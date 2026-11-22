// AI stems server module: stem cache upload/serve/delete, model download + verification, ORT file serving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { Library } from '../server/library.js';
import { registerStemRoutes, DEFAULT_MODEL, modelSpec, extractTarEntry, wavHeader, bgOrder } from '../server/stems.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0;

/** Same routing contract as server/index.js: route(method, pattern, handler, { bodyLimit }), JSON/octet bodies. */
async function harness(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-stems-'));
  const library = new Library(dir);
  library.upsertTrack({ id: 'trk1', title: 'Song', sourceType: 'local', path: path.join(dir, 'song.wav') });
  if (opts.ffmpeg) library.media = { ffmpeg: () => ({ path: 'ffmpeg', encoders: { flac: true } }) };
  Object.assign(library.settings, opts.settings || {});
  const routes = [], events = [];
  const route = (method, pattern, handler, o = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, ...o });
  };
  const stems = registerStemRoutes({ route, library, emit: (t, p) => { events.push([t, p]); opts.onEvent?.(t, p); }, ortDir: opts.ortDir ?? null, fetch: opts.fetch, restricted: opts.restricted, lookup: opts.lookup, native: opts.native ?? false, input: opts.input });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      for (const r of routes) {
        if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
        const m = r.re.exec(url.pathname); if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        let body = {};
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
          const chunks = []; for await (const c of req) chunks.push(c);
          const raw = Buffer.concat(chunks);
          body = !raw.length ? {} : req.headers['content-type'] === 'application/json' ? JSON.parse(raw) : raw;
        }
        const out = await r.handler({ req, res, params, body, query: url.searchParams });
        if (!res.headersSent && out !== undefined) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); }
        return;
      }
      res.writeHead(404); res.end('{}');
    } catch (e) { if (!res.headersSent) { res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, headers = {}) => {
    const o = { method, headers: { ...headers } };
    if (Buffer.isBuffer(body)) { o.body = body; o.headers['Content-Type'] = 'application/octet-stream'; }
    else if (body !== undefined) { o.body = JSON.stringify(body); o.headers['Content-Type'] = 'application/json'; }
    return fetch(base + p, o);
  };
  const json = async (...a) => { const r = await call(...a); const j = await r.json().catch(() => ({})); return { status: r.status, ...j }; };
  const close = () => { stems.close(); server.close(); library.flush(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { dir, library, stems, events, call, json, close };
}

function pcm(frames, seed) { const b = Buffer.alloc(frames * 4); for (let i = 0; i < frames * 2; i++) b.writeInt16LE(((i * 7919 + seed * 104729) % 65536) - 32768, i * 2); return b; }

async function uploadAll(h, frames, split = 600) {
  const { token } = await h.json('POST', '/api/stems/trk1/begin', { model: 'test-model', sampleRate: 44100, frames });
  assert.ok(token);
  const data = {};
  for (const [k, s] of ['vocals', 'drums', 'bass', 'other'].entries()) {
    data[s] = pcm(frames, k + 1);
    // second part first: parts may arrive in any order
    assert.equal((await h.json('PUT', `/api/stems/trk1/part?token=${token}&stem=${s}&frame=${split}`, data[s].subarray(split * 4))).status, 200);
    assert.equal((await h.json('PUT', `/api/stems/trk1/part?token=${token}&stem=${s}&frame=0`, data[s].subarray(0, split * 4))).status, 200);
  }
  return { token, data };
}

test('stems server: status before anything is downloaded', async () => {
  const h = await harness();
  try {
    const st = await h.json('GET', '/api/stems/status');
    assert.equal(st.ort, false); assert.equal(st.format, 'wav');
    assert.equal(st.model.ready, false); assert.equal(st.model.id, DEFAULT_MODEL.id);
    assert.equal(st.model.downloadBytes, DEFAULT_MODEL.downloadBytes);
    assert.deepEqual(st.stemNames, ['vocals', 'drums', 'bass', 'other']);
    assert.equal((await h.json('GET', '/api/stems/model')).status, 404);
    assert.equal((await h.json('GET', '/api/stems/trk1')).ready, false);
    assert.equal((await h.json('GET', '/api/stems/trk1/vocals')).status, 404);
  } finally { h.close(); }
});

test('stems server: upload, finish (WAV), serve with Range, mark the track, delete', async () => {
  const h = await harness();
  try {
    const frames = 1000;
    const { token, data } = await uploadAll(h, frames);
    const fin = await h.json('POST', `/api/stems/trk1/finish?token=${token}`);
    assert.equal(fin.status, 200, fin.error);
    assert.deepEqual({ ...fin.stems, at: 0 }, { model: 'test-model', ready: true, format: 'wav', at: 0 });
    assert.equal(h.library.getTrack('trk1').stems.ready, true);
    assert.ok(h.events.some(([t, p]) => t === 'stems' && p.ready));
    const info = await h.json('GET', '/api/stems/trk1');
    assert.equal(info.ready, true); assert.equal(info.frames, frames); assert.equal(info.sampleRate, 44100);
    for (const s of ['vocals', 'drums', 'bass', 'other']) {
      const r = await h.call('GET', `/api/stems/trk1/${s}`);
      assert.equal(r.headers.get('content-type'), 'audio/wav');
      const buf = Buffer.from(await r.arrayBuffer());
      assert.deepEqual(buf.subarray(0, 44), wavHeader(frames * 4));
      assert.ok(buf.subarray(44).equals(data[s]), `${s} data intact`);
    }
    const r = await h.call('GET', '/api/stems/trk1/bass', undefined, { Range: 'bytes=44-47' });
    assert.equal(r.status, 206);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(data.bass.subarray(0, 4)));
    // no temp upload folders left
    assert.deepEqual(fs.readdirSync(path.join(h.dir, 'stems')).filter((n) => n.startsWith('.upload')), []);
    assert.equal((await h.json('DELETE', '/api/stems/trk1')).status, 200);
    assert.equal(h.library.getTrack('trk1').stems, undefined);
    assert.equal(fs.existsSync(path.join(h.dir, 'stems', 'trk1')), false);
  } finally { h.close(); }
});

test('stems server: rejects bad parts, wrong tokens and incomplete uploads', async () => {
  const h = await harness();
  try {
    const { token } = await h.json('POST', '/api/stems/trk1/begin', { sampleRate: 44100, frames: 100 });
    assert.equal((await h.json('PUT', `/api/stems/trk1/part?token=nope&stem=vocals&frame=0`, pcm(10, 1))).status, 409);
    assert.equal((await h.json('PUT', `/api/stems/trk1/part?token=${token}&stem=piano&frame=0`, pcm(10, 1))).status, 400);
    assert.equal((await h.json('PUT', `/api/stems/trk1/part?token=${token}&stem=vocals&frame=95`, pcm(10, 1))).status, 400, 'past the end');
    assert.equal((await h.json('PUT', `/api/stems/trk1/part?token=${token}&stem=vocals&frame=0`, Buffer.alloc(6))).status, 400, 'odd frame size');
    const fin = await h.json('POST', `/api/stems/trk1/finish?token=${token}`);
    assert.equal(fin.status, 400); assert.match(fin.error, /incomplete/);
    assert.equal((await h.json('POST', '/api/stems/trk1/begin', { sampleRate: 48000, frames: 100 })).status, 400, 'model rate only');
    assert.equal((await h.json('POST', '/api/stems/nope/begin', { sampleRate: 44100, frames: 100 })).status, 404);
    assert.equal((await h.json('GET', '/api/stems/..%2F..%2Fetc')).status, 400);
    // a new begin replaces the old upload
    const again = await h.json('POST', '/api/stems/trk1/begin', { sampleRate: 44100, frames: 100 });
    assert.notEqual(again.token, token);
    assert.equal((await h.json('PUT', `/api/stems/trk1/part?token=${token}&stem=vocals&frame=0`, pcm(10, 1))).status, 409);
    await h.stems.evict('trk1');
  } finally { h.close(); }
});

test('stems server: FLAC via FFmpeg is lossless', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const h = await harness({ ffmpeg: true });
  try {
    const frames = 4410;
    const { token, data } = await uploadAll(h, frames, 2000);
    const fin = await h.json('POST', `/api/stems/trk1/finish?token=${token}`);
    assert.equal(fin.status, 200, fin.error); assert.equal(fin.stems.format, 'flac');
    const r = await h.call('GET', '/api/stems/trk1/drums');
    assert.equal(r.headers.get('content-type'), 'audio/flac');
    const flac = Buffer.from(await r.arrayBuffer());
    assert.equal(flac.subarray(0, 4).toString(), 'fLaC');
    const f = path.join(h.dir, 'x.flac'); fs.writeFileSync(f, flac);
    const dec = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-f', 's16le', '-']);
    assert.ok(dec.stdout.equals(data.drums), 'decoded FLAC equals the uploaded PCM');
  } finally { h.close(); }
});

// ---------------- native engine (server-side queue + child process) ----------------
test('stems server: native engine separates in a child process and saves the stems', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  let done;
  const finished = new Promise((r) => { done = r; });
  let h;
  h = await harness({
    ffmpeg: true, native: { stub: true, idleMs: 50 },
    input: async () => ({ file: path.join(h.dir, 'song.wav') }),
    onEvent: (t, p) => { if (t === 'stems-done' || t === 'stems-failed') done([t, p]); },
  });
  try {
    const frames = 44100 * 9; // two model chunks
    const data = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) { const v = Math.round(Math.sin(i * 0.03) * 8000 + Math.sin(i * 0.4) * 4000); data.writeInt16LE(v, i * 4); data.writeInt16LE(v, i * 4 + 2); }
    fs.writeFileSync(path.join(h.dir, 'song.wav'), Buffer.concat([wavHeader(data.length), data]));
    const st = await h.json('GET', '/api/stems/status');
    assert.equal(st.native.installed, true); assert.equal(st.native.available, true);
    const q = await h.json('POST', '/api/stems/queue', { ids: ['trk1', 'nope', '../x'] });
    assert.equal(q.status, 200, q.error); assert.equal(q.added, 1);
    const [type, ev] = await finished;
    assert.equal(type, 'stems-done', ev.message);
    assert.equal(ev.backend, 'stub'); assert.equal(Math.round(ev.seconds), 9);
    const info = await h.json('GET', '/api/stems/trk1');
    assert.equal(info.ready, true); assert.equal(info.frames, frames); assert.equal(info.format, 'flac');
    assert.equal(h.library.getTrack('trk1').stems.ready, true);
    // the four stems add up to the original (the stub splits the spectrum)
    const dec = (s) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(h.dir, 'stems', 'trk1', `${s}.flac`), '-f', 's16le', '-'], { maxBuffer: 64 * 2 ** 20 }).stdout;
    const parts = ['vocals', 'drums', 'bass', 'other'].map(dec);
    let maxErr = 0;
    for (let i = 0; i < frames * 2; i += 97) { const sum = parts.reduce((a, p) => a + p.readInt16LE(i * 2), 0); maxErr = Math.max(maxErr, Math.abs(sum - data.readInt16LE(i * 2))); }
    assert.ok(maxErr < 40, `stems sum to the mix (max error ${maxErr})`);
    // already prepared: not queued again unless forced
    assert.equal((await h.json('POST', '/api/stems/queue', { ids: ['trk1'] })).added, 0);
    assert.ok(!fs.readdirSync(path.join(h.dir, 'stems')).some((n) => n.startsWith('.upload-')), 'no upload folder left');
  } finally { h.close(); }
});

test('stems server: native engine cancel, and off by default without onnxruntime-node', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  let failed;
  const fail = new Promise((r) => { failed = r; });
  let h;
  h = await harness({ ffmpeg: true, native: { stub: true }, input: async () => ({ file: path.join(h.dir, 'long.wav') }), onEvent: (t, p) => { if (t === 'stems-failed' || t === 'stems-done') failed([t, p]); } });
  try {
    const frames = 44100 * 60;
    fs.writeFileSync(path.join(h.dir, 'long.wav'), Buffer.concat([wavHeader(frames * 4), pcm(frames, 3)]));
    await h.json('POST', '/api/stems/queue', { ids: ['trk1'] });
    await new Promise((r) => setTimeout(r, 300));
    await h.json('POST', '/api/stems/queue/cancel', { id: 'trk1' });
    const [type, ev] = await fail;
    assert.equal(type, 'stems-failed'); assert.equal(ev.cancelled, true);
    assert.equal((await h.json('GET', '/api/stems/trk1')).ready, false);
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!fs.readdirSync(path.join(h.dir, 'stems')).some((n) => n.startsWith('.upload-')), 'no upload folder left');
  } finally { h.close(); }
  const off = await harness({ ffmpeg: true });
  try {
    const st = await off.json('GET', '/api/stems/status');
    assert.equal(st.native.available, false);
    assert.equal((await off.json('POST', '/api/stems/queue', { ids: ['trk1'] })).status, 409);
  } finally { off.close(); }
});

// ---------------- model download ----------------
function tarEntry(name, data, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
  h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const tar = (...entries) => Buffer.concat([...entries, Buffer.alloc(1024)]);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const fakeFetch = (bytes, calls = []) => async (url) => { calls.push(url); return new Response(Readable.toWeb(Readable.from([bytes.subarray(0, 1000), bytes.subarray(1000)])), { status: 200, headers: { 'content-length': String(bytes.length) } }); };
async function waitFor(fn, ms = 5000) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } }

test('stems server: extracts one member from a tar (pax path, other files skipped)', async () => {
  const model = crypto.randomBytes(3000);
  const pax = Buffer.from('30 path=package/deep/model.onnx\n');
  const t = tar(tarEntry('package/README.md', Buffer.from('hello')), tarEntry('PaxHeader', pax, 'x'), tarEntry('short-name', model), tarEntry('package/other.bin', crypto.randomBytes(700)));
  const chunks = []; const out = new (await import('node:stream')).Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
  assert.equal(await extractTarEntry(Readable.from([t.subarray(0, 100), t.subarray(100, 1500), t.subarray(1500)]), 'package/deep/model.onnx', out), true);
  assert.ok(Buffer.concat(chunks).equals(model));
  assert.equal(await extractTarEntry(Readable.from([t]), 'missing.onnx', out), false);
});

test('stems server: downloads, verifies and serves a pinned model from an archive', async () => {
  const model = crypto.randomBytes(5000);
  const tgz = zlib.gzipSync(tar(tarEntry('package/package.json', Buffer.from('{}')), tarEntry('package/m.onnx', model)));
  const calls = [];
  const h = await harness({ fetch: fakeFetch(tgz, calls), settings: { stemsModelUrl: 'https://models.example/m-1.0.0.tgz#package/m.onnx', stemsModelSha256: sha(model) } });
  try {
    let st = await h.json('GET', '/api/stems/status');
    assert.equal(st.model.custom, true); assert.equal(st.model.ready, false);
    assert.equal((await h.json('POST', '/api/stems/model/download')).started, true);
    st = await waitFor(async () => { const s = await h.json('GET', '/api/stems/status'); return s.model.ready && s; });
    assert.equal(st.model.verified, true); assert.equal(st.model.bytes, model.length);
    assert.deepEqual(calls, ['https://models.example/m-1.0.0.tgz']);
    const r = await h.call('GET', `/api/stems/model?sha=${sha(model)}`);
    assert.match(r.headers.get('cache-control'), /immutable/);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(model));
    assert.ok(h.events.some(([t, p]) => t === 'stems-model' && p.ready));
    assert.equal((await h.json('POST', '/api/stems/model/download')).ready, true, 'second download is a no-op');
    await h.json('DELETE', '/api/stems/model');
    assert.equal((await h.json('GET', '/api/stems/status')).model.ready, false);
  } finally { h.close(); }
});

test('stems server: a model with the wrong SHA-256 is rejected and not kept', async () => {
  const model = crypto.randomBytes(5000);
  const h = await harness({ fetch: fakeFetch(model), settings: { stemsModelUrl: 'https://models.example/model.onnx', stemsModelSha256: sha(Buffer.from('other')) } });
  try {
    await h.json('POST', '/api/stems/model/download');
    const st = await waitFor(async () => { const s = await h.json('GET', '/api/stems/status'); return !s.model.downloading && s.model.error && s; });
    assert.match(st.model.error, /SHA-256 mismatch/);
    assert.equal(st.model.ready, false);
    assert.deepEqual(fs.readdirSync(path.join(h.dir, 'stems', 'models')), [], 'no partial files left');
  } finally { h.close(); }
});

test('stems server: model settings', () => {
  assert.equal(modelSpec({}).url, DEFAULT_MODEL.url);
  assert.match(DEFAULT_MODEL.url, /^https:\/\/registry\.npmjs\.org\/demucs\/-\/demucs-1\.0\.0\.tgz$/);
  assert.match(DEFAULT_MODEL.sha256, /^[0-9a-f]{64}$/); assert.match(DEFAULT_MODEL.archiveSha256, /^[0-9a-f]{64}$/);
  const c = modelSpec({ stemsModelUrl: 'https://x.example/a/model.onnx', stemsModelSha256: 'AB'.repeat(32) });
  assert.equal(c.entry, null); assert.equal(c.sha256, 'ab'.repeat(32));
  assert.equal(modelSpec({ stemsModelUrl: 'https://x.example/p.tgz#entry=package/x.onnx', stemsModelSha256: 'ab'.repeat(32) }).entry, 'package/x.onnx');
  assert.throws(() => modelSpec({ stemsModelUrl: 'https://x.example/p.tgz#entry=package/x.onnx' }), /SHA-256/, 'custom URLs must be pinned');
  assert.throws(() => modelSpec({ stemsModelUrl: 'file:///etc/passwd' }), /http/);
  assert.throws(() => modelSpec({ stemsModelUrl: 'not a url' }));
});

test('stems server: serves onnxruntime-web files from its dist folder only', async () => {
  const ort = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-ort-'));
  fs.writeFileSync(path.join(ort, 'ort.webgpu.min.mjs'), 'export const x = 1;');
  fs.writeFileSync(path.join(ort, 'ort-wasm-simd-threaded.jsep.wasm'), Buffer.from([0, 97, 115, 109]));
  fs.writeFileSync(path.join(ort, 'ort.webgpu.min.mjs.map'), '{}');
  const h = await harness({ ortDir: ort });
  try {
    assert.equal((await h.json('GET', '/api/stems/status')).ort, true);
    let r = await h.call('GET', '/api/stems/ort/ort.webgpu.min.mjs');
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /javascript/);
    r = await h.call('GET', '/api/stems/ort/ort-wasm-simd-threaded.jsep.wasm');
    assert.equal(r.headers.get('content-type'), 'application/wasm');
    assert.equal((await h.call('GET', '/api/stems/ort/ort.webgpu.min.mjs.map')).status, 404);
    assert.equal((await h.call('GET', '/api/stems/ort/..%2Fpackage.json')).status, 404);
    assert.equal((await h.call('GET', '/api/stems/ort/missing.mjs')).status, 404);
  } finally { h.close(); fs.rmSync(ort, { recursive: true, force: true }); }
});

test('stems server: hosted mode refuses model URLs that resolve to this server / link-local, on every redirect hop; only verified models are served', async () => {
  const model = crypto.randomBytes(5000);
  const calls = [];
  const lookup = async (host) => [{ address: { 'public.example': '93.184.216.34', 'local.example': '127.0.0.1' }[host] || '10.0.0.5', family: 4 }];
  const fetchy = async (url) => {
    calls.push(url);
    if (url.startsWith('https://public.example/redirect')) return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    return new Response(model, { status: 200 });
  };
  for (const [u, expect] of [['https://local.example/m.onnx', /Refusing/], ['https://public.example/redirect.onnx', /Refusing/], ['http://[::1]:7380/api/info', /Refusing/]]) {
    calls.length = 0;
    const h = await harness({ fetch: fetchy, lookup, restricted: true, settings: { stemsModelUrl: u, stemsModelSha256: sha(model) } });
    try {
      await h.json('POST', '/api/stems/model/download');
      const st = await waitFor(async () => { const s = await h.json('GET', '/api/stems/status'); return !s.model.downloading && s.model.error && s; });
      assert.match(st.model.error, expect, u);
      assert.equal(calls.some((c) => /169\.254|local\.example|::1/.test(c)), false, 'blocked hop never fetched');
    } finally { h.close(); }
  }
  // a LAN address is fine (NAS installs fetch from the local network), and redirects to it are followed
  calls.length = 0;
  const h = await harness({ fetch: fetchy, lookup, restricted: true, settings: { stemsModelUrl: 'https://lan.example/m.onnx', stemsModelSha256: sha(model) } });
  try {
    await h.json('POST', '/api/stems/model/download');
    await waitFor(async () => (await h.json('GET', '/api/stems/status')).model.ready);
    assert.equal((await h.call('GET', '/api/stems/model')).status, 200);
    // a cached file whose hash does not match the pinned one is not served
    const dir = path.join(h.dir, 'stems', 'models');
    const meta = path.join(dir, `${sha(model)}.onnx.json`);
    fs.writeFileSync(meta, JSON.stringify({ ...JSON.parse(fs.readFileSync(meta, 'utf8')), sha256: 'f'.repeat(64) }));
    assert.equal((await h.call('GET', '/api/stems/model')).status, 404);
  } finally { h.close(); }
  // unpinned custom URLs are refused outright
  const u = await harness({ fetch: fetchy, settings: { stemsModelUrl: 'https://public.example/m.onnx' } });
  try {
    assert.equal((await u.call('POST', '/api/stems/model/download')).status, 400);
    assert.equal((await u.call('GET', '/api/stems/model')).status, 400);
  } finally { u.close(); }
});

// ---------------- background preparation (settings.stemsBackground) ----------------
test('stems server: background order is most played, then rated, then recent', () => {
  const list = [{ id: 'a', playCount: 1, addedAt: 5 }, { id: 'b', playCount: 9 }, { id: 'c', playCount: 1, rating: 5 }, { id: 'd', playCount: 1, addedAt: 9 }];
  assert.deepEqual(list.sort(bgOrder).map((t) => t.id), ['b', 'c', 'd', 'a']);
});

test('stems server: background preparation runs the library most played first and skips tracks it cannot read', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const done = [];
  let finish;
  const all = new Promise((r) => { finish = r; });
  let h;
  h = await harness({
    ffmpeg: true, native: { stub: true, idleMs: 50, bgPollMs: 40 },
    input: async (t) => (t.id === 'nofile' ? null : { file: path.join(h.dir, 'song.wav') }),
    onEvent: (t, p) => { if (t === 'stems-done') { done.push(p); if (done.length === 2) finish(); } },
  });
  try {
    const frames = 44100 * 2;
    fs.writeFileSync(path.join(h.dir, 'song.wav'), Buffer.concat([wavHeader(frames * 4), pcm(frames, 3)]));
    h.library.upsertTrack({ id: 'hot', title: 'Hot', sourceType: 'local', path: path.join(h.dir, 'song.wav'), playCount: 7 });
    h.library.upsertTrack({ id: 'nofile', title: 'Remote', sourceType: 'local', path: path.join(h.dir, 'x.wav'), playCount: 3 });
    let st = await h.json('GET', '/api/stems/status');
    assert.equal(st.native.background.enabled, false); assert.equal(st.native.current, null);
    h.library.settings.stemsBackground = true;
    await h.json('POST', '/api/stems/background', {});
    await all;
    assert.deepEqual(done.map((d) => d.id), ['hot', 'trk1'], 'most played first; the unreadable one is skipped');
    assert.ok(done.every((d) => d.background));
    await new Promise((r) => setTimeout(r, 120));
    st = await h.json('GET', '/api/stems/status');
    assert.equal(st.native.background.remaining, 0); assert.equal(st.native.background.failed, 1); assert.equal(st.native.background.done, 2);
    assert.ok(st.native.background.cacheBytes > 0);
  } finally { h.close(); }
});

test('stems server: a requested track interrupts a background one', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const events = [];
  let h;
  h = await harness({
    ffmpeg: true, native: { stub: true, idleMs: 50, bgPollMs: 1e6 }, settings: { stemsBackground: true },
    input: async (t) => ({ file: path.join(h.dir, t.id === 'trk1' ? 'long.wav' : 'short.wav') }),
    onEvent: (t, p) => { if (t === 'stems-done' || t === 'stems-failed') events.push([t, p.id, !!p.background]); },
  });
  try {
    fs.writeFileSync(path.join(h.dir, 'long.wav'), Buffer.concat([wavHeader(44100 * 60 * 4), pcm(44100 * 60, 3)]));
    fs.writeFileSync(path.join(h.dir, 'short.wav'), Buffer.concat([wavHeader(44100 * 4), pcm(44100, 3)]));
    h.library.upsertTrack({ id: 'asked', title: 'Asked', sourceType: 'local', path: path.join(h.dir, 'short.wav'), playCount: 0 });
    h.library.updateTrack('trk1', { playCount: 5 });
    await h.json('POST', '/api/stems/background', {});
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await h.json('GET', '/api/stems/status')).native.current?.id, 'trk1');
    assert.equal((await h.json('POST', '/api/stems/queue', { ids: ['asked'] })).added, 1);
    const t0 = Date.now();
    while (!events.some((e) => e[1] === 'asked') && Date.now() - t0 < 20e3) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(events[0], ['stems-done', 'asked', false], 'the asked track finished first, without a failure for the interrupted one');
    // the interrupted background track is picked up again afterwards
    while (!events.some((e) => e[1] === 'trk1') && Date.now() - t0 < 30e3) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(events.find((e) => e[1] === 'trk1'), ['stems-done', 'trk1', true]);
    const st = await h.json('GET', '/api/stems/status');
    assert.equal(st.native.background.full, false); assert.equal(st.native.background.capBytes, 40 * 2 ** 30);
  } finally { h.close(); }
});
