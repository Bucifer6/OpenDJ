import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAdaptiveTransition } from '../public/js/adaptive-dj.js';
import { AutoMix, DROP_STYLES } from '../public/js/automix.js';
import { liveNext, smartMix } from '../public/js/smartmix.js';
import { analysisPatch } from '../public/js/audio/analysis-core.js';
import { LibraryCore } from '../public/js/shared/library-core.js';

function track(id, extra = {}) {
  return { id, bpm: 120, bpmConfidence: 0.9, key: '8A', energy: 6, genre: 'House', duration: 256,
    downbeat: 0, gridOffset: 0, mixIn: 0, mixOut: 224,
    phrases: Array.from({ length: 8 }, (_, i) => ({ start: i * 32, end: (i + 1) * 32, type: i === 0 ? 'intro' : i === 7 ? 'outro' : 'breakdown', energy: 0.6 })), ...extra };
}

test('section search selects interior outgoing and incoming windows to avoid two voices', () => {
  const out = track('a', { vocalMap: Array.from({ length: 256 }, (_, i) => i >= 96 && i < 160 ? 0.4 : 1) });
  const inn = track('b', { vocalMap: Array.from({ length: 256 }, (_, i) => i >= 64 && i < 128 ? 0 : 1) });
  const p = planAdaptiveTransition(out, inn, { position: 70, styles: ['blend'] });
  assert.ok(p);
  assert.ok(p.timing.begin > 70 && p.timing.begin < 224, JSON.stringify(p));
  assert.ok(p.inStart >= 64 && p.inStart < 128, JSON.stringify(p));
  assert.ok(p.timing.begin < out.mixOut);
  assert.equal(p.timing.begin % 2, 0, 'outgoing bar line');
  assert.equal(p.inStart % 2, 0, 'incoming bar line');
  assert.equal((p.timing.start + p.timing.len) % 32, 0, 'handover lands on a section boundary');
  assert.ok(p.timing.start + p.timing.len <= out.duration);
  assert.ok(p.inStart + p.timing.len <= inn.duration);
  assert.ok(p.evaluated <= 64);
});

test('uncertain grids, disabled sync, and large tempo gaps never produce long beatmatched overlaps', () => {
  for (const [out, inn, opts] of [
    [track('a', { bpmConfidence: 0.1 }), track('b'), {}],
    [track('a'), track('b'), { keepSync: false }],
    [track('a'), track('b', { bpm: 96 }), {}],
    [track('a'), track('b', { bpm: 480 }), {}],
    [track('a'), track('b'), { rate: 1.2 }],
    [track('a', { bpm: 0 }), track('b'), {}],
  ]) {
    const p = planAdaptiveTransition(out, inn, opts);
    assert.ok(p && DROP_STYLES.has(p.style), JSON.stringify(p));
  }
});

test('bad durations, exhausted tracks and late starts degrade safely; candidates are bounded', () => {
  for (const duration of [0, -1, NaN, Infinity, undefined]) assert.equal(planAdaptiveTransition(track('a', { duration }), track('b')), null);
  assert.equal(planAdaptiveTransition(track('a'), track('b'), { position: 255 }), null);
  assert.equal(planAdaptiveTransition(track('a'), track('b'), { entry: 250 }), null);
  const p = planAdaptiveTransition(track('a', { phrases: [{ start: NaN, end: Infinity }, ...track('a').phrases] }), track('b'));
  assert.ok(p && p.evaluated <= 64);
});

test('live selection reranks at most six candidates by playable transition quality and excludes history', () => {
  const a = track('a'), b = track('b'), c = track('c');
  let calls = 0;
  const r = liveNext(a, [a, b, c, ...Array.from({ length: 30 }, (_, i) => track(`x${i}`))], {
    history: [b], shape: 'flat', transitionScore: (t) => { calls++; return { score: t.id === 'c' ? 10 : -10, reason: 'clear instrumental section' }; },
  });
  assert.equal(r.track.id, 'c'); assert.equal(calls, 6);
  assert.match(r.reason, /clear instrumental section/);
});

test('set lookahead respects the requested opening energy even when later harmonic matches favor a louder opener', () => {
  const pool = [track('low', { energy: 2, key: '3B' }), ...Array.from({ length: 6 }, (_, i) => track(`high${i}`, { energy: 8 }))];
  assert.equal(smartMix(pool, { shape: 'warmup' }).tracks[0].id, 'low');
  assert.equal(smartMix(pool, { shape: 'flat', start: pool[1] }).tracks.length, pool.length);
});

function session() {
  const a = track('a'), b = track('b');
  const deck = (index, t) => ({ index, track: t, bpm: t.bpm, beatLen: 0.5, gridOffset: 0, duration: 256,
    position: index ? 0 : 70, playing: index === 0, rate: 1, tempo: 0,
    setTempo(v) { this.tempo = v; }, setMaster() {}, matchTempo() {}, setKeyLock() {},
    seek(v) { this.position = v; }, play() { this.playing = true; }, pause() { this.playing = false; } });
  const engine = { on() {}, ctx: { currentTime: 100 }, decks: [deck(0, a), deck(1, b)],
    channels: [0, 1].map(() => ({ state: {}, set(k, v) { this.state[k] = v; } })) };
  const app = { engine, settings: { automix: { style: 'auto', lengthMode: 'auto', keepSync: true, transitionBeats: 32 } } };
  const am = new AutoMix(app);
  Object.assign(am, { enabled: true, current: engine.decks[0], queue: [a, b], idx: 1 });
  return { am, engine, a, b, app };
}

test('playback consumes the cached adaptive timing and cue, including a late tick', () => {
  const { am, engine, a, b } = session();
  a.vocalMap = Array.from({ length: 256 }, (_, i) => i >= 96 && i < 160 ? 0 : 1);
  b.vocalMap = Array.from({ length: 256 }, (_, i) => i >= 64 && i < 128 ? 0 : 1);
  am.nextTransition();
  const u = am.upcoming, p = u.adaptive;
  assert.ok(p && !DROP_STYLES.has(u.style));
  engine.decks[0].position = u.plan.begin + 0.1;
  am.beginTransition();
  assert.equal(am.transition.style, p.style);
  assert.ok(Math.abs(engine.decks[1].position - p.inStart - 0.1) < 1e-6);
  assert.equal(am.transition.t0, 100000);
  const t0 = am.transition.t0;
  am.stepTransition();
  assert.equal(am.transition.t0, t0, 'suspended audio clock does not advance the fade');
});

test('cached planning is stable as playhead advances; grid edits, seeks, stems and overrides invalidate it', () => {
  const { am, engine, app } = session();
  am.nextTransition(); const first = am.upcoming;
  engine.decks[0].position += 0.1; am.nextTransition(); assert.equal(am.upcoming, first);
  engine.decks[0].gridOffset = 0.1; am.nextTransition(); assert.notEqual(am.upcoming, first);
  const edited = am.upcoming;
  engine.decks[0].position = 10; am.nextTransition(); assert.notEqual(am.upcoming, edited);
  const sought = am.upcoming;
  engine.decks[1].stemsReady = true; am.nextTransition(); assert.notEqual(am.upcoming, sought);
  app.settings.automix.keepSync = false; am.nextTransition(); assert.ok(DROP_STYLES.has(am.upcoming.style));
  am.setOverride(1, 'cut'); am.nextTransition(); assert.equal(am.upcoming.style, 'cut'); assert.equal(am.upcoming.adaptive, undefined);
});

test('beat confidence survives analysis, API edits and rescans; locked grids are trusted', () => {
  const lib = new LibraryCore(); lib.upsertTrack(track('a'));
  const patch = analysisPatch({}, { bpm: 120, bpmConfidence: 0.12 });
  lib.updateTrack('a', patch); assert.equal(lib.getTrack('a').bpmConfidence, 0.12);
  lib.upsertTrack(track('a', { bpmConfidence: 1 })); assert.equal(lib.getTrack('a').bpmConfidence, 0.12);
  lib.updateTrack('a', { bpmConfidence: 3 }); assert.equal(lib.getTrack('a').bpmConfidence, 1);
  assert.equal(analysisPatch({ bpm: 120, gridLocked: true }, { bpm: 121, bpmConfidence: 0.1 }).bpmConfidence, 1);
});
