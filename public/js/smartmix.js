// Smart mix: how well two tracks go together, and set ordering built on it.
//
// scoreTransition(cur, cand, ctx) rates a candidate next track from the analysis OpenDJ keeps per track (Camelot
// key, BPM, energy 1-10, genre / tags, intro phrases) plus the set so far (no artist repeats within N tracks, no
// recently played tracks) and the chosen set shape (warm-up → peak → cool-down, rising, steady, peak, waves).
// Missing data scores neutral, so unanalysed tracks still order sensibly. smartMix() orders a whole pool up front
// (beam search), liveNext() picks the next track while playing. Pure functions: no DOM, no audio.
import { toCamelot } from './audio/analysis-core.js';

/** Tempo distance as |log ratio|, allowing half / double time (87 ↔ 174 = 0). */
export function tempoDistance(a, b) {
  if (!a || !b) return 0;
  const r = Math.abs(Math.log(b / a));
  return Math.min(r, Math.abs(r - Math.LN2), Math.abs(r - 2 * Math.LN2));
}

const parseCam = (k) => { const m = /^(\d+)([AB])$/.exec(toCamelot(k) || ''); return m ? { n: +m[1], l: m[2], s: m[0] } : null; };

/**
 * Harmonic relation on the Camelot wheel from a to b.
 * kind: same | up (+1) | down (-1) | relative (A↔B) | boost (+2) | diagonal | semitone (+7) | drop2 (-2) | clash | unknown
 * value: -1 (clash) .. 1 (same key); 0 when a key is unknown.
 */
export function camelotRelation(a, b) {
  const ca = parseCam(a), cb = parseCam(b);
  if (!ca || !cb) return { kind: 'unknown', value: 0, from: ca?.s || null, to: cb?.s || null };
  const up = (cb.n - ca.n + 12) % 12;
  let kind = 'clash';
  if (ca.l === cb.l) kind = up === 0 ? 'same' : up === 1 ? 'up' : up === 11 ? 'down' : up === 2 ? 'boost' : up === 7 ? 'semitone' : up === 10 ? 'drop2' : 'clash';
  else if (up === 0) kind = 'relative';
  else if ((ca.l === 'A' && up === 1) || (ca.l === 'B' && up === 11)) kind = 'diagonal';
  const value = { same: 1, up: 0.9, relative: 0.8, down: 0.8, boost: 0.5, diagonal: 0.3, semitone: 0.15, drop2: 0.1, clash: -1 }[kind];
  return { kind, value, from: ca.s, to: cb.s };
}
/** True when two known keys are a harmonic clash (not same, ±1, relative, +2 boost, diagonal, ±semitone moves). */
export const isClash = (a, b) => camelotRelation(a, b).kind === 'clash';

export const SET_SHAPES = [
  ['warmup', 'Warm-up → peak → cool-down'], ['rising', 'Rising energy'], ['steady', 'Steady energy'], ['peak', 'Peak (rise, then fall)'], ['wave', 'Waves'],
];
/** Target energy at position x (0..1) of the set, between lo and hi; null for 'steady' (follow the current track). */
export function shapeTarget(shape, x, lo = 1, hi = 10) {
  const s = hi - lo;
  if (shape === 'rising') return lo + s * x;
  if (shape === 'warmup') return x < 0.7 ? lo + s * (x / 0.7) : hi - s * 0.6 * ((x - 0.7) / 0.3);
  if (shape === 'peak') return x < 0.55 ? lo + s * (x / 0.55) : hi - s * ((x - 0.55) / 0.45);
  if (shape === 'wave') return lo + s * (0.5 - 0.5 * Math.cos(2 * Math.PI * 2 * x));
  return null;
}

/** Slider positions (0..1 each) for the presets in the UI. */
export const PRESETS = {
  balanced: { harmonic: 0.5, energy: 0.5, variety: 0.5 },
  harmonic: { harmonic: 1, energy: 0.3, variety: 0.3 },
  energy: { harmonic: 0.35, energy: 1, variety: 0.4 },
  variety: { harmonic: 0.4, energy: 0.4, variety: 1 },
};
/** Scoring weights from the three "harmonic ↔ energy ↔ variety" sliders. */
export function weightsFrom(s = PRESETS.balanced) {
  const h = clamp01(s.harmonic ?? 0.5), e = clamp01(s.energy ?? 0.5), v = clamp01(s.variety ?? 0.5);
  return { harmonic: 1 + 4 * h, bpm: 3, energy: 0.5 + 4 * e, genre: 0.4 + 1.6 * (1 - v), variety: 1 + 2 * v, phrase: 0.5, artistWindow: 2 + Math.round(4 * v), recentHours: 2 + 6 * v };
}
const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(+x) ? +x : 0.5));
const num = (x) => (Number.isFinite(+x) && +x > 0 ? +x : null);

const STOP = new Set(['and', 'the', 'music', 'mix', 'n', 'of']);
/** Genre + tag words of a track (lower case). */
export function styleWords(t) {
  const out = new Set();
  for (const s of [t.genre || '', ...(t.tags || [])]) for (const w of String(s).toLowerCase().split(/[^a-z0-9]+/)) if (w && !STOP.has(w)) out.add(w);
  return out;
}
/** Genre / tag similarity 0..1 (Jaccard), null when either has none. */
export function genreSimilarity(a, b) {
  const wa = a._words || styleWords(a), wb = b._words || styleWords(b);
  if (!wa.size || !wb.size) return null;
  let inter = 0; for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}
const artistKey = (t) => String(t.artist || '').toLowerCase().split(/\s*(?:,|&|feat\.?|ft\.?|vs\.?|x)\s+/)[0].trim();
/** Has an intro to mix into: 1, starts straight into the music: -0.5, unknown: 0. */
function introValue(t) {
  const p = t.phrases;
  if (!Array.isArray(p) || !p.length) return 0;
  return p[0].type === 'intro' && (p[0].bars || 0) >= 8 ? 1 : -0.5;
}

/**
 * Score a candidate next track. Higher is better.
 * ctx: { weights, shape, x (position 0..1 in the set), lo, hi (energy range), recentArtists: string[] (newest last),
 *        playedIds: Set, now }
 * @returns {{ score: number, parts: object }}
 */
export function scoreTransition(cur, cand, ctx = {}) {
  const W = ctx.weights || weightsFrom();
  const parts = {};
  // harmonic: clashes get an extra penalty so they are avoided whenever an alternative exists
  const h = cur ? camelotRelation(cur.key, cand.key) : { kind: 'unknown', value: 0 };
  parts.harmonic = h.value + (h.kind === 'clash' ? -1 : 0);
  // tempo: within 3 % is good, beyond 8 % (half / double time excepted) is a jump
  const ba = num(cur?.bpm), bb = num(cand.bpm);
  if (ba && bb) { const d = tempoDistance(ba, bb); parts.bpm = Math.max(-1, 1 - d / 0.03) - (d > Math.log(1.08) ? 1 + (d - Math.log(1.08)) * 15 : 0); } else parts.bpm = 0;
  // energy flow toward the set shape
  const ea = num(cur?.energy), eb = num(cand.energy);
  const target = shapeTarget(ctx.shape, ctx.x ?? 0, ctx.lo ?? 1, ctx.hi ?? 10);
  if (eb == null) parts.energy = 0;
  else if (target != null) {
    parts.energy = Math.max(-1.5, 1 - Math.abs(eb - target) / 2);
    if (ctx.shape === 'rising' && ea != null && eb < ea) parts.energy -= 0.6 + (ea - eb) * 0.3; // never step down in a rising set
  } else parts.energy = ea == null ? 0 : Math.max(-1.5, 1 - Math.abs(eb - ea) / 2);
  if (ea != null && eb != null && Math.abs(eb - ea) > 3) parts.energy -= 0.5; // no sudden jumps
  // genre / tags
  const g = cur ? genreSimilarity(cur, cand) : null;
  parts.genre = g == null ? 0 : g * 2 - 1;
  // variety: no artist repeats within the window, no recently played tracks, not the same album twice
  let v = 0;
  const ak = artistKey(cand);
  const recent = ctx.recentArtists || (cur ? [artistKey(cur)] : []);
  const win = W.artistWindow ?? 3, at = ak ? recent.slice(-win).lastIndexOf(ak) : -1;
  if (at >= 0) { const dist = Math.min(win, recent.length) - at; v -= 3 * (win - dist + 1) / win; } // the closer the repeat, the worse
  if (ctx.playedIds?.has(cand.id)) v -= 3;
  else if (cand.lastPlayed && (ctx.now ?? Date.now()) - cand.lastPlayed < (W.recentHours ?? 4) * 3600e3) v -= 1;
  if (cur && cand.album && cur.album === cand.album && artistKey(cur) === ak) v -= 0.3;
  parts.variety = v;
  // Prefer tracks with analysed entry/exit points so the transition planner can land on musical phrases.
  parts.phrase = introValue(cand)
    + (Number.isFinite(+cand.mixIn) ? 0.45 : 0)
    + (cur && Number.isFinite(+cur.mixOut) ? 0.35 : 0)
    + (Array.isArray(cand.phrases) && cand.phrases.some((p) => ['buildup', 'verse', 'drop', 'chorus'].includes(p.type)) ? 0.2 : 0);
  const score = W.harmonic * parts.harmonic + W.bpm * parts.bpm + W.energy * parts.energy + W.genre * parts.genre + W.variety * parts.variety + W.phrase * parts.phrase;
  return { score, parts };
}

const fmtBpm = (b) => (Number(b) % 1 ? Number(b).toFixed(1) : String(Math.round(b)));
/** Human explanation of a transition, e.g. "8A → 9A, 124 → 126 BPM, energy +1, same genre". */
export function explain(cur, cand) {
  if (!cur) return [cand.key ? toCamelot(cand.key) : null, num(cand.bpm) ? `${fmtBpm(cand.bpm)} BPM` : null, num(cand.energy) ? `energy ${cand.energy}` : null].filter(Boolean).join(', ') || 'opening track';
  const bits = [];
  if (Number.isFinite(+cand.mixIn)) bits.push('analysed mix-in');
  if (Number.isFinite(+cur.mixOut)) bits.push('analysed outro');
  const h = camelotRelation(cur.key, cand.key);
  if (h.kind !== 'unknown') bits.push(`${h.from} → ${h.to}${h.kind === 'clash' ? ' (key clash)' : h.kind === 'relative' ? ' (relative)' : h.kind === 'boost' ? ' (energy boost)' : ''}`);
  else bits.push('key ?');
  const ba = num(cur.bpm), bb = num(cand.bpm);
  if (ba && bb) {
    const half = Math.abs(Math.log(bb / ba)) > 0.5 ? ' (half/double time)' : '';
    bits.push(`${fmtBpm(ba)} → ${fmtBpm(bb)} BPM${half}`);
  } else bits.push('BPM ?');
  const ea = num(cur.energy), eb = num(cand.energy);
  if (ea != null && eb != null) bits.push(eb === ea ? 'same energy' : `energy ${eb > ea ? '+' : ''}${Math.round((eb - ea) * 10) / 10}`);
  const g = genreSimilarity(cur, cand);
  if (g != null) bits.push(g >= 0.99 ? 'same genre' : g > 0 ? 'related genre' : 'genre change');
  return bits.join(', ');
}

function prep(t) { Object.defineProperty(t, '_words', { value: styleWords(t), enumerable: false, configurable: true, writable: true }); return t; }
function energyRange(list) {
  const es = list.map((t) => num(t.energy)).filter((e) => e != null);
  return es.length ? [Math.min(...es), Math.max(...es)] : [1, 10];
}

/**
 * Order (and, for big pools, pick) tracks so each transition scores well and the set follows the shape.
 * opts: { shape='warmup', sliders | weights, limit (tracks to pick; default all up to 200, else 40),
 *         start (track playing before the set), history (tracks played already), beam=6, branch=6 }
 * @returns {{ tracks: object[], steps: { track, reason, score }[] }}
 */
export function smartMix(pool, opts = {}) {
  const seen = new Set();
  const list = pool.filter((t) => t && !seen.has(t.id) && seen.add(t.id)).map(prep);
  const W = opts.weights || weightsFrom(opts.sliders);
  const shape = opts.shape || 'warmup';
  const L = Math.min(list.length, Math.max(1, opts.limit ?? (list.length <= 200 ? list.length : 40)));
  if (!L) return { tracks: [], steps: [] };
  const [lo, hi] = energyRange(list);
  const history = (opts.history || []).map(prep);
  const playedIds = new Set(history.map((t) => t.id));
  const start = opts.start ? prep(opts.start) : null;
  if (start) playedIds.add(start.id);
  const baseArtists = [...history, ...(start ? [start] : [])].map(artistKey).filter(Boolean);
  const B = Math.max(1, opts.beam ?? 6), K = Math.max(1, opts.branch ?? 6);
  const now = opts.now ?? Date.now();
  const openingTarget = shapeTarget(shape, 0, lo, hi);
  const openingDistance = (t) => num(t.energy) == null || openingTarget == null ? Infinity : Math.abs(num(t.energy) - openingTarget);
  const closestOpening = list.reduce((best, t) => Math.min(best, openingDistance(t)), Infinity);
  let beams = [{ seq: [], used: new Set(), total: 0 }];
  for (let i = 0; i < L; i++) {
    const x = L > 1 ? i / (L - 1) : 0;
    const next = [];
    for (const b of beams) {
      const prev = b.seq.length ? b.seq[b.seq.length - 1] : start;
      const recentArtists = [...baseArtists, ...b.seq.map(artistKey)];
      const cands = [];
      for (const t of list) {
        if (b.used.has(t.id)) continue;
        // Preserve the requested opening energy: future compatibility must not turn a warm-up into a peak opener.
        if (!prev && Number.isFinite(closestOpening) && openingDistance(t) > closestOpening) continue;
        let s;
        if (!prev) { // opening track: fit the start of the shape, prefer tracks with an intro
          const e = num(t.energy), tgt = shapeTarget(shape, 0, lo, hi);
          s = (e == null ? 0 : tgt == null ? 0 : -Math.abs(e - tgt) * W.energy) + W.phrase * introValue(t) - (playedIds.has(t.id) ? 10 : 0);
        } else s = scoreTransition(prev, t, { weights: W, shape, x, lo, hi, recentArtists, playedIds, now }).score;
        cands.push([s, t]);
      }
      cands.sort((p, q) => q[0] - p[0]);
      for (const [s, t] of cands.slice(0, K)) next.push({ prevBeam: b, t, total: b.total + s });
    }
    next.sort((p, q) => q.total - p.total);
    beams = next.slice(0, B).map(({ prevBeam, t, total }) => ({ seq: [...prevBeam.seq, t], used: new Set([...prevBeam.used, t.id]), total }));
  }
  const best = beams[0];
  const steps = best.seq.map((t, i) => {
    const prev = i ? best.seq[i - 1] : start;
    return { track: t, reason: explain(prev, t), score: prev ? scoreTransition(prev, t, { weights: W, shape, x: L > 1 ? i / (L - 1) : 0, lo, hi }).score : 0 };
  });
  return { tracks: best.seq, steps };
}

/**
 * Live mode: the best next track from `pool` after `cur`, given what was played. position = tracks played so far,
 * setLength = planned set length (for the shape). @returns {{ track, reason, score } | null}
 */
export function liveNext(cur, pool, { history = [], shape = 'warmup', sliders, weights, position = 0, setLength = 20, now, transitionScore } = {}) {
  const W = weights || weightsFrom(sliders);
  const playedIds = new Set([...history.map((t) => t.id), cur?.id].filter(Boolean));
  const list = pool.filter((t) => t && !playedIds.has(t.id)).map(prep);
  if (!list.length) return null;
  if (cur) prep(cur);
  const [lo, hi] = energyRange([...list, ...(cur ? [cur] : [])]);
  const x = Math.min(1, position / Math.max(1, setLength - 1));
  const recentArtists = [...history, ...(cur ? [cur] : [])].map(artistKey).filter(Boolean);
  const ranked = [];
  for (const t of list) {
    const { score } = scoreTransition(cur, t, { weights: W, shape, x, lo, hi, recentArtists, playedIds, now });
    ranked.push({ track: t, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  const finalists = ranked.slice(0, 6).map((r) => {
    const q = transitionScore?.(r.track);
    return { ...r, score: r.score + (Number.isFinite(q?.score) ? q.score : 0), transitionReason: q?.reason };
  });
  finalists.sort((a, b) => b.score - a.score);
  const best = finalists[0];
  return { ...best, reason: [explain(cur, best.track), best.transitionReason].filter(Boolean).join('; ') };
}

/** Fisher-Yates shuffle (copy). rand() defaults to Math.random. */
export function shuffle(list, rand = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
