// Remote control for AI assistants (server/mcp.js): MCP over Streamable HTTP. Off by default, token required,
// scopes enforced, loopback bind by default, rate limits, no secrets or paths in answers, strict input schemas,
// hosted mode needs the login session AND the token, audit log.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { start } from '../server/index.js';
import { validateArgs, TOOLS, publicTrack } from '../server/mcp.js';
import { encodeVocalMap } from '../public/js/shared/vocal-map.js';

const quiet = { log() {}, warn() {}, error() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'odj-mcp-'));
const json = (url, method = 'GET', body, headers = {}) => fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

/** A fake OpenDJ window: claims the relay, answers mcp-command events like public/js/remote-control.js would. */
async function fakePage(app, handler) {
  const page = 'a'.repeat(32);
  const ctrl = new AbortController();
  const res = await fetch(app.url + 'api/events', { signal: ctrl.signal });
  await json(app.url + 'api/mcp/claim', 'POST', { page });
  const seen = [];
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!/^event: mcp-command/m.test(block)) continue;
          const msg = JSON.parse(/^data: (.*)$/m.exec(block)[1]);
          if (msg.page !== page) continue;
          seen.push(msg);
          let out; try { out = { id: msg.id, result: await handler(msg.tool, msg.args) }; } catch (e) { out = { id: msg.id, error: e.message }; }
          await json(app.url + 'api/mcp/result', 'POST', out);
        }
      }
    } catch { /* aborted */ }
  })();
  return { seen, close: () => ctrl.abort() };
}

async function setup({ scopes = ['read', 'playback', 'broadcast'], port = 7903, enable = true, ...opts } = {}) {
  const dir = tmpDir();
  const app = await start({ port: 0, dataDir: dir, log: quiet, ffmpeg: false, ...opts });
  let token = null;
  if (enable) {
    const r = await (await json(app.url + 'api/mcp/config', 'PUT', { enabled: true, scopes, port })).json();
    token = r.token;
  }
  const url = `http://127.0.0.1:${port}/mcp`;
  let sid = null;
  const rpc = async (method, params, { auth = token, headers = {}, id = 1, raw } = {}) => {
    const h = { Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(sid ? { 'Mcp-Session-Id': sid } : {}), ...headers };
    const r = await json(url, 'POST', raw ?? { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, h);
    if (r.headers.get('mcp-session-id')) sid = r.headers.get('mcp-session-id');
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
  };
  const init = () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '1' } });
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  const close = async () => { app.shutdown(); await app.mcp.close(); app.server.closeAllConnections?.(); await new Promise((r) => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); };
  return { app, dir, token, url, rpc, init, call, close, setSid: (v) => { sid = v; } };
}

test('off by default: nothing listens, and the settings API says so', async () => {
  const s = await setup({ enable: false, port: 7904 });
  try {
    const c = await (await fetch(s.app.url + 'api/mcp/config')).json();
    assert.equal(c.enabled, false); assert.equal(c.running, false); assert.equal(c.host, '127.0.0.1'); assert.equal(c.hasToken, false);
    await assert.rejects(fetch('http://127.0.0.1:7904/mcp', { method: 'POST' }), 'no listener while off');
    assert.ok(!('mcp' in (await (await fetch(s.app.url + 'api/settings')).json())), 'not part of the general settings');
    // the general settings endpoint can't switch it on
    await json(s.app.url + 'api/settings', 'PUT', { mcp: { enabled: true, host: '0.0.0.0' } });
    assert.equal((await (await fetch(s.app.url + 'api/mcp/config')).json()).enabled, false);
  } finally { await s.close(); }
});

test('enabling: a 256-bit token shown once, stored only as a hash; loopback bind by default', async () => {
  const s = await setup({ port: 7905 });
  try {
    assert.match(s.token, /^odj_mcp_[A-Za-z0-9_-]{43}$/);
    const stored = fs.readFileSync(path.join(s.dir, 'mcp-token.json'), 'utf8');
    assert.ok(!stored.includes(s.token.slice(8)), 'the token itself is not stored');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(s.dir, 'mcp-token.json')).mode & 0o077, 0);
    const c = await (await fetch(s.app.url + 'api/mcp/config')).json();
    assert.equal(c.running, true); assert.equal(c.url, 'http://127.0.0.1:7905/mcp'); assert.equal(c.exposed, false);
    assert.ok(!JSON.stringify(c).includes(s.token), 'config never returns the token');
    assert.equal((await (await json(s.app.url + 'api/mcp/config', 'PUT', { scopes: ['read'] })).json()).token, undefined, 'shown only once');
    assert.equal(s.app.mcp.port, 7905);
  } finally { await s.close(); }
});

test('auth required: no token / wrong token / browser Origin / foreign Host refused; failed attempts rate limited', async () => {
  const s = await setup({ port: 7906 });
  try {
    assert.equal((await s.rpc('initialize', {}, { auth: null })).status, 401);
    assert.equal((await s.rpc('initialize', {}, { auth: 'odj_mcp_wrong-token-xxxxxxxxxxxxxxxx' })).status, 401);
    assert.equal((await s.rpc('initialize', {}, { headers: { Origin: 'https://evil.example' } })).status, 403, 'browser pages cannot call it');
    const rebind = await new Promise((resolve, reject) => { // fetch can't set Host: plain http.request
      const rq = http.request({ host: '127.0.0.1', port: 7906, path: '/mcp', method: 'POST', headers: { Host: 'evil.example:7906', Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode); });
      rq.on('error', reject); rq.end('{}');
    });
    assert.equal(rebind, 421, 'DNS rebinding: Host must be the loopback name');
    let last;
    for (let i = 0; i < 12; i++) last = await s.rpc('initialize', {}, { auth: 'odj_mcp_brute-force-attempt-' + i });
    assert.equal(last.status, 429, 'too many failed attempts');
    const audit = await (await fetch(s.app.url + 'api/mcp/audit')).json();
    assert.ok(audit.entries.some((e) => e.tool === '(auth)' && !e.ok), 'failed logins are in the audit log');
    assert.ok(!JSON.stringify(audit).includes('brute-force-attempt'), 'attempted tokens are not logged');
  } finally { await s.close(); }
});

test('protocol: initialize, session id, tools/list, ping, notifications, GET 405, DELETE ends the session', async () => {
  const s = await setup({ port: 7907, scopes: ['read'] });
  try {
    const i = await s.init();
    assert.equal(i.status, 200);
    assert.equal(i.body.result.protocolVersion, '2025-06-18');
    assert.equal(i.body.result.serverInfo.name, 'OpenDJ');
    assert.ok(i.body.result.capabilities.tools);
    const sid = i.headers.get('mcp-session-id'); assert.match(sid, /^[a-f0-9]{32}$/);
    assert.equal((await s.rpc(null, null, { raw: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
    assert.deepEqual((await s.rpc('ping')).body.result, {});
    const tools = (await s.rpc('tools/list')).body.result.tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['get_deck', 'get_status', 'get_track_details', 'list_genres', 'plan_transition', 'search_library'], 'only the tools the scopes allow are listed');
    assert.equal((await s.rpc('nope/method')).body.error.code, -32601);
    assert.equal((await s.rpc(null, null, { raw: [{ jsonrpc: '2.0', id: 1, method: 'ping' }] })).status, 400, 'no batching');
    assert.equal((await s.rpc('ping', null, { headers: { 'MCP-Protocol-Version': '1999-01-01' } })).status, 400);
    assert.equal((await fetch(s.url, { headers: { Authorization: `Bearer ${s.token}` } })).status, 405);
    s.setSid(null);
    assert.equal((await s.rpc('ping')).status, 400, 'session id required after initialize');
    s.setSid('f'.repeat(32));
    assert.equal((await s.rpc('ping')).status, 404, 'unknown session');
    assert.equal((await fetch(s.url, { method: 'DELETE', headers: { Authorization: `Bearer ${s.token}`, 'Mcp-Session-Id': sid } })).status, 204);
    s.setSid(sid);
    assert.equal((await s.rpc('ping')).status, 404, 'deleted session');
    const old = await s.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'old' } });
    assert.equal(old.body.result.protocolVersion, '2024-11-05', 'older clients negotiated');
  } finally { await s.close(); }
});

test('scope enforcement: read-only token cannot control playback or broadcast', async () => {
  const s = await setup({ port: 7908, scopes: ['read'] });
  const page = await fakePage(s.app, async () => ({ ok: true }));
  try {
    await s.init();
    for (const [name, args] of [['play', { deck: 1 }], ['set_crossfader', { position: 0 }], ['broadcast_start', { target_id: 'abc' }], ['queue_dedication', { text: 'hi' }]]) {
      const r = await s.call(name, args);
      assert.equal(r.body.error?.code, -32602, name);
      assert.match(r.body.error.message, /permission is off/);
    }
    assert.equal(page.seen.length, 0, 'nothing reached the app window');
  } finally { page.close(); await s.close(); }
});

test('playback tools are relayed to the open window; no window: a clear error', async () => {
  const s = await setup({ port: 7909 });
  try {
    await s.init();
    const none = await s.call('play', { deck: 1 });
    assert.equal(none.body.result.isError, true); assert.match(none.body.result.content[0].text, /not open/);
    const page = await fakePage(s.app, async (tool, args) => (tool === 'play' ? { deck: args.deck, playing: true } : tool === 'get_status' ? { decks: [] } : (() => { throw new Error('Deck 3 is not shown'); })()));
    const ok = await s.call('play', { deck: 2 });
    assert.deepEqual(ok.body.result.structuredContent, { deck: 2, playing: true });
    assert.deepEqual(page.seen.at(-1).args, { deck: 2 });
    const bad = await s.call('pause', { deck: 3 });
    assert.equal(bad.body.result.isError, true); assert.match(bad.body.result.content[0].text, /not shown/);
    const audit = (await (await fetch(s.app.url + 'api/mcp/audit')).json()).entries;
    assert.ok(audit.some((e) => e.tool === 'play' && e.ok && e.args === '{"deck":2}'));
    assert.ok(audit.some((e) => e.tool === 'pause' && !e.ok));
    page.close();
  } finally { await s.close(); }
});

test('injection-safe input schemas: unknown properties, wrong types, bounds, patterns', async () => {
  for (const [name, t] of Object.entries(TOOLS)) {
    assert.equal(t.inputSchema.additionalProperties, false, `${name}: closed schema`);
    for (const [k, p] of Object.entries(t.inputSchema.properties)) {
      if (p.type === 'string') assert.ok(p.maxLength || p.enum, `${name}.${k}: bounded string`);
      if (p.type === 'integer' || p.type === 'number') assert.ok(p.minimum != null && p.maximum != null, `${name}.${k}: bounded number`);
    }
  }
  const v = (tool, a) => validateArgs(TOOLS[tool].inputSchema, a);
  assert.equal(v('play', { deck: 1, path: '/etc/passwd' }).ok, false);
  assert.equal(v('play', { deck: '1' }).ok, false);
  assert.equal(v('play', { deck: 5 }).ok, false);
  assert.equal(v('play', { deck: 1.5 }).ok, false);
  assert.equal(v('play', {}).ok, false);
  assert.equal(v('load_track', { deck: 1, track_id: '../../etc/passwd' }).ok, false);
  assert.equal(v('load_track', { deck: 1, track_id: '__proto__x' }).ok, true, 'ids are only looked up, never used as paths');
  assert.equal(v('set_crossfader', { position: Infinity }).ok, false);
  assert.equal(v('set_crossfader', { position: NaN }).ok, false);
  assert.equal(v('queue_dedication', { text: 'x'.repeat(201) }).ok, false);
  assert.equal(v('queue_dedication', { text: '' }).ok, false);
  assert.equal(v('queue_dedication', { text: 'hi', language: 'fr' }).ok, false);
  assert.equal(v('broadcast_start', { target_id: 'a; rm -rf /' }).ok, false);
  assert.equal(v('automix_start', { track_ids: Array(201).fill('a') }).ok, false);
  assert.equal(v('automix_start', { track_ids: [{}] }).ok, false);
  assert.deepEqual(v('search_library', {}).value, { random: false, limit: 20 });
  assert.equal(v('search_library', { key: '13A' }).ok, false);
  assert.equal(v('set_mixer', { deck: 1, eq_low: -2 }).ok, false);
  assert.equal(v('set_fx', { deck: 1, type: 'eval' }).ok, false);
  assert.equal(v('set_loop', { deck: 1, beats: 64 }).ok, false);
  assert.equal(v('get_status', ['x']).ok, false);
  const s = await setup({ port: 7910 });
  try {
    await s.init();
    const r = await s.call('set_crossfader', { position: 0.5, eval: 'process.exit()' });
    assert.equal(r.body.error.code, -32602); assert.match(r.body.error.message, /unknown argument/);
    assert.equal((await s.call('constructor', {})).body.error.code, -32602);
    const big = await fetch(s.url, { method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70 * 1024) } }) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413, 'body limit');
  } finally { await s.close(); }
});

test('no secret leakage: library search returns metadata only; broadcast targets by id; stream password never returned', async () => {
  const s = await setup({ port: 7911 });
  try {
    const music = path.join(s.dir, 'Secret Folder'); fs.mkdirSync(music);
    const t = s.app.library;
    // a local track and a remote one with a token in its URL
    t.data.tracks.t1 = { id: 't1', title: 'Night Drive', artist: 'Ana', album: 'A', genre: 'House', bpm: 124, key: '8A', duration: 200, path: path.join(music, 'night.mp3'), sourceType: 'local', added: 2 };
    t.data.tracks.t2 = { id: 't2', title: 'Night Bus', artist: 'Mihai', path: 'https://media.example/stream?api_key=SECRET123', remoteId: 'r9', sourceType: 'remote', added: 1 };
    await json(s.app.url + 'api/broadcast/config', 'PUT', { targets: [{ id: 'radio1', type: 'icecast', name: 'My radio', host: 'stream.example', port: 8000, mount: '/live', password: 'hunter2-stream-pass' }] });
    await s.init();
    const r = (await s.call('search_library', { query: 'night' })).body.result.structuredContent;
    assert.equal(r.total, 2);
    for (const x of r.tracks) assert.deepEqual(Object.keys(x).sort(), ['album', 'artist', 'bpm', 'camelot', 'duration', 'energy', 'genre', 'has_stems', 'id', 'key', 'title', 'year']);
    const all = JSON.stringify(r);
    assert.ok(!all.includes('Secret Folder') && !all.includes('SECRET123') && !all.includes('night.mp3'));
    assert.deepEqual(Object.keys(publicTrack(t.data.tracks.t2)).sort(), ['album', 'artist', 'bpm', 'camelot', 'duration', 'energy', 'genre', 'has_stems', 'id', 'key', 'title', 'year']);
    // a target that does not exist is refused before anything is relayed
    const nope = await s.call('broadcast_start', { target_id: 'other' });
    assert.equal(nope.body.result.isError, true); assert.match(nope.body.result.content[0].text, /No stream target/);
    const page = await fakePage(s.app, async (tool, args) => ({ live: true, target_id: args.target_id }));
    const ok = await s.call('broadcast_start', { target_id: 'radio1' });
    assert.deepEqual(ok.body.result.structuredContent, { live: true, target_id: 'radio1' });
    assert.ok(!JSON.stringify(page.seen).includes('hunter2'), 'the page never gets the password through MCP');
    const audit = fs.readFileSync(path.join(s.dir, 'mcp-audit.log'), 'utf8');
    assert.ok(!audit.includes(s.token) && !audit.includes('hunter2'));
    page.close();
  } finally { await s.close(); }
});

test('rate limit on control actions', async () => {
  const s = await setup({ port: 7912 });
  const page = await fakePage(s.app, async () => ({ ok: true }));
  try {
    await s.init();
    let limited = 0;
    for (let i = 0; i < 35; i++) { const r = await s.call('trigger_sample', { pad: 1 }); if (r.body.result?.isError && /Too many/.test(r.body.result.content[0].text)) limited++; }
    assert.ok(limited >= 5, `limited ${limited}`);
    assert.ok(page.seen.length <= 30);
    assert.equal((await s.call('search_library', {})).body.result.isError, undefined, 'reads still work');
  } finally { page.close(); await s.close(); }
});

test('exposing it needs a valid bind address and is flagged; a new token disconnects clients', async () => {
  const s = await setup({ port: 7913 });
  try {
    assert.equal((await json(s.app.url + 'api/mcp/config', 'PUT', { host: 'evil.example' })).status, 400);
    assert.equal((await json(s.app.url + 'api/mcp/config', 'PUT', { port: 80 })).status, 400);
    const c = await (await json(s.app.url + 'api/mcp/config', 'PUT', { host: '0.0.0.0' })).json();
    assert.equal(c.exposed, true);
    await json(s.app.url + 'api/mcp/config', 'PUT', { host: '127.0.0.1' });
    await s.init();
    const fresh = await (await json(s.app.url + 'api/mcp/token', 'POST', {})).json();
    assert.notEqual(fresh.token, s.token);
    assert.equal((await s.rpc('ping')).status, 401, 'old token refused');
    assert.equal((await s.rpc('ping', null, { auth: fresh.token })).status, 404, 'old sessions dropped');
  } finally { await s.close(); }
});

test('hosted mode: no separate listener; /api/mcp/rpc needs the login session AND the token', async () => {
  const dir = tmpDir();
  const app = await start({ port: 0, dataDir: dir, log: quiet, ffmpeg: false, auth: true, password: 'correct horse battery staple' });
  try {
    const login = await json(app.url + 'api/auth/login', 'POST', { password: 'correct horse battery staple' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const r = await (await json(app.url + 'api/mcp/config', 'PUT', { enabled: true, scopes: ['read'] }, { Cookie: cookie })).json();
    assert.ok(r.token); assert.equal(r.hosted, true); assert.equal(r.url, '/api/mcp/rpc');
    assert.equal(app.mcp.port, null, 'no extra listener in hosted mode');
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } } };
    assert.equal((await json(app.url + 'api/mcp/rpc', 'POST', init, { Authorization: `Bearer ${r.token}` })).status, 401, 'token without a session');
    assert.equal((await json(app.url + 'api/mcp/rpc', 'POST', init, { Cookie: cookie })).status, 401, 'session without the token');
    const ok = await json(app.url + 'api/mcp/rpc', 'POST', init, { Cookie: cookie, Authorization: `Bearer ${r.token}`, Accept: 'application/json' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).result.serverInfo.name, 'OpenDJ');
  } finally { app.shutdown(); await app.mcp.close(); app.server.closeAllConnections?.(); await new Promise((r) => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('AI DJ tools: search filters, genres, track details with sections and vocal sections', async () => {
  const s = await setup({ port: 7912 });
  try {
    const t = s.app.library;
    const vocals = encodeVocalMap(Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 20 ? 1 : 0)));
    t.data.tracks.a = { id: 'a', title: 'Alpha', artist: 'X', genre: 'House; Deep House', bpm: 124, key: '8A', energy: 6, year: 2019, duration: 200, sourceType: 'local', path: 'C:/m/a.mp3', addedAt: 3,
      phrases: [{ start: 0, end: 30, type: 'intro', bars: 16 }, { start: 30, end: 170, type: 'drop', bars: 72 }, { start: 170, end: 200, type: 'outro', bars: 16 }], mixIn: 0, mixOut: 170,
      cues: [{ index: 0, type: 'hot', position: 30, name: 'Drop' }], stems: { ready: true, model: 'htdemucs-v4', vocals } };
    t.data.tracks.b = { id: 'b', title: 'Beta', artist: 'Y', genre: 'Techno', bpm: 132, key: '3B', energy: 8, year: 2023, duration: 300, sourceType: 'local', path: 'C:/m/b.mp3', addedAt: 2 };
    t.data.tracks.c = { id: 'c', title: 'Gamma', artist: 'Z', genre: 'House', bpm: 122, key: '9A', energy: 4, duration: 250, sourceType: 'local', path: 'C:/m/c.mp3', addedAt: 1 };
    await s.init();
    const ids = async (a) => (await s.call('search_library', a)).body.result.structuredContent.tracks.map((x) => x.id);
    assert.deepEqual(await ids({ genre: 'house' }), ['a', 'c']);
    assert.deepEqual(await ids({ bpm_min: 125 }), ['b']);
    assert.deepEqual((await ids({ compatible_with_key: '8A' })).sort(), ['a', 'c']);
    assert.deepEqual(await ids({ key: '3B' }), ['b']);
    assert.deepEqual(await ids({ energy_max: 5 }), ['c']);
    assert.deepEqual(await ids({ has_stems: true }), ['a']);
    assert.deepEqual(await ids({ year_from: 2020 }), ['b']);
    const g = (await s.call('list_genres', {})).body.result.structuredContent;
    assert.deepEqual(g.genres[0], { genre: 'House', tracks: 2 });
    assert.ok(g.genres.some((x) => x.genre === 'Deep House'));
    const d = (await s.call('get_track_details', { track_id: 'a' })).body.result.structuredContent;
    assert.equal(d.camelot, '8A'); assert.equal(d.mix_out, 170); assert.equal(d.sections.length, 3); assert.equal(d.sections[1].type, 'drop');
    assert.deepEqual(d.hot_cues, [{ cue: 1, position: 30, name: 'Drop' }]);
    assert.deepEqual(d.stems, { ready: true, model: 'htdemucs-v4' });
    assert.deepEqual(d.vocal_sections, [[10, 20]]);
    assert.ok(!JSON.stringify(d).includes('a.mp3'), 'no file paths');
    assert.equal((await s.call('get_track_details', { track_id: 'zzz' })).body.result.isError, true);
    // page tools are relayed with validated arguments
    const page = await fakePage(s.app, async (tool, args) => ({ tool, args }));
    const r = (await s.call('set_mixer', { deck: 2, eq_low: -1, vocal: 0 })).body.result.structuredContent;
    assert.deepEqual(r, { tool: 'set_mixer', args: { deck: 2, eq_low: -1, vocal: 0 } });
    const q = (await s.call('queue_dedication', { text: 'Make some noise', when: 'now' })).body.result.structuredContent;
    assert.equal(q.args.when, 'now');
    page.close?.();
  } finally { await s.close(); }
});
