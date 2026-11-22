// Bounded, deterministic section search. No decoding, network, models, or PCM on the playback thread.
import { planBestTransition, vocalsBetween } from './mix-planner.js';
import { planTransition, incomingStart, DROP_STYLES } from './automix.js';
import { camelotRelation } from './smartmix.js';
import { decodeVocalMap } from './shared/vocal-map.js';

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const endOf = (t) => Math.min(t.duration, finite(t.endTime) && t.endTime > 0 ? t.endTime : t.duration);
const barOf = (t) => finite(t.bpm) && t.bpm > 0 ? 240 / t.bpm : 2;
const anchor = (t) => t.downbeat ?? t.gridOffset ?? 0;
const snap = (t, x) => anchor(t) + Math.round((x - anchor(t)) / barOf(t)) * barOf(t);
const sections = (t) => (Array.isArray(t.phrases) ? t.phrases : [])
  .filter((p) => finite(p.start) && finite(p.end) && p.end > p.start)
  .slice(0, 200).sort((a, b) => a.start - b.start);
const spread = (points, limit = 8) => points.length <= limit ? points :
  Array.from({ length: limit }, (_, i) => points[Math.round(i * (points.length - 1) / (limit - 1))]);

function localEnergy(t, a, b) {
  let sum = 0, weight = 0;
  for (const p of sections(t)) {
    const overlap = Math.max(0, Math.min(b, p.end) - Math.max(a, p.start));
    // Phrase detector energy is normalised 0..1; library energy is 1..10.
    if (finite(p.energy)) { sum += overlap * clamp(p.energy, 0, 1) * 10; weight += overlap; }
  }
  return weight ? sum / weight : finite(t.energy) ? t.energy : 5;
}

/** Track-time window search across section boundaries, not just intro/outro.
 * position/entry are outgoing track seconds. Returns null when timing is unusable.
 * Explicit low beat confidence forbids tempo-matched overlaps; legacy grids remain usable.
 */
export function planAdaptiveTransition(out, inn, opts = {}) {
  if (!out || !inn || !finite(out.duration) || !finite(inn.duration) || out.duration <= 0 || inn.duration <= 0) return null;
  // Decode measured vocals once per search, rather than once per style/length/window.
  out = { ...out, vocalMap: out.vocalMap || decodeVocalMap(out.stems?.vocals) };
  inn = { ...inn, vocalMap: inn.vocalMap || decodeVocalMap(inn.stems?.vocals) };
  const outSections = sections(out), inSections = sections(inn);
  const position = finite(opts.position) ? Math.max(0, opts.position) : 0;
  const minTime = Math.max(position + barOf(out) * 2, (opts.entry || 0) + Math.max(32, barOf(out) * 16));
  const earliest = anchor(out) + Math.ceil((minTime - anchor(out)) / barOf(out) - 1e-6) * barOf(out);
  const end = endOf(out), inEnd = endOf(inn);
  const rate = finite(opts.rate) && opts.rate > 0 ? opts.rate : 1;
  const rawRatio = out.bpm * rate / inn.bpm;
  // Mirror Deck.syncTargetRatio: matching half/double BPM does not double the audio's playback speed.
  const ratio = [rawRatio, rawRatio * 2, rawRatio / 2].reduce((a, b) => Math.abs(Math.log(b)) < Math.abs(Math.log(a)) ? b : a);
  const lowConfidence = [out, inn].some((t) => !t.bpmLocked && !t.gridLocked && finite(t.bpmConfidence) && t.bpmConfidence < 0.35);
  const noOverlap = lowConfidence || opts.keepSync === false || !out.bpm || !inn.bpm || Math.abs(Math.log(ratio)) > Math.log(1.08);
  const styles = noOverlap ? (opts.styles || ['echo', 'cut', 'reverb']).filter((s) => ['echo', 'cut', 'reverb'].includes(s)) : opts.styles;
  if (styles && !styles.length) return null;
  // Include the original endpoints as fallbacks; cap both axes independently of library/track size.
  const lastBar = anchor(out) + Math.floor((end - anchor(out)) / barOf(out) + 1e-6) * barOf(out);
  const exits = [...new Set([lastBar, ...outSections.map((p) => snap(out, p.end))])]
    .filter((x) => x > earliest && x <= end + 1e-6).sort((a, b) => a - b);
  const boundedExits = spread(exits);
  const allEntries = [...new Set([incomingStart(inn), ...inSections.map((p) => snap(inn, p.start))])]
    .filter((x) => x >= (inn.startTime || 0) && x < inEnd - Math.max(16, barOf(inn) * 8));
  const entries = spread(allEntries);
  let best = null, evaluated = 0;
  for (const exit of boundedExits) for (const cue of entries) {
    const remainingBars = Math.floor((exit - earliest) / barOf(out) + 1e-6);
    if (remainingBars < 1) continue;
    const section = outSections.find((p) => p.end >= exit - 0.01 && p.start < exit);
    const o = { ...out, duration: exit, endTime: exit, mixOut: Math.max(earliest, section ? snap(out, section.start) : earliest),
      phrases: outSections.filter((p) => p.start < exit).map((p) => ({ ...p, end: Math.min(exit, p.end) })) };
    const n = { ...inn, mixIn: cue, phrases: inSections.filter((p) => p.end > cue) };
    const candidateBars = [remainingBars, ...inSections.filter((p) => p.start <= cue && p.end > cue).map((p) => Math.floor((p.end - cue) / barOf(inn)))];
    let p = planBestTransition(o, n, { ...opts, candidateBars, styles, keySync: false });
    let timing = planTransition(o, p.style, { transitionBeats: p.beats, skipSilence: true });
    const drop = DROP_STYLES.has(p.style);
    if (!drop) {
      const bars = Math.min(p.bars, remainingBars, Math.floor(timing.len / barOf(out) + 1e-6));
      if (bars < 4 || (opts.fixedBars && bars !== opts.fixedBars)) continue;
      const len = bars * barOf(out), start = exit - len;
      timing = { ...timing, begin: start, start, len, end: exit };
      p = { ...p, bars, beats: bars * 4, lengthWhy: `${bars} bars (section fit)` };
    }
    const finish = drop ? timing.drop : timing.start + timing.len;
    const inSpan = drop ? 0 : timing.len * ratio / rate;
    if (timing.begin < earliest - 1e-6 || finish > end + 1e-6 || cue + inSpan > inEnd - 2) continue;
    const vo = vocalsBetween(out, timing.begin, finish), vi = vocalsBetween(inn, cue, cue + Math.max(2, inSpan));
    const eo = localEnergy(out, timing.begin, finish), ei = localEnergy(inn, cue, cue + Math.max(2, inSpan));
    const harmonic = camelotRelation(out.key, inn.key);
    // Compare actual windows. Holding quick-stem vocals is not treated as perfect source separation.
    const vocalCost = drop ? vo.v * 2 : Math.min(vo.v, vi.v) * (p.style === 'stemswap' ? 2 : 12);
    const clashCost = !drop && harmonic.kind === 'clash' ? Math.min(8, inSpan / 4) : 0;
    const score = p.score - vocalCost - clashCost - Math.abs(ei - eo) * 0.7
      - (exit - earliest) / Math.max(1, end - earliest) * 1.5 - cue / inEnd * 0.5;
    evaluated++;
    if (!best || score > best.score) best = { ...p, score, timing, inStart: cue,
      vocals: !drop && !['stemswap', 'crossfade'].includes(p.style) && Math.min(vo.v, vi.v) > 0.2 ? 'hold-in' : null,
      confidence: lowConfidence ? 'low' : vo.known && vi.known ? 'measured-vocals' : 'estimated',
      why: `${p.why}; section search: ${timing.begin.toFixed(1)}s → ${cue.toFixed(1)}s${lowConfidence ? '; uncertain grid: no beat-matched overlap' : ''}` };
  }
  return best && { ...best, evaluated };
}
