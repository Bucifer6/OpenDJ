import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrack, analyzeStructure, computeWaveform, detectPhrases, mixPoints, autoCuesFor } from '../public/js/audio/analysis-core.js';

const SR = 22050;
const BPM = 124;
const BEAT = 60 / BPM, BAR = 4 * BEAT;

/**
 * Synthetic dance track: `lead` s of silence, `pickup` beats of hi-hats, then sections of whole bars.
 * Section voices: kick (4/4), bass (off-beat 8ths), hats (8ths), pad (Am chord). gain may be a function of 0..1 progress.
 */
export function synthTrack(sections, { lead = 0.3, pickup = 2, tail = 1, sr = SR, bpm = BPM } = {}) {
  const beat = 60 / bpm, bar = 4 * beat;
  const downbeat = lead + pickup * beat;
  const totalBars = sections.reduce((s, x) => s + x.bars, 0);
  const n = Math.ceil((downbeat + totalBars * bar + tail) * sr);
  const x = new Float32Array(n);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  const add = (from, to, v) => {
    const i0 = Math.max(0, Math.floor(from * sr)), i1 = Math.min(n, Math.floor(to * sr));
    for (let i = i0; i < i1; i++) x[i] += v(i / sr - from, i / sr);
  };
  const hats = (t0, t1, g) => {
    for (let t = t0; t < t1 - 1e-6; t += beat / 2) {
      let prev = 0;
      add(t, t + 0.04, (u) => { const r = rnd(); const h = r - prev; prev = r; return 0.12 * g(t) * h * Math.exp(-u * 90); });
    }
  };
  if (pickup) hats(lead, downbeat, () => 1);
  let t = downbeat;
  for (const s of sections) {
    const t1 = t + s.bars * bar, ts = t;
    const g = (tt) => (typeof s.gain === 'function' ? s.gain((tt - ts) / (t1 - ts)) : s.gain ?? 1);
    if (s.hats) hats(t, t1, g);
    if (s.pad) add(t, t1, (u, tt) => s.pad * g(tt) * (Math.sin(2 * Math.PI * 220 * tt) + Math.sin(2 * Math.PI * 261.63 * tt) + Math.sin(2 * Math.PI * 329.63 * tt)));
    for (let b = t; b < t1 - 1e-6; b += beat) {
      const gb = g(b);
      if (s.kick) add(b, b + 0.25, (u) => 0.8 * gb * Math.sin(2 * Math.PI * (50 * u + 100 * (1 - Math.exp(-u * 40)) / 40)) * Math.exp(-u * 18));
      if (s.bass) add(b + beat / 2, b + beat * 0.95, (u) => 0.35 * gb * Math.sin(2 * Math.PI * 55 * u) * Math.min(1, u * 200) * Math.exp(-u * 3));
    }
    t = t1;
  }
  return { mono: x, downbeat, bar, beat };
}

const SECTIONS = [
  { name: 'intro', bars: 16, hats: true, pad: 0.05 },
  { name: 'drop', bars: 32, kick: true, bass: true, hats: true, pad: 0.05 },
  { name: 'breakdown', bars: 16, hats: true, pad: 0.12 },
  { name: 'drop', bars: 32, kick: true, bass: true, hats: true, pad: 0.05 },
  { name: 'outro', bars: 16, kick: true, hats: true, gain: (p) => 1 - 0.7 * p },
];

let cached;
function analyzed() {
  if (!cached) {
    const tr = synthTrack(SECTIONS);
    const t0 = performance.now();
    const r = analyzeTrack(tr.mono, SR);
    cached = { tr, r, ms: performance.now() - t0 };
  }
  return cached;
}

function truthBounds(tr) {
  const out = []; let b = 0;
  for (const s of SECTIONS) { out.push({ t: tr.downbeat + b * tr.bar, type: s.name, mid: tr.downbeat + (b + s.bars / 2) * tr.bar }); b += s.bars; }
  return out;
}

test('synthetic track: bpm, downbeat and phrase boundaries', () => {
  const { tr, r } = analyzed();
  assert.ok(Math.abs(r.bpm - BPM) < 0.05, `bpm ${r.bpm}`);
  assert.ok(Math.abs(r.downbeat - tr.downbeat) < 0.05, `downbeat ${r.downbeat} vs ${tr.downbeat}`);
  const starts = r.phrases.map((p) => p.start);
  for (const tb of truthBounds(tr).slice(1)) {
    const near = starts.some((s) => Math.abs(s - tb.t) <= BEAT + 1e-3);
    assert.ok(near, `no phrase boundary near ${tb.t.toFixed(2)} (${tb.type}); got ${starts.join(', ')}`);
  }
  // no spurious boundaries: every boundary is one of the truth ones (sections ≤ 32 bars are not split)
  for (const s of starts.slice(1)) assert.ok(truthBounds(tr).some((tb) => Math.abs(s - tb.t) <= BEAT + 1e-3), `spurious boundary at ${s}`);
  // phrases are contiguous and ordered
  for (let i = 1; i < r.phrases.length; i++) assert.ok(Math.abs(r.phrases[i].start - r.phrases[i - 1].end) < 1e-6);
});

test('synthetic track: phrase labels', () => {
  const { tr, r } = analyzed();
  const at = (t) => r.phrases.find((p) => p.start <= t && t < p.end)?.type;
  for (const tb of truthBounds(tr)) assert.equal(at(tb.mid), tb.type, `at ${tb.mid.toFixed(1)}s`);
  for (const p of r.phrases) assert.ok(p.energy >= 0 && p.energy <= 1);
  const drop = r.phrases.find((p) => p.type === 'drop'), brk = r.phrases.find((p) => p.type === 'breakdown');
  assert.ok(drop.energy > brk.energy);
});

test('synthetic track: mix points and auto cues', () => {
  const { tr, r } = analyzed();
  assert.ok(Math.abs(r.mixIn - tr.downbeat) < 0.05, `mixIn ${r.mixIn}`);
  const outroStart = tr.downbeat + 96 * tr.bar;
  assert.ok(Math.abs(r.mixOut - outroStart) <= BEAT, `mixOut ${r.mixOut} vs ${outroStart}`);
  const hot = r.autoCues.filter((c) => c.type === 'hot');
  const mem = r.autoCues.filter((c) => c.type === 'memory');
  assert.ok(hot.length >= 5 && hot.length <= 8);
  hot.forEach((c, i) => { assert.equal(c.index, i); assert.ok(c.name && /^#[0-9a-f]{6}$/i.test(c.color)); });
  for (let i = 1; i < hot.length; i++) assert.ok(hot[i].position > hot[i - 1].position);
  const names = hot.map((c) => c.name);
  for (const n of ['Intro', 'Drop', 'Breakdown', 'Drop 2', 'Outro']) assert.ok(names.includes(n), `missing ${n} in ${names}`);
  const cue = (n) => hot.find((c) => c.name === n).position;
  assert.ok(Math.abs(cue('Drop') - (tr.downbeat + 16 * tr.bar)) <= BEAT);
  assert.ok(Math.abs(cue('Breakdown') - (tr.downbeat + 48 * tr.bar)) <= BEAT);
  assert.ok(Math.abs(cue('Drop 2') - (tr.downbeat + 64 * tr.bar)) <= BEAT);
  assert.ok(mem.every((c) => c.index === -1));
  assert.ok(mem.some((c) => Math.abs(c.position - r.mixIn) < 1e-6 && c.name === 'Mix in'));
});

test('downbeat phase is found when the grid offset does not start on beat 1', () => {
  // 3-beat pickup: the first beat of the track is beat 2 of a bar
  const tr = synthTrack(SECTIONS.slice(0, 3), { pickup: 3, lead: 0.1 });
  const wf = computeWaveform(tr.mono, SR);
  const off = (tr.downbeat % BEAT); // what detectBpm would report
  const { phrases, downbeat } = detectPhrases(null, SR, BPM, off, wf, { startTime: 0.1, endTime: tr.mono.length / SR - 1 });
  assert.ok(Math.abs(downbeat - tr.downbeat) < 0.02, `downbeat ${downbeat} vs ${tr.downbeat}`);
  assert.deepEqual(phrases.map((p) => p.type), ['intro', 'drop', 'outro']);
});

test('long sections are split into 16-bar phrases; long outro gives mixOut at 8-bar boundary', () => {
  const tr = synthTrack([
    { name: 'intro', bars: 16, hats: true, pad: 0.05 },
    { name: 'drop', bars: 64, kick: true, bass: true, hats: true, pad: 0.05 },
    { name: 'outro', bars: 16, hats: true, pad: 0.05 },
  ]);
  const wf = computeWaveform(tr.mono, SR);
  const s = analyzeStructure(wf, BPM, tr.downbeat % BEAT, { startTime: 0.3, endTime: tr.mono.length / SR - 1, duration: tr.mono.length / SR });
  const drops = s.phrases.filter((p) => p.type === 'drop');
  assert.equal(drops.length, 4);
  assert.ok(drops.every((p) => p.bars === 16));
  // one hot cue per section start, not per phrase
  assert.equal(s.autoCues.filter((c) => c.name.startsWith('Drop')).length, 1);
  assert.ok(Math.abs(s.mixOut - (tr.downbeat + 80 * tr.bar)) <= BEAT);
});

test('no bpm / short material degrades gracefully', () => {
  const wf = { rate: 150, low: new Uint8Array(1500), mid: new Uint8Array(1500), high: new Uint8Array(1500), peak: new Uint8Array(1500) };
  const s = analyzeStructure(wf, null, 0, { startTime: 1, endTime: 9, duration: 10 });
  assert.deepEqual(s.phrases, []);
  assert.equal(s.mixIn, 1);
  assert.ok(s.mixOut >= s.mixIn);
  const s2 = analyzeStructure(wf, 124, 0, { startTime: 0, endTime: 9, duration: 10 });
  assert.equal(s2.phrases.length, 1);
  assert.ok(s2.mixOut >= s2.mixIn);
  assert.deepEqual(mixPoints([], 0, 124, { startTime: 2, endTime: 40 }), { mixIn: 2, mixOut: 10 });
  assert.ok(autoCuesFor([], { mixIn: 0 }).length >= 1);
});

test('phrase analysis is fast (7-minute track)', () => {
  const sr = 44100, secs = 420, rate = 150, n = secs * rate;
  const wf = { rate, low: new Uint8Array(n), mid: new Uint8Array(n), high: new Uint8Array(n), peak: new Uint8Array(n) };
  for (let i = 0; i < n; i++) { const bar = Math.floor(i / rate / (240 / 124)); const on = (bar >> 4) % 2; wf.low[i] = on ? 200 : 20; wf.mid[i] = 100 + (i % 37); wf.high[i] = 80 + (i % 11); wf.peak[i] = 200; }
  const t0 = performance.now();
  for (let r = 0; r < 5; r++) analyzeStructure(wf, 124, 0.1, { startTime: 0, endTime: secs, duration: secs });
  const ms = (performance.now() - t0) / 5;
  assert.ok(ms < 100, `took ${ms.toFixed(1)} ms`);
  void sr;
});

test('DJ-style layout: kick-only intro, breakdown + riser buildup, long outro', () => {
  const tr = synthTrack([
    { bars: 16, kick: true, hats: true },
    { bars: 32, kick: true, bass: true, hats: true, pad: 0.05 },
    { bars: 16, pad: 0.12 },
    { bars: 8, hats: true, pad: 0.12, gain: (p) => 0.4 + p },
    { bars: 32, kick: true, bass: true, hats: true, pad: 0.05 },
    { bars: 32, kick: true, hats: true },
  ], { pickup: 0 });
  const r = analyzeTrack(tr.mono, SR);
  assert.ok(Math.abs(r.bpm - BPM) < 0.05, 'off-beat bass must not fool the tempo detection');
  const got = r.phrases.map((p) => [Math.round((p.start - tr.downbeat) / tr.bar) + 0, p.type]);
  assert.deepEqual(got, [[0, 'intro'], [16, 'drop'], [48, 'breakdown'], [64, 'buildup'], [72, 'drop'], [104, 'outro']]);
  assert.ok(Math.abs(r.mixOut - (tr.downbeat + 104 * tr.bar)) <= BEAT);
});

test('auto cues: no "Drop" at the start of the track; every auto cue is marked auto', () => {
  // full-energy from the first bar (one section, or a loud intro): hot cue A must not be a "Drop" near 0 s
  const one = autoCuesFor([{ start: 0.1, end: 200, type: 'drop', energy: 1, bars: 100 }], { mixIn: 0.1, mixOut: 170, downbeat: 0.1 });
  assert.ok(!one.some((c) => /^Drop/.test(c.name)), JSON.stringify(one));
  assert.equal(one.find((c) => c.index === 0).name, 'Start');
  // a "drop" right after a section of the same loudness is not a real drop either
  const flat = autoCuesFor([
    { start: 0.2, end: 30, type: 'verse', energy: 0.95, bars: 16 },
    { start: 30, end: 90, type: 'drop', energy: 1, bars: 32 },
    { start: 90, end: 120, type: 'outro', energy: 0.4, bars: 16 },
  ], { mixIn: 0.2, mixOut: 90, downbeat: 0.2 });
  assert.ok(!flat.some((c) => /^Drop/.test(c.name)), JSON.stringify(flat));
  // a drop 1.6 s in (after a tiny "intro") is not one
  const early = autoCuesFor([{ start: 0, end: 1.6, type: 'intro', energy: 0.2, bars: 1 }, { start: 1.6, end: 200, type: 'drop', energy: 1, bars: 100 }], { mixIn: 0, downbeat: 0 });
  assert.ok(!early.some((c) => /^Drop/.test(c.name)));
  // the real thing: quiet intro, then a big jump 30 s in
  const real = autoCuesFor([
    { start: 0.2, end: 30, type: 'intro', energy: 0.4, bars: 16 },
    { start: 30, end: 90, type: 'drop', energy: 1, bars: 32 },
    { start: 90, end: 120, type: 'outro', energy: 0.4, bars: 16 },
  ], { mixIn: 0.2, mixOut: 90, downbeat: 0.2 });
  assert.equal(real.find((c) => c.name === 'Drop').position, 30);
  for (const c of [...one, ...flat, ...real]) assert.equal(c.auto, true);
});

test('analysisPatch: same patch for deck load and background analysis; locked grids and user data win', async () => {
  const { analysisPatch } = await import('../public/js/audio/analysis-core.js');
  const r = { bpm: 128, gridOffset: 0.12, key: 'Am', gain: -3, startTime: 0.1, endTime: 199, energy: 6, duration: 200, phrases: [], mixIn: 0.1, mixOut: 170, downbeat: 0.1, autoCues: [{ index: 0, type: 'hot', position: 0.1, name: 'Start', auto: true }] };
  const p = analysisPatch({ id: 'a', cues: [] }, r);
  assert.equal(p.bpm, 128); assert.equal(p.key, 'Am'); assert.equal(p.analyzed, true); assert.equal(p.unreadable, false);
  assert.equal(p.cues.length, 1);
  const locked = analysisPatch({ bpm: 125, gridOffset: 0.3, bpmLocked: true, key: '8A', cues: [{ index: 0, position: 5 }] }, r);
  assert.equal(locked.bpm, 125); assert.equal(locked.gridOffset, 0.3); assert.equal(locked.key, '8A'); assert.equal(locked.cues, undefined);
  const imported = analysisPatch({ bpm: 124, gridOffset: 0.05, gridLocked: true }, r);
  assert.equal(imported.bpm, 124); assert.equal(imported.gridOffset, 0.05);
  assert.equal(analysisPatch({}, r, { autoCues: false }).cues, undefined);
});
