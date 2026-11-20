// AI stems: model download/cache, ONNX Runtime Web files, and the per-track stem cache.
// Registered from server/index.js with registerStemRoutes({ route, library, emit }).
//
// Separation itself runs in the browser (public/js/stems/stems-worker.js, onnxruntime-web, WASM or WebGPU);
// the server only stores what the browser sends back and serves it to the decks:
//   <data>/stems/models/<sha256>.onnx          the downloaded model (verified, never committed to the repo)
//   <data>/stems/<trackId>/{vocals,drums,bass,other}.flac (16-bit 44.1 kHz; .wav when FFmpeg has no FLAC encoder)
//   <data>/stems/<trackId>/meta.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { guardedFetch } from './netguard.js';

export const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];
export const STEM_RATE = 44100;

/**
 * Default model: HT-Demucs v4 (4 stems, Meta's facebookresearch/demucs, MIT) exported to ONNX with the STFT
 * outside the graph, as published in the npm package "demucs" 1.0.0 (github.com/bakkot/demucs-js).
 * npm tarball URLs are immutable; both the archive and the extracted model are SHA-256 checked.
 */
export const DEFAULT_MODEL = Object.freeze({
  id: 'htdemucs-v4',
  name: 'HT-Demucs v4 (vocals, drums, bass, other)',
  url: 'https://registry.npmjs.org/demucs/-/demucs-1.0.0.tgz',
  archiveSha256: '83aadd00d48cd2a0c2e81e2a35616f4fa41a41f5c07efcc4a5c1959377b4ec42',
  entry: 'package/htdemucs.onnx',
  sha256: 'da9e5101ee0804d04933974b59d8aae9c862e80e14f2f24e7c74cae76bdbe748',
  bytes: 174263526,
  downloadBytes: 98176342,
  licence: 'Demucs (code and pretrained HT-Demucs weights) by Meta Platforms, released under the MIT licence in facebookresearch/demucs. The ONNX export\'s packager notes the weights may be meant for personal and research use; check before commercial use.',
  homepage: 'https://github.com/facebookresearch/demucs',
});

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const ID_RE = /^[\w-]{1,64}$/;
const isHex64 = (s) => /^[0-9a-f]{64}$/i.test(String(s || ''));
const MAX_MODEL_BYTES = 2 * 2 ** 30;

/**
 * Model the settings ask for: the default, or { url[#entry], sha256 } from settings. A custom URL needs its SHA-256:
 * the server downloads it and serves it back, so an unpinned URL would let anyone who can edit settings read
 * arbitrary URLs through the server.
 */
export function modelSpec(settings = {}) {
  const raw = String(settings.stemsModelUrl || '').trim();
  if (!raw || raw === DEFAULT_MODEL.url) return { ...DEFAULT_MODEL, custom: false };
  let u;
  try { u = new URL(raw); } catch { throw bad('The stems model URL is not valid'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('The stems model URL must be http(s)');
  const entry = decodeURIComponent(u.hash.replace(/^#(entry=)?/, '')) || null; // archive member: https://…/x.tgz#package/model.onnx
  u.hash = '';
  const sha256 = isHex64(settings.stemsModelSha256) ? settings.stemsModelSha256.toLowerCase() : null;
  if (!sha256) throw bad('A custom stems model URL needs its SHA-256 (stemsModelSha256), so the download can be verified');
  const archive = /\.(tgz|tar\.gz)$/i.test(u.pathname) || !!entry;
  return {
    id: 'custom', name: path.basename(entry || u.pathname) || 'Custom model', url: u.href, entry: archive ? entry : null,
    sha256, archiveSha256: null, bytes: null, downloadBytes: null, licence: 'Custom model: check its licence.', custom: true,
  };
}

/** Cache file name: the expected (pinned) hash. */
const modelKey = (spec) => spec.sha256;

/**
 * Streams a .tar (already gunzipped) and writes only `entry` to `out`. Handles ustar prefix and pax path.
 * Reads the stream to its end (the caller hashes the whole download).
 */
export async function extractTarEntry(readable, entry, out) {
  let buf = Buffer.alloc(0), state = 'header', remain = 0, pad = 0, current = null, paxPath = null, found = false, paxBody = [];
  const want = entry.replace(/^\.\//, '');
  const str = (b, a, n) => b.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
  for await (const chunk of readable) {
    if (state === 'end') continue; // drain
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (state === 'header') {
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512); buf = buf.subarray(512);
        if (h.every((x) => x === 0)) { state = 'end'; break; }
        const type = String.fromCharCode(h[156] || 48);
        const size = parseInt(str(h, 124, 12).trim() || '0', 8);
        const prefix = str(h, 257, 6).startsWith('ustar') ? str(h, 345, 155) : '';
        let name = (prefix ? prefix + '/' : '') + str(h, 0, 100);
        if (paxPath) { name = paxPath; paxPath = null; }
        remain = size; pad = (512 - (size % 512)) % 512;
        current = type === 'x' ? 'pax' : (type === '0' || type === '\0' || type === '7') && name.replace(/^\.\//, '') === want ? 'want' : 'skip';
        paxBody = [];
        state = 'body';
      }
      if (state === 'body') {
        if (remain > 0) {
          if (!buf.length) break;
          const n = Math.min(remain, buf.length), part = buf.subarray(0, n); buf = buf.subarray(n); remain -= n;
          if (current === 'want') { found = true; if (!out.write(part)) await new Promise((r) => out.once('drain', r)); }
          else if (current === 'pax') paxBody.push(Buffer.from(part));
          if (remain > 0) break;
        }
        if (current === 'pax') { const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(Buffer.concat(paxBody).toString('utf8')); if (m) paxPath = m[1]; }
        state = 'pad';
      }
      if (state === 'pad') {
        if (buf.length < pad) { pad -= buf.length; buf = Buffer.alloc(0); break; }
        buf = buf.subarray(pad); pad = 0; state = 'header';
      }
      if (state === 'end') break;
    }
  }
  return found;
}

/** Minimal 16-bit PCM WAV header. */
export function wavHeader(dataBytes, sampleRate = STEM_RATE, channels = 2) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** onnxruntime-web's dist folder (OPENDJ_ORT_DIR overrides; null when the package is not installed). */
export function findOrtDir(explicit = process.env.OPENDJ_ORT_DIR) {
  const ok = (d) => d && fs.existsSync(path.join(d, 'ort.webgpu.min.mjs'));
  if (explicit) return ok(explicit) ? path.resolve(explicit) : null;
  try {
    const main = createRequire(import.meta.url).resolve('onnxruntime-web'); // .../onnxruntime-web/dist/ort.min.js
    const d = path.dirname(main);
    return ok(d) ? d : null;
  } catch { return null; }
}
const ortVersion = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, '..', 'package.json'), 'utf8')).version; } catch { return null; } };

async function sendFile(req, res, file, type, cache = 'no-cache') {
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st?.isFile()) throw bad('Not found', 404);
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m && (m[1] || m[2])) {
    let start = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1]);
    const end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (!(start <= end) || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(file, { start, end }), res).catch(() => res.destroy());
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(file), res).catch(() => res.destroy());
}

const run = (bin, args) => new Promise((resolve, reject) => {
  const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  p.on('error', reject);
  p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${err.trim().split('\n').pop()}`))));
});

/**
 * @param {object} o
 * @param {Function} o.route   route(method, pattern, handler, opts) from server/index.js
 * @param {import('./library.js').Library} o.library
 * @param {Function} [o.emit]  server-sent events
 * @param {string} [o.dataDir] defaults to library.dataDir
 * @param {string|null} [o.ortDir] onnxruntime-web dist folder (default: resolved from node_modules)
 * @param {Function} [o.fetch]
 * @param {boolean} [o.restricted]  hosted mode: the model URL may not point at this server / link-local addresses
 * @param {Function} [o.lookup]     DNS lookup (tests)
 */
export function registerStemRoutes({ route, library, emit = () => {}, dataDir = library.dataDir, ortDir, fetch: f = globalThis.fetch, restricted = false, lookup }) {
  const root = path.join(dataDir, 'stems');
  const modelsDir = path.join(root, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  const ORT = ortDir === undefined ? findOrtDir() : ortDir;
  const ffmpeg = () => library.media?.ffmpeg?.() || null;
  const settings = () => library.settings || {};
  const trackDir = (id) => path.join(root, id);
  const checkId = (id) => { if (!ID_RE.test(id)) throw bad('Bad track id'); return id; };
  const track = (id) => { const t = library.getTrack(checkId(id)); if (!t) throw bad('Track not found', 404); return t; };

  // ---------------- model ----------------
  let download = null; // { spec, received, total, ctrl, promise }
  let lastError = null;
  const modelFile = (spec) => path.join(modelsDir, `${modelKey(spec)}.onnx`);
  const modelMeta = (spec) => { try { return JSON.parse(fs.readFileSync(modelFile(spec) + '.json', 'utf8')); } catch { return null; } };
  /** Downloaded and verified against the pinned SHA-256 (only such a file is ever served). */
  const modelReady = (spec) => { const m = modelMeta(spec); return !!m && !!spec.sha256 && m.sha256 === spec.sha256 && fs.existsSync(modelFile(spec)); };

  const modelStatus = () => {
    let spec; try { spec = modelSpec(settings()); } catch (e) { return { error: e.message }; }
    const meta = modelReady(spec) ? modelMeta(spec) : null;
    return {
      id: spec.id, name: spec.name, url: spec.url, licence: spec.licence, homepage: spec.homepage || null, custom: spec.custom,
      bytes: meta?.bytes ?? spec.bytes, downloadBytes: spec.downloadBytes, sha256: meta?.sha256 || spec.sha256,
      verified: !!meta && (!!spec.sha256 && meta.sha256 === spec.sha256), ready: !!meta,
      downloading: download && download.spec.url === spec.url ? { received: download.received, total: download.total } : null,
      error: lastError,
    };
  };

  async function fetchModel(spec) {
    const ctrl = new AbortController();
    download = { spec, received: 0, total: spec.downloadBytes || 0, ctrl };
    const target = modelFile(spec), part = `${target}.${crypto.randomBytes(4).toString('hex')}.part`;
    let lastEmit = 0;
    const progress = (force) => { const now = Date.now(); if (force || now - lastEmit > 400) { lastEmit = now; emit('stems-model', { received: download.received, total: download.total }); } };
    try {
      // redirects are followed by hand; in hosted mode every hop must not point at this server / link-local
      const res = await guardedFetch(spec.url, { signal: ctrl.signal }, { fetch: f, check: restricted, lookup });
      if (!res.ok || !res.body) throw new Error(`Model download failed: HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length')) || 0;
      if (len > MAX_MODEL_BYTES) throw new Error('Model file is too large');
      if (len) download.total = len;
      const archiveHash = crypto.createHash('sha256'), fileHash = crypto.createHash('sha256');
      let fileBytes = 0;
      const out = fs.createWriteStream(part);
      const counted = async function* (body) {
        for await (const c of body) {
          download.received += c.length; archiveHash.update(c); progress();
          if (download.received > MAX_MODEL_BYTES) throw new Error('Model file is too large');
          yield c;
        }
      };
      const hashOut = new Transform({ transform(c, _e, cb) { fileHash.update(c); fileBytes += c.length; cb(null, c); } });
      hashOut.pipe(out);
      const outDone = new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
      const src = counted(res.body);
      if (spec.entry) {
        const gunzip = zlib.createGunzip();
        const feed = (async () => { for await (const c of src) if (!gunzip.write(c)) await new Promise((r) => gunzip.once('drain', r)); gunzip.end(); })();
        feed.catch((e) => gunzip.destroy(e));
        const found = await extractTarEntry(gunzip, spec.entry, hashOut);
        await feed;
        if (!found) throw new Error(`"${spec.entry}" is not in the downloaded archive`);
      } else {
        for await (const c of src) if (!hashOut.write(c)) await new Promise((r) => hashOut.once('drain', r));
      }
      hashOut.end();
      await outDone;
      const aHex = archiveHash.digest('hex'), fHex = fileHash.digest('hex');
      if (spec.archiveSha256 && aHex !== spec.archiveSha256) throw new Error('Model download is corrupt (archive SHA-256 mismatch)');
      if (!spec.sha256 || fHex !== spec.sha256) throw new Error('Model download is corrupt (SHA-256 mismatch)');
      if (fileBytes < 1024) throw new Error('Model download is empty');
      await fs.promises.rename(part, target);
      fs.writeFileSync(target + '.json', JSON.stringify({ url: spec.url, entry: spec.entry, sha256: fHex, bytes: fileBytes, pinned: !!spec.sha256, at: Date.now() }));
      lastError = null;
      progress(true);
      emit('stems-model', { ready: true });
    } catch (e) {
      lastError = ctrl.signal.aborted ? 'Download cancelled' : e.message;
      emit('stems-model', { error: lastError });
      throw e;
    } finally {
      fs.promises.rm(part, { force: true }).catch(() => {});
      download = null;
    }
  }

  route('GET', '/api/stems/status', () => ({
    model: modelStatus(), ort: !!ORT, ortVersion: ORT ? ortVersion(ORT) : null,
    ffmpeg: !!ffmpeg(), format: ffmpeg()?.encoders?.flac ? 'flac' : 'wav', stemNames: STEM_NAMES, sampleRate: STEM_RATE,
  }));
  route('POST', '/api/stems/model/download', () => {
    const spec = modelSpec(settings());
    if (modelReady(spec)) return { ready: true };
    if (!download) { lastError = null; fetchModel(spec).catch(() => {}); }
    return { started: true, downloading: { received: download?.received || 0, total: download?.total || 0 } };
  });
  route('POST', '/api/stems/model/cancel', () => { download?.ctrl.abort(); return { ok: true }; });
  route('GET', '/api/stems/model', ({ req, res }) => {
    const spec = modelSpec(settings());
    if (!modelReady(spec)) throw bad('The stems model has not been downloaded yet', 404);
    // immutable per hash: the UI asks for /api/stems/model?sha=<sha256>
    return sendFile(req, res, modelFile(spec), 'application/octet-stream', 'private, max-age=31536000, immutable');
  });
  route('DELETE', '/api/stems/model', async () => {
    const spec = modelSpec(settings());
    await fs.promises.rm(modelFile(spec), { force: true }); await fs.promises.rm(modelFile(spec) + '.json', { force: true });
    return { ok: true };
  });

  // ---------------- onnxruntime-web files (served same-origin so the page CSP can stay 'self') ----------------
  route('GET', '/api/stems/ort/:file', ({ req, res, params }) => {
    if (!ORT) throw bad('onnxruntime-web is not installed on the server', 404);
    const name = params.file;
    if (!/^ort[\w.-]*\.(mjs|wasm)$/.test(name) || name.includes('..')) throw bad('Not found', 404);
    return sendFile(req, res, path.join(ORT, name), name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8', 'public, max-age=86400');
  });

  // ---------------- per-track stem cache ----------------
  const uploads = new Map(); // trackId -> { token, dir, frames, sampleRate, model, at }
  const readMeta = (id) => { try { return JSON.parse(fs.readFileSync(path.join(trackDir(id), 'meta.json'), 'utf8')); } catch { return null; } };
  const setTrackStems = (id, value) => {
    const t = library.getTrack(id);
    if (!t) return;
    if (value) t.stems = value; else delete t.stems;
    library.changed('tracks');
  };
  const dropUpload = async (id) => { const u = uploads.get(id); if (!u) return; uploads.delete(id); await fs.promises.rm(u.dir, { recursive: true, force: true }).catch(() => {}); };
  const upload = (id, token) => { const u = uploads.get(id); if (!u || u.token !== token) throw bad('No such stems upload (cancelled or expired)', 409); u.at = Date.now(); return u; };
  // stale uploads (tab closed mid-separation) are removed after an hour
  const sweep = setInterval(() => { for (const [id, u] of uploads) if (Date.now() - u.at > 3600e3) dropUpload(id); }, 600e3);
  sweep.unref?.();
  // leftovers from a crash
  for (const n of fs.readdirSync(root)) if (n.startsWith('.upload-')) fs.promises.rm(path.join(root, n), { recursive: true, force: true }).catch(() => {});

  route('GET', '/api/stems/:id', ({ params }) => {
    const t = track(params.id), meta = readMeta(t.id);
    return { ready: !!meta, ...(meta || {}), preparing: uploads.has(t.id), track: t.stems || null };
  });
  route('POST', '/api/stems/:id/begin', async ({ params, body }) => {
    const t = track(params.id);
    const frames = Math.floor(Number(body.frames));
    const sampleRate = Math.floor(Number(body.sampleRate)) || STEM_RATE;
    if (!(frames > 0 && frames <= sampleRate * 60 * 90)) throw bad('Bad length (max. 90 minutes)');
    if (sampleRate !== STEM_RATE) throw bad(`Stems must be ${STEM_RATE} Hz`);
    await dropUpload(t.id);
    const token = crypto.randomBytes(12).toString('hex');
    const dir = path.join(root, `.upload-${t.id}-${token.slice(0, 8)}`);
    await fs.promises.mkdir(dir, { recursive: true });
    for (const s of STEM_NAMES) await fs.promises.writeFile(path.join(dir, `${s}.raw`), '');
    uploads.set(t.id, { token, dir, frames, sampleRate, model: String(body.model || 'unknown').slice(0, 80), backend: String(body.backend || '').slice(0, 40), at: Date.now() });
    emit('stems', { id: t.id, preparing: true });
    return { token };
  });
  // body: interleaved stereo s16le for frames [frame, frame + n)
  route('PUT', '/api/stems/:id/part', async ({ params, query, body }) => {
    const u = upload(checkId(params.id), query.get('token'));
    const stem = query.get('stem'), frame = Number(query.get('frame'));
    if (!STEM_NAMES.includes(stem)) throw bad('Unknown stem');
    if (!Buffer.isBuffer(body) || !body.length || body.length % 4) throw bad('Send 16-bit stereo PCM (application/octet-stream)');
    if (!Number.isSafeInteger(frame) || frame < 0 || frame + body.length / 4 > u.frames) throw bad('Part is outside the track');
    const fh = await fs.promises.open(path.join(u.dir, `${stem}.raw`), 'r+');
    try { await fh.write(body, 0, body.length, frame * 4); } finally { await fh.close(); }
    return { ok: true };
  }, { bodyLimit: 64 * 2 ** 20 });
  route('POST', '/api/stems/:id/finish', async ({ params, query }) => {
    const t = track(params.id);
    const u = upload(t.id, query.get('token'));
    const ff = ffmpeg();
    const flac = !!ff?.encoders?.flac;
    for (const s of STEM_NAMES) {
      const raw = path.join(u.dir, `${s}.raw`);
      const st = await fs.promises.stat(raw);
      if (st.size !== u.frames * 4) throw bad(`Stem "${s}" is incomplete (${st.size} of ${u.frames * 4} bytes)`);
      if (flac) await run(ff.path, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', String(u.sampleRate), '-ac', '2', '-i', raw, '-c:a', 'flac', '-compression_level', '5', path.join(u.dir, `${s}.flac`)]);
      else {
        const out = fs.createWriteStream(path.join(u.dir, `${s}.wav`));
        out.write(wavHeader(st.size, u.sampleRate, 2));
        await pipeline(fs.createReadStream(raw), out);
      }
      await fs.promises.rm(raw, { force: true });
    }
    const meta = { model: u.model, backend: u.backend, format: flac ? 'flac' : 'wav', sampleRate: u.sampleRate, frames: u.frames, stems: STEM_NAMES, at: Date.now() };
    await fs.promises.writeFile(path.join(u.dir, 'meta.json'), JSON.stringify(meta));
    const dest = trackDir(t.id);
    await fs.promises.rm(dest, { recursive: true, force: true });
    await fs.promises.rename(u.dir, dest);
    uploads.delete(t.id);
    const value = { model: u.model, ready: true, format: meta.format, at: meta.at };
    setTrackStems(t.id, value);
    emit('stems', { id: t.id, ready: true });
    return { ok: true, stems: value };
  });
  route('DELETE', '/api/stems/:id', async ({ params }) => {
    const id = checkId(params.id);
    await dropUpload(id);
    await fs.promises.rm(trackDir(id), { recursive: true, force: true });
    if (library.getTrack(id)?.stems) setTrackStems(id, null);
    emit('stems', { id, ready: false });
    return { ok: true };
  });
  route('GET', '/api/stems/:id/:stem', ({ req, res, params }) => {
    const id = checkId(params.id);
    if (!STEM_NAMES.includes(params.stem)) throw bad('Unknown stem', 404);
    const meta = readMeta(id);
    if (!meta) throw bad('No stems for this track', 404);
    return sendFile(req, res, path.join(trackDir(id), `${params.stem}.${meta.format}`), meta.format === 'flac' ? 'audio/flac' : 'audio/wav');
  });

  return {
    dir: root,
    ortDir: ORT,
    /** Remove a track's stems (call when tracks are deleted from the library). */
    evict: async (id) => { if (!ID_RE.test(id)) return; await dropUpload(id); await fs.promises.rm(trackDir(id), { recursive: true, force: true }); },
    close() { clearInterval(sweep); download?.ctrl.abort(); },
  };
}
