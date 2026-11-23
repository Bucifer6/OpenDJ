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

test('P1.4: blend follows the club recipe (incoming mids eased in, highs held back until the swap, outgoing highs make room, mids leave after it)', () => {
  const at = (k, s = null) => mixLevels('blend', k, s);
  assert.equal(at(0).inVol, 0); assert.ok(Math.abs(at(0.25).inVol - 0.8) < 1e-9, 'fader up after a quarter');
  assert.ok(at(0).inHigh < -0.2 && at(0.45).inHigh < -0.2 && Math.abs(at(0.8, 0.5).inHigh) < 1e-12, 'incoming highs -6 dB until the swap, then flat (real-mixes.md §2.4)');
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

test('P0.3: a cut that lands on a much louder section is pre-trimmed', async () => {
  const { landingTrim, sectionLevel } = await import('../public/js/automix.js');
  const out = { gain: -2, phrases: [{ start: 0, end: 60, lufs: -12 }] };   // heard at -14
  const loud = { gain: -1, phrases: [{ start: 0, end: 30, lufs: -9 }] };   // heard at -10: +4 LU
  assert.equal(sectionLevel(out, 10), -14);
  assert.equal(landingTrim(out, 10, loud, 1), -3);
  assert.equal(landingTrim(out, 10, { gain: 0, phrases: [{ start: 0, end: 9, lufs: -13 }] }, 1), null, '+1 LU is fine');
  assert.equal(landingTrim(out, 10, { phrases: [] }, 1), null, 'unknown');
});

test('P4.1: transition checker measures level continuity, basslines, vocals and stretch', async () => {
  const { checkTransition } = await import('../public/js/transition-check.js');
  const bpm = 125, bar = 240 / bpm;
  const tr = (lufs, gain, vocal) => ({ bpm, gain, phrases: [{ start: 0, end: 400, lufs }], vocalMap: new Float32Array(400).fill(vocal) });
  const plan = { style: 'blend', begin: 100, len: 32 * bar, inStart: 0, ratio: 1 };
  const same = checkTransition(tr(-10, -4, 0), tr(-12, -2, 0), plan);
  assert.equal(same.ok, true, JSON.stringify(same));
  assert.equal(same.metrics.lowOverlapBeats, 0);
  assert.ok(same.metrics.bumpLu <= 2, `bump ${same.metrics.bumpLu}`);
  // crossfade with vocals on both sides: flagged
  const voc = checkTransition(tr(-14, 0, 1), tr(-14, 0, 1), { ...plan, style: 'crossfade' });
  assert.ok(voc.issues.some((x) => /vocals/.test(x)), JSON.stringify(voc));
  assert.ok(voc.penalty > 0);
  // 8 % stretch
  const st = checkTransition({ ...tr(-14, 0, 0), bpm: 135 }, tr(-14, 0, 0), plan);
  assert.ok(st.metrics.stretchPct > 7 && st.issues.some((x) => /stretched/.test(x)));
  // nothing to check
  assert.equal(checkTransition(null, null, {}).ok, true);
});

test('P5: trick planner picks musical slots, respects mode, arc, vocals, grid and spacing', async () => {
  const { planTricks, trickSlots, rollSize } = await import('../public/js/automix-tricks.js');
  const bpm = 125, bar = 240 / bpm;
  const sec = (type, a, b) => ({ type, start: a * bar, end: b * bar });
  const house = { genre: 'House', bpm, energy: 7, bpmConfidence: 0.9,
    phrases: [sec('intro', 0, 16), sec('verse', 16, 48), sec('buildup', 48, 56), sec('drop', 56, 96), sec('breakdown', 96, 112), sec('drop', 112, 144), sec('outro', 144, 160)] };
  const slots = trickSlots(house, 0, 160 * bar);
  assert.ok(slots.some((s) => s.slot === 'preDrop' && Math.abs(s.at - 56 * bar) < 1e-6));
  const base = { from: 20 * bar, to: 140 * bar, phase: 'peak', nowMs: 0, positionToMs: (s) => s * 1000 };
  assert.deepEqual(planTricks(house, { ...base, mode: 'off' }), []);
  const subtle = planTricks(house, { ...base, mode: 'subtle' });
  assert.equal(subtle.length, 1, JSON.stringify(subtle));
  assert.ok(['bassTease', 'filterBuild'].includes(subtle[0].id));
  assert.ok(Math.abs(subtle[0].at - 56 * bar) < 1e-6 || Math.abs(subtle[0].at - 112 * bar) < 1e-6, 'resolves on a drop downbeat');
  const party = planTricks(house, { ...base, mode: 'party', familiar: true });
  assert.ok(party.length >= 1 && party.length <= 2);
  for (let i = 1; i < party.length; i++) assert.ok(party[i].at - party[i - 1].at >= 32 * bar);
  // subtle mode: nothing in the warm-up; nothing on a shaky grid; nothing over vocals
  assert.deepEqual(planTricks(house, { ...base, mode: 'subtle', phase: 'warmup' }), []);
  assert.deepEqual(planTricks({ ...house, bpmConfidence: 0.3 }, { ...base, mode: 'party' }), []);
  const vocal = { ...house, vocalMap: new Float32Array(400).fill(1) };
  assert.ok(planTricks(vocal, { ...base, mode: 'subtle' }).every((e) => e.id === 'echoFreeze'));
  // spacing: a trick 2 minutes ago blocks subtle mode
  assert.deepEqual(planTricks(house, { ...base, mode: 'subtle', history: [{ id: 'filterBuild', atMs: 0 }] }), []);
  // lounge never
  assert.deepEqual(planTricks({ ...house, genre: 'Lounge' }, { ...base, mode: 'party' }), []);
  // rewind only at the peak, on familiar bass / open tracks
  const dnb = { ...house, genre: 'Drum & Bass', bpm: 174, energy: 8 };
  const r = planTricks(dnb, { from: 0, to: 1e9, mode: 'party', phase: 'peak', familiar: true, nowMs: 0, positionToMs: (s) => s * 1000 });
  assert.ok(r.every((e) => e.id !== 'rewind' || e.restart != null));
  assert.equal(rollSize(0, 8), 1); assert.equal(rollSize(5, 8), 0.5); assert.equal(rollSize(7, 8), 0.125);
});

test('P1.1: phrase grids line up even when the incoming track has a pickup intro', async () => {
  const { gridMisalign } = await import('../public/js/adaptive-dj.js');
  const bpm = 120, bar = 2;
  const out = { bpm, downbeat: 0, gridOffset: 0, phraseAnchor: 0 };
  const inn = { bpm, downbeat: 0, gridOffset: 0, phraseAnchor: 7 * bar }; // 7-bar pickup before its first phrase
  assert.equal(gridMisalign(out, 64 * bar, inn, 0), 1, 'starting both on bar 0 leaves the grids a bar apart');
  assert.equal(gridMisalign(out, 65 * bar, inn, 0), 0, 'starting the incoming a bar later lines them up');
  assert.equal(gridMisalign(out, 64 * bar, { ...inn, phraseAnchor: 0 }, 0), 0);
});

test('P3.4: end time, wind-down and clean-only filter', async () => {
  const { AutoMix } = await import('../public/js/automix.js');
  const app = { engine: { on() {}, decks: [{ index: 0 }, { index: 1 }], channels: [] }, settings: { automix: { endAt: '02:00', cleanOnly: true } }, toast() {} };
  const am = new AutoMix(app);
  am.startedAt = new Date(2026, 10, 21, 22, 0, 0).getTime();
  const end = am.endAtMs();
  assert.equal(new Date(end).getDate(), 22, 'next day'); assert.equal(new Date(end).getHours(), 2);
  assert.equal(am.windingDown(new Date(2026, 10, 22, 0, 30).getTime()), false);
  assert.equal(am.windingDown(new Date(2026, 10, 22, 1, 57).getTime()), true);
  assert.ok(Math.abs(am.partyCtx().setMinutes - 240) < 1e-6);
  assert.equal(am.allowed({ id: 1, title: 'Song (Explicit)' }), false);
  assert.equal(am.allowed({ id: 2, title: 'Song (Clean)' }), true);
  app.settings.automix = { endAt: 'nonsense' };
  assert.equal(am.endAtMs(), null); assert.equal(am.windingDown(), false);
});

test('P1.6: set tempo journey: selection leans toward the planned tempo', async () => {
  const { scoreTransition } = await import('../public/js/smartmix.js');
  const cur = { id: 'c', bpm: 122, key: '8A', energy: 6, genre: 'House' };
  const up = { id: 'u', bpm: 123.5, key: '8A', energy: 6, genre: 'House' }, down = { id: 'd', bpm: 120.5, key: '8A', energy: 6, genre: 'House' };
  const s = (c, targetBpm) => scoreTransition(cur, c, { targetBpm }).score;
  assert.ok(s(up, 125) > s(down, 125), 'rising toward 125');
  assert.ok(s(down, 119) > s(up, 119), 'falling toward 119');
  assert.equal(scoreTransition(cur, up, {}).parts.tempoArc, 0);
});

test('P2.2 / P0.4: loop-extend for a short ending, and beat safety per region', async () => {
  const { planAdaptiveTransition } = await import('../public/js/adaptive-dj.js');
  const bpm = 124, bar = 240 / bpm;
  const sec = (type, a, b, extra = {}) => ({ type, start: a * bar, end: b * bar, energy: 0.7, pulse: 0.9, gridErr: 4, ...extra });
  // radio edit: no outro, the music ends right after its last chorus
  const out = { id: 'a', bpm, key: '8A', energy: 7, duration: 66 * bar, endTime: 66 * bar, downbeat: 0, gridOffset: 0, bpmConfidence: 0.9,
    phrases: [sec('intro', 0, 8), sec('verse', 8, 40), sec('chorus', 40, 64)], vocalMap: Array.from({ length: Math.ceil(66 * bar) }, (_, i) => (i < 56 * bar ? 1 : 0)) };
  const inn = { id: 'b', bpm, key: '8A', energy: 7, duration: 96 * bar, downbeat: 0, gridOffset: 0, bpmConfidence: 0.9, mixIn: 0,
    phrases: [sec('intro', 0, 16), sec('drop', 16, 64), sec('outro', 64, 96)] };
  const p = planAdaptiveTransition(out, inn, { position: 52 * bar, entry: 0, minPlay: 0, fixedBars: 16, styles: ['blend', 'bassswap', 'filter', 'crossfade'] });
  assert.ok(p?.loopOut, `loop-extended (${p?.why})`);
  assert.ok(Math.abs(p.loopOut.end - p.loopOut.start - 8 * bar) < 1e-6 && p.loopOut.end <= 66 * bar);
  assert.ok(p.timing.begin < p.loopOut.end, 'the loop is engaged before the music runs out');
  // a drifting live-drummed outro: no long beat-matched overlap
  const drift = { ...out, id: 'c', duration: 128 * bar, endTime: 128 * bar, vocalMap: undefined,
    phrases: [sec('intro', 0, 16), sec('verse', 16, 96), sec('outro', 96, 128, { gridErr: 40, pulse: 0.5 })] };
  const q = planAdaptiveTransition(drift, inn, { position: 60 * bar, entry: 0, minPlay: 0 });
  assert.ok(!q || ['echo', 'cut', 'reverb', 'backspin', 'brake', 'loop'].includes(q.style) || q.timing.begin < 96 * bar, `no overlap on the drifting outro (${q?.style} ${q?.timing?.begin / bar})`);
  const steady = planAdaptiveTransition({ ...drift, phrases: [sec('intro', 0, 16), sec('verse', 16, 96), sec('outro', 96, 128)] }, inn, { position: 60 * bar, entry: 0, minPlay: 0 });
  assert.equal(steady.beatSafety, 'long');
});

test('P2.5 / P5: stem recipes and ping-pong keep one bassline and one vocal', async () => {
  const { stemLevels, planBestTransition } = await import('../public/js/mix-planner.js');
  const { mixLevels, twoBasslines } = await import('../public/js/automix.js');
  for (const style of ['stemswap', 'drumbridge', 'vocalcarry', 'acapellain']) {
    for (let k = 0; k <= 1.0001; k += 0.01) {
      const L = stemLevels(style, k);
      assert.ok(!(L.inn[2] > 0.1 && L.out[2] > 0.1 && Math.min(L.inn[2], L.out[2]) > 0.5), `${style} k=${k.toFixed(2)}: two basslines`);
      assert.ok(!(L.inn[0] > 0.3 && L.out[0] > 0.3), `${style} k=${k.toFixed(2)}: two vocals`);
    }
    assert.deepEqual(stemLevels(style, 1).inn, [1, 1, 1, 1]);
  }
  // drum bridge: a moment of drums only
  const mid = stemLevels('drumbridge', 0.66);
  assert.ok(mid.out[0] === 0 && mid.out[2] === 0 && mid.out[3] === 0 && mid.inn[0] === 0 && mid.inn[2] === 0, 'drums only');
  // acapella carry: outgoing vocal over the incoming instrumental
  const vc = stemLevels('vocalcarry', 0.7);
  assert.ok(vc.out[0] === 1 && vc.out[1] < 0.01 && vc.inn[1] === 1 && vc.inn[0] === 0);
  for (let k = 0; k <= 1; k += 0.01) assert.ok(!twoBasslines(mixLevels('pingpong', k)));
  // the planner picks a drum bridge for a key clash when both decks have stems
  const bpm = 124, bar = 240 / bpm;
  const t = (key) => ({ bpm, key, energy: 6, genre: 'House', duration: 112 * bar, endTime: 112 * bar, mixIn: 0, mixOut: 96 * bar, downbeat: 0, gridOffset: 0,
    phrases: [{ start: 0, end: 16 * bar, type: 'intro' }, { start: 16 * bar, end: 96 * bar, type: 'drop' }, { start: 96 * bar, end: 112 * bar, type: 'outro' }] });
  const p = planBestTransition(t('8A'), t('3B'), { stemsOut: true, stemsIn: true });
  assert.ok(['drumbridge', 'stemswap', 'filter'].includes(p.style), `${p.style}: ${p.why}`);
  assert.ok(p.options.some((o) => o.style === 'drumbridge'));
});

test('P5: scratch fill only with a scratch sound loaded; light cues follow tricks', async () => {
  const { planTricks } = await import('../public/js/automix-tricks.js');
  const bpm = 96, bar = 240 / bpm;
  const sec = (type, a, b) => ({ type, start: a * bar, end: b * bar });
  const hip = { genre: 'Hip-Hop', bpm, energy: 7, bpmConfidence: 0.9, phrases: [sec('intro', 0, 8), sec('verse', 8, 24), sec('chorus', 24, 32), sec('verse', 32, 48), sec('chorus', 48, 56)] };
  const ctx = { from: 4 * bar, to: 60 * bar, mode: 'party', phase: 'peak', familiar: true, nowMs: 0, positionToMs: (s) => s * 1000 };
  const without = planTricks(hip, ctx).map((e) => e.id), withS = planTricks(hip, { ...ctx, hasScratch: true }).map((e) => e.id);
  assert.ok(!without.includes('scratchFill'));
  assert.ok(withS.length >= 1);
  const { AutoMix } = await import('../public/js/automix.js');
  const calls = [];
  const app = { engine: { on() {}, decks: [], channels: [], ctx: { currentTime: 0 } }, settings: { automix: {} }, lighting: { enabled: true, setLive: async (p) => { calls.push(p); } } };
  const am = new AutoMix(app);
  am.lightCue('blackout', 0, 0.2);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(calls, [{ blackout: true }, { blackout: false }]);
});
