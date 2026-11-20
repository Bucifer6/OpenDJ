// Mix recording: WAV/RF64 writer, cue sheets, chunk sequencing, sessions with split, routes, client uploader/tracker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import {
  wavHeader, parseWavHeader, WAV_HEADER_BYTES, WavWriter, convertPcm, cueTime, clockTime, buildCue, buildTracklistText,
  tracksForPart, normTracklist, ChunkReorderer, RecordingSession, registerRecordingRoutes, encoderArgs,
} from '../server/recorder.js';
import { findFfmpeg } from '../server/media.js';
import { TracklistTracker, crossfaderGain } from '../public/js/recording/tracklist.js';
import { ChunkUploader } from '../public/js/recording/uploader.js';
import { miniServer, fakeLibrary } from './recording-helpers.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-rec-'));
const ffmpegP = findFfmpeg();

/** s16le stereo sine, `seconds` long. */
function sine(seconds, sr = 48000, hz = 440) {
  const n = Math.round(seconds * sr), b = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) { const v = Math.round(Math.sin(2 * Math.PI * hz * i / sr) * 12000); b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2); }
  return b;
}

// ---------------------------------------------------------------- WAV / RF64

test('WAV header: RIFF with a reserved JUNK chunk, correct sizes', () => {
  const h = wavHeader({ sampleRate: 48000, channels: 2, bits: 16, dataBytes: 192000 });
  assert.equal(h.length, WAV_HEADER_BYTES);
  assert.equal(h.toString('ascii', 0, 4), 'RIFF');
  assert.equal(h.readUInt32LE(4), 192000 + 72);
  assert.equal(h.toString('ascii', 12, 16), 'JUNK');
  assert.equal(h.readUInt32LE(16), 28);
  assert.equal(h.toString('ascii', 48, 52), 'fmt ');
  assert.equal(h.readUInt16LE(56), 1);
  assert.equal(h.readUInt32LE(64), 48000 * 4); // byte rate
  assert.equal(h.readUInt16LE(68), 4);         // block align
  assert.equal(h.toString('ascii', 72, 76), 'data');
  assert.equal(h.readUInt32LE(76), 192000);
  assert.deepEqual({ ...parseWavHeader(h), riffSize: undefined }, { kind: 'RIFF', rf64: false, channels: 2, sampleRate: 48000, bits: 16, dataBytes: 192000, riffSize: undefined });
});

test('WAV header switches to RF64 with a ds64 chunk past 4 GB', () => {
  const dataBytes = 5 * 2 ** 30; // 5 GiB
  const h = wavHeader({ sampleRate: 44100, channels: 2, bits: 24, dataBytes });
  assert.equal(h.toString('ascii', 0, 4), 'RF64');
  assert.equal(h.readUInt32LE(4), 0xFFFFFFFF);
  assert.equal(h.toString('ascii', 12, 16), 'ds64');
  assert.equal(Number(h.readBigUInt64LE(20)), dataBytes + 72);
  assert.equal(Number(h.readBigUInt64LE(28)), dataBytes);
  assert.equal(Number(h.readBigUInt64LE(36)), Math.floor(dataBytes / 6));
  assert.equal(h.readUInt32LE(76), 0xFFFFFFFF);
  assert.equal(h.readUInt16LE(70), 24);
  const p = parseWavHeader(h);
  assert.equal(p.rf64, true); assert.equal(p.dataBytes, dataBytes);
  // exactly at the limit stays RIFF
  assert.equal(wavHeader({ sampleRate: 44100, dataBytes: 0xFFFFFFFF - 72 }).toString('ascii', 0, 4), 'RIFF');
  assert.equal(wavHeader({ sampleRate: 44100, dataBytes: 0xFFFFFFFF - 71 }).toString('ascii', 0, 4), 'RF64');
});

test('PCM conversion: f32 -> 16/24-bit with clipping, s16 passthrough', () => {
  const f = Buffer.alloc(16); [0.5, -1.5, 1, 0].forEach((v, i) => f.writeFloatLE(v, i * 4));
  const s16 = convertPcm(f, 'f32', 16);
  assert.deepEqual([0, 1, 2, 3].map((i) => s16.readInt16LE(i * 2)), [16384, -32767, 32767, 0]);
  const s24 = convertPcm(f, 'f32', 24);
  assert.equal(s24.length, 12); assert.equal(s24.readIntLE(0, 3), 4194304); assert.equal(s24.readIntLE(3, 3), -8388607);
  const raw = Buffer.from([1, 2, 3, 4]);
  assert.equal(convertPcm(raw, 's16', 16), raw);
});

test('WavWriter writes a file music-metadata reads with the right duration (and a valid header mid-recording)', async () => {
  const dir = tmpDir(), file = path.join(dir, 'a.wav');
  const w = new WavWriter(file, { sampleRate: 48000, headerEveryMs: 0 });
  await w.open();
  await w.write(sine(1));
  const mid = parseWavHeader(fs.readFileSync(file).subarray(0, 80));
  assert.equal(mid.dataBytes, 192000, 'header kept current so a crash leaves a playable file');
  await w.write(sine(1));
  await w.close();
  assert.equal(fs.statSync(file).size, 80 + 384000);
  const mm = await parseFile(file);
  assert.equal(mm.format.sampleRate, 48000);
  assert.ok(Math.abs(mm.format.duration - 2) < 0.01, `duration ${mm.format.duration}`);
  await assert.rejects(new WavWriter(file, { sampleRate: 48000 }).open(), /EEXIST/, 'never overwrites');
});

// ---------------------------------------------------------------- cue sheet / tracklist

test('cue time uses 75 frames per second and does not wrap at 100 minutes', () => {
  assert.equal(cueTime(0), '00:00:00');
  assert.equal(cueTime(61.5), '01:01:38');
  assert.equal(cueTime(6000 + 1 / 75), '100:00:01');
  assert.equal(clockTime(3725), '01:02:05');
  assert.equal(clockTime(65), '01:05');
});

test('cue sheet + text tracklist from played tracks', () => {
  const tracks = [
    { t: 312.4, artist: 'B "Quote"', title: 'Second' },
    { t: 3.2, artist: 'A', title: 'First' },
    { t: 320, artist: 'B "Quote"', title: 'Second' }, // consecutive repeat: dropped
    { t: 3900, artist: '', title: 'Third\nline' },
  ];
  const cue = buildCue({ file: '/x/My mix.mp3', title: 'My mix', performer: 'DJ Test', tracks, format: 'mp3' });
  const lines = cue.split('\r\n');
  assert.ok(lines.includes('PERFORMER "DJ Test"'));
  assert.ok(lines.includes('FILE "My mix.mp3" MP3'));
  assert.deepEqual(lines.filter((l) => /^\s+TRACK/.test(l)), ['  TRACK 01 AUDIO', '  TRACK 02 AUDIO', '  TRACK 03 AUDIO']);
  assert.deepEqual(lines.filter((l) => /INDEX 01/.test(l)).map((l) => l.trim()), ['INDEX 01 00:00:00', 'INDEX 01 05:12:30', 'INDEX 01 65:00:00']);
  assert.ok(lines.includes(`    PERFORMER "B 'Quote'"`), 'quotes are made safe');
  assert.ok(lines.includes('    TITLE "Third line"'), 'newlines removed');
  assert.ok(!lines.some((l) => l.includes('PERFORMER ""')), 'no empty performer');
  assert.match(buildCue({ file: 'a.flac', tracks: [] }), /FILE "a.flac" WAVE/);
  const txt = buildTracklistText({ title: 'My mix', tracks, duration: 4000 });
  assert.equal(txt, 'My mix\n\n01. [00:00:03] A - First\n02. [00:05:12] B "Quote" - Second\n03. [01:05:00] Third\nline\n'.replace('Third\nline', 'Third\nline'));
  assert.match(buildTracklistText({ tracks: [] }), /no tracks detected/);
});

test('tracklist per split part: track playing at the cut starts the part', () => {
  const tracks = [{ t: 0, title: 'A' }, { t: 100, title: 'B' }, { t: 250, title: 'C' }];
  assert.deepEqual(tracksForPart(tracks, 0, 120).map((x) => [x.title, x.t]), [['A', 0], ['B', 100]]);
  assert.deepEqual(tracksForPart(tracks, 120, 240).map((x) => [x.title, x.t]), [['B', 0]]);
  assert.deepEqual(tracksForPart(tracks, 240).map((x) => [x.title, x.t]), [['B', 0], ['C', 10]]);
  assert.equal(normTracklist([{ t: 'x' }, null, { t: 1, title: 'ok' }]).length, 1);
});

// ---------------------------------------------------------------- sequencing

test('chunk reorderer: out-of-order and duplicate chunks are written once, in order', async () => {
  const got = [];
  const r = new ChunkReorderer({ sink: async (b, seq) => { await new Promise((x) => setTimeout(x, 2)); got.push([seq, b.toString()]); } });
  const ps = [r.push(2, Buffer.from('c')), r.push(0, Buffer.from('a')), r.push(2, Buffer.from('dup')), r.push(1, Buffer.from('b'))];
  const res = await Promise.all(ps);
  assert.equal(res[2].duplicate, true);
  await r.push(0, Buffer.from('late dup'));
  await r.push(3, Buffer.from('d'));
  assert.deepEqual(got, [[0, 'a'], [1, 'b'], [2, 'c'], [3, 'd']]);
  assert.equal(r.ack, 3);
  assert.equal(r.duplicates, 2);
  assert.throws(() => r.push(4 + 240, Buffer.from('far')), (e) => e.status === 409);
  assert.throws(() => r.push(-1, Buffer.alloc(0)), (e) => e.status === 400);
});

test('chunk reorderer: finish() waits for stragglers, then fills lost chunks with silence', async () => {
  const got = [];
  const r = new ChunkReorderer({ sink: (b, seq) => { got.push([seq, b.length]); }, gapBytes: 8 });
  await r.push(0, Buffer.alloc(4));
  r.push(3, Buffer.alloc(4));
  setTimeout(() => r.push(1, Buffer.alloc(4)), 30); // arrives during the grace period
  await r.finish(4, { graceMs: 200 });
  assert.deepEqual(got, [[0, 4], [1, 4], [2, 8], [3, 4], [4, 8]]);
  assert.equal(r.gaps, 2);
  assert.throws(() => r.push(5, Buffer.alloc(1)), (e) => e.status === 409);
});

test('chunk reorderer: a failing sink poisons the stream (no silent data loss)', async () => {
  const r = new ChunkReorderer({ sink: () => { throw new Error('disk full'); } });
  await assert.rejects(r.push(0, Buffer.alloc(1)), /disk full/);
  assert.throws(() => r.push(1, Buffer.alloc(1)), /disk full/);
});

// ---------------------------------------------------------------- sessions

test('recording session: WAV with auto-split, per-part cue sheets and text tracklists', async () => {
  const dir = tmpDir();
  const s = new RecordingSession({ dir, format: 'wav', sampleRate: 8000, sampleFormat: 's16', chunkFrames: 4000, splitMinutes: 1 / 60 * 1.5, title: 'Test mix', artist: 'DJ T' }); // split every 1.5 s
  await s.open();
  s.addTrack({ t: 0, artist: 'A', title: 'One' });
  for (let i = 0; i < 8; i++) await s.push(i, sine(0.5, 8000)); // 4 s
  s.addTrack({ t: 2.0, artist: 'B', title: 'Two' });
  const st = await s.stop(7);
  assert.equal(st.state, 'stopped');
  assert.equal(st.seconds, 4);
  assert.deepEqual(st.parts.map((p) => [p.name, p.seconds]), [['Test mix - part 1.wav', 1.5], ['Test mix - part 2.wav', 1.5], ['Test mix - part 3.wav', 1]]);
  for (const p of st.parts) {
    const mm = await parseFile(p.file);
    assert.ok(Math.abs(mm.format.duration - p.seconds) < 0.001, `${p.name}: ${mm.format.duration}`);
  }
  const cue2 = fs.readFileSync(path.join(dir, 'Test mix - part 2.cue'), 'utf8');
  assert.match(cue2, /FILE "Test mix - part 2.wav" WAVE/);
  assert.match(cue2, /TITLE "One"[\s\S]*INDEX 01 00:00:00[\s\S]*TITLE "Two"[\s\S]*INDEX 01 00:00:38/); // 2.0 - 1.5 = 0.5 s = 37.5 frames
  assert.match(fs.readFileSync(path.join(dir, 'Test mix - part 3.txt'), 'utf8'), /01\. \[00:00\] B - Two/);
});

test('recording session: lost chunks become silence so the length stays right', async () => {
  const dir = tmpDir();
  const s = new RecordingSession({ dir, format: 'wav', sampleRate: 8000, sampleFormat: 'f32', chunkFrames: 800, title: 'gaps' });
  await s.open();
  const f32 = Buffer.alloc(800 * 8);
  await s.push(0, f32); s.push(2, f32);
  const st = await s.stop(3, { graceMs: 50 });
  assert.equal(st.gaps, 2);
  assert.equal(st.seconds, 0.4);
  assert.equal(fs.statSync(path.join(dir, 'gaps.wav')).size, 80 + 3200 * 2 * 2);
});

test('recording session: MP3 / FLAC / AAC / Opus through FFmpeg', async (t) => {
  const ff = await ffmpegP;
  if (!ff) return t.skip('FFmpeg not available');
  const dir = tmpDir();
  for (const format of ['mp3', 'flac', 'aac', 'opus']) {
    const s = new RecordingSession({ dir, format, bitrate: 128, sampleRate: 48000, sampleFormat: 's16', chunkFrames: 24000, title: `enc ${format}`, ffmpegPath: ff.path });
    await s.open();
    for (let i = 0; i < 4; i++) await s.push(i, sine(0.5));
    const st = await s.stop(3);
    assert.equal(st.state, 'stopped', st.error);
    const mm = await parseFile(st.file);
    assert.ok(Math.abs(mm.format.duration - 2) < 0.15, `${format} duration ${mm.format.duration}`);
    assert.ok(st.bytes > 1000);
  }
  assert.ok(encoderArgs('mp3', { bitrate: 320 }).includes('320k'));
});

// ---------------------------------------------------------------- routes

test('recording routes: start, chunks out of order, track markers, stop, list, download, delete', async () => {
  const dataDir = tmpDir(), music = tmpDir();
  const lib = fakeLibrary(dataDir);
  const srv = await miniServer((route) => registerRecordingRoutes({ route, library: lib, pathAllowed: (p) => p.startsWith(music) }));
  const j = async (method, url, body) => { const r = await fetch(srv.base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    let r = await j('PUT', '/api/recording/config', { folder: '/etc' });
    assert.equal(r.status, 403, 'folders outside the allowed roots are refused');
    r = await j('PUT', '/api/recording/config', { folder: path.join(music, 'Recs'), format: 'wav' });
    assert.equal(r.body.folder, path.join(music, 'Recs'));
    r = await j('GET', '/api/recording/config');
    assert.equal(r.body.formats.find((f) => f.id === 'mp3').available, false, 'mp3 needs ffmpeg');
    assert.equal((await j('POST', '/api/recording/start', { format: 'mp3', sampleRate: 8000 })).status, 415);
    r = await j('POST', '/api/recording/start', { sampleRate: 8000, sampleFormat: 's16', chunkFrames: 4000, title: 'Route mix' });
    assert.equal(r.status, 200);
    const id = r.body.id;
    const send = (seq) => fetch(`${srv.base}/api/recording/${id}/chunk?seq=${seq}`, { method: 'POST', body: sine(0.5, 8000), headers: { 'Content-Type': 'application/octet-stream' } });
    const res = await Promise.all([send(1), send(0), send(3), send(2)]);
    assert.deepEqual(res.map((x) => x.status), [200, 200, 200, 200]);
    await j('POST', `/api/recording/${id}/track`, { t: 0.2, artist: 'Art', title: 'Song' });
    r = await j('GET', '/api/recording/status');
    assert.equal(r.body.active[0].seconds, 2);
    r = await j('POST', `/api/recording/${id}/stop`, { lastSeq: 3 });
    assert.equal(r.body.state, 'stopped'); assert.equal(r.body.name, 'Route mix.wav');
    assert.equal((await send(4)).status, 404, 'chunks after stop are refused');
    r = await j('GET', '/api/recordings');
    assert.equal(r.body.recordings.length, 1);
    assert.equal(r.body.recordings[0].cue, 'Route mix.cue');
    assert.ok(Math.abs(r.body.recordings[0].duration - 2) < 0.001);
    const ranged = await fetch(`${srv.base}/api/recordings/file?name=${encodeURIComponent('Route mix.wav')}`, { headers: { Range: 'bytes=0-3' } });
    assert.equal(ranged.status, 206); assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), 'RIFF');
    const dl = await fetch(`${srv.base}/api/recordings/file?name=${encodeURIComponent('Route mix.wav')}&download=1`);
    assert.match(dl.headers.get('content-disposition'), /attachment/); await dl.arrayBuffer();
    assert.equal((await fetch(`${srv.base}/api/recordings/file?name=..%2Fx.wav`)).status, 400, 'no path traversal');
    assert.equal((await fetch(`${srv.base}/api/recordings/file?name=secrets.json`)).status, 400);
    r = await j('DELETE', `/api/recordings/file?name=${encodeURIComponent('Route mix.wav')}`);
    assert.deepEqual(r.body.removed.sort(), ['Route mix.cue', 'Route mix.txt', 'Route mix.wav']);
  } finally { await srv.close(); }
});

test('recording routes: abandoned sessions are finished by the watchdog', async () => {
  const music = tmpDir();
  const lib = fakeLibrary(tmpDir());
  let ctl;
  const srv = await miniServer((route) => { ctl = registerRecordingRoutes({ route, library: lib, pathAllowed: () => true, idleMs: 150 }); });
  try {
    await fetch(srv.base + '/api/recording/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: music }) });
    const s = await (await fetch(srv.base + '/api/recording/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sampleRate: 8000 }) })).json();
    await fetch(`${srv.base}/api/recording/${s.id}/chunk?seq=0`, { method: 'POST', body: sine(0.25, 8000) });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(ctl.sessions.size, 0);
    const st = await (await fetch(srv.base + '/api/recording/status')).json();
    assert.match(st.finished[0].error, /No audio received/);
    assert.equal(parseWavHeader(fs.readFileSync(path.join(music, s.name)).subarray(0, 80)).dataBytes, 8000);
  } finally { await ctl.close(); await srv.close(); }
});

// ---------------------------------------------------------------- client logic

test('tracklist tracker logs a track once it has been audible long enough, at the moment it became audible', () => {
  const tr = new TracklistTracker({ minSeconds: 5 });
  const deck = (i, title, audible, level = 1) => ({ index: i, key: title && `id-${title}|${title}`, artist: 'X', title, trackId: `id-${title}`, audible, level });
  assert.deepEqual(tr.update(0, [deck(0, 'A', true), deck(1, 'B', false)]), []);
  assert.deepEqual(tr.update(5, [deck(0, 'A', true), deck(1, 'B', false)]).map((e) => [e.title, e.t]), [['A', 0]]);
  tr.update(60, [deck(0, 'A', true), deck(1, 'B', true)]);       // B fades in at 60
  tr.update(62, [deck(0, 'A', true), deck(1, 'B', false)]);      // ...but was only a short preview: forgotten
  tr.update(70, [deck(0, 'A', true), deck(1, 'B', true)]);
  const e = tr.update(76, [deck(0, 'A', false), deck(1, 'B', true)]);
  assert.deepEqual(e.map((x) => [x.title, x.t, x.deck]), [['B', 70, 1]]);
  tr.update(80, [deck(0, 'A', true), deck(1, 'B', true, 0.5)]);
  assert.deepEqual(tr.update(90, [deck(0, 'A', true), deck(1, 'B', true, 0.5)]).map((x) => x.title), ['A'], 'A played again later');
  assert.equal(tr.logged.length, 3);
  assert.equal(TracklistTracker.nowPlaying([deck(0, 'A', true, 0.4), deck(1, 'B', true, 0.9)]).title, 'B');
  assert.ok(crossfaderGain(-1, 'B') < 1e-9); assert.equal(crossfaderGain(-1, 'A'), 1); assert.equal(crossfaderGain(1, 'THRU'), 1);
});

test('chunk uploader: parallel uploads, retries with backoff, sequence numbers kept', async () => {
  const seen = [];
  let fails = 2;
  const fetch = async (url, o) => {
    const seq = Number(new URL(url, 'http://x').searchParams.get('seq'));
    await new Promise((r) => setTimeout(r, Math.random() * 5));
    if (seq === 1 && fails-- > 0) return seq === 1 && fails === 1 ? Promise.reject(new TypeError('network')) : { ok: false, status: 503, json: async () => ({ error: 'busy' }) };
    seen.push([seq, o.body.byteLength]);
    return { ok: true, status: 200, json: async () => ({ ack: seq }) };
  };
  const u = new ChunkUploader({ url: (s) => `/c?seq=${s}`, fetch, maxInFlight: 3 });
  for (let i = 0; i < 6; i++) u.push(new Int16Array(10 + i));
  assert.equal(await u.drain(5000), true);
  assert.deepEqual(seen.map((x) => x[0]).sort(), [0, 1, 2, 3, 4, 5]);
  assert.equal(seen.find((x) => x[0] === 3)[1], 26);
  assert.equal(u.retries, 2);
  assert.equal(u.lastSeq, 5);
});

test('chunk uploader: fatal answers stop the stream; overflow drops the oldest queued audio', async () => {
  let fatal = null;
  const u = new ChunkUploader({ url: (s) => `/c?seq=${s}`, fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: 'gone' }) }), onFatal: (e) => { fatal = e; } });
  u.push(new Uint8Array(4));
  await u.drain(1000);
  assert.equal(fatal?.message, 'gone');
  let warned = '';
  const slow = new ChunkUploader({ url: () => '/c', maxInFlight: 1, maxQueueBytes: 30, fetch: () => new Promise(() => {}), onWarn: (m) => { warned = m; } });
  for (let i = 0; i < 6; i++) slow.push(new Uint8Array(10));
  assert.equal(slow.dropped, 2); assert.equal(slow.backlogBytes, 30); assert.match(warned, /dropped/);
  slow.abort();
});
