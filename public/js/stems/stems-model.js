// Turns an ONNX Runtime session into runChunk() for separateChunked().
// Supported graphs (detected from the session's inputs/outputs):
//  - "hybrid" HT-Demucs export with the STFT outside the graph (npm "demucs" / sevagh demucs.onnx style):
//      inputs  mix [1,2,N] + complex-as-channels spectrogram [1,4,2048,T]
//      outputs spectrogram masks/estimates [1,S,4,2048,T] + time branch [1,S,2,N]  -> ispec(spec) + time
//  - "waveform" exports with the STFT inside the graph (StemSplit demucs-onnx style): mix [1,2,N] -> [1,S,2,N]
// A deterministic stub session (frequency bands) stands in for the model in tests.
import { demucsSpec, demucsISpec, specFrames, BINS, NFFT, MODEL_RATE, DEMUCS_SOURCES, stemsDifference, MAX_BACKEND_DIFFERENCE, meanSquare, backendMismatchError } from './stem-dsp.js';

export const SEGMENT = Math.floor(7.8 * MODEL_RATE); // 343980: fixed by the exported graphs

const dimsOf = (session, name, kind) => {
  const md = kind === 'in' ? session.inputMetadata : session.outputMetadata;
  const m = Array.isArray(md) ? md.find((x) => x.name === name) : md?.[name];
  return m?.shape || m?.dims || null;
};

export function createRunner(session, Tensor, { sources = DEMUCS_SOURCES } = {}) {
  const ins = session.inputNames, outs = session.outputNames;
  const S = sources.length, C = 2;
  if (ins.length >= 2) {
    // which input is the waveform? the one with 3 dims (fall back to the export's order: mix, spec)
    let mixName = ins[0], specName = ins[1];
    const d0 = dimsOf(session, ins[0], 'in'), d1 = dimsOf(session, ins[1], 'in');
    if (d0 && d1 && d0.length === 4 && d1.length === 3) [mixName, specName] = [ins[1], ins[0]];
    const segment = Number(dimsOf(session, mixName, 'in')?.[2]) || SEGMENT;
    const T = specFrames(segment);
    return {
      kind: 'hybrid', segment, sources,
      async runChunk(mix) {
        const spec = demucsSpec(mix, C, segment);
        const mixT = new Tensor('float32', mix, [1, C, segment]);
        const specT = new Tensor('float32', spec, [1, C * 2, BINS, T]);
        let r;
        try {
          r = await session.run({ [mixName]: mixT, [specName]: specT });
        } finally {
          mixT.dispose?.();
          specT.dispose?.();
        }
        let zx = null, xt = null;
        for (const n of outs) { const t = r[n]; if (t.dims.length === 5) zx = t; else xt = t; }
        if (!zx || !xt) { for (const n of outs) r[n].dispose?.(); throw new Error('Unexpected model outputs'); }
        const out = new Float32Array(xt.data); // time branch, [S][C][segment]
        demucsISpec(zx.data, S, C, segment, out);
        for (const n of outs) r[n].dispose?.();
        return out;
      },
    };
  }
  const segment = Number(dimsOf(session, ins[0], 'in')?.[2]) || SEGMENT;
  return {
    kind: 'waveform', segment, sources,
    async runChunk(mix) {
      const mixT = new Tensor('float32', mix, [1, C, segment]);
      let r;
      try { r = await session.run({ [ins[0]]: mixT }); } finally { mixT.dispose?.(); }
      const t = r[outs[0]];
      const out = new Float32Array(t.data);
      t.dispose?.();
      return out;
    },
  };
}

/**
 * runChunk for a GPU backend that is checked against the CPU once: the first chunk with real audio in it is also run
 * on `reference()` (a CPU runner, created only for this and released after), and if the GPU's stems differ from the
 * CPU's (stemsDifference > MAX_BACKEND_DIFFERENCE) backendMismatchError is thrown, so the caller redoes the track on
 * the CPU. Until then every chunk is compared; after the check passes, chunks go straight to the GPU.
 * @param {(mix: Float32Array) => Promise<Float32Array>} runChunk the GPU runner
 * @param {() => Promise<{ runChunk: Function, release?: Function }>} reference
 * @param {{ backend?: string, onVerified?: (diff: number) => void, minMeanSquare?: number }} [o]
 */
export function verifiedRunChunk(runChunk, reference, { backend = 'GPU', onVerified, minMeanSquare = 1e-5 } = {}) {
  let verified = false;
  const run = async (mix) => {
    const out = await runChunk(mix);
    if (verified || meanSquare(mix) < minMeanSquare) return out; // silence says nothing about the backend
    const ref = await reference();
    let expected;
    try { expected = await ref.runChunk(mix); } finally { await ref.release?.(); }
    const diff = stemsDifference(out, expected);
    if (!(diff <= MAX_BACKEND_DIFFERENCE)) throw backendMismatchError(backend, diff);
    verified = true;
    onVerified?.(diff);
    return out;
  };
  run.isVerified = () => verified;
  return run;
}

/**
 * Fixed, music-like test input for comparing a GPU backend with the CPU (planar stereo [2][segment]): a kick, a
 * bass line, a harmonic "voice" and noise hats, from a seeded generator so every run and every machine get the
 * same samples.
 */
export function backendTestInput(segment = SEGMENT) {
  const x = new Float32Array(2 * segment);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 31 - 1; };
  for (let i = 0; i < segment; i++) {
    const t = i / MODEL_RATE, beat = t % 0.5;
    const kick = Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-beat * 30)) * beat) * Math.exp(-beat * 8) * 0.45;
    const bass = Math.sin(2 * Math.PI * (55 * (1 + ((t * 2) | 0) % 2)) * t) * 0.2;
    let voice = 0;
    const f0 = 220 * (1 + 0.01 * Math.sin(2 * Math.PI * 5 * t));
    for (let h = 1; h < 12; h++) voice += Math.sin(2 * Math.PI * f0 * h * t) * Math.exp(-((f0 * h - 800) ** 2) / 2e5) / h;
    const hat = (t + 0.25) % 0.5 < 0.03 ? rnd() * 0.12 : 0;
    x[i] = kick + bass + voice * 0.25 + hat;
    x[segment + i] = kick + bass + voice * 0.2 + hat * 0.7;
  }
  return x;
}

/** Minimal tensor class for the stub (same shape as ort.Tensor). */
export class StubTensor {
  constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
}

/**
 * Test stand-in for HT-Demucs with the same inputs/outputs as the hybrid export.
 * Splits the spectrogram into bands: bass < 300 Hz, "vocals" 300 Hz - 3 kHz, "drums" 3 - 12 kHz, other = rest,
 * and puts what the dropped edge frames lose into "other"'s time branch, so the 4 outputs sum to the input.
 */
export function createStubSession({ segment = SEGMENT } = {}) {
  const T = specFrames(segment);
  const hz = (bin) => bin * MODEL_RATE / NFFT;
  const band = (f) => { const h = hz(f); return h < 300 ? 1 : h < 3000 ? 3 : h < 12000 ? 0 : 2; }; // index into DEMUCS_SOURCES
  return {
    stub: true,
    inputNames: ['input', 'spec'],
    outputNames: ['output', 'time'],
    inputMetadata: [{ name: 'input', shape: [1, 2, segment] }, { name: 'spec', shape: [1, 4, BINS, T] }],
    async run(feeds) {
      const mix = feeds.input.data, z = feeds.spec.data, plane = BINS * T;
      const zx = new Float32Array(4 * 4 * plane);
      for (let ch = 0; ch < 4; ch++) for (let f = 0; f < BINS; f++) {
        const s = band(f), src = (ch * BINS + f) * T, dst = ((s * 4 + ch) * BINS + f) * T;
        zx.set(z.subarray(src, src + T), dst);
      }
      // time branch: residual of the spectral round trip goes to "other" (index 2)
      const recon = demucsISpec(z, 1, 2, segment);
      const xt = new Float32Array(4 * 2 * segment);
      for (let i = 0; i < 2 * segment; i++) xt[2 * 2 * segment + i] = mix[i] - recon[i];
      return { output: new StubTensor('float32', zx, [1, 4, 4, BINS, T]), time: new StubTensor('float32', xt, [1, 4, 2, segment]) };
    },
  };
}

