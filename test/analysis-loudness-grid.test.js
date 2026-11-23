// Track analysis: BS.1770 loudness per track / phrase / main section and the track trim, key confidence, and the
// 8-bar phrase grid (phrase-offset vote, pickup bars, snapping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeTrack, analyzeStructure, analysisPatch, computeWaveform, detectKey, phraseOffsetVote, trackLoudness,
  gainForLoudness, carryPhraseLufs, LOUDNESS_TARGET, GAIN_MIN, GAIN_MAX,
} from '../public/js/audio/analysis-core.js';
import { loudnessProfile } from '../public/js/audio/loudness.js';
import { synthTrack } from './synth-track.js';

const SR = 22050, BPM = 124, BAR = 240 / BPM, BEAT = 60 / BPM;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);

const SECTIONS = [
  { bars: 16, hats: true, pad: 0.05 },
  { bars: 32, kick: true, bass: true, hats: true, pad: 0.05 },
  { bars: 16, hats: true, pad: 0.12 },
  { bars: 32, kick: true, bass: true, hats: true, pad: 0.05 },
  { bars: 16, kick: true, hats: true, gain: (p) => 1 - 0.7 * p },
];
let cached;
const track = () => (cached ??= (() => { const tr = synthTrack(SECTIONS); return { tr, r: analyzeTrack(tr.mono, SR) }; })());

test('analyzeTrack: integrated, main-section and per-phrase LUFS; gain = target − mainLufs', () => {
  const { r } = track();
  assert.equal(LOUDNESS_TARGET, -14);
  assert.ok(Number.isFinite(r.lufs) && Number.isFinite(r.mainLufs));
  for (const p of r.phrases) assert.ok(Number.isFinite(p.lufs), JSON.stringify(p));
  const drops = r.phrases.filter((p) => p.type === 'drop');
  const intro = r.phrases[0];
  assert.ok(drops.length >= 2);
  // the main section is the loudest drop; intro is much quieter; integrated sits in between
  near(r.mainLufs, Math.max(...drops.map((p) => p.lufs)), 0.15);
  assert.ok(intro.lufs < r.mainLufs - 4, `intro ${intro.lufs} vs main ${r.mainLufs}`);
  assert.ok(r.lufs <= r.mainLufs + 0.05 && r.lufs > intro.lufs);
  assert.equal(r.gain, gainForLoudness(r.mainLufs));
  near(r.gain, LOUDNESS_TARGET - r.mainLufs, 0.06);
});

test('loudness scales with level: +6 dB louder audio reads 6 LU louder and gets 6 dB less gain', () => {
  const { tr, r } = track();
  const loud = Float32Array.from(tr.mono, (v) => v * 2);
  const r2 = analyzeTrack(loud, SR);
  near(r2.mainLufs - r.mainLufs, 6.02, 0.15);
  near(r2.lufs - r.lufs, 6.02, 0.15);
  near(r.gain - r2.gain, 6.02, 0.25);
});

test('gain clamp and fallbacks', () => {
  assert.equal(gainForLoudness(-40), GAIN_MAX);
  assert.equal(gainForLoudness(0), GAIN_MIN);
  assert.equal(gainForLoudness(-Infinity), 0);
  assert.equal(gainForLoudness(null), 0);
  // no main sections ≥ 8 bars → loudest 30 s window; silence → null and gain 0
  const sr = 8000, x = new Float32Array(sr * 90);
  for (let i = sr * 40; i < sr * 70; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr);
  for (let i = 0; i < sr * 40; i++) x[i] = 0.05 * Math.sin(2 * Math.PI * 440 * i / sr);
  const prof = loudnessProfile(x, sr);
  const l = trackLoudness(prof, sr, [{ start: 0, end: 40, type: 'intro', bars: 16 }, { start: 40, end: 90, type: 'outro', bars: 20 }], 120);
  near(l.mainLufs, -6.5, 0.3, 'loudest window ≈ the loud tone (0.5 amplitude, dual mono: -0.691 + 10·log10(2 · 0.125) + K-gain)');
  assert.ok(l.lufs < l.mainLufs + 0.1);
  const short = trackLoudness(prof, sr, [{ start: 40, end: 50, type: 'drop', bars: 4 }], 120);
  near(short.mainLufs, l.mainLufs, 0.05, 'a 4-bar drop is not a main section');
  const silent = trackLoudness(loudnessProfile(new Float32Array(sr * 5), sr), sr, [], 0);
  assert.deepEqual(silent, { lufs: null, mainLufs: null, phraseLufs: [] });
  assert.equal(gainForLoudness(silent.mainLufs), 0);
});

test('key confidence: high for a clear key, low for noise; stored by analysisPatch', () => {
  const notes = { A: 220, C: 261.63, E: 329.63, D: 293.66, F: 349.23, G: 392, B: 246.94 };
  const chords = [['A', 'C', 'E'], ['D', 'F', 'A'], ['E', 'G', 'B'], ['A', 'C', 'E']];
  const x = new Float32Array(SR * 16);
  for (let i = 0; i < x.length; i++) for (const n of chords[Math.floor(i / (SR * 4)) % 4]) x[i] += Math.sin(2 * Math.PI * notes[n] * i / SR) * 0.2;
  const k = detectKey(x, SR);
  assert.equal(k.camelot, '8A');
  assert.ok(k.keyConfidence >= 0.7 && k.keyConfidence <= 1, `clear key ${k.keyConfidence}`);
  let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  const noise = detectKey(Float32Array.from({ length: SR * 16 }, rnd), SR);
  assert.ok(noise.keyConfidence < 0.5 && noise.keyConfidence < k.keyConfidence - 0.3, `noise ${noise.keyConfidence}`);
  const tone = detectKey(Float32Array.from({ length: SR * 16 }, (_, i) => Math.sin(2 * Math.PI * 220 * i / SR)), SR);
  assert.ok(tone.keyConfidence < 0.5, `single note ${tone.keyConfidence}`);
  assert.equal(detectKey(new Float32Array(100), SR).keyConfidence, 0);

  const r = { bpm: 124, key: 'Am', camelot: '8A', keyConfidence: 0.8, gain: -1, lufs: -10.2, mainLufs: -13, phraseAnchor: 1.2, phraseConfidence: 0.9, phrases: [] };
  const fresh = analysisPatch({}, r);
  assert.equal(fresh.key, 'Am'); assert.equal(fresh.keyConfidence, 0.8);
  assert.equal(fresh.lufs, -10.2); assert.equal(fresh.mainLufs, -13); assert.equal(fresh.gain, -1);
  assert.equal(fresh.phraseAnchor, 1.2); assert.equal(fresh.phraseConfidence, 0.9);
  // user / tag / imported key (no confidence stored): kept and trusted
  const user = analysisPatch({ key: '3B' }, r);
  assert.equal(user.key, '3B'); assert.equal(user.keyConfidence, 1);
  // key from an earlier analysis: refreshed when the detector agrees, else the old confidence stays
  assert.equal(analysisPatch({ key: 'Am', keyConfidence: 0.5 }, r).keyConfidence, 0.8);
  assert.equal(analysisPatch({ key: 'C', keyConfidence: 0.5 }, r).keyConfidence, 0.5);
  // old analysis results (no new fields): nothing new in the patch, gain as before
  const old = analysisPatch({}, { bpm: 120, key: 'Am', gain: -3, phrases: [] });
  for (const f of ['keyConfidence', 'lufs', 'mainLufs', 'phraseAnchor', 'phraseConfidence']) assert.ok(!(f in old), f);
  assert.equal(old.gain, -3);
  // locked grid: the phrase anchor moves onto the locked grid's beats
  const locked = analysisPatch({ bpm: 120, gridOffset: 0.1, bpmLocked: true }, { ...r, phraseAnchor: 8.37 });
  near(((locked.phraseAnchor - 0.1) / 0.5) % 1, 0, 1e-6);
});

test('phrase-offset vote: picks the offset whose 8-bar lines carry the novelty', () => {
  const nov = new Float32Array(81);
  for (let k = 3; k < 80; k += 8) nov[k] = 1;
  for (let k = 1; k < 80; k++) nov[k] += 0.05 * ((k * 7) % 3);
  const v = phraseOffsetVote(nov, 80);
  assert.equal(v.offset, 3);
  assert.ok(v.confidence > 0.8, `confidence ${v.confidence}`);
  const flat = phraseOffsetVote(new Float32Array(81).fill(0.3), 80);
  assert.equal(flat.offset, 0); assert.equal(flat.confidence, 0);
  // 4-bar ambiguity (o and o + 4 equally strong) is less certain than a clean 8-bar grid
  const amb = new Float32Array(81); for (let k = 2; k < 80; k += 4) amb[k] = 1;
  const va = phraseOffsetVote(amb, 80);
  assert.ok(va.offset === 2 || va.offset === 6);
  assert.ok(va.confidence < v.confidence - 0.2, `ambiguous ${va.confidence} vs ${v.confidence}`);
});

test('phrase grid: 2 pickup bars before 8-bar blocks → anchor 2 bars after the downbeat, boundaries on the grid', () => {
  const blocks = [
    { bars: 2, hats: true }, // pickup
    { bars: 8, kick: true, hats: true },
    { bars: 8, kick: true, bass: true, hats: true, pad: 0.05 },
    { bars: 8, hats: true, pad: 0.15 },
    { bars: 8, kick: true, bass: true, hats: true, pad: 0.05 },
    { bars: 8, kick: true, hats: true },
    { bars: 8, pad: 0.12 },
    { bars: 8, kick: true, bass: true, hats: true },
    { bars: 8, kick: true, hats: true, gain: 0.5 },
  ];
  const tr = synthTrack(blocks, { pickup: 0 });
  const dur = tr.mono.length / SR;
  const s = analyzeStructure(computeWaveform(tr.mono, SR), BPM, tr.downbeat % BEAT, { startTime: 0.3, endTime: dur - 1, duration: dur });
  near(s.downbeat, tr.downbeat, 0.03, 'downbeat');
  near(s.phraseAnchor, tr.downbeat + 2 * BAR, 0.03, 'phrase anchor');
  assert.ok(s.phraseConfidence >= 0.6, `confidence ${s.phraseConfidence}`);
  const starts = s.phrases.slice(1).map((p) => Math.round((p.start - tr.downbeat) / BAR));
  assert.ok(starts.length >= 4, JSON.stringify(starts));
  for (const b of starts) assert.equal((b - 2) % 8, 0, `boundary at bar ${b} is off the phrase grid (${starts})`);
  for (const p of s.phrases) assert.ok(Number.isInteger(p.bars) && p.bars > 0);
  // the fallback mix-out (no outro) lands on the phrase grid too
  assert.equal((Math.round((s.mixOut - tr.downbeat) / BAR) - 2) % 8, 0, `mixOut ${s.mixOut}`);
});

test('phrase grid: a clean boundary one bar off the grid is kept (not snapped)', () => {
  const tr = synthTrack([
    { bars: 16, hats: true, pad: 0.05 },
    { bars: 16, kick: true, bass: true, hats: true, pad: 0.05 },
    { bars: 17, hats: true, pad: 0.15 }, // breakdown one bar longer: the next drop starts at bar 49
    { bars: 15, kick: true, bass: true, hats: true, pad: 0.05 },
    { bars: 16, kick: true, hats: true },
  ], { pickup: 0 });
  const r = analyzeTrack(tr.mono, SR);
  const starts = r.phrases.slice(1).map((p) => Math.round((p.start - tr.downbeat) / BAR));
  assert.deepEqual(starts, [16, 32, 49, 64], JSON.stringify(r.phrases.map((p) => [p.type, p.bars])));
  near(r.phraseAnchor, r.downbeat, 0.01);
});

test('carryPhraseLufs: phrases recomputed from the waveform keep an energy-weighted loudness', () => {
  const old = [{ start: 0, end: 10, lufs: -20 }, { start: 10, end: 20, lufs: -10 }];
  const out = carryPhraseLufs(old, [{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 30, end: 40 }]);
  assert.equal(out[0].lufs, -20);
  near(out[1].lufs, 10 * Math.log10((10 ** -2 + 10 ** -1) / 2), 0.05);
  assert.equal(out[2].lufs, undefined);
  const plain = [{ start: 0, end: 1 }];
  assert.equal(carryPhraseLufs([{ start: 0, end: 1 }], plain), plain, 'old analyses without lufs: unchanged');
});

test('library keeps the new analysis fields (sanitised) and trusts a key the user changes', async () => {
  const { LibraryCore, sanitizeField } = await import('../public/js/shared/library-core.js');
  const lib = new LibraryCore(); lib.save = () => {};
  lib.upsertTrack({ id: 't1', title: 'x' });
  lib.updateTrack('t1', { key: 'Am', keyConfidence: 0.42, lufs: '-9.5', mainLufs: -8.1, phraseAnchor: 1.25, phraseConfidence: 3, gain: -5.9, phrases: [{ start: 0, end: 10, lufs: -9 }] });
  const t = lib.getTrack('t1');
  assert.equal(t.keyConfidence, 0.42); assert.equal(t.lufs, -9.5); assert.equal(t.mainLufs, -8.1);
  assert.equal(t.phraseAnchor, 1.25); assert.equal(t.phraseConfidence, 1); assert.equal(t.phrases[0].lufs, -9);
  assert.equal(sanitizeField('mainLufs', 'loud'), null);
  lib.updateTrack('t1', { key: 'Am' }); // same key re-saved: confidence untouched
  assert.equal(t.keyConfidence, 0.42);
  lib.updateTrack('t1', { key: 'Cm' }); // changed by the user: trusted
  assert.equal(t.keyConfidence, 1);
  lib.upsertTrack({ id: 't1', title: 'rescan' }); // a rescan keeps the analysis
  assert.equal(lib.getTrack('t1').mainLufs, -8.1);
});
