// Every advertised assistant tool through authenticated MCP -> event relay -> actual browser app.
// Synthetic audio and a loopback Icecast fixture only; no model downloads or external broadcasts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';
import { TOOLS } from '../server/mcp.js';
import { beatWav } from '../test/fake-servers.js';
import { mockIcecast } from '../test/recording-helpers.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-mcp-e2e-')), music = path.join(tmp, 'Music');
fs.mkdirSync(music);
for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(music, `Artist ${i} - Tool Track ${i}.wav`), beatWav({ bpm: 120, seconds: 80, hz: 220 + i * 20 }));
const app = await start({ port: 0, dataDir: path.join(tmp, 'data') }), ice = await mockIcecast();
await app.ffmpegReady;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }), page = await browser.newPage();
const errors = [], seen = new Set(), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
page.on('pageerror', (e) => errors.push(String(e)));
const json = async (url, body, method = 'POST') => (await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
let sid, seq = 0, token;
const rpc = async (method, params) => {
  const r = await fetch('http://127.0.0.1:17939/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, ...(sid ? { 'Mcp-Session-Id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) });
  sid = r.headers.get('mcp-session-id') || sid;
  assert.equal(r.status, 200);
  const b = await r.json(); assert.ok(!b.error, JSON.stringify(b.error)); return b.result;
};
const call = async (name, args = {}, expectError) => {
  let r = await rpc('tools/call', { name, arguments: args });
  if (r.isError && /Too many control/.test(r.content?.[0]?.text || '')) { await sleep(61000); r = await rpc('tools/call', { name, arguments: args }); }
  if (expectError) assert.match(r.content?.[0]?.text || '', expectError, name);
  else assert.ok(!r.isError, `${name}: ${JSON.stringify(r)}`);
  seen.add(name); console.log(`ok - ${name}${expectError ? ' (guard)' : ''}`);
  return r.structuredContent;
};
try {
  token = (await json(app.url + 'api/mcp/config', { enabled: true, port: 17939, scopes: ['read', 'playback', 'broadcast'] }, 'PUT')).token;
  await json(app.url + 'api/folders', { path: music });
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
  await page.waitForFunction(() => window.opendj.library.tracks.size === 3, null, { timeout: 30000 });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'opendj-qa', version: '1' } });
  const listed = await rpc('tools/list', {});
  assert.deepEqual(listed.tools.map((t) => t.name).sort(), Object.keys(TOOLS).sort());
  const tracks = (await call('search_library', {})).tracks, ids = tracks.map((t) => t.id);
  await call('list_genres');
  await call('get_track_details', { track_id: ids[0] });
  await call('load_track', { deck: 1, track_id: ids[0] });
  await call('load_track', { deck: 2, track_id: ids[1] });
  assert.equal((await call('get_deck', { deck: 1 })).loaded, true);
  await call('set_mixer', { deck: 1, volume: 0.6, eq_low: -0.2, eq_mid: 0.1, eq_high: 0.1, filter: 0.1, vocal: 0.8, instrumental: 0.9 });
  assert.equal((await call('get_deck', { deck: 1 })).mixer.volume, 0.6);
  await call('set_tempo', { deck: 1, percent: 2 });
  assert.equal((await call('get_deck', { deck: 1 })).tempo_percent, 2);
  await call('set_key', { deck: 1, semitones: 1 });
  await call('set_loop', { deck: 1, beats: 4 });
  await call('set_loop', { deck: 1, beats: 0 });
  await call('seek', { deck: 1, seconds: 5 });
  assert.ok((await call('get_deck', { deck: 1 })).position >= 4.9);
  await call('set_fx', { deck: 1, type: 'echo', on: true, mix: 0.2, param: 0.4, beats: 0.5 });
  await call('play', { deck: 1 });
  assert.equal((await call('get_deck', { deck: 1 })).playing, true);
  await call('seek', { deck: 1, seconds: 10 }, /on air/);
  await call('load_track', { deck: 1, track_id: ids[2] }, /playing/);
  await call('pause', { deck: 1 });
  await call('cue', { deck: 1 });
  await call('set_crossfader', { position: 0.4 });
  assert.equal((await call('get_status')).crossfader, 0.4);
  await call('trigger_sample', { pad: 1 });
  await call('set_stems', { deck: 1, vocals: 0.5 }, /No AI stems|loading/);
  await call('prepare_stems', { track_ids: [ids[0]] }); // Consent gate remains in force.
  await call('queue_dedication', { text: 'Local QA check', when: 'phrase', show_on_screen: false, stream_metadata: false });
  const config = await json(app.url + 'api/broadcast/config', { targets: [{ type: 'icecast', name: 'QA loopback', host: '127.0.0.1', port: ice.port, mount: '/live', password: 'hackme', format: 'mp3', bitrate: 128 }] }, 'PUT');
  const target = config.config.targets[0].id;
  await call('broadcast_start', { target_id: target });
  await sleep(750);
  await call('broadcast_stop', { target_id: target });
  const pair = await call('plan_transition', { from_track_id: ids[0], to_track_id: ids[1] });
  assert.ok(pair.style && Number.isFinite(pair.score));
  await call('automix_start', { track_ids: ids, mode: 'order' });
  await page.waitForFunction(() => { const a = window.opendj.automix, d = a.other(a.current); return d?.track?.id === a.nextTrack()?.id && !d.loading; }, null, { timeout: 30000 });
  await call('set_transition', { style: 'cut' });
  await call('automix_queue_next', { track_ids: [ids[2]] });
  await call('plan_transition');
  await call('automix_skip');
  await call('automix_stop');
  assert.equal((await call('get_status')).automix.enabled, false);
  assert.deepEqual([...seen].sort(), Object.keys(TOOLS).sort(), 'every advertised tool exercised');
  assert.deepEqual(errors, []);
  console.log(`MCP E2E PASSED (${seen.size} tools)`);
} catch (e) { console.error(e); process.exitCode = 1; }
finally { await browser.close(); app.shutdown(); await app.mcp.close(); app.server.closeAllConnections?.(); await new Promise((r) => app.server.close(r)); await ice.close(); }
