// Turntable model checks for the deck worklet (motor start / stop, release spin-up, inertia, reverse ramps, jog weight,
// position-following scratch, tempo glide, active loops, slip brake, scratch samples) and the pure deck helpers in
// audio/vinyl.js (rpm scale, quantize divisions, needle drop, strobe, tonearm). Same minimal AudioWorklet scope as
// test/fx-dsp.test.js; every transport change is also checked for clicks (largest sample step vs the clean sine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { secPerRev, snapTo, nextQuantizeDiv, QUANTIZE_DIVS, glideDuration, needleTarget, bendAt, strobeAngle, tonearmAngle, tonearmProgress, TONEARM, vinylFor, jumpSizeStep, VINYL_DEFAULTS } from '../public/js/audio/vinyl.js';

const processors = {};
globalThis.sampleRate = 48000;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor ??= class { constructor() { this.port = { postMessage: () => {}, onmessage: null }; } };
globalThis.registerProcessor = (name, cls) => { processors[name] = cls; };
const W = await import('../public/js/audio/worklets.js');

const SR = 48000;
function deck(src) {
  globalThis.currentTime = 0;
  const p = new processors['deck-processor'](); const sent = []; p.port.postMessage = (m) => sent.push(m);
  p.onMessage({ type: 'load', left: src, right: src, sampleRate: SR, scale: 1 });
  return { p, sent, msg: (m) => p.onMessage(m) };
}
/** Render `frames` frames; onBlock(p, t) runs before each 128-frame block (t = its audio time). */
function run(p, frames, onBlock) {
  const L = new Float32Array(frames);
  for (let o = 0; o < frames; o += 128) {
    onBlock?.(p, globalThis.currentTime);
    const l = new Float32Array(128), r = new Float32Array(128);
    p.process([], [[l, r], [new Float32Array(128), new Float32Array(128)]]);
    L.set(l.subarray(0, Math.min(128, frames - o)), o);
    globalThis.currentTime += 128 / SR;
  }
  return L;
}
const sine = (n, f = 220, a = 0.5) => Float32Array.from({ length: n }, (_, i) => a * Math.sin(2 * Math.PI * f * i / SR));
const maxStep = (x, a = 1, b = x.length) => { let m = 0; for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1])); return m; };
// largest step of the clean 220 Hz test sine at up to `speed` x (+5 %): faster playback has bigger steps
const CLEAN = (speed = 1) => 2 * Math.PI * 220 * speed * 0.5 / SR * 1.05;
/** Sample the platter speed every block: returns [{ t, v }] relative to the first block. */
function speeds(p, secs, onBlock) {
  const out = []; const t0 = globalThis.currentTime;
  run(p, Math.round(secs * SR), (pp, t) => { onBlock?.(pp, t); out.push({ t: t - t0, v: pp.curRate }); });
  return out;
}
const firstAt = (arr, pred) => arr.find(pred)?.t;

test('worklet acknowledges the latest seek in its position reports', () => {
  const { p, msg, sent } = deck(sine(SR * 10));
  msg({ type: 'seek', frame: SR * 2, seq: 3 }); run(p, 512);
  const old = sent.filter((m) => m.type === 'pos').at(-1);
  assert.equal(old.seekSeq, 3);
  msg({ type: 'seek', frame: SR * 5, seq: 4 }); run(p, 512);
  assert.equal(sent.filter((m) => m.type === 'pos').at(-1).seekSeq, 4);
  assert.equal(old.seekSeq, 3, 'already queued messages retain their older acknowledgement');
});

test('vinyl helpers: rpm scale, defaults, clamping', () => {
  assert.equal(secPerRev(33), 1.8);
  assert.ok(Math.abs(secPerRev(45) - 1.3333) < 1e-3 && Math.abs(secPerRev(78) - 0.7692) < 1e-3);
  const v = vinylFor({ vinyl: { start: 0.7, rpm: 45 }, vinylDecks: [null, { start: 99, rpm: 12 }] }, 1);
  assert.equal(v.start, 3, 'clamped to the range'); assert.equal(v.rpm, 33, 'unknown rpm falls back to 33');
  assert.equal(vinylFor({ vinyl: { start: 0.7, rpm: 45 } }, 0).rpm, 45);
  assert.deepEqual(vinylFor({}, 0), { ...VINYL_DEFAULTS });
});

test('motor: start time 0.7 s reaches 1x at 0.70 s (±10 ms), monotonic and click-free', () => {
  const { p, msg } = deck(sine(SR * 4));
  msg({ type: 'rate', value: 1 }); msg({ type: 'motor', value: { start: 0.7 } });
  msg({ type: 'play', value: true });
  const sp = speeds(p, 1);
  const t99 = firstAt(sp, (s) => s.v >= 0.99);
  assert.ok(Math.abs(t99 - 0.7) <= 0.01, `99 % at ${t99}`);
  assert.ok(sp.every((s, i) => i === 0 || s.v >= sp[i - 1].v - 1e-12), 'monotonic');
  assert.equal(sp.at(-1).v, 1);
  const { p: p2, msg: m2 } = deck(sine(SR * 4));
  m2({ type: 'rate', value: 1 }); m2({ type: 'keylock', value: true }); m2({ type: 'motor', value: { start: 0.7 } }); m2({ type: 'play', value: true });
  const out = run(p2, SR);
  assert.ok(maxStep(out) <= CLEAN(), `start ramp step ${maxStep(out)}`);
});

test('motor: stop time 1.2 s brakes a paused deck to 0 at 1.2 s (±10 ms) without a click; play during the brake spins back up', () => {
  const { p, msg } = deck(sine(SR * 6));
  msg({ type: 'rate', value: 1 }); msg({ type: 'motor', value: { stop: 1.2 } }); msg({ type: 'play', value: true });
  run(p, 4800);
  msg({ type: 'play', value: false });
  const sp = speeds(p, 1.5);
  const t0 = firstAt(sp, (s) => s.v === 0);
  assert.ok(Math.abs(t0 - 1.2) <= 0.01, `stopped at ${t0}`);
  const { p: p2, msg: m2 } = deck(sine(SR * 6));
  m2({ type: 'rate', value: 1 }); m2({ type: 'keylock', value: true }); m2({ type: 'motor', value: { stop: 1.2, start: 0.5 } }); m2({ type: 'play', value: true });
  run(p2, SR * 0.6);
  m2({ type: 'play', value: false });
  const out = run(p2, SR * 0.5);
  m2({ type: 'play', value: true });
  const out2 = run(p2, SR);
  assert.ok(maxStep(out) <= CLEAN(), `pause brake step ${maxStep(out)}`);
  assert.ok(maxStep(out2) <= CLEAN(), `re-start step ${maxStep(out2)}`);
  assert.equal(p2.curRate, 1);
});

test('motor: release from a held record spins up to 99 % in the start time (±10 ms), click-free; slip-mat shortens it', () => {
  for (const [slipmat, T] of [[0, 0.3], [1, 0.3 * 0.4]]) {
    const { p, msg } = deck(sine(SR * 6));
    msg({ type: 'rate', value: 1 }); msg({ type: 'keylock', value: true }); msg({ type: 'motor', value: { start: 0.3, slipmat } }); msg({ type: 'play', value: true });
    run(p, SR * 0.5);
    msg({ type: 'scratch', value: { velocity: 0 } }); // hand holds the record
    run(p, SR * 0.2);
    msg({ type: 'scratch', value: null });
    const t1 = globalThis.currentTime;
    const sp = []; const out = run(p, SR * 0.6, (pp, t) => sp.push({ t: t - t1, v: pp.curRate }));
    const t99 = firstAt(sp, (s) => s.v >= 0.99);
    if (slipmat === 0) assert.ok(Math.abs(sp[0].v) < 0.01, `held at release (${sp[0].v})`);
    assert.ok(Math.abs(t99 - T * (1 - Math.min(1, sp[0].v))) <= 0.012, `slipmat ${slipmat}: 99 % at ${t99}`);
    assert.ok(maxStep(out) <= CLEAN(), `release spin-up step ${maxStep(out)}`);
  }
});

test('motor: start time 0 keeps the original instant transport (release snaps to speed)', () => {
  const { p, msg } = deck(sine(SR * 4));
  msg({ type: 'rate', value: 1.05 }); msg({ type: 'play', value: true });
  run(p, 256);
  assert.equal(p.curRate, 1.05);
  msg({ type: 'scratch', value: { velocity: -1 } }); run(p, 2048); msg({ type: 'scratch', value: null }); run(p, 128);
  assert.equal(p.curRate, 1.05);
  msg({ type: 'play', value: false }); run(p, 128);
  assert.equal(p.curRate, 0);
});

test('inertia: a stopped deck released at 2x coasts and stops within the configured time (±5 %)', () => {
  const { p, msg } = deck(sine(SR * 8));
  msg({ type: 'seek', frame: SR }); msg({ type: 'motor', value: { inertia: 1.5 } });
  msg({ type: 'scratch', value: { velocity: 2 } }); run(p, SR * 0.1);
  assert.ok(Math.abs(p.curRate - 2) < 0.01);
  msg({ type: 'scratch', value: null });
  const sp = speeds(p, 2);
  const t0 = firstAt(sp, (s) => s.v === 0);
  assert.ok(Math.abs(t0 - 1.5) <= 0.075, `coasted for ${t0}`);
  assert.ok(sp.every((s, i) => i === 0 || s.v <= sp[i - 1].v + 1e-12), 'slows down monotonically');
});

test('reverse with motor ramps passes through 0 without a click', () => {
  const { p, msg } = deck(sine(SR * 8));
  msg({ type: 'rate', value: 1 }); msg({ type: 'seek', frame: SR * 4 }); msg({ type: 'motor', value: { start: 0.4, stop: 0.4 } }); msg({ type: 'play', value: true });
  run(p, SR * 0.6);
  msg({ type: 'reverse', value: true });
  const sp = []; const out = run(p, SR * 1.2, (pp) => sp.push(pp.curRate));
  assert.ok(sp.some((v) => v === 0) || sp.some((v, i) => i && Math.sign(v) !== Math.sign(sp[i - 1])), 'crosses zero');
  assert.equal(sp.at(-1), -1);
  assert.ok(maxStep(out) <= CLEAN(), `reverse step ${maxStep(out)}`);
});

test('jog weight: heavy vs light step response (10-90 %) differs by 5x or more; default keeps the original 0.02', () => {
  assert.equal(W.handCoef(0.5), 0.02);
  const rise = (w) => {
    const { p, msg } = deck(sine(SR * 4));
    msg({ type: 'jogWeight', value: w }); msg({ type: 'seek', frame: SR });
    msg({ type: 'scratch', value: { velocity: 1 } });
    let n = 0, a = -1, b = -1;
    while (b < 0 && n < SR) { run(p, 1); n++; if (a < 0 && p.curRate >= 0.1) a = n; if (p.curRate >= 0.9) b = n; }
    return b - a;
  };
  const light = rise(0), heavy = rise(1);
  assert.ok(heavy / light >= 5, `light ${light} vs heavy ${heavy} samples`);
});

/** Synthetic baby scratch through the position API: 2 Hz, ±90° (±0.45 s at 33⅓), events at `hz` with timing jitter. */
function babyScratch({ hz = 60, jitter = 0.004, weight = 0.5, seed = 7 } = {}) {
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const { p, msg } = deck(new Float32Array(SR * 20));
  msg({ type: 'seek', frame: SR * 5 }); msg({ type: 'jogWeight', value: weight });
  const hand = (t) => 0.45 * Math.sin(2 * Math.PI * 2 * t) * SR;
  const ev = []; for (let i = 1; i < 3 * hz; i++) { const t = i / hz + (rnd() * 2 - 1) * jitter; ev.push({ t, at: t + rnd() * 0.008, pos: hand(t) }); }
  for (let i = 1; i < ev.length; i++) ev[i].at = Math.max(ev[i].at, ev[i - 1].at); // delivered in order
  msg({ type: 'scratch', value: { pos: true } }); msg({ type: 'scratchPos', pos: 0, t: 0 });
  let k = 0; const got = [], rates = [];
  run(p, 3 * SR, (pp, now) => {
    while (k < ev.length && ev[k].at <= now) { pp.onMessage({ type: 'scratchPos', pos: ev[k].pos, t: ev[k].t }); k++; }
    if (now > 0.5) { got.push([now, pp.pos - SR * 5]); rates.push(pp.curRate); }
  });
  let best = Infinity, lat = 0; // error after removing the best constant latency
  for (let L = 0; L <= 0.05; L += 0.0005) { let e2 = 0; for (const [t, x] of got) { const e = (x - hand(t - L)) / SR; e2 += e * e; } e2 = Math.sqrt(e2 / got.length); if (e2 < best) { best = e2; lat = L; } }
  let flips = 0, last = 0; for (const r of rates) { const sg = Math.abs(r) > 0.02 ? Math.sign(r) : 0; if (sg && last && sg !== last) flips++; if (sg) last = sg; }
  return { rms: best * 1000, latency: lat * 1000, flips };
}

test('position scratch: 60 Hz touch with ±4 ms jitter keeps playhead error < 8 ms RMS at every jog weight', () => {
  for (const w of [0, 0.5, 1]) {
    const r = babyScratch({ weight: w });
    assert.ok(r.rms < 8, `weight ${w}: ${r.rms.toFixed(2)} ms RMS (latency ${r.latency} ms)`);
    if (w >= 0.5) assert.ok(r.flips <= 10, `weight ${w}: ${r.flips} direction changes (input has 10)`);
  }
});

test('position scratch: 240 Hz coalesced events give < 5 ms RMS and no extra direction flips', () => {
  for (const w of [0, 0.5, 1]) {
    const r = babyScratch({ hz: 240, jitter: 0.001, weight: w });
    assert.ok(r.rms < 5, `weight ${w}: ${r.rms.toFixed(2)} ms RMS`);
    assert.ok(r.flips <= 10, `weight ${w}: ${r.flips} flips`);
    assert.ok(r.latency < 20, `latency ${r.latency} ms`);
  }
});

test('position scratch: one full touch turn at 45 rpm moves 1.333 s (±1 %); a held record stays put; loop wraps under the hand', () => {
  const { p, msg } = deck(new Float32Array(SR * 20));
  msg({ type: 'seek', frame: SR * 5 });
  msg({ type: 'scratch', value: { pos: true } }); msg({ type: 'scratchPos', pos: 0, t: 0 });
  const spr = secPerRev(45);
  for (let i = 1; i <= 60; i++) msg({ type: 'scratchPos', pos: (i / 60) * spr * SR, t: i / 120 });
  run(p, SR * 0.7);
  const moved = (p.pos - SR * 5) / SR;
  assert.ok(Math.abs(moved - spr) / spr < 0.01, `moved ${moved} s`);
  const held = p.pos; run(p, SR * 0.3);
  assert.ok(Math.abs(p.pos - held) < 1 && Math.abs(p.curRate) < 0.01, 'hand still: record still');
  // playing deck with the hand down in a loop: forward motion wraps and the hand keeps its place
  const { p: q, msg: m2 } = deck(new Float32Array(SR * 20));
  m2({ type: 'seek', frame: SR * 2 }); m2({ type: 'loop', value: { start: SR * 2, end: SR * 2.5 } });
  m2({ type: 'scratch', value: { pos: true } }); m2({ type: 'scratchPos', pos: 0, t: 0 });
  for (let i = 1; i <= 120; i++) m2({ type: 'scratchPos', pos: (i / 120) * SR, t: i / 120 }); // 1 s forward at 1x
  run(q, SR * 1.2);
  assert.ok(q.pos >= SR * 2 && q.pos <= SR * 2.5, 'stays in the loop');
  assert.ok(Math.abs(q.curRate) < 0.05, `no run-away after the wrap (${q.curRate})`);
});

test('tempo glide (rateRamp): 16 beats end at the target ±0.01 % at beat 16 ±5 ms, monotonic, key lock click-free', () => {
  const { p, msg, sent } = deck(sine(SR * 30));
  msg({ type: 'rate', value: 1 }); msg({ type: 'keylock', value: true }); msg({ type: 'play', value: true });
  run(p, 4800);
  const beat = 0.5, r1 = 1.06, dur = glideDuration(16, beat, 1, r1);
  const startPos = p.pos, t0 = globalThis.currentTime;
  msg({ type: 'rateRamp', to: r1, dur, id: 3 });
  const rates = []; const out = run(p, Math.ceil((dur + 0.2) * SR), (pp) => rates.push(pp.rate));
  const done = sent.find((m) => m.type === 'rampDone');
  assert.equal(done?.id, 3); assert.equal(p.rate, r1);
  assert.ok(Math.abs(p.rate - r1) / r1 < 1e-4);
  assert.ok(rates.every((r, i) => i === 0 || r >= rates[i - 1] - 1e-12), 'monotonic');
  // track time covered by the ramp = 16 beats: find when the play head passed 16 beats (8 s of track)
  const covered = (p.pos - startPos) / SR - (globalThis.currentTime - t0 - dur) * r1;
  assert.ok(Math.abs(covered - 16 * beat) <= 0.005 * r1, `16 beats took ${covered} s of track time during the ramp`);
  assert.ok(maxStep(out) <= CLEAN(1.06) * 1.3, `glide step ${maxStep(out)}`);
  msg({ type: 'rateRamp', to: 1, dur: 2 }); run(p, SR * 0.2); msg({ type: 'rate', value: 1.02 }); run(p, 256);
  assert.equal(p.rate, 1.02, 'a rate message cancels the ramp');
});

test('active loop: engages when the play head reaches its start (sample accurate), not when jumped past', () => {
  const { p, msg, sent } = deck(sine(SR * 10));
  msg({ type: 'rate', value: 1 }); msg({ type: 'play', value: true });
  msg({ type: 'armLoop', value: { start: SR * 0.5 + 37, end: SR * 0.75 } });
  run(p, SR * 1.5);
  const e = sent.find((m) => m.type === 'loopEngaged');
  assert.ok(e && e.start === SR * 0.5 + 37, 'engaged');
  assert.ok(p.pos >= SR * 0.5 && p.pos < SR * 0.75, `looping (${p.pos / SR})`);
  const { p: q, msg: m2, sent: s2 } = deck(sine(SR * 10));
  m2({ type: 'rate', value: 1 }); m2({ type: 'play', value: true });
  m2({ type: 'armLoop', value: { start: SR * 0.5, end: SR * 0.75 } });
  m2({ type: 'seek', frame: SR * 2 }); // jumped past it
  run(q, SR);
  assert.ok(!s2.some((m) => m.type === 'loopEngaged') && q.pos > SR * 2.5);
});

test('quantize divisions snap to the selected grid; jump sizes step through ½..64', () => {
  const b = 0.5, off = 0.1;
  assert.equal(snapTo(1.37, off, b, 1), 1.6); assert.equal(snapTo(1.3, off, b, 1), 1.1);
  assert.ok(Math.abs(snapTo(1.37, off, b, 1 / 8) - (off + Math.round((1.37 - off) / (b / 8)) * b / 8)) < 1e-12);
  assert.equal(snapTo(2.0, off, b, 4), 2.1);
  assert.deepEqual(QUANTIZE_DIVS.map(nextQuantizeDiv), [1 / 4, 1 / 2, 1, 4, 1 / 8]);
  assert.equal(jumpSizeStep(0.5, -1), 0.5); assert.equal(jumpSizeStep(32, 1), 64); assert.equal(jumpSizeStep(64, 1), 64); assert.equal(jumpSizeStep(4, -1), 2);
});

test('needle drop: snapped drops land on the grid (±1 ms) and keep the beat phase while playing', () => {
  const o = { duration: 200, bpm: 120, gridOffset: 0.237 };
  const t = needleTarget(0.4321, { ...o, snap: 'beat' });
  const k = (t - o.gridOffset) / 0.5; assert.ok(Math.abs(k - Math.round(k)) * 0.5 < 0.001, `on the beat grid (${t})`);
  const bar = needleTarget(0.4321, { ...o, snap: 'bar' }); const kb = (bar - o.gridOffset) / 2; assert.ok(Math.abs(kb - Math.round(kb)) * 2 < 0.001);
  const pos = 10.237 + 0.12; // 0.12 s past a beat
  const tp = needleTarget(0.4321, { ...o, snap: 'beat', playing: true, position: pos });
  const ph = (((tp - o.gridOffset) % 0.5) + 0.5) % 0.5; assert.ok(Math.abs(ph - 0.12) < 0.001, `phase kept (${ph})`);
  assert.equal(needleTarget(0.5, { duration: 100 }), 50, 'no snap: exact');
  assert.equal(needleTarget(2, { duration: 100 }), 100 * 1, 'clamped');
});

test('bend ramp and strobe / tonearm geometry', () => {
  assert.equal(bendAt(0), 0.01); assert.ok(Math.abs(bendAt(1) - 0.08) < 1e-12); assert.ok(Math.abs(bendAt(5) - 0.08) < 1e-12);
  const nominal = (100 / 3) / 60; // 33⅓ rpm in rev/s
  // 0 % pitch: the middle row stands still (< 0.5° in 1 s); +1 %: it moves
  assert.ok(Math.abs(strobeAngle(nominal, nominal, 0, 1) - strobeAngle(nominal, nominal, 0, 0)) * 180 / Math.PI < 0.5);
  assert.ok(Math.abs(strobeAngle(nominal * 1.01, nominal, 0, 1)) * 180 / Math.PI > 3, 'drifts one dot a second at +1 %');
  assert.ok(Math.abs(strobeAngle(nominal * 1.033, nominal, 0.033, 1)) * 180 / Math.PI < 0.5, '+3.3 % row stands still at +3.3 %');
  for (const k of [0, 0.25, 0.5, 0.75, 1]) assert.ok(Math.abs(tonearmProgress(tonearmAngle(k)) - k) < 1e-12);
  assert.ok(Math.abs((tonearmAngle(0.5) - TONEARM.outer) / (TONEARM.inner - TONEARM.outer) - 0.5) < 1e-12, 'linear');
});

test('slip brake resumes at the shadow position (±5 ms) and keeps playing', () => {
  const { p, msg, sent } = deck(sine(SR * 10));
  msg({ type: 'rate', value: 1 }); msg({ type: 'play', value: true }); run(p, SR * 0.5);
  msg({ type: 'slip', value: true });
  const t0 = globalThis.currentTime, p0 = p.pos;
  msg({ type: 'brake', value: 1 / (0.8 * SR), slip: true });
  const out = run(p, SR * 1.2);
  assert.ok(sent.some((m) => m.type === 'slipResumed') && !sent.some((m) => m.type === 'stopped'));
  const expect = p0 + (globalThis.currentTime - t0) * SR;
  assert.ok(Math.abs(p.pos - expect) / SR <= 0.005, `at ${(p.pos - expect) / SR} s from the shadow`);
  assert.equal(p.curRate, 1); assert.equal(p.playing, true);
  assert.ok(maxStep(out) <= CLEAN() * 1.3, `slip brake step ${maxStep(out)}`);
  const { p: q, msg: m2, sent: s2 } = deck(sine(SR * 10));
  m2({ type: 'rate', value: 1 }); m2({ type: 'seek', frame: SR * 3 }); m2({ type: 'play', value: true }); run(q, SR * 0.2); m2({ type: 'slip', value: true });
  m2({ type: 'backspin', seconds: 0.6, speed: 5 }); run(q, 0.06 * SR);
  assert.ok(Math.abs(q.curRate + 5) < 0.2, `backspin throw speed (${q.curRate})`);
});

test('scratch sample: swaps in and back to the track at the given frame, without clicks', () => {
  const { p, msg, sent } = deck(sine(SR * 10));
  msg({ type: 'rate', value: 1 }); msg({ type: 'play', value: true }); run(p, SR * 0.5);
  const sample = sine(SR * 2, 440, 0.4);
  msg({ type: 'altLoad', left: sample, sampleRate: SR, scale: 1 });
  const a = run(p, SR * 0.3);
  assert.equal(p.len, SR * 2, 'sample loaded'); assert.ok(p.alt && p.pos > 0.25 * SR && p.pos < 0.3 * SR);
  msg({ type: 'altReturn', frame: SR * 4.25 });
  const b = run(p, SR * 0.1);
  assert.equal(p.len, SR * 10); assert.equal(p.alt, null);
  assert.ok(Math.abs(p.pos - (SR * 4.25 + 0.1 * SR)) / SR < 0.006, `back at ${p.pos / SR}`);
  assert.ok(sent.some((m) => m.type === 'altReturned'));
  assert.ok(maxStep(a) <= CLEAN() * 2.1 && maxStep(b) <= CLEAN() * 2.1, `swap steps ${maxStep(a)} ${maxStep(b)}`);
});

test('scratch sample credits: every bundled sample file has an SPDX licence entry', () => {
  const credits = JSON.parse(fs.readFileSync(new URL('../public/samples/CREDITS.json', import.meta.url)));
  const files = fs.readdirSync(new URL('../public/samples/', import.meta.url), { recursive: true }).filter((f) => /\.(wav|mp3|ogg|flac|m4a|opus)$/i.test(f));
  for (const f of files) {
    const c = credits.files?.find((x) => x.file === f.replaceAll('\\', '/'));
    assert.ok(c, `${f} is credited`); assert.match(c.license, /^(CC0-1\.0|CC-BY-4\.0|CC-BY-SA-4\.0|MIT|LicenseRef-PublicDomain)$/);
  }
  assert.ok(credits.generated?.length >= 4, 'synthesised scratch sounds are listed');
});
