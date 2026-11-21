// Frame pacing of the situations named in docs/CLAUDE_HANDOVER.md, with real (demo) audio playing:
//   startup      reload with a 2,000-track library, then start a deck straight away (first seconds of a session)
//   library      the full track list downloaded and re-rendered (library.refresh(), as after a scan or sync)
//   eq-drag      a mouse dragging channel 1's LOW EQ knob up and down
//   xfader       a mouse dragging the crossfader from end to end, at several window widths, 2 and 4 decks
// For each: frames, 50th / 95th / 99th-percentile and worst frame interval, frames over 33 ms, long tasks, and for
// the crossfader the travel reached (-1 .. 1) and the track width in pixels.
//
//   node scripts/perf/pacing.mjs [--electron] [--dpr=1.25] [--tracks=2000] [--json=<file>] [--strict]
//   xvfb-run -a node scripts/perf/pacing.mjs --electron
//
// The numbers depend on the machine and the GPU: headless Chromium in a container renders in software, so treat
// them as a regression baseline, not as a statement about a real Windows laptop. --strict fails (exit 1) when the
// 95th-percentile frame of any phase is over 50 ms or the crossfader does not reach both ends.
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
const ELECTRON = argv.includes('--electron');
const DPR = Number(opt('dpr', 1));
const N = Number(opt('tracks', 2000));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-pacing-'));
const demo = await makeDemoLibrary(path.join(os.tmpdir(), 'opendj-demo-library'));
const big = path.join(tmp, 'Big Library'); fs.mkdirSync(big);
{ // tiny silent WAVs: only the list size matters for the library phases
  const sr = 8000, len = sr / 4, hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + len * 2, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(len * 2, 40);
  const body = Buffer.concat([hdr, Buffer.alloc(len * 2)]);
  for (let k = 0; k < N; k++) fs.writeFileSync(path.join(big, `Artist ${k % 37} - Library Track ${k}.wav`), body);
}

let app, browser, page, electronApp;
const results = { env: {}, phases: [] };
if (ELECTRON) {
  const { _electron } = require('playwright');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  electronApp = await _electron.launch({ executablePath: require(path.join(root, 'node_modules/electron')), args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', ...(DPR !== 1 ? [`--force-device-scale-factor=${DPR}`] : []), root], env: { ...process.env, OPENDJ_DATA: path.join(tmp, 'data') } });
  page = await electronApp.firstWindow();
  results.env.runtime = await electronApp.evaluate(() => `Electron ${process.versions.electron}, Chrome ${process.versions.chrome}`);
} else {
  app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: DPR })).newPage();
  results.env.runtime = `Chromium ${browser.version()} (headless)`;
  await page.goto(app.url);
}
results.env.dpr = DPR; results.env.tracks = N + TRACKS.length; results.env.cpus = os.cpus().length;
page.on('pageerror', (e) => console.error('[page error]', String(e)));
const ev = (fn, arg) => page.evaluate(fn, arg);
const setSize = async (w, h) => {
  if (ELECTRON) await electronApp.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(400, 300); win.setContentSize(w, h); }, [w, h]);
  else await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(500);
};

// frame recorder: rAF intervals + long tasks between start() and stop()
const RECORDER = `(() => {
  if (window.__pace) return;
  const st = { fr: [], longs: [], run: false, last: 0 };
  try { new PerformanceObserver((l) => { if (st.run) for (const e of l.getEntries()) st.longs.push(e.duration); }).observe({ type: 'longtask', buffered: false }); } catch {}
  const f = (t) => { if (st.run) { if (st.last) st.fr.push(t - st.last); st.last = t; } requestAnimationFrame(f); };
  requestAnimationFrame(f);
  window.__pace = { start() { st.fr = []; st.longs = []; st.last = 0; st.run = true; }, stop() { st.run = false; return { fr: st.fr, longs: st.longs }; } };
})()`;
const summary = (name, { fr, longs }, extra = {}) => {
  const s = [...fr].sort((a, b) => a - b), q = (p) => +(s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0).toFixed(1);
  const r = { name, frames: fr.length, fps: +(1000 * fr.length / Math.max(1, fr.reduce((a, b) => a + b, 0))).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +(s.at(-1) || 0).toFixed(1), over33: fr.filter((x) => x > 33.4).length, longTasks: longs.length, longMs: Math.round(longs.reduce((a, b) => a + b, 0)), ...extra };
  results.phases.push(r);
  console.log(`[${name}]`, JSON.stringify(r));
  return r;
};

await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 60000 });
await ev(() => window.opendj.engine.resume());
await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
await ev(() => window.opendj.setSetting('autoAnalyse', false));
await ev(async (dirs) => { for (const d of dirs) await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: d }) }); }, [demo, big]);
await page.waitForFunction((k) => window.opendj.library.tracks.size >= k, TRACKS.length + N, { timeout: 300000 });
await ev(() => window.opendj.analyser?.cancel?.());

// ---- startup: reload with the big library, play a deck as soon as the app is ready ----
await page.addInitScript(RECORDER).catch(() => {});
await page.addInitScript('window.__paceAuto = true; addEventListener("DOMContentLoaded", () => window.__pace?.start());').catch(() => {});
const t0 = Date.now();
await page.reload();
await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 60000 });
const readyMs = Date.now() - t0;
await ev(RECORDER);
await ev(async () => {
  const a = window.opendj; await a.engine.resume();
  const t = [...a.library.tracks.values()].find((x) => x.title === 'Pressure Index');
  await a.loadTrack(0, t.id); a.engine.channels[0].set('volume', 0.9); a.engine.setCrossfader(-1); a.engine.decks[0].play();
  await new Promise((r) => setTimeout(r, 3000));
});
summary('startup', await ev(() => window.__pace.stop()), { readyMs, note: 'from DOMContentLoaded (browser) to 3 s after a deck started' });

// ---- library download with audio playing ----
await ev(() => window.__pace.start());
await ev(async () => { for (let k = 0; k < 3; k++) { await window.opendj.library.refresh(); await new Promise((r) => setTimeout(r, 300)); } });
summary('library', await ev(() => window.__pace.stop()), { refreshes: 3 });

// ---- EQ drag ----
const dragKnob = async (sel) => {
  const box = await page.locator(sel).first().boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let k = 0; k < 240; k++) { await page.mouse.move(x, y + 60 * Math.sin(k / 12)); }
  await page.mouse.up();
};
await ev(() => window.__pace.start());
const eq0 = await ev(() => window.opendj.engine.channels[0].state.eqLow);
await dragKnob('.strip[data-ch="0"] .knob[aria-label="LOW"]');
const eq1 = await ev(() => window.opendj.engine.channels[0].state.eqLow);
summary('eq-drag', await ev(() => window.__pace.stop()), { moved: eq0 !== eq1 });

// ---- crossfader travel, narrow mixer on wide windows ----
for (const [w, h, decks] of [[1920, 1080, 2], [2560, 1080, 2], [2560, 1080, 4], [3440, 1440, 4], [1280, 800, 4]]) {
  await setSize(w, h);
  await ev((n) => window.opendj.setDeckCount(n, false), decks);
  await page.waitForTimeout(400);
  const track = page.locator('.crossfader .fader-track').first();
  const box = await track.boundingBox();
  const mixerW = (await page.locator('.mixer').first().boundingBox())?.width || 0;
  const y = box.y + box.height / 2;
  await ev(() => window.opendj.engine.setCrossfader(0));
  await ev(() => window.__pace.start());
  let lo = 1, hi = -1;
  const thumb = await page.locator('.crossfader .fader-thumb').first().boundingBox();
  await page.mouse.move(thumb.x + thumb.width / 2, y); await page.mouse.down();
  for (let rep = 0; rep < 3; rep++) {
    for (let k = 0; k <= 60; k++) { await page.mouse.move(box.x - 20 + (box.width + 40) * (k / 60), y); }
    hi = Math.max(hi, await ev(() => window.opendj.engine.crossfader));
    for (let k = 60; k >= 0; k--) { await page.mouse.move(box.x - 20 + (box.width + 40) * (k / 60), y); }
    lo = Math.min(lo, await ev(() => window.opendj.engine.crossfader));
  }
  await page.mouse.up();
  summary(`xfader ${w}x${h} ${decks}d`, await ev(() => window.__pace.stop()), { trackPx: Math.round(box.width), mixerPx: Math.round(mixerW), travel: [+lo.toFixed(3), +hi.toFixed(3)] });
}

if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(results, null, 2));
let bad = 0;
for (const p of results.phases) {
  if (p.p95 > 50) { bad++; console.log(`[pacing] ${p.name}: 95th-percentile frame ${p.p95} ms > 50 ms`); }
  if (p.travel && (p.travel[0] > -0.99 || p.travel[1] < 0.99)) { bad++; console.log(`[pacing] ${p.name}: crossfader travel ${p.travel}`); }
}
console.log(bad ? `[pacing] ${bad} problem(s)` : '[pacing] all phases within limits');
await ev(() => window.opendj.engine.decks.forEach((d) => d.pause())).catch(() => {}); // else the desktop app asks before closing
if (ELECTRON) await electronApp.close();
else { await browser.close(); app.shutdown?.(); app.server.close(); }
process.exit(bad && argv.includes('--strict') ? 1 : 0);
