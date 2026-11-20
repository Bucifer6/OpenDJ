// Live broadcasting: Icecast / Shoutcast source protocol against mock servers, metadata + stats URLs, secrets,
// and a full encode -> mock Icecast stream (FFmpeg).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import {
  icecastRequest, shoutcastHeaders, shoutcastPassword, metadataRequest, statsUrl, parseListeners, openSource, normTarget,
  SecretStore, registerBroadcastRoutes, songTitle,
} from '../server/broadcast.js';
import { findFfmpeg } from '../server/media.js';
import { miniServer, fakeLibrary, mockIcecast } from './recording-helpers.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-cast-'));
const ffmpegP = findFfmpeg();
const ice = (port, extra = {}) => normTarget({ type: 'icecast', host: '127.0.0.1', port, mount: '/live', stationName: 'Test FM', genre: 'House', ...extra });
const sine = (seconds, sr = 48000) => { const n = Math.round(seconds * sr), b = Buffer.alloc(n * 4); for (let i = 0; i < n; i++) { const v = Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * 10000); b.writeInt16LE(v, i * 4); b.writeInt16LE(v, i * 4 + 2); } return b; };
const waitFor = async (fn, ms = 8000, msg = 'condition') => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${msg}`); await new Promise((r) => setTimeout(r, 50)); } };

test('Icecast PUT / SOURCE request heads', () => {
  const t = ice(8000, { url: 'https://example.com', public: true });
  const put = icecastRequest(t, { password: 'p@ss', contentType: 'audio/mpeg', bitrate: 128, sampleRate: 44100 });
  const lines = put.split('\r\n');
  assert.equal(lines[0], 'PUT /live HTTP/1.1');
  assert.ok(lines.includes('Host: 127.0.0.1:8000'));
  assert.ok(lines.includes(`Authorization: Basic ${Buffer.from('source:p@ss').toString('base64')}`));
  assert.ok(lines.includes('Content-Type: audio/mpeg'));
  assert.ok(lines.includes('Ice-Public: 1'));
  assert.ok(lines.includes('Ice-Name: Test FM'));
  assert.ok(lines.includes('Ice-Url: https://example.com'));
  assert.ok(lines.includes('Ice-Audio-Info: ice-samplerate=44100;ice-bitrate=128;ice-channels=2'));
  assert.ok(lines.includes('Expect: 100-continue'));
  assert.ok(put.endsWith('\r\n\r\n'));
  const src = icecastRequest({ ...t, stationName: 'Evil\r\nX-Injected: 1' }, { password: 'x', method: 'SOURCE', contentType: 'audio/ogg', bitrate: 96 });
  assert.match(src, /^SOURCE \/live HTTP\/1\.0\r\n/);
  assert.ok(!src.includes('Expect:'));
  assert.ok(!/\r\nX-Injected/.test(src), 'header injection stripped');
  assert.equal(shoutcastPassword({ shoutcastVersion: 2, sid: 3 }, 'pw'), 'pw:#3');
  assert.equal(shoutcastPassword({ shoutcastVersion: 1 }, 'pw'), 'pw');
  assert.match(shoutcastHeaders({ stationName: 'S', genre: 'G' }, { contentType: 'audio/aacp', bitrate: 64 }), /^content-type:audio\/aacp\r\nicy-name:S\r\nicy-genre:G\r\nicy-pub:0\r\nicy-br:64\r\n\r\n$/);
});

test('metadata update and listener stats URLs', () => {
  const t = ice(8443, { tls: true, mount: '/my mix' });
  const m = metadataRequest(t, songTitle({ artist: 'Daft Punk', title: 'One More Time & Again' }), 'pw');
  const u = new URL(m.url);
  assert.equal(u.origin, 'https://127.0.0.1:8443');
  assert.equal(u.pathname, '/admin/metadata');
  assert.equal(u.searchParams.get('mount'), '/my mix');
  assert.equal(u.searchParams.get('mode'), 'updinfo');
  assert.equal(u.searchParams.get('song'), 'Daft Punk - One More Time & Again');
  assert.equal(u.searchParams.get('charset'), 'UTF-8');
  assert.equal(m.headers.Authorization, `Basic ${Buffer.from('source:pw').toString('base64')}`);
  const sc1 = normTarget({ type: 'shoutcast', host: 'radio.example.com', port: 8000 });
  assert.equal(metadataRequest(sc1, 'A - B', 'pw').url, 'http://radio.example.com:8000/admin.cgi?pass=pw&mode=updinfo&song=A+-+B');
  const sc2 = normTarget({ type: 'shoutcast', host: 'radio.example.com', port: 8000, shoutcastVersion: 2, sid: 2 });
  assert.equal(metadataRequest(sc2, 'A', 'pw').url, 'http://radio.example.com:8000/admin.cgi?sid=2&pass=pw&mode=updinfo&song=A');
  assert.equal(statsUrl(t), 'https://127.0.0.1:8443/status-json.xsl');
  assert.equal(statsUrl(sc1), 'http://radio.example.com:8000/7.html');
  assert.equal(statsUrl(sc2), 'http://radio.example.com:8000/stats?sid=2&json=1');
  const icestats = { icestats: { source: [{ listenurl: 'http://h:8000/other', listeners: 1 }, { listenurl: 'http://h:8000/my%20mix', listeners: 12 }] } };
  assert.equal(parseListeners(ice(1, { mount: '/my%20mix' }), JSON.stringify(icestats)), 12);
  assert.equal(parseListeners(ice(1, { mount: '/solo' }), JSON.stringify({ icestats: { source: { listenurl: 'http://h/x', listeners: 3 } } })), 3);
  assert.equal(parseListeners(sc1, '<html><body>5,1,9,100,4,128,Song</body></html>'), 5);
  assert.equal(parseListeners(sc2, '{"currentlisteners":42}'), 42);
  assert.equal(parseListeners(t, 'garbage'), null);
});

test('target validation', () => {
  assert.throws(() => normTarget({ type: 'icecast', host: 'http://x.com' }), /host name/);
  assert.throws(() => normTarget({ type: 'icecast', host: 'x.com', port: 70000 }), /port/i);
  assert.throws(() => normTarget({ type: 'rtmp', rtmpUrl: 'http://x' }), /rtmp:\/\//);
  const sc = normTarget({ type: 'shoutcast', host: 'x.com', format: 'opus' });
  assert.equal(sc.format, 'mp3', 'Shoutcast carries MP3/AAC only');
  const t = normTarget({ type: 'icecast', host: 'X.com', mount: 'live', password: 'secret' });
  assert.equal(t.mount, '/live'); assert.equal(t.host, 'x.com'); assert.equal(t.password, undefined, 'secrets are not part of the target');
});

test('Icecast source handshake: PUT with 100-continue against a mock server', async () => {
  const m = await mockIcecast({ password: 'hackme' });
  try {
    const sock = await openSource(ice(m.port), { password: 'hackme', contentType: 'audio/mpeg', bitrate: 128 });
    sock.write(Buffer.from('audio-bytes'));
    await waitFor(() => m.state.bytes >= 11, 2000, 'bytes');
    assert.equal(m.sources[0].method, 'PUT');
    assert.equal(m.sources[0].mount, '/live');
    assert.equal(m.sources[0].headers['content-type'], 'audio/mpeg');
    assert.equal(m.sources[0].headers['ice-name'], 'Test FM');
    sock.destroy();
    await assert.rejects(openSource(ice(m.port), { password: 'wrong', contentType: 'audio/mpeg', bitrate: 128 }), (e) => e.fatal && /password/.test(e.message));
  } finally { await m.close(); }
});

test('Icecast source handshake: falls back to SOURCE when PUT is refused (Icecast < 2.4)', async () => {
  const m = await mockIcecast({ put: false });
  try {
    const sock = await openSource(ice(m.port), { password: 'hackme', contentType: 'audio/ogg', bitrate: 96 });
    assert.equal(m.sources[0].method, 'SOURCE');
    assert.ok(m.state.heads[0].startsWith('PUT '));
    sock.destroy();
    await assert.rejects(openSource(ice(m.port, { protocol: 'put' }), { password: 'hackme', contentType: 'audio/ogg', bitrate: 96 }), /405|PUT|Icecast/);
  } finally { await m.close(); }
});

test('Shoutcast v1 handshake on port + 1 and wrong password', async () => {
  const got = [];
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      if (!sock.authed && buf.includes('\r\n')) {
        const pw = buf.slice(0, buf.indexOf('\r\n')); buf = buf.slice(buf.indexOf('\r\n') + 2);
        if (pw !== 'scpass') { sock.end('invalid password\r\n'); return; }
        sock.authed = true; sock.write('OK2\r\nicy-caps:11\r\n\r\n');
      }
      if (sock.authed && buf.includes('\r\n\r\n')) got.push(buf);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const sp = server.address().port;
  try {
    const t = normTarget({ type: 'shoutcast', host: '127.0.0.1', port: sp - 1, stationName: 'SC' });
    const sock = await openSource(t, { password: 'scpass', contentType: 'audio/mpeg', bitrate: 128 });
    await waitFor(() => got.length, 2000, 'icy headers');
    assert.match(got[0], /content-type:audio\/mpeg\r\nicy-name:SC\r\n/);
    sock.destroy();
    await assert.rejects(openSource(t, { password: 'nope', contentType: 'audio/mpeg', bitrate: 128 }), (e) => e.fatal && /password/.test(e.message));
    const viaSourcePort = normTarget({ type: 'shoutcast', host: '127.0.0.1', port: 1, sourcePort: sp });
    (await openSource(viaSourcePort, { password: 'scpass', contentType: 'audio/mpeg', bitrate: 128 })).destroy();
  } finally { server.close(); }
});

test('secrets stay server-side: config GET never returns passwords; secrets.json is 0600', async () => {
  const dataDir = tmpDir();
  const lib = fakeLibrary(dataDir);
  const srv = await miniServer((route) => registerBroadcastRoutes({ route, library: lib }));
  const j = async (method, url, body) => (await fetch(srv.base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })).json();
  try {
    let r = await j('PUT', '/api/broadcast/config', { targets: [{ type: 'icecast', host: 'radio.example.com', port: 8000, mount: '/live', password: 'TOPSECRET1' }, { type: 'rtmp', rtmpUrl: 'rtmp://live.twitch.tv/app', streamKey: 'live_KEY_123' }] });
    assert.ok(!JSON.stringify(r).includes('TOPSECRET1') && !JSON.stringify(r).includes('live_KEY_123'));
    assert.equal(r.config.targets[0].hasPassword, true);
    assert.equal(r.config.targets[1].hasStreamKey, true);
    const ids = r.config.targets.map((t) => t.id);
    const get = await (await fetch(srv.base + '/api/broadcast/config')).text();
    assert.ok(!get.includes('TOPSECRET1') && !get.includes('live_KEY_123'));
    const sf = path.join(dataDir, 'secrets.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(sf).mode & 0o777, 0o600);
    assert.equal(new SecretStore(dataDir).get('broadcast', ids[0], 'password'), 'TOPSECRET1');
    // the stored config (settings.json via the library, or broadcast.json before the key exists) never holds secrets
    const cfgFile = path.join(dataDir, 'broadcast.json');
    const stored = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : JSON.stringify(lib.settings.broadcast || {});
    assert.ok(!stored.includes('TOPSECRET1') && !stored.includes('live_KEY_123'), 'not in the stored config');
    // editing without a password keeps it; clearPassword removes it; removing a target removes its secrets
    r = await j('PUT', '/api/broadcast/config', { targets: [{ ...r.config.targets[0], password: '', stationName: 'New' }, r.config.targets[1]] });
    assert.equal(r.config.targets[0].hasPassword, true); assert.equal(r.config.targets[0].stationName, 'New');
    r = await j('PUT', '/api/broadcast/config', { targets: [{ ...r.config.targets[0], clearPassword: true }] });
    assert.equal(r.config.targets[0].hasPassword, false);
    assert.equal(new SecretStore(dataDir).get('broadcast', ids[1], 'streamKey'), '');
  } finally { await srv.close(); }
});

test('broadcast to a mock Icecast server: MP3 audio arrives, metadata + listeners update, reconnects after a drop', async (t) => {
  const ff = await ffmpegP;
  if (!ff) return t.skip('FFmpeg not available');
  const m = await mockIcecast({ password: 'hackme' });
  const lib = fakeLibrary(tmpDir(), ff);
  const events = [];
  let ctl;
  const srv = await miniServer((route) => { ctl = registerBroadcastRoutes({ route, library: lib, emit: (type, p) => events.push([type, p]) }); });
  const j = async (method, url, body) => { const r = await fetch(srv.base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); const b = await r.json(); if (!r.ok) throw new Error(b.error); return b; };
  try {
    await j('PUT', '/api/broadcast/config', { targets: [{ type: 'icecast', host: '127.0.0.1', port: m.port, mount: '/live', password: 'hackme', format: 'mp3', bitrate: 128, stationName: 'Test FM' }] });
    const s = await j('POST', '/api/broadcast/start', { sampleRate: 48000, sampleFormat: 's16', chunkFrames: 24000 });
    let seq = 0;
    const pump = setInterval(() => fetch(`${srv.base}/api/broadcast/${s.id}/chunk?seq=${seq++}`, { method: 'POST', body: sine(0.5) }).catch(() => {}), 500);
    try {
      await waitFor(() => m.state.bytes > 8000, 15000, 'MP3 bytes at the mock server');
      const head = Buffer.concat(m.state.chunks);
      assert.equal(head[0], 0xFF, 'starts with an MPEG frame sync (no ID3 tag in the stream)');
      assert.equal(head[1] & 0xE0, 0xE0);
      assert.equal(m.sources[0].headers['content-type'], 'audio/mpeg');
      const meta = await j('POST', `/api/broadcast/${s.id}/metadata`, { artist: 'Artist', title: 'Title' });
      assert.equal(meta.ok, true);
      assert.deepEqual(m.metadata[0], { mount: '/live', mode: 'updinfo', song: 'Artist - Title', charset: 'UTF-8' });
      const out = ctl.sessions.get(s.id).outputs[0];
      await out.pollListeners();
      assert.equal(out.listeners, 7);
      let st = await j('GET', '/api/broadcast/status');
      assert.equal(st.active[0].outputs[0].state, 'live');
      // the server drops the source: reconnect, and the song is re-sent
      m.dropSources();
      await waitFor(() => m.sources.length >= 2 && out.state === 'live', 10000, 'reconnect');
      await waitFor(() => m.metadata.length >= 2, 4000, 'metadata re-sent after reconnect');
      st = await j('GET', '/api/broadcast/status');
      assert.ok(st.active[0].outputs[0].reconnects >= 1);
      assert.ok(events.some(([type, p]) => type === 'broadcast' && p.active?.[0]?.outputs?.[0]?.state === 'reconnecting'));
    } finally { clearInterval(pump); }
    const stopped = await j('POST', `/api/broadcast/${s.id}/stop`);
    assert.equal(stopped.outputs[0].state, 'stopped');
    assert.equal((await j('GET', '/api/broadcast/status')).active.length, 0);
  } finally { await ctl?.close(); await srv.close(); await m.close(); }
});

test('broadcast: wrong password is reported as an error (not retried in a tight loop)', async (t) => {
  const ff = await ffmpegP;
  if (!ff) return t.skip('FFmpeg not available');
  const m = await mockIcecast({ password: 'right' });
  const lib = fakeLibrary(tmpDir(), ff);
  let ctl;
  const srv = await miniServer((route) => { ctl = registerBroadcastRoutes({ route, library: lib }); });
  try {
    await fetch(srv.base + '/api/broadcast/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: [{ type: 'icecast', host: '127.0.0.1', port: m.port, password: 'wrong' }] }) });
    const s = await (await fetch(srv.base + '/api/broadcast/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sampleRate: 48000 }) })).json();
    const out = ctl.sessions.get(s.id).outputs[0];
    await waitFor(() => out.state === 'error', 5000, 'error state');
    assert.match(out.error, /user name or password/);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(m.state.heads.length, 1, 'no hammering after an auth failure');
  } finally { await ctl?.close(); await srv.close(); await m.close(); }
});

test('RTMP: FFmpeg publishes FLV (still image + AAC) to an RTMP server', async (t) => {
  const ff = await ffmpegP;
  if (!ff || !ff.encoders?.libx264) return t.skip('FFmpeg with libx264 not available');
  const dir = tmpDir(), out = path.join(dir, 'got.flv');
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  // FFmpeg as a one-shot RTMP server
  const rx = spawn(ff.path, ['-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', `rtmp://127.0.0.1:${port}/live/testkey`, '-c', 'copy', '-y', out], { stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise((r) => setTimeout(r, 600));
  const lib = fakeLibrary(dir, ff);
  let ctl;
  const srv = await miniServer((route) => { ctl = registerBroadcastRoutes({ route, library: lib }); });
  try {
    await fetch(srv.base + '/api/broadcast/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: [{ type: 'rtmp', rtmpUrl: `rtmp://127.0.0.1:${port}/live`, streamKey: 'testkey', resolution: '854x480' }] }) });
    const s = await (await fetch(srv.base + '/api/broadcast/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sampleRate: 48000, sampleFormat: 's16', chunkFrames: 24000 }) })).json();
    let seq = 0;
    const pump = setInterval(() => fetch(`${srv.base}/api/broadcast/${s.id}/chunk?seq=${seq++}`, { method: 'POST', body: sine(0.5) }).catch(() => {}), 500);
    const o = ctl.sessions.get(s.id).outputs[0];
    try {
      await waitFor(() => o.state === 'live' && o.bytesOut > 10000, 20000, 'RTMP live');
    } finally { clearInterval(pump); }
    await fetch(`${srv.base}/api/broadcast/${s.id}/stop`, { method: 'POST' });
    await new Promise((r) => { rx.once('close', r); setTimeout(() => { rx.kill('SIGKILL'); r(); }, 5000); });
    const probe = await new Promise((r) => { let e = ''; const p = spawn(ff.path, ['-hide_banner', '-i', out]); p.stderr.on('data', (d) => { e += d; }); p.on('close', () => r(e)); });
    assert.match(probe, /Video: h264/); assert.match(probe, /Audio: aac/);
  } finally { rx.kill('SIGKILL'); await ctl?.close(); await srv.close(); }
});
