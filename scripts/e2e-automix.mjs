// End-to-end automix test in headless Chromium:
//   A) smart mix built from the demo library (synthesised demo tracks): order with reasons, transitions happen
//   B) every transition style: the master output is tapped (AudioWorklet) and analysed for level drops / bumps,
//      clipping and clicks across each transition
//   C) loading tracks while automix runs, through every load path (context menu, double-click, drag & drop,
//      keyboard, MIDI), on the next deck, the on-air deck and during a transition
//   D) a fake Subsonic server's playlists in the sidebar: open one, smart-mix / automix it
// Usage: node scripts/e2e-automix.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';
import { TRACKS, renderTrack } from './demo/make-demo-library.mjs';
import { fakeSubsonic, beatWav } from '../test/fake-servers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-automix-'));
const music = path.join(tmp, 'Music');
fs.mkdirSync(music);

// ---- the demo library: 6 synthesised tracks (fictional), cut to 75 s with a fade, as WAV ----
const SR = 44100, CUT = 75;
const DEMO = [0, 1, 2, 3, 4, 8].map((i) => TRACKS[i]);
function writeWav(file, L, R) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4); }
  fs.writeFileSync(file, buf);
}
const t0 = Date.now();
for (const def of DEMO) {
  const a = renderTrack(def), n = Math.min(a.L.length, CUT * SR), L = a.L.slice(0, n), R = a.R.slice(0, n);
  for (let i = 0; i < SR; i++) { const f = i / SR; L[n - 1 - i] *= f; R[n - 1 - i] *= f; }
  writeWav(path.join(music, `${def.artist} - ${def.title}.wav`.replace(/[\\/:*?"<>|]/g, '_')), L, R);
}
console.log(`demo library rendered (${DEMO.length} tracks, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);

const songs = [124, 126, 125].map((bpm, i) => ({ id: `s${i + 1}`, title: `Remote ${i + 1}`, artist: `Server Artist ${i + 1}`, genre: 'House', bpm, duration: 40, wav: beatWav({ bpm, seconds: 40, hz: [220, 196, 246.9][i] }) }));
const sub = await fakeSubsonic({ songs, playlists: [{ id: 'p1', name: 'Friday Night', songIds: ['s2', 's1', 's3'] }] });

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
class CheckError extends Error {}
const check = (cond, msg) => { if (!cond) throw new CheckError(msg); console.log('ok -', msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until the automix next deck holds the queue's next track (loaded). */
const waitNextLoaded = () => page.waitForFunction(() => {
  const a = window.opendj.automix, d = a.enabled && a.current && a.other(a.current), n = a.nextTrack();
  return !a.transition && d && n && d.track?.id === n.id && !d.loading && !a._loading;
}, null, { timeout: 30000 });

try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 20000 });
  await page.evaluate(() => window.opendj.engine.resume());
  // OPENDJ_MIXER=<personality> or eq:<preset>: run the whole suite on another mixer personality / EQ preset
  // (the automix writes logical controls; each personality and EQ preset translates them)
  if (process.env.OPENDJ_MIXER) {
    const mode = process.env.OPENDJ_MIXER;
    const ok = await page.evaluate((m) => { const a = window.opendj; if (m.startsWith('eq:')) { const mx = { ...(a.settings.mixer || {}), eqType: m.slice(3) }; a.setSetting('mixer', mx); a.engine.settings.mixer = mx; a.engine.applyMixerConfig(); return a.engine.mx.eqType === m.slice(3); } return window.opendjMixer.setPersonality(m) && a.engine.mx.personality === m; }, mode);
    check(ok, `mixer set to ${mode}`);
  }
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
  await page.evaluate(async (dir) => (await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) })).json(), music);
  await page.waitForFunction((n) => window.opendj.library.tracks.size === n, DEMO.length, { timeout: 30000 });
  // background analysis of the whole library (BPM, key, energy, phrases)
  await page.waitForFunction(() => [...window.opendj.library.tracks.values()].every((t) => t.analyzed), null, { timeout: 180000 });
  check(true, `demo library scanned and analysed (${DEMO.length} tracks)`);
  // genre tags as the MP3 demo files carry them (WAV has none)
  await page.evaluate(async (meta) => {
    const a = window.opendj;
    for (const t of a.library.tracks.values()) { const m = meta.find((x) => t.title === x.title); if (m) a.library.updateTrack(await (await fetch(`/api/tracks/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ genre: m.genre }) })).json()); }
  }, DEMO.map((d) => ({ title: d.title, genre: d.genre })));

  // ---------- master tap (contiguous samples: RMS, peak and the largest 2nd difference per 50 ms) ----------
  await page.evaluate(() => {
    const e = window.opendj.engine, ctx = e.ctx;
    const sp = ctx.createScriptProcessor(1024, 2, 2), sink = ctx.createGain(); sink.gain.value = 0;
    const N = Math.round(ctx.sampleRate * 0.05);
    let n = 0, s = 0, p = 0, c = 0, x1 = 0, x2 = 0, t = 0;
    window.__frames = [];
    sp.onaudioprocess = (ev) => {
      const L = ev.inputBuffer.getChannelData(0), R = ev.inputBuffer.getChannelData(1);
      if (!t) t = ev.playbackTime;
      for (let i = 0; i < L.length; i++) {
        const x = (L[i] + R[i]) * 0.5; s += x * x;
        const pk = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (pk > p) p = pk;
        const d = Math.abs(x - 2 * x1 + x2); if (d > c) c = d; x2 = x1; x1 = x;
        if (++n >= N) { window.__frames.push([ev.playbackTime + i / ctx.sampleRate, Math.sqrt(s / n), p, c]); n = 0; s = 0; p = 0; c = 0; }
      }
      if (window.__frames.length > 20000) window.__frames.splice(0, 5000);
    };
    e.masterOut.connect(sp); sp.connect(sink); sink.connect(ctx.destination);
    window.__tap = sp;
  });

  // Adaptive planning through the real decks/worklets: an early instrumental entry, mixed out late.
  await page.evaluate(async () => {
    const app = window.opendj, am = app.automix;
    window.__adaptiveSaved = { automix: app.settings.automix, learning: app.settings.mixLearning };
    app.settings.automix = { ...app.settings.automix, style: 'auto', lengthMode: 'auto', keepSync: true, varyStyles: false };
    app.settings.mixLearning = { bias: { blend: 5, echo: -5, cut: -5, reverb: -5 } };
    await am.start([...app.library.tracks.values()].slice(0, 2), { mode: 'order' });
  });
  await waitNextLoaded();
  const adaptivePlan = await page.evaluate(async () => {
    const am = window.opendj.automix;
    window.__adaptiveOriginal = new Map();
    for (const d of [am.current, am.other(am.current)]) {
      window.__adaptiveOriginal.set(d.track.id, window.opendj.library.track(d.track.id));
      d.bpm = 120; d.gridOffset = 0;
      d.track = { ...d.track, bpm: 120, bpmConfidence: 1, key: '8A', mixIn: 0, mixOut: 64, downbeat: 0,
        phrases: Array.from({ length: 4 }, (_, i) => ({ start: i * 16, end: (i + 1) * 16, type: i === 0 ? 'intro' : 'breakdown', energy: 0.6 })),
        vocalMap: Array.from({ length: 75 }, (_, i) => d === am.current ? 1 : i >= 16 && i < 48 ? 0 : 1) };
      window.opendj.library.tracks.set(d.track.id, d.track);
      await fetch(`/api/tracks/${d.track.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d.track) });
    }
    am.current.seek(10); am.upcoming = null;
    const nt = am.nextTransition(), p = am.upcoming.adaptive;
    const off = am.on('transition', () => { window.__adaptiveHeard = { cue: am.transition.inStart ?? am.transition.inn.position, style: am.transition.style }; off(); });
    am.current.seek(nt.begin - 0.2);
    return { begin: nt.begin, cue: p?.inStart, style: nt.style, adaptive: !!p, outLen: am.current.duration, inLen: am.other(am.current).duration };
  });
  // like a DJ: most of the outgoing track plays first, and the incoming one comes in early (here on its instrumental
  // section at 16 s, inside its first quarter, so the two vocals never overlap; the demo grid may snap it ~0.1 s early)
  check(adaptivePlan.adaptive && adaptivePlan.cue >= 15.5 && adaptivePlan.cue <= adaptivePlan.inLen * 0.25 + 0.01 && adaptivePlan.begin >= Math.min(adaptivePlan.outLen * 0.6, adaptivePlan.outLen - 16) - 2, `adaptive plan: mix out late, in early (${JSON.stringify(adaptivePlan)})`);
  await page.waitForFunction(() => !!window.__adaptiveHeard, null, { timeout: 15000 });
  const heard = await page.evaluate(() => window.__adaptiveHeard);
  check(heard.style === adaptivePlan.style && Math.abs(heard.cue - adaptivePlan.cue) < 0.25, `real deck transport follows the selected adaptive cue (${JSON.stringify({ heard, plan: adaptivePlan })})`);
  await page.waitForFunction(() => !window.opendj.automix.transition, null, { timeout: 40000 });
  await page.evaluate(async () => {
    const app = window.opendj; app.automix.stop();
    for (const d of app.engine.decks.slice(0, 2)) d.pause();
    for (const [id, track] of window.__adaptiveOriginal) {
      app.library.tracks.set(id, track);
      await fetch(`/api/tracks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(track) });
    }
    app.settings.automix = window.__adaptiveSaved.automix; app.settings.mixLearning = window.__adaptiveSaved.learning;
  });

  // empty decks: automix would otherwise start with the tracks left on them (tested in A2)
  const ejectDecks = () => page.evaluate(() => { for (const d of window.opendj.engine.decks.slice(0, 2)) { d.pause(); d.eject(); } });

  // ================= A) smart mix from the demo library =================
  await ejectDecks();
  await page.evaluate(() => window.opendj.setSetting('automix', { ...window.opendj.settings.automix, style: 'blend', transitionBeats: 16 }));
  const sm = await page.evaluate(async () => {
    const a = window.opendj;
    await a.startAutomix([...a.library.tracks.values()], { mode: 'smart', shape: 'warmup' });
    const am = a.automix;
    return { enabled: am.enabled, mode: am.mode, n: am.queue.length, reasons: am.queue.map((t) => am.reasons.get(t) || ''), energy: am.queue.map((t) => a.library.track(t.id)?.energy), titles: am.queue.map((t) => t.title) };
  });
  console.log('smart order:', sm.titles.map((t, i) => `${t} [${sm.reasons[i]}]`).join('\n  '));
  check(sm.enabled && sm.mode === 'smart' && sm.n === DEMO.length, `smart mix ordered the demo library (${sm.n} tracks)`);
  check(sm.reasons.slice(1).every((r) => /BPM/.test(r) && /→/.test(r)), 'every transition explained (key → key, BPM → BPM…)');
  const eMax = Math.max(...sm.energy), topAt = sm.energy.indexOf(eMax);
  check(sm.energy[0] <= Math.min(...sm.energy) + 1 && topAt > 0, `warm-up shape: starts low, peaks later (energy ${sm.energy.join(' ')})`);
  for (let k = 0; k < 2; k++) {
    await waitNextLoaded();
    const before = await page.evaluate(() => window.opendj.automix.idx);
    await page.evaluate(() => { const a = window.opendj.automix; const nt = a.nextTransition(); a.current.seek(Math.max(0, nt.begin - 1)); });
    await page.waitForFunction((b) => { const a = window.opendj.automix; return a.idx > b && !a.transition && a.current.playing; }, before, { timeout: 40000 });
    const st = await page.evaluate(() => ({ idx: window.opendj.automix.idx, title: window.opendj.automix.current.track.title }));
    check(st.title === sm.titles[st.idx - 1], `smart mix transition ${k + 1} done, now playing "${st.title}" (queue order)`);
  }
  // the queue panel shows the next transition and the reasons
  await page.locator('.am-queue-btn').click();
  const qp = await page.evaluate(() => ({ head: document.querySelector('.am-queue-next')?.textContent, items: document.querySelectorAll('.am-q-item').length, meta: document.querySelector('.am-q-meta')?.textContent }));
  check(/Next transition: .+ in \d\d:\d\d/.test(qp.head) && qp.items >= 1 && /BPM/.test(qp.meta), `queue panel: "${qp.head}"`);
  await page.locator('.am-queue-btn').click();
  await page.evaluate(() => window.opendj.automix.stop());

  // ================= A2) AUTOMIX starts with the tracks the DJ loaded; ▾ menu: endless library mix =================
  await ejectDecks();
  const loaded = await page.evaluate(async () => {
    const a = window.opendj, all = [...a.library.tracks.values()];
    await a.loadTrack(0, all[2].id); await a.loadTrack(1, all[4].id);
    const loads = []; const orig = a.loadTrack.bind(a);
    a.loadTrack = (i, id, o) => { loads.push([i, id]); return orig(i, id, o); };
    await a.automixFrom({ kind: 'library' }, { mode: 'shuffle', length: 'endless' });
    a.loadTrack = orig;
    const [d1, d2] = a.engine.decks, am = a.automix;
    return { playing: d1.playing, cur: am.current === d1, first: am.queue[0].id, next: am.nextTrack()?.id, want: [all[2].id, all[4].id], d2: d2.track?.id, loads, upcoming: am.queue.length - am.idx, refill: !!am.refill?.endless };
  });
  check(loaded.playing && loaded.cur && loaded.first === loaded.want[0], 'AUTOMIX plays the track loaded on deck 1 first');
  check(loaded.next === loaded.want[1] && loaded.d2 === loaded.want[1] && !loaded.loads.length, 'the track loaded on deck 2 plays next (not reloaded)');
  check(loaded.refill && loaded.upcoming >= 2, `endless library mix keeps tracks queued (${loaded.upcoming} upcoming)`);
  await page.evaluate(() => window.opendj.automix.stop());
  await page.locator('.am-menu-btn').click();
  const menu = await page.evaluate(() => [...document.querySelectorAll('.am-menu .ctx-item')].map((x) => x.textContent));
  check(menu.some((x) => /Shuffle the whole library/.test(x)) && menu.some((x) => /Mix a playlist/.test(x)) && menu.some((x) => /Mix genres/.test(x)) && menu.some((x) => /1 hour/.test(x)), `▾ menu offers library / playlist / genres / timed / endless (${menu.length} items)`);
  await page.locator('.am-menu .ctx-item', { hasText: 'Mix genres' }).click();
  await page.waitForSelector('[data-am="genres"]');
  const dlg = await page.evaluate(() => ({ src: document.querySelector('[data-am="source"]').value, genres: document.querySelectorAll('[data-am="genres"] input').length, length: document.querySelector('[data-am="length"]').options.length }));
  check(dlg.src === 'genres' && dlg.genres > 0 && dlg.length === 6, `Automix dialog: genres source with ${dlg.genres} genres, ${dlg.length} set lengths`);
  await page.keyboard.press('Escape');
  await ejectDecks();

  // ================= A3) blends stay in phase: the incoming deck starts on the beat and is held there =================
  const phase = await page.evaluate(async () => {
    const a = window.opendj;
    await a.setSetting('automix', { ...a.settings.automix, style: 'blend', transitionBeats: 16, lengthMode: 'fixed', varyStyles: false, keepSync: true, keySync: false });
    const house = [...a.library.tracks.values()].filter((t) => t.bpm > 115 && t.bpm < 132).sort((x, y) => x.bpm - y.bpm).slice(0, 2);
    await a.automix.start(house, { mode: 'order' });
    for (let i = 0; i < 100 && !(a.automix.other(a.automix.current).track?.id === house[1].id && !a.automix.other(a.automix.current).loading); i++) await new Promise((r) => setTimeout(r, 100));
    const am = a.automix, nt = am.nextTransition();
    am.current.seek(Math.max(0, nt.begin - 0.5));
    for (let i = 0; i < 60 && !am.transition; i++) await new Promise((r) => setTimeout(r, 50));
    const tr = am.transition; if (!tr) return { error: 'no transition' };
    const { phaseErrorSeconds } = await import('/js/automix.js');
    const { audibleOffset } = await import('/js/audio/beat-phase.js');
    const errs = [], heard = [];
    // a busy main thread right as it starts (what makes a late start), then sample the phase for 3 s
    const t0 = performance.now(); while (performance.now() - t0 < 40) { /* block */ }
    for (let i = 0; i < 30 && am.transition === tr; i++) { await new Promise((r) => setTimeout(r, 100)); const t = a.engine.ctx.currentTime, e = phaseErrorSeconds(tr.out, tr.inn, t); if (e != null && i >= 3) errs.push(Math.abs(e) * 1000);
      const h = tr.out.onsets && tr.inn.onsets ? audibleOffset({ curve: tr.out.onsets, pos: tr.out.positionAt(t), rate: tr.out.rate }, { curve: tr.inn.onsets, pos: tr.inn.positionAt(t), rate: tr.inn.rate }) : null;
      if (h && i >= 5) heard.push(Math.abs(h.offset) * 1000); }
    am.stop();
    for (const d of a.engine.decks.slice(0, 2)) { d.pause(); d.eject(); }
    errs.sort((x, y) => x - y); heard.sort((x, y) => x - y);
    return { n: errs.length, median: errs[errs.length >> 1], max: errs.at(-1), heardN: heard.length, heardMedian: heard[heard.length >> 1], heardMax: heard.at(-1), source: tr.phaseSource };
  });
  check(!phase.error && phase.n >= 10 && phase.median < 5 && phase.max < 15, `blend stays in phase on the grids (median ${phase.median?.toFixed(1)} ms, max ${phase.max?.toFixed(1)} ms over ${phase.n} samples)`);
  check(phase.heardN >= 10 && phase.heardMedian < 3 && phase.heardMax < 8, `blend stays in phase by ear: the kicks land together (median ${phase.heardMedian?.toFixed(1)} ms, max ${phase.heardMax?.toFixed(1)} ms over ${phase.heardN} samples; keeper used: ${phase.source})`);

  // ================= B) every transition style: level, clipping, clicks =================
  const STYLES = ['blend', 'bassswap', 'crossfade', 'filter', 'echo', 'cut', 'backspin', 'brake', 'loop', 'reverb'];
  await page.evaluate(async () => {
    const a = window.opendj;
    for (const d of a.engine.decks.slice(0, 2)) { d.pause(); d.eject(); }
    await a.setSetting('automix', { ...a.settings.automix, style: 'blend', transitionBeats: 8, varyStyles: false, keySync: false });
    const house = [...a.library.tracks.values()].filter((t) => t.bpm > 115 && t.bpm < 132).sort((x, y) => x.bpm - y.bpm).slice(0, 3);
    const q = []; for (let i = 0; i < 14; i++) q.push(house[i % house.length]);
    await a.automix.start(q, { mode: 'order' });
  });
  const results = [];
  for (const style of STYLES) {
    await page.evaluate((s) => window.opendj.setSetting('automix', { ...window.opendj.settings.automix, style: s }), style);
    await waitNextLoaded();
    const info = await page.evaluate(() => { const a = window.opendj.automix, nt = a.nextTransition(); a.current.seek(Math.max(0, nt.begin - 3)); return { style: nt.style, begin: nt.begin, idx: a.idx, ctx: window.opendj.engine.ctx.currentTime }; });
    if (info.style !== style) throw new CheckError(`next transition style is ${info.style}, expected ${style}`);
    await page.waitForFunction(() => !!window.opendj.automix.transition, null, { timeout: 15000 });
    const tStart = await page.evaluate(() => window.opendj.engine.ctx.currentTime);
    await page.waitForFunction((b) => { const a = window.opendj.automix; return a.idx > b && !a.transition; }, info.idx, { timeout: 40000 });
    await sleep(1500);
    const r = await page.evaluate(({ c0, tStart }) => {
      const a = window.opendj.automix, f = window.__frames;
      const pre = f.filter((x) => x[0] > c0 + 0.3 && x[0] < tStart - 0.1), during = f.filter((x) => x[0] >= tStart);
      const rms = (fr) => Math.sqrt(fr.reduce((s, x) => s + x[1] * x[1], 0) / Math.max(1, fr.length));
      const steady = rms(pre);
      // 500 ms RMS windows (about a beat: kicks and gaps average out) during and after the transition
      const win = []; for (let i = 0; i + 10 <= during.length; i++) win.push(rms(during.slice(i, i + 10)));
      const after = during.slice(-20);
      return {
        steady, minRatio: Math.min(...win) / steady, maxRatio: Math.max(...win) / steady, afterRatio: rms(after) / steady,
        lowMs: win.filter((w) => w < steady * 0.25).length * 50, peak: Math.max(...during.map((x) => x[2])),
        clickBase: Math.max(...pre.map((x) => x[3])), click: Math.max(...during.map((x) => x[3])),
        playing: a.current.playing, other: a.other(a.current).playing,
        series: during.map((x) => `${(x[0] - tStart).toFixed(2)}:${(x[1] / steady).toFixed(2)}`).join(' '),
      };
    }, { c0: info.ctx, tStart });
    results.push({ style, ...r });
    if (process.env.DEBUG_AM) console.log(r.series);
    console.log(`${style.padEnd(9)} steady ${r.steady.toFixed(3)}  min ${r.minRatio.toFixed(2)}  max ${r.maxRatio.toFixed(2)}  after ${r.afterRatio.toFixed(2)}  <25% ${r.lowMs} ms  peak ${r.peak.toFixed(3)}  click ${r.click.toFixed(3)} (base ${r.clickBase.toFixed(3)})`);
    check(r.playing && !r.other, `${style}: transition finished, incoming deck playing alone`);
    check(r.peak < 1.0, `${style}: no clipping (peak ${r.peak.toFixed(3)})`);
    check(r.maxRatio < 2.0, `${style}: no level bump (max ${r.maxRatio.toFixed(2)}× the level before)`);
    check(r.afterRatio > 0.5 && r.afterRatio < 2.0, `${style}: level after the transition consistent (${r.afterRatio.toFixed(2)}×)`);
    const gapOk = ['backspin', 'brake', 'cut', 'loop'].includes(style) ? r.lowMs <= 400 : r.lowMs === 0;
    check(gapOk && r.minRatio > (['blend', 'bassswap', 'crossfade', 'filter'].includes(style) ? 0.3 : 0.02), `${style}: no dropout (lowest ${r.minRatio.toFixed(2)}×, ${r.lowMs} ms below 25 %)`);
    if (!['backspin', 'brake', 'reverb'].includes(style)) check(r.click < Math.max(r.clickBase * 2, 0.08), `${style}: no clicks (2nd-difference peak ${r.click.toFixed(3)}, ${r.clickBase.toFixed(3)} before)`);
  }
  // auto picks a style per pair and the tempo restore still runs
  await page.evaluate(() => window.opendj.setSetting('automix', { ...window.opendj.settings.automix, style: 'auto' }));
  await waitNextLoaded();
  const auto = await page.evaluate(() => window.opendj.automix.nextTransition());
  check(auto.style !== 'auto' && auto.why, `auto style: "${auto.style}" (${auto.why})`);
  await page.evaluate(() => window.opendj.automix.stop());

  // big tempo gaps are never beat-matched (QA M3): a forced blend style falls back to echo out / cut (and says so),
  // drop styles start the incoming track at its own tempo, and there is no tempo glide afterwards
  for (const [style, from, to] of [['crossfade', 'Saturday Satellite', 'Iron Meridian'], ['cut', 'Midnight Transit', 'Pressure Index']]) {
    await page.evaluate(async ({ style, from, to }) => {
      const a = window.opendj;
      for (const d of a.engine.decks.slice(0, 2)) { d.pause(); d.eject(); }
      await a.setSetting('automix', { ...a.settings.automix, style, transitionBeats: 8, varyStyles: false });
      const all = [...a.library.tracks.values()], t = (x) => all.find((y) => y.title === x);
      await a.automix.start([t(from), t(to), t(from)], { mode: 'order' });
    }, { style, from, to });
    await waitNextLoaded();
    const nt = await page.evaluate(() => {
      const a = window.opendj.automix, nt = a.nextTransition();
      const off = a.on('transition', () => { const tr = a.transition; window.__amStart = { style: tr.style, why: tr.why, inTempo: tr.inn.tempo, inSync: tr.inn.syncOn }; off(); });
      a.current.seek(Math.max(0, nt.begin - 2)); return nt;
    });
    await page.waitForFunction(() => !!window.__amStart, null, { timeout: 15000 });
    const during = await page.evaluate(() => { const r = window.__amStart; window.__amStart = null; return r; });
    await page.waitForFunction(() => !window.opendj.automix.transition, null, { timeout: 40000 });
    const after = await page.evaluate(() => { const a = window.opendj.automix; return { tempo: a.current.tempo, ramp: !!a.tempoRamp }; });
    if (style === 'crossfade') check(['echo', 'cut'].includes(nt.style) && /too far to beat-match/.test(nt.why) && during.style === nt.style, `118 → 130 BPM with Crossfade chosen: ${nt.style} instead ("${nt.why}")`);
    check(Math.abs(during.inTempo) < 0.01 && !during.inSync && Math.abs(after.tempo) < 0.01 && !after.ramp, `${style === 'crossfade' ? '118 → 130 BPM' : 'cut 124 → 126 BPM'}: incoming track at its own tempo (${during.inTempo.toFixed(2)} %), no tempo glide afterwards`);
    await page.evaluate(() => window.opendj.automix.stop());
  }

  // ================= C) loading tracks while automix runs =================
  const ids = await page.evaluate(() => [...window.opendj.library.tracks.values()].map((t) => t.id));
  const startAm = () => page.evaluate(async () => {
    const a = window.opendj;
    for (const d of a.engine.decks.slice(0, 2)) { d.pause(); d.eject(); }
    await a.setSetting('automix', { ...a.settings.automix, style: 'blend', transitionBeats: 8, onAirLoad: 'ask' });
    const all = [...a.library.tracks.values()];
    await a.automix.start([all[0], all[1], all[2]], { mode: 'order' });
  });
  await startAm();
  await waitNextLoaded();
  /** Select a library row by track id (Collection view), scrolled into view. Returns its row element handle index. */
  const selectRow = async (id) => {
    await page.evaluate((tid) => { const L = window.opendj.library; if (L.view.kind !== 'all') L.setView({ kind: 'all' }, 'Collection'); L.search.value = ''; L.query = ''; L.applyView(); const i = L.rows.findIndex((t) => t.id === tid); L.cursor = i; L.selected = new Set([tid]); L.scroller.scrollTop = Math.max(0, i * 26 - 40); L.renderRows(true); }, id);
    await sleep(100);
    return page.locator(`.lib-rows .lr[data-i="${await page.evaluate((tid) => window.opendj.library.rows.findIndex((t) => t.id === tid), id)}"]`);
  };
  const state = () => page.evaluate(() => { const a = window.opendj.automix; return { enabled: a.enabled, next: a.nextTrack()?.id, cur: a.current?.track?.id, curPlaying: a.current?.playing, curIdx: a.current?.index, otherTrack: a.other(a.current)?.track?.id, transition: !!a.transition, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).at(-1) }; });
  const expectNext = async (id, how) => {
    await page.waitForFunction((tid) => { const a = window.opendj.automix, d = a.other(a.current); return a.enabled && a.nextTrack()?.id === tid && d.track?.id === tid && !d.loading; }, id, { timeout: 20000 }).catch(() => {});
    const s = await state();
    check(s.enabled && s.next === id && s.otherTrack === id && s.curPlaying, `${how}: the picked track is next and loaded on the next deck, automix keeps playing ("${s.toast}")`);
  };
  const nextDeck = await page.evaluate(() => { const a = window.opendj.automix; return a.other(a.current).index; });
  // context menu "Load to deck N" on the next deck
  let row = await selectRow(ids[3]);
  await row.click({ button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: `Load to deck ${nextDeck + 1}` }).click();
  await expectNext(ids[3], 'context menu → next deck');
  // double-click (loads on the free deck = the next deck)
  row = await selectRow(ids[4]);
  await row.dblclick();
  await expectNext(ids[4], 'double-click');
  // drag & drop onto the next deck
  await page.evaluate(({ tid, d }) => { const dt = new DataTransfer(); dt.setData('text/x-opendj-track', tid); document.querySelector(`.deck[data-deck="${d}"]`).dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }, { tid: ids[5], d: nextDeck });
  await expectNext(ids[5], 'drag & drop');
  // keyboard: Shift + arrow loads the selected track on deck 1 (←) / 2 (→)
  row = await selectRow(ids[3]);
  await row.click();
  await page.keyboard.down('Shift'); await page.keyboard.press(nextDeck === 1 ? 'ArrowRight' : 'ArrowLeft'); await page.keyboard.up('Shift');
  await expectNext(ids[3], 'keyboard (Shift+arrow)');
  // MIDI "load" button of the next deck
  await selectRow(ids[4]);
  await page.evaluate((d) => window.opendj.midi.byId.get(`deck${d + 1}.load`).handler(true), nextDeck);
  await expectNext(ids[4], 'MIDI load');
  // the on-air deck: asks; "Play next" queues it and never cuts the live track
  const onAir = await state();
  row = await selectRow(ids[5]);
  await row.click({ button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: `Load to deck ${onAir.curIdx + 1}` }).click();
  await page.locator('.overlay button', { hasText: 'Play next' }).click({ timeout: 5000 });
  await expectNext(ids[5], 'on-air deck → "Play next"');
  check((await state()).cur === onAir.cur, 'on-air deck kept its live track');
  // during a transition: queued for afterwards, the incoming deck is not reloaded mid-mix
  await page.evaluate(() => window.opendj.automix.skip());
  await page.waitForFunction(() => !!window.opendj.automix.transition, null, { timeout: 10000 });
  const mid = await page.evaluate(() => { const t = window.opendj.automix.transition; return { inn: t.inn.track.id, innIdx: t.inn.index }; });
  await page.evaluate(({ tid, d }) => window.opendj.loadTrack(d, tid), { tid: ids[0], d: mid.innIdx });
  const during = await state();
  check(during.transition && during.next === ids[0] && /plays next/.test(during.toast || ''), `during a transition: queued next ("${during.toast}")`);
  check(await page.evaluate(() => window.opendj.automix.transition?.inn.track.id), 'incoming deck untouched mid-transition');
  await page.waitForFunction(() => !window.opendj.automix.transition, null, { timeout: 30000 });
  check((await state()).cur === mid.inn, 'transition completed into the track it started with');
  await expectNext(ids[0], 'after the transition the queued pick');
  // on-air deck with "Stop automix & load": automix stops, the track loads there
  const live = await state();
  row = await selectRow(ids[2]);
  await row.click({ button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: `Load to deck ${live.curIdx + 1}` }).click();
  await page.locator('.overlay button', { hasText: 'Stop automix & load' }).click({ timeout: 5000 });
  await page.waitForFunction(({ d, tid }) => window.opendj.engine.decks[d].track?.id === tid && !window.opendj.engine.decks[d].loading, { d: live.curIdx, tid: ids[2] }, { timeout: 20000 });
  check(!(await state()).enabled, 'on-air deck → "Stop automix & load": automix stopped and the track loaded');
  for (let d = 0; d < 2; d++) await page.evaluate((i) => window.opendj.engine.decks[i].pause(), d);

  // ================= C2) MIX NOW, queue edits and stopping during preload (handover checks) =================
  const startFive = () => page.evaluate(async () => {
    const a = window.opendj;
    a.automix.stop();
    for (const d of a.engine.decks.slice(0, 2)) { d.pause(); d.eject(); }
    await a.setSetting('automix', { ...a.settings.automix, style: 'blend', transitionBeats: 8, onAirLoad: 'ask' });
    await a.automix.start([...a.library.tracks.values()].slice(0, 5), { mode: 'order' });
  });
  await startFive();
  await waitNextLoaded();
  // repeated presses: the deck's MIX NOW seven times -> exactly one transition
  const presses = await page.evaluate(async () => {
    const a = window.opendj.automix, idx0 = a.idx, cur = a.current.index;
    let begun = 0; const orig = a.beginTransition.bind(a); a.beginTransition = (...x) => { begun++; return orig(...x); };
    const btn = document.querySelector(`.deck[data-deck="${cur}"] .deck-mix-now`);
    const enabledBefore = !btn.disabled;
    for (let k = 0; k < 7; k++) btn.click();
    await new Promise((r) => setTimeout(r, 400));
    a.beginTransition = orig;
    return { begun, steps: a.idx - idx0, transition: !!a.transition, enabledBefore, disabledNow: btn.disabled, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).at(-1) };
  });
  check(presses.enabledBefore && presses.transition && presses.begun === 1 && presses.steps === 1 && presses.disabledNow, `MIX NOW pressed 7 times: one transition, queue advanced by one, button disabled during it ("${presses.toast}")`);
  // queue edits during the transition: move the last track to play next, remove one -> the mix finishes, the edit wins
  const edit = await page.evaluate(() => {
    const a = window.opendj.automix, last = a.queue.length - 1, want = a.queue[last].id;
    a.move(last, a.idx); a.remove(a.queue.length - 1);
    return { want, inn: a.transition?.inn.track.id, qlen: a.queue.length };
  });
  await page.waitForFunction(() => !window.opendj.automix.transition, null, { timeout: 30000 });
  check((await state()).cur === edit.inn, 'queue edited mid-transition: the transition still completes into its incoming track');
  await expectNext(edit.want, 'queue edited mid-transition');
  // MIX NOW while the next deck is still loading: waits for the preload, then mixes into the edited next track
  const prep = await page.evaluate(async () => {
    const a = window.opendj.automix;
    const held = new Set(window.opendj.engine.decks.slice(0, 2).map((d) => d.track?.id));
    a.insertNext([...window.opendj.library.tracks.values()].find((t) => !held.has(t.id))); // the next deck does not hold it yet
    const want = a.nextTrack().id, r = a.skip(), r2 = a.skip();      // pressed twice while preparing
    return { r, r2, want, pending: a.forceTransitionRequested };
  });
  check(prep.r === 'preparing' && prep.r2 === 'preparing' && prep.pending, 'MIX NOW during the preload: "preparing", transition requested once');
  await page.waitForFunction(() => !!window.opendj.automix.transition, null, { timeout: 30000 });
  check(await page.evaluate(() => window.opendj.automix.transition.inn.track.id) === prep.want, 'the requested transition starts as soon as the edited next track is loaded');
  await page.waitForFunction(() => !window.opendj.automix.transition, null, { timeout: 30000 });
  // stop while the forced transition waits for its preload: nothing starts afterwards
  const stopPrep = await page.evaluate(async () => {
    const a = window.opendj.automix;
    // queue a track that neither deck holds, as the next one, then press MIX NOW and stop right away
    const held = new Set(window.opendj.engine.decks.slice(0, 2).map((d) => d.track?.id));
    a.insertNext([...window.opendj.library.tracks.values()].find((t) => !held.has(t.id)));
    const r = a.skip(); a.stop();
    await new Promise((res) => setTimeout(res, 4000));
    return { r, enabled: a.enabled, transition: !!a.transition, pending: a.forceTransitionRequested, playing: window.opendj.engine.decks.slice(0, 2).filter((d) => d.playing).length };
  });
  check(stopPrep.r === 'preparing' && !stopPrep.enabled && !stopPrep.transition && !stopPrep.pending && stopPrep.playing === 1, `stop while MIX NOW waits for the preload: no transition afterwards, only the live deck plays (${JSON.stringify(stopPrep)})`);
  // stop while automix loads its FIRST track (decks stopped): it must not start playing once the load finishes
  const stopFirst = await page.evaluate(async () => {
    const a = window.opendj; a.automix.stop();
    for (const d of a.engine.decks) { d.pause(); d.eject(); }
    const before = document.querySelectorAll('.toast').length;
    const p = a.automix.start([...a.library.tracks.values()].slice(2, 5), { mode: 'order' }).then(() => 'ok', (e) => e.message);
    await new Promise((r) => setTimeout(r, 30)); a.automix.stop();
    const res = await p; await new Promise((r) => setTimeout(r, 1500));
    const toasts = [...document.querySelectorAll('.toast')].slice(before).map((t) => t.textContent);
    return { res, enabled: a.automix.enabled, playing: a.engine.decks.filter((d) => d.playing).length, toasts };
  });
  check(stopFirst.res === 'ok' && !stopFirst.enabled && stopFirst.playing === 0 && !stopFirst.toasts.some((t) => /could be loaded/.test(t)), `stop during the first track's preload: nothing plays, no load error (${JSON.stringify(stopFirst)})`);
  // AUTOMIX (one click, no dialog): starts a smart mix of the library view; again while starting = cancel;
  // repeated starts are coalesced; Shift-click / right-click opens the options dialog; no AUTOMIX NOW button any more
  const oneClick = await page.evaluate(async () => {
    const a = window.opendj; a.automix.stop(); for (const d of a.engine.decks) { d.pause(); d.eject(); }
    a.automix.queue = []; a.automix.idx = 0;
    a.library.setView({ kind: 'all' }, 'Collection');
    let starts = 0, mode = null; const orig = a.automix.start.bind(a.automix); a.automix.start = (l, o) => { starts++; mode = o.mode; return orig(l, o); };
    document.querySelector('.automix-btn').click();
    await Promise.all([a.automixStart(), a.automixStart()]);
    for (let k = 0; k < 100 && !(a.automix.enabled && a.automix.current?.playing); k++) await new Promise((r) => setTimeout(r, 100));
    a.automix.start = orig;
    const dialog = !!document.querySelector('.overlay select[data-am="mode"]');
    const r = { starts, mode, enabled: a.automix.enabled, playing: !!a.automix.current?.playing, dialog, nowBtn: document.querySelectorAll('.am-now-btn').length };
    document.querySelector('.automix-btn').click(); // stop
    r.stopped = !a.automix.enabled;
    document.querySelector('.automix-btn').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await new Promise((res) => setTimeout(res, 200));
    r.shiftDialog = !!document.querySelector('.overlay select[data-am="mode"]');
    document.querySelector('.overlay .modal-x')?.click(); document.querySelectorAll('.overlay').forEach((o) => o.querySelector('button')?.textContent === 'Cancel' && o.querySelector('button').click());
    await new Promise((res) => setTimeout(res, 100));
    document.querySelector('.automix-btn').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise((res) => setTimeout(res, 200));
    r.ctxDialog = !!document.querySelector('.overlay select[data-am="mode"]');
    document.querySelectorAll('.overlay').forEach((o) => o.remove());
    return r;
  });
  check(oneClick.starts === 1 && oneClick.mode === 'smart' && oneClick.enabled && oneClick.playing && !oneClick.dialog && oneClick.nowBtn === 0, `AUTOMIX starts a smart mix in one click, no dialog, repeated starts coalesced (${JSON.stringify(oneClick)})`);
  check(oneClick.stopped && oneClick.shiftDialog && oneClick.ctxDialog, 'AUTOMIX again stops; Shift-click and right-click open the Automix options');
  // the remaining queue wins over the library view
  const fromQueue = await page.evaluate(async () => {
    const a = window.opendj; const all = [...a.library.tracks.values()];
    a.automix.queue = [all[3], all[4]]; a.automix.idx = 0;
    let got = null; const orig = a.automix.start.bind(a.automix); a.automix.start = (l, o) => { got = l.map((t) => t.id); return orig(l, o); };
    a.toggleAutomix();
    for (let k = 0; k < 100 && !got; k++) await new Promise((r) => setTimeout(r, 50));
    a.automix.start = orig;
    return { got: (got || []).sort(), want: [all[3].id, all[4].id].sort() };
  });
  check(JSON.stringify(fromQueue.got) === JSON.stringify(fromQueue.want), 'AUTOMIX (key A / MIDI automix.toggle) starts from the remaining queue when there is one');
  await page.evaluate(() => { window.opendj.automix.stop(); for (const d of window.opendj.engine.decks) { d.pause(); d.eject(); } });

  // ================= D) media-server playlists → automix =================
  const add = await page.evaluate(async (url) => (await fetch('/api/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'subsonic', name: 'Navidrome', url, username: 'dj', password: 'secret' }) })).json(), sub.url);
  check(add.source?.id, 'fake Subsonic server connected');
  await page.evaluate(() => window.opendj.library.refresh());
  await page.waitForSelector('.tree-item[data-remote-pl="p1"]', { timeout: 15000 });
  check(true, 'sidebar lists the server\'s playlist "Friday Night"');
  await page.locator('.tree-item[data-remote-pl="p1"] .ti-label').click();
  await page.waitForFunction(() => window.opendj.library.view.kind === 'playlist' && window.opendj.library.rows.length === 3, null, { timeout: 15000 });
  const rows = await page.evaluate(() => window.opendj.library.rows.map((t) => t.title));
  check(rows.join(',') === 'Remote 2,Remote 1,Remote 3', `opened: tracks in playlist order (${rows.join(', ')})`);
  await page.locator('.tree-item[data-remote-pl="p1"]').hover(); // row actions open on hover
  await page.locator('.tree-item[data-remote-pl="p1"] .ti-act').click();
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Smart mix' }).click();
  await page.locator('.overlay select[data-am="mode"]').waitFor({ timeout: 10000 });
  check(await page.evaluate(() => document.querySelector('.overlay select[data-am="mode"]').value) === 'smart', 'playlist "Smart mix" opens automix in smart mode');
  await page.locator('.overlay button', { hasText: 'Start automix' }).click();
  await page.waitForFunction(() => window.opendj.automix.enabled && window.opendj.automix.current?.playing, null, { timeout: 60000 });
  const pm = await page.evaluate(() => { const a = window.opendj.automix; return { mode: a.mode, n: a.queue.length, src: a.queue.map((t) => window.opendj.library.track(t.id)?.sourceType), first: a.current.track.title }; });
  check(pm.mode === 'smart' && pm.n === 3 && pm.src.every((s) => s === 'remote'), `media-server playlist smart-mixed (${pm.n} remote tracks, starts with "${pm.first}")`);
  await waitNextLoaded();
  const pidx = await page.evaluate(() => window.opendj.automix.idx);
  await page.evaluate(() => { const a = window.opendj.automix; a.current.seek(Math.max(0, a.nextTransition().begin - 1)); });
  await page.waitForFunction((b) => { const a = window.opendj.automix; return a.idx > b && !a.transition && a.current.playing; }, pidx, { timeout: 40000 });
  check(true, 'transition between streamed media-server tracks');
  await page.evaluate(() => window.opendj.automix.stop());
  // "Shuffle & mix" from the same menu
  await page.locator('.tree-item[data-remote-pl="p1"]').hover(); // row actions open on hover
  await page.locator('.tree-item[data-remote-pl="p1"] .ti-act').click();
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Shuffle & mix' }).click();
  await page.locator('.overlay button', { hasText: 'Start automix' }).click();
  await page.waitForFunction(() => window.opendj.automix.enabled && window.opendj.automix.mode === 'shuffle', null, { timeout: 30000 });
  check(true, 'playlist "Shuffle & mix" starts a shuffled automix');
  await page.evaluate(() => window.opendj.automix.stop());

  // ================= E) local mode (mobile app backend, ?local=1): sampler, smart mix, media-server playlists =================
  // bypassCSP stands in for the app's native networking (CapacitorHttp): the page CSP only allows 'self', so in a
  // plain browser the on-device backend cannot reach a media server at all
  const lctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, bypassCSP: true });
  const lp = await lctx.newPage();
  const lerr = [];
  lp.on('pageerror', (e) => lerr.push(String(e)));
  lp.on('console', (m) => { if (m.type() === 'error') lerr.push(m.text()); });
  await lp.goto(app.url + '?local=1');
  await lp.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
  await lp.evaluate(() => window.opendj.engine.resume());
  await lp.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
  const wavs = [[124, 220], [126, 196], [125, 246.9]].map(([bpm, hz], i) => ({ name: `Local Artist ${i + 1} - Pocket ${i + 1}.wav`, b64: beatWav({ bpm, hz, seconds: 32 }).toString('base64') }));
  await lp.evaluate(async (files) => {
    const { api } = await import('/js/api.js');
    for (const f of files) { const bin = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)); await api.upload(new File([bin], f.name, { type: 'audio/wav' })); }
    await window.opendj.library.refresh();
  }, wavs);
  await lp.waitForFunction(() => window.opendj.library.tracks.size >= 3 && [...window.opendj.library.tracks.values()].every((t) => t.analyzed), null, { timeout: 120000 });
  const lsamp = await lp.evaluate(async () => { const s = window.opendj.engine.sampler; await s.ready; return s.slots.every((x) => x.buffer) && s.slots[0].buffer.duration > 0.3; }); // pad 1: the recorded air horn (0.53 s)
  check(lsamp, 'local mode: sampler bank rendered');
  await lp.evaluate(async () => { const a = window.opendj; await a.setSetting('automix', { ...a.settings.automix, style: 'auto', transitionBeats: 8 }); await a.startAutomix([...a.library.tracks.values()], { mode: 'smart', shape: 'rising' }); });
  const lsm = await lp.evaluate(() => { const a = window.opendj.automix; return { on: a.enabled, mode: a.mode, n: a.queue.length, reason: a.reasons.get(a.queue[1]) }; });
  check(lsm.on && lsm.mode === 'smart' && lsm.n === 3 && /BPM/.test(lsm.reason || ''), `local mode: smart mix running (${lsm.reason})`);
  await lp.waitForFunction(() => { const a = window.opendj.automix, d = a.other(a.current), n = a.nextTrack(); return d.track?.id === n?.id && !d.loading; }, null, { timeout: 30000 });
  const lidx = await lp.evaluate(() => { const a = window.opendj.automix; a.current.seek(Math.max(0, a.nextTransition().begin - 1)); return a.idx; });
  await lp.waitForFunction((b) => { const a = window.opendj.automix; return a.idx > b && !a.transition && a.current.playing; }, lidx, { timeout: 40000 });
  check(true, 'local mode: automix transition done');
  await lp.evaluate(() => window.opendj.automix.stop());
  const ladd = await lp.evaluate(async (url) => { const { api } = await import('/js/api.js'); return api.addSource({ type: 'subsonic', name: 'Phone Navi', url, username: 'dj', password: 'secret' }); }, sub.url);
  check(ladd.source?.id, 'local mode: media server connected from the page');
  await lp.evaluate(() => window.opendj.library.refresh());
  await lp.waitForSelector('.tree-item[data-remote-pl="p1"]', { timeout: 20000 });
  await lp.locator('.tree-item[data-remote-pl="p1"]').hover(); // row actions open on hover
  await lp.locator('.tree-item[data-remote-pl="p1"] .ti-act').click();
  await lp.locator('.ctx-menu .ctx-item', { hasText: 'Shuffle & mix' }).click();
  await lp.locator('.overlay button', { hasText: 'Start automix' }).click();
  await lp.waitForFunction(() => window.opendj.automix.enabled && window.opendj.automix.mode === 'shuffle' && window.opendj.automix.current?.playing, null, { timeout: 60000 });
  const lq = await lp.evaluate(() => { const a = window.opendj.automix; return a.queue.slice(a.idx).map((t) => window.opendj.library.track(t.id)?.sourceType); }); // upcoming (the deck still playing stays first)
  check(lq.filter((x) => x === 'remote').length === 3, `local mode: media-server playlist "Shuffle & mix" plays the remote tracks (upcoming: ${lq.join(", ")})`);
  await lp.evaluate(() => window.opendj.automix.stop());
  const lbad = lerr.filter((e) => !/Failed to load resource/.test(e));
  check(lbad.length === 0, `local mode: no console errors ${lbad.join(' | ')}`);
  await lctx.close();

  const bad = errors.filter((e) => !/Failed to load resource/.test(e));
  check(bad.length === 0, `no console errors ${bad.join(' | ')}`);
  console.log('\nE2E AUTOMIX PASSED');
} catch (e) {
  console.error('FAIL:', e.message);
  if (!(e instanceof CheckError)) console.error(e);
  console.error(errors.join('\n'));
  await page.screenshot({ path: path.join(tmp, 'fail.png') }).catch(() => {});
  console.error('screenshot', path.join(tmp, 'fail.png'));
  process.exitCode = 1;
} finally {
  await browser.close(); app.server.close(); app.shutdown(); await sub.close();
  if (!process.exitCode) fs.rmSync(tmp, { recursive: true, force: true });
}
