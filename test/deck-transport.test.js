import test from 'node:test';
import assert from 'node:assert/strict';
import { Deck } from '../public/js/audio/deck.js';

test('a queued position report with the same timestamp cannot undo a newer seek', () => {
  const d = Object.assign(Object.create(Deck.prototype), { sr: 48000, ctx: { currentTime: 10 }, _pos: 6.6, _seekGuard: 10, _seekSeq: 4, playing: false, emit() {} });
  const report = { type: 'pos', frame: 5 * 48000, shadow: 5 * 48000, time: 10, rate: 0, playing: false, seekSeq: 3 };
  d.onWorklet(report); assert.equal(d._pos, 6.6);
  d.onWorklet({ ...report, frame: 6.6 * 48000, seekSeq: 4 }); assert.equal(d._pos, 6.6);
  d.onWorklet({ ...report, frame: 8 * 48000, seekSeq: 4 }); assert.equal(d._pos, 8);
});
