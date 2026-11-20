// Extra media formats via FFmpeg: detection, transcode-to-FLAC streaming + cache + Range, video remux, 415 without FFmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { parseFile } from 'music-metadata';
import { start } from '../server/index.js';
import { findFfmpeg, needsTranscode, normCodec, remoteBrowserDecodable } from '../server/media.js';
import { Transcoder } from '../server/transcode.js';
import { createClient } from '../server/sources/index.js';

const ff = await findFfmpeg(undefined);
const skip = ff ? false : 'ffmpeg not available (install ffmpeg or npm i ffmpeg-static)';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-fmt-'));
const music = path.join(tmp, 'music');
fs.mkdirSync(music);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gen(name, args) {
  const r = spawnSync(ff.path, ['-hide_banner', '-loglevel', 'error', '-y', ...args, path.join(music, name)]);
  if (r.status !== 0) throw new Error(`fixture ${name}: ${r.stderr}`);
}
/** Decode a media buffer/file with ffmpeg and return its decoded duration in seconds. */
function decodedSeconds(input) {
  const isBuf = Buffer.isBuffer(input);
  const r = spawnSync(ff.path, ['-hide_banner', '-nostats', '-i', isBuf ? 'pipe:0' : input, '-f', 'null', '-'], { input: isBuf ? input : undefined, maxBuffer: 1 << 26 });
  const m = [...String(r.stderr).matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)].pop();
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

let app, base, byName;
before(async () => {
  if (skip) return;
  const sine = ['-f', 'lavfi', '-i', 'sine=f=440:d=3:sample_rate=44100', '-ac', '2'];
  gen('Artist - Lossless.m4a', [...sine, '-c:a', 'alac']);
  gen('Artist - Windows.wma', [...sine, '-c:a', 'wmav2']);
  gen('Artist - Pack.wv', [...sine, '-c:a', 'wavpack']);
  gen('Artist - Plain.wav', [...sine]);
  gen('Artist - Clip.mkv', ['-f', 'lavfi', '-i', 'testsrc=d=3:s=160x120:r=25', ...sine, '-shortest', '-c:v', ff.encoders.libx264 ? 'libx264' : 'mpeg4', '-c:a', 'ac3']);
  if (ff.encoders.libx264) gen('Artist - Web.mp4', ['-f', 'lavfi', '-i', 'testsrc=d=3:s=160x120:r=25', ...sine, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
  app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
  base = app.url.slice(0, -1);
  await app.ffmpegReady;
  await fetch(`${base}/api/folders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: music }) });
  const want = fs.readdirSync(music).length;
  let tracks = [];
  for (let i = 0; i < 200 && tracks.length < want; i++) { await sleep(50); tracks = await (await fetch(`${base}/api/tracks`)).json(); }
  byName = Object.fromEntries(tracks.map((t) => [t.title, t]));
});
after(() => { app?.server.close(); app?.shutdown(); });

test('format rules (no ffmpeg needed)', () => {
  assert.equal(needsTranscode({ ext: '.mp3' }), false);
  assert.equal(needsTranscode({ ext: '.m4a', codec: 'MPEG-4/AAC' }), false);
  assert.equal(needsTranscode({ ext: '.m4a', codec: 'ALAC' }), true);
  for (const e of ['.wma', '.ape', '.wv', '.dsf', '.dff', '.ac3', '.dts', '.mp2', '.amr', '.tta', '.mka', '.au', '.caf', '.aifc', '.mkv', '.avi']) assert.equal(needsTranscode({ ext: e }), true, e);
  assert.equal(needsTranscode({ ext: '.mp4', hasVideo: true }), true);
  assert.equal(normCodec('MPEG4/ISO/AVC'), 'h264');
  assert.equal(normCodec('<avc1>'), 'h264');
  assert.equal(remoteBrowserDecodable('flac'), true);
  assert.equal(remoteBrowserDecodable('wma'), false);
  // media servers transcode for us when OpenDJ has no ffmpeg
  const jf = createClient({ type: 'jellyfin', url: 'http://jf', token: 'T', userId: 'U' });
  assert.match(jf.transcodeRequest('42').url, /\/Audio\/42\/universal\?.*AudioCodec=flac/);
  const ss = createClient({ type: 'subsonic', url: 'http://ss', username: 'u', password: 'p' });
  assert.match(ss.transcodeRequest('7').url, /\/rest\/stream\?.*format=mp3/);
  const px = createClient({ type: 'plex', url: 'http://px', token: 'T' });
  assert.match(px.transcodeRequest('9').url, /transcode\/universal\/start\.mp3/);
});

test('scanner marks needsTranscode / hasVideo / codec', { skip }, () => {
  assert.equal(byName.Lossless.codec, 'alac');
  assert.equal(byName.Lossless.needsTranscode, true);
  assert.equal(byName.Windows.needsTranscode, true);
  assert.equal(byName.Pack.needsTranscode, true);
  assert.equal(byName.Plain.needsTranscode, false);
  assert.equal(byName.Plain.hasVideo, false);
  assert.equal(byName.Clip.hasVideo, true);
  assert.equal(byName.Clip.needsTranscode, true);
  assert.ok(Math.abs(byName.Clip.duration - 3) < 0.2, `mkv duration ${byName.Clip.duration}`);
  if (byName.Web) { assert.equal(byName.Web.hasVideo, true); assert.equal(byName.Web.videoCodec, 'h264'); }
});

test('capabilities report ffmpeg + formats', { skip }, async () => {
  const c = await (await fetch(`${base}/api/capabilities`)).json();
  assert.equal(c.ffmpeg, true);
  assert.ok(c.version);
  for (const f of ['wma', 'ape', 'wv', 'dsf', 'mkv', 'mp3']) assert.ok(c.formats.includes(f), f);
});

for (const name of ['Lossless', 'Windows', 'Pack', 'Clip']) {
  test(`stream transcodes ${name} to decodable FLAC, then serves it from the cache with Range`, { skip }, async () => {
    const t = byName[name];
    const before = app.transcoder.started;
    const r = await fetch(`${base}/api/tracks/${t.id}/stream`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/flac');
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(body.toString('ascii', 0, 4), 'fLaC');
    const secs = decodedSeconds(body);
    assert.ok(Math.abs(secs - 3) < 0.15, `decoded ${secs}s`);
    await sleep(100);
    const cache = path.join(app.library.dataDir, 'transcode-cache', `${t.id}.flac`);
    assert.ok(fs.existsSync(cache), 'cached');
    assert.ok(Math.abs((await parseFile(cache)).format.duration - 3) < 0.15, 'cached file has a proper STREAMINFO duration');
    // cached: no new ffmpeg, Content-Length + Range
    const r2 = await fetch(`${base}/api/tracks/${t.id}/stream`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(r2.status, 206);
    assert.equal((await r2.arrayBuffer()).byteLength, 100);
    assert.equal(app.transcoder.started, before + 1);
  });
}

test('native formats are served as is', { skip }, async () => {
  const r = await fetch(`${base}/api/tracks/${byName.Plain.id}/stream`);
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.equal(Number(r.headers.get('content-length')), fs.statSync(byName.Plain.path).size);
  await r.arrayBuffer();
});

test('video endpoint: mkv remuxed to MP4 (cached), mp4 served directly, audio-only 404', { skip }, async () => {
  const r = await fetch(`${base}/api/tracks/${byName.Clip.id}/video`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.toString('ascii', 4, 8), 'ftyp');
  const f = path.join(tmp, 'out.mp4'); fs.writeFileSync(f, buf);
  const info = spawnSync(ff.path, ['-hide_banner', '-i', f]).stderr.toString();
  assert.match(info, /Video: (h264|mpeg4)/);
  assert.match(info, /Audio: aac/);
  const r2 = await fetch(`${base}/api/tracks/${byName.Clip.id}/video`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(r2.status, 206);
  await r2.arrayBuffer();
  if (byName.Web) {
    const n = app.transcoder.started;
    const w = await fetch(`${base}/api/tracks/${byName.Web.id}/video`);
    assert.equal(w.headers.get('content-type'), 'video/mp4');
    assert.equal(Number(w.headers.get('content-length')), fs.statSync(byName.Web.path).size);
    await w.arrayBuffer();
    assert.equal(app.transcoder.started, n, 'browser-playable video is not transcoded');
  }
  assert.equal((await fetch(`${base}/api/tracks/${byName.Plain.id}/video`)).status, 404);
});

test('remote track in an exotic format: fetched from the media server and transcoded locally', { skip }, async () => {
  const wma = fs.readFileSync(path.join(music, 'Artist - Windows.wma'));
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'Content-Type': 'audio/x-ms-wma' }); res.end(wma); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    app.library.saveSource({ id: 'ss1', type: 'subsonic', name: 'S', url: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p' });
    app.library.upsertTrack({ id: 'remote-wma', sourceType: 'remote', sourceId: 'ss1', remoteId: '5', format: 'wma', title: 'Remote' });
    const r = await fetch(`${base}/api/tracks/remote-wma/stream`);
    assert.equal(r.headers.get('content-type'), 'audio/flac');
    assert.ok(Math.abs(decodedSeconds(Buffer.from(await r.arrayBuffer())) - 3) < 0.15);
    assert.match(seen[0], /\/rest\/stream\?.*format=raw/);
  } finally { srv.close(); }
});

test('without FFmpeg: 415 with a clear message; media server asked to transcode; mp4 served raw', { skip }, async () => {
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(Buffer.alloc(1000)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const app2 = await start({ port: 0, dataDir: path.join(tmp, 'data2'), ffmpeg: path.join(tmp, 'no-such-ffmpeg') });
  try {
    const u = app2.url.slice(0, -1);
    const caps = await (await fetch(`${u}/api/capabilities`)).json();
    assert.equal(caps.ffmpeg, false);
    assert.ok(!caps.formats.includes('wma'));
    const { added } = await (await fetch(`${u}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [path.join(music, 'Artist - Windows.wma')] }) })).json();
    const r = await fetch(`${u}/api/tracks/${added[0]}/stream`);
    assert.equal(r.status, 415);
    const j = await r.json();
    assert.equal(j.code, 'needs-ffmpeg');
    assert.match(j.error, /Install FFmpeg or use the desktop app/);
    app2.library.saveSource({ id: 'ss1', type: 'subsonic', name: 'S', url: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p' });
    app2.library.upsertTrack({ id: 'rw', sourceType: 'remote', sourceId: 'ss1', remoteId: '5', format: 'ape', title: 'R' });
    const rr = await fetch(`${u}/api/tracks/rw/stream`);
    assert.equal(rr.status, 200);
    await rr.arrayBuffer();
    assert.match(seen[0], /format=mp3/);
    if (byName.Web) {
      const v = await (await fetch(`${u}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [byName.Web.path] }) })).json();
      const s = await fetch(`${u}/api/tracks/${v.added[0]}/stream`);
      assert.equal(s.status, 200);
      assert.equal(Number(s.headers.get('content-length')), fs.statSync(byName.Web.path).size);
      await s.arrayBuffer();
    }
  } finally { app2.server.close(); app2.shutdown(); srv.close(); }
});

test('transcoder: client abort kills ffmpeg, concurrency limit 2, no partial cache', { skip: process.platform === 'win32' || skip }, async () => {
  // A fake, slow "ffmpeg": answers -version/-encoders, then just sleeps when asked to convert.
  const fake = path.join(tmp, 'fake-ffmpeg.sh');
  const pids = path.join(tmp, 'pids');
  fs.writeFileSync(fake, `#!/bin/sh\ncase "$*" in *-version*) echo "ffmpeg version 9.9-fake"; exit 0;; *-encoders*) echo " A..... flac"; exit 0;; esac\necho $$ >> ${pids}\nexec sleep 30\n`, { mode: 0o755 });
  const app3 = await start({ port: 0, dataDir: path.join(tmp, 'data3'), ffmpeg: fake });
  try {
    const u = app3.url.slice(0, -1);
    const { added } = await (await fetch(`${u}/api/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: ['Artist - Windows.wma', 'Artist - Pack.wv', 'Artist - Lossless.m4a'].map((f) => path.join(music, f)) }) })).json();
    assert.equal(added.length, 3);
    const ctrls = added.map(() => new AbortController());
    const reqs = added.map((id, i) => fetch(`${u}/api/tracks/${id}/stream`, { signal: ctrls[i].signal }).catch(() => null));
    await sleep(400);
    let st = app3.transcoder.stats();
    assert.equal(st.running, 2, 'two ffmpeg processes');
    assert.equal(st.queued, 1, 'third waits');
    for (const c of ctrls) c.abort();
    await Promise.all(reqs);
    await sleep(400);
    st = app3.transcoder.stats();
    assert.equal(st.running + st.queued, 0);
    assert.equal(app3.transcoder.jobs.size, 0);
    for (const pid of fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number)) {
      assert.throws(() => process.kill(pid, 0), 'ffmpeg process was killed');
    }
    assert.deepEqual(fs.readdirSync(path.join(app3.library.dataDir, 'transcode-cache')), [], 'no partial files');
  } finally { app3.server.close(); app3.shutdown(); }
});

test('transcode cache is an LRU with a size cap', async () => {
  const dir = path.join(tmp, 'lru');
  const tr = new Transcoder({ dir, ffmpeg: () => null, maxBytes: () => 2500, sendFile: () => {} });
  const now = Date.now() / 1000;
  ['a', 'b', 'c'].forEach((n, i) => { const f = tr.file(n, 'flac'); fs.writeFileSync(f, Buffer.alloc(1000)); fs.utimesSync(f, now - 100 + i, now - 100 + i); });
  tr.touch(tr.file('a', 'flac')); // recently used
  await sleep(50);
  await tr.prune(tr.file('c', 'flac'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.flac', 'c.flac']);
});
