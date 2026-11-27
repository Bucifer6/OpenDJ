// "Suggested next" strip ranking (public/js/ui/suggest.js on top of smartmix.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestNext, scoreTrack } from '../public/js/ui/suggest.js';
import { smartMix, liveNext } from '../public/js/smartmix.js';

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

test('large library (25k tracks): suggestNext, smartMix, and liveNext stay fast without blocking the UI', () => {
  const N = 25000;
  const keys = ['8A', '9A', '7A', '8B', '2B', '3A'];
  const big = Array.from({ length: N }, (_, i) => ({
    id: `big_${i}`, title: `Track ${i}`, artist: `Artist ${i % 500}`, genre: i % 2 ? 'House' : 'Pop',
    bpm: i < 200 ? 120 + (i % 12) : 0, key: i < 200 ? keys[i % keys.length] : null,
    energy: i < 200 ? 1 + (i % 10) : null, analyzed: i < 200, duration: 210,
  }));
  const bigRef = { id: 'big_0', cam: '8A', bpm: 124, energy: 6, genre: 'house', track: big[0] };

  let t0 = performance.now();
  const sg = suggestNext(bigRef, big, { limit: 12 });
  const tSg = performance.now() - t0;
  assert.equal(sg.length, 12);
  assert.ok(sg.every((x) => x.track.analyzed), 'analysed matches rank ahead of unanalysed tracks');
  assert.ok(tSg < 300, `suggestNext(25k) took ${tSg.toFixed(1)} ms`);

  t0 = performance.now();
  const sm = smartMix(big, { limit: 40, start: big[0] });
  const tSm = performance.now() - t0;
  assert.equal(sm.tracks.length, 40);
  assert.ok(tSm < 500, `smartMix(25k) took ${tSm.toFixed(1)} ms`);

  t0 = performance.now();
  const ln = liveNext(big[0], big, { setLength: 40 });
  const tLn = performance.now() - t0;
  assert.ok(ln?.track?.id);
  assert.ok(tLn < 300, `liveNext(25k) took ${tLn.toFixed(1)} ms`);
});
