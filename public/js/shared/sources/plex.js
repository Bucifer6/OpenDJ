import { sha1Hex, base64Utf8 } from '../hash.js';
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
    this.plexTvUrl = (opts?.plexTvUrl || 'https://plex.tv').replace(/\/+$/, '');
    this.clientId =
      config.clientId ||
      'opendj-' + sha1Hex(String(config.id || `${this.config.url}|${config.username || ''}`)).slice(0, 16);
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
        Authorization: 'Basic ' + base64Utf8(`${username}:${password}`),
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
    this.config.accountToken = token;
  }

  async connect() {
    if (!this.config.url) throw new Error('Plex server URL is required');
    if (!this.config.token) {
      if (this.config.username && this.config.password) await this._signIn();
      else throw new Error('Plex token or username/password required');
    }
    // The plex.tv account token (lists Plex Home users and switches between them). A connection made with a typed
    // X-Plex-Token assumes it is the account token; a switched-to user's token never replaces it.
    if (!this.config.accountToken) this.config.accountToken = this.config.token;
    const body = await this._get('/');
    const mc = body?.MediaContainer || {};
    this.machineId = mc.machineIdentifier || null;
    return { ok: true, serverName: mc.friendlyName || 'Plex', version: mc.version || null };
  }

  persistable() {
    const out = {};
    if (this.config.token) out.token = this.config.token;
    if (this.config.accountToken) out.accountToken = this.config.accountToken;
    if (this.config.plexUser) out.plexUser = this.config.plexUser;
    return out;
  }

  /** A plex.tv request with the given token (JSON). */
  async _plexTv(path, token, { method = 'GET' } = {}) {
    const res = await this.fetch(this.plexTvUrl + path, {
      method,
      headers: {
        Accept: 'application/json',
        'X-Plex-Client-Identifier': this.clientId,
        'X-Plex-Product': PRODUCT,
        'X-Plex-Version': VERSION,
        'X-Plex-Token': token,
      },
    });
    if (!res.ok) {
      const err = new Error(`plex.tv ${path.split('?')[0]} -> HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /**
   * Plex Home users of the signed-in account: [{ id (uuid), title, admin, protected (needs a PIN), restricted
   * (managed user), guest, current }]. An account without Plex Home lists only itself (or nothing).
   */
  async homeUsers() {
    const token = this.config.accountToken || this.config.token;
    if (!token) throw new Error('Connect to Plex first');
    const body = await this._plexTv('/api/v2/home/users', token);
    const list = Array.isArray(body) ? body : asArray(body?.users);
    const current = this.config.plexUser?.id || null;
    return list
      .filter((u) => u && (u.uuid || u.id != null))
      .map((u) => {
        const id = String(u.uuid || u.id);
        const admin = !!u.admin;
        return {
          id,
          title: String(u.title || u.friendlyName || u.username || 'Plex user').slice(0, 100),
          admin,
          protected: !!u.protected,
          restricted: !!u.restricted,
          guest: !!u.guest,
          current: current ? current === id : admin,
        };
      });
  }

  /**
   * Switch to a Plex Home user (`pin` for PIN-protected users; never stored). Afterwards the connection browses and
   * streams as that user: their libraries, playlists and restrictions. Switching to the account owner goes back to
   * the account token. Throws (and keeps the current user) when the PIN is wrong or the user can't use this server.
   */
  async switchUser(userId, pin) {
    const users = await this.homeUsers();
    const user = users.find((u) => u.id === String(userId));
    if (!user) throw Object.assign(new Error('That Plex user is not in this Plex Home'), { status: 404 });
    if (pin != null && pin !== '' && !/^\d{4}$/.test(String(pin))) throw Object.assign(new Error('The PIN is 4 digits'), { status: 400 });
    if (user.protected && !pin && !user.admin) throw Object.assign(new Error(`${user.title} needs a PIN`), { status: 400, needsPin: true });
    const account = this.config.accountToken || this.config.token;
    let userToken;
    if (user.admin && !pin) userToken = account;
    else {
      const q = pin ? `?pin=${encodeURIComponent(String(pin))}` : '';
      let body;
      try { body = await this._plexTv(`/api/v2/home/users/${encodeURIComponent(user.id)}/switch${q}`, account, { method: 'POST' }); } catch (e) {
        if (e.status === 401 || e.status === 403 || e.status === 422) throw Object.assign(new Error(pin ? 'Wrong PIN' : `${user.title} needs a PIN`), { status: 400, needsPin: !pin });
        throw e;
      }
      userToken = body?.authToken || body?.authenticationToken || body?.user?.authToken;
      if (!userToken) throw new Error('plex.tv returned no token for that user');
    }
    const serverToken = await this._serverToken(userToken);
    // check the user can actually reach this server before keeping anything
    const res = await this.fetch(this.config.url + '/', { headers: { ...this._headers(), 'X-Plex-Token': serverToken } });
    if (!res.ok) throw Object.assign(new Error(`${user.title} has no access to this Plex server`), { status: 400 });
    this.config.token = serverToken;
    if (user.admin) delete this.config.plexUser;
    else this.config.plexUser = { id: user.id, title: user.title };
    return user;
  }

  /** The token a plex.tv user token uses on this server (its resource access token), else the user token itself. */
  async _serverToken(userToken) {
    if (!this.machineId) {
      try { this.machineId = (await this._get('/'))?.MediaContainer?.machineIdentifier || null; } catch { /* below */ }
    }
    if (!this.machineId) return userToken;
    try {
      const list = await this._plexTv('/api/v2/resources?includeHttps=1&includeRelay=1', userToken);
      const r = asArray(list).find((x) => x?.clientIdentifier === this.machineId && x.accessToken);
      if (r) return String(r.accessToken);
    } catch { /* fall back to the user token */ }
    return userToken;
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

  /**
   * Audio playlists. Default: { remoteId, name, trackRemoteIds } (pages through each playlist, used by sync).
   * opts.tracks === false: summaries only, { remoteId, name, trackCount, duration, smart }.
   */
  async listPlaylists(opts = {}) {
    const body = await this._get('/playlists?playlistType=audio');
    if (opts.tracks === false) {
      return asArray(body?.MediaContainer?.Metadata)
        .filter((p) => !p.playlistType || p.playlistType === 'audio')
        .map((p) => ({
          remoteId: String(p.ratingKey), name: p.title || String(p.ratingKey), trackCount: Number(p.leafCount) || 0,
          duration: p.duration ? p.duration / 1000 : null, smart: !!p.smart,
        }));
    }
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

  /** Tracks of one playlist, in playlist order, as normalised tracks (same shape as listTracks(), with remotePath). */
  async playlistTracks(id) {
    const out = [];
    await this._paged(`/playlists/${encodeURIComponent(id)}/items`, (items) => {
      for (const m of items) if (!m.type || m.type === 'track') out.push(this._normTrack(m));
    });
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
