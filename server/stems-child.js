// Native AI stem separation, run as a child process of the OpenDJ server (server/stems.js forks it).
// Same model and the same DSP as the browser engine (public/js/stems/*), but ONNX Runtime for Node: native
// multi-threaded CPU everywhere, and the GPU where the platform has one (DirectML on Windows, CoreML on macOS,
// CUDA on Linux when its libraries are installed). A separate process at below-normal priority, so neither the
// server's event loop nor the audio in the browser waits for it, and a cancel simply kills it.
//
// in  (IPC): { type: 'init', model, backend: 'auto'|'gpu'|'cpu', threads, stub, stubGpu?: 'ok'|'broken' (tests) }
//            { type: 'job', id, ffmpeg, input: { file } | { url, headers }, dir, overlap, maxFrames }
// out (IPC): { type: 'ready', backend, threads, loadMs } { type: 'progress', id, phase, done, total }
//            { type: 'done', id, frames, ms, chunks, backend, gpuFailed? } { type: 'error', id?, message }
// A job writes <dir>/{vocals,drums,bass,other}.raw: interleaved stereo s16le, 44.1 kHz, the whole track.
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { separateChunked, interleaveInt16, STEMS, DEMUCS_SOURCES, MODEL_RATE } from '../public/js/stems/stem-dsp.js';
import { createRunner, createStubSession, StubTensor, verifiedRunChunk } from '../public/js/stems/stems-model.js';

const send = (m) => process.send?.(m);
const order = STEMS.map((n) => DEMUCS_SOURCES.indexOf(n));
let runner = null, info = null, ort = null, gpuFailed = false, initMsg = null;
// A GPU backend is only trusted once its stems match the CPU's for one chunk of real audio (verifiedRunChunk):
// DirectML has been seen returning noise in every stem that still adds up to the track, so mixtureError passes it.
let gpuRun = null, cpuReference = null;

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

async function load(m, { cpuOnly = false } = {}) {
  const t0 = Date.now();
  gpuRun = null; cpuReference = null;
  if (m.stub) {
    runner = createRunner(createStubSession(), StubTensor);
    info = { backend: 'stub', threads: 1 };
    // tests: a fake GPU in front of the stub ('ok' returns the stub's stems, 'broken' scrambles them)
    if (m.stubGpu && !cpuOnly && m.backend !== 'cpu') {
      const cpu = runner, S = cpu.sources.length;
      const fake = m.stubGpu === 'broken' ? async (x) => scrambleSources(await cpu.runChunk(x), S, 2, cpu.segment) : cpu.runChunk;
      runner = { ...cpu, runChunk: fake };
      info = { backend: 'stub-gpu', threads: 0 };
      cpuReference = async () => ({ runChunk: cpu.runChunk });
    }
    return;
  }
  ort ||= createRequire(import.meta.url)('onnxruntime-node');
  const threads = Math.max(1, Math.floor(m.threads) || Math.max(1, (os.availableParallelism?.() || os.cpus().length) - 2));
  const opts = { graphOptimizationLevel: 'all', intraOpNumThreads: threads, interOpNumThreads: 1 };
  let session = null, backend = 'cpu';
  if (!cpuOnly && m.backend !== 'cpu') {
    for (const ep of gpuProviders(process.platform, ort.listSupportedBackends?.() || [])) {
      try { session = await ort.InferenceSession.create(m.model, { ...opts, executionProviders: [ep] }); backend = ep; break; }
      catch (e) { process.stderr.write(`[stems] ${ep} unavailable, using the CPU: ${e.message}\n`); }
    }
  }
  if (!session) session = await ort.InferenceSession.create(m.model, { ...opts, executionProviders: ['cpu'] });
  runner = createRunner(session, ort.Tensor);
  info = { backend, threads: backend === 'cpu' ? threads : 0, loadMs: Date.now() - t0 };
  if (backend !== 'cpu') {
    // the CPU session for the one-time check: loaded only when the first chunk with audio arrives, released after
    cpuReference = async () => {
      const cpu = await ort.InferenceSession.create(m.model, { ...opts, executionProviders: ['cpu'] });
      return { runChunk: createRunner(cpu, ort.Tensor).runChunk, release: () => cpu.release?.() };
    };
  }
}

/** runChunk for this job: a GPU that has not passed the CPU comparison yet is checked on its first audible chunk. */
function jobRunChunk() {
  if (!cpuReference) return runner.runChunk;
  gpuRun ||= verifiedRunChunk(runner.runChunk, cpuReference, {
    backend: info.backend,
    onVerified: (diff) => process.stderr.write(`[stems] ${info.backend} output matches the CPU (difference ${diff.toExponential(1)})\n`),
  });
  return gpuRun.isVerified() ? runner.runChunk : gpuRun;
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
    runChunk: jobRunChunk(),
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
      if (info.backend === 'cpu' || info.backend === 'stub' || gpuFailed) throw e;
      process.stderr.write(`[stems] ${info.backend} failed (${e.message}), using the CPU\n`);
      gpuFailed = { backend: info.backend, message: e.message };
      await load(initMsg, { cpuOnly: true });
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
      if (m.type === 'init') { initMsg = m; await load(m, { cpuOnly: gpuFailed }); send({ type: 'ready', ...info }); }
      else if (m.type === 'job') {
        if (!runner) throw new Error('Model not loaded');
        await job(m);
      }
    } catch (e) { send({ type: 'error', id: m.id, message: e?.message || String(e) }); }
  });
});
process.on('disconnect', () => process.exit(0));
