// Native AI stem separation, run as a child process of the OpenDJ server (server/stems.js forks it).
// Same model and the same DSP as the browser engine (public/js/stems/*), but ONNX Runtime for Node: native
// multi-threaded CPU everywhere, and the GPU where the platform has one (DirectML on Windows, CoreML on macOS,
// CUDA on Linux when its libraries are installed). A separate process at below-normal priority, so neither the
// server's event loop nor the audio in the browser waits for it, and a cancel simply kills it.
//
// in  (IPC): { type: 'init', model, backend: 'auto'|'gpu'|'cpu', threads, stub, stubGpu?: 'ok'|'broken'|'crash' (tests) }
//            { type: 'job', id, ffmpeg, input: { file } | { url, headers }, dir, overlap, maxFrames }
// out (IPC): { type: 'ready', backend, threads, loadMs, gpuFailed? } { type: 'progress', id, phase, done, total }
//            { type: 'done', id, frames, ms, chunks, backend, gpuFailed? } { type: 'error', id?, message }
// A job writes <dir>/{vocals,drums,bass,other}.raw: interleaved stereo s16le, 44.1 kHz, the whole track.
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { separateChunked, interleaveInt16, STEMS, DEMUCS_SOURCES, MODEL_RATE, stemsDifference, MAX_BACKEND_DIFFERENCE, backendMismatchError } from '../public/js/stems/stem-dsp.js';
import { createRunner, createStubSession, StubTensor, backendTestInput } from '../public/js/stems/stems-model.js';

const send = (m) => process.send?.(m);
const order = STEMS.map((n) => DEMUCS_SOURCES.indexOf(n));
const log = (msg) => process.stderr.write(`[stems] ${msg}\n`);
let runner = null, info = null, ort = null, gpuFailed = null, initMsg = null, session = null;

/** Test stand-in for a GPU whose output layout is wrong: every stem gets slices of the others (sum unchanged). */
function scrambleSources(out, sources, channels, segment) {
  const r = new Float32Array(out.length);
  for (let c = 0; c < channels; c++) for (let t = 0; t < segment; t++) for (let s = 0; s < sources; s++) {
    r[(((s + (t >> 6)) % sources) * channels + c) * segment + t] = out[(s * channels + c) * segment + t];
  }
  return r;
}

/** GPU execution providers worth trying on this platform, in order. */
export function gpuProviders(platform = process.platform, supported = []) {
  const has = (n) => supported.some((b) => b.name === n);
  if (platform === 'win32') return has('dml') ? ['dml'] : [];
  if (platform === 'darwin') return has('coreml') ? ['coreml'] : [];
  if (platform === 'linux') return has('cuda') ? ['cuda'] : [];
  return [];
}

/**
 * The CPU's stems for the fixed test signal: computed once per model and cached next to it (<model>.cpu-ref.f32),
 * with its own session that is released before any GPU session is created, so the two never share the process.
 */
async function cpuReference(m, makeCpu, input) {
  const file = m.model ? `${m.model}.cpu-ref.f32` : null;
  if (file) {
    try {
      const b = fs.readFileSync(file);
      if (b.length % 4 === 0 && b.length > 0) return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
    } catch { /* not cached yet */ }
  }
  const t0 = Date.now();
  const cpu = await makeCpu();
  try {
    const out = await cpu.runner.runChunk(input);
    if (file) { try { fs.writeFileSync(file, new Uint8Array(out.buffer, out.byteOffset, out.byteLength)); } catch (e) { log(`could not cache the CPU reference: ${e.message}`); } }
    log(`CPU reference for the GPU check computed in ${Date.now() - t0} ms`);
    return out;
  } finally { await cpu.release?.(); }
}

/**
 * Load the model. With a GPU backend, its stems for a fixed test signal must match the CPU's
 * (stemsDifference <= MAX_BACKEND_DIFFERENCE): DirectML has been seen returning noise in every stem that still adds
 * up to the track, which the per-chunk mixture check cannot see. A GPU that fails is released and the CPU is used.
 */
async function load(m, { cpuOnly = false } = {}) {
  const t0 = Date.now();
  await release();
  const wantGpu = !cpuOnly && m.backend !== 'cpu';
  if (m.stub) {
    const cpu = createRunner(createStubSession(), StubTensor);
    runner = cpu; info = { backend: 'stub', threads: 1 };
    // tests: a fake GPU in front of the stub ('ok' returns the stub's stems, 'broken' scrambles them, 'crash' dies)
    if (m.stubGpu && wantGpu) {
      const S = cpu.sources.length;
      const fake = m.stubGpu === 'broken' ? async (x) => scrambleSources(await cpu.runChunk(x), S, 2, cpu.segment)
        : m.stubGpu === 'crash' ? async () => { process.kill(process.pid, 'SIGKILL'); return new Promise(() => {}); }
          : cpu.runChunk;
      const gpu = { ...cpu, runChunk: fake };
      const verdict = await checkGpu('stub-gpu', gpu, () => ({ runner: createRunner(createStubSession(), StubTensor) }), m);
      if (verdict.ok) { runner = gpu; info = { backend: 'stub-gpu', threads: 0 }; }
    }
    info.loadMs = Date.now() - t0;
    return;
  }
  ort ||= createRequire(import.meta.url)('onnxruntime-node');
  const threads = Math.max(1, Math.floor(m.threads) || Math.max(1, (os.availableParallelism?.() || os.cpus().length) - 2));
  const opts = { graphOptimizationLevel: 'all', intraOpNumThreads: threads, interOpNumThreads: 1 };
  const makeCpu = async () => {
    const s = await ort.InferenceSession.create(m.model, { ...opts, executionProviders: ['cpu'] });
    return { session: s, runner: createRunner(s, ort.Tensor), release: () => s.release?.() };
  };
  if (wantGpu) {
    for (const ep of gpuProviders(process.platform, ort.listSupportedBackends?.() || [])) {
      // DirectML needs sequential execution without memory patterns
      const epOpts = ep === 'dml' ? { ...opts, enableMemPattern: false, executionMode: 'sequential' } : opts;
      let s = null;
      try {
        const input = backendTestInput();
        const ref = await cpuReference(m, makeCpu, input); // before the GPU session exists
        log(`loading the model on ${ep}`);
        s = await ort.InferenceSession.create(m.model, { ...epOpts, executionProviders: [ep] });
        const gpu = createRunner(s, ort.Tensor);
        const verdict = await checkGpu(ep, gpu, null, m, { input, ref });
        if (verdict.ok) { session = s; runner = gpu; info = { backend: ep, threads: 0, loadMs: Date.now() - t0 }; return; }
      } catch (e) {
        gpuFailed ||= { backend: ep, message: e.message };
        log(`${ep} unavailable, using the CPU: ${e.message}`);
      }
      try { await s?.release?.(); } catch { /* already gone */ }
    }
  }
  const cpu = await makeCpu();
  session = cpu.session; runner = cpu.runner;
  info = { backend: 'cpu', threads, loadMs: Date.now() - t0 };
}

/** Compare a GPU runner with the CPU on the test signal; records gpuFailed when it does not match. */
async function checkGpu(name, gpu, makeCpu, m, { input = backendTestInput(), ref = null } = {}) {
  const t0 = Date.now();
  ref ||= await cpuReference(m, makeCpu, input);
  const out = await gpu.runChunk(input);
  const diff = stemsDifference(out, ref);
  if (diff <= MAX_BACKEND_DIFFERENCE) { log(`${name} output matches the CPU (difference ${diff.toExponential(1)}, ${Date.now() - t0} ms)`); return { ok: true, diff }; }
  const message = backendMismatchError(name, diff).message;
  gpuFailed = { backend: name, message };
  log(`${message}: using the CPU`);
  return { ok: false, diff };
}

/** Free the loaded model (native memory, GPU) before another one is loaded. */
async function release() {
  const s = session; session = null; runner = null;
  try { await s?.release?.(); } catch { /* already released */ }
}

/** Decode any input FFmpeg reads to planar float 44.1 kHz stereo. */
function decode(ffmpeg, input, maxFrames) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (input.url) {
      const h = Object.entries(input.headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      if (h) args.push('-headers', h);
      args.push('-i', input.url);
    } else args.push('-i', input.file);
    args.push('-map', '0:a:0', '-vn', '-f', 'f32le', '-ac', '2', '-ar', String(MODEL_RATE), '-');
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = []; let bytes = 0, err = '', tooLong = false;
    p.stdout.on('data', (c) => {
      bytes += c.length;
      if (maxFrames && bytes > maxFrames * 8) { tooLong = true; p.kill(); return; }
      chunks.push(c);
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (tooLong) return reject(new Error(`The track is too long for stems (max. ${Math.round(maxFrames / MODEL_RATE / 60)} minutes)`));
      if (code !== 0) return reject(new Error(`Could not decode the track: ${err.trim().split('\n').pop() || `ffmpeg exited with ${code}`}`));
      const buf = Buffer.concat(chunks);
      const length = Math.floor(buf.length / 8);
      if (!length) return reject(new Error('The track has no audio'));
      const f = new Float32Array(buf.buffer, buf.byteOffset, length * 2);
      const left = new Float32Array(length), right = new Float32Array(length);
      for (let i = 0; i < length; i++) { left[i] = f[2 * i]; right[i] = f[2 * i + 1]; }
      resolve({ left, right, length });
    });
  });
}

async function job(m) {
  const t0 = Date.now();
  send({ type: 'progress', id: m.id, phase: 'decoding', done: 0, total: 0 });
  const audio = await decode(m.ffmpeg, m.input, m.maxFrames);
  const fds = STEMS.map((s) => fs.openSync(`${m.dir}/${s}.raw`, 'w'));
  const pos = STEMS.map(() => 0);
  let lastSent = 0;
  const run = async () => separateChunked({
    channels: [audio.left, audio.right], length: audio.length, segment: runner.segment, overlap: m.overlap ?? 0.25, sources: runner.sources.length,
    runChunk: runner.runChunk,
    onProgress: (done, total) => {
      const now = Date.now();
      if (done === 0 || done === total || now - lastSent > 500) { lastSent = now; send({ type: 'progress', id: m.id, phase: 'separating', done, total, backend: info.backend }); }
    },
    onBlock: ({ frames, data }) => {
      order.forEach((k, s) => { const pcm = interleaveInt16(data, 2, frames, k * 2 * frames); fs.writeSync(fds[s], new Uint8Array(pcm.buffer), 0, pcm.byteLength, pos[s]); pos[s] += pcm.byteLength; });
    },
  });
  try {
    let r;
    try { r = await run(); }
    catch (e) {
      // a GPU provider that loads but fails on the first chunk (driver, memory): redo the track on the CPU
      if (info.backend === 'cpu' || info.backend === 'stub') throw e;
      log(`${info.backend} failed (${e.message}), using the CPU`);
      gpuFailed = { backend: info.backend, message: e.message };
      await load(initMsg, { cpuOnly: true }); // releases the GPU session first
      for (const fd of fds) fs.ftruncateSync(fd, 0);
      pos.fill(0);
      r = await run();
    }
    send({ type: 'done', id: m.id, frames: audio.length, ms: Date.now() - t0, chunks: r.chunks, backend: info.backend, threads: info.threads, ...(gpuFailed ? { gpuFailed } : {}) });
  } finally { for (const fd of fds) fs.closeSync(fd); }
}

// one message at a time: a job never starts before the model is loaded
let chain = Promise.resolve();
process.on('message', (m) => {
  chain = chain.then(async () => {
    try {
      if (m.type === 'init') {
        initMsg = m; await load(m, { cpuOnly: !!gpuFailed });
        log(`ready: ${info.backend}${info.threads ? ` x${info.threads} threads` : ''}, loaded in ${info.loadMs} ms`);
        send({ type: 'ready', ...info, ...(gpuFailed ? { gpuFailed } : {}) });
      }
      else if (m.type === 'job') {
        if (!runner) throw new Error('Model not loaded');
        log(`job ${m.id}: separating on ${info.backend}`);
        await job(m);
      }
    } catch (e) { send({ type: 'error', id: m.id, message: e?.message || String(e) }); }
  });
});
process.on('disconnect', () => process.exit(0));
