// Mixer screenshots / geometry for layout work: node scripts/mixer-shot.mjs <outDir> [name:WxH:layout:decks:zoom ...]
// Starts OpenDJ on a throw-away data folder (port 7880-7899), prints the mixer geometry and saves a mixer crop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const [out = '.', ...specs] = process.argv.slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-shot-'));
let app; for (let p = 7880; p < 7900 && !app; p++) { try { app = await start({ port: p, dataDir: path.join(tmp, 'data') }); } catch { /* port busy */ } }
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
fs.mkdirSync(out, { recursive: true });
for (const spec of specs.length ? specs : ['classic:1280:800:classic:2:100']) {
  const [name, w, h, layout = 'classic', decks = '2', zoom = '100', extra = ''] = spec.split(':');
  const page = await browser.newPage({ viewport: { width: +w, height: +h } });
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
  await page.evaluate(async ({ layout, decks, zoom, extra }) => {
    const a = window.opendj;
    if (+zoom !== (a.settings.uiScale || 100)) { await a.setSetting('uiScale', +zoom); (await import('/js/ui/themes.js')).applyTheme(a.settings); }
    if (+decks === 4) await a.setDeckCount(4); else await a.setLayout(layout);
    if (extra) for (const kv of extra.split(',')) { const [k, v] = kv.split('='); if (k === 'theme') { a.settings.theme = v; (await import('/js/ui/themes.js')).applyTheme(a.settings); } if (k === 'personality') window.opendjMixer?.setPersonality(v); if (k === 'drawer') window.opendjMixer?.toggleDrawer(true, v); }
  }, { layout, decks, zoom, extra });
  await page.waitForTimeout(600);
  const g = await page.evaluate(() => {
    const m = document.querySelector('.mixer'), r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
    return { mixer: r(m), xf: r(document.querySelector('.crossfader .fader-track')), strips: [...document.querySelectorAll('.mixer .strip')].filter((s) => s.offsetParent).map(r), master: r(document.querySelector('.mixer-master')) };
  });
  console.log(name, JSON.stringify(g));
  const m = await page.locator('.mixer').boundingBox();
  if (m) await page.screenshot({ path: path.join(out, `${name}.png`), clip: { x: Math.max(0, m.x - 4), y: Math.max(0, m.y - 4), width: m.width + 8, height: m.height + 8 } });
  await page.screenshot({ path: path.join(out, `${name}-full.png`) });
  await page.close();
}
await browser.close(); app.server.close(); app.shutdown?.(); fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
