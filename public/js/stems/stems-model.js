// Turns an ONNX Runtime session into runChunk() for separateChunked().
// Supported graphs (detected from the session's inputs/outputs):
//  - "hybrid" HT-Demucs export with the STFT outside the graph (npm "demucs" / sevagh demucs.onnx style):
//      inputs  mix [1,2,N] + complex-as-channels spectrogram [1,4,2048,T]
//      outputs spectrogram masks/estimates [1,S,4,2048,T] + time branch [1,S,2,N]  -> ispec(spec) + time
//  - "waveform" exports with the STFT inside the graph (StemSplit demucs-onnx style): mix [1,2,N] -> [1,S,2,N]
// A deterministic stub session (frequency bands) stands in for the model in tests.
import { demucsSpec, demucsISpec, specFrames, BINS, NFFT, MODEL_RATE, DEMUCS_SOURCES } from './stem-dsp.js';

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
        const r = await session.run({ [mixName]: new Tensor('float32', mix, [1, C, segment]), [specName]: new Tensor('float32', spec, [1, C * 2, BINS, T]) });
        let zx = null, xt = null;
        for (const n of outs) { const t = r[n]; if (t.dims.length === 5) zx = t; else xt = t; }
        if (!zx || !xt) throw new Error('Unexpected model outputs');
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
      const r = await session.run({ [ins[0]]: new Tensor('float32', mix, [1, C, segment]) });
      const t = r[outs[0]];
      const out = new Float32Array(t.data);
      t.dispose?.();
      return out;
    },
  };
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

