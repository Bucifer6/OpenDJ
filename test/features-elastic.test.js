import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectVocalActivity, computeBarFeatures, localChromaSimilarity, barProfileAt,
  computeGrooveAndEmbedding, detectElasticGrid, beatAtTime, timeAtBeat, localBpmAt,
} from '../public/js/audio/features.js';
import { analyzeTrack } from '../public/js/audio/analysis-core.js';
import { soundSimilarity } from '../public/js/smartmix.js';

const SR = 44100;

function makeBeatTrack(bpm, seconds, { vocalFrom = -1, vocalTo = -1, chordFreqs = [220, 261.63, 329.63] } = {}) {
  const x = new Float32Array(Math.floor(SR * seconds));
  const beat = 60 / bpm;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const tb = t % beat;
    // Kick on every beat
    if (tb < 0.12) x[i] += 0.55 * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-tb * 35)) * tb) * Math.exp(-tb * 20);
    // Steady harmonic chord in low-mid
    for (const f of chordFreqs) x[i] += 0.08 * Math.sin(2 * Math.PI * f * t);
    // Simulated vocal (modulated harmonic stack at 350/700/1050/1400 Hz with 5 Hz syllabic envelope)
    if (t >= vocalFrom && t < vocalTo) {
      const syll = 0.5 + 0.5 * Math.sin(2 * Math.PI * 5 * t);
      const vib = 1 + 0.015 * Math.sin(2 * Math.PI * 6 * t);
      x[i] += syll * (0.28 * Math.sin(2 * Math.PI * 440 * vib * t) + 0.2 * Math.sin(2 * Math.PI * 880 * vib * t) + 0.14 * Math.sin(2 * Math.PI * 1320 * vib * t));
    }
  }
  return x;
}

test('DSP VAD distinguishes vocal sections from kick-only instrumental sections', () => {
  const x = makeBeatTrack(124, 16, { vocalFrom: 8, vocalTo: 15, chordFreqs: [] });
  const { map, encoded } = detectVocalActivity(x, SR);
  assert.equal(map.length, 16);
  assert.ok(encoded.length > 0);
  const instMean = (map[1] + map[2] + map[3] + map[4] + map[5]) / 5;
  const vocMean = (map[9] + map[10] + map[11] + map[12] + map[13]) / 5;
  assert.ok(vocMean > instMean + 0.25, `expected vocal (${vocMean.toFixed(2)}) >> inst (${instMean.toFixed(2)})`);
});

test('per-bar 4-band + chroma features measure harmonic similarity accurately', () => {
  const am = makeBeatTrack(120, 12, { chordFreqs: [220, 261.63, 329.63] }); // A minor
  const fSharp = makeBeatTrack(120, 12, { chordFreqs: [185, 233.08, 277.18] }); // F# major (clash)
  const bfA = computeBarFeatures(am, SR, 120, 0);
  const bfB = computeBarFeatures(fSharp, SR, 120, 0);
  assert.ok(bfA.length >= 5);
  const prof = barProfileAt({ barFeatures: bfA }, 2, 6);
  assert.ok(prof && prof.sub > 0 && prof.mid > 0);
  const sameSim = localChromaSimilarity({ barFeatures: bfA }, 0, 8, { barFeatures: bfA }, 0, 8);
  const clashSim = localChromaSimilarity({ barFeatures: bfA }, 0, 8, { barFeatures: bfB }, 0, 8);
  assert.ok(sameSim > 0.95 && clashSim < 0.55, `same=${sameSim}, clash=${clashSim}`);
});

test('groove fingerprint + 24-dim embedding drives smartmix.soundSimilarity', () => {
  const a = analyzeTrack(makeBeatTrack(124, 24), SR);
  const b = analyzeTrack(makeBeatTrack(124, 24), SR);
  assert.equal(a.embedding.length, 24);
  assert.equal(a.groove.steps.length, 16);
  const sim = soundSimilarity(a, b);
  assert.ok(sim > 0.9, `expected high self-similarity, got ${sim}`);
});

test('elastic beatgrid detects tempo drift and interpolates beat <-> time accurately', () => {
  // Build a 32-second track whose tempo drifts linearly from 118 BPM to 128 BPM
  const dur = 32;
  const x = new Float32Array(SR * dur);
  let phase = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const bpm = 118 + (10 * t) / dur;
    const prevPhase = phase;
    phase += bpm / 60 / SR;
    if (Math.floor(phase) > Math.floor(prevPhase)) {
      for (let j = 0; j < 1800 && i + j < x.length; j++) {
        x[i + j] += 0.85 * Math.sin((2 * Math.PI * 55 * j) / SR) * Math.exp(-j / 350);
      }
    }
  }
  const map = detectElasticGrid(x, SR, 123, 0);
  assert.ok(Array.isArray(map) && map.length >= 2, 'detected elastic tempoMap');
  assert.ok(localBpmAt({ tempoMap: map }, 2) < localBpmAt({ tempoMap: map }, 28) - 4, 'tracked tempo rise');
  const b = beatAtTime({ tempoMap: map }, 15);
  const tBack = timeAtBeat({ tempoMap: map }, b);
  assert.ok(Math.abs(tBack - 15) < 0.01, `round-trip time ${tBack}`);
});
