// Automix transition planner: works out the best way to mix one track into the next.
//
// For each pair of tracks it tries every transition style at every sensible length (4, 8, 16, 32 bars) and scores
// each option on what the analysis knows about the two tracks:
//   - tempo gap (a long beat-matched overlap far from a track's own tempo sounds stretched; > 8 % is never blended),
//   - key (clashing keys only overlap briefly or under a filter, unless key sync fixes them),
//   - vocals (from the AI vocal stem's per-second map when the stems are prepared, else guessed from the sections):
//     two voices at once is the classic automix mistake, so overlaps are penalised unless the plan holds the
//     incoming vocals back (VOC knob: AI stems when loaded, else the mixer's DSP quick stems) or uses a stem swap,
//   - phrasing (the overlap should fit the outgoing outro and the incoming intro, ideally ending where the incoming
//     track's main part starts),
//   - energy and genre changes (rises want short, punchy changes; drops and genre changes a filter or wash),
//   - variety (not the same style every time) and what this DJ chose before (learned style preferences).
// Pure functions, no audio: a plan takes well under a millisecond, on any device, without a GPU.
//
// Learning (settings.mixLearning): when the DJ overrides a planned style, that style's bias goes up and the planned
// one's goes down a little. Kilobytes of numbers, nothing else.
import { tempoDistance, planMixOut, incomingStart, outroBars, introBars, DROP_STYLES, autoTransitionLength, LOG_BPM_JUMP } from './automix.js';
import { camelotRelation, genreSimilarity } from './smartmix.js';
import { decodeVocalMap } from './shared/vocal-map.js';

/** Styles the planner chooses from. 'stemswap' needs AI stems on both decks. */
export const PLANNER_STYLES = ['blend', 'bassswap', 'crossfade', 'filter', 'stemswap', 'echo', 'cut', 'backspin', 'brake', 'loop', 'reverb'];
const BLEND_STYLES = new Set(['blend', 'bassswap', 'crossfade', 'filter', 'stemswap']);
const LENGTHS = [4, 8, 16, 32];
/** Longest overlap each blend style is used for (bars). */
const MAX_BARS = { blend: 32, stemswap: 32, filter: 16, crossfade: 16, bassswap: 8 };
/** Prior per style: how good the style is "in general", before the tracks are looked at. Novelty styles are rare. */
const PRIOR = { blend: 4, stemswap: 5, bassswap: 2.5, filter: 1.5, crossfade: 0, echo: 1, cut: -1, loop: -1.5, reverb: -1, backspin: -4, brake: -4.5 };
export const BIAS_LIMIT = 5;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

/** Phrase-based guess of vocal presence where there is no vocal map (0..1, and how sure it is). */
const SECTION_VOCALS = { intro: 0.15, outro: 0.2, buildup: 0.35, breakdown: 0.45, verse: 0.6, drop: 0.55, chorus: 0.7 };

/**
 * Average vocal presence of a track between a and b (track seconds): { v: 0..1, known: true when measured }.
 * t: { stems: { vocals } | vocalMap, phrases }
 */
export function vocalsBetween(t, a, b) {
  if (!(b > a)) return { v: 0, known: !!t?.stems?.vocals };
  const map = t?.vocalMap || decodeVocalMap(t?.stems?.vocals);
  if (map?.length) {
    const i0 = Math.max(0, Math.floor(a)), i1 = Math.min(map.length, Math.ceil(b));
    if (i1 <= i0) return { v: 0, known: true };
    let s = 0; for (let i = i0; i < i1; i++) s += map[i];
    return { v: s / (i1 - i0), known: true };
  }
  const ph = Array.isArray(t?.phrases) ? t.phrases : [];
  if (!ph.length) return { v: 0.4, known: false };
  let s = 0, w = 0;
  for (const p of ph) {
    const o = Math.min(b, p.end) - Math.max(a, p.start);
    if (o > 0) { s += o * (SECTION_VOCALS[p.type] ?? 0.5); w += o; }
  }
  return { v: w ? s / w : 0.4, known: false };
}

/** Learned style biases, sanitised: { style: -5..5 }. */
export function learnedBias(learning) {
  const b = learning?.bias || {};
  return Object.fromEntries(PLANNER_STYLES.map((s) => [s, Math.max(-BIAS_LIMIT, Math.min(BIAS_LIMIT, Number(b[s]) || 0))]));
}

/**
 * The DJ chose `chosen` where the planner had picked `planned`: new learning state (pure; the caller saves it).
 * Each choice moves the chosen style up by 0.6 and the planned one down by 0.3, with a slow decay of everything
 * else towards 0 so old habits fade.
 */
export function learnChoice(learning, chosen, planned) {
  const bias = learnedBias(learning);
  if (!PLANNER_STYLES.includes(chosen) || chosen === planned) return { bias, n: Number(learning?.n) || 0 };
  for (const s of PLANNER_STYLES) bias[s] *= 0.97;
  bias[chosen] = Math.min(BIAS_LIMIT, bias[chosen] + 0.6);
  if (PLANNER_STYLES.includes(planned)) bias[planned] = Math.max(-BIAS_LIMIT, bias[planned] - 0.3);
  for (const s of PLANNER_STYLES) bias[s] = Math.round(bias[s] * 1000) / 1000;
  return { bias, n: (Number(learning?.n) || 0) + 1 };
}

/**
 * Plan the transition from `out` into `inn`.
 * out / inn: track info ({ bpm, key, energy, genre, duration, endTime, mixIn, mixOut, downbeat, gridOffset, phrases,
 *   stems: { ready, vocals } }).
 * opts: { stemsOut, stemsIn (AI stems will be loaded on the decks), keySync, prevStyle, vary, fixedBars (the
 *   settings' fixed length: only the style is planned), learning (settings.mixLearning), styles (limit the choice) }
 * @returns {{ style, bars, beats, vocals: 'hold-in'|null, score, why, lengthWhy, options: {style,bars,score}[] }}
 */
export function planBestTransition(out, inn, opts = {}) {
  const ba = num(out?.bpm) || 0, bb = num(inn?.bpm) || 0, grid = !!(ba && bb);
  const d = grid ? tempoDistance(ba, bb) : 0, bigJump = d > LOG_BPM_JUMP;
  const ea = num(out?.energy), eb = num(inn?.energy), de = ea != null && eb != null && ea > 0 && eb > 0 ? eb - ea : 0;
  const key = camelotRelation(out?.key, inn?.key), clash = key.kind === 'clash' && !opts.keySync;
  const g = out && inn && (out.genre || inn.genre) ? genreSimilarity(out, inn) : null;
  const ob = outroBars(out), ib = introBars(inn);
  const bias = learnedBias(opts.learning);
  const stemsBoth = !!(opts.stemsOut && opts.stemsIn);
  const allowed = new Set(opts.styles || PLANNER_STYLES);
  const inStart = incomingStart(inn || {});
  const outBar = ba ? 240 / ba : 2, inBar = bb ? 240 / bb : 2;
  const cands = [];

  const add = (style, bars, parts, extra = {}) => {
    const score = parts.reduce((s, [v]) => s + v, 0);
    cands.push({ style, bars, score, parts, ...extra });
  };

  for (const style of PLANNER_STYLES) {
    if (!allowed.has(style)) continue;
    if (style === 'stemswap' && !stemsBoth) continue;
    const blend = BLEND_STYLES.has(style);
    if (blend && (!grid || bigJump)) continue; // never beat-match far off a track's tempo, nor without beat grids
    if (!grid && !['echo', 'cut', 'reverb'].includes(style)) continue; // spins, brakes and loops need a beat grid
    const base = [[PRIOR[style] ?? 0, null], [bias[style] || 0, bias[style] > 0.5 ? 'you often pick it' : bias[style] < -0.5 ? 'you often change it' : null]];
    if (opts.prevStyle && opts.prevStyle === style) base.push([opts.vary ? -5 : -1.5, 'same as the last transition']);
    if (opts.recent?.includes(style)) base.push([-0.8, null]);

    if (blend) {
      const lengths = opts.fixedBars ? [opts.fixedBars] : LENGTHS.filter((b) => b <= (MAX_BARS[style] || 16));
      for (const bars of lengths) {
        const p = [...base];
        // tempo: the incoming track plays at the outgoing tempo for the whole overlap
        if (d > 0.005) p.push([-d * 100 * (0.5 + bars / 16), d > 0.03 ? `${Math.round((Math.exp(d) - 1) * 100)} % tempo gap` : null]);
        // key
        if (clash) p.push([-(bars / 4) * (style === 'filter' ? 0.6 : 2.5), style === 'filter' ? 'filter hides the key clash' : 'key clash']);
        else if (key.kind !== 'unknown' && bars >= 16) p.push([2 * Math.max(0, key.value), key.value >= 0.8 ? 'keys match' : null]);
        // phrasing
        if (ob != null) p.push(bars > ob ? [-(bars - ob) * 0.7, `longer than the ${ob}-bar outro`] : [1.5, null]);
        if (ib != null) {
          if (ib === 0) p.push([-(bars - 4) * 0.6, bars > 4 ? 'incoming track has no intro' : null]);
          else if (Math.abs(bars - ib) <= 1) p.push([3, `lands on the incoming track's main part (${ib}-bar intro)`]);
          else if (bars > ib) p.push([-(bars - ib) * 0.35, null]);
        }
        if (ob == null && ib == null) p.push([-Math.abs(bars - 16) * 0.15, null]); // no structure: a middle length
        // energy and genre
        if (de >= 2) p.push([style === 'bassswap' ? 3 : -bars * 0.25, style === 'bassswap' ? 'energy rises: quick swap' : null]);
        if (de <= -2) p.push([style === 'filter' ? 3 : 0, style === 'filter' ? 'energy drops: filter sweep' : null]);
        if (g === 0) p.push([style === 'filter' ? 1.5 : -(bars / 4) * 1.2, style === 'filter' ? 'genre change: filter sweep' : 'genre change']);
        else if (g != null && g >= 0.8 && bars >= 16 && (style === 'blend' || style === 'stemswap')) p.push([1.5, 'same genre: long blend']);
        // vocals: incoming window is beat-matched to the outgoing one
        const w = planMixOut(out || {}, { transitionBeats: bars * 4 });
        const len = Math.min(w.len, bars * outBar);
        const vo = vocalsBetween(out, w.start, w.start + len), vi = vocalsBetween(inn, inStart, inStart + len * (inBar / outBar));
        const overlap = Math.min(vo.v, vi.v), conf = vo.known && vi.known ? 1 : vo.known || vi.known ? 0.75 : 0.5;
        let vocals = null, keep = 1;
        if (style === 'stemswap') keep = 0.1;
        else if (overlap > 0.2 && style !== 'crossfade') { vocals = 'hold-in'; keep = opts.stemsIn ? 0.3 : 0.6; }
        const vPen = overlap * bars * 1.6 * conf * keep;
        if (vPen > 0.2) p.push([-vPen, keep < 1 || overlap < 0.3 ? null : `vocals would overlap${vo.known && vi.known ? '' : ' (estimated)'}`]);
        if (vocals) p.push([0, `incoming vocals held back until the swap${opts.stemsIn ? ' (AI stems)' : ''}`]);
        if (style === 'stemswap') p.push([overlap > 0.2 ? 2.5 : 1, 'stem swap: drums, then bass, vocals last']);
        add(style, bars, p, { vocals });
      }
    } else {
      // drop styles: the outgoing track's effect, then the incoming track drops in on a bar line (no overlap)
      const p = [...base];
      if (bigJump) p.push([8, `${Math.round(ba)} → ${Math.round(bb)} BPM is too far to blend`]);
      if (!grid) p.push([style === 'echo' ? 6 : 3, 'no beat grid: no beat-matched overlap']);
      if (clash) p.push([2, 'no overlap: the key clash is never heard']);
      if (g === 0) p.push([style === 'echo' || style === 'reverb' ? 2 : 0.5, 'genre change']);
      if (de >= 2) p.push([style === 'cut' || style === 'backspin' ? 3 : 0, style === 'cut' || style === 'backspin' ? 'energy rises: straight in' : null]);
      if (de <= -2) p.push([style === 'reverb' || style === 'echo' ? 3 : -1, style === 'reverb' || style === 'echo' ? 'energy drops: let it ring out' : null]);
      // cutting a voice off mid-word is worse than echoing it out
      const w = planMixOut(out || {}, { transitionBeats: 16 });
      const drop = w.start + w.len;
      const vo = vocalsBetween(out, drop - 4, drop);
      const hard = style === 'cut' || style === 'loop' || style === 'backspin' || style === 'brake';
      if (vo.v > 0.15) p.push([-vo.v * (hard ? 6 : 1.5), hard ? 'would cut a vocal off' : null]);
      if (!bigJump && grid) p.push([-2.5, null]); // a beat-matched blend is usually smoother when one is possible
      const bars = opts.fixedBars || autoTransitionLength(out || {}, inn || {}, style).bars;
      add(style, bars, p);
    }
  }
  if (!cands.length) return { style: 'echo', bars: opts.fixedBars || 8, beats: (opts.fixedBars || 8) * 4, vocals: null, score: 0, why: 'echo out', lengthWhy: '', options: [] };
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  const reasons = best.parts.filter(([, r]) => r).sort((a, b) => Math.abs(b[0]) - Math.abs(a[0])).map(([, r]) => r);
  const seen = new Set(), options = [];
  for (const c of cands) { if (seen.has(c.style)) continue; seen.add(c.style); options.push({ style: c.style, bars: c.bars, score: Math.round(c.score * 10) / 10 }); if (options.length >= 4) break; }
  return {
    style: best.style, bars: best.bars, beats: best.bars * 4, vocals: best.vocals || null, score: Math.round(best.score * 10) / 10,
    why: `planned: ${[...new Set(reasons)].slice(0, 3).join(', ') || 'best fit for these two tracks'}`,
    lengthWhy: `${best.bars} bars (planned)`, options,
  };
}

/**
 * Stem levels during a stem swap at progress k (0..1): [vocals, drums, bass, other] for each deck plus faders.
 * The incoming drums come in first under the outgoing track, then its music, the bass swaps at the middle, the
 * outgoing vocals leave, and the incoming vocals enter only after them.
 */
export function stemSwapLevels(k) {
  k = clamp01(k);
  const e = (a, b) => { const x = clamp01((k - a) / (b - a)); return x * x * (3 - 2 * x); };
  const swap = e(0.48, 0.52);
  return {
    inn: [e(0.75, 0.9), e(0, 0.2), swap, e(0.25, 0.5)],
    out: [1 - e(0.45, 0.72), 1 - e(0.3, 0.55), 1 - swap, 1 - e(0.5, 0.88)],
    inVol: 0.8, outVol: 0.8 * (1 - e(0.88, 1)),
  };
}
