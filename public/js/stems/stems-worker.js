// Stem separation worker: ONNX Runtime Web (WebGPU when available, else WASM) runs HT-Demucs chunk by chunk.
// Finished audio is posted back block by block as Int16 (the page uploads it to the server), so neither the
// UI thread nor the audio thread does any heavy work, and a long track never sits in memory as 4 float stems.
//
// in : { type: 'init', ortBase, modelUrl, threads, backend: 'auto'|'webgpu'|'wasm', stub }
//      { type: 'separate', id, left, right, length, overlap }
// out: { type: 'model-progress', received, total } { type: 'ready', backend, threads, kind, loadMs }
//      { type: 'progress', id, done, total } { type: 'block', id, frame, frames, stems: Int16Array[4] (STEMS order) }
//      { type: 'done', id, ms, chunks } { type: 'error', id?, message }
import { separateChunked, interleaveInt16, STEMS, DEMUCS_SOURCES } from './stem-dsp.js';
import { createRunner, createStubSession, StubTensor } from './stems-model.js';

let runner = null, info = null;
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
    info = { backend, threads: backend === 'wasm' ? ort.env.wasm.numThreads : 0, kind: runner.kind };
  }
  postMessage({ type: 'ready', ...info, loadMs: Math.round(performance.now() - t0) });
}

async function separate(m) {
  if (!runner) throw new Error('Model not loaded');
  const t0 = performance.now();
  const left = m.left, right = m.right || m.left;
  const r = await separateChunked({
    channels: [left, right], length: m.length, segment: runner.segment, overlap: m.overlap ?? 0.25, sources: runner.sources.length,
    runChunk: runner.runChunk,
    onProgress: (done, total) => postMessage({ type: 'progress', id: m.id, done, total }),
    onBlock: ({ frame, frames, data }) => {
      const stems = order.map((k) => interleaveInt16(data, 2, frames, k * 2 * frames));
      postMessage({ type: 'block', id: m.id, frame, frames, stems }, stems.map((s) => s.buffer));
    },
  });
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
