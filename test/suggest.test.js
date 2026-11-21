// "Suggested next" strip ranking (public/js/ui/suggest.js on top of smartmix.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestNext, scoreTrack } from '../public/js/ui/suggest.js';

const T = [
  { id: 'a', title: 'A', key: '8A', bpm: 124, energy: 6, genre: 'House' },
  { id: 'b', title: 'B', key: '9A', bpm: 125, energy: 7, genre: 'House' },
  { id: 'c', title: 'C', key: '2B', bpm: 126, energy: 5, genre: 'Techno' },
  { id: 'd', title: 'D', key: '8A', bpm: 150 },
  { id: 'e', title: 'E', key: '8A', bpm: 62, energy: 6, genre: 'House' }, // half time
  { id: 'f', title: 'F', key: '8A', bpm: 124, missing: true },
];
const ref = { id: 'a', cam: '8A', bpm: 124, energy: 6, genre: 'house', track: T[0] };

test('suggestions: compatible keys first, never the same / missing / un-beatmatchable track', () => {
  const ids = suggestNext(ref, T).map((x) => x.track.id);
  assert.ok(!ids.includes('a') && !ids.includes('d') && !ids.includes('f'));
  assert.ok(ids.includes('e'), 'half / double time counts as beatmatchable');
  assert.ok(ids.indexOf('b') < ids.indexOf('c'), 'harmonic neighbour ranks above a key clash');
  assert.equal(suggestNext(ref, T).find((x) => x.track.id === 'b').keyMatch, true);
});

test('suggestions: excluded (loaded) tracks are skipped; no reference -> nothing', () => {
  assert.ok(!suggestNext(ref, T, { exclude: new Set(['b']) }).some((x) => x.track.id === 'b'));
  assert.deepEqual(suggestNext(null, T), []);
  assert.equal(scoreTrack(ref, T[3]), -1);
});
