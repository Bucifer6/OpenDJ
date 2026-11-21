// UI audit + playback frame-rate benchmark. Starts OpenDJ on a throw-away data folder with the fictional demo
// library (scripts/demo/make-demo-library.mjs), loads and plays decks, then
//   * --shots: screenshots at 1920x1080 / 1366x768, 2 and 4 decks, a few themes  -> <out>/<theme>-<w>-<n>deck.png
//   * --perf:  frame times, dropped frames, long tasks and style/layout/script time while 2 (and 4) decks play,
//              at normal speed and with 4x CPU throttling (Chrome DevTools Protocol)
//
//   * --fx:    with --perf: heavy effects on every channel (reverb, flanger, phaser, trans, Space / Jet Color FX)
//              and the audio thread's load / glitch counters where the browser exposes them
//
//   node scripts/perf/ui-bench.mjs [--shots] [--perf] [--fx] [--out=<dir>] [--themes=midnight,light,neon] [--secs=6]
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
async function playState(n) {
  await ev(([n, fx]) => {
    const a = window.opendj, E = a.engine;
    E.decks.forEach((d, i) => { d.pause(); d.exitLoop?.(); d.seek(d.beatLen * 4 * [46, 8, 24, 56][i]); });
    a.setDeckCount(n, false);
    E.channels[1].set('eqLow', -0.75); E.channels[0].set('fxType', 'echo'); E.channels[0].set('fxOn', true); E.channels[0].set('fxMix', 0.35);
    E.decks.slice(0, n).forEach((d, i) => { d.play(); if (i) d.sync(); });
    E.decks[1].autoLoop(8);
    if (fx) {
      [['reverb', 0.5], ['flanger', 0.6], ['phaser', 0.6], ['trans', 0.8]].forEach(([t, m], i) => { const ch = E.channels[i]; ch.set('fxType', t); ch.set('fxMix', m); ch.set('fxOn', true); });
      E.channels.forEach((ch, i) => { ch.set('colorFx', i % 2 ? 'pitch' : 'space'); ch.set('filter', i % 2 ? 0.35 : -0.4); });
    }
    a.mixer.renderAll?.();
  }, [n, argv.includes('--fx')]);
  await sleep(600);
}
const setTheme = (id) => ev(async (id) => { const { applyTheme } = await import('/js/ui/themes.js'); await window.opendj.setSetting('theme', id); applyTheme(window.opendj.settings); }, id);

if (argv.includes('--shots')) {
  for (const theme of THEMES) {
    await setTheme(theme);
    for (const [w, h] of [[1920, 1080], [1366, 768]]) {
      await page.setViewportSize({ width: w, height: h });
      for (const n of [2, 4]) {
        await playState(n);
        await sleep(700);
        const f = path.join(OUT, `${theme}-${w}-${n}deck.png`);
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
    const a0 = await ev(() => { const c = window.opendj.engine.ctx, s = c.playoutStats; return s ? { fallback: s.fallbackFramesEvents, fallbackSec: s.fallbackDuration } : null; });
    const r = await ev((secs) => new Promise((res) => {
      const frames = []; const longs = [];
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push(e.duration); });
      try { po.observe({ type: 'longtask', buffered: false }); } catch {}
      let last = performance.now(); const t0 = last;
      const tick = (now) => { frames.push(now - last); last = now; if (now - t0 < secs * 1000) requestAnimationFrame(tick); else { po.disconnect(); res({ frames, longs, wall: now - t0 }); } };
      requestAnimationFrame(tick);
    }), SECS);
    const m1 = await metric();
    const a1 = await ev(() => { const c = window.opendj.engine.ctx, s = c.playoutStats; return s ? { fallback: s.fallbackFramesEvents, fallbackSec: s.fallbackDuration } : null; });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const f = r.frames.slice(1).sort((a, b) => a - b);
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    const pct = (p) => f[Math.min(f.length - 1, Math.floor(f.length * p))];
    const d = (k) => ((m1[k] - m0[k]) * 1000 / (r.wall / 1000)); // ms per second of wall time
    const row = {
      decks: n, cpu: `${throttle}x`, fps: +(1000 / avg).toFixed(1), p50: +pct(0.5).toFixed(1), p95: +pct(0.95).toFixed(1), p99: +pct(0.99).toFixed(1),
      dropped: f.filter((x) => x > 1000 / 60 * 1.5).length, frames: f.length, longTasks: r.longs.length, longMs: Math.round(r.longs.reduce((a, b) => a + b, 0)),
      'script ms/s': +d('ScriptDuration').toFixed(0), 'style ms/s': +d('RecalcStyleDuration').toFixed(0), 'layout ms/s': +d('LayoutDuration').toFixed(0), 'task ms/s': +d('TaskDuration').toFixed(0),
      'audio glitches': a0 && a1 ? a1.fallback - a0.fallback : 'n/a',
      'layouts/s': +((m1.LayoutCount - m0.LayoutCount) / (r.wall / 1000)).toFixed(1), 'recalcs/s': +((m1.RecalcStyleCount - m0.RecalcStyleCount) / (r.wall / 1000)).toFixed(1),
    };
    results.push(row); console.log('[perf]', JSON.stringify(row));
  }
  console.table(results);
  fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify(results, null, 2));
}

await browser.close();
app.shutdown?.(); app.server.close();
process.exit(0);
