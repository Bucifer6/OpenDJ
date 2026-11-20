import { sha1Hex } from '../hash.js';
import { SourceClient } from './base.js';

// MediaMax REST API v1 (see MediaMax docs/API.md).
// Auth: POST /api/v1/auth/login -> { token, user } then `Authorization: Bearer <token>`,
// or a MediaMax API key (`mmk_…`) sent as `X-Api-Key`. Both are also accepted in the query
// string (`?token=` / `?api_key=`) but every endpoint we use accepts headers.
//
// remoteId   = MediaMax item id of the track.
// remotePath = MediaSource id (needed for /stream/direct/:mediaId).
// coverImageId = image id of the track's (album) artwork, for /images/:imageId.

const API = '/api/v1';
const PAGE_SIZE = 500; // server max for GET /items
const CHILD_PAGE = 2000; // server max for GET /items/:id/children
const DETAIL_CONCURRENCY = 6;
const CLIENT_VERSION = '0.1.0';

function asArray(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

function extOf(p) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(p || '');
  return m ? m[1].toLowerCase() : null;
}

const isApiKey = (t) => typeof t === 'string' && t.startsWith('mmk_');

/** "A minor" -> "Am", "F# major" -> "F#" (tag-style key text, as OpenDJ's own analysis writes). */
export function mediaMaxKeyToTag(k) {
  if (!k) return null;
  const m = /^\s*([A-G][#b]?)\s*(major|minor|maj|min|m)?\s*$/i.exec(String(k));
  if (!m) return String(k);
  const minor = m[2] && /^(minor|min|m)$/i.test(m[2]) && m[2] !== 'M';
  return m[1] + (minor ? 'm' : '');
}

/** Image id from a server-relative `/api/v1/images/<id>` URL. */
function imageIdOf(u) {
  const m = /\/images\/([^/?#]+)/.exec(u || '');
  return m ? decodeURIComponent(m[1]) : null;
}

/** Run fn over items with bounded concurrency. */
async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/** MediaMax client (the user's own media server, with DJ-mode track analysis). */
export class MediaMaxClient extends SourceClient {
  constructor(config, opts) {
    super(config, opts);
    this.deviceId =
      this.config.deviceId ||
      'opendj-' + sha1Hex(String(config.id || `${this.config.url}|${config.username || ''}`)).slice(0, 16);
  }

  _base() {
    return this.config.url + API;
  }

  _authHeaders() {
    const t = this.config.token;
    if (!t) return {};
    return isApiKey(t) ? { 'X-Api-Key': t } : { Authorization: `Bearer ${t}` };
  }

  _headers(extra = {}) {
    return {
      Accept: 'application/json',
      'X-MediaMax-Device-Id': this.deviceId,
      'X-MediaMax-Device-Name': 'OpenDJ',
      'X-MediaMax-Platform': 'other',
      'X-MediaMax-Version': CLIENT_VERSION,
      ...this._authHeaders(),
      ...extra,
    };
  }

  _canRelogin() {
    return !!(this.config.username && this.config.password) && !isApiKey(this.config.token);
  }

  async _raw(path, { method = 'GET', body } = {}) {
    return this.fetch(this._base() + path, {
      method,
      headers: this._headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async _req(path, opts = {}, retried = false) {
    const res = await this._raw(path, opts);
    if (res.status === 401 && !retried && !opts.noRelogin && this._canRelogin()) {
      // Session token expired or revoked: sign in again with the stored password.
      await this._login();
      return this._req(path, opts, true);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = '';
      try {
        msg = JSON.parse(text)?.message || '';
      } catch {
        /* not JSON */
      }
      const err = new Error(`MediaMax ${opts.method || 'GET'} ${path} -> HTTP ${res.status}${msg ? `: ${msg}` : ''}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  async _login() {
    const { username, password } = this.config;
    if (!username) throw new Error('MediaMax username or API key required');
    const body = await this._req(
      '/auth/login',
      {
        method: 'POST',
        noRelogin: true,
        body: {
          username,
          password: password || '',
          deviceId: this.deviceId,
          deviceName: 'OpenDJ',
          platform: 'other',
          appVersion: CLIENT_VERSION,
          ...(this.config.totpCode ? { totpCode: this.config.totpCode } : {}),
        },
      },
      true,
    );
    if (!body?.token) throw new Error('MediaMax login returned no token');
    this.config.token = body.token;
    this.config.userId = body.user?.id || this.config.userId;
  }

  async connect() {
    if (!this.config.url) throw new Error('MediaMax server URL is required');
    if (!this.config.token) await this._login();
    const me = await this._req('/auth/me');
    if (me?.id) this.config.userId = me.id;
    let info = null;
    try {
      info = await this._req('/system/info');
    } catch {
      /* public endpoint; tolerate older servers */
    }
    return { ok: true, serverName: info?.name || 'MediaMax', version: info?.version || null };
  }

  persistable() {
    const out = {};
    if (this.config.token) out.token = this.config.token;
    if (this.config.userId) out.userId = this.config.userId;
    if (this.deviceId) out.deviceId = this.deviceId;
    return out;
  }

  async _ensure() {
    if (!this.config.token) await this.connect();
  }

  async listLibraries() {
    await this._ensure();
    return asArray(await this._req('/libraries'))
      .filter((l) => l.type === 'music')
      .map((l) => ({ id: String(l.id), name: l.name }));
  }

  _normTrack(it) {
    const artist = it.grandparentTitle || (asArray(it.people)[0]?.name ?? '') || '';
    const cover = it.posterUrl || it.thumbUrl || null;
    return {
      remoteId: String(it.id),
      title: it.title || '',
      artist,
      album: it.parentTitle || '',
      albumArtist: it.grandparentTitle || '',
      genre: asArray(it.genres).join(', ') || null,
      year: Number(it.year) || null,
      trackNumber: Number(it.index) || null,
      duration: it.durationMs ? it.durationMs / 1000 : null,
      bpm: null,
      key: null,
      format: null,
      size: null,
      bitrate: null,
      coverUrl: cover ? (/^https?:/i.test(cover) ? cover : this.config.url + cover) : null,
      coverImageId: imageIdOf(cover),
      remotePath: null,
    };
  }

  /** Fill in file details from GET /items/:id (media[]). */
  _applyMedia(t, item) {
    const m = asArray(item?.media)[0];
    if (!m) return;
    t.remotePath = m.id ? String(m.id) : null;
    t.format = (m.container || '').toLowerCase().split(',')[0] || t.format;
    t.size = Number(m.size) || null;
    t.bitrate = Number(m.bitrate) || null;
    if (!t.duration && m.durationMs) t.duration = m.durationMs / 1000;
  }

  /** Map a MediaMax TrackAnalysis (DJ mode) onto the track. */
  _applyAnalysis(t, a) {
    if (!a) return;
    if (Number(a.bpm) > 0) {
      t.bpm = Math.round(Number(a.bpm) * 100) / 100;
      if (a.beatOffsetMs != null) t.gridOffset = Number(a.beatOffsetMs) / 1000;
    }
    if (a.key) t.key = mediaMaxKeyToTag(a.key);
    else if (a.camelot) t.key = a.camelot;
    if (a.camelot) t.camelot = a.camelot;
    if (typeof a.energy === 'number') {
      // MediaMax energy is 0–1; OpenDJ uses a 1–10 scale.
      t.energy = Math.max(1, Math.min(10, Math.round(a.energy * 10)));
      t.energyRaw = a.energy;
    }
  }

  async _pagedTracks(libraryId, onPage) {
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const q = new URLSearchParams({ type: 'track', sort: 'title', order: 'asc', limit: String(PAGE_SIZE), offset: String(offset) });
      if (libraryId) q.set('libraryId', libraryId);
      const body = await this._req(`/items?${q}`);
      const items = asArray(body?.items);
      total = Number(body?.total ?? items.length) || 0;
      onPage(items, total);
      if (items.length === 0) break;
      offset += items.length;
    }
  }

  /**
   * opts.onProgress(done, total); opts.details (default true) fetches per-track file info
   * (mediaId/format/size) and DJ analysis — MediaMax's list endpoint carries neither.
   */
  async listTracks(opts = {}) {
    await this._ensure();
    const libs = this.config.libraryIds?.length ? this.config.libraryIds : (await this.listLibraries()).map((l) => l.id);
    if (!libs.length) return [];
    const tracks = [];
    const seen = new Set();
    for (const lib of libs) {
      await this._pagedTracks(lib, (items) => {
        for (const it of items) {
          if (it.type && it.type !== 'track') continue;
          if (seen.has(String(it.id))) continue;
          seen.add(String(it.id));
          tracks.push(this._normTrack(it));
        }
      });
    }
    const fetchDetails = opts.details !== false && this.config.fetchDetails !== false;
    const fetchAnalysis = fetchDetails && this.config.fetchAnalysis !== false;
    if (!fetchDetails) {
      opts.onProgress?.(tracks.length, tracks.length);
      return tracks;
    }
    let done = 0;
    opts.onProgress?.(0, tracks.length);
    await pool(tracks, DETAIL_CONCURRENCY, async (t) => {
      const id = encodeURIComponent(t.remoteId);
      try {
        this._applyMedia(t, await this._req(`/items/${id}`));
      } catch (e) {
        if (e.status === 401) throw e;
      }
      if (fetchAnalysis) {
        try {
          this._applyAnalysis(t, await this._req(`/items/${id}/analysis`));
        } catch (e) {
          if (e.status === 401) throw e;
          // 400/404/500: not analysable (e.g. remote file) — leave bpm/key empty.
        }
      }
      done++;
      opts.onProgress?.(done, tracks.length);
    });
    return tracks;
  }

  async _children(id) {
    const out = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const q = new URLSearchParams({ limit: String(CHILD_PAGE), offset: String(offset) });
      const body = await this._req(`/items/${encodeURIComponent(id)}/children?${q}`);
      const items = asArray(body?.items);
      total = Number(body?.total ?? items.length) || 0;
      out.push(...items);
      if (items.length === 0) break;
      offset += items.length;
    }
    return out;
  }

  /** The user's own playlists (manual and smart — smart children are computed live by the server). */
  async listPlaylists() {
    await this._ensure();
    const lists = asArray(await this._req('/playlists'));
    const out = [];
    for (const p of lists) {
      if (p.type && p.type !== 'playlist') continue;
      const kids = await this._children(p.id);
      const trackRemoteIds = kids.filter((i) => !i.type || i.type === 'track').map((i) => String(i.id));
      // Skip video-only playlists.
      if (kids.length && !trackRemoteIds.length) continue;
      out.push({ remoteId: String(p.id), name: p.title || p.name || 'Playlist', trackRemoteIds, smart: !!p.smart });
    }
    return out;
  }

  /** Direct play of the original file (Range supported). Falls back to the original-file download route. */
  streamRequest(remoteId, track) {
    const mediaId = track?.remotePath;
    const url = mediaId
      ? `${this._base()}/stream/direct/${encodeURIComponent(mediaId)}`
      : `${this._base()}/stream/download/${encodeURIComponent(remoteId)}?quality=original`;
    return { url, headers: this._authHeaders() };
  }

  /** Original file (needs the MediaMax user's "allow downloads" permission, or admin). */
  downloadRequest(remoteId, track) {
    const ext = (track?.format || extOf(track?.path) || '').toLowerCase() || null;
    return {
      url: `${this._base()}/stream/download/${encodeURIComponent(remoteId)}?quality=original`,
      headers: this._authHeaders(),
      ext,
    };
  }

  coverRequest(remoteId, track) {
    const imgId = track?.coverImageId || imageIdOf(track?.coverUrl);
    if (!imgId) return null;
    return { url: `${this._base()}/images/${encodeURIComponent(imgId)}?w=600`, headers: this._authHeaders() };
  }
}
