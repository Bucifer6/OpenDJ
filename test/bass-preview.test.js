// Bass preview (Settings → Automix, off by default): in a club EQ blend the incoming bass plays at -8 dB for the
// 8 bars before the bass swap, as in a real DJ's transition (docs/automix-research/04-real-mixes.md §2.4), only when
// the transition check finds no low-end bump from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mixLevels, bassPreviewFrom, BASS_PREVIEW_DB, BASS_PREVIEW_BARS, twoBasslines } from '../public/js/automix.js';
import { checkBassPreview } from '../public/js/transition-check.js';
import { isoKnobGain } from '../public/js/audio/curves.js';

const BPM = 125, BAR = 240 / BPM;

test('bass preview window: 8 bars before the swap, shorter when the blend is, none under 2 bars', () => {
  assert.equal(BASS_PREVIEW_BARS, 8);
  const lenIn = 32 * BAR;                                       // a 32-bar blend, swap at bar 19.2 (60 %)
  assert.ok(Math.abs(bassPreviewFrom(0.6, lenIn, BAR) - (0.6 - 8 / 32)) < 1e-9, '8 bars before the swap');
  const short = bassPreviewFrom(0.6, 16 * BAR, BAR);            // 16 bars: only 8 bars after the first tenth fit
  assert.ok(Math.abs(short - 0.1) < 1e-9, `starts after the first tenth (${short})`);
  assert.equal(bassPreviewFrom(0.2, 8 * BAR, BAR), null, 'fewer than 2 bars before the swap: none');
  assert.equal(bassPreviewFrom(null, lenIn, BAR), null);
});

test('mixLevels: the preview holds the incoming bass at -8 dB until the swap; without it, nothing changes', () => {
  for (let k = 0; k <= 1.0001; k += 0.05) {
    assert.deepEqual(mixLevels('blend', k, null, {}), mixLevels('blend', k, null), `no option, k=${k}`);
    assert.deepEqual(mixLevels('blend', k, 0.6, { previewFrom: 0.35 }), mixLevels('blend', k, 0.6), `after the swap, k=${k}`);
  }
  assert.equal(mixLevels('blend', 0.3, null, { previewFrom: 0.35 }).inLow, -1, 'before the window: cut');
  const pv = mixLevels('blend', 0.4, null, { previewFrom: 0.35 });
  assert.ok(Math.abs(20 * Math.log10(isoKnobGain(pv.inLow)) - BASS_PREVIEW_DB) < 0.5, `-8 dB in the window (${pv.inLow})`);
  assert.equal(pv.outLow, 0, 'the outgoing bass stays full');
  assert.equal(twoBasslines(pv), true, 'it is two basslines, deliberately (so it needs its own check)');
  assert.equal(mixLevels('bassswap', 0.4, null, { previewFrom: 0.35 }).inLow, mixLevels('bassswap', 0.4, null).inLow, 'only the club EQ blend');
});

test('checkBassPreview: under a quieter intro yes, under an equally loud section no', () => {
  const t = (lufs) => ({ bpm: BPM, gain: 0, phrases: [{ start: 0, end: 400, lufs }] });
  const plan = { style: 'blend', begin: 100, len: 32 * BAR, inStart: 0, ratio: 1, kSwap: 0.6, previewFrom: 0.35 };
  assert.equal(checkBassPreview(t(-10), t(-20), plan), true, 'a quiet intro');
  assert.equal(checkBassPreview(t(-10), t(-14), plan), true, 'an intro 4 LU quieter');
  assert.equal(checkBassPreview(t(-10), t(-10), plan), false, 'two equally loud sections: the kicks would add up');
  assert.equal(checkBassPreview(t(-10), t(-20), { ...plan, previewFrom: null }), false, 'no window: no preview');
});

test('AutoMix uses the preview only when it is switched on, for a blend, outside double drops', async () => {
  const { AutoMix } = await import('../public/js/automix.js');
  const settings = { automix: {} };
  const app = { engine: { on() {}, decks: [], channels: [] }, settings, library: { track: () => null }, toast() {} };
  const am = new AutoMix(app);
  const track = (id, lufs) => ({ id, bpm: BPM, gain: 0, phrases: [{ start: 0, end: 400, lufs }] });
  am.info = (d) => d.track;
  const out = { track: track('a', -10) }, ii = track('b', -20);
  const args = { begin: 100, len: 32 * BAR, inStart: 0, ratio: 1, kSwap: 0.6, lenIn: 32 * BAR };
  assert.equal(am.bassPreviewFor('blend', null, out, ii, args), null, 'off by default');
  settings.automix.bassPreview = true;
  assert.ok(Math.abs(am.bassPreviewFor('blend', null, out, ii, args) - 0.35) < 1e-9, 'on: 8 bars before the swap');
  assert.ok(am.bassPreviewFor('phrase', null, out, ii, args) != null, 'the blend alias too');
  assert.equal(am.bassPreviewFor('bassswap', null, out, ii, args), null, 'not for other styles');
  assert.equal(am.bassPreviewFor('blend', { doubleDrop: true }, out, ii, args), null, 'not in a double drop');
  assert.equal(am.bassPreviewFor('blend', null, { track: track('a', -10) }, track('b', -10), args), null, 'not when it would bump the low end');
});
