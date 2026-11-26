import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchMp3Tags, parseId3v2, buildSeratoMarkers2, writeTrackTagsToFile } from '../server/tag-writer.js';
import { PRESETS } from '../public/js/midi/presets.js';
import { Engine } from '../public/js/audio/engine.js';
import { sanitizeSetting } from '../public/js/shared/settings-schema.js';

test('ID3v2 + Serato GEOB tag write-back preserves existing frames and audio payload', async () => {
  // Fake MP3 audio frames
  const audioPayload = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]);
  // First write on a tagless MP3
  const patched1 = patchMp3Tags(audioPayload, {
    bpm: 126.5,
    key: '8A',
    color: '#3ea6ff',
    cues: [
      { index: 0, position: 12.345, name: 'Drop', color: '#ff3b4d' },
      { index: 1, position: 64.0, name: 'Break', color: '#2ed47a' },
    ],
  });
  const parsed1 = parseId3v2(patched1);
  assert.deepEqual(patched1.subarray(parsed1.audioOffset), audioPayload, 'MP3 audio bytes untouched');
  assert.ok(parsed1.frames.some((f) => f.id === 'TBPM'), 'TBPM written');
  assert.ok(parsed1.frames.some((f) => f.id === 'TKEY'), 'TKEY written');
  assert.ok(parsed1.frames.some((f) => f.id === 'GEOB' && f.desc === 'Serato Markers2'), 'Serato Markers2 GEOB written');

  // Re-patching updates TBPM without duplicating frames
  const patched2 = patchMp3Tags(patched1, { bpm: 128 });
  const parsed2 = parseId3v2(patched2);
  assert.equal(parsed2.frames.filter((f) => f.id === 'TBPM').length, 1, 'no duplicate TBPM');
  assert.equal(parsed2.frames.filter((f) => f.id === 'GEOB').length, 1, 'existing Serato GEOB preserved');
  assert.deepEqual(patched2.subarray(parsed2.audioOffset), audioPayload, 'MP3 audio bytes still identical');

  // Atomic file write test
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-tag-'));
  try {
    const mp3 = path.join(dir, 'track.mp3');
    fs.writeFileSync(mp3, audioPayload);
    const r = await writeTrackTagsToFile(mp3, { bpm: 124, key: '9A', cues: [{ index: 0, position: 4, name: 'Intro', color: '#3ea6ff' }] });
    assert.equal(r.ok, true);
    const onDisk = fs.readFileSync(mp3);
    assert.deepEqual(onDisk.subarray(parseId3v2(onDisk).audioOffset), audioPayload);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  void buildSeratoMarkers2;
});

test('bundled pro controller presets auto-match major working-DJ hardware', () => {
  const names = ['DDJ-FLX10', 'Pioneer DDJ-1000', 'DDJ-FLX6', 'DDJ-SB3', 'DDJ-REV1', 'Mixtrack Platinum FX', 'DJControl Inpulse 500', 'Denon MC4000', 'Reloop Buddy'];
  for (const dev of names) {
    const m = PRESETS.find((p) => p.match.test(dev));
    assert.ok(m, `no preset matched ${dev}`);
    assert.ok(m.entries.length >= 20, `${dev} preset has ${m.entries.length} entries`);
  }
});

test('Engine.audioHealth reports latency/channels/dropouts and gigMode validates in schema', () => {
  assert.deepEqual(sanitizeSetting('gigMode', true), { ok: true, value: true });
  assert.deepEqual(sanitizeSetting('gigMode', false), { ok: true, value: false });
  const e = new Engine({ gigMode: true });
  e.ctx = { state: 'running', sampleRate: 48000, baseLatency: 0.0053, outputLatency: 0.0112, destination: { maxChannelCount: 4, channelCount: 4 }, playbackStats: { underrunEvents: 0 } };
  const h = e.audioHealth();
  assert.equal(h.sampleRate, 48000);
  assert.equal(h.maxChannels, 4);
  assert.equal(h.totalLatencyMs, 16.5);
  assert.equal(h.dropouts, 0);
  assert.equal(h.gigMode, true);
});
