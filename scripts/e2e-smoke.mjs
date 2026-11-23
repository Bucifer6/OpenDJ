// End-to-end smoke test: generates test tracks, starts the server, drives the UI in headless Chromium.
// Usage: node scripts/e2e-smoke.mjs [screenshot.png]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-'));
const music = path.join(tmp, 'Music');
fs.mkdirSync(music);

function writeWav(file, bpm, seconds, rootHz) {
  const sr = 44100, n = sr * seconds, data = Buffer.alloc(44 + n * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVE', 8); data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(sr, 24);
  data.writeUInt32LE(sr * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(n * 4, 40);
  const beat = 60 / bpm;
  for (let i = 0; i < n; i++) {
    const t = i / sr, tb = (t - 0.1) % beat;
    let v = 0.25 * Math.sin(2 * Math.PI * rootHz * t) + 0.12 * Math.sin(2 * Math.PI * rootHz * 1.5 * t);
    if (t > 0.1 && tb < 0.15) v += 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb * 40)) * tb) * Math.exp(-tb * 18);
    const s = Math.max(-1, Math.min(1, v * 0.7)) * 32767;
    data.writeInt16LE(s | 0, 44 + i * 4); data.writeInt16LE(s | 0, 46 + i * 4);
  }
  fs.writeFileSync(file, data);
}
writeWav(path.join(music, 'Test Artist - House Groove.wav'), 124, 50, 220);
writeWav(path.join(music, 'Other Artist - Techno Drive.wav'), 128, 50, 196);
writeWav(path.join(music, 'Third - Deep Roller.wav'), 122, 40, 174.6);

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: Number(process.env.DPR || 1) });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const fail = async (msg) => { console.error('FAIL:', msg); console.error(errors.join('\n')); await page.screenshot({ path: path.join(tmp, 'fail.png') }); console.error('screenshot', path.join(tmp, 'fail.png')); await browser.close(); app.server.close(); process.exit(1); };
class CheckError extends Error {}
const check = (cond, msg) => { if (!cond) throw new CheckError(msg); console.log('ok -', msg); };

try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 15000 });
  await page.evaluate(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});

  const r = await page.evaluate(async (dir) => (await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) })).json(), music);
  check(r.id, 'folder added');
  await page.waitForFunction(() => window.opendj.library.tracks.size === 3, null, { timeout: 15000 });
  check(true, 'scanned 3 tracks and UI refreshed via server events');
  await page.waitForSelector('.lr');

  const ids = await page.evaluate(() => ['House Groove', 'Deep Roller', 'Techno Drive'].map((n) => [...window.opendj.library.tracks.values()].find((t) => t.title === n).id));
  await page.evaluate(async (ids) => { await window.opendj.loadTrack(0, ids[0]); await window.opendj.loadTrack(1, ids[2]); }, ids);
  const d = await page.evaluate(() => window.opendj.engine.decks.slice(0, 2).map((x) => ({ bpm: x.bpm, dur: x.duration, title: x.track?.title, wf: !!x.waveform, key: x.track?.key })));
  console.log('decks', JSON.stringify(d));
  check(d[0].wf && d[1].wf, 'waveforms computed');
  check(Math.abs(d[0].bpm - 124) < 0.1, `deck 1 BPM detected (${d[0].bpm})`);
  check(Math.abs(d[1].bpm - 128) < 0.1, `deck 2 BPM detected (${d[1].bpm})`);

  await page.evaluate(() => window.opendj.engine.decks[0].play());
  await page.waitForTimeout(1200);
  const p1 = await page.evaluate(() => window.opendj.engine.decks[0].position);
  check(p1 > 0.6, `deck 1 plays (pos ${p1.toFixed(2)})`);
  const lvl = await page.evaluate(() => window.opendj.engine.channels[0].level());
  check(lvl > 0.01, `audio reaches channel meter (${lvl.toFixed(3)})`);

  // sync deck 2 to deck 1
  if (process.env.DEBUG_SYNC) console.log(await page.evaluate(async () => { const [d1, d2] = window.opendj.engine.decks; const out = []; const os = d2.seek.bind(d2); d2.seek = (t) => { out.push(`seek ${t.toFixed(3)} from ${d2.position.toFixed(3)} m=${d1.position.toFixed(3)} mph=${d1.beatPhase().toFixed(3)} ph=${d2.beatPhase().toFixed(3)} tgtph=${d2.beatPhase(t).toFixed(3)} stack=${new Error().stack.split('\n')[2].trim()}`); os(t); }; d2.play(); d2.sync(); await new Promise((r) => setTimeout(r, 300)); out.push(`after: m=${d1.beatPhase().toFixed(3)} d2=${d2.beatPhase().toFixed(3)} pos=${d2.position.toFixed(3)}`); d2.seek = os; return out.join('\n'); }));
  else await page.evaluate(() => { const d2 = window.opendj.engine.decks[1]; d2.play(); d2.sync(); });
  await page.waitForTimeout(400);
  if (process.env.DEBUG_SYNC) console.log(await page.evaluate(async () => { const [d1, d2] = window.opendj.engine.decks; const log = []; for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 250)); log.push([d1.position, d2.position, d1.beatPhase(), d2.beatPhase(), d1.gridOffset, d2.gridOffset, d2.rate, d2._rate].map((x) => x.toFixed(3)).join(' ')); } return log.join('\n'); }));
  const s = await page.evaluate(() => { const [a, b] = window.opendj.engine.decks; return { a: a.effectiveBpm, b: b.effectiveBpm, pa: a.beatPhase(), pb: b.beatPhase() }; });
  check(Math.abs(s.a - s.b) < 0.05, `sync matched tempo (${s.a.toFixed(2)} vs ${s.b.toFixed(2)})`);
  let ph = Math.abs(s.pa - s.pb); ph = Math.min(ph, 1 - ph);
  check(ph < 0.08, `sync aligned phase (Δ ${ph.toFixed(3)} beats)`);

  // hot cue + loop + fx via UI
  await page.evaluate(() => window.opendj.engine.decks[0].deleteHotCue(0)); // auto cues may already fill pad A
  await page.locator('.deck[data-deck="0"] .pad').first().dispatchEvent('pointerdown');
  await page.locator('.deck[data-deck="0"] .pad').first().dispatchEvent('pointerup');
  const hc = await page.evaluate(() => { const d = window.opendj.engine.decks[0]; const c = d.hotCue(0); return c && Math.abs(c.position - d.snap(c.position)) < 0.002; });
  check(hc, 'hot cue set from pad (on the beat grid)');
  await page.evaluate(() => window.opendj.engine.decks[0].autoLoop(4));
  const loop = await page.evaluate(() => window.opendj.engine.decks[0].loopBeats);
  check(Math.abs(loop - 4) < 0.01, 'auto loop 4 beats');
  await page.evaluate(() => window.opendj.engine.decks[0].exitLoop());
  for (const fx of ['echo', 'reverb', 'flanger', 'phaser', 'trans', 'bitcrush', 'distortion', 'noise', 'autofilter', 'pingpong']) {
    await page.evaluate((fx) => { const c = window.opendj.engine.channels[0]; c.set('fxType', fx); c.set('fxOn', true); }, fx);
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => window.opendj.engine.channels[0].set('fxOn', false));
  check(true, 'all effects instantiate');
  await page.evaluate(() => window.opendj.engine.sampler.trigger(0));

  // recording
  // recordings stream to disk on the server; keep them inside the test's temp folder
  await page.evaluate((folder) => fetch('/api/recording/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder, format: 'wav' }) }), path.join(tmp, 'Recordings'));
  await page.evaluate(() => window.opendj.engine.startRecording());
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.opendj.engine.stopRecording());
  const rec = await page.evaluate(async () => (await (await fetch('/api/recordings')).json()).recordings[0]);
  check(rec && /\.wav$/.test(rec.name) && rec.size > 44100, `recording saved to disk (${rec?.name}, ${rec?.size} bytes)`);

  // persisted analysis
  const saved = await page.evaluate(async (id) => (await (await fetch('/api/tracks')).json()).find((t) => t.id === id), ids[0]);
  check(saved.analyzed && saved.cues.some((c) => c.index === 0) && Array.isArray(saved.phrases) && saved.phrases.length > 0, `analysis, phrases (${saved.phrases?.map((p) => p.type).join(' ')}) + cues persisted to library`);

  // automix with a short transition
  await page.evaluate(async () => {
    const a = window.opendj;
    a.engine.decks.forEach((d) => { d.pause(); d.eject(); }); // empty decks: automix would start with their tracks
    await a.setSetting('automix', { ...a.settings.automix, transitionBeats: 8, style: 'eqswap' });
    await a.automix.start([...a.library.tracks.values()]);
    const d = a.automix.current; d.seek(d.duration - 12);
  });
  await page.waitForFunction(() => window.opendj.automix.transition, null, { timeout: 15000 });
  check(true, 'automix started a transition');
  await page.waitForFunction(() => !window.opendj.automix.transition && window.opendj.automix.idx >= 2, null, { timeout: 20000 });
  const am = await page.evaluate(() => ({ cur: window.opendj.automix.current.index, playing: window.opendj.automix.current.playing }));
  check(am.playing, `automix finished transition, deck ${am.cur + 1} now playing`);

  await page.evaluate(() => window.opendj.setDeckCount(2, false));
  await page.waitForTimeout(500);
  const shot = process.argv[2] || path.join(tmp, 'screenshot.png');
  await page.screenshot({ path: shot });
  console.log('screenshot:', shot);
  const real = errors.filter((e) => !/favicon|404 \(Not Found\)/.test(e));
  check(real.length === 0, `no console errors${real.length ? ': ' + real.join(' | ') : ''}`);
  console.log('\nE2E SMOKE PASSED');
} catch (e) { await fail(e instanceof CheckError ? e.message : e.stack || e.message); }
await browser.close();
app.server.close();
process.exit(0);
