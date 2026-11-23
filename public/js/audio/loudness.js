// ITU-R BS.1770-4 / EBU R128 loudness measurement: K-weighting (pre-filter high shelf + RLB high-pass, biquad
// coefficients derived for any sample rate, as libebur128), momentary (400 ms), short-term (3 s), gated integrated
// loudness (-70 LUFS absolute gate, -10 LU relative gate, 400 ms blocks with 75 % overlap) and per-section loudness.
// Pure functions (no Web Audio): used by the analysis worker, the sampler's mastering and Node unit tests.
//
// One pass: every channel is K-weighted once and reduced to the energy of 100 ms sub-blocks (`loudnessProfile`).
// Everything else (blocks, windows, sections, gating) is computed from those sub-block energies, so measuring a
// 7-minute track costs one biquad pair per sample and a few thousand additions afterwards.
//
// Channel convention (BS.1770: the K-weighted mean squares of the channels are summed with weight 1.0 for L / R):
//  - an ARRAY of channels is measured as given: [mono] is "mono in one channel" (a full-scale 997 Hz sine measures
//    -3.01 LUFS), [left, right] is a stereo pair (the same sine on both channels measures 0.0 LUFS);
//  - a bare Float32Array is a mono mix-down that is PLAYED on both speakers (the analysis worker gets (L + R) / 2):
//    it is measured as dual mono, i.e. like [x, x] (+3.01 dB vs [x]). For correlated (centre) material this equals
//    the loudness of the original stereo file; for fully uncorrelated stereo it reads up to 3 dB low.

export const LOUDNESS_TARGET = -14; // LUFS: track trim target (streaming-platform level, leaves headroom for the mix)
export const ABS_GATE = -70; // LUFS
export const REL_GATE = -10; // LU below the absolute-gated mean
const SUB = 0.1; // s: sub-block (hop) length; a 400 ms block is 4 sub-blocks, a 3 s short-term window 30

/** BS.1770 K-weighting biquads for sample rate fs: [preFilter (high shelf ≈ +4 dB), RLB high-pass (≈ 38 Hz)], each {b:[b0,b1,b2], a:[a1,a2]}. */
export function kWeightingCoefs(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416, a0 = 1 + K / Q + K * K;
  const pre = { b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0], a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / fs);
  const d = 1 + K / Q + K * K;
  const rlb = { b: [1, -2, 1], a: [2 * (K * K - 1) / d, (1 - K / Q + K * K) / d] };
  return [pre, rlb];
}

/** Mean-square energy (block "z") to LUFS. */
export const energyToLufs = (z) => (z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity);

function channelsOf(input) {
  if (ArrayBuffer.isView(input)) return { chans: [input], weight: 2 }; // dual mono, see the header
  if (Array.isArray(input) && input.length && input.every((c) => ArrayBuffer.isView(c))) return { chans: input, weight: 1 };
  throw new TypeError('loudness: expected a Float32Array or an array of channel arrays');
}

/**
 * The one pass over the audio: K-weighted energy of every 100 ms sub-block, summed over channels.
 * @param {Float32Array|Float32Array[]} input  mono mix (measured as dual mono) or an array of channels
 * @param {number} sampleRate
 * @returns {{ sub: Float64Array, hop: number, sampleRate: number, length: number, frames: number }}
 *   sub[i] = Σ channel weight · Σ y² over sub-block i (NOT yet divided by its length); hop = samples per sub-block.
 *   Material shorter than one 400 ms block becomes a single sub-block (measured as one block, like the sampler did).
 */
export function loudnessProfile(input, sampleRate) {
  const { chans, weight } = channelsOf(input);
  const n = chans[0].length;
  const blk = Math.round(0.4 * sampleRate);
  const hop = n < blk ? Math.max(1, n) : Math.max(1, Math.round(SUB * sampleRate));
  const ns = Math.floor(n / hop);
  const sub = new Float64Array(ns);
  const [p, r] = kWeightingCoefs(sampleRate);
  const pb0 = p.b[0], pb1 = p.b[1], pb2 = p.b[2], pa1 = p.a[0], pa2 = p.a[1];
  const ra1 = r.a[0], ra2 = r.a[1];
  for (const c of chans) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, w1 = 0, w2 = 0; // pre-filter state, RLB state (input = pre output)
    for (let s = 0, i = 0; s < ns; s++) {
      let acc = 0;
      for (const e = i + hop; i < e; i++) {
        const x = c[i];
        const y = pb0 * x + pb1 * x1 + pb2 * x2 - pa1 * y1 - pa2 * y2;
        x2 = x1; x1 = x;
        const w = y - 2 * y1 + y2 - ra1 * w1 - ra2 * w2; // RLB: b = [1, -2, 1]
        y2 = y1; y1 = y; w2 = w1; w1 = w;
        acc += w * w;
      }
      sub[s] += weight * acc;
    }
  }
  return { sub, hop, sampleRate, length: n, frames: ns };
}

const asProfile = (x, sr) => (x && x.sub instanceof Float64Array ? x : loudnessProfile(x, sr));

/** Mean-square energy of the windows of `len` sub-blocks starting at every sub-block (step 100 ms). */
function windowEnergies(prof, len) {
  const { sub, hop } = prof;
  const L = Math.min(len, sub.length);
  const n = Math.max(0, sub.length - L + 1);
  const out = new Float64Array(n);
  let s = 0;
  for (let i = 0; i < L; i++) s += sub[i];
  for (let i = 0; i < n; i++) {
    out[i] = s / (L * hop);
    if (i + L < sub.length) s += sub[i + L] - sub[i];
  }
  return out;
}

/** Energies of the 400 ms gating blocks (75 % overlap) in sub-block range [i0, i1). Short ranges: one block of what there is. */
function blocksIn(prof, i0, i1) {
  const { sub, hop } = prof;
  i0 = Math.max(0, i0); i1 = Math.min(sub.length, i1);
  if (i1 <= i0) return [];
  const B = prof.length < Math.round(0.4 * prof.sampleRate) ? 1 : 4;
  if (i1 - i0 < B) { let s = 0; for (let i = i0; i < i1; i++) s += sub[i]; return [s / ((i1 - i0) * hop)]; }
  const out = [];
  let s = 0;
  for (let i = i0; i < i0 + B; i++) s += sub[i];
  for (let i = i0; i + B <= i1; i++) {
    out.push(s / (B * hop));
    if (i + B < i1) s += sub[i + B] - sub[i];
  }
  return out;
}

/** BS.1770 two-stage gated mean of block energies, in LUFS (-Infinity when every block is below -70 LUFS). */
export function gatedLoudness(blocks) {
  const absZ = 10 ** ((ABS_GATE + 0.691) / 10);
  let s = 0, n = 0;
  for (const z of blocks) if (z > absZ) { s += z; n++; }
  if (!n) return -Infinity;
  const relZ = (s / n) * 10 ** (REL_GATE / 10);
  let s2 = 0, n2 = 0;
  for (const z of blocks) if (z > absZ && z > relZ) { s2 += z; n2++; }
  return energyToLufs(s2 / n2);
}

/**
 * Integrated loudness (LUFS) of a whole signal. Material shorter than one 400 ms block is measured as one block.
 * @param {Float32Array|Float32Array[]|object} input  channels, a mono mix (dual mono) or a loudnessProfile()
 * @returns {number} LUFS, -Infinity for silence
 */
export function integratedLoudness(input, sampleRate) {
  const prof = asProfile(input, sampleRate);
  return gatedLoudness(blocksIn(prof, 0, prof.frames));
}

/** Momentary loudness (400 ms window) every 100 ms, LUFS. Entry i covers [i·0.1 s, i·0.1 s + 0.4 s). */
export function momentaryLoudness(input, sampleRate) {
  return Float32Array.from(windowEnergies(asProfile(input, sampleRate), 4), energyToLufs);
}

/** Short-term loudness (3 s window) every 100 ms, LUFS. Entry i covers [i·0.1 s, i·0.1 s + 3 s). */
export function shortTermLoudness(input, sampleRate) {
  return Float32Array.from(windowEnergies(asProfile(input, sampleRate), 30), energyToLufs);
}

/** Sub-block index range fully inside [start, end) seconds (at least one sub-block when the range touches audio). */
function range(prof, start, end) {
  const sec = prof.hop / prof.sampleRate;
  let i0 = Math.ceil(Math.max(0, start) / sec - 1e-6), i1 = Math.floor(end / sec + 1e-6);
  if (i1 <= i0) { i0 = Math.floor(Math.max(0, start) / sec); i1 = i0 + 1; }
  return [Math.min(prof.frames, i0), Math.min(prof.frames, i1)];
}

/**
 * Loudness of each section: the gated (-70 LUFS absolute, -10 LU relative) mean of the 400 ms blocks (100 ms step)
 * that lie inside [start, end) — a short-term-style reading of the section, independent of the rest of the track.
 * @param {Float32Array|Float32Array[]|object} input  channels, mono mix (dual mono) or loudnessProfile()
 * @param {number} sampleRate
 * @param {{start:number,end:number}[]} sections  seconds
 * @returns {(number|null)[]} LUFS per section; null for an empty / out-of-range section, -Infinity for silence
 */
export function sectionLoudness(input, sampleRate, sections) {
  const prof = asProfile(input, sampleRate);
  return sections.map((s) => {
    if (!s || !(s.end > s.start) || s.start * prof.sampleRate >= prof.length) return null;
    const [i0, i1] = range(prof, s.start, s.end);
    return i1 > i0 ? gatedLoudness(blocksIn(prof, i0, i1)) : null;
  });
}

/**
 * The loudest window of `seconds` (gated loudness of the blocks inside it), scanned in 1 s steps.
 * @returns {{ start:number, end:number, lufs:number } | null}
 */
export function loudestWindow(input, sampleRate, seconds = 30) {
  const prof = asProfile(input, sampleRate);
  const sec = prof.hop / prof.sampleRate;
  const W = Math.max(1, Math.round(seconds / sec)), step = Math.max(1, Math.round(1 / sec));
  if (!prof.frames) return null;
  let best = null;
  for (let i = 0; ; i += step) {
    const i1 = Math.min(prof.frames, i + W);
    const lufs = gatedLoudness(blocksIn(prof, i, i1));
    if (Number.isFinite(lufs) && (!best || lufs > best.lufs)) best = { start: i * sec, end: i1 * sec, lufs };
    if (i1 >= prof.frames) break;
  }
  return best;
}
