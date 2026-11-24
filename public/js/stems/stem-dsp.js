// Pure DSP for AI stem separation (no DOM, no ORT): runs in the stems worker and in Node tests.
//  - FFT / Demucs-compatible STFT (spec) and inverse STFT (ispec), matching torch.stft/istft as used by HT-Demucs
//  - chunk planning + streaming overlap-add (finished audio leaves the worker block by block, so a long track
//    never needs 4 full-length float stems in memory)
//  - Int16 helpers

export const MODEL_RATE = 44100;
/** Stem order used everywhere in OpenDJ (UI, files, deck worklet). */
export const STEMS = ['vocals', 'drums', 'bass', 'other'];
/** HT-Demucs output order. */
export const DEMUCS_SOURCES = ['drums', 'bass', 'other', 'vocals'];

// ---------------------------------------------------------------- FFT
const plans = new Map();
/** Radix-2 complex FFT plan (in place on Float64Array re/im). */
export function fftPlan(n) {
  if (plans.has(n)) return plans.get(n);
  if (n & (n - 1)) throw new Error('FFT size must be a power of 2');
  const rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  const plan = {
    n,
    /** Forward transform (inverse = conjugate trick, done by the caller). */
    fft(re, im) {
      for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = i + j, b = a + half, wr = cos[k], wi = sin[k];
            const tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          }
        }
      }
    },
  };
  plans.set(n, plan);
  return plan;
}

const hannCache = new Map();
/** Periodic Hann window (torch.hann_window default). */
export function hann(n) {
  if (!hannCache.has(n)) { const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / n)); hannCache.set(n, w); }
  return hannCache.get(n);
}

/** Reflect index into [0, n) (torch 'reflect' padding, edge sample not repeated). */
function reflect(i, n) {
  if (n === 1) return 0;
  const p = 2 * (n - 1);
  i = ((i % p) + p) % p;
  return i < n ? i : p - i;
}

// ---------------------------------------------------------------- HT-Demucs spectrogram
// HTDemucs._spec: hop 1024, nfft 4096, input reflect-padded by 3*hop/2 (+ up to a multiple of hop),
// torch.stft(center=True, reflect, normalized=True), last bin dropped, frames 2..2+le kept.
export const HOP = 1024, NFFT = 4096, BINS = 2048;
export const specFrames = (length) => Math.ceil(length / HOP);

/**
 * Complex-as-channels spectrogram of a planar multichannel signal.
 * @param {Float32Array} mix planar [C][length]
 * @returns {Float32Array} [C*2][BINS][le] (channel c real at 2c, imag at 2c+1)
 */
export function demucsSpec(mix, channels, length) {
  const le = specFrames(length), pad = (HOP / 2) * 3;
  const padLen = le * HOP + 2 * pad;          // after HTDemucs' own padding
  const out = new Float32Array(channels * 2 * BINS * le);
  const plan = fftPlan(NFFT), w = hann(NFFT), norm = 1 / Math.sqrt(NFFT);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  // padded signal of channel c: two reflect paddings (HTDemucs pad1d, then stft center padding)
  const padded = [];
  for (let c = 0; c < channels; c++) {
    const src = mix.subarray(c * length, (c + 1) * length);
    const p1 = new Float32Array(padLen);
    for (let i = 0; i < padLen; i++) p1[i] = src[reflect(i - pad, length)];
    const p2 = new Float32Array(padLen + NFFT);
    for (let i = 0; i < p2.length; i++) p2[i] = p1[reflect(i - NFFT / 2, padLen)];
    padded.push(p2);
  }
  for (let c = 0; c < channels; c += 2) {
    const a = padded[c], b = padded[c + 1]; // two real channels packed in one complex FFT
    for (let t = 0; t < le; t++) {
      const start = (t + 2) * HOP;
      for (let i = 0; i < NFFT; i++) { re[i] = a[start + i] * w[i] * norm; im[i] = b ? b[start + i] * w[i] * norm : 0; }
      plan.fft(re, im);
      for (let f = 0; f < BINS; f++) {
        const g = f === 0 ? 0 : NFFT - f;
        const zr = re[f], zi = im[f], cr = re[g], ci = -im[g]; // conj(Z[n-f])
        const base1 = ((c * 2) * BINS + f) * le + t, base1i = ((c * 2 + 1) * BINS + f) * le + t;
        out[base1] = (zr + cr) / 2; out[base1i] = (zi + ci) / 2;
        if (b) {
          const base2 = (((c + 1) * 2) * BINS + f) * le + t, base2i = (((c + 1) * 2 + 1) * BINS + f) * le + t;
          out[base2] = (zi - ci) / 2; out[base2i] = -(zr - cr) / 2;
        }
      }
    }
  }
  return out;
}

/**
 * Inverse of demucsSpec for S sources: complex-as-channels [S][C*2][BINS][le] -> planar [S][C][length].
 * Adds into `out` when given (HT-Demucs sums the time branch and the spectrogram branch).
 */
export function demucsISpec(z, sources, channels, length, out = new Float32Array(sources * channels * length)) {
  const le = specFrames(length), pad = (HOP / 2) * 3;
  const plan = fftPlan(NFFT), w = hann(NFFT), norm = Math.sqrt(NFFT);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  // window-square envelope (torch istft divides by it); constant 1.5 in the region we keep, computed anyway
  const off = pad + NFFT / 2 - 2 * HOP; // sample k of the output sits at offset k + off from data frame 0's start
  const env = new Float64Array(length);
  for (let t = -2; t < le + 2; t++) for (let i = 0; i < NFFT; i++) { const k = t * HOP + i - off; if (k >= 0 && k < length) env[k] += w[i] * w[i]; }
  const scale = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) scale[i] = w[i] * norm / NFFT; // ifft 1/n, normalized=True, synthesis window
  const plane = BINS * le;
  for (let s = 0; s < sources; s++) {
    for (let c = 0; c < channels; c += 2) {
      const two = c + 1 < channels;
      const rA = (s * channels * 2 + c * 2) * plane, iA = rA + plane;
      const rB = rA + 2 * plane, iB = rA + 3 * plane;
      const oA = (s * channels + c) * length, oB = oA + length;
      for (let t = 0; t < le; t++) {
        // Z = X1 + i*X2 over the full (Hermitian-extended) spectrum; DC/Nyquist imaginary parts dropped like irfft
        for (let f = 0; f < BINS; f++) {
          const x1r = z[rA + f * le + t], x1i = f === 0 ? 0 : z[iA + f * le + t];
          const x2r = two ? z[rB + f * le + t] : 0, x2i = two && f !== 0 ? z[iB + f * le + t] : 0;
          re[f] = x1r - x2i; im[f] = x1i + x2r;
          if (f) { re[NFFT - f] = x1r + x2i; im[NFFT - f] = -x1i + x2r; }
        }
        re[BINS] = 0; im[BINS] = 0; // Nyquist bin is zero-padded by HTDemucs._ispec
        // inverse FFT via conj(FFT(conj(Z)))
        for (let i = 0; i < NFFT; i++) im[i] = -im[i];
        plan.fft(re, im);
        const start = t * HOP - off;
        const i0 = Math.max(0, -start), i1 = Math.min(NFFT, length - start);
        for (let i = i0; i < i1; i++) {
          const k = start + i;
          out[oA + k] += re[i] * scale[i] / env[k];
          if (two) out[oB + k] += -im[i] * scale[i] / env[k];
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- chunking + overlap-add
/** Demucs-style triangular weight (normalised to max 1). */
export function transitionWeight(segment) {
  const w = new Float32Array(segment);
  const h = Math.floor(segment / 2);
  for (let i = 0; i <= h && i < segment; i++) w[i] = i + 1;
  for (let i = h + 1; i < segment; i++) w[i] = segment - i;
  let m = 0; for (const v of w) m = Math.max(m, v);
  for (let i = 0; i < segment; i++) w[i] /= m;
  return w;
}

/** Chunk offsets for a track: [{ offset, length }] with stride = (1 - overlap) * segment. */
export function planChunks(length, segment, overlap = 0.25) {
  const stride = Math.max(1, Math.floor((1 - overlap) * segment));
  const out = [];
  for (let offset = 0; offset < length; offset += stride) out.push({ offset, length: Math.min(segment, length - offset) });
  return { stride, chunks: out };
}

/**
 * Model input for one chunk (planar [C][segment]): short final chunks are centred with real audio
 * around them as context (demucs TensorChunk.padded), zeros outside the track.
 */
export function chunkInput(channelsData, length, offset, chunkLen, segment, out = new Float32Array(channelsData.length * segment)) {
  const start = offset - Math.floor((segment - chunkLen) / 2);
  out.fill(0);
  for (let c = 0; c < channelsData.length; c++) {
    const src = channelsData[c], base = c * segment;
    const a = Math.max(0, start), b = Math.min(length, start + segment);
    if (b > a) out.set(src.subarray(a, b), base + (a - start));
  }
  return out;
}

/** Streaming overlap-add: add chunks in order, take out the samples no later chunk can touch. */
export class StreamingOLA {
  constructor(sources, channels, length, segment, stride) {
    Object.assign(this, { sources, channels, length, segment, stride });
    this.weight = transitionWeight(segment);
    this.acc = new Float32Array(sources * channels * segment);
    this.wsum = new Float32Array(segment);
    this.base = 0; // track position of acc[0]
  }
  /**
   * @param {Float32Array} out model output, planar [S][C][segment] for the padded chunk input
   * @param {number} chunkLen valid samples of this chunk
   * @returns {{ frame: number, frames: number, data: Float32Array }} finished block, planar [S][C][frames]
   */
  add(out, chunkLen) {
    const { sources, channels, segment, weight, acc, wsum } = this;
    const trim = Math.floor((segment - chunkLen) / 2); // centre trim (matches chunkInput)
    for (let k = 0; k < sources * channels; k++) {
      const o = k * segment, a = k * segment + trim;
      for (let t = 0; t < chunkLen; t++) acc[o + t] += weight[t] * out[a + t];
    }
    for (let t = 0; t < chunkLen; t++) wsum[t] += weight[t];
    const last = this.base + this.stride >= this.length;
    const n = last ? this.length - this.base : this.stride;
    const data = new Float32Array(sources * channels * n);
    for (let k = 0; k < sources * channels; k++) {
      const o = k * segment, d = k * n;
      for (let t = 0; t < n; t++) data[d + t] = wsum[t] > 0 ? acc[o + t] / wsum[t] : 0;
    }
    const block = { frame: this.base, frames: n, data };
    // shift the window
    for (let k = 0; k < sources * channels; k++) { const o = k * segment; acc.copyWithin(o, o + n, o + segment); acc.fill(0, o + segment - n, o + segment); }
    wsum.copyWithin(0, n); wsum.fill(0, segment - n);
    this.base += n;
    return block;
  }
}

/**
 * How far one chunk's sources are from adding back up to its input: error energy / input energy (Infinity when the
 * output holds NaN / Infinity). HT-Demucs reconstructs the mix to within about 1 % of its energy; a GPU backend that
 * computes garbage (seen with DirectML: full-scale noise in every stem) is off by orders of magnitude.
 */
export function mixtureError(input, out, sources, channels, segment) {
  let err = 0, ref = 0;
  for (let c = 0; c < channels; c++) {
    const ib = c * segment;
    for (let t = 0; t < segment; t++) {
      let s = 0;
      for (let k = 0; k < sources; k++) s += out[(k * channels + c) * segment + t];
      const x = input[ib + t], d = s - x;
      err += d * d; ref += x * x;
    }
  }
  if (!Number.isFinite(err)) return Infinity;
  return err / (ref + 1e-6 * channels * segment); // the floor keeps near-silent chunks from failing on rounding noise
}
/** Chunks whose sources miss the input by more than this (error / input energy, about -6 dB) are rejected. */
export const MAX_MIXTURE_ERROR = 0.25;
/** Thrown by separateChunked when the model output is not a separation of the input (broken backend). */
export const badOutputError = (ratio) => Object.assign(new Error(`The stem model returned invalid audio (the stems do not add up to the track: error ${Number.isFinite(ratio) ? ratio.toFixed(2) : 'NaN'})`), { code: 'BAD_STEM_OUTPUT' });

/**
 * How far one backend's stems are from another's for the same chunk: error energy / reference energy, summed over
 * every source (Infinity for NaN / Infinity). mixtureError cannot see audio moved between the sources (a GPU that
 * mixes up the output layout returns noise in every stem that still adds up to the track exactly), so a GPU's
 * output is compared once with the CPU's (see verifiedRunChunk in stems-model.js).
 */
export function stemsDifference(out, ref) {
  let err = 0, energy = 0;
  for (let i = 0; i < ref.length; i++) { const d = out[i] - ref[i]; err += d * d; energy += ref[i] * ref[i]; }
  if (!Number.isFinite(err)) return Infinity;
  return err / (energy + 1e-6 * ref.length);
}
/** A GPU whose stems differ from the CPU's by more than this (about -13 dB) is not used. fp32 / TF32 rounding is far below. */
export const MAX_BACKEND_DIFFERENCE = 0.05;
/** Mean square of a chunk (to skip silent intros when choosing the chunk a GPU is checked on). */
export function meanSquare(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return s / (x.length || 1); }
/** Thrown when a GPU's stems do not match the CPU's for the same audio. */
export const backendMismatchError = (backend, diff) => Object.assign(new Error(`The ${backend} backend returned different stems from the CPU (difference ${Number.isFinite(diff) ? diff.toFixed(2) : 'NaN'})`), { code: 'BAD_STEM_OUTPUT', mismatch: true });

/**
 * Separate a whole track chunk by chunk.
 * runChunk(planar Float32Array [C][segment]) -> Promise<Float32Array> planar [S][C][segment]
 * onBlock({ frame, frames, data }) receives finished audio in order (planar [S][C][frames]).
 * Every chunk is checked (mixtureError) before it is used: invalid output throws badOutputError, so the caller
 * can redo the track on another backend instead of writing noise.
 */
export async function separateChunked({ channels, length, segment, overlap = 0.25, sources, runChunk, onBlock, onProgress, shouldStop }) {
  const C = channels.length;
  const { stride, chunks } = planChunks(length, segment, overlap);
  const ola = new StreamingOLA(sources, C, length, segment, stride);
  const input = new Float32Array(C * segment);
  onProgress?.(0, chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    if (shouldStop?.()) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    const { offset, length: n } = chunks[i];
    chunkInput(channels, length, offset, n, segment, input);
    const out = await runChunk(input);
    const bad = mixtureError(input, out, sources, C, segment);
    if (!(bad <= MAX_MIXTURE_ERROR)) throw badOutputError(bad);
    const block = ola.add(out, n);
    await onBlock?.(block);
    onProgress?.(i + 1, chunks.length);
  }
  return { chunks: chunks.length, stride };
}

// ---------------------------------------------------------------- Int16 helpers
/** Planar float [C][n] of one source -> interleaved Int16 [n][C] (rounded, clipped). */
export function interleaveInt16(planar, channels, n, offset = 0, out = new Int16Array(n * channels)) {
  for (let c = 0; c < channels; c++) {
    const base = offset + c * n;
    for (let i = 0; i < n; i++) {
      let v = planar[base + i] * 32767;
      v = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      out[i * channels + c] = Math.round(v);
    }
  }
  return out;
}

/** Float32 -> Int16 (rounded, clipped), for the deck worklet's compact stem buffers. */
export function floatToInt16(src, out = new Int16Array(src.length), scale = 1) {
  const g = 32767 / (scale > 1 ? scale : 1); // scale: peak-normalisation of the deck audio (see audio/deck.js)
  for (let i = 0; i < src.length; i++) {
    let v = src[i] * g;
    v = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    out[i] = Math.round(v);
  }
  return out;
}

/**
 * A pause switch for chunked work: gate(fn) wraps fn so each call first waits while the switch is on; set(false)
 * lets every waiting call go on. The stems worker uses it to hold background separation between chunks.
 */
export function makeHold() {
  let held = false;
  const waiting = [];
  return {
    get held() { return held; },
    set(on) { held = !!on; if (!held) waiting.splice(0).forEach((r) => r()); },
    gate: (fn) => async (...a) => { while (held) await new Promise((r) => waiting.push(r)); return fn(...a); },
  };
}
