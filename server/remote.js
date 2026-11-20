// Remote media-server integration: connect, sync catalogue, download tracks for offline use.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createClient } from './sources/index.js';
import { Library } from './library.js';
import { addFile } from './scanner.js';

const clients = new Map();
const TOKEN_ONLY = new Set(['plex', 'jellyfin', 'emby']);
const USER_DATA = (t) => t.analyzed || t.cues?.length || t.loops?.length || t.hotLoops?.length || t.rating || t.playCount || t.comment || t.tags?.length || t.color;

export function clientFor(library, sourceId) {
  const cfg = library.getSource(sourceId);
  if (!cfg) throw new Error('Unknown source');
  let c = clients.get(sourceId);
  if (!c || c._cfgVersion !== JSON.stringify(cfg)) {
    c = createClient(cfg);
    c._cfgVersion = JSON.stringify(cfg);
    clients.set(sourceId, c);
  }
  return c;
}

/** Connect with new credentials, persist the resulting token (not raw password where avoidable). */
export async function addSource(library, cfg) {
  // a wrong URL or an offline server is the user's input, not a server fault: 400 / 502 with a readable reason
  const bad = (status, msg) => Object.assign(new Error(msg), { status });
  let u = null; try { u = new URL(String(cfg.url || '')); } catch { /* checked below */ }
  if (!u || !/^https?:$/.test(u.protocol)) throw bad(400, 'Enter the server address as a full URL, e.g. http://192.168.1.10:8096');
  let client, info;
  try { client = createClient(cfg); } catch (e) { throw bad(400, e.message); }
  try { info = await client.connect(); } catch (e) {
    if (e.status) throw bad(e.status === 401 || e.status === 403 ? 400 : 502, e.status === 401 || e.status === 403 ? 'The server refused the login (check user name / password / token)' : e.message); // never pass a remote 401 through (the UI would ask for the OpenDJ login)
    const c = e.cause?.code || e.code;
    if (!c && !(e instanceof TypeError)) throw bad(400, e.message); // login refused, wrong library… (the client's message)
    const why = c === 'ECONNREFUSED' ? 'connection refused' : c === 'ENOTFOUND' || c === 'EAI_AGAIN' ? 'host not found' : c === 'ETIMEDOUT' || c === 'UND_ERR_CONNECT_TIMEOUT' ? 'timed out' : (e.cause?.message || e.message);
    throw bad(502, `Could not reach ${u.host}: ${why}`);
  }
  const saved = library.saveSource({ ...cfg, ...client.persistable(), serverName: info?.serverName || cfg.name });
  // Plex/Jellyfin/Emby never sign in again once they have a token: don't keep the raw password around.
  // (Subsonic signs every request with it; MediaMax re-logs in when its session expires.)
  if (TOKEN_ONLY.has(saved.type) && saved.token) delete saved.password;
  clients.delete(saved.id);
  return { source: library.publicSource(saved), info };
}

export async function syncSource(library, sourceId, { onProgress } = {}) {
  const cfg = library.getSource(sourceId);
  const client = clientFor(library, sourceId);
  await client.connect();
  const persist = client.persistable();
  if (Object.keys(persist).length) Object.assign(cfg, persist);
  const tracks = await client.listTracks({ onProgress: (done, total) => onProgress?.({ source: sourceId, done, total }) });
  const seen = new Set();
  for (const rt of tracks) {
    const tid = Library.remoteId(sourceId, rt.remoteId);
    seen.add(tid);
    const { coverUrl, ...rest } = rt;
    library.upsertTrack({ ...rest, id: tid, sourceType: 'remote', sourceId, sourceKind: cfg.type, hasCover: !!coverUrl });
  }
  // Tracks no longer on the server. A server that suddenly lists nothing (or less than half of what it had) is
  // more likely broken or half-indexed than emptied, so nothing is pruned then. Tracks with the user's work on
  // them (cues, analysis, ratings, plays…) are kept and flagged `remoteMissing` instead of deleted.
  const prevCount = library.allTracks().filter((t) => t.sourceId === sourceId && t.sourceType === 'remote').length;
  const gone = library.allTracks().filter((t) => t.sourceId === sourceId && !seen.has(t.id));
  let pruned = 0, kept = 0;
  const suspicious = gone.length && (tracks.length === 0 || (prevCount >= 10 && tracks.length < prevCount * 0.5));
  if (!suspicious) {
    for (const t of gone) { if (t.localPath) { t.sourceType = 'local'; t.path = t.localPath; } }
    const drop = [];
    for (const t of gone) {
      if (t.localPath) continue;
      if (USER_DATA(t)) { t.remoteMissing = true; kept++; } else drop.push(t.id);
    }
    pruned = drop.length;
    library.removeTracks(drop);
  }
  for (const rt of tracks) { const t = library.getTrack(Library.remoteId(sourceId, rt.remoteId)); if (t?.remoteMissing) delete t.remoteMissing; }

  let playlists = [];
  try { playlists = await client.listPlaylists(); } catch { /* playlists optional */ }
  for (const rp of playlists) {
    const trackIds = rp.trackRemoteIds.map((r) => Library.remoteId(sourceId, r)).filter((t) => library.getTrack(t));
    const existing = library.data.playlists.find((p) => p.sourceId === sourceId && p.remoteId === rp.remoteId);
    if (existing) { existing.name = rp.name; existing.trackIds = trackIds; }
    else library.data.playlists.push({ id: Library.remoteId(sourceId, 'pl:' + rp.remoteId), name: rp.name, trackIds, sourceId, remoteId: rp.remoteId, folder: cfg.name, createdAt: Date.now() });
  }
  cfg.lastSync = Date.now();
  cfg.trackCount = tracks.length;
  library.changed('tracks');
  onProgress?.({ source: sourceId, done: tracks.length, total: tracks.length, finished: true });
  return { tracks: tracks.length, playlists: playlists.length, pruned, keptMissing: kept, skippedPrune: !!suspicious };
}

/** Request info for streaming a remote track through our local proxy. */
export function remoteStream(library, track) {
  return clientFor(library, track.sourceId).streamRequest(track.remoteId, track);
}
export function remoteCover(library, track) {
  return clientFor(library, track.sourceId).coverRequest(track.remoteId, track);
}

export const safe = (s) => {
  const v = String(s || 'Unknown').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Unknown';
  return /^\.+$/.test(v) ? '_' : v.replace(/^\.+/, '_'); // no '.', '..' or hidden names
};
/** A file extension from a (server-controlled) string: 1-5 alphanumerics, else the fallback. */
export const safeExt = (e, fallback = 'mp3') => { const v = String(e || '').replace(/^\./, '').toLowerCase(); return /^[a-z0-9]{1,5}$/.test(v) ? v : fallback; };
const DONE_CAP = 200;

export class DownloadManager {
  constructor(library, emit) {
    this.library = library;
    this.emit = emit;
    this.queue = [];
    this.active = new Map();
    this.done = [];
    this.concurrency = 2;
  }
  list() {
    return {
      queued: this.queue.map((q) => ({ trackId: q })),
      active: [...this.active.values()].map(({ trackId, received, total }) => ({ trackId, received, total })),
      done: this.done.slice(-50),
    };
  }
  enqueue(trackIds) {
    let n = 0;
    for (const tid of trackIds) {
      const t = this.library.getTrack(tid);
      if (!t || t.sourceType !== 'remote' || t.localPath || this.queue.includes(tid) || this.active.has(tid)) continue;
      this.queue.push(tid); n++;
    }
    this.pump();
    this.emit('downloads', this.list());
    return n;
  }
  cancel(tid) {
    this.queue = this.queue.filter((q) => q !== tid);
    this.active.get(tid)?.ctrl.abort();
    this.emit('downloads', this.list());
  }
  pump() {
    while (this.active.size < this.concurrency && this.queue.length) {
      const tid = this.queue.shift();
      const job = { trackId: tid, received: 0, total: 0, ctrl: new AbortController() };
      this.active.set(tid, job);
      this.run(job).then(
        (file) => this.done.push({ trackId: tid, ok: true, file }),
        (err) => this.done.push({ trackId: tid, ok: false, error: err.message }),
      ).finally(() => {
        if (this.done.length > DONE_CAP) this.done.splice(0, this.done.length - DONE_CAP); this.active.delete(tid); this.emit('downloads', this.list()); this.pump(); });
    }
  }
  async run(job) {
    const t = this.library.getTrack(job.trackId);
    const client = clientFor(this.library, t.sourceId);
    const req = client.downloadRequest(t.remoteId, t);
    const res = await fetch(req.url, { headers: req.headers || {}, signal: job.ctrl.signal });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    job.total = Number(res.headers.get('content-length')) || t.size || 0;
    const ext = safeExt(req.ext, safeExt(t.format));
    const root = path.resolve(this.library.settings.downloadDir);
    const dir = path.join(root, safe(t.albumArtist || t.artist), safe(t.album || 'Singles'));
    if (!isInside(root, dir)) throw new Error('Refusing to download outside the download folder');
    await fs.promises.mkdir(dir, { recursive: true });
    const stem = `${t.trackNumber ? String(t.trackNumber).padStart(2, '0') + ' ' : ''}${safe(t.artist)} - ${safe(t.title)}`.slice(0, 200);
    // per-track temp file: two tracks with the same name never write the same .part
    const tmp = path.join(dir, `.${t.id}.part`);
    let last = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      job.received += chunk.length;
      if (Date.now() - last > 250) { last = Date.now(); this.emit('downloads', this.list()); }
    });
    let file;
    try {
      await pipeline(body, fs.createWriteStream(tmp));
      file = await uniqueName(dir, stem, ext);
      if (!isInside(root, file)) throw new Error('Refusing to download outside the download folder');
      await fs.promises.link(tmp, file).catch(async (e) => { // link fails if the name was taken meanwhile: never overwrite
        if (e.code === 'EEXIST') { file = await uniqueName(dir, stem, ext); await fs.promises.link(tmp, file); } else await fs.promises.copyFile(tmp, file, fs.constants.COPYFILE_EXCL);
      });
    } finally { await fs.promises.rm(tmp, { force: true }).catch(() => {}); }
    t.localPath = file;
    t.downloadedAt = Date.now();
    // Pick up any embedded tags we didn't get from the server (e.g. BPM/key written by other DJ software).
    try {
      const { readTags } = await import('./scanner.js');
      const tags = await readTags(file, { ffmpeg: this.library.media?.ffmpeg()?.path });
      t.codec = tags.codec; t.hasVideo = tags.hasVideo; t.needsTranscode = tags.needsTranscode;
      if (!t.bpm && tags.bpm) t.bpm = tags.bpm;
      if (!t.key && tags.key) t.key = tags.key;
      if (!t.duration && tags.duration) t.duration = tags.duration;
    } catch { /* ignore */ }
    this.library.changed('tracks');
    return file;
  }
}

export function isInside(root, p) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** `<dir>/<stem>.<ext>`, or `<stem> (2).<ext>`… when taken. */
export async function uniqueName(dir, stem, ext) {
  for (let i = 1; i < 1000; i++) {
    const f = path.join(dir, `${stem}${i > 1 ? ` (${i})` : ''}.${ext}`);
    try { await fs.promises.access(f); } catch { return f; }
  }
  throw new Error('Too many files with the same name');
}

export { addFile };
