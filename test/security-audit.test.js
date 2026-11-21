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

// ---------------------------------------------------------------- #2 body limits
test('#2 body limits: 16 KiB for the public login routes, 1 MiB by default, explicit limits where big bodies are needed', () => hosted(async ({ app, c }) => {
  const pad = (n) => JSON.stringify({ password: 'x', pad: 'A'.repeat(n) });
  // pre-auth: refused on Content-Length alone, without buffering
  const big = await raw(app.port, 'POST', '/api/auth/login', { 'Content-Type': 'application/json', 'Content-Length': 45 * 2 ** 20 });
  assert.equal(big.status, 413);
  assert.equal((await raw(app.port, 'POST', '/api/auth/login', { 'Content-Type': 'application/json' }, pad(20 * 1024))).status, 413);
  assert.equal((await raw(app.port, 'POST', '/api/auth/setup', { 'Content-Type': 'application/json' }, pad(20 * 1024))).status, 413);
  // default 1 MiB
  assert.equal((await c('PUT', '/api/lyrics/settings', { online: false, pad: 'A'.repeat(1.5 * 2 ** 20) })).status, 413);
  assert.equal((await c('PUT', '/api/lyrics/settings', { online: false, pad: 'A'.repeat(100 * 1024) })).status, 200);
  assert.equal((await c('POST', '/api/playlists', { name: 'x', pad: 'A'.repeat(1.5 * 2 ** 20) })).status, 200, 'playlists take long id lists');
  // explicit bigger limits keep working
  const ids = Array.from({ length: 60000 }, (_, i) => `t${i}`.padEnd(20, 'x')); // ~1.4 MB of ids
  assert.equal((await c('POST', '/api/tracks/update', { ids, patch: { rating: 1 } })).status, 200);
  assert.equal((await c('POST', '/api/tracks/delete', { ids })).status, 200);
  assert.equal((await c('POST', '/api/import/m3u', { content: '#EXTM3U\n' + '# pad\n'.repeat(500000), name: 'big' })).status, 200);
  const r = await c('POST', '/api/restore', backup({ playlists: [{ id: 'p', name: 'P', trackIds: ids }] }));
  assert.equal(r.status, 200);
  app.library.upsertTrack({ id: 'w1', sourceType: 'local', path: '/nowhere.wav', title: 'w' });
  assert.equal((await c('PUT', '/api/tracks/w1/waveform', Buffer.alloc(4 * 2 ** 20))).status, 200);
}));

// ---------------------------------------------------------------- #3 login rate limit
test('#3 trust-proxy: the right-most X-Forwarded-For hop is used; a proxy list is only trusted from those peers', async () => {
  const { Auth } = await import('../server/auth.js');
  const dir = tmpdir();
  const req = (peer, xff, extra = {}) => ({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': xff, ...extra } });
  const a1 = new Auth({ dataDir: dir, enabled: true, password: PW, trustProxy: '1', log: {} });
  assert.equal(a1.clientIp(req('10.0.0.1', '6.6.6.6, 203.0.113.9')), '203.0.113.9', 'client-supplied left hops are ignored');
  assert.equal(a1.clientIp(req('10.0.0.1', '')), '10.0.0.1');
  const a2 = new Auth({ dataDir: dir, enabled: true, password: PW, trustProxy: '10.0.0.1, 10.0.0.2', log: {} });
  assert.equal(a2.clientIp(req('10.0.0.1', '6.6.6.6, 203.0.113.9, 10.0.0.2')), '203.0.113.9', 'chained trusted proxies are skipped');
  assert.equal(a2.clientIp(req('::ffff:10.0.0.1', '203.0.113.9')), '203.0.113.9');
  assert.equal(a2.clientIp(req('198.51.100.7', '1.2.3.4')), '198.51.100.7', 'XFF from an untrusted peer is ignored');
  assert.equal(a2.isSecure(req('198.51.100.7', '', { 'x-forwarded-proto': 'https' })), false);
  assert.equal(a2.isSecure(req('10.0.0.1', '', { 'x-forwarded-proto': 'http, https' })), true);
  const a3 = new Auth({ dataDir: dir, enabled: true, password: PW, trustProxy: undefined, log: {} });
  assert.equal(a3.clientIp(req('198.51.100.7', '1.2.3.4')), '198.51.100.7');
});

test('#3 rotating X-Forwarded-For does not escape the per-client lock (trust-proxy=1)', () => hosted(async ({ app }) => {
  let locked = false;
  for (let i = 0; i < 8; i++) {
    const r = await raw(app.port, 'POST', '/api/auth/login', { 'Content-Type': 'application/json', 'X-Forwarded-For': `9.9.9.${i}, 203.0.113.5` }, JSON.stringify({ password: 'bad' }));
    if (r.status === 429) locked = true;
  }
  assert.ok(locked, 'the proxy-added (right-most) hop is the same for every attempt');
}, { login: false, trustProxy: '1' }));

test('#3 an attacker on the same address cannot lock out a browser that signed in before; global budget slows, never locks', async () => {
  const { Auth } = await import('../server/auth.js');
  const auth = new Auth({ dataDir: tmpdir(), enabled: true, password: PW, log: {} });
  const res = () => { const h = {}; return { setHeader: (k, v) => { h[k] = v; }, h }; };
  const owner = { socket: { remoteAddress: '192.0.2.1' }, headers: {} };
  const r0 = res();
  await auth.login(owner, r0, PW);
  const dev = r0.h['Set-Cookie'].find((c) => c.startsWith('opendj_device=')).split(';')[0];
  assert.match(r0.h['Set-Cookie'].find((c) => c.startsWith('opendj_device=')), /HttpOnly; SameSite=Strict/);
  const attacker = { socket: { remoteAddress: '192.0.2.1' }, headers: {} };
  for (let i = 0; i < 6; i++) await auth.login(attacker, res(), 'wrong').catch(() => {});
  await assert.rejects(auth.login(attacker, res(), PW), (e) => e.status === 429, 'that address is locked');
  await auth.login({ ...owner, headers: { cookie: dev } }, res(), PW); // the known device still gets in
  // forged device cookies are not honoured
  await assert.rejects(auth.login({ ...owner, headers: { cookie: 'opendj_device=AAAAAAAAAAAAAAAAAAAAAA.' + 'A'.repeat(43) } }, res(), PW), (e) => e.status === 429);
  // global budget: many addresses failing slows every attempt down, but the right password still works
  for (let i = 0; i < 24; i++) await auth.login({ socket: { remoteAddress: `198.51.100.${i}` }, headers: {} }, res(), 'wrong').catch(() => {});
  assert.ok(auth.globalDelay() > 0);
  const t0 = Date.now();
  await auth.login({ socket: { remoteAddress: '203.0.113.50' }, headers: {} }, res(), PW);
  assert.ok(Date.now() - t0 >= auth.globalDelay() - 300, 'attempt was delayed');
});

test('#3 scrypt does not block the event loop; setup code shares the limits', async () => {
  const { Auth } = await import('../server/auth.js');
  const auth = new Auth({ dataDir: tmpdir(), enabled: true, password: PW, log: {} });
  let ticks = 0;
  const iv = setInterval(() => ticks++, 1);
  await Promise.all(Array.from({ length: 6 }, () => auth.login({ socket: { remoteAddress: '192.0.2.9' }, headers: {} }, { setHeader() {} }, 'wrong').catch(() => {})));
  clearInterval(iv);
  assert.ok(ticks > 5, `timers kept running during scrypt (${ticks})`);
  const lines = [];
  const s = new Auth({ dataDir: tmpdir(), enabled: true, password: '', log: { log: (m) => lines.push(m) } });
  const who = { socket: { remoteAddress: '192.0.2.10' }, headers: {} };
  for (let i = 0; i < 5; i++) await s.setup(who, { setHeader() {} }, { code: 'NOPE', password: PW }).catch(() => {});
  await assert.rejects(s.setup(who, { setHeader() {} }, { code: s.setupCode, password: PW }), (e) => e.status === 429);
});

// ---------------------------------------------------------------- #4 weak env password
test('#4 a short or example OPENDJ_PASSWORD refuses to start', async () => {
  const { Auth } = await import('../server/auth.js');
  for (const pw of ['change-me', 'CHANGE-ME', 'choose-a-password', 'password', 'opendj', 'short', '1234567']) {
    assert.throws(() => new Auth({ dataDir: tmpdir(), enabled: true, password: pw, log: {} }), /OPENDJ_PASSWORD is too weak/, pw);
  }
  await assert.rejects(start({ port: 0, host: '127.0.0.1', auth: true, dataDir: tmpdir(), password: 'change-me', ffmpeg: false, log: {} }), /too weak/);
  assert.ok(new Auth({ dataDir: tmpdir(), enabled: true, password: 'e2e-web-password', log: {} }).envPassword);
  assert.ok(new Auth({ dataDir: tmpdir(), enabled: false, password: 'x', log: {} }), 'ignored when login is off');
  const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(compose, /^\s*OPENDJ_PASSWORD:\s*"?change-me/m, 'compose ships no default password');
  for (const f of ['../README.md', '../Dockerfile', '../docker-compose.yml']) {
    const txt = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const m of txt.matchAll(/OPENDJ_PASSWORD[=:]\s*['"]?([^'"\s]+)/g)) {
      if (m[1].startsWith('$')) continue;
      assert.ok(m[1].length >= 8 && !/^(change-me|choose-a-password|password|opendj)$/i.test(m[1]), `${f}: example password "${m[1]}" would be refused`);
    }
  }
});

// ---------------------------------------------------------------- #5 write-only secrets vs. new targets
const fakeSubsonic = async () => {
  const log = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); log.push(u.searchParams);
    res.setHeader('Content-Type', 'application/json');
    if (!u.searchParams.get('p')) return res.end(JSON.stringify({ 'subsonic-response': { status: 'failed', error: { code: 41, message: 'token auth not supported' } } }));
    res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', type: 'fake', musicFolders: {}, searchResult3: {}, playlists: {} } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, log, close: () => srv.close() };
};
const md5 = async (s) => (await import('node:crypto')).createHash('md5').update(s).digest('hex');

test('#5 media sources: a saved password/token is never sent to a new URL; server-only fields are ignored', () => desktop(async ({ app, c }) => {
  const { sourceConfigFromForm } = await import('../server/sources/index.js');
  const prev = { id: 's1', type: 'jellyfin', name: 'J', url: 'http://a.example:8096', username: 'dj', password: 'PW', token: 'TOK', userId: 'U1', pathPrefix: '', lastSync: 5 };
  assert.deepEqual([sourceConfigFromForm({ id: 's1', type: 'jellyfin', name: 'J2', url: 'http://a.example:8096/', username: 'dj' }, prev)].map((x) => [x.password, x.token, x.userId, x.name, x.lastSync]), [['PW', 'TOK', 'U1', 'J2', 5]], 'same endpoint keeps them');
  for (const change of [{ url: 'http://evil.example:8096' }, { username: 'other' }, { type: 'emby' }]) {
    const cfg = sourceConfigFromForm({ id: 's1', type: 'jellyfin', url: prev.url, username: 'dj', ...change }, prev);
    assert.equal(cfg.password, undefined, JSON.stringify(change)); assert.equal(cfg.token, undefined); assert.equal(cfg.userId, undefined);
  }
  const injected = sourceConfigFromForm({ type: 'jellyfin', url: 'http://x', username: 'u', token: 'T', userId: 'U', legacyAuth: true, deviceId: 'D' }, null);
  assert.deepEqual([injected.token, injected.userId, injected.legacyAuth, injected.deviceId], [undefined, undefined, undefined, undefined]);
  assert.equal(sourceConfigFromForm({ type: 'plex', url: 'http://x', token: 'PLEXTOKEN' }, null).token, 'PLEXTOKEN', 'the Plex form has a token field');

  // end to end: re-point a saved legacy-auth Subsonic source at another server without retyping the password
  const a = await fakeSubsonic(), b = await fakeSubsonic();
  try {
    const r1 = await c('POST', '/api/sources', { type: 'subsonic', name: 'S', url: a.url, username: 'dj', password: 'TOPSECRET', legacyAuth: true });
    assert.equal(r1.status, 200);
    const id = r1.json.source.id;
    const r2 = await c('POST', '/api/sources', { id, type: 'subsonic', name: 'S', url: b.url, username: 'dj' });
    assert.notEqual(r2.status, 200, 'cannot connect without the password');
    for (const q of b.log) {
      assert.notEqual(q.get('p'), 'enc:' + Buffer.from('TOPSECRET').toString('hex'));
      if (q.get('t')) assert.notEqual(q.get('t'), await md5('TOPSECRET' + q.get('s')));
    }
    assert.equal(app.library.getSource(id).url, a.url, 'stored source unchanged');
    // without the legacy checkbox, error 41 does not make the server send the password in the URL
    const r3 = await c('POST', '/api/sources', { type: 'subsonic', name: 'S2', url: b.url, username: 'dj', password: 'OTHERSECRET' });
    assert.notEqual(r3.status, 200);
    assert.equal(b.log.some((q) => q.get('p')), false);
    // restore: a backup that moves a source keeps no secret
    const bk = JSON.parse((await c('GET', '/api/backup')).body);
    bk.library.sources[0].url = b.url;
    await c('POST', '/api/restore', bk);
    assert.equal(app.library.getSource(id).password, undefined);
  } finally { a.close(); b.close(); }
}));

test('#5 broadcast secrets and the Hue key are dropped when the target changes', () => desktop(async ({ app, c }) => {
  let r = await c('PUT', '/api/broadcast/config', { targets: [{ id: 'ice', type: 'icecast', host: 'radio.example.com', port: 8000, password: 'ICEPW' }, { id: 'tw', type: 'rtmp', rtmpUrl: 'rtmp://live.twitch.tv/app', streamKey: 'live_KEY_123' }] });
  assert.deepEqual(r.json.config.targets.map((t) => [t.hasPassword, t.hasStreamKey]), [[true, false], [false, true]]);
  r = await c('PUT', '/api/broadcast/config', { targets: [{ id: 'ice', type: 'icecast', host: 'radio.example.com', port: 8000, stationName: 'renamed' }, { id: 'tw', type: 'rtmp', rtmpUrl: 'rtmp://live.twitch.tv/app' }] });
  assert.deepEqual(r.json.config.targets.map((t) => [t.hasPassword, t.hasStreamKey]), [[true, false], [false, true]], 'same endpoint: kept');
  for (const change of [{ host: 'evil.example' }, { port: 8001 }, { tls: true }, { username: 'admin' }]) {
    await c('PUT', '/api/broadcast/config', { targets: [{ id: 'ice', type: 'icecast', host: 'radio.example.com', port: 8000, password: 'ICEPW' }] });
    r = await c('PUT', '/api/broadcast/config', { targets: [{ id: 'ice', type: 'icecast', host: 'radio.example.com', port: 8000, ...change }] });
    assert.equal(r.json.config.targets[0].hasPassword, false, JSON.stringify(change));
  }
  await c('PUT', '/api/broadcast/config', { targets: [{ id: 'tw', type: 'rtmp', rtmpUrl: 'rtmp://live.twitch.tv/app', streamKey: 'live_KEY_123' }] });
  r = await c('PUT', '/api/broadcast/config', { targets: [{ id: 'tw', type: 'rtmp', rtmpUrl: 'rtmp://evil.example/app' }] });
  assert.equal(r.json.config.targets[0].hasStreamKey, false);
  // Hue: the redacted key only stands for the stored one on the same bridge
  app.library.updateSettings({ lighting: { outputs: { hue: { bridge: '10.0.0.2', username: 'HUESECRET' } } } });
  app.lighting.engine?.setConfig?.(app.library.settings.lighting);
  await c('PUT', '/api/settings', { lighting: { outputs: { hue: { bridge: '10.6.6.6', username: '••••••' } } } });
  assert.equal(app.library.settings.lighting.outputs.hue.username, '');
  app.library.updateSettings({ lighting: { outputs: { hue: { bridge: '10.0.0.2', username: 'HUESECRET' } } } });
  await c('PUT', '/api/settings', { lighting: { outputs: { hue: { bridge: '10.0.0.2', username: '••••••' } } } });
  assert.equal(app.library.settings.lighting.outputs.hue.username, 'HUESECRET');
}));

test('#5 lighting config: a new Hue bridge address needs pairing again', async () => {
  const { registerLightingRoutes } = await import('../server/lighting/routes.js');
  const routes = {};
  const library = { settings: { lighting: { outputs: { hue: { bridge: '10.0.0.2', username: 'HUESECRET' } } } }, updateSettings(p) { Object.assign(this.settings, p); } };
  const l = registerLightingRoutes({ route: (m, p, h) => { routes[`${m} ${p}`] = h; }, library, fetch: async () => { throw new Error('offline'); } });
  try {
    const put = (hue) => routes['PUT /api/lighting/config']({ body: { ...l.engine?.config, outputs: { ...(library.settings.lighting.outputs), hue } } });
    await put({ bridge: '10.6.6.6', username: '••••••' });
    assert.equal(library.settings.lighting.outputs.hue.username, '');
    library.settings.lighting.outputs.hue = { bridge: '10.0.0.2', username: 'HUESECRET' };
    l.engine?.setConfig?.(library.settings.lighting);
  } finally { l.close?.(); }
});

test('#5 (suspected) RTMP stream key is redacted from FFmpeg errors', async () => {
  const { redactKey } = await import('../server/broadcast.js');
  assert.equal(redactKey('Error opening output rtmp://live.twitch.tv/app/live_KEY_123: I/O error', 'live_KEY_123'), 'Error opening output rtmp://live.twitch.tv/app/***: I/O error');
  assert.doesNotMatch(redactKey('rtmp://a.example/app/sk_abcdefghijklmnop failed', ''), /abcdefghijklmnop/);
});

// ---------------------------------------------------------------- #6 active content on the app origin / #11 framing
const id3WithCover = (mime, data) => {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(mime + '\0'), Buffer.from([3]), Buffer.from('\0'), data]);
  const fh = Buffer.alloc(10); fh.write('APIC', 0); fh.writeUInt32BE(body.length, 4);
  const frames = Buffer.concat([fh, body]), n = frames.length;
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]), frames, Buffer.alloc(2048)]);
};

test('#6 embedded SVG covers and HTML from media servers are never served as active content', () => desktop(async ({ app, c, dir }) => {
  const svg = path.join(dir, 'svg.mp3'), jpg = path.join(dir, 'jpg.mp3');
  fs.writeFileSync(svg, id3WithCover('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')));
  fs.writeFileSync(jpg, id3WithCover('image/jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])));
  app.library.upsertTrack({ id: 'svg', sourceType: 'local', path: svg, title: 's' });
  app.library.upsertTrack({ id: 'jpg', sourceType: 'local', path: jpg, title: 'j' });
  const s = await c('GET', '/api/tracks/svg/cover');
  assert.equal(s.status, 200);
  assert.equal(s.headers['content-type'], 'application/octet-stream');
  assert.equal((await c('GET', '/api/tracks/jpg/cover')).headers['content-type'], 'image/jpeg');
  // a media server answering text/html for a stream or a cover
  const up = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<script>alert(document.domain)</script>'); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  try {
    app.library.saveSource({ id: 'ss', type: 'subsonic', name: 'S', url: `http://127.0.0.1:${up.address().port}`, username: 'u', password: 'p' });
    app.library.upsertTrack({ id: 'rem', sourceType: 'remote', sourceId: 'ss', remoteId: '42', format: 'mp3', hasCover: true, title: 'r' });
    for (const p of ['/api/tracks/rem/cover', '/api/tracks/rem/stream']) {
      const r = await c('GET', p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], 'application/octet-stream', p);
      assert.equal(r.headers['content-security-policy'], "default-src 'none'; sandbox", p);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
    }
  } finally { up.close(); }
  const { safeMediaType } = await import('../server/index.js');
  assert.equal(safeMediaType('audio/flac'), 'audio/flac');
  assert.equal(safeMediaType('video/mp4; codecs=x'), 'video/mp4');
  assert.equal(safeMediaType('image/svg+xml', 'image'), 'application/octet-stream');
  assert.equal(safeMediaType('image/png', 'audio'), 'application/octet-stream');
  // every API response carries the sandbox CSP; JSON and SSE still work
  const j = await c('GET', '/api/settings');
  assert.equal(j.headers['content-security-policy'], "default-src 'none'; sandbox");
  assert.equal(j.headers['content-type'], 'application/json');
}));

test('#11 frames are refused in every mode (X-Frame-Options + frame-ancestors on HTML)', () => desktop(async ({ c }) => {
  for (const p of ['/', '/index.html', '/login.html', '/video.html']) {
    const r = await c('GET', p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['x-frame-options'], 'DENY', p);
    // the page's own <meta> policy is sent as the header too (QA p5), with frame-ancestors added
    const csp = r.headers['content-security-policy'], meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(r.body)?.[1];
    assert.ok(csp.endsWith("; frame-ancestors 'none'") && meta && csp.startsWith(meta.replace(/;\s*$/, '')), `${p}: ${csp}`);
    assert.match(csp, /default-src 'self'/, p);
  }
  assert.equal((await c('GET', '/api/info')).headers['x-frame-options'], 'DENY');
}));

// ---------------------------------------------------------------- #8 open redirect after login
test('#8 login.html only returns to pages of this server', async () => {
  const vm = await import('node:vm');
  const html = fs.readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
  const src = /const next = \(\) => \{[\s\S]*?\n {2}\};/.exec(html)[0];
  const nextFor = (q) => vm.runInNewContext(`${src}; next()`, { URL, URLSearchParams, location: { origin: 'http://nas:7380', search: q === null ? '' : '?next=' + q } });
  for (const evil of ['/%5Cattacker.example/phish', '/%09/attacker.example/x', '//attacker.example', '/\\attacker.example', 'https://attacker.example/', '/.//attacker.example', 'javascript:alert(1)', '/%2F%2Fattacker.example', encodeURIComponent('/\\attacker.example')]) {
    const r = nextFor(evil);
    assert.ok(r === '/' || new URL(r).origin === 'http://nas:7380', `${evil} -> ${r}`);
  }
  assert.equal(nextFor(encodeURIComponent('/?deck=2#lib')), 'http://nas:7380/?deck=2#lib');
  assert.equal(nextFor('/login.html'), '/');
  assert.equal(nextFor(null), 'http://nas:7380/');
});

// ---------------------------------------------------------------- #9 prototype pollution through ids
test('#9 ids like __proto__ / constructor never reach Object.prototype', () => desktop(async ({ app, c }) => {
  assert.equal(app.library.getTrack('__proto__'), undefined);
  assert.equal(app.library.getTrack('constructor'), undefined);
  assert.equal(app.library.getTrack('toString'), undefined);
  const r = await c('POST', '/api/tracks/update', { ids: ['__proto__', 'constructor', 'prototype', 'hasOwnProperty'], patch: { title: 'polluted', bpm: 999, tags: ['x'] } });
  assert.equal(r.status, 200);
  assert.equal(r.json.updated, 0);
  assert.equal({}.title, undefined);
  assert.equal({}.bpm, undefined);
  assert.equal(Object.prototype.userEdited, undefined);
  for (const p of ['/api/tracks/__proto__', '/api/tracks/constructor']) assert.equal((await c('PATCH', p, { title: 'x' })).status, 404, p);
  assert.equal((await c('GET', '/api/tracks/__proto__/stream')).status, 404);
  assert.equal((await c('POST', '/api/tracks/played', { id: '__proto__' })).status, 404);
  const pl = (await c('POST', '/api/playlists', { name: 'P' })).json;
  assert.equal((await c('POST', `/api/playlists/${pl.id}/add`, { trackIds: ['__proto__', 'constructor'] })).json.trackIds.length, 0);
  assert.equal(app.library.getPlaylist('__proto__'), undefined);
  assert.equal(app.library.getSource('constructor'), undefined);
  assert.equal(app.library.getFolder('__proto__'), undefined);
  assert.equal((await c('POST', '/api/folders/__proto__/scan')).status, 404);
  assert.throws(() => app.library.upsertTrack({ id: '__proto__', title: 'x' }), /Bad track id/);
  assert.equal({}.playCount, undefined);
}));

// ---------------------------------------------------------------- #12 private files on disk
test('#12 data dir 0700, library/settings JSON 0600 (existing files fixed on startup)', { skip: process.platform === 'win32' }, async () => {
  const { Library } = await import('../server/library.js');
  const root = tmpdir();
  const dir = path.join(root, 'data');
  const lib = new Library(dir);
  lib.saveSource({ id: 's', type: 'subsonic', url: 'http://x', password: 'pw' });
  lib.flush(); lib.flush(); // second flush also writes .bak
  const mode = (f) => fs.statSync(f).mode & 0o777;
  assert.equal(mode(dir), 0o700);
  for (const f of ['library.json', 'settings.json', 'library.json.bak', 'settings.json.bak']) assert.equal(mode(path.join(dir, f)), 0o600, f);
  // an older install with world-readable files
  const old = path.join(root, 'old'); fs.mkdirSync(old);
  for (const f of ['library.json', 'settings.json', 'auth.json']) fs.writeFileSync(path.join(old, f), '{}', { mode: 0o644 });
  fs.writeFileSync(path.join(old, 'library.json.tmp'), '{}', { mode: 0o644 });
  const lib2 = new Library(old);
  for (const f of ['library.json', 'settings.json', 'auth.json']) assert.equal(mode(path.join(old, f)), 0o600, f);
  lib2.flush();
  assert.equal(mode(path.join(old, 'library.json')), 0o600, 'rewritten through a leftover 0644 .tmp');
});

// ---------------------------------------------------------------- #10 desktop server per-launch token
test('#10 desktop launch token: every request needs the cookie (static, API, SSE, media); start() without one is unchanged', async () => {
  const dir = tmpdir();
  const f = path.join(dir, 'a.wav'); fs.writeFileSync(f, wav());
  const app = await start({ port: 0, dataDir: path.join(dir, 'd'), ffmpeg: false, launchToken: 'tok-123456789', log: { log() {}, warn() {}, error() {} } });
  try {
    app.library.upsertTrack({ id: 't1', sourceType: 'local', path: f, title: 'a' });
    const get = (p, cookie) => raw(app.port, 'GET', p, cookie ? { Cookie: cookie } : {});
    for (const p of ['/', '/index.html', '/js/app.js', '/video.html', '/api/info', `/api/browse?path=${encodeURIComponent(os.homedir())}`, '/api/tracks/t1/stream', '/api/tracks/t1/cover', '/api/events']) {
      assert.equal((await get(p)).status, 401, p);
      assert.equal((await get(p, 'opendj_launch=wrong')).status, 401, p);
    }
    for (const p of ['/', '/video.html', '/api/info', '/api/tracks/t1/stream']) assert.equal((await get(p, 'other=1; opendj_launch=tok-123456789')).status, 200, p);
    const ctrl = new AbortController();
    const es = await fetch(app.url + 'api/events', { headers: { Cookie: 'opendj_launch=tok-123456789' }, signal: ctrl.signal });
    assert.equal(es.status, 200); ctrl.abort();
  } finally { app.server.close(); app.shutdown(); }
  await desktop(async ({ c }) => { assert.equal((await c('GET', '/api/info')).status, 200, 'no token configured: open as before'); });
});

// ---------------------------------------------------------------- #14 Electron pop-ups (static check; run headless with xvfb + Playwright _electron)
test('#14 electron/main.js applies the pop-up / navigation / webview policy to every webContents and sets the launch cookie', () => {
  const src = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
  assert.match(src, /app\.on\('web-contents-created'/);
  for (const ev of ['setWindowOpenHandler', "'will-navigate'", "'will-redirect'", "'will-attach-webview'"]) assert.ok(src.includes(ev), ev);
  assert.doesNotMatch(src, /win\.webContents\.setWindowOpenHandler/, 'not only on the main window');
  assert.match(src, /cookies\.set\(\{[^}]*httpOnly: true, sameSite: 'strict'/);
  assert.ok(src.indexOf('cookies.set(') < src.indexOf('win.loadURL('), 'cookie before loadURL');
});

// ---------------------------------------------------------------- #15 supply chain
test('#15 Dockerfile base image pinned by digest; ffmpeg download location cannot be redirected and is hash-checked', async () => {
  const docker = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(docker, /^FROM node:\d+-slim@sha256:[0-9a-f]{64}$/m); // any Node version, always pinned by digest
  const { createRequire } = await import('node:module');
  const bp = createRequire(import.meta.url)('../build/before-pack.cjs');
  process.env.FFMPEG_BINARIES_URL = 'https://evil.example'; process.env.FFMPEG_BINARY_RELEASE = 'x'; process.env.FFMPEG_BIN = '/tmp/x';
  try {
    const env = bp.installEnv({ npm_config_arch: 'arm64' });
    for (const k of ['FFMPEG_BINARIES_URL', 'FFMPEG_BINARY_RELEASE', 'FFMPEG_BIN']) assert.equal(k in env, false, k);
    assert.equal(env.npm_config_arch, 'arm64');
  } finally { delete process.env.FFMPEG_BINARIES_URL; delete process.env.FFMPEG_BINARY_RELEASE; delete process.env.FFMPEG_BIN; }
  const dir = tmpdir(); // never the real node_modules: a mismatch deletes the binary
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ 'ffmpeg-static': { 'binary-release-tag': 'b6.1.1' } }));
  fs.writeFileSync(path.join(dir, 'ffmpeg'), 'not the real ffmpeg');
  assert.throws(() => bp.verifyFfmpeg(dir, 'linux-x64'), /does not match/);
  assert.equal(fs.existsSync(path.join(dir, 'ffmpeg')), false, 'rejected binary removed');
});

// ---------------------------------------------------------------- suspected items
test('(suspected) media-server downloads are capped (declared and actual size); hosted stems uploads default to 30 minutes', async () => {
  const { Library } = await import('../server/library.js');
  const { DownloadManager } = await import('../server/remote.js');
  const dir = tmpdir();
  const big = Buffer.alloc(1.5 * 2 ** 20);
  const srv = http.createServer((req, res) => {
    if (req.url.includes('id=declared')) { res.writeHead(200, { 'Content-Length': String(5 * 2 ** 30) }); return res.end(); }
    res.writeHead(200); res.write(big); res.end(big); // chunked, no length
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const lib = new Library(path.join(dir, 'data'));
    lib.settings.downloadMaxMB = 1;
    lib.saveSource({ id: 's', type: 'subsonic', name: 'S', url: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p' });
    for (const id of ['declared', 'lying']) lib.upsertTrack({ id, sourceType: 'remote', sourceId: 's', remoteId: id, title: id, artist: 'A', format: 'mp3' });
    const m = new DownloadManager(lib, () => {});
    m.enqueue(['declared', 'lying']);
    for (let i = 0; i < 200 && m.done.length < 2; i++) await sleep(20);
    assert.deepEqual(m.done.map((d) => d.ok), [false, false]);
    for (const d of m.done) assert.match(d.error, /limit/);
    const left = fs.readdirSync(lib.settings.downloadDir, { recursive: true }).filter((f) => /\.(mp3|part)$/.test(f));
    assert.deepEqual(left, [], 'nothing kept');
    lib.flush();
  } finally { srv.close(); }
  await hosted(async ({ app, c }) => {
    app.library.upsertTrack({ id: 'trk', sourceType: 'local', path: '/x.wav', title: 'x' });
    assert.equal((await c('POST', '/api/stems/trk/begin', { frames: 44100 * 60 * 31, sampleRate: 44100 })).status, 400);
    assert.equal((await c('POST', '/api/stems/trk/begin', { frames: 44100 * 60 * 29, sampleRate: 44100 })).status, 200);
  });
});

// ---------------------------------------------------------------- B1 README reverse-proxy recipe / N7 malformed cookie
test('B1 the README reverse-proxy recipe (HOST=127.0.0.1 + proxy env) requires login and limits paths', async () => {
  const keys = ['OPENDJ_TRUST_PROXY', 'OPENDJ_PASSWORD', 'OPENDJ_ALLOWED_HOSTS', 'OPENDJ_AUTH'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const set = (env) => { for (const k of keys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } };
  try {
    for (const env of [
      { OPENDJ_TRUST_PROXY: '1', OPENDJ_PASSWORD: PW, OPENDJ_ALLOWED_HOSTS: 'dj.example.com' },
      { OPENDJ_TRUST_PROXY: '127.0.0.1', OPENDJ_ALLOWED_HOSTS: 'dj.example.com' },
      { OPENDJ_PASSWORD: PW },
      { OPENDJ_ALLOWED_HOSTS: 'dj.example.com' },
    ]) {
      set(env);
      const app = await start({ port: 0, host: '127.0.0.1', dataDir: path.join(tmpdir(), 'd'), ffmpeg: false, log: { log() {}, warn() {}, error() {} } });
      try {
        const h = { Host: env.OPENDJ_ALLOWED_HOSTS || `127.0.0.1:${app.port}`, 'X-Forwarded-For': '203.0.113.7', 'X-Forwarded-Proto': 'https' };
        const tag = JSON.stringify(env);
        assert.equal(app.auth.enabled, true, tag);
        assert.equal((await raw(app.port, 'GET', '/', h)).status, 302, tag);
        assert.equal((await raw(app.port, 'GET', '/api/tracks', h)).status, 401, tag);
        assert.equal((await raw(app.port, 'GET', '/api/browse?path=%2F', h)).status, 401, tag);
        assert.equal((await raw(app.port, 'POST', '/api/folders', { ...h, 'Content-Type': 'application/json' }, JSON.stringify({ path: '/etc' }))).status, 401, tag);
        if (env.OPENDJ_PASSWORD) {
          const c = client(app);
          await c('POST', '/api/auth/login', { password: PW }, h);
          assert.equal((await c('POST', '/api/folders', { path: '/etc' }, h)).status, 403, 'signed in: still limited to the music roots');
          assert.equal((await c('GET', '/api/browse?path=%2F', undefined, h)).status, 403);
        }
      } finally { app.server.close(); app.shutdown(); }
    }
    set({ OPENDJ_ALLOWED_HOSTS: 'dj.example.com' });
    await assert.rejects(start({ port: 0, dataDir: path.join(tmpdir(), 'd'), auth: false, ffmpeg: false, log: {} }), /OPENDJ_ALLOWED_HOSTS/);
    set({});
    const plain = await start({ port: 0, dataDir: path.join(tmpdir(), 'd'), ffmpeg: false, log: { log() {}, warn() {}, error() {} } });
    try { assert.equal(plain.auth.enabled, false, 'plain npm run web on loopback is unchanged'); } finally { plain.server.close(); plain.shutdown(); }
  } finally { set(saved); }
});

test('N7 a malformed (bad percent-encoding) cookie is treated as no session, not a 500', () => hosted(async ({ app }) => {
  for (const cookie of ['opendj_session=%E0%A4%A', 'opendj_session=%; other=%zz', 'opendj_device=%%%; opendj_session=%C0']) {
    assert.equal((await raw(app.port, 'GET', '/api/tracks', { Cookie: cookie })).status, 401, cookie);
    assert.equal((await raw(app.port, 'GET', '/api/auth/status', { Cookie: cookie })).status, 200, cookie);
    assert.equal((await raw(app.port, 'POST', '/api/auth/login', { Cookie: cookie, 'Content-Type': 'application/json' }, JSON.stringify({ password: PW }))).status, 200, cookie);
  }
  const d = await start({ port: 0, dataDir: path.join(tmpdir(), 'd'), ffmpeg: false, launchToken: 'tok', log: { log() {}, warn() {}, error() {} } });
  try { assert.equal((await raw(d.port, 'GET', '/', { Cookie: 'opendj_launch=%E0' })).status, 401); } finally { d.server.close(); d.shutdown(); }
}, { login: false }));

test('desktop (launch token, auth:false) ignores hosted-mode login env vars but still requires the token', async () => {
  const keys = ['OPENDJ_PASSWORD', 'OPENDJ_AUTH', 'OPENDJ_ALLOWED_HOSTS', 'OPENDJ_TRUST_PROXY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { OPENDJ_PASSWORD: 'longenough123', OPENDJ_AUTH: '1', OPENDJ_ALLOWED_HOSTS: 'x.example', OPENDJ_TRUST_PROXY: '1' });
  const quiet = { log() {}, info() {}, warn() {}, error() {} };
  try {
    const s = await start({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'odj-desk-')), launchToken: 'tok', auth: false, password: '', trustProxy: '', allowedHosts: [], log: quiet });
    try {
      const u = `http://127.0.0.1:${s.port}/api/tracks`;
      assert.equal((await fetch(u)).status, 401);
      assert.equal((await fetch(u, { headers: { cookie: 'opendj_launch=tok' } })).status, 200);
    } finally { await s.close?.(); s.server?.close?.(); }
  } finally { for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
