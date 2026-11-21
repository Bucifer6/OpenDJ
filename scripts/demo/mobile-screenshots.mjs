// Phone / tablet screenshots for docs/MOBILE.md (docs/images/mobile-*.png): the fictional demo library
// (scripts/demo/make-demo-library.mjs) on an emulated iPhone 13 (portrait + landscape) and an iPad in landscape,
// two decks loaded and deck 1 playing.
//
//   node scripts/demo/mobile-screenshots.mjs [--out=<dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { start } from '../../server/index.js';
import { makeDemoLibrary, TRACKS } from './make-demo-library.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const a = process.argv.find((x) => x.startsWith('--out='));
const OUT = path.resolve(a ? a.slice(6) : path.join(ROOT, 'docs/images'));
fs.mkdirSync(OUT, { recursive: true });
const lib = await makeDemoLibrary(path.join(os.tmpdir(), 'opendj-demo-library'));
const app = await start({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-mshots-')) });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const phone = devices['iPhone 13'];
const profiles = [
  ['mobile-phone', { ...phone, viewport: { width: 390, height: 664 }, deviceScaleFactor: 1.5 }],
  ['mobile-phone-landscape', { ...phone, viewport: { width: 750, height: 342 }, deviceScaleFactor: 1.5 }],
  ['mobile-tablet', { viewport: { width: 1194, height: 834 }, deviceScaleFactor: 1.2, isMobile: true, hasTouch: true }],
];
let first = true;
for (const [name, profile] of profiles) {
  const ctx = await browser.newContext(profile);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[page error]', String(e)));
  const ev = (fn, arg) => page.evaluate(fn, arg);
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
  await ev(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
  if (first) { await ev((dir) => fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir, name: 'Demo Music' }) }), lib); first = false; }
  await page.waitForFunction((n) => window.opendj.library.tracks.size === n, TRACKS.length, { timeout: 60000 });
  const ids = await ev(() => Object.fromEntries([...window.opendj.library.tracks.values()].map((t) => [t.title, t.id])));
  for (const [i, t] of [[0, 'Pressure Index'], [1, 'Copper Skyline']]) {
    await ev(([i, id]) => window.opendj.loadTrack(i, id), [i, ids[t]]);
    await page.waitForFunction((i) => !!window.opendj.engine.decks[i].waveform, i, { timeout: 60000 });
  }
  await ev(() => { const [d1, d2] = window.opendj.engine.decks; d1.setMaster(); d1.seek(d1.beatLen * 4 * 46); d2.seek(d2.beatLen * 4 * 8); d1.play(); d2.play(); d2.sync(); window.opendj.showDeckTab?.(0); });
  await page.waitForTimeout(1500);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('[mobile shots]', path.basename(file), Math.round(fs.statSync(file).size / 1024), 'KB');
  await ctx.close();
}
await browser.close();
app.server.close();
process.exit(0);
