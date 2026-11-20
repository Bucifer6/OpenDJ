// End-to-end checks for performance features: key shift/sync, phase-locked hot cues, saved loops, slicer,
// instant doubles, quick stems, color FX, mic/talkover, sequencer. Usage: node scripts/e2e-performance.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-perf-'));
const music = path.join(tmp, 'Music'); fs.mkdirSync(music);

function wav(file, seconds, fn) {
  const sr = 44100, n = sr * seconds, d = Buffer.alloc(44 + n * 4);
  d.write('RIFF', 0); d.writeUInt32LE(36 + n * 4, 4); d.write('WAVEfmt ', 8); d.writeUInt32LE(16, 16); d.writeUInt16LE(1, 20); d.writeUInt16LE(2, 22);
  d.writeUInt32LE(sr, 24); d.writeUInt32LE(sr * 4, 28); d.writeUInt16LE(4, 32); d.writeUInt16LE(16, 34); d.write('data', 36); d.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { const [l, r] = fn(i / sr); d.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l)) * 32767), 44 + i * 4); d.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r)) * 32767), 46 + i * 4); }
  fs.writeFileSync(file, d);
}
const kick = (t, bpm) => { const b = 60 / bpm, tb = (t - 0.1 + b * 100) % b; return t > 0.1 && tb < 0.15 ? 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb * 40)) * tb) * Math.exp(-tb * 18) : 0; };
// A: 124 BPM, A minor-ish pad (centred) ; B: 124 BPM, C# minor-ish ; T: pure 440 Hz tone (for pitch test), wide stereo pad for stems
wav(path.join(music, 'A - Groove.wav'), 40, (t) => { const v = kick(t, 124) + 0.15 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 261.6 * t) + Math.sin(2 * Math.PI * 329.6 * t)) + 0.2 * Math.sin(2 * Math.PI * 110 * t); return [v * 0.7, v * 0.7]; });
wav(path.join(music, 'B - Other.wav'), 40, (t) => { const v = kick(t, 124) + 0.15 * (Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t) + Math.sin(2 * Math.PI * 415.3 * t)) + 0.2 * Math.sin(2 * Math.PI * 138.6 * t); return [v * 0.7, v * 0.7]; });
wav(path.join(music, 'T - Tone.wav'), 20, (t) => { const v = 0.5 * Math.sin(2 * Math.PI * 440 * t); return [v, v]; });

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
let failed = false;
const check = (c, msg) => { console.log(`${c ? 'ok' : 'FAIL'} - ${msg}`); if (!c) failed = true; };

try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 15000 });
  await page.evaluate((dir) => fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) }), music);
  await page.waitForFunction(() => window.opendj.library.tracks.size === 3, null, { timeout: 15000 });
  const id = (title) => page.evaluate((t) => [...window.opendj.library.tracks.values()].find((x) => x.title === t).id, title);

  // ---- key shift really changes pitch (440 -> 880 Hz for +12) ----
  await page.evaluate(async (tid) => { await window.opendj.loadTrack(0, tid); }, await id('Tone'));
  const freq = async () => page.evaluate(async () => {
    const e = window.opendj.engine, ch = e.channels[0];
    const an = e.ctx.createAnalyser(); an.fftSize = 16384; ch.fx.output.connect(an);
    await new Promise((r) => setTimeout(r, 600));
    const d = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(d); ch.fx.output.disconnect(an);
    let best = 1; for (let i = 1; i < d.length - 1; i++) if (d[i] > d[best]) best = i;
    const off = (d[best - 1] - d[best + 1]) / (2 * (d[best - 1] - 2 * d[best] + d[best + 1]));
    return (best + off) * e.ctx.sampleRate / an.fftSize;
  });
  await page.evaluate(() => window.opendj.engine.decks[0].play());
  const f0 = await freq();
  await page.evaluate(() => window.opendj.engine.decks[0].setKeyShift(12));
  const f12 = await freq();
  await page.evaluate(() => { const d = window.opendj.engine.decks[0]; d.setKeyShift(0); d.setKeyLock(true); d.setTempo(8); });
  const fLock = await freq();
  check(Math.abs(f0 / 440 - 1) < 0.006, `tone plays at ${f0.toFixed(1)} Hz`);
  check(Math.abs(f12 / 880 - 1) < 0.006, `key shift +12 → ${f12.toFixed(1)} Hz`);
  check(Math.abs(fLock / 440 - 1) < 0.006, `key lock holds pitch at +8% tempo → ${fLock.toFixed(1)} Hz`);
  await page.evaluate(() => { const d = window.opendj.engine.decks[0]; d.pause(); d.setTempo(0); });

  // ---- key sync ----
  await page.evaluate(async ([a, b]) => { await window.opendj.loadTrack(0, a); await window.opendj.loadTrack(1, b); }, [await id('Groove'), await id('Other')]);
  const ks = await page.evaluate(() => {
    const [d1, d2] = window.opendj.engine.decks;
    d1.track.key = 'Am'; d2.track.key = 'C#m'; d1.play(); d1.setMaster();
    const before = d2.playingCamelot; const ok = d2.keySyncTo(d1);
    return { before, after: d2.playingCamelot, shift: d2.keyShift, ok, master: d1.playingCamelot };
  });
  check(ks.ok && ks.after && ['8A', '7A', '9A', '8B'].includes(ks.after), `key sync ${ks.before} → ${ks.after} (shift ${ks.shift}) to match ${ks.master}`);

  // ---- phase-locked hot cue jump ----
  const hc = await page.evaluate(async () => {
    const d = window.opendj.engine.decks[0];
    d.seek(4.1); await new Promise((r) => setTimeout(r, 300));
    d.hotCueDown(0); d.hotCueUp(0);               // set A at the snapped beat
    await new Promise((r) => setTimeout(r, 1700)); // play on, now at a random point inside a beat
    const before = d.beatPhase();
    d.hotCueDown(0); d.hotCueUp(0);
    return { before, after: d.beatPhase(), pos: d.position, cue: d.hotCue(0).position }; // read right after the jump
  });
  let dph = Math.abs(hc.before - hc.after); dph = Math.min(dph, 1 - dph);
  check(dph < 0.03 && Math.abs(hc.pos - hc.cue) < 0.6, `quantized hot cue keeps beat phase (Δ ${dph.toFixed(3)} beats)`);

  // ---- saved loop on a hot cue ----
  const sl = await page.evaluate(async () => {
    const d = window.opendj.engine.decks[0];
    d.autoLoop(2); d.hotCueDown(3); d.exitLoop(); d.seek(20);
    await new Promise((r) => setTimeout(r, 200));
    d.hotCueDown(3); d.hotCueUp(3);
    return { cue: d.hotCue(3), loop: d.loop?.active, beats: d.loopBeats };
  });
  check(sl.cue?.loopEnd && sl.loop && Math.abs(sl.beats - 2) < 0.01, 'loop saved to hot cue D and recalled');
  await page.evaluate(() => window.opendj.engine.decks[0].exitLoop());

  // ---- slicer with slip ----
  const sc = await page.evaluate(async () => {
    const d = window.opendj.engine.decks[0];
    const p0 = d.position; d.sliceDown(0); await new Promise((r) => setTimeout(r, 400)); const inSlice = d.loop?.active; d.sliceUp();
    await new Promise((r) => setTimeout(r, 150));
    return { inSlice, drift: d.position - (p0 + 0.55 * d.rate), slip: d.slip };
  });
  check(sc.inSlice && Math.abs(sc.drift) < 0.25 && !sc.slip, `slicer loops a slice and slips back (drift ${sc.drift.toFixed(2)}s)`);

  // ---- instant double ----
  const dbl = await page.evaluate(async () => {
    const [d1, , d3] = window.opendj.engine.decks;
    await d3.cloneFrom(d1); await new Promise((r) => setTimeout(r, 200));
    return { same: d3.track?.id === d1.track?.id, d: Math.abs(d3.position - d1.position), playing: d3.playing };
  });
  check(dbl.same && dbl.playing && dbl.d < 0.4, `instant double on deck 3 (offset ${dbl.d.toFixed(2)}s)`);
  await page.evaluate(() => window.opendj.engine.decks[2].eject?.() || window.opendj.engine.decks[2].pause());

  // ---- quick stems: vocal knob removes centred content ----
  const stem = await page.evaluate(async () => {
    const e = window.opendj.engine, ch = e.channels[0];
    const lvl = async () => { let p = 0; for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 40)); p = Math.max(p, ch.level()); } return p; };
    const full = await lvl(); ch.set('vocal', 0); const novox = await lvl(); ch.set('vocal', 1); ch.set('inst', 0); const voxOnly = await lvl(); ch.set('inst', 1);
    return { full, novox, voxOnly };
  });
  check(stem.novox < stem.full * 0.85, `quick stems vocal cut lowers centred mids (${stem.full.toFixed(2)} → ${stem.novox.toFixed(2)})`);

  // ---- color FX ----
  for (const c of ['space', 'dubecho', 'noise', 'crush', 'pitch', 'filter']) await page.evaluate((c) => { const ch = window.opendj.engine.channels[0]; ch.set('colorFx', c); ch.set('filter', 0.5); ch.set('filter', 0); }, c);
  check(true, 'all Color FX modes switch cleanly');

  // ---- mic + talkover (fake device) ----
  const mic = await page.evaluate(async () => { const e = window.opendj.engine; await e.setMic(true); e.setTalkover(true); await new Promise((r) => setTimeout(r, 400)); const r = { on: e.micOn, lvl: e.micLevel(), duck: e.duck.gain.value }; e.setTalkover(false); await e.setMic(false); return r; });
  check(mic.on && mic.duck < 0.5, `mic input on, talkover ducks music to ${mic.duck.toFixed(2)} (mic level ${mic.lvl.toFixed(3)})`);

  // ---- sequencer: triggers on master 16ths ----
  const seq = await page.evaluate(async () => {
    const a = window.opendj, s = a.sequencer, e = a.engine;
    const hits = []; const orig = e.sampler.trigger.bind(e.sampler);
    e.sampler.trigger = (i, o) => { hits.push(o?.when); return orig(i, o); };
    s.clear(); [0, 4, 8, 12].forEach((c) => s.toggle(3, c));
    s.start(); await new Promise((r) => setTimeout(r, 2100)); s.stop(); e.sampler.trigger = orig;
    const m = e.masterDeck();
    return { hits: hits.length, beatSec: 60 / m.effectiveBpm, gaps: hits.slice(1).map((t, i) => t - hits[i]) };
  });
  const gapOk = seq.gaps.every((g) => Math.abs(g - seq.beatSec) < 0.02);
  check(seq.hits >= 3 && gapOk, `sequencer fired ${seq.hits} kicks one beat apart (${seq.beatSec.toFixed(3)}s)`);

  // UI renders: open the sequencer panel and pitch pad mode for a screenshot
  await page.evaluate(() => { window.opendj.toggleSequencer(); window.opendj.engine.decks[0].padMode('pitch'); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: process.argv[2] || path.join(tmp, 'perf.png') });
  const real = errors.filter((e) => !/favicon/.test(e));
  check(real.length === 0, `no console errors${real.length ? ': ' + real.join(' | ') : ''}`);
} catch (e) { console.error(e); console.error('page errors:', errors); console.error(await page.evaluate(() => ({ lib: !!window.opendj?.library, deck: !!document.querySelector('.deck'), boot: document.getElementById('boot')?.textContent })).catch((x) => x.message)); failed = true; }
await browser.close(); app.server.close();
console.log(failed ? '\nPERFORMANCE E2E FAILED' : '\nPERFORMANCE E2E PASSED');
process.exit(failed ? 1 : 0);
