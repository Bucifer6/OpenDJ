// HTTP API + static UI server.
// Desktop / `npm run web`: bound to 127.0.0.1, no password, Host + Origin checked (DNS rebinding / CSRF).
// Hosted (HOST=0.0.0.0, e.g. on a NAS): password login required (auth.js), file access limited to allowed roots.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseFile } from 'music-metadata';
import { Library, newId } from './library.js';
import { scanFolder, addFile, walk, AUDIO_EXT, isMediaPath } from './scanner.js';
import { listDrives, browseDir } from './drives.js';
import { aiffToWav } from './aiff.js';
import { addSource, syncSource, remoteStream, remoteCover, DownloadManager, clientFor, isInside, uniqueName, safe, sourcePlaylists, openSourcePlaylist, remoteError, plexUsers, switchPlexUser } from './remote.js';
import { findFfmpeg, needsTranscode, remoteBrowserDecodable, browserPlayableVideo, formatList, DSD_EXT, VIDEO_MIME, extOf, probe, isVideoByName, BROWSER_VIDEO_EXT } from './media.js';
import { Transcoder } from './transcode.js';
import { Auth, parseCookies, parseTrustProxy } from './auth.js';
import { redactSettings, REDACTED } from './library-tools.js';
import { SOURCE_TYPES, sourceConfigFromForm } from './sources/index.js';
import { parseRekordboxXml, buildRekordboxXml } from './rekordbox.js';
import { parseM3U, buildM3U } from './m3u.js';
import { evaluateSmart, normSmart, SMART_FIELDS, SMART_OPS, SOURCE_VALUES, TRACK_COLORS } from './smart.js';
import { History, exportSession, sessionTitle } from './history.js';
import { MissingChecker, relocateTracks, findDuplicates, mergeDuplicates, buildBackup, restoreBackup } from './library-tools.js';
import { parseTraktorNml, readSeratoCrates, parseVirtualDjXml, importParsed, mergeImportedCues } from './importers.js';
import { registerLightingRoutes } from './lighting/routes.js';
import { registerLinkRoutes } from './link/index.js';
import { registerLyricsRoutes } from './lyrics.js';
import { registerRecordingRoutes } from './recorder.js';
import { registerTtsRoutes } from './tts.js';
import { registerMcp } from './mcp.js';
import { registerBroadcastRoutes } from './broadcast.js';
import { registerCdjRoutes } from './cdj/routes.js';
import { findIdenticalTrack } from './upload-dedupe.js';
import { registerStemRoutes } from './stems.js';
import { installAppLog, appLog, readAppLog, logLine } from './applog.js';
import { registerUpdateRoutes } from './update.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm', '.aif': 'audio/wav', '.aiff': 'audio/wav', '.m4b': 'audio/mp4',
  '.m4v': 'video/mp4', '.mov': 'video/mp4',
};
// Content types we pass on for media from files / media servers. Anything else (text/html, image/svg+xml, XML…)
// could run script on the app's origin if opened directly, so it is sent as application/octet-stream.
const SAFE_IMAGE = /^image\/(jpeg|png|gif|webp|bmp|avif)$/;
export function safeMediaType(type, kind = 'audio') {
  let t = String(type || '').split(';')[0].trim().toLowerCase();
  if (t === 'image/jpg' || t === 'image/pjpeg') t = 'image/jpeg';
  if (kind === 'image') return SAFE_IMAGE.test(t) ? t : 'application/octet-stream';
  if (/^(audio|video)\/[\w.+-]+$/.test(t) || t === 'application/ogg') return t;
  return 'application/octet-stream';
}
// Every API response: never rendered as a document with scripts, even when opened directly in a tab.
const API_CSP = "default-src 'none'; sandbox";
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** Cookie carrying the per-launch token of the desktop app (see createServer's `launchToken`). */
export const LAUNCH_COOKIE = 'opendj_launch';

export function isLoopback(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '::ffff:127.0.0.1';
}
const csv = (v) => String(v || '').split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

export function defaultDataDir() {
  if (process.env.OPENDJ_DATA) return process.env.OPENDJ_DATA;
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || home, 'OpenDJ');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'OpenDJ');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opendj');
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const mimeOf = (req) => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

// Request body limits. Bodies are buffered in memory, so the default is small; the public login routes get even
// less (they are reachable without a session), and routes that really take big bodies opt in with `bodyLimit`.
const KiB = 1024, MiB = 1024 * KiB;
const DEFAULT_BODY_LIMIT = 1 * MiB;
const AUTH_BODY_LIMIT = 16 * KiB;
const BIG_JSON = 8 * MiB;      // long id / path lists (bulk edits, big playlists, settings with MIDI maps / lighting)
const IMPORT_LIMIT = 50 * MiB; // rekordbox / Traktor / VirtualDJ XML, M3U sent as content

async function readBody(req, limit = DEFAULT_BODY_LIMIT) {
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'Body too large');
  const chunks = []; let n = 0;
  // Preserve the socket on early exit so the error handler can deliver HTTP 413 before closing it.
  for await (const c of req.iterator({ destroyOnReturn: false })) { n += c.length; if (n > limit) throw new HttpError(413, 'Body too large'); chunks.push(c); }
  const raw = Buffer.concat(chunks);
  if (!raw.length) return {};
  // JSON only with exactly `application/json` (not a CORS-safelisted type, so cross-site pages need a preflight).
  if (mimeOf(req) === 'application/json') {
    let v;
    try { v = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
    return v && typeof v === 'object' ? v : {};
  }
  if (mimeOf(req) === 'application/octet-stream') return raw;
  throw new HttpError(415, 'Send JSON (Content-Type: application/json)');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendBodyLimitError(req, res, obj) {
  const body = JSON.stringify(obj);
  // Deliver a complete response before closing a socket whose client may still be uploading.
  // Closing immediately can replace the response with ECONNRESET on Windows.
  res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), Connection: 'close' });
  res.write(body);
  let finished = false;
  const finish = () => {
    if (finished) return; finished = true; clearTimeout(timer);
    req.off('end', finish); req.off('error', finish); req.off('close', finish);
    if (!res.destroyed && !res.writableEnded) res.end();
  };
  const timer = setTimeout(finish, 1000); timer.unref();
  req.once('end', finish); req.once('error', finish); req.once('close', finish);
  res.once('close', finish);
  req.resume(); // discard without buffering, for at most one second
  if (req.readableEnded) finish();
}

/** Parse a Range header against a size: { start, end } | 'invalid' | null (no/ignored range -> full body). */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null; // multi-range or unknown unit: answer with the full file
  if (m[1] === '' && m[2] === '') return 'invalid';
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); if (!n) return 'invalid'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

const pipeQuiet = (src, res) => pipeline(src, res).catch(() => { if (!res.destroyed) res.destroy(); });

async function sendFileRange(req, res, file, mime) {
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new HttpError(404, 'File missing (drive disconnected?)');
  const range = parseRange(req.headers.range, st.size);
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (range === 'invalid') { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
  if (range) {
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`, 'Content-Length': range.end - range.start + 1 });
    if (req.method === 'HEAD') return res.end();
    return pipeQuiet(fs.createReadStream(file, { start: range.start, end: range.end }), res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  return pipeQuiet(fs.createReadStream(file), res);
}

const PLACEHOLDER = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#20252d"/><path d="M24 11v13.5a4 4 0 1 1-2-3.46V15l-6 1.5v10a4 4 0 1 1-2-3.46V13z" fill="#4a5361"/></svg>';
function sendPlaceholder(res) {
  if (res.headersSent) return res.end();
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' });
  res.end(PLACEHOLDER);
}

/** Stream a remote media-server URL to the client (Range passed through). Aborts upstream when the client leaves. */
/** A media server problem in words a DJ can act on (instead of Node's "fetch failed"). */
export function mediaServerError(url, { status, err, timeout, name } = {}) {
  let host = ''; try { host = new URL(url).host; } catch { /* */ }
  const who = name ? `${name}${host ? ` (${host})` : ''}` : host || 'the media server';
  if (timeout) return `${who} did not answer in time — check it's on and reachable`;
  if (err) return `Can't reach ${who} — check it's on and reachable from this computer`;
  if (status === 401 || status === 403) return `${who} refused the request — check the login in the server's settings`;
  if (status === 404) return `${who} no longer has this track (HTTP 404) — rescan the server`;
  if (status >= 500) return `${who} had a problem (HTTP ${status}) — try again in a moment`;
  return `${who} answered HTTP ${status}`;
}

const cspCache = new Map();
/** The Content-Security-Policy header for a public HTML page: its <meta http-equiv> policy + frame-ancestors 'none'. */
export async function htmlCsp(file, mtime = 0) {
  const hit = cspCache.get(file);
  if (hit && hit.mtime === mtime) return hit.csp;
  const html = await fs.promises.readFile(file, 'utf8').catch(() => '');
  const m = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(["'])(.*?)\1/i.exec(html);
  const meta = m ? m[2].trim().replace(/;\s*$/, '') : '';
  const csp = meta ? `${meta}; frame-ancestors 'none'` : "frame-ancestors 'none'";
  cspCache.set(file, { mtime, csp });
  return csp;
}

async function proxy(req, res, { url, headers = {}, name }, { connectTimeout = 15000, kind = 'audio' } = {}) {
  const h = { ...headers };
  if (req.headers.range) h.Range = req.headers.range;
  const ctrl = new AbortController();
  const onClose = () => ctrl.abort();
  res.on('close', onClose);
  const timer = setTimeout(() => ctrl.abort(), connectTimeout);
  let up;
  try { up = await fetch(url, { headers: h, signal: ctrl.signal }); } catch (e) {
    res.off('close', onClose);
    if (res.destroyed) return;
    throw new HttpError(502, mediaServerError(url, { timeout: ctrl.signal.aborted, err: !ctrl.signal.aborted, name }));
  } finally { clearTimeout(timer); }
  if (![200, 206, 416].includes(up.status)) {
    ctrl.abort();
    res.off('close', onClose);
    throw new HttpError(502, mediaServerError(url, { status: up.status, name }));
  }
  const out = { 'content-type': safeMediaType(up.headers.get('content-type'), kind) };
  for (const k of ['content-length', 'content-range', 'accept-ranges']) {
    const v = up.headers.get(k); if (v) out[k] = v;
  }
  res.writeHead(up.status, out);
  if (!up.body || req.method === 'HEAD') { ctrl.abort(); return res.end(); }
  await pipeline(Readable.fromWeb(up.body), res).catch(() => { ctrl.abort(); if (!res.destroyed) res.destroy(); });
  res.off('close', onClose);
}

/**
 * @param {object} o
 * @param {string} [o.dataDir]
 * @param {boolean} [o.auth]     require a password (default: on when OPENDJ_AUTH=1; start() turns it on for non-loopback hosts)
 * @param {string|false} [o.ffmpeg]  ffmpeg path, or false to disable (default: OPENDJ_FFMPEG / bundled / PATH)
 * @param {string[]} [o.allowedHosts]  extra Host names accepted (OPENDJ_ALLOWED_HOSTS)
 * @param {string[]} [o.roots]   folders the UI may browse/add (OPENDJ_MUSIC_ROOTS); setting them turns the restriction on
 * @param {string|boolean} [o.trustProxy]  reverse proxy trust (OPENDJ_TRUST_PROXY): '1' or a list of proxy addresses
 * @param {string} [o.launchToken]  Electron only: every request must carry this token in the LAUNCH_COOKIE cookie, so
 *   other local users / processes cannot use the password-less desktop server. Not set by `npm run web` / tests.
 */
export function createServer({ dataDir = defaultDataDir(), log = console, auth: authOpt, ffmpeg: ffmpegOpt, allowedHosts, roots: rootsOpt, password, trustProxy, launchToken, tts, mcp: mcpOpts } = {}) {
  const library = new Library(dataDir);
  const sse = new Set();
  const emit = (type, payload) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const r of sse) r.write(msg);
  };
  library.listeners.add(emit);
  const history = new History(dataDir);
  history.onError = (e) => emit('job-error', { key: 'save', message: `Could not save play history: ${e.message}` });
  const pendingWarnings = [...library.loadErrors, ...history.loadErrors];
  const missing = new MissingChecker(library, { onChange: () => emit('library', { what: 'missing' }) });

  // ---------------- hosting / security config ----------------
  const pw = password ?? process.env.OPENDJ_PASSWORD;
  const trust = trustProxy ?? process.env.OPENDJ_TRUST_PROXY;
  const extraHosts = new Set((allowedHosts || csv(process.env.OPENDJ_ALLOWED_HOSTS)).map((h) => h.toLowerCase()));
  // Login turns on when asked for (auth: true, OPENDJ_AUTH=1, --auth, a non-loopback HOST via start()), and also
  // whenever the configuration says the server is reached from elsewhere: a password, a trusted reverse proxy or
  // extra host names. A reverse proxy on the same machine connects from 127.0.0.1, so HOST alone can't tell.
  const exposed = !!pw || !!parseTrustProxy(trust) || extraHosts.size > 0;
  const authEnabled = authOpt === true || (authOpt !== false && (process.env.OPENDJ_AUTH === '1' || exposed));
  if (extraHosts.size && !authEnabled) throw new Error('OPENDJ_ALLOWED_HOSTS is set but login is off: remove it, or turn login on (OPENDJ_AUTH=1 / --auth / OPENDJ_PASSWORD)');
  const auth = new Auth({ dataDir, enabled: authEnabled, password: pw, trustProxy: trust, log });
  const envRoots = rootsOpt || (process.env.OPENDJ_MUSIC_ROOTS ? process.env.OPENDJ_MUSIC_ROOTS.split(path.delimiter).filter(Boolean) : null);
  const restricted = authEnabled || !!envRoots; // hosted mode: never expose the whole filesystem
  const uploadDir = () => path.resolve(library.settings.uploadDir || process.env.OPENDJ_UPLOAD_DIR || path.join(dataDir, 'Uploads'));
  const realish = (p) => { const abs = path.resolve(String(p)); try { return fs.realpathSync.native(abs); } catch { return abs; } };
  const allowedRoots = () => {
    const list = envRoots || (Array.isArray(library.settings.allowedRoots) && library.settings.allowedRoots.length ? library.settings.allowedRoots : null)
      || [path.join(os.homedir(), 'Music'), uploadDir(), library.settings.downloadDir].filter(Boolean);
    return [...new Set(list.map((r) => realish(r)))];
  };
  const within = (p, roots) => { const a = path.resolve(String(p)), r = realish(p); return roots.some((root) => isInside(root, a) && isInside(root, r)); };
  /** Throws 403 when hosted mode forbids this path. Returns the resolved path. */
  const allowPath = (p, what = 'This folder') => {
    if (typeof p !== 'string' || !p) throw new HttpError(400, 'Path required');
    if (restricted && !within(p, allowedRoots())) throw new HttpError(403, `${what} is outside the allowed music folders`);
    return path.resolve(p);
  };
  const pathAllowed = (p) => !restricted || within(p, allowedRoots());
  /**
   * Local files that may be served / written next to (lyrics): allowed roots + download/upload folders. Library
   * folders are NOT trusted on their own: they come from library.json, which a restored backup can rewrite.
   */
  const readable = (file) => !restricted || within(file, [...allowedRoots(), realish(library.settings.downloadDir), realish(uploadDir())]);
  // imports only add media files inside the allowed roots
  const addFileChecked = (lib, file, ...a) => (pathAllowed(file) ? addFile(lib, file, ...a) : Promise.resolve(null));

  // ---------------- ffmpeg / transcoding ----------------
  let ff = null;
  const ffReady = findFfmpeg(ffmpegOpt === undefined ? process.env.OPENDJ_FFMPEG : ffmpegOpt).then((r) => {
    ff = r;
    if (r) log.log?.(`[opendj] FFmpeg ${r.version} (${r.source}) - extra formats enabled`);
    else log.log?.('[opendj] FFmpeg not found - ALAC/WMA/APE/DSD/video files need FFmpeg (set OPENDJ_FFMPEG or install it)');
    return r;
  }).catch(() => null);
  library.media = { ffmpeg: () => ff, ready: ffReady };
  const transcoder = new Transcoder({
    dir: path.join(dataDir, 'transcode-cache'), ffmpeg: () => ff, sendFile: sendFileRange, log,
    maxBytes: () => Math.max(0.1, Number(library.settings.transcodeCacheGB) || 4) * 2 ** 30,
  });
  const needsFfmpeg = (what) => Object.assign(new HttpError(415, `${what} needs FFmpeg, which is not installed on the server. Install FFmpeg or use the desktop app.`), { code: 'needs-ffmpeg' });

  const playlistTrackIds = (p) => (p.smart ? evaluateSmart(p.smart, library.allTracks()) : p.trackIds);
  const resolvedPlaylists = () => {
    const all = library.data.playlists.some((p) => p.smart) ? library.allTracks() : null;
    return library.data.playlists.map((p) => (p.smart ? { ...p, trackIds: evaluateSmart(p.smart, all) } : p));
  };
  const attachment = (res, type, name, body) => {
    res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${String(name).replace(/[^\w.\- ]+/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}` });
    res.end(body);
  };
  const localFile = (t) => (t && (t.localPath || (t.sourceType === 'local' ? t.path : null))) || null;
  const statOk = (f, ms = 4000) => Promise.race([fs.promises.stat(f).then((st) => st, () => null), new Promise((r) => { const tm = setTimeout(() => r(undefined), ms); tm.unref?.(); })]);
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
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, ...opts });
  };
  const track = (tid) => { const t = library.getTrack(tid); if (!t) throw new HttpError(404, 'Track not found'); return t; };

  // ---------------- health / auth / capabilities ----------------
  route('GET', '/api/health', () => ({ ok: true }), { public: true });
  route('GET', '/api/auth/status', ({ req }) => ({ enabled: auth.enabled, authenticated: auth.check(req), setupRequired: auth.setupRequired }), { public: true });
  const authRoute = { public: true, bodyLimit: AUTH_BODY_LIMIT };
  route('POST', '/api/auth/login', async ({ req, res, body }) => { await auth.login(req, res, body.password); return { ok: true }; }, authRoute);
  route('POST', '/api/auth/setup', async ({ req, res, body }) => { await auth.setup(req, res, body); return { ok: true }; }, authRoute);
  route('POST', '/api/auth/logout', async ({ req, res }) => { auth.logout(req, res); return { ok: true }; }, authRoute);
  route('POST', '/api/auth/password', async ({ req, res, body }) => { if (!auth.enabled) throw new HttpError(400, 'Login is not enabled'); await auth.changePassword(req, res, body); return { ok: true }; }, { bodyLimit: AUTH_BODY_LIMIT });
  route('GET', '/api/capabilities', async () => {
    await ffReady;
    return {
      ffmpeg: !!ff, version: ff?.version || null, ffmpegSource: ff?.source || null, videoEncode: !!ff?.encoders?.libx264,
      formats: formatList(ff).all, formatGroups: formatList(ff),
      hosted: restricted, auth: auth.enabled, upload: { maxMB: Number(library.settings.uploadMaxMB) || 2048, accept: formatList(ff).all.map((e) => '.' + e) },
      transcodeCache: transcoder.stats(),
    };
  });

  // ---------------- tracks ----------------
  route('GET', '/api/tracks', async () => {
    const all = library.allTracks();
    const miss = await missing.missingIdsAsync(all);
    return miss.size ? all.map((t) => (miss.has(t.id) ? { ...t, missing: true } : t)) : all;
  });
  route('PATCH', '/api/tracks/:id', async ({ params, body }) => library.updateTrack(track(params.id).id, body));
  // Bulk edit: apply the same patch to many tracks (multi-select track info editor).
  route('POST', '/api/tracks/update', async ({ body }) => {
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((i) => library.getTrack(i));
    for (const i of ids) library.updateTrack(i, body.patch && typeof body.patch === 'object' ? body.patch : {});
    return { updated: ids.length };
  }, { bodyLimit: BIG_JSON });
  route('GET', '/api/tracks/missing', async () => [...await missing.missingIdsAsync(library.allTracks(), { full: true })]);
  route('POST', '/api/tracks/relocate', async ({ body }) => {
    allowPath(body.folder);
    const ids = Array.isArray(body.ids) && body.ids.length ? body.ids : [...await missing.missingIdsAsync(library.allTracks(), { full: true })];
    const r = await relocateTracks(library, body.folder, ids, { confirm: body.confirm && typeof body.confirm === 'object' ? body.confirm : {} });
    missing.invalidate(r.relocated.map((x) => x.id));
    return r;
  }, { bodyLimit: BIG_JSON });
  route('GET', '/api/tracks/duplicates', () => findDuplicates(library.allTracks()));
  route('POST', '/api/tracks/dedupe', async ({ body }) => mergeDuplicates(library, body.groups), { bodyLimit: BIG_JSON });
  route('POST', '/api/tracks/delete', async ({ body }) => {
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
    library.removeTracks(ids);
    for (const id of ids) stems.evict(id).catch(() => {});
    for (const id of ids) transcoder.evict(id).catch(() => {});
    return { ok: true };
  }, { bodyLimit: BIG_JSON });
  route('POST', '/api/tracks/played', async ({ body }) => {
    const t = track(body.id); t.playCount = (t.playCount || 0) + 1; t.lastPlayed = Date.now();
    history.record(t, t.lastPlayed);
    library.changed('tracks'); return t;
  });

  /** Local file of a track, checked: exists, is a regular media file, may be served. */
  const servableFile = async (t) => {
    const file = t.localPath && (await statOk(t.localPath))?.isFile() ? t.localPath : t.sourceType === 'local' ? t.path : null;
    if (!file) return null;
    if (!isMediaPath(file)) throw new HttpError(403, 'Not a media file');
    if (!readable(file)) throw new HttpError(403, 'File is outside the allowed music folders');
    const st = await statOk(file);
    if (st === undefined) throw new HttpError(504, 'The drive holding this file does not respond');
    if (!st) { // tell the library right away (the Missing files view, the ⚠ in the row), not 15 s and a refresh later
      missing.invalidate([t.id]); missing.missingIdsAsync([t]).then((m) => { if (m.has(t.id)) emit('library', { what: 'missing' }); }).catch(() => {});
      throw new HttpError(404, 'File missing (drive disconnected?)');
    }
    if (!st.isFile()) throw new HttpError(404, 'Not a file');
    return { file, st };
  };

  /** AIFF -> WAV in-process (cached in the transcode cache, served with Range). Falls back to FFmpeg for AIFF-C codecs. */
  const serveAiff = async (req, res, t, file, st) => {
    const cached = transcoder.file(t.id, 'wav');
    if (await transcoder.fresh(cached, st.mtimeMs)) { transcoder.touch(cached); return sendFileRange(req, res, cached, 'audio/wav'); }
    let wav;
    try { wav = aiffToWav(await fs.promises.readFile(file)); } catch (e) {
      await ffReady;
      if (ff) return transcoder.serveAudio(req, res, { key: t.id, input: file, srcMtime: st.mtimeMs, sampleRate: t.sampleRate });
      throw /Unsupported AIFC/.test(e.message) ? needsFfmpeg('This compressed AIFF-C file') : new HttpError(415, `Cannot read AIFF: ${e.message}`);
    }
    const tmp = `${cached}.${crypto.randomBytes(4).toString('hex')}.part`;
    await fs.promises.writeFile(tmp, wav);
    await fs.promises.rename(tmp, cached);
    transcoder.prune(cached).catch(() => {});
    return sendFileRange(req, res, cached, 'audio/wav');
  };

  const srcName = (t) => { try { return library.getSource(t.sourceId)?.name || ''; } catch { return ''; } };
  route('GET', '/api/tracks/:id/stream', async ({ params, req, res }) => {
    const t = track(params.id);
    const local = await servableFile(t);
    if (local) {
      const { file, st } = local;
      const ext = extOf(file);
      if (ext === '.aif' || ext === '.aiff') return serveAiff(req, res, t, file, st);
      const hasVideo = t.hasVideo ?? (isVideoByName(ext) || undefined);
      if (needsTranscode({ ext, codec: t.codec, hasVideo })) {
        await ffReady;
        if (!ff) {
          // Without FFmpeg, mp4/mov/webm videos may still decode in the browser (audio track); the rest can't.
          if (BROWSER_VIDEO_EXT.has(ext) && t.codec !== 'alac') return sendFileRange(req, res, file, MIME[ext] || 'video/mp4');
          throw needsFfmpeg(`This ${ext.slice(1).toUpperCase()}${t.codec && t.codec !== ext.slice(1) ? ` (${t.codec})` : ''} file`);
        }
        return transcoder.serveAudio(req, res, { key: t.id, input: file, srcMtime: st.mtimeMs, sampleRate: t.sampleRate, dsd: DSD_EXT.has(ext) });
      }
      return sendFileRange(req, res, file, MIME[ext] || 'application/octet-stream');
    }
    if (t.sourceType !== 'remote') throw new HttpError(404, 'File missing');
    if (!remoteBrowserDecodable(t.format)) {
      await ffReady;
      if (ff) {
        // Fetch the original from the media server, transcode locally to FLAC (lossless), cache it.
        const reqInfo = remoteStream(library, t);
        return transcoder.serveAudio(req, res, {
          key: t.id, sampleRate: t.sampleRate, dsd: ['dsf', 'dff'].includes(String(t.format).toLowerCase()),
          input: async (signal, tmp) => {
            let up;
            try { up = await fetch(reqInfo.url, { headers: reqInfo.headers || {}, signal }); } catch (e) { if (signal?.aborted) throw e; throw new HttpError(502, mediaServerError(reqInfo.url, { err: true, name: srcName(t) })); }
            if (!up.ok || !up.body) throw new HttpError(502, mediaServerError(reqInfo.url, { status: up.status, name: srcName(t) }));
            await pipeline(Readable.fromWeb(up.body), fs.createWriteStream(tmp), { signal });
            return tmp;
          },
        });
      }
      // No local FFmpeg: ask the media server to transcode, where its API can.
      const c = clientFor(library, t.sourceId);
      const tr = c.transcodeRequest?.(t.remoteId, t);
      if (tr) return proxy(req, res, { ...tr, name: srcName(t) });
      throw needsFfmpeg(`This ${String(t.format).toUpperCase()} track`);
    }
    return proxy(req, res, { ...remoteStream(library, t), name: srcName(t) });
  });

  // Video of a track (for the video decks): browser-playable files as is (Range), others remuxed/transcoded to MP4.
  route('GET', '/api/tracks/:id/video', async ({ params, req, res }) => {
    const t = track(params.id);
    const local = await servableFile(t);
    if (!local) throw new HttpError(404, 'Video is only available for local files');
    const { file, st } = local;
    const ext = extOf(file);
    await ffReady;
    let { hasVideo, videoCodec, codec } = t;
    if (ff && (hasVideo === undefined || (hasVideo && !videoCodec))) {
      const p = await probe(ff.path, file).catch(() => null);
      if (p) { hasVideo = p.hasVideo; videoCodec = p.videoCodec; codec = p.audioCodec || codec; }
    }
    if (hasVideo === undefined) hasVideo = BROWSER_VIDEO_EXT.has(ext) || isVideoByName(ext);
    if (!hasVideo) throw new HttpError(404, 'This track has no video');
    if (browserPlayableVideo(ext, ff ? videoCodec : '', ff ? codec : '')) return sendFileRange(req, res, file, VIDEO_MIME[ext] || 'video/mp4');
    if (!ff) throw needsFfmpeg('Playing this video');
    return transcoder.serveVideo(req, res, { key: t.id, input: file, srcMtime: st.mtimeMs, videoCodec, audioCodec: codec });
  });

  route('GET', '/api/tracks/:id/cover', async ({ params, req, res }) => {
    const t = track(params.id);
    const file = t.localPath || (t.sourceType === 'local' ? t.path : null);
    if (file && isMediaPath(file) && readable(file) && (await statOk(file))?.isFile()) {
      const mm = await parseFile(file, { duration: false }).catch(() => null);
      const pic = mm?.common.picture?.[0];
      if (!pic) return sendPlaceholder(res);
      res.writeHead(200, { 'Content-Type': safeMediaType(pic.format, 'image'), 'Cache-Control': 'max-age=86400' });
      return res.end(Buffer.from(pic.data));
    }
    const r = t.sourceType === 'remote' ? remoteCover(library, t) : null;
    if (!r) return sendPlaceholder(res);
    return proxy(req, res, r, { kind: 'image' }).catch(() => sendPlaceholder(res));
  });
  route('GET', '/api/tracks/:id/waveform', async ({ params, req, res }) => {
    const f = library.waveformPath(track(params.id).id);
    if (!(await statOk(f))?.isFile()) throw new HttpError(404, 'Not analysed');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    return pipeQuiet(fs.createReadStream(f), res);
  });
  route('PUT', '/api/tracks/:id/waveform', async ({ params, body }) => {
    if (!Buffer.isBuffer(body)) throw new HttpError(400, 'Expected binary body');
    await fs.promises.writeFile(library.waveformPath(track(params.id).id), body);
    return { ok: true };
  }, { bodyLimit: 16 * MiB });
  route('POST', '/api/files', async ({ body }) => {
    const added = [];
    for (const p of Array.isArray(body.paths) ? body.paths : []) {
      if (typeof p !== 'string' || !pathAllowed(p)) continue;
      const st = await fs.promises.stat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) { for await (const f of walk(p)) { const t = await addFile(library, f); if (t) added.push(t.id); } }
      else if (AUDIO_EXT.has(path.extname(p).toLowerCase())) { const t = await addFile(library, p); if (t) added.push(t.id); }
    }
    library.changed('tracks');
    return { added };
  }, { bodyLimit: BIG_JSON });

  // ---------------- browser upload (hosted mode: users can't hand us local paths) ----------------
  // Raw body, file name in `X-Filename` (URI-encoded). Saved into the uploads folder, which is a library folder.
  route('POST', '/api/upload', async ({ req, query }) => {
    let name;
    try { name = decodeURIComponent(String(req.headers['x-filename'] || query.get('name') || '')); } catch { throw new HttpError(400, 'Bad file name'); }
    name = path.basename(name.replace(/\\/g, '/'));
    const ext = extOf(name);
    if (!name || !AUDIO_EXT.has(ext)) throw new HttpError(415, `Unsupported file type${ext ? ` (${ext})` : ''}. Upload audio or video files.`);
    const limit = (Number(library.settings.uploadMaxMB) || 2048) * 1024 * 1024;
    const len = Number(req.headers['content-length']);
    if (len > limit) throw new HttpError(413, `File too large (limit ${Math.round(limit / 1048576)} MB)`);
    const dir = uploadDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.upload-${crypto.randomBytes(8).toString('hex')}.part`);
    let n = 0;
    const sha = crypto.createHash('sha256');
    try {
      await pipeline(req, async function* (src) {
        for await (const c of src) { n += c.length; if (n > limit) throw new HttpError(413, `File too large (limit ${Math.round(limit / 1048576)} MB)`); sha.update(c); yield c; }
      }, fs.createWriteStream(tmp, { flags: 'wx' }));
      if (!n) throw new HttpError(400, 'Empty file');
      // the same file uploaded again: keep the existing track instead of adding "name (2).ext"
      const same = await findIdenticalTrack(library, { size: n, hash: sha.digest('hex') });
      if (same) { await fs.promises.rm(tmp, { force: true }); return { id: same.id, track: same, duplicate: true }; }
      const stem = safe(path.basename(name, ext)).slice(0, 180);
      const dest = await uniqueName(dir, stem, ext.slice(1));
      await fs.promises.rename(tmp, dest);
      const folder = library.data.folders.find((f) => path.resolve(f.path) === dir) || library.addFolder(dir, 'Uploads');
      const t = await addFile(library, dest, folder.id);
      if (!t) throw new HttpError(415, 'Could not read this file');
      folder.trackCount = (folder.trackCount || 0) + 1;
      library.changed('tracks');
      return { id: t.id, track: t };
    } catch (e) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }, { raw: true });

  // ---------------- playlists ----------------
  // Smart playlists are returned with their trackIds computed from the rules, so automix / export just work.
  route('GET', '/api/playlists', () => resolvedPlaylists());
  route('POST', '/api/playlists', async ({ body }) => {
    const extra = body.folder ? { folder: String(body.folder).slice(0, 200) } : {};
    if (body.smart) extra.smart = normSmart(body.smart);
    const p = library.createPlaylist(body.name, Array.isArray(body.trackIds) ? body.trackIds.filter((x) => typeof x === 'string') : [], extra);
    return p.smart ? { ...p, trackIds: playlistTrackIds(p) } : p;
  }, { bodyLimit: BIG_JSON });
  route('PATCH', '/api/playlists/:id', async ({ params, body }) => {
    const p = library.updatePlaylist(params.id, { ...body, ...(body.smart ? { smart: normSmart(body.smart) } : {}), ...('folder' in body ? { folder: body.folder ? String(body.folder).slice(0, 200) : body.folder } : {}) });
    if (!p) throw new HttpError(404, 'No playlist');
    return p.smart ? { ...p, trackIds: playlistTrackIds(p) } : p;
  }, { bodyLimit: BIG_JSON });
  route('DELETE', '/api/playlists/:id', async ({ params }) => { library.deletePlaylist(params.id); return { ok: true }; });
  route('POST', '/api/playlists/:id/add', async ({ params, body }) => {
    if (library.getPlaylist(params.id)?.smart) throw new HttpError(400, 'Smart playlists are filled by their rules');
    return library.addToPlaylist(params.id, Array.isArray(body.trackIds) ? body.trackIds : []) || Promise.reject(new HttpError(404, 'No playlist'));
  }, { bodyLimit: BIG_JSON });
  route('GET', '/api/smart/fields', () => ({ fields: SMART_FIELDS, ops: SMART_OPS, sources: SOURCE_VALUES, colors: TRACK_COLORS }));
  route('POST', '/api/smart/preview', async ({ body }) => {
    const ids = evaluateSmart(normSmart(body.smart), library.allTracks());
    return { count: ids.length, trackIds: ids.slice(0, 500) };
  });
  route('GET', '/api/playlists/:id/m3u', async ({ params, res }) => {
    const p = library.getPlaylist(params.id); if (!p) throw new HttpError(404, 'No playlist');
    const m3u = buildM3U(playlistTrackIds(p).map((t) => library.getTrack(t)).filter(Boolean));
    attachment(res, 'audio/x-mpegurl; charset=utf-8', `${String(p.name)}.m3u8`, m3u);
  });

  // ---------------- import / export ----------------
  const readImport = async (body, key) => {
    if (body[key] != null) return String(body[key]);
    allowPath(body.path, 'This file');
    try { return await fs.promises.readFile(body.path, 'utf8'); } catch (e) {
      throw new HttpError(400, e.code === 'ENOENT' ? 'File not found' : e.code === 'EISDIR' ? 'That is a folder, not a file' : `Cannot read the file (${e.code || e.message})`);
    }
  };
  /** Parser errors ("Not a Traktor collection", malformed XML) are the user's file, not a server fault: 400 with the message. */
  const parseImport = (fn, xml) => { try { return fn(xml); } catch (e) { throw new HttpError(400, e.message || 'Could not read this file'); } };
  route('POST', '/api/import/m3u', async ({ body }) => {
    const content = await readImport(body, 'content');
    const baseDir = body.path ? path.dirname(body.path) : (typeof body.baseDir === 'string' ? body.baseDir : os.homedir());
    const ids = [];
    for (const entry of parseM3U(content, baseDir)) {
      const t = await addFileChecked(library, entry.path).catch(() => null);
      if (t) ids.push(t.id);
    }
    return library.createPlaylist(body.name || (body.path ? path.basename(body.path).replace(/\.m3u8?$/i, '') : 'Imported'), ids);
  }, { bodyLimit: IMPORT_LIMIT });
  route('POST', '/api/import/rekordbox', async ({ body }) => {
    const xml = await readImport(body, 'xml');
    const parsed = parseImport(parseRekordboxXml, xml);
    const byLoc = new Map();
    let imported = 0, cuesAdded = 0, cuesSkipped = 0;
    for (const rt of parsed.tracks) {
      if (!rt.location) continue;
      const t = await addFileChecked(library, rt.location).catch(() => null);
      if (!t) continue;
      byLoc.set(rt.location, t.id);
      // cues: merged only when the XML has some (auto cues replaceable, the user's own kept); tags only fill empty ones
      const m = mergeImportedCues(t.cues, (rt.cues || []).map((c) => ({ ...c, index: c.type === 'memory' ? -1 : c.index })));
      cuesAdded += m.added; cuesSkipped += m.skipped;
      const fill = Object.fromEntries([['title', rt.title], ['artist', rt.artist], ['album', rt.album], ['genre', rt.genre]].filter(([k, v]) => v && !t[k]));
      library.updateTrack(t.id, {
        ...fill,
        bpm: rt.bpm || t.bpm, key: rt.key || t.key, rating: rt.rating ?? t.rating, comment: rt.comments || t.comment,
        ...(rt.cues?.length ? { cues: m.cues } : {}),
        gridOffset: rt.grid?.offset ?? t.gridOffset,
        analyzed: !!rt.bpm || t.analyzed,
        ...(rt.bpm && rt.grid ? { gridLocked: true } : rt.bpm ? { bpmLocked: true } : {}), // imported grid is authoritative
        ...(rt.color ? { color: rt.color } : {}),
      });
      imported++;
    }
    let playlists = 0;
    for (const pl of parsed.playlists) {
      const ids = pl.trackKeys.map((k) => byLoc.get(k)).filter(Boolean);
      library.createPlaylist(pl.name, ids, { folder: pl.path?.length ? pl.path.join(' / ') : 'rekordbox' }); playlists++;
    }
    return { imported, playlists, missing: parsed.tracks.length - imported, cuesAdded, cuesSkipped };
  }, { bodyLimit: IMPORT_LIMIT });
  route('POST', '/api/import/traktor', async ({ body }) => {
    const xml = await readImport(body, 'xml');
    return importParsed(library, addFileChecked, parseImport(parseTraktorNml, xml), { folderPrefix: 'Traktor' });
  }, { bodyLimit: IMPORT_LIMIT });
  route('POST', '/api/import/serato', async ({ body }) => {
    allowPath(body.path);
    if (!(await statOk(body.path))?.isDirectory()) throw new HttpError(400, 'Folder does not exist');
    const { playlists } = readSeratoCrates(body.path);
    return importParsed(library, addFileChecked, { tracks: [], playlists }, { folderPrefix: 'Serato' });
  });
  route('POST', '/api/import/virtualdj', async ({ body }) => {
    const xml = await readImport(body, 'xml');
    return importParsed(library, addFileChecked, parseImport(parseVirtualDjXml, xml), { folderPrefix: 'VirtualDJ' });
  }, { bodyLimit: IMPORT_LIMIT });
  route('GET', '/api/export/rekordbox', async ({ res }) => {
    const tracks = library.allTracks().filter((t) => t.localPath || t.sourceType === 'local')
      .map((t) => ({ ...t, path: t.localPath || t.path }));
    const xml = buildRekordboxXml({ tracks, playlists: resolvedPlaylists().map((p) => ({ ...p, path: p.folder ? String(p.folder).split(' / ') : [] })) });
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': 'attachment; filename="opendj-rekordbox.xml"' });
    res.end(xml);
  });
  // Export playlists to a USB stick / folder: copies audio (Artist/Album folders) + .m3u8 per playlist + rekordbox.xml
  route('POST', '/api/export/usb', async ({ body }) => {
    const target = allowPath(body.targetDir, 'The export folder');
    const musicDir = path.join(target, 'OpenDJ', 'Music');
    await fs.promises.mkdir(musicDir, { recursive: true });
    const exported = [];
    const copied = new Map(); // trackId -> dest
    const claimed = new Map(); // dest -> source (this run): different sources never share a file name
    for (const pid of Array.isArray(body.playlistIds) ? body.playlistIds : []) {
      const p = library.getPlaylist(pid); if (!p) continue;
      const items = [];
      for (const tid of playlistTrackIds(p)) {
        const t = library.getTrack(tid); const src = localFile(t);
        if (!src || !isMediaPath(src) || !readable(src)) continue;
        const sst = await statOk(src);
        if (!sst?.isFile()) continue;
        if (!copied.has(tid)) {
          const dir = path.join(musicDir, safe(t.albumArtist || t.artist || 'Unknown'), safe(t.album || 'Singles'));
          await fs.promises.mkdir(dir, { recursive: true });
          const ext = path.extname(src), stem = safe(path.basename(src, ext));
          let dest = path.join(dir, stem + ext);
          for (let i = 2; claimed.has(dest) && claimed.get(dest) !== src; i++) dest = path.join(dir, `${stem} (${i})${ext}`);
          claimed.set(dest, src);
          const dst = await statOk(dest);
          // copy when new or when the stick holds an outdated copy (size/mtime differ; FAT has 2 s mtime resolution)
          if (!dst || dst.size !== sst.size || Math.abs(dst.mtimeMs - sst.mtimeMs) > 2000) {
            const tmp = dest + '.part';
            await fs.promises.copyFile(src, tmp);
            await fs.promises.utimes(tmp, sst.atime, sst.mtime).catch(() => {});
            await fs.promises.rename(tmp, dest);
          }
          copied.set(tid, dest);
        }
        items.push({ ...t, path: copied.get(tid) });
      }
      await fs.promises.writeFile(path.join(target, 'OpenDJ', `${String(p.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '_')}.m3u8`), buildM3U(items, path.join(target, 'OpenDJ')));
      exported.push({ name: p.name, tracks: items.length });
    }
    const tracks = [...copied.entries()].map(([tid, p]) => ({ ...library.getTrack(tid), path: p }));
    const pls = (Array.isArray(body.playlistIds) ? body.playlistIds : []).map((pid) => library.getPlaylist(pid)).filter(Boolean).map((p) => ({ ...p, trackIds: playlistTrackIds(p) }));
    await fs.promises.writeFile(path.join(target, 'OpenDJ', 'rekordbox.xml'), buildRekordboxXml({ tracks, playlists: pls }));
    return { exported, files: copied.size, target };
  }, { bodyLimit: BIG_JSON });

  // ---------------- history ----------------
  route('GET', '/api/history', () => history.list());
  route('GET', '/api/history/:id', async ({ params }) => history.get(params.id) || Promise.reject(new HttpError(404, 'No session')));
  route('PATCH', '/api/history/:id', async ({ params, body }) => { const s = history.rename(params.id, body.name); if (!s) throw new HttpError(404, 'No session'); emit('library', { what: 'history' }); return s; });
  route('DELETE', '/api/history/:id', async ({ params }) => { history.remove(params.id); emit('library', { what: 'history' }); return { ok: true }; });
  route('GET', '/api/history/:id/export', async ({ params, query, res }) => {
    const s = history.get(params.id); if (!s) throw new HttpError(404, 'No session');
    const fmt = ['txt', 'csv', 'm3u8'].includes(query.get('format')) ? query.get('format') : 'txt';
    const body = exportSession(s, fmt, (tid) => localFile(library.getTrack(tid)));
    const type = { txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', m3u8: 'audio/x-mpegurl; charset=utf-8' }[fmt];
    attachment(res, type, `${sessionTitle(s).replace(/:/g, '-')}.${fmt}`, body);
  });

  // ---------------- backup / restore ----------------
  route('GET', '/api/backup', async ({ res }) => {
    const d = new Date().toISOString().slice(0, 10);
    attachment(res, 'application/json', `opendj-backup-${d}.json`, JSON.stringify(buildBackup(library, history)));
  });
  route('POST', '/api/restore', async ({ body }) => {
    const r = restoreBackup(library, history, body, { pathAllowed: readable });
    missing.invalidate();
    return r;
  }, { bodyLimit: 200 * 1024 * 1024 });

  // ---------------- folders / drives ----------------
  route('GET', '/api/folders', async () => Promise.all(library.data.folders.map(async (f) => ({ ...f, online: !!(await statOk(f.path, 1500)) }))));
  route('POST', '/api/folders', async ({ body }) => {
    allowPath(body.path);
    if (!(await statOk(body.path))?.isDirectory()) throw new HttpError(400, 'Folder does not exist');
    const f = library.addFolder(body.path, typeof body.name === 'string' ? body.name.slice(0, 200) : undefined);
    runJob('scan:' + f.id, () => scanFolder(library, f, { onProgress: (p) => emit('scan', p) }));
    return f;
  });
  route('POST', '/api/folders/:id/scan', async ({ params }) => {
    const f = library.getFolder(params.id); if (!f) throw new HttpError(404, 'No folder');
    if (!readable(f.path)) throw new HttpError(403, 'This folder is outside the allowed music folders');
    runJob('scan:' + f.id, () => scanFolder(library, f, { onProgress: (p) => emit('scan', p) }));
    return { started: true };
  });
  route('DELETE', '/api/folders/:id', async ({ params }) => { library.removeFolder(params.id); return { ok: true }; });
  route('GET', '/api/drives', () => (restricted
    ? allowedRoots().filter((r) => fs.existsSync(r)).map((r) => ({ path: r, name: path.basename(r) || r, kind: 'home' }))
    : listDrives()));
  route('GET', '/api/browse', async ({ query }) => {
    const p = query.get('path');
    if (!restricted) return browseDir(p);
    const roots = allowedRoots().filter((r) => fs.existsSync(r));
    if (!p) return { path: '', parent: null, entries: roots.map((r) => ({ name: path.basename(r) || r, path: r })), roots: true };
    allowPath(p);
    const out = browseDir(p);
    // never offer a way above the allowed roots
    out.entries = out.entries.filter((e) => pathAllowed(e.path));
    out.parent = out.parent && pathAllowed(out.parent) ? out.parent : '';
    return out;
  });

  // ---------------- remote sources ----------------
  route('GET', '/api/source-types', () => SOURCE_TYPES);
  route('GET', '/api/sources', () => library.data.sources.map((s) => library.publicSource(s)));
  route('POST', '/api/sources', async ({ body }) => {
    const prev = typeof body.id === 'string' ? library.getSource(body.id) : null;
    if (body.id !== undefined && !prev) throw new HttpError(404, 'No source');
    // stored secrets are only reused for the same endpoint (see sourceConfigFromForm)
    let result;
    try { result = await addSource(library, sourceConfigFromForm(body, prev)); } catch (e) {
      throw e.status ? e : new HttpError(502, `Could not connect: ${String(e.message).slice(0, 300)}`);
    }
    runJob('sync:' + result.source.id, () => syncSource(library, result.source.id, { onProgress: (p) => emit('sync', p) }));
    return result;
  });
  route('POST', '/api/sources/:id/sync', async ({ params }) => {
    if (!library.getSource(params.id)) throw new HttpError(404, 'No source');
    runJob('sync:' + params.id, () => syncSource(library, params.id, { onProgress: (p) => emit('sync', p) }));
    return { started: true };
  });
  // Live playlists of a media server, and one playlist's tracks (stored as remote library tracks so they play,
  // analyse and download like synced ones; the playlist is mirrored in the library under the server).
  const remoteFail = (e) => (e.expose ? new HttpError(e.status, e.message) : e);
  route('GET', '/api/sources/:id/libraries', async ({ params }) => {
    if (!library.getSource(params.id)) throw new HttpError(404, 'No source');
    try { const c = clientFor(library, params.id); await c.connect(); return await c.listLibraries(); } catch (e) { throw remoteFail(remoteError(e)); }
  });
  route('GET', '/api/sources/:id/playlists', async ({ params }) => {
    if (!library.getSource(params.id)) throw new HttpError(404, 'No source');
    try { return await sourcePlaylists(library, params.id); } catch (e) { throw remoteFail(e); }
  });
  route('GET', '/api/sources/:id/playlists/:pid', async ({ params, query }) => {
    if (!library.getSource(params.id)) throw new HttpError(404, 'No source');
    if (!params.pid || params.pid.length > 256) throw new HttpError(400, 'Bad playlist id');
    try { return await openSourcePlaylist(library, params.id, params.pid, { name: query.get('name') || undefined }); } catch (e) { throw remoteFail(e); }
  });
  // Plex Home: list users and switch the connection to one (then re-sync: each user sees their own libraries)
  route('GET', '/api/sources/:id/users', async ({ params }) => {
    if (!library.getSource(params.id)) throw new HttpError(404, 'No source');
    try { return await plexUsers(library, params.id); } catch (e) { throw remoteFail(e); }
  });
  route('POST', '/api/sources/:id/user', async ({ params, body }) => {
    if (!library.getSource(params.id)) throw new HttpError(404, 'No source');
    let r;
    try { r = await switchPlexUser(library, params.id, body?.userId, body?.pin); } catch (e) { throw remoteFail(e); }
    runJob('sync:' + params.id, () => syncSource(library, params.id, { onProgress: (p) => emit('sync', p) }));
    return r;
  });
  route('DELETE', '/api/sources/:id', async ({ params }) => { library.removeSource(params.id); return { ok: true }; });

  // ---------------- downloads ----------------
  route('GET', '/api/downloads', () => downloads.list());
  route('POST', '/api/downloads', async ({ body }) => ({ queued: downloads.enqueue(Array.isArray(body.trackIds) ? body.trackIds : []) }), { bodyLimit: BIG_JSON });
  route('POST', '/api/downloads/cancel', async ({ body }) => { downloads.cancel(body.trackId); return { ok: true }; });

  // ---------------- settings / misc ----------------
  route('GET', '/api/settings', () => redactSettings(library.settings));
  route('PUT', '/api/settings', async ({ body }) => {
    const patch = { ...body };
    delete patch.allowedRoots; // set in settings.json or OPENDJ_MUSIC_ROOTS, never from the web UI
    delete patch.recording; delete patch.broadcast; delete patch.mcp; // only via their own validated endpoints
    for (const k of ['downloadDir', 'uploadDir']) if (k in patch && patch[k]) allowPath(String(patch[k]), 'This folder');
    const hue = patch.lighting?.outputs?.hue, curHue = library.settings.lighting?.outputs?.hue;
    // the redacted Hue key stands for the stored one, but only for the same bridge
    if (hue?.username === REDACTED) hue.username = curHue?.username && String(hue.bridge || '') === String(curHue.bridge || '') ? curHue.username : '';
    return redactSettings(library.updateSettings(patch));
  }, { bodyLimit: BIG_JSON });
  route('GET', '/api/jobs', () => [...jobs.keys()]);
  // app log: download (Settings → General → Download log), and errors from the page (window.onerror) so they end up
  // in the same file; at most 30 page reports a minute, 2 KB each
  route('GET', '/api/logs', ({ res }) => {
    const text = readAppLog();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="opendj-${VERSION}-log.txt"`, 'Cache-Control': 'no-store' });
    res.end(appLog() ? text || '(the log is empty)\n' : 'Logging to a file is off for this server (it runs inside another program or a test).\n');
  });
  const clientLog = { n: 0, at: 0 };
  route('POST', '/api/logs/client', ({ body }) => {
    const now = Date.now();
    if (now - clientLog.at > 60e3) { clientLog.at = now; clientLog.n = 0; }
    if (++clientLog.n > 30) return { ok: false };
    const lines = (Array.isArray(body?.lines) ? body.lines : [body?.message]).slice(0, 5).map((x) => String(x ?? '').replace(/\s+$/, '').slice(0, 2048)).filter(Boolean);
    for (const l of lines) logLine(l, 'page');
    return { ok: true };
  });
  route('GET', '/api/info', () => ({ version: VERSION, dataDir, platform: process.platform, tracks: Object.keys(library.data.tracks).length, hosted: restricted, auth: auth.enabled, logDir: appLog()?.dir || null }));
  // ---------------- lighting (DMX / Art-Net / sACN / WLED / Hue / OSC) ----------------
  const lighting = registerLightingRoutes({ route, library, emit });
  const link = registerLinkRoutes({ route, library, emit, log });
  // what the native stems engine decodes: the local file, or the media server's stream for remote tracks
  const stemsInput = async (t) => {
    const l = await servableFile(t);
    if (l) return { file: l.file };
    if (t.sourceType !== 'remote') return null;
    try { const r = remoteStream(library, t); return r?.url ? { url: r.url, headers: r.headers || {} } : null; } catch { return null; }
  };
  const stems = registerStemRoutes({ route, library, emit, restricted, input: stemsInput });
  registerLyricsRoutes({ route, library, emit, dataDir, canRead: readable, canWrite: readable });
  const recording = registerRecordingRoutes({ route, library, emit, pathAllowed, allowedRoots });
  const broadcast = registerBroadcastRoutes({ route, library, emit, pathAllowed: readable, log });
  registerTtsRoutes({ route, httpError: (status, msg) => new HttpError(status, msg), detect: tts });
  // remote control for AI assistants (MCP): off by default; own loopback listener, or session + token when hosted
  const mcp = registerMcp({ route, library, emit, auth, hosted: auth.enabled, version: VERSION, log, broadcastConfig: () => library.settings.broadcast || { targets: [] }, ...(mcpOpts || {}) });
  registerCdjRoutes({ route, library, emit, allowPath, readable });
  const updates = registerUpdateRoutes({ route, library, version: VERSION, hosted: restricted });

  route('GET', '/api/events', ({ req, res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: {}\n\n`);
    // startup problems (damaged library file recovered from backup…) are shown once
    while (pendingWarnings.length) res.write(`event: job-error\ndata: ${JSON.stringify({ key: 'load', message: pendingWarnings.shift() })}\n\n`);
    sse.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); sse.delete(res); });
    return undefined;
  });

  // ---------------- request guards ----------------
  let boundPort = null; // set by start()
  const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  const splitHost = (h) => { const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(h || '').trim().toLowerCase()); return m ? { name: m[1], port: m[2] ? Number(m[2]) : 80 } : null; };
  /** DNS-rebinding guard: the Host header must name this server. */
  const hostOk = (req) => {
    const h = splitHost(req.headers.host);
    if (!h) return false;
    if (extraHosts.has(h.name)) return true;
    if (auth.enabled) return extraHosts.size === 0 || LOCAL_NAMES.has(h.name); // hosted: password protects; optional allowlist
    return LOCAL_NAMES.has(h.name) && (boundPort == null || h.port === boundPort);
  };
  const publicHost = (req) => auth.forwarded(req, 'x-forwarded-host') || req.headers.host;
  /** CSRF guard: a browser Origin must be this very server (exact match; "null" and other sites are refused). */
  const originOk = (req) => {
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site') return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true; // non-browser client (browsers always send Origin on POST/PUT/DELETE)
    let u; try { u = new URL(origin); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const hosts = new Set([String(req.headers.host).toLowerCase(), String(publicHost(req)).toLowerCase()]);
    return hosts.has(u.host.toLowerCase());
  };
  // Desktop app: per-launch token (HttpOnly cookie set by electron/main.js) required on every request
  const launchKey = launchToken ? crypto.createHash('sha256').update(String(launchToken)).digest() : null;
  const launchOk = (req) => {
    const v = parseCookies(req.headers.cookie)[LAUNCH_COOKIE];
    return typeof v === 'string' && crypto.timingSafeEqual(crypto.createHash('sha256').update(v).digest(), launchKey);
  };
  const PUBLIC_FILES = new Set(['login.html', 'icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest', 'sw.js', 'favicon.ico', 'fonts/inter-latin-wght-normal.woff2', 'fonts/inter-latin-ext-wght-normal.woff2', // the login page's UI font
    'js/page-i18n.js', 'js/i18n.js', 'js/locales/ro.js']); // and its translation (static UI text only)

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end('Bad request'); }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY'); // no clickjacking, desktop mode included (frame-ancestors below)
    if (!hostOk(req)) { res.writeHead(421, { 'Content-Type': 'text/plain' }); return res.end('Misdirected request: unknown Host'); }
    if (launchKey && !launchOk(req)) { res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('This OpenDJ server only answers the OpenDJ app that started it'); }
    const isApi = url.pathname.startsWith('/api/');
    // onnxruntime-web's own module files (node_modules, not user data) may need to run as a worker script
    if (isApi && !url.pathname.startsWith('/api/stems/ort/')) res.setHeader('Content-Security-Policy', API_CSP);
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    // Block cross-site requests from web pages to this API (state-changing ones, and any API read a page attempts).
    if ((mutating || isApi) && !originOk(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('Forbidden origin'); }
    try {
      if (isApi) {
        for (const r of routes) {
          if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          if (!r.public && !auth.check(req)) throw new HttpError(401, 'Login required');
          let params;
          try { params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); } catch { throw new HttpError(400, 'Bad URL'); }
          const body = ['POST', 'PUT', 'PATCH'].includes(req.method) && !r.raw ? await readBody(req, r.bodyLimit) : (r.raw ? undefined : {});
          const out = await r.handler({ req, res, params, body, query: url.searchParams });
          if (!res.headersSent && out !== undefined) sendJson(res, 200, out);
          return;
        }
        throw new HttpError(404, 'No such endpoint');
      }
      if (mutating) throw new HttpError(405, 'Method not allowed');
      // static UI
      let p;
      try { p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, ''); } catch { throw new HttpError(400, 'Bad URL'); }
      if (!p || p === '.') p = 'index.html';
      const rel = p.replace(/\\/g, '/');
      if (auth.enabled && !PUBLIC_FILES.has(rel) && !auth.check(req)) {
        if (rel === 'index.html' || rel.endsWith('.html')) { res.writeHead(302, { Location: '/login.html', 'Cache-Control': 'no-store' }); return res.end(); }
        throw new HttpError(401, 'Login required');
      }
      const file = path.join(PUBLIC, p);
      const relCheck = path.relative(PUBLIC, file);
      if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) throw new HttpError(404, 'Not found');
      const st = await fs.promises.stat(file).catch(() => null);
      if (!st?.isFile()) throw new HttpError(404, 'Not found');
      const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
      if (rel === 'sw.js') headers['Service-Worker-Allowed'] = '/';
      // HTML pages: the page's own <meta> CSP is also sent as a header (one source of truth: the meta tag, read once
      // per file version), plus frame-ancestors, which only works as a header
      if (path.extname(file) === '.html') headers['Content-Security-Policy'] = await htmlCsp(file, st.mtimeMs);
      // the Controller Mapper is shown inside Settings: only this app may frame it
      if (rel === 'controller-mapper.html') headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'");
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      await pipeQuiet(fs.createReadStream(file), res);
    } catch (e) {
      if (!e.status) log.error?.('[opendj]', e);
      if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
      if (e.status === 413 && !res.headersSent) return sendBodyLimitError(req, res, { error: e.message, ...(typeof e.code === 'string' ? { code: e.code } : {}) });
      if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status ? e.message : 'Internal error', ...(e.code && typeof e.code === 'string' && e.status ? { code: e.code } : {}) });
      else res.end();
    }
  });
  server.on('listening', () => { const a = server.address(); if (a && typeof a === 'object') boundPort = a.port; });

  const shutdown = () => {
    try { library.flush(); } catch (e) { log.error?.('[opendj] final save failed:', e.message); }
    try { history.flush(); } catch { /* reported above */ }
    for (const r of sse) r.end();
    try { lighting?.close?.(); } catch { /* already closed */ }
    try { link?.close?.(); } catch { /* already closed */ }
    try { stems?.close?.(); } catch { /* already closed */ }
    try { recording?.close?.(); } catch { /* already closed */ }
    try { broadcast?.close?.(); } catch { /* already closed */ }
    try { mcp?.close?.(); } catch { /* already closed */ }
    downloads.queue = [];
    for (const j of downloads.active.values()) j.ctrl.abort();
  };
  return { server, library, history, downloads, transcoder, auth, lighting, link, stems, recording, broadcast, mcp, updates, ffmpegReady: ffReady, shutdown, newId };
}

/**
 * Start the server. Binding to a non-loopback address (HOST=0.0.0.0 etc.) always turns on password login.
 * opts: { port, host, dataDir, auth, ffmpeg, allowedHosts, roots, password }
 */
export async function start({ port = 0, host = '127.0.0.1', dataDir, logs = false, ...opts } = {}) {
  // undefined lets createServer decide from the environment (password / proxy / allowed hosts turn login on)
  // Electron passes auth:false with a launch token (loopback only): the token guards it, env vars must not add a login.
  const desktop = opts.auth === false && !!opts.launchToken && isLoopback(host);
  const auth = desktop ? false : opts.auth === true || !isLoopback(host) || process.env.OPENDJ_AUTH === '1' ? true : opts.auth;
  // the app log (<data>/logs/opendj.log) before anything else prints, so start-up problems are in it too
  if (logs) installAppLog(path.join(dataDir || defaultDataDir(), 'logs'), { header: `OpenDJ ${VERSION}` });
  const app = createServer({ dataDir, ...opts, auth });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, host, resolve); });
  app.port = app.server.address().port;
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  app.url = `http://${shown}:${app.port}/`;
  app.host = host;
  return app;
}
