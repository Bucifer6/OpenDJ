import { createHash, randomBytes } from 'node:crypto';
import { SourceClient } from './base.js';

const API_VERSION = '1.16.1';
const CLIENT = 'OpenDJ';
const PAGE_SIZE = 500;

function asArray(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

export class SubsonicError extends Error {
  constructor(code, message) {
    super(`Subsonic error ${code}: ${message}`);
    this.code = code;
  }
}

/** Subsonic / Navidrome / Airsonic / Gonic client. remoteId = song id. */
export class SubsonicClient extends SourceClient {
  constructor(config, opts) {
    super(config, opts);
    // Legacy (hex-encoded password) auth for servers that reject token auth (error 41).
    this.legacyAuth = !!config.legacyAuth;
  }

  /** Auth + common query params. A fresh salt each call. */
  authParams() {
    const { username = '', password = '' } = this.config;
    const p = { u: username, v: API_VERSION, c: CLIENT, f: 'json' };
    if (this.legacyAuth) {
      p.p = 'enc:' + Buffer.from(password, 'utf8').toString('hex');
    } else {
      const s = randomBytes(6).toString('hex');
      p.t = createHash('md5').update(password + s).digest('hex');
      p.s = s;
    }
    return p;
  }

  _url(method, params = {}) {
    const q = new URLSearchParams({ ...this.authParams(), ...params });
    return `${this.config.url}/rest/${method}?${q}`;
  }

  async _call(method, params = {}, { retried = false } = {}) {
    const res = await this.fetch(this._url(method, params), { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Subsonic ${method} -> HTTP ${res.status}`);
    const body = await res.json();
    const r = body?.['subsonic-response'];
    if (!r) throw new Error(`Subsonic ${method}: unexpected response`);
    if (r.status !== 'ok') {
      const code = r.error?.code;
      if (code === 41 && !this.legacyAuth && !retried) {
        this.legacyAuth = true;
        return this._call(method, params, { retried: true });
      }
      throw new SubsonicError(code, r.error?.message || 'unknown error');
    }
    return r;
  }

  async connect() {
    if (!this.config.url) throw new Error('Subsonic server URL is required');
    if (!this.config.username) throw new Error('Subsonic username is required');
    const r = await this._call('ping');
    return {
      ok: true,
      serverName: r.type ? r.type.charAt(0).toUpperCase() + r.type.slice(1) : 'Subsonic',
      version: r.serverVersion || r.version || null,
    };
  }

  persistable() {
    return this.legacyAuth ? { legacyAuth: true } : {};
  }

  async listLibraries() {
    try {
      const r = await this._call('getMusicFolders');
      return asArray(r.musicFolders?.musicFolder).map((f) => ({ id: String(f.id), name: f.name || String(f.id) }));
    } catch {
      return [];
    }
  }

  _normTrack(s) {
    return {
      remoteId: String(s.id),
      title: s.title || '',
      artist: s.artist || s.displayArtist || '',
      album: s.album || '',
      albumArtist: s.albumArtist || s.displayAlbumArtist || '',
      genre: s.genre || (asArray(s.genres).map((g) => g.name).join(', ') || null),
      year: Number(s.year) || null,
      trackNumber: Number(s.track) || null,
      duration: s.duration != null ? Number(s.duration) : null,
      bpm: Number(s.bpm) || null,
      format: (s.suffix || '').toLowerCase() || null,
      size: Number(s.size) || null,
      bitrate: Number(s.bitRate) || null,
      coverUrl: null, // needs auth params: use coverRequest(remoteId, track)
      coverArt: s.coverArt ? String(s.coverArt) : null,
    };
  }

  async _searchAll(folderId, onProgress, out) {
    let offset = 0;
    for (;;) {
      const params = { query: '', songCount: String(PAGE_SIZE), songOffset: String(offset), artistCount: '0', albumCount: '0' };
      if (folderId) params.musicFolderId = folderId;
      const r = await this._call('search3', params);
      const songs = asArray(r.searchResult3?.song);
      for (const s of songs) out.push(this._normTrack(s));
      offset += songs.length;
      onProgress?.(out.length, null);
      if (songs.length < PAGE_SIZE) return offset;
    }
  }

  async _walkAlbums(folderId, onProgress, out) {
    const albums = [];
    let offset = 0;
    for (;;) {
      const params = { type: 'alphabeticalByName', size: String(PAGE_SIZE), offset: String(offset) };
      if (folderId) params.musicFolderId = folderId;
      const r = await this._call('getAlbumList2', params);
      const page = asArray(r.albumList2?.album);
      albums.push(...page);
      offset += page.length;
      if (page.length < PAGE_SIZE) break;
    }
    let done = 0;
    for (const a of albums) {
      const r = await this._call('getAlbum', { id: a.id });
      for (const s of asArray(r.album?.song)) out.push(this._normTrack(s));
      done++;
      onProgress?.(done, albums.length);
    }
  }

  async listTracks(opts = {}) {
    const folders = this.config.libraryIds?.length ? this.config.libraryIds : [null];
    const out = [];
    const seen = new Set();
    for (const folderId of folders) {
      const batch = [];
      let found = 0;
      try {
        found = await this._searchAll(folderId, opts.onProgress, batch);
      } catch {
        found = 0;
      }
      if (!found) {
        batch.length = 0;
        await this._walkAlbums(folderId, opts.onProgress, batch);
      }
      for (const t of batch) {
        if (seen.has(t.remoteId)) continue;
        seen.add(t.remoteId);
        out.push(t);
      }
    }
    return out;
  }

  async listPlaylists() {
    const r = await this._call('getPlaylists');
    const out = [];
    for (const p of asArray(r.playlists?.playlist)) {
      const d = await this._call('getPlaylist', { id: p.id });
      out.push({
        remoteId: String(p.id),
        name: p.name,
        trackRemoteIds: asArray(d.playlist?.entry).map((e) => String(e.id)),
      });
    }
    return out;
  }

  streamRequest(remoteId) {
    return { url: this._url('stream', { id: remoteId, format: 'raw' }), headers: {} };
  }

  /** Server-side transcode (MP3 320 kbps: the one target every Subsonic server offers) when OpenDJ has no FFmpeg. */
  transcodeRequest(remoteId) {
    return { url: this._url('stream', { id: remoteId, format: 'mp3', maxBitRate: '320' }), headers: {} };
  }

  downloadRequest(remoteId, track) {
    return { url: this._url('download', { id: remoteId }), headers: {}, ext: track?.format || null };
  }

  coverRequest(remoteId, track) {
    return { url: this._url('getCoverArt', { id: track?.coverArt || remoteId }), headers: {} };
  }
}
