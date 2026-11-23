// Auto-mix: plays a queue non-stop on decks 1 & 2 with beat-matched, phrase-aligned transitions in a choice of
// mixing styles (smooth blend, bass swap, crossfade, filter sweep, echo out, cut, backspin, vinyl brake, loop out,
// reverb wash, or "auto": one picked per pair from tempo, energy, key and genre). Queues can be played in order,
// shuffled, ordered by smart mix (compatibility score, see smartmix.js) or picked live while playing.
// Uses the track structure (phrases, mixIn / mixOut from analysis-core) when available: transitions start at the
// outgoing track's outro, the incoming track starts at its first downbeat so phrase boundaries line up, and the
// transition length adapts to the outro (bounded by settings.automix.transitionBeats), or with
// settings.automix.lengthMode 'auto' is chosen per transition from the outro / intro phrases, BPM gap, energy and key
// (autoTransitionLength).
import { Emitter } from './util.js';
import { api } from './api.js';
import { toCamelot, camelotCompatible, analyzeStructure } from './audio/analysis-core.js';
import { smartMix, liveNext, shuffle, camelotRelation, genreSimilarity, explain, skipFeedback, playFeedback, emptyFeedback, arcPhase, familiarityInfo, isFamiliar } from './smartmix.js';
import { planTricks, rollSize } from './automix-tricks.js';
import { decodeVocalMap } from './shared/vocal-map.js';
import { t } from './i18n.js';
import { planBestTransition, stemSwapLevels, learnChoice } from './mix-planner.js';
import { planAdaptiveTransition } from './adaptive-dj.js';
import { Watchdog, quietAt } from './automix-watchdog.js';
import { echoBeatsFor, styleFamily } from './dj-styles.js';

export const LOG_BPM_JUMP = Math.log(1.08); // > 8 % tempo change (after half/double matching) is a "big jump"

/** Tempo distance as |log ratio|, allowing half / double time (87 ↔ 174 = 0). */
export function tempoDistance(a, b) {
  if (!a || !b) return 0;
  const r = Math.abs(Math.log(b / a));
  return Math.min(r, Math.abs(r - Math.LN2), Math.abs(r - 2 * Math.LN2));
}

/** True when two keys clash (both known and not neighbours on the Camelot wheel). */
export function keysClash(a, b) {
  const ca = toCamelot(a), cb = toCamelot(b);
  return !!(ca && cb && !camelotCompatible(ca, cb));
}

function transitionScore(cur, t) {
  let s = 0;
  if (cur.bpm && t.bpm) {
    const d = tempoDistance(cur.bpm, t.bpm);
    s -= d * 60;
    if (d > LOG_BPM_JUMP) s -= 20 + (d - LOG_BPM_JUMP) * 100;
  }
  const cc = toCamelot(cur.key);
  if (cc && camelotCompatible(cc, toCamelot(t.key))) s += 6;
  return s;
}

/** Target energy (1..10 scale) at position x (0..1) of the set for each energy-curve mode. */
export function energyTarget(mode, x, lo = 1, hi = 10, n = 10) {
  const span = hi - lo;
  if (mode === 'build') return lo + span * x;
  if (mode === 'peak') return x < 0.65 ? lo + span * (x / 0.65) : hi - span * 0.7 * ((x - 0.65) / 0.35);
  if (mode === 'wave') { const cycles = Math.max(1, Math.round(n / 8)); return lo + span * (0.5 - 0.5 * Math.cos(2 * Math.PI * cycles * x)); }
  return null;
}

/**
 * Order a list so each next track is harmonically and tempo-wise close (greedy walk), optionally following an
 * energy curve: 'harmonic' (default), 'build' (rising energy), 'peak' (rise then fall), 'wave' (up and down).
 * Big tempo jumps (> 8 %, half/double time excepted) are avoided.
 */
export function smartOrder(tracks, mode = 'harmonic') {
  if (typeof mode === 'object' && mode) mode = mode.mode || mode.order || 'harmonic';
  const curve = mode === 'build' || mode === 'peak' || mode === 'wave';
  if (tracks.length < (curve ? 2 : 3)) return tracks;
  const E = (t) => (Number.isFinite(t.energy) ? t.energy : 5);
  const es = tracks.map(E), lo = Math.min(...es), hi = Math.max(...es), n = tracks.length;
  const target = (i) => energyTarget(mode, n > 1 ? i / (n - 1) : 0, lo, hi, n);
  const rest = [...tracks];
  let first = 0;
  if (curve) { // start with the track closest to the curve's start (low energy, then lowest tempo)
    const t0 = target(0);
    rest.forEach((t, i) => {
      const d = Math.abs(E(t) - t0), bd = Math.abs(E(rest[first]) - t0);
      if (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && (t.bpm || 0) < (rest[first].bpm || 0))) first = i;
    });
  }
  const out = [rest.splice(first, 1)[0]];
  while (rest.length) {
    const cur = out.at(-1), tgt = curve ? target(out.length) : null;
    let best = 0, bestScore = -Infinity;
    rest.forEach((t, i) => {
      let s = transitionScore(cur, t);
      if (curve) s -= Math.abs(E(t) - tgt) * 2.5;
      else if (cur.energy && t.energy) s -= Math.abs(t.energy - cur.energy) * 0.5;
      if (s > bestScore) { bestScore = s; best = i; }
    });
    out.push(rest.splice(best, 1)[0]);
  }
  return out;
}

const snapTo = (t, grid, beat) => grid + Math.round((t - grid) / beat) * beat;

/**
 * Where to start mixing out of a track and for how long (track seconds).
 * t: { bpm, gridOffset, duration, endTime, mixOut?, downbeat?, phrases? }
 * @returns {{ start: number, len: number, end: number, phrase: boolean }} phrase = start is a phrase boundary from the analysis
 */
export function planMixOut(t, { transitionBeats = 32, skipSilence = true } = {}) {
  const dur = t.duration || 0;
  const end = skipSilence ? Math.min(dur, t.endTime || dur) : dur;
  if (!t.bpm) { const len = Math.min(12, dur * 0.4); return { start: end - len, len, end, phrase: false }; }
  const beat = 60 / t.bpm, bar = 4 * beat;
  const maxLen = Math.min(transitionBeats * beat, dur * 0.4);
  let mo = t.mixOut;
  if (mo == null && t.phrases?.length) { // start of the trailing outro section
    let i = t.phrases.length - 1;
    if (t.phrases[i].type === 'outro') { while (i > 0 && t.phrases[i - 1].type === 'outro') i--; mo = t.phrases[i].start; }
  }
  const minLen = Math.min(maxLen, 8 * beat);
  if (mo != null && mo > 0 && end - mo >= minLen - 1e-3) {
    // long outro: start on the latest 8-bar phrase boundary inside it that still leaves room for the transition
    let start = mo;
    if (end - mo > maxLen) start = mo + Math.floor((end - mo - maxLen) / (8 * bar) + 1e-6) * 8 * bar;
    return { start, len: Math.min(end - start, maxLen), end, phrase: true };
  }
  // fallback: align to a 4-bar phrase counted from the first downbeat / grid
  const anchor = t.downbeat ?? t.gridOffset ?? 0;
  const lenSec = transitionBeats * beat;
  let start = end - Math.min(lenSec, dur * 0.4);
  const phrase = beat * 16;
  start = anchor + Math.floor((start - anchor) / phrase) * phrase;
  if (end - start > lenSec * 1.6) start += phrase;
  // never start after the music ends (short / unanalysed tracks, short transitions)
  const minStart = end - Math.min(lenSec, dur * 0.4);
  if (!(start <= minStart)) start = Math.max(0, minStart);
  return { start, len: Math.max(0, end - start), end, phrase: false };
}

/** Bounds of the automatic transition length (bars). */
export const AUTO_LENGTH_MIN_BARS = 4, AUTO_LENGTH_MAX_BARS = 32;
/** Auto length per style: [usual bars without structure info, most bars it is stretched to]. */
const AUTO_LENGTH_STYLE = { blend: [16, 32], stemswap: [16, 32], filter: [16, 16], crossfade: [8, 16], bassswap: [4, 4] }; // bass swap: planTransition keeps it to 16 beats
/** Round down to a phrase: multiples of 8 bars from 8 bars up, else 4 bars. */
const phraseBars = (b) => (b >= 8 ? Math.floor(b / 8 + 1e-6) * 8 : AUTO_LENGTH_MIN_BARS);

/** Bars of the trailing outro of an outgoing track (from the analysed phrases / mix-out point), or null if unknown. */
export function outroBars(t) {
  if (!t?.bpm) return null;
  const bar = 240 / t.bpm, end = Number(t.endTime) || Number(t.duration) || 0;
  if (!end) return null;
  const ph = Array.isArray(t.phrases) ? t.phrases : [];
  let start = null;
  if (ph.length && ph.at(-1).type === 'outro') { let i = ph.length - 1; while (i > 0 && ph[i - 1].type === 'outro') i--; if (i > 0) start = ph[i].start; }
  if (start == null && Number.isFinite(Number(t.mixOut)) && Number(t.mixOut) > 0) start = Number(t.mixOut);
  if (start == null || !(end > start)) return null;
  return Math.round((end - start) / bar);
}

/** Bars of the intro of an incoming track, counted from where automix starts it; 0 = it starts on a main phrase; null = unknown. */
export function introBars(t) {
  if (!t?.bpm) return null;
  const ph = Array.isArray(t.phrases) ? t.phrases : [];
  if (!ph.length) return null;
  if (ph[0].type !== 'intro') return 0;
  const main = ph.find((p) => p.type !== 'intro');
  if (!main) return null;
  return Math.max(0, Math.round((main.start - incomingStart(t)) / (240 / t.bpm)));
}

/**
 * Automatic transition length for one transition ("Auto (from the tracks)"): as long as the outgoing outro and the
 * incoming intro allow (the shorter one), capped per style and shortened for big tempo differences, energy jumps and
 * key clashes; whole phrases (4 bars, then multiples of 8) between 4 and 32 bars.
 * out / inn: { bpm, duration, endTime, mixIn, mixOut, phrases, energy, key }.
 * @returns {{ bars: number, beats: number, why: string }}
 */
export function autoTransitionLength(out, inn, style, { keySync = false } = {}) {
  style = normStyle(style);
  const drop = DROP_STYLES.has(style);
  const [usual, most] = AUTO_LENGTH_STYLE[style] || [8, 16];
  const ob = outroBars(out), ib = drop ? null : introBars(inn);
  const reasons = [];
  let bars, cap = drop ? AUTO_LENGTH_MAX_BARS : most;
  if (ob == null && ib == null) { bars = usual; reasons.push(t(drop ? 'no outro analysis' : 'no phrase analysis: usual length for the style')); }
  else {
    const known = [ob, ib].filter((x) => x != null);
    bars = Math.min(...known);
    if (ob != null) reasons.push(t('{n}-bar outro', { n: ob }));
    if (ib != null) reasons.push(ib === 0 ? t('incoming track starts without an intro') : t('{n}-bar intro', { n: ib }));
    if (ib === 0) bars = Math.min(ob ?? 8, 8);
    if (bars > cap) reasons.push(t('{style} max {n} bars', { style: t(STYLE_LABEL[style]), n: cap }));
  }
  if (!drop) {
    const ba = Number(out?.bpm) || 0, bb = Number(inn?.bpm) || 0, d = ba && bb ? tempoDistance(ba, bb) : 0;
    const pct = Math.round((Math.exp(d) - 1) * 100);
    if (d > 0.04 && cap > 8) { cap = 8; reasons.push(t('{pct} % BPM gap: shorter', { pct })); }
    else if (d > 0.02 && cap > 16) { cap = 16; reasons.push(t('{pct} % BPM gap', { pct })); }
    const ea = Number(out?.energy), eb = Number(inn?.energy);
    if (Number.isFinite(ea) && Number.isFinite(eb) && ea > 0 && eb > 0) {
      const de = Math.abs(eb - ea);
      if (de >= 3 && cap > 8) { cap = 8; reasons.push(t(eb > ea ? 'energy jump {a} → {b}' : 'energy drop {a} → {b}', { a: Math.round(ea), b: Math.round(eb) })); }
      else if (de >= 2 && cap > 16) { cap = 16; reasons.push(t('energy {a} → {b}', { a: Math.round(ea), b: Math.round(eb) })); }
    }
    if (!keySync && camelotRelation(out?.key, inn?.key).kind === 'clash' && cap > 8) { cap = 8; reasons.push(t('key clash: short overlap')); }
  }
  bars = phraseBars(Math.max(AUTO_LENGTH_MIN_BARS, Math.min(bars, cap, AUTO_LENGTH_MAX_BARS)));
  return { bars, beats: bars * 4, why: reasons.join(', ') };
}

/** Position (track seconds) to start the incoming track: its mix-in point (first downbeat), else first beat. */
export function incomingStart(t) {
  if (t.mixIn != null && t.mixIn >= 0 && (!t.duration || t.mixIn < t.duration - 1)) return t.mixIn;
  const st = t.startTime || 0;
  if (!t.bpm) return st;
  const beat = 60 / t.bpm;
  let s = Math.max(t.gridOffset || 0, snapTo(st, t.gridOffset || 0, beat));
  if (s < 0) s += beat;
  return s;
}

/**
 * Beats to offset the incoming start so its bars line up with the outgoing track.
 * pos: outgoing position; start: planned transition start (a phrase boundary) or null for an immediate mix.
 */
/** Choose a phrase-aware opening for smart sets: use a saved mix-in point, or skip a detected intro to the first main phrase. */
export function smartStartPoint(t) {
  const duration = Number(t?.duration) || 0;
  const end = Number(t?.endTime) || duration || Infinity;
  const floor = Number(t?.startTime) || 0;
  const limit = Math.min(end, duration ? duration * 0.25 : Infinity); // skip an intro, never a quarter of the song
  const valid = (p) => Number.isFinite(Number(p)) && Number(p) > floor + 0.5 && Number(p) <= limit && Number(p) < end - 4;
  if (valid(t?.mixIn)) return Number(t.mixIn);
  const main = new Set(['buildup', 'verse', 'drop', 'chorus']);
  const phrases = Array.isArray(t?.phrases) ? t.phrases : [];
  if (phrases[0]?.type === 'intro') {
    const entry = phrases.find((p) => main.has(p.type) && valid(p.start));
    if (entry) return Number(entry.start);
  }
  return incomingStart(t || {});
}
export function barOffsetBeats(t, pos, start = null) {
  if (!t.bpm) return 0;
  const beat = 60 / t.bpm;
  if (start != null) {
    const late = (pos - start) / beat;
    if (late >= 0 && late <= 4) return late;
  }
  const anchor = t.downbeat ?? t.gridOffset ?? 0;
  return ((((pos - anchor) / beat) % 4) + 4) % 4;
}

/**
 * Bass-swap point for the 'phrase' style, in incoming-track seconds: a phrase boundary of the incoming track inside
 * the transition window [inStart, inStart + lenIn] (closest to its middle); falls back to 8-, 4- or 1-bar boundaries
 * counted from the mix-in point.
 */
export function phraseSwapPoint(t, inStart, lenIn) {
  const lo = inStart + 0.2 * lenIn, hi = inStart + 0.85 * lenIn, mid = inStart + 0.5 * lenIn;
  const pick = (cands) => cands.filter((x) => x >= lo && x <= hi).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
  const fromPhrases = pick((t.phrases || []).map((p) => p.start));
  if (fromPhrases != null) return fromPhrases;
  if (t.bpm) {
    const bar = 240 / t.bpm, anchor = t.mixIn ?? t.downbeat ?? t.gridOffset ?? 0;
    for (const bars of [8, 4, 2, 1]) {
      const step = bars * bar, c = [];
      for (let k = Math.ceil((lo - anchor) / step - 1e-6); anchor + k * step <= hi + 1e-6; k++) c.push(anchor + k * step);
      const p = pick(c);
      if (p != null) return p;
    }
  }
  return mid;
}

const ease = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const sq = (v) => (v <= 1e-12 ? 0 : Math.sqrt(v));
/** Isolator knob positions for a few cuts (knob -1..0 = -26 dB..0, see curves.js isoKnobGain). */
const EQ_M6 = -6 / 26, EQ_M20 = -20 / 26;

/**
 * Mixer settings at transition progress k (0..1) for the blend styles. kSwap: progress at which the blend's bass swap
 * happened (null = not yet). Returns only the controls the style touches: inVol, outVol (0..0.8), inLow, inMid,
 * inHigh, outLow, outMid, outHigh (EQ -1..1), inFilter, outFilter (-1 low-pass .. 1 high-pass), echo (bool).
 * Channel faders are squared (gain = vol²), so fades use sqrt curves where the sum must keep constant power.
 */
export function mixLevels(style, k, kSwap = null) {
  style = STYLE_ALIASES[style] || style;
  if (style === 'blend' || style === 'phrase') {
    // long EQ blend, the club recipe (docs/PRO_DJ_AUTOMIX_RESEARCH.md P1.4): the incoming fader comes up over the first
    // quarter with its bass killed and its mids / highs a little down; the outgoing highs make room for the incoming
    // hats; the bass swaps on a phrase line (kSwap) in one move; then the outgoing mids / highs leave before its fader
    if (kSwap == null) {
      return {
        inVol: 0.8 * ease(clamp01(k / 0.25)), outVol: 0.8, inLow: -1, outLow: 0, outMid: 0,
        inHigh: EQ_M6 * (1 - clamp01((k - 0.125) / 0.125)), inMid: EQ_M6 + (EQ_M6 / -2) * clamp01(k / 0.5),
        outHigh: EQ_M6 * ease(clamp01((k - 0.25) / 0.25)),
      };
    }
    const p = clamp01((k - kSwap) / Math.max(1e-3, 1 - kSwap));
    return {
      inVol: 0.8, outVol: 0.8 * (1 - ease(clamp01((p - 0.5) / 0.5))), inLow: 0, outLow: -1, inHigh: 0,
      inMid: (EQ_M6 / 2) * (1 - ease(clamp01(p / 0.5))), outMid: EQ_M6 * ease(clamp01(p / 0.5)),
      outHigh: EQ_M6 + EQ_M6 * ease(clamp01(p / 0.75)),
    };
  }
  if (style === 'eqswap' || style === 'bassswap') {
    return {
      inVol: 0.8 * Math.min(1, k * 2.5), inLow: k < 0.5 ? -1 : 0, outLow: k < 0.5 ? 0 : -1,
      outVol: 0.8 * (k < 0.75 ? 1 : 1 - ease((k - 0.75) / 0.25)), inHigh: k < 0.25 ? -0.5 + k * 2 : 0,
    };
  }
  // one bassline at a time (P1.2): beat-matched kicks add up in phase (+6 dB), which no fader curve hides, so the
  // filter and crossfade styles also hand the low band over in one move, at the swap point (default: the middle)
  const swapped = kSwap != null ? k >= kSwap : k >= 0.55;
  const low = { inLow: swapped ? 0 : -1, outLow: swapped ? -1 : 0 };
  if (style === 'filter') {
    // outgoing: high-pass sweep up; incoming: opens from a low-pass; constant-power fader crossfade in the middle
    const x = clamp01((k - 0.25) / 0.6);
    return { inVol: 0.8 * sq(Math.sin(x * Math.PI / 2)), outVol: 0.8 * sq(Math.cos(x * Math.PI / 2)), outFilter: Math.min(0.85, k * 1.1), inFilter: -0.8 * (1 - ease(clamp01(k / 0.75))), ...low };
  }
  if (style === 'echo') return { inVol: 0.8 * ease(k), echo: k > 0.7, outVol: 0.8 * (k < 0.75 ? 1 : 1 - ease((k - 0.75) / 0.25)), ...low };
  // constant-power crossfade
  return { inVol: 0.8 * sq(Math.sin(k * Math.PI / 2)), outVol: 0.8 * sq(Math.cos(k * Math.PI / 2)), ...low };
}

/** Styles whose bass hands over at a phrase line during the overlap (see phraseSwapPoint). */
export const SWAP_STYLES = new Set(['blend', 'filter', 'crossfade']);

/**
 * Low-band owner check for mixer settings L (mixLevels output): true when both decks would play their low band at
 * the same time (EQ above -20 dB on both audible decks). The executor never sends such a state.
 */
export function twoBasslines(L) {
  const audible = (v) => v == null || v > 0.05;
  const lowOn = (v) => v == null || v > EQ_M20;
  return audible(L.inVol) && audible(L.outVol) && lowOn(L.inLow) && lowOn(L.outLow);
}

// ------------------------------------------------------------------ mixing styles

/** [id, label] of every transition style, in menu order. */
export const STYLES = [
  ['auto', 'Auto (picked per transition)'],
  ['blend', 'Smooth blend (EQ, bass swap on the phrase)'],
  ['bassswap', 'Bass swap (quick)'],
  ['stemswap', 'Stem swap (drums, bass, then vocals; needs AI stems)'],
  ['crossfade', 'Crossfade'],
  ['filter', 'Filter sweep'],
  ['echo', 'Echo out, drop in'],
  ['cut', 'Cut on the downbeat'],
  ['backspin', 'Backspin, drop in'],
  ['brake', 'Vinyl brake (power down), drop in'],
  ['loop', 'Loop out (roll), drop in'],
  ['reverb', 'Reverb wash, drop in'],
];
export const STYLE_LABEL = Object.fromEntries(STYLES.map(([id, l]) => [id, l.split(' (')[0].split(',')[0]]));
/** Older setting values. */
export const STYLE_ALIASES = { phrase: 'blend', eqswap: 'bassswap' };
export const normStyle = (s) => (STYLE_LABEL[STYLE_ALIASES[s] || s] ? STYLE_ALIASES[s] || s : 'blend');
/** Styles where the outgoing track leaves with an effect and the incoming one drops in on a downbeat. */
export const DROP_STYLES = new Set(['echo', 'cut', 'backspin', 'brake', 'loop', 'reverb']);
/** Drop styles: beats of effect before the drop, beats of tail after it. */
const DROP_TIMING = { echo: [8, 8], reverb: [8, 8], cut: [0, 0], backspin: [2, 0], brake: [4, 0], loop: [16, 0] };
/** "Vary styles": alternatives that suit the same situation. */
const VARIANTS = { blend: ['blend', 'bassswap', 'filter'], stemswap: ['stemswap', 'blend', 'bassswap'], bassswap: ['bassswap', 'blend', 'filter'], crossfade: ['crossfade', 'blend'], filter: ['filter', 'blend', 'reverb'], echo: ['echo', 'reverb', 'loop'], cut: ['cut', 'backspin', 'loop'], backspin: ['backspin', 'brake', 'cut'], brake: ['brake', 'backspin', 'echo'], loop: ['loop', 'echo', 'cut'], reverb: ['reverb', 'echo', 'filter'] };
const hashIdx = (s, n) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return Math.abs(h) % n; };

/**
 * Auto style for a pair of tracks: big tempo jumps get an echo out / cut / reverb wash (no long beat-matched overlap),
 * key clashes and genre changes a filter sweep, similar compatible tracks a smooth blend or bass swap.
 * @returns {{ style: string, why: string }}
 */
export function pickStyle(cur, next, { prev = null, vary = false, seed = '' } = {}) {
  const ba = Number(cur?.bpm) || 0, bb = Number(next?.bpm) || 0;
  const ea = Number(cur?.energy), eb = Number(next?.energy), de = Number.isFinite(ea) && Number.isFinite(eb) ? eb - ea : 0;
  const key = camelotRelation(cur?.key, next?.key);
  const g = cur && next ? genreSimilarity(cur, next) : null;
  let style, why;
  if (!ba || !bb) { style = 'echo'; why = 'no beat grid on one track: echo out instead of a beat-matched overlap'; }
  else {
    const d = tempoDistance(ba, bb);
    if (d > LOG_BPM_JUMP) {
      if (de >= 2) { style = 'cut'; why = `big tempo jump (${Math.round(ba)} → ${Math.round(bb)} BPM) into more energy: cut on the downbeat`; }
      else if (de <= -2) { style = 'reverb'; why = `big tempo jump (${Math.round(ba)} → ${Math.round(bb)} BPM) and energy drops: reverb wash`; }
      else { style = 'echo'; why = `big tempo jump (${Math.round(ba)} → ${Math.round(bb)} BPM): echo out`; }
    } else if (key.kind === 'clash') { style = 'filter'; why = `key clash (${key.from} → ${key.to}): filter sweep hides it`; }
    else if (g != null && g === 0) { style = d > 0.03 ? 'echo' : 'filter'; why = 'genre change: ' + (style === 'echo' ? 'echo out' : 'filter sweep'); }
    else if (d > 0.04) { style = 'bassswap'; why = `${Math.round(ba)} → ${Math.round(bb)} BPM: quick bass swap keeps the tempo change short`; }
    else if (de >= 2) { style = 'bassswap'; why = 'energy rises: quick bass swap'; }
    else if (de <= -2) { style = 'filter'; why = 'energy drops: filter sweep'; }
    else { style = 'blend'; why = 'similar tempo and compatible key: smooth blend'; }
  }
  if (vary && prev && prev === style) {
    const alts = VARIANTS[style].filter((x) => x !== style);
    style = alts[hashIdx(seed, alts.length)]; why += ` (varied: ${STYLE_LABEL[style]})`;
  }
  return { style, why };
}

/**
 * When and how a transition runs, in outgoing-track seconds.
 * Blend styles: { start, len } (the incoming track plays from start for len). Drop styles: { start (effect begins),
 * drop (incoming drops in, a bar line), pre / post (beats of effect before / tail after the drop) }.
 * `begin` is the position at which automix starts the transition in both cases.
 */
export function planTransition(t, style, opts = {}, { pos = 0, immediate = false } = {}) {
  style = normStyle(style);
  const beat = t.bpm ? 60 / t.bpm : 0.5, bar = 4 * beat;
  const anchor = t.downbeat ?? t.gridOffset ?? 0;
  if (!DROP_STYLES.has(style)) {
    if (immediate) return { style, begin: pos, start: pos, len: 4 * beat, immediate };
    const p = planMixOut(t, opts);
    const len = style === 'bassswap' ? Math.min(p.len, 16 * beat) : p.len;
    return { style, begin: p.start, start: p.start, len, end: p.end, phrase: p.phrase };
  }
  const [preB, postB] = DROP_TIMING[style];
  const pre = preB * beat, post = postB * beat;
  const snapDown = (x) => (t.bpm ? anchor + Math.floor((x - anchor) / bar + 1e-6) * bar : x);
  const snapUp = (x) => (t.bpm ? anchor + Math.ceil((x - anchor) / bar - 1e-6) * bar : x);
  let drop;
  if (immediate) drop = snapUp(pos + pre + 0.05);
  else {
    const p = planMixOut(t, opts);
    drop = snapDown(p.start + p.len);
    if (drop - pre < p.start - 8 * bar || drop <= p.start) drop = snapDown(p.start + Math.max(bar, pre)); // very short outro
    if (drop > p.end) drop = snapDown(p.end);
  }
  return { style, begin: Math.max(0, drop - pre), start: Math.max(0, drop - pre), drop, pre: preB, post: postB, preSec: pre, postSec: post, immediate };
}

/** Fewest bars over which the incoming track eases back to its original tempo after a transition. */
export const TEMPO_RESTORE_BARS = 8;
/** Most bars for the ease-back (about 2 minutes at 128 BPM). */
export const TEMPO_RESTORE_MAX_BARS = 64;
/**
 * Bars for easing a deck back from `fromPct` % to its own tempo: like a DJ riding the pitch, at most about 1 BPM per
 * 16 bars, so the change is never heard (P1.6); between TEMPO_RESTORE_BARS and TEMPO_RESTORE_MAX_BARS.
 */
export function restoreBars(fromPct, bpm) {
  const dBpm = Math.abs(Number(fromPct) || 0) / 100 * (Number(bpm) || 120);
  return Math.max(TEMPO_RESTORE_BARS, Math.min(TEMPO_RESTORE_MAX_BARS, Math.ceil(dBpm * 16 / 4) * 4));
}
/** Largest tempo gap a blend morphs across (the master tempo glides from the outgoing to the incoming tempo). */
export const MORPH_MAX = Math.log(1.04);
/**
 * Tempo morph for a blend (P1.6): the outgoing (master) deck's tempo % that makes it run at the incoming track's own
 * tempo (half / double time aware), or null when the gap is too small to matter or too big to morph.
 * out / inn: { bpm, tempo (%), effectiveBpm }.
 */
export function morphTarget(out, inn) {
  const ob = Number(out?.bpm), ib = Number(inn?.bpm);
  if (!(ob > 0 && ib > 0)) return null;
  const eff = Number(out.effectiveBpm) || ob * (1 + (Number(out.tempo) || 0) / 100);
  const target = [ib, ib * 2, ib / 2].reduce((a, b) => (Math.abs(Math.log(b / eff)) < Math.abs(Math.log(a / eff)) ? b : a));
  const gap = Math.abs(Math.log(target / eff));
  if (gap < 0.002 || gap > MORPH_MAX) return null;
  return (target / ob - 1) * 100;
}
/** Tempo (%) during the ease-back: smooth (ease-in-out) from `from` to 0 as k goes 0 → 1. */
export function tempoRampValue(from, k) {
  k = Math.min(1, Math.max(0, k));
  return from * (1 - k * k * (3 - 2 * k));
}

const structureCache = new WeakMap();

/** Phase drift (seconds) the phase keeper leaves alone; above it the incoming deck's pitch is bent back. */
export const PHASE_TOLERANCE = 0.003;
/** Largest pitch bend the phase keeper uses (2 %, with key lock not audible as a pitch change). */
export const MAX_PHASE_BEND = 0.02;
/** A phase error this big (seconds) at the start of a blend is snapped by a seek rather than bent. */
export const PHASE_SNAP = 0.03;
/**
 * How far the incoming deck's beats are behind the outgoing deck's (seconds of audio time; negative = ahead) at
 * audio time t, from both beat grids. null when the tempos differ by more than 5 % (half / double time sync).
 */
export function phaseErrorSeconds(out, inn, t) {
  const ob = out.effectiveBpm || out.bpm, ib = inn.effectiveBpm || inn.bpm;
  if (!ob || !ib || Math.abs(Math.log(ob / ib)) > 0.05) return null;
  let d = out.beatPhase(out.positionAt(t)) - inn.beatPhase(inn.positionAt(t));
  if (d > 0.5) d -= 1; if (d < -0.5) d += 1;
  return d * 60 / ob;
}

/** Endless live sets: length of one energy-curve cycle (tracks). */
const LIVE_ENDLESS_CYCLE = 30;
/** Seconds left in the track playing on a deck (0 without one). */
function remainingSeconds(deck) {
  if (!deck?.track) return 0;
  const d = Number(deck.duration || deck.track.duration) || 0;
  return Math.max(0, d - (Number(deck.position) || 0));
}
/** The first tracks of a list that fill `seconds` (tracks of unknown length count 4 minutes); at least one. */
export function trimToMinutes(list, seconds) {
  const out = [];
  let total = 0;
  for (const t of list) { if (out.length && total >= seconds) break; out.push(t); total += Number(t.duration) || 240; }
  return out;
}

/** Loudness (LUFS) of the analysed section of t that contains `at` (track seconds), plus its level-match gain. */
export function sectionLevel(t, at) {
  const p = (Array.isArray(t?.phrases) ? t.phrases : []).find((x) => at >= x.start - 0.05 && at < x.end);
  const l = Number(p?.lufs);
  return Number.isFinite(l) ? l + (Number(t.gain) || 0) : null;
}
/**
 * Cut / drop landings (P0.3): extra trim (dB, <= 0) for the incoming track when the section it lands on is more than
 * 2 LU louder than the outgoing section it replaces (after level matching); null when fine or unknown.
 */
export function landingTrim(out, outAt, inn, innAt) {
  const a = sectionLevel(out, outAt), b = sectionLevel(inn, innAt);
  if (a == null || b == null || b - a <= 2) return null;
  return -Math.min(6, b - a - 1);
}

export class AutoMix extends Emitter {
  constructor(app) {
    super();
    this.app = app; this.engine = app.engine;
    this.enabled = false; this.queue = []; this.idx = 0; this.transition = null;
    /** Per-transition style overrides (queue track object → style) and smart-mix explanations (track → text). */
    this.overrides = new Map(); this.reasons = new Map();
    /** Planner results per queue track (track object -> plan), for learning from overrides. */
    this.plans = new WeakMap(); this._recent = [];
    this.mode = 'order'; this.live = null; this.upcoming = null; this.forceTransitionRequested = false;
    this.engine.on('tick', () => this.tick());
  }
  get opts() { return this.app.settings.automix; }
  // Transition progress follows the audio clock, including suspension/resume.
  now() { return Number.isFinite(this.engine.ctx?.currentTime) ? this.engine.ctx.currentTime * 1000 : performance.now(); }

  static smartOrder(tracks, mode) { return smartOrder(tracks, mode); }

  /**
   * Start automix. opts.mode: 'order' (as given) | 'shuffle' | 'smart' (order by compatibility up front) |
   * 'live' (smart pick of each next track while playing). Older callers: { smart: true, order } = energy-curve order.
   * opts.shape / sliders / limit tune smart mix (defaults from settings.automix).
   * opts.minutes: a timed set (e.g. 60), opts.endless: never runs out (opts.pool, default the tracks, is drawn from
   * again as the set plays). Tracks already on decks 1 / 2 are used first (see below).
   */
  async start(tracks, { smart = false, order, mode, shape, sliders, limit, minutes, endless = false, pool = null } = {}) {
    if (!tracks.length) throw new Error('Queue is empty');
    this.reasons = new Map(); this.overrides = new Map(); this.live = null; this.refill = null; this.feedback = emptyFeedback(); this.livePlan = null; this.trickHistory = []; this.famInfo = familiarityInfo(tracks); this._peakHours = undefined;
    mode = mode || (smart ? 'legacy-smart' : this.opts.shuffle ? 'shuffle' : 'order');
    shape = shape || this.opts.shape || 'warmup';
    sliders = sliders || this.opts.sliders;
    const [a, b] = this.engine.decks;
    // Start with what is already on decks 1 / 2: a playing deck keeps playing; otherwise a loaded deck (deck 1 first)
    // starts the set, and a track loaded on the other deck plays next. Those tracks are taken out of the list.
    const lib = this.app.library;
    const libCopy = (t) => (t ? lib?.track?.(t.id) || t : null);
    const ready = (d) => !!d.track && !d.loading;
    const playingDeck = [a, b].find((d) => d.playing && ready(d)) || null;
    const firstDeck = playingDeck || [a, b].find(ready) || null;
    const nextDeck = firstDeck && ready(this.other(firstDeck)) && this.other(firstDeck).track.id !== firstDeck.track.id ? this.other(firstDeck) : null;
    const firstTrack = libCopy(firstDeck?.track), pinnedNext = libCopy(nextDeck?.track);
    const onDecks = new Set([firstTrack?.id, pinnedNext?.id].filter(Boolean));
    let list = tracks.filter((t) => t && !onDecks.has(t.id) && this.allowed(t));
    if (!list.length && !pinnedNext && !firstTrack) throw new Error('Queue is empty');
    const after = pinnedNext || firstTrack; // what the ordering continues from
    if (mode === 'shuffle') list = shuffle(list);
    else if (mode === 'legacy-smart') list = smartOrder(list, order || this.opts.order || 'harmonic');
    else if (mode === 'smart' && list.length) {
      const r = smartMix(list, { shape, sliders, limit, start: after });
      list = r.tracks;
      r.steps.forEach((s) => this.reasons.set(s.track, s.reason));
    } else if (mode === 'live') {
      const avg = list.reduce((n, t) => n + (Number(t.duration) || 240), 0) / (list.length || 1);
      const timed = minutes > 0 ? Math.max(2, Math.ceil(minutes * 60 / avg)) : 0; // a timed live set: tracks that fill it
      const setLength = endless ? LIVE_ENDLESS_CYCLE : Math.min(list.length + onDecks.size, Math.max(2, timed || Number(limit) || Number(this.opts.liveSetLength) || list.length + onDecks.size));
      this.live = { ids: list.map((t) => t.id), shape, sliders, setLength, endless: !!endless };
      if (pinnedNext || !list.length) list = [];
      else {
        this.live.minutes = minutes > 0 ? minutes : 0;
        list = this.playable(list);
        const first = after ? liveNext(after, list, { shape, sliders, position: 0, setLength, ...this.partyCtx({ endless: !!endless, elapsedMin: 0, setMinutes: minutes > 0 ? minutes : undefined }), transitionScore: (t) => this.transitionQuality(after, t, firstDeck) }) : null;
        const r = first ? null : smartMix(list, { shape, sliders, limit: 1 });
        const t0 = first?.track || r.tracks[0];
        list = [t0];
        this.reasons.set(t0, first?.reason || r.steps[0].reason);
      }
    }
    if (pinnedNext) { list.unshift(pinnedNext); this.reasons.set(pinnedNext, [explain(firstTrack, pinnedNext), `already loaded on deck ${nextDeck.index + 1}`].filter(Boolean).join('; ')); }
    if (minutes > 0 && !endless) list = trimToMinutes(list, minutes * 60 - remainingSeconds(firstDeck));
    // endless (or a set length the list is too short for): more tracks are added from the pool as the set plays
    if ((endless || minutes > 0) && mode !== 'live') {
      const ids = (pool || tracks).map((t) => t?.id).filter(Boolean);
      this.refill = { ids, endless: !!endless, seconds: endless ? Infinity : minutes * 60, mode, shape, sliders };
    }
    this.mode = mode;
    this.queue = firstTrack ? [firstTrack, ...list] : list; this.idx = firstTrack ? 1 : 0;
    this.enabled = true; this.transition = null; this.forceTransitionRequested = false;
    this.startedAt = Date.now();
    const runId = this._runId = (this._runId || 0) + 1;
    await this.engine.resume();
    if (playingDeck) this.current = playingDeck;
    else if (firstDeck) {
      // a track the DJ loaded (and maybe cued): play it from where it is, or from the best phrase when at the start
      this.prepare(firstDeck);
      const smartMode = ['smart', 'live', 'legacy-smart'].includes(this.mode);
      if (firstDeck.position < 0.5 && smartMode && this.opts.smartStart !== false) { const at = smartStartPoint(firstTrack); if (at > 0.5) firstDeck.seek(at); }
      firstDeck._autoMixEntry = firstDeck.position; firstDeck.play();
      this.current = firstDeck;
    } else {
      // start with the first track that actually loads (missing files / server errors are skipped)
      let loaded = false;
      while (this.idx < this.queue.length && this.enabled) {
        try { await this.app.loadTrack(0, this.queue[this.idx].id, { automix: true }); loaded = true; this.idx++; break; }
        catch (e) { this.app.toast?.(`Automix: skipping "${this.queue[this.idx].title}" (${e.message})`); this.idx++; }
      }
      // stopped while the first track was loading: don't start playing it afterwards (and it's not a load error)
      if (!this.enabled || runId !== this._runId) { this.emit('state'); return; }
      if (!loaded) { this.enabled = false; this.emit('state'); throw new Error('None of the tracks in the queue could be loaded'); }
      this.prepare(a);
      const first = this.queue[Math.max(0, this.idx - 1)] || a.track;
      const smartMode = ['smart', 'live', 'legacy-smart'].includes(this.mode);
      const startAt = smartMode && this.opts.smartStart !== false ? smartStartPoint(first) : 0;
      if (startAt > 0.5) a.seek(startAt);
      a._autoMixEntry = startAt; a.play();
      this.current = a;
    }
    if (!this.enabled || runId !== this._runId) return;
    if (nextDeck) { const ch = this.engine.channels[nextDeck.index]; ch.set('xfAssign', 'THRU'); ch.set('volume', 0); }
    this.fillLive();
    this.fillMore();
    this.preloadNext();
    this.emit('state');
  }

  /**
   * Endless / timed sets: keep a few tracks queued from the pool (settings of the start: shuffle or smart order),
   * preferring tracks not played in this set; when the whole pool has been played, it starts over (endless only).
   * A timed set stops adding once the queued tracks fill its length.
   */
  fillMore() {
    const r = this.refill;
    if (!r || this.live || this.windingDown()) return; // live mode picks each next track itself (fillLive)
    const lib = this.app.library;
    const secs = (t) => Number(lib?.track?.(t.id)?.duration || t.duration) || 240;
    if (this.queue.length - this.idx >= 2) return;
    if (!r.endless && this.queue.reduce((n, t) => n + secs(t), 0) >= r.seconds) return;
    if (r.mode === 'order') {
      // in order: carry on after the last queued track, back to the top of the list at its end (endless)
      const n = r.ids.length, from = r.ids.indexOf(this.queue.at(-1)?.id) + 1;
      if (!n || (!r.endless && from >= n)) return;
      let add = [];
      for (let k = 0; k < Math.min(8, n); k++) { const id = r.ids[(from + k) % n]; if (!r.endless && from + k >= n) break; const t = lib?.track?.(id); if (t && !t.unreadable && this.allowed(t)) add.push(t); }
      if (!r.endless) { let planned = this.queue.reduce((x, t) => x + secs(t), 0); add = add.filter((t) => { const keep = planned < r.seconds; planned += secs(t); return keep; }); }
      if (add.length) this.queue.push(...add);
      return;
    }
    // not played in this set; endless: a track comes back once (nearly) every other track has played since
    const window = r.endless ? Math.min(this.queue.length, Math.max(1, Math.ceil(r.ids.length * 0.75))) : this.queue.length;
    const recent = new Set(this.queue.slice(this.queue.length - window).map((t) => t.id));
    const pool = this.playable(r.ids.filter((id) => !recent.has(id)).map((id) => lib?.track?.(id)).filter((t) => t && !t.unreadable));
    if (!pool.length) return;
    let add;
    const last = this.queue.at(-1) || this.current?.track;
    if (r.mode === 'smart' || r.mode === 'legacy-smart') {
      const sm = smartMix(pool.length > 400 ? shuffle(pool).slice(0, 400) : pool, { shape: r.shape, sliders: r.sliders, limit: 8, start: last ? lib?.track?.(last.id) || last : null, ...this.partyCtx({ endless: r.endless }) });
      add = sm.tracks; sm.steps.forEach((s) => this.reasons.set(s.track, s.reason));
    } else add = shuffle(pool).slice(0, 8);
    if (!r.endless) {
      let planned = this.queue.reduce((n, t) => n + secs(t), 0);
      const keep = [];
      for (const t of add) { if (planned >= r.seconds) break; keep.push(t); planned += secs(t); }
      add = keep;
    }
    if (add.length) this.queue.push(...add);
  }
  stop() { this.endTrick(true); this.trickPlan = null; this._finale = null; if (this.engine.prefetched) this.engine.prefetched.clear(); this.enabled = false; this.forceTransitionRequested = false; this.watchdog?.reset(); if (this.transition) this.finishTransition(true); this.upcoming = null; this.emit('state'); }
  /** Start the next transition immediately, waiting for its deck preload if necessary. */
  skip({ feedback = true } = {}) {
    if (!this.enabled || this.transition || !this.current || !this.nextTrack()) return false;
    if (feedback) this.noteSkip();
    this._skipNext = true;
    const incoming = this.other(this.current), next = this.nextTrack();
    if (incoming.track?.id === next.id && !incoming.loading && !this._loading) {
      this.beginTransition(true); return 'started';
    }
    this.forceTransitionRequested = true;
    this.preloadNext();
    this.emit('state');
    return 'preparing';
  }

  // ---------- queue editing ----------
  /** Remove queue entry i (absolute index into this.queue). */
  remove(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.queue.splice(i, 1);
    if (i < this.idx) this.idx--;
    this.queueChanged();
  }
  /** Move queue entry from → to (absolute indices). Moving an upcoming track to this.idx makes it play next. */
  move(from, to) {
    const q = this.queue;
    if (from < 0 || from >= q.length || from === to) return;
    to = Math.max(0, Math.min(q.length - 1, to));
    let b = this.idx;
    const [t] = q.splice(from, 1);
    if (from < b) b--;
    q.splice(to, 0, t);
    if (to < b) b++;
    this.idx = b;
    this.queueChanged();
  }
  /**
   * Shuffle the tracks still to come (works while automix runs: the next track is re-preloaded). Live mode picks
   * each next track itself, so there is nothing to shuffle there. Returns the number of shuffled tracks.
   */
  shuffleRemaining() {
    if (this.live && this.enabled) return 0;
    const rest = this.queue.slice(this.idx);
    if (rest.length < 2) return 0;
    const mixed = shuffle(rest);
    for (const t of mixed) this.reasons.delete(t); // smart-mix reasons describe the old order
    this.queue.splice(this.idx, rest.length, ...mixed);
    this.queueChanged();
    return mixed.length;
  }
  /** Insert tracks to play right after the current one. */
  insertNext(tracks) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    if (!list.length) return;
    this.queue.splice(this.idx, 0, ...list);
    this.queueChanged();
  }
  /**
   * Style for the transition into queue entry i (absolute index): 'auto' / null clears the override.
   * learn: false for choices that are not the DJ's own (an AI assistant over MCP), so they don't train the planner.
   */
  setOverride(i, style, { learn = true } = {}) {
    const t = this.queue[i]; if (!t) return;
    const planned = this.plans.get(t);
    if (!style || style === 'default') this.overrides.delete(t); else this.overrides.set(t, style === 'auto' ? 'auto' : normStyle(style));
    // the DJ disagreed with the planner: remember it (settings.mixLearning), so its next plans lean their way
    if (learn && planned && style && style !== 'auto' && style !== 'default' && normStyle(style) !== planned.style) {
      this.app.setSetting?.('mixLearning', learnChoice(this.app.settings.mixLearning, normStyle(style), planned.style));
    }
    this.upcoming = null; this.emit('state');
  }
  queueChanged() {
    this.upcoming = null;
    if (this.enabled && !this.transition && this.current) this.preloadNext();
    this.emit('state');
  }

  other(d) { return d === this.engine.decks[0] ? this.engine.decks[1] : this.engine.decks[0]; }
  nextTrack() { return this.queue[this.idx] || null; }

  /** Party controls and live feedback for track selection (smartmix.js options). */
  partyCtx(extra = {}) {
    const o = this.opts || {};
    return {
      energyBias: Number(o.energyBias) || 0, vibeLock: !!o.vibeLock, banned: new Set((o.banned || []).map(String)),
      feedback: this.feedback || undefined, now: Date.now(), elapsedMin: this.startedAt ? (Date.now() - this.startedAt) / 60000 : 0, ...extra,
      targetBpm: this.targetBpm() ?? undefined,
      ...(this.endAtMs() != null ? { setMinutes: (this.endAtMs() - (this.startedAt || Date.now())) / 60000, endless: false } : {}),
    };
  }
  /**
   * Wind-down (P3.4): settings.automix.endAt "HH:MM" (local clock) ends the set there: the energy arc closes towards
   * it, no new tracks are added in its last minutes, and the last track fades out in a reverb wash.
   * @returns {number|null} the end time in ms
   */
  endAtMs(now = Date.now()) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(this.opts?.endAt || ''));
    if (!m) return null;
    const start = this.startedAt || now, d = new Date(start);
    d.setHours(+m[1], +m[2], 0, 0);
    if (d.getTime() <= start + 60e3) d.setDate(d.getDate() + 1); // "02:00" after a 22:00 start is tomorrow
    return d.getTime();
  }
  /** True once the set has reached its end time (less the track still to play): nothing more is queued. */
  windingDown(now = Date.now()) {
    const end = this.endAtMs(now);
    if (end == null) return false;
    const left = this.current?.track ? Math.max(0, (this.current.duration || 0) - (this.current.position || 0)) * 1000 : 0;
    return now + Math.min(left, 6 * 60e3) + 3 * 60e3 >= end; // (the track that would come next needs a few minutes)
  }
  /**
   * The set's planned tempo now (P1.6): from the tempo the set started at, rising about 3 BPM per hour through the
   * warm-up and build and holding at the peak, as warm-up DJs do (capped at +8 %). null for open-format sets, which
   * move between tempo worlds by design, and before anything has played.
   */
  targetBpm(now = Date.now()) {
    const first = this.fresh(this.queue[0] || this.current?.track), b0 = Number(first?.bpm);
    if (!(b0 > 0) || !this.startedAt || styleFamily(first) === 'open') return null;
    const phase = this.setPhase();
    const hours = Math.max(0, (now - this.startedAt) / 3600e3);
    const rise = phase === 'peak' || phase === 'close' || phase === 'valley' ? Math.min(hours, this._peakHours ??= hours) : hours;
    return b0 * Math.min(1.08, 1 + (3 * rise) / b0);
  }
  /** May this track be played (not banned, and clean when only clean versions are wanted)? */
  allowed(t) {
    if (!t || (this.opts?.banned || []).map(String).includes(String(t.id))) return false;
    // clean only: the library has no parental-advisory flag, so explicit versions are recognised by their tags /
    // title ("Explicit", "Dirty"); "Clean" / "Radio Edit" versions are fine
    if (this.opts?.cleanOnly && /\b(explicit|dirty)\b/i.test([t.title, t.genre, t.comment, ...(Array.isArray(t.tags) ? t.tags : [])].filter(Boolean).join(' '))) return false;
    return true;
  }
  /**
   * Party pools (P0.2): when enough analysed tracks are available, only those are picked, so every transition can be
   * planned on beats and phrases; unanalysed ones come back only when nothing else is left.
   */
  playable(list) {
    const ok = list.filter((t) => this.allowed(t) && !t.unreadable);
    const analysed = ok.filter((t) => t.analyzed && Number(t.bpm) > 0);
    return analysed.length >= 5 ? analysed : ok;
  }
  /** The DJ (or a guest) skipped the playing track: selection learns from it (smartmix skipFeedback). */
  noteSkip(deck = this.current) {
    const t = deck?.track; if (!t) return;
    const played = Math.max(0, (deck.position || 0) - (deck._autoMixEntry || 0));
    this.feedback = skipFeedback(this.feedback || emptyFeedback(), this.fresh(t), { playedSeconds: played, now: Date.now(), history: this.queue.slice(0, this.idx) });
  }

  /** Live smart mode: when nothing is queued after the current track, pick the best next one from the pool. */
  fillLive() {
    if (!this.live || this.idx < this.queue.length || this.windingDown()) return;
    const lib = this.app.library;
    const fresh = (t) => (t && lib?.track?.(t.id)) || t;
    const played = this.queue.slice(0, this.idx).map(fresh);
    const endless = !!this.live.endless;
    if (!endless && played.length >= this.live.setLength) return;
    const cur = fresh(this.current?.track) || played.at(-1) || null;
    const pool = this.playable(this.live.ids.map((id) => lib?.track?.(id)).filter(Boolean));
    // endless: the energy curve repeats every LIVE_ENDLESS_CYCLE tracks, and a track can come back once every other
    // track of the pool has played since
    const history = endless ? played.slice(-Math.max(1, pool.length - 1)) : played;
    const position = endless ? played.length % this.live.setLength : played.length;
    const r = liveNext(cur, pool, { history, shape: this.live.shape, sliders: this.live.sliders, position, setLength: this.live.setLength,
      ...this.partyCtx({ endless, setMinutes: this.live.minutes || undefined }), transitionScore: (t) => this.transitionQuality(cur, t, this.current) });
    if (!r) return;
    this.queue.push(r.track); this.reasons.set(r.track, r.reason);
    this.livePlan = r.plan || null; // the planned continuation (set preview)
  }

  transitionQuality(out, inn, deck) {
    const p = planAdaptiveTransition(out, inn, { position: deck?.position || 0, entry: deck?._autoMixEntry || 0, rate: deck?.rate || 1, keepSync: this.opts.keepSync });
    return p ? { score: Math.max(-4, Math.min(4, p.score / 4)), reason: p.why } : { score: -2, reason: 'limited section analysis' };
  }

  /**
   * Preview nudges for the next transition (P6.2): 'earlier' / 'later' move it a phrase, 'shorter' / 'longer' change
   * its length (8 / 16 / 32 bars), 'reset' clears them. Returns the new nudge (or null).
   */
  nudge(kind) {
    const next = this.nextTrack(); if (!next) return null;
    this.nudges ||= new WeakMap();
    const n = { ...(this.nudges.get(next) || { shift: 0, bars: null }) };
    const bars = n.bars || this.upcoming?.length?.bars || 16, LEN = [4, 8, 16, 32];
    if (kind === 'earlier') n.shift -= 1; else if (kind === 'later') n.shift += 1;
    else if (kind === 'shorter') n.bars = LEN.filter((b) => b < bars).at(-1) || 4;
    else if (kind === 'longer') n.bars = LEN.find((b) => b > bars) || 32;
    if (kind === 'reset' || (!n.shift && !n.bars)) { this.nudges.delete(next); this.upcoming = null; this.emit('state'); return null; }
    this.nudges.set(next, n); this.upcoming = null; this.emit('state');
    return n;
  }

  /**
   * The next transition as one plan object (P6.1): what the executor will play, for the preview timeline, the
   * headphone render and the checker. null when nothing is planned.
   */
  previewPlan() {
    const nt = this.nextTransition(), u = this.upcoming;
    if (!nt || !u) return null;
    const cur = this.current, nd = this.other(cur), next = this.nextTrack();
    const innReady = nd?.track?.id === next.id && !nd.loading;
    const ii = innReady ? this.info(nd) : this.trackInfo(next);
    const style = u.style, drop = DROP_STYLES.has(style), plan = u.plan;
    const outRate = cur.rate || 1, outBpm = cur.effectiveBpm || cur.bpm || 0, inBpm = Number(ii.bpm) || 0;
    const raw = outBpm && inBpm ? outBpm / inBpm : 1;
    const innRate = [raw, raw * 2, raw / 2].reduce((a, b) => (Math.abs(Math.log(b)) < Math.abs(Math.log(a)) ? b : a));
    const inStart = u.adaptive?.inStart ?? incomingStart(ii);
    const len = drop ? 0 : plan.len, lenIn = len * innRate / outRate;
    const swapAt = drop ? null : u.adaptive?.swapIn ?? (SWAP_STYLES.has(style) ? phraseSwapPoint(ii, inStart, lenIn) : null);
    const kSwap = swapAt != null && lenIn > 0 ? clamp01((swapAt - inStart) / lenIn) : style === 'bassswap' ? 0.5 : null;
    const lanes = drop ? null : Array.from({ length: 65 }, (_, i) => { const k = i / 64; return { k, ...mixLevels(style, k, kSwap != null && k >= kSwap ? kSwap : null) }; });
    return {
      style, why: u.why, length: u.length, begin: plan.begin, len, drop: drop ? plan.drop : null, end: drop ? plan.drop : plan.start + len,
      inStart, kSwap, lanes, outRate, innRate: drop ? 1 : innRate, beatLen: outBpm ? 60 / (cur.bpm || outBpm) : 0.5,
      check: u.adaptive?.check || null, landing: u.adaptive?.landing ?? null, doubleDrop: !!u.adaptive?.doubleDrop,
      position: cur.position, beginsIn: nt.beginsIn, outTrack: cur.track, inTrack: next, nudge: this.nudges?.get(next) || null,
      echoBeats: echoBeatsFor(this.fresh(cur.track), this.fresh(next)),
      gains: { out: Number(this.fresh(cur.track)?.gain) || 0, inn: Number(this.fresh(next)?.gain) || 0 },
      tricks: (this.trickPlan?.deck === cur ? this.trickPlan.events : []).filter((e) => !e.done).map((e) => ({ id: e.id, label: e.label, at: e.at, start: e.start, why: e.why })),
      upcoming: [next, ...(this.livePlan || []).filter((t) => t.id !== next.id), ...this.queue.slice(this.idx + 1)].slice(0, 8),
    };
  }

  /** Style (and why) for the transition into queue entry i. */
  styleFor(i, prevTrack) {
    const t = this.queue[i]; if (!t) return null;
    const ov = this.overrides.get(t);
    const def = ov || this.opts.style || 'blend';
    const prev = prevTrack ?? (i > 0 ? this.queue[i - 1] : null);
    const lib = this.app.library;
    const fresh = (x) => (x && lib?.track?.(x.id)) || x;
    if (def === 'auto') {
      const prevStyle = i > this.idx ? this.styleFor(i - 1)?.style : this._lastStyle;
      const plan = this.planFor(i, prev, prevStyle);
      if (plan) return { style: plan.style, why: plan.why, override: !!ov, plan };
      return { ...pickStyle(fresh(prev), fresh(t), { prev: prevStyle, vary: !!this.opts.varyStyles, seed: `${prev?.id}>${t.id}` }), override: !!ov };
    }
    let style = normStyle(def);
    if (!ov && this.opts.varyStyles) { const alts = VARIANTS[style]; style = alts[hashIdx(`${prev?.id}>${t.id}`, alts.length)]; }
    let why = ov ? 'chosen for this transition' : this.opts.varyStyles && style !== normStyle(def) ? 'varied' : 'default style';
    // blend styles can't bridge a big tempo gap (they would beat-match far off the incoming track's tempo)
    const pa = fresh(prev), pb = fresh(t), ba = Number(pa?.bpm) || 0, bb = Number(pb?.bpm) || 0;
    if (ba && bb && !DROP_STYLES.has(style) && tempoDistance(ba, bb) > LOG_BPM_JUMP) {
      const was = STYLE_LABEL[style] || style, de = (Number(pb.energy) || 0) - (Number(pa.energy) || 0);
      style = de >= 2 ? 'cut' : 'echo';
      why = `${why}; ${Math.round(ba)} → ${Math.round(bb)} BPM is too far to beat-match: ${STYLE_LABEL[style]} instead of ${was}`;
    }
    return { style, why, override: !!ov };
  }

  /**
   * Planner result for the transition into queue entry i (see mix-planner.js): the decks' live structure when the
   * tracks are loaded, else the library copies; AI stems count when they are loaded or will load with the track.
   */
  planFor(i, prevTrack, prevStyle) {
    const t = this.queue[i]; if (!t || !prevTrack) return null;
    const cur = this.current, nd = cur ? this.other(cur) : null;
    const onCur = i === this.idx && cur?.track?.id === prevTrack.id, onNext = i === this.idx && nd?.track?.id === t.id && !nd.loading;
    const o = { ...this.fresh(prevTrack), ...(onCur ? this.info(cur) : {}) }, n = { ...this.fresh(t), ...(onNext ? this.info(nd) : {}) };
    for (const k of ['energy', 'key', 'genre', 'stems']) { if (o[k] == null) o[k] = this.fresh(prevTrack)?.[k]; if (n[k] == null) n[k] = this.fresh(t)?.[k]; }
    const autoLoad = this.engine.settings?.stemsAutoLoad !== false;
    const stems = (deckOn, track) => !!(deckOn?.stemsReady || (autoLoad && track?.stems?.ready));
    try {
      const plan = planBestTransition(o, n, {
        stemsOut: stems(onCur ? cur : null, o), stemsIn: stems(onNext ? nd : null, n), keySync: !!this.opts.keySync,
        prevStyle, vary: !!this.opts.varyStyles, recent: this._recent, learning: this.app.settings?.mixLearning,
        fixedBars: this.opts.lengthMode === 'auto' ? null : (Number(this.opts.transitionBeats) || 32) / 4,
        styles: this.opts.keepSync === false || [o, n].some((t) => !t.bpmLocked && !t.gridLocked && Number.isFinite(t.bpmConfidence) && t.bpmConfidence < 0.35) ? ['echo', 'cut', 'reverb'] : undefined,
      });
      this.plans.set(t, plan);
      return plan;
    } catch (e) { console.warn('[automix] planner', e); return null; }
  }

  /** Structure info for the track on a deck: analysed fields, else derived from the deck's waveform (older analyses). */
  info(deck) {
    const t = { ...deck.track, ...this.fresh(deck.track) };
    const base = { ...t, bpm: deck.bpm, gridOffset: deck.gridOffset, duration: deck.duration || t.duration, startTime: t.startTime, endTime: t.endTime };
    if (t.mixOut != null || t.mixIn != null) return { ...base, mixIn: t.mixIn, mixOut: t.mixOut, downbeat: t.downbeat, phrases: t.phrases };
    if (!deck.bpm || !deck.waveform || !deck.track) return { ...base, phrases: t.phrases };
    const key = `${deck.bpm}|${deck.gridOffset}|${t.startTime}|${t.endTime}`;
    let c = structureCache.get(deck.track);
    if (!c || c.key !== key) {
      try {
        c = { key, s: analyzeStructure(deck.waveform, deck.bpm, deck.gridOffset, { startTime: t.startTime || 0, endTime: t.endTime || deck.duration, duration: deck.duration }) };
      } catch { c = { key, s: {} }; }
      structureCache.set(deck.track, c);
    }
    return { ...base, ...c.s, phrases: t.phrases?.length ? t.phrases : c.s.phrases };
  }

  prepare(deck) {
    const ch = this.engine.channels[deck.index];
    ch.set('xfAssign', 'THRU'); ch.set('eqLow', 0); ch.set('eqMid', 0); ch.set('eqHigh', 0); ch.set('filter', 0); ch.set('volume', 0.8); ch.set('vocal', 1);
    deck.setKeyLock(true);
    // level matching (P0.3): every track at the same loudness, from its analysed gain (main-section loudness when
    // analysed with it), whatever the global auto-gain setting; set before the track is heard, never while on air
    if (this.opts.levelMatch !== false && typeof ch.setAutoGain === 'function' && !deck.playing) ch.setAutoGain(Number(this.fresh(deck.track)?.gain ?? deck.track?.gain) || 0);
  }

  async preloadNext() {
    this.fillLive();
    this.fillMore();
    const t = this.nextTrack(); if (!t) return;
    const deck = this.other(this.current);
    if (this._loading || deck.track?.id === t.id || deck.loading) return;
    this._loading = true;
    try { await this.app.loadTrack(deck.index, t.id, { automix: true }); } catch (e) {
      this._loading = false;
      if (!this.enabled) return; // stopped meanwhile: nothing to skip
      this.app.toast(`Automix: skipping "${t.title}" (${e.message})`);
      const at = this.queue.indexOf(t); // the queue may have been edited while it loaded
      if (at >= this.idx) this.queue.splice(at, 1);
      this.emit('state'); return this.preloadNext();
    }
    this._loading = false;
    if (!this.enabled) return; // stopped while loading: leave the deck's fader to the DJ
    const ch = this.engine.channels[deck.index];
    ch.set('xfAssign', 'THRU'); ch.set('volume', 0);
    this.prefetchAhead();
    this.upcoming = null;
    this.emit('state');
  }

  /**
   * Party safety (P0.1): fetch the track after next while this one plays, so its bytes are in memory when its deck
   * loads (the deck uses them instead of the network), and a file that can't be read is found out a track early:
   * it is retried once, then taken out of the queue.
   */
  async prefetchAhead() {
    const t = this.queue[this.idx + 1];
    if (!t || this.engine.lowEnd || typeof fetch !== 'function') return;
    const cache = this.engine.prefetched ||= new Map();
    if (cache.has(t.id) || this._prefetching === t.id) return;
    const limit = 120 * 1024 * 1024; // never hold more than one very large file ahead
    this._prefetching = t.id;
    for (let attempt = 0; attempt < 2 && this.enabled; attempt++) {
      try {
        const res = await fetch(api.streamUrl(t.id));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length')) || 0;
        if (len > limit) { res.body?.cancel?.(); break; }
        const ab = await res.arrayBuffer();
        if (!ab.byteLength) throw new Error('empty file');
        for (const id of [...cache.keys()]) if (id !== this.nextTrack()?.id) cache.delete(id); // keep at most the next two
        if (this.queue.slice(this.idx, this.idx + 3).some((x) => x.id === t.id)) cache.set(t.id, ab);
        break;
      } catch (e) {
        if (attempt === 0) { await new Promise((r) => setTimeout(r, 5000)); continue; }
        const at = this.queue.indexOf(t);
        if (at > this.idx && this.enabled) { this.queue.splice(at, 1); this.app.toast?.(`Automix: skipping "${t.title}" (${e.message})`); this.emit('state'); }
      }
    }
    if (this._prefetching === t.id) this._prefetching = null;
  }

  /** Library copy of a track (analysed fields: energy, key, phrases), else the given object. */
  fresh(t) { return (t && this.app.library?.track?.(t.id)) || t; }

  /**
   * Transition length for a pair: { beats, bars, auto, why }. Fixed: settings.automix.transitionBeats; auto
   * (lengthMode 'auto'): picked from the tracks. out / inn: structure info ({ bpm, phrases, mixOut, ... }), merged
   * over the library copies for energy and key.
   */
  lengthFor(out, inn, style, outTrack = null, innTrack = null) {
    const beats = Number(this.opts.transitionBeats) || 32;
    if (this.opts.lengthMode !== 'auto') return { beats, bars: beats / 4, auto: false, why: '' };
    const o = { ...this.fresh(outTrack), ...out }, i = { ...this.fresh(innTrack), ...inn };
    for (const k of ['energy', 'key']) { if (o[k] == null) o[k] = this.fresh(outTrack)?.[k]; if (i[k] == null) i[k] = this.fresh(innTrack)?.[k]; }
    return { ...autoTransitionLength(o, i, style, { keySync: !!this.opts.keySync }), auto: true };
  }

  /** Structure info for a queued track that is not on a deck yet (library copy). */
  trackInfo(t) {
    const f = this.fresh(t) || {};
    return { ...f };
  }

  /** Length of the transition into queue entry i with the given style (for the queue panel). */
  lengthForQueue(i, style) {
    const t = this.queue[i]; if (!t || !style) return null;
    if (i === this.idx && this.upcoming?.adaptive && this.upcoming.style === style) return this.upcoming.length;
    const planned = this.plans.get(t);
    if (planned && planned.style === style && this.opts.lengthMode === 'auto') return { beats: planned.beats, bars: planned.bars, auto: true, why: planned.lengthWhy };
    const cur = this.current, nextDeck = cur ? this.other(cur) : null;
    const out = i === this.idx && cur?.track ? this.info(cur) : this.trackInfo(this.queue[i - 1]);
    const outTrack = i === this.idx && cur?.track ? cur.track : this.queue[i - 1];
    const inn = i === this.idx && nextDeck?.track?.id === t.id && !nextDeck.loading ? this.info(nextDeck) : this.trackInfo(t);
    return this.lengthFor(out, inn, style, outTrack, t);
  }

  /** The next transition: { style, why, begin (outgoing position), drop?, beginsIn (s) } (cached until something changes). */
  nextTransition() {
    const cur = this.current, next = this.nextTrack();
    if (!this.enabled || !cur?.track || !next) return null;
    const nd = this.other(cur), innReady = nd?.track?.id === next.id && !nd.loading;
    const oi = this.info(cur), ii = innReady ? this.info(nd) : this.trackInfo(next);
    const signature = (t) => ['bpm', 'bpmConfidence', 'gridOffset', 'downbeat', 'duration', 'startTime', 'endTime', 'mixIn', 'mixOut', 'phrases', 'key', 'energy', 'genre', 'vocalMap', 'stems'].map((k) => t[k]);
    const nudge = this.nudges?.get(next) || null;
    const key = JSON.stringify([cur.track.id, next.id, this.opts, this.overrides.get(next), nudge, signature(oi), signature(ii), cur.rate, cur.stemsReady, nd?.stemsReady, this.app.settings.mixLearning]);
    if (this.upcoming && (cur.position < (this.upcoming.observed || 0) - (cur.beatLen || 0.5) * 4 || cur.position > (this.upcoming.plan.drop ?? this.upcoming.plan.end ?? Infinity))) this.upcoming = null;
    // rehearse, then commit (P6.4): two bars before it begins the plan is locked; analysis or stem updates arriving
    // now re-plan only the transition after this one (a DJ's own override or nudge still applies)
    const u0 = this.upcoming, bar0 = 4 * (cur.beatLen || 0.5);
    const locked = u0 && u0.nextId === next.id && u0.userKey === JSON.stringify([this.overrides.get(next), nudge])
      && cur.position >= u0.plan.begin - 2 * bar0 && cur.position < u0.plan.begin + bar0;
    if (locked) u0.key = key;
    if (!this.upcoming || this.upcoming.key !== key) {
      const s = this.styleFor(this.idx, this.app.library?.track?.(cur.track.id) || cur.track);
      const length = s.plan && this.opts.lengthMode === 'auto' ? { beats: s.plan.beats, bars: s.plan.bars, auto: true, why: s.plan.lengthWhy }
        : this.lengthFor(oi, innReady ? this.info(nd) : this.trackInfo(next), s.style, cur.track, next);
      this.upcoming = { key, nextId: next.id, userKey: JSON.stringify([this.overrides.get(next), nudge]), ...s, length, plan: planTransition(oi, s.style, { ...this.opts, transitionBeats: length.beats }) };
      if (s.plan && (!s.override || this.overrides.get(next) === 'auto')) {
        const adaptive = planAdaptiveTransition(oi, ii, {
          position: cur.position, entry: cur._autoMixEntry || 0, rate: cur.rate, keepSync: this.opts.keepSync,
          stemsOut: !!cur.stemsReady, stemsIn: !!nd?.stemsReady,
          fixedBars: nudge?.bars || (this.opts.lengthMode === 'auto' ? null : length.bars), exitShift: nudge?.shift || 0,
          doubleDrops: this.opts.doubleDrops === false ? false : undefined,
          prevStyle: this._lastStyle, vary: !!this.opts.varyStyles, recent: this._recent, learning: this.app.settings.mixLearning,
        });
        if (adaptive) Object.assign(this.upcoming, { style: adaptive.style, why: adaptive.why, plan: adaptive.timing, adaptive,
          length: { beats: adaptive.beats, bars: adaptive.bars, auto: this.opts.lengthMode === 'auto', why: adaptive.lengthWhy } });
      }
    }
    const u = this.upcoming;
    u.observed = cur.position;
    return { style: u.style, why: u.why, override: u.override, begin: u.plan.begin, drop: u.plan.drop, length: u.length, beginsIn: Math.max(0, (u.plan.begin - cur.position) / (cur.rate || 1)) };
  }

  tick() {
    if (!this.enabled) return;
    const cur = this.current;
    if (!cur) return;
    if (this.opts.watchdog !== false && this.watch()) return;
    if (this.transition) return this.stepTransition();
    if (this.tempoRamp) this.stepTempoRamp();
    if (this.levelEase) this.stepLevelEase();
    if (this.opts.tricks !== 'off') this.stepTricks();
    const next = this.nextTrack();
    if (this.forceTransitionRequested) {
      const incoming = this.other(cur);
      if (!next) { this.forceTransitionRequested = false; this.emit('state'); return; }
      if (incoming.track?.id === next.id && !incoming.loading && !this._loading) {
        this.forceTransitionRequested = false; this.beginTransition(true); return;
      }
      if (!this._loading && !incoming.loading) this.preloadNext();
      return;
    }
    if (!cur.playing && !cur.loading && cur.track && cur.position >= cur.duration - 0.05) {
      // track ended without a transition (e.g. next track failed to load)
      if (next) this.beginTransition(true); else this.stop();
      return;
    }
    if (!next && cur.playing && cur.track) { this.stepFinale(cur); return; }
    if (!cur.track || !cur.playing || !next) return;
    const nxt = this.other(cur);
    if (nxt.track?.id !== next.id) { if (!this._loading && !nxt.loading) this.preloadNext(); return; }
    if (nxt.loading) return;
    const nt = this.nextTransition();
    if (nt && cur.position >= nt.begin) this.beginTransition();
  }

  /**
   * Party safety (P0.1): watch the master output and the on-air deck; silence, a stalled or a stopped deck that lasts
   * longer than any planned effect is rescued: the fader and EQ are restored, a stuck transition is completed, or the
   * next track is cut in on the beat. Returns true when it acted this tick.
   */
  watch() {
    const ctx = this.engine.ctx, t = ctx?.currentTime;
    if (!Number.isFinite(t) || typeof this.engine.masterLevels !== 'function') return false;
    if (ctx.state === 'suspended') { this.engine.resume?.(); return false; }
    const wd = this.watchdog ||= new Watchdog();
    const tr = this.transition, cur = this.current;
    const deck = tr ? (tr.drop && tr.phase === 'pre' ? tr.out : tr.inn) : cur;
    const masterOn = (this.engine.masterGain?.gain?.value ?? 1) > 0.02;
    const expectSilence = !!(tr?.drop && tr.phase === 'pre') || !!this._trickSilence || quietAt(deck?.waveform, deck?.position, 2.5)
      || !!deck?.loading || !!deck?.scratching;
    const [l, r] = this.engine.masterLevels() || [0, 0];
    const trouble = wd.update({ t, level: Math.max(l || 0, r || 0), position: deck?.position, playing: !!deck?.playing,
      expectSilence, active: masterOn && !!deck?.track });
    // a transition that runs far past its planned length is finished as well
    const overdue = tr && !tr.drop && tr.dur && this.now() - tr.t0 > tr.dur + 4000;
    if (!trouble && !overdue) return false;
    this.rescue(overdue ? 'overdue' : trouble.kind);
    wd.cooldown(t, 4);
    return true;
  }

  rescue(kind) {
    this.rescues = (this.rescues || 0) + 1;
    console.warn(`[automix] rescue: ${kind}`);
    this.emit('rescue', { kind });
    if (this.transition) { this.finishTransition(true); this.app.toast?.(t('Automix: finished a stuck transition')); return; }
    const cur = this.current, ch = this.engine.channels[cur.index];
    // the fader or EQ of the on-air deck was left down (a controller, a stale automation): bring it back first
    if (kind === 'silent' && cur.playing && ch?.state && (ch.state.volume < 0.05 || ch.state.eqLow <= -0.99 && ch.state.eqMid <= -0.99)) {
      this.prepare(cur); this.app.toast?.(t('Automix: restored the on-air deck level')); return;
    }
    const next = this.nextTrack(), inn = this.other(cur);
    if (next && inn.track?.id === next.id && !inn.loading) { this.beginTransition(true); this.app.toast?.(t('Automix: the music stopped, started the next track')); return; }
    if (kind === 'stopped' && cur.track && cur.position < (cur.duration || 0) - 2) { cur.play(); return; }
    // nothing ready yet: load the next track and cut to it as soon as it is there
    if (next) { this.forceTransitionRequested = true; this.preloadNext(); }
  }

  /**
   * After a transition the incoming track keeps the outgoing track's tempo; without this every track would
   * inherit the previous one's speed and the drift adds up. Ease it back to 0 % over a few bars (setting
   * automix.restoreTempo, default on). Moving the tempo fader / sync by hand cancels it.
   */
  startTempoRamp(deck) {
    this.tempoRamp = null;
    if (this.opts.restoreTempo === false || !deck || Math.abs(deck.tempo) < 0.01 || deck.syncOn) return;
    const bpm = deck.effectiveBpm || 120;
    this.tempoRamp = { deck, from: deck.tempo, last: deck.tempo, t0: this.now(), dur: (restoreBars(deck.tempo, bpm) * 4 * 60 / bpm) * 1000 };
  }
  stepTempoRamp() {
    const r = this.tempoRamp, d = r.deck;
    if (d !== this.current || d.syncOn || Math.abs(d.tempo - r.last) > 0.05) { this.tempoRamp = null; return; } // user took over
    const k = (this.now() - r.t0) / r.dur;
    r.last = tempoRampValue(r.from, k);
    d.setTempo(k >= 1 ? 0 : r.last);
    if (k >= 1) this.tempoRamp = null;
  }

  /**
   * The end of the set (no next track): the last track fades out over its final 8 bars in a reverb wash, like a DJ
   * closing the night, then automix stops. settings.automix.finale false: it just plays to its end.
   */
  stepFinale(cur) {
    // an endless set that just ran short: top the queue up instead of ending
    if ((this.live?.endless || this.refill?.endless) && !this.windingDown()) { this.fillLive(); this.fillMore(); if (this.nextTrack()) this.preloadNext(); return; }
    if (this.opts.finale === false || !cur.bpm) return;
    const bars8 = 8 * 4 * 60 / (cur.effectiveBpm || cur.bpm), end = Math.min(cur.duration || 0, Number(this.fresh(cur.track)?.endTime) || cur.duration || 0);
    const ch = this.engine.channels[cur.index], now = this.now();
    if (!this._finale) {
      if (end - cur.position > bars8 / (cur.rate || 1) || end - cur.position < 2) return;
      this.endTrick(true);
      this._finale = { t0: now, dur: Math.max(2000, (end - cur.position) / (cur.rate || 1) * 1000) };
      ch.set('fxType', 'reverb'); ch.set('fxParam', 0.85); ch.set('fxMix', 0.15); ch.set('fxOn', true);
      this.emit('finale');
    }
    const k = clamp01((now - this._finale.t0) / this._finale.dur);
    ch.set('fxMix', 0.15 + 0.6 * k); ch.set('eqLow', -0.6 * ease(k)); ch.set('volume', 0.8 * Math.sqrt(1 - ease(k)));
    if (k >= 1) { cur.pause(); ch.set('fxOn', false); ch.set('eqLow', 0); this._finale = null; this.app.toast?.(t('Automix: the set is over')); this.stop(); }
  }

  // ---------- tricks (P5, automix-tricks.js) ----------
  /** Where the set is (0..1) for the energy arc, and the arc phase there. */
  setPhase() {
    const shape = this.live?.shape || this.opts.shape || 'warmup';
    const x = this.live ? (this.live.endless ? (this.idx % this.live.setLength) / this.live.setLength : this.idx / Math.max(1, this.live.setLength)) : this.idx / Math.max(1, this.queue.length);
    try { return arcPhase(shape, Math.min(1, x), { now: Date.now(), elapsedMin: this.startedAt ? (Date.now() - this.startedAt) / 60000 : 0, endless: !!this.live?.endless || !!this.refill?.endless }); } catch { return 'build'; }
  }
  /** Plan the tricks for the on-air track, in the window that is free of transitions. */
  planTricksNow(deck) {
    const mode = this.opts.tricks || 'subtle', nt = this.nextTransition();
    const key = `${deck.track.id}|${mode}|${Math.round((nt?.begin ?? -1) * 2)}|${Math.round((deck.position || 0) / 30)}`;
    if (this.trickPlan?.key === key) return;
    const t = { ...this.info(deck) };
    t.vocalMap = t.vocalMap || decodeVocalMap(t.stems?.vocals);
    const bar = 240 / (deck.bpm || 120), rate = deck.rate || 1, now = Date.now(), pos = deck.position || 0;
    const to = (nt ? nt.begin : (deck.duration || 0) - 32 * bar) - 8 * bar;
    const events = planTricks(t, { from: pos + 2 * bar, to, mode, phase: this.setPhase(), familiar: isFamiliar(this.fresh(deck.track), this.famInfo || familiarityInfo(this.queue)),
      history: this.trickHistory || [], nowMs: now, positionToMs: (sec) => now + (sec - pos) / rate * 1000 });
    this.trickPlan = { key, deck, events };
  }
  stepTricks() {
    const cur = this.current;
    if (this.trick) return this.stepTrick();
    if (!cur?.playing || !cur.track || !cur.bpm || this.transition) return;
    this.planTricksNow(cur);
    const ev = this.trickPlan?.events.find((e) => !e.done);
    if (!ev || this.trickPlan.deck !== cur) return;
    const ahead = (ev.start - cur.position) / (cur.rate || 1);
    if (ahead < -0.3) { ev.done = true; return; } // passed (a seek): skip it
    if (ahead <= 0.15) this.startTrick(ev, cur);
  }
  startTrick(ev, d) {
    const ch = this.engine.channels[d.index], ctxT = this.engine.ctx?.currentTime;
    if (!ch || !Number.isFinite(ctxT)) { ev.done = true; return; }
    const rate = d.rate || 1, beatSec = 60 / (d.effectiveBpm || d.bpm || 120);
    const atStart = ctxT + Math.max(0, (ev.start - d.position) / rate), atRes = ctxT + Math.max(0, (ev.at - d.position) / rate);
    const tr = this.trick = { ev, d, ch, atStart, atRes, beatSec, saved: { fxType: ch.state.fxType, fxMix: ch.state.fxMix, fxParam: ch.state.fxParam, fxBeats: ch.state.fxBeats } };
    ev.done = true;
    (this.trickHistory ||= []).push({ id: ev.id, atMs: Date.now() });
    if (ev.id === 'bassTease' || ev.id === 'grooveLift') ch.scheduleEq?.({ eqLow: -1 }, atStart);
    else if (ev.id === 'pauseDrop') { ch.scheduleEq?.({ eqLow: -1, eqMid: -1, eqHigh: -1 }, atStart); this._trickSilence = true; }
    else if (ev.id === 'echoFreeze') { ch.set('fxType', 'echo'); ch.set('fxBeats', 0.5); ch.set('fxParam', 0.85); ch.set('fxMix', 0.5); ch.set('fxOn', true); }
    else if (ev.id === 'horn') {
      const sm = this.engine.sampler, i = sm?.slots?.findIndex((s) => s?.sound === 'airhorn' && s.buffer);
      if (i >= 0) sm.trigger(i, { when: atRes, velocity: 0.55 });
      this.trick = null; this.emit('trick', ev); return;
    } else if (ev.id === 'rewind') { d.backspin(Math.max(0.4, 2 * beatSec)); tr.spinEnd = atStart + Math.max(0.4, 2 * beatSec); this._trickSilence = true; }
    this.emit('trick', ev);
  }
  stepTrick() {
    const tr = this.trick, ctxT = this.engine.ctx?.currentTime;
    if (!tr || !Number.isFinite(ctxT)) return;
    if (tr.d !== this.current) return this.endTrick(true);
    const { ev, ch, d } = tr, k = clamp01((ctxT - tr.atStart) / Math.max(0.05, tr.atRes - tr.atStart));
    if (ev.id === 'filterBuild') ch.set('filter', -0.7 * ease(k));
    if (ev.id === 'loopRoll' && ctxT >= tr.atStart && tr.atRes - ctxT > 0.02) {
      const size = rollSize(Math.floor((ctxT - tr.atStart) / tr.beatSec), Math.round(ev.bars * 4));
      if (size !== tr.size) { if (tr.size) d.rollOff(); d.rollOn(size); tr.size = size; }
      ch.set('filter', 0.5 * ease(k));
    }
    if (ev.id === 'rewind') {
      if (!tr.restarted && ctxT >= tr.spinEnd + 0.05) {
        tr.restarted = true; d.seek(ev.restart ?? Math.max(0, ev.at - 16 * 4 * tr.beatSec)); d.play({ at: ctxT + 0.03, instant: true });
        this._trickSilence = false; this.trickPlan = null; this.upcoming = null; this.trick = null;
      }
      return;
    }
    if (tr.atRes - ctxT <= 0.15) this.endTrick(false);
  }
  /** Resolve the trick on its downbeat (scheduled), or undo it at once (abort). */
  endTrick(abort) {
    const tr = this.trick; if (!tr) return;
    this.trick = null;
    const { ev, ch, d } = tr, at = abort ? this.engine.ctx?.currentTime : tr.atRes;
    if (['bassTease', 'grooveLift', 'pauseDrop'].includes(ev.id)) ch.scheduleEq?.(ev.id === 'pauseDrop' ? { eqLow: 0, eqMid: 0, eqHigh: 0 } : { eqLow: 0 }, at);
    if (ev.id === 'filterBuild' || ev.id === 'loopRoll') ch.set('filter', 0);
    if (ev.id === 'loopRoll' && d.rolling) d.rollOff();
    if (ev.id === 'echoFreeze') { ch.set('fxOn', false); for (const [key, v] of Object.entries(tr.saved)) ch.set(key, v); }
    if (ev.id === 'rewind' && abort && !d.playing && d.track) d.play();
    if (ev.id === 'pauseDrop' && !abort) setTimeout(() => { this._trickSilence = false; }, Math.max(0, (tr.atRes - (this.engine.ctx?.currentTime || 0)) * 1000) + 200);
    else this._trickSilence = false;
  }

  /** Ease a landing trim back to the track's own level-match gain over 8 bars. */
  stepLevelEase() {
    const e = this.levelEase;
    if (e.deck !== this.current) { this.levelEase = null; return; }
    const k = clamp01((this.now() - e.t0) / e.dur);
    e.ch.setAutoGain(e.base + e.db * (1 - ease(k)));
    if (k >= 1) this.levelEase = null;
  }

  beginTransition(immediate = false) {
    this.tempoRamp = null;
    this.endTrick(true); this.trickPlan = null;
    const out = this.current, inn = this.other(out);
    const next = this.nextTrack();
    if (!next) { if (!out.playing) this.stop(); return; }
    if (!inn.track || inn.loading || inn.track.id !== next.id) { if (!inn.loading && !this._loading) this.preloadNext(); return; }
    const oi = this.info(out), ii = this.info(inn);
    const posAt = this.engine.ctx?.currentTime; // the start is planned for this audio time
    const pos = Number.isFinite(posAt) && typeof out.positionAt === 'function' ? out.positionAt(posAt) : out.position;
    if (!immediate) this.nextTransition();
    const upcoming = !immediate ? this.upcoming : null;
    let { style, why, plan: planned } = this.styleFor(this.idx, this.app.library?.track?.(out.track.id) || out.track) || { style: 'blend' };
    if (upcoming?.adaptive) { style = upcoming.style; why = upcoming.why; planned = upcoming.adaptive; }
    let vocals = planned?.vocals || null;
    if (style === 'stemswap' && !(out.stemsReady && inn.stemsReady)) { style = 'blend'; vocals = 'hold-in'; why = `${why ? why + '; ' : ''}AI stems not loaded on both decks: smooth blend`; }
    if (!out.playing) style = 'cut'; // the outgoing track already ended: just start the next one
    if (DROP_STYLES.has(style) && (!out.bpm || !inn.bpm) && style !== 'echo' && style !== 'cut') style = 'echo';
    // a big tempo gap (> 8 %, half / double time allowed) is never beat-matched: a blend would play the incoming track
    // far off its own tempo (122 -> 96 BPM at +27 %) and then glide back. Blend styles fall back to echo out / cut,
    // as the Auto style does, and every drop style starts the incoming track at its own tempo on the bar line.
    const outBpm = out.effectiveBpm || out.bpm, bigJump = !!(outBpm && inn.bpm) && tempoDistance(outBpm, inn.bpm) > LOG_BPM_JUMP;
    if (bigJump && !DROP_STYLES.has(style)) {
      const de = (Number(inn.track?.energy) || 0) - (Number(out.track?.energy) || 0);
      const was = STYLE_LABEL[style] || style;
      style = de >= 2 ? 'cut' : 'echo';
      why = `${why ? why + '; ' : ''}${Math.round(outBpm)} → ${Math.round(inn.bpm)} BPM is too far to beat-match: ${STYLE_LABEL[style]} instead of ${was}`;
    }
    const length = upcoming?.adaptive && style === upcoming.style ? upcoming.length : planned && planned.style === style && this.opts.lengthMode === 'auto' ? { beats: planned.beats, bars: planned.bars, auto: true, why: planned.lengthWhy }
      : this.lengthFor(oi, ii, style, out.track, inn.track);
    const plan = upcoming?.adaptive && style === upcoming.style && out.playing ? upcoming.plan : planTransition(oi, style, { ...this.opts, transitionBeats: length.beats }, { pos, immediate: immediate || !out.playing });
    const cue = upcoming?.adaptive?.inStart ?? incomingStart(ii);
    this.prepare(inn);
    const chI = this.engine.channels[inn.index], chO = this.engine.channels[out.index];
    chI.set('volume', 0);
    let morph = null;
    if (this.opts.keepSync && out.bpm && inn.bpm && !bigJump && !DROP_STYLES.has(style)) {
      out.setMaster(); inn.syncOn = true; inn.matchTempo();
      // ride the master tempo over to the incoming track's own tempo during the blend, so it is never stretched
      // after it (P1.6); the synced incoming deck follows
      const to = this.opts.tempoMorph === false || immediate ? null : morphTarget(out, inn);
      if (to != null) morph = { from: out.tempo || 0, to };
    }
    else { inn.syncOn = false; if (Math.abs(inn.tempo || 0) > 0.01) inn.setTempo(0); } // its own tempo: nothing to ramp back afterwards
    // key clash → shift the incoming track's key to a compatible one (if the deck supports it)
    if (this.opts.keySync && typeof inn.keySyncTo === 'function') {
      const outKey = out.playingCamelot || out.camelot || out.track?.key;
      if (keysClash(outKey, inn.camelot || inn.track?.key)) { try { inn.keySyncTo(out); } catch (e) { console.warn('keySyncTo failed', e); } }
    }
    const fx = { ...chO.state }; // FX / EQ settings to restore on the outgoing channel afterwards
    const tr = { skipped: !!this._skipNext, morph, out, inn, style, why, vocals: DROP_STYLES.has(style) ? null : vocals, length: immediate || !out.playing ? null : length, t0: this.now(), fxSaved: { fxType: fx.fxType, fxMix: fx.fxMix, fxParam: fx.fxParam, fxBeats: fx.fxBeats, fxOn: fx.fxOn } };
    if (DROP_STYLES.has(style)) {
      // the incoming track waits at its first downbeat and drops in on the outgoing track's bar line
      inn.seek(cue); inn._autoMixEntry = cue;
      const rate = out.playing ? out.rate || 1 : 1;
      const toDrop = Math.max(0, (plan.drop - pos) / rate);
      Object.assign(tr, { drop: true, phase: 'pre', dropWall: tr.t0 + toDrop * 1000, beatWall: (out.bpm ? 60 / out.bpm / rate : 0.5) * 1000, plan });
      tr.postWall = tr.beatWall * plan.post;
      if (this.opts.levelMatch !== false) {
        const extra = landingTrim(this.fresh(out.track) && { ...this.fresh(out.track), ...oi }, plan.drop - 0.1, { ...this.fresh(inn.track), ...ii }, cue + 0.1);
        if (extra != null) tr.landTrim = { db: extra, base: Number(this.fresh(inn.track)?.gain ?? inn.track?.gain) || 0 };
      }
      this.startEffect(tr);
    } else {
      // blend styles: tempo-matched incoming track starts at its mix-in point, bar/phrase-aligned with the outgoing one
      let len, offBeats;
      if (immediate) { len = 4 * (out.beatLen || 0.5); offBeats = barOffsetBeats(oi, pos); }
      else {
        const late = pos - plan.start;
        offBeats = barOffsetBeats(oi, pos, plan.start);
        len = out.bpm && late / out.beatLen <= 4 ? plan.len - Math.max(0, late) : Math.min(plan.len, (plan.end ?? oi.duration) - pos);
      }
      len = Math.max(2, len);
      const durWall = Math.max(2, len / (out.rate || 1));
      const inStart = cue + (upcoming?.adaptive ? Math.max(0, pos - plan.start) * (inn.rate || 1) / (out.rate || 1) : inn.bpm && out.bpm ? offBeats * inn.beatLen : 0);
      inn.seek(inStart); inn._autoMixEntry = inStart;
      inn.play({ at: posAt, instant: true }); // on the beat even if the message reaches the audio thread late
      const lenIn = upcoming?.adaptive ? len * (inn.rate || 1) / (out.rate || 1) : inn.bpm && out.bpm ? (len / out.beatLen) * inn.beatLen : len;
      Object.assign(tr, { dur: durWall * 1000, inStart, swapAt: upcoming?.adaptive?.swapIn ?? (SWAP_STYLES.has(style) ? phraseSwapPoint(ii, inStart, lenIn) : null), kSwap: null });
      if (tr.vocals === 'hold-in') chI.set('vocal', 0);
      if (style === 'stemswap') this.applyStemSwap(tr, 0);
    }
    this.transition = tr; this._skipNext = false;
    this._lastStyle = style;
    this._recent = [...this._recent.slice(-5), upcoming?.adaptive?.doubleDrop ? 'doubledrop' : style];
    tr.echoBeats = echoBeatsFor(this.fresh(out.track), this.fresh(inn.track));
    this.idx++;
    this.upcoming = null;
    this.emit('transition', { style, why, length: tr.length });
    this.emit('state');
  }

  /** Drop styles: start the outgoing track's effect. */
  startEffect(tr) {
    const chO = this.engine.channels[tr.out.index], d = tr.out, bw = tr.beatWall / 1000;
    // echo out (P2.4): tempo-synced delay of the family's length, feedback about 50 %, wet rising over the last bars
    if (tr.style === 'echo') { chO.set('fxType', 'echo'); chO.set('fxBeats', tr.echoBeats || echoBeatsFor(this.fresh(tr.out.track), this.fresh(tr.inn.track))); chO.set('fxParam', 0.5); chO.set('fxMix', 0.25); chO.set('fxOn', true); }
    else if (tr.style === 'reverb') { chO.set('fxType', 'reverb'); chO.set('fxParam', 0.8); chO.set('fxMix', 0.2); chO.set('fxOn', true); }
    else if (tr.style === 'backspin') d.backspin(Math.max(0.4, tr.plan.pre * bw));
    else if (tr.style === 'brake') d.brake(Math.max(0.5, tr.plan.pre * bw));
    else if (tr.style === 'loop' && d.bpm) { const s = d.floorBeat ? d.floorBeat(d.position) : d.position; tr.loopStart = s; tr.loopBeats = 4; d.setLoop(s, s + 4 * d.beatLen); }
  }

  stepTransition() {
    const tr = this.transition;
    const chO = this.engine.channels[tr.out.index], chI = this.engine.channels[tr.inn.index];
    if (tr.drop) return this.stepDrop(tr, chO, chI);
    const k = Math.min(1, (this.now() - tr.t0) / tr.dur);
    if (tr.swapAt != null && tr.kSwap == null) {
      // the bass swap is scheduled on the audio clock a little ahead, so it lands exactly on the phrase line however
      // late this tick runs (P0.5)
      const ctxT = this.engine.ctx?.currentTime, rate = tr.inn.rate || 1;
      const ahead = (tr.swapAt - tr.inn.position) / rate;
      if (Number.isFinite(ctxT) && ahead <= 0.15 && ahead > -0.05 && typeof chI.scheduleEq === 'function' && tr.inn.playing) {
        const at = ctxT + Math.max(0, ahead);
        chI.scheduleEq({ eqLow: 0 }, at); chO.scheduleEq({ eqLow: -1 }, at);
        tr.kSwap = Math.min(1, k + Math.max(0, ahead) * 1000 / tr.dur); tr.swapScheduledAt = at;
      } else if (ahead <= 0 || k >= 0.9) tr.kSwap = k;
    }
    if (tr.morph && tr.out.isMaster !== false) { const v = tr.morph.from + (tr.morph.to - tr.morph.from) * ease(clamp01(k / 0.9)); if (Math.abs(v - (tr.out.tempo || 0)) > 0.01) tr.out.setTempo(v); }
    if (tr.style === 'stemswap') { this.applyStemSwap(tr, k); if (k >= 1) this.finishTransition(); return; }
    this.keepPhase(tr, k);
    const L = mixLevels(tr.style, k, tr.kSwap);
    if (tr.vocals === 'hold-in') {
      // incoming vocals wait for the swap (blend: the bass swap; other styles: 60 %), then trade places with the outgoing ones
      const at = tr.kSwap ?? (tr.style === 'blend' ? null : 0.6);
      const p = at == null || k < at ? 0 : clamp01((k - at) / Math.max(0.05, Math.min(0.3, 1 - at)));
      chI.set('vocal', ease(p)); chO.set('vocal', 1 - ease(p));
    }
    const map = { inVol: [chI, 'volume'], outVol: [chO, 'volume'], inLow: [chI, 'eqLow'], inMid: [chI, 'eqMid'], inHigh: [chI, 'eqHigh'], outLow: [chO, 'eqLow'], outMid: [chO, 'eqMid'], outHigh: [chO, 'eqHigh'], inFilter: [chI, 'filter'], outFilter: [chO, 'filter'] };
    for (const [k2, [ch, key]] of Object.entries(map)) if (L[k2] != null) ch.set(key, L[k2]);
    if (L.echo && !chO.state.fxOn) { chO.set('fxType', 'echo'); chO.set('fxBeats', tr.echoBeats || 0.75); chO.set('fxMix', 0.6); chO.set('fxOn', true); }
    if (k >= 1) this.finishTransition();
  }

  /**
   * Like a DJ riding the pitch during a blend: four times a second, compare the two decks' beat phases at the same
   * audio time; drift over PHASE_TOLERANCE is pulled back with a small pitch bend (at most MAX_PHASE_BEND), and a big
   * error early in the blend (the incoming track still quiet) is snapped into phase. Only for synced decks at the same
   * tempo (not half / double time).
   */
  keepPhase(tr, k) {
    const { out, inn } = tr;
    if (!inn.syncOn || !out.playing || !inn.playing || !out.bpm || !inn.bpm || inn._pendingPlay || typeof inn.positionAt !== 'function' || typeof inn.setBend !== 'function') return;
    const t = this.engine.ctx?.currentTime;
    if (!Number.isFinite(t) || t - (tr.phaseAt || 0) < 0.25) return;
    tr.phaseAt = t;
    const err = phaseErrorSeconds(out, inn, t);
    if (err == null) return;
    tr.phaseErr = err;
    if (Math.abs(err) > PHASE_SNAP && k < 0.2 && !tr.phaseSnapped) { tr.phaseSnapped = true; inn.setBend(0); inn.alignPhase(); return; }
    const bend = Math.abs(err) < PHASE_TOLERANCE ? 0 : Math.max(-MAX_PHASE_BEND, Math.min(MAX_PHASE_BEND, err / 0.5)); // fix it over ~0.5 s
    if (bend !== (inn.bend || 0)) { inn.setBend(bend); tr.phaseBend = true; }
  }

  /** Stem swap: per-stem levels on both decks (AI stems), see stemSwapLevels in mix-planner.js. */
  applyStemSwap(tr, k) {
    const L = stemSwapLevels(k);
    const chO = this.engine.channels[tr.out.index], chI = this.engine.channels[tr.inn.index];
    chI.set('volume', L.inVol); chO.set('volume', L.outVol);
    const put = (deck, lv) => lv.forEach((v, i) => { const was = deck.stemLevels?.[i] ?? 1; if (was !== v && (Math.abs(was - v) > 0.004 || v === 0 || v === 1)) deck.setStemLevel?.(i, v); });
    put(tr.inn, L.inn); put(tr.out, L.out);
  }

  /** Drop styles: effect build-up, the drop on the bar line, then the tail. Wall-clock driven (loops / spins stop the position). */
  stepDrop(tr, chO, chI) {
    const now = this.now();
    if (tr.phase === 'pre') {
      const span = Math.max(1, tr.dropWall - tr.t0), e = clamp01((now - tr.t0) / span);
      if (tr.style === 'echo') { chO.set('fxMix', 0.25 + 0.45 * e); chO.set('fxParam', 0.45 + 0.3 * e); chO.set('filter', 0.3 * e); chO.set('eqLow', -0.6 * e); }
      else if (tr.style === 'reverb') { chO.set('fxMix', 0.2 + 0.75 * e); chO.set('filter', 0.45 * e); chO.set('eqLow', -0.7 * e); }
      else if (tr.style === 'backspin' || tr.style === 'brake') chO.set('volume', 0.8 * Math.sqrt(1 - ease(clamp01((e - 0.55) / 0.45))));
      else if (tr.style === 'loop' && tr.loopStart != null) {
        // roll the loop shorter: 1 bar for 2 bars, then 2 beats, 1, 1/2, 1/4; the high-pass rises with it
        const b = (now - tr.t0) / tr.beatWall;
        const want = b < 8 ? 4 : b < 12 ? 2 : b < 14 ? 1 : b < 15 ? 0.5 : 0.25;
        if (want !== tr.loopBeats) { tr.loopBeats = want; const d = tr.out, s = d.floorBeat ? d.floorBeat(d.position) : tr.loopStart; tr.loopStart = s; d.setLoop(s, s + want * d.beatLen); }
        chO.set('filter', 0.55 * e);
      }
      if (now >= tr.dropWall - 10) this.dropIn(tr, chO, chI);
      return;
    }
    // tail after the drop: echo / reverb ring out on the outgoing fader (pre-fader FX), or on their own after the
    // fader cut (post-fader FX tails: the tail decays naturally, nothing to fade)
    const p = tr.postWall > 0 ? clamp01((now - tr.dropAt) / tr.postWall) : 1;
    if (tr.postWall > 0 && !tr.tailPost) chO.set('volume', 0.8 * Math.sqrt(1 - ease(p)));
    if (p >= 1) this.finishTransition();
  }

  dropIn(tr, chO, chI) {
    tr.phase = 'post'; tr.dropAt = this.now();
    const { out, inn } = tr;
    tr.tailPost = (tr.style === 'echo' || tr.style === 'reverb') && this.engine.settings?.fxPostFader !== false;
    // echo out / reverb wash: with post-fader FX tails the fader cuts the dry signal and the tail rings out on its own
    // (a real echo-out); with pre-fader FX the EQ kills the dry signal and the fader fades the tail afterwards
    if (tr.style === 'echo' || tr.style === 'reverb') { if (tr.tailPost) chO.set('volume', 0); else { chO.set('eqLow', -1); chO.set('eqMid', -1); chO.set('eqHigh', -1); } }
    else chO.set('volume', 0);
    for (const k of ['eqLow', 'eqMid', 'eqHigh', 'filter']) chI.set(k, 0);
    chI.set('volume', 0.8);
    if (tr.landTrim && typeof chI.setAutoGain === 'function') {
      chI.setAutoGain(tr.landTrim.base + tr.landTrim.db);
      this.levelEase = { ch: chI, deck: inn, ...tr.landTrim, t0: this.now(), dur: 8 * 4 * (60 / (inn.effectiveBpm || inn.bpm || 120)) * 1000 };
    }
    inn.play({ at: tr.dropWall / 1000, instant: true }); // exactly on the bar line (the tick may come a little early or late)
    if (tr.style === 'loop' || tr.style === 'cut') setTimeout(() => { if (out !== this.current || this.transition?.out === out) { out.exitLoop?.(); out.loop = null; } }, 30);
    this.emit('state');
  }

  finishTransition(aborted = false) {
    const tr = this.transition;
    const { out, inn } = tr;
    this.transition = null;
    const chO = this.engine.channels[out.index], chI = this.engine.channels[inn.index];
    if (tr.phaseBend && inn.bend) inn.setBend(0); // the phase keeper's pitch bend ends with the blend
    out.pause();
    if (out.loop?.active) out.exitLoop();
    out.loop = null;
    chO.set('fxOn', false);
    const restoreFx = () => { for (const [k, v] of Object.entries(tr.fxSaved || {})) if (k !== 'fxOn') chO.set(k, v); };
    // post-fader tail still ringing: changing the effect type / mix now would cut it, so restore the user's FX
    // settings once it has died away (unless the FX unit has been switched on again meanwhile)
    if (tr.tailPost && !aborted) setTimeout(() => { if (!chO.state.fxOn) restoreFx(); }, 8000);
    else restoreFx();
    for (const ch of [chO, chI]) { ch.set('eqLow', 0); ch.set('eqMid', 0); ch.set('eqHigh', 0); ch.set('filter', 0); if (tr.vocals || tr.style === 'stemswap') ch.set('vocal', 1); }
    if (tr.style === 'stemswap') for (const d of [out, inn]) for (let i = 0; i < 4; i++) if (d.stemLevels?.[i] !== 1) d.setStemLevel?.(i, 1);
    if (aborted) {
      // stopping mid-transition: finish the move to the incoming deck so the mixer isn't left half-mixed
      chI.set('volume', 0.8); chO.set('volume', 0.8);
      if (!inn.playing) inn.play();
      inn.syncOn = false; inn.setMaster?.(); this.current = inn;
      return;
    }
    if (!inn.playing) { chI.set('volume', 0.8); inn.play(); }
    if (out.track && !tr.skipped) this.feedback = playFeedback(this.feedback || emptyFeedback(), this.fresh(out.track), { now: Date.now() });
    inn.setMaster(); inn.syncOn = false;
    this.current = inn;
    this.startTempoRamp(inn);
    this.fillLive();
    this.fillMore();
    if (this.nextTrack()) setTimeout(() => this.preloadNext(), 500);
    else this.emit('ending');
    this.emit('state');
  }

  /**
   * A track the user loads on deck 1 / 2 while automix runs (drag & drop, "Load to deck", double-click, keys, MIDI).
   * Next deck → it becomes the next track (automix mixes into it). On-air deck → ask (or settings.automix.onAirLoad:
   * 'queue' | 'stop'). During a transition → queued as the next track (both decks are busy; never glitch the mix).
   * @returns {Promise<'handled'|'load'|'ignore'>} 'load' = go ahead and load (automix was stopped).
   */
  async userLoad(deckIndex, track) {
    if (!this.enabled || deckIndex > 1) return 'ignore';
    const deck = this.engine.decks[deckIndex];
    const title = `"${track.title || 'track'}"`;
    if (this.transition) {
      this.insertNext([track]);
      this.app.toast?.(`Automix is mixing: ${title} plays next`);
      return 'handled';
    }
    if (deck === this.current) {
      let choice = this.opts.onAirLoad || 'ask';
      if (choice === 'ask') {
        choice = await this.app.dialogs.modal('Automix is playing this deck', Object.assign(document.createElement('p'), { textContent: `Deck ${deckIndex + 1} is on air. Stop automix and load ${title} (the live track is cut), or play it next?` }), [
          { label: 'Cancel', value: null }, { label: 'Play next', value: 'queue', primary: true }, { label: 'Stop automix & load', value: 'stop' },
        ]);
      }
      if (choice === 'queue') { this.insertNext([track]); this.app.toast?.(`Automix: ${title} plays next`); return 'handled'; }
      if (choice === 'stop') { this.stop(); this.app.toast?.('Automix stopped'); return 'load'; }
      this.app.toast?.('Kept the live track playing');
      return 'handled';
    }
    // the idle / next deck: the user's pick becomes the next track and is (re)loaded there by automix
    this.insertNext([track]);
    this.app.toast?.(`Automix: ${title} is up next`);
    return 'handled';
  }
}
