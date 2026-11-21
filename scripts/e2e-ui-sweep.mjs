// UI sweep: every layout mode x theme x interface size x window size. Fails on any page error, console error or
// unhandled rejection, on interactive controls that overlap each other, stick out of their panel (outside a scroll
// area), are covered by something else where you would click them, or on fader caps outside their tracks.
// Then clicks every deck / mixer / panel control, switches every panel and mode, opens the dialogs and presses the
// keyboard shortcuts in each layout.   Usage: node scripts/e2e-ui-sweep.mjs [--quick] [--skins]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const QUICK = process.argv.includes('--quick');
const SKINS_ONLY = process.argv.includes('--skins'); // only the controller skins (section 5)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-sweep-'));
const music = path.join(tmp, 'Music'); fs.mkdirSync(music);
function wav(file, seconds, bpm, f0) {
  const sr = 22050, n = sr * seconds, d = Buffer.alloc(44 + n * 4);
  d.write('RIFF', 0); d.writeUInt32LE(36 + n * 4, 4); d.write('WAVEfmt ', 8); d.writeUInt32LE(16, 16); d.writeUInt16LE(1, 20); d.writeUInt16LE(2, 22);
  d.writeUInt32LE(sr, 24); d.writeUInt32LE(sr * 4, 28); d.writeUInt16LE(4, 32); d.writeUInt16LE(16, 34); d.write('data', 36); d.writeUInt32LE(n * 4, 40);
  const b = 60 / bpm;
  for (let i = 0; i < n; i++) { const t = i / sr, tb = (t - 0.1 + b * 100) % b; const v = (t > 0.1 && tb < 0.15 ? 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb * 40)) * tb) * Math.exp(-tb * 18) : 0) + 0.12 * Math.sin(2 * Math.PI * f0 * t) + 0.05 * Math.sin(2 * Math.PI * f0 * 4.02 * t); const s = Math.round(v * 0.7 * 32767); d.writeInt16LE(s, 44 + i * 4); d.writeInt16LE(s, 46 + i * 4); }
  fs.writeFileSync(file, d);
}
wav(path.join(music, 'Sweep - One.wav'), 60, 124, 220);
wav(path.join(music, 'Sweep - Two.wav'), 60, 126, 247);
wav(path.join(music, 'Sweep - Three.wav'), 45, 128, 196);
wav(path.join(music, 'Sweep - Four.wav'), 45, 122, 262);

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource.*(cover|404)/i.test(m.text())) errors.push(`console: ${m.text()}`); });
let failed = false, checks = 0;
const check = (c, msg) => { checks++; if (!c || process.env.VERBOSE) console.log(`${c ? 'ok' : 'FAIL'} - ${msg}`); if (!c) failed = true; };
const ev = (fn, arg) => page.evaluate(fn, arg);

// Geometry audit run in the page: overlapping / escaping / covered controls and fader caps outside their tracks.
const audit = () => ev(() => {
  const REGIONS = '.topbar, .deck, .mixer, .sampler-bar, .lib-tools, .lib-chips, .waves';
  const CONTROLS = '.btn, .knob, .pad, .panel-tab, .seg-btn, .pad-mode, .chip, .spad, .fader-track, select, input.lib-search, .jog';
  const vis = (e) => { if (!e.offsetParent && getComputedStyle(e).position !== 'fixed') return false; const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(e).visibility !== 'hidden'; };
  const scrollParent = (e, stop) => { for (let p = e.parentElement; p && p !== stop; p = p.parentElement) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowY + s.overflowX) && (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)) return p; } return null; };
  const name = (e) => `${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 3).join('.')}${e.textContent?.trim() ? `"${e.textContent.trim().slice(0, 14)}"` : ''}${e.closest('[data-deck]') ? `@deck${+e.closest('[data-deck]').dataset.deck + 1}` : ''}`;
  const out = { overlap: [], escape: [], covered: [], fader: [], count: 0 };
  for (const region of document.querySelectorAll(REGIONS)) {
    if (!vis(region)) continue;
    const rr = region.getBoundingClientRect();
    const els = [...region.querySelectorAll(CONTROLS)].filter(vis).filter((e) => !e.parentElement.closest('.btn, .knob, .pad, .fader-track, .chip'));
    out.count += els.length;
    const rects = els.map((e) => ({ e, r: e.getBoundingClientRect(), sp: scrollParent(e, region) }));
    for (const { e, r, sp } of rects) {
      if (sp) { const s = sp.getBoundingClientRect(); if (r.bottom < s.top || r.top > s.bottom || r.right < s.left || r.left > s.right) continue; } // scrolled out: reachable by scrolling
      else if (r.left < rr.left - 1 || r.right > rr.right + 1 || r.top < rr.top - 1 || r.bottom > rr.bottom + 1) out.escape.push(name(e));
      // covered: what is under the centre of the control where a click lands?
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2; // (no clamping to innerWidth: under CSS zoom it is in another unit)
      // CSS zoom (interface size): rect and hit-test coordinates can differ by the zoom factor, so try both spaces
      const z = parseFloat(document.documentElement.style.zoom) || 1;
      const hits = [[cx, cy], [cx * z, cy * z], [cx / z, cy / z]].map(([x, y]) => document.elementFromPoint(x, y));
      const hit = hits.find((x) => x && (x === e || e.contains(x) || x.contains(e))) || hits[0];
      if (hit && hit !== e && !e.contains(hit) && !hit.contains(e)) {
        const inView = !sp || (() => { const s = sp.getBoundingClientRect(); return cy >= s.top && cy <= s.bottom; })();
        if (inView && !hit.closest('.toast, .toasts')) out.covered.push(`${name(e)} under ${name(hit)}`);
      }
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 1.5 && h > 1.5) out.overlap.push(`${name(a.e)} x ${name(b.e)} (${w.toFixed(0)}x${h.toFixed(0)})`);
    }
  }
  for (const f of document.querySelectorAll('.fader')) {
    if (!vis(f)) continue;
    const t = f.querySelector('.fader-track').getBoundingClientRect(), c = f.querySelector('.fader-thumb').getBoundingClientRect();
    if (c.top < t.top - 0.6 || c.bottom > t.bottom + 0.6 || c.left < t.left - 0.6 || c.right > t.right + 0.6) out.fader.push(name(f));
  }
  return out;
});
// Fit check, in layout units (no zoom ambiguity): the deck row, top bar, mixer and sampler bar stay inside the window,
// the top bar is not clipped, and each visible deck's control column shows the chosen panel without scrolling.
// (A cut-off panel row used to pass the audit above: .deck-mid is a scroll area, so controls below its edge
// counted as "reachable by scrolling" — e.g. the right deck's FX row at 1600x960, or the whole right deck when the
// top bar's min-content pushed the page wider than the window.)
const fit = (panels) => ev(async (panels) => {
  const out = [];
  const vis = (e) => e && e.offsetParent && e.getBoundingClientRect().width > 1;
  const decks = () => [...document.querySelectorAll('.deck')].filter(vis);
  for (const panel of panels) {
    // open the panel with its tab on every visible deck, as a user would (falls back to the API when the tab is hidden)
    for (const d of decks()) { const t = d.querySelector(`.panel-tab[data-panel="${panel}"]`); if (t && vis(t)) t.click(); else window.opendj.engine.decks[+d.dataset.deck].showPanel?.(panel); }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    for (const sel of ['.topbar', '.deck-area', '.mixer', '.sampler-bar']) { const e = document.querySelector(sel); if (!vis(e)) continue; const r = e.getBoundingClientRect(); if (r.right > innerWidth + 1 || r.left < -1) out.push(`${sel} outside the window (${Math.round(r.right)} > ${innerWidth})`); }
    const tb = document.querySelector('.topbar'); if (tb.scrollWidth > tb.clientWidth + 1) out.push(`top bar clipped by ${tb.scrollWidth - tb.clientWidth}px`);
    const appEl = document.getElementById('app'), z = parseFloat(document.documentElement.style.zoom) || 1;
    if (appEl.scrollWidth > innerWidth / z + 1) out.push(`page ${appEl.scrollWidth}px wide in a ${Math.round(innerWidth / z)}px window`);
    // top bar items (buttons, automix info, clock...) never overlap each other or leave the bar
    const items = [...tb.querySelectorAll(':scope > *, :scope > .tb-group > *')].filter((e) => !e.matches('.tb-group, .tb-spacer') && vis(e) && e.getBoundingClientRect().width > 2);
    const tr = tb.getBoundingClientRect();
    for (let i = 0; i < items.length; i++) {
      const a = items[i].getBoundingClientRect();
      if (a.right > tr.right + 1) out.push(`top bar: ${items[i].className || items[i].tagName} outside the bar`);
      for (let j = i + 1; j < items.length; j++) { const b = items[j].getBoundingClientRect(); if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) out.push(`top bar: ${items[i].className} overlaps ${items[j].className}`); }
    }
    for (const d of decks()) {
      const n = `${panel}@deck${+d.dataset.deck + 1}`, mid = d.querySelector('.deck-mid');
      if (d.getBoundingClientRect().right > innerWidth + 1) out.push(`deck${+d.dataset.deck + 1} outside the window`);
      if (mid.scrollHeight > mid.clientHeight + 1) out.push(`${n} cut off by ${mid.scrollHeight - mid.clientHeight}px`);
      if (mid.scrollWidth > mid.clientWidth + 1) out.push(`${n} ${mid.scrollWidth - mid.clientWidth}px too wide`);
      if (d.scrollHeight > d.clientHeight + 1) out.push(`${n}: deck content ${d.scrollHeight - d.clientHeight}px taller than the deck`);
      for (const b of d.querySelectorAll('.btn')) if (vis(b) && b.querySelector('.lbl-dual') && b.scrollWidth > b.clientWidth + 1) out.push(`${n}: label "${b.textContent.trim()}" clipped`);
      for (const p of d.querySelectorAll('.deck-panel')) if (vis(p) && p.scrollHeight > p.clientHeight + 1) out.push(`${n}: the ${p.dataset.panel} panel's content spills ${p.scrollHeight - p.clientHeight}px out of it`);
    }
  }
  return [...new Set(out)];
}, panels);
const PANELS = ['cues', 'loops', 'fx', 'stems', 'key'];
const summary = (a) => [a.overlap.length && `overlap ${a.overlap.slice(0, 4).join('; ')}`, a.escape.length && `outside ${a.escape.slice(0, 4).join('; ')}`, a.covered.length && `covered ${a.covered.slice(0, 4).join('; ')}`, a.fader.length && `fader ${a.fader.join('; ')}`].filter(Boolean).join(' | ');

const setUi = (o) => ev(async ({ layout, theme, zoom }) => {
  const a = window.opendj, { applyTheme } = await import('/js/ui/themes.js');
  a.engine.decks.forEach((d) => d.pause());
  if (layout === 'four') await a.setDeckCount(4, false); else await a.setLayout(layout, false);
  a.settings.theme = theme; a.settings.uiScale = zoom; applyTheme(a.settings);
}, o);

try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
  await ev(() => window.opendj.engine.resume());
  await ev((d) => fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: d }) }), music);
  await page.waitForFunction(() => window.opendj.library.tracks.size === 4, null, { timeout: 30000 });
  const ids = await ev(() => [...window.opendj.library.tracks.values()].sort((a, b) => a.title.localeCompare(b.title)).map((t) => t.id));
  for (let i = 0; i < 4; i++) { await ev(([i, id]) => window.opendj.loadTrack(i, id), [i, ids[i]]); await page.waitForFunction((i) => !!window.opendj.engine.decks[i].waveform, i, { timeout: 30000 }); }
  await page.waitForFunction(() => !window.opendj.analyser.running, null, { timeout: 60000 }).catch(() => {});
  await ev(() => window.opendj.engine.decks.forEach((d) => d.addMemoryCue?.()));

  if (!SKINS_ONLY) { // --skins: only section 5
  // ---------- 1. geometry across the matrix ----------
  const layouts = ['classic', 'performance', 'waveform', 'four'];
  const themes = QUICK ? ['midnight'] : ['midnight', 'light', 'contrast'];
  const zooms = QUICK ? [100] : [80, 100, 150];
  // the common laptop / desktop sizes: 1600x960 is the desktop app's default window, 1440x900 a 15" laptop
  const sizes = [[1920, 1080], [1600, 960], [1440, 900], [1366, 768], [1280, 800]];
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    for (const layout of layouts) for (const theme of themes) for (const zoom of zooms) {
      if (theme !== 'midnight' && zoom !== 100) continue; // themes don't change geometry: check them at 100 %
      await setUi({ layout, theme, zoom });
      await page.waitForTimeout(160);
      const a = await audit();
      check(a.count > 40 && !summary(a), `${w}x${h} ${layout} ${theme} @${zoom}%: ${a.count} controls in bounds, none overlapping or covered${summary(a) ? ' — ' + summary(a) : ''}`);
      if (theme !== 'midnight') continue;
      // every panel fits on every visible deck; then the full audit again with the FX panel open on all decks
      const f = await fit(PANELS);
      check(!f.length, `${w}x${h} ${layout} @${zoom}%: all decks' panels fit, nothing outside the window${f.length ? ' — ' + f.slice(0, 4).join('; ') : ''}`);
      await fit(['fx']);
      const fa = await audit();
      check(fa.count > 30 && !summary(fa), `${w}x${h} ${layout} @${zoom}% FX panel on both decks: ${fa.count} controls in bounds${summary(fa) ? ' — ' + summary(fa) : ''}`);
      await ev(() => window.opendj.engine.decks.forEach((d) => d.showPanel?.('cues')));
    }
  }
  // the remaining common sizes (fit check only: these are the window sizes the layout has to hold at all zooms)
  for (const [w, h] of QUICK ? [] : [[1024, 768], [1280, 720], [1600, 900], [2560, 1440]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const layout of layouts) for (const zoom of zooms) {
      await setUi({ layout, theme: 'midnight', zoom });
      await page.waitForTimeout(120);
      const f = await fit(PANELS);
      check(!f.length, `${w}x${h} ${layout} @${zoom}%: all decks' panels fit, nothing outside the window${f.length ? ' — ' + f.slice(0, 4).join('; ') : ''}`);
    }
  }
  await ev(() => window.opendj.engine.decks.forEach((d) => d.showPanel?.('cues')));
  // top bar in its busiest state: hosted mode's Sign out shown and automix announcing a long "Next: …" line
  await ev(() => { const a = window.opendj; a.signOutBtn.hidden = false; a.amInfo.textContent = 'Next: A Very Long Artist Name – An Extremely Long Track Title (Extended Club Mix) · Bass swap in 01:23'; });
  for (const [w, h] of [[1024, 768], [1280, 720], [1366, 768], [1440, 900], [1600, 900], [1920, 1080]]) for (const zoom of [100, 110, 125, 150]) {
    await page.setViewportSize({ width: w, height: h });
    await setUi({ layout: 'classic', theme: 'midnight', zoom });
    await page.waitForTimeout(120);
    const f = await fit(['fx']);
    check(!f.length, `${w}x${h} @${zoom}% with Sign out + automix info: top bar items don't overlap, page fits${f.length ? ' — ' + f.slice(0, 4).join('; ') : ''}`);
  }
  // the folded buttons are offered in the More menu
  await page.setViewportSize({ width: 1280, height: 720 }); await setUi({ layout: 'classic', theme: 'midnight', zoom: 100 }); await page.waitForTimeout(150);
  await page.locator('.topbar .tb-more').click();
  const moreItems = await ev(() => [...document.querySelectorAll('.tb-menu .ctx-item')].map((x) => x.textContent.trim()));
  check(['LIVE', 'VIDEO', 'LIGHTS', 'Sign out'].every((k) => moreItems.some((t) => t.includes(k))), `1280 px: More menu offers the folded buttons (${moreItems.join(', ')})`);
  await page.keyboard.press('Escape'); await ev(() => { document.querySelector('.tb-menu')?.remove(); const a = window.opendj; a.signOutBtn.hidden = true; a.amInfo.textContent = ''; });
  await page.setViewportSize({ width: 1920, height: 1080 });

  // ---------- 2. click sweep per layout ----------
  await page.setViewportSize({ width: 1920, height: 1080 });
  const SKIP = /eject|stems-prep|rec\b|live-btn|dvs-btn|video-btn|light-btn|signout|fullscreen|automix-btn|lib-collapse|upl-btn|import-btn/;
  for (const layout of layouts) {
    await setUi({ layout, theme: 'midnight', zoom: 100 });
    await page.waitForTimeout(200);
    // every panel of every deck
    const tabs = await page.locator('.deck:visible .panel-tab:visible').count();
    for (let k = 0; k < tabs; k++) { await page.locator('.deck:visible .panel-tab:visible').nth(k).click(); }
    const shownOk = await ev(() => [...document.querySelectorAll('.deck')].filter((d) => d.offsetParent).every((d) => d.querySelector('.deck-panel.shown')));
    check(shownOk, `${layout}: every panel tab opens its panel`);
    for (const panel of ['cues', 'loops', 'fx', 'stems', 'key']) {
      await ev((p) => window.opendj.engine.decks.forEach((d) => d.showPanel?.(p)), panel);
      const a = await audit();
      check(!summary(a), `${layout}: ${panel} panel in bounds${summary(a) ? ' — ' + summary(a) : ''}`);
      // click every visible control in the decks and the mixer (toggles twice so the state is restored)
      const targets = await ev((skip) => {
        const re = new RegExp(skip);
        const list = [...document.querySelectorAll('.deck .btn, .deck .pad, .deck .pad-mode, .mixer .btn')].filter((e) => e.offsetParent && e.getBoundingClientRect().width > 2 && !re.test(e.className) && !e.disabled);
        list.forEach((e, i) => { e.dataset.sweep = `${i}`; });
        return list.length;
      }, SKIP.source);
      let clicked = 0;
      for (let k = 0; k < targets; k++) {
        const loc = page.locator(`[data-sweep="${k}"]`);
        if (!(await loc.isVisible().catch(() => false))) continue;
        const box = await loc.boundingBox(); if (!box) continue;
        const inView = await loc.evaluate((e) => { const r = e.getBoundingClientRect(); const p = e.closest('.deck-mid'); if (!p) return true; const s = p.getBoundingClientRect(); return r.top >= s.top - 1 && r.bottom <= s.bottom + 1; });
        if (!inView) await loc.scrollIntoViewIfNeeded();
        const isToggle = await loc.evaluate((e) => !e.matches('.pad, .btn-cue, .loop-row .btn, .jump-row .btn, .key-row .btn'));
        await loc.click({ timeout: 2000 });
        if (isToggle) await loc.click({ timeout: 2000 });
        clicked++;
        if (await page.locator('.overlay').count()) await page.keyboard.press('Escape');
      }
      await ev(() => { document.querySelectorAll('.overlay .modal-x').forEach((x) => x.click()); document.querySelectorAll('[data-sweep]').forEach((e) => delete e.dataset.sweep); window.opendj.engine.decks.forEach((d) => { d.pause(); d.exitLoop?.(); d.setKeyShift?.(0); }); });
      check(clicked > 10 && errors.length === 0, `${layout}/${panel}: clicked ${clicked} controls without errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
    }
    // keyboard shortcuts
    await page.locator('.lib-header').click({ position: { x: 5, y: 5 } }).catch(() => {});
    for (const k of ['z', 'x', 'x', 'c', 'm', ',', ',', '.', 'q', 'w', 'o', 'p', '1', '2', '7', '8', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', ' ', ' ']) await page.keyboard.press(k);
    await ev(() => window.opendj.engine.decks.forEach((d) => { d.pause(); d.exitLoop?.(); }));
    check(errors.length === 0, `${layout}: keyboard shortcuts without errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  }

  // ---------- 3. top bar, dialogs, library ----------
  await setUi({ layout: 'classic', theme: 'midnight', zoom: 100 });
  for (const b of await page.locator('.layout-seg .seg-btn').all()) { await b.click(); await page.waitForTimeout(80); }
  check(await ev(() => document.body.classList.contains('four-decks') && window.opendj.deckCount === 4), 'layout switcher reaches 4 decks');
  await page.locator('.layout-seg .seg-btn[data-layout="classic"]').click();
  check(await ev(() => window.opendj.deckCount === 2 && document.body.classList.contains('layout-classic')), 'layout switcher back to classic');
  const tabNames = await ev(async () => { window.opendj.dialogs.settings(); await new Promise((r) => setTimeout(r, 300)); return [...document.querySelectorAll('.overlay .tab')].map((t) => t.textContent); });
  for (let k = 0; k < tabNames.length; k++) {
    await page.locator('.overlay .tab').nth(k).click(); await page.waitForTimeout(120);
    const bad = await ev(() => { const m = document.querySelector('.overlay .modal').getBoundingClientRect(); return [...document.querySelectorAll('.overlay .modal-body .btn, .overlay .modal-body select, .overlay .modal-body input')].filter((e) => e.offsetParent && e.getBoundingClientRect().width).filter((e) => { const r = e.getBoundingClientRect(); return r.right > m.right + 1 || r.left < m.left - 1; }).map((e) => e.className || e.tagName); });
    check(bad.length === 0, `settings / ${tabNames[k]}: controls inside the dialog${bad.length ? ' — ' + bad.join(', ') : ''}`);
  }
  await page.keyboard.press('Escape');
  check(!(await page.locator('.overlay').count()), 'Escape closes the settings dialog');
  // library chips, suggestions, rows, collapse
  await ev(() => window.opendj.engine.decks[0].setMaster());
  await page.locator('.lib-chips .chip', { hasText: 'Key match' }).click();
  await page.waitForTimeout(250);
  check(/key:compat/.test(await page.locator('.lib-search').inputValue()), 'Key match chip adds key:compat to the search');
  await page.locator('.lib-chips .chip', { hasText: 'BPM' }).click();
  await page.locator('.lib-chips .chip-clear').click();
  await page.waitForTimeout(250);
  check((await page.locator('.lib-search').inputValue()) === '' && (await ev(() => window.opendj.library.rows.length)) === 4, 'Clear chip resets search and filters');
  await page.locator('.lib-chips .chip-rows').click(); await page.waitForTimeout(100);
  check(await ev(() => document.querySelector('.library').classList.contains('rows-art') && document.querySelector('.lr').getBoundingClientRect().height >= 43), 'Artwork rows toggle');
  await page.locator('.lib-chips .chip-rows').click();
  await page.locator('.lib-collapse-btn').click(); await page.waitForTimeout(300);
  check(await ev(() => document.querySelector('.library').getBoundingClientRect().height < 60), 'library collapses');
  await page.locator('.lib-collapse-btn').click(); await page.waitForTimeout(300);
  check(await ev(() => document.querySelector('.library').getBoundingClientRect().height > 150), 'library expands again');
  check(await ev(() => document.querySelectorAll('.lib-suggest .sg-card, .lib-suggest .sg-empty').length > 0), 'suggestions strip renders');

  // ---------- 4. resize while playing: no errors, nothing escapes ----------
  await ev(() => window.opendj.engine.decks.slice(0, 2).forEach((d) => d.play()));
  for (const [w, h] of [[1600, 900], [1100, 700], [1440, 900], [1920, 1080]]) { await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(250); }
  const after = await audit();
  check(!summary(after), `after live resizes: controls in bounds${summary(after) ? ' — ' + summary(after) : ''}`);
  await ev(() => window.opendj.engine.decks.forEach((d) => d.pause()));

  } // !SKINS_ONLY

  // ---------- 5. whole-layout controller skins (js/skins): geometry at every size, then click every control ----------
  const skinAudit = () => ev(() => {
    const root = document.querySelector('.sk-root'); if (!root) return { missing: true };
    const rr = root.getBoundingClientRect();
    const CONTROLS = '.sk-btn, .sk-knob, .sk-fader, .sk-jog, .sk-pad, .ai-xpad';
    const vis = (e) => { const r = e.getBoundingClientRect(); return e.offsetParent && r.width > 1 && r.height > 1; };
    const name = (e) => `${e.className.baseVal ?? e.className}`.split(' ').slice(0, 2).join('.') + (e.textContent?.trim() ? `"${e.textContent.trim().slice(0, 12)}"` : '') + (e.dataset.target ? `[${e.dataset.target}]` : '');
    const els = [...root.querySelectorAll(CONTROLS)].filter(vis);
    const out = { count: els.length, escape: [], overlap: [], covered: [], fader: [], small: [], clipped: [] };
    const rects = els.map((e) => ({ e, r: e.getBoundingClientRect() }));
    for (const { e, r } of rects) {
      if (r.left < rr.left - 1 || r.right > rr.right + 1 || r.top < rr.top - 1 || r.bottom > rr.bottom + 1) out.escape.push(name(e));
      const panel = e.closest('.cc-deck, .cc-mixer, .ai-strip, .ai-deck, .ai-mixer, .ai-browse, .ai-screen-wrap');
      if (panel) { const p = panel.getBoundingClientRect(); if (r.left < p.left - 1 || r.right > p.right + 1 || r.top < p.top - 1 || r.bottom > p.bottom + 1) out.escape.push(`${name(e)} outside its panel`); }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && hit !== e && !e.contains(hit) && !hit.contains(e) && !hit.closest('.toast, .toasts')) out.covered.push(`${name(e)} under ${name(hit)}`);
      if (Math.min(r.width, r.height) < 9) out.small.push(name(e));
      const lbl = e.matches('.sk-btn') && e.querySelector('.sk-lbl'); if (lbl && lbl.scrollWidth > e.clientWidth + 2) out.clipped.push(name(e));
    }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j]; if (a.e.contains(b.e) || b.e.contains(a.e)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 1.5 && h > 1.5) out.overlap.push(`${name(a.e)} x ${name(b.e)}`);
    }
    for (const f of root.querySelectorAll('.sk-fader')) {
      if (!vis(f)) continue;
      const t = f.getBoundingClientRect(), c = f.querySelector('.sk-fcap').getBoundingClientRect();
      if (c.top < t.top - 1 || c.bottom > t.bottom + 1 || c.left < t.left - 1 || c.right > t.right + 1) out.fader.push(name(f));
    }
    return out;
  });
  const skinSummary = (a) => a.missing ? 'skin not shown' : ['escape', 'overlap', 'covered', 'fader', 'small', 'clipped'].filter((k) => a[k].length).map((k) => `${k} ${a[k].slice(0, 4).join('; ')}`).join(' | ');
  for (const skin of ['compact-controller', 'all-in-one']) {
    for (const [w, h] of [[1920, 1080], [1600, 960], [1440, 900], [1366, 768], [1280, 800], [2560, 1440], [1180, 820]]) {
      await page.setViewportSize({ width: w, height: h });
      await setUi({ layout: skin === 'all-in-one' ? 'four' : 'classic', theme: skin, zoom: 100 });
      await page.waitForSelector('.sk-root', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(250);
      // every fader to both ends and back: the caps stay in their tracks
      await ev(() => { for (const f of document.querySelectorAll('.sk-root .sk-fader[data-target]')) { const t = f.dataset.target, m = window.opendj.midi; const v = m.byId.get(t)?.get?.() ?? 0.5; m.dispatch({ target: t }, 0); m.dispatch({ target: t }, 1); m.dispatch({ target: t }, v); } });
      await page.waitForTimeout(60);
      const a = await skinAudit();
      check(a.count > (skin === 'all-in-one' ? 150 : 60) && !skinSummary(a), `${skin} ${w}x${h}: ${a.count} controls reachable, in bounds, none overlapping, covered or clipped${skinSummary(a) ? ' — ' + skinSummary(a) : ''}`);
      const f = await fit([]);
      check(!f.length, `${skin} ${w}x${h}: page fits the window${f.length ? ' — ' + f.slice(0, 3).join('; ') : ''}`);
    }
    // click every enabled button and pad (twice for toggles), drag every knob and fader a little
    await page.setViewportSize({ width: 1920, height: 1080 });
    await setUi({ layout: skin === 'all-in-one' ? 'four' : 'classic', theme: skin, zoom: 100 });
    await page.waitForSelector('.sk-root'); await page.waitForTimeout(200);
    const SKIN_SKIP = /MENU|MIXER|TAG LIST|USB STOP|INST\.|LOAD|⏮|⏭/;
    const n = await ev(() => { const l = [...document.querySelectorAll('.sk-root .sk-btn:not(.sk-na), .sk-root .sk-pad')].filter((e) => e.offsetParent); l.forEach((e, i) => { e.dataset.sweep = `${i}`; }); return l.length; });
    let clicked = 0;
    for (let i = 0; i < n; i++) {
      const loc = page.locator(`.sk-root [data-sweep="${i}"]`);
      const txt = (await loc.textContent()) || '';
      if (SKIN_SKIP.test(txt)) continue;
      await loc.click({ timeout: 2000 }); await loc.click({ timeout: 2000 }); clicked++;
      if (await page.locator('.overlay').count()) await page.keyboard.press('Escape');
    }
    for (const sel of ['.sk-root .sk-knob:not(.sk-na)', '.sk-root .sk-fader']) {
      const m = await page.locator(sel).count();
      for (let i = 0; i < m; i++) { const bb = await page.locator(sel).nth(i).boundingBox(); if (!bb) continue; await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down(); await page.mouse.move(bb.x + bb.width / 2 + 3, bb.y + bb.height / 2 - 6, { steps: 2 }); await page.mouse.up(); }
    }
    await ev(() => { document.querySelectorAll('[data-sweep]').forEach((e) => delete e.dataset.sweep); const a = window.opendj; a.shift = false; a.engine.decks.forEach((d) => { d.pause(); d.exitLoop?.(); d.setKeyShift?.(0); }); });
    check(clicked > (skin === 'all-in-one' ? 80 : 40) && errors.length === 0, `${skin}: clicked ${clicked} buttons and pads, dragged every knob and fader, no errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  }
  await setUi({ layout: 'classic', theme: 'midnight', zoom: 100 });
  check(await ev(() => !document.querySelector('.sk-root') && document.querySelectorAll('.waves .wave-row').length === 4), 'back to a normal theme: standard layout and waveforms restored');
  check(errors.length === 0, `no page errors, console errors or unhandled rejections${errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''}`);
} catch (e) { console.error(e); failed = true; }
await browser.close(); app.server.close();
console.log(`\n${checks} checks`);
console.log(failed ? 'UI SWEEP FAILED' : 'UI SWEEP PASSED');
process.exit(failed ? 1 : 0);
