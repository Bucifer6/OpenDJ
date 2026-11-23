// Automix transition planner (public/js/mix-planner.js) and the vocal map (public/js/shared/vocal-map.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBestTransition, vocalsBetween, learnChoice, learnedBias, stemSwapLevels } from '../public/js/mix-planner.js';
import { vocalPresence, encodeVocalMap, decodeVocalMap } from '../public/js/shared/vocal-map.js';

/** A 4-minute 124 BPM track: 16-bar intro, verse / drop body, 16-bar outro. */
function track(over = {}) {
  const bpm = over.bpm || 124, bar = 240 / bpm;
  const ph = [
    { start: 0, end: 16 * bar, type: 'intro' }, { start: 16 * bar, end: 48 * bar, type: 'verse' },
    { start: 48 * bar, end: 96 * bar, type: 'drop' }, { start: 96 * bar, end: 112 * bar, type: 'outro' },
  ];
  return { bpm, key: '8A', energy: 6, genre: 'House', duration: 112 * bar, endTime: 112 * bar, mixIn: 0, mixOut: 96 * bar, downbeat: 0, gridOffset: 0, phrases: ph, ...over };
}
const map = (secs, f) => encodeVocalMap(Array.from({ length: secs }, (_, i) => f(i)));

test('vocal map: presence from stem energy, round trip through base64', () => {
  const v = [0, 1e-7, 0.01, 0.01], other = [0.01, 0.01, 0.01, 0.0001];
  const p = vocalPresence(v, [v, other]);
  assert.equal(p[0], 0); assert.equal(p[1], 0, 'too quiet to be a voice');
  assert.ok(p[2] > 0.9, 'half the energy is vocals'); assert.ok(p[3] > 0.99);
  const back = decodeVocalMap(encodeVocalMap(p));
  assert.equal(back.length, 4); assert.ok(Math.abs(back[2] - p[2]) < 0.01);
  assert.equal(decodeVocalMap('***'), null);
});

test('planner: similar tracks get a long phrase-fitting blend', () => {
  const p = planBestTransition(track(), track({ key: '9A' }));
  assert.ok(['blend', 'stemswap'].includes(p.style), p.style);
  assert.equal(p.bars, 16, 'fits the 16-bar outro and lands on the 16-bar intro');
  assert.match(p.why, /^planned: /);
  assert.ok(p.options.length >= 3 && p.options[0].style === p.style);
});

test('planner: a big tempo jump is never blended', () => {
  const p = planBestTransition(track({ bpm: 124 }), track({ bpm: 96 }));
  assert.ok(['echo', 'cut', 'reverb', 'loop', 'backspin', 'brake'].includes(p.style), p.style);
  assert.ok(p.options.every((o) => !['blend', 'bassswap', 'crossfade', 'filter', 'stemswap'].includes(o.style)));
});

test('planner: a key clash shortens the overlap or hides it', () => {
  const p = planBestTransition(track({ key: '8A' }), track({ key: '3B' }));
  assert.ok(p.style === 'filter' || p.bars <= 8 || ['echo', 'cut', 'reverb'].includes(p.style), `${p.style} ${p.bars}`);
  const synced = planBestTransition(track({ key: '8A' }), track({ key: '3B' }), { keySync: true });
  assert.ok(synced.bars >= p.bars, 'key sync allows the longer blend again');
});

test('planner: no beat grid means no beat-matched overlap', () => {
  const p = planBestTransition(track({ bpm: 0 }), track());
  assert.ok(['echo', 'cut', 'reverb'].includes(p.style), p.style);
});

test('planner: overlapping vocals are held back, or swapped stem by stem when both decks have AI stems', () => {
  const secs = Math.ceil(track().duration);
  const allVox = { ready: true, vocals: map(secs, () => 1) };
  const out = track({ stems: allVox }), inn = track({ key: '9A', stems: allVox });
  const v = vocalsBetween(out, 10, 20);
  assert.equal(v.known, true); assert.ok(v.v > 0.99);
  const held = planBestTransition(out, inn, { styles: ['blend', 'bassswap', 'crossfade', 'filter'] });
  assert.equal(held.vocals, 'hold-in', `${held.style}: incoming vocals wait`);
  const swap = planBestTransition(out, inn, { stemsOut: true, stemsIn: true });
  assert.equal(swap.style, 'stemswap');
  // no vocals anywhere: nothing to hold back
  const none = { ready: true, vocals: map(secs, () => 0) };
  assert.equal(planBestTransition(track({ stems: none }), track({ key: '9A', stems: none }), { styles: ['blend'] }).vocals, null);
});

test('planner: cutting a track off mid-vocal is avoided', () => {
  const secs = Math.ceil(track().duration);
  const out = track({ stems: { ready: true, vocals: map(secs, () => 1) } });
  const p = planBestTransition(out, track({ bpm: 96 }), { styles: ['cut', 'echo'] });
  assert.equal(p.style, 'echo');
});

test('planner: fixed length setting plans the style only', () => {
  const p = planBestTransition(track(), track(), { fixedBars: 8 });
  assert.equal(p.bars, 8);
});

test('planner: learns from overrides and repeats less', () => {
  let learning = { n: 0, bias: {} };
  for (let i = 0; i < 12; i++) learning = learnChoice(learning, 'filter', 'blend');
  assert.equal(learning.n, 12);
  const b = learnedBias(learning);
  assert.ok(b.filter > 3 && b.blend < 0, JSON.stringify(b));
  assert.ok(b.filter <= 5);
  const p = planBestTransition(track(), track({ key: '9A' }), { learning });
  assert.equal(p.style, 'filter');
  assert.deepEqual(learnChoice(learning, 'nonsense', 'blend').bias, learnedBias(learning));
  const vary = planBestTransition(track({ genre: 'Disco' }), track({ key: '9A', genre: 'Disco' }), { prevStyle: 'blend', vary: true, styles: ['blend', 'bassswap', 'filter'] });
  assert.notEqual(vary.style, 'blend');
  // club music keeps blending even with "vary styles" on (house DJs blend transition after transition)
  const club = planBestTransition(track(), track({ key: '9A' }), { prevStyle: 'blend', vary: true, styles: ['blend', 'bassswap', 'filter'] });
  assert.equal(club.style, 'blend');
});

test('stem swap levels: drums first, bass swaps in the middle, incoming vocals after the outgoing ones', () => {
  const at = (k) => stemSwapLevels(k);
  assert.deepEqual(at(0).inn, [0, 0, 0, 0]); assert.deepEqual(at(0).out, [1, 1, 1, 1]);
  assert.ok(at(0.2).inn[1] > 0.99 && at(0.2).inn[2] === 0, 'incoming drums in, bass not yet');
  assert.ok(at(0.6).inn[2] === 1 && at(0.6).out[2] === 0, 'bass swapped');
  assert.ok(at(0.74).out[0] < 0.01 && at(0.74).inn[0] === 0, 'outgoing vocals gone before incoming ones start');
  assert.deepEqual(at(1).inn, [1, 1, 1, 1]); assert.equal(at(1).outVol, 0);
});
