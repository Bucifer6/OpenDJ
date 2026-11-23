// Stem separation worker: ONNX Runtime Web (WebGPU when available, else WASM) runs HT-Demucs chunk by chunk.
// Finished audio is posted back block by block as Int16 (the page uploads it to the server), so neither the
// UI thread nor the audio thread does any heavy work, and a long track never sits in memory as 4 float stems.
//
// in : { type: 'init', ortBase, modelUrl, threads, backend: 'auto'|'webgpu'|'wasm', stub, gpuVerified }
//      { type: 'separate', id, left, right, length, overlap }
// out: { type: 'model-progress', received, total } { type: 'ready', backend, threads, kind, loadMs }
//      { type: 'progress', id, done, total } { type: 'block', id, frame, frames, stems: Int16Array[4] (STEMS order) }
//      { type: 'backend', backend, threads, failed? } { type: 'verified', backend } (WebGPU matched WASM once)
//      { type: 'done', id, ms, chunks } { type: 'error', id?, message }
import { separateChunked, interleaveInt16, STEMS, DEMUCS_SOURCES } from './stem-dsp.js';
import { createRunner, createStubSession, StubTensor, verifiedRunChunk } from './stems-model.js';

let runner = null, info = null, toWasm = null, wasmReference = null, gpuRun = null;
const order = STEMS.map((n) => DEMUCS_SOURCES.indexOf(n)); // model index for each OpenDJ stem

async function fetchModel(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Model: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const out = new Uint8Array(total); let got = 0, last = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, got); got += value.length;
    if (got - last > 4e6) { last = got; postMessage({ type: 'model-progress', received: got, total }); }
  }
  return got === total ? out : out.subarray(0, got);
}

async function init(m) {
  const t0 = performance.now();
  if (m.stub) {
    runner = createRunner(createStubSession(), StubTensor);
    info = { backend: 'stub', threads: 1, kind: runner.kind };
  } else {
    const ort = await import(`${m.ortBase}ort.webgpu.min.mjs`);
    ort.env.wasm.wasmPaths = m.ortBase;
    // multi-threaded WASM needs SharedArrayBuffer, i.e. a cross-origin isolated page (COOP/COEP headers)
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, m.threads || 1) : 1;
    ort.env.logLevel = 'error';
    const bytes = await fetchModel(m.modelUrl);
    const opts = { graphOptimizationLevel: 'all' };
    let session = null, backend = 'wasm';
    const gpuOk = m.backend !== 'wasm' && 'gpu' in navigator && await navigator.gpu.requestAdapter().then((a) => !!a, () => false);
    if (gpuOk) {
      try { session = await ort.InferenceSession.create(bytes, { ...opts, executionProviders: ['webgpu'] }); backend = 'webgpu'; } catch (e) { console.warn('[stems] WebGPU unavailable, using WASM:', e.message); }
    }
    if (!session) session = await ort.InferenceSession.create(bytes, { ...opts, executionProviders: ['wasm'] });
    runner = createRunner(session, ort.Tensor);
    // WebGPU is checked once against WASM on real audio (verifiedRunChunk: noise that still adds up to the track
    // passes mixtureError), unless this page already checked it
    wasmReference = backend === 'wasm' || m.gpuVerified ? null : async () => {
      const cpu = await ort.InferenceSession.create(bytes, { ...opts, executionProviders: ['wasm'] });
      return { runChunk: createRunner(cpu, ort.Tensor).runChunk, release: () => cpu.release?.() };
    };
    gpuRun = null;
    // WebGPU that runs but returns invalid stems: separate() redoes the track on WASM
    toWasm = backend === 'wasm' ? null : async () => {
      await session.release?.().catch?.(() => {});
      session = await ort.InferenceSession.create(bytes, { ...opts, executionProviders: ['wasm'] });
      runner = createRunner(session, ort.Tensor);
      info = { backend: 'wasm', threads: ort.env.wasm.numThreads, kind: runner.kind };
      toWasm = null; wasmReference = null; gpuRun = null;
    };
    info = { backend, threads: backend === 'wasm' ? ort.env.wasm.numThreads : 0, kind: runner.kind };
  }
  postMessage({ type: 'ready', ...info, loadMs: Math.round(performance.now() - t0) });
}

async function separate(m) {
  if (!runner) throw new Error('Model not loaded');
  const t0 = performance.now();
  const left = m.left, right = m.right || m.left;
  const runChunk = () => {
    if (!wasmReference) return runner.runChunk;
    gpuRun ||= verifiedRunChunk(runner.runChunk, wasmReference, { backend: info.backend, onVerified: () => postMessage({ type: 'verified', backend: info.backend }) });
    return gpuRun.isVerified() ? runner.runChunk : gpuRun;
  };
  const run = () => separateChunked({
    channels: [left, right], length: m.length, segment: runner.segment, overlap: m.overlap ?? 0.25, sources: runner.sources.length,
    runChunk: runChunk(),
    onProgress: (done, total) => postMessage({ type: 'progress', id: m.id, done, total }),
    onBlock: ({ frame, frames, data }) => {
      const stems = order.map((k) => interleaveInt16(data, 2, frames, k * 2 * frames));
      postMessage({ type: 'block', id: m.id, frame, frames, stems }, stems.map((s) => s.buffer));
    },
  });
  let r;
  try { r = await run(); }
  catch (e) {
    if (e?.code !== 'BAD_STEM_OUTPUT' || !toWasm) throw e;
    console.warn(`[stems] ${info.backend}: ${e.message}; using WASM`);
    await toWasm();
    postMessage({ type: 'backend', ...info, failed: true });
    r = await run(); // blocks are keyed by frame: the redo overwrites anything already sent
  }
  postMessage({ type: 'done', id: m.id, ms: Math.round(performance.now() - t0), chunks: r.chunks, ...info });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'separate') await separate(m);
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: err?.message || String(err) });
  }
};
