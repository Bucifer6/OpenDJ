import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOUDNESS_TARGET, kWeightingCoefs, loudnessProfile, integratedLoudness, momentaryLoudness, shortTermLoudness,
  sectionLoudness, loudestWindow, gatedLoudness,
} from '../public/js/audio/loudness.js';
import { integratedLoudness as samplerLoudness } from '../public/js/audio/sampler.js';

const sine = (sr, secs, f = 997, amp = 1) => Float32Array.from({ length: Math.round(sr * secs) }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / sr));
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

test('K-weighting coefficients at 48 kHz match the BS.1770-4 tables', () => {
  const [pre, rlb] = kWeightingCoefs(48000);
  near(pre.b[0], 1.53512485958697, 1e-6); near(pre.b[1], -2.69169618940638, 1e-6); near(pre.b[2], 1.19839281085285, 1e-6);
  near(pre.a[0], -1.69065929318241, 1e-6); near(pre.a[1], 0.73248077421585, 1e-6);
  near(rlb.a[0], -1.99004745483398, 1e-6); near(rlb.a[1], 0.99007225036621, 1e-6);
  assert.deepEqual(rlb.b, [1, -2, 1]);
});

for (const sr of [44100, 48000]) {
  test(`997 Hz full-scale sine at ${sr} Hz: -3.01 LUFS in one channel, 0 LUFS on two / dual mono`, () => {
    const x = sine(sr, 5);
    near(integratedLoudness([x], sr), -3.01, 0.5, 'mono in one channel');
    near(integratedLoudness([x], sr), -3.01, 0.05, 'precise');
    near(integratedLoudness([x, x], sr), 0, 0.05, 'stereo pair');
    near(integratedLoudness(x, sr), 0, 0.05, 'bare mono mix = dual mono');
    const quiet = sine(sr, 5, 997, 10 ** (-20 / 20));
    near(integratedLoudness([quiet], sr), -23.01, 0.05, '-20 dBFS sine');
  });
}

test('the sampler keeps its integratedLoudness export (same numbers)', () => {
  const x = sine(48000, 2, 1000, 0.5);
  assert.equal(samplerLoudness([x, x], 48000), integratedLoudness([x, x], 48000));
  // shorter than one 400 ms block: measured as a single block, not -Infinity
  near(samplerLoudness([sine(48000, 0.2)], 48000), -3.01, 0.2);
});

test('gating ignores silence and very quiet passages', () => {
  const sr = 44100, loud = sine(sr, 10), x = new Float32Array(sr * 40);
  x.set(loud, sr * 15); // 10 s of tone in 40 s of silence
  near(integratedLoudness([x], sr), -3.01, 0.25); // blocks straddling the edges are partly silent
  // a -40 dB passage is removed by the relative gate (-10 LU)
  const y = new Float32Array(sr * 20); y.set(loud); y.set(sine(sr, 10, 997, 0.01), sr * 10);
  near(integratedLoudness([y], sr), -3.01, 0.25);
  assert.equal(integratedLoudness([new Float32Array(sr * 3)], sr), -Infinity);
  assert.equal(gatedLoudness([]), -Infinity);
});

test('momentary / short-term curves and section loudness', () => {
  const sr = 44100;
  const x = new Float32Array(sr * 20);
  x.set(sine(sr, 10, 997, 10 ** (-20 / 20)));
  x.set(sine(sr, 10, 997, 10 ** (-6 / 20)), sr * 10);
  const prof = loudnessProfile([x], sr);
  const m = momentaryLoudness(prof), st = shortTermLoudness(prof);
  assert.equal(m.length, 200 - 3); assert.equal(st.length, 200 - 29);
  near(m[10], -23.01, 0.1); near(m[150], -9.01, 0.1);
  near(st[20], -23.01, 0.1); near(st[150], -9.01, 0.1);
  const [a, b, all, none] = sectionLoudness(prof, sr, [{ start: 0, end: 10 }, { start: 10, end: 20 }, { start: 0, end: 20 }, { start: 30, end: 40 }]);
  near(a, -23.01, 0.1); near(b, -9.01, 0.1);
  near(all, -9.01, 0.2, 'relative gate drops the quiet half');
  assert.equal(none, null);
  // same result from raw channels as from a profile
  assert.deepEqual(sectionLoudness([x], sr, [{ start: 2, end: 8 }]), sectionLoudness(prof, sr, [{ start: 2, end: 8 }]));
  const w = loudestWindow(prof, sr, 5);
  assert.ok(w.start >= 10 && w.end <= 20.001, JSON.stringify(w)); near(w.lufs, -9.01, 0.1);
  assert.equal(LOUDNESS_TARGET, -14);
});

test('loudness of a 7-minute track is fast (single pass)', () => {
  const sr = 44100, n = sr * 420, x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.05) * 0.3 + ((i * 7919) % 101) / 500;
  const t0 = performance.now();
  const prof = loudnessProfile(x, sr);
  integratedLoudness(prof); shortTermLoudness(prof); loudestWindow(prof, sr, 30);
  sectionLoudness(prof, sr, Array.from({ length: 30 }, (_, i) => ({ start: i * 14, end: i * 14 + 14 })));
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
});
