// What real DJ mixes show (docs/automix-research/04-real-mixes.md), as Automix rules: blends mostly 16 bars and at
// most 32 (a long outro over a long intro may run longer), tracks on air about as long as DJs play them, the bass
// swapped as the incoming groove arrives or a little past the middle, the incoming highs held back until then.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAdaptiveTransition } from '../public/js/adaptive-dj.js';
import { planBestTransition } from '../public/js/mix-planner.js';
import { autoTransitionLength, phraseSwapPoint, mixLevels, SWAP_AT } from '../public/js/automix.js';
import { FAMILIES } from '../public/js/dj-styles.js';

const BPM = 124, BAR = 240 / BPM;
/** A club track: intro, build, drop, breakdown, drop, outro (bars). */
function club(id, { intro = 32, outro = 32, drop = 64, extra = {} } = {}) {
  const parts = [['intro', intro], ['buildup', 16], ['drop', drop], ['breakdown', 32], ['drop', drop], ['outro', outro]];
  let at = 0;
  const phrases = parts.map(([type, bars]) => { const p = { type, start: at * BAR, end: (at + bars) * BAR, energy: type === 'drop' ? 0.9 : 0.5 }; at += bars; return p; });
  return { id, bpm: BPM, bpmConfidence: 0.95, key: '8A', energy: 7, genre: 'Tech House', duration: at * BAR, downbeat: 0, gridOffset: 0, mixIn: 0,
    mixOut: (at - outro) * BAR, phrases, ...extra };
}

test('club blends: the planner prefers 16 bars and keeps to 32 at most for house, techno and trance', () => {
  for (const id of ['house', 'techno', 'trance']) assert.ok(FAMILIES[id].maxBars <= 32 && FAMILIES[id].bestBars.includes(16), id);
  for (const [o, i] of [[24, 24], [40, 40], [32, 16]]) {
    const out = club('a', { outro: o }), inn = club('b', { intro: i });
    const p = planBestTransition({ ...out, mixOut: out.duration - o * BAR }, inn, { styles: ['blend'] });
    assert.ok(p.bars >= 8 && p.bars <= 32, `${o}-bar outro, ${i}-bar intro: ${p.bars} bars`);
    assert.match(p.lengthWhy, /most DJs: 8-26 bars/);
  }
  // only a long outro over a long intro runs past 32 bars
  assert.equal(autoTransitionLength(club('a', { outro: 40 }), club('b', { intro: 40 }), 'blend').bars, 32);
  assert.equal(autoTransitionLength(club('a', { outro: 64 }), club('b', { intro: 64 }), 'blend').bars, 64);
});

test('play time: a long club track hands over after about as long as a DJ plays it, not at its very end', () => {
  // an 8.6-minute track that came in at its start, with section ends to exit on all through it
  const out = club('a', { drop: 96, outro: 32 }), inn = club('b');
  const p = planAdaptiveTransition(out, inn, { position: 0, entry: 0, styles: ['blend'] });
  const longest = planAdaptiveTransition(out, inn, { position: 0, entry: 0, styles: ['blend'], playTarget: false });
  assert.ok(p && longest);
  const onAir = p.timing.begin / 60, before = longest.timing.begin / 60;
  assert.ok(out.duration / 60 > 8, `${(out.duration / 60).toFixed(1)} min track`);
  assert.ok(onAir <= FAMILIES.house.playMinutes * 1.2 + 1.2, `next track comes in after ${onAir.toFixed(1)} min`);
  assert.ok(onAir >= 3, `but most of it still plays: ${onAir.toFixed(1)} min`);
  assert.ok(onAir < before, `earlier than without the target (${before.toFixed(1)} min)`);
});

test('bass swap: as the incoming main part arrives, else on the phrase line nearest 58 % of the blend', () => {
  const inn = { bpm: BPM, mixIn: 0, phrases: [{ type: 'intro', start: 0 }, { type: 'intro', start: 8 * BAR }, { type: 'drop', start: 24 * BAR }] };
  // 32-bar blend: the drop at 75 % beats the intro phrase line at 25 %
  assert.ok(Math.abs(phraseSwapPoint(inn, 0, 32 * BAR) - 24 * BAR) < 1e-6);
  // no main part inside: the phrase line nearest 58 %
  const plain = { bpm: BPM, mixIn: 0, phrases: [{ type: 'intro', start: 0 }, { type: 'intro', start: 8 * BAR }, { type: 'intro', start: 16 * BAR }, { type: 'outro', start: 40 * BAR }] };
  assert.ok(Math.abs(phraseSwapPoint(plain, 0, 32 * BAR) - 16 * BAR) < 1e-6);
  assert.ok(Math.abs(phraseSwapPoint({ bpm: 0 }, 10, 8) - (10 + SWAP_AT * 8)) < 1e-9);
});

test('blend EQ: the incoming highs stay 6 dB down until the swap and open with the bass', () => {
  for (const k of [0, 0.2, 0.4, 0.55]) assert.ok(Math.abs(mixLevels('blend', k, null).inHigh - -6 / 26) < 1e-9, `k=${k}`);
  const just = mixLevels('blend', 0.6, 0.58), later = mixLevels('blend', 0.75, 0.58);
  assert.ok(just.inHigh < 0 && just.inHigh > -6 / 26, 'opening');
  assert.ok(Math.abs(later.inHigh) < 1e-12, 'open');
  assert.equal(just.inLow, 0); assert.equal(just.outLow, -1);
});
