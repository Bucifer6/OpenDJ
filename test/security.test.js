// Regression tests for the security / robustness QA findings (numbers refer to the QA report).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { start, parseRange } from '../server/index.js';
import { Library } from '../server/library.js';
import { History } from '../server/history.js';
import { aiffToWav } from '../server/aiff.js';
import { safe, safeExt, DownloadManager, syncSource } from '../server/remote.js';
import { walk } from '../server/scanner.js';
import { relocateTracks, mergeDuplicates, buildBackup } from '../server/library-tools.js';
import { toCamelot } from '../server/smart.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-sec-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wav = (n = 200) => {
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
};
const raw = (port, method, p, headers = {}, body) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    res.on('error', () => resolve({ status: res.statusCode, body: d }));
  });
  r.on('error', (e) => resolve({ status: 0, error: e.message }));
  if (body) r.write(body);
  r.end();
});
async function withApp(fn, opts = {}) {
  const dir = tmpdir();
  const app = await start({ port: 0, dataDir: path.join(dir, 'data'), ffmpeg: false, ...opts });
  const J = (method, p, body, headers = {}) => raw(app.port, method, p, { 'Content-Type': 'application/json', ...headers }, body === undefined ? undefined : JSON.stringify(body));
  try { await fn({ app, dir, J }); } finally { app.server.close(); app.shutdown(); }
}

test('#1 CSRF: Origin null and text/plain "JSON" bodies are refused', () => withApp(async ({ app, J }) => {
  assert.equal((await J('POST', '/api/playlists', { name: 'x' }, { Origin: 'null' })).status, 403);
  assert.equal((await J('POST', '/api/playlists', { name: 'x' }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await J('POST', '/api/playlists', { name: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const simple = await raw(app.port, 'POST', '/api/import/m3u', { 'Content-Type': 'text/plain; x=json' }, JSON.stringify({ content: '/etc/passwd\n', name: 'pwn' }));
  assert.equal(simple.status, 415);
  assert.equal(app.library.data.playlists.length, 0);
  // reads from another site are refused too
  assert.equal((await J('GET', '/api/settings', undefined, { Origin: 'http://evil.example' })).status, 403);
}));

test('#2 DNS rebinding: unknown Host or wrong port -> 421', () => withApp(async ({ app, J }) => {
  assert.equal((await J('GET', '/api/settings', undefined, { Host: `evil.example:${app.port}` })).status, 421);
  assert.equal((await J('PUT', '/api/settings', { deckCount: 4 }, { Host: 'evil.example', Origin: 'http://evil.example' })).status, 421);
  assert.equal((await J('GET', '/api/settings', undefined, { Host: `localhost:${app.port + 1}` })).status, 421);
  assert.equal((await J('GET', '/api/settings', undefined, { Host: `[::1]:${app.port}` })).status, 200);
}));

test('#3 imports never turn non-media files or directories into tracks; stream re-checks', () => withApp(async ({ app, dir, J }) => {
  const d = path.join(dir, 'folder.mp3'); fs.mkdirSync(d);
  const r = await J('POST', '/api/import/m3u', { content: `/etc/passwd\n${d}\n`, name: 'p' });
  assert.equal(JSON.parse(r.body).trackIds.length, 0);
  app.library.upsertTrack({ id: 'x', sourceType: 'local', path: '/etc/passwd', title: 'x' });
  assert.equal((await J('GET', '/api/tracks/x/stream')).status, 403);
  // #5: a directory with a media extension is a 404, not a crash
  app.library.upsertTrack({ id: 'y', sourceType: 'local', path: d, title: 'y' });
  assert.equal((await J('GET', '/api/tracks/y/stream')).status, 404);
  assert.equal((await J('GET', '/api/health')).status, 200, 'server still alive');
}));

test('#4 #12 downloads: no path traversal from server-supplied suffixes, unique names, no overwrite, temp cleanup', async () => {
  const dir = tmpdir();
  assert.equal(safeExt('mp3/../../../PWNED.sh'), 'mp3');
  assert.equal(safeExt('FLAC'), 'flac');
  assert.equal(safe('..'), '_');
  assert.equal(safe('.hidden'), '_hidden');
  const srv = http.createServer((req, res) => res.end('#!/bin/sh\necho owned\n'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const lib = new Library(path.join(dir, 'data'));
  lib.saveSource({ id: 's', type: 'subsonic', name: 'S', url: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p' });
  for (const id of ['a', 'b']) lib.upsertTrack({ id, sourceType: 'remote', sourceId: 's', remoteId: id, title: 'Same', artist: 'Art', album: '..', format: 'mp3/../../../../PWNED.sh' });
  const dl = lib.settings.downloadDir;
  const pre = path.join(dl, 'Art', '_'); fs.mkdirSync(pre, { recursive: true });
  fs.writeFileSync(path.join(pre, 'Art - Same.mp3'), 'USER FILE');
  const m = new DownloadManager(lib, () => {});
  m.enqueue(['a', 'b']);
  for (let i = 0; i < 100 && m.done.length < 2; i++) await sleep(20);
  srv.close();
  assert.deepEqual(m.done.map((d) => d.ok), [true, true]);
  const files = fs.readdirSync(pre).sort();
  assert.deepEqual(files, ['Art - Same (2).mp3', 'Art - Same (3).mp3', 'Art - Same.mp3']);
  assert.equal(fs.readFileSync(path.join(pre, 'Art - Same.mp3'), 'utf8'), 'USER FILE');
  assert.equal(fs.existsSync(path.join(dir, 'PWNED.sh')) || fs.existsSync(path.join(dir, 'data', 'PWNED.sh')), false);
  lib.flush();
});

test('#6 AIFF: bad bit depth / truncated chunks throw instead of hanging', () => {
  const b = Buffer.alloc(60);
  b.write('FORM'); b.write('AIFF', 8); b.write('COMM', 12); b.writeUInt32BE(18, 16); b.writeUInt16BE(1, 20); b.writeUInt32BE(100, 22); b.writeUInt16BE(0, 26);
  b.write('SSND', 38); b.writeUInt32BE(8, 42);
  assert.throws(() => aiffToWav(b), /bit depth/);
  assert.throws(() => aiffToWav(Buffer.from('FORM\0\0\0\x04AIFFCOMM\0\0\0\x12\0')), /truncated|COMM/);
  assert.throws(() => aiffToWav(Buffer.from('FORM')), /not AIFF/);
});

test('#7 a damaged library.json is kept aside and the backup copy is loaded (not silently emptied)', () => {
  const dir = tmpdir();
  const lib = new Library(dir);
  lib.upsertTrack({ id: 't1', title: 'One', sourceType: 'local', path: '/x.mp3' });
  lib.flush(); lib.flush(); // second flush writes library.json.bak
  fs.writeFileSync(path.join(dir, 'library.json'), '{"tracks": {"t1": tru');
  const lib2 = new Library(dir);
  assert.ok(lib2.getTrack('t1'), 'loaded from .bak');
  assert.equal(lib2.loadErrors.length, 1);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('library.json.corrupt-')));
  fs.writeFileSync(path.join(dir, 'history.json'), 'garbage');
  const h = new History(dir);
  assert.equal(h.loadErrors.length, 1);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('history.json.corrupt-')));
});

test('#8 a failing background save is reported, not a crash', async () => {
  const lib = new Library(tmpdir());
  const events = [];
  lib.listeners.add((type, p) => events.push([type, p]));
  lib._writeAtomic = () => { throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); };
  lib.save();
  await sleep(550);
  assert.ok(events.some(([t, p]) => t === 'job-error' && /no space/.test(p.message)));
  clearTimeout(lib._t);
});

test('#9 Range validation', async () => {
  assert.equal(parseRange('bytes=10-2', 100), 'invalid');
  assert.equal(parseRange('bytes=-0', 100), 'invalid');
  assert.equal(parseRange('bytes=200-', 100), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  await withApp(async ({ app, dir, J }) => {
    const f = path.join(dir, 'a.wav'); fs.writeFileSync(f, wav());
    app.library.upsertTrack({ id: 'w', sourceType: 'local', path: f, title: 'w' });
    assert.equal((await J('GET', '/api/tracks/w/stream', undefined, { Range: 'bytes=10-2' })).status, 416);
    assert.equal((await J('GET', '/api/tracks/w/stream', undefined, { Range: 'bytes=0-1,4-5' })).status, 200);
  });
});

test('#10 proxy: aborts upstream when the client leaves; upstream errors -> 502', () => withApp(async ({ app }) => {
  let closed = 0, status = 200;
  const up = http.createServer((req, res) => {
    if (status !== 200) { res.writeHead(status); return res.end('nope'); }
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    const iv = setInterval(() => res.write(Buffer.alloc(65536)), 5);
    res.on('close', () => { clearInterval(iv); closed++; });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  try {
    app.library.saveSource({ id: 's', type: 'subsonic', name: 'S', url: `http://127.0.0.1:${up.address().port}`, username: 'u', password: 'p' });
    app.library.upsertTrack({ id: 'r', sourceType: 'remote', sourceId: 's', remoteId: '1', format: 'mp3', title: 'r' });
    await new Promise((resolve) => {
      const rq = http.get({ host: '127.0.0.1', port: app.port, path: '/api/tracks/r/stream' }, (res) => { res.once('data', () => { rq.destroy(); resolve(); }); });
    });
    for (let i = 0; i < 50 && !closed; i++) await sleep(20);
    assert.equal(closed, 1, 'upstream request aborted');
    status = 500;
    assert.equal((await raw(app.port, 'GET', '/api/tracks/r/stream')).status, 502);
  } finally { up.close(); }
}));

test('#11 USB export: same file names from different tracks do not collide; outdated copies are refreshed', () => withApp(async ({ app, dir, J }) => {
  const a = path.join(dir, 'a'), b = path.join(dir, 'b'), usb = path.join(dir, 'usb');
  fs.mkdirSync(a); fs.mkdirSync(b); fs.mkdirSync(usb);
  fs.writeFileSync(path.join(a, 'Intro.wav'), wav(100)); fs.writeFileSync(path.join(b, 'Intro.wav'), wav(300));
  app.library.upsertTrack({ id: 'a', sourceType: 'local', path: path.join(a, 'Intro.wav'), title: 'Intro', artist: 'X' });
  app.library.upsertTrack({ id: 'b', sourceType: 'local', path: path.join(b, 'Intro.wav'), title: 'Intro', artist: 'X' });
  const pl = app.library.createPlaylist('P', ['a', 'b']);
  const r = JSON.parse((await J('POST', '/api/export/usb', { targetDir: usb, playlistIds: [pl.id] })).body);
  assert.equal(r.files, 2);
  const out = path.join(usb, 'OpenDJ', 'Music', 'X', 'Singles');
  assert.deepEqual(fs.readdirSync(out).sort(), ['Intro (2).wav', 'Intro.wav']);
  fs.writeFileSync(path.join(a, 'Intro.wav'), wav(500));
  await J('POST', '/api/export/usb', { targetDir: usb, playlistIds: [pl.id] });
  assert.equal(fs.statSync(path.join(out, 'Intro.wav')).size, wav(500).length, 'updated');
}));

test('#15 relocate: same name but different size, or several matches, need confirmation; library files are not candidates', async () => {
  const dir = tmpdir();
  const lib = new Library(path.join(dir, 'data'));
  const nd = path.join(dir, 'new'); fs.mkdirSync(nd);
  fs.writeFileSync(path.join(nd, 'Song.mp3'), 'xxxxxxxxx');
  lib.upsertTrack({ id: 't', sourceType: 'local', path: path.join(dir, 'old', 'Song.mp3'), size: 5 });
  let r = await relocateTracks(lib, nd, ['t']);
  assert.equal(r.relocated.length, 0);
  assert.equal(r.ambiguous[0].reason, 'size differs');
  r = await relocateTracks(lib, nd, ['t'], { confirm: { t: path.join(nd, 'Song.mp3') } });
  assert.equal(r.relocated.length, 1);
  // a file that already is another library track is not taken
  fs.writeFileSync(path.join(nd, 'Other.mp3'), 'yyyyy');
  lib.upsertTrack({ id: Library.localId(path.join(nd, 'Other.mp3')), sourceType: 'local', path: path.join(nd, 'Other.mp3') });
  lib.upsertTrack({ id: 'u', sourceType: 'local', path: path.join(dir, 'gone', 'Other.mp3'), size: 5 });
  r = await relocateTracks(lib, nd, ['u']);
  assert.deepEqual(r.notFound, ['u']);
  lib.flush();
});

test('#16 remote sync: an empty/partial listing does not wipe tracks; tracks with cues are kept as missing', async () => {
  const dir = tmpdir();
  let songs = ['1', '2', '3'];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...o } })); };
    if (u.pathname.endsWith('/ping')) return send({});
    if (u.pathname.endsWith('/search3')) return send({ searchResult3: { song: Number(u.searchParams.get('songOffset')) ? [] : songs.map((id) => ({ id, title: 'T' + id, artist: 'A', suffix: 'mp3' })) } });
    if (u.pathname.endsWith('/getAlbumList2')) return send({ albumList2: {} });
    return send({});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const lib = new Library(path.join(dir, 'data'));
    lib.saveSource({ id: 's', type: 'subsonic', name: 'S', url: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p' });
    await syncSource(lib, 's');
    const ids = lib.allTracks().map((t) => t.id);
    assert.equal(ids.length, 3);
    const t2 = lib.allTracks().find((t) => t.remoteId === '2');
    lib.updateTrack(t2.id, { cues: [{ index: 0, position: 1 }] });
    songs = ['1', '3'];
    await syncSource(lib, 's');
    assert.equal(lib.getTrack(t2.id).remoteMissing, true, 'kept, flagged');
    songs = [];
    const r = await syncSource(lib, 's');
    assert.equal(r.skippedPrune, true);
    assert.equal(lib.allTracks().length, 3, 'empty listing prunes nothing');
    lib.flush();
  } finally { srv.close(); }
});

test('#18 #19 #22 restore validates shapes; playlist names are strings; no prototype pollution', () => withApp(async ({ app, J }) => {
  const bad = { app: 'OpenDJ', type: 'library-backup', library: { tracks: { t: { title: 'x' } }, playlists: [{ id: 'p', name: { a: 1 } }, 5] }, settings: { __proto__: { polluted: 1 }, bogus: 1, deckCount: 4 } };
  assert.equal((await J('POST', '/api/restore', bad)).status, 200);
  const pls = JSON.parse((await J('GET', '/api/playlists')).body);
  assert.deepEqual(pls[0].trackIds, []);
  assert.equal(typeof pls[0].name, 'string');
  assert.equal((await J('GET', `/api/playlists/p/m3u`)).status, 200);
  assert.equal(app.library.settings.bogus, undefined);
  assert.equal(app.library.settings.deckCount, 4);
  const p = JSON.parse((await J('POST', '/api/playlists', { name: { x: 1 } })).body);
  assert.equal(typeof p.name, 'string');
  await J('PUT', '/api/settings', JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1}'));
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(app.library.settings, 'constructor'), false);
}));

test('#20 scanner follows symlinks without looping', { skip: process.platform === 'win32' }, async () => {
  const dir = tmpdir();
  const real = path.join(dir, 'real'), root = path.join(dir, 'root');
  fs.mkdirSync(real); fs.mkdirSync(root);
  fs.writeFileSync(path.join(real, 'a.wav'), wav());
  fs.symlinkSync(real, path.join(root, 'linked'));
  fs.symlinkSync(root, path.join(root, 'loop'));
  fs.symlinkSync(path.join(real, 'a.wav'), path.join(root, 'b.wav'));
  const out = [];
  for await (const f of walk(root)) out.push(path.relative(root, f));
  assert.deepEqual(out.sort(), ['b.wav', path.join('linked', 'a.wav')]);
});

test('#21 secrets: Hue key redacted from settings/lighting/backup; Plex password dropped once a token exists', () => withApp(async ({ app, J }) => {
  app.library.updateSettings({ lighting: { outputs: { hue: { bridge: '10.0.0.2', username: 'HUESECRET' } } }, youtubeApiKey: 'YTKEY' });
  assert.equal((await J('GET', '/api/settings')).body.includes('HUESECRET'), false);
  assert.equal(JSON.stringify(buildBackup(app.library, app.history)).includes('HUESECRET'), false);
  assert.equal(JSON.stringify(buildBackup(app.library, app.history)).includes('YTKEY'), false);
  const { addSource } = await import('../server/remote.js');
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url.includes('sign') ? { user: { authToken: 'TOK' } } : { MediaContainer: { friendlyName: 'P' } })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { source } = await addSource(app.library, { type: 'plex', name: 'P', url: `http://127.0.0.1:${srv.address().port}`, token: 'TOK', password: 'PW', username: 'u' });
    assert.equal(app.library.getSource(source.id).password, undefined);
    assert.equal(app.library.getSource(source.id).token, 'TOK');
  } finally { srv.close(); }
}));

test('#23 #24 static path guard; invalid JSON -> 400; JSON null body tolerated', () => withApp(async ({ app }) => {
  assert.equal((await raw(app.port, 'GET', '/..%2fpackage.json')).status, 404);
  assert.equal((await raw(app.port, 'GET', '/%2e%2e/server/index.js')).status, 404);
  assert.equal((await raw(app.port, 'POST', '/api/playlists', { 'Content-Type': 'application/json' }, '{nope')).status, 400);
  assert.equal((await raw(app.port, 'POST', '/api/tracks/delete', { 'Content-Type': 'application/json' }, 'null')).status, 200);
}));

test('#25 lighting engine is closed on shutdown', async () => {
  const app = await start({ port: 0, dataDir: path.join(tmpdir(), 'd'), ffmpeg: false });
  app.server.close(); app.shutdown();
  assert.equal(app.lighting.timer, null);
});

test('#26 merging chained duplicate groups keeps playlist entries and user data', () => {
  const lib = new Library(tmpdir());
  lib.upsertTrack({ id: 'a', title: 'S', sourceType: 'local', path: '/a.mp3', cues: [{ index: 0, position: 3 }], analyzed: true, bpm: 128 });
  lib.upsertTrack({ id: 'b', title: 'S', sourceType: 'local', path: '/b.mp3' });
  lib.upsertTrack({ id: 'c', title: 'S', sourceType: 'local', path: '/c.mp3' });
  lib.createPlaylist('P', ['a', 'b', 'x']);
  assert.equal(mergeDuplicates(lib, [{ keep: 'a', remove: ['a'] }]).removed, 0, 'keep in remove is rejected');
  mergeDuplicates(lib, [{ keep: 'b', remove: ['a'] }, { keep: 'c', remove: ['b'] }]);
  assert.deepEqual(lib.data.playlists[0].trackIds, ['c', 'x']);
  assert.equal(lib.getTrack('c').cues[0].position, 3);
  assert.equal(lib.getTrack('c').bpm, 128);
  lib.flush();
});

test('smart: toCamelot major/minor parsing', () => {
  assert.equal(toCamelot('Am'), '8A');
  assert.equal(toCamelot('Amaj'), '11B');
  assert.equal(toCamelot('A major'), '11B');
  assert.equal(toCamelot('C major'), '8B');
  assert.equal(toCamelot('C minor'), '5A');
  assert.equal(toCamelot('F#m'), '11A');
  assert.equal(toCamelot('Bbm'), '3A');
});

test('updateTrack coerces field types', () => {
  const lib = new Library(tmpdir());
  lib.upsertTrack({ id: 't', title: 'x', sourceType: 'local', path: '/t.mp3' });
  const t = lib.updateTrack('t', { energy: { evil: '<img>' }, bpm: '128.5', title: 42, rating: 'NaN', key: 'x'.repeat(100), year: '' });
  assert.equal(t.energy, null);
  assert.equal(t.bpm, 128.5);
  assert.equal(t.title, '42');
  assert.equal(t.rating, null);
  assert.equal(t.key.length, 16);
  assert.equal(t.year, null);
  lib.flush();
});
