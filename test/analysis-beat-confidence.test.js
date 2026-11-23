// P0.4: per-section beat confidence (pulse, gridErr) on phrases and regionBeatSafety for the planner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack, analyzeStructure, computeWaveform, detectPhrases, sectionBeatConfidence, regionBeatSafety, carryPhraseLufs } from '../public/js/audio/analysis-core.js';
import { sanitizeField } from '../public/js/shared/library-core.js';
import { synthTrack } from './synth-track.js';

const SR = 22050, BPM = 124, BEAT = 60 / BPM, BAR = 4 * BEAT;

/** Kick on every beat (+ off-beat hat) with a per-beat timing offset off(k) in seconds. */
function kickTrack(bars, off = () => 0, { lead = 0.5 } = {}) {
  const n = Math.ceil((lead + bars * BAR + 1) * SR);
  const x = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  for (let k = 0; k < bars * 4; k++) {
    const i0 = Math.floor((lead + k * BEAT + off(k)) * SR);
    for (let i = 0; i < 0.25 * SR && i0 + i < n; i++) {
      const u = i / SR;
      x[i0 + i] += 0.8 * Math.sin(2 * Math.PI * (50 * u + 100 * (1 - Math.exp(-u * 40)) / 40)) * Math.exp(-u * 18);
    }
    const j0 = Math.floor((lead + k * BEAT + BEAT / 2 + off(k)) * SR);
    let prev = 0;
    for (let i = 0; i < 0.04 * SR && j0 + i < n; i++) { const r = rnd(); x[j0 + i] += 0.12 * (r - prev) * Math.exp(-i / SR * 90); prev = r; }
  }
  return { mono: x, lead };
}

const phraseAt = (phrases, t) => phrases.find((p) => p.start <= t && t < p.end);

test('steady 4/4 kick track (analysed grid): pulse > 0.7 and gridErr < 10 ms on every phrase', () => {
  const tr = synthTrack([{ bars: 32, kick: true, bass: true, hats: true }, { bars: 32, kick: true, hats: true, pad: 0.05 }]);
  const r = analyzeTrack(tr.mono, SR);
  assert.ok(r.phrases.length >= 1);
  for (const p of r.phrases) {
    if (p.end - p.start < 4 * BAR) continue;
    assert.ok(p.pulse > 0.7, `pulse ${p.pulse} at ${p.start}`);
    assert.ok(p.gridErr != null && p.gridErr < 10, `gridErr ${p.gridErr} at ${p.start}`);
  }
});

test('beatless pad: pulse < 0.3 and gridErr null', () => {
  const tr = synthTrack([{ bars: 32, pad: 0.12 }], { pickup: 0 });
  const w = computeWaveform(tr.mono, SR);
  const c = sectionBeatConfidence(w, BPM, tr.downbeat, tr.downbeat, tr.downbeat + 32 * BAR);
  assert.ok(c.pulse < 0.3, `pulse ${c.pulse}`);
  assert.equal(c.gridErr, null);
});

test('live-drummer drift ±40 ms: gridErr > 25 ms (steady control < 10 ms)', () => {
  const drift = kickTrack(32, (k) => 0.04 * Math.sin(2 * Math.PI * k / 16));
  const steady = kickTrack(32);
  const end = drift.lead + 32 * BAR;
  const cd = sectionBeatConfidence(computeWaveform(drift.mono, SR), BPM, drift.lead, drift.lead, end);
  const cs = sectionBeatConfidence(computeWaveform(steady.mono, SR), BPM, steady.lead, steady.lead, end);
  assert.ok(cd.gridErr > 25, `drift gridErr ${cd.gridErr}`);
  assert.ok(cs.gridErr < 10, `steady gridErr ${cs.gridErr}`);
  assert.ok(cs.pulse > 0.7 && cd.pulse < cs.pulse, `pulse steady ${cs.pulse} drift ${cd.pulse}`);
});

test('grid edit: a grid 30 ms off the kicks shows as gridErr ≈ 30 ms', () => {
  const tr = kickTrack(16);
  const w = computeWaveform(tr.mono, SR);
  const c = sectionBeatConfidence(w, BPM, tr.lead + 0.03, tr.lead, tr.lead + 16 * BAR);
  assert.ok(c.gridErr > 22 && c.gridErr < 38, `gridErr ${c.gridErr}`);
});

test('beatless intro + steady body (+ beatless breakdown): per-phrase pulse follows the sections', () => {
  const tr = synthTrack([
    { bars: 16, pad: 0.1 },
    { bars: 32, kick: true, bass: true, hats: true, pad: 0.05 },
    { bars: 16, pad: 0.12 },
    { bars: 16, kick: true, hats: true },
  ]);
  const w = computeWaveform(tr.mono, SR);
  const duration = tr.mono.length / SR;
  const { phrases } = detectPhrases(null, 0, BPM, tr.downbeat, w, { duration });
  const intro = phraseAt(phrases, tr.downbeat + 8 * BAR);
  const body = phraseAt(phrases, tr.downbeat + 32 * BAR);
  const brk = phraseAt(phrases, tr.downbeat + 56 * BAR);
  const out = phraseAt(phrases, tr.downbeat + 72 * BAR);
  assert.ok(intro.pulse < 0.3 && intro.gridErr == null, `intro ${intro.pulse} / ${intro.gridErr}`);
  assert.ok(body.pulse > 0.7 && body.gridErr < 10, `body ${body.pulse} / ${body.gridErr}`);
  assert.ok(brk.pulse < 0.3 && brk.gridErr == null, `breakdown ${brk.pulse} / ${brk.gridErr}`);
  assert.ok(out.pulse > 0.7 && out.gridErr < 10, `outro ${out.pulse} / ${out.gridErr}`);

  // the client path (old analyses, grid edits: deck.refreshStructure) carries the fields, also through carryPhraseLufs
  const st = analyzeStructure(w, BPM, tr.downbeat, { duration });
  assert.deepEqual(st.phrases.map((p) => [p.pulse, p.gridErr]), phrases.map((p) => [p.pulse, p.gridErr]));
  const carried = carryPhraseLufs(phrases.map((p) => ({ ...p, lufs: -10 })), st.phrases);
  assert.ok(carried.every((p) => 'pulse' in p && 'gridErr' in p && p.lufs === -10));
  // the library keeps phrase objects as they are
  assert.deepEqual(sanitizeField('phrases', carried), carried);

  // region helper on the analysed track
  const track = { bpm: BPM, phrases };
  const rIntro = regionBeatSafety(track, tr.downbeat, tr.downbeat + 8 * BAR);
  const rBody = regionBeatSafety(track, tr.downbeat + 24 * BAR, tr.downbeat + 40 * BAR);
  assert.ok(rIntro.known && rIntro.pulse < 0.3 && rIntro.gridErr == null, JSON.stringify(rIntro));
  assert.ok(rBody.known && rBody.pulse > 0.7 && rBody.gridErr < 10, JSON.stringify(rBody));
});

test('regionBeatSafety: duration-weighted pulse, worst gridErr of phrases overlapping ≥ 1 bar, known flag', () => {
  const bar = 240 / 120; // 2 s
  const track = {
    bpm: 120,
    phrases: [
      { start: 0, end: 32, pulse: 0.1, gridErr: null },
      { start: 32, end: 64, pulse: 0.9, gridErr: 4 },
      { start: 64, end: 96, pulse: 0.8, gridErr: 30 },
    ],
  };
  // 16 s of the pad + 16 s of the body: (16·0.1 + 16·0.9) / 32
  let r = regionBeatSafety(track, 16, 48);
  assert.deepEqual(r, { pulse: 0.5, gridErr: 4, known: true });
  // 24 s body + 8 s drifting phrase: weighted pulse, gridErr = max
  r = regionBeatSafety(track, 40, 72);
  assert.equal(r.pulse, Math.round(((24 * 0.9 + 8 * 0.8) / 32) * 100) / 100);
  assert.equal(r.gridErr, 30);
  // a sliver (< 1 bar) of the drifting phrase does not set gridErr
  r = regionBeatSafety(track, 40, 64 + bar / 2);
  assert.equal(r.gridErr, 4);
  // a region shorter than a bar inside one phrase still gets that phrase's gridErr
  assert.equal(regionBeatSafety(track, 70, 71).gridErr, 30);
  // beatless only
  assert.deepEqual(regionBeatSafety(track, 0, 30), { pulse: 0.1, gridErr: null, known: true });
  // unknown: old analysis without the fields, no grid, no phrases, mostly uncovered
  assert.equal(regionBeatSafety({ bpm: 120, phrases: [{ start: 0, end: 60 }] }, 0, 30).known, false);
  assert.equal(regionBeatSafety({ bpm: 0, phrases: track.phrases }, 0, 30).known, false);
  assert.equal(regionBeatSafety({ bpm: 120 }, 0, 30).known, false);
  assert.equal(regionBeatSafety(track, 80, 200).known, false);
  assert.equal(regionBeatSafety(null, 0, 1).known, false);
});
