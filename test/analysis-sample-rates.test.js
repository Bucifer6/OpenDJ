import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBpm } from '../public/js/audio/analysis-core.js';

// Same percussion + sustained fifth used by the browser background-analysis fixture.
// At 48 kHz the pad used to win the ACF and report 132.85 BPM for a 124 BPM track.
for (const sr of [22050, 44100, 48000, 96000]) for (const [bpm, root] of [[122, 174.6], [124, 220], [128, 196]]) {
  test(`beat detector distinguishes drums from sustained tones: ${bpm} BPM at ${sr} Hz`, () => {
    const mono = new Float32Array(sr * 50), beat = 60 / bpm;
    for (let i = 0; i < mono.length; i++) {
      const t = i / sr, tb = (t - 0.1) % beat;
      let v = 0.25 * Math.sin(2 * Math.PI * root * t) + 0.12 * Math.sin(2 * Math.PI * root * 1.5 * t);
      if (t > 0.1 && tb < 0.15) v += 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb * 40)) * tb) * Math.exp(-tb * 18);
      mono[i] = Math.trunc(Math.max(-1, Math.min(1, v * 0.7)) * 32767) / 32768;
    }
    const r = detectBpm(mono, sr);
    assert.ok(Math.abs(r.bpm - bpm) < 0.05, `got ${r.bpm}`);
    assert.ok(Math.abs(r.offset - 0.1) < 0.025, `offset ${r.offset}`);
  });
}
