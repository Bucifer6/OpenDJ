// End-to-end test for AI stems in headless Chromium:
//   prepare stems (stub "band" model by default) -> server cache -> deck loads 4 stems -> per-stem gains are
//   checked with a spectrum analyser through key lock / tempo / loop / slip / scratch.
// Real model: set STEMS_MODEL=/path/to/htdemucs.onnx (sha256 da9e5101…, from the npm "demucs" 1.0.0 tarball) and
// make onnxruntime-web resolvable (npm dependency, or OPENDJ_ORT_DIR=…/onnxruntime-web/dist) to also separate a
// short clip with HT-Demucs in the browser worker and report the speed.
// Usage: node scripts/e2e-stems.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';
import { registerStemRoutes, DEFAULT_MODEL, findOrtDir } from '../server/stems.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-stems-'));
const music = path.join(tmp, 'Music');
fs.mkdirSync(music);
const SR = 44100;
// three sines in three stub "bands": 100 Hz (bass), 1 kHz (vocals), 6 kHz (drums), plus a soft click track for BPM
function writeWav(file, seconds) {
  const n = SR * seconds, data = Buffer.alloc(44 + n * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVE', 8); data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const t = i / SR, tb = t % 0.5;
    let v = 0.25 * Math.sin(2 * Math.PI * 100 * t) + 0.2 * Math.sin(2 * Math.PI * 1000 * t) + 0.1 * Math.sin(2 * Math.PI * 6000 * t);
    if (tb < 0.03) v += 0.3 * Math.sin(2 * Math.PI * 60 * tb) * (1 - tb / 0.03);
    const s = Math.max(-1, Math.min(1, v * 0.8)) * 32767;
    data.writeInt16LE(s | 0, 44 + i * 4); data.writeInt16LE(s | 0, 46 + i * 4);
  }
  fs.writeFileSync(file, data);
}
writeWav(path.join(music, 'Stem Test - Three Bands.wav'), 24);
writeWav(path.join(music, 'Stem Test - Short Clip.wav'), Number(process.env.STEMS_CLIP_SECONDS || 10));

const dataDir = path.join(tmp, 'data');
const ortDir = process.env.OPENDJ_ORT_DIR || findOrtDir();
const realModel = process.env.STEMS_MODEL && fs.existsSync(process.env.STEMS_MODEL) && ortDir ? process.env.STEMS_MODEL : null;
if (realModel) { // pre-seed the model cache as if it had been downloaded
  const dir = path.join(dataDir, 'stems', 'models'); fs.mkdirSync(dir, { recursive: true });
  const bytes = fs.readFileSync(realModel), sha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha !== DEFAULT_MODEL.sha256) throw new Error(`STEMS_MODEL is not the pinned HT-Demucs export (sha256 ${sha})`);
  fs.copyFileSync(realModel, path.join(dir, `${sha}.onnx`));
  fs.writeFileSync(path.join(dir, `${sha}.onnx.json`), JSON.stringify({ url: DEFAULT_MODEL.url, entry: DEFAULT_MODEL.entry, sha256: sha, bytes: bytes.length, pinned: true, at: Date.now() }));
}

const app = await start({ port: 0, dataDir });
// Until server/index.js registers the stem routes, mount them in front of the app's request handler.
const probe = await fetch(new URL('/api/stems/status', app.url)).then((r) => r.status).catch(() => 0);
let shim = null;
if (probe === 404) {
  const routes = [];
  const route = (method, pattern, handler, o = {}) => { const keys = []; routes.push({ method, keys, handler, ...o, re: new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$') }); };
  shim = registerStemRoutes({ route, library: app.library, ortDir });
  const orig = app.server.listeners('request')[0];
  app.server.removeAllListeners('request');
  app.server.on('request', async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const r = url.pathname.startsWith('/api/stems/') && routes.find((x) => (x.method === req.method || (x.method === 'GET' && req.method === 'HEAD')) && x.re.test(url.pathname));
    if (!r) return orig(req, res);
    try {
      const m = r.re.exec(url.pathname), params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let body = {};
      if (['POST', 'PUT'].includes(req.method)) { const c = []; for await (const x of req) c.push(x); const raw = Buffer.concat(c); body = !raw.length ? {} : String(req.headers['content-type']).startsWith('application/json') ? JSON.parse(raw) : raw; }
      const out = await r.handler({ req, res, params, body, query: url.searchParams });
      if (!res.headersSent && out !== undefined) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); }
    } catch (e) { if (!res.headersSent) { res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } }
  });
  console.log('(stem routes not registered in server/index.js yet: mounted by the test)');
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (process.env.DEBUG) console.log('[page]', m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const done = async (code) => { await browser.close(); shim?.close(); app.server.close(); app.shutdown?.(); process.exit(code); };
class CheckError extends Error {}
const check = (cond, msg) => { if (!cond) throw new CheckError(msg); console.log('ok -', msg); };

try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 20000 });
  await page.evaluate(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
  const r = await page.evaluate(async (dir) => (await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) })).json(), music);
  check(r.id, 'folder added');
  await page.waitForFunction(() => window.opendj.library.tracks.size === 2, null, { timeout: 15000 });
  const ids = await page.evaluate(() => Object.fromEntries([...window.opendj.library.tracks.values()].map((t) => [t.title, t.id])));

  // ---------- prepare stems (stub model) ----------
  await page.evaluate(async () => {
    const ui = await import('/js/stems/stems-ui.js');
    const app = window.opendj;
    ui.setupStems(app);
    // mount the deck controls if the app has not placed them yet
    if (!document.querySelector('.deck-stems')) document.querySelector('.deck')?.append(ui.buildStemControls(app, app.engine.decks[0]));
    app.stems.useStub('bands');
    app.settings.autoGain = false; app.engine.settings.autoGain = false;
    window.__stemEvents = [];
    for (const ev of ['progress', 'finished', 'failed']) app.stems.on(ev, (x) => window.__stemEvents.push([ev, x && { ...x }]));
  });
  const t0 = Date.now();
  const queued = await page.evaluate((id) => window.opendj.stems.enqueue([id], { interactive: false }), ids['Three Bands']);
  check(queued === 1, 'track queued for stems');
  await page.waitForFunction((id) => window.opendj.library.track(id)?.stems?.ready, ids['Three Bands'], { timeout: 120000 });
  const ev = await page.evaluate(() => window.__stemEvents);
  check(ev.some(([e, x]) => e === 'progress' && x?.phase === 'separating' && x.total > 1), `progress events (${ev.filter(([e]) => e === 'progress').length})`);
  check(ev.some(([e]) => e === 'finished'), `stems prepared with the stub model in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // background preparation in this window waits while a mix transition runs (playback first), then carries on
  const held = await page.evaluate(async (id) => {
    const app = window.opendj, s = app.stems, am = app.automix;
    const phases = []; const onP = (x) => x && phases.push(x.phase); s.on('progress', onP);
    let finished = false; const onF = () => { finished = true; }; s.on('finished', onF);
    am.transition = { style: 'blend' }; // a transition running (what stems-ui.js watches)
    await s.enqueue([id], { interactive: false, force: true });
    await new Promise((r) => setTimeout(r, 2500));
    const during = { finished, waiting: s.current?.phase === 'waiting for the mix', held: !!s._held };
    am.transition = null;
    for (let k = 0; k < 300 && !finished; k++) await new Promise((r) => setTimeout(r, 100));
    s.off?.('progress', onP); s.off?.('finished', onF);
    return { during, finished, sawWaiting: phases.includes('waiting for the mix') };
  }, ids['Three Bands']);
  check(!held.during.finished && held.during.waiting && held.during.held, `background stems wait while a mix transition runs (${JSON.stringify(held.during)})`);
  check(held.finished && held.sawWaiting, 'and finish once it is over');
  const info = await page.evaluate((id) => fetch(`/api/stems/${id}`).then((r) => r.json()), ids['Three Bands']);
  check(info.ready && info.frames === 24 * SR && info.stems.length === 4, `server stem cache (${info.format}, ${info.frames} frames)`);

  // ---------- deck playback with stems ----------
  await page.evaluate((id) => window.opendj.loadTrack(0, id), ids['Three Bands']);
  await page.waitForFunction(() => window.opendj.engine.decks[0].stemsReady, null, { timeout: 30000 });
  check(true, 'deck loaded the stems into the worklet');
  check(await page.evaluate(() => window.opendj.engine.channels[0].aiStems === true), 'mixer channel switched VOC/INST to AI stems');
  check(await page.evaluate(() => !document.querySelector('.deck-stems .stem-btn').disabled), 'stem buttons enabled');

  await page.evaluate(() => {
    const { engine } = window.opendj, d = engine.decks[0];
    const an = engine.ctx.createAnalyser(); an.fftSize = 16384; an.smoothingTimeConstant = 0; d.node.connect(an, 0);
    window.__spec = async () => {
      await new Promise((r) => setTimeout(r, 550)); // let gain ramps settle and the 0.34 s analyser window refill
      const b = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(b);
      const at = (hz) => { const k = Math.round(hz / (engine.ctx.sampleRate / an.fftSize)); return Math.max(b[k - 2], b[k - 1], b[k], b[k + 1], b[k + 2]); };
      const td = new Float32Array(an.fftSize); an.getFloatTimeDomainData(td);
      let peak = 0; for (const v of td) peak = Math.max(peak, Math.abs(v));
      return { bass: at(100), voc: at(1000), drums: at(6000), peak, pos: d.position };
    };
    d.seek(2); d.play();
  });
  const spec = () => page.evaluate(() => window.__spec());
  const full = await spec();
  console.log('full mix dB', JSON.stringify(full));
  check(full.bass > -40 && full.voc > -40 && full.drums > -45, 'all three bands audible with all stems on');
  const drop = (a, b, k) => a[k] - b[k];
  const expect = async (label, fn, gone, kept, ref = full) => {
    await page.evaluate(fn);
    const s = await spec();
    for (const k of gone) check(drop(ref, s, k) > 30, `${label}: ${k} removed (−${drop(ref, s, k).toFixed(0)} dB)`);
    for (const k of kept) check(Math.abs(drop(ref, s, k)) < 3, `${label}: ${k} kept (${(-drop(ref, s, k)).toFixed(1)} dB)`);
    return s;
  };
  await expect('acapella', () => window.opendj.engine.decks[0].stemAcapella(), ['bass', 'drums'], ['voc']);
  await expect('instrumental', () => window.opendj.engine.decks[0].stemInstrumental(), ['voc'], ['bass', 'drums']);
  await expect('all on', () => window.opendj.engine.decks[0].stemInstrumental(), [], ['bass', 'voc', 'drums']);
  await expect('mute bass (button)', () => document.querySelector('.deck-stems .stem-2').click(), ['bass'], ['voc', 'drums']);
  await page.evaluate(() => window.opendj.engine.decks[0].setStemMute(2, false));
  await expect('channel VOC knob at 0', () => window.opendj.engine.channels[0].set('vocal', 0), ['voc'], ['bass', 'drums']);
  await page.evaluate(() => window.opendj.engine.channels[0].set('vocal', 1));
  await expect('drums level 0', () => window.opendj.engine.decks[0].setStemLevel(1, 0), ['drums'], ['bass', 'voc']);
  await page.evaluate(() => window.opendj.engine.decks[0].setStemLevel(1, 1));

  // key lock + tempo: pitch stays, stem gains still apply (WSOLA path reads the stem mix)
  await page.evaluate(() => { const d = window.opendj.engine.decks[0]; d.setKeyLock(true); d.setTempo(8); });
  const wsola = await spec(); // the time-stretcher itself colours the highs a little: compare against all stems on at this tempo
  await expect('key lock +8% instrumental', () => window.opendj.engine.decks[0].stemInstrumental(), ['voc'], ['bass', 'drums'], wsola);
  // key shift: frequencies move by +2 semitones, still no vocals
  const ks = await page.evaluate(async () => { const d = window.opendj.engine.decks[0]; d.setKeyShift(2); const s = await window.__spec(); d.setKeyShift(0); return s; });
  check(drop(full, ks, 'voc') > 25, `key shift +2 with instrumental: vocals stay out (−${drop(full, ks, 'voc').toFixed(0)} dB at 1 kHz)`);
  await page.evaluate(() => { const d = window.opendj.engine.decks[0]; d.stemInstrumental(); d.setTempo(0); });

  // loop + slip: position wraps and slips back; acapella stays applied
  const loopRes = await page.evaluate(async () => {
    const d = window.opendj.engine.decks[0];
    d.stemAcapella(); d.setSlip(true);
    const start = d.position; d.setLoop(d.floorBeat(start), d.floorBeat(start) + 0.5);
    await new Promise((r) => setTimeout(r, 1300));
    const inLoop = d.position, s = await window.__spec();
    d.exitLoop(); d.setSlip(false);
    await new Promise((r) => setTimeout(r, 200));
    return { start, inLoop, loopStart: d.loop.start, after: d.position, s };
  });
  check(loopRes.inLoop >= loopRes.loopStart - 0.01 && loopRes.inLoop <= loopRes.loopStart + 0.51, `loop wraps (${loopRes.inLoop.toFixed(2)} in [${loopRes.loopStart.toFixed(2)}, +0.5])`);
  check(loopRes.after > loopRes.start + 1.2, `slip resumed ahead (${loopRes.after.toFixed(2)} > ${(loopRes.start + 1.2).toFixed(2)})`);
  check(drop(full, loopRes.s, 'bass') > 30 && Math.abs(drop(full, loopRes.s, 'voc')) < 3, 'acapella holds inside the loop');

  // scratch + reverse with stems: position follows the jog, stem gains stay, 'ended' still fires once
  const scr = await page.evaluate(async () => {
    const d = window.opendj.engine.decks[0];
    const p0 = d.position;
    let s = null;
    const spin = (async () => { for (let i = 0; i < 40; i++) { d.jogScratch(-0.01, 0.02); await new Promise((r) => setTimeout(r, 20)); } })();
    await new Promise((r) => setTimeout(r, 400)); s = await window.__spec(); await spin;
    d.jogRelease();
    await new Promise((r) => setTimeout(r, 300));
    const p1 = d.position;
    d.setReverse(true); await new Promise((r) => setTimeout(r, 400)); const p2 = d.position; d.setReverse(false);
    let ended = 0; d.on('ended', () => ended++);
    d.stemAcapella(); d.seek(d.duration - 0.4); await new Promise((r) => setTimeout(r, 1200));
    return { p0, p1, p2, s, ended, playing: d.playing };
  });
  check(scr.p1 < scr.p0, `scratch moved backwards (${scr.p0.toFixed(2)} -> ${scr.p1.toFixed(2)})`);
  check(scr.s.peak > 0.02, `stem mix audible while scratching (peak ${scr.s.peak.toFixed(3)})`);
  check(scr.p2 < scr.p1 + 0.1, `reverse plays backwards (${scr.p1.toFixed(2)} -> ${scr.p2.toFixed(2)})`);
  check(scr.ended === 1 && !scr.playing, `'ended' fired once (${scr.ended})`);

  // vocal echo send (stem FX) produces signal on output 1 only when on
  const fx = await page.evaluate(async () => {
    const { engine } = window.opendj, d = engine.decks[0];
    const an = engine.ctx.createAnalyser(); an.fftSize = 2048; d.node.connect(an, 1);
    const peak = async () => { await new Promise((r) => setTimeout(r, 300)); const b = new Float32Array(2048); an.getFloatTimeDomainData(b); return Math.max(...b.map(Math.abs)); };
    d.seek(3); d.play();
    const off = await peak(); d.setStemFx(true); const on = await peak(); d.setStemFx(false); const off2 = await peak();
    return { off, on, off2 };
  });
  check(fx.off < 1e-6 && fx.on > 0.05 && fx.off2 < 1e-3, `vocal echo send (off ${fx.off.toFixed(4)}, on ${fx.on.toFixed(3)})`);

  // instant double keeps the stems and their state; ejecting/reloading without stems falls back
  await page.evaluate(async () => { const [a, b] = window.opendj.engine.decks; a.stemInstrumental(); await b.cloneFrom(a); });
  await page.waitForFunction(() => window.opendj.engine.decks[1].stemsReady, null, { timeout: 30000 });
  check(await page.evaluate(() => window.opendj.engine.decks[1].isInstrumental), 'instant double copies stems + mute state');
  await page.evaluate((id) => { for (const d of window.opendj.engine.decks) d.pause(); return window.opendj.loadTrack(1, id); }, ids['Short Clip']);
  check(await page.evaluate(() => !window.opendj.engine.decks[1].stemsReady && !window.opendj.engine.channels[1].aiStems), 'track without stems: quick-stems fallback on the channel');

  // delete stems: deck drops them
  await page.evaluate((id) => window.opendj.stems.remove(id), ids['Three Bands']);
  await page.waitForFunction(() => !window.opendj.engine.decks[0].stemsReady, null, { timeout: 5000 });
  check(true, 'deleting stems unloads them from the deck');
  await page.evaluate(() => window.opendj.engine.decks[0].pause());

  // ---------- real HT-Demucs in the browser worker ----------
  if (realModel) {
    const st = await page.evaluate(() => fetch('/api/stems/status').then((r) => r.json()));
    check(st.model.ready && st.ort, `real model available (${st.model.name}, ORT ${st.ortVersion})`);
    const res = await page.evaluate(async (id) => {
      const s = window.opendj.stems; s.stub = null; s.disposeWorker();
      const t = performance.now(); await s.enqueue([id], { interactive: false, force: true });
      await new Promise((resolve, reject) => { s.on('finished', resolve); s.on('failed', (e) => reject(new Error(e.message))); });
      return { wall: performance.now() - t, ...s.lastRun, isolated: crossOriginIsolated };
    }, ids['Short Clip']);
    console.log('real model run', JSON.stringify(res));
    check(res.backend && res.ms > 0, `HT-Demucs separated ${res.seconds.toFixed(1)} s in ${(res.ms / 1000).toFixed(1)} s on ${res.backend} (×${(res.seconds / (res.ms / 1000)).toFixed(2)} realtime, ${res.threads} thread(s), page load+decode+upload ${(res.wall / 1000).toFixed(1)} s)`);
    await page.evaluate((id) => window.opendj.loadTrack(1, id), ids['Short Clip']);
    await page.waitForFunction(() => window.opendj.engine.decks[1].stemsReady, null, { timeout: 30000 });
    check(true, 'deck plays the HT-Demucs stems');
  } else console.log('# real model skipped (set STEMS_MODEL=…/htdemucs.onnx and install onnxruntime-web to run it)');

  const relevant = errors.filter((e) => !/favicon|Failed to load resource.*404/.test(e));
  check(!relevant.length, `no page errors${relevant.length ? ': ' + relevant.join(' | ') : ''}`);
  console.log('\nE2E STEMS PASSED');
  await done(0);
} catch (e) {
  console.error('FAIL:', e instanceof CheckError ? e.message : e);
  console.error(errors.join('\n'));
  await page.screenshot({ path: path.join(tmp, 'fail.png') }).catch(() => {});
  console.error('screenshot', path.join(tmp, 'fail.png'));
  await done(1);
}
