// App Store / Google Play / desktop screenshots, recorded from OpenDJ's own UI with the review-pack tracks
// (scripts/review-pack/build-review-pack.mjs) loaded and playing. Re-run after UI changes: one command regenerates
// every image in docs/store/screenshots/<platform>/.
//
//   node scripts/review-pack/store-screenshots.mjs [--only=<platform,...>] [--scenes=<scene,...>] [--cache=<dir>]
//                                                  [--out=<dir>] [--port=7941] [--no-cc0]
//
// Platforms (pixel sizes = viewport × device scale factor; sources in docs/store/SCREENSHOT_SPECS.md):
//   ios-iphone-6.9   1320×2868  iPhone with Dynamic Island, large display (phone mode, ?local=1)
//   ios-iphone-6.3   1206×2622  iPhone with Dynamic Island, medium display (the one Apple lists as required)
//   ios-ipad-13      2752×2064  iPad 13-inch, landscape
//   play-phone       1080×1920  Google Play phone, 9:16
//   play-tablet-7    1080×1920  Google Play 7-inch tablet, 9:16 portrait
//   play-tablet-10   2560×1440  Google Play 10-inch tablet, 16:9
//   desktop-1080     1920×1080  desktop app / web app (GitHub, website)
//   desktop-1440     2560×1440
//   feature-graphic  1024×500   Google Play feature graphic (composed from a desktop shot + the app name)
// Scenes: mix library automix sampler effects video settings (video: desktop only: the mobile app has no video mixer)
//
// Mobile platforms run the UI in phone mode (?local=1: the on-device backend the iOS / Android app uses, tracks
// imported through the file picker); desktop platforms run the server-backed desktop UI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { start } from '../../server/index.js';
import { ensureProxyEnv, prepareTracks, ROOT, DEFAULT_CACHE } from './pack.mjs';
import { ffmpegPath } from '../demo/make-demo-library.mjs';

ensureProxyEnv();
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const log = (...a) => console.log('[store-shots]', ...a);

/** The empty library's "Import music" button, else the toolbar's Import (hidden in some narrow layouts). */
const importButton = (page) => page.locator('.lib-empty button', { hasText: 'Import music' }).or(page.locator('.lib-tools .import-btn:visible')).first();
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
export const PLATFORMS = {
  'ios-iphone-6.9': { local: true, viewport: [440, 956], dsf: 3 },
  'ios-iphone-6.3': { local: true, viewport: [402, 874], dsf: 3 },
  'ios-ipad-13': { local: true, viewport: [1376, 1032], dsf: 2, tablet: true },
  'play-phone': { local: true, viewport: [540, 960], dsf: 2 },
  'play-tablet-7': { local: true, viewport: [576, 1024], dsf: 1.875 }, // portrait: the 1024×576 landscape layout overlaps (see docs/store/README.md)
  'play-tablet-10': { local: true, viewport: [1280, 720], dsf: 2, tablet: true },
  'desktop-1080': { local: false, viewport: [1920, 1080], dsf: 1 },
  'desktop-1440': { local: false, viewport: [1920, 1080], dsf: 4 / 3 },
};
const SCENES = ['mix', 'library', 'automix', 'sampler', 'effects', 'video', 'settings'];
const only = opt('only', '').split(',').filter(Boolean);
const scenes = opt('scenes', SCENES.join(',')).split(',').filter(Boolean);
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/store/screenshots')));
const PORT = Number(opt('port', 7941));

// ------------------------------------------------------------------ tracks
const { tracks } = await prepareTracks({ cache: path.resolve(opt('cache', DEFAULT_CACHE)), cc0: !argv.includes('--no-cc0'), log: (s) => log(s) });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-store-shots-'));
const musicDir = path.join(tmp, 'OpenDJ Review Pack');
fs.mkdirSync(musicDir);
for (const t of tracks) fs.copyFileSync(t.file, path.join(musicDir, t.track.file));
const files = tracks.map((t) => path.join(musicDir, t.track.file));
const pick = (...titles) => titles.map((x) => tracks.find((t) => t.track.title === x)).find(Boolean)?.track.title;
// deck 1 / deck 2 of the mix: house 124 into techno 128 (synced), both generated, so always present
const A = pick('Open Circuit'), B = pick('Iron Lattice');

const app = await start({ port: PORT, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const results = [];

/** Open the UI for a platform with the pack imported and analysed. */
async function openPlatform(name, P) {
  const [width, height] = P.viewport;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: P.dsf, ...(P.local ? { isMobile: true, hasTouch: true, userAgent: MOBILE_UA } : {}) });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${name} page error]`, String(e)));
  await page.goto(`${app.url.replace(/\/$/, '')}/${P.local ? '?local=1' : ''}`);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
  await page.evaluate(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1500 }).catch(() => {});
  const have = await page.evaluate(() => window.opendj.library.tracks.size);
  if (P.local) {
    const chooser = page.waitForEvent('filechooser');
    await importButton(page).click();
    await (await chooser).setFiles(files);
  } else if (!have) {
    await page.evaluate((dir) => fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir, name: 'Review Pack' }) }), musicDir);
  }
  await page.waitForFunction((n) => window.opendj.library.tracks.size === n, files.length, { timeout: 120000 });
  if (P.local) await page.waitForFunction(() => [...window.opendj.library.tracks.values()].every((t) => t.analyzed) && !window.opendj.analyser.running, null, { timeout: 300000 });
  const ids = await page.evaluate(() => Object.fromEntries([...window.opendj.library.tracks.values()].map((t) => [t.title, t.id])));
  if (!P.local) for (const title of Object.keys(ids)) await loadDeck(page, 1, ids[title]); // desktop analyses on load
  // playlists (same in both backends: the phone mode answers /api/... in the page)
  const havePl = await page.evaluate(() => window.opendj.library.playlists.length);
  if (!havePl) {
    const post = (u, b) => page.evaluate(([u, b]) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json()), [u, b]);
    const T = (...n) => n.map((x) => ids[x]).filter(Boolean);
    await post('/api/playlists', { name: 'Review Pack', trackIds: Object.values(ids) });
    await post('/api/playlists', { name: 'Warm-up', trackIds: T('Fire Place', 'Paper Lanterns', 'Roller Fever') });
    await post('/api/playlists', { name: 'Peak time', trackIds: T('After Party', 'Open Circuit', 'Iron Lattice') });
    await page.evaluate(() => window.opendj.library.refresh());
  }
  // a few ratings / colours make the library look used (local edits, nothing personal)
  const meta = { 'Open Circuit': { rating: 5, color: '#ff007f' }, 'Iron Lattice': { rating: 4, color: '#ff0000' }, 'After Party': { rating: 4, color: '#ffa500' }, 'Roller Fever': { rating: 4, color: '#ffff00' }, 'Fire Place': { rating: 3, color: '#660099' }, 'Paper Lanterns': { rating: 4, color: '#25fde9' } };
  for (const [t, p] of Object.entries(meta)) if (ids[t]) await page.evaluate(([id, p]) => fetch(`/api/tracks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }), [ids[t], p]);
  await page.evaluate(() => window.opendj.library.refresh());
  return { ctx, page, ids };
}

async function loadDeck(page, i, id) {
  if (await page.evaluate(([i, id]) => window.opendj.engine.decks[i].track?.id === id, [i, id])) return;
  await page.evaluate((i) => window.opendj.engine.decks[i].pause(), i);
  await page.evaluate(([i, id]) => window.opendj.loadTrack(i, id), [i, id]);
  await page.waitForFunction((i) => !!window.opendj.engine.decks[i].waveform, i, { timeout: 60000 });
}

/** Two decks mixing: house on deck 1 in its drop, techno on deck 2 synced to it with the bass cut and a loop. */
async function mixState(page, ids, { fx = false } = {}) {
  await closeOverlays(page);
  await loadDeck(page, 0, ids[A]);
  await loadDeck(page, 1, ids[B]);
  await page.evaluate(({ fx }) => {
    const a = window.opendj, E = a.engine, [d1, d2] = E.decks;
    a.setDeckCount?.(2, false);
    E.channels.forEach((c) => { for (const k of ['eqLow', 'eqMid', 'eqHigh', 'filter']) c.set(k, 0); c.set('fxOn', false); });
    d1.setMaster?.();
    if (!d1.playing) d1.seek(d1.beatLen * 4 * 30);
    if (!d2.playing) d2.seek(d2.beatLen * 4 * 26);
    E.channels[0].set('volume', 1); E.channels[1].set('volume', 0.9);
    E.channels[1].set('eqLow', -0.7); E.channels[0].set('eqHigh', 0.1); E.channels[1].set('filter', 0.15);
    E.setCrossfader(-0.15);
    if (!d1.playing) d1.play();
    if (!d2.playing) d2.play();
    d2.sync();
    if (fx) {
      E.channels[0].set('fxType', 'echo'); E.channels[0].set('fxMix', 0.45); E.channels[0].set('fxOn', true);
      E.channels[1].set('fxType', 'flanger'); E.channels[1].set('fxMix', 0.6); E.channels[1].set('fxOn', true);
    }
    a.mixer.renderAll?.();
    a.showDeckTab?.(0);
    E.decks.forEach((d) => d.showPanel?.('cues'));
  }, { fx });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const d2 = window.opendj.engine.decks[1]; if (!d2.loop?.active && !d2.looping) d2.autoLoop?.(8); });
}

async function closeOverlays(page) {
  await page.evaluate(() => { document.querySelectorAll('.overlay .modal-x').forEach((x) => x.click()); document.querySelectorAll('.ctx-menu, .toast, .upl-panel').forEach((x) => { x.remove?.(); }); });
  await page.waitForTimeout(150);
}
const scrollTo = (page, sel, block = 'start') => page.evaluate(([sel, block]) => { const e = document.querySelector(sel); if (e) e.scrollIntoView({ block }); document.querySelector('#app')?.scrollBy?.(0, 0); }, [sel, block]);
const scrollTop = (page) => page.evaluate(() => { document.querySelector('#app')?.scrollTo?.(0, 0); window.scrollTo(0, 0); });
const panels = (page, id) => page.evaluate((id) => window.opendj.engine.decks.forEach((d) => d.showPanel?.(id)), id);

const SCENE_FN = {
  async mix({ page, ids, P }) {
    await mixState(page, ids);
    await scrollTop(page);
  },
  async library({ page, ids, P }) {
    await mixState(page, ids);
    await page.evaluate(() => window.opendj.library.setView({ kind: 'all' }, 'Collection'));
    if (!P.local) await page.evaluate(() => document.documentElement.style.setProperty('--browser-h', `${Math.round(innerHeight * 0.42)}px`));
    else if (P.tablet && P.viewport[1] >= 900) await page.evaluate(() => document.documentElement.style.setProperty('--browser-h', `${Math.round(innerHeight * 0.5)}px`));
    else if (P.tablet) { /* small tablets: the default split already shows the library */ }
    else await scrollTo(page, '.sampler-bar');
  },
  async automix({ page, ids, P }) {
    await mixState(page, ids);
    await page.evaluate(() => { const L = window.opendj.library; const p = L.playlists.find((x) => x.name === 'Review Pack'); L.setView({ kind: 'playlist', id: p.id }, p.name); });
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.opendj.dialogs.automixQueue(window.opendj.library.rows, { title: 'Review Pack' }); }); // resolves on close
    await page.waitForSelector('.overlay .modal', { timeout: 5000 });
  },
  async sampler({ page, ids, P }) {
    await mixState(page, ids);
    // a running pattern on the step sequencer (rows = sampler pads), synced to the master deck
    await page.evaluate(() => {
      const s = window.opendj.sequencer;
      s.clear();
      const set = (r, steps) => { if (r < s.rows) for (const c of steps) if (c < s.steps) s.toggle(r, c); };
      set(3, [0, 4, 8, 12]); set(4, [4, 12]); set(5, [2, 6, 10, 14]); set(1, [14]);
      if (!window.opendj.seqPanel) window.opendj.toggleSequencer();
      if (!s.running) s.start();
    });
    await page.waitForTimeout(400);
    if (P.local && !P.tablet) await scrollTo(page, '.sampler-bar');
  },
  async effects({ page, ids, P }) {
    await mixState(page, ids, { fx: true });
    await panels(page, 'fx');
    if (P.local && !P.tablet) await scrollTo(page, '.deck:not(.m-hide) .panel-tabs', 'center');
  },
  async video({ page, ids, P }) {
    if (P.local) return 'skip'; // the mobile app has no video mixer (platform.js MOBILE_UNAVAILABLE.video)
    await mixState(page, ids);
    await page.evaluate(async () => {
      const a = window.opendj;
      const api = (a.videoUi ||= (await import('/js/video/video-ui.js')).setupVideo(a));
      api.openPanel();
      a.video.mixer.showNowPlaying?.('OpenDJ Demo – Open Circuit');
    });
    // the tab of the optional third-party video source is hidden: no third-party names in store images
    await page.evaluate(() => { for (const b of document.querySelectorAll('.vid-panel button, [class*="vid"] button')) if (b.textContent.trim() === 'YouTube') b.style.display = 'none'; const f = document.querySelector('.vid-fps'); if (f) f.style.visibility = 'hidden'; }); // (the fps readout shows the headless software renderer's rate)
    await page.waitForTimeout(2500);
  },
  async settings({ page, P }) {
    await page.evaluate(() => { window.opendj.dialogs.settings('appearance'); });
    await page.waitForSelector('.overlay .modal', { timeout: 5000 });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelectorAll('.overlay .modal, .overlay .modal *').forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }));
  },
};

async function shoot(page, file) {
  await page.evaluate(() => {
    document.activeElement?.blur?.(); document.querySelectorAll('.toast, .upl-panel').forEach((x) => x.remove());
    for (const e of document.querySelectorAll('*')) if (e.scrollLeft) e.scrollLeft = 0; // scrollIntoView can pan wide tables sideways
  });
  await page.waitForTimeout(1200); // meters, waveforms and the visualiser move
  await page.screenshot({ path: file, type: 'jpeg', quality: 84 });
}

for (const [name, P] of Object.entries(PLATFORMS)) {
  if (only.length && !only.includes(name)) continue;
  const dir = path.join(OUT, name);
  fs.mkdirSync(dir, { recursive: true });
  log(`--- ${name} ${P.viewport.join('×')} @${P.dsf}`);
  const s = await openPlatform(name, P);
  for (const [n, scene] of scenes.entries()) {
    try {
      const r = await SCENE_FN[scene]({ ...s, P });
      if (r === 'skip') { log(`  ${scene}: skipped on ${name}`); continue; }
      const file = path.join(dir, `${String(SCENES.indexOf(scene) + 1).padStart(2, '0')}-${scene}.jpg`);
      await shoot(s.page, file);
      const size = fs.statSync(file).size;
      results.push({ file: path.relative(ROOT, file), bytes: size });
      log(`  ${path.relative(ROOT, file)} ${Math.round(size / 1024)} KB`);
    } catch (e) { console.error(`  ${scene} failed on ${name}:`, e); }
    await closeOverlays(s.page);
    await s.page.evaluate(() => { const a = window.opendj; a.video?.api?.closePanel?.(); if (a.seqPanel) { a.sequencer.stop(); a.toggleSequencer(); } a.engine.channels.forEach((c) => c.set('fxOn', false)); document.documentElement.style.removeProperty('--browser-h'); });
  }
  await s.ctx.close();
}

// ------------------------------------------------------------------ Google Play feature graphic (1024×500)
if (!only.length || only.includes('feature-graphic')) {
  const src = path.join(OUT, 'desktop-1080', '01-mix.jpg');
  if (fs.existsSync(src)) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 500 } });
    const img = fs.readFileSync(src).toString('base64');
    await page.setContent(`<!doctype html><html><head><style>
      html,body{margin:0;width:1024px;height:500px;overflow:hidden;background:#07090c;font-family:Inter,"DejaVu Sans",sans-serif}
      .shot{position:absolute;right:-230px;top:46px;width:800px;border-radius:12px;box-shadow:0 20px 60px #000c;transform:perspective(1400px) rotateY(-14deg) rotateX(3deg)}
      .glow{position:absolute;inset:0;background:radial-gradient(600px 380px at 20% 50%,#1b6dff33,transparent 70%),radial-gradient(500px 300px at 90% 90%,#ff3d8a22,transparent 70%)}
      .txt{position:absolute;left:56px;top:150px;color:#fff}
      h1{margin:0;font-size:84px;font-weight:800;letter-spacing:-2px}
      p{margin:10px 0 0;font-size:26px;color:#b9c4d4;max-width:360px;line-height:1.25}
      .tag{margin-top:22px;display:inline-block;font-size:18px;color:#7fb2ff;border:1px solid #7fb2ff66;border-radius:999px;padding:6px 14px}
    </style></head><body><div class="glow"></div><img class="shot" src="data:image/jpeg;base64,${img}"><div class="txt"><h1>OpenDJ</h1><p>Free, open-source DJ app. Mix your own music.</p><span class="tag">No account · No ads · Works offline</span></div></body></html>`);
    await page.waitForTimeout(300);
    const dir = path.join(OUT, 'play-feature-graphic'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'feature-graphic-1024x500.png');
    await page.screenshot({ path: path.join(tmp, 'fg.png') });
    // 24-bit PNG without alpha, as Google Play asks
    const r = spawnSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(tmp, 'fg.png'), '-pix_fmt', 'rgb24', file]);
    if (r.status !== 0) fs.copyFileSync(path.join(tmp, 'fg.png'), file);
    results.push({ file: path.relative(ROOT, file), bytes: fs.statSync(file).size });
    log(`  ${path.relative(ROOT, file)} ${Math.round(fs.statSync(file).size / 1024)} KB`);
    await page.close();
  } else log('feature graphic: needs desktop-1080/01-mix.jpg first');
}

fs.writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify(mergeIndex(results), null, 2)}\n`);
await browser.close();
app.shutdown?.(); app.server.close();
fs.rmSync(tmp, { recursive: true, force: true });
log(`done: ${results.length} images, ${(results.reduce((a, r) => a + r.bytes, 0) / 1048576).toFixed(1)} MB`);
process.exit(0);

/** docs/store/screenshots/index.json: every image with its pixel size (kept across partial runs). */
function mergeIndex(res) {
  const f = path.join(OUT, 'index.json');
  const old = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
  const map = new Map(old.map((x) => [x.file, x]));
  for (const r of res) {
    const name = r.file.split('/').at(-2);
    const P = PLATFORMS[name];
    map.set(r.file, { file: r.file, pixels: P ? `${Math.round(P.viewport[0] * P.dsf)}x${Math.round(P.viewport[1] * P.dsf)}` : '1024x500', mode: P ? (P.local ? 'phone mode (?local=1)' : 'desktop') : 'composed', kb: Math.round(r.bytes / 1024) });
  }
  return [...map.values()].filter((x) => fs.existsSync(path.join(ROOT, x.file))).sort((a, b) => a.file.localeCompare(b.file));
}
