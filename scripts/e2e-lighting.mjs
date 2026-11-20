// End-to-end lighting test: plays a generated 124 BPM track in headless Chromium, lets the renderer feed the
// server's show engine and checks that Art-Net packets arrive on a local UDP port, changing on the beat.
// Usage: node scripts/e2e-lighting.mjs [screenshot-dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-light-'));
const shots = process.argv[2] || tmp;
fs.mkdirSync(shots, { recursive: true });
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
writeWav(path.join(music, 'Light Test - Groove 124.wav'), 124, 40, 220);

// Art-Net receiver
const udp = dgram.createSocket('udp4');
const packets = [];
udp.on('message', (m) => packets.push({ t: Date.now(), m }));
await new Promise((r) => udp.bind(0, '127.0.0.1', r));
const artPort = udp.address().port;

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const done = async (code) => { await browser.close(); app.server.close(); udp.close(); process.exit(code); };
class CheckError extends Error {}
const check = (cond, msg) => { if (!cond) throw new CheckError(msg); console.log('ok -', msg); };

try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 15000 });
  await page.evaluate(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});

  await page.evaluate(async (dir) => fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) }), music);
  await page.waitForFunction(() => window.opendj.library.tracks.size === 1, null, { timeout: 15000 });

  // app.js wiring isn't in place yet: create the Lighting instance here (same lines app.js will use).
  await page.evaluate(async () => {
    if (!document.querySelector('link[href$="lighting.css"]')) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'css/lighting.css' }));
    const { Lighting } = await import('/js/lighting/lighting.js');
    const app = window.opendj;
    if (!app.lighting) { app.lighting = new Lighting(app); await app.lighting.init(); }
  });
  check(await page.evaluate(() => !!window.opendj.lighting.meta), 'Lighting module initialised from the server');

  await page.evaluate(async (port) => {
    const L = window.opendj.lighting;
    await L.saveConfig({
      enabled: true,
      fixtures: [
        ...[1, 2, 3, 4].map((n) => ({ id: `par${n}`, name: `Par ${n}`, type: 'rgb', channels: ['dim', 'r', 'g', 'b', 'strobe'], universe: 1, address: 1 + (n - 1) * 5, group: n <= 2 ? 'left' : 'right' })),
        { id: 'strobe1', name: 'Strobe', type: 'strobe', channels: ['dim', 'rate'], universe: 1, address: 21 },
        { id: 'strip1', name: 'Bar strip', type: 'wled-strip', host: '', pixels: 60 },
      ],
      show: { auto: false, manualEffect: 'chase', colorMode: 'key' },
      outputs: { artnet: { enabled: true, host: '127.0.0.1', port, net: 0, subnet: 0, universe: 0 } },
    });
  }, artPort);

  const id = await page.evaluate(() => [...window.opendj.library.tracks.values()][0].id);
  await page.evaluate(async (id) => { await window.opendj.loadTrack(0, id); }, id);
  const bpm = await page.evaluate(() => window.opendj.engine.decks[0].bpm);
  check(Math.abs(bpm - 124) < 0.2, `track analysed at ${bpm.toFixed(2)} BPM`);
  await page.evaluate(() => window.opendj.engine.decks[0].play());
  await page.waitForTimeout(600);
  packets.length = 0;
  const t0 = Date.now();
  await page.waitForTimeout(4200);
  const sample = await page.evaluate(() => window.opendj.lighting.sample());
  const art = packets.filter((p) => p.t >= t0);
  check(art.length >= 6, `${art.length} ArtDmx packets received (sent on change + 1 s keepalive) on 127.0.0.1:${artPort}`);
  check(art.every((p) => p.m.toString('ascii', 0, 8) === 'Art-Net\0' && p.m.readUInt16LE(8) === 0x5000), 'all packets are ArtDmx');
  const seqs = art.map((p) => p.m[12]);
  check(seqs.every((s, i) => i === 0 || s === (seqs[i - 1] % 255) + 1), 'sequence numbers increment');

  // which par is lit (chase): dimmer channel at 1, 6, 11, 16
  // (the WLED strip is chase slot 5, so every 5th beat no par is lit)
  const lit = (m) => [0, 1, 2, 3].map((i) => m[18 + i * 5]).join(',');
  if (process.env.DEBUG) console.log(art.map((p) => `${p.t - t0} ${[0, 1, 2, 3].map((i) => p.m[18 + i * 5]).join(",")} ${p.m.subarray(18, 40).toString("hex")}`).join("\n"), sample);
  const changes = [];
  for (let i = 1; i < art.length; i++) if (lit(art[i].m) !== lit(art[i - 1].m)) changes.push(art[i]);
  check(changes.length >= 6, `chase stepped ${changes.length} times in 4.2 s`);
  const iv = changes.slice(1).map((c, i) => c.t - changes[i].t).sort((a, b) => a - b);
  const med = iv[Math.floor(iv.length / 2)];
  check(Math.abs(med - 60000 / 124) < 60, `steps every ${med} ms (one beat at 124 BPM = ${(60000 / 124).toFixed(0)} ms)`);
  // phase: each step should land on a beat of the audible beat clock reported by the renderer
  const beatAt = (t) => sample.beat + (t - sample.at) * sample.bpm / 60000;
  const phases = changes.map((c) => { const f = beatAt(c.t) % 1; return f > 0.5 ? f - 1 : f; });
  const worst = Math.max(...phases.map(Math.abs));
  check(worst < 0.15, `steps are on the beat (worst phase error ${(worst * 60000 / 124).toFixed(0)} ms)`);

  // auto mode with the analysed phrases: lights keep changing
  await page.evaluate(() => window.opendj.lighting.setLive({ auto: true }));
  packets.length = 0;
  await page.waitForTimeout(1500);
  const autoVals = new Set(packets.map((p) => p.m.subarray(18, 40).toString('hex')));
  check(autoVals.size > 3, `auto show produces changing frames (${autoVals.size} distinct)`);
  // blackout override
  await page.evaluate(() => window.opendj.lighting.setLive({ blackout: true }));
  await page.waitForTimeout(200); packets.length = 0; await page.waitForTimeout(1200);
  check(packets.length >= 1 && packets.every((p) => p.m.subarray(18).every((v) => v === 0)), 'blackout sends all-zero frames');
  await page.evaluate(() => window.opendj.lighting.setLive({ blackout: false }));

  // panel screenshots
  await page.evaluate(() => { window.opendj.lighting.openPanel(); });
  await page.waitForSelector('.lt-stage .lt-node');
  await page.waitForTimeout(700);
  const glowing = await page.evaluate(() => [...document.querySelectorAll('.lt-bulb')].filter((b) => b.style.background && b.style.background !== 'rgb(0, 0, 0)').length);
  check(glowing >= 1, `live preview paints fixtures (${glowing} lit)`);
  await page.screenshot({ path: path.join(shots, 'lighting-live.png') });
  for (const tab of ['Fixtures', 'Outputs', 'Show']) {
    await page.locator('.lt-panel .tab', { hasText: tab }).click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shots, `lighting-${tab.toLowerCase()}.png`) });
  }
  console.log('screenshots:', shots);
  check(!errors.length, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await done(0);
} catch (e) {
  console.error('FAIL:', e.message);
  if (!(e instanceof CheckError)) console.error(e.stack);
  console.error(errors.join('\n'));
  await page.screenshot({ path: path.join(tmp, 'fail.png') }).catch(() => {});
  console.error('screenshot', path.join(tmp, 'fail.png'));
  await done(1);
}
