// Regression tests for issues found by end-to-end user testing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoCuesFor } from '../public/js/audio/analysis-core.js';
import { cueLists } from '../server/cdj/model.js';
import { buildRekordboxXml } from '../server/rekordbox.js';

test('F2: auto "Mix in" / "Mix out" are memory cues: they never take a CDJ / rekordbox hot-cue slot', () => {
  const cues = autoCuesFor([
    { start: 0.2, end: 30, type: 'intro', energy: 0.4, bars: 16 },
    { start: 30, end: 90, type: 'drop', energy: 1, bars: 32 },
    { start: 90, end: 120, type: 'outro', energy: 0.4, bars: 16 },
  ], { mixIn: 0.2, mixOut: 90, downbeat: 0.2 });
  const { hotCues, memoryCues } = cueLists({ bpm: 128, cues });
  assert.equal(hotCues.length, cues.filter((c) => c.index >= 0).length);
  assert.equal(memoryCues.length, 2);
  const xml = buildRekordboxXml({ tracks: [{ id: 'x', title: 't', path: '/m/t.mp3', bpm: 128, cues }] });
  for (const n of ['Mix in', 'Mix out']) assert.match(xml, new RegExp(`Name="${n}"[^>]*Num="-1"`));
});
