// "Suggested next" scoring: how well a library track would mix out of the reference (master / playing) track.
// Deliberately small and self-contained so a smarter scorer (e.g. a smart-mix module from automix) can replace it:
// anything exporting suggestNext(ref, tracks, opts) with the same result shape works.
import { toCamelot, camelotCompatible } from '../audio/analysis-core.js';

/** Reference for scoring from a deck: { id, cam, bpm, energy, genre }. */
export function refFromDeck(deck) {
  const t = deck?.track;
  if (!t) return null;
  return { id: t.id, cam: deck.playingCamelot || toCamelot(t.key), bpm: deck.effectiveBpm || t.bpm || 0, energy: Number(t.energy) || 0, genre: (t.genre || '').toLowerCase() };
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
export function suggestNext(ref, tracks, { limit = 10, exclude = new Set() } = {}) {
  if (!ref) return [];
  const out = [];
  for (const t of tracks) {
    if (exclude.has(t.id)) continue;
    const score = scoreTrack(ref, t);
    if (score > 0.3) out.push({ track: t, score, keyMatch: !!(ref.cam && camelotCompatible(ref.cam, toCamelot(t.key))), bpmDelta: ref.bpm && t.bpm ? (t.bpm / ref.bpm - 1) * 100 : null });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
