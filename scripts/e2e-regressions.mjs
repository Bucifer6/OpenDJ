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

  const timesAfterLegacyMarker = await page.evaluate(async () => {
    const app = window.opendj;
    const [first, second] = app.engine.decks;
    const phrases = second.track.phrases;
    second.track.phrases = [{ start: 0, end: 5 }];
    try {
      first.play();
      second.play();
      const times = () => app.deckEls.slice(0, 2).map((deck) => deck.querySelector('.deck-time').textContent);
      const before = times();
      await new Promise((resolve) => setTimeout(resolve, 650));
      return times().map((time, i) => time !== before[i]);
    } finally {
      first.pause();
      second.pause();
      second.track.phrases = phrases;
    }
  });
  check(timesAfterLegacyMarker.every(Boolean), 'both deck clocks advance with an incomplete legacy phrase marker');

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
    const a = window.opendj; a.engine.decks.forEach((d) => { d.pause(); d.eject(); });
    const bogus = { id: 'does-not-exist', title: 'Ghost' };
    try { await a.automix.start([bogus, a.library.track(short)]); } catch (e) { return { err: e.message }; }
    await new Promise((r) => setTimeout(r, 300));
    const r = { enabled: a.automix.enabled, playing: a.automix.current?.playing, title: a.automix.current?.track?.title };
    a.automix.stop(); return r;
  }, { short: ids.Short });
  check(am.enabled && am.playing && am.title === 'Short', `automix skips a track that fails to load (${JSON.stringify(am)})`);

  // stopping automix mid-transition leaves a clean mixer
  const stopMid = await page.evaluate(async ({ s, t }) => {
    const a = window.opendj; a.engine.decks.forEach((d) => { d.pause(); d.eject(); });
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

  // Faders and knobs stay inside their drawn bounds and range (user report: the tempo cap slid far past its track)
  await page.evaluate(async (id) => { await window.opendj.loadTrack(1, id); }, ids.Long);
  const setUi = (z, n) => page.evaluate(async ([z, n]) => { const { applyTheme } = await import('/js/ui/themes.js'); const a = window.opendj; a.engine.decks.forEach((d) => d.pause()); a.settings.uiScale = z; applyTheme(a.settings); a.setDeckCount(n, false); }, [z, n]);
  // every visible fader: is the cap inside the track, and does the drawn value match the engine?
  const faderState = () => page.evaluate(() => {
    const a = window.opendj, E = a.engine, out = [];
    for (const f of document.querySelectorAll('.fader')) {
      if (!f.offsetParent) continue;
      const tr = f.querySelector('.fader-track').getBoundingClientRect(), th = f.querySelector('.fader-thumb').getBoundingClientRect();
      if (!tr.width || !tr.height) continue;
      const inside = th.top >= tr.top - 0.6 && th.bottom <= tr.bottom + 0.6 && th.left >= tr.left - 0.6 && th.right <= tr.right + 0.6;
      const v = Number(f.getAttribute('aria-valuenow')), lo = Number(f.getAttribute('aria-valuemin')), hi = Number(f.getAttribute('aria-valuemax'));
      let engine = null, ok = v >= lo - 1e-6 && v <= hi + 1e-6;
      const deckEl = f.closest('.deck'), strip = f.closest('.strip');
      if (f.classList.contains('tempo-fader')) {
        const d = E.decks[deckEl.dataset.deck]; engine = d.tempo / d.tempoRange;
        const rate = d.rate / (1 + d.tempo / 100);
        const shown = parseFloat(deckEl.querySelector('.tempo-val').textContent);
        ok = ok && Math.abs(d.tempo) <= d.tempoRange + 1e-6 && Math.abs(rate - 1 - d.bend) < 1e-6 && (Date.now() - (window._lastTempoSet || 0) < 120 || Math.abs(shown - d.tempo) < 0.006);
      } else if (strip) engine = E.channels[strip.dataset.ch].state.volume;
      else if (f.classList.contains('crossfader')) engine = E.crossfader;
      if (engine != null) ok = ok && Math.abs(engine - v) < 1e-3;
      out.push({ cls: f.className.replace('fader ', ''), inside, ok, v, engine, th: [th.top | 0, th.bottom | 0, th.left | 0, th.right | 0], tr: [tr.top | 0, tr.bottom | 0, tr.left | 0, tr.right | 0] });
    }
    return out;
  });
  const knobState = () => page.evaluate(() => {
    const E = window.opendj.engine;
    const knobsOk = [...document.querySelectorAll('.knob')].filter((k) => k.offsetParent).every((k) => { const v = Number(k.getAttribute('aria-valuenow')); return v >= Number(k.getAttribute('aria-valuemin')) - 1e-6 && v <= Number(k.getAttribute('aria-valuemax')) + 1e-6; });
    const lim = { trim: [-1, 1], eqHigh: [-1, 1], eqMid: [-1, 1], eqLow: [-1, 1], filter: [-1, 1], volume: [0, 1], fxMix: [0, 1], fxParam: [0, 1], fxParam2: [0, 1], vocal: [0, 1], inst: [0, 1] };
    const engineOk = E.channels.every((c) => Object.entries(lim).every(([k, [lo, hi]]) => c.state[k] >= lo && c.state[k] <= hi)) && [E.masterVolume, E.cueMix, E.hpVolume].every((v) => v == null || (v >= 0 && v <= 1));
    return { knobsOk, engineOk };
  });
  const dragAll = async (sel, overshoot) => {
    const boxes = await page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent && e.getBoundingClientRect().width).map((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: e.closest('.fader-h') ? 1 : 0 }; }), sel);
    for (const b of boxes) for (const dir of [-1, 1]) {
      await page.mouse.move(b.x, b.y); await page.mouse.down();
      await page.mouse.move(b.x + (b.h ? dir * overshoot : 0), b.y + (b.h ? 0 : dir * overshoot), { steps: 6 });
      await page.mouse.up();
    }
    return boxes.length;
  };
  const bad = (list) => list.filter((x) => !x.inside || !x.ok);
  for (const [w, h, z, n] of [[1600, 960, 100, 2], [1366, 768, 100, 4], [1100, 700, 80, 2], [1920, 1080, 150, 4]]) {
    await page.setViewportSize({ width: w, height: h }); await setUi(z, n); await page.waitForTimeout(300);
    for (const r of [6, 16, 50]) {
      await page.evaluate((r) => window.opendj.engine.decks.forEach((d) => d.setTempoRange(r)), r);
      const nf = await dragAll('.fader-thumb', 2000);
      await page.waitForTimeout(150);
      const st = await faderState();
      check(nf > 0 && bad(st).length === 0, `${w}x${h} @${z}% ${n} decks ±${r}%: ${nf} fader caps dragged past both ends stay inside their tracks, values clamped and in sync${bad(st).length ? ' ' + JSON.stringify(bad(st)) : ''}`);
    }
    const nk = await dragAll('.knob', 3000);
    const ks = await knobState();
    check(nk > 0 && ks.knobsOk && ks.engineOk, `${w}x${h} @${z}%: ${nk} knobs dragged past both ends stay in range (${JSON.stringify(ks)})`);
  }
  // wheel, keyboard, MIDI and programmatic values (sync far away, range shrink) never push the tempo cap off its track
  await page.setViewportSize({ width: 1600, height: 960 }); await setUi(100, 2); await page.waitForTimeout(300);
  const tf = page.locator('.deck[data-deck="0"] .tempo-fader');
  await tf.hover(); for (let k = 0; k < 150; k++) await page.mouse.wheel(0, -120);
  await tf.focus(); for (let k = 0; k < 80; k++) await page.keyboard.press('ArrowDown');
  await page.evaluate(() => { const d = window.opendj.engine.decks[0]; d.setTempoFader(7); window.opendj.midi; for (let k = 0; k < 60; k++) d.stepTempo(0.5); });
  await page.waitForTimeout(150);
  let st = await faderState();
  check(bad(st).length === 0, `tempo fader after wheel/keys/MIDI overshoot stays inside and in range${bad(st).length ? ' ' + JSON.stringify(bad(st)) : ''}`);
  const prog = await page.evaluate(async () => {
    const [a, b] = window.opendj.engine.decks; a.setTempoRange(8); b.setTempoRange(8); a.resetTempo(); b.resetTempo();
    a.bpm = 124; b.bpm = 172; a.setMaster(); a.play(); b.play(); b.sync(); await new Promise((r) => setTimeout(r, 200));
    const synced = { tempo: b.tempo, range: b.tempoRange, sel: document.querySelector('.deck[data-deck="1"] .deck-tempo select').value };
    a.pause(); b.pause(); b.setTempoRange(50); b.setTempoFader(1); b.setTempoRange(6);
    return { synced, shrunk: { tempo: b.tempo, range: b.tempoRange } };
  });
  await page.waitForTimeout(150);
  st = await faderState();
  check(Math.abs(prog.synced.tempo) <= prog.synced.range && String(prog.synced.range) === prog.synced.sel && prog.shrunk.tempo === 6 && prog.shrunk.range === 6 && bad(st).length === 0,
    `sync to a far BPM widens the range instead of overshooting; shrinking the range clamps the tempo (${JSON.stringify(prog)})`);
  await page.evaluate(() => window.opendj.engine.decks.forEach((d) => { d.setTempoRange(8); d.resetTempo(); }));

  // QA final round: loops and loading (M2, m1, m5, m6)
  const loops = await page.evaluate(async ({ long, third }) => {
    const app = window.opendj, d = app.engine.decks[0];
    await app.loadTrack(0, third); d.setGrid(120, 0);
    const out = {};
    // M2: a ¼-beat loop pressed late in the beat starts on the ¼-beat grid that holds the play head (no jump back)
    d.seek(10.43); await new Promise((r) => setTimeout(r, 50)); const pos = d.position;
    d.autoLoop(0.25); out.quarter = { start: d.loop.start, end: d.loop.end, pos };
    // halving stops at 1/8 beat
    for (let k = 0; k < 6; k++) d.loopHalve(); out.minBeats = d.loopBeats;
    d.exitLoop();
    // m1: ½ / ×2 after the loop was exited change the auto-loop size, not the stored inactive loop
    const btns = [...document.querySelectorAll('.deck[data-deck="0"] .loop-row:not(.jump-row) .btn')];
    const half = btns.find((b) => b.textContent.trim() === '½'), size = document.querySelector('.deck[data-deck="0"] .loop-size');
    const before = size.textContent; half.click(); await new Promise((r) => setTimeout(r, 50)); out.halfAfterExit = { before, after: size.textContent, stored: d.loopBeats };
    // m6: a loop roll / slice keeps the user's stored inactive loop
    d.setLoop(4, 6); d.exitLoop(); d.play();
    d.rollOn(0.25); await new Promise((r) => setTimeout(r, 80)); d.rollOff();
    out.afterRoll = d.loop && { start: d.loop.start, end: d.loop.end, active: d.loop.active };
    d.sliceDown(2); await new Promise((r) => setTimeout(r, 80)); d.sliceUp();
    out.afterSlice = d.loop && { start: d.loop.start, end: d.loop.end, active: d.loop.active };
    d.pause(); d.loop = null;
    // m5: loop / hot cue / sync are ignored while the deck is still loading
    const p = app.loadTrack(0, long);
    await new Promise((r) => setTimeout(r, 30));
    out.loadingWas = d.loading; const cues0 = (d.track?.cues || []).length; d.autoLoop(4); d.hotCueDown(0); d.sync();
    out.whileLoading = { loop: d.loop, sync: d.syncOn, cues: (d.track?.cues || []).length - cues0 };
    await p; d.syncOn = false;
    return out;
  }, { long: ids.Long, third: ids.Third });
  const q = loops.quarter;
  check(Math.abs(q.end - q.start - 0.125) < 1e-6 && q.start <= q.pos + 1e-3 && q.pos < q.end + 0.02, `¼-beat loop pressed late in the beat contains the play head (${q.start.toFixed(3)}–${q.end.toFixed(3)} s, play head ${q.pos.toFixed(3)} s)`);
  check(loops.minBeats === 0.125, `loop ½ stops at 1/8 beat (${loops.minBeats})`);
  check(loops.halfAfterExit.after !== loops.halfAfterExit.before && loops.halfAfterExit.stored === loops.minBeats, `½ after exiting a loop changes the auto-loop size (${JSON.stringify(loops.halfAfterExit)})`);
  check(loops.afterRoll?.start === 4 && loops.afterRoll?.end === 6 && !loops.afterRoll.active, `a loop roll keeps the stored loop (${JSON.stringify(loops.afterRoll)})`);
  check(loops.afterSlice?.start === 4 && loops.afterSlice?.end === 6 && !loops.afterSlice.active, `the slicer keeps the stored loop (${JSON.stringify(loops.afterSlice)})`);
  check(loops.loadingWas && !loops.whileLoading.loop && !loops.whileLoading.sync && loops.whileLoading.cues === 0, `loop / hot cue / sync ignored while the deck loads (${JSON.stringify(loops.whileLoading)})`);

  // M5: scrolling a big list recycles row nodes (rows that stay in view are not rebuilt), positions them with
  // transform and keeps the column template on the container
  const lib = await page.evaluate(async () => {
    const L = window.opendj.library, base = L.rows[0];
    const saved = L.rows;
    L.rows = Array.from({ length: 2000 }, (_, i) => ({ ...base, id: `fake${i}`, title: `Row ${i}` }));
    L.renderRows(true);
    const sc = L.scroller; sc.scrollTop = 0; L.renderRows(true);
    const keep = L.rowsEl.querySelector('.lr[data-i="12"]');
    sc.scrollTop = 26 * 3; L.renderRows();
    const same = L.rowsEl.querySelector('.lr[data-i="12"]') === keep;
    sc.scrollTop = 26 * 1500; L.renderRows();
    const out = { same, count: L.rowsEl.children.length, transform: !!L.rowsEl.querySelector('.lr').style.transform, rowTpl: L.rowsEl.querySelector('.lr').style.gridTemplateColumns, varTpl: L.rowsEl.style.getPropertyValue('--lib-cols') };
    L.rows = saved; sc.scrollTop = 0; L.renderRows(true);
    return out;
  });
  check(lib.same && lib.count < 80 && lib.transform && !lib.rowTpl && !!lib.varTpl, `library rows are recycled while scrolling (${JSON.stringify(lib)})`);

  // m3: the Echo Out pad gives the user's beat FX settings back after the tail
  const eo = await page.evaluate(async (id) => {
    const app = window.opendj, d = app.engine.decks[0], ch = app.engine.channels[0];
    await app.loadTrack(0, id); d.setGrid(240, 0); d.play();
    ch.set('fxType', 'flanger'); ch.set('fxMix', 0.3); ch.set('fxParam', 0.4); ch.set('fxBeats', 1);
    app.padFx(d, 'echoOut', true);
    const during = ch.state.fxType;
    await new Promise((r) => setTimeout(r, d.beatLen * 8000 + 400));
    return { during, after: { fxType: ch.state.fxType, fxMix: ch.state.fxMix, fxParam: ch.state.fxParam, fxBeats: ch.state.fxBeats, fxOn: ch.state.fxOn } };
  }, ids.Third);
  check(eo.during === 'echo' && eo.after.fxType === 'flanger' && eo.after.fxMix === 0.3 && eo.after.fxParam === 0.4 && eo.after.fxBeats === 1 && !eo.after.fxOn, `Echo Out pad restores the beat FX afterwards (${JSON.stringify(eo)})`);

  // m4: a deck load reports its progress (Loading x % / Decoding / Analysing) under the title
  const prog2 = await page.evaluate(async (id) => {
    const app = window.opendj, d = app.engine.decks[1], seen = [], notes = new Set();
    const off = d.on('load-progress', (p) => { seen.push(`${p.name}${p.pct != null ? ':' + p.pct : ''}`); notes.add(document.querySelector('.deck[data-deck="1"] .deck-load-note').textContent); });
    const t = app.library.track(id); const r = await fetch(`/api/tracks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ analyzed: false }) }).then((x) => x.json()); app.library.updateTrack(r);
    await app.loadTrack(1, id); off();
    return { phases: [...new Set(seen.map((x) => x.split(':')[0]))], pcts: seen.filter((x) => x.startsWith('Loading:')).length, notes: [...notes].slice(0, 4), after: document.querySelector('.deck[data-deck="1"] .deck-load-note').textContent };
  }, ids.Long);
  check(['Loading', 'Decoding', 'Analysing'].every((p) => prog2.phases.includes(p)) && prog2.pcts >= 2 && prog2.after === '', `deck load shows its progress (${JSON.stringify(prog2)})`);

  // ---- AI assistant remote control (MCP) driving the live page: off by default, then token + scopes ----
  const MCP_PORT = 7915;
  const before = await page.evaluate(async () => (await fetch('/api/mcp/config')).json());
  check(!before.enabled && before.host === '127.0.0.1', 'remote control is off by default, loopback when on');
  const on = await page.evaluate(async (port) => (await fetch('/api/mcp/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, port, scopes: ['read', 'playback'] }) })).json(), MCP_PORT);
  let sid = null, rid = 0;
  const rpc = async (method, params) => {
    const r = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${on.token}`, ...(sid ? { 'Mcp-Session-Id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) });
    sid = r.headers.get('mcp-session-id') || sid;
    return r.json();
  };
  const tool = async (name, args = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return r.result?.isError ? { error: r.result.content[0].text } : r.result?.structuredContent ?? r.error; };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e' } });
  await page.evaluate(() => { const E = window.opendj.engine; E.decks.forEach((d) => d.pause()); });
  const found = await tool('search_library', { query: 'third' });
  check(found.total === 1 && found.tracks[0].title === 'Third' && !JSON.stringify(found).includes(music), `search_library finds metadata only (${JSON.stringify(found.tracks[0])})`);
  const loaded = await tool('load_track', { deck: 1, track_id: found.tracks[0].id });
  check(loaded.title === 'Third' && (await page.evaluate(() => window.opendj.engine.decks[0].track?.title)) === 'Third', 'load_track loads deck 1 in the open window');
  await tool('play', { deck: 1 }); await tool('set_crossfader', { position: -0.5 });
  const mst = await tool('get_status');
  check(mst.decks[0].playing && mst.decks[0].title === 'Third' && mst.crossfader === -0.5 && mst.broadcast && Array.isArray(mst.sampler), `play / set_crossfader / get_status (${JSON.stringify(mst.decks[0])})`);
  const sample = await tool('trigger_sample', { pad: 1 });
  check(sample.name === 'Air Horn', 'trigger_sample fires pad 1');
  const ded = await tool('queue_dedication', { text: 'For Ana and Mihai', language: 'en', show_on_screen: true, stream_metadata: false });
  check(ded.queued && (await page.evaluate(() => window.opendj.dedications.queue.length)) >= 1, 'queue_dedication queues it in the window');
  await page.evaluate(() => window.opendj.dedications.clear());
  const deny = await tool('broadcast_start', { target_id: 'abc' });
  check(deny?.code === -32602, 'broadcast tools refused without the broadcast permission');
  const notice = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
  check(/AI assistant: play/.test(notice), `the window shows a notice for each action (${notice.slice(0, 120)})`);
  await tool('pause', { deck: 1 });
  const audit = await page.evaluate(async () => (await fetch('/api/mcp/audit')).json());
  check(audit.entries.some((e) => e.tool === 'load_track' && e.ok) && audit.entries.some((e) => e.tool === 'broadcast_start' && !e.ok), `audit log lists the actions (${audit.entries.length} entries)`);
  await page.evaluate(() => fetch('/api/mcp/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }));

  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} catch (e) { console.error(e); failed = true; }
await browser.close(); app.server.close();
console.log(failed ? '\nREGRESSIONS FAILED' : '\nREGRESSIONS PASSED');
process.exit(failed ? 1 : 0);
