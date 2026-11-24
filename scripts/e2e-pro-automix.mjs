// End-to-end check of the pro-DJ automix features in a real browser (docs/PRO_DJ_AUTOMIX_RESEARCH.md):
// the queue panel's transition preview (timeline, checker verdict, nudges, headphone render), the silence watchdog
// rescuing a dead on-air fader, a planned trick performed and the mixer restored, and party controls.
// Run: node scripts/e2e-pro-automix.mjs   (OPENDJ_CHROMIUM=/path/to/chromium to use another browser binary)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';
import { TRACKS, renderTrack } from './demo/make-demo-library.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-pro-'));
const music = path.join(tmp, 'Music');
fs.mkdirSync(music);
const SR = 44100, CUT = 90;
const DEMO = [0, 1, 2, 3].map((i) => TRACKS[i]);
function writeWav(file, L, R) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4); }
  fs.writeFileSync(file, buf);
}
for (const def of DEMO) {
  const a = renderTrack(def), n = Math.min(a.L.length, CUT * SR), L = a.L.slice(0, n), R = a.R.slice(0, n);
  for (let i = 0; i < SR; i++) { const f = i / SR; L[n - 1 - i] *= f; R[n - 1 - i] *= f; }
  writeWav(path.join(music, `${def.artist} - ${def.title}.wav`.replace(/[\\/:*?"<>|]/g, '_')), L, R);
}

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const launch = { args: ['--autoplay-policy=no-user-gesture-required'] };
if (process.env.OPENDJ_CHROMIUM) launch.executablePath = process.env.OPENDJ_CHROMIUM;
const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
class CheckError extends Error {}
const check = (cond, msg) => { if (!cond) throw new CheckError(msg); console.log('ok -', msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitNextLoaded = () => page.waitForFunction(() => {
  const a = window.opendj.automix, d = a.enabled && a.current && a.other(a.current), n = a.nextTrack();
  return !a.transition && d && n && d.track?.id === n.id && !d.loading && !a._loading;
}, null, { timeout: 30000 });

try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 20000 });
  await page.evaluate(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
  await page.evaluate(async (dir) => (await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) })).json(), music);
  await page.waitForFunction((n) => window.opendj.library.tracks.size === n, DEMO.length, { timeout: 30000 });
  await page.waitForFunction(() => [...window.opendj.library.tracks.values()].every((t) => t.analyzed), null, { timeout: 180000 });
  const lib = await page.evaluate(() => [...window.opendj.library.tracks.values()].map((t) => ({ lufs: t.lufs, mainLufs: t.mainLufs, gain: t.gain, phraseAnchor: t.phraseAnchor, keyConfidence: t.keyConfidence })));
  check(lib.every((t) => Number.isFinite(t.mainLufs) && Number.isFinite(t.gain) && Math.abs(t.gain - (-14 - t.mainLufs)) < 0.11 || t.gain === 6 || t.gain === -12), `analysis stores loudness and level-match gain (${JSON.stringify(lib[0])})`);

  // ---------- start a set: level matching applied before the track is heard ----------
  await page.evaluate(async () => {
    const a = window.opendj;
    a.settings.automix = { ...a.settings.automix, style: 'auto', lengthMode: 'auto', keepSync: true, tricks: 'subtle' };
    await a.automix.start([...a.library.tracks.values()], { mode: 'order' });
  });
  await waitNextLoaded();
  const gains = await page.evaluate(() => { const a = window.opendj, am = a.automix; return { ch: a.engine.channels[am.current.index].state.autoGain, track: a.library.track(am.current.track.id).gain }; });
  check(Math.abs(gains.ch - gains.track) < 1e-6, `on-air deck level-matched (${gains.ch.toFixed(1)} dB)`);

  // ---------- preview: queue panel timeline, checker verdict, nudge, headphone render ----------
  await page.evaluate(() => window.opendj.toggleQueuePanel());
  await page.waitForSelector('.am-preview svg.am-tl', { timeout: 10000 });
  const verdict = await page.locator('.am-check').textContent();
  check(/in \d|check|drop transition/.test(verdict || ''), `preview timeline and verdict shown ("${verdict}")`);
  const before = await page.evaluate(() => window.opendj.automix.previewPlan());
  check(before && (before.lanes ? before.lanes.length === 65 : before.drop != null), `preview plan (${before.style}, ${before.length?.bars} bars: ${before.length?.why}; ${before.why})`);
  await page.getByRole('button', { name: 'shorter', exact: true }).click();
  const after = await page.evaluate(() => { const p = window.opendj.automix.previewPlan(); return { bars: p.length?.bars, nudge: p.nudge }; });
  check(after.nudge?.bars && (after.bars <= (before.length?.bars || 32)), `nudge "shorter" re-plans the transition (${before.length?.bars} → ${after.bars} bars)`);
  await page.getByRole('button', { name: 'reset', exact: true }).click();
  const rendered = await page.evaluate(async () => {
    const { renderTransition } = await import('/js/automix-preview.js');
    const p = window.opendj.automix.previewPlan();
    const buf = await renderTransition(window.opendj.engine.ctx, p);
    const d = buf.getChannelData(0); let pk = 0, sum = 0; for (let i = 0; i < d.length; i += 7) { pk = Math.max(pk, Math.abs(d[i])); sum += d[i] * d[i]; }
    return { seconds: buf.duration, peak: pk, rms: Math.sqrt(sum / (d.length / 7)) };
  });
  check(rendered.seconds > 4 && rendered.peak > 0.01 && rendered.peak < 4, `transition rendered offline for the headphones (${rendered.seconds.toFixed(1)} s, peak ${rendered.peak.toFixed(2)})`);
  await page.getByRole('button', { name: 'Preview ♪' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.am-nudges button')].some((b) => b.textContent === 'Stop preview'), null, { timeout: 30000 });
  check(true, 'headphone preview plays');
  await page.getByRole('button', { name: 'Stop preview' }).click();

  // ---------- watchdog: the on-air fader is pulled down by something else -> restored ----------
  const rescue = await page.evaluate(async () => {
    const a = window.opendj, am = a.automix, ch = a.engine.channels[am.current.index];
    let kind = null; const off = am.on('rescue', (e) => { kind = e.kind; });
    ch.set('volume', 0);
    const t0 = performance.now();
    while (!kind && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
    off();
    return { kind, volume: ch.state.volume, ms: Math.round(performance.now() - t0) };
  });
  check(rescue.kind === 'silent' && rescue.volume > 0.5, `watchdog: silent on-air deck rescued in ${rescue.ms} ms (${rescue.kind}, fader ${rescue.volume})`);

  // ---------- a trick: bass-cut tease into the next section, then the EQ is restored ----------
  const trick = await page.evaluate(async () => {
    const a = window.opendj, am = a.automix, d = am.current, ch = a.engine.channels[d.index];
    const bar = 240 / d.bpm, pos = d.position;
    const ev = { id: 'bassTease', label: 'bass-cut tease', start: pos + bar * 0.5, at: pos + bar * 1.5, bars: 1 };
    am.trickPlan = { key: 'test', deck: d, events: [ev] };
    am.planTricksNow = () => {}; // keep the test event
    let started = false; const off = am.on('trick', () => { started = true; });
    const t0 = performance.now(); let sawKill = false;
    while (performance.now() - t0 < 6000) {
      await new Promise((r) => setTimeout(r, 50));
      if (ch.state.eqLow <= -0.99) sawKill = true;
      if (started && !am.trick) break;
    }
    off();
    await new Promise((r) => setTimeout(r, 300));
    return { started, sawKill, eqLow: ch.state.eqLow, history: (am.trickHistory || []).length };
  });
  check(trick.started && trick.sawKill && trick.eqLow === 0, `trick performed on the beat and the EQ restored (${JSON.stringify(trick)})`);

  // ---------- party controls ----------
  await page.getByRole('button', { name: 'Energy +' }).click();
  const bias = await page.evaluate(() => window.opendj.settings.automix.energyBias);
  check(bias === 0.5, 'energy + nudges the selection target');
  const banned = await page.evaluate(() => { const am = window.opendj.automix, n = am.nextTrack(); document.querySelector('.am-party button[title^="Never play"]').click(); return { id: String(n.id), list: window.opendj.settings.automix.banned, next: am.nextTrack()?.id }; });
  check(banned.list.includes(banned.id) && String(banned.next) !== banned.id, 'never play: the next track is banned and removed');

  // ---------- a full transition still completes cleanly ----------
  await waitNextLoaded();
  await page.evaluate(() => window.opendj.automix.skip());
  await page.waitForFunction(() => !window.opendj.automix.transition, null, { timeout: 60000 });
  const clean = await page.evaluate(() => { const a = window.opendj, ch = a.engine.channels[a.automix.current.index].state; return { eq: [ch.eqLow, ch.eqMid, ch.eqHigh, ch.filter], vol: ch.volume, fb: a.automix.feedback?.resetSuggested }; });
  check(clean.eq.every((v) => v === 0) && clean.vol > 0.7, `after the transition the on-air channel is clean (${JSON.stringify(clean)})`);
  // ---------- bass preview (opt-in): the incoming bass at -8 dB for the bars before the swap, in a scheduled blend ----------
  // a 32-bar club EQ blend into a next track 8 dB quieter (as an intro is): there the checker allows the preview
  const savedAm = await page.evaluate(() => JSON.stringify(window.opendj.settings.automix));
  await page.evaluate(() => window.opendj.setSetting('automix', { ...window.opendj.settings.automix, style: 'blend', varyStyles: false, lengthMode: 'fixed', transitionBeats: 128, bassPreview: true }));
  await waitNextLoaded();
  const pv = await page.evaluate(async () => {
    const a = window.opendj, am = a.automix, cur = am.current, next = am.nextTrack();
    const lib = a.library.tracks.get(next.id), gain0 = lib.gain;
    lib.gain = (Number(gain0) || 0) - 8; am.upcoming = null;
    try {
      const nt = am.nextTransition(), pp = am.previewPlan();
      if (!nt || !pp) return { none: true };
      cur.seek(Math.max(0, nt.begin - 1.5)); // let the blend start on schedule (not MIX NOW)
      const t0 = performance.now(); let tr = null;
      while (!(tr = am.transition) && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 25));
      if (!tr) return { started: false, planned: pp.previewFrom };
      const ch = a.engine.channels[tr.inn.index], seen = [];
      while (am.transition === tr) { seen.push({ k: Math.min(1, (am.now() - tr.t0) / tr.dur), low: ch.state.eqLow, swap: tr.kSwap }); await new Promise((r) => setTimeout(r, 40)); }
      return { started: true, style: tr.style, bars: tr.length?.bars, planned: pp.previewFrom, from: tr.previewFrom ?? null, kSwap: seen.find((x) => x.swap != null)?.swap ?? null, seen };
    } finally { lib.gain = gain0; }
  });
  check(pv.started && pv.style === 'blend', `a scheduled club EQ blend started (${pv.style}, ${pv.bars} bars)`);
  check(pv.from != null, `the bass preview is used under a quieter incoming track (from ${pv.from?.toFixed(2)}, planned ${pv.planned?.toFixed(2)})`);
  const pvBefore = pv.seen.filter((x) => x.swap == null && x.k < pv.from - 0.01), inWin = pv.seen.filter((x) => x.swap == null && x.k > pv.from + 0.01);
  check(pvBefore.length > 0 && pvBefore.every((x) => x.low <= -0.99) && inWin.length > 0 && inWin.every((x) => Math.abs(x.low - (-8 / 26)) < 0.01),
    `incoming bass cut until ${pv.from.toFixed(2)}, then -8 dB until the swap at ${pv.kSwap?.toFixed(2)} (${pvBefore.length} / ${inWin.length} samples)`);
  check(pv.kSwap != null && pv.seen.filter((x) => x.swap != null).every((x) => x.low === 0), 'after the swap the incoming bass is full');
  await page.evaluate((s) => window.opendj.setSetting('automix', JSON.parse(s)), savedAm);

  // ---------- render this set (P6.5): the planned upcoming set exported offline to a WAV file ----------
  const exported = await page.evaluate(async () => {
    const { exportSet } = await import('/js/automix-export.js');
    let timeline = null, calls = 0;
    const t0 = performance.now();
    const blob = await exportSet(window.opendj, { maxTracks: 2, maxMinutes: 3, onProgress: (p) => { timeline = p.timeline; calls++; } });
    const h = new DataView(await blob.slice(0, 44).arrayBuffer());
    const tag = (o) => String.fromCharCode(h.getUint8(o), h.getUint8(o + 1), h.getUint8(o + 2), h.getUint8(o + 3));
    const sr = h.getUint32(24, true), bytes = h.getUint32(40, true);
    // loudness of the middle of the file: music, not silence
    const mid = new Int16Array(await blob.slice(44 + Math.floor(bytes / 8) * 4, 44 + Math.floor(bytes / 8) * 4 + sr * 4).arrayBuffer());
    let pk = 0; for (const v of mid) pk = Math.max(pk, Math.abs(v));
    return { riff: tag(0), wave: tag(8), data: tag(36), type: blob.type, size: blob.size, sr, channels: h.getUint16(22, true), bits: h.getUint16(34, true),
      bytes, seconds: bytes / (sr * 4), planned: timeline?.seconds, kinds: timeline?.segments.map((s) => s.kind).join(','), calls, peak: pk / 32767, ms: Math.round(performance.now() - t0) };
  });
  check(exported.riff === 'RIFF' && exported.wave === 'WAVE' && exported.data === 'data' && exported.type === 'audio/wav' && exported.channels === 2 && exported.bits === 16
    && exported.size > 1048576 && exported.size === 44 + exported.bytes && exported.bytes % 4 === 0 && exported.seconds > 10 && exported.seconds <= 180 && Math.abs(exported.seconds - exported.planned) < 0.05
    && exported.peak > 0.01, `set exported to WAV (${(exported.size / 1048576).toFixed(1)} MB, ${exported.seconds.toFixed(1)} s: ${exported.kinds}; peak ${exported.peak.toFixed(2)}; ${exported.ms} ms) ${JSON.stringify({ planned: exported.planned, seconds: exported.seconds, size: exported.size, peak: exported.peak })}`);
  check(!errors.length, `no console errors ${errors.join(' | ')}`);
  console.log('\nE2E PRO AUTOMIX PASSED');
} catch (e) {
  console.error(`FAIL: ${e instanceof CheckError ? e.message : e.stack || e}`);
  if (errors.length) console.error('console errors:', errors.slice(0, 5).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  await app.close?.();
  process.exit(process.exitCode || 0);
}
