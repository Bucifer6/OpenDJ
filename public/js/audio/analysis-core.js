// Track analysis: 3-band waveform, BPM + beatgrid, musical key (Camelot), loudness and silence trimming.
// Pure functions: used by the Web Worker in the app and by Node unit tests.

export const WAVE_RATE = 150; // waveform points per second

export function downmix(left, right) {
  if (!right || right === left) return left;
  const m = new Float32Array(left.length);
  for (let i = 0; i < m.length; i++) m[i] = (left[i] + right[i]) * 0.5;
  return m;
}

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
  if (frames < 2) return { key: null, camelot: null };
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
  let best = { r: -2, key: null, camelot: null };
  for (let tonic = 0; tonic < 12; tonic++) {
    const rot = (p) => p.map((_, i) => p[(i - tonic + 12) % 12]);
    const rMaj = corr([...chroma], rot(MAJOR)), rMin = corr([...chroma], rot(MINOR));
    if (rMaj > best.r) best = { r: rMaj, key: NOTE_NAMES[tonic], camelot: CAMELOT_MAJOR[tonic] };
    if (rMin > best.r) best = { r: rMin, key: NOTE_NAMES[tonic] + 'm', camelot: CAMELOT_MINOR[tonic] };
  }
  return { key: best.key, camelot: best.camelot, confidence: best.r };
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

export function loudness(mono, sr) {
  // RMS over 400 ms blocks, gated (ignore quiet blocks), roughly LUFS-like
  const blk = Math.floor(sr * 0.4); const vals = [];
  for (let i = 0; i + blk <= mono.length; i += blk) {
    let s = 0; for (let j = i; j < i + blk; j++) s += mono[j] * mono[j];
    vals.push(s / blk);
  }
  const gated = vals.filter((v) => 10 * Math.log10(v + 1e-12) > -50);
  if (!gated.length) return { rmsDb: -60, gainDb: 0 };
  const mean = gated.reduce((a, b) => a + b) / gated.length;
  const rmsDb = 10 * Math.log10(mean);
  const gainDb = Math.max(-12, Math.min(12, -12 - rmsDb)); // target ≈ -12 dB RMS
  return { rmsDb, gainDb };
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
 * @returns {{ phrases: {start:number,end:number,type:string,energy:number,bars:number}[], downbeat: number }}
 * phrase.energy is the section's relative energy 0..1 (1 = loudest section of the track).
 */
export function detectPhrases(mono, sr, bpm, gridOffset = 0, waveform = null, opts = {}) {
  if (!waveform && mono) waveform = computeWaveform(mono, sr);
  const duration = opts.duration ?? (mono && sr ? mono.length / sr : waveform ? waveform.peak.length / waveform.rate : 0);
  const startTime = Math.max(0, opts.startTime ?? 0), endTime = Math.min(duration, opts.endTime ?? duration);
  if (!bpm || !waveform || !(endTime > startTime)) return { phrases: [], downbeat: startTime };
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
    return { phrases: [{ start: r3(Math.min(downbeat, startTime)), end: r3(endTime), type: 'verse', energy: 1, bars: Math.max(0, K) }], downbeat: r3(downbeat) };
  }
  const F = [new Float32Array(K), new Float32Array(K), new Float32Array(K)];
  for (let j = 0; j < 3; j++) {
    const P = PB[j];
    let mx = 1e-6;
    for (let k = 0; k < K; k++) { F[j][k] = (P[db + 4 * k + 4] - P[db + 4 * k]) / 4; if (F[j][k] > mx) mx = F[j][k]; }
    for (let k = 0; k < K; k++) F[j][k] /= mx;
  }
  const PF = F.map(prefix);

  // ---- 3) novelty between bars (multi-scale before/after contrast ≈ checkerboard kernel on the SSM) ----
  const nov = new Float32Array(K + 1);
  let maxNov = 0;
  for (let k = 1; k < K; k++) {
    let v = 0;
    for (const [W, wt] of [[2, 0.5], [4, 1], [8, 1]]) {
      const w = Math.min(W, k, K - k);
      if (w < Math.min(2, W)) continue;
      v += wt * (w / W) * segDist(PF, k - w, k, k, k + w);
    }
    nov[k] = v; if (v > maxNov) maxNov = v;
  }
  const thr = Math.max(0.06, 0.2 * maxNov);
  const prior = (k) => (k % 16 === 0 ? 1.3 : k % 8 === 0 ? 1.2 : k % 4 === 0 ? 1.05 : 1);
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
    if (c.k < 4 || K - c.k < 4) continue;
    if (bounds.every((k) => Math.abs(k - c.k) >= 8)) bounds.push(c.k);
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
    if (s.b - a > 32) while (s.b - a >= 24) { phrases.push({ a, b: a + 16, s }); a += 16; }
    phrases.push({ a, b: s.b, s });
  }
  const out = phrases.map(({ a, b, s }, i) => ({
    start: r3(i === 0 ? Math.max(0, Math.min(downbeat, startTime)) : downbeat + a * bar),
    end: r3(i === phrases.length - 1 ? Math.max(downbeat + b * bar, endTime) : downbeat + b * bar),
    type: s.type, energy: Math.round(s.eRel * 100) / 100, bars: b - a,
  }));
  return { phrases: out, downbeat: r3(downbeat) };
}

function r3(x) { return Math.round(x * 1000) / 1000; }

/** Where to start the next track (mixIn) and where to start mixing out of this one (mixOut), in seconds. */
export function mixPoints(phrases, downbeat, bpm, { startTime = 0, endTime } = {}) {
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
    const k = Math.max(0, L >= 8 ? Math.floor((K - L) / 8) * 8 : K - L);
    mixOut = downbeat + k * bar;
  }
  if (mixOut <= mixIn) mixOut = Math.max(mixIn, end - Math.min(30, (end - mixIn) / 2));
  return { mixIn: r3(mixIn), mixOut: r3(mixOut) };
}

/** Hot cue (max 8) + memory cue suggestions from the structure, like rekordbox auto cue / SMART CUE. */
export function autoCuesFor(phrases, { mixIn, mixOut, downbeat } = {}) {
  const cands = [];
  const counts = {};
  // contiguous phrases of one section share a type: only cue section starts
  phrases.forEach((p, i) => {
    if (i > 0 && phrases[i - 1].type === p.type) return;
    counts[p.type] = (counts[p.type] || 0) + 1;
    const nth = counts[p.type];
    const position = i === 0 && downbeat != null ? downbeat : p.start;
    const prio = { intro: 10, drop: nth === 1 ? 9 : nth === 2 ? 7 : 5, outro: 8, breakdown: nth === 1 ? 7 : 5, buildup: 4, verse: 3 }[p.type] ?? 1;
    cands.push({ position, type: p.type, name: PHRASE_NAMES[p.type] + (nth > 1 && p.type !== 'intro' && p.type !== 'outro' ? ` ${nth}` : ''), prio });
  });
  if (!cands.length && mixIn != null) cands.push({ position: mixIn, type: 'intro', name: 'Start', prio: 10 });
  const chosen = cands.sort((a, b) => b.prio - a.prio || a.position - b.position).slice(0, 8).sort((a, b) => a.position - b.position);
  const cues = chosen.map((c, i) => ({ index: i, type: 'hot', position: r3(c.position), name: c.name, color: PHRASE_CUE_COLORS[c.type] || '#2ecc71' }));
  if (mixIn != null) cues.push({ index: -1, type: 'memory', position: r3(mixIn), name: 'Mix in' });
  if (mixOut != null && mixOut > (mixIn ?? -1) + 1) cues.push({ index: -1, type: 'memory', position: r3(mixOut), name: 'Mix out' });
  return cues;
}

/** Everything structure-related from an existing waveform: phrases, downbeat, mixIn, mixOut, autoCues. */
export function analyzeStructure(waveform, bpm, gridOffset, { startTime = 0, endTime, duration } = {}) {
  duration = duration ?? (waveform ? waveform.peak.length / waveform.rate : 0);
  endTime = endTime ?? duration;
  const { phrases, downbeat } = detectPhrases(null, 0, bpm, gridOffset, waveform, { startTime, endTime, duration });
  const { mixIn, mixOut } = mixPoints(phrases, downbeat, bpm, { startTime, endTime });
  const autoCues = autoCuesFor(phrases, { mixIn, mixOut, downbeat: bpm ? downbeat : undefined });
  return { phrases, downbeat, mixIn, mixOut, autoCues };
}

export function analyzeTrack(mono, sr) {
  const waveform = computeWaveform(mono, sr);
  const beat = detectBpm(mono, sr);
  const key = detectKey(mono, sr);
  const loud = loudness(mono, sr);
  const trim = trimPoints(mono, sr);
  let energy = 0;
  for (let i = 0; i < waveform.peak.length; i++) energy += waveform.low[i] + waveform.mid[i];
  energy = Math.round(Math.min(10, Math.max(1, energy / waveform.peak.length / 25)));
  const duration = mono.length / sr;
  const structure = analyzeStructure(waveform, beat.bpm, beat.offset, { ...trim, duration });
  return { waveform, bpm: beat.bpm, gridOffset: beat.offset, bpmConfidence: beat.confidence, key: key.key, camelot: key.camelot, gain: loud.gainDb, ...trim, energy, duration, ...structure };
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
