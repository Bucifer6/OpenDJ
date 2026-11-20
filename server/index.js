// Local HTTP API + static UI server. Bound to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { parseFile } from 'music-metadata';
import { Library, newId } from './library.js';
import { scanFolder, addFile, walk, AUDIO_EXT } from './scanner.js';
import { listDrives, browseDir } from './drives.js';
import { aiffToWav } from './aiff.js';
import { addSource, syncSource, remoteStream, remoteCover, DownloadManager, clientFor } from './remote.js';
import { SOURCE_TYPES } from './sources/index.js';
import { parseRekordboxXml, buildRekordboxXml } from './rekordbox.js';
import { parseM3U, buildM3U } from './m3u.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm', '.aif': 'audio/wav', '.aiff': 'audio/wav',
};

export function defaultDataDir() {
  if (process.env.OPENDJ_DATA) return process.env.OPENDJ_DATA;
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || home, 'OpenDJ');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'OpenDJ');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opendj');
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function readBody(req, limit = 50 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new HttpError(413, 'Body too large'); chunks.push(c); }
  const raw = Buffer.concat(chunks);
  if (!raw.length) return {};
  if ((req.headers['content-type'] || '').includes('json')) return JSON.parse(raw.toString('utf8'));
  return raw;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendFileRange(req, res, file, mime) {
  const st = fs.statSync(file);
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }
}

const PLACEHOLDER = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#20252d"/><path d="M24 11v13.5a4 4 0 1 1-2-3.46V15l-6 1.5v10a4 4 0 1 1-2-3.46V13z" fill="#4a5361"/></svg>';
function sendPlaceholder(res) {
  if (res.headersSent) return res.end();
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' });
  res.end(PLACEHOLDER);
}

async function proxy(req, res, { url, headers = {} }) {
  const h = { ...headers };
  if (req.headers.range) h.Range = req.headers.range;
  const up = await fetch(url, { headers: h });
  const out = {};
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = up.headers.get(k); if (v) out[k] = v;
  }
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

export function createServer({ dataDir = defaultDataDir(), log = console } = {}) {
  const library = new Library(dataDir);
  const sse = new Set();
  const emit = (type, payload) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const r of sse) r.write(msg);
  };
  library.listeners.add(emit);
  const downloads = new DownloadManager(library, emit);
  const jobs = new Map(); // running scans/syncs

  const runJob = (key, fn) => {
    if (jobs.has(key)) return jobs.get(key);
    const p = fn().catch((e) => { emit('job-error', { key, message: e.message }); throw e; }).finally(() => { jobs.delete(key); emit('jobs', [...jobs.keys()]); });
    jobs.set(key, p);
    emit('jobs', [...jobs.keys()]);
    p.catch(() => {});
    return p;
  };

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };
  const track = (tid) => { const t = library.getTrack(tid); if (!t) throw new HttpError(404, 'Track not found'); return t; };

  // ---------------- tracks ----------------
  route('GET', '/api/tracks', () => library.allTracks());
  route('PATCH', '/api/tracks/:id', async ({ params, body }) => library.updateTrack(track(params.id).id, body));
  route('POST', '/api/tracks/delete', async ({ body }) => { library.removeTracks(body.ids || []); return { ok: true }; });
  route('POST', '/api/tracks/played', async ({ body }) => {
    const t = track(body.id); t.playCount = (t.playCount || 0) + 1; t.lastPlayed = Date.now(); library.changed('tracks'); return t;
  });
  route('GET', '/api/tracks/:id/stream', async ({ params, req, res }) => {
    const t = track(params.id);
    const file = t.localPath && fs.existsSync(t.localPath) ? t.localPath : t.sourceType === 'local' ? t.path : null;
    if (file) {
      if (!fs.existsSync(file)) throw new HttpError(404, 'File missing (drive disconnected?)');
      const ext = path.extname(file).toLowerCase();
      if (ext === '.aif' || ext === '.aiff') {
        const wav = aiffToWav(await fs.promises.readFile(file));
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
        return res.end(wav);
      }
      return sendFileRange(req, res, file, MIME[ext] || 'application/octet-stream');
    }
    return proxy(req, res, remoteStream(library, t));
  });
  route('GET', '/api/tracks/:id/cover', async ({ params, req, res }) => {
    const t = track(params.id);
    const file = t.localPath || (t.sourceType === 'local' ? t.path : null);
    if (file && fs.existsSync(file)) {
      const mm = await parseFile(file, { duration: false }).catch(() => null);
      const pic = mm?.common.picture?.[0];
      if (!pic) return sendPlaceholder(res);
      res.writeHead(200, { 'Content-Type': pic.format, 'Cache-Control': 'max-age=86400' });
      return res.end(Buffer.from(pic.data));
    }
    const r = t.sourceType === 'remote' ? remoteCover(library, t) : null;
    if (!r) return sendPlaceholder(res);
    return proxy(req, res, r).catch(() => sendPlaceholder(res));
  });
  route('GET', '/api/tracks/:id/waveform', async ({ params, res }) => {
    const f = library.waveformPath(track(params.id).id);
    if (!fs.existsSync(f)) throw new HttpError(404, 'Not analysed');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  });
  route('PUT', '/api/tracks/:id/waveform', async ({ params, body }) => {
    if (!Buffer.isBuffer(body)) throw new HttpError(400, 'Expected binary body');
    await fs.promises.writeFile(library.waveformPath(track(params.id).id), body);
    return { ok: true };
  });
  route('POST', '/api/files', async ({ body }) => {
    const added = [];
    for (const p of body.paths || []) {
      const st = await fs.promises.stat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) { for await (const f of walk(p)) { const t = await addFile(library, f); if (t) added.push(t.id); } }
      else if (AUDIO_EXT.has(path.extname(p).toLowerCase())) { const t = await addFile(library, p); if (t) added.push(t.id); }
    }
    library.changed('tracks');
    return { added };
  });

  // ---------------- playlists ----------------
  route('GET', '/api/playlists', () => library.data.playlists);
  route('POST', '/api/playlists', async ({ body }) => library.createPlaylist(body.name, body.trackIds || [], body.folder ? { folder: body.folder } : {}));
  route('PATCH', '/api/playlists/:id', async ({ params, body }) => library.updatePlaylist(params.id, body) || Promise.reject(new HttpError(404, 'No playlist')));
  route('DELETE', '/api/playlists/:id', async ({ params }) => { library.deletePlaylist(params.id); return { ok: true }; });
  route('POST', '/api/playlists/:id/add', async ({ params, body }) => library.addToPlaylist(params.id, body.trackIds || []));
  route('GET', '/api/playlists/:id/m3u', async ({ params, res }) => {
    const p = library.getPlaylist(params.id); if (!p) throw new HttpError(404, 'No playlist');
    const m3u = buildM3U(p.trackIds.map((t) => library.getTrack(t)).filter(Boolean));
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Content-Disposition': `attachment; filename="${encodeURIComponent(p.name)}.m3u8"` });
    res.end(m3u);
  });

  // ---------------- import / export ----------------
  route('POST', '/api/import/m3u', async ({ body }) => {
    const content = body.content ?? await fs.promises.readFile(body.path, 'utf8');
    const baseDir = body.path ? path.dirname(body.path) : (body.baseDir || os.homedir());
    const ids = [];
    for (const entry of parseM3U(content, baseDir)) {
      if (fs.existsSync(entry.path)) { const t = await addFile(library, entry.path); if (t) ids.push(t.id); }
    }
    return library.createPlaylist(body.name || (body.path ? path.basename(body.path).replace(/\.m3u8?$/i, '') : 'Imported'), ids);
  });
  route('POST', '/api/import/rekordbox', async ({ body }) => {
    const xml = body.xml ?? await fs.promises.readFile(body.path, 'utf8');
    const parsed = parseRekordboxXml(xml);
    const byLoc = new Map();
    let imported = 0;
    for (const rt of parsed.tracks) {
      if (!rt.location || !fs.existsSync(rt.location)) continue;
      const t = await addFile(library, rt.location);
      if (!t) continue;
      byLoc.set(rt.location, t.id);
      library.updateTrack(t.id, {
        bpm: rt.bpm || t.bpm, key: rt.key || t.key, rating: rt.rating ?? t.rating, comment: rt.comments || t.comment,
        cues: (rt.cues || []).map((c) => ({ ...c, index: c.type === 'memory' ? -1 : c.index })),
        gridOffset: rt.grid?.offset ?? t.gridOffset,
        analyzed: !!rt.bpm || t.analyzed,
      });
      imported++;
    }
    let playlists = 0;
    for (const pl of parsed.playlists) {
      const ids = pl.trackKeys.map((k) => byLoc.get(k)).filter(Boolean);
      library.createPlaylist(pl.name, ids, { folder: pl.path?.length ? pl.path.join(' / ') : 'rekordbox' }); playlists++;
    }
    return { imported, playlists, missing: parsed.tracks.length - imported };
  });
  route('GET', '/api/export/rekordbox', async ({ res }) => {
    const tracks = library.allTracks().filter((t) => t.localPath || t.sourceType === 'local')
      .map((t) => ({ ...t, path: t.localPath || t.path }));
    const xml = buildRekordboxXml({ tracks, playlists: library.data.playlists });
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': 'attachment; filename="opendj-rekordbox.xml"' });
    res.end(xml);
  });
  // Export playlists to a USB stick / folder: copies audio + writes .m3u8 per playlist + rekordbox.xml
  route('POST', '/api/export/usb', async ({ body }) => {
    const target = path.resolve(body.targetDir);
    await fs.promises.mkdir(path.join(target, 'OpenDJ', 'Music'), { recursive: true });
    const exported = [];
    const copied = new Map();
    for (const pid of body.playlistIds || []) {
      const p = library.getPlaylist(pid); if (!p) continue;
      const items = [];
      for (const tid of p.trackIds) {
        const t = library.getTrack(tid); const src = t && (t.localPath || (t.sourceType === 'local' ? t.path : null));
        if (!src || !fs.existsSync(src)) continue;
        if (!copied.has(tid)) {
          const dest = path.join(target, 'OpenDJ', 'Music', path.basename(src));
          if (!fs.existsSync(dest)) await fs.promises.copyFile(src, dest);
          copied.set(tid, dest);
        }
        items.push({ ...t, path: copied.get(tid) });
      }
      await fs.promises.writeFile(path.join(target, 'OpenDJ', `${p.name.replace(/[<>:"/\\|?*]/g, '_')}.m3u8`), buildM3U(items, path.join(target, 'OpenDJ')));
      exported.push({ name: p.name, tracks: items.length });
    }
    const tracks = [...copied.entries()].map(([tid, p]) => ({ ...library.getTrack(tid), path: p }));
    const pls = (body.playlistIds || []).map((pid) => library.getPlaylist(pid)).filter(Boolean);
    await fs.promises.writeFile(path.join(target, 'OpenDJ', 'rekordbox.xml'), buildRekordboxXml({ tracks, playlists: pls }));
    return { exported, files: copied.size, target };
  });

  // ---------------- folders / drives ----------------
  route('GET', '/api/folders', () => library.data.folders.map((f) => ({ ...f, online: fs.existsSync(f.path) })));
  route('POST', '/api/folders', async ({ body }) => {
    if (!body.path || !fs.existsSync(body.path)) throw new HttpError(400, 'Folder does not exist');
    const f = library.addFolder(body.path, body.name);
    runJob('scan:' + f.id, () => scanFolder(library, f, { onProgress: (p) => emit('scan', p) }));
    return f;
  });
  route('POST', '/api/folders/:id/scan', async ({ params }) => {
    const f = library.data.folders.find((x) => x.id === params.id); if (!f) throw new HttpError(404, 'No folder');
    runJob('scan:' + f.id, () => scanFolder(library, f, { onProgress: (p) => emit('scan', p) }));
    return { started: true };
  });
  route('DELETE', '/api/folders/:id', async ({ params }) => { library.removeFolder(params.id); return { ok: true }; });
  route('GET', '/api/drives', () => listDrives());
  route('GET', '/api/browse', async ({ query }) => browseDir(query.get('path')));

  // ---------------- remote sources ----------------
  route('GET', '/api/source-types', () => SOURCE_TYPES);
  route('GET', '/api/sources', () => library.data.sources.map((s) => library.publicSource(s)));
  route('POST', '/api/sources', async ({ body }) => {
    const prev = body.id ? library.getSource(body.id) : null;
    const cfg = { ...(prev || {}), ...body };
    if (prev && !body.password) cfg.password = prev.password; // keep stored secret when editing
    const result = await addSource(library, cfg);
    runJob('sync:' + result.source.id, () => syncSource(library, result.source.id, { onProgress: (p) => emit('sync', p) }));
    return result;
  });
  route('POST', '/api/sources/:id/sync', async ({ params }) => {
    if (!library.getSource(params.id)) throw new HttpError(404, 'No source');
    runJob('sync:' + params.id, () => syncSource(library, params.id, { onProgress: (p) => emit('sync', p) }));
    return { started: true };
  });
  route('GET', '/api/sources/:id/libraries', async ({ params }) => { const c = clientFor(library, params.id); await c.connect(); return c.listLibraries(); });
  route('DELETE', '/api/sources/:id', async ({ params }) => { library.removeSource(params.id); return { ok: true }; });

  // ---------------- downloads ----------------
  route('GET', '/api/downloads', () => downloads.list());
  route('POST', '/api/downloads', async ({ body }) => ({ queued: downloads.enqueue(body.trackIds || []) }));
  route('POST', '/api/downloads/cancel', async ({ body }) => { downloads.cancel(body.trackId); return { ok: true }; });

  // ---------------- settings / misc ----------------
  route('GET', '/api/settings', () => library.settings);
  route('PUT', '/api/settings', async ({ body }) => library.updateSettings(body));
  route('GET', '/api/jobs', () => [...jobs.keys()]);
  route('GET', '/api/info', () => ({ version: '0.1.0', dataDir, platform: process.platform, tracks: Object.keys(library.data.tracks).length }));
  route('GET', '/api/events', ({ req, res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: {}\n\n`);
    sse.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); sse.delete(res); });
    return undefined;
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // Block cross-site requests from web pages to this local API.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}` && origin !== 'null' && req.method !== 'GET') {
      res.writeHead(403); return res.end('Forbidden origin');
    }
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
          const out = await r.handler({ req, res, params, body, query: url.searchParams });
          if (!res.headersSent && out !== undefined) sendJson(res, 200, out);
          return;
        }
        throw new HttpError(404, 'No such endpoint');
      }
      // static UI
      let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      if (!p || p === '.') p = 'index.html';
      const file = path.join(PUBLIC, p);
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw new HttpError(404, 'Not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      if (!e.status) log.error?.('[opendj]', e);
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
      else res.end();
    }
  });

  const shutdown = () => { library.flush(); for (const r of sse) r.end(); };
  return { server, library, downloads, shutdown, newId };
}

export async function start({ port = 0, host = '127.0.0.1', dataDir } = {}) {
  const app = createServer({ dataDir });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, host, resolve); });
  app.port = app.server.address().port;
  app.url = `http://${host}:${app.port}/`;
  return app;
}
