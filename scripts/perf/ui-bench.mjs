// UI audit + playback frame-rate benchmark. Starts OpenDJ on a throw-away data folder with the fictional demo
// library (scripts/demo/make-demo-library.mjs), loads and plays decks, then
//   * --shots: screenshots at 1920x1080 / 1366x768, 2 and 4 decks, a few themes  -> <out>/<theme>-<w>-<n>deck.png
//   * --perf:  frame times, dropped frames, long tasks and style/layout/script time while 2 (and 4) decks play,
//              at normal speed and with 4x CPU throttling (Chrome DevTools Protocol)
//
//   * --fx:    with --perf: heavy effects on every channel (reverb, flanger, phaser, trans, Space / Jet Color FX)
//              and the audio thread's load / glitch counters where the browser exposes them
//   * --latency: pointer-to-frame latency of the live controls, then the long tasks of a track load and of the
//              background analyser while a deck plays
//   * --analysis: only the last part: long tasks / dropped frames while a deck plays and the background analyser
//              re-analyses --tracks=N tracks (default 4), --rounds=N times; every long task's duration is listed
//   * --library: a 2,000-track library: frame times while scrolling the track list with a deck playing
//              (fails when the 95th-percentile frame is over 20 ms)
//   * --electron: run all of the above in the desktop app (Electron, Playwright _electron; use xvfb-run -a on Linux)
//
//   node scripts/perf/ui-bench.mjs [--shots] [--perf] [--fx] [--latency] [--analysis] [--electron] [--out=<dir>] [--themes=midnight,light,neon] [--secs=6]
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
const ELECTRON = argv.includes('--electron');
let app, browser, context, page, electronApp;
if (ELECTRON) {
  // the desktop app starts its own server (launch-token guarded) on the throw-away data folder
  const { _electron } = require('playwright');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  electronApp = await _electron.launch({ executablePath: require(path.join(root, 'node_modules/electron')), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', root], env: { ...process.env, OPENDJ_DATA: path.join(tmp, 'data') } });
  page = await electronApp.firstWindow();
  page.on('crash', () => console.error('[electron] renderer crashed'));
  electronApp.process().stderr.on('data', (d) => { if (process.env.VERBOSE) process.stderr.write(d); });
  context = electronApp.context();
  console.log('[electron]', await electronApp.evaluate(() => `Electron ${process.versions.electron}, Chrome ${process.versions.chrome}`));
} else {
  app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page = await context.newPage();
}
page.on('pageerror', (e) => console.error('[page error]', String(e)));
const ev = (fn, arg) => page.evaluate(fn, arg);
const sleep = (ms) => page.waitForTimeout(ms);

if (!ELECTRON) await page.goto(app.url);
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
// let the background analyser finish its first pass (the analysis measurement below re-analyses on purpose)
await page.waitForFunction(() => !window.opendj.analyser.running, null, { timeout: 180000 }).catch(() => console.warn('analyser still running'));
async function playState(n, layout = 'classic') {
  await ev(async ([n, layout, fx]) => {
    const a = window.opendj, E = a.engine;
    if (a.setLayout) { E.decks.forEach((d) => d.pause()); await a.setLayout(layout, false); }
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
  }, [n, layout, argv.includes('--fx')]);
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

// long tasks + frames while `src` (an async function, as source) runs in the page
const measure = (fn) => ev(async (src) => {
  const longs = []; const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push(e.duration); }); po.observe({ type: 'longtask' });
  const frames = []; let last = performance.now(), run = true; const tick = (t) => { frames.push(t - last); last = t; if (run) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  await (0, eval)(src)();
  run = false; po.disconnect();
  const f = frames.slice(1);
  return { longTasks: longs.length, longest: Math.round(Math.max(0, ...longs)), over50ms: longs.filter((x) => x > 50).length, durations: longs.map(Math.round), droppedFrames: f.filter((x) => x > 25).length, frames: f.length, worstFrame: Math.round(Math.max(...f)) };
}, fn);
const TRACKS_N = Number(opt('tracks', 4)), ROUNDS = Number(opt('rounds', 1));
const analysisRun = `async () => { const a = window.opendj; a.engine.decks[0].pause(); a.engine.decks[1].play(); let n = 0; const off = a.analyser.on('analysed', () => n++); const want = a.analyser.request([...a.library.tracks.values()].slice(0, ${TRACKS_N}), { force: true }); await new Promise((r) => setTimeout(r, 400)); for (let i = 0; i < 600 && (a.analyser.running || n < want); i++) await new Promise((r) => setTimeout(r, 100)); off(); window._analysed = n; }`;

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
  const load = await measure(`async () => { const a = window.opendj, E = a.engine; E.decks[1].play(); E.decks[0].pause(); const id = [...a.library.tracks.values()].find((t) => t.title === 'Glass Horizon').id; await a.loadTrack(0, id); await new Promise((r) => setTimeout(r, 500)); }`);
  console.log('[load] track load while a deck plays:', JSON.stringify(load));
}
if (argv.includes('--latency') || argv.includes('--analysis')) {
  await playState(2, LAYOUTS[0]);
  for (let k = 0; k < ROUNDS; k++) {
    const ana = { analysed: 0, ...(await measure(analysisRun)) }; ana.analysed = await ev(() => window._analysed);
    console.log(`[analysis] background analysis of ${TRACKS_N} tracks while a deck plays${ROUNDS > 1 ? ` (round ${k + 1})` : ''}:`, JSON.stringify(ana));
  }
}

if (argv.includes('--library')) {
  // 2,000 tiny tracks (0.25 s, 8 kHz mono WAV) without background analysis: only the list rendering is measured
  const big = path.join(tmp, 'Big Library'); fs.mkdirSync(big);
  const n = 2000, sr = 8000, len = sr / 4, hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + len * 2, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(len * 2, 40);
  const body = Buffer.alloc(len * 2);
  for (let k = 0; k < n; k++) fs.writeFileSync(path.join(big, `Artist ${k % 37} - Library Track ${k}.wav`), Buffer.concat([hdr, body]));
  await ev(() => window.opendj.setSetting('autoAnalyse', false));
  await ev((dir) => fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) }), big);
  await page.waitForFunction((k) => window.opendj.library.tracks.size >= k, TRACKS.length + n, { timeout: 180000 });
  await ev(() => window.opendj.analyser.cancel());
  await playState(2, LAYOUTS[0]);
  let worst = 0;
  for (const [name, step, count] of [['400 px steps', 400, 60], ['80 px per frame', 80, 120]]) {
    const r = await ev(async ([step, count]) => {
      const sc = document.querySelector('.lib-scroll'); sc.scrollTop = 0; await new Promise((res) => setTimeout(res, 300));
      const fr = []; let last = performance.now(), run = true; const f = (t) => { fr.push(t - last); last = t; if (run) requestAnimationFrame(f); }; requestAnimationFrame(f);
      for (let k = 0; k < count; k++) { sc.scrollTop += step; await new Promise((res) => requestAnimationFrame(res)); }
      run = false; fr.shift(); const s = [...fr].sort((a, b) => a - b);
      return { frames: fr.length, avg: +(fr.reduce((a, b) => a + b, 0) / fr.length).toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: +s.at(-1).toFixed(1), over20ms: fr.filter((x) => x > 20).length };
    }, [step, count]);
    worst = Math.max(worst, r.p95);
    console.log(`[library] scrolling ${n} tracks (${name}) while 2 decks play:`, JSON.stringify(r));
  }
  console.log(worst <= 20 ? '[library] ok: 95th-percentile frame <= 20 ms' : `[library] FAIL: 95th-percentile frame ${worst} ms > 20 ms`);
  if (worst > 20) process.exitCode = 1;
}

if (ELECTRON) await electronApp.close();
else { await browser.close(); app.shutdown?.(); app.server.close(); }
process.exit(0);
