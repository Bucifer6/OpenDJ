// Bounded, deterministic section search. No decoding, network, models, or PCM on the playback thread.
import { planBestTransition, vocalsBetween } from './mix-planner.js';
import { planTransition, incomingStart, DROP_STYLES } from './automix.js';
import { camelotRelation } from './smartmix.js';
import { decodeVocalMap } from './shared/vocal-map.js';
import { pairFamily } from './dj-styles.js';
import { checkTransition } from './transition-check.js';

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
/** Share of a track (from where it came in) that plays before the next transition may begin. */
export const MIN_PLAY = 0.6;
/** ...and at least this long (seconds) when the track has that much left. */
export const MIN_PLAY_SECONDS = 90;
/** Latest point (share of the incoming track) it may come in at, when its intro would clash. */
export const MAX_CUE = 0.25;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const endOf = (t) => Math.min(t.duration, finite(t.endTime) && t.endTime > 0 ? t.endTime : t.duration);
const barOf = (t) => finite(t.bpm) && t.bpm > 0 ? 240 / t.bpm : 2;
const anchor = (t) => t.downbeat ?? t.gridOffset ?? 0;
const snap = (t, x) => anchor(t) + Math.round((x - anchor(t)) / barOf(t)) * barOf(t);
const sections = (t) => (Array.isArray(t.phrases) ? t.phrases : [])
  .filter((p) => finite(p.start) && finite(p.end) && p.end > p.start)
  .slice(0, 200).sort((a, b) => a.start - b.start);
/** Phrase grid (P1.1): 8-bar lines from the analysed phrase anchor, else from the first downbeat. */
const PHRASE_BARS = 8;
const phraseAnchor = (t) => (finite(t.phraseAnchor) ? t.phraseAnchor : anchor(t));
const phraseTrusted = (t) => !finite(t.phraseConfidence) || t.phraseConfidence >= 0.3;
/** Distance (bars) from x to the nearest phrase line of t. */
export function offPhraseBars(t, x) {
  const ph = barOf(t) * PHRASE_BARS, d = (x - phraseAnchor(t)) / ph;
  return Math.abs(d - Math.round(d)) * PHRASE_BARS;
}
/** Snap x to the nearest phrase line when within a bar of it (trusted grids), else to the nearest bar. */
const snapPhrase = (t, x) => {
  const b = snap(t, x);
  if (!phraseTrusted(t)) return b;
  const ph = barOf(t) * PHRASE_BARS, line = phraseAnchor(t) + Math.round((b - phraseAnchor(t)) / ph) * ph;
  return Math.abs(line - b) <= barOf(t) + 1e-6 ? line : b;
};
const MAIN = new Set(['drop', 'verse', 'chorus', 'buildup']);
/** Start of the incoming track's first main section at or after `cue` (its "landing"), or null. */
export function landingAfter(t, cue) {
  const p = sections(t).find((x) => MAIN.has(x.type) && x.start >= cue - 0.05);
  return p ? p.start : null;
}
const pairHash = (a, b) => { let h = 2166136261; for (const c of `${a}>${b}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return Math.abs(h); };
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

/** Track-time window search across section boundaries near the outgoing outro and the incoming intro.
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
  const entry = finite(opts.entry) ? Math.max(0, opts.entry) : 0;
  const end = endOf(out), inEnd = endOf(inn);
  // Like a DJ: the outgoing track plays most of what is left from where it came in (MIN_PLAY of it, at least
  // MIN_PLAY_SECONDS when the track has that much) before a transition may begin; minPlay lowers it (tests, MCP).
  const share = finite(opts.minPlay) ? clamp(opts.minPlay, 0, 1) : MIN_PLAY;
  const left = Math.max(0, end - entry);
  const played = Math.min(left * 0.9, Math.max(left * share, share > 0 ? Math.min(MIN_PLAY_SECONDS, left * 0.8) : 0));
  const minTime = Math.max(position + barOf(out) * 2, entry + Math.max(Math.min(32, left * 0.5), played));
  const earliest = anchor(out) + Math.ceil((minTime - anchor(out)) / barOf(out) - 1e-6) * barOf(out);
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
  const exits = [...new Set([lastBar, ...outSections.map((p) => snapPhrase(out, p.end))])]
    .filter((x) => x > earliest && x <= end + 1e-6).sort((a, b) => a - b);
  // double drops (P2.3, drum & bass / dubstep): an exit 16 bars into each outgoing drop, so the incoming drop can hit
  // together with it
  const family = pairFamily(out, inn);
  const ddExits = family === 'bass' ? outSections.filter((p) => p.type === 'drop').map((p) => snapPhrase(out, p.start + 16 * barOf(out)))
    .filter((x) => x > earliest && x <= end + 1e-6 && !exits.includes(x)) : [];
  const boundedExits = [...spread(exits), ...ddExits.slice(0, 2)];
  // The incoming track comes in on its intro / mix-in point, or a section start in its first quarter (MAX_CUE), so
  // most of it is still to come; never a section deep inside it.
  const home = incomingStart(inn);
  const cueLimit = Math.max(home, (inn.startTime || 0) + (inEnd - (inn.startTime || 0)) * (finite(opts.maxCue) ? clamp(opts.maxCue, 0, 1) : MAX_CUE));
  // landing cues (P1.3): start the incoming track whole phrases before its first main part, so that part lands
  // exactly where the outgoing track changes section (the classic "drop on the break")
  const land = landingAfter(inn, home);
  const landingCues = land == null ? [] : [4, 8, 16, 32].map((b) => land - b * barOf(inn)).filter((x) => x >= home - 0.05);
  const allEntries = [...new Set([home, ...inSections.map((p) => snapPhrase(inn, p.start)), ...landingCues])]
    .filter((x) => x >= (inn.startTime || 0) && x <= cueLimit + 1e-6 && x < inEnd - Math.max(16, barOf(inn) * 8));
  const landSet = new Set(landingCues);
  const entries = [...spread(allEntries.filter((x) => !landSet.has(x)), 8), ...allEntries.filter((x) => landSet.has(x))];
  let best = null, ddBest = null, evaluated = 0;
  for (const exit of boundedExits) for (const cue of entries) {
    const remainingBars = Math.floor((exit - earliest) / barOf(out) + 1e-6);
    if (remainingBars < 1) continue;
    const section = outSections.find((p) => p.end >= exit - 0.01 && p.start < exit);
    // a double-drop exit sits inside a drop: its window may start in the section before it (the incoming intro
    // plays under the outgoing breakdown / build)
    const dd = ddExits.includes(exit);
    const o = { ...out, duration: exit, endTime: exit, mixOut: Math.max(earliest, dd ? exit - 48 * barOf(out) : section ? snap(out, section.start) : earliest),
      phrases: outSections.filter((p) => p.start < exit).map((p) => ({ ...p, end: Math.min(exit, p.end) })) };
    const n = { ...inn, mixIn: cue, phrases: inSections.filter((p) => p.end > cue) };
    const landing = landingAfter(inn, cue);
    const landBars = landing == null ? null : Math.round((landing - cue) / barOf(inn));
    const candidateBars = [remainingBars, ...inSections.filter((p) => p.start <= cue && p.end > cue).map((p) => Math.floor((p.end - cue) / barOf(inn))), ...(landBars >= 4 ? [landBars] : []), ...(family === 'bass' && landBars >= 4 ? [landBars + 16] : [])];
    const ddBars = dd && landBars >= 4 && !opts.fixedBars && (!styles || styles.includes('blend')) ? landBars + 16 : null;
    if (dd && !ddBars) continue;
    let p = planBestTransition(o, n, { ...opts, candidateBars, keySync: false, ...(ddBars ? { styles: ['blend'], fixedBars: ddBars } : { styles }) });
    let timing = planTransition(o, p.style, { transitionBeats: p.beats, skipSilence: true });
    const drop = DROP_STYLES.has(p.style);
    if (!drop) {
      const bars = Math.min(p.bars, remainingBars, Math.floor(timing.len / barOf(out) + 1e-6));
      if (bars < 4 || ((opts.fixedBars || ddBars) && bars !== (opts.fixedBars || ddBars))) continue;
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
    // music left unplayed in the outgoing track, and the incoming intro skipped, both cost: a DJ mixes out late and
    // in early, and only moves off those points to avoid two voices or a bad key / energy match
    const unplayed = (end - exit) / Math.max(1, left), skipped = Math.max(0, cue - home) / Math.max(1, inEnd);
    // phrasing (P1.1 / P1.3): a blend starts on an outgoing phrase line, and the incoming main part should land on the
    // outgoing exit (the end of the overlap) rather than somewhere inside it
    let phrasing = 0, landed = false;
    if (!drop && phraseTrusted(out)) phrasing -= Math.min(3, offPhraseBars(out, timing.begin) * 0.75);
    if (!drop && landing != null) {
      const miss = Math.abs(cue + inSpan - landing) / barOf(inn);
      if (miss < 0.25) { phrasing += 3; landed = true; }
      else if (landing < cue + inSpan) phrasing -= Math.min(2, (cue + inSpan - landing) / barOf(inn) * 0.15); // lands mid-overlap: two main parts at once
    }
    // double drop: the incoming drop hits exactly on an outgoing drop, keys and tempo tight, at high energy
    let doubleDrop = false;
    if (!drop && family === 'bass' && landing != null && !landed && landing < cue + inSpan - 4 * barOf(inn)) {
      const tLand = timing.begin + (landing - cue) * rate / ratio;
      const hit = outSections.some((q) => q.type === 'drop' && Math.abs(q.start - tLand) < barOf(out) * 0.25);
      const measuredClash = vo.known && vi.known && Math.min(vo.v, vi.v) > 0.3;
      if (hit && !measuredClash && harmonic.value >= 0.8 && Math.abs(Math.log(ratio)) <= Math.log(1.02) && Math.min(eo, ei) >= 6 && !opts.recent?.includes('doubledrop')) doubleDrop = true;
    }
    // objective check of the simulated blend (P4.1): loudness bump / dip, two basslines, vocals on vocals, stretch
    const check = drop ? null : checkTransition(out, inn, { style: p.style, begin: timing.begin, len: timing.len, inStart: cue, ratio: ratio / rate, rate });
    if (check) phrasing -= check.penalty;
    const score = p.score - vocalCost - clashCost - Math.abs(ei - eo) * 0.7 - unplayed * 6 - skipped * 8 + phrasing;
    evaluated++;
    if (doubleDrop) {
      // kept aside: a double drop is a peak-time move, not something to score against ordinary blends
      if (!ddBest || score > ddBest.score) ddBest = { ...p, score, timing, inStart: cue, vocals: null, landed: false, landing, doubleDrop: true, swapIn: landing, check,
        confidence: lowConfidence ? 'low' : vo.known && vi.known ? 'measured-vocals' : 'estimated',
        why: `double drop: both drops hit together, one bassline; section search: ${timing.begin.toFixed(1)}s → ${cue.toFixed(1)}s` };
      continue;
    }
    if (!best || score > best.score) best = { ...p, score, timing, inStart: cue,
      vocals: !drop && !['stemswap', 'crossfade'].includes(p.style) && Math.min(vo.v, vi.v) > 0.2 ? 'hold-in' : null,
      confidence: lowConfidence ? 'low' : vo.known && vi.known ? 'measured-vocals' : 'estimated',
      landed, landing: landed ? landing : null, doubleDrop: false, swapIn: null, check,
      why: `${p.why}${landed ? '; the incoming main part lands on the phrase' : ''}; section search: ${timing.begin.toFixed(1)}s → ${cue.toFixed(1)}s${lowConfidence ? '; uncertain grid: no beat-matched overlap' : ''}` };
  }
  // drum & bass DJs double-drop on roughly a quarter to a third of their transitions (never twice running, checked
  // above): a stable hash of the pair picks which eligible pairs get it
  if (ddBest && best && (opts.doubleDrops === true || (opts.doubleDrops !== false && pairHash(out.id, inn.id) % 100 < 35))) {
    return { ...ddBest, score: best.score + 0.5, evaluated };
  }
  return best && { ...best, evaluated };
}
