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

test('N9: broadcast User-Agent carries the package.json version', async () => {
  const fs = await import('node:fs');
  const { icecastRequest, VERSION } = await import('../server/broadcast.js');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  const head = String(icecastRequest({ host: 'h', port: 8000, mount: '/live' }, { password: 'x', contentType: 'audio/mpeg', bitrate: 128 }));
  assert.ok(head.includes(`User-Agent: OpenDJ/${pkg.version}\r\n`) || head.includes(`User-Agent: OpenDJ/${pkg.version}\n`), head);
});

test('N10: lyrics in ID3 TXXX frames (LYRICS / UNSYNCEDLYRICS / SYNCEDLYRICS, as ffmpeg writes them)', async () => {
  const { lyricsFromMetadata } = await import('../server/lyrics.js');
  const mm = (id, value) => ({ format: { sampleRate: 44100 }, native: { 'ID3v2.4': [{ id: 'TSSE', value: 'Lavf' }, { id, value }] } });
  const plain = lyricsFromMetadata(mm('TXXX:LYRICS', 'First line\nSecond line'));
  assert.ok(plain && /First line/.test(plain.plain), 'TXXX:LYRICS');
  assert.ok(/Hello/.test(lyricsFromMetadata(mm('TXXX:UNSYNCEDLYRICS', 'Hello')).plain), 'TXXX:UNSYNCEDLYRICS');
  const synced = lyricsFromMetadata(mm('TXXX:SYNCEDLYRICS', '[00:01.00]Hello\n[00:03.50]World'));
  assert.equal(synced.synced.length, 2); assert.equal(synced.synced[1].t, 3.5);
  assert.ok(lyricsFromMetadata(mm('TXXX:lyrics', ['Array value'])), 'case-insensitive, array values');
  assert.equal(lyricsFromMetadata(mm('TXXX:COMMENT', 'not lyrics')), null, 'other TXXX frames are ignored');
});

test('N10: lyrics written by ffmpeg into an MP3 are read back', async (t) => {
  const { findFfmpeg } = await import('../server/media.js');
  const ff = await findFfmpeg().catch(() => null);
  if (!ff?.path) return t.skip('no ffmpeg');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { readEmbedded } = await import('../server/lyrics.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-lyr-'));
  const file = path.join(dir, 't.mp3');
  execFileSync(ff.path, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-metadata', 'lyrics=[00:00.50]Sing along', file]);
  const l = await readEmbedded(file);
  assert.ok(l, 'lyrics found');
  assert.equal(l.synced[0].text, 'Sing along');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('F11: broadcast status says "connecting…" instead of "0 kbps" until bytes flow', async () => {
  const { liveDetail, hms } = await import('../public/js/recording/status.js');
  assert.match(liveDetail({ state: 'live', uptime: 1, kbps: 0, bytes: 0 }), /connecting…/);
  assert.doesNotMatch(liveDetail({ state: 'live', uptime: 2, kbps: 0, bytes: 4096 }), /0 kbps/);
  assert.equal(liveDetail({ state: 'live', uptime: 75, kbps: 128, bytes: 9e5, listeners: 1 }), ' · 1:15 · 128 kbps · 1 listener');
  assert.equal(liveDetail({ state: 'connecting' }), '');
  assert.equal(hms(3725), '1:02:05');
});
