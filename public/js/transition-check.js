// Objective transition checker (docs/PRO_DJ_AUTOMIX_RESEARCH.md P4.1). Simulates a planned transition from its mixer
// automation (mixLevels) and the two tracks' analysis, and reports what a listener would notice: a loudness bump or
// dip, two basslines at once, vocals on vocals, too much time-stretch, an off-phrase start. Pure and cheap (about a
// hundred samples per plan), so the planner can check every candidate and the preview can show the result.
import { mixLevels, twoBasslines, SWAP_STYLES, doubleDropTrim } from './automix.js';
import { faderGain, isoKnobGain } from './audio/curves.js';
import { barProfileAt, localChromaSimilarity } from './audio/features.js';
import { decodeVocalMap } from './shared/vocal-map.js';
import { loudnessProfile, sectionLoudness } from './audio/loudness.js';

/** Starting thresholds (research §4 of 03-systems-mir.md). */
export const CHECK_LIMITS = Object.freeze({ bumpLu: 2, dipLu: 3, lowOverlapBeats: 1, vocalOverlapSec: 2, stretchPct: 5 });

/** Share of a dance track's loudness power per band (low < 200 Hz, mid, high > 2.5 kHz): a typical club mix. */
const BAND_SHARE = [0.45, 0.4, 0.15];

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const toDb = (p) => 10 * Math.log10(Math.max(1e-12, p));

/** Heard loudness (LUFS) of a track section around `at`, after level matching; falls back to the track level. */
function levelAt(t, at) {
  const p = (Array.isArray(t?.phrases) ? t.phrases : []).find((x) => at >= x.start - 0.05 && at < x.end);
  const base = finite(p?.lufs) ? p.lufs : finite(t?.mainLufs) ? t.mainLufs : finite(t?.lufs) ? t.lufs : -14 - (Number(t?.gain) || 0);
  return base + (Number(t?.gain) || 0);
}

const vocalMapCache = new WeakMap();
/** Vocal presence (0..1) of t at `at` from its stem or DSP vocal map, or null when unmeasured. */
function vocalAt(t, at) {
  if (!t) return null;
  let m = t.vocalMap;
  if (!m?.length) {
    if (vocalMapCache.has(t)) m = vocalMapCache.get(t);
    else { m = decodeVocalMap(t.stems?.vocals) || decodeVocalMap(t.vocalMapAuto) || null; vocalMapCache.set(t, m); }
  }
  if (!m?.length) return null;
  const i = Math.floor(at);
  return i >= 0 && i < m.length ? m[i] : 0;
}

/** Per-band power share [low, mid, high] at time `at` from measured barFeatures, else typical club mix. */
function bandShareAt(t, at) {
  const p = barProfileAt(t, at, at + 0.25);
  if (!p) return BAND_SHARE;
  const lo = p.sub * p.sub + p.punch * p.punch, mi = p.mid * p.mid, hi = p.high * p.high;
  const tot = lo + mi + hi;
  return tot > 1e-6 ? [lo / tot, mi / tot, hi / tot] : BAND_SHARE;
}

/**
 * Check a blend: out / inn are the analysed tracks (phrases with lufs, gain, vocalMap, bpm), plan: { style, begin,
 * len (outgoing seconds), inStart (incoming seconds), ratio (incoming seconds per outgoing second), kSwap (0..1) }.
 * @returns {{ ok: boolean, issues: string[], penalty: number, metrics: { bumpLu, dipLu, lowOverlapBeats, vocalOverlapSec, stretchPct } }}
 */
export function checkTransition(out, inn, plan, limits = CHECK_LIMITS) {
  const issues = [];
  const metrics = { bumpLu: 0, dipLu: 0, lowOverlapBeats: 0, vocalOverlapSec: 0, stretchPct: 0 };
  const len = Number(plan?.len) || 0;
  if (!(len > 0) || !plan?.style) return { ok: true, issues, penalty: 0, metrics };
  const ratio = finite(plan.ratio) && plan.ratio > 0 ? plan.ratio : 1;
  const kSwap = finite(plan.kSwap) ? plan.kSwap : SWAP_STYLES.has(plan.style) || plan.style === 'blend' ? 0.5 : null;
  const beat = out?.bpm ? 60 / out.bpm : 0.5;
  const steps = Math.max(32, Math.min(256, Math.round(len / beat)));
  const invRefGain = 1 / faderGain(0.8, 'log');
  let lowBeats = 0, vocalSec = 0;
  for (let i = 0; i <= steps; i++) {
    const k = i / steps, to = plan.begin + k * len, ti = plan.inStart + k * len * ratio;
    const L = mixLevels(plan.style, k, kSwap != null && k >= kSwap ? kSwap : null);
    const dd = plan.doubleDrop ? doubleDropTrim(k, kSwap) : 1;
    const go = faderGain((L.outVol ?? 0.8) * dd, 'log') * invRefGain, gi = faderGain((L.inVol ?? 0) * dd, 'log') * invRefGain;
    const lo = levelAt(out, to), li = levelAt(inn, ti);
    const ao = Math.pow(10, lo / 20) * go, ai = Math.pow(10, li / 20) * gi;
    // Per-bar measured spectral shares when available (falls back to typical club mix)
    const bsO = bandShareAt(out, to), bsI = bandShareAt(inn, ti);
    // the low band of beat-matched tracks adds up in phase (amplitudes); mids and highs add as powers
    const lowAmp = ao * Math.sqrt(bsO[0]) * isoKnobGain(L.outLow ?? 0) + ai * Math.sqrt(bsI[0]) * isoKnobGain(L.inLow ?? 0);
    const midO = ao * isoKnobGain(L.outMid ?? 0), midI = ai * isoKnobGain(L.inMid ?? 0);
    const hiO = ao * isoKnobGain(L.outHigh ?? 0), hiI = ai * isoKnobGain(L.inHigh ?? 0);
    const low = lowAmp * lowAmp;
    const mid = midO * midO * bsO[1] + midI * midI * bsI[1];
    const high = hiO * hiO * bsO[2] + hiI * hiI * bsI[2];
    const heard = toDb(low + mid + high);
    // what each track would sound like alone right now (its own section loudness, level-matched): the mix should
    // never be much louder than the louder of the two (bump), nor fall well below the line from one to the other (dip)
    metrics.bumpLu = Math.max(metrics.bumpLu, heard - Math.max(lo, li));
    metrics.dipLu = Math.max(metrics.dipLu, lo + (li - lo) * k - heard);
    if (twoBasslines(L) && go > 0.1 && gi > 0.1) lowBeats += len / steps / beat;
    const vo = vocalAt(out, to), vi = vocalAt(inn, ti);
    if (vo != null && vi != null && vo > 0.5 && vi > 0.5 && go > 0.3 && gi > 0.3 && (L.inMid ?? 0) > -0.5) vocalSec += len / steps;
  }
  metrics.lowOverlapBeats = Math.round(lowBeats * 10) / 10;
  metrics.vocalOverlapSec = Math.round(vocalSec * 10) / 10;
  metrics.bumpLu = Math.round(metrics.bumpLu * 10) / 10; metrics.dipLu = Math.round(metrics.dipLu * 10) / 10;
  metrics.chromaSim = plan.chromaSim !== undefined
    ? plan.chromaSim
    : localChromaSimilarity(out, plan.begin, plan.begin + len, inn, plan.inStart, plan.inStart + len * ratio);
  if (out?.bpm && inn?.bpm) {
    const r = (out.bpm * (plan.rate || 1)) / inn.bpm, best = [r, r * 2, r / 2].reduce((a, b) => (Math.abs(Math.log(b)) < Math.abs(Math.log(a)) ? b : a));
    metrics.stretchPct = Math.round(Math.abs(best - 1) * 1000) / 10;
  }
  let penalty = 0;
  if (metrics.bumpLu > limits.bumpLu) { issues.push(`level bump ${metrics.bumpLu} LU`); penalty += (metrics.bumpLu - limits.bumpLu) * 1.5; }
  if (metrics.dipLu > limits.dipLu) { issues.push(`level dip ${metrics.dipLu} LU`); penalty += (metrics.dipLu - limits.dipLu) * 1.5; }
  if (metrics.lowOverlapBeats > limits.lowOverlapBeats) { issues.push('two basslines'); penalty += 3; }
  if (metrics.vocalOverlapSec > limits.vocalOverlapSec) { issues.push(`vocals overlap ${metrics.vocalOverlapSec} s`); penalty += Math.min(6, metrics.vocalOverlapSec - limits.vocalOverlapSec); }
  if (metrics.chromaSim != null && metrics.chromaSim < 0.42) { issues.push(`harmonic clash (${Math.round(metrics.chromaSim * 100)}%)`); penalty += (0.42 - metrics.chromaSim) * 8; }
  if (metrics.stretchPct > limits.stretchPct) { issues.push(`stretched ${metrics.stretchPct} %`); penalty += (metrics.stretchPct - limits.stretchPct) * 0.5; }
  return { ok: !issues.length, issues, penalty: Math.round(penalty * 10) / 10, metrics };
}

/**
 * Real-PCM objective quality check on a rendered transition AudioBuffer (or { left, right, sampleRate }):
 * measures actual BS.1770 short-term loudness bump/dip across pre -> overlap -> post, dead-air gaps (>250 ms below
 * -50 dBFS), and peak clipping (> -0.2 dBFS).
 */
export function checkRenderedAudio(audio, { preSec = 4, spanSec = 8, limits = CHECK_LIMITS } = {}) {
  const left = typeof audio?.getChannelData === 'function' ? audio.getChannelData(0) : audio?.left;
  const right = typeof audio?.getChannelData === 'function' ? (audio.numberOfChannels > 1 ? audio.getChannelData(1) : left) : (audio?.right || left);
  const sr = audio?.sampleRate || 44100;
  if (!left?.length) return { ok: true, issues: [], metrics: { bumpLu: 0, dipLu: 0, deadAirMs: 0, peakDb: -Infinity } };
  const n = left.length, dur = n / sr;
  const mono = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const l = left[i], r = right[i] ?? l;
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > peak) peak = a;
    mono[i] = (l + r) * 0.5;
  }
  const peakDb = Math.round(20 * Math.log10(Math.max(1e-9, peak)) * 10) / 10;

  // Dead-air scan in 50 ms blocks (< -50 dBFS RMS)
  const blk = Math.max(1, Math.round(0.05 * sr));
  const silThr = Math.pow(10, -50 / 20);
  let runSil = 0, maxSil = 0;
  for (let i = 0; i + blk <= n; i += blk) {
    let e = 0;
    for (let j = i; j < i + blk; j++) e += mono[j] * mono[j];
    if (Math.sqrt(e / blk) < silThr) { runSil += 50; if (runSil > maxSil) maxSil = runSil; }
    else runSil = 0;
  }

  // Real BS.1770 short-term loudness: compare 3 s windows across the overlap against pre / post reference
  const prof = loudnessProfile(mono, sr);
  const [preL, postL] = sectionLoudness(prof, sr, [
    { start: 0, end: Math.max(0.5, preSec) },
    { start: Math.min(dur - 0.5, preSec + spanSec), end: dur },
  ]);
  let bumpLu = 0, dipLu = 0;
  if (Number.isFinite(preL) && Number.isFinite(postL) && spanSec >= 1) {
    const win = Math.min(3, spanSec);
    const secs = [];
    for (let t = preSec; t + win <= preSec + spanSec + 0.01; t += 0.5) secs.push({ start: t, end: t + win, k: (t + win / 2 - preSec) / spanSec });
    const vals = sectionLoudness(prof, sr, secs);
    vals.forEach((v, idx) => {
      if (!Number.isFinite(v)) return;
      const k = clamp01(secs[idx].k);
      bumpLu = Math.max(bumpLu, v - Math.max(preL, postL));
      dipLu = Math.max(dipLu, preL + (postL - preL) * k - v);
    });
  }
  bumpLu = Math.round(bumpLu * 10) / 10;
  dipLu = Math.round(dipLu * 10) / 10;
  const issues = [];
  if (bumpLu > limits.bumpLu) issues.push(`rendered loudness bump +${bumpLu} LU`);
  if (dipLu > limits.dipLu) issues.push(`rendered loudness dip -${dipLu} LU`);
  if (maxSil > 250) issues.push(`dead air ${maxSil} ms`);
  if (peakDb > -0.2) issues.push(`peak ${peakDb} dBFS`);
  return { ok: !issues.length, issues, metrics: { bumpLu, dipLu, deadAirMs: maxSil, peakDb } };
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));
