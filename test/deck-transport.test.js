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

test('a position report from the end of a worklet block reads exactly at any audio time, also before it arrived', () => {
  // the report says: frame F was reached at audio time 10.008 s (end of the block); the main thread's clock still
  // reads 10 s. Two decks reporting at different block ends must still agree on where they are now.
  const deck = (time, frame) => {
    const d = Object.assign(Object.create(Deck.prototype), { sr: 48000, ctx: { currentTime: 10 }, track: {}, duration: 300, _seekGuard: 0, _seekSeq: 0, playing: true, emit() {} });
    d.onWorklet({ type: 'pos', frame, shadow: frame, time, rate: 1, playing: true });
    return d;
  };
  const at = 10, posAt10 = 50; // both decks are at 50 s at audio time 10 s
  const a = deck(at + 0.008, (posAt10 + 0.008) * 48000), b = deck(at + 128 * 3 / 48000, (posAt10 + 128 * 3 / 48000) * 48000);
  assert.ok(Math.abs(a.positionAt(at) - posAt10) < 1e-9, `deck a: ${a.positionAt(at)}`);
  assert.ok(Math.abs(b.positionAt(at) - posAt10) < 1e-9, `deck b: ${b.positionAt(at)}`);
  assert.ok(Math.abs(a.positionAt(at) - b.positionAt(at)) < 1e-9, 'the two agree: no phantom phase offset of whole blocks');
});
