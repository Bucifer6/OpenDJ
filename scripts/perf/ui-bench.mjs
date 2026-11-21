// UI audit + playback frame-rate benchmark. Starts OpenDJ on a throw-away data folder with the fictional demo
// library (scripts/demo/make-demo-library.mjs), loads and plays decks, then
//   * --shots: screenshots at 1920x1080 / 1366x768, 2 and 4 decks, a few themes  -> <out>/<theme>-<w>-<n>deck.png
//   * --perf:  frame times, dropped frames, long tasks and style/layout/script time while 2 (and 4) decks play,
//              at normal speed and with 4x CPU throttling (Chrome DevTools Protocol)
//
//   node scripts/perf/ui-bench.mjs [--shots] [--perf] [--out=<dir>] [--themes=midnight,light,neon] [--secs=6]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { start } from '../../server/index.js';
import { makeDemoLibrary, TRACKS } from '../demo/make-demo-library.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const OUT = path.resolve(opt('out', path.join(os.tmpdir(), 'opendj-ui-bench')));
const THEMES = opt('themes', 'midnight,light,neon').split(',');
const SECS = Number(opt('secs', 6));
const LAYOUTS = opt('layouts', 'classic').split(',');
fs.mkdirSync(OUT, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-bench-'));
const lib = await makeDemoLibrary(path.join(os.tmpdir(), 'opendj-demo-library'));
const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('pageerror', (e) => console.error('[page error]', String(e)));
const ev = (fn, arg) => page.evaluate(fn, arg);
const sleep = (ms) => page.waitForTimeout(ms);

await page.goto(app.url);
await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
await ev(() => window.opendj.engine.resume());
await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
await ev((dir) => fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir, name: 'Demo Music' }) }), lib);
await page.waitForFunction((n) => window.opendj.library.tracks.size === n, TRACKS.length, { timeout: 60000 });
const ids = await ev(() => Object.fromEntries([...window.opendj.library.tracks.values()].map((t) => [t.title, t.id])));
async function loadDeck(i, title) {
  await ev((i) => window.opendj.engine.decks[i].pause(), i);
  await ev(([i, id]) => window.opendj.loadTrack(i, id), [i, ids[title]]);
  await page.waitForFunction((i) => !!window.opendj.engine.decks[i].waveform, i, { timeout: 60000 });
}
const titles = ['Pressure Index', 'Copper Skyline', 'Static Bloom', 'Midnight Transit'];
for (let i = 0; i < 4; i++) await loadDeck(i, titles[i]);
// let the background analyser finish first (measured separately with --analysis)
if (!argv.includes('--analysis')) await page.waitForFunction(() => !window.opendj.analyser.running, null, { timeout: 180000 }).catch(() => console.warn('analyser still running'));
async function playState(n, layout = 'classic') {
  await ev(async ([n, layout]) => {
    const a = window.opendj, E = a.engine;
    if (a.setLayout) { E.decks.forEach((d) => d.pause()); await a.setLayout(layout, false); }
    E.decks.forEach((d, i) => { d.pause(); d.exitLoop?.(); d.seek(d.beatLen * 4 * [46, 8, 24, 56][i]); });
    a.setDeckCount(n, false);
    E.channels[1].set('eqLow', -0.75); E.channels[0].set('fxType', 'echo'); E.channels[0].set('fxOn', true); E.channels[0].set('fxMix', 0.35);
    E.decks.slice(0, n).forEach((d, i) => { d.play(); if (i) d.sync(); });
    E.decks[1].autoLoop(8);
    a.mixer.renderAll?.();
  }, [n, layout]);
  await sleep(600);
}
const setTheme = (id) => ev(async (id) => { const { applyTheme } = await import('/js/ui/themes.js'); await window.opendj.setSetting('theme', id); applyTheme(window.opendj.settings); }, id);

if (argv.includes('--shots')) {
  for (const theme of THEMES) {
    await setTheme(theme);
    for (const [w, h] of [[1920, 1080], [1366, 768]]) {
      await page.setViewportSize({ width: w, height: h });
      for (const [n, layout] of [...LAYOUTS.map((l) => [2, l]), [4, 'classic']]) {
        await playState(n, layout);
        await sleep(700);
        const f = path.join(OUT, `${theme}-${w}-${n}deck${n === 2 && layout !== 'classic' ? '-' + layout : ''}.png`);
        await page.screenshot({ path: f });
        console.log('[shot]', f);
      }
    }
  }
  await setTheme('midnight');
  await page.setViewportSize({ width: 1920, height: 1080 });
}

if (argv.includes('--perf')) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const results = [];
  for (const n of [2, 4]) for (const throttle of [1, 4]) {
    await playState(n);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await sleep(800);
    const m0 = await metric();
    const r = await ev((secs) => new Promise((res) => {
      const frames = []; const longs = [];
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push(e.duration); });
      try { po.observe({ type: 'longtask', buffered: false }); } catch {}
      let last = performance.now(); const t0 = last;
      const tick = (now) => { frames.push(now - last); last = now; if (now - t0 < secs * 1000) requestAnimationFrame(tick); else { po.disconnect(); res({ frames, longs, wall: now - t0 }); } };
      requestAnimationFrame(tick);
    }), SECS);
    const m1 = await metric();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const f = r.frames.slice(1).sort((a, b) => a - b);
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    const pct = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))];
    const d = (k) => ((m1[k] - m0[k]) * 1000 / (r.wall / 1000)); // ms per second of wall time
    const row = {
      decks: n, cpu: `${throttle}x`, fps: +(1000 / avg).toFixed(1), p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), p99: +pct(0.99).toFixed(1),
      dropped: f.filter((x) => x > 1000 / 60 * 1.5).length, frames: f.length, longTasks: r.longs.length, longMs: Math.round(r.longs.reduce((a, b) => a + b, 0)),
      'script ms/s': +d('ScriptDuration').toFixed(0), 'style ms/s': +d('RecalcStyleDuration').toFixed(0), 'layout ms/s': +d('LayoutDuration').toFixed(0), 'task ms/s': +d('TaskDuration').toFixed(0),
      'layouts/s': +((m1.LayoutCount - m0.LayoutCount) / (r.wall / 1000)).toFixed(1), 'recalcs/s': +((m1.RecalcStyleCount - m0.RecalcStyleCount) / (r.wall / 1000)).toFixed(1),
    };
    results.push(row); console.log('[perf]', JSON.stringify(row));
  }
  console.table(results);
  fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify(results, null, 2));
}

if (argv.includes('--latency')) {
  // pointer down -> next rendered frame (double rAF after the event's timestamp), for the controls you hit live
  await page.setViewportSize({ width: 1920, height: 1080 });
  await playState(2, LAYOUTS[0]);
  await ev(() => { window._lat = []; document.addEventListener('pointerdown', (e) => { const t0 = e.timeStamp; requestAnimationFrame(() => requestAnimationFrame((t2) => window._lat.push({ el: e.target.closest('button, .pad, .knob')?.className || e.target.className, ms: t2 - t0 }))); }, true); });
  const targets = ['.deck[data-deck="0"] .pad >> nth=4', '.deck[data-deck="0"] .panel-tab >> nth=1', '.deck[data-deck="0"] .panel-tab >> nth=0', '.deck[data-deck="0"] .btn-sync', '.strip[data-ch="0"] .btn-pfl', '.layout-seg .seg-btn >> nth=0'];
  for (let k = 0; k < 4; k++) for (const t of targets) { await page.locator(t).click(); await sleep(60); }
  const lat = await ev(() => window._lat.map((x) => x.ms).sort((a, b) => a - b));
  const res = { samples: lat.length, p50: +lat[Math.floor(lat.length / 2)].toFixed(1), p95: +lat[Math.floor(lat.length * 0.95)].toFixed(1), max: +lat.at(-1).toFixed(1) };
  console.log('[latency] pointerdown -> next frame (ms):', JSON.stringify(res));
  // long tasks while a track loads onto deck 1 and while the background analyser works, deck 2 playing
  const measure = (fn) => ev(async (src) => {
    const longs = []; const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push(e.duration); }); po.observe({ type: 'longtask' });
    const frames = []; let last = performance.now(), run = true; const tick = (t) => { frames.push(t - last); last = t; if (run) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    await (0, eval)(src)();
    run = false; po.disconnect();
    const f = frames.slice(1);
    return { longTasks: longs.length, longest: Math.round(Math.max(0, ...longs)), droppedFrames: f.filter((x) => x > 25).length, frames: f.length, worstFrame: Math.round(Math.max(...f)) };
  }, fn);
  const load = await measure(`async () => { const a = window.opendj, E = a.engine; E.decks[1].play(); E.decks[0].pause(); const id = [...a.library.tracks.values()].find((t) => t.title === 'Glass Horizon').id; await a.loadTrack(0, id); await new Promise((r) => setTimeout(r, 500)); }`);
  console.log('[load] track load while a deck plays:', JSON.stringify(load));
  const ana = await measure(`async () => { const a = window.opendj; a.engine.decks[1].play(); a.analyser.request([...a.library.tracks.values()].slice(0, 3), { force: true }); await new Promise((r) => setTimeout(r, 400)); for (let i = 0; i < 300 && a.analyser.running; i++) await new Promise((r) => setTimeout(r, 100)); }`);
  console.log('[analysis] background analysis of 3 tracks while a deck plays:', JSON.stringify(ana));
}

await browser.close();
app.shutdown?.(); app.server.close();
process.exit(0);
