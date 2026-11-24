// Objective transition checker (docs/PRO_DJ_AUTOMIX_RESEARCH.md P4.1). Simulates a planned transition from its mixer
// automation (mixLevels) and the two tracks' analysis, and reports what a listener would notice: a loudness bump or
// dip, two basslines at once, vocals on vocals, too much time-stretch, an off-phrase start. Pure and cheap (about a
// hundred samples per plan), so the planner can check every candidate and the preview can show the result.
import { mixLevels, twoBasslines, SWAP_STYLES, doubleDropTrim } from './automix.js';
import { faderGain, isoKnobGain } from './audio/curves.js';

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

/** Vocal presence (0..1) of t at `at` from its per-second vocal map, or null when unmeasured. */
function vocalAt(t, at) {
  const m = t?.vocalMap;
  if (!m?.length) return null;
  const i = Math.floor(at);
  return i >= 0 && i < m.length ? m[i] : 0;
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
  let lowBeats = 0, vocalSec = 0;
  for (let i = 0; i <= steps; i++) {
    const k = i / steps, to = plan.begin + k * len, ti = plan.inStart + k * len * ratio;
    const L = mixLevels(plan.style, k, kSwap != null && k >= kSwap ? kSwap : null);
    const vol = (v, d) => faderGain(v ?? d, 'log');
    const dd = plan.doubleDrop ? doubleDropTrim(k, kSwap) : 1;
    const go = vol((L.outVol ?? 0.8) * dd, 0.8) / faderGain(0.8, 'log'), gi = vol((L.inVol ?? 0) * dd, 0) / faderGain(0.8, 'log');
    const eq = (v) => isoKnobGain(v ?? 0);
    const ao = Math.pow(10, levelAt(out, to) / 20) * go, ai = Math.pow(10, levelAt(inn, ti) / 20) * gi;
    // the low band of beat-matched tracks adds up in phase (amplitudes); mids and highs add as powers
    const low = Math.pow(ao * eq(L.outLow) + ai * eq(L.inLow), 2) * BAND_SHARE[0];
    const mid = (Math.pow(ao * eq(L.outMid), 2) + Math.pow(ai * eq(L.inMid), 2)) * BAND_SHARE[1];
    const high = (Math.pow(ao * eq(L.outHigh), 2) + Math.pow(ai * eq(L.inHigh), 2)) * BAND_SHARE[2];
    const heard = toDb(low + mid + high);
    // what each track would sound like alone right now (its own section loudness, level-matched): the mix should
    // never be much louder than the louder of the two (bump), nor fall well below the line from one to the other (dip)
    const lo = levelAt(out, to), li = levelAt(inn, ti);
    metrics.bumpLu = Math.max(metrics.bumpLu, heard - Math.max(lo, li));
    metrics.dipLu = Math.max(metrics.dipLu, lo + (li - lo) * k - heard);
    if (twoBasslines(L) && go > 0.1 && gi > 0.1) lowBeats += len / steps / beat;
    const vo = vocalAt(out, to), vi = vocalAt(inn, ti);
    if (vo != null && vi != null && vo > 0.5 && vi > 0.5 && go > 0.3 && gi > 0.3 && (L.inMid ?? 0) > -0.5) vocalSec += len / steps;
  }
  metrics.lowOverlapBeats = Math.round(lowBeats * 10) / 10;
  metrics.vocalOverlapSec = Math.round(vocalSec * 10) / 10;
  metrics.bumpLu = Math.round(metrics.bumpLu * 10) / 10; metrics.dipLu = Math.round(metrics.dipLu * 10) / 10;
  if (out?.bpm && inn?.bpm) {
    const r = (out.bpm * (plan.rate || 1)) / inn.bpm, best = [r, r * 2, r / 2].reduce((a, b) => (Math.abs(Math.log(b)) < Math.abs(Math.log(a)) ? b : a));
    metrics.stretchPct = Math.round(Math.abs(best - 1) * 1000) / 10;
  }
  let penalty = 0;
  if (metrics.bumpLu > limits.bumpLu) { issues.push(`level bump ${metrics.bumpLu} LU`); penalty += (metrics.bumpLu - limits.bumpLu) * 1.5; }
  if (metrics.dipLu > limits.dipLu) { issues.push(`level dip ${metrics.dipLu} LU`); penalty += (metrics.dipLu - limits.dipLu) * 1.5; }
  if (metrics.lowOverlapBeats > limits.lowOverlapBeats) { issues.push('two basslines'); penalty += 3; }
  if (metrics.vocalOverlapSec > limits.vocalOverlapSec) { issues.push(`vocals overlap ${metrics.vocalOverlapSec} s`); penalty += Math.min(6, metrics.vocalOverlapSec - limits.vocalOverlapSec); }
  if (metrics.stretchPct > limits.stretchPct) { issues.push(`stretched ${metrics.stretchPct} %`); penalty += (metrics.stretchPct - limits.stretchPct) * 0.5; }
  return { ok: !issues.length, issues, penalty: Math.round(penalty * 10) / 10, metrics };
}
