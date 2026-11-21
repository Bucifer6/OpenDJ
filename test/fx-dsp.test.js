// DSP checks for the deck worklet (de-click, brake, backspin, loop roll) and the effect worklets (limiter, LFO,
// crusher, reverb), run under Node with a minimal AudioWorklet global scope. Browser renders of the whole effect
// graphs live in scripts/e2e-fx.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eqKnobGain } from '../public/js/audio/engine.js';

const processors = {};
globalThis.sampleRate = 48000;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: () => {}, onmessage: null }; } };
globalThis.registerProcessor = (name, cls) => { processors[name] = cls; };
await import('../public/js/audio/worklets.js');
await import('../public/js/audio/fx-worklets.js');

const SR = 48000;
function deck(src) {
  const p = new processors['deck-processor'](); const sent = []; p.port.postMessage = (m) => sent.push(m);
  p.onMessage({ type: 'load', left: src, right: src, sampleRate: SR, scale: 1 });
  return { p, sent, msg: (m) => p.onMessage(m) };
}
function run(p, frames) {
  const L = new Float32Array(frames);
  for (let o = 0; o < frames; o += 128) {
    const l = new Float32Array(128), r = new Float32Array(128);
    p.process([], [[l, r], [new Float32Array(128), new Float32Array(128)]]);
    L.set(l.subarray(0, Math.min(128, frames - o)), o);
    globalThis.currentTime += 128 / SR;
  }
  return L;
}
const sine = (n, f = 220, a = 0.5) => Float32Array.from({ length: n }, (_, i) => a * Math.sin(2 * Math.PI * f * i / SR));
const maxStep = (x, a = 1, b = x.length) => { let m = 0; for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1])); return m; };
const CLEAN = 2 * Math.PI * 220 * 0.5 / SR * 1.05; // largest step of the clean 220 Hz test sine (+5 %)

test('deck: play, pause and hot-cue jumps cross-fade instead of clicking', () => {
  const { p, msg } = deck(sine(SR * 4));
  msg({ type: 'rate', value: 1 }); msg({ type: 'play', value: true });
  const a = run(p, 9000);
  msg({ type: 'seek', frame: 12345.6 }); // jump to an unrelated phase
  const b = run(p, 9000);
  msg({ type: 'play', value: false }); // instant stop (CDJ mode)
  const c = run(p, 4000);
  assert.ok(maxStep(a) <= CLEAN, `start ${maxStep(a)}`);
  assert.ok(maxStep(b) <= CLEAN * 1.3, `jump ${maxStep(b)}`);
  assert.ok(maxStep(c) <= CLEAN, `stop ${maxStep(c)}`);
  assert.equal(c.slice(400).every((v) => v === 0), true, 'silent after the 4 ms fade');
});

test('deck: loop roll wraps without a step even when the loop is not a whole number of cycles', () => {
  const { p, msg } = deck(sine(SR * 4));
  msg({ type: 'rate', value: 1 }); msg({ type: 'seek', frame: 10000 }); msg({ type: 'play', value: true });
  msg({ type: 'loop', value: { start: 10000, end: 10000 + 0.0937 * SR } });
  const out = run(p, SR);
  assert.ok(maxStep(out, 300) <= CLEAN * 1.3, `loop wrap ${maxStep(out, 300)}`);
  assert.ok(p.pos >= 10000 && p.pos <= 10000 + 0.0937 * SR + 1);
});

test('deck: brake stops in the requested time with a natural curve and no final click', () => {
  const { p, msg, sent } = deck(sine(SR * 6));
  msg({ type: 'rate', value: 1 }); msg({ type: 'play', value: true });
  run(p, 4800);
  msg({ type: 'brake', value: 1 / (1.2 * SR) });
  const speeds = []; let stoppedAt = -1;
  for (let k = 0; k < 200; k++) { run(p, 384); speeds.push(Math.abs(p.curRate)); if (stoppedAt < 0 && sent.some((m) => m.type === 'stopped')) stoppedAt = (k + 1) * 0.008; }
  assert.ok(Math.abs(stoppedAt - 1.2) < 0.02, `stopped after ${stoppedAt} s`);
  // friction + drag: speed falls faster at the start than at the end (a straight line would be at 0.75 after 0.3 s)
  const v03 = speeds[Math.round(0.3 / 0.008) - 1];
  assert.ok(v03 < 0.68 && v03 > 0.6, `speed after 0.3 s: ${v03}`);
  const { p: p2, msg: m2 } = deck(sine(SR * 6));
  m2({ type: 'rate', value: 1 }); m2({ type: 'play', value: true }); run(p2, 4800);
  m2({ type: 'brake', value: 1 / (1.2 * SR) });
  const out = run(p2, SR * 1.5);
  assert.ok(maxStep(out) <= CLEAN, `brake ${maxStep(out)}`);
});

test('deck: backspin throws the record back, spins down and stops', () => {
  const { p, msg, sent } = deck(sine(SR * 6));
  msg({ type: 'rate', value: 1 }); msg({ type: 'seek', frame: SR * 3 }); msg({ type: 'play', value: true });
  run(p, 4800);
  const p0 = p.pos;
  msg({ type: 'backspin', seconds: 1, speed: 4.5 });
  run(p, 0.06 * SR);
  assert.ok(Math.abs(p.curRate + 4.5) < 0.05, `full reverse speed after the flick (${p.curRate})`);
  run(p, 1.2 * SR);
  assert.ok(sent.some((m) => m.type === 'stopped'), 'deck reports the stop');
  assert.ok(p.pos < p0 - SR, `went backwards (${((p0 - p.pos) / SR).toFixed(2)} s)`);
  assert.equal(p.curRate, 0);
});

test('limiter: transparent below the ceiling, never above it, no clicks', () => {
  const lim = new processors['opendj-limiter']();
  const params = { ceiling: [-1], release: [0.08], enabled: [1] };
  const L = lim.L, n = SR * 2;
  // smooth level: 0.5 for 0.5 s, then swells up to 3 (+15.6 dB) with periodic louder bursts
  const env = (t) => (t < 0.5 ? 0.5 : 0.5 + 2.5 * Math.min(1, (t - 0.5) / 0.3)) * (1 + 0.5 * Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 4);
  const x = Float32Array.from({ length: n }, (_, i) => env(i / SR) * Math.sin(2 * Math.PI * 100 * i / SR));
  const out = new Float32Array(n);
  for (let o = 0; o < n; o += 128) {
    const a = x.subarray(o, o + 128), l = new Float32Array(128), r = new Float32Array(128);
    lim.process([[a, a]], [[l, r]], params); out.set(l, o);
  }
  const ceil = 10 ** (-1 / 20);
  let over = 0, diff = 0;
  for (let i = 0; i < n; i++) if (Math.abs(out[i]) > ceil + 1e-6) over++;
  for (let i = L; i < SR * 0.12; i++) diff = Math.max(diff, Math.abs(out[i] - x[i - L])); // first 0.12 s: 0.75 peak, below ceiling
  assert.equal(over, 0);
  assert.ok(diff < 1e-7, `bit-transparent below the ceiling (${diff})`);
  assert.ok(maxStep(out) < 2 * Math.PI * 100 * ceil / SR * 1.5, `gain changes are smooth (${maxStep(out)})`);
});

test('LFO: gate is locked to the beat clock and has smooth edges', () => {
  const lfo = new processors['opendj-lfo']();
  lfo.port.onmessage({ data: { beat: 0, at: 0, beatSec: 0.5 } });
  globalThis.currentTime = 0;
  const params = { beats: [0.5], shape: [2], duty: [0.5], spread: [0], offset: [0] };
  const n = SR, out = new Float32Array(n);
  for (let o = 0; o < n; o += 128) { const a = new Float32Array(128), b = new Float32Array(128); lfo.process([], [[a, b]], params); out.set(a, o); globalThis.currentTime += 128 / SR; }
  const rises = []; for (let i = 1; i < n; i++) if (out[i - 1] < 0.5 && out[i] >= 0.5) rises.push(i / SR);
  for (const t of rises) assert.ok(Math.abs(((t + 0.125) % 0.25) - 0.125) < 0.003, `gate opens on the 1/8 grid (${t})`);
  assert.ok(rises.length >= 3);
  assert.ok(maxStep(out) < 0.02, `edges are ramps, not steps (${maxStep(out)})`);
});

test('crusher reduces bits and sample rate; reverb tail decays and goes idle', () => {
  const cr = new processors['opendj-crush']();
  const x = sine(128 * 40, 440, 0.8), out = new Float32Array(x.length);
  for (let k = 0; k < 40; k++) { const o = [new Float32Array(128), new Float32Array(128)]; cr.process([[x.subarray(k * 128, k * 128 + 128)]], [o], { bits: [3], rate: [2000] }); out.set(o[0], k * 128); }
  const levels = new Set(Array.from(out.slice(2000), (v) => v.toFixed(4)));
  assert.ok(levels.size <= 9, `3-bit output has few levels (${levels.size})`);
  const rv = new processors['opendj-reverb']();
  const params = { decay: [1], damping: [6000], predelay: [0.02], size: [1], early: [0.5] };
  const blocks = [];
  for (let k = 0; k < 1200; k++) {
    const inp = new Float32Array(128); if (k === 0) inp[0] = 1;
    const o = [new Float32Array(128), new Float32Array(128)];
    rv.process([[inp, inp]], [o], params);
    blocks.push(Math.max(...o[0].map(Math.abs)));
  }
  const at = (s) => Math.max(...blocks.slice(Math.round(s * SR / 128), Math.round(s * SR / 128) + 20));
  assert.ok(at(0.1) > 1e-3, 'reverb rings');
  assert.ok(at(1.0) < at(0.1) / 300, `-60 dB by RT60 (${at(0.1)} -> ${at(1.0)})`);
  assert.equal(blocks.at(-1), 0, 'idle after the tail');
});

test('EQ knob: unity at 12 o\'clock, +6 dB at max, full kill at min, monotonic', () => {
  assert.equal(eqKnobGain(0), 1);
  assert.ok(Math.abs(20 * Math.log10(eqKnobGain(1)) - 6) < 1e-9);
  assert.equal(eqKnobGain(-1), 0);
  let prev = -1; for (let v = -1; v <= 1.0001; v += 0.01) { const g = eqKnobGain(v); assert.ok(g >= prev); prev = g; }
});
