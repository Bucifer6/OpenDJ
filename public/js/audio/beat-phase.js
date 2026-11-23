// Audible beat phase between two decks, measured from the music itself rather than from the beat grids.
//
// A beat grid can be a few milliseconds off (the downbeat is placed to about one analysis hop) or very slightly
// off tempo (a BPM within 0.06 of a whole number is rounded to it), so two decks can look in phase on paper while
// their kicks flam. A DJ listens instead: here each deck keeps a fine kick-onset curve of its track (low band energy
// rises every ONSET_HOP samples, built when the track loads), and during a blend the last few beats of the two curves
// are cross-correlated at the positions actually playing. The peak is the audible offset, to well under a
// millisecond with parabolic interpolation. Pure functions (no DOM, no audio graph): used by the deck and by tests.

/** Samples per onset point: 64 (1.45 ms at 44.1 kHz). */
export const ONSET_HOP = 64;

const onePole = (fc, sr) => 1 - Math.exp(-2 * Math.PI * fc / sr);

/**
 * Kick onset curve of a track: half-wave rectified rise of the low band (< ~150 Hz) energy, one value per ONSET_HOP
 * samples. Built in slices of `slice` points (128 k samples: a few ms) with `yieldFn` awaited between them, so a long track never blocks the
 * page for more than a few milliseconds. Returns { rate, env } (rate: points per second of track time).
 */
export async function onsetCurve(left, right, sampleRate, { hop = ONSET_HOP, slice = 2000, yieldFn = () => new Promise((r) => setTimeout(r, 0)) } = {}) {
  const n = Math.floor(left.length / hop);
  const env = new Float32Array(n);
  const a = onePole(150, sampleRate), b = onePole(40, sampleRate);
  // energy follower (2-pole at 40 Hz): smooths the ripple a sustained bass note or pad leaves in the energy, which
  // would otherwise look like tiny onsets at the note's frequency; the same filter on both decks adds no offset
  let lp1 = 0, lp2 = 0, e1 = 0, e2 = 0, prev = 0;
  for (let k0 = 0; k0 < n; k0 += slice) {
    const k1 = Math.min(n, k0 + slice);
    for (let k = k0; k < k1; k++) {
      for (let i = k * hop, end = i + hop; i < end; i++) {
        const x = right ? (left[i] + right[i]) * 0.5 : left[i];
        lp1 += a * (x - lp1); lp2 += a * (lp1 - lp2); // 2-pole low-pass: the kick and the bass
        e1 += b * (lp2 * lp2 - e1); e2 += b * (e1 - e2);
      }
      const v = Math.log1p(1000 * e2);
      env[k] = v > prev ? v - prev : 0; // only rises: where a kick starts
      prev = v;
    }
    if (k1 < n) await yieldFn();
  }
  return { rate: sampleRate / hop, env };
}

/** Value of an onset curve at track time t (linear interpolation; 0 outside the track). */
function at(curve, t) {
  const x = t * curve.rate, i = Math.floor(x);
  if (i < 0 || i + 1 >= curve.env.length) return 0;
  const f = x - i;
  return curve.env[i] * (1 - f) + curve.env[i + 1] * f;
}

/**
 * How far the incoming deck's audible beats lag behind the outgoing deck's, in seconds of audio time (negative:
 * ahead), from their onset curves over the last `window` seconds of the outgoing track.
 * out / inn: { curve, pos (track seconds now), rate (playback rate) }. maxLag: search range in seconds (keep it
 * under half a beat so the search cannot jump a beat). Returns { offset, confidence } or null without usable onsets.
 */
export function audibleOffset(out, inn, { window = 2, maxLag = 0.06, step = 0.0005 } = {}) {
  if (!out?.curve?.env?.length || !inn?.curve?.env?.length || !(out.rate > 0) || !(inn.rate > 0)) return null;
  const dt = 1 / out.curve.rate;        // one point of the outgoing curve, in outgoing track seconds
  const n = Math.floor(window / dt);
  if (n < 32 || out.pos - n * dt < 0) return null;
  // audio time τ before now (τ >= 0): outgoing at pos - τ·rateOut, incoming at pos - τ·rateIn
  const xs = new Float32Array(n);
  let sx = 0, sxx = 0;
  for (let j = 0; j < n; j++) { const v = at(out.curve, out.pos - j * dt); xs[j] = v; sx += v; sxx += v * v; }
  // too few / too weak onsets (a pad, a breakdown, silence): nothing to lock to. A 4/4 kick averages 0.006 (quiet)
  // to 0.018 (loud) per point, a sustained pad's leftover ripple ~0.0016.
  if (sx / n < MIN_ONSET) return null;
  const tau = (j) => j * dt / out.rate;
  const lags = [];
  let best = -Infinity, bestI = -1;
  for (let L = -maxLag, i = 0; L <= maxLag + 1e-12; L += step, i++) {
    // incoming lagging by L: its sound at audio time T was written for track time (T - L)
    let c = 0, syy = 0;
    for (let j = 0; j < n; j++) { const y = at(inn.curve, inn.pos - (tau(j) + L) * inn.rate); c += xs[j] * y; syy += y * y; }
    const v = syy > 1e-9 ? c / Math.sqrt(sxx * syy) : 0;
    lags.push(v);
    if (v > best) { best = v; bestI = i; }
  }
  if (bestI < 0 || best <= 0) return null;
  let sy = 0; // the incoming side needs onsets too, where it matched
  for (let j = 0; j < n; j++) sy += at(inn.curve, inn.pos - (tau(j) + (-maxLag + bestI * step)) * inn.rate);
  if (sy / n < MIN_ONSET) return null;
  // parabolic interpolation around the peak
  let frac = 0;
  if (bestI > 0 && bestI < lags.length - 1) {
    const a = lags[bestI - 1], b = lags[bestI], c = lags[bestI + 1], d = a - 2 * b + c;
    if (d < 0) frac = 0.5 * (a - c) / d;
  }
  // the best lag L matched the incoming deck's sound at T - L with the outgoing deck's at T: a lag of d seconds
  // behind shows up as L = -d
  const offset = -(-maxLag + (bestI + frac) * step);
  const mean = lags.reduce((s, v) => s + v, 0) / lags.length;
  // confidence: how far the peak stands above the average lag (a clean kick pattern: ~0.5+; pads / no drums: ~0)
  return { offset, confidence: Math.max(0, best - mean), peak: best };
}

/** Mean onset strength per point below which a curve has no kicks to lock to (see audibleOffset). */
export const MIN_ONSET = 0.004;
/** Below this confidence the audible measurement is not trusted (no clear kicks): the beat grids are used. */
export const MIN_CONFIDENCE = 0.35; // clean kicks score 0.5 and more; soft or busy ones ~0.2 and jump around
