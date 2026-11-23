// Pro-DJ automix behaviour (docs/PRO_DJ_AUTOMIX_RESEARCH.md): invariants of the mixing curves and the party-safety
// helpers. Pure functions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mixLevels, twoBasslines, SWAP_STYLES } from '../public/js/automix.js';

test('P1.2: no blend style ever plays two basslines at once', () => {
  for (const style of ['blend', 'bassswap', 'filter', 'crossfade', 'echo']) {
    for (const kSwap of [null, 0.3, 0.5, 0.7]) {
      for (let k = 0; k <= 1.0001; k += 0.01) {
        const sw = kSwap != null && k >= kSwap ? kSwap : null;
        const L = mixLevels(style, k, SWAP_STYLES.has(style) || style === 'blend' ? sw : kSwap);
        assert.ok(!twoBasslines(L), `${style} k=${k.toFixed(2)} kSwap=${kSwap}: ${JSON.stringify(L)}`);
      }
    }
  }
});

test('P1.4: blend follows the club recipe (incoming highs/mids eased in, outgoing highs make room, mids leave after the swap)', () => {
  const at = (k, s = null) => mixLevels('blend', k, s);
  assert.equal(at(0).inVol, 0); assert.ok(Math.abs(at(0.25).inVol - 0.8) < 1e-9, 'fader up after a quarter');
  assert.ok(at(0).inHigh < -0.2 && at(0.25).inHigh === 0, 'incoming highs from -6 dB to flat');
  assert.ok(at(0.2).outHigh === 0 && at(0.5).outHigh < -0.2, 'outgoing highs make room from the second quarter');
  const post = at(0.75, 0.5);
  assert.equal(post.outLow, -1); assert.equal(post.inLow, 0);
  assert.ok(post.outMid < -0.2 && post.inMid > -0.01, 'mids traded after the swap');
  assert.ok(at(0.7, 0.5).outVol > 0.7, 'outgoing fader holds for the first half after the swap');
  assert.ok(at(1, 0.5).outVol < 1e-9);
});

test('P0.1: watchdog reports silence, stalls and stops only after their limits, and not for quiet music', async () => {
  const { Watchdog, quietAt, SILENCE_PEAK } = await import('../public/js/automix-watchdog.js');
  const w = new Watchdog({ silentFor: 2.5, stallFor: 2, stoppedFor: 1.5 });
  let pos = 10, r = null;
  // healthy: loud and moving
  for (let t = 0; t < 5; t += 0.1) { pos += 0.1; r = w.update({ t, level: 0.5, position: pos, playing: true }); assert.equal(r, null); }
  // silent output while the deck moves (decoder died, fader stuck at 0...)
  for (let t = 5; t < 7.4; t += 0.1) { pos += 0.1; r = w.update({ t, level: SILENCE_PEAK / 10, position: pos, playing: true }); assert.equal(r, null, `too early at ${t}`); }
  for (let t = 7.4; t < 7.8 && !r; t += 0.1) { pos += 0.1; r = w.update({ t, level: 0, position: pos, playing: true }); }
  assert.equal(r?.kind, 'silent');
  // the music itself is quiet here: no alarm
  w.reset();
  for (let t = 0; t < 10; t += 0.1) { pos += 0.1; assert.equal(w.update({ t, level: 0, position: pos, playing: true, expectSilence: true }), null); }
  // stall: playing but the position doesn't move
  w.reset(); r = null;
  for (let t = 0; t < 3 && !r; t += 0.1) r = w.update({ t, level: 0.4, position: 42, playing: true });
  assert.equal(r?.kind, 'stalled');
  // stopped deck
  w.reset(); r = null;
  for (let t = 0; t < 3 && !r; t += 0.1) r = w.update({ t, level: 0, position: 42, playing: false });
  assert.equal(r?.kind, 'stopped'); assert.ok(r.for >= 1.5);
  // cooldown after a rescue
  w.cooldown(3, 4);
  for (let t = 3; t < 6.9; t += 0.1) assert.equal(w.update({ t, level: 0, position: 42, playing: false }), null);
  // inactive automix never alarms
  w.reset();
  for (let t = 0; t < 9; t += 0.5) assert.equal(w.update({ t, level: 0, position: 1, playing: false, active: false }), null);
  // quietAt from a waveform: silent gap at 2-4 s
  const peak = new Uint8Array(150 * 6).fill(200); peak.fill(1, 300, 600);
  assert.equal(quietAt({ peak, rate: 150 }, 2.1, 1.5), true);
  assert.equal(quietAt({ peak, rate: 150 }, 1, 2), false);
  assert.equal(quietAt({ peak, rate: 150 }, 7, 2), true, 'past the end');
  assert.equal(quietAt(null, 1), false);
});

test('P1.6: tempo morph target rides the master to the incoming track\'s own tempo (half/double aware, 4 % max)', async () => {
  const { morphTarget } = await import('../public/js/automix.js');
  // 124 -> 126: master goes +1.61 %
  assert.ok(Math.abs(morphTarget({ bpm: 124, tempo: 0 }, { bpm: 126 }) - (126 / 124 - 1) * 100) < 1e-9);
  // master already stretched to 126: nothing to do
  assert.equal(morphTarget({ bpm: 124, tempo: (126 / 124 - 1) * 100 }, { bpm: 126 }), null);
  // half time: 87 vs 174 -> nothing; 86 vs 174 (≈ 87) -> morph to 87
  assert.equal(morphTarget({ bpm: 174, tempo: 0 }, { bpm: 87 }), null);
  assert.ok(Math.abs(morphTarget({ bpm: 172, tempo: 0 }, { bpm: 87 }) - (174 / 172 - 1) * 100) < 1e-9);
  // 6 % is too far to morph
  assert.equal(morphTarget({ bpm: 120, tempo: 0 }, { bpm: 127.2 }), null);
  assert.equal(morphTarget({ bpm: 0 }, { bpm: 120 }), null);
});
