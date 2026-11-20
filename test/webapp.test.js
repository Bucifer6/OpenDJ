// Hosted web-app mode: password login, cookies, rate limiting, allowed roots, browser upload, Host/Origin guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { start, isLoopback } from '../server/index.js';
import { Auth } from '../server/auth.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-web-'));
function wav(seconds = 0.2, sr = 8000) {
  const n = Math.round(seconds * sr), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}
/** Raw request (fetch can't set the Host header). */
export const raw = (app, method, url, headers = {}, body) => new Promise((resolve) => {
  const r = http.request({ host: '127.0.0.1', port: app.port, path: url, method, headers }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
  });
  r.on('error', (e) => resolve({ status: 0, error: e.message }));
  if (body) r.write(body);
  r.end();
});
const client = (app) => {
  let cookie = '';
  const f = async (method, url, body, headers = {}) => {
    const h = { ...(cookie ? { Cookie: cookie } : {}), ...headers };
    let b = body;
    if (body !== undefined && !Buffer.isBuffer(body)) { b = JSON.stringify(body); h['Content-Type'] ??= 'application/json'; }
    const r = await fetch(app.url + url.replace(/^\//, ''), { method, headers: h, body: b, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    const txt = await r.text();
    let json = null; try { json = JSON.parse(txt); } catch { /* not json */ }
    return { status: r.status, json, text: txt, headers: r.headers };
  };
  f.cookie = () => cookie;
  f.setCookie = (c) => { cookie = c; };
  return f;
};

test('isLoopback', () => {
  for (const h of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]']) assert.equal(isLoopback(h), true, h);
  for (const h of ['0.0.0.0', '::', '192.168.1.5', 'nas.local']) assert.equal(isLoopback(h), false, h);
});

test('binding to a non-loopback address forces login', async () => {
  const app = await start({ port: 0, host: '0.0.0.0', dataDir: path.join(tmpdir(), 'd'), password: 'correct horse' });
  try {
    assert.equal(app.auth.enabled, true);
    const r = await fetch(`http://127.0.0.1:${app.port}/api/tracks`);
    assert.equal(r.status, 401);
  } finally { app.server.close(); app.shutdown(); }
});

test('login: required for API, SSE and app assets; cookie flags; logout; sessions persist', async () => {
  const dir = tmpdir();
  const app = await start({ port: 0, dataDir: path.join(dir, 'd'), auth: true, password: 'correct horse' });
  const c = client(app);
  try {
    assert.equal((await c('GET', '/api/tracks')).status, 401);
    assert.equal((await c('GET', '/api/events')).status, 401);
    assert.equal((await c('GET', '/js/app.js')).status, 401);
    const home = await c('GET', '/');
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/login.html');
    for (const pub of ['/login.html', '/sw.js', '/manifest.webmanifest', '/icon.svg', '/api/health']) assert.equal((await c('GET', pub)).status, 200, pub);
    assert.deepEqual((await c('GET', '/api/auth/status')).json, { enabled: true, authenticated: false, setupRequired: false });

    assert.equal((await c('POST', '/api/auth/login', { password: 'nope' })).status, 401);
    const ok = await c('POST', '/api/auth/login', { password: 'correct horse' });
    assert.equal(ok.status, 200);
    const sc = ok.headers.get('set-cookie');
    assert.match(sc, /^opendj_session=[\w-]{43}; /);
    assert.match(sc, /HttpOnly/);
    assert.match(sc, /SameSite=Strict/);
    assert.match(sc, /Path=\//);
    assert.doesNotMatch(sc, /Secure/, 'plain http: no Secure flag');
    assert.equal((await c('GET', '/api/tracks')).status, 200);
    assert.equal((await c('GET', '/js/app.js')).status, 200);
    // SSE with the session
    const ctrl = new AbortController();
    const es = await fetch(app.url + 'api/events', { headers: { Cookie: c.cookie() }, signal: ctrl.signal });
    assert.equal(es.status, 200); ctrl.abort();
    // the token is stored hashed, not in clear
    const stored = fs.readFileSync(path.join(dir, 'd', 'auth.json'), 'utf8');
    assert.equal(stored.includes(c.cookie().split('=')[1]), false);
    // a new server on the same data dir accepts the session
    const auth2 = new Auth({ dataDir: path.join(dir, 'd'), enabled: true, password: 'x', log: {} });
    assert.equal(auth2.check({ headers: { cookie: c.cookie() } }), true);
    const saved = c.cookie();
    await c('POST', '/api/auth/logout');
    c.setCookie(saved);
    assert.equal((await c('GET', '/api/tracks')).status, 401, 'logout revokes the session server-side');
    // behind a TLS reverse proxy (trusted), the cookie is Secure
    const auth3 = new Auth({ dataDir: path.join(dir, 'd3'), enabled: true, password: 'x', trustProxy: true, log: {} });
    assert.match(auth3.cookie({ socket: {}, headers: { 'x-forwarded-proto': 'https' } }, 'v', 10), /; Secure$/);
  } finally { app.server.close(); app.shutdown(); }
});

test('login is rate limited with backoff (even the right password is refused while locked)', async () => {
  const app = await start({ port: 0, dataDir: path.join(tmpdir(), 'd'), auth: true, password: 'correct horse' });
  const c = client(app);
  try {
    for (let i = 0; i < 4; i++) assert.equal((await c('POST', '/api/auth/login', { password: 'bad' + i })).status, 401);
    assert.equal((await c('POST', '/api/auth/login', { password: 'bad' })).status, 401); // 5th: starts the lock
    const locked = await c('POST', '/api/auth/login', { password: 'correct horse' });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) >= 1);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await c('POST', '/api/auth/login', { password: 'correct horse' })).status, 200);
  } finally { app.server.close(); app.shutdown(); }
});

test('first-run setup needs the code from the server log', async () => {
  const lines = [];
  const app = await start({ port: 0, dataDir: path.join(tmpdir(), 'd'), auth: true, password: '', log: { log: (m) => lines.push(m), error() {}, warn() {} } });
  const c = client(app);
  try {
    assert.equal((await c('GET', '/api/auth/status')).json.setupRequired, true);
    const code = /setup code (\w+)/.exec(lines.join('\n'))[1];
    assert.equal((await c('POST', '/api/auth/login', { password: 'whatever' })).status, 409);
    assert.equal((await c('POST', '/api/auth/setup', { code: 'WRONG000', password: 'long enough' })).status, 401);
    assert.equal((await c('POST', '/api/auth/setup', { code, password: 'short' })).status, 400);
    assert.equal((await c('POST', '/api/auth/setup', { code, password: 'long enough' })).status, 200);
    assert.equal((await c('GET', '/api/tracks')).status, 200);
    assert.equal((await c('POST', '/api/auth/setup', { code, password: 'another one' })).status, 409, 'only once');
    const c2 = client(app);
    assert.equal((await c2('POST', '/api/auth/login', { password: 'long enough' })).status, 200);
  } finally { app.server.close(); app.shutdown(); }
});

test('hosted mode: browsing, folders, imports, exports and settings are limited to the allowed roots', async () => {
  const dir = tmpdir();
  const music = path.join(dir, 'music'), secret = path.join(dir, 'secret');
  fs.mkdirSync(music); fs.mkdirSync(secret);
  fs.writeFileSync(path.join(music, 'A - In.wav'), wav());
  fs.writeFileSync(path.join(secret, 'B - Out.wav'), wav());
  const app = await start({ port: 0, dataDir: path.join(dir, 'd'), auth: true, password: 'correct horse', roots: [music] });
  const c = client(app);
  try {
    await c('POST', '/api/auth/login', { password: 'correct horse' });
    const top = (await c('GET', '/api/browse')).json;
    assert.deepEqual(top.entries.map((e) => e.path), [fs.realpathSync(music)]);
    assert.equal((await c('GET', `/api/browse?path=${encodeURIComponent('/')}`)).status, 403);
    assert.equal((await c('GET', `/api/browse?path=${encodeURIComponent(secret)}`)).status, 403);
    assert.equal((await c('GET', `/api/browse?path=${encodeURIComponent(music)}`)).json.parent, '', 'no way up from a root');
    assert.deepEqual((await c('GET', '/api/drives')).json.map((d) => d.path), [fs.realpathSync(music)]);
    assert.equal((await c('POST', '/api/folders', { path: secret })).status, 403);
    assert.equal((await c('POST', '/api/folders', { path: music })).status, 200);
    assert.equal((await c('POST', '/api/files', { paths: [path.join(secret, 'B - Out.wav')] })).json.added.length, 0);
    const pl = (await c('POST', '/api/import/m3u', { content: `${path.join(secret, 'B - Out.wav')}\n${path.join(music, 'A - In.wav')}\n`, name: 'x' })).json;
    assert.equal(pl.trackIds.length, 1, 'only the file inside the roots was imported');
    assert.equal((await c('POST', '/api/import/m3u', { path: '/etc/hosts' })).status, 403);
    assert.equal((await c('POST', '/api/export/usb', { targetDir: secret, playlistIds: [pl.id] })).status, 403);
    assert.equal((await c('POST', '/api/tracks/relocate', { folder: secret })).status, 403);
    assert.equal((await c('PUT', '/api/settings', { downloadDir: secret })).status, 403);
    await c('PUT', '/api/settings', { allowedRoots: ['/'] });
    assert.equal(app.library.settings.allowedRoots, null, 'roots cannot be widened from the web UI');
    // a track pointing outside the roots (e.g. from a restored backup) is not served
    app.library.upsertTrack({ id: 'evil', sourceType: 'local', path: path.join(secret, 'B - Out.wav'), title: 'x' });
    assert.equal((await c('GET', '/api/tracks/evil/stream')).status, 403);
    assert.equal((await c('GET', `/api/tracks/${pl.trackIds[0]}/stream`)).status, 200);
  } finally { app.server.close(); app.shutdown(); }
});

test('upload: streams into the uploads folder, adds the track; extension allowlist, size limit, name sanitising', async () => {
  const dir = tmpdir();
  const app = await start({ port: 0, dataDir: path.join(dir, 'd'), auth: true, password: 'correct horse' });
  const c = client(app);
  const up = (name, body) => c('POST', '/api/upload', body, { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(name) });
  try {
    assert.equal((await up('a.wav', wav())).status, 401, 'needs login');
    await c('POST', '/api/auth/login', { password: 'correct horse' });
    const r = await up('Test Artist - Uploaded Song.wav', wav(0.5));
    assert.equal(r.status, 200, r.text);
    const t = app.library.getTrack(r.json.id);
    assert.equal(t.title, 'Uploaded Song');
    assert.equal(t.artist, 'Test Artist');
    const uploads = path.join(dir, 'd', 'Uploads');
    assert.equal(path.dirname(t.path), uploads);
    assert.ok(app.library.data.folders.some((f) => f.path === uploads), 'uploads folder is a library folder');
    const again = await up('Test Artist - Uploaded Song.wav', wav(0.5));
    assert.notEqual(again.json.id, r.json.id, 'same name: kept both');
    const trav = await up('../../../evil.wav', wav());
    assert.equal(trav.status, 200);
    assert.equal(path.dirname(app.library.getTrack(trav.json.id).path), uploads);
    assert.equal((await up('notes.txt', Buffer.from('hello'))).status, 415);
    assert.equal((await up('script.sh', Buffer.from('#!/bin/sh'))).status, 415);
    await c('PUT', '/api/settings', { uploadMaxMB: 0.001 }); // ~1 KB
    assert.equal((await up('big.wav', wav(2))).status, 413);
    assert.deepEqual(fs.readdirSync(uploads).filter((f) => f.endsWith('.part')), [], 'no partial files left');
    const st = await c('GET', `/api/tracks/${r.json.id}/stream`);
    assert.equal(st.status, 200);
  } finally { app.server.close(); app.shutdown(); }
});

test('loopback mode: no password, but Host (DNS rebinding) and Origin (CSRF) are checked', async () => {
  const app = await start({ port: 0, dataDir: path.join(tmpdir(), 'd') });
  const c = client(app);
  try {
    assert.equal(app.auth.enabled, false);
    assert.equal((await c('GET', '/api/tracks')).status, 200);
    assert.equal((await c('GET', '/api/auth/status')).json.enabled, false);
    assert.equal((await raw(app, 'GET', '/api/tracks', { Host: `localhost:${app.port}` })).status, 200);
    assert.equal((await raw(app, 'GET', '/api/settings', { Host: `evil.example:${app.port}` })).status, 421);
    assert.equal((await raw(app, 'GET', '/api/settings', { Host: `127.0.0.1:${app.port + 1}` })).status, 421);
    assert.equal((await c('POST', '/api/playlists', { name: 'x' }, { Origin: 'null' })).status, 403);
    assert.equal((await c('POST', '/api/playlists', { name: 'x' }, { Origin: `http://127.0.0.1:${app.port}` })).status, 200);
    assert.equal((await c('GET', '/api/health')).json.ok, true);
  } finally { app.server.close(); app.shutdown(); }
});

test('login.html: CSP hash matches its inline script', () => {
  const html = fs.readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const hash = crypto.createHash('sha256').update(script).digest('base64');
  assert.ok(html.includes(`'sha256-${hash}'`), 'update the CSP hash in login.html after editing its script');
});
