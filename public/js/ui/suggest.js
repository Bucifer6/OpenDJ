// "Suggested next": how well a library track would mix out of the reference (master / playing) track.
// Ranking uses smart mix's transition score (js/smartmix.js: harmonic relation, tempo, energy, genre, artist
// variety) on top of a hard filter (beatmatchable within ±8 %, key known-compatible flagged); the local scorer
// below remains as the fallback when smart mix can't score a pair.
import { toCamelot, camelotCompatible } from '../audio/analysis-core.js';
import { scoreTransition, styleWords, explain } from '../smartmix.js';

/** Reference for scoring from a deck: { id, cam, bpm, energy, genre }. */
export function refFromDeck(deck) {
  const t = deck?.track;
  if (!t) return null;
  return { id: t.id, cam: deck.playingCamelot || toCamelot(t.key), bpm: deck.effectiveBpm || t.bpm || 0, energy: Number(t.energy) || 0, genre: (t.genre || '').toLowerCase(), track: t };
}

/** Score 0..1 (higher mixes better), or -1 when the track should not be suggested. */
export function scoreTrack(ref, t) {
  if (!ref || !t || t.id === ref.id || t.missing || t.unreadable) return -1;
  const cam = toCamelot(t.key);
  let key = 0.35; // unknown key
  if (ref.cam && cam) key = cam === ref.cam ? 1 : camelotCompatible(ref.cam, cam) ? 0.85 : 0.1;
  let bpm = 0.4;
  if (ref.bpm > 0 && t.bpm > 0) {
    const d = Math.min(...[1, 2, 0.5].map((f) => Math.abs(t.bpm * f / ref.bpm - 1)));
    bpm = d > 0.08 ? 0 : 1 - d / 0.08;
  }
  if (bpm === 0) return -1; // can't be beatmatched within ±8 %
  const energy = ref.energy && t.energy ? 1 - Math.min(1, Math.abs(ref.energy - Number(t.energy)) / 4) : 0.6;
  const genre = ref.genre && t.genre && t.genre.toLowerCase() === ref.genre ? 1 : 0.5;
  return 0.45 * key + 0.35 * bpm + 0.12 * energy + 0.08 * genre - (t.playCount ? 0.04 : 0);
}

/** Best `limit` tracks to play after `ref`: [{ track, score, keyMatch, bpmDelta }] (best first). */
const words = (t) => { if (!t._words) Object.defineProperty(t, '_words', { value: styleWords(t), enumerable: false, configurable: true, writable: true }); return t; };

export function suggestNext(ref, tracks, { limit = 10, exclude = new Set() } = {}) {
  if (!ref) return [];
  // smart mix compares the playing key / tempo: a pitched or tempo-shifted deck is scored as heard
  const cur = ref.track ? words({ ...ref.track, key: ref.cam || ref.track.key, bpm: ref.bpm || ref.track.bpm }) : null;
  // Pass 1: fast bounded top-K pre-filter using scoreTrack() so 70k+ libraries never run scoreTransition/explain on every track.
  // Keep analysed tracks (known BPM or key) separate from unanalysed fallbacks so thousands of unanalysed remote tracks don't drown out matches.
  const cap = Math.max(limit * 8, 80);
  const topAnalysed = [];
  const topFallback = [];
  const pushTop = (arr, item) => {
    if (arr.length < cap) {
      arr.push(item);
      if (arr.length === cap) arr.sort((a, b) => b.local - a.local);
    } else if (item.local > arr[arr.length - 1].local) {
      let i = arr.length - 1;
      while (i > 0 && item.local > arr[i - 1].local) { arr[i] = arr[i - 1]; i--; }
      arr[i] = item;
    }
  };
  for (const t of tracks) {
    if (!t || exclude.has(t.id)) continue;
    const local = scoreTrack(ref, t);
    if (local <= 0.3) continue; // not beatmatchable / missing / same track
    const hasMeta = (Number(t.bpm) > 0) || !!t.key;
    if (hasMeta) pushTop(topAnalysed, { track: t, local });
    else if (topAnalysed.length < limit) pushTop(topFallback, { track: t, local });
  }
  const shortlist = topAnalysed.length >= limit ? topAnalysed : [...topAnalysed, ...topFallback];
  // Pass 2: rank the bounded shortlist with smart mix's transition scorer (without generating explanations yet).
  const out = [];
  for (const { track: t, local } of shortlist) {
    let score = local;
    if (cur) { try { score = scoreTransition(cur, words(t)).score; } catch { score = local; } }
    out.push({ track: t, score, reason: '', keyMatch: !!(ref.cam && camelotCompatible(ref.cam, toCamelot(t.key))), bpmDelta: ref.bpm && t.bpm ? (t.bpm / ref.bpm - 1) * 100 : null });
  }
  out.sort((a, b) => b.score - a.score);
  const winners = out.slice(0, limit);
  // Pass 3: build human-readable explanations only for the final top `limit` winners.
  if (cur) {
    for (const w of winners) {
      try { w.reason = explain(cur, w.track); } catch { w.reason = ''; }
    }
  }
  return winners;
}
