// Regression tests for the hands-on security audit (numbers refer to the audit findings).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { start } from '../server/index.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-audit-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PW = 'correct horse';
function wav(seconds = 0.2, sr = 8000) {
  const n = Math.round(seconds * sr), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}
/** Raw request (fetch can't set Host / Content-Length freely). */
const raw = (port, method, url, headers = {}, body) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port, path: url, method, headers }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c));
    res.on('end', () => { const b = Buffer.concat(chunks); resolve({ status: res.statusCode, body: b.toString(), buf: b, headers: res.headers }); });
    res.on('error', () => resolve({ status: res.statusCode, body: '' }));
  });
  r.on('error', (e) => resolve({ status: 0, error: e.message }));
  if (body) r.write(body);
  r.end();
});
/** JSON client with a cookie jar. */
const client = (app) => {
  let cookie = '';
  const f = async (method, url, body, headers = {}) => {
    const h = { ...(cookie ? { Cookie: cookie } : {}), ...headers };
    let b = body;
    if (body !== undefined && !Buffer.isBuffer(body)) { b = JSON.stringify(body); h['Content-Type'] ??= 'application/json'; }
    if (Buffer.isBuffer(body)) h['Content-Type'] ??= 'application/octet-stream';
    const r = await raw(app.port, method, url, { ...(b ? { 'Content-Length': Buffer.byteLength(b) } : {}), ...h }, b);
    const sc = r.headers?.['set-cookie']?.find((x) => x.startsWith('opendj_session='));
    if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    let json = null; try { json = JSON.parse(r.body); } catch { /* not json */ }
    return { ...r, json };
  };
  f.cookie = () => cookie;
  return f;
};
async function hosted(fn, opts = {}) {
  const dir = tmpdir();
  const music = path.join(dir, 'music'), outside = path.join(dir, 'outside');
  fs.mkdirSync(music); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(music, 'A - In.wav'), wav());
  fs.writeFileSync(path.join(outside, 'secret.wav'), wav());
  const app = await start({ port: 0, dataDir: path.join(dir, 'd'), auth: true, password: PW, roots: [music], ffmpeg: false, log: { log() {}, warn() {}, error() {} }, ...opts });
  const c = client(app);
  try {
    if (opts.login !== false) assert.equal((await c('POST', '/api/auth/login', { password: PW })).status, 200);
    await fn({ app, c, dir, music, outside });
  } finally { app.server.close(); app.shutdown(); }
}
async function desktop(fn, opts = {}) {
  const dir = tmpdir();
  const app = await start({ port: 0, dataDir: path.join(dir, 'd'), ffmpeg: false, log: { log() {}, warn() {}, error() {} }, ...opts });
  const c = client(app);
  try { await fn({ app, c, dir }); } finally { app.server.close(); app.shutdown(); }
}
const backup = (library) => ({ app: 'OpenDJ', type: 'library-backup', library: { tracks: {}, playlists: [], folders: [], sources: [], ...library }, settings: {} });

// ---------------------------------------------------------------- #1 restore vs. hosted roots
test('#1 hosted: a restored backup cannot add folders or tracks outside the allowed roots', () => hosted(async ({ app, c, music, outside }) => {
  const evil = path.join(outside, 'secret.wav'), good = path.join(music, 'A - In.wav');
  const r = await c('POST', '/api/restore', backup({
    tracks: {
      evil1: { sourceType: 'local', path: evil, title: 'x' },
      evil2: { sourceType: 'remote', sourceId: 's', localPath: evil, title: 'y' },
      good1: { sourceType: 'local', path: good, title: 'ok' },
      'a")<img src=x>': { sourceType: 'local', path: good, title: 'bad id' },
    },
    folders: [{ id: 'root', path: '/' }, { id: 'rel', path: 'relative/music' }, { id: 'm', path: music }],
    playlists: [{ id: 'p1', name: 'P', trackIds: ['good1', 'evil1', '__proto__', 'a")<img'] }],
  }));
  assert.equal(r.status, 200);
  assert.deepEqual(app.library.data.folders.map((f) => f.id), ['m'], 'only the folder inside the roots survives');
  assert.equal(app.library.getTrack('evil1').path, undefined, 'track path outside the roots is stripped');
  assert.equal(app.library.getTrack('evil2').localPath, undefined);
  assert.equal(app.library.getTrack('good1').path, good);
  assert.equal(Object.keys(app.library.data.tracks).some((k) => k.includes('<')), false, 'ids with markup are dropped');
  assert.deepEqual(app.library.data.playlists[0].trackIds, ['good1', 'evil1']);
  assert.notEqual((await c('GET', '/api/tracks/evil1/stream')).status, 200);
  assert.equal((await c('POST', '/api/folders/root/scan')).status, 404);
  // even with a poisoned library.json (pre-fix restore), library folders do not widen what may be read/written
  app.library.data.folders.push({ id: 'root', path: '/' });
  app.library.upsertTrack({ id: 'evil3', sourceType: 'local', path: evil, title: 'z' });
  assert.equal((await c('GET', '/api/tracks/evil3/stream')).status, 403);
  assert.equal((await c('POST', '/api/folders/root/scan')).status, 403);
  const lrc = await c('PUT', '/api/tracks/evil3/lyrics', { lrc: '[00:01.00]hello', writeLrc: true });
  assert.equal(lrc.status, 409);
  assert.equal(fs.existsSync(path.join(outside, 'secret.lrc')), false, 'no .lrc written outside the roots');
  assert.equal((await c('GET', '/api/tracks/good1/stream')).status, 200);
}));

test('#1 desktop: restoring a normal backup keeps folders and track paths', () => desktop(async ({ app, c, dir }) => {
  const f = path.join(dir, 'x.wav'); fs.writeFileSync(f, wav());
  const r = await c('POST', '/api/restore', backup({ tracks: { t1: { sourceType: 'local', path: f, title: 'a' }, t2: { sourceType: 'local', path: 'D:\\Music\\b.mp3' } }, folders: [{ id: 'f1', path: dir }], playlists: [{ id: 'p', name: 'P', trackIds: ['t1', 't2'] }] }));
  assert.equal(r.status, 200);
  assert.equal(app.library.data.folders.length, 1);
  assert.equal(app.library.getTrack('t1').path, f);
  assert.equal(app.library.getTrack('t2').path, 'D:\\Music\\b.mp3', 'unrestricted: other-machine paths are kept for relocating');
  assert.equal((await c('GET', '/api/tracks/t1/stream')).status, 200);
}));

test('#1 CDJ export skips non-media files', async () => {
  const { exportToCdj } = await import('../server/cdj/export.js');
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'x');
  const lib = { getPlaylist: () => ({ id: 'p', name: 'P', trackIds: ['t'] }), getTrack: () => ({ id: 't', sourceType: 'local', path: path.join(dir, 'secret.txt'), title: 'x' }), settings: {} };
  fs.mkdirSync(path.join(dir, 'usb'));
  const r = await exportToCdj({ library: lib }, { targetDir: path.join(dir, 'usb'), playlistIds: ['p'], dryRun: true });
  assert.equal(r.skipped?.[0]?.reason, 'not an audio or video file');
});

// ---------------------------------------------------------------- #13 ids in UI URLs
test('#13 api.js encodes ids in every URL helper', async () => {
  const { api } = await import('../public/js/api.js');
  const id = 'a)"></div><img src=x onerror=alert(1)>';
  for (const k of ['streamUrl', 'videoUrl', 'coverUrl', 'm3uUrl']) {
    const u = api[k](id);
    assert.doesNotMatch(u, /["<>()' ]/, k);
  }
  assert.equal(api.coverUrl('abc123'), '/api/tracks/abc123/cover');
});
