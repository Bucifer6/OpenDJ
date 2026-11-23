// Smart mix: how well two tracks go together, and set ordering built on it.
//
// scoreTransition(cur, cand, ctx) rates a candidate next track from the analysis OpenDJ keeps per track (Camelot
// key + confidence, BPM, energy 1-10, genre / tags, phrases, vocal map, rating / play count) plus the set so far
// (artist gap, same-song remixes, familiar / vocal runs, energy-boost key moves, skip feedback) and the set's energy
// arc (warm-up → peak → cool-down, rising, steady, peak, waves, or a party arc that follows the clock).
// Missing data scores neutral, so unanalysed tracks still order sensibly. smartMix() orders a whole pool up front
// (beam search), liveNext() picks the next track while playing (small lookahead beam). Pure functions: no DOM, no
// audio. Rules and numbers: docs/PRO_DJ_AUTOMIX_RESEARCH.md §P3 and docs/automix-research/02-selection.md.
import { toCamelot } from './audio/analysis-core.js';
import { decodeVocalMap } from './shared/vocal-map.js';

/** Tempo distance as |log ratio|, allowing half / double time (87 ↔ 174 = 0). */
export function tempoDistance(a, b) {
  if (!a || !b) return 0;
  const r = Math.abs(Math.log(b / a));
  return Math.min(r, Math.abs(r - Math.LN2), Math.abs(r - 2 * Math.LN2));
}

const camCache = new Map();
const parseCam = (k) => {
  if (k == null || k === '') return null;
  if (camCache.has(k)) return camCache.get(k);
  const m = /^(\d+)([AB])$/.exec(toCamelot(k) || '');
  const r = m ? { n: +m[1], l: m[2], s: m[0] } : null;
  if (camCache.size > 500) camCache.clear();
  camCache.set(k, r);
  return r;
};

const KEY_VALUES = { same: 1, up: 0.9, relative: 0.85, down: 0.85, diagonal: 0.75, boost: 0.6, semitone: 0.4, drop2: 0.4, clash: -1 };
/**
 * Harmonic relation on the Camelot wheel from a to b.
 * kind: same | up (+1) | down (-1) | relative (A↔B) | boost (+2) | diagonal | semitone (+7) | drop2 (-2) | clash | unknown
 * value: -1 (clash) .. 1 (same key); 0 when a key is unknown. Values follow 02-selection.md §1.2 (boost / semitone
 * are only that good as a planned lift: scoreTransition reduces them otherwise).
 */
export function camelotRelation(a, b) {
  const ca = parseCam(a), cb = parseCam(b);
  if (!ca || !cb) return { kind: 'unknown', value: 0, from: ca?.s || null, to: cb?.s || null };
  const up = (cb.n - ca.n + 12) % 12;
  let kind = 'clash';
  if (ca.l === cb.l) kind = up === 0 ? 'same' : up === 1 ? 'up' : up === 11 ? 'down' : up === 2 ? 'boost' : up === 7 ? 'semitone' : up === 10 ? 'drop2' : 'clash';
  else if (up === 0) kind = 'relative';
  else if ((ca.l === 'A' && up === 1) || (ca.l === 'B' && up === 11)) kind = 'diagonal';
  return { kind, value: KEY_VALUES[kind], from: ca.s, to: cb.s };
}
/** True when two known keys are a harmonic clash (not same, ±1, relative, +2 boost, diagonal, ±semitone moves). */
export const isClash = (a, b) => camelotRelation(a, b).kind === 'clash';
const LIFT_KINDS = new Set(['boost', 'semitone']);

export const SET_SHAPES = [
  ['warmup', 'Warm-up → peak → cool-down'], ['rising', 'Rising energy'], ['steady', 'Steady energy'], ['peak', 'Peak (rise, then fall)'], ['wave', 'Waves'],
  ['party', 'Party (follows the clock)'],
];

// ---- party arc (02-selection.md §3.3 / §3.5) ----
const lerpPts = (pts, x) => {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + (y1 - y0) * ((x - x0) / (x1 - x0 || 1)); }
  return pts.at(-1)[1];
};
// energy (1-10) by clock hour; hours before noon count as 24+ (the night continues)
const CLOCK = [[12, 3], [19, 3.5], [22, 5], [23, 6.5], [24, 8], [25, 8.8], [26, 9], [27, 8], [28, 7], [29, 6.5], [32, 6.5], [34, 5], [36, 3]];
// set template over τ: warm-up 3→5, build 5→7, peak 1 7→8, valley −15 % for 2-3 tracks, main peak 8→9, close 9→6
const TEMPLATE = [[0, 3], [0.25, 5], [0.5, 7], [0.65, 8], [0.675, 6.8], [0.72, 7], [0.74, 8], [0.9, 9], [1, 6]];
// endless: build → peak → valley, repeated every CYCLE_MIN minutes of clock time (offsets around the clock level)
const CYCLE_MIN = 40;
const CYCLE = [[0, -1], [0.55, 0.8], [0.7, 1], [0.8, -0.6], [1, -1]];
const clockHour = (now) => { const d = new Date(now); const h = d.getHours() + d.getMinutes() / 60; return h < 12 ? h + 24 : h; };

function partyInfo({ now = Date.now(), elapsedMin, setMinutes, tau } = {}) {
  const h = clockHour(now), clock = lerpPts(CLOCK, h);
  let e, phase;
  const known = Number.isFinite(tau) || (Number.isFinite(+setMinutes) && +setMinutes > 0);
  if (known) {
    const t = Math.max(0, Math.min(1, Number.isFinite(tau) ? tau : (+elapsedMin || 0) / +setMinutes));
    e = clock + 0.7 * (lerpPts(TEMPLATE, t) - 6.5);
    phase = t < 0.25 ? 'warmup' : t < 0.5 ? 'build' : t < 0.65 ? 'peak' : t < 0.72 ? 'valley' : t < 0.9 ? 'peak' : 'close';
  } else {
    const mins = Math.floor(now / 60000) - new Date(now).getTimezoneOffset();
    const c = (((mins % CYCLE_MIN) + CYCLE_MIN) % CYCLE_MIN) / CYCLE_MIN;
    e = clock + 1.2 * lerpPts(CYCLE, c);
    phase = c < 0.55 ? 'build' : c < 0.75 ? 'peak' : 'valley';
  }
  // the clock bounds the level: background before 22:00, after-hours (04:00-08:00) deeper / hypnotic 6-7
  if (h < 22) { e = Math.min(e, 5); phase = 'warmup'; } else if (h >= 28 && h < 32) { e = Math.max(6, Math.min(7, e)); if (phase !== 'close') phase = 'build'; }
  return { energy: Math.max(1, Math.min(10, e)), phase };
}
/**
 * Party arc target energy, mapped to the pool's lo..hi range (like shapeTarget). Clock time sets the level (before
 * 22:00 background ≤ 5, peak around 00:00-02:00, after 04:00 deeper 6-7); with a known set length (setMinutes, or a
 * set fraction tau 0..1) the τ template shapes it; endless sets (no setMinutes / tau) cycle build-peak-valley every
 * 40 minutes of clock time. now: ms timestamp (local clock), elapsedMin: minutes since the set started.
 */
export function partyTarget({ now = Date.now(), elapsedMin, setMinutes, lo = 1, hi = 10, tau } = {}) {
  const { energy } = partyInfo({ now, elapsedMin, setMinutes, tau });
  return lo + (hi - lo) * ((energy - 1) / 9);
}

/**
 * Target energy at position x (0..1) of the set, between lo and hi; null for 'steady' (follow the current track).
 * 'party' reads ctx { now, elapsedMin, setMinutes, endless }: without setMinutes / elapsedMin x is the set fraction,
 * with endless: true it cycles on the clock.
 */
export function shapeTarget(shape, x, lo = 1, hi = 10, ctx = {}) {
  const s = hi - lo;
  if (shape === 'rising') return lo + s * x;
  if (shape === 'warmup') return x < 0.7 ? lo + s * (x / 0.7) : hi - s * 0.6 * ((x - 0.7) / 0.3);
  if (shape === 'peak') return x < 0.55 ? lo + s * (x / 0.55) : hi - s * ((x - 0.55) / 0.45);
  if (shape === 'wave') return lo + s * (0.5 - 0.5 * Math.cos(2 * Math.PI * 2 * x));
  if (shape === 'party') return partyTarget({ ...partyArgs(x, ctx), lo, hi });
  return null;
}
function partyArgs(x, ctx = {}) {
  const now = ctx.now ?? Date.now();
  if (ctx.endless) return { now };
  if (Number.isFinite(+ctx.setMinutes) && +ctx.setMinutes > 0 && Number.isFinite(+ctx.elapsedMin)) return { now, elapsedMin: +ctx.elapsedMin, setMinutes: +ctx.setMinutes };
  return { now, tau: Math.max(0, Math.min(1, +x || 0)) };
}
/** Arc phase at x: warmup | build | peak | valley | close (party: from the clock / template). */
export function arcPhase(shape, x = 0, ctx = {}) {
  if (shape === 'party') return partyInfo(partyArgs(x, ctx)).phase;
  if (shape === 'steady' || !shape) return 'build';
  if (shape === 'rising') return x < 0.25 ? 'warmup' : x < 0.6 ? 'build' : 'peak';
  if (shape === 'peak') return x < 0.25 ? 'warmup' : x < 0.45 ? 'build' : x < 0.7 ? 'peak' : 'close';
  return x < 0.25 ? 'warmup' : x < 0.5 ? 'build' : x < 0.88 ? 'peak' : 'close';
}
/** Desired share of familiar tracks by arc phase. */
export const FAMILIAR_SHARE = { warmup: 0.25, build: 0.45, peak: 0.6, valley: 0.5, close: 0.75 };

/** Slider positions (0..1 each) for the presets in the UI. */
export const PRESETS = {
  balanced: { harmonic: 0.5, energy: 0.5, variety: 0.5 },
  harmonic: { harmonic: 1, energy: 0.3, variety: 0.3 },
  energy: { harmonic: 0.35, energy: 1, variety: 0.4 },
  variety: { harmonic: 0.4, energy: 0.4, variety: 1 },
};
/**
 * Scoring weights from the three "harmonic ↔ energy ↔ variety" sliders. artistWindow = hard artist gap (tracks),
 * artistSoft = soft gap; vibe is only used with ctx.vibeLock.
 */
export function weightsFrom(s = PRESETS.balanced) {
  const h = clamp01(s.harmonic ?? 0.5), e = clamp01(s.energy ?? 0.5), v = clamp01(s.variety ?? 0.5);
  return {
    harmonic: 1 + 4 * h, bpm: 3, energy: 0.5 + 4 * e, genre: 0.4 + 1.6 * (1 - v), variety: 1 + 2 * v, phrase: 0.5,
    familiarity: 1, vocal: 1, feedback: 1, vibe: 3,
    artistWindow: 8, artistSoft: 15, recentHours: 2 + 6 * v,
  };
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
const wordsOf = (t) => t._words || styleWords(t);
/** Genre / tag similarity 0..1 (Jaccard), null when either has none. */
export function genreSimilarity(a, b) {
  const wa = wordsOf(a), wb = wordsOf(b);
  if (!wa.size || !wb.size) return null;
  let inter = 0; for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

const FAMILY_WORDS = {
  house: ['house', 'deep', 'disco', 'garage', 'funky', 'soulful', 'progressive', 'electro', 'nudisco'],
  techno: ['techno', 'industrial', 'minimal', 'acid', 'hardgroove'],
  trance: ['trance', 'psy', 'psytrance', 'goa', 'uplifting'],
  bass: ['dnb', 'drum', 'jungle', 'dubstep', 'bass', 'breaks', 'breakbeat', 'liquid', 'neurofunk', 'riddim', 'ukg'],
  hiphop: ['hip', 'hop', 'hiphop', 'rap', 'trap', 'drill', 'grime', 'rnb'],
  latin: ['reggaeton', 'latin', 'salsa', 'bachata', 'cumbia', 'dembow', 'moombahton', 'merengue'],
  afro: ['afrobeats', 'afrobeat', 'afro', 'amapiano', 'dancehall', 'reggae', 'soca', 'afrohouse'],
  pop: ['pop', 'dance', 'edm', 'electropop', 'synthpop', 'kpop', 'disco'],
  rock: ['rock', 'indie', 'punk', 'metal', 'alternative', 'grunge'],
  chill: ['ambient', 'chill', 'downtempo', 'lofi', 'lounge', 'jazz', 'soul', 'funk', 'chillout'],
};
const WORD_FAMILY = new Map();
for (const [f, ws] of Object.entries(FAMILY_WORDS)) for (const w of ws) WORD_FAMILY.set(w, [...(WORD_FAMILY.get(w) || []), f]);
/** Genre families of a track (house, techno, trance, bass, hiphop, latin, afro, pop, rock, chill). */
export function genreFamilies(t) {
  const out = new Set();
  for (const w of wordsOf(t)) for (const f of WORD_FAMILY.get(w) || []) out.add(f);
  if (/r\s*&\s*b/i.test(`${t.genre || ''} ${(t.tags || []).join(' ')}`)) out.add('hiphop'); // "R&B" splits into r / b
  return out;
}
const OPEN_RE = /hip.?hop|\bpop\b|reggaeton|latin|afro.?beats?|r\s*&\s*b|\brnb\b|dancehall|\brap\b/i;
/** Open-format track (hip-hop, pop, reggaeton, latin, afrobeats, r&b, dancehall): looser tempo tolerance. */
export const isOpenFormat = (t) => !!t && OPEN_RE.test(`${t.genre || ''} ${(t.tags || []).join(' ')}`);

const artistKey = (t) => String(t?.artist || '').toLowerCase().split(/\s*(?:,|&|feat\.?|ft\.?|vs\.?|x)\s+/)[0].trim();

const GENERIC_TITLES = new Set(['intro', 'outro', 'untitled', 'track', 'interlude', 'skit', 'unknown']);
const memoTitle = new Map();
/**
 * Normalised song title for "same song" detection: remixes, edits, VIPs, radio / extended versions and feat. credits
 * of one original give the same key ("Song (X Remix)", "Song [Edit]", "Song - Y Mix", "Song feat. Z" → "song").
 * '' for empty / generic titles (Intro, Untitled, …).
 */
export function songKey(t) {
  const title = String(t?.title || '');
  if (memoTitle.has(title)) return memoTitle.get(title);
  let s = title.toLowerCase();
  s = s.replace(/\s*[([{][^)\]}]*[)\]}]/g, ' ');
  s = s.replace(/\s+(?:feat\.?|ft\.?|featuring|with)\s.*$/, '');
  s = s.replace(/\s+[-–—]\s+.*\b(?:mix|remix|edit|version|dub|rework|bootleg|vip|remaster(?:ed)?|live|instrumental|extended|radio|flip|refix)\b.*$/, '');
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  if (s.length < 3 || GENERIC_TITLES.has(s)) s = '';
  if (memoTitle.size > 5000) memoTitle.clear();
  memoTitle.set(title, s);
  return s;
}

const vocalCache = new WeakMap();
const VOCAL_TYPES = { chorus: 1, hook: 1, vocal: 1, rap: 1, verse: 0.6 };
/**
 * Vocal density 0..1 of a track, or null when unknown: the mean of the decoded vocal map (stems.vocals / vocalMap)
 * when there is one, else the share of verse / chorus phrases (verse counts 0.6: the analyser also labels plain
 * grooves 'verse'), else null.
 */
export function vocalDensity(t) {
  if (!t || typeof t !== 'object') return null;
  const sig = `${t.stems?.vocals?.length || 0}|${t.vocalMap?.length || 0}|${t.phrases?.length || 0}`;
  const c = vocalCache.get(t);
  if (c && c.sig === sig) return c.v;
  let v = null;
  const map = t.vocalMap || decodeVocalMap(t.stems?.vocals);
  if (map && map.length) { let s = 0; for (const x of map) s += x; v = s / map.length; }
  else if (Array.isArray(t.phrases) && t.phrases.length) {
    let tot = 0, voc = 0, typed = 0;
    for (const p of t.phrases) {
      const d = Math.max(0, (+p.end || 0) - (+p.start || 0)) || (+p.bars || 0);
      tot += d; if (p.type) typed++;
      voc += d * (VOCAL_TYPES[p.type] || 0);
    }
    if (tot > 0 && typed >= 3) v = voc / tot;
  }
  vocalCache.set(t, { sig, v });
  return v;
}
const VOCAL_HEAVY = 0.45, VOCAL_BREATHER = 0.2;

/**
 * Familiarity info for a pool: { threshold, enabled }. threshold = play count at the pool's top 30 % (at least 1);
 * enabled = the pool has any rating or play count at all (otherwise familiarity scores neutral).
 */
export function familiarityInfo(pool = []) {
  const counts = [];
  let enabled = false;
  for (const t of pool) {
    const pc = +t?.playCount || 0, r = +t?.rating || 0;
    counts.push(pc);
    if (pc > 0 || r > 0) enabled = true;
  }
  counts.sort((a, b) => b - a);
  const idx = Math.max(0, Math.ceil(counts.length * 0.3) - 1);
  return { threshold: Math.max(1, counts[idx] || 0), enabled };
}
/** A track is familiar when rated ≥ 4 or its play count is in the pool's top 30 % (fam from familiarityInfo). */
export const isFamiliar = (t, fam = {}) => (+t?.rating || 0) >= 4 || (+t?.playCount || 0) >= (fam.threshold ?? Infinity);
const isBanger = (t, fam) => isFamiliar(t, fam) && (num(t.energy) ?? 0) >= 8;

/** Has an intro to mix into: 1, starts straight into the music: -0.5, unknown: 0. */
function introValue(t) {
  const p = t.phrases;
  if (!Array.isArray(p) || !p.length) return 0;
  return p[0].type === 'intro' && (p[0].bars || 0) >= 8 ? 1 : -0.5;
}
const keyConf = (t) => { const c = +t?.keyConfidence; return t?.keyConfidence != null && Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 1; };

/**
 * Sound similarity 0..1 from what is known (genre words, tempo, energy, vocal density, and an `embedding` vector when
 * both tracks have one), null when nothing is comparable.
 */
export function soundSimilarity(a, b) {
  if (!a || !b) return null;
  let s = 0, w = 0;
  const add = (v, wt) => { if (v != null && Number.isFinite(v)) { s += v * wt; w += wt; } };
  add(genreSimilarity(a, b), 2);
  const ba = num(a.bpm), bb = num(b.bpm);
  if (ba && bb) add(Math.exp(-((tempoDistance(ba, bb) / 0.04) ** 2)), 1);
  const ea = num(a.energy), eb = num(b.energy);
  if (ea != null && eb != null) add(Math.max(0, 1 - Math.abs(ea - eb) / 5), 1);
  const va = vocalDensity(a), vb = vocalDensity(b);
  if (va != null && vb != null) add(1 - Math.abs(va - vb), 0.5);
  if (Array.isArray(a.embedding) && Array.isArray(b.embedding) && a.embedding.length && a.embedding.length === b.embedding.length) {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.embedding.length; i++) { d += a.embedding[i] * b.embedding[i]; na += a.embedding[i] ** 2; nb += b.embedding[i] ** 2; }
    if (na > 0 && nb > 0) add(Math.max(0, d / Math.sqrt(na * nb)), 3);
  }
  return w ? s / w : null;
}

// ---- skip feedback (02-selection.md §3.5) ----
const FB_TRACK_HALF = 3 * 3600e3, FB_STYLE_HALF = 3600e3, RESET_WINDOW = 20 * 60e3;
const decayed = (e, now, half) => (e ? e.w * 0.5 ** (Math.max(0, now - e.at) / half) : 0);
const bump = (map, k, w, now, half) => (k ? { ...map, [k]: { w: decayed(map[k], now, half) + w, at: now } } : map);
/** Empty feedback state. */
export const emptyFeedback = () => ({ tracks: {}, artists: {}, words: {}, recent: [], resetSuggested: false, resetAt: 0 });
/**
 * Record a skip. Returns a new state (the old one is not changed): an early skip (< 30 s played) is a strong
 * negative on the track, a late one weak; its artist and genre words get part of it. resetSuggested turns true after
 * 2 skips within the last 4 tracks (use opts.history = tracks / ids played, newest last, when you have it; otherwise
 * the plays / skips recorded with playFeedback / skipFeedback in the last 20 minutes count).
 * @returns {{ tracks, artists, words, recent, resetSuggested, resetAt }}
 */
export function skipFeedback(state, track, { playedSeconds, now = Date.now(), history } = {}) {
  const st = { ...emptyFeedback(), ...(state || {}) };
  if (!track) return st;
  const early = Number.isFinite(+playedSeconds) && +playedSeconds < 30;
  const s = early ? 1 : 0.35;
  let tracks = bump(st.tracks, track.id, s, now, FB_TRACK_HALF);
  let artists = bump(st.artists, artistKey(track), 0.5 * s, now, FB_STYLE_HALF);
  let words = st.words;
  for (const w of styleWords(track)) words = bump(words, w, 0.3 * s, now, FB_STYLE_HALF);
  const recent = [...st.recent.filter((r) => now - r.at < RESET_WINDOW), { id: track.id, skip: true, early, at: now }].slice(-4);
  let skips;
  if (Array.isArray(history) && history.length) {
    const ids = history.map((h) => (h && typeof h === 'object' ? h.id : h));
    if (ids.at(-1) !== track.id) ids.push(track.id);
    skips = ids.slice(-4).filter((id) => tracks[id]).length;
  } else skips = recent.filter((r) => r.skip).length;
  const reset = skips >= 2;
  return { ...st, tracks, artists, words, recent, resetSuggested: reset || (st.resetSuggested && now - st.resetAt < RESET_WINDOW), resetAt: reset ? now : st.resetAt };
}
/** Record a track that played through (or the next pick): clears resetSuggested and counts for the 4-track window. */
export function playFeedback(state, track, { now = Date.now() } = {}) {
  const st = { ...emptyFeedback(), ...(state || {}) };
  const recent = track ? [...st.recent.filter((r) => now - r.at < RESET_WINDOW), { id: track.id, skip: false, at: now }].slice(-4) : st.recent;
  return { ...st, recent, resetSuggested: false };
}
function feedbackPenalty(cand, fb, now) {
  if (!fb) return 0;
  let p = 0;
  if (fb.tracks) p += 3 * decayed(fb.tracks[cand.id], now, FB_TRACK_HALF);
  if (fb.artists) p += 1.5 * decayed(fb.artists[artistKey(cand)], now, FB_STYLE_HALF);
  if (fb.words) {
    const ws = wordsOf(cand);
    if (ws.size) { let s = 0; for (const w of ws) s += decayed(fb.words[w], now, FB_STYLE_HALF); p += 2 * Math.min(1, s / ws.size); }
  }
  return p;
}
const resetActive = (fb, now) => !!fb?.resetSuggested && (!fb.resetAt || now - fb.resetAt < RESET_WINDOW);

// ---- set context (history-derived state), cached per ctx object ----
const ctxCache = new WeakMap();
const asSet = (x) => (x instanceof Set ? x : new Set(Array.isArray(x) ? x : []));
function contextState(cur, ctx) {
  const c = ctxCache.get(ctx);
  if (c && c.cur === cur) return c;
  const hist = Array.isArray(ctx.history) ? ctx.history : [];
  const seq = cur && hist.at(-1) !== cur && hist.at(-1)?.id !== cur.id ? [...hist, cur] : hist.length ? hist : cur ? [cur] : [];
  const tail = seq.slice(-16);
  const fam = ctx.familiarity;
  const st = { cur };
  st.artists = ctx.recentArtists || (hist.length ? tail.map(artistKey) : cur ? [artistKey(cur)] : []);
  st.songs = new Map();
  for (const t of seq) { const k = songKey(t); if (k) st.songs.set(k, t.id); }
  st.ids = new Set(seq.map((t) => t.id));
  // energy-boost key moves (+2 / +7) among the last 5 transitions: at most 1 per 6 tracks
  st.boostRecent = false;
  for (let i = Math.max(1, tail.length - 5); i < tail.length; i++) if (LIFT_KINDS.has(camelotRelation(tail[i - 1].key, tail[i].key).kind)) st.boostRecent = true;
  const run = (pred) => { let n = 0; for (let i = tail.length - 1; i >= 0 && pred(tail[i]); i--) n++; return n; };
  if (fam?.enabled) {
    st.bangerRun = run((t) => isBanger(t, fam));
    st.unfamRun = run((t) => !isFamiliar(t, fam));
    const last = tail.slice(-8);
    st.famCount = last.filter((t) => isFamiliar(t, fam)).length; st.famN = last.length;
  }
  st.vocalRun = run((t) => (vocalDensity(t) ?? 0) > VOCAL_HEAVY);
  st.shapeT = shapeTarget(ctx.shape, ctx.x ?? 0, ctx.lo ?? 1, ctx.hi ?? 10, ctx);
  st.phase = fam?.enabled ? arcPhase(ctx.shape, ctx.x ?? 0, ctx) : null;
  ctxCache.set(ctx, st);
  return st;
}

/**
 * Score a candidate next track. Higher is better.
 * ctx: {
 *   weights, shape, x (position 0..1 in the set), lo, hi (energy range), now,
 *   history: tracks played before cand, newest last (cur is appended when missing) — artist gap, same-song remixes,
 *            boost cap, familiar / vocal runs,
 *   recentArtists: string[] (legacy; overrides the artists from history), playedIds: Set, songKeys: Set (extra
 *            song keys played earlier),
 *   familiarity: familiarityInfo(pool) (familiarity part is neutral without it),
 *   energyBias: -2..+2 added to the arc target, banned: Set | id[] (score -1e6), vibeLock: boolean,
 *   feedback: skipFeedback() state,
 *   party arc: elapsedMin, setMinutes, endless (see shapeTarget)
 * }
 * The history-derived state is cached per ctx object (and cur): build a new ctx instead of mutating one.
 * @returns {{ score: number, parts: object, target: number|null }}
 */
export function scoreTransition(cur, cand, ctx = {}) {
  const W = ctx.weights || weightsFrom();
  const now = ctx.now ?? Date.now();
  const st = contextState(cur, ctx);
  const parts = {};
  const ea = num(cur?.energy), eb = num(cand.energy);
  // energy target: arc (or the current track for 'steady') plus the "more / less energy" bias
  const bias = Math.max(-2, Math.min(2, +ctx.energyBias || 0));
  let target = st.shapeT;
  if (target == null && ea != null && bias) target = ea;
  if (target != null) target = Math.max(1, Math.min(10, target + bias));

  // harmonic: relation value, lifts only when the arc rises, ≤ 1 boost per 6 tracks, scaled by key confidence
  const h = cur ? camelotRelation(cur.key, cand.key) : { kind: 'unknown', value: 0 };
  let hv = h.value + (h.kind === 'clash' ? -1 : 0);
  if (LIFT_KINDS.has(h.kind)) {
    const rise = target != null && ea != null ? target - ea : 0; // 'steady' follows the current level: no lift
    if (rise < 0.5) hv = h.kind === 'boost' ? 0.2 : 0;
    else if (rise >= 1.5) hv += 0.1;
    if (st.boostRecent) hv -= 0.5;
  }
  parts.harmonic = hv * (0.4 + 0.6 * Math.min(keyConf(cur), keyConf(cand)));

  // tempo: 1.0 within 1.5 %, 0.5 at the family tolerance (3 % dance, 5 % open format), 0 at 2×; jump beyond 8 %
  const ba = num(cur?.bpm), bb = num(cand.bpm);
  if (ba && bb) {
    const d = tempoDistance(ba, bb), pct = Math.exp(d) - 1;
    const tol = isOpenFormat(cur) || isOpenFormat(cand) ? 0.05 : 0.03;
    let s = pct <= 0.015 ? 1 : pct <= tol ? 1 - 0.5 * (pct - 0.015) / (tol - 0.015) : Math.max(0, 0.5 * (1 - (pct - tol) / tol));
    if (Math.abs(Math.log(bb / ba)) > 0.35) s *= 0.85; // half / double time: a feel change
    parts.bpm = 2 * s - 1 - (d > Math.log(1.08) ? 1 + (d - Math.log(1.08)) * 15 : 0);
  } else parts.bpm = 0;
  // tempo journey (P1.6): with ctx.targetBpm (the set's planned tempo now), tracks that move the set toward it win a
  // little; half / double time counts as the same tempo
  parts.tempoArc = 0;
  const tb = num(ctx.targetBpm);
  if (tb && bb && ba) {
    const toTarget = (x) => tempoDistance(x, tb);
    parts.tempoArc = Math.max(-1, Math.min(1, (toTarget(ba) - toTarget(bb)) / 0.02)) * 0.5 - Math.min(1, toTarget(bb) / 0.06) * 0.5;
  }

  // energy: Gaussian around the target (σ 1), −0.3 per level beyond a ±1 step (+2 allowed when the arc lifts)
  if (eb == null) parts.energy = 0;
  else {
    const tgt = target ?? ea;
    if (tgt == null) parts.energy = 0;
    else {
      const off = Math.abs(eb - tgt);
      parts.energy = 2 * Math.exp(-(off ** 2)) - 1 - 0.1 * Math.max(0, off - 2);
      if (ea != null) {
        const lift = target != null && target - ea >= 1.5 && eb > ea;
        parts.energy -= 0.3 * Math.max(0, Math.abs(eb - ea) - (lift ? 2 : 1));
        if (Math.abs(eb - ea) > 3) parts.energy -= 0.5; // no sudden jumps
        if (ctx.shape === 'rising' && eb < ea) parts.energy -= 0.6 + (ea - eb) * 0.3; // never step down in a rising set
      }
    }
  }

  // genre / tags
  const g = cur ? genreSimilarity(cur, cand) : null;
  parts.genre = g == null ? 0 : g * 2 - 1;

  // variety: artist gap (hard 8, soft to 15), no replays (same id or a remix of the same song), album, last played
  let v = 0;
  const ak = artistKey(cand);
  const hard = W.artistWindow ?? 8, soft = Math.max(hard, W.artistSoft ?? 15);
  const at = ak ? st.artists.lastIndexOf(ak) : -1;
  parts.artistGap = at >= 0 ? st.artists.length - at : null;
  const gap = parts.artistGap;
  if (gap != null && gap <= hard) v -= 2 + 2 * (hard - gap) / Math.max(1, hard - 1);
  else if (gap != null && gap <= soft) v -= 0.8 * (soft + 1 - gap) / (soft + 1 - hard);
  const sk = songKey(cand);
  const played = ctx.playedIds?.has(cand.id) || st.ids.has(cand.id);
  parts.sameSong = !played && !!sk && ((st.songs.has(sk) && st.songs.get(sk) !== cand.id) || !!ctx.songKeys?.has?.(sk));
  if (played || parts.sameSong) v -= 3;
  else if (cand.lastPlayed && now - cand.lastPlayed < (W.recentHours ?? 4) * 3600e3) v -= 1;
  if (cur && cand.album && cur.album === cand.album && artistKey(cur) === ak) v -= 0.3;
  parts.variety = v;

  // Prefer tracks with analysed entry/exit points so the transition planner can land on musical phrases.
  parts.phrase = introValue(cand)
    + (Number.isFinite(+cand.mixIn) ? 0.45 : 0)
    + (cur && Number.isFinite(+cur.mixOut) ? 0.35 : 0)
    + (Array.isArray(cand.phrases) && cand.phrases.some((p) => ['buildup', 'verse', 'drop', 'chorus'].includes(p.type)) ? 0.2 : 0);

  // familiarity: move the recent familiar share toward the phase target; ≤ 3 bangers, ≤ 5 unfamiliar in a row
  parts.familiarity = 0;
  const fam = ctx.familiarity;
  if (fam?.enabled) {
    const f = isFamiliar(cand, fam) ? 1 : 0;
    const want = FAMILIAR_SHARE[st.phase] ?? 0.45;
    const share = (st.famCount + 0.5) / (st.famN + 1), next = (st.famCount + 0.5 + f) / (st.famN + 2);
    parts.familiarity = Math.max(-1, Math.min(1, (Math.abs(share - want) - Math.abs(next - want)) * (st.famN + 2)));
    if (f && isBanger(cand, fam) && st.bangerRun >= 3) parts.familiarity -= 2;
    if (!f && st.unfamRun >= 5) parts.familiarity -= 1.5;
  }

  // vocal alternation: ≤ 3 vocal-heavy tracks in a row, then an instrumental breather
  parts.vocal = 0;
  const vd = vocalDensity(cand);
  if (vd != null && st.vocalRun >= 3) parts.vocal = vd > VOCAL_HEAVY ? -1.5 : vd < VOCAL_BREATHER ? 0.5 : 0;

  // party controls: vibe lock, skip feedback (and a context reset after 2 skips in 4 tracks)
  parts.vibe = 0;
  if (ctx.vibeLock && cur) {
    const fa = genreFamilies(cur), fb = genreFamilies(cand);
    let shared = false; for (const x of fa) if (fb.has(x)) shared = true;
    const sim = soundSimilarity(cur, cand);
    parts.vibe = (sim == null ? 0 : 2 * sim - 1) + (fa.size && fb.size ? (shared ? 0.5 : -1.5) : 0);
  }
  parts.feedback = 0 - feedbackPenalty(cand, ctx.feedback, now) || 0;
  if (resetActive(ctx.feedback, now) && cur && !ctx.vibeLock) {
    const gs = genreSimilarity(cur, cand);
    parts.reset = (gs == null ? 0 : gs >= 0.5 ? -1.5 : gs < 0.2 ? 1.5 : 0) + (ea != null && eb != null && Math.abs(eb - ea) >= 2 ? 0.5 : 0);
    parts.feedback += parts.reset;
  }

  let score = W.harmonic * parts.harmonic + W.bpm * parts.bpm + W.energy * parts.energy + W.genre * parts.genre + W.variety * parts.variety + W.phrase * parts.phrase
    + (W.tempoArc ?? 1) * parts.tempoArc + (W.familiarity ?? 1) * parts.familiarity + (W.vocal ?? 1) * parts.vocal + (W.feedback ?? 1) * parts.feedback + (ctx.vibeLock ? W.vibe ?? 3 : 0) * parts.vibe;
  if (ctx.banned && asSetCached(ctx.banned).has(cand.id)) { parts.banned = true; score -= 1e6; }
  return { score, parts, target };
}
const bannedCache = new WeakMap();
function asSetCached(b) {
  if (b instanceof Set) return b;
  let s = bannedCache.get(b);
  if (!s) { s = asSet(b); if (typeof b === 'object') bannedCache.set(b, s); }
  return s;
}

const fmtBpm = (b) => (Number(b) % 1 ? Number(b).toFixed(1) : String(Math.round(b)));
/**
 * Human explanation of a transition, e.g. "8A → 9A, 124 → 126 BPM, energy +1, same genre". With ctx (the same
 * context as scoreTransition) it adds the set-level reasons: familiar banger, vocal breather, artist gap, skip
 * feedback, vibe lock, party arc.
 */
export function explain(cur, cand, ctx) {
  if (!cur) return [cand.key ? toCamelot(cand.key) : null, num(cand.bpm) ? `${fmtBpm(cand.bpm)} BPM` : null, num(cand.energy) ? `energy ${cand.energy}` : null].filter(Boolean).join(', ') || 'opening track';
  const bits = [];
  if (Number.isFinite(+cand.mixIn)) bits.push('analysed mix-in');
  if (Number.isFinite(+cur.mixOut)) bits.push('analysed outro');
  const h = camelotRelation(cur.key, cand.key);
  if (h.kind !== 'unknown') bits.push(`${h.from} → ${h.to}${h.kind === 'clash' ? ' (key clash)' : h.kind === 'relative' ? ' (relative)' : h.kind === 'boost' ? ' (energy boost)' : h.kind === 'semitone' ? ' (semitone lift)' : ''}`);
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
  if (ctx) {
    const { parts, target } = scoreTransition(cur, cand, ctx);
    const st = contextState(cur, ctx), fam = ctx.familiarity;
    if (fam?.enabled && isBanger(cand, fam)) bits.push('familiar banger');
    else if (fam?.enabled && isFamiliar(cand, fam) && parts.familiarity > 0) bits.push('familiar track');
    const vd = vocalDensity(cand);
    if (st.vocalRun >= 2 && vd != null && vd < VOCAL_BREATHER) bits.push('vocal breather');
    if (parts.artistGap != null && parts.artistGap <= (ctx.weights?.artistSoft ?? 15)) bits.push(`artist gap ${parts.artistGap}`);
    if (parts.sameSong) bits.push('same song as an earlier track');
    if (parts.reset > 0) bits.push('fresh direction after skips');
    else if (parts.feedback < -0.3) bits.push('skip feedback');
    if (ctx.vibeLock && parts.vibe > 0) bits.push('vibe lock');
    if (ctx.shape === 'party' && target != null) bits.push(`party arc: ${arcPhase('party', ctx.x ?? 0, ctx)}, target energy ${Math.round(target * 10) / 10}`);
  }
  return bits.join(', ');
}

function prep(t) { Object.defineProperty(t, '_words', { value: styleWords(t), enumerable: false, configurable: true, writable: true }); return t; }
function energyRange(list) {
  let lo = Infinity, hi = -Infinity;
  for (const t of list) { const e = num(t.energy); if (e != null) { if (e < lo) lo = e; if (e > hi) hi = e; } }
  return lo <= hi ? [lo, hi] : [1, 10];
}

/**
 * Order (and, for big pools, pick) tracks so each transition scores well and the set follows the shape.
 * opts: { shape='warmup', sliders | weights, limit (tracks to pick; default all up to 200, else 40),
 *         start (track playing before the set), history (tracks played already), beam=6, branch=6, now,
 *         energyBias, banned, vibeLock, feedback (see scoreTransition), familiarity (default from the pool),
 *         trackMinutes=3.5 (minutes per track, advances the party clock), setMinutes (party; default limit × trackMinutes) }
 * @returns {{ tracks: object[], steps: { track, reason, score }[] }}
 */
export function smartMix(pool, opts = {}) {
  const seen = new Set();
  const banned = opts.banned ? asSet(opts.banned) : null;
  const list = pool.filter((t) => t && !seen.has(t.id) && seen.add(t.id) && !banned?.has(t.id)).map(prep);
  const W = opts.weights || weightsFrom(opts.sliders);
  const shape = opts.shape || 'warmup';
  const L = Math.min(list.length, Math.max(1, opts.limit ?? (list.length <= 200 ? list.length : 40)));
  if (!L) return { tracks: [], steps: [] };
  const [lo, hi] = energyRange(list);
  const history = (opts.history || []).map(prep);
  const playedIds = new Set(history.map((t) => t.id));
  const start = opts.start ? prep(opts.start) : null;
  if (start) playedIds.add(start.id);
  const baseSeq = [...history, ...(start ? [start] : [])];
  const songKeys = new Set(baseSeq.map(songKey).filter(Boolean));
  const baseTail = baseSeq.slice(-16);
  const B = Math.max(1, opts.beam ?? 6), K = Math.max(1, opts.branch ?? 6);
  const now = opts.now ?? Date.now();
  const tm = opts.trackMinutes ?? 3.5;
  const familiarity = opts.familiarity || familiarityInfo(list);
  const common = { weights: W, shape, lo, hi, playedIds, songKeys, energyBias: opts.energyBias, vibeLock: opts.vibeLock, feedback: opts.feedback, familiarity, setMinutes: opts.setMinutes ?? L * tm, endless: opts.endless };
  const ctxAt = (i, seq) => ({ ...common, x: L > 1 ? i / (L - 1) : 0, now: now + i * tm * 60e3, elapsedMin: i * tm, history: [...baseTail, ...seq.slice(-16)].slice(-16) });
  const bias = Math.max(-2, Math.min(2, +opts.energyBias || 0));
  const t0 = shapeTarget(shape, 0, lo, hi, ctxAt(0, []));
  const openingTarget = t0 == null ? null : Math.max(1, Math.min(10, t0 + bias));
  const openingDistance = (t) => num(t.energy) == null || openingTarget == null ? Infinity : Math.abs(num(t.energy) - openingTarget);
  const closestOpening = list.reduce((best, t) => Math.min(best, openingDistance(t)), Infinity);
  let beams = [{ seq: [], used: new Set(), total: 0 }];
  for (let i = 0; i < L; i++) {
    const next = [];
    for (const b of beams) {
      const prev = b.seq.length ? b.seq[b.seq.length - 1] : start;
      const ctx = ctxAt(i, b.seq);
      const cands = [];
      for (const t of list) {
        if (b.used.has(t.id)) continue;
        // Preserve the requested opening energy: future compatibility must not turn a warm-up into a peak opener.
        if (!prev && Number.isFinite(closestOpening) && openingDistance(t) > closestOpening) continue;
        let s;
        if (!prev) { // opening track: fit the start of the shape, prefer tracks with an intro
          const e = num(t.energy);
          s = (e == null || openingTarget == null ? 0 : -Math.abs(e - openingTarget) * W.energy) + W.phrase * introValue(t) - (playedIds.has(t.id) ? 10 : 0)
            - (W.feedback ?? 1) * feedbackPenalty(t, opts.feedback, now);
        } else s = scoreTransition(prev, t, ctx).score;
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
    if (!prev) return { track: t, reason: explain(null, t), score: 0 };
    const ctx = ctxAt(i, best.seq.slice(0, i));
    return { track: t, reason: explain(prev, t), score: scoreTransition(prev, t, ctx).score };
  });
  return { tracks: best.seq, steps };
}

const DISCOUNT = 0.85;
/**
 * Live mode: the best next track from `pool` after `cur`, given what was played. position = tracks played so far,
 * setLength = planned set length (for the shape).
 * opts: { history, shape, sliders | weights, position, setLength, now, transitionScore(track) → { score, reason }
 *         (expensive; only called for ≤ `finalists` first-step candidates),
 *         lookahead=3 (planning depth in tracks; 0 = greedy: rank by pair score, rerank the top 6 with transitionScore),
 *         beamWidth=5, prefilter=40 (lookahead only considers the top-K single-step candidates), finalists=6,
 *         energyBias, banned, vibeLock, feedback, familiarity (see scoreTransition),
 *         endless (party arc cycles on the clock; x wraps at setLength), elapsedMin, setMinutes, trackMinutes=3.5 }
 * @returns {{ track, reason, score, plan: object[], planScore, transitionReason } | null}
 */
export function liveNext(cur, pool, opts = {}) {
  const { history: hist0 = [], shape = 'warmup', sliders, weights, position = 0, setLength = 20, transitionScore, energyBias, banned, vibeLock, feedback, endless } = opts;
  const history = hist0.filter(Boolean);
  const W = weights || weightsFrom(sliders);
  const depthOpt = Math.max(0, Math.floor(opts.lookahead ?? 3)), width = Math.max(1, opts.beamWidth ?? 5);
  const preK = Math.max(1, opts.prefilter ?? 40), nFinal = Math.max(1, opts.finalists ?? 6);
  const tm = opts.trackMinutes ?? 3.5, now = opts.now ?? Date.now();
  const playedIds = new Set([...history.map((t) => t?.id), cur?.id].filter(Boolean));
  const bannedSet = banned ? asSet(banned) : null;
  const list = pool.filter((t) => t && !playedIds.has(t.id) && !bannedSet?.has(t.id)).map(prep);
  if (!list.length) return null;
  // a plan that has to use up the whole pool says nothing about dead ends: keep at least one track out of it
  const depth = Math.min(depthOpt, list.length - 1);
  if (cur) prep(cur);
  const [lo, hi] = energyRange([...list, ...(cur ? [cur] : [])]);
  const familiarity = opts.familiarity || familiarityInfo(list);
  const songKeys = new Set(history.map(songKey).filter(Boolean));
  const histTail = history.slice(-16);
  const el0 = Number.isFinite(+opts.elapsedMin) ? +opts.elapsedMin : position * tm;
  const setMinutes = endless ? undefined : (opts.setMinutes ?? setLength * tm);
  const xAt = (p) => (endless ? (p % Math.max(1, setLength)) / Math.max(1, setLength - 1) : Math.min(1, p / Math.max(1, setLength - 1)));
  const common = { weights: W, shape, lo, hi, playedIds, songKeys, energyBias, vibeLock, feedback, familiarity, setMinutes, endless };
  const ctxAt = (k, path) => ({ ...common, x: xAt(position + k), now: now + k * tm * 60e3, elapsedMin: el0 + k * tm, history: [...histTail, ...(cur ? [cur] : []), ...path].slice(-16) });

  const ctx0 = ctxAt(0, []);
  const ranked = list.map((t) => ({ track: t, score: scoreTransition(cur, t, ctx0).score }));
  ranked.sort((a, b) => b.score - a.score);

  let firsts;
  if (depth <= 1) firsts = ranked.slice(0, nFinal).map((r) => ({ ...r, planScore: r.score, plan: [r.track] }));
  else {
    const K = ranked.slice(0, preK).map((r) => r.track);
    const nFirst = Math.min(K.length, Math.max(nFinal * 2, 12));
    firsts = ranked.slice(0, nFirst).map((r) => {
      let beams = [{ path: [r.track], total: r.score }];
      for (let d = 1; d < depth; d++) {
        const next = [];
        const disc = DISCOUNT ** d;
        for (const b of beams) {
          const prev = b.path.at(-1), ctx = ctxAt(d, b.path.slice(0, -1));
          const used = new Set(b.path.map((t) => t.id));
          for (const t of K) if (!used.has(t.id)) next.push({ path: b.path, t, total: b.total + disc * scoreTransition(prev, t, ctx).score });
        }
        if (!next.length) break;
        next.sort((a, b) => b.total - a.total);
        beams = next.slice(0, width).map((n) => ({ path: [...n.path, n.t], total: n.total }));
      }
      return { ...r, planScore: beams[0].total, plan: beams[0].path };
    });
    firsts.sort((a, b) => b.planScore - a.planScore);
    firsts = firsts.slice(0, nFinal);
  }
  const finalists = firsts.map((r) => {
    const q = transitionScore?.(r.track);
    const add = Number.isFinite(q?.score) ? q.score : 0;
    return { ...r, score: r.score + add, planScore: r.planScore + add, transitionReason: q?.reason };
  });
  finalists.sort((a, b) => b.planScore - a.planScore);
  const best = finalists[0];
  return { ...best, reason: [explain(cur, best.track, cur ? ctx0 : undefined), best.transitionReason].filter(Boolean).join('; ') };
}

/** Fisher-Yates shuffle (copy). rand() defaults to Math.random. */
export function shuffle(list, rand = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
