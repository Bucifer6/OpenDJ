// AI stems: model download/cache, ONNX Runtime Web files, and the per-track stem cache.
// Registered from server/index.js with registerStemRoutes({ route, library, emit }).
//
// Separation runs on the server when it can (server/stems-child.js, onnxruntime-node: native CPU threads, DirectML /
// CoreML / CUDA on the GPU), in a below-normal-priority child process with its own queue, so every client (phone,
// browser, desktop app) only asks for stems and gets them. Without onnxruntime-node or FFmpeg (mobile app, minimal
// installs) the browser separates (public/js/stems/stems-worker.js, onnxruntime-web) and uploads the result.
// Either way the stems end up in the same cache, served to the decks:
//   <data>/stems/models/<sha256>.onnx          the downloaded model (verified, never committed to the repo)
//   <data>/stems/<trackId>/{vocals,drums,bass,other}.flac (16-bit 44.1 kHz; .wav when FFmpeg has no FLAC encoder)
//   <data>/stems/<trackId>/meta.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import os from 'node:os';
import { spawn, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { guardedFetch } from './netguard.js';
import { vocalPresence, encodeVocalMap } from '../public/js/shared/vocal-map.js';

/** Mean square (0..1) of each second of an interleaved stereo s16le file. */
export async function meanSquarePerSecond(file, rate = STEM_RATE) {
  const out = [];
  let acc = 0, n = 0, carry = null;
  for await (let chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
    const usable = chunk.length - (chunk.length % 4);
    if (usable < chunk.length) carry = chunk.subarray(usable);
    for (let i = 0; i < usable; i += 4) {
      const l = chunk.readInt16LE(i) / 32768, r = chunk.readInt16LE(i + 2) / 32768;
      acc += (l * l + r * r) * 0.5;
      if (++n === rate) { out.push(acc / n); acc = 0; n = 0; }
    }
  }
  if (n > rate / 4) out.push(acc / n);
  return out;
}

export const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];
export const STEM_RATE = 44100;
/**
 * Stems saved with the current output checks carry meta.checked = STEM_CHECK. GPU-made stems from before them may be
 * noise (DirectML returned full-scale garbage for HT-Demucs), so they are dropped at start-up and prepared again.
 *  1: every chunk's sources must add up to the track (mixtureError)
 *  2: a GPU's stems must also match the CPU's for the same audio (verifiedRunChunk): check 1 missed DirectML noise
 *     that still added up to the track
 */
export const STEM_CHECK = 2;
/** Version of the GPU check (2: every graph optimisation level is tried); older failure records are retried. */
export const GPU_CHECK_VERSION = 2;
export const uncheckedGpuStems = (meta) => !!meta && !(meta.checked >= STEM_CHECK) && /\b(dml|webgpu|coreml|cuda)\b/i.test(String(meta.backend || ''));

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
  // Text only (docs/RESOURCES_AND_LICENSING.md §0.1): the Demucs code is MIT, the pretrained weights are not.
  licence: 'Demucs code (Meta Platforms / Alexandre Défossez) is MIT-licensed, but the pretrained HT-Demucs weights are not covered by the MIT licence: their author says their licence is unclear (trained partly on research-only data), and the ONNX package says personal and research use only. Use these weights for personal, research or other non-commercial use only.',
  homepage: 'https://github.com/facebookresearch/demucs',
});

/**
 * Background preparation order: tracks played most, then rated highest, then played or added most recently (the
 * ones a DJ is likely to load next get their stems first).
 */
export function bgOrder(a, b) {
  return (b.playCount || 0) - (a.playCount || 0) || (b.rating || 0) - (a.rating || 0)
    || (b.lastPlayed || 0) - (a.lastPlayed || 0) || (b.addedAt || 0) - (a.addedAt || 0);
}

/**
 * " (exit 3)" / " (exit 0xC0000005)" / " (signal SIGKILL)" for a process that ended. Windows reports crashes as
 * NTSTATUS codes (0xC0000005 access violation, 0xC0000409 stack buffer overrun…), shown in hex.
 */
export function exitText(code, signal) {
  if (signal) return ` (signal ${signal})`;
  if (!code) return '';
  return code > 255 || code < 0 ? ` (exit 0x${(code >>> 0).toString(16).toUpperCase()})` : ` (exit ${code})`;
}
/** Last line of a child's stderr that says something (Chromium / Electron crash-reporter chatter is skipped). */
export function lastMeaningfulLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/crashpad|^\[\d+\/\d+\.\d+:(ERROR|WARNING|INFO|VERBOSE)/i.test(l));
  return lines.pop()?.slice(0, 300) || '';
}

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

/**
 * onnxruntime-node, when installed (optional dependency) and built for this platform: { version } or { reason }.
 * OPENDJ_STEMS_NATIVE=0 turns the native engine off.
 */
export function nativeRuntime(env = process.env) {
  if (env.OPENDJ_STEMS_NATIVE === '0') return { reason: 'Server stems are turned off (OPENDJ_STEMS_NATIVE=0)' };
  try {
    const pkg = createRequire(import.meta.url).resolve('onnxruntime-node/package.json');
    const bin = path.join(path.dirname(pkg), 'bin', 'napi-v6', process.platform, process.arch);
    if (!fs.existsSync(bin)) return { reason: `onnxruntime-node has no build for ${process.platform}-${process.arch}` };
    return { version: JSON.parse(fs.readFileSync(pkg, 'utf8')).version };
  } catch { return { reason: 'onnxruntime-node is not installed on the server' }; }
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
 * @param {Function} [o.input]      async (track) => { file } | { url, headers } | null: what FFmpeg decodes for the
 *                                  native engine (null: this track can only be separated in the browser)
 * @param {object|false} [o.native] native engine: false = off; { stub, stubGpu: 'ok'|'broken', child, idleMs } for tests. Default: on when
 *                                  onnxruntime-node is installed (hosted servers: only with OPENDJ_STEMS_NATIVE=1)
 */
export function registerStemRoutes({ route, library, emit = () => {}, dataDir = library.dataDir, ortDir, fetch: f = globalThis.fetch, restricted = false, lookup, input = null, native }) {
  const root = path.join(dataDir, 'stems');
  const modelsDir = path.join(root, 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  const ORT = ortDir === undefined ? findOrtDir() : ortDir;
  // longest track that gets stems (4 stems x 16-bit stereo: ~42 MB of raw PCM per minute while uploading); hosted
  // servers default to 30 minutes so one user cannot fill the disk with a single upload
  const maxMinutes = Math.max(1, Number(process.env.OPENDJ_STEMS_MAX_MINUTES) || (restricted ? 30 : 90));
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
      await fs.promises.rm(part, { force: true }).catch(() => {}); // gone before the error is reported
      lastError = ctrl.signal.aborted ? 'Download cancelled' : e.message;
      emit('stems-model', { error: lastError });
      throw e;
    } finally {
      await fs.promises.rm(part, { force: true }).catch(() => {}); // before the status stops saying "downloading"
      download = null;
    }
  }

  route('GET', '/api/stems/status', () => ({
    native: engine.status(),
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
  // the native engine's CPU stems for its fixed test signal (stems-child.js): the browser engine checks WebGPU
  // against it in one chunk instead of a slow single-threaded WASM run (404 until the native engine computed it)
  route('GET', '/api/stems/model/cpu-ref', ({ req, res }) => {
    const spec = modelSpec(settings());
    if (!modelReady(spec)) throw bad('The stems model has not been downloaded yet', 404);
    return sendFile(req, res, modelFile(spec) + '.cpu-ref.f32', 'application/octet-stream');
  });
  route('DELETE', '/api/stems/model', async () => {
    const spec = modelSpec(settings());
    await fs.promises.rm(modelFile(spec), { force: true }); await fs.promises.rm(modelFile(spec) + '.json', { force: true });
    await fs.promises.rm(modelFile(spec) + '.cpu-ref.f32', { force: true }); // the GPU check's CPU reference (stems-child.js)
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
    if (!(frames > 0 && frames <= sampleRate * 60 * maxMinutes)) throw bad(`Bad length (max. ${maxMinutes} minutes)`);
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
  /** Raw s16 stems in u.dir -> FLAC (or WAV) + meta.json, moved into the track's stem folder. */
  async function finalize(t, u) {
    const ff = ffmpeg();
    const flac = !!ff?.encoders?.flac;
    for (const s of STEM_NAMES) {
      const st = await fs.promises.stat(path.join(u.dir, `${s}.raw`));
      if (st.size !== u.frames * 4) throw bad(`Stem "${s}" is incomplete (${st.size} of ${u.frames * 4} bytes)`);
    }
    // where the vocals are (one value per second): Automix's transition planner keeps two vocals from overlapping
    let vocals = null;
    try {
      const ms = await Promise.all(STEM_NAMES.map((s) => meanSquarePerSecond(path.join(u.dir, `${s}.raw`), u.sampleRate)));
      vocals = encodeVocalMap(vocalPresence(ms[STEM_NAMES.indexOf('vocals')], ms));
    } catch (e) { console.warn('[stems] vocal map', e.message); }
    for (const s of STEM_NAMES) {
      const raw = path.join(u.dir, `${s}.raw`);
      const st = await fs.promises.stat(raw);
      if (flac) await run(ff.path, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', String(u.sampleRate), '-ac', '2', '-i', raw, '-c:a', 'flac', '-compression_level', '5', path.join(u.dir, `${s}.flac`)]);
      else {
        const out = fs.createWriteStream(path.join(u.dir, `${s}.wav`));
        out.write(wavHeader(st.size, u.sampleRate, 2));
        await pipeline(fs.createReadStream(raw), out);
      }
      await fs.promises.rm(raw, { force: true });
    }
    const meta = { model: u.model, backend: u.backend, format: flac ? 'flac' : 'wav', sampleRate: u.sampleRate, frames: u.frames, stems: STEM_NAMES, checked: STEM_CHECK, at: Date.now(), ...(vocals ? { vocals } : {}) };
    await fs.promises.writeFile(path.join(u.dir, 'meta.json'), JSON.stringify(meta));
    const dest = trackDir(t.id);
    await fs.promises.rm(dest, { recursive: true, force: true });
    await fs.promises.rename(u.dir, dest);
    uploads.delete(t.id);
    const value = { model: u.model, ready: true, format: meta.format, at: meta.at, ...(vocals ? { vocals } : {}) };
    setTrackStems(t.id, value);
    emit('stems', { id: t.id, ready: true, stems: value });
    return value;
  }
  route('POST', '/api/stems/:id/finish', async ({ params, query }) => {
    const t = track(params.id);
    const value = await finalize(t, upload(t.id, query.get('token')));
    return { ok: true, stems: value };
  });

  // ---------------- native engine: the server's own separation queue ----------------
  const engine = createEngine();
  function createEngine() {
    const rt = native === false ? { reason: 'Server stems are turned off' }
      : native?.stub ? { version: 'stub' }
        : restricted && process.env.OPENDJ_STEMS_NATIVE !== '1' ? { reason: 'Server stems are off on hosted servers (OPENDJ_STEMS_NATIVE=1 turns them on)' }
          : nativeRuntime();
    const idleMs = native?.idleMs ?? (Number(process.env.OPENDJ_STEMS_IDLE_MS) || 10 * 60e3); // model stays loaded between tracks
    const childPath = native?.child || fileURLToPath(new URL('./stems-child.js', import.meta.url));
    const queue = [];          // track ids
    let cur = null;            // { id, title, phase, done, total, started, backend, cancelled }
    let child = null, ready = null, backend = null, pending = null, idleT = null, pumping = false, last = null;
    // { backend, message, at }: the GPU failed its check or crashed, so later model loads use the CPU directly. Kept in
    // <stems>/gpu-check.json across restarts until onnxruntime-node changes (a new version may fix it) or
    // POST /api/stems/gpu/retry clears it.
    const gpuFile = path.join(root, 'gpu-check.json');
    // GPU_CHECK_VERSION: records from older checks (fewer things tried) are ignored, so the GPU gets another chance
    let gpuFailed = (() => { try { const g = JSON.parse(fs.readFileSync(gpuFile, 'utf8')); return g.ort === rt.version && g.version === GPU_CHECK_VERSION && g.backend ? g : null; } catch { return null; } })();
    const setGpuFailed = (g) => {
      if (gpuFailed) return;
      gpuFailed = { backend: String(g.backend || 'gpu'), message: String(g.message || '').slice(0, 500), at: Date.now() };
      console.warn(`[stems] the graphics card (${gpuFailed.backend}) is not used for stems from now on: ${gpuFailed.message}`);
      try { fs.writeFileSync(gpuFile, JSON.stringify({ ...gpuFailed, ort: rt.version, version: GPU_CHECK_VERSION })); } catch { /* read-only data dir: this session only */ }
    };
    const crashRetried = new Set(); // tracks already redone on the CPU after a GPU crash (only once each)

    const installed = () => !!rt.version && !!ffmpeg();
    const modelOk = () => { if (native?.stub) return true; try { return modelReady(modelSpec(settings())); } catch { return false; } };

    // Background preparation (settings.stemsBackground): when the queue is empty, the library's tracks without stems
    // are separated one by one, the ones played most first, until the stem cache reaches settings.stemsCacheGB. Any
    // track asked for (a deck load, Automix's next tracks, the menu) goes first and interrupts a background track.
    const bg = { failed: new Set(), done: 0, cacheBytes: null };
    const bgCap = () => Math.max(1, Number(settings().stemsCacheGB) || 40) * 2 ** 30;
    const bgOn = () => settings().stemsBackground === true && installed() && modelOk();
    const bgTodo = () => (library.allTracks?.() || []).filter((t) => !t.stems?.ready && !bg.failed.has(t.id) && t.id !== cur?.id && !queue.includes(t.id) && ID_RE.test(t.id));
    const bgNext = () => bgTodo().sort(bgOrder)[0]?.id || null;
    async function measureCache() {
      let total = 0;
      for (const d of await fs.promises.readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!d.isDirectory() || d.name === 'models' || d.name.startsWith('.')) continue;
        for (const f of await fs.promises.readdir(path.join(root, d.name)).catch(() => [])) total += (await fs.promises.stat(path.join(root, d.name, f)).catch(() => null))?.size || 0;
      }
      return (bg.cacheBytes = total);
    }
    const bgFull = () => bg.cacheBytes != null && bg.cacheBytes >= bgCap();
    const bgState = () => {
      const on = settings().stemsBackground === true;
      return { enabled: on, remaining: on ? bgTodo().length : 0, done: bg.done, failed: bg.failed.size, cacheBytes: bg.cacheBytes, capBytes: bgCap(), full: bgFull() };
    };

    const state = () => ({
      current: cur && { id: cur.id, title: cur.title, phase: cur.phase, done: cur.done, total: cur.total, elapsed: Date.now() - cur.started, separating: cur.sepAt ? Date.now() - cur.sepAt : 0, backend: cur.backend || backend?.backend || null, background: !!cur.background },
      queue: [...queue],
      background: bgState(),
      // whether the graphics card is used: 'unknown' until the engine has loaded once (its GPU check), then 'ok' /
      // 'failed'; clients route tracks to their own WebGPU when it failed (stems.js browserGpu)
      gpu: gpuFailed ? 'failed' : backend?.backend ? (['cpu', 'stub'].includes(backend.backend) ? (settings().stemsBackend === 'wasm' ? 'off' : 'failed') : 'ok') : 'unknown',
      gpuFailed,
    });
    const changed = () => emit('stems-queue', state());
    const killChild = () => { const c = child; child = null; ready = null; backend = null; c?.kill(); };

    function startChild() {
      const spec = native?.stub ? null : modelSpec(settings());
      const c = child = fork(childPath, [], { stdio: ['ignore', 'inherit', 'pipe', 'ipc'], serialization: 'advanced', windowsHide: true, execArgv: [] });
      try { os.setPriority(c.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed here: normal priority */ }
      const backendArg = settings().stemsBackend === 'wasm' || gpuFailed ? 'cpu' : 'auto';
      c.usingGpu = backendArg !== 'cpu'; // until 'ready' says which backend loaded (a crash while loading counts too)
      let err = '';
      c.stderr.on('data', (d) => { err = (err + d).slice(-4000); process.stderr.write(d); });
      const p = new Promise((resolve, reject) => {
        c.on('message', (m) => {
          if (m.type === 'ready') {
            c.usingGpu = !['cpu', 'stub'].includes(m.backend);
            if (m.gpuFailed) setGpuFailed(m.gpuFailed);
            if (child === c) backend = m;
            resolve(m);
            changed(); // clients learn at once whether the graphics card is used
          }
          else if (m.type === 'progress') { if (cur?.id === m.id) { Object.assign(cur, { phase: m.phase, done: m.done, total: m.total }, m.backend ? { backend: m.backend } : {}); if (m.phase === 'separating') cur.sepAt ||= Date.now(); changed(); } }
          else if (m.type === 'done') pending?.resolve(m);
          else if (m.type === 'error') { if (m.id) pending?.reject(new Error(m.message)); else { reject(new Error(m.message)); if (child === c) killChild(); } }
        });
        c.on('exit', (code, signal) => {
          const tail = lastMeaningfulLine(err);
          const e = new Error(`The stems engine stopped${exitText(code, signal)}${tail ? `: ${tail}` : ''}`);
          const crashed = child === c && (!!code || !!signal); // not a kill of ours (cancel, idle, preempt)
          if (crashed) {
            console.warn(`[stems] engine process ended${exitText(code, signal)} while using ${c.usingGpu ? `the graphics card (${backend?.backend || 'loading'})` : 'the CPU'}`);
            if (c.usingGpu) e.gpuCrash = backend?.backend && backend.backend !== 'cpu' ? backend.backend : 'gpu';
          }
          if (child === c) { child = null; ready = null; backend = null; }
          reject(e); pending?.reject(e);
        });
      });
      c.send({ type: 'init', model: spec ? modelFile(spec) : null, stub: !!native?.stub, stubGpu: native?.stubGpu || null, backend: backendArg, threads: Number(process.env.OPENDJ_STEMS_THREADS) || 0 });
      ready = p; p.catch(() => {});
      return p;
    }

    async function runOne(id, { background = false } = {}) {
      const t = library.getTrack(id);
      if (!t) return;
      cur = { id, title: t.title || 'Untitled', phase: 'starting', done: 0, total: 0, started: Date.now(), background };
      changed();
      const token = crypto.randomBytes(12).toString('hex');
      const dir = path.join(root, `.upload-${id}-${token.slice(0, 8)}`);
      const mine = () => uploads.get(id)?.token === token;
      try {
        const src = input ? await input(t) : null;
        if (!src) throw bad('This track can only be separated in the browser');
        await dropUpload(id);
        await fs.promises.mkdir(dir, { recursive: true });
        uploads.set(id, { token, dir, frames: 0, sampleRate: STEM_RATE, model: native?.stub ? 'stub-bands' : modelSpec(settings()).id, backend: '', at: Date.now() });
        emit('stems', { id, preparing: true });
        if (!ready) { cur.phase = 'loading model'; changed(); }
        await (ready || startChild());
        if (cur.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        const r = await new Promise((resolve, reject) => {
          pending = { resolve, reject };
          child.send({ type: 'job', id, ffmpeg: ffmpeg().path, input: src, dir, overlap: Number(settings().stemsOverlap) || 0.25, maxFrames: STEM_RATE * 60 * maxMinutes });
        });
        pending = null;
        if (r.gpuFailed) setGpuFailed(r.gpuFailed);
        if (!mine()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        cur.phase = 'saving'; changed();
        const u = uploads.get(id);
        Object.assign(u, { frames: r.frames, backend: `server ${r.backend}${r.threads > 1 ? ` x${r.threads}` : ''}` });
        const value = await finalize(t, u);
        last = { id, title: cur.title, ms: r.ms, seconds: r.frames / STEM_RATE, backend: r.backend, threads: r.threads, chunks: r.chunks };
        emit('stems-done', { ...last, background, stems: value });
        if (background) bg.done++;
        measureCache().catch(() => {});
      } catch (e) {
        pending = null;
        if (mine()) await dropUpload(id);
        else await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        if (e.gpuCrash && !cur?.cancelled) setGpuFailed({ backend: e.gpuCrash, message: e.message });
        if (cur?.preempted) { /* a background track made way for a track someone asked for: it is tried again later */ }
        else if (e.gpuCrash && !cur?.cancelled && !crashRetried.has(id)) {
          // the graphics card crashed the engine: the next start uses the CPU, and this track is redone first
          crashRetried.add(id);
          console.warn(`[stems] ${id}: redoing on the CPU after the crash`);
          if (!queue.includes(id)) queue.unshift(id);
        }
        else if (background && !cur?.cancelled && !e.cancelled) { bg.failed.add(id); console.warn('[stems] background', id, e.message); }
        else if (cur?.cancelled || e.cancelled) emit('stems-failed', { id, title: cur?.title, cancelled: true });
        else { console.warn('[stems]', id, e.message); emit('stems-failed', { id, title: cur?.title, message: e.message }); }
      } finally { cur = null; changed(); }
    }

    async function pump() {
      if (pumping) return;
      pumping = true; clearTimeout(idleT);
      try {
        for (;;) {
          if (queue.length) { await runOne(queue.shift()); continue; }
          if (!bgOn()) break;
          if (bg.cacheBytes == null) await measureCache();
          if (bgFull()) break;
          const id = bgNext();
          if (!id) break;
          await runOne(id, { background: true });
        }
      } finally {
        pumping = false;
        // free the model's memory (and the GPU, for Ollama & co.) when nothing comes for a while
        idleT = setTimeout(() => { if (!pumping) killChild(); }, idleMs); idleT.unref?.();
      }
    }

    return {
      status: () => ({
        installed: installed(), available: installed() && modelOk(),
        reason: rt.reason || (!ffmpeg() ? 'FFmpeg is needed for server stems' : !modelOk() ? 'The stems model is not downloaded yet' : null),
        version: rt.version || null, backend: backend?.backend || null, threads: backend?.threads || 0, gpuFailed, last, ...state(),
      }),
      state,
      add(ids, { force = false, front = false } = {}) {
        if (!installed()) throw bad(rt.reason || 'FFmpeg is needed for server stems', 409);
        if (!modelOk()) throw bad('The stems model is not downloaded yet', 409);
        let added = 0;
        const list = [...new Set(ids.map(String))].filter((id) => ID_RE.test(id) && library.getTrack(id) && cur?.id !== id && (force || !readMeta(id)));
        if (front) list.reverse();
        for (const id of list) {
          const i = queue.indexOf(id);
          if (i >= 0) { if (front && i > 0) { queue.splice(i, 1); queue.unshift(id); } continue; }
          if (front) queue.unshift(id); else queue.push(id);
          added++;
        }
        // a track someone asked for interrupts a background track (that one goes back to the background list)
        if (added && cur?.background && !cur.cancelled) { cur.cancelled = cur.preempted = true; uploads.delete(cur.id); killChild(); }
        changed();
        pump();
        return { added, ...state() };
      },
      cancel(id) {
        const i = queue.indexOf(id);
        if (i >= 0) { queue.splice(i, 1); changed(); }
        if (cur && cur.id === id) { cur.cancelled = true; uploads.delete(id); killChild(); }
      },
      cancelAll() { queue.length = 0; if (cur) this.cancel(cur.id); changed(); },
      /** Start background preparation when it is turned on (called on settings changes and every minute). */
      kick() { if (!pumping && bgOn()) pump(); },
      /**
       * Load the engine now (and so run its GPU check) without a track, so clients know whether the graphics card is
       * used before they queue anything. Resolves with status(); the engine is freed again after idleMs.
       */
      async warm() {
        if (installed() && modelOk() && !backend && !gpuFailed) {
          try { await (ready || startChild()); } catch (e) { console.warn('[stems] warm-up', e.message); }
          if (!pumping) { clearTimeout(idleT); idleT = setTimeout(() => { if (!pumping) killChild(); }, idleMs); idleT.unref?.(); }
        }
        return this.status();
      },
      /** Try the graphics card again (after a driver update): forget the recorded GPU failure, reload the model. */
      retryGpu() {
        gpuFailed = null; crashRetried.clear();
        fs.rmSync(gpuFile, { force: true });
        // the engine's own memo of which GPU optimisation level works (stems-child.js), so every level is tried again
        try { for (const f of fs.readdirSync(modelsDir)) if (/\.gpu-[a-z]+\.json$/.test(f)) fs.rmSync(path.join(modelsDir, f), { force: true }); } catch { /* none */ }
        if (!cur) killChild(); // loaded again (GPU first) for the next track
        console.warn('[stems] the graphics card will be tried again for stems');
        return { gpuFailed };
      },
      /** Forget background failures (e.g. after FFmpeg or a source came back) and recount the cache. */
      retryBackground() { bg.failed.clear(); measureCache().then(() => this.kick(), () => {}); return state(); },
      close() { clearTimeout(idleT); clearInterval(bgT); queue.length = 0; killChild(); },
    };
  }
  const bgT = setInterval(() => engine.kick(), native?.bgPollMs ?? 60e3); bgT.unref?.();
  // stems made on a GPU before the current output checks may be noise: drop them so they are prepared again
  const purged = (async () => {
    let n = 0;
    for (const t of library.allTracks?.() || []) {
      if (!t.stems?.ready || !ID_RE.test(String(t.id)) || !uncheckedGpuStems(readMeta(t.id))) continue;
      await fs.promises.rm(trackDir(t.id), { recursive: true, force: true }).catch(() => {});
      setTrackStems(t.id, null); emit('stems', { id: t.id, ready: false }); n++;
    }
    if (n) { console.warn(`[stems] ${n} track(s) had GPU stems made before the current output checks: preparing them again`); engine.retryBackground?.(); }
    return n;
  })().catch((e) => { console.warn('[stems] purge', e.message); return 0; });
  route('POST', '/api/stems/queue', ({ body }) => engine.add(Array.isArray(body?.ids) ? body.ids.slice(0, 5000) : [], { force: !!body?.force, front: !!body?.front }));
  route('POST', '/api/stems/background', ({ body }) => (body?.retry ? engine.retryBackground() : (engine.kick(), engine.state())));
  route('POST', '/api/stems/gpu/retry', () => engine.retryGpu());
  route('POST', '/api/stems/engine/warm', () => engine.warm());
  route('POST', '/api/stems/queue/cancel', ({ body }) => {
    if (body?.all) engine.cancelAll();
    else if (Array.isArray(body?.ids)) for (const id of body.ids.slice(0, 5000)) engine.cancel(String(id));
    else engine.cancel(String(body?.id || ''));
    return engine.state();
  });
  route('DELETE', '/api/stems/:id', async ({ params }) => {
    const id = checkId(params.id);
    engine.cancel(id);
    await dropUpload(id);
    await fs.promises.rm(trackDir(id), { recursive: true, force: true });
    if (library.getTrack(id)?.stems) setTrackStems(id, null);
    engine.retryBackground?.();
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
    engine, purged, // purged: Promise<number> of unchecked GPU stems dropped at start-up
    evict: async (id) => { if (!ID_RE.test(id)) return; engine.cancel(id); await dropUpload(id); await fs.promises.rm(trackDir(id), { recursive: true, force: true }); },
    close() { clearInterval(sweep); download?.ctrl.abort(); engine.close(); },
  };
}
