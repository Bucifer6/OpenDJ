import { createHash } from 'node:crypto';
import { SourceClient } from './base.js';

const PAGE_SIZE = 500;
const PRODUCT = 'OpenDJ';
const VERSION = '0.1.0';

function asArray(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

function extOf(p) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(p || '');
  return m ? m[1].toLowerCase() : null;
}

/**
 * Plex Media Server client.
 *
 * Track remoteId = Plex ratingKey. Streaming/downloading needs the media Part key
 * (`/library/parts/<id>/<ts>/file.ext`), which is returned on each normalised track as
 * `remotePath`; pass the stored track as the 2nd argument of streamRequest/downloadRequest.
 */
export class PlexClient extends SourceClient {
  constructor(config, opts) {
    super(config, opts);
    this.signInUrl = opts?.signInUrl || 'https://plex.tv/users/sign_in.json';
    this.clientId =
      config.clientId ||
      'opendj-' + createHash('sha1').update(String(config.id || `${this.config.url}|${config.username || ''}`)).digest('hex').slice(0, 16);
  }

  _headers(extra = {}) {
    const h = {
      Accept: 'application/json',
      'X-Plex-Client-Identifier': this.clientId,
      'X-Plex-Product': PRODUCT,
      'X-Plex-Version': VERSION,
      ...extra,
    };
    if (this.config.token) h['X-Plex-Token'] = this.config.token;
    return h;
  }

  async _get(path, headers = {}) {
    const res = await this.fetch(this.config.url + path, { headers: this._headers(headers) });
    if (!res.ok) {
      const err = new Error(`Plex ${path} -> HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async _signIn() {
    const { username, password } = this.config;
    const res = await this.fetch(this.signInUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
        'X-Plex-Client-Identifier': this.clientId,
        'X-Plex-Product': PRODUCT,
        'X-Plex-Version': VERSION,
      },
    });
    if (!res.ok) throw new Error(`Plex sign-in failed: HTTP ${res.status}`);
    const body = await res.json();
    const token = body?.user?.authToken || body?.user?.authentication_token;
    if (!token) throw new Error('Plex sign-in returned no token');
    this.config.token = token;
  }

  async connect() {
    if (!this.config.url) throw new Error('Plex server URL is required');
    if (!this.config.token) {
      if (this.config.username && this.config.password) await this._signIn();
      else throw new Error('Plex token or username/password required');
    }
    const body = await this._get('/');
    const mc = body?.MediaContainer || {};
    return { ok: true, serverName: mc.friendlyName || 'Plex', version: mc.version || null };
  }

  persistable() {
    return this.config.token ? { token: this.config.token } : {};
  }

  async listLibraries() {
    const body = await this._get('/library/sections');
    return asArray(body?.MediaContainer?.Directory)
      .filter((d) => d.type === 'artist')
      .map((d) => ({ id: String(d.key), name: d.title }));
  }

  _normTrack(m) {
    const media = asArray(m.Media)[0] || {};
    const part = asArray(media.Part)[0] || {};
    const thumb = m.thumb || m.parentThumb || m.grandparentThumb || null;
    return {
      remoteId: String(m.ratingKey),
      title: m.title || '',
      artist: m.originalTitle || m.grandparentTitle || '',
      album: m.parentTitle || '',
      albumArtist: m.grandparentTitle || '',
      genre: asArray(m.Genre).map((g) => g.tag).filter(Boolean).join(', ') || null,
      year: Number(m.parentYear || m.year) || null,
      trackNumber: Number(m.index) || null,
      duration: m.duration ? m.duration / 1000 : part.duration ? part.duration / 1000 : null,
      bpm: null,
      format: (part.container || media.container || extOf(part.file) || media.audioCodec || '').toLowerCase() || null,
      size: Number(part.size) || null,
      bitrate: Number(media.bitrate) || null,
      coverUrl: thumb ? this.config.url + thumb : null,
      remotePath: part.key || null,
    };
  }

  async _paged(path, onPage) {
    let start = 0;
    let total = Infinity;
    while (start < total) {
      const body = await this._get(path, {
        'X-Plex-Container-Start': String(start),
        'X-Plex-Container-Size': String(PAGE_SIZE),
      });
      const mc = body?.MediaContainer || {};
      const items = asArray(mc.Metadata);
      total = Number(mc.totalSize ?? mc.size ?? items.length) || 0;
      onPage(items, total);
      if (items.length === 0) break;
      start += items.length;
    }
  }

  async listTracks(opts = {}) {
    let sectionIds = this.config.libraryIds?.length ? this.config.libraryIds : (await this.listLibraries()).map((l) => l.id);
    const tracks = [];
    for (const id of sectionIds) {
      await this._paged(`/library/sections/${encodeURIComponent(id)}/all?type=10`, (items, total) => {
        for (const m of items) tracks.push(this._normTrack(m));
        opts.onProgress?.(tracks.length, total);
      });
    }
    return tracks;
  }

  async listPlaylists() {
    const body = await this._get('/playlists?playlistType=audio');
    const out = [];
    for (const p of asArray(body?.MediaContainer?.Metadata)) {
      if (p.smart && p.playlistType !== 'audio') continue;
      const ids = [];
      await this._paged(`/playlists/${encodeURIComponent(p.ratingKey)}/items`, (items) => {
        for (const m of items) ids.push(String(m.ratingKey));
      });
      out.push({ remoteId: String(p.ratingKey), name: p.title, trackRemoteIds: ids });
    }
    return out;
  }

  _withToken(path) {
    const sep = path.includes('?') ? '&' : '?';
    return this.config.url + path + (this.config.token ? `${sep}X-Plex-Token=${encodeURIComponent(this.config.token)}` : '');
  }

  streamRequest(remoteId, track) {
    if (track?.remotePath) return { url: this._withToken(track.remotePath), headers: {} };
    // Fallback without a known part key: universal transcoder (MP3).
    return this.transcodeRequest(remoteId);
  }

  /** Plex universal transcoder -> MP3 (formats the browser can't decode, when OpenDJ has no FFmpeg). */
  transcodeRequest(remoteId) {
    const q = new URLSearchParams({
      path: `/library/metadata/${remoteId}`,
      protocol: 'http',
      'X-Plex-Client-Identifier': this.clientId,
      'X-Plex-Product': PRODUCT,
    });
    return { url: this._withToken(`/music/:/transcode/universal/start.mp3?${q}`), headers: {} };
  }

  downloadRequest(remoteId, track) {
    if (!track?.remotePath) throw new Error(`Plex download for ${remoteId} needs track.remotePath (part key)`);
    const sep = track.remotePath.includes('?') ? '&' : '?';
    return {
      url: this._withToken(track.remotePath + `${sep}download=1`),
      headers: {},
      ext: extOf(track.remotePath.split('?')[0]) || track.format || 'mp3',
    };
  }

  coverRequest(remoteId) {
    return { url: this._withToken(`/library/metadata/${remoteId}/thumb`), headers: {} };
  }
}
