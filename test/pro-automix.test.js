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

test('P1.3: the planner lands the incoming main part on the outgoing phrase (drop on the break)', async () => {
  const { planAdaptiveTransition, offPhraseBars, landingAfter } = await import('../public/js/adaptive-dj.js');
  const bpm = 125, bar = 240 / bpm;
  const sec = (type, a, b, energy) => ({ type, start: a * bar, end: b * bar, energy });
  // outgoing: 96 bars, drop 32-64, outro 64-96; incoming: intro 0-16 (drums), drop from bar 16
  const out = { id: 'a', bpm, key: '8A', energy: 7, duration: 96 * bar, downbeat: 0, gridOffset: 0, bpmConfidence: 0.9,
    phrases: [sec('intro', 0, 16, 0.4), sec('verse', 16, 32, 0.6), sec('drop', 32, 64, 0.9), sec('outro', 64, 96, 0.5)] };
  const inn = { id: 'b', bpm, key: '8A', energy: 7, duration: 96 * bar, downbeat: 0, gridOffset: 0, bpmConfidence: 0.9, mixIn: 0,
    phrases: [sec('intro', 0, 16, 0.4), sec('drop', 16, 48, 0.9), sec('breakdown', 48, 64, 0.4), sec('outro', 64, 96, 0.5)] };
  assert.equal(landingAfter(inn, 0), 16 * bar);
  const p = planAdaptiveTransition(out, inn, { position: 40 * bar, entry: 0, minPlay: 0 });
  assert.ok(p, 'a plan');
  assert.ok(!['echo', 'cut', 'reverb', 'backspin', 'brake', 'loop'].includes(p.style), `blend expected, got ${p.style}`);
  assert.equal(offPhraseBars(out, p.timing.begin) < 0.01, true, `starts on an 8-bar line (${p.timing.begin / bar} bars)`);
  assert.equal(p.landed, true, p.why);
  assert.ok(Math.abs(p.landing - 16 * bar) < 1e-6);
});

test('P2.1: genre families steer technique (club blends, open-format cuts, effect budget)', async () => {
  const { styleFamily, pairFamily, effectShare, echoBeatsFor } = await import('../public/js/dj-styles.js');
  const { planBestTransition } = await import('../public/js/mix-planner.js');
  assert.equal(styleFamily({ genre: 'Tech House' }), 'house');
  assert.equal(styleFamily({ genre: 'Drum & Bass' }), 'bass');
  assert.equal(styleFamily({ genre: 'Hip-Hop' }), 'open');
  assert.equal(styleFamily({ genre: 'Melodic Techno' }), 'techno');
  assert.equal(styleFamily({ bpm: 174 }), 'bass'); assert.equal(styleFamily({}), null);
  assert.equal(pairFamily({ genre: 'House' }, { genre: 'Reggaeton' }), 'open');
  assert.equal(effectShare(['echo', 'blend', 'cut', 'reverb']), 0.5);
  assert.equal(echoBeatsFor({ genre: 'house' }, { genre: 'house' }), 0.75);
  const bpm = 96, bar = 240 / bpm;
  const t = (over) => ({ bpm, key: '8A', energy: 6, duration: 64 * bar, endTime: 64 * bar, mixIn: 0, downbeat: 0, gridOffset: 0,
    phrases: [{ type: 'intro', start: 0, end: 4 * bar }, { type: 'verse', start: 4 * bar, end: 56 * bar }, { type: 'outro', start: 56 * bar, end: 64 * bar }], ...over });
  const hip = planBestTransition(t({ genre: 'Hip-Hop' }), t({ genre: 'Hip-Hop', key: '9A' }));
  assert.ok(hip.bars <= 8 || ['cut', 'echo'].includes(hip.style), `open format: short (${hip.style} ${hip.bars})`);
  // past the effect budget, the effect is held back
  const echoScore = (r) => planBestTransition(t({ genre: 'Techno', bpm: 130 }), t({ genre: 'Techno', bpm: 145 }), { recent: r }).options.find((o) => o.style === 'echo').score;
  assert.ok(echoScore(['echo', 'reverb', 'echo']) < echoScore(['blend', 'blend', 'blend']) - 2, 'effects past the budget cost');
});

test('P2.3: drum & bass pairs at peak energy can double drop (drops aligned, bass swapped on the drop)', async () => {
  const { planAdaptiveTransition } = await import('../public/js/adaptive-dj.js');
  const bpm = 174, bar = 240 / bpm;
  const sec = (type, a, b, energy) => ({ type, start: a * bar, end: b * bar, energy });
  const dnb = (id, key) => ({ id, genre: 'Drum & Bass', bpm, key, energy: 8, duration: 160 * bar, downbeat: 0, gridOffset: 0, bpmConfidence: 0.9, mixIn: 0,
    phrases: [sec('intro', 0, 16, 0.4), sec('drop', 16, 64, 0.95), sec('breakdown', 64, 96, 0.5), sec('drop', 96, 144, 0.95), sec('outro', 144, 160, 0.4)] });
  const p = planAdaptiveTransition(dnb('a', '5A'), dnb('b', '5A'), { position: 70 * bar, entry: 0, minPlay: 0, doubleDrops: true });
  assert.ok(p, 'plan');
  if (p.doubleDrop) {
    assert.ok(Math.abs(p.swapIn - 16 * bar) < 1e-6, 'bass swap on the incoming drop');
    assert.match(p.why, /double drop/);
  } else assert.ok(p.landed || p.style, `some plan: ${p.why}`);
  // never twice in a row
  const q = planAdaptiveTransition(dnb('a', '5A'), dnb('b', '5A'), { position: 70 * bar, entry: 0, minPlay: 0, doubleDrops: true, recent: ['doubledrop'] });
  assert.ok(!q.doubleDrop);
  // the result must say whether a double drop was found for this textbook pair
  assert.equal(p.doubleDrop, true, p.why);
});
