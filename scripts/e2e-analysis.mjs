// End-to-end: background analysis. Adds a folder, waits until every track is analysed without loading any
// deck, then checks bpm: search, the waveform cache, the unreadable flag for a corrupt and a 0-byte file,
// that deck load reuses the background result, and the Settings switch.
// Usage: node scripts/e2e-analysis.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-analysis-'));
const music = path.join(tmp, 'Music');
fs.mkdirSync(music);

function writeWav(file, bpm, seconds, rootHz) {
  const sr = 44100, n = sr * seconds, data = Buffer.alloc(44 + n * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVE', 8); data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(sr, 24);
  data.writeUInt32LE(sr * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(n * 4, 40);
  const beat = 60 / bpm;
  for (let i = 0; i < n; i++) {
    const t = i / sr, tb = (t - 0.1) % beat;
    let v = 0.25 * Math.sin(2 * Math.PI * rootHz * t) + 0.12 * Math.sin(2 * Math.PI * rootHz * 1.5 * t);
    if (t > 0.1 && tb < 0.15) v += 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb * 40)) * tb) * Math.exp(-tb * 18);
    const s = Math.max(-1, Math.min(1, v * 0.7)) * 32767;
    data.writeInt16LE(s | 0, 44 + i * 4); data.writeInt16LE(s | 0, 46 + i * 4);
  }
  fs.writeFileSync(file, data);
}
// same material as e2e-smoke (known to give exact BPMs with the analysis core)
const TRACKS = [[124, 50, 220], [128, 50, 196], [122, 40, 174.6]];
TRACKS.forEach(([b, secs, hz], i) => writeWav(path.join(music, `Artist ${i} - Track ${b}.wav`), b, secs, hz));
const BPMS = TRACKS.map((x) => x[0]);
fs.writeFileSync(path.join(music, 'corrupt.mp3'), Buffer.from('ID3 this is not really audio data '.repeat(200)));
fs.writeFileSync(path.join(music, 'empty.mp3'), Buffer.alloc(0));
const AUDIO = BPMS.length, TOTAL = AUDIO + 2;

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const done = async (code) => { await browser.close(); app.server.close(); process.exit(code); };
const check = (cond, msg) => { if (!cond) throw new Error(msg); console.log('ok -', msg); };

try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 15000 });
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});

  // first launch: the empty library explains how to add music
  const empty = await page.locator('.lib-empty').innerText();
  check(/library is empty/i.test(empty) && /\+ Folder/.test(empty) && /rekordbox/i.test(empty), 'empty library panel on first launch');

  const r = await page.evaluate(async (dir) => (await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) })).json(), music);
  check(r.id, 'folder added');
  await page.waitForFunction((n) => window.opendj.library.tracks.size === n, TOTAL, { timeout: 15000 });
  check(true, `scanned ${TOTAL} files`);

  // progress shows up while it works
  await page.waitForFunction(() => /Analysing \d+ \/ \d+/.test(document.querySelector('.lib-analysis')?.textContent || ''), null, { timeout: 15000 });
  check(true, 'progress line "Analysing n / N" visible');

  const t0 = Date.now();
  await page.waitForFunction((n) => [...window.opendj.library.tracks.values()].filter((t) => t.analyzed).length === n && !window.opendj.analyser.running, AUDIO, { timeout: 120000 });
  check(true, `all ${AUDIO} audio tracks analysed in the background (${((Date.now() - t0) / 1000).toFixed(1)} s), no deck loaded`);
  check(await page.evaluate(() => window.opendj.engine.decks.every((d) => !d.track)), 'no deck was used');

  // the server has the results (not only this page): bpm, key, waveform, auto cues
  const server = await page.evaluate(async () => (await (await fetch('/api/tracks')).json()));
  const audio = server.filter((t) => /^Track \d+$/.test(t.title));
  for (const t of audio) {
    const want = Number(t.title.split(' ')[1]);
    check(t.analyzed && Math.abs(t.bpm - want) < 1.5, `${t.title}: bpm ${t.bpm}`);
    check(t.key && t.energy >= 1 && Array.isArray(t.phrases), `${t.title}: key ${t.key}, energy ${t.energy}, phrases`);
    check((t.cues || []).every((c) => c.auto === true), `${t.title}: auto cues marked auto`);
    check(!(t.cues || []).some((c) => /^Drop/.test(c.name) && c.position < 20), `${t.title}: no "Drop" cue at the start`);
    const wf = await page.evaluate(async (id) => (await fetch(`/api/tracks/${id}/waveform`)).status, t.id);
    check(wf === 200, `${t.title}: waveform cached`);
  }
  const bad = server.filter((t) => ['corrupt', 'empty'].includes(t.title));
  check(bad.length === 2 && bad.every((t) => t.unreadable && !t.analyzed), 'corrupt and 0-byte files marked unreadable');
  check(await page.locator('.lr.unreadable').count() === 2, 'unreadable rows flagged in the library');

  // bpm: search works without loading anything
  await page.locator('.lib-search').fill('bpm:123-129');
  await page.waitForFunction(() => window.opendj.library.rows.length === 2, null, { timeout: 3000 });
  check(true, 'bpm:123-129 finds the 124 and 128 tracks');
  await page.locator('.lib-search').fill('');

  // a deck load reuses the background analysis (no new analysis in the deck worker)
  const reused = await page.evaluate(async () => {
    const app = window.opendj; const t = [...app.library.tracks.values()].find((x) => x.title === 'Track 124');
    let analysed = 0; const orig = app.engine.analyze.bind(app.engine); app.engine.analyze = (...a) => { analysed++; return orig(...a); };
    await app.loadTrack(0, t.id); app.engine.analyze = orig;
    return { analysed, wave: !!app.engine.decks[0].waveform, bpm: app.engine.decks[0].bpm, want: t.bpm };
  });
  check(reused.analysed === 0 && reused.wave && reused.bpm === reused.want, 'deck load reuses the background result (waveform + grid)');

  // background and deck analysis give identical results (same decoder, same analysis core)
  const same = await page.evaluate(async () => {
    const app = window.opendj; const t = app.library.tracks.get([...app.library.tracks.values()].find((x) => x.title === 'Track 128').id);
    const bg = { bpm: t.bpm, gridOffset: t.gridOffset, key: t.key, energy: t.energy };
    const r = await fetch(`/api/tracks/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ analyzed: false }) }).then((x) => x.json());
    app.library.updateTrack(r);
    await app.loadTrack(1, t.id);
    const d = app.engine.decks[1].track;
    return { bg, deck: { bpm: d.bpm, gridOffset: d.gridOffset, key: d.key, energy: d.energy } };
  });
  check(JSON.stringify(same.bg) === JSON.stringify(same.deck), `background result equals deck analysis ${JSON.stringify(same.bg)}`);

  // corrupt file on a deck: title kept, toast names the file
  const corrupt = await page.evaluate(async () => {
    const app = window.opendj; const t = [...app.library.tracks.values()].find((x) => x.title === 'corrupt');
    await app.loadTrack(1, t.id).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    return { title: app.deckEls[1].querySelector('.deck-title')?.textContent || '', toasts: [...document.querySelectorAll('.toast')].map((x) => x.textContent) };
  });
  check(corrupt.toasts.some((x) => /corrupt/.test(x)), `toast names the undecodable file (${corrupt.toasts.join(' / ')})`);
  check(/corrupt/.test(corrupt.title) && !/Unable to decode/i.test(corrupt.title), `deck title keeps the track name ("${corrupt.title}")`);

  // re-analyse from the context menu path, and the Settings switch stops the automatic queue
  await page.evaluate(async () => { await window.opendj.setSetting('autoAnalyse', false); });
  const queued = await page.evaluate(() => window.opendj.analyser.autoQueue());
  check(queued === 0, 'autoAnalyse off: nothing is queued automatically');
  const n = await page.evaluate(() => { const app = window.opendj; const t = [...app.library.tracks.values()].find((x) => x.title === 'Track 122'); t.analyzed = false; return app.analyser.request([t]); });
  check(n === 1, 'explicit "Analyse selected" still works with the setting off');
  await page.waitForFunction(() => !window.opendj.analyser.running && window.opendj.library.tracks.size && [...window.opendj.library.tracks.values()].find((x) => x.title === 'Track 122').analyzed, null, { timeout: 30000 });
  check(true, 'explicit analysis finished');

  // small screens: one deck at a time via tabs, nothing pushed off-screen
  for (const [w, h] of [[390, 844], [768, 1024]]) {
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const vis = (e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0;
      const off = [...document.querySelectorAll('.topbar button, .topbar .clock, .deck button, .mixer button, .lib-tools > *')].filter(vis).filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; });
      const decks = window.opendj.deckEls.filter(vis).length;
      return { off: off.map((e) => e.textContent.trim().slice(0, 12)), decks, sw: document.documentElement.scrollWidth, tabs: [...document.querySelectorAll('.deck-tab')].filter(vis).length };
    });
    check(!m.off.length && m.sw <= w, `${w}x${h}: no controls off-screen (${m.off.join(', ')})`);
    check(m.decks === 1 && m.tabs === 2, `${w}x${h}: one deck shown, ${m.tabs} deck tabs`);
  }
  await page.locator('.deck-tab').nth(1).click();
  check(await page.evaluate(() => window.opendj.deckEls[1].offsetParent !== null && window.opendj.deckEls[0].offsetParent === null), 'deck tab switches to deck 2');
  await page.setViewportSize({ width: 1600, height: 960 });

  check(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  console.log('\nE2E ANALYSIS PASSED');
  await done(0);
} catch (e) {
  console.error('FAIL:', e.message); console.error(errors.join('\n'));
  await page.screenshot({ path: path.join(tmp, 'fail.png') }).catch(() => {}); console.error('screenshot', path.join(tmp, 'fail.png'));
  await done(1);
}
