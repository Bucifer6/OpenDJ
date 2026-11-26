import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dynamicMixLevels, twoBasslines, AutoMix } from '../public/js/automix.js';
import { stemMakeupGain, isVocalSolo } from '../public/js/stems/stem-fx.js';
import { checkRenderedAudio, checkTransition } from '../public/js/transition-check.js';
import { Emitter } from '../public/js/util.js';

test('dynamicMixLevels: HPF kick-punch preview and mid carving keep one-bassline invariant', () => {
  const out = { barFeatures: [{ start: 0, end: 20, sub: 0.7, punch: 0.6, mid: 0.75, high: 0.5, centroid: 0.4, chroma: new Array(12).fill(1 / 12) }] };
  const inn = { barFeatures: [{ start: 0, end: 20, sub: 0.6, punch: 0.5, mid: 0.72, high: 0.1, centroid: 0.4, chroma: new Array(12).fill(1 / 12) }] };
  const pre = dynamicMixLevels('blend', 0.35, null, { out, inn, outPos: 4, inPos: 4 });
  assert.ok(!twoBasslines(pre), 'never two basslines');
  assert.ok(pre.inFilter > 0.15, `expected HPF kick-punch preview, got inFilter=${pre.inFilter}`);
  assert.ok(pre.outMid < -0.05, `expected dynamic mid carve on dense overlap, got outMid=${pre.outMid}`);
  assert.ok(pre.inHigh > -0.15, `sparse incoming highs open early, got inHigh=${pre.inHigh}`);
  const post = dynamicMixLevels('blend', 0.7, 0.5, { out, inn, outPos: 8, inPos: 8 });
  assert.ok(!twoBasslines(post));
  assert.ok(Math.abs(post.inFilter) < 1e-6, 'HPF cleared after swap');
});

test('stemMakeupGain and isVocalSolo protect stem transitions from volume drops and rumble', () => {
  assert.equal(stemMakeupGain([1, 1, 1, 1]), 1);
  assert.ok(stemMakeupGain([1, 0, 0, 0]) > 1.2, 'acapella receives gentle makeup boost');
  assert.ok(stemMakeupGain([0, 1, 0, 0]) > 1.2, 'drums-only receives gentle makeup boost');
  assert.equal(isVocalSolo([0.9, 0, 0, 0]), true);
  assert.equal(isVocalSolo([0.9, 0.8, 0.8, 0.8]), false);
});

test('per-lane manual takeover releases only the touched knob during an active transition', () => {
  const engine = new Emitter();
  engine.ctx = { currentTime: 10 };
  const makeCh = (idx) => ({
    index: idx,
    state: { volume: 0.8, eqLow: 0, eqMid: 0, eqHigh: 0, filter: 0, vocal: 1, xfAssign: 'THRU', fxOn: false },
    set(k, v) { this.state[k] = v; },
    setAutoGain() {},
    cancelAutomation() {},
  });
  const makeDeck = (idx, track) => ({
    index: idx, track, bpm: 124, effectiveBpm: 124, beatLen: 60 / 124, duration: 240, position: 100, rate: 1, playing: idx === 0,
    loading: false, syncOn: false, tempo: 0, setKeyLock() {}, setMaster() {}, matchTempo() {}, seek(p) { this.position = p; },
    play() { this.playing = true; }, pause() { this.playing = false; }, positionAt() { return this.position; }, post() {},
  });
  const t1 = { id: 'a', title: 'A', bpm: 124, duration: 240, gridOffset: 0, key: '8A' };
  const t2 = { id: 'b', title: 'B', bpm: 124, duration: 240, gridOffset: 0, key: '8A' };
  engine.channels = [makeCh(0), makeCh(1)];
  engine.decks = [makeDeck(0, t1), makeDeck(1, t2)];
  const app = { engine, library: { track: (id) => (id === 'a' ? t1 : t2) }, settings: { automix: { style: 'blend', lengthMode: 'fixed', transitionBeats: 16, keepSync: true } }, toast() {} };
  const am = new AutoMix(app);
  am.enabled = true; am.current = engine.decks[0]; am.queue = [t1, t2]; am.idx = 1;
  am.beginTransition(true);
  // DJ manually grabs outgoing filter and sets it to 0.75
  engine.channels[0].set('filter', 0.75);
  engine.emit('user-control', 0, 'filter', 0.75);
  engine.ctx.currentTime = 11;
  am.stepTransition();
  assert.equal(engine.channels[0].state.filter, 0.75, 'manual filter lane stayed under DJ control');
  assert.ok(engine.channels[1].state.volume > 0, 'untouched incoming volume lane continued automating');
});

test('Mix Point Link arms and triggers a one-shot handoff when Automix is off', () => {
  const engine = new Emitter();
  engine.ctx = { currentTime: 0 };
  const makeCh = (idx) => ({ index: idx, state: { volume: 0.8, eqLow: 0, eqMid: 0, eqHigh: 0, filter: 0, vocal: 1, fxOn: false }, set(k, v) { this.state[k] = v; }, setAutoGain() {}, cancelAutomation() {} });
  const makeDeck = (idx, track) => ({
    index: idx, track, bpm: 125, effectiveBpm: 125, beatLen: 60 / 125, duration: 200, position: 100, rate: 1, playing: idx === 0,
    loading: false, syncOn: false, tempo: 0, setKeyLock() {}, setMaster() {}, matchTempo() {}, seek(p) { this.position = p; },
    play() { this.playing = true; }, pause() { this.playing = false; }, positionAt() { return this.position; }, post() {},
  });
  const t1 = { id: 'a', title: 'A', bpm: 125, duration: 200, gridOffset: 0, key: '8A', mixOut: 150 };
  const t2 = { id: 'b', title: 'B', bpm: 125, duration: 200, gridOffset: 0, key: '8A', mixIn: 8 };
  engine.channels = [makeCh(0), makeCh(1)];
  engine.decks = [makeDeck(0, t1), makeDeck(1, t2)];
  const app = { engine, library: { track: (id) => (id === 'a' ? t1 : t2) }, settings: { automix: { style: 'blend', lengthMode: 'fixed', transitionBeats: 16, keepSync: true } }, toast() {} };
  const am = new AutoMix(app);
  assert.equal(am.enabled, false);
  const link = am.linkMixPoints(0, 1);
  assert.equal(link.outCue, 150);
  assert.equal(link.inCue, 8);
  am.tick();
  assert.equal(am.transition, null, 'does not fire before outCue');
  engine.decks[0].position = 150.1;
  am.tick();
  assert.ok(am.transition, 'Mix Point Link triggered transition at outCue');
  assert.equal(am._oneShot, true, 'marked one-shot so control returns to DJ afterwards');
});

test('checkRenderedAudio detects clean transitions vs dead air and loudness bumps', () => {
  const sr = 22050;
  const clean = new Float32Array(sr * 12);
  for (let i = 0; i < clean.length; i++) clean[i] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / sr);
  const rClean = checkRenderedAudio({ left: clean, right: clean, sampleRate: sr }, { preSec: 3, spanSec: 6 });
  assert.equal(rClean.ok, true, JSON.stringify(rClean));
  assert.equal(rClean.metrics.deadAirMs, 0);

  // Inject a 600 ms dead-air dropout
  const gapped = new Float32Array(clean);
  gapped.fill(0, sr * 5, Math.floor(sr * 5.6));
  const rGap = checkRenderedAudio({ left: gapped, right: gapped, sampleRate: sr }, { preSec: 3, spanSec: 6 });
  assert.equal(rGap.ok, false);
  assert.ok(rGap.metrics.deadAirMs >= 500);

  // checkTransition reports local chroma clash when barFeatures clash
  const cA = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const cB = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const out = { bpm: 124, gain: 0, mainLufs: -14, barFeatures: [{ start: 0, end: 20, sub: 0.5, punch: 0.4, mid: 0.6, high: 0.3, chroma: cA }] };
  const inn = { bpm: 124, gain: 0, mainLufs: -14, barFeatures: [{ start: 0, end: 20, sub: 0.5, punch: 0.4, mid: 0.6, high: 0.3, chroma: cB }] };
  const chk = checkTransition(out, inn, { style: 'blend', begin: 0, len: 10, inStart: 0 });
  assert.equal(chk.metrics.chromaSim, 0);
  assert.ok(chk.issues.some((x) => /harmonic clash/.test(x)));
});
