// The mobile app's on-device backend (public/js/local/): dispatcher, storage abstraction (in-memory fakes), import with
// tag reading, playlists / smart playlists, rekordbox XML + M3U matching, exports, recording, media-server secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as mm from 'music-metadata';
import { XMLParser } from 'fast-xml-parser';
import { Router, HttpError, parseBody, EventHub, attachment } from '../public/js/local/dispatcher.js';
import { MemoryFS, checkPath } from '../public/js/local/storage/fs.js';
import { MemoryKV } from '../public/js/local/storage/kv.js';
import { createLocalBackend, parseApi } from '../public/js/local/backend.js';
import { checkFormat, keySafe } from '../public/js/local/media.js';
import { trackMatcher, parseTitleFromName, deviceTrackId } from '../public/js/local/importer.js';
import { scrub, capacitorFetch } from '../public/js/local/sources.js';
import { wavHeader, parseWavHeader, recordingFormats } from '../public/js/local/recording.js';
import { dispositionName } from '../public/js/local/share.js';
import { sha1Hex, md5Hex } from '../public/js/shared/hash.js';
import { APP_VERSION } from '../public/js/platform.js';
import fs from 'node:fs';
import crypto from 'node:crypto';

function wav(seconds = 1, sr = 8000) {
  const n = Math.round(seconds * sr), b = new Uint8Array(44 + n * 4);
  b.set(wavHeader({ sampleRate: sr, dataBytes: n * 4 }));
  const v = new DataView(b.buffer);
  for (let i = 0; i < n; i++) { const s = Math.round(Math.sin(i / 10) * 8000); v.setInt16(44 + i * 4, s, true); v.setInt16(46 + i * 4, s, true); }
  return b;
}
const file = (bytes, name) => new File([bytes], name);
async function backend(extra = {}) {
  const b = await createLocalBackend({ kv: new MemoryKV(), fs: new MemoryFS(), mm, XMLParser, canPlayType: () => false, log: { error() {}, warn() {} }, ...extra });
  const call = async (method, url, body, headers = {}) => {
    const isBin = body instanceof Blob || body instanceof Uint8Array;
    const r = await b.handle(method, url, { body: body === undefined || isBin ? body : JSON.stringify(body), headers: isBin ? headers : { 'Content-Type': 'application/json', ...headers } });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: type.includes('json') ? await r.json() : r.status === 204 ? null : await r.blob() };
  };
  const upload = (bytes, name) => call('POST', '/api/upload', file(bytes, name), { 'X-Filename': encodeURIComponent(name) });
  return { b, call, upload };
}

test('version constant matches package.json', () => {
  assert.equal(APP_VERSION, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
});

test('shared hashes match node:crypto (media-server clients)', () => {
  for (const s of ['', 'opendj', 'pässwörd🎧'.repeat(9)]) {
    assert.equal(sha1Hex(s), crypto.createHash('sha1').update(s).digest('hex'));
    assert.equal(md5Hex(s), crypto.createHash('md5').update(s).digest('hex'));
  }
});

test('dispatcher: routes, params, JSON / binary bodies, errors like the server', async () => {
  const r = new Router({ log: { error() {} } });
  r.route('GET', '/api/x/:id', ({ params, query }) => ({ id: params.id, q: query.get('q') }));
  r.route('POST', '/api/echo', ({ body }) => ({ body: body instanceof Uint8Array ? [...body] : body }));
  r.route('GET', '/api/fail', () => { throw new HttpError(418, 'teapot', 'tea'); });
  r.route('GET', '/api/crash', () => { throw new Error('boom'); });
  r.route('GET', '/api/none', () => undefined);
  r.route('GET', '/api/file', () => attachment('a,b', 'text/csv', 'Set: 1.csv'));
  assert.deepEqual(await (await r.handle('GET', '/api/x/a%2Fb?q=1')).json(), { id: 'a/b', q: '1' });
  assert.deepEqual(await (await r.handle('HEAD', '/api/x/1')).json(), { id: '1', q: null });
  assert.deepEqual(await (await r.handle('POST', '/api/echo', { body: '{"a":1}', headers: { 'Content-Type': 'application/json' } })).json(), { body: { a: 1 } });
  assert.deepEqual(await (await r.handle('POST', '/api/echo', { body: new Uint8Array([1, 2]) })).json(), { body: [1, 2] });
  const bad = await r.handle('POST', '/api/echo', { body: '{nope', headers: { 'content-type': 'application/json' } });
  assert.equal(bad.status, 400);
  const f = await r.handle('GET', '/api/fail');
  assert.equal(f.status, 418); assert.deepEqual(await f.json(), { error: 'teapot', code: 'tea' });
  assert.equal((await r.handle('GET', '/api/crash')).status, 500);
  assert.equal((await r.handle('GET', '/api/nothing')).status, 404);
  assert.equal((await r.handle('GET', '/api/none')).status, 204);
  const a = await r.handle('GET', '/api/file');
  assert.equal(dispositionName(a.headers.get('content-disposition')), 'Set: 1.csv');
  assert.ok((await parseBody(new Blob(['x']))) instanceof Blob, 'files stay Blobs (no copy)');
});

test('event hub replays startup warnings to the first subscriber', async () => {
  const h = new EventHub(); h.pending.push('damaged');
  const got = [];
  h.subscribe((t, p) => got.push([t, p]));
  h.emit('library', { what: 'tracks' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(got.map((x) => x[0]), ['library', 'hello', 'job-error']);
});

test('storage: paths are confined, memory fakes behave like the real stores', async () => {
  for (const p of ['../x', 'a//b', 'a/./b', '/abs', 'a\\b', 'sp ace', '']) assert.throws(() => checkPath(p), /Bad storage path/, p);
  assert.doesNotThrow(() => checkPath('music/ab12.mp3'));
  const f = new MemoryFS();
  await f.write('a/b.bin', new Uint8Array([1, 2, 3]));
  assert.equal((await f.stat('a/b.bin')).size, 3);
  assert.deepEqual((await f.list('a')).map((x) => x.name), ['b.bin']);
  const ap = f.appender('rec/x.wav', { headerBytes: 4 });
  await ap.write(new Uint8Array([9, 9])); await ap.write(new Uint8Array([8]));
  await ap.close(new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual([...new Uint8Array(await (await f.read('rec/x.wav')).arrayBuffer())], [1, 2, 3, 4, 9, 9, 8]);
  assert.match(await f.url('a/b.bin'), /^blob:/);
  assert.equal(f.urlSync('a/b.bin'), await f.url('a/b.bin'));
  await f.delete('a/b.bin');
  assert.equal(await f.read('a/b.bin'), null);
  assert.equal(f.urlSync('a/b.bin'), null, 'blob URL revoked with the file');
  const kv = new MemoryKV();
  const o = { a: [1] }; await kv.set('k', o); o.a.push(2);
  assert.deepEqual(await kv.get('k'), { a: [1] }, 'values are cloned');
});

test('formats: what the phone plays, a clear refusal for the rest', () => {
  assert.ok(checkFormat('x.MP3').ok && checkFormat('x.flac').ok && checkFormat('x.aiff').ok && checkFormat('x.m4a').ok);
  assert.equal(checkFormat('x.opus', { canPlayType: () => false }).ok, false);
  assert.equal(checkFormat('x.opus', { canPlayType: () => true }).ok, true);
  assert.match(checkFormat('x.wma').reason, /FFmpeg/);
  assert.equal(checkFormat('x.wma', { transcoder: { handles: (e) => e === 'wma' } }).ok, true, 'transcoder hook');
  assert.equal(checkFormat('notes.txt').ok, false);
  assert.equal(keySafe('Ä b/c?.wav'), 'A_b_c_.wav');
});

test('import: copy-in, tags from the file name, duplicates, refusals', async () => {
  const { b, call, upload } = await backend();
  const r = await upload(wav(1), 'DJ Test - First Tune.wav');
  assert.equal(r.status, 200);
  const t = r.body.track;
  assert.equal(t.title, 'First Tune'); assert.equal(t.artist, 'DJ Test');
  assert.equal(t.sourceType, 'local'); assert.match(t.path, /^music\/[0-9a-f]{16}\.wav$/);
  assert.equal(t.fileName, 'DJ Test - First Tune.wav');
  assert.ok(Math.abs(t.duration - 1) < 0.01 && t.sampleRate === 8000);
  assert.equal(t.id, deviceTrackId('DJ Test - First Tune.wav', wav(1).length));
  assert.ok((await b.fs.stat(t.path)).size > 1000, 'the file is in app storage');
  assert.equal((await upload(wav(1), 'DJ Test - First Tune.wav')).body.duplicate, true, 'same file again: recognised');
  const w = await upload(new Uint8Array([1, 2, 3]), 'old.wma');
  assert.equal(w.status, 415); assert.match(w.body.error, /old\.wma.*FFmpeg/);
  assert.equal((await upload(new Uint8Array(0), 'empty.mp3')).status, 400);
  const list = await call('GET', '/api/tracks');
  assert.equal(list.body.length, 1);
  // stream / waveform / cover / delete
  const s = await call('GET', `/api/tracks/${t.id}/stream`);
  assert.equal(s.status, 200); assert.equal(s.headers.get('content-type'), 'audio/wav'); assert.equal(s.body.size, wav(1).length);
  assert.equal((await call('GET', `/api/tracks/${t.id}/waveform`)).status, 404);
  assert.equal((await call('PUT', `/api/tracks/${t.id}/waveform`, new Uint8Array(200))).status, 200);
  assert.equal((await call('GET', `/api/tracks/${t.id}/waveform`)).body.size, 200);
  assert.equal((await call('GET', `/api/tracks/${t.id}/cover`)).headers.get('content-type'), 'image/svg+xml', 'placeholder without art');
  assert.match(b.urlForSync(`/api/tracks/${t.id}/cover`), /^data:image\/svg/);
  assert.match(await b.urlFor(`/api/tracks/${t.id}/stream`), /^blob:/);
  assert.equal((await call('POST', '/api/tracks/delete', { ids: [t.id] })).status, 200);
  assert.equal(await b.fs.stat(t.path), null, "removing a track deletes the app's copy");
  assert.equal(await b.fs.stat(`waveforms/${t.id}.bin`), null, 'and its waveform');
});

test('AIFF is converted to WAV for WebViews that cannot decode it', async () => {
  const { call, upload } = await backend();
  const n = 100, aiff = new Uint8Array(12 + 26 + 16 + n * 4), v = new DataView(aiff.buffer);
  const w = (o, s) => { for (let i = 0; i < 4; i++) aiff[o + i] = s.charCodeAt(i); };
  w(0, 'FORM'); v.setUint32(4, aiff.length - 8); w(8, 'AIFF');
  w(12, 'COMM'); v.setUint32(16, 18); v.setUint16(20, 2); v.setUint32(22, n); v.setUint16(26, 16); aiff.set([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0], 28);
  w(38, 'SSND'); v.setUint32(42, 8 + n * 4);
  const t = (await upload(aiff, 'loop.aiff')).body.track;
  const s = await call('GET', `/api/tracks/${t.id}/stream`);
  assert.equal(s.headers.get('content-type'), 'audio/wav');
  assert.equal(parseWavHeader(new Uint8Array(await s.body.arrayBuffer())).sampleRate, 44100);
});

test('playlists, smart playlists, M3U / rekordbox export and import matched by file name', async () => {
  const { call, upload } = await backend();
  const a = (await upload(wav(1), 'Alpha - One.wav')).body.track;
  const c = (await upload(wav(1.5), 'Gamma - Three.wav')).body.track;
  await call('PATCH', `/api/tracks/${a.id}`, { bpm: 124, genre: 'House' });
  const p = (await call('POST', '/api/playlists', { name: 'Set', trackIds: [a.id, c.id] })).body;
  assert.deepEqual(p.trackIds, [a.id, c.id]);
  const smart = (await call('POST', '/api/playlists', { name: 'House', smart: { match: 'all', rules: [{ field: 'genre', op: 'contains', value: 'house' }] } })).body;
  assert.deepEqual(smart.trackIds, [a.id]);
  assert.equal((await call('POST', `/api/playlists/${smart.id}/add`, { trackIds: [c.id] })).status, 400);
  const m3u = await (await call('GET', `/api/playlists/${p.id}/m3u`)).body.text();
  assert.match(m3u, /#EXTM3U[\s\S]*Alpha - One\.wav[\s\S]*Gamma - Three\.wav/);
  const xml = await (await call('GET', '/api/export/rekordbox')).body.text();
  assert.match(xml, /DJ_PLAYLISTS/); assert.match(xml, /Alpha%20-%20One\.wav|Alpha - One\.wav/);
  // M3U from a computer: absolute paths elsewhere, matched by file name / artist - title
  const imp = await call('POST', '/api/import/m3u', { content: '#EXTM3U\n#EXTINF:1,Gamma - Three\nD:\\Music\\Gamma - Three.wav\n/Users/x/Missing.mp3\n#EXTINF:1,Alpha - One\nfile:///x/other-name.flac\n', name: 'From PC' });
  assert.deepEqual(imp.body.trackIds, [c.id, a.id]);
  assert.equal((await call('POST', '/api/import/m3u', { path: '/x.m3u' })).status, 400, 'paths are refused with a hint');
  // rekordbox XML: cues, BPM grid and playlists land on the matched tracks
  const rb = `<?xml version="1.0"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="1">
    <TRACK TrackID="1" Name="Three" Artist="Gamma" AverageBpm="128.00" Tonality="8A" Location="file://localhost/C:/DJ/Gamma%20-%20Three.wav">
      <TEMPO Inizio="0.050" Bpm="128.00" Metro="4/4" Battito="1"/><POSITION_MARK Name="Drop" Type="0" Start="12.5" Num="2"/></TRACK>
    </COLLECTION><PLAYLISTS><NODE Type="0" Name="ROOT" Count="1"><NODE Name="Gig" Type="1" KeyType="0" Entries="1"><TRACK Key="1"/></NODE></NODE></PLAYLISTS></DJ_PLAYLISTS>`;
  const r = (await call('POST', '/api/import/rekordbox', { xml: rb })).body;
  assert.equal(r.imported, 1); assert.equal(r.playlists, 1); assert.equal(r.missing, 0);
  const t = (await call('GET', '/api/tracks')).body.find((x) => x.id === c.id);
  assert.equal(t.bpm, 128); assert.equal(t.gridLocked, true);
  assert.ok(t.cues.some((q) => q.index === 2 && Math.abs(q.position - 12.5) < 0.01));
  assert.equal((await call('POST', '/api/import/traktor', { xml: '<x/>' })).status, 501);
});

test('history, setlist export, backup without secrets, restore keeps only app-storage paths', async () => {
  const { b, call, upload } = await backend();
  const a = (await upload(wav(1), 'Alpha - One.wav')).body.track;
  await call('POST', '/api/tracks/played', { id: a.id });
  const s = (await call('GET', '/api/history')).body;
  assert.equal(s.length, 1);
  const txt = await (await call('GET', `/api/history/${s[0].id}/export?format=m3u8`)).body.text();
  assert.match(txt, /Alpha - One\.wav/);
  b.library.saveSource({ id: 'src1', type: 'subsonic', url: 'http://nas', username: 'u', password: 'secret-pw' });
  const bk = await call('GET', '/api/backup');
  assert.match(bk.headers.get('content-disposition'), /opendj-backup-/);
  const backup = bk.body;
  assert.ok(!JSON.stringify(backup).includes('secret-pw'), 'no passwords in backups');
  backup.library.tracks.evil = { id: 'evil', title: 'x', sourceType: 'local', path: '/etc/passwd' };
  const r = (await call('POST', '/api/restore', backup)).body;
  assert.equal(r.tracks, 2);
  assert.equal(b.library.getTrack('evil').path, undefined, 'foreign paths dropped');
  assert.equal(b.library.getTrack(a.id).path, a.path);
  assert.equal(b.library.getSource('src1').password, 'secret-pw', 'stored secret kept for the same endpoint');
});

test('settings: device-specific keys cannot be set; library and settings persist', async () => {
  const kv = new MemoryKV(), mfs = new MemoryFS();
  const { b, call } = await backend({ kv, fs: mfs });
  const s = (await call('PUT', '/api/settings', { theme: 'neon', downloadDir: '/etc', recording: { x: 1 }, deckCount: 4 })).body;
  assert.equal(s.theme, 'neon'); assert.equal(s.deckCount, 4); assert.equal(s.downloadDir, 'downloads');
  await call('POST', '/api/playlists', { name: 'Keep me' });
  await b.flush();
  const again = await backend({ kv, fs: mfs });
  assert.equal((await again.call('GET', '/api/settings')).body.theme, 'neon');
  assert.equal((await again.call('GET', '/api/playlists')).body[0].name, 'Keep me');
  const caps = (await call('GET', '/api/capabilities')).body;
  assert.equal(caps.local, true); assert.equal(caps.ffmpeg, false); assert.equal(caps.hosted, false);
  assert.equal((await call('POST', '/api/folders', { path: '/x' })).status, 501);
  assert.equal((await call('GET', '/api/stems/status')).body.available, false);
});

test('recording: numbered PCM chunks (out of order) become a WAV with the right length, then a list entry', async () => {
  const { call } = await backend();
  const info = (await call('GET', '/api/recording/config')).body;
  assert.ok(info.formats.find((f) => f.id === 'wav').available);
  const sr = 8000, chunkFrames = 4000;
  const st = (await call('POST', '/api/recording/start', { sampleRate: sr, sampleFormat: 's16', chunkFrames, title: 'Test mix' })).body;
  const chunk = () => new Uint8Array(chunkFrames * 4).fill(7);
  for (const seq of [1, 0, 2]) assert.equal((await call('POST', `/api/recording/${st.id}/chunk?seq=${seq}`, chunk())).status, 200);
  await call('POST', `/api/recording/${st.id}/track`, { t: 0.2, artist: 'A', title: 'B' });
  const done = (await call('POST', `/api/recording/${st.id}/stop`, { lastSeq: 3 })).body; // seq 3 never arrived: silence
  assert.equal(done.state, 'stopped'); assert.equal(done.seconds, 2);
  const b = new Uint8Array(await (await call('GET', `/api/recordings/file?name=${encodeURIComponent(done.name)}`)).body.arrayBuffer());
  const h = parseWavHeader(b);
  assert.equal(h.riff, 'RIFF'); assert.equal(h.dataBytes, 4 * chunkFrames * 4); assert.equal(b.length, 44 + h.dataBytes);
  const list = (await call('GET', '/api/recordings')).body.recordings;
  assert.equal(list.length, 1); assert.equal(list[0].duration, 2); assert.ok(list[0].cue && list[0].txt);
  const dl = await call('GET', `/api/recordings/file?name=${encodeURIComponent(done.name)}&download=1`);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal((await call('GET', '/api/recordings/file?name=..%2Fx.wav')).status, 400);
  assert.equal((await call('DELETE', `/api/recordings/file?name=${encodeURIComponent(done.name)}`)).body.removed.length, 3);
  assert.deepEqual(recordingFormats(undefined).filter((f) => f.available).map((f) => f.id), ['wav'], 'no MediaRecorder: WAV only');
});

test('media servers: secrets stay in app storage and bound to the endpoint; errors never show auth query strings', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.pathname.endsWith('/ping')) return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', type: 'navidrome', version: '1.16.1' } }), { headers: { 'content-type': 'application/json' } });
    if (u.pathname.endsWith('/search3')) return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok', searchResult3: { song: [{ id: 's1', title: 'Remote', artist: 'R', suffix: 'mp3', duration: 100 }] } } }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ 'subsonic-response': { status: 'ok' } }), { headers: { 'content-type': 'application/json' } });
  };
  const { b, call } = await backend({ http: fakeFetch });
  const r = await call('POST', '/api/sources', { type: 'subsonic', url: 'http://nas:4533', username: 'dj', password: 'pw123', name: 'NAS' });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes('pw123'));
  const id = r.body.source.id;
  const pub = (await call('GET', '/api/sources')).body[0];
  assert.equal(pub.password, undefined); assert.equal(pub.hasPassword, true);
  assert.equal(b.library.getSource(id).password, 'pw123', 'kept in app storage for Subsonic token auth');
  // a different server URL without a new password: the stored one is not sent there
  calls.length = 0;
  const moved = await call('POST', '/api/sources', { id, type: 'subsonic', url: 'http://evil.example', username: 'dj' });
  assert.ok(calls.every((u) => !u.includes(md5Hex('pw123'))), 'no token for the old password sent to the new host');
  assert.ok(moved.status === 200 || moved.status >= 400);
  assert.equal(b.library.getSource(id).password, undefined, 'secret dropped when the endpoint changed');
  assert.equal(scrub('failed http://nas/rest/ping?u=dj&t=abc&s=1 now'), 'failed http://nas/rest/ping?… now');
});

test('capacitorFetch turns CapacitorHttp answers into Responses', async () => {
  const f = capacitorFetch({ request: async (o) => ({ status: 200, headers: { 'Content-Type': 'application/json' }, data: { echo: o.data, method: o.method } }) });
  const r = await f('http://x/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
  assert.deepEqual(await r.json(), { echo: { a: 1 }, method: 'POST' });
});

test('matching helpers and media URL parsing', () => {
  const m = trackMatcher([{ id: '1', fileName: 'A - B.flac', artist: 'A', title: 'B' }, { id: '2', fileName: 'x.mp3', artist: 'Café', title: 'Déjà Vu' }]);
  assert.equal(m({ path: 'C:\\Music\\A - B.flac' }).id, '1');
  assert.equal(m({ path: '/m/A - B.mp3' }).id, '1', 'same name, other format');
  assert.equal(m({ artist: 'cafe', title: 'deja vu' }), null, 'accents matter less than… (no fuzzy match)');
  assert.equal(m({ artist: 'Café', title: 'Déjà  Vu' }).id, '2');
  assert.equal(m({ label: 'A - B' }).id, '1');
  assert.deepEqual(parseTitleFromName('03. Artist - Title.mp3'), { artist: 'Artist', title: 'Title' });
  assert.deepEqual(parseApi('/api/tracks/abc/cover'), { kind: 'track', id: 'abc', what: 'cover' });
  assert.deepEqual(parseApi('/api/recordings/file?name=a.wav'), { kind: 'recording', name: 'a.wav' });
  assert.equal(parseApi('/api/recordings/file?name=a.wav&download=1'), null);
});
