// OpenDJ 3-band waveform (ODJW: 150 points/s, low/mid/high/peak 0..255) -> the waveform tags CDJs read.
//
//   PWAV  400 columns, byte = whiteness(3 bits) << 5 | height(5 bits)       (all players)
//   PWV2  100 columns, height in the low 4 bits                              (CDJ-900 class)
//   PWV3  150/s, same byte format as PWAV                                    (scrolling blue waveform)
//   PWV5  150/s, u16 = red(3) green(3) blue(3) height(5) 00                  (nxs2 colour scroll; low=red, mid=green, high=blue)
//   PWV4  1200 columns × 6 bytes [d0, d1, energy bottom half, low, mid, high] (nxs2 colour preview)
//   PWV7  150/s × 3 bytes [mid, high, low]                                   (CDJ-3000 3-band scroll)
//   PWV6  1200 columns × 3 bytes [mid, high, low]                            (CDJ-3000 3-band preview)
// Value ranges follow what rekordbox writes (e.g. PWAV heights reach ~24, PWV4 bands stay below 128).

const RATE = 150;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Resample a waveform (any rate) to `n` points at 150/s by taking the max of the covered source points. */
function resample(w, n) {
  const src = w.peak.length;
  if (w.rate === RATE && src === n) return w;
  const out = { rate: RATE, low: new Uint8Array(n), mid: new Uint8Array(n), high: new Uint8Array(n), peak: new Uint8Array(n) };
  const ratio = w.rate / RATE;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    for (let j = a; j < b && j < src; j++) {
      if (w.low[j] > out.low[i]) out.low[i] = w.low[j];
      if (w.mid[j] > out.mid[i]) out.mid[i] = w.mid[j];
      if (w.high[j] > out.high[i]) out.high[i] = w.high[j];
      if (w.peak[j] > out.peak[i]) out.peak[i] = w.peak[j];
    }
  }
  return out;
}

const whiteness = (lo, mi, hi) => { const s = lo + mi + hi; return s ? clamp(Math.round((8 * hi) / s), 0, 7) : 0; };

/** Column ranges for fixed-width previews. */
function columns(n, cols, fn) {
  const out = [];
  for (let c = 0; c < cols; c++) {
    const a = Math.floor((c * n) / cols), b = Math.max(a + 1, Math.floor(((c + 1) * n) / cols));
    out.push(n ? fn(a, Math.min(b, n)) : fn(0, 0));
  }
  return out;
}

/**
 * @param {{rate:number, low:Uint8Array, mid:Uint8Array, high:Uint8Array, peak:Uint8Array}|null} wave
 * @param {number} duration seconds
 */
export function cdjWaveforms(wave, duration) {
  const n = Math.max(0, Math.round((Number(duration) || (wave ? wave.peak.length / wave.rate : 0)) * RATE));
  const w = wave ? resample(wave, n) : { low: new Uint8Array(n), mid: new Uint8Array(n), high: new Uint8Array(n), peak: new Uint8Array(n) };
  const { low, mid, high, peak } = w;

  const scroll = new Uint8Array(n);
  const colorScroll = new Uint16Array(n);
  const threeBandScroll = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const lo = low[i], mi = mid[i], hi = high[i];
    const h = Math.round((peak[i] * 31) / 255);
    scroll[i] = (whiteness(lo, mi, hi) << 5) | h;
    const m = Math.max(lo, mi, hi, 1);
    const r = Math.round((7 * lo) / m), g = Math.round((7 * mi) / m), b = Math.round((7 * hi) / m);
    colorScroll[i] = (r << 13) | (g << 10) | (b << 7) | (h << 2);
    threeBandScroll[i * 3] = mi >> 1; threeBandScroll[i * 3 + 1] = hi >> 1; threeBandScroll[i * 3 + 2] = lo >> 1;
  }

  const stats = (a, b) => {
    let pk = 0, lo = 0, mi = 0, hi = 0, sl = 0, sm = 0, sh = 0;
    for (let i = a; i < b; i++) {
      if (peak[i] > pk) pk = peak[i];
      if (low[i] > lo) lo = low[i];
      if (mid[i] > mi) mi = mid[i];
      if (high[i] > hi) hi = high[i];
      sl += low[i]; sm += mid[i]; sh += high[i];
    }
    return { pk, lo, mi, hi, white: whiteness(sl, sm, sh) };
  };
  const preview = Uint8Array.from(columns(n, 400, (a, b) => { const s = stats(a, b); return (s.white << 5) | Math.round((s.pk * 24) / 255); }));
  const tiny = Uint8Array.from(columns(n, 100, (a, b) => Math.round((stats(a, b).pk * 15) / 255)));
  const colorPreview = new Uint8Array(1200 * 6);
  const threeBandPreview = new Uint8Array(1200 * 3);
  columns(n, 1200, (a, b) => stats(a, b)).forEach((s, c) => {
    const d0 = Math.round((s.pk * 121) / 255);
    colorPreview.set([d0, clamp(Math.round(255 - d0 * 0.8), 128, 255), Math.round((Math.max(s.lo, s.mi) * 120) / 255),
      Math.round((s.lo * 110) / 255), Math.round((s.mi * 90) / 255), Math.round((s.hi * 60) / 255)], c * 6);
    threeBandPreview.set([Math.round((s.mi * 43) / 255), Math.round((s.hi * 43) / 255), Math.round((s.lo * 43) / 255)], c * 3);
  });
  // PWVC (2EX) holds three per-track scale values whose meaning is not documented; derived from band maxima.
  let mMid = 0, mHigh = 0, mLow = 0;
  for (let i = 0; i < n; i++) { if (mid[i] > mMid) mMid = mid[i]; if (high[i] > mHigh) mHigh = high[i]; if (low[i] > mLow) mLow = low[i]; }
  const threeBandScale = [Math.round(mMid * 0.6), Math.round(mHigh * 1.0), Math.round(mLow * 2.0)];

  return { preview, tiny, scroll, colorScroll, colorPreview, threeBandScroll, threeBandPreview, threeBandScale, points: n };
}
