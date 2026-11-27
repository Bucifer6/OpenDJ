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

test('ID3v2.4 tag write-back preserves large syncsafe frames (APIC) and rejects unsynced tags', () => {
  const audioPayload = Buffer.from([0xff, 0xfb, 0x90, 0x00, 9, 8, 7, 6]);
  // Build a synthetic ID3v2.4 tag with a 300-byte APIC frame (syncsafe size > 127)
  const apicPayload = Buffer.alloc(300, 0xab);
  const syncsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
  const apicFrame = Buffer.concat([Buffer.from('APIC', 'ascii'), syncsafe(apicPayload.length), Buffer.from([0, 0]), apicPayload]);
  const v24 = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([4, 0, 0]), syncsafe(apicFrame.length), apicFrame, audioPayload]);

  const patched = patchMp3Tags(v24, { bpm: 128, key: '8A' });
  assert.equal(patched[3], 4, 'preserves ID3v2.4 major version');
  const parsed = parseId3v2(patched);
  assert.equal(parsed.ver, 4);
  assert.equal(parsed.frames.filter((f) => f.id === 'APIC').length, 1, 'large v2.4 APIC frame preserved intact');
  assert.equal(parsed.frames.find((f) => f.id === 'APIC').raw.length, 10 + 300, 'APIC frame size intact');
  assert.deepEqual(patched.subarray(parsed.audioOffset), audioPayload, 'audio payload intact');

  // Globally unsynchronised tag (flag 0x80) is rejected rather than corrupted
  const unsync = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0x80]), syncsafe(0), audioPayload]);
  assert.throws(() => parseId3v2(unsync), /Unsynchronised/);
});

test('E2E HTTP security & functionality: FTS5 search, write-tags, chunked PCM, SQLite playCount, COOP/COEP', async () => {
  const { start } = await import('../server/index.js');
  const { Library } = await import('../server/library.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-pro-e2e-'));
  const musicDir = path.join(dir, 'music');
  fs.mkdirSync(musicDir, { recursive: true });
  // Create a valid 2-second 44.1 kHz mono WAV file for real FFmpeg PCM streaming + an MP3 for tag write-back
  const sr = 44100, nSamples = sr * 2;
  const wav = Buffer.alloc(44 + nSamples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + nSamples * 2, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(nSamples * 2, 40);
  for (let i = 0; i < nSamples; i++) wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * 12000), 44 + i * 2);
  const wavPath = path.join(musicDir, 'sine-test.wav');
  fs.writeFileSync(wavPath, wav);
  const mp3Path = path.join(musicDir, 'tag-test.mp3');
  const mp3Payload = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]);
  fs.writeFileSync(mp3Path, mp3Payload);

  const dataDir = path.join(dir, 'data');
  const app = await start({ port: 0, dataDir, roots: [musicDir] });
  try {
    // 1. COOP / COEP headers on HTML
    const home = await fetch(app.url);
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(home.headers.get('cross-origin-embedder-policy'), 'credentialless');

    // Add both files to library
    const tWav = app.library.upsertTrack({ id: 'wav-1', title: 'Ștefan Club Anthem', artist: 'DJ Aurora', genre: 'House', sourceType: 'local', path: wavPath, bpm: 126, key: '8A' });
    const tMp3 = app.library.upsertTrack({ id: 'mp3-1', title: 'Midnight Pulse', artist: 'Solaris', genre: 'Techno', sourceType: 'local', path: mp3Path, bpm: 130, key: '6A', cues: [{ index: 0, position: 8, name: 'Drop', color: '#ff3b4d' }] });
    app.library.flush();

    // 2. FTS5 search including Unicode and hostile SQL/FTS injection payload
    const hitUnicode = await (await fetch(`${app.url}api/tracks/search?q=${encodeURIComponent('Ștefan')}`)).json();
    assert.equal(hitUnicode.length, 1);
    assert.equal(hitUnicode[0].id, tWav.id);
    const hostile = await fetch(`${app.url}api/tracks/search?q=${encodeURIComponent('a" OR 1=1; DROP TABLE tracks;--')}&limit=Infinity`);
    assert.equal(hostile.status, 200);
    assert.ok(Array.isArray(await hostile.json()), 'hostile FTS query handled safely');

    // 3. Tag write-back via HTTP API: MP3 succeeds, WAV fails cleanly with 400
    const wrOk = await fetch(`${app.url}api/tracks/${tMp3.id}/write-tags`, { method: 'POST' });
    assert.equal(wrOk.status, 200);
    const onDisk = fs.readFileSync(mp3Path);
    assert.deepEqual(onDisk.subarray(parseId3v2(onDisk).audioOffset), mp3Payload);
    const wrBad = await fetch(`${app.url}api/tracks/${tWav.id}/write-tags`, { method: 'POST' });
    assert.equal(wrBad.status, 400);

    // 4. Chunked PCM streaming via FFmpeg (if FFmpeg is present) + NaN/Infinity query resilience
    const caps = await (await fetch(`${app.url}api/capabilities`)).json();
    if (caps.ffmpeg) {
      const pcmRes = await fetch(`${app.url}api/tracks/${tWav.id}/pcm?start=0&dur=1&sr=22050`);
      assert.equal(pcmRes.status, 200);
      const pcmBuf = Buffer.from(await pcmRes.arrayBuffer());
      // 1 s of stereo Int16 at 22050 Hz ≈ 88,200 bytes
      assert.ok(pcmBuf.length >= 44100, `expected stereo Int16 PCM bytes, got ${pcmBuf.length}`);
      const pcmClamp = await fetch(`${app.url}api/tracks/${tWav.id}/pcm?start=Infinity&dur=1&sr=22050`);
      assert.equal(pcmClamp.status, 200);
      await pcmClamp.arrayBuffer();
    }

    // 5. POST /api/tracks/played persists directly to SQLite (verified with library.json removed)
    const playRes = await fetch(`${app.url}api/tracks/played`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: tMp3.id }) });
    assert.equal(playRes.status, 200);
    app.library.flush();
    try { fs.unlinkSync(path.join(dataDir, 'library.json')); } catch { /* */ }
    const reloaded = new Library(dataDir);
    assert.equal(reloaded.getTrack(tMp3.id)?.playCount, 1, 'playCount persisted to SQLite');
    reloaded.close();
  } finally {
    app.shutdown();
    app.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Error handling & recovery: corrupt library.db quarantine, search fallback, PV NaN recovery, curve overlap recovery', async () => {
  const { Library } = await import('../server/library.js');
  const { StereoPhaseVocoder } = await import('../public/js/audio/phase-vocoder.js');
  const { Channel } = await import('../public/js/audio/engine.js');

  // 1. Corrupt library.db is quarantined and recovered from library.json
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-rec-'));
  try {
    const lib1 = new Library(dir);
    lib1.upsertTrack({ id: 'rec-1', title: 'Phoenix Rise', artist: 'Recovery DJ', sourceType: 'local', path: '/music/phoenix.mp3', bpm: 126 });
    lib1.flush();
    lib1.close();
    // Corrupt library.db with garbage bytes
    fs.writeFileSync(path.join(dir, 'library.db'), Buffer.from('NOT_A_VALID_SQLITE_DATABASE_HEADER_CORRUPT'));
    const lib2 = new Library(dir);
    assert.equal(lib2.getTrack('rec-1')?.title, 'Phoenix Rise', 'recovered track from library.json after corrupt library.db');
    assert.ok(lib2.loadErrors.some((e) => /quarantined/i.test(e)), 'reports quarantine warning to UI');
    const files = fs.readdirSync(dir);
    assert.ok(files.some((f) => f.startsWith('library.db.corrupt-')), 'corrupt db file preserved aside');
    // 2. searchTracks gracefully falls back to in-memory search when SQLite throws
    if (lib2.sqlite) lib2.sqlite.searchIds = () => { throw new Error('SQLITE_BUSY simulated'); };
    const hits = lib2.searchTracks('Phoenix');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 'rec-1');
    lib2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 3. StereoPhaseVocoder recovers cleanly from NaN samples / non-finite rates without latching NaN
  const pv = new StereoPhaseVocoder();
  const out = new Float32Array(2);
  let call = 0;
  const badReader = (_pos, dst) => {
    call++;
    if (call >= 100 && call <= 120) { dst[0] = NaN; dst[1] = Infinity; }
    else { dst[0] = Math.sin(call * 0.05) * 0.3; dst[1] = Math.cos(call * 0.05) * 0.3; }
  };
  for (let i = 0; i < 4096; i++) {
    pv.nextSample(badReader, i === 500 ? NaN : i, i === 600 ? Infinity : 1.05, 1.0, i === 700 ? -5 : 1.0, out);
    assert.ok(Number.isFinite(out[0]) && Number.isFinite(out[1]), `sample ${i} stayed finite`);
  }

  // 4. Channel.scheduleCurve catches overlapping Web Audio curve errors gracefully and returns false
  const ch = Object.create(Channel.prototype);
  ch.ctx = { currentTime: 10 };
  ch.pst = { fader: {}, postFader: {} };
  const throwingParam = {
    value: 1,
    cancelScheduledValues() {},
    setValueCurveAtTime() { throw new Error('NotSupportedError: overlaps previously scheduled curve'); },
  };
  ch.fader = { gain: throwingParam };
  ch.postFader = { gain: throwingParam };
  assert.equal(ch.scheduleCurve('volume', [1, 0], 10, 2), false, 'returns false cleanly on Web Audio overlap error');
  assert.equal(ch.scheduleCurve('volume', [1], 10, 2), false, 'rejects curve with <2 points');
});
