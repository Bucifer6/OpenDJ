import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseLrc, buildLrc, lyricStateAt, lineIndexAt, normalizeLyrics, shiftLyrics, heardTrackTime, formatTime, plainToLines } from '../public/js/lyrics/lrc.js';
import { registerLyricsRoutes, lrclibLookup, syltToLines, lyricsFromMetadata, readEmbedded, readSidecar, decodeText, fromJellyfin, fromSubsonic, LYRICS_USER_AGENT } from '../server/lyrics.js';

const require = createRequire(import.meta.url);
const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b}`);
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-lyr-'));
function ffmpegBin() {
  try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) return p; } catch { /* optional dependency */ }
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch { return null; }
}

// ------------------------------------------------------------------ LRC parser
test('LRC: metadata tags, multiple timestamps per line, sorting, empty lines', () => {
  const r = parseLrc('﻿[ti:Song Title]\n[ar:The Artist]\n[al:Album]\n[by:someone]\n[length: 03:20]\n[00:12.00][01:30.50]Chorus\n[00:05.10]Verse one\n[00:20.00]\n[00:21.5]short frac\n[00:22:50]colon frac\n[01:02.123]millis\n');
  assert.deepEqual(r.meta, { ti: 'Song Title', ar: 'The Artist', al: 'Album', by: 'someone', length: '03:20' });
  assert.deepEqual(r.synced.map((l) => [l.t, l.text]), [[5.1, 'Verse one'], [12, 'Chorus'], [20, ''], [21.5, 'short frac'], [22.5, 'colon frac'], [62.123, 'millis'], [90.5, 'Chorus']]);
  assert.match(r.plain, /^Verse one\nChorus\n\nshort frac/);
});

test('LRC: [offset:] shifts every stamp (+ = earlier), words too', () => {
  const plus = parseLrc('[offset:+500]\n[00:10.00]<00:10.00>a <00:10.50>b\n[00:00.20]start');
  assert.deepEqual(plus.synced.map((l) => l.t), [0, 9.5]); // clamped at 0
  assert.deepEqual(plus.synced[1].words.map((w) => w.t), [9.5, 10]);
  assert.equal(plus.offset, 500);
  const minus = parseLrc('[offset:-250]\n[00:10.00]x');
  assert.equal(minus.synced[0].t, 10.25);
});

test('LRC: enhanced word timing (A2), trailing end stamp, repeated line stamps shift the words', () => {
  const r = parseLrc('[00:05.00]<00:05.00>Hel<00:05.40>lo <00:05.90>world<00:06.60>\n[00:08.00]First <00:08.50>word untimed\n[00:10.00][00:20.00]<00:10.00>re<00:10.30>peat');
  const [a, b, c, d] = r.synced;
  assert.equal(a.text, 'Hello world');
  assert.deepEqual(a.words, [{ t: 5, text: 'Hel' }, { t: 5.4, text: 'lo ' }, { t: 5.9, text: 'world' }]);
  assert.equal(a.end, 6.6);
  assert.deepEqual(b.words, [{ t: 8, text: 'First ' }, { t: 8.5, text: 'word untimed' }]);
  assert.equal(b.text, 'First word untimed');
  assert.deepEqual(c.words.map((w) => w.t), [10, 10.3]);
  assert.deepEqual(d.words.map((w) => w.t), [20, 20.3]);
  // round trip through the writer keeps lines and word stamps
  const back = parseLrc(buildLrc(r));
  assert.deepEqual(back.synced, r.synced);
  assert.match(buildLrc(r), /\[00:05\.00\]<00:05\.00>Hel<00:05\.40>lo <00:05\.90>world<00:06\.60>/);
});

test('LRC: plain text without stamps, formatTime rounding, normalize/shift helpers', () => {
  const r = parseLrc('Just some\nplain lyrics\n');
  assert.equal(r.synced.length, 0); assert.equal(r.plain, 'Just some\nplain lyrics');
  assert.equal(formatTime(59.999), '01:00.00'); assert.equal(formatTime(61.234), '01:01.23');
  const n = normalizeLyrics({ synced: [{ t: '3', text: 'b' }, { t: 1, text: 'a' }, { t: -1, text: 'bad' }, { t: 'x' }] });
  assert.deepEqual(n.synced.map((l) => l.text), ['a', 'b']);
  assert.deepEqual(shiftLyrics(n, 0.5).synced.map((l) => l.t), [1.5, 3.5]);
  assert.deepEqual(plainToLines('a\n\n\nb').map((l) => l.text), ['a', '', 'b']);
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x61, 0, 0x62, 0])), 'ab');
  assert.equal(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'café'); // Latin-1 fallback
});

// ------------------------------------------------------------------ timing vs deck position
test('lyric state follows the deck position; tempo changes how long lines last in real time', () => {
  const lyr = parseLrc('[00:10.00]one\n[00:12.00]<00:12.00>two <00:13.00>words<00:14.00>\n[00:16.00]three');
  assert.equal(lineIndexAt(lyr.synced, 9.99), -1);
  assert.equal(lyricStateAt(lyr, 10).line.text, 'one');
  const s = lyricStateAt(lyr, 13.5);
  assert.equal(s.line.text, 'two words'); assert.equal(s.wordIndex, 1); near(s.wordProgress, 0.5); assert.equal(s.next.text, 'three');
  assert.equal(lyricStateAt(lyr, 15).gap, true, 'after the end stamp = instrumental gap');

  // simulate a deck playing from 9 s at different tempos with 40 ms of output latency
  const lag = 0.04;
  for (const tempo of [-8, 0, 6, 16]) {
    const rate = 1 + tempo / 100;
    const changes = [];
    let last = -2;
    for (let ms = 0; ms <= 9000; ms += 5) {
      const real = ms / 1000;
      const pos = 9 + real * rate; // what deck.position reports (scheduled audio)
      const heard = heardTrackTime(pos, rate, lag);
      const idx = lineIndexAt(lyr.synced, heard);
      if (idx !== last) { changes.push([idx, real]); last = idx; }
    }
    // line k becomes visible when its time is *heard*: real = (t - 9) / rate + lag
    for (const [idx, real] of changes.slice(1)) near(real, (lyr.synced[idx].t - 9) / rate + lag, 0.006, `tempo ${tempo}% line ${idx}`);
  }
  assert.equal(heardTrackTime(5, 1.5, 0.1, false), 5, 'paused: no latency correction');
});

// ------------------------------------------------------------------ ID3 SYLT / USLT and Vorbis tags
const syncsafe = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const id3Frame = (id, body) => Buffer.concat([Buffer.from(id), syncsafe(body.length), Buffer.from([0, 0]), body]);
function id3Tag({ sylt, uslt }) {
  const z = Buffer.from([0]);
  const frames = [];
  if (sylt) {
    frames.push(id3Frame('SYLT', Buffer.concat([Buffer.from([3]), Buffer.from('eng'), Buffer.from([2, 1]), z,
      ...sylt.flatMap(([text, ms]) => { const b = Buffer.alloc(4); b.writeUInt32BE(ms); return [Buffer.from(text, 'utf8'), z, b]; })])));
  }
  if (uslt) frames.push(id3Frame('USLT', Buffer.concat([Buffer.from([3]), Buffer.from('eng'), z, Buffer.from(uslt, 'utf8')])));
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0]), syncsafe(body.length), body]);
}

test('ID3 SYLT (synced, syllables → words) and USLT extracted from a generated MP3', async (t) => {
  const ff = ffmpegBin();
  if (!ff) { t.skip('ffmpeg not available'); return; }
  const dir = tmpdir();
  const raw = path.join(dir, 'raw.mp3');
  execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '0', raw]);
  const file = path.join(dir, 'Song.mp3');
  fs.writeFileSync(file, Buffer.concat([id3Tag({ sylt: [['Hel', 1000], ['lo ', 1400], ['wörld', 1800], ['\nSecond', 2500], [' line', 2900]], uslt: 'Hello wörld\nSecond line' }), fs.readFileSync(raw)]));
  const l = await readEmbedded(file);
  assert.equal(l.source, 'tags');
  assert.deepEqual(l.synced.map((x) => [x.t, x.text]), [[1, 'Hello wörld'], [2.5, 'Second line']]);
  assert.deepEqual(l.synced[0].words, [{ t: 1, text: 'Hel' }, { t: 1.4, text: 'lo ' }, { t: 1.8, text: 'wörld' }]);
  assert.equal(l.plain, 'Hello wörld\nSecond line');
  // only USLT → plain
  const f2 = path.join(dir, 'Plain.mp3');
  fs.writeFileSync(f2, Buffer.concat([id3Tag({ uslt: 'Unsynced words' }), fs.readFileSync(raw)]));
  const p = await readEmbedded(f2);
  assert.equal(p.synced.length, 0); assert.equal(p.plain, 'Unsynced words');
});

test('Vorbis LYRICS comment (FLAC) holding an LRC becomes synced lyrics', async (t) => {
  const ff = ffmpegBin();
  if (!ff) { t.skip('ffmpeg not available'); return; }
  const dir = tmpdir();
  const file = path.join(dir, 'v.flac');
  execFileSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-metadata', 'LYRICS=[00:00.50]first\n[00:01.20]second', file]);
  const l = await readEmbedded(file);
  assert.deepEqual(l.synced.map((x) => [x.t, x.text]), [[0.5, 'first'], [1.2, 'second']]);
});

test('SYLT helpers: MPEG-frame timestamps, entries without newlines, metadata-only common.lyrics', () => {
  const lines = syltToLines([{ text: 'a', timestamp: 38 }, { text: 'b', timestamp: 76 }], { timeStampFormat: 1, sampleRate: 44100 });
  near(lines[0].t, (38 * 1152) / 44100, 1e-9); assert.equal(lines.length, 2);
  const l = lyricsFromMetadata({ native: {}, common: { lyrics: [{ text: '[00:01.00]x\n[00:02.00]y' }] } });
  assert.deepEqual(l.synced.map((x) => x.text), ['x', 'y']);
  assert.equal(lyricsFromMetadata({ native: {}, common: {} }), null);
});

test('media server payloads: Jellyfin ticks and OpenSubsonic structured lyrics', () => {
  const j = fromJellyfin({ Metadata: { Offset: 0 }, Lyrics: [{ Text: 'a', Start: 12_500_000 }, { Text: 'b', Start: 30_000_000 }] });
  assert.deepEqual(j.synced.map((x) => [x.t, x.text]), [[1.25, 'a'], [3, 'b']]);
  assert.equal(fromJellyfin({ Lyrics: [{ Text: 'x' }, { Text: 'y' }] }).plain, 'x\ny');
  const s = fromSubsonic({ lyricsList: { structuredLyrics: [{ synced: true, offset: 100, line: [{ start: 1100, value: 'p' }] }] } });
  assert.deepEqual(s.synced, [{ t: 1, text: 'p' }]);
  assert.equal(fromSubsonic({ lyrics: { value: 'old api' } }).plain, 'old api');
});

// ------------------------------------------------------------------ LRCLIB client (mock server)
function mockServer(handler) {
  const reqs = [];
  const srv = http.createServer((req, res) => { reqs.push({ url: new URL(req.url, 'http://x'), headers: req.headers }); handler(req, res, reqs.at(-1)); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, reqs, url: `http://127.0.0.1:${srv.address().port}` })));
}
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

test('LRCLIB: /api/get with the full signature, generic User-Agent, disk cache, search fallback, cached misses', async () => {
  const m = await mockServer((req, res, r) => {
    if (r.url.pathname === '/api/get' && r.url.searchParams.get('track_name') === 'Known') return json(res, 200, { id: 7, trackName: 'Known', syncedLyrics: '[00:01.00]la la\n[00:03.00]lo', plainLyrics: 'la la\nlo' });
    if (r.url.pathname === '/api/get') return json(res, 404, { code: 404, name: 'TrackNotFound' });
    if (r.url.pathname === '/api/search' && r.url.searchParams.get('track_name') === 'Searchable') {
      return json(res, 200, [{ id: 1, duration: 300, plainLyrics: 'wrong length' }, { id: 2, duration: 181, plainLyrics: 'plain only' }, { id: 3, duration: 179, syncedLyrics: '[00:02.00]synced wins' }]);
    }
    return json(res, 200, []);
  });
  const cacheDir = tmpdir();
  try {
    const opts = { baseUrl: m.url, cacheDir };
    const a = await lrclibLookup({ artist: 'Art', title: 'Known', album: 'Alb', duration: 200.4 }, opts);
    assert.equal(a.source, 'lrclib'); assert.deepEqual(a.synced.map((l) => l.t), [1, 3]);
    const q = m.reqs[0];
    assert.equal(q.headers['user-agent'], LYRICS_USER_AGENT);
    assert.equal(q.url.searchParams.get('duration'), '200');
    assert.equal(q.url.searchParams.get('artist_name'), 'Art'); assert.equal(q.url.searchParams.get('album_name'), 'Alb');
    assert.equal(Object.keys(q.headers).some((h) => /cookie|authorization/i.test(h)), false);
    await lrclibLookup({ artist: 'Art', title: 'Known', album: 'Alb', duration: 200.4 }, opts);
    assert.equal(m.reqs.length, 1, 'second lookup served from the cache');
    await lrclibLookup({ artist: 'Art', title: 'Known', album: 'Alb', duration: 200.4 }, { ...opts, refresh: true });
    assert.equal(m.reqs.length, 2, 'refresh bypasses the cache');
    const s = await lrclibLookup({ artist: 'Art', title: 'Searchable', duration: 180 }, opts); // no album → search
    assert.deepEqual(s.synced.map((l) => l.text), ['synced wins']);
    assert.equal(m.reqs.at(-1).url.pathname, '/api/search');
    const n = m.reqs.length;
    assert.equal(await lrclibLookup({ artist: 'Nobody', title: 'Nothing', album: 'X', duration: 100 }, opts), null);
    const afterMiss = m.reqs.length;
    assert.ok(afterMiss > n);
    assert.equal(await lrclibLookup({ artist: 'Nobody', title: 'Nothing', album: 'X', duration: 100 }, opts), null);
    assert.equal(m.reqs.length, afterMiss, 'misses are cached too');
  } finally { m.srv.close(); }
});

// ------------------------------------------------------------------ routes
function setup({ tracks = {}, sources = [], settings = {} } = {}) {
  const dataDir = tmpdir();
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });
  const library = {
    dataDir, settings, data: { tracks, sources },
    getTrack: (id) => tracks[id], getSource: (id) => sources.find((s) => s.id === id),
    updateSettings(p) { Object.assign(settings, p); return settings; },
  };
  const events = [];
  const call = (method, pattern, { params = {}, body = {}, query = '' } = {}) => routes.find((r) => r.method === method && r.pattern === pattern).handler({ params, body, query: new URLSearchParams(query) });
  return { dataDir, library, routes, route, events, call, emit: (t, p) => events.push([t, p]) };
}

test('lyrics routes: .lrc sidecar, embedded fallback, user edits win, PUT writes .lrc, DELETE, online gating', async () => {
  const music = tmpdir();
  const withLrc = path.join(music, 'With Lrc.wav'); fs.writeFileSync(withLrc, Buffer.alloc(100));
  fs.writeFileSync(path.join(music, 'With Lrc.lrc'), '[ar:A]\n[00:01.00]from sidecar\n[00:02.00]line 2');
  const bare = path.join(music, 'Bare.wav'); fs.writeFileSync(bare, Buffer.alloc(100));
  const m = await mockServer((req, res, r) => (r.url.pathname === '/api/get' ? json(res, 200, { id: 9, syncedLyrics: '[00:04.00]from lrclib' }) : json(res, 404, {})));
  try {
    const tracks = {
      a: { id: 'a', sourceType: 'local', path: withLrc, title: 'With Lrc', artist: 'A' },
      b: { id: 'b', sourceType: 'local', path: bare, title: 'Bare', artist: 'B', album: 'Al', duration: 120 },
    };
    const ctx = setup({ tracks });
    registerLyricsRoutes({ route: ctx.route, library: ctx.library, emit: ctx.emit, lrclibUrl: m.url });
    const a = await ctx.call('GET', '/api/tracks/:id/lyrics', { params: { id: 'a' } });
    assert.equal(a.source, 'lrc'); assert.deepEqual(a.synced.map((l) => l.text), ['from sidecar', 'line 2']);
    // nothing local, online off → nothing, and LRCLIB was not contacted
    const b0 = await ctx.call('GET', '/api/tracks/:id/lyrics', { params: { id: 'b' } });
    assert.equal(b0.source, null); assert.equal(m.reqs.length, 0);
    // explicit user action (?online=1) or the setting allow LRCLIB
    const b1 = await ctx.call('GET', '/api/tracks/:id/lyrics', { params: { id: 'b' }, query: 'online=1' });
    assert.equal(b1.source, 'lrclib'); assert.equal(m.reqs.length, 1);
    assert.deepEqual(await ctx.call('PUT', '/api/lyrics/settings', { body: { online: true } }), { online: true, writeLrc: false });
    assert.equal((await ctx.call('GET', '/api/tracks/:id/lyrics', { params: { id: 'b' } })).source, 'lrclib');
    // user edit wins and can be written as .lrc next to the file
    const saved = await ctx.call('PUT', '/api/tracks/:id/lyrics', { params: { id: 'b' }, body: { synced: [{ t: 0.5, text: 'mine' }, { t: 1.5, text: 'too', words: [{ t: 1.5, text: 'too' }] }], writeLrc: true } });
    assert.equal(saved.source, 'user'); assert.equal(saved.wroteLrc, path.join(music, 'Bare.lrc'));
    const lrc = fs.readFileSync(path.join(music, 'Bare.lrc'), 'utf8');
    assert.match(lrc, /\[ti:Bare\]/); assert.match(lrc, /\[00:00\.50\]mine/); assert.match(lrc, /\[00:01\.50\]<00:01\.50>too/);
    assert.deepEqual((await ctx.call('GET', '/api/tracks/:id/lyrics', { params: { id: 'b' } })).synced.map((l) => l.text), ['mine', 'too']);
    assert.ok(ctx.events.some(([t, p]) => t === 'lyrics' && p.trackId === 'b'));
    // PUT from LRC text
    await ctx.call('PUT', '/api/tracks/:id/lyrics', { params: { id: 'a' }, body: { lrc: '[00:09.00]edited' } });
    assert.equal((await ctx.call('GET', '/api/tracks/:id/lyrics', { params: { id: 'a' } })).synced[0].text, 'edited');
    await ctx.call('DELETE', '/api/tracks/:id/lyrics', { params: { id: 'a' } });
    assert.equal((await ctx.call('GET', '/api/tracks/:id/lyrics', { params: { id: 'a' } })).source, 'lrc');
    await assert.rejects(ctx.call('PUT', '/api/tracks/:id/lyrics', { params: { id: 'a' }, body: { synced: [] } }), /No lyrics/);
    await assert.rejects(ctx.call('GET', '/api/tracks/:id/lyrics', { params: { id: 'zz' } }), /not found/);
  } finally { m.srv.close(); }
});

test('lyrics routes: hosted-mode guard (canRead) hides files outside the allowed roots', async () => {
  const music = tmpdir();
  const f = path.join(music, 'X.wav'); fs.writeFileSync(f, Buffer.alloc(10)); fs.writeFileSync(path.join(music, 'X.lrc'), '[00:01.00]secret');
  const ctx = setup({ tracks: { x: { id: 'x', sourceType: 'local', path: f } } });
  registerLyricsRoutes({ route: ctx.route, library: ctx.library, canRead: () => false });
  assert.equal((await ctx.call('GET', '/api/tracks/:id/lyrics', { params: { id: 'x' } })).source, null);
  await assert.rejects(ctx.call('PUT', '/api/tracks/:id/lyrics', { params: { id: 'x' }, body: { plain: 'p', writeLrc: true } }), /only be written next to local files/);
  assert.ok(await readSidecar(f)); // the helper itself reads it
});

test('lyrics routes: Jellyfin and Subsonic media servers', async () => {
  const m = await mockServer((req, res, r) => {
    if (r.url.pathname === '/Audio/jf1/Lyrics') return json(res, 200, { Metadata: {}, Lyrics: [{ Text: 'jelly', Start: 20_000_000 }] });
    if (r.url.pathname === '/rest/getLyricsBySongId') return json(res, 200, { 'subsonic-response': { status: 'ok', lyricsList: { structuredLyrics: [{ synced: true, line: [{ start: 3000, value: 'sonic' }] }] } } });
    return json(res, 404, {});
  });
  try {
    const sources = [
      { id: 'jf', type: 'jellyfin', url: m.url, token: 'tok', userId: 'u' },
      { id: 'ss', type: 'subsonic', url: m.url, username: 'u', password: 'p' },
    ];
    const tracks = {
      j: { id: 'j', sourceType: 'remote', sourceId: 'jf', remoteId: 'jf1', title: 'J' },
      s: { id: 's', sourceType: 'remote', sourceId: 'ss', remoteId: 'ss1', title: 'S', artist: 'A' },
    };
    const ctx = setup({ tracks, sources });
    registerLyricsRoutes({ route: ctx.route, library: ctx.library });
    const j = await ctx.call('GET', '/api/tracks/:id/lyrics', { params: { id: 'j' } });
    assert.equal(j.source, 'server'); assert.deepEqual(j.synced, [{ t: 2, text: 'jelly' }]);
    const s = await ctx.call('GET', '/api/tracks/:id/lyrics', { params: { id: 's' } });
    assert.deepEqual(s.synced, [{ t: 3, text: 'sonic' }]);
  } finally { m.srv.close(); }
});
