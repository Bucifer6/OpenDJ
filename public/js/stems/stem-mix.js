// Multi-stem mixing for the deck worklet (pure functions; imported by audio/worklets.js and by tests).
//
// The deck keeps the ORIGINAL track (Float32) plus three AI stems (vocals, drums, bass) as Int16. The fourth
// stem, "other", is the residual: other = original - vocals - drums - bass. So with every stem at full level the
// deck plays the original bit for bit, and any model error ends up in "other" instead of being lost:
//   out = gV*V + gD*D + gB*B + gO*(O - V - D - B) = gO*O + (gV-gO)*V + (gD-gO)*D + (gB-gO)*B
// Only terms with a non-zero coefficient are read, so "instrumental" (O - V) or "acapella" (V) cost one stem.

export const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];
export const LOADED_STEMS = 3; // vocals, drums, bass; "other" is derived
const I16 = 1 / 32767;

/** Stem gains [v, d, b, o] -> coefficients [orig, v, d, b] for the residual formula. */
export function stemCoefficients(g, out = new Float32Array(4)) {
  const o = g[3];
  out[0] = o; out[1] = g[0] - o; out[2] = g[1] - o; out[3] = g[2] - o;
  return out;
}

/** True when the gains are exactly "everything on" (the deck then uses its plain original-only path). */
export const isUnity = (g) => g[0] === 1 && g[1] === 1 && g[2] === 1 && g[3] === 1;
export const isSilent = (g) => g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0;

/**
 * One-pole smoothing of current gains towards targets (per sample; k = 1 - exp(-1/(tau*sr))).
 * Snaps when close so the unity/zero fast paths kick in again. Returns true when any gain changed.
 */
export function smoothGains(cur, target, k) {
  let changed = false;
  for (let i = 0; i < cur.length; i++) {
    const d = target[i] - cur[i];
    if (d === 0) continue;
    cur[i] = Math.abs(d) < 1e-4 ? target[i] : cur[i] + d * k;
    changed = true;
  }
  return changed;
}

/**
 * Hermite-interpolated stereo read of the stem mix at fractional frame x.
 * L/R: original Float32 channels; stems: [{ L: Int16Array, R: Int16Array }] (vocals, drums, bass);
 * coef: from stemCoefficients(); out: [l, r] written in place. Matches the deck's 4-point Hermite exactly
 * for the original (coef [1,0,0,0]).
 */
export function readStemMix(L, R, stems, coef, x, len, out) {
  const i = Math.floor(x);
  let l = 0, r = 0;
  if (i < 1 || i + 2 >= len) { // edges: nearest sample, like DeckProcessor.sample()
    if (i >= 0 && i < len) {
      l = coef[0] * L[i]; r = coef[0] * R[i];
      for (let s = 0; s < stems.length; s++) { const c = coef[s + 1]; if (c !== 0) { l += c * stems[s].L[i] * I16; r += c * stems[s].R[i] * I16; } }
    }
    out[0] = l; out[1] = r; return out;
  }
  const f = x - i, f2 = f * f, f3 = f2 * f;
  const w0 = -0.5 * f3 + f2 - 0.5 * f, w1 = 1.5 * f3 - 2.5 * f2 + 1, w2 = -1.5 * f3 + 2 * f2 + 0.5 * f, w3 = 0.5 * f3 - 0.5 * f2;
  const c0 = coef[0];
  if (c0 !== 0) {
    l = c0 * (w0 * L[i - 1] + w1 * L[i] + w2 * L[i + 1] + w3 * L[i + 2]);
    r = c0 * (w0 * R[i - 1] + w1 * R[i] + w2 * R[i + 1] + w3 * R[i + 2]);
  }
  for (let s = 0; s < stems.length; s++) {
    const c = coef[s + 1];
    if (c === 0) continue;
    const sl = stems[s].L, sr = stems[s].R, k = c * I16;
    l += k * (w0 * sl[i - 1] + w1 * sl[i] + w2 * sl[i + 1] + w3 * sl[i + 2]);
    r += k * (w0 * sr[i - 1] + w1 * sr[i] + w2 * sr[i + 1] + w3 * sr[i + 2]);
  }
  out[0] = l; out[1] = r;
  return out;
}

/**
 * Effective per-stem gains from the deck controls:
 * levels/mute per stem, then the channel's VOC knob scales vocals and INST scales drums, bass and other.
 */
export function effectiveGains({ levels, mute }, vocalMacro = 1, instMacro = 1, out = new Float32Array(4)) {
  for (let i = 0; i < 4; i++) out[i] = (mute[i] ? 0 : levels[i]) * (i === 0 ? vocalMacro : instMacro);
  return out;
}

/** Bytes a deck needs for a track of `frames` frames at the context rate: Float32 original + 3 Int16 stereo stems. */
export const deckStemBytes = (frames) => frames * 2 * 4 + LOADED_STEMS * frames * 2 * 2;
