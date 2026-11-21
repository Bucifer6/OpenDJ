import { sha1Hex } from '../hash.js';
import { SourceClient } from './base.js';

const PAGE_SIZE = 500;
const CLIENT_VERSION = '0.1.0';

function asArray(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

function extOf(p) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(p || '');
  return m ? m[1].toLowerCase() : null;
}

/** Jellyfin client. remoteId = Item Id. */
export class JellyfinClient extends SourceClient {
  constructor(config, opts) {
    super(config, opts);
    this.prefix = config.pathPrefix || '';
    this.deviceId =
      'opendj-' + sha1Hex(String(config.id || `${this.config.url}|${config.username || ''}`)).slice(0, 16);
  }

  get serverLabel() {
    return 'Jellyfin';
  }

  _authValue() {
    let v = `MediaBrowser Client="OpenDJ", Device="OpenDJ", DeviceId="${this.deviceId}", Version="${CLIENT_VERSION}"`;
    if (this.config.token) v += `, Token="${this.config.token}"`;
    return v;
  }

  _headers(extra = {}) {
    const auth = this._authValue();
    const h = {
      Accept: 'application/json',
      Authorization: auth,
      'X-Emby-Authorization': auth,
      ...extra,
    };
    if (this.config.token) h['X-Emby-Token'] = this.config.token;
    return h;
  }

  _base() {
    return this.config.url + this.prefix;
  }

  async _req(path, { method = 'GET', body } = {}) {
    const headers = this._headers(body ? { 'Content-Type': 'application/json' } : {});
    const res = await this.fetch(this._base() + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = new Error(`${this.serverLabel} ${method} ${path} -> HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async _authenticate() {
    const { username, password } = this.config;
    const body = await this._req('/Users/AuthenticateByName', {
      method: 'POST',
      body: { Username: username, Pw: password || '', Password: password || '' },
    });
    if (!body?.AccessToken) throw new Error(`${this.serverLabel} authentication returned no token`);
    this.config.token = body.AccessToken;
    this.config.userId = body.User?.Id || this.config.userId;
  }

  async _connectOnce() {
    if (!this.config.token) {
      if (!this.config.username) throw new Error(`${this.serverLabel} username or API token required`);
      await this._authenticate();
    }
    if (!this.config.userId) {
      try {
        const me = await this._req('/Users/Me');
        this.config.userId = me?.Id;
      } catch {
        // API keys have no user; pick the first administrator/user.
        const users = asArray(await this._req('/Users'));
        const u = users.find((x) => x?.Policy?.IsAdministrator) || users[0];
        this.config.userId = u?.Id;
      }
      if (!this.config.userId) throw new Error(`${this.serverLabel}: could not determine user id`);
    }
    const info = await this._req('/System/Info');
    return { ok: true, serverName: info?.ServerName || this.serverLabel, version: info?.Version || null };
  }

  async connect() {
    if (!this.config.url) throw new Error(`${this.serverLabel} server URL is required`);
    return this._connectOnce();
  }

  persistable() {
    const out = {};
    if (this.config.token) out.token = this.config.token;
    if (this.config.userId) out.userId = this.config.userId;
    if (this.prefix) out.pathPrefix = this.prefix;
    return out;
  }

  async listLibraries() {
    const body = await this._req(`/Users/${this.config.userId}/Views`);
    return asArray(body?.Items)
      .filter((v) => !v.CollectionType || v.CollectionType === 'music')
      .map((v) => ({ id: v.Id, name: v.Name }));
  }

  _normTrack(it) {
    const src = asArray(it.MediaSources)[0] || {};
    const imgId = it.ImageTags?.Primary ? it.Id : it.AlbumPrimaryImageTag ? it.AlbumId : null;
    return {
      remoteId: String(it.Id),
      title: it.Name || '',
      artist: asArray(it.Artists).join(', ') || it.AlbumArtist || '',
      album: it.Album || '',
      albumArtist: it.AlbumArtist || '',
      genre: asArray(it.Genres).join(', ') || null,
      year: Number(it.ProductionYear) || null,
      trackNumber: Number(it.IndexNumber) || null,
      duration: it.RunTimeTicks ? it.RunTimeTicks / 1e7 : null,
      bpm: null,
      format: (src.Container || extOf(src.Path || it.Path) || it.Container || '').toLowerCase().split(',')[0] || null,
      size: Number(src.Size) || null,
      bitrate: src.Bitrate ? Math.round(src.Bitrate / 1000) : null,
      coverUrl: imgId ? `${this._base()}/Items/${imgId}/Images/Primary` : null,
    };
  }

  async _pagedItems(params, onPage) {
    let start = 0;
    let total = Infinity;
    while (start < total) {
      const q = new URLSearchParams({ ...params, StartIndex: String(start), Limit: String(PAGE_SIZE) });
      const body = await this._req(`/Users/${this.config.userId}/Items?${q}`);
      const items = asArray(body?.Items);
      total = Number(body?.TotalRecordCount ?? items.length) || 0;
      onPage(items, total);
      if (items.length === 0) break;
      start += items.length;
    }
  }

  async listTracks(opts = {}) {
    if (!this.config.userId) await this.connect();
    const parents = this.config.libraryIds?.length ? this.config.libraryIds : [null];
    const tracks = [];
    for (const parentId of parents) {
      const params = {
        IncludeItemTypes: 'Audio',
        Recursive: 'true',
        Fields: 'Genres,MediaSources,ProductionYear,Path',
      };
      if (parentId) params.ParentId = parentId;
      await this._pagedItems(params, (items, total) => {
        for (const it of items) tracks.push(this._normTrack(it));
        opts.onProgress?.(tracks.length, total);
      });
    }
    return tracks;
  }

  async listPlaylists() {
    if (!this.config.userId) await this.connect();
    const lists = [];
    await this._pagedItems({ IncludeItemTypes: 'Playlist', Recursive: 'true' }, (items) => lists.push(...items));
    const out = [];
    for (const p of lists) {
      if (p.MediaType && p.MediaType !== 'Audio') continue;
      const body = await this._req(`/Playlists/${p.Id}/Items?UserId=${encodeURIComponent(this.config.userId)}`);
      out.push({
        remoteId: String(p.Id),
        name: p.Name,
        trackRemoteIds: asArray(body?.Items)
          .filter((i) => !i.Type || i.Type === 'Audio')
          .map((i) => String(i.Id)),
      });
    }
    return out;
  }

  _tok() {
    return encodeURIComponent(this.config.token || '');
  }

  streamRequest(remoteId) {
    return { url: `${this._base()}/Audio/${remoteId}/stream?static=true&api_key=${this._tok()}`, headers: {} };
  }

  /** Server-side transcode to FLAC (lossless) for formats the browser can't decode (used when OpenDJ has no FFmpeg). */
  transcodeRequest(remoteId) {
    const q = new URLSearchParams({
      UserId: this.config.userId || '', DeviceId: 'opendj', MaxStreamingBitrate: '999999999',
      Container: 'flac,mp3,m4a|aac,ogg|opus,ogg|vorbis,wav,webm|opus', TranscodingContainer: 'flac', TranscodingProtocol: 'http',
      AudioCodec: 'flac', api_key: this.config.token || '',
    });
    return { url: `${this._base()}/Audio/${encodeURIComponent(remoteId)}/universal?${q}`, headers: {} };
  }

  downloadRequest(remoteId, track) {
    return {
      url: `${this._base()}/Items/${remoteId}/Download?api_key=${this._tok()}`,
      headers: {},
      ext: track?.format || null,
    };
  }

  coverRequest(remoteId) {
    return { url: `${this._base()}/Items/${remoteId}/Images/Primary?api_key=${this._tok()}`, headers: {} };
  }
}
