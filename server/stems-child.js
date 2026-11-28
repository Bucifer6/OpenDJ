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
/** ONNX Runtime graph optimisation levels tried on a GPU provider, most optimised first. */
export const GPU_LEVELS = ['all', 'basic', 'disabled'];
const ortVersion = () => { try { return createRequire(import.meta.url)('onnxruntime-node/package.json').version; } catch { return null; } };
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
  const cores = os.availableParallelism?.() || os.cpus().length;
  const threads = Math.max(1, Math.floor(m.threads) || Math.min(4, Math.max(1, Math.floor(cores / 2))));
  const opts = { graphOptimizationLevel: 'all', intraOpNumThreads: threads, interOpNumThreads: 1 };
  const makeCpu = async () => {
    const s = await ort.InferenceSession.create(m.model, { ...opts, executionProviders: ['cpu'] });
    return { session: s, runner: createRunner(s, ort.Tensor), release: () => s.release?.() };
  };
  if (wantGpu) {
    for (const ep of gpuProviders(process.platform, ort.listSupportedBackends?.() || [])) {
      // ONNX Runtime's graph optimisations can fuse HT-Demucs' layers into kernels a GPU provider computes wrongly
      // (DirectML returned noise with level 'all'), so each level is tried in turn and checked against the CPU; the
      // one that works is remembered next to the model (<model>.gpu-<ep>.json) and tried first next time.
      const memo = `${m.model}.gpu-${ep}.json`;
      let remembered = null;
      try { remembered = JSON.parse(fs.readFileSync(memo, 'utf8')); } catch { /* first time */ }
      if (remembered?.ok === false && remembered.ort === ortVersion()) { gpuFailed ||= { backend: ep, message: remembered.message }; log(`${ep}: ${remembered.message} (checked before)`); continue; }
      // Fast path: if this exact GPU provider + level + ORT version already passed verification before,
      // load it directly without re-running a 1-5 s synthetic CPU-vs-GPU inference on every 90 s respawn.
      if (remembered?.ok === true && remembered.ort === ortVersion() && remembered.level) {
        const epOpts = { ...opts, graphOptimizationLevel: remembered.level, ...(ep === 'dml' ? { enableMemPattern: false, executionMode: 'sequential' } : {}) };
        try {
          log(`loading verified ${ep} (graph optimisation: ${remembered.level})`);
          const s = await ort.InferenceSession.create(m.model, { ...epOpts, executionProviders: [ep] });
          gpuFailed = null;
          session = s; runner = createRunner(s, ort.Tensor); info = { backend: ep, threads: 0, loadMs: Date.now() - t0, level: remembered.level };
          return;
        } catch (e) {
          log(`${ep} (${remembered.level}) reload failed, re-verifying: ${e.message}`);
        }
      }
      const levels = [...new Set([remembered?.ok ? remembered.level : null, ...GPU_LEVELS].filter(Boolean))];
      const failures = [];
      let input, ref;
      try { input = backendTestInput(); ref = await cpuReference(m, makeCpu, input); } // before any GPU session exists
      catch (e) { log(`CPU reference failed: ${e.message}`); break; }
      for (const level of levels) {
        // DirectML needs sequential execution without memory patterns
        const epOpts = { ...opts, graphOptimizationLevel: level, ...(ep === 'dml' ? { enableMemPattern: false, executionMode: 'sequential' } : {}) };
        let s = null;
        try {
          log(`loading the model on ${ep} (graph optimisation: ${level})`);
          s = await ort.InferenceSession.create(m.model, { ...epOpts, executionProviders: [ep] });
          const gpu = createRunner(s, ort.Tensor);
          const verdict = await checkGpu(`${ep}/${level}`, gpu, null, m, { input, ref, record: false });
          if (verdict.ok) {
            gpuFailed = null;
            try { fs.writeFileSync(memo, JSON.stringify({ ok: true, level, ort: ortVersion(), at: Date.now() })); } catch { /* read-only */ }
            session = s; runner = gpu; info = { backend: ep, threads: 0, loadMs: Date.now() - t0, level };
            return;
          }
          failures.push(`${level}: difference ${verdict.diff.toExponential(1)}`);
        } catch (e) {
          failures.push(`${level}: ${e.message}`);
          log(`${ep} (${level}) unavailable: ${e.message}`);
        }
        try { await s?.release?.(); } catch { /* already gone */ }
        if (failures.length && /unavailable|Failed to load|not supported/i.test(failures.at(-1))) break; // the provider itself is missing
      }
      const missing = failures.length === 1 && /unavailable|Failed to load|not supported/i.test(failures[0]);
      const message = missing ? `the ${ep} backend is not available here (${failures[0].replace(/^\w+: /, '')})`
        : `the ${ep} backend did not match the CPU at any optimisation level (${failures.join('; ')})`;
      gpuFailed ||= { backend: ep, message };
      log(`${message}: using the CPU`);
      try { fs.writeFileSync(memo, JSON.stringify({ ok: false, message, ort: ortVersion(), at: Date.now() })); } catch { /* read-only */ }
    }
  }
  const cpu = await makeCpu();
  session = cpu.session; runner = cpu.runner;
  info = { backend: 'cpu', threads, loadMs: Date.now() - t0 };
}

/** Compare a GPU runner with the CPU on the test signal; records gpuFailed when it does not match. */
async function checkGpu(name, gpu, makeCpu, m, { input = backendTestInput(), ref = null, record = true } = {}) {
  const t0 = Date.now();
  ref ||= await cpuReference(m, makeCpu, input);
  const out = await gpu.runChunk(input);
  const diff = stemsDifference(out, ref);
  if (diff <= MAX_BACKEND_DIFFERENCE) { log(`${name} output matches the CPU (difference ${diff.toExponential(1)}, ${Date.now() - t0} ms)`); return { ok: true, diff }; }
  const message = backendMismatchError(name, diff).message;
  if (record) gpuFailed = { backend: name, message };
  log(`${message}: using the CPU`);
  return { ok: false, diff };
}

/** Free the loaded model (native memory, GPU) before another one is loaded. */
async function release() {
  const s = session; session = null; runner = null;
  try { await s?.release?.(); } catch { /* already released */ }
}

/** Stream FFmpeg decode to a temporary interleaved f32le stereo file on disk (~6 MB RAM even for 90-min mixes). */
function decodeToFile(ffmpeg, input, maxFrames, tmpFile) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2'];
    if (input.url) {
      const h = Object.entries(input.headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      if (h) args.push('-headers', h);
      args.push('-i', input.url);
    } else args.push('-i', input.file);
    args.push('-map', '0:a:0', '-vn', '-f', 'f32le', '-ac', '2', '-ar', String(MODEL_RATE), '-');
    const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = fs.createWriteStream(tmpFile);
    let bytes = 0, err = '', tooLong = false, settled = false;
    const fail = (e) => { if (!settled) { settled = true; try { out.destroy(); } catch { /* */ } reject(e); } };
    out.on('error', (e) => { p.kill(); fail(e); });
    p.stdout.on('data', (c) => {
      bytes += c.length;
      if (maxFrames && bytes > maxFrames * 8) { tooLong = true; p.kill(); out.destroy(); return; }
      if (!out.write(c)) p.stdout.pause();
    });
    out.on('drain', () => p.stdout.resume());
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', fail);
    p.on('close', (code) => {
      if (tooLong) return fail(new Error(`The track is too long for stems (max. ${Math.round(maxFrames / MODEL_RATE / 60)} minutes)`));
      if (code !== 0) return fail(new Error(`Could not decode the track: ${err.trim().split('\n').pop() || `ffmpeg exited with ${code}`}`));
      out.end(() => {
        if (settled) return;
        settled = true;
        const length = Math.floor(bytes / 8);
        if (!length) return reject(new Error('The track has no audio'));
        resolve({ file: tmpFile, length });
      });
    });
  });
}

async function job(m) {
  const t0 = Date.now();
  send({ type: 'progress', id: m.id, phase: 'decoding', done: 0, total: 0 });
  const pcmFile = `${m.dir}/input.f32`;
  const decoded = await decodeToFile(m.ffmpeg, m.input, m.maxFrames, pcmFile);
  const pcmFd = fs.openSync(decoded.file, 'r');
  const fds = STEMS.map((s) => fs.openSync(`${m.dir}/${s}.raw`, 'w'));
  const pos = STEMS.map(() => 0);
  let lastSent = 0;
  let readBuf = null;
  const fillChunk = (offset, chunkLen, segment, out) => {
    const start = offset - Math.floor((segment - chunkLen) / 2);
    out.fill(0);
    const a = Math.max(0, start), b = Math.min(decoded.length, start + segment);
    const count = b - a;
    if (count <= 0) return;
    const needBytes = count * 8;
    if (!readBuf || readBuf.length < needBytes) readBuf = Buffer.allocUnsafe(segment * 8);
    let got = 0;
    while (got < needBytes) {
      const r = fs.readSync(pcmFd, readBuf, got, needBytes - got, a * 8 + got);
      if (r <= 0) break;
      got += r;
    }
    const frames = Math.floor(got / 8);
    const f = new Float32Array(readBuf.buffer, readBuf.byteOffset, frames * 2);
    const dstOff = a - start;
    for (let i = 0; i < frames; i++) {
      out[dstOff + i] = f[2 * i];
      out[segment + dstOff + i] = f[2 * i + 1];
    }
  };
  const run = async () => separateChunked({
    channelCount: 2, fillChunk, length: decoded.length, segment: runner.segment, overlap: m.overlap ?? 0.25, sources: runner.sources.length,
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
    send({ type: 'done', id: m.id, frames: decoded.length, ms: Date.now() - t0, chunks: r.chunks, backend: info.backend, threads: info.threads, ...(gpuFailed ? { gpuFailed } : {}) });
  } finally {
    readBuf = null;
    try { fs.closeSync(pcmFd); } catch { /* */ }
    for (const fd of fds) { try { fs.closeSync(fd); } catch { /* */ } }
    try { fs.rmSync(pcmFile, { force: true }); } catch { /* */ }
  }
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
