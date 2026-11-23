// "Render this set" (docs/PRO_DJ_AUTOMIX_RESEARCH.md P6.5): the set's sequencing, without audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeline, planSet, transitionSpan, wavHeader, exportFileName, POST_BARS } from '../public/js/automix-export.js';

function track(id, extra = {}) {
  return { id, title: `T${id}`, bpm: 120, bpmConfidence: 0.9, key: '8A', energy: 6, genre: 'House', duration: 256,
    downbeat: 0, gridOffset: 0, mixIn: 0, mixOut: 224, gain: -2,
    phrases: Array.from({ length: 8 }, (_, i) => ({ start: i * 32, end: (i + 1) * 32, type: i === 0 ? 'intro' : i === 7 ? 'outro' : 'breakdown', energy: 0.6 })), ...extra };
}
const close = (a, b, msg, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

function checkContiguous(tl) {
  let t = 0;
  for (const s of tl.segments) { close(s.at, t, `segment at ${s.kind}`); assert.ok(s.seconds > 0); t += s.seconds; }
  close(tl.seconds, t, 'total length');
}

test('planSet plans every pair after the previous transition, entering each track at its planned cue', () => {
  const tracks = [track('a'), track('b', { bpm: 124 }), track('c', { bpm: 62 }), track('d')];
  const plans = planSet(tracks, { start: 20, entry: 0, rate: 1 });
  assert.equal(plans.length, 3);
  let pos = 20;
  plans.forEach((p, i) => {
    assert.equal(p.outTrack.id, tracks[i].id); assert.equal(p.inTrack.id, tracks[i + 1].id);
    assert.ok(p.begin >= pos, `transition ${i} begins after the track was entered (${p.begin} >= ${pos})`);
    assert.equal(p.outRate, 1, 'tracks play at their native tempo');
    pos = transitionSpan(p).inTo;
  });
  close(plans[0].innRate, 120 / 124, 'incoming beat-matched to the outgoing tempo');
  close(plans[1].innRate, 124 / 124, 'half/double tempo aware (124 into 62)');
});

test('setTimeline: contiguous segments, every track entered at its cue, total length', () => {
  const tracks = [track('a'), track('b'), track('c')];
  const plans = planSet(tracks, { start: 10 });
  const tl = setTimeline(tracks, plans, { start: 10 });
  checkContiguous(tl);
  assert.equal(tl.cut, false);
  assert.deepEqual(tl.segments.map((s) => s.kind), ['track', 'transition', 'track', 'transition', 'track']);
  const [a, ab, b, bc, c] = tl.segments;
  assert.equal(a.from, 10); close(a.to, plans[0].begin, 'A plays to the transition');
  assert.equal(ab.from, plans[0].begin); assert.equal(ab.inFrom, plans[0].inStart, 'B entered at its planned cue');
  close(b.from, ab.inTo, 'B continues from where the transition left it');
  close(b.to, plans[1].begin, 'B plays to its transition'); assert.equal(bc.inFrom, plans[1].inStart);
  close(c.from, bc.inTo, 'C continues'); close(c.to, 256, 'the last track plays to its end');
  const expected = (plans[0].begin - 10) + transitionSpan(plans[0]).seconds + (plans[1].begin - ab.inTo) + transitionSpan(plans[1]).seconds + (256 - bc.inTo);
  close(tl.seconds, expected, 'total');
  // the tail: POST_BARS of the incoming track at the outgoing tempo after the handover
  close(transitionSpan(plans[0]).post, POST_BARS * 2, 'post bars');
});

test('setTimeline: drop transitions enter the incoming track at the drop, and a rate on the first track', () => {
  const tracks = [{ id: 'a', duration: 200 }, { id: 'b', duration: 180 }];
  const plans = [{ style: 'echo', begin: 150, drop: 166, len: 0, inStart: 8, outRate: 1.04, innRate: 1, beatLen: 0.5 }];
  const tl = setTimeline(tracks, plans, { start: 100 });
  checkContiguous(tl);
  const [a, ab, b] = tl.segments;
  close(a.seconds, 50 / 1.04, 'first track at its deck rate');
  close(ab.seconds, 16 / 1.04 + POST_BARS * 2, 'drop span + tail');
  close(ab.inTo, 8 + POST_BARS * 2, 'incoming from the drop');
  assert.equal(b.rate, 1); close(b.to, 180, 'to the end');
});

test('setTimeline: maxMinutes stops at a transition boundary, never past the limit', () => {
  const tracks = [track('a'), track('b'), track('c')];
  const plans = planSet(tracks, { start: 0 });
  const full = setTimeline(tracks, plans);
  const t2 = full.segments[3]; // the second transition
  // a limit inside the second transition: the set ends where it would begin
  const tl = setTimeline(tracks, plans, { maxSeconds: t2.at + t2.seconds / 2 });
  checkContiguous(tl);
  assert.equal(tl.cut, true);
  assert.deepEqual(tl.segments.map((s) => s.kind), ['track', 'transition', 'track']);
  close(tl.seconds, t2.at, 'ends at the transition boundary');
  // a limit inside a plain stretch: cut there
  const mid = full.segments[2].at + 5;
  const tl2 = setTimeline(tracks, plans, { maxSeconds: mid });
  checkContiguous(tl2); assert.equal(tl2.cut, true); close(tl2.seconds, mid, 'cut at the limit');
  // a limit inside the first transition: only the first stretch
  const tl3 = setTimeline(tracks, plans, { maxSeconds: full.segments[1].at + 1 });
  assert.deepEqual(tl3.segments.map((s) => s.kind), ['track']);
  for (const max of [30, 100, 200, 300, 400, 10000]) assert.ok(setTimeline(tracks, plans, { maxSeconds: max }).seconds <= max + 1e-9);
});

test('setTimeline: a missing or overlapping plan ends the set with that track played out', () => {
  const tracks = [{ id: 'a', duration: 100 }, { id: 'b', duration: 100 }];
  const tl = setTimeline(tracks, [], { start: 10 });
  assert.equal(tl.segments.length, 1); close(tl.seconds, 90, 'played to the end');
  const bad = setTimeline(tracks, [{ begin: 5, len: 8, inStart: 0, outRate: 1, innRate: 1, beatLen: 0.5 }], { start: 10 });
  assert.equal(bad.segments.length, 1);
});

test('WAV header and file name', () => {
  const h = new DataView(wavHeader(48000, 48000));
  const str = (o) => String.fromCharCode(...new Uint8Array(h.buffer, o, 4));
  assert.equal(str(0), 'RIFF'); assert.equal(str(8), 'WAVE'); assert.equal(str(36), 'data');
  assert.equal(h.getUint32(40, true), 48000 * 4); assert.equal(h.getUint16(22, true), 2); assert.equal(h.getUint16(34, true), 16);
  assert.equal(exportFileName(new Date(2026, 10, 23, 9, 5)), 'OpenDJ set 2026-11-23 0905.wav');
});
