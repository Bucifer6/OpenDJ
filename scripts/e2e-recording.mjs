// End-to-end: record a playing deck to disk (WAV + MP3) through the streaming recorder, and broadcast to a mock
// Icecast server, in headless Chromium.
// Usage: node scripts/e2e-recording.mjs
// Works before the module is wired into server/index.js / app.js: if /api/recording/* is missing, the routes are
// mounted in front of the server's handler, and the UI module is imported dynamically from the page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseFile } from 'music-metadata';
import { start } from '../server/index.js';
import { registerRecordingRoutes } from '../server/recorder.js';
import { registerBroadcastRoutes } from '../server/broadcast.js';
import { dispatch, mockIcecast } from '../test/recording-helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-rec-'));
const music = path.join(tmp, 'Music'), recs = path.join(tmp, 'Recordings');
fs.mkdirSync(music);

function writeWav(file, seconds, hz) {
  const sr = 44100, n = sr * seconds, data = Buffer.alloc(44 + n * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVE', 8); data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(sr, 24);
  data.writeUInt32LE(sr * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr, beat = t % 0.5;
    let v = 0.3 * Math.sin(2 * Math.PI * hz * t);
    if (beat < 0.12) v += 0.6 * Math.sin(2 * Math.PI * 60 * beat) * Math.exp(-beat * 20);
    const s = Math.max(-1, Math.min(1, v)) * 32767;
    data.writeInt16LE(s | 0, 44 + i * 4); data.writeInt16LE(s | 0, 46 + i * 4);
  }
  fs.writeFileSync(file, data);
}
writeWav(path.join(music, 'Test Artist - House Groove.wav'), 40, 220);

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
await app.ffmpegReady;
const ff = app.library.media.ffmpeg();
let mounted = null;
const probeRoute = await fetch(`${app.url}api/recording/config`);
if (probeRoute.status === 404) {
  // not wired yet: mount the recording / broadcast routes in front of the app's own handler
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => { const keys = []; routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$'), keys, handler, ...opts }); };
  const emit = () => {};
  mounted = [registerRecordingRoutes({ route, library: app.library, emit, pathAllowed: () => true }), registerBroadcastRoutes({ route, library: app.library, emit })];
  const orig = app.server.listeners('request');
  app.server.removeAllListeners('request');
  app.server.on('request', async (req, res) => {
    if (/^\/api\/(recording|recordings|broadcast)\b/.test(new URL(req.url, 'http://x').pathname) && await dispatch(routes, req, res)) return;
    for (const l of orig) l.call(app.server, req, res);
  });
  console.log('(recording routes mounted by the test: not wired into server/index.js yet)');
} else await probeRoute.arrayBuffer();

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
let ice = null;
const finish = async (code) => { setTimeout(() => process.exit(code), 8000).unref(); await browser.close(); for (const m of mounted || []) await m.close(); await ice?.close(); app.shutdown(); app.server.closeAllConnections?.(); app.server.close(); process.exit(code); };
class CheckError extends Error {}
const check = (cond, msg) => { if (!cond) throw new CheckError(msg); console.log('ok -', msg); };
const run = (args) => new Promise((r) => { let e = ''; const p = spawn(ff.path, ['-hide_banner', '-nostdin', ...args]); p.stderr.on('data', (d) => { e += d; }); p.on('close', () => r(e)); });
const meanVolume = async (file) => Number(/mean_volume: (-?[\d.]+) dB/.exec(await run(['-i', file, '-af', 'volumedetect', '-f', 'null', '-']))?.[1] ?? -999);

try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 20000 });
  await page.evaluate(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
  await page.evaluate(async (dir) => fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) }), music);
  await page.waitForFunction(() => window.opendj.library.tracks.size === 1, null, { timeout: 15000 });
  await page.evaluate(async () => { const t = [...window.opendj.library.tracks.values()][0]; await window.opendj.loadTrack(0, t.id); });

  // the module, as app.js will create it
  await page.evaluate(async () => {
    const m = await import('/js/recording/index.js');
    window.rec = window.opendj.recording?.recorder ? window.opendj.recording : m.setupRecording(window.opendj);
  });
  check(await page.locator('.live-btn').count() === 1, 'topbar LIVE button added');
  const cfg = await page.evaluate(async (dir) => (await fetch('/api/recording/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: dir, minTrackSeconds: 1, format: 'wav' }) })).json(), recs);
  check(cfg.folder === recs, 'recordings folder set');

  await page.evaluate(() => { const E = window.opendj.engine; E.channels[0].set('volume', 1); E.setCrossfader(-1); E.decks[0].play(); });
  await page.waitForTimeout(300);

  for (const format of ['wav', 'mp3']) {
    await page.evaluate((f) => window.rec.recorder.start({ format: f, minTrackSeconds: 1, title: `e2e ${f}` }), format);
    check(await page.evaluate(() => window.opendj.engine.recording === undefined || window.opendj.engine.recording === true || window.rec.recorder.recording), `${format}: recording started`);
    await page.waitForTimeout(3000);
    const live = await page.evaluate(() => ({ elapsed: window.rec.recorder.elapsed, peak: window.rec.recorder.peak, tracks: window.rec.recorder.tracker.logged.length }));
    check(live.elapsed > 2.4, `${format}: ${live.elapsed.toFixed(2)} s captured`);
    const r = await page.evaluate(() => window.rec.recorder.stop());
    check(r && r.state === 'stopped' && !r.error, `${format}: stopped cleanly (${r?.error || r?.state})`);
    check(fs.existsSync(r.file), `${format}: file on disk ${path.basename(r.file)} (${(r.bytes / 1024).toFixed(0)} KB)`);
    const mm = await parseFile(r.file);
    check(Math.abs(mm.format.duration - 3) < 0.6, `${format}: duration ${mm.format.duration.toFixed(2)} s`);
    check(format === 'wav' ? mm.format.container === 'WAVE' && mm.format.bitsPerSample === 16 : /MPEG/.test(mm.format.container) && mm.format.codec?.includes('MPEG 1 Layer 3'), `${format}: container ${mm.format.container} / ${mm.format.codec}`);
    const info = await run(['-i', r.file]);
    check(new RegExp(format === 'wav' ? 'Audio: pcm_s16le' : 'Audio: mp3').test(info), `${format}: ffmpeg sees the expected codec`);
    const vol = await meanVolume(r.file);
    check(vol > -40, `${format}: audio is not silent (mean ${vol} dB)`);
    const cue = fs.readFileSync(r.file.replace(/\.\w+$/, '.cue'), 'utf8');
    check(/TITLE "House Groove"/.test(cue) && /PERFORMER "Test Artist"/.test(cue) && cue.includes(`FILE "${path.basename(r.file)}" ${format === 'mp3' ? 'MP3' : 'WAVE'}`), `${format}: cue sheet lists the playing track`);
    check(/\[00:00\] Test Artist - House Groove/.test(fs.readFileSync(r.file.replace(/\.\w+$/, '.txt'), 'utf8')), `${format}: text tracklist written`);
  }
  const list = await page.evaluate(async () => (await fetch('/api/recordings')).json());
  check(list.recordings.length === 2, 'recordings list shows both files');
  await page.evaluate(() => { window.rec.openPanel('recordings'); }); // the modal promise resolves on close
  await page.waitForSelector('.rec-row');
  check(await page.locator('.rec-row').count() === 2, 'Recordings tab lists them');
  await page.keyboard.press('Escape');
  await page.locator('.modal-x').click({ timeout: 1000 }).catch(() => {});

  // ---- broadcast to a mock Icecast server ----
  ice = await mockIcecast({ password: 'e2e-pass' });
  const bc = await page.evaluate(async (port) => (await fetch('/api/broadcast/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: [{ type: 'icecast', name: 'Mock', host: '127.0.0.1', port, mount: '/live', password: 'e2e-pass', format: 'mp3', bitrate: 128 }] }) })).json(), ice.port);
  check(bc.config.targets[0].hasPassword && !JSON.stringify(bc).includes('e2e-pass'), 'stream password stored server-side only');
  await page.evaluate(async () => { window.rec.broadcaster.metadataDelayMs = 300; await window.rec.broadcaster.start(); });
  const t0 = Date.now();
  while (ice.state.bytes < 20000 && Date.now() - t0 < 15000) await page.waitForTimeout(200);
  check(ice.state.bytes >= 20000, `mock Icecast received ${ice.state.bytes} bytes of MP3`);
  check(ice.sources[0]?.headers['content-type'] === 'audio/mpeg', 'source logged in with audio/mpeg');
  while (!ice.metadata.length && Date.now() - t0 < 20000) await page.waitForTimeout(200);
  check(ice.metadata[0]?.song === 'Test Artist - House Groove', `now-playing metadata sent (${ice.metadata[0]?.song})`);
  const st = await page.evaluate(async () => (await fetch('/api/broadcast/status')).json());
  check(st.active[0].outputs[0].state === 'live', 'broadcast status: live');
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.rec.broadcaster.status && window.rec.broadcaster._poll());
  check(await page.evaluate(() => /ON AIR/.test(document.querySelector('.live-btn').textContent)), 'LIVE button shows ON AIR');
  await page.evaluate(() => window.rec.broadcaster.stop());
  check((await page.evaluate(async () => (await fetch('/api/broadcast/status')).json())).active.length === 0, 'broadcast stopped');

  const bad = errors.filter((e) => !/favicon|AudioContext was not allowed/.test(e));
  check(!bad.length, `no page errors${bad.length ? ': ' + bad.join(' | ') : ''}`);
  console.log('\nE2E recording: all checks passed');
  await finish(0);
} catch (e) {
  console.error('FAIL:', e instanceof CheckError ? e.message : e);
  console.error(errors.join('\n'));
  await page.screenshot({ path: path.join(tmp, 'fail.png') }).catch(() => {});
  console.error('screenshot', path.join(tmp, 'fail.png'));
  await finish(1);
}
