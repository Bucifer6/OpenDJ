// End-to-end DVS test in headless Chromium.
//  A) getUserMedia path: Chromium's fake capture device plays a generated Serato timecode WAV
//     (--use-file-for-fake-audio-capture); deck 1 must play forwards at 1.0× (REL) and follow the record
//     position (ABS).
//  B) MediaStream path: two quadrature oscillators → MediaStreamDestination as the "turntable"; deck 1 must
//     play forwards, reverse when the carrier reverses, and follow a +5 % pitch change.
// Usage: node scripts/e2e-dvs.mjs [screenshot.png]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';
import { TIMECODES } from '../public/js/dvs/timecode-defs.js';
import { generateTimecode, encodeWav } from '../public/js/dvs/timecode-gen.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-dvs-'));
const music = path.join(tmp, 'Music');
fs.mkdirSync(music);

// a 90 s music track for deck 1
{
  const sr = 44100, n = sr * 90, data = Buffer.alloc(44 + n * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVE', 8); data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(sr, 24);
  data.writeUInt32LE(sr * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(n * 4, 40);
  const beat = 60 / 124;
  for (let i = 0; i < n; i++) {
    const t = i / sr, tb = t % beat;
    let v = 0.2 * Math.sin(2 * Math.PI * 220 * t);
    if (tb < 0.12) v += 0.7 * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-tb * 40)) * tb) * Math.exp(-tb * 18);
    const s = Math.max(-1, Math.min(1, v * 0.7)) * 32767;
    data.writeInt16LE(s | 0, 44 + i * 4); data.writeInt16LE(s | 0, 46 + i * 4);
  }
  fs.writeFileSync(path.join(music, 'DVS Artist - Timecode Groove.wav'), data);
}
// the timecode "record": Serato side A, starting 20 s in, playing forwards at 33⅓ for 40 s
const TC_START_SEC = 20;
const def = TIMECODES.serato_2a;
const tc = generateTimecode({ def, sampleRate: 44100, seconds: 40, startCycle: TC_START_SEC * def.carrier, amplitude: 0.4, noise: 0.01 });
const wav = path.join(tmp, 'timecode.wav');
fs.writeFileSync(wav, encodeWav(tc.L, tc.R, 44100));

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`] });
const ctxB = await browser.newContext({ viewport: { width: 1600, height: 960 }, permissions: ['microphone'] });
const page = await ctxB.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
class CheckError extends Error {}
const check = (cond, msg) => { if (!cond) throw new CheckError(msg); console.log('ok -', msg); };
const fail = async (msg) => { console.error('FAIL:', msg); console.error(errors.join('\n')); await page.screenshot({ path: path.join(tmp, 'fail.png') }).catch(() => {}); console.error('screenshot', path.join(tmp, 'fail.png')); await browser.close(); app.server.close(); process.exit(1); };

/** Average deck speed over `ms` measured from the deck position. */
const measureSpeed = (ms) => page.evaluate(async (ms) => {
  const d = window.opendj.engine.decks[0], c = d.ctx;
  const p0 = d.position, t0 = c.currentTime;
  await new Promise((r) => setTimeout(r, ms));
  return (d.position - p0) / (c.currentTime - t0);
}, ms);

try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 15000 });
  await page.evaluate(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
  const r = await page.evaluate(async (dir) => (await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) })).json(), music);
  check(r.id, 'folder added');
  await page.waitForFunction(() => window.opendj.library.tracks.size === 1, null, { timeout: 15000 });
  await page.evaluate(async () => { const t = [...window.opendj.library.tracks.values()][0]; await window.opendj.loadTrack(0, t.id); });
  check(await page.evaluate(() => window.opendj.engine.decks[0].duration > 80), 'track loaded on deck 1');

  // ---- wire DVS the way app.js will (until the wiring lines are added there) ----
  await page.evaluate(async () => {
    const app = window.opendj;
    if (!app.dvs) {
      const { DvsManager } = await import('/js/dvs/dvs.js');
      const { dvsButton, dvsModeIndicator } = await import('/js/dvs/dvs-ui.js');
      app.dvs = new DvsManager(app);
      document.querySelector('.topbar .tb-spacer').after(dvsButton(app));
      app.deckEls.forEach((root, i) => root.querySelector('.deck-sub')?.append(dvsModeIndicator(app, i)));
    }
    const s = app.dvs.settings;
    s.enabled = true; s.channelCount = 2; s.decks[0] = { ...s.decks[0], mode: 'rel', pair: 0, timecode: 'serato_2a', rpm: 33 };
    await app.dvs.save(s);
  });

  // ================= A) getUserMedia + fake capture file =================
  await page.evaluate(() => window.opendj.dvs.start());
  const info = await page.evaluate(() => ({ running: window.opendj.dvs.running, ch: window.opendj.dvs.channels, label: window.opendj.dvs.deviceLabel, sr: window.opendj.engine.ctx.sampleRate }));
  check(info.running, `DVS input opened through getUserMedia (${info.label || 'fake device'}, ${info.ch} ch, ctx ${info.sr} Hz)`);
  await page.waitForFunction(() => window.opendj.dvs.decks[0].status?.signal && window.opendj.engine.decks[0].playing, null, { timeout: 8000 });
  await page.waitForTimeout(1000);
  const stA = await page.evaluate(() => window.opendj.dvs.decks[0].status);
  if (process.env.DEBUG_DVS) console.log(JSON.stringify({ ...stA, scope: [...stA.scope.slice(0, 40)].map((x) => +x.toFixed(3)) }));
  check(stA.quality > 0.8, `timecode decoded from the capture device (quality ${(stA.quality * 100).toFixed(0)}%, carrier ${stA.carrierHz.toFixed(1)} Hz)`);
  await page.waitForTimeout(500);
  const vA = await measureSpeed(1500);
  check(Math.abs(vA - 1) < 0.01, `REL: deck 1 plays forwards at the record speed (${vA.toFixed(4)}×)`);
  check(await page.evaluate(() => document.querySelector('.deck[data-deck="0"] .dvs-mode')?.textContent === 'REL'), 'deck shows the REL indicator');

  await page.evaluate(() => window.opendj.dvs.decks[0].setMode('abs'));
  await page.waitForFunction(() => window.opendj.dvs.decks[0].status?.lock, null, { timeout: 5000 });
  await page.waitForTimeout(600);
  const abs = await page.evaluate(async () => {
    const dd = window.opendj.dvs.decks[0], d = window.opendj.engine.decks[0];
    const out = [];
    for (let k = 0; k < 5; k++) { await new Promise((r) => setTimeout(r, 120)); const st = dd.status; out.push({ rec: st.pos / 1000 + (d.ctx.currentTime - st.t), deck: d.position, lock: st.lock }); }
    return out;
  });
  const worstAbs = Math.max(...abs.map((x) => Math.abs(x.rec - x.deck)));
  check(abs.every((x) => x.lock) && abs[0].rec > TC_START_SEC - 0.5, `ABS: decoder locked to the record position (${abs[0].rec.toFixed(2)} s into the record)`);
  check(worstAbs < 0.06, `ABS: deck position follows the record (worst offset ${(worstAbs * 1000).toFixed(0)} ms)`);

  // ================= B) oscillator turntable through a MediaStream =================
  await page.evaluate(async () => {
    const app = window.opendj, c = app.engine.ctx;
    const dest = c.createMediaStreamDestination(); dest.channelCount = 2;
    const merge = c.createChannelMerger(2);
    const cosL = c.createOscillator(), sinR = c.createOscillator();
    cosL.setPeriodicWave(c.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0]), { disableNormalization: true }));
    for (const o of [cosL, sinR]) o.frequency.value = 1000;
    const g = c.createGain(); g.gain.value = 0.3;
    cosL.connect(merge, 0, 0); sinR.connect(merge, 0, 1); merge.connect(g); g.connect(dest);
    const t = c.currentTime + 0.05; cosL.start(t); sinR.start(t);
    window.__tt = { cosL, sinR, setHz: (hz) => { const at = c.currentTime + 0.02; cosL.frequency.setValueAtTime(hz, at); sinR.frequency.setValueAtTime(hz, at); return at; } };
    await app.dvs.decks[0].setMode('rel');
    await app.dvs.start(dest.stream);
  });
  await page.waitForFunction(() => window.opendj.dvs.decks[0].status?.signal, null, { timeout: 5000 });
  await page.waitForTimeout(400);
  const vB = await measureSpeed(1000);
  check(Math.abs(vB - 1) < 0.01, `oscillator turntable: forwards at ${vB.toFixed(4)}×`);
  const rev = await page.evaluate(async () => {
    const d = window.opendj.engine.decks[0], c = d.ctx;
    const at = window.__tt.setHz(-1000);
    const t0 = performance.now();
    while (performance.now() - t0 < 2000) { if (d._rate < -0.5) break; await new Promise((r) => setTimeout(r, 2)); }
    return { reacted: (c.currentTime - at) * 1000, rate: d._rate };
  });
  check(rev.rate < -0.5, `deck reverses when the record reverses (seen ${rev.reacted.toFixed(0)} ms after the change, incl. MediaStream + UI polling latency)`);
  await page.waitForTimeout(300);
  const vRev = await measureSpeed(800);
  check(Math.abs(vRev + 1) < 0.015, `plays backwards at ${vRev.toFixed(4)}×`);
  await page.evaluate(() => window.__tt.setHz(1050));
  await page.waitForTimeout(500);
  const vPitch = await measureSpeed(1000);
  check(Math.abs(vPitch - 1.05) < 0.01, `+5 % pitch on the turntable → ${vPitch.toFixed(4)}×`);
  await page.waitForTimeout(400);
  const tempo = await page.evaluate(() => window.opendj.engine.decks[0].tempo);
  check(Math.abs(tempo - 5) < 0.3, `turntable pitch shows as deck tempo (${tempo.toFixed(2)} %)`);
  // needle up: oscillators silent → deck stops
  await page.evaluate(() => { window.__tt.cosL.stop(); window.__tt.sinR.stop(); });
  await page.waitForFunction(() => !window.opendj.engine.decks[0].playing, null, { timeout: 2000 });
  check(true, 'needle lift (no signal) stops the deck');
  // INT hand-over keeps the deck under software control
  await page.evaluate(() => window.opendj.dvs.decks[0].setMode('int'));
  check(await page.evaluate(() => !window.opendj.engine.decks[0].external), 'INT mode releases the deck');

  // panel renders with a scope
  await page.evaluate(() => { import('/js/dvs/dvs-ui.js').then((m) => m.openDvsPanel(window.opendj)); });
  await page.waitForSelector('.dvs-panel .dvs-scope', { timeout: 3000 });
  await page.waitForTimeout(300);
  const shot = process.argv[2] || path.join(tmp, 'dvs.png');
  await page.screenshot({ path: shot });
  console.log('screenshot:', shot);
  const real = errors.filter((e) => !/favicon|404 \(Not Found\)/.test(e));
  check(real.length === 0, `no console errors${real.length ? ': ' + real.join(' | ') : ''}`);
  console.log('\nE2E DVS PASSED');
} catch (e) { await fail(e instanceof CheckError ? e.message : e.stack || e.message); }
await browser.close();
app.server.close();
process.exit(0);
