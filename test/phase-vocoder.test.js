import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StereoPhaseVocoder, fft2048, PV_SIZE } from '../public/js/audio/phase-vocoder.js';

const SR = 48000;

function dominantFreq(sig, sr = SR) {
  // Zero-crossing / parabolic FFT peak on a 16384-sample slice past initial settling
  const off = Math.min(4096, Math.floor(sig.length / 4));
  const N = 8192;
  let bestF = 0, bestP = -1;
  for (let k = 10; k < 2000; k++) {
    let re = 0, im = 0;
    const w0 = (2 * Math.PI * k) / N;
    for (let i = 0; i < N && off + i < sig.length; i++) {
      const x = sig[off + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      re += x * Math.cos(w0 * i);
      im -= x * Math.sin(w0 * i);
    }
    const p = re * re + im * im;
    if (p > bestP) { bestP = p; bestF = (k * sr) / N; }
  }
  return bestF;
}

function measureFreqZC(sig, sr = SR) {
  const start = Math.floor(sig.length * 0.25), end = Math.floor(sig.length * 0.85);
  let first = -1, last = -1, crossings = 0;
  for (let i = start; i < end; i++) {
    if (sig[i - 1] <= 0 && sig[i] > 0) {
      const frac = -sig[i - 1] / (sig[i] - sig[i - 1]);
      const t = i - 1 + frac;
      if (first < 0) first = t;
      else crossings++;
      last = t;
    }
  }
  return crossings > 0 ? (crossings * sr) / (last - first) : 0;
}

test('fft2048 forward + inverse round-trip is exact within 1e-5', () => {
  const re = new Float32Array(PV_SIZE), im = new Float32Array(PV_SIZE);
  const orig = new Float32Array(PV_SIZE);
  for (let i = 0; i < PV_SIZE; i++) orig[i] = re[i] = Math.sin(i * 0.13) + 0.5 * Math.cos(i * 0.41);
  fft2048(re, im, false);
  fft2048(re, im, true);
  let maxErr = 0;
  for (let i = 0; i < PV_SIZE; i++) maxErr = Math.max(maxErr, Math.abs(re[i] - orig[i]));
  assert.ok(maxErr < 1e-5, `round-trip maxErr ${maxErr}`);
});

test('StereoPhaseVocoder preserves exact pitch under ±6% and ±12% tempo stretch', () => {
  const f0 = 440;
  const src = Float32Array.from({ length: SR * 3 }, (_, i) => 0.6 * Math.sin((2 * Math.PI * f0 * i) / SR));
  const read = (x, out) => {
    const i = Math.floor(x);
    const v = i >= 0 && i + 1 < src.length ? src[i] + (src[i + 1] - src[i]) * (x - i) : 0;
    out[0] = v; out[1] = v;
  };
  for (const tempo of [0.88, 0.94, 1.06, 1.12]) {
    const pv = new StereoPhaseVocoder();
    const out = new Float32Array(SR);
    const pair = new Float32Array(2);
    for (let n = 0; n < out.length; n++) {
      pv.nextSample(read, n * tempo, tempo, 1.0, 1.0, pair);
      out[n] = pair[0];
    }
    const f = measureFreqZC(out, SR);
    assert.ok(Math.abs(f - f0) / f0 < 0.002, `tempo=${tempo}: got ${f.toFixed(2)} Hz vs ${f0} Hz`);
  }
});

test('StereoPhaseVocoder shifts pitch accurately for Key Sync (±2, +4 semitones) and preserves stereo balance', () => {
  const f0 = 330;
  const srcL = Float32Array.from({ length: SR * 3 }, (_, i) => 0.7 * Math.sin((2 * Math.PI * f0 * i) / SR));
  const srcR = Float32Array.from({ length: SR * 3 }, (_, i) => 0.35 * Math.sin((2 * Math.PI * f0 * i) / SR + 0.8));
  const read = (x, out) => {
    const i = Math.floor(x), fr = x - i;
    if (i < 0 || i + 1 >= srcL.length) { out[0] = out[1] = 0; return; }
    out[0] = srcL[i] + (srcL[i + 1] - srcL[i]) * fr;
    out[1] = srcR[i] + (srcR[i + 1] - srcR[i]) * fr;
  };
  for (const semis of [-2, 2, 4]) {
    const pitch = Math.pow(2, semis / 12);
    const pv = new StereoPhaseVocoder();
    const oL = new Float32Array(SR), oR = new Float32Array(SR), pair = new Float32Array(2);
    for (let n = 0; n < SR; n++) {
      pv.nextSample(read, n, 1.0, pitch, pitch, pair);
      oL[n] = pair[0]; oR[n] = pair[1];
    }
    const f = measureFreqZC(oL, SR);
    const expected = f0 * pitch;
    assert.ok(Math.abs(f - expected) / expected < 0.005, `semis=${semis}: got ${f.toFixed(1)} vs ${expected.toFixed(1)}`);
    // Stereo amplitude ratio (~2:1) preserved
    let eL = 0, eR = 0;
    for (let i = SR >> 2; i < (SR * 3) >> 2; i++) { eL += oL[i] * oL[i]; eR += oR[i] * oR[i]; }
    const ratio = Math.sqrt(eL / Math.max(1e-9, eR));
    assert.ok(Math.abs(ratio - 2.0) < 0.25, `stereo ratio ${ratio.toFixed(2)} (expected ~2.0)`);
  }
});

test('StereoPhaseVocoder maintains zero-latency kick transient alignment under +5% tempo stretch', () => {
  const src = new Float32Array(SR * 3);
  // Sharp kick impulse at t = 1.000 s (frame 48000)
  const kickAt = SR;
  for (let i = 0; i < 600; i++) src[kickAt + i] = Math.sin((2 * Math.PI * 80 * i) / SR) * Math.exp(-i / 120);
  const read = (x, out) => {
    const i = Math.floor(x);
    out[0] = out[1] = i >= 0 && i < src.length ? src[i] : 0;
  };
  const tempo = 1.05;
  const pv = new StereoPhaseVocoder();
  const out = new Float32Array(Math.floor(SR * 1.5)), pair = new Float32Array(2);
  for (let n = 0; n < out.length; n++) {
    pv.nextSample(read, n * tempo, tempo, 1.0, 1.0, pair);
    out[n] = pair[0];
  }
  let peakIdx = 0, peakVal = 0;
  for (let n = 0; n < out.length; n++) if (Math.abs(out[n]) > peakVal) { peakVal = Math.abs(out[n]); peakIdx = n; }
  const expectedIdx = kickAt / tempo;
  const errMs = (Math.abs(peakIdx - expectedIdx) / SR) * 1000;
  assert.ok(errMs < 5, `kick aligned within ${errMs.toFixed(2)} ms (expected < 5 ms)`);
  void dominantFreq;
});
