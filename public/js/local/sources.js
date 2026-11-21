// Media servers (Plex, Jellyfin, Emby, Subsonic/Navidrome, MediaMax) for the on-device backend: the same clients as
// the desktop server (public/js/shared/sources/), talking to the server directly from the phone.
//   - In the app, requests go through CapacitorHttp (native networking: no CORS) and downloads through
//     @capacitor/file-transfer straight into app storage (big files never pass through JavaScript).
//   - In a plain browser (?local=1 test mode) they use fetch, which only works with servers that allow CORS.
// Security, as on the server: credentials live only in the library record in app storage, secrets are bound to
// their endpoint (sourceConfigFromForm), the UI only ever sees publicSource() (no secrets), and error messages
// are stripped of URLs' query strings (Subsonic signs every URL with a token).
import { createClient } from '../shared/sources/index.js';
import { LibraryCore } from '../shared/library-core.js';
import { checkFormat } from './media.js';
import { readTagsFromBlob } from './importer.js';

const TOKEN_ONLY = new Set(['plex', 'jellyfin', 'emby']);
const USER_DATA = (t) => t.analyzed || t.cues?.length || t.loops?.length || t.hotLoops?.length || t.rating || t.playCount || t.comment || t.tags?.length || t.color;
/** Never show (or log) a URL's query string: it can carry tokens / Subsonic auth. */
export const scrub = (msg) => String(msg ?? '').replace(/(https?:\/\/[^\s?'"]+)\?[^\s'"]*/gi, '$1?…').slice(0, 300);
export const safeExt = (e, fallback = 'mp3') => { const v = String(e || '').replace(/^\./, '').toLowerCase(); return /^[a-z0-9]{1,5}$/.test(v) ? v : fallback; };

/**
 * fetch-compatible function over CapacitorHttp (native) - returns a real Response.
 * @param CapacitorHttp  the core plugin proxy
 */
export function capacitorFetch(CapacitorHttp) {
  return async (url, init = {}) => {
    const headers = { ...(init.headers || {}) };
    let data;
    if (init.body != null) {
      const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
      data = /json/i.test(ct) && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    }
    const r = await CapacitorHttp.request({ url: String(url), method: init.method || 'GET', headers, data, responseType: 'text', connectTimeout: 15000, readTimeout: 60000 });
    const body = r.data == null ? '' : typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    const status = r.status >= 200 && r.status <= 599 ? r.status : 502;
    return new Response(status === 204 || status === 304 ? null : body, { status, headers: r.headers || {} });
  };
}

export class LocalSources {
  /**
   * @param {object} o
   * @param o.library   LocalLibrary
   * @param o.fs        file store
   * @param o.emit      event hub emit
   * @param o.fetch     fetch for API calls (capacitorFetch in the app, window.fetch in browsers)
   * @param o.download  optional native downloader: ({ url, headers, dest, onProgress }) => Promise (file-transfer)
   * @param o.mm        music-metadata ({ parseBlob })
   */
  constructor({ library, fs, emit, fetch, download, mm }) {
    Object.assign(this, { library, fs, emit, fetchImpl: fetch, nativeDownload: download, mm });
    this.clients = new Map();
    this.downloads = new DownloadQueue(this);
  }

  clientFor(sourceId) {
    const cfg = this.library.getSource(sourceId);
    if (!cfg) throw Object.assign(new Error('Unknown source'), { status: 404 });
    let c = this.clients.get(sourceId);
    if (!c || c._cfgVersion !== JSON.stringify(cfg)) {
      c = createClient(cfg, { fetchImpl: this.fetchImpl });
      c._cfgVersion = JSON.stringify(cfg);
      this.clients.set(sourceId, c);
    }
    return c;
  }

  /** Connect with new credentials and persist the resulting token (like server/remote.js addSource). */
  async addSource(cfg) {
    const bad = (status, msg) => Object.assign(new Error(scrub(msg)), { status });
    let u = null; try { u = new URL(String(cfg.url || '')); } catch { /* checked below */ }
    if (!u || !/^https?:$/.test(u.protocol)) throw bad(400, 'Enter the server address as a full URL, e.g. http://192.168.1.10:8096');
    let client, info;
    try { client = createClient(cfg, { fetchImpl: this.fetchImpl }); } catch (e) { throw bad(400, e.message); }
    try { info = await client.connect(); } catch (e) {
      if (e.status) throw bad(e.status === 401 || e.status === 403 ? 400 : 502, e.status === 401 || e.status === 403 ? 'The server refused the login (check user name / password / token)' : e.message);
      if (!(e instanceof TypeError) && !/network|fetch|connect|timed? ?out|host/i.test(e.message)) throw bad(400, e.message);
      throw bad(502, `Could not reach ${u.host}${globalThis.Capacitor?.isNativePlatform?.() ? '' : ' (in a browser the media server must allow CORS)'}: ${e.message}`);
    }
    const saved = this.library.saveSource({ ...cfg, ...client.persistable(), serverName: info?.serverName || cfg.name }, { replace: true });
    if (TOKEN_ONLY.has(saved.type) && saved.token) delete saved.password;
    this.clients.delete(saved.id);
    return { source: this.library.publicSource(saved), info };
  }

  /** Sync the catalogue (same pruning rules as server/remote.js syncSource). */
  async syncSource(sourceId, { onProgress } = {}) {
    const lib = this.library;
    const cfg = lib.getSource(sourceId);
    const client = this.clientFor(sourceId);
    await client.connect();
    const persist = client.persistable();
    if (Object.keys(persist).length) Object.assign(cfg, persist);
    const tracks = await client.listTracks({ onProgress: (done, total) => onProgress?.({ source: sourceId, done, total }) });
    const seen = new Set();
    for (const rt of tracks) {
      const tid = LibraryCore.remoteId(sourceId, rt.remoteId);
      seen.add(tid);
      const { coverUrl, ...rest } = rt;
      lib.upsertTrack({ ...rest, id: tid, sourceType: 'remote', sourceId, sourceKind: cfg.type, hasCover: !!coverUrl });
    }
    const prevCount = lib.allTracks().filter((t) => t.sourceId === sourceId && t.sourceType === 'remote').length;
    const gone = lib.allTracks().filter((t) => t.sourceId === sourceId && !seen.has(t.id));
    let pruned = 0, kept = 0;
    const suspicious = gone.length && (tracks.length === 0 || (prevCount >= 10 && tracks.length < prevCount * 0.5));
    if (!suspicious) {
      for (const t of gone) if (t.localPath) { t.sourceType = 'local'; t.path = t.localPath; }
      const drop = [];
      for (const t of gone) { if (t.localPath) continue; if (USER_DATA(t)) { t.remoteMissing = true; kept++; } else drop.push(t.id); }
      pruned = drop.length;
      lib.removeTracks(drop);
    }
    for (const rt of tracks) { const t = lib.getTrack(LibraryCore.remoteId(sourceId, rt.remoteId)); if (t?.remoteMissing) delete t.remoteMissing; }
    let playlists = [];
    try { playlists = await client.listPlaylists(); } catch { /* optional */ }
    for (const rp of playlists) {
      const trackIds = rp.trackRemoteIds.map((r) => LibraryCore.remoteId(sourceId, r)).filter((t) => lib.getTrack(t));
      const existing = lib.data.playlists.find((p) => p.sourceId === sourceId && p.remoteId === rp.remoteId);
      if (existing) { existing.name = rp.name; existing.trackIds = trackIds; }
      else lib.data.playlists.push({ id: LibraryCore.remoteId(sourceId, 'pl:' + rp.remoteId), name: rp.name, trackIds, sourceId, remoteId: rp.remoteId, folder: cfg.name, createdAt: Date.now() });
    }
    cfg.lastSync = Date.now();
    cfg.trackCount = tracks.length;
    lib.changed('tracks');
    onProgress?.({ source: sourceId, done: tracks.length, total: tracks.length, finished: true });
    return { tracks: tracks.length, playlists: playlists.length, pruned, keptMissing: kept, skippedPrune: !!suspicious };
  }

  /** Fetch a media-server URL into app storage (native: file-transfer; browser: fetch). Returns bytes written. */
  async fetchToFile({ url, headers = {} }, dest, { onProgress, signal, limit = Infinity } = {}) {
    if (this.nativeDownload) {
      await this.nativeDownload({ url, headers, dest, onProgress });
      const st = await this.fs.stat(dest);
      if (!st) throw new Error('Download failed');
      if (st.size > limit) { await this.fs.delete(dest); throw new Error('Download is larger than the limit (downloadMaxMB)'); }
      return st.size;
    }
    const res = await this.fetchImpl(url, { headers, signal });
    if (!res.ok) throw new Error(`Media server answered HTTP ${res.status}`);
    if (Number(res.headers.get('content-length')) > limit) throw new Error('Download is larger than the limit (downloadMaxMB)');
    const blob = await res.blob();
    if (blob.size > limit) throw new Error('Download is larger than the limit (downloadMaxMB)');
    onProgress?.(blob.size, blob.size);
    await this.fs.write(dest, blob);
    return blob.size;
  }

  /** Request for playing a remote track: a browser-decodable stream, or the server's transcode where needed. */
  streamRequest(t) {
    const c = this.clientFor(t.sourceId);
    if (!checkFormat(`x.${t.format || 'mp3'}`).ok) {
      const tr = c.transcodeRequest?.(t.remoteId, t);
      if (tr) return { ...tr, ext: 'mp3' };
      throw Object.assign(new Error(`This ${String(t.format).toUpperCase()} track can't be played on the phone (no FFmpeg) and the media server can't transcode it`), { status: 415 });
    }
    return { ...c.streamRequest(t.remoteId, t), ext: safeExt(t.format) };
  }
  coverRequest(t) { try { return this.clientFor(t.sourceId).coverRequest(t.remoteId, t); } catch { return null; } }
}

const DONE_CAP = 200;
/** Download-for-offline queue (same list()/enqueue()/cancel() shape and 'downloads' events as the server). */
export class DownloadQueue {
  constructor(sources) { this.s = sources; this.queue = []; this.active = new Map(); this.done = []; this.concurrency = 2; }
  get library() { return this.s.library; }
  list() {
    return {
      queued: this.queue.map((q) => ({ trackId: q })),
      active: [...this.active.values()].map(({ trackId, received, total }) => ({ trackId, received, total })),
      done: this.done.slice(-50),
    };
  }
  enqueue(ids) {
    let n = 0;
    for (const tid of ids) {
      const t = this.library.getTrack(tid);
      if (!t || t.sourceType !== 'remote' || t.localPath || this.queue.includes(tid) || this.active.has(tid)) continue;
      this.queue.push(tid); n++;
    }
    this.pump();
    this.s.emit('downloads', this.list());
    return n;
  }
  cancel(tid) {
    this.queue = this.queue.filter((q) => q !== tid);
    const j = this.active.get(tid); if (j) { j.cancelled = true; j.ctrl.abort(); }
    this.s.emit('downloads', this.list());
  }
  pump() {
    while (this.active.size < this.concurrency && this.queue.length) {
      const tid = this.queue.shift();
      const job = { trackId: tid, received: 0, total: 0, ctrl: new AbortController() };
      this.active.set(tid, job);
      this.run(job).then((file) => this.done.push({ trackId: tid, ok: true, file }), (err) => this.done.push({ trackId: tid, ok: false, error: scrub(err.message) }))
        .finally(() => { if (this.done.length > DONE_CAP) this.done.splice(0, this.done.length - DONE_CAP); this.active.delete(tid); this.s.emit('downloads', this.list()); this.pump(); });
    }
  }
  async run(job) {
    const t = this.library.getTrack(job.trackId);
    const req = this.s.clientFor(t.sourceId).downloadRequest(t.remoteId, t);
    const ext = safeExt(req.ext, safeExt(t.format));
    if (!checkFormat(`x.${ext}`).ok) throw new Error(`${ext.toUpperCase()} files can't be played on the phone yet`);
    const dest = `downloads/${String(t.id).replace(/[^\w-]/g, '_')}.${ext}`;
    const limit = Math.max(1, Number(this.library.settings?.downloadMaxMB) || 4096) * 1048576;
    let last = 0;
    await this.s.fetchToFile(req, dest, {
      signal: job.ctrl.signal, limit,
      onProgress: (received, total) => { job.received = received; job.total = total || t.size || 0; if (Date.now() - last > 250) { last = Date.now(); this.s.emit('downloads', this.list()); } },
    });
    if (job.cancelled) { await this.s.fs.delete(dest); throw new Error('Cancelled'); }
    t.localPath = dest;
    t.downloadedAt = Date.now();
    try {
      const blob = await this.s.fs.read(dest);
      const { tags } = await readTagsFromBlob(blob, dest, this.s.mm, { covers: false });
      t.codec = tags.codec; t.hasVideo = tags.hasVideo; t.needsTranscode = false;
      if (!t.bpm && tags.bpm) t.bpm = tags.bpm;
      if (!t.key && tags.key) t.key = tags.key;
      if (!t.duration && tags.duration) t.duration = tags.duration;
    } catch { /* tags are optional */ }
    this.library.changed('tracks');
    return dest;
  }
}
