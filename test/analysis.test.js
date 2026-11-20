import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBpm, detectKey, toCamelot, camelotCompatible, encodeWaveform, decodeWaveform, computeWaveform, trimPoints } from '../public/js/audio/analysis-core.js';

const SR = 44100;

function clickTrack(bpm, seconds, offset = 0) {
  const x = new Float32Array(SR * seconds);
  const beat = 60 / bpm;
  for (let t = offset; t < seconds; t += beat) {
    const s = Math.floor(t * SR);
    for (let i = 0; i < 2000 && s + i < x.length; i++) x[s + i] += Math.sin(2 * Math.PI * 55 * i / SR) * Math.exp(-i / 400) * 0.9;
  }
  return x;
}

for (const bpm of [100, 124, 128, 140, 174]) {
  test(`detects ${bpm} BPM`, () => {
    const r = detectBpm(clickTrack(bpm, 40, 0.2), SR);
    assert.ok(Math.abs(r.bpm - bpm) < 0.05, `got ${r.bpm}`);
  });
}

test('beat grid offset lands on the first kick', () => {
  const r = detectBpm(clickTrack(128, 40, 0.3), SR);
  const beat = 60 / 128;
  const d = Math.abs(((r.offset - 0.3) % beat + beat) % beat);
  assert.ok(Math.min(d, beat - d) < 0.025, `offset ${r.offset}`);
});

test('detects A minor from an Am chord progression', () => {
  const notes = { A: 220, C: 261.63, E: 329.63, D: 293.66, F: 349.23, G: 392, B: 246.94 };
  const chords = [['A', 'C', 'E'], ['D', 'F', 'A'], ['E', 'G', 'B'], ['A', 'C', 'E']];
  const x = new Float32Array(SR * 16);
  for (let i = 0; i < x.length; i++) {
    const ch = chords[Math.floor(i / (SR * 4)) % 4];
    for (const n of ch) x[i] += Math.sin(2 * Math.PI * notes[n] * i / SR) * 0.2;
    x[i] += Math.sin(2 * Math.PI * 110 * i / SR) * 0.3; // A bass
  }
  const k = detectKey(x, SR);
  assert.equal(k.camelot, '8A', `got ${k.key}`);
});

test('camelot helpers', () => {
  assert.equal(toCamelot('Am'), '8A');
  assert.equal(toCamelot('C'), '8B');
  assert.equal(toCamelot('F#m'), '11A');
  assert.equal(toCamelot('Gbm'), '11A');
  assert.equal(toCamelot('5A'), '5A');
  assert.ok(camelotCompatible('8A', '9A'));
  assert.ok(camelotCompatible('12A', '1A'));
  assert.ok(camelotCompatible('8A', '8B'));
  assert.ok(!camelotCompatible('8A', '3B'));
});

test('waveform encode/decode round trip + trim points', () => {
  const x = clickTrack(120, 10, 1);
  const w = computeWaveform(x, SR);
  const d = decodeWaveform(encodeWaveform(w).buffer);
  assert.deepEqual([...d.peak], [...w.peak]);
  assert.equal(d.rate, w.rate);
  const tp = trimPoints(x, SR);
  assert.ok(Math.abs(tp.startTime - 1) < 0.06);
});

const kick = (t, bpm) => { const b = 60 / bpm, tb = (t - 0.1 + b * 100) % b; return t > 0.1 && tb < 0.15 ? 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb * 40)) * tb) * Math.exp(-tb * 18) : 0; };

test('kick + sustained chord/bass tones: 124 BPM (not 112)', () => {
  const x = new Float32Array(SR * 40);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] = 0.7 * (kick(t, 124) + 0.15 * (Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t) + Math.sin(2 * Math.PI * 415.3 * t)) + 0.2 * Math.sin(2 * Math.PI * 138.6 * t));
  }
  const r = detectBpm(x, SR);
  assert.ok(Math.abs(r.bpm - 124) < 0.05, `got ${r.bpm}`);
});

test('kick + off-beat bass is not detected at 2/3 tempo', () => {
  const sr = 22050, bpm = 124, b = 60 / bpm;
  const x = new Float32Array(sr * 60);
  for (let i = 0; i < x.length; i++) {
    const t = i / sr, tb = (t - 0.1 - b / 2 + b * 100) % b;
    x[i] = 0.6 * kick(t, bpm) + (t > 0.1 + b / 2 && tb < b * 0.45 ? 0.35 * Math.sin(2 * Math.PI * 55 * tb) * Math.min(1, tb * 200) * Math.exp(-tb * 3) : 0);
  }
  const r = detectBpm(x, sr);
  assert.ok(Math.abs(r.bpm - bpm) < 0.05, `got ${r.bpm}`);
});

test('toCamelot: major keys are not mistaken for minor', () => {
  assert.equal(toCamelot('Amaj'), '11B');
  assert.equal(toCamelot('A major'), '11B');
  assert.equal(toCamelot('C major'), '8B');
  assert.equal(toCamelot('Gbmaj'), '2B');
  assert.equal(toCamelot('A minor'), '8A');
  assert.equal(toCamelot('Cmin'), '5A');
});
