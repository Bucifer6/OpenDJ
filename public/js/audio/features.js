// Musical feature extraction for pro-DJ automix & smart selection:
//   - Per-bar 4-band spectrum (sub <90 Hz, punch 90-250 Hz, mid 250-2500 Hz, high >2500 Hz) + 12-bin bar chroma
//   - Fast DSP Vocal Activity Detection (VAD) per second (no Demucs required; harmonic mid-band + 3-8 Hz syllabic flux)
//   - 16-step groove fingerprint + swing + 24-dim unit-normalized audio embedding for smartmix.soundSimilarity()
//   - Elastic beatgrid (tempoMap) detection & beat/time interpolation for live-drummed / drifting tracks
// Pure ES module (zero deps): runs in analysis-worker.js, browser, and Node tests.
import { encodeVocalMap } from '../shared/vocal-map.js';

const onePole = (fc, sr) => 1 - Math.exp((-2 * Math.PI * fc) / sr);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const k = i + j + len / 2;
        const ar = re[k] * cr - im[k] * ci;
        const ai = re[k] * ci + im[k] * cr;
        re[k] = re[i + j] - ar; im[k] = im[i + j] - ai;
        re[i + j] += ar; im[i + j] += ai;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/**
 * Fast DSP Vocal Activity Detector (per-second probability 0..1).
 * Combines three acoustic cues of human vocals without needing AI source separation:
 *   1. Voice-band energy ratio (300 - 3400 Hz vs total spectrum)
 *   2. Low spectral flatness / high tonality in the vocal formant band (harmonics vs broadband noise/hats)
 *   3. Syllabic amplitude modulation (3 - 8 Hz envelope variance in the vocal band)
 * Returns { map: Float32Array (per second 0..1), encoded: string (vocal-map format) }.
 */
export function detectVocalActivity(mono, sr) {
  const secs = Math.floor(mono.length / sr);
  if (secs < 1) return { map: new Float32Array(0), encoded: '' };
  const dec = Math.max(1, Math.floor(sr / 11025));
  const fs = sr / dec;
  const N = 1024;
  const hop = 256; // ~23 ms frames (~43 fps, ideal for 3-8 Hz syllabic modulation)
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const re = new Float32Array(N), im = new Float32Array(N);
  const bLo = Math.max(1, Math.floor((300 * N) / fs));
  const bHi = Math.min(N / 2 - 1, Math.ceil((3400 * N) / fs));
  const bSub = Math.max(1, Math.floor((120 * N) / fs));

  const raw = new Float32Array(secs);
  for (let s = 0; s < secs; s++) {
    const base = s * sr;
    const frames = Math.max(1, Math.floor((sr / dec - N) / hop) + 1);
    const vEnv = new Float32Array(frames);
    let ratioSum = 0, tonalSum = 0, vEnergySum = 0;
    for (let fr = 0; fr < frames; fr++) {
      const start = base + fr * hop * dec;
      for (let i = 0; i < N; i++) {
        const idx = start + i * dec;
        re[i] = (idx < mono.length ? mono[idx] : 0) * win[i];
        im[i] = 0;
      }
      fftInPlace(re, im);
      let eSub = 0, eVoc = 0, eAll = 1e-12;
      let logSum = 0, linSum = 1e-12, vocBins = 0;
      for (let b = 1; b < N / 2; b++) {
        const p = re[b] * re[b] + im[b] * im[b];
        eAll += p;
        if (b < bSub) eSub += p;
        if (b >= bLo && b <= bHi) {
          eVoc += p;
          logSum += Math.log(p + 1e-12);
          linSum += p;
          vocBins++;
        }
      }
      vEnv[fr] = Math.sqrt(eVoc);
      vEnergySum += eVoc;
      // Penalize frames dominated by sub-bass only
      const ratio = eVoc / (eAll - 0.5 * eSub + 1e-12);
      // Spectral flatness in voice band (0 = pure harmonics/voice, 1 = flat noise)
      const gm = Math.exp(logSum / Math.max(1, vocBins));
      const am = linSum / Math.max(1, vocBins);
      const flatness = clamp01(gm / (am + 1e-12));
      const tonality = 1 - Math.sqrt(flatness);
      ratioSum += ratio;
      tonalSum += tonality;
    }
    const meanRatio = ratioSum / frames;
    const meanTonal = tonalSum / frames;
    // Syllabic modulation (3 - 8 Hz) measured by frame-to-frame normalized envelope variation over ~120 ms lag
    let envMean = 0;
    for (let fr = 0; fr < frames; fr++) envMean += vEnv[fr];
    envMean /= frames;
    const lag = Math.max(1, Math.round((0.12 * fs) / hop)); // ~4 Hz half-cycle
    let modSum = 0, modN = 0;
    for (let fr = lag; fr < frames; fr++) { modSum += Math.abs(vEnv[fr] - vEnv[fr - lag]); modN++; }
    const modScore = envMean > 1e-4 && modN > 0 ? clamp01((modSum / modN) / (envMean * 0.9)) : 0;
    const rmsDb = 10 * Math.log10(vEnergySum / (frames * N) + 1e-12);
    const loudGate = clamp01((rmsDb + 42) / 18); // silence / whisper gate
    // Combine cues: voice requires vocal-band presence + harmonicity + moderate modulation
    const p = loudGate * clamp01((meanRatio - 0.12) * 2.1) * (0.45 + 0.55 * meanTonal) * (0.45 + 0.55 * modScore);
    raw[s] = clamp01(p * 1.35);
  }
  // 3-second median + slight smoothing (removes single-second false triggers)
  const map = new Float32Array(secs);
  for (let s = 0; s < secs; s++) {
    const a = raw[Math.max(0, s - 1)], b = raw[s], c = raw[Math.min(secs - 1, s + 1)];
    const med = a + b + c - Math.min(a, b, c) - Math.max(a, b, c);
    map[s] = r2(med * 0.7 + b * 0.3);
  }
  return { map, encoded: encodeVocalMap(map) };
}

/**
 * Per-bar 4-band spectral profile (sub <90 Hz, punch 90-250 Hz, mid 250-2500 Hz, high >2500 Hz)
 * + 12-bin chroma vector + spectral centroid.
 * Compact output (~120 bytes per 16 bars) for content-aware EQ, local chroma clash detection, and phrase segmentation.
 */
export function computeBarFeatures(mono, sr, bpm, downbeat = 0) {
  if (!(bpm > 0) || !mono?.length) return [];
  const barSec = 240 / bpm;
  const dur = mono.length / sr;
  const nBars = Math.min(320, Math.floor((dur - downbeat) / barSec));
  if (nBars < 1) return [];

  // 4-band 2-pole filter bank over the track in a single linear pass
  const aSub = onePole(90, sr), aLow = onePole(250, sr), aMid = onePole(2500, sr);
  let s1 = 0, s2 = 0, l1 = 0, l2 = 0, m1 = 0, m2 = 0;
  const subE = new Float64Array(nBars), punchE = new Float64Array(nBars);
  const midE = new Float64Array(nBars), highE = new Float64Array(nBars);
  const barFrames = barSec * sr;
  const startFrame = Math.max(0, Math.floor(downbeat * sr));
  const endFrame = Math.min(mono.length, Math.floor((downbeat + nBars * barSec) * sr));
  for (let i = startFrame; i < endFrame; i++) {
    const x = mono[i];
    s1 += aSub * (x - s1); s2 += aSub * (s1 - s2);
    l1 += aLow * (x - l1); l2 += aLow * (l1 - l2);
    m1 += aMid * (x - m1); m2 += aMid * (m1 - m2);
    const sub = s2, punch = l2 - s2, mid = m2 - l2, high = x - m2;
    const b = Math.min(nBars - 1, Math.floor((i - startFrame) / barFrames));
    subE[b] += sub * sub;
    punchE[b] += punch * punch;
    midE[b] += mid * mid;
    highE[b] += high * high;
  }

  // Per-bar 12-bin chroma (1 FFT per bar centered in the bar, decimated to ~11 kHz)
  const dec = Math.max(1, Math.floor(sr / 11025));
  const fs = sr / dec;
  const N = 4096;
  const re = new Float32Array(N), im = new Float32Array(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const binPc = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * fs) / N;
    if (f < 110 || f > 2400) continue; // ignore sub-bass/kick fundamentals (<110 Hz) so chords dominate chroma
    const midi = 69 + 12 * Math.log2(f / 440);
    if (Math.abs(midi - Math.round(midi)) <= 0.35) binPc[k] = ((Math.round(midi) % 12) + 12) % 12;
  }

  // Normalize band energies relative to the track's loudest bar so bands stay comparable
  let maxBand = 1e-12;
  for (let b = 0; b < nBars; b++) {
    const tot = (subE[b] + punchE[b] + midE[b] + highE[b]) / Math.max(1, barFrames);
    if (tot > maxBand) maxBand = tot;
  }
  const norm = Math.sqrt(maxBand);

  const out = [];
  for (let b = 0; b < nBars; b++) {
    const center = startFrame + Math.floor((b + 0.5) * barFrames);
    const base = Math.max(0, Math.min(mono.length - N * dec, center - (N * dec) / 2));
    for (let i = 0; i < N; i++) {
      const idx = base + i * dec;
      re[i] = (idx < mono.length ? mono[idx] : 0) * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    const ch = new Float32Array(12);
    let cSum = 1e-9, wFreq = 0, wMag = 1e-9;
    for (let k = 1; k < N / 2; k++) {
      const m = Math.hypot(re[k], im[k]);
      wFreq += m * ((k * fs) / N);
      wMag += m;
      if (binPc[k] >= 0) { const p = m * m; ch[binPc[k]] += p; cSum += p; }
    }
    const chroma = new Array(12);
    for (let i = 0; i < 12; i++) chroma[i] = Math.round((ch[i] / cSum) * 100) / 100;
    const sub = clamp01(Math.sqrt(subE[b] / Math.max(1, barFrames)) / norm);
    const punch = clamp01(Math.sqrt(punchE[b] / Math.max(1, barFrames)) / norm);
    const mid = clamp01(Math.sqrt(midE[b] / Math.max(1, barFrames)) / norm);
    const high = clamp01(Math.sqrt(highE[b] / Math.max(1, barFrames)) / norm);
    out.push({
      start: r3(downbeat + b * barSec),
      end: r3(downbeat + (b + 1) * barSec),
      sub: r2(sub), punch: r2(punch), mid: r2(mid), high: r2(high),
      centroid: r2(clamp01((wFreq / wMag - 200) / 3800)),
      chroma,
    });
  }
  return out;
}

/** Cosine similarity (0..1) of mean 12-bin chroma between two track windows [a0,a1] and [b0,b1]. null when unavailable. */
export function localChromaSimilarity(out, a0, a1, inn, b0, b1) {
  const meanChroma = (t, x0, x1) => {
    const bf = Array.isArray(t?.barFeatures) ? t.barFeatures : null;
    if (!bf?.length) return null;
    const acc = new Float64Array(12);
    let w = 0;
    for (const bar of bf) {
      if (!Array.isArray(bar.chroma) || bar.chroma.length !== 12) continue;
      const ov = Math.min(x1, bar.end) - Math.max(x0, bar.start);
      if (ov <= 0) continue;
      // Weight tonal bars higher (sub/high-only drum bars have low mid energy)
      const tonalW = ov * (0.25 + (bar.mid ?? 0.5));
      for (let i = 0; i < 12; i++) acc[i] += bar.chroma[i] * tonalW;
      w += tonalW;
    }
    return w > 0 ? acc : null;
  };
  const ca = meanChroma(out, a0, a1), cb = meanChroma(inn, b0, b1);
  if (!ca || !cb) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < 12; i++) { dot += ca[i] * cb[i]; na += ca[i] * ca[i]; nb += cb[i] * cb[i]; }
  return na > 0 && nb > 0 ? r3(clamp01(dot / Math.sqrt(na * nb))) : null;
}

/** Mean 4-band profile { sub, punch, mid, high, centroid } of a track at time `at` (or over [a, b]). */
export function barProfileAt(track, a, b = a + 0.1) {
  const bf = Array.isArray(track?.barFeatures) ? track.barFeatures : null;
  if (!bf?.length) return null;
  let sub = 0, punch = 0, mid = 0, high = 0, centroid = 0, w = 0;
  for (const bar of bf) {
    const ov = Math.min(b, bar.end) - Math.max(a, bar.start);
    if (ov <= 0) continue;
    sub += (bar.sub || 0) * ov;
    punch += (bar.punch || 0) * ov;
    mid += (bar.mid || 0) * ov;
    high += (bar.high || 0) * ov;
    centroid += (bar.centroid || 0) * ov;
    w += ov;
  }
  if (!(w > 0)) return null;
  return { sub: sub / w, punch: punch / w, mid: mid / w, high: high / w, centroid: centroid / w };
}

/**
 * 16-step rhythmic groove fingerprint (per bar, 16th-note grid) + swing score + 24-dim unit embedding
 * consumed directly by smartmix.soundSimilarity(a, b).
 */
export function computeGrooveAndEmbedding(mono, sr, bpm, downbeat = 0, barFeatures = [], vocalMap = null) {
  const steps16 = new Float32Array(16);
  let swing = 0;
  if (bpm > 0 && mono?.length > sr * 4) {
    const stepSec = 15 / bpm; // 1/16th note
    const stepFrames = Math.max(16, Math.floor(stepSec * sr));
    const startFrame = Math.max(0, Math.floor(downbeat * sr));
    const maxFrames = Math.min(mono.length, startFrame + Math.floor(sr * 120)); // up to 2 min body
    const counts = new Float32Array(16);
    let prevRms = 0;
    for (let f = startFrame, idx = 0; f + stepFrames <= maxFrames; f += stepFrames, idx++) {
      let e = 0;
      for (let i = f; i < f + stepFrames; i += 4) { const x = mono[i]; e += x * x; }
      const rms = Math.sqrt(e / (stepFrames / 4));
      const onset = Math.max(0, rms - prevRms * 0.7);
      prevRms = rms;
      const st = idx & 15;
      steps16[st] += onset;
      counts[st]++;
    }
    let mx = 1e-9;
    for (let i = 0; i < 16; i++) { steps16[i] /= Math.max(1, counts[i]); if (steps16[i] > mx) mx = steps16[i]; }
    for (let i = 0; i < 16; i++) steps16[i] = r2(steps16[i] / mx);
    // Swing: ratio of off-beat 16th energy (steps 3,7,11,15) vs straight 8th off-beats (2,6,10,14)
    const straight = steps16[2] + steps16[6] + steps16[10] + steps16[14];
    const swung = steps16[3] + steps16[7] + steps16[11] + steps16[15];
    swing = r2(clamp01(swung / (straight + swung + 1e-6)));
  }

  // Aggregate spectral balance & variance from barFeatures
  let subM = 0, punchM = 0, midM = 0, highM = 0, centM = 0, eVar = 0;
  if (barFeatures.length) {
    const es = [];
    for (const b of barFeatures) {
      subM += b.sub; punchM += b.punch; midM += b.mid; highM += b.high; centM += b.centroid;
      es.push(0.35 * b.sub + 0.25 * b.punch + 0.25 * b.mid + 0.15 * b.high);
    }
    const n = barFeatures.length;
    subM /= n; punchM /= n; midM /= n; highM /= n; centM /= n;
    const meanE = es.reduce((a, b) => a + b, 0) / n;
    eVar = Math.sqrt(es.reduce((a, x) => a + (x - meanE) ** 2, 0) / n);
  }
  let vocMean = 0;
  if (vocalMap?.length) {
    for (let i = 0; i < vocalMap.length; i++) vocMean += vocalMap[i];
    vocMean /= vocalMap.length;
  }

  // 24-dim unit-normalized audio fingerprint vector
  const rawVec = [
    ...Array.from(steps16), // 16 rhythmic steps
    bpm ? clamp01((Math.log2(bpm) - Math.log2(70)) / (Math.log2(180) - Math.log2(70))) : 0.5,
    subM, punchM, midM, highM, centM, clamp01(eVar * 2.5), vocMean,
  ];
  let norm = 0;
  for (const v of rawVec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  const embedding = rawVec.map((v) => r3(v / norm));
  return { groove: { steps: Array.from(steps16), swing }, embedding };
}

/**
 * Elastic beatgrid (tempoMap) detector for live-drummed / tempo-drifting tracks.
 * Tracks local beat-onset drift across 8-second windows; returns null for steady electronic grids (drift < 1.2%),
 * or an ordered array of warp anchors [{ time, bpm, beat }] when real tempo drift is detected.
 */
export function detectElasticGrid(mono, sr, globalBpm, gridOffset = 0) {
  if (!(globalBpm > 0) || !mono?.length) return null;
  const dur = mono.length / sr;
  if (dur < 20) return null;
  const hop = 256;
  const fps = sr / hop;
  const n = Math.floor(mono.length / hop);
  const env = new Float32Array(n);
  const a = onePole(150, sr);
  let lp = 0, prev = 0;
  for (let k = 0; k < n; k++) {
    let e = 0;
    for (let i = k * hop, end = i + hop; i < end; i++) { const x = mono[i]; lp += a * (x - lp); e += lp * lp; }
    const l = Math.log1p(e * 1000);
    env[k] = Math.max(0, l - prev);
    prev = l;
  }

  const winSec = 8, stepSec = 4;
  const beat0 = 60 / globalBpm;
  const localBpms = [];
  for (let t0 = 0; t0 + winSec <= dur; t0 += stepSec) {
    const i0 = Math.floor(t0 * fps), i1 = Math.min(n, Math.floor((t0 + winSec) * fps));
    // Search local BPM within ±6% of globalBpm
    let bestB = globalBpm, bestS = -1;
    for (let b = globalBpm * 0.94; b <= globalBpm * 1.06; b += 0.2) {
      const P = (fps * 60) / b;
      const bins = 32;
      const h = new Float32Array(bins);
      let sum = 0;
      for (let k = i0; k < i1; k++) { const ph = (k / P) % 1; h[Math.floor(ph * bins)] += env[k]; sum += env[k]; }
      let mx = 0;
      for (let j = 0; j < bins; j++) if (h[j] > mx) mx = h[j];
      const sc = mx / (sum / bins + 1e-9);
      if (sc > bestS) { bestS = sc; bestB = b; }
    }
    if (bestS > 2.2) localBpms.push({ time: t0 + winSec / 2, bpm: Math.round(bestB * 100) / 100, score: bestS });
  }
  if (localBpms.length < 3) return null;

  // Check coefficient of variation / max excursion: steady electronic tracks stay null
  const mean = localBpms.reduce((s, x) => s + x.bpm, 0) / localBpms.length;
  const sd = Math.sqrt(localBpms.reduce((s, x) => s + (x.bpm - mean) ** 2, 0) / localBpms.length);
  const maxDiff = Math.max(...localBpms.map((x) => Math.abs(x.bpm - globalBpm) / globalBpm));
  if (sd / mean < 0.012 && maxDiff < 0.018) return null;

  // Build piecewise-linear warp anchors (merge consecutive windows within 0.6 BPM)
  const anchors = [{ time: r3(gridOffset), bpm: localBpms[0].bpm, beat: 0 }];
  for (let i = 1; i < localBpms.length; i++) {
    const prevA = anchors[anchors.length - 1];
    const cur = localBpms[i];
    if (Math.abs(cur.bpm - prevA.bpm) < 0.6) continue;
    const dt = cur.time - prevA.time;
    const dBeats = (dt * prevA.bpm) / 60;
    anchors.push({ time: r3(cur.time), bpm: cur.bpm, beat: r3(prevA.beat + dBeats) });
  }
  return anchors.length >= 2 ? anchors : null;
}

/** Elastic beat index at track time `t` (honors `track.tempoMap`, falls back to constant bpm + gridOffset). */
export function beatAtTime(track, t) {
  const map = Array.isArray(track?.tempoMap) && track.tempoMap.length >= 2 ? track.tempoMap : null;
  if (!map) {
    const bpm = Number(track?.bpm) || 0;
    return bpm > 0 ? ((t - (track?.gridOffset || 0)) * bpm) / 60 : 0;
  }
  let a = map[0];
  for (let i = 1; i < map.length; i++) {
    if (t < map[i].time) break;
    a = map[i];
  }
  return a.beat + ((t - a.time) * a.bpm) / 60;
}

/** Track time (s) for beat index `beat` (inverse of beatAtTime). */
export function timeAtBeat(track, beat) {
  const map = Array.isArray(track?.tempoMap) && track.tempoMap.length >= 2 ? track.tempoMap : null;
  if (!map) {
    const bpm = Number(track?.bpm) || 0;
    return bpm > 0 ? (track?.gridOffset || 0) + (beat * 60) / bpm : 0;
  }
  let a = map[0];
  for (let i = 1; i < map.length; i++) {
    if (beat < map[i].beat) break;
    a = map[i];
  }
  return a.time + ((beat - a.beat) * 60) / a.bpm;
}

/** Local instantaneous BPM at track time `t` (from elastic tempoMap, else track.bpm). */
export function localBpmAt(track, t) {
  const map = Array.isArray(track?.tempoMap) && track.tempoMap.length >= 2 ? track.tempoMap : null;
  if (!map) return Number(track?.bpm) || 0;
  let a = map[0];
  for (let i = 1; i < map.length; i++) {
    if (t < map[i].time) break;
    a = map[i];
  }
  return a.bpm;
}
