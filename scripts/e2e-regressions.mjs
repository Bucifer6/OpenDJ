// Regression checks for bugs found in QA (stale loads, stuck scratch, play counting, bad BPM, shortcuts behind
// dialogs, automix failure handling). Usage: node scripts/e2e-regressions.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-reg-'));
const music = path.join(tmp, 'Music'); fs.mkdirSync(music);
function wav(file, seconds, bpm) {
  const sr = 22050, n = sr * seconds, d = Buffer.alloc(44 + n * 4);
  d.write('RIFF', 0); d.writeUInt32LE(36 + n * 4, 4); d.write('WAVEfmt ', 8); d.writeUInt32LE(16, 16); d.writeUInt16LE(1, 20); d.writeUInt16LE(2, 22);
  d.writeUInt32LE(sr, 24); d.writeUInt32LE(sr * 4, 28); d.writeUInt16LE(4, 32); d.writeUInt16LE(16, 34); d.write('data', 36); d.writeUInt32LE(n * 4, 40);
  const b = 60 / bpm;
  for (let i = 0; i < n; i++) { const t = i / sr, tb = (t - 0.1 + b * 100) % b; const v = (t > 0.1 && tb < 0.15 ? 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb * 40)) * tb) * Math.exp(-tb * 18) : 0) + 0.1 * Math.sin(2 * Math.PI * 220 * t); const s = Math.round(v * 0.7 * 32767); d.writeInt16LE(s, 44 + i * 4); d.writeInt16LE(s, 46 + i * 4); }
  fs.writeFileSync(file, d);
}
wav(path.join(music, 'R - Long.wav'), 240, 124);
wav(path.join(music, 'R - Short.wav'), 20, 128);
wav(path.join(music, 'R - Third.wav'), 30, 126);

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
let failed = false;
const check = (c, msg) => { console.log(`${c ? 'ok' : 'FAIL'} - ${msg}`); if (!c) failed = true; };
try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 20000 });
  await page.evaluate((d) => fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: d }) }), music);
  await page.waitForFunction(() => window.opendj.library.tracks.size === 3, null, { timeout: 20000 });
  const ids = await page.evaluate(() => Object.fromEntries([...window.opendj.library.tracks.values()].map((t) => [t.title, t.id])));

  // pre-analyse the short track so it loads fast, then race a slow load against it
  await page.evaluate(async (id) => { await window.opendj.loadTrack(1, id); }, ids.Short);
  const race = await page.evaluate(async ({ long, short }) => {
    const a = window.opendj, d = a.engine.decks[0];
    const p1 = d.load({ ...a.library.track(long) }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    await d.load({ ...a.library.track(short) });
    await p1; await new Promise((r) => setTimeout(r, 300));
    return { title: d.track?.title, duration: Math.round(d.duration), bpm: d.bpm };
  }, { long: ids.Long, short: ids.Short });
  check(race.title === 'Short' && race.duration === 20 && race.bpm === 128, `a superseded load can't overwrite the newer track (${JSON.stringify(race)})`);

  // play counting for every track, not just the first one on a deck
  const plays = await page.evaluate(async ({ a, b }) => {
    const app = window.opendj, d = app.engine.decks[0]; let n = 0;
    const orig = window.fetch; window.fetch = (u, o) => { if (String(u).includes('/api/tracks/played')) n++; return orig(u, o); };
    await app.loadTrack(0, a); d.play(); await new Promise((r) => setTimeout(r, 200)); d.pause();
    await app.loadTrack(0, b); d.play(); await new Promise((r) => setTimeout(r, 200)); d.pause();
    window.fetch = orig; return n;
  }, { a: ids.Short, b: ids.Third });
  check(plays === 2, `every played track is counted (${plays} play events)`);

  // deck stopping mid-scratch must not leave it stuck
  const scratch = await page.evaluate(async () => {
    const d = window.opendj.engine.decks[0]; const c = document.querySelectorAll('.wf-detail')[0];
    d.seek(2); d.play(); await new Promise((r) => setTimeout(r, 200));
    const r = c.getBoundingClientRect(), y = r.top + r.height / 2;
    c.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 300, clientY: y, pointerId: 1, bubbles: true }));
    c.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 320, clientY: y, pointerId: 1, bubbles: true }));
    d.pause();
    c.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 320, clientY: y, pointerId: 1, bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const p0 = d.position; d.play(); await new Promise((r) => setTimeout(r, 500)); const moved = d.position - p0; d.pause();
    return { scratching: d.scratching, moved };
  });
  check(!scratch.scratching && scratch.moved > 0.3, `deck plays again after stopping mid-scratch (moved ${scratch.moved.toFixed(2)}s)`);

  // invalid BPM from the grid editor must be rejected (no infinite draw loop)
  const bpm = await page.evaluate(async () => { const d = window.opendj.engine.decks[0]; const before = d.bpm; const r = d.setGrid(-120, d.gridOffset); await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))); return { r, bpm: d.bpm, before }; });
  check(bpm.r === false && bpm.bpm === bpm.before, 'negative BPM rejected, UI keeps rendering');

  // shortcuts don't fire behind an open dialog
  await page.evaluate(() => { window.opendj.dialogs.confirm('test'); });
  await page.waitForSelector('.overlay');
  await page.keyboard.press('x'); await page.keyboard.press('r');
  const behind = await page.evaluate(() => ({ playing: window.opendj.engine.decks[0].playing, rec: window.opendj.engine.recording }));
  check(!behind.playing && !behind.rec, 'shortcuts are ignored while a dialog is open');
  // Escape closes only the top dialog
  await page.evaluate(() => { window.opendj.dialogs.confirm('second'); });
  await page.waitForFunction(() => document.querySelectorAll('.overlay').length === 2);
  await page.keyboard.press('Escape');
  const left = await page.evaluate(() => document.querySelectorAll('.overlay').length);
  check(left === 1, `Escape closes only the top-most dialog (${left} left)`);
  await page.keyboard.press('Escape');

  // automix: first track missing -> skips it instead of hanging "on"
  const am = await page.evaluate(async ({ short }) => {
    const a = window.opendj; a.engine.decks.forEach((d) => d.pause());
    const bogus = { id: 'does-not-exist', title: 'Ghost' };
    try { await a.automix.start([bogus, a.library.track(short)]); } catch (e) { return { err: e.message }; }
    await new Promise((r) => setTimeout(r, 300));
    const r = { enabled: a.automix.enabled, playing: a.automix.current?.playing, title: a.automix.current?.track?.title };
    a.automix.stop(); return r;
  }, { short: ids.Short });
  check(am.enabled && am.playing && am.title === 'Short', `automix skips a track that fails to load (${JSON.stringify(am)})`);

  // stopping automix mid-transition leaves a clean mixer
  const stopMid = await page.evaluate(async ({ s, t }) => {
    const a = window.opendj; a.engine.decks.forEach((d) => d.pause());
    await a.setSetting('automix', { ...a.settings.automix, transitionBeats: 16, style: 'eqswap' });
    await a.automix.start([a.library.track(s), a.library.track(t)]);
    await new Promise((r) => setTimeout(r, 1500));
    a.automix.skip(); await new Promise((r) => setTimeout(r, 700)); a.automix.stop();
    const [d1, d2] = a.engine.decks, [c1, c2] = a.engine.channels;
    const r = { playing: [d1.playing, d2.playing], ch: [c1.state, c2.state].map((x) => ({ v: x.volume, low: x.eqLow })) };
    d1.pause(); d2.pause(); return r;
  }, { s: ids.Short, t: ids.Third });
  const oneDeck = stopMid.playing.filter(Boolean).length === 1;
  const clean = stopMid.ch.every((c) => c.low === 0 && c.v >= 0.79);
  check(oneDeck && clean, `stopping automix mid-transition leaves one deck playing and EQs reset (${JSON.stringify(stopMid)})`);

  // ---- pre-release QA pass ----
  await page.evaluate(() => { const a = window.opendj; a.automix.stop?.(); a.engine.decks.forEach((d) => d.pause()); });
  // M1: playlists show in their own order with a # column, and can be reordered by dragging
  const order = [ids.Third, ids.Long, ids.Short];
  const pl = await page.evaluate((o) => fetch('/api/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'QA order', trackIds: o }) }).then((r) => r.json()), order);
  await page.evaluate(async (id) => { const L = window.opendj.library; await L.refresh(); await L.setView({ kind: 'playlist', id }, 'QA order'); }, pl.id);
  await page.waitForTimeout(300);
  const shown = await page.evaluate(() => ({ ids: window.opendj.library.rows.map((t) => t.id), hash: [...document.querySelectorAll('.lib-header .lh')][0]?.textContent }));
  check(JSON.stringify(shown.ids) === JSON.stringify(order) && /#/.test(shown.hash), `a playlist opens in its own order with a # column (${JSON.stringify(shown)})`);
  await page.locator('.lr').nth(2).dragTo(page.locator('.lr').nth(0), { targetPosition: { x: 200, y: 3 } });
  await page.waitForTimeout(600);
  const after = await page.evaluate((id) => window.opendj.library.playlists.find((p) => p.id === id).trackIds, pl.id);
  check(JSON.stringify(after) === JSON.stringify([ids.Short, ids.Third, ids.Long]), `dragging a row reorders the playlist (${JSON.stringify(after)})`);
  await page.evaluate(() => window.opendj.library.setView({ kind: 'all' }, 'Collection'));
  await page.waitForTimeout(300);
  // M6: Esc closes a dialog opened from a context-menu item (the menu's Esc listener used to leak)
  await page.locator('.lr').nth(0).click({ button: 'right' });
  await page.locator('.ctx-item', { hasText: /Edit track info/ }).click();
  await page.waitForTimeout(300); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  check(!(await page.evaluate(() => !!document.querySelector('.overlay'))), 'the first Esc closes a dialog opened from a context menu');
  // M2: the context menu opens at the pointer under Interface size 150 %
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(async () => { const { applyTheme } = await import('/js/ui/themes.js'); await window.opendj.setSetting('uiScale', 150); applyTheme(window.opendj.settings); });
  await page.waitForTimeout(400);
  const rb = await page.locator('.lr').nth(1).boundingBox();
  const cx = Math.round(rb.x + 150), cy = Math.round(rb.y + rb.height / 2);
  await page.mouse.click(cx, cy, { button: 'right' }); await page.waitForTimeout(200);
  const mr = await page.evaluate(() => { const r = document.querySelector('.ctx-menu').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; });
  check(Math.abs(mr.l - cx) < 4 && mr.b <= 1080 && mr.r <= 1920 && mr.t >= 0, `context menu at the pointer and on screen at 150 % (${cx},${cy} -> ${JSON.stringify(mr)})`);
  await page.keyboard.press('Escape');
  await page.evaluate(async () => { const { applyTheme } = await import('/js/ui/themes.js'); await window.opendj.setSetting('uiScale', 100); applyTheme(window.opendj.settings); });
  // m5: key:<unknown> matches nothing
  const keyless = await page.evaluate(async () => { const L = window.opendj.library; L.query = 'key:xyz'; L.applyView(); const n = L.rows.length; L.query = ''; L.applyView(); return n; });
  check(keyless === 0, `search key:xyz matches nothing (${keyless})`);
  // M5 / M4: all 8 hot-cue pads visible and the 4-deck master column unclipped on short screens
  await page.evaluate(async (id) => { await window.opendj.loadTrack(0, id); }, ids.Third);
  for (const [w, h] of [[1280, 800], [1600, 900], [1366, 768]]) {
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(400);
    const vis = await page.evaluate(() => { const dk = document.querySelector('.deck'), mid = dk.querySelector('.deck-mid').getBoundingClientRect(); return [...dk.querySelectorAll('.pad')].filter((p) => { const r = p.getBoundingClientRect(); return r.height > 0 && r.bottom <= mid.bottom + 1; }).length; });
    check(vis === 8, `2 decks at ${w}x${h}: all 8 hot-cue pads visible (${vis})`);
  }
  await page.evaluate(() => window.opendj.setDeckCount(4, false)); await page.setViewportSize({ width: 1280, height: 800 }); await page.waitForTimeout(400);
  const clip = await page.evaluate(() => { const m = document.querySelector('.mixer-master'), r = m.getBoundingClientRect(); return [...m.querySelectorAll('.knob-wrap, .btn')].filter((e) => { const x = e.getBoundingClientRect(); return x.width && (x.right > r.right + 1 || x.left < r.left - 1); }).length; });
  check(clip === 0, `4 decks at 1280x800: nothing clipped in the MASTER column (${clip})`);
  await page.evaluate(() => window.opendj.setDeckCount(2, false)); await page.setViewportSize({ width: 1600, height: 960 });
  // m1: the loop size label is a clean number
  const lbl = await page.evaluate(async () => { const d = window.opendj.engine.decks[0]; d.autoLoop(4); await new Promise((r) => setTimeout(r, 100)); const t = document.querySelector('.loop-size').textContent; d.exitLoop(); return t; });
  check(lbl === '4', `loop size label reads "4" (${lbl})`);

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} catch (e) { console.error(e); failed = true; }
await browser.close(); app.server.close();
console.log(failed ? '\nREGRESSIONS FAILED' : '\nREGRESSIONS PASSED');
process.exit(failed ? 1 : 0);
