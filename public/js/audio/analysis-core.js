// Track analysis: 3-band waveform, BPM + beatgrid, musical key (Camelot) + confidence, BS.1770 loudness (integrated,
// main section, per phrase) and track trim, silence trimming, phrases on an 8-bar phrase grid.
// Pure functions: used by the Web Worker in the app and by Node unit tests.

import { LOUDNESS_TARGET, loudnessProfile, integratedLoudness, sectionLoudness, loudestWindow } from './loudness.js';
import { detectVocalActivity, computeBarFeatures, computeGrooveAndEmbedding, detectElasticGrid } from './features.js';

export const WAVE_RATE = 150; // waveform points per second

const onePoleCoef = (fc, sr) => 1 - Math.exp(-2 * Math.PI * fc / sr);

/** Coloured waveform data: per point peak of low / mid / high bands and overall peak, 0..255 */
export function computeWaveform(mono, sr, rate = WAVE_RATE) {
  const hop = sr / rate;
  const n = Math.ceil(mono.length / hop);
  const low = new Float32Array(n), mid = new Float32Array(n), high = new Float32Array(n), peak = new Float32Array(n);
  const aL = onePoleCoef(220, sr), aM = onePoleCoef(2600, sr);
  let lp1 = 0, lp1b = 0, lp2 = 0, lp2b = 0;
  for (let i = 0, k = 0, next = hop; i < mono.length; i++) {
    const x = mono[i];
    lp1 += aL * (x - lp1); lp1b += aL * (lp1 - lp1b);      // 2-pole low
    lp2 += aM * (x - lp2); lp2b += aM * (lp2 - lp2b);
    const lo = Math.abs(lp1b), mi = Math.abs(lp2b - lp1b), hi = Math.abs(x - lp2b), pk = Math.abs(x);
    if (lo > low[k]) low[k] = lo;
    if (mi > mid[k]) mid[k] = mi;
    if (hi > high[k]) high[k] = hi;
    if (pk > peak[k]) peak[k] = pk;
    if (i >= next) { k++; next += hop; if (k >= n) break; }
  }
  const norm = (a) => {
    let mx = 1e-9; for (const v of a) if (v > mx) mx = v;
    const out = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) out[i] = Math.min(255, Math.round(a[i] / mx * 255));
    return out;
  };
  return { rate, low: norm(low), mid: norm(mid), high: norm(high), peak: norm(peak) };
}

/** Onset-strength envelope (log energy flux of low and full band). */
function onsetEnvelope(mono, sr, hop) {
  const n = Math.floor(mono.length / hop);
  const env = new Float32Array(n);
  const a = onePoleCoef(150, sr);
  let lp = 0, prevLo = 0, prevAll = 0;
  for (let k = 0; k < n; k++) {
    let eLo = 0, eAll = 0;
    for (let i = k * hop, e = i + hop; i < e; i++) {
      const x = mono[i]; lp += a * (x - lp);
      eLo += lp * lp; eAll += x * x;
    }
    const lLo = Math.log1p(eLo * 1000), lAll = Math.log1p(eAll * 100);
    env[k] = Math.max(0, lLo - prevLo) * 1.5 + Math.max(0, lAll - prevAll);
    prevLo = lLo; prevAll = lAll;
  }
  // remove local mean (adaptive threshold)
  const w = 16, out = new Float32Array(n); let s = 0;
  for (let k = 0; k < n; k++) {
    s += env[k]; if (k >= 2 * w) s -= env[k - 2 * w];
    const mean = s / Math.min(k + 1, 2 * w);
    out[Math.max(0, k - w)] = Math.max(0, env[Math.max(0, k - w)] - mean);
  }
  return out;
}

/** Sharpness of the beat when folding the onset envelope with period P (in hops). */
function foldScore(env, P, bins = 48) {
  const h = new Float32Array(bins);
  for (let k = 0; k < env.length; k++) {
    const ph = (k / P) % 1;
    h[Math.floor(ph * bins)] += env[k];
  }
  let mx = 0, mi = 0, sum = 0;
  for (let i = 0; i < bins; i++) { sum += h[i]; if (h[i] > mx) { mx = h[i]; mi = i; } }
  return { score: mx / (sum / bins + 1e-9), phase: (mi + 0.5) / bins };
}

const MIN_ONSET = 0.03; // mean onset strength below which a signal has no beat (see test/qa-regressions)
export function detectBpm(mono, sr, { min = 70, max = 180 } = {}) {
  const hop = 256;
  const env = onsetEnvelope(mono, sr, hop);
  const fps = sr / hop;
  if (env.length < fps * 4) return { bpm: null, offset: 0, confidence: 0 };
  // no onsets at all (digital silence, a steady tone): there is no tempo to find, don't invent one
  let onsetMean = 0; for (let k = 0; k < env.length; k++) onsetMean += env[k];
  onsetMean /= env.length;
  if (!(onsetMean > MIN_ONSET)) return { bpm: null, offset: 0, confidence: 0 };
  // 1) autocorrelation over the tempo range
  const minLag = Math.floor(fps * 60 / max), maxLag = Math.ceil(fps * 60 / min);
  const N = Math.min(env.length, Math.floor(fps * 120)); // first 2 minutes is plenty for ACF
  const start = Math.max(0, Math.floor((env.length - N) / 2));
  let best = { lag: 0, v: -1 };
  const acf = new Float32Array(maxLag * 2 + 2);
  for (let lag = Math.floor(minLag / 2); lag <= maxLag * 2 + 1; lag++) {
    let v = 0;
    for (let k = start; k + lag < start + N; k++) v += env[k] * env[k + lag];
    acf[lag] = v;
  }
  const A = (l) => Math.max(acf[l - 1] || 0, acf[l] || 0, acf[l + 1] || 0); // tolerate fractional periods
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 * fps / lag;
    // mild preference for the usual dance-music range
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.9, 2));
    // reward lags whose double also correlates (beat vs half-beat disambiguation)
    const half = A(Math.round(lag / 2));
    const v = (A(lag) + 0.5 * (A(lag * 2) || A(lag)) - 0.5 * half) * w;
    if (v > best.v) best = { lag, v };
  }
  if (!best.lag) return { bpm: null, offset: 0, confidence: 0 };
  // 1b) 3:2 check: off-beat bass (kick + bass on the "and") makes the ACF favour 1.5 beats (2/3 of the tempo).
  // Folding the onsets at the true beat period is much sharper than at 1.5 beats, so switch when it clearly is.
  let coarseLag = best.lag;
  const l23 = best.lag * 2 / 3;
  const sharpest = (lag) => { // best fold score within ±3 % (integer lags are too coarse to fold a whole track)
    const b0 = 60 * fps / lag; let m = 0;
    for (let b = b0 * 0.97; b <= b0 * 1.03; b += 0.05) m = Math.max(m, foldScore(env, fps * 60 / b).score);
    return m;
  };
  if (l23 >= minLag && sharpest(l23) > 1.25 * sharpest(best.lag)) coarseLag = l23;
  // A sustained pad can produce a stronger ACF peak than the drums, especially at 48 kHz.
  // If that hypothesis has weak whole-track consistency, search the bounded tempo range
  // before local refinement. Confident estimates keep the fast path and existing disambiguation.
  const sharpness = sharpest(coarseLag);
  if (sharpness < 4) {
    let alternative = { bpm: 60 * fps / coarseLag, score: sharpness };
    for (let b = min; b <= max; b += 0.25) {
      const score = foldScore(env, fps * 60 / b).score;
      if (score > alternative.score) alternative = { bpm: b, score };
    }
    if (alternative.score > sharpness * 1.25) coarseLag = fps * 60 / alternative.bpm;
  }
  // 2) refine with phase folding over the whole track (sub-hop precision)
  let coarse = 60 * fps / coarseLag;
  let top = { bpm: coarse, score: 0, phase: 0 };
  for (let b = coarse * 0.97; b <= coarse * 1.03; b += 0.02) {
    const r = foldScore(env, fps * 60 / b);
    if (r.score > top.score) top = { bpm: b, ...r };
  }
  for (let b = top.bpm - 0.03; b <= top.bpm + 0.03; b += 0.002) {
    const r = foldScore(env, fps * 60 / b, 96);
    if (r.score > top.score * 0.999) top = { bpm: b, ...r };
  }
  let bpm = top.bpm;
  const rounded = Math.round(bpm);
  if (Math.abs(bpm - rounded) < 0.06) bpm = rounded; else bpm = Math.round(bpm * 100) / 100;
  // recompute phase with the final bpm
  const P = fps * 60 / bpm;
  const fin = foldScore(env, P, 96);
  const beat = 60 / bpm;
  let offset = (fin.phase * P) / fps;
  offset = ((offset % beat) + beat) % beat;
  return { bpm, offset, confidence: Math.min(1, (fin.score - 1) / 6) };
}

// ---------------- key detection ----------------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ar = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const ai = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j + len / 2] = re[i + j] - ar; im[i + j + len / 2] = im[i + j] - ai;
        re[i + j] += ar; im[i + j] += ai;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
export const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

function corr(a, b) {
  const ma = a.reduce((x, y) => x + y) / 12, mb = b.reduce((x, y) => x + y) / 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db + 1e-12);
}

export function detectKey(mono, sr) {
  // decimate to ~11 kHz
  const dec = Math.max(1, Math.floor(sr / 11025));
  const fs = sr / dec;
  const N = 8192;
  const frames = Math.floor(mono.length / dec / N);
  if (frames < 2) return { key: null, camelot: null, keyConfidence: 0 };
  const maxFrames = 160;
  const stride = Math.max(1, Math.floor(frames / maxFrames));
  const chroma = new Float64Array(12);
  const re = new Float64Array(N), im = new Float64Array(N);
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  const binPc = new Int8Array(N / 2).fill(-1);
  for (let b = 1; b < N / 2; b++) {
    const f = b * fs / N;
    if (f < 55 || f > 2000) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    if (Math.abs(midi - Math.round(midi)) > 0.35) continue; // only bins near a semitone centre
    binPc[b] = ((Math.round(midi) % 12) + 12) % 12;
  }
  for (let fr = 0; fr < frames; fr += stride) {
    const base = fr * N * dec;
    for (let i = 0; i < N; i++) {
      let s = 0; const o = base + i * dec;
      for (let d = 0; d < dec; d++) s += mono[o + d] || 0;
      re[i] = (s / dec) * win[i]; im[i] = 0;
    }
    fft(re, im);
    const frameChroma = new Float64Array(12);
    for (let b = 1; b < N / 2; b++) if (binPc[b] >= 0) frameChroma[binPc[b]] += Math.sqrt(re[b] * re[b] + im[b] * im[b]);
    const tot = frameChroma.reduce((x, y) => x + y) + 1e-9;
    for (let i = 0; i < 12; i++) chroma[i] += frameChroma[i] / tot;
  }
  const cands = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rot = (p) => p.map((_, i) => p[(i - tonic + 12) % 12]);
    cands.push({ r: corr([...chroma], rot(MAJOR)), key: NOTE_NAMES[tonic], camelot: CAMELOT_MAJOR[tonic] });
    cands.push({ r: corr([...chroma], rot(MINOR)), key: NOTE_NAMES[tonic] + 'm', camelot: CAMELOT_MINOR[tonic] });
  }
  let best = { r: -2, key: null, camelot: null };
  for (const c of cands) if (c.r > best.r) best = c;
  return { key: best.key, camelot: best.camelot, confidence: best.r, keyConfidence: keyConfidenceOf(cands, best) };
}

/**
 * Key confidence 0..1 from the 24 Krumhansl correlations: how well the best key fits (correlation r, 0..1) times
 * how clearly it beats the runner-up. The relative major / minor (same Camelot number) is not a rival: it shares the
 * scale and mixes the same way, so the margin is taken to the best key with a different Camelot number.
 * conf = clamp((r − 0.4) / 0.5) · (0.35 + 0.65 · min(1, margin / 0.15)); clear tonal material ≈ 0.8..1, noise /
 * atonal / single-note material ≈ 0.1..0.4.
 */
function keyConfidenceOf(cands, best) {
  if (!best.camelot || !(best.r > 0)) return 0;
  const num = parseInt(best.camelot, 10);
  let second = -1;
  for (const c of cands) if (parseInt(c.camelot, 10) !== num && c.r > second) second = c.r;
  const margin = Math.max(0, best.r - second);
  const conf = Math.min(1, Math.max(0, (best.r - 0.4) / 0.5)) * (0.35 + 0.65 * Math.min(1, margin / 0.15));
  return Math.round(Math.max(0, Math.min(1, conf)) * 100) / 100;
}

/** Camelot code for tag-style keys ("Am", "A minor", "8A", "F#m", "Gbmaj") */
export function toCamelot(k) {
  if (!k) return null;
  const s = String(k).trim();
  if (/^(1[0-2]|[1-9])[AB]$/i.test(s)) return s.toUpperCase();
  const m = /^([A-G])\s*([#b♯♭]?)\s*(minor|min|major|maj|m)?(?![a-z])/i.exec(s);
  if (!m) return null;
  const enh = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'F#', 'G#': 'Ab', 'A#': 'Bb', Gb: 'F#', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' };
  let name = m[1].toUpperCase() + (m[2] || '').replace('♯', '#').replace('♭', 'b');
  name = enh[name] || name;
  const idx = NOTE_NAMES.indexOf(name);
  if (idx < 0) return null;
  const minor = m[3] && /^m(in(or)?)?$/i.test(m[3]) && m[3] !== 'M';
  return minor ? CAMELOT_MINOR[idx] : CAMELOT_MAJOR[idx];
}

/** Harmonic compatibility on the Camelot wheel: same, ±1, relative major/minor, +2 energy boost. */
export function camelotCompatible(a, b) {
  const pa = /^(\d+)([AB])$/.exec(a || ''), pb = /^(\d+)([AB])$/.exec(b || '');
  if (!pa || !pb) return false;
  const na = +pa[1], nb = +pb[1];
  const d = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  if (pa[2] === pb[2]) return d <= 1;
  return d === 0;
}

// ---------------- loudness (BS.1770, see loudness.js) ----------------
export { LOUDNESS_TARGET };
export const GAIN_MIN = -12, GAIN_MAX = 6; // dB: track trim range
const MAIN_TYPES = new Set(['drop', 'verse', 'chorus']); // "main" sections: what the track sounds like most of the time
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/** Track trim (dB) that brings the main-section loudness to LOUDNESS_TARGET, clamped to [GAIN_MIN, GAIN_MAX]; 0 when unknown. */
export function gainForLoudness(mainLufs) {
  if (!Number.isFinite(mainLufs)) return 0;
  return Math.round(Math.max(GAIN_MIN, Math.min(GAIN_MAX, LOUDNESS_TARGET - mainLufs)) * 10) / 10;
}

/**
 * Loudness of a track from its loudness profile (one K-weighted pass, loudness.js) and its phrases.
 * - lufs: gated integrated loudness of the whole track;
 * - phraseLufs[i]: gated loudness of the 400 ms blocks inside phrases[i] (null for silence);
 * - mainLufs: the loudest main section — consecutive drop / verse / chorus phrases of one type spanning ≥ 8 bars —
 *   else the loudest 30 s window, else the integrated loudness.
 * All LUFS rounded to 0.1 (null when silent).
 */
export function trackLoudness(prof, sampleRate, phrases = [], bpm = 0) {
  const lufs = integratedLoudness(prof);
  const phraseLufs = sectionLoudness(prof, sampleRate, phrases).map((v) => r1(v));
  const bar = bpm ? 240 / bpm : 0;
  const barsOf = (p) => (Number.isFinite(p.bars) ? p.bars : bar ? Math.round((p.end - p.start) / bar) : 0);
  const mains = [];
  for (let i = 0; i < phrases.length; i++) {
    const p = phrases[i];
    if (!MAIN_TYPES.has(p.type)) continue;
    const last = mains.at(-1);
    if (last && last.i1 === i - 1 && phrases[last.i0].type === p.type) { last.i1 = i; last.end = p.end; last.bars += barsOf(p); }
    else mains.push({ i0: i, i1: i, start: p.start, end: p.end, bars: barsOf(p) });
  }
  let main = -Infinity;
  const big = mains.filter((m) => m.bars >= 8);
  if (big.length) for (const v of sectionLoudness(prof, sampleRate, big)) if (v != null && v > main) main = v;
  if (!Number.isFinite(main)) main = loudestWindow(prof, sampleRate, 30)?.lufs ?? -Infinity;
  if (!Number.isFinite(main)) main = lufs;
  return { lufs: r1(lufs), mainLufs: r1(main), phraseLufs };
}

/**
 * Per-phrase loudness for phrases recomputed from the waveform (grid edit, no audio at hand): each new phrase gets the
 * energy-weighted mean of the old phrases' lufs it overlaps (old analyses without lufs: phrases unchanged).
 */
export function carryPhraseLufs(oldPhrases, newPhrases) {
  const old = (oldPhrases || []).filter((p) => Number.isFinite(p?.lufs) && p.end > p.start);
  if (!old.length || !Array.isArray(newPhrases)) return newPhrases;
  return newPhrases.map((p) => {
    let e = 0, w = 0;
    for (const o of old) {
      const ov = Math.min(p.end, o.end) - Math.max(p.start, o.start);
      if (ov > 0) { e += ov * 10 ** (o.lufs / 10); w += ov; }
    }
    return w > 0 ? { ...p, lufs: Math.round(10 * Math.log10(e / w) * 10) / 10 } : { ...p };
  });
}

export function trimPoints(mono, sr) {
  const thr = Math.pow(10, -45 / 20);
  const blk = Math.floor(sr * 0.05);
  let start = 0, end = mono.length;
  outer: for (let i = 0; i < mono.length; i += blk) for (let j = i; j < Math.min(i + blk, mono.length); j++) if (Math.abs(mono[j]) > thr) { start = i; break outer; }
  outer2: for (let i = mono.length - blk; i > 0; i -= blk) for (let j = i; j < i + blk; j++) if (Math.abs(mono[j]) > thr * 4) { end = i + blk; break outer2; }
  return { startTime: start / sr, endTime: Math.min(mono.length, end) / sr };
}

// ---------------- phrase / structure analysis ----------------
// Works on the 3-band waveform only (no audio needed), so it is cheap (a few ms for a 7-minute track)
// and can also be run on the client for tracks analysed before phrase analysis existed.

export const PHRASE_TYPES = ['intro', 'verse', 'buildup', 'drop', 'breakdown', 'outro'];
const PHRASE_NAMES = { intro: 'Intro', verse: 'Verse', buildup: 'Build', drop: 'Drop', breakdown: 'Breakdown', outro: 'Outro' };
const PHRASE_CUE_COLORS = { intro: '#3ea6ff', verse: '#8a96a8', buildup: '#ffb020', drop: '#ff3b4d', breakdown: '#2ed47a', outro: '#c06cff' };
const BAND_W = [1.5, 1, 0.8]; // low / mid / high weights for distances

/** Mean low / mid / high level (0..1) of each beat, beats starting at t0. */
function beatBands(waveform, t0, beat, nb) {
  const { rate, low, mid, high } = waveform; const n = low.length;
  const lo = new Float32Array(nb), mi = new Float32Array(nb), hi = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    const i0 = Math.max(0, Math.round((t0 + b * beat) * rate)), i1 = Math.min(n, Math.round((t0 + (b + 1) * beat) * rate));
    if (i1 <= i0) continue;
    let sl = 0, sm = 0, sh = 0;
    for (let i = i0; i < i1; i++) { sl += low[i]; sm += mid[i]; sh += high[i]; }
    const c = (i1 - i0) * 255;
    lo[b] = sl / c; mi[b] = sm / c; hi[b] = sh / c;
  }
  return [lo, mi, hi];
}

function prefix(a) { const p = new Float64Array(a.length + 1); for (let i = 0; i < a.length; i++) p[i + 1] = p[i] + a[i]; return p; }

/** Weighted distance between the mean feature vectors of [a0,a1) and [b0,b1) using prefix sums P (one per band). */
function segDist(P, a0, a1, b0, b1) {
  let d = 0;
  for (let j = 0; j < P.length; j++) {
    const x = (P[j][a1] - P[j][a0]) / (a1 - a0), y = (P[j][b1] - P[j][b0]) / (b1 - b0);
    d += BAND_W[j] * (x - y) * (x - y);
  }
  return Math.sqrt(d);
}

/**
 * Bar / phrase structure.
 * @returns {{ phrases: {start:number,end:number,type:string,energy:number,bars:number}[], downbeat: number,
 *   phraseAnchor: number|null, phraseConfidence: number }}
 * phrase.energy is the section's relative energy 0..1 (1 = loudest section of the track).
 * phraseAnchor (s) is the first downbeat (≥ downbeat) that starts an 8-bar phrase: downbeat + o bars, where the
 * offset o ∈ 0..7 wins a vote of bar novelty summed at o + 8k (o > 0 = pickup bars before the first phrase).
 * phraseConfidence 0..1 says how clearly that offset beats the others (0 = no 8-bar phrasing found).
 */
export function detectPhrases(mono, sr, bpm, gridOffset = 0, waveform = null, opts = {}) {
  if (!waveform && mono) waveform = computeWaveform(mono, sr);
  const duration = opts.duration ?? (mono && sr ? mono.length / sr : waveform ? waveform.peak.length / waveform.rate : 0);
  const startTime = Math.max(0, opts.startTime ?? 0), endTime = Math.min(duration, opts.endTime ?? duration);
  if (!bpm || !waveform || !(endTime > startTime)) return { phrases: [], downbeat: startTime, phraseAnchor: null, phraseConfidence: 0 };
  const beat = 60 / bpm, bar = beat * 4;
  // beat lattice covering the whole track
  const t0 = gridOffset - Math.floor(gridOffset / beat) * beat;
  const nb = Math.max(0, Math.floor((duration - t0) / beat));
  const bands = beatBands(waveform, t0, beat, nb);
  const PB = bands.map(prefix);

  // ---- 1) downbeat phase: the bar phase where big energy changes line up ----
  const firstBeat = Math.max(0, Math.ceil((startTime - t0) / beat - 0.25));
  const lastBeat = Math.min(nb, Math.floor((endTime - t0) / beat));
  const score = [0, 0, 0, 0];
  for (let b = firstBeat + 4; b <= lastBeat - 4; b++) {
    const d = segDist(PB, b - 4, b, b, b + 4);
    score[b % 4] += d * d;
  }
  const fallback = firstBeat % 4; // prior: music starts on a downbeat
  score[fallback] *= 1.1;
  let phase = fallback;
  for (let p = 0; p < 4; p++) if (score[p] > score[phase] + 1e-9) phase = p;
  let db = phase; while (db < firstBeat) db += 4;
  const downbeat = t0 + db * beat;

  // ---- 2) per-bar features ----
  const K = Math.floor((lastBeat - db) / 4);
  if (K < 4) {
    const p = { start: r3(Math.min(downbeat, startTime)), end: r3(endTime), type: 'verse', energy: 1, bars: Math.max(0, K) };
    Object.assign(p, sectionBeatConfidence(waveform, bpm, gridOffset, p.start, p.end));
    return { phrases: [p], downbeat: r3(downbeat), phraseAnchor: r3(downbeat), phraseConfidence: 0 };
  }
  const F = [new Float32Array(K), new Float32Array(K), new Float32Array(K)];
  for (let j = 0; j < 3; j++) {
    const P = PB[j];
    let mx = 1e-6;
    for (let k = 0; k < K; k++) { F[j][k] = (P[db + 4 * k + 4] - P[db + 4 * k]) / 4; if (F[j][k] > mx) mx = F[j][k]; }
    for (let k = 0; k < K; k++) F[j][k] /= mx;
  }
  const PF = F.map(prefix);

  // ---- 3) novelty between bars (multi-scale before/after contrast: 3-band energy + optional 12-bin chroma) ----
  const barChroma = Array.isArray(opts.barFeatures) ? opts.barFeatures.map((b) => b.chroma) : null;
  const chromaDist = (a0, a1, b0, b1) => {
    if (!barChroma || barChroma.length < b1) return 0;
    const ca = new Float64Array(12), cb = new Float64Array(12);
    for (let i = a0; i < a1; i++) { const c = barChroma[i]; if (c) for (let j = 0; j < 12; j++) ca[j] += c[j]; }
    for (let i = b0; i < b1; i++) { const c = barChroma[i]; if (c) for (let j = 0; j < 12; j++) cb[j] += c[j]; }
    let dot = 0, na = 0, nb = 0;
    for (let j = 0; j < 12; j++) { dot += ca[j] * cb[j]; na += ca[j] * ca[j]; nb += cb[j] * cb[j]; }
    return na > 0 && nb > 0 ? Math.max(0, 1 - dot / Math.sqrt(na * nb)) : 0;
  };
  const nov = new Float32Array(K + 1);
  let maxNov = 0;
  for (let k = 1; k < K; k++) {
    let v = 0;
    for (const [W, wt] of [[2, 0.5], [4, 1], [8, 1]]) {
      const w = Math.min(W, k, K - k);
      if (w < Math.min(2, W)) continue;
      v += wt * (w / W) * (segDist(PF, k - w, k, k, k + w) + 0.45 * chromaDist(k - w, k, k, k + w));
    }
    nov[k] = v; if (v > maxNov) maxNov = v;
  }
  const thr = Math.max(0.06, 0.2 * maxNov);

  // ---- 3b) phrase grid (8-bar): offset vote over bar novelty, above its median (the background level) ----
  const { offset: po, confidence: phraseConfidence } = phraseOffsetVote(nov, K);
  const gridOn = phraseConfidence >= 0.3; // below: no trustworthy 8-bar grid, behave as before (grid from bar 0)
  const go = gridOn ? po : 0;
  const rel = (k) => k - go;
  const prior = (k) => { const r = rel(k); return r % 32 === 0 ? 1.35 : r % 16 === 0 ? 1.3 : r % 8 === 0 ? 1.2 : r % 4 === 0 ? 1.05 : 1; };
  // sharp (±2 bar) contrast: decides whether a boundary one bar off the grid is really off-grid (pickup / fill bar)
  const sharp = (k) => (k <= 0 || k >= K ? 0 : segDist(PF, Math.max(0, k - 2), k, k, Math.min(K, k + 2)));
  const snapRatio = phraseConfidence >= 0.6 ? 0.6 : 0.8;
  const cands = [];
  for (let k = 2; k <= K - 2; k++) {
    if (nov[k] < thr) continue;
    let isMax = true;
    for (let j = Math.max(1, k - 2); j <= Math.min(K - 1, k + 2); j++) if (j !== k && (nov[j] > nov[k] || (nov[j] === nov[k] && j < k))) { isMax = false; break; }
    if (isMax) cands.push({ k, s: nov[k] * prior(k) });
  }
  cands.sort((a, b) => b.s - a.s);
  const bounds = [];
  for (const c of cands) {
    let k = c.k;
    if (gridOn && rel(k) % 8 !== 0) {
      // within ±1 bar of a phrase line: snap to it unless the off-grid evidence is clearly stronger
      const g = go + Math.round(rel(k) / 8) * 8;
      if (Math.abs(g - k) <= 1 && g > 0 && g < K && sharp(g) >= snapRatio * sharp(k)) k = g;
    }
    if (k < 4 || K - k < 4) continue;
    if (bounds.every((b) => Math.abs(b - k) >= 8)) bounds.push(k);
  }
  bounds.sort((a, b) => a - b);
  const edges = [0, ...bounds, K];

  // ---- 4) section stats + labels ----
  const secs = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i], b = edges[i + 1];
    const m = (j, x, y) => (PF[j][y] - PF[j][x]) / (y - x);
    const e = (x, y) => 0.5 * m(0, x, y) + 0.3 * m(1, x, y) + 0.2 * m(2, x, y);
    const q = Math.max(1, Math.floor((b - a) / 4));
    secs.push({ a, b, lo: m(0, a, b), e: e(a, b), slope: e(b - q, b) - e(a, a + q) });
  }
  const maxE = Math.max(...secs.map((s) => s.e), 1e-6), maxLo = Math.max(...secs.map((s) => s.lo), 1e-6);
  for (const s of secs) { s.eRel = s.e / maxE; s.loRel = s.lo / maxLo; s.full = s.loRel >= 0.7 && s.eRel >= 0.75; }
  const n = secs.length;
  let hadDrop = false;
  secs.forEach((s, i) => {
    if (n === 1) s.type = s.full ? 'drop' : 'verse';
    else if (i === 0) s.type = 'intro';
    else if (i === n - 1) s.type = 'outro';
    else if (s.full) s.type = 'drop';
    else {
      const next = secs[i + 1], nextDrop = i + 1 < n - 1 && next.full;
      if (nextDrop && (s.slope > 0.06 || s.b - s.a <= 8) && !(hadDrop && s.loRel < 0.35 && s.b - s.a > 8)) s.type = 'buildup';
      else if (hadDrop && s.loRel < 0.6) s.type = 'breakdown';
      else if (nextDrop) s.type = 'buildup';
      else s.type = 'verse';
    }
    if (s.type === 'drop' || s.full) hadDrop = true; // a full-energy intro counts as a drop for what follows
  });

  // ---- 5) phrases (sections longer than 32 bars are split into 16-bar phrases) ----
  const phrases = [];
  for (const s of secs) {
    let a = s.a;
    if (s.b - a > 32) {
      for (;;) {
        // 16 bars on, on a phrase line of the grid (a section that starts off-grid gets back onto it)
        const cut = gridOn ? go + Math.round((a + 16 - go) / 8) * 8 : a + 16;
        if (s.b - a < 24 || cut - a < 8 || s.b - cut < 8) break;
        phrases.push({ a, b: cut, s }); a = cut;
      }
    }
    phrases.push({ a, b: s.b, s });
  }
  const out = phrases.map(({ a, b, s }, i) => ({
    start: r3(i === 0 ? Math.max(0, Math.min(downbeat, startTime)) : downbeat + a * bar),
    end: r3(i === phrases.length - 1 ? Math.max(downbeat + b * bar, endTime) : downbeat + b * bar),
    type: s.type, energy: Math.round(s.eRel * 100) / 100, bars: b - a,
  }));
  for (const p of out) Object.assign(p, sectionBeatConfidence(waveform, bpm, gridOffset, p.start, p.end));
  return { phrases: out, downbeat: r3(downbeat), phraseAnchor: r3(downbeat + po * bar), phraseConfidence };
}

// ---------- per-section beat confidence (P0.4: is a long beat-matched overlap safe here?) ----------
const ONSET_MIN = 6;        // u8 waveform units / frame: smallest rise that counts as an onset (a steady pad stays below)
const ONSET_RATIO = 1.4;   // an onset at least multiplies the band level by this
const ONSET_COVER = 0.75;  // fraction of grid beats with an onset that counts as a full pulse
const ONSET_WIN = 0.3;      // beats: onset search window around each grid beat (excludes off-beat 8ths at ±0.5)

/**
 * Onset flux of a u8 band over frames [i0, i1): how far the next two frames' mean rises above the highest of the three
 * frames before, counted only when it is ≥ ONSET_RATIO × that level. Frame-to-frame wobble of a sustained sound (a
 * pad's per-frame peak moves by ±20 %) gives 0; a kick or hat attack gives most of its height.
 */
function bandFlux(a, i0, i1) {
  const n = a.length, f = new Float32Array(Math.max(0, i1 - i0));
  for (let i = i0; i < i1; i++) {
    if (i < 1) continue;
    const prev = Math.max(a[i - 1], i >= 2 ? a[i - 2] : 0, i >= 3 ? a[i - 3] : 0);
    const cur = (a[i] + (i + 1 < n ? a[i + 1] : a[i])) / 2, d = cur - prev;
    f[i - i0] = d > 0 && (cur + 4) >= ONSET_RATIO * (prev + 4) ? d : 0;
  }
  return f;
}

/** Pearson correlation of the [1 2 1]-smoothed flux with itself `lag` frames later (max over lag ± 2 frames). */
function pulseOf(flux, lagF) {
  const n = flux.length;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = ((flux[i - 1] || 0) + 2 * flux[i] + (flux[i + 1] || 0)) / 4;
  let best = 0;
  for (let L = Math.floor(lagF) - 2; L <= Math.ceil(lagF) + 2; L++) {
    const m = n - L;
    if (L < 1 || m < 2 * L) continue; // need at least two periods
    let sa = 0, sb = 0;
    for (let i = 0; i < m; i++) { sa += x[i]; sb += x[i + L]; }
    const ma = sa / m, mb = sb / m;
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < m; i++) { const u = x[i] - ma, v = x[i + L] - mb; ab += u * v; aa += u * u; bb += v * v; }
    if (aa > 1e-9 && bb > 1e-9) best = Math.max(best, ab / Math.sqrt(aa * bb));
  }
  return best;
}

/** Signed offsets (s) of the strongest onset within ±ONSET_WIN beats of each grid beat in [i0, i1). */
function gridOffsets(flux, i0, rate, beat, gridOffset, t0, t1) {
  const peaks = [];
  const kb0 = Math.ceil((t0 - gridOffset) / beat), kb1 = Math.floor((t1 - gridOffset) / beat);
  for (let k = kb0; k <= kb1; k++) {
    const g = gridOffset + k * beat;
    const a = Math.max(1, Math.ceil((g - ONSET_WIN * beat) * rate) - i0), b = Math.min(flux.length - 1, Math.floor((g + ONSET_WIN * beat) * rate) - i0);
    let bi = -1, bv = 0;
    for (let i = a; i <= b; i++) if (flux[i] > bv && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1]) { bv = flux[i]; bi = i; }
    if (bi >= 0) peaks.push({ v: bv, dt: (i0 + bi + 0.5) / rate - g });
  }
  if (!peaks.length) return { offsets: [], beats: Math.max(0, kb1 - kb0 + 1) };
  const vs = peaks.map((p) => p.v).sort((x, y) => x - y);
  const thr = Math.max(ONSET_MIN, 0.3 * vs[Math.floor(0.9 * (vs.length - 1))]);
  return { offsets: peaks.filter((p) => p.v >= thr).map((p) => p.dt), beats: Math.max(0, kb1 - kb0 + 1) };
}

function median(a) { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

/**
 * Beat confidence of the section [start, end) from the 3-band waveform and the track grid (cheap: no PCM, ~1 ms for a
 * 16-bar phrase), for the low band and the high band; each value is the better band's.
 * pulse 0..1 = periodicity × coverage, where periodicity is the Pearson autocorrelation of the band's onset flux at the
 *   beat period (±2 frames) and coverage = min(1, (beats with an onset within ±0.3 beat) / (0.75 × beats)). 0 = beatless
 *   pad / free time, ≥ 0.8 = a steady four-on-the-floor (or steady 8th hats).
 * gridErr ms: median |offset| between the strongest onset within ±0.3 beat of each grid beat and that beat, low band
 *   first, high band when the low band has onsets on fewer than ¼ of the beats; null when neither has (beatless).
 *   Off-beat 8ths (bass, hats) sit at ±0.5 beat, outside the window. Onset time = centre of the waveform frame where
 *   the rise starts, so ~2–7 ms remain on a perfect grid (frame quantisation + the detector's grid offset).
 */
export function sectionBeatConfidence(waveform, bpm, gridOffset, start, end) {
  if (!waveform || !(bpm > 0) || !(end > start)) return { pulse: null, gridErr: null };
  const { rate } = waveform, n = waveform.low.length, beat = 60 / bpm;
  const i0 = Math.max(0, Math.floor(start * rate)), i1 = Math.min(n, Math.ceil(end * rate));
  if (i1 - i0 < 4) return { pulse: 0, gridErr: null };
  const t0 = i0 / rate, t1 = i1 / rate;
  let pulse = 0, gridErr = null;
  for (const band of [waveform.low, waveform.high]) {
    const f = bandFlux(band, i0, i1);
    const { offsets, beats } = gridOffsets(f, i0, rate, beat, gridOffset || 0, t0, t1);
    const cover = beats > 0 ? Math.min(1, offsets.length / (ONSET_COVER * beats)) : 0;
    if (cover > 0) pulse = Math.max(pulse, cover * pulseOf(f, beat * rate));
    if (gridErr == null && offsets.length >= Math.max(4, 0.25 * beats)) gridErr = Math.round(median(offsets.map(Math.abs)) * 10000) / 10;
  }
  return { pulse: Math.round(Math.max(0, Math.min(1, pulse)) * 100) / 100, gridErr };
}

/**
 * Beat safety of the region [a, b] (s) of a track, from its phrases' pulse / gridErr (for the automix planner).
 * pulse: overlap-duration-weighted mean over the phrases that carry it.
 * gridErr: the worst (max) gridErr of those phrases overlapping the region by ≥ 1 bar (any overlap when the region is
 *   shorter), because one drifting phrase is enough to flam a long blend; null when none has one (beatless region).
 * known: false when the track has no grid or less than half of [a, b] is covered by phrases with a pulse
 *   (analyses from before this field): fall back to the global bpmConfidence gate then.
 */
export function regionBeatSafety(track, a, b) {
  const none = { pulse: null, gridErr: null, known: false };
  const phrases = Array.isArray(track?.phrases) ? track.phrases : [];
  if (!(track?.bpm > 0) || !phrases.length) return none;
  if (!(b > a)) b = a + 1e-3;
  const bar = 240 / track.bpm, minOv = Math.min(bar, (b - a) * 0.999);
  let w = 0, ps = 0, err = null;
  for (const p of phrases) {
    const ov = Math.min(b, p.end) - Math.max(a, p.start);
    if (!(ov > 0) || !Number.isFinite(p.pulse)) continue;
    w += ov; ps += ov * p.pulse;
    if (Number.isFinite(p.gridErr) && ov >= minOv) err = Math.max(err ?? 0, p.gridErr);
  }
  if (!(w >= 0.5 * (b - a))) return none;
  return { pulse: Math.round((ps / w) * 100) / 100, gridErr: err, known: true };
}

/**
 * Phrase-offset vote (P1.1): score each bar offset o ∈ 0..7 by Σ novelty[o + 8k] over the novelty peaks (local maxima
 * within ±2 bars, measured above the median so a busy track's background doesn't vote), pick the best (ties: the
 * smaller offset).
 * confidence = (best − mean) / (⅞ · best) — 1 when all novelty falls on one 8-bar grid, 0 when spread evenly —
 * scaled by 0.5 + 0.5 · min(1, 2 · (best − runner-up) / best), so a 4-bar ambiguity (o and o + 4 equal) halves it.
 */
export function phraseOffsetVote(nov, K = nov.length - 1) {
  const vals = [];
  for (let k = 1; k < K; k++) vals.push(nov[k]);
  if (vals.length < 8) return { offset: 0, confidence: 0, votes: new Array(8).fill(0) };
  vals.sort((a, b) => a - b);
  const base = vals[vals.length >> 1];
  const votes = new Array(8).fill(0);
  for (let k = 1; k < K; k++) {
    // only peaks vote (the novelty kernels smear a boundary over ±7 bars, which would vote for every offset)
    let peak = true;
    for (let j = Math.max(1, k - 2); j <= Math.min(K - 1, k + 2); j++) if (j !== k && nov[j] > nov[k]) { peak = false; break; }
    if (peak) votes[k % 8] += Math.max(0, nov[k] - base);
  }
  let o = 0;
  for (let i = 1; i < 8; i++) if (votes[i] > votes[o] * 1.02 + 1e-9) o = i;
  const best = votes[o];
  if (!(best > 1e-9)) return { offset: 0, confidence: 0, votes };
  const mean = votes.reduce((x, y) => x + y, 0) / 8;
  let second = 0; for (let i = 0; i < 8; i++) if (i !== o && votes[i] > second) second = votes[i];
  const c = ((best - mean) / (0.875 * best)) * (0.5 + 0.5 * Math.min(1, (2 * (best - second)) / best));
  return { offset: o, confidence: Math.round(Math.max(0, Math.min(1, c)) * 100) / 100, votes };
}

function r3(x) { return Math.round(x * 1000) / 1000; }

/**
 * Where to start the next track (mixIn) and where to start mixing out of this one (mixOut), in seconds.
 * phraseAnchor (optional): a downbeat that starts an 8-bar phrase; the fallback mixOut lands on that phrase grid.
 */
export function mixPoints(phrases, downbeat, bpm, { startTime = 0, endTime, phraseAnchor } = {}) {
  const end = endTime ?? (phrases.length ? phrases.at(-1).end : startTime);
  if (!bpm || !phrases.length) return { mixIn: r3(startTime), mixOut: r3(Math.max(startTime, end - 30)) };
  const bar = 240 / bpm;
  const mixIn = downbeat;
  const K = Math.floor((end - downbeat) / bar + 1e-6);
  const last = phrases.at(-1);
  // trailing outro (possibly split into several 16-bar phrases)
  let oi = phrases.length - 1;
  while (oi > 0 && phrases[oi - 1].type === 'outro') oi--;
  const outroBars = Math.round((end - phrases[oi].start) / bar);
  let mixOut;
  if (last.type === 'outro' && oi > 0 && outroBars >= 8 && outroBars <= 64) mixOut = phrases[oi].start;
  else { // last 32 (short tracks: 16) bars, on an 8-bar phrase boundary
    const L = K >= 64 ? 32 : K >= 24 ? 16 : Math.max(1, Math.floor(K / 2));
    const a0 = phraseAnchor != null ? ((Math.round((phraseAnchor - downbeat) / bar) % 8) + 8) % 8 : 0; // pickup bars
    const k = Math.max(0, L >= 8 ? (K - L - a0 >= 0 ? a0 + Math.floor((K - L - a0) / 8) * 8 : Math.floor((K - L) / 8) * 8) : K - L);
    mixOut = downbeat + k * bar;
  }
  if (mixOut <= mixIn) mixOut = Math.max(mixIn, end - Math.min(30, (end - mixIn) / 2));
  return { mixIn: r3(mixIn), mixOut: r3(mixOut) };
}

// A "Drop" cue needs a real energy jump well into the track: at least this many seconds in, after a
// quieter intro / build / breakdown or at least this much louder (relative section energy, 0..1) than the section before.
export const DROP_MIN_START = 20;
export const DROP_MIN_JUMP = 0.2;

/**
 * Hot cue (max 8) + memory cue suggestions from the structure, like rekordbox auto cue / SMART CUE.
 * Every cue is marked `auto: true` so imports / re-analysis know they may replace it.
 */
export function autoCuesFor(phrases, { mixIn, mixOut, downbeat } = {}) {
  const cands = [];
  const counts = {};
  // contiguous phrases of one section share a type: only cue section starts
  phrases.forEach((p, i) => {
    if (i > 0 && phrases[i - 1].type === p.type) return;
    if (p.type === 'drop') {
      // a full-energy start (or a section no louder than the one before) is not a drop: cue it as the start
      // of the track if it is the first section, else not at all
      const prev = phrases[i - 1];
      const real = i > 0 && p.start >= DROP_MIN_START
        && (['intro', 'buildup', 'breakdown'].includes(prev.type) || (p.energy ?? 1) - (prev.energy ?? 0) >= DROP_MIN_JUMP);
      if (!real) {
        if (i === 0) cands.push({ position: downbeat != null ? downbeat : p.start, type: 'intro', name: 'Start', prio: 10 });
        return;
      }
    }
    counts[p.type] = (counts[p.type] || 0) + 1;
    const nth = counts[p.type];
    const position = i === 0 && downbeat != null ? downbeat : p.start;
    const prio = { intro: 10, drop: nth === 1 ? 9 : nth === 2 ? 7 : 5, outro: 8, breakdown: nth === 1 ? 7 : 5, buildup: 4, verse: 3 }[p.type] ?? 1;
    cands.push({ position, type: p.type, name: PHRASE_NAMES[p.type] + (nth > 1 && p.type !== 'intro' && p.type !== 'outro' ? ` ${nth}` : ''), prio });
  });
  if (!cands.length && mixIn != null) cands.push({ position: mixIn, type: 'intro', name: 'Start', prio: 10 });
  const chosen = cands.sort((a, b) => b.prio - a.prio || a.position - b.position).slice(0, 8).sort((a, b) => a.position - b.position);
  const cues = chosen.map((c, i) => ({ index: i, type: 'hot', position: r3(c.position), name: c.name, color: PHRASE_CUE_COLORS[c.type] || '#2ecc71', auto: true }));
  if (mixIn != null) cues.push({ index: -1, type: 'memory', position: r3(mixIn), name: 'Mix in', auto: true });
  if (mixOut != null && mixOut > (mixIn ?? -1) + 1) cues.push({ index: -1, type: 'memory', position: r3(mixOut), name: 'Mix out', auto: true });
  return cues;
}

/**
 * The library patch for a finished analysis (`r` = analyzeTrack() result without the waveform), shared by
 * deck load and background analysis so both store exactly the same thing. User / imported data wins:
 * a locked BPM or imported grid (bpmLocked / gridLocked) keeps its BPM and grid, an existing key is kept,
 * existing cues are kept (auto cues are only added to tracks without any cues).
 *
 * keyConfidence: the detector's 0..1 confidence when the detected key is stored. When the track's own key is kept
 * (typed by the user, read from tags or imported, i.e. stored without a keyConfidence) it is 1 — a key the user or
 * their other software chose is trusted. A stored key that came from an earlier analysis (it has a keyConfidence) gets
 * the fresh confidence if the detector still agrees, else keeps its old one. Analyses from before this field: absent.
 * gain = LOUDNESS_TARGET − mainLufs (dB, clamped) for new analyses; lufs / mainLufs / phrases[i].lufs in LUFS.
 * phraseAnchor / phraseConfidence: the 8-bar phrase grid; with a locked grid the anchor is moved onto its beats.
 */
export function analysisPatch(track, r, { duration, autoCues = true } = {}) {
  const locked = !!(track.bpm && (track.bpmLocked || track.gridLocked));
  const patch = {
    bpm: locked ? track.bpm : r.bpm,
    gridOffset: locked && track.gridOffset != null ? track.gridOffset : r.gridOffset,
    key: track.key || r.key, gain: r.gain, startTime: r.startTime, endTime: r.endTime,
    energy: r.energy, duration: duration ?? r.duration, analyzed: true, unreadable: false,
    bpmConfidence: locked ? 1 : r.bpmConfidence,
  };
  for (const k of ['phrases', 'mixIn', 'mixOut', 'downbeat', 'lufs', 'mainLufs', 'phraseAnchor', 'phraseConfidence', 'barFeatures', 'vocalMapAuto', 'groove', 'embedding', 'tempoMap']) if (r[k] !== undefined) patch[k] = r[k];
  if (locked && track.downbeat != null) patch.downbeat = track.downbeat;
  if (locked && Number.isFinite(patch.phraseAnchor) && track.bpm > 0 && Number.isFinite(patch.gridOffset)) {
    const beat = 60 / track.bpm;
    patch.phraseAnchor = r3(patch.gridOffset + Math.round((patch.phraseAnchor - patch.gridOffset) / beat) * beat);
  }
  if (r.keyConfidence !== undefined) {
    if (!track.key) patch.keyConfidence = r.keyConfidence;
    else if (track.keyConfidence == null) patch.keyConfidence = 1;
    else patch.keyConfidence = toCamelot(track.key) === (r.camelot ?? toCamelot(r.key)) ? r.keyConfidence : track.keyConfidence;
  }
  if (!(track.cues || []).length && Array.isArray(r.autoCues) && r.autoCues.length && autoCues !== false) patch.cues = r.autoCues;
  return patch;
}

/** Everything structure-related from an existing waveform: phrases, downbeat, mixIn, mixOut, autoCues. */
export function analyzeStructure(waveform, bpm, gridOffset, { startTime = 0, endTime, duration, barFeatures } = {}) {
  duration = duration ?? (waveform ? waveform.peak.length / waveform.rate : 0);
  endTime = endTime ?? duration;
  const { phrases, downbeat, phraseAnchor, phraseConfidence } = detectPhrases(null, 0, bpm, gridOffset, waveform, { startTime, endTime, duration, barFeatures });
  const { mixIn, mixOut } = mixPoints(phrases, downbeat, bpm, { startTime, endTime, phraseAnchor: phraseConfidence >= 0.3 ? phraseAnchor : undefined });
  const autoCues = autoCuesFor(phrases, { mixIn, mixOut, downbeat: bpm ? downbeat : undefined });
  return { phrases, downbeat, phraseAnchor, phraseConfidence, mixIn, mixOut, autoCues };
}

export function analyzeTrack(mono, sr) {
  const waveform = computeWaveform(mono, sr);
  const beat = detectBpm(mono, sr);
  const key = detectKey(mono, sr);
  const trim = trimPoints(mono, sr);
  let energy = 0;
  for (let i = 0; i < waveform.peak.length; i++) energy += waveform.low[i] + waveform.mid[i];
  energy = Math.round(Math.min(10, Math.max(1, energy / waveform.peak.length / 25)));
  const duration = mono.length / sr;
  const firstPass = analyzeStructure(waveform, beat.bpm, beat.offset, { ...trim, duration });
  // Per-bar 4-band + 12-bin chroma, DSP vocal activity map, groove fingerprint / audio embedding, elastic tempoMap
  const barFeatures = beat.bpm ? computeBarFeatures(mono, sr, beat.bpm, firstPass.downbeat) : [];
  const structure = barFeatures.length ? analyzeStructure(waveform, beat.bpm, beat.offset, { ...trim, duration, barFeatures }) : firstPass;
  const vad = detectVocalActivity(mono, sr);
  const { groove, embedding } = computeGrooveAndEmbedding(mono, sr, beat.bpm, structure.downbeat, barFeatures, vad.map);
  const tempoMap = beat.bpm ? detectElasticGrid(mono, sr, beat.bpm, beat.offset) : null;
  // loudness: one K-weighted pass over the mono mix (measured as dual mono = as played on both speakers)
  const loud = trackLoudness(loudnessProfile(mono, sr), sr, structure.phrases, beat.bpm);
  structure.phrases = structure.phrases.map((p, i) => ({ ...p, lufs: loud.phraseLufs[i] }));
  return {
    waveform, bpm: beat.bpm, gridOffset: beat.offset, bpmConfidence: beat.confidence, key: key.key, camelot: key.camelot,
    keyConfidence: key.keyConfidence, lufs: loud.lufs, mainLufs: loud.mainLufs, gain: gainForLoudness(loud.mainLufs),
    ...trim, energy, duration, ...structure, barFeatures, vocalMapAuto: vad.encoded || undefined, groove, embedding, tempoMap,
  };
}

// ---------- waveform (de)serialisation for the server cache ----------
export function encodeWaveform(w) {
  const n = w.peak.length;
  const buf = new Uint8Array(12 + n * 4);
  const dv = new DataView(buf.buffer);
  buf.set([79, 68, 74, 87]); // "ODJW"
  dv.setUint16(4, 1, true); dv.setUint16(6, w.rate, true); dv.setUint32(8, n, true);
  buf.set(w.low, 12); buf.set(w.mid, 12 + n); buf.set(w.high, 12 + 2 * n); buf.set(w.peak, 12 + 3 * n);
  return buf;
}
export function decodeWaveform(ab) {
  const buf = new Uint8Array(ab);
  if (buf.length < 12 || buf[0] !== 79 || buf[3] !== 87) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const rate = dv.getUint16(6, true), n = dv.getUint32(8, true);
  if (buf.length < 12 + 4 * n) return null;
  return { rate, low: buf.slice(12, 12 + n), mid: buf.slice(12 + n, 12 + 2 * n), high: buf.slice(12 + 2 * n, 12 + 3 * n), peak: buf.slice(12 + 3 * n, 12 + 4 * n) };
}
