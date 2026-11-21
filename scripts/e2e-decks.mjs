// Turntable and deck features in the real app (docs/MIXER_AND_TURNTABLES_PLAN.md §6, T1-T11): motor ramps,
// position-following touch / mouse scratch, multitouch hold, platter skins and their draw time, tonearm needle drop,
// needle lock and snap, tempo glide, active loops, quantize divisions, beat jump sizes, loop in / out adjust, scratch
// samples, slip brake, scale play, deck lock, scratch view, haptics throttle, MIDI targets, settings persistence and
// long tasks while scratching. Usage: node scripts/e2e-decks.mjs [screenshot dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-decks-'));
const shots = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (shots) fs.mkdirSync(shots, { recursive: true });
const music = path.join(tmp, 'Music'); fs.mkdirSync(music);
function wav(file, seconds, bpm, hz) {
  const sr = 44100, n = sr * seconds, d = Buffer.alloc(44 + n * 4);
  d.write('RIFF', 0); d.writeUInt32LE(36 + n * 4, 4); d.write('WAVEfmt ', 8); d.writeUInt32LE(16, 16); d.writeUInt16LE(1, 20); d.writeUInt16LE(2, 22);
  d.writeUInt32LE(sr, 24); d.writeUInt32LE(sr * 4, 28); d.writeUInt16LE(4, 32); d.writeUInt16LE(16, 34); d.write('data', 36); d.writeUInt32LE(n * 4, 40);
  const b = 60 / bpm;
  for (let i = 0; i < n; i++) { const t = i / sr, tb = (t + b * 100) % b; const v = (tb < 0.15 ? 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb * 40)) * tb) * Math.exp(-tb * 18) : 0) + 0.12 * Math.sin(2 * Math.PI * hz * t); const s = Math.round(v * 0.7 * 32767); d.writeInt16LE(s, 44 + i * 4); d.writeInt16LE(s, 46 + i * 4); }
  fs.writeFileSync(file, d);
}
wav(path.join(music, 'Deck Test - One.wav'), 90, 120, 220);
wav(path.join(music, 'Deck Test - Two.wav'), 90, 125, 330);

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
let failed = false;
const check = (c, msg) => { console.log(`${c ? 'ok' : 'FAIL'} - ${msg}`); if (!c) failed = true; };
const ev = (fn, arg) => page.evaluate(fn, arg);
const sleep = (ms) => page.waitForTimeout(ms);
const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 20000 });
  await ev(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
  await ev((d) => fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: d }) }), music);
  await page.waitForFunction(() => window.opendj.library.tracks.size === 2, null, { timeout: 20000 });
  const ids = await ev(() => Object.fromEntries([...window.opendj.library.tracks.values()].map((t) => [t.title, t.id])));
  await ev(async (ids) => { await window.opendj.loadTrack(0, ids.One); await window.opendj.loadTrack(1, ids.Two); }, ids);
  await page.waitForFunction(() => window.opendj.engine.decks.every((d, i) => i > 1 || (d.track && d.bpm)), null, { timeout: 30000 });
  const bpm = await ev(() => window.opendj.engine.decks[0].bpm);
  check(Math.abs(bpm - 120) < 0.5, `test track analysed (${bpm} BPM)`);

  // ---------------------------------------------------------------- MIDI targets: new ids present, old ids kept
  const tg = await ev(() => window.opendj.midi.targets?.map?.((t) => t.id) || (window.opendj.midi.buildTargets?.() || []).map((t) => t.id));
  const ids2 = tg.length ? tg : await ev(async () => (await import('/js/midi/midi.js')).buildTargets(window.opendj).map((t) => t.id));
  const want = ['vinylMode', 'motorStart', 'motorStop', 'slipmat', 'jogWeight', 'brake', 'backspin', 'slipBrake', 'startStop', 'quartz', 'rpm33', 'rpm45', 'rpm78', 'tempoGlideReset', 'tempoGlideSync', 'tempoRange.next', 'needle', 'needleLock', 'activeLoop', 'quantizeDiv.next', 'jumpSize.up', 'jumpSize.down', 'jumpBySize+', 'jumpBySize-', 'loopInAdjust', 'loopOutAdjust', 'padMode.scratch', 'padMode.platterPlay', 'scratchSlot1', 'scratchReturn', 'lock', 'slipReverse'].map((x) => `deck1.${x}`);
  const old = ['deck1.play', 'deck1.jog', 'deck1.jogTouch', 'deck1.bendUp', 'deck1.tempoUp', 'deck1.censor', 'deck1.reverse', 'deck1.padMode.fx', 'mixer1.volume', 'mixer.crossfader'];
  check(want.every((x) => ids2.includes(x)), `deck MIDI targets present (${want.filter((x) => !ids2.includes(x)).join(', ') || 'all'})`);
  check(old.every((x) => ids2.includes(x)) && new Set(ids2).size === ids2.length, 'existing MIDI ids kept, no duplicates');
  const midi = (id, v) => ev(async ([id, v]) => { const t = (await import('/js/midi/midi.js')).buildTargets(window.opendj).find((x) => x.id === id); t.handler(v); }, [id, v]);

  // ---------------------------------------------------------------- T1 motor: start / stop ramps through the real engine
  await ev(async () => { const { setDeckVinyl } = await import('/js/midi/deck-targets.js'); const a = window.opendj, d = a.engine.decks[0]; d.seek(10); setDeckVinyl(a, d, { start: 0.6, stop: 0.6 }); await new Promise((r) => setTimeout(r, 100)); d.play(); });
  await sleep(230); const r1 = await ev(() => window.opendj.engine.decks[0]._rate);
  await sleep(700); const r2 = await ev(() => window.opendj.engine.decks[0]._rate);
  check(r1 > 0.15 && r1 < 0.75 && Math.abs(r2 - 1) < 0.01, `motor start 0.6 s: ${f(r1)}x after 0.23 s, ${f(r2)}x after 0.93 s`);
  await ev(() => window.opendj.engine.decks[0].pause());
  await sleep(250); const r3 = await ev(() => window.opendj.engine.decks[0]._rate);
  await sleep(600); const r4 = await ev(() => window.opendj.engine.decks[0]._rate);
  check(r3 > 0.1 && r3 < 0.8 && r4 === 0, `motor stop 0.6 s on pause: ${f(r3)}x after 0.25 s, ${f(r4)}x after 0.85 s`);
  await ev(async () => { const { setDeckVinyl } = await import('/js/midi/deck-targets.js'); setDeckVinyl(window.opendj, window.opendj.engine.decks[0], { start: 0, stop: 0 }); });
  // settings persistence of the per-deck Platter panel
  await sleep(500);
  const saved = await ev(async () => (await (await fetch('/api/settings')).json()).vinylDecks?.[0]);
  check(saved && saved.start === 0 && saved.stop === 0, `per-deck vinyl options saved (${JSON.stringify(saved)})`);

  // ---------------------------------------------------------------- T3 mouse scratch through the position API
  const jogBox = await page.locator('.deck[data-deck="0"] .jog-canvas').boundingBox();
  const cx = jogBox.x + jogBox.width / 2, cy = jogBox.y + jogBox.height / 2, rad = jogBox.width * 0.3; // platter top (the outer ring, beyond 0.78 of the radius, nudges)
  await ev(() => { const d = window.opendj.engine.decks[0]; d.pause(); d.seek(20); });
  await sleep(150);
  const p0 = await ev(() => window.opendj.engine.decks[0].position);
  await page.mouse.move(cx + rad * Math.cos(-Math.PI / 2), cy + rad * Math.sin(-Math.PI / 2));
  await page.mouse.down();
  for (let k = 1; k <= 24; k++) { const a = -Math.PI / 2 - (k / 24) * Math.PI; await page.mouse.move(cx + rad * Math.cos(a), cy + rad * Math.sin(a)); await sleep(12); } // half a turn backwards
  await sleep(200);
  const p1 = await ev(() => window.opendj.engine.decks[0].position);
  await page.mouse.up(); await sleep(100);
  check(Math.abs((p0 - p1) - 0.9) < 0.05, `mouse half-turn back moves the record 0.9 s at 33⅓ (${f(p0 - p1)} s)`);
  // 45 rpm: half a turn = 0.667 s
  await midi('deck1.rpm45', true);
  const p2 = await ev(() => window.opendj.engine.decks[0].position);
  await page.mouse.move(cx + rad * Math.cos(-Math.PI / 2), cy + rad * Math.sin(-Math.PI / 2)); await page.mouse.down();
  for (let k = 1; k <= 24; k++) { const a = -Math.PI / 2 + (k / 24) * Math.PI; await page.mouse.move(cx + rad * Math.cos(a), cy + rad * Math.sin(a)); await sleep(12); }
  await sleep(200); const p3 = await ev(() => window.opendj.engine.decks[0].position); await page.mouse.up();
  check(Math.abs((p3 - p2) - 0.6667) < 0.04, `45 rpm: half a turn forwards = ${f(p3 - p2)} s (0.667)`);
  await midi('deck1.rpm33', true);

  // ---------------------------------------------------------------- T8 multitouch: finger 1 scratches, finger 2 holds
  const cdp = await ctx.newCDPSession(page);
  const tp = (id, a, r = rad) => ({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), id });
  await ev(() => { const d = window.opendj.engine.decks[0]; d.seek(30); d.play(); window.__pe = []; const c = document.querySelector('.deck[data-deck="0"] .jog-canvas'); for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture']) c.addEventListener(t, (e) => window.__pe.push(`${t}:${e.pointerId}`)); });
  await sleep(300);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp(1, -1.5)] });
  await sleep(60);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp(1, -1.5), tp(2, 2, rad * 0.5)] });
  const holdRates = [];
  for (let k = 0; k < 12; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [tp(1, -1.5 + k * 0.08), tp(2, 2, rad * 0.5)] }); await sleep(30); if (k > 4) holdRates.push(await ev(() => window.opendj.engine.decks[0]._rate)); }
  check(holdRates.every((r) => Math.abs(r) < 0.01), `second finger holds the record still (max |rate| ${f(Math.max(...holdRates.map(Math.abs)))})`);
  check(await ev(() => document.querySelector('.deck[data-deck="0"] .jog').holding()), 'jog reports the hand-on-record hold');
  // lift the holding finger: finger 1 scratches again from where it is (no jump)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [tp(2, 2, rad * 0.5)] });
  const q0 = await ev(() => window.opendj.engine.decks[0].position);
  for (let k = 1; k <= 10; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [tp(1, -1.5 + 0.88 + k * 0.1)] }); await sleep(16); }
  await sleep(150);
  const q1 = await ev(() => window.opendj.engine.decks[0].position);
  check(q1 - q0 > 0.1 && q1 - q0 < 0.6, `after the hold, finger 1 scratches on from its place (+${f(q1 - q0)} s for 1 rad)`);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [tp(1, -1.5 + 0.88 + 1)] }); // (CDP: touchEnd lists the points that lift)
  await sleep(150);
  check(await ev(() => Math.abs(window.opendj.engine.decks[0]._rate - 1) < 0.01), 'release: the motor brings the playing deck back to speed');

  // ---------------------------------------------------------------- T10 flick to spin back
  await ev(() => { const a = window.opendj; a.settings.deckOptions = { ...(a.settings.deckOptions || {}), flickSpinback: true }; });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp(1, 0)] });
  for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [tp(1, -k * 0.6)] }); // as fast as CDP goes
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [tp(1, -3.6)] });
  await sleep(80);
  const spin = await ev(() => window.opendj.engine.decks[0]._rate);
  check(spin < -2, `a fast backwards throw spins the record back (${f(spin)}x)`);
  await sleep(1300);
  await ev(() => { const a = window.opendj; a.settings.deckOptions = { ...a.settings.deckOptions, flickSpinback: false }; a.engine.decks[0].pause(); });

  // ---------------------------------------------------------------- haptics: ≤ 40 calls a second, none when off
  const hap = await ev(async () => {
    const h = await import('/js/ui/haptics.js'); let n = 0; h.hapticsLog.sink = () => n++;
    h.setHapticsLevel('full'); const t0 = performance.now(); while (performance.now() - t0 < 1000) { h.haptics.tick(); await new Promise((r) => setTimeout(r, 2)); }
    const full = n; n = 0; h.setHapticsLevel('off'); for (let i = 0; i < 50; i++) h.haptics.tick();
    const off = n; h.setHapticsLevel('auto'); h.hapticsLog.sink = null; return { full, off };
  });
  check(hap.full <= 41 && hap.full >= 30 && hap.off === 0, `haptics throttled to 40 Hz (${hap.full} calls in 1 s), none when Off (${hap.off})`);

  // ---------------------------------------------------------------- T7 skins: render, draw time per platter
  const skinRes = [];
  for (const skin of ['minimal', 'vinyl', 'cdj']) {
    const r = await ev(async (skin) => {
      const a = window.opendj; a.settings.deckOptions = { ...a.settings.deckOptions, platterSkin: skin };
      a.engine.decks.slice(0, 2).forEach((d) => d.play());
      await new Promise((r) => setTimeout(r, 400));
      const jogs = [...document.querySelectorAll('.deck .jog')].slice(0, 2);
      const times = [];
      for (let k = 0; k < 60; k++) { await new Promise((r) => requestAnimationFrame(r)); const t0 = performance.now(); jogs.forEach((j) => j.draw(performance.now() + 7)); times.push((performance.now() - t0) / jogs.length); }
      times.sort((x, y) => x - y);
      const cv = jogs[0].querySelector('canvas'), px = cv.getContext('2d').getImageData(cv.width / 2, cv.height * 0.2, 1, 1).data;
      return { skin, med: times[30], p95: times[57], ds: jogs[0].dataset.skin, painted: px[3] > 0 };
    }, skin);
    skinRes.push(r);
    check(r.ds === skin && r.painted, `${skin} skin renders`);
    check(r.med <= 1, `${skin} skin: draw time ${f(r.med)} ms per platter (median), p95 ${f(r.p95)} ms (budget 1 ms)`);
    if (shots) { await sleep(300); await page.screenshot({ path: path.join(shots, `decks-skin-${skin}.png`) }); }
  }
  await ev(() => window.opendj.engine.decks.forEach((d) => d.pause()));

  // ---------------------------------------------------------------- T6 tonearm needle drop (vinyl skin)
  await ev(() => { const a = window.opendj; a.settings.deckOptions = { ...a.settings.deckOptions, platterSkin: 'vinyl', needleSnap: 'off' }; a.engine.decks[0].seek(5); });
  await sleep(200);
  const arm = await ev(async () => {
    const { makeSkin } = await import('/js/ui/platter-skins.js'); const cv = document.querySelector('.deck[data-deck="0"] .jog-canvas'); const W = cv.width;
    const s = makeSkin('vinyl'), d = window.opendj.engine.decks[0], geo = s.geometry(W), k = d.position / d.duration;
    const phi = geo.outer + (geo.inner - geo.outer) * k, n = s.needle(geo, phi), phi2 = geo.outer + (geo.inner - geo.outer) * 0.5, n2 = s.needle(geo, phi2);
    const r = cv.getBoundingClientRect(); const sc = r.width / W;
    return { x: r.left + n[0] * sc, y: r.top + n[1] * sc, x2: r.left + n2[0] * sc, y2: r.top + n2[1] * sc };
  });
  await page.mouse.move(arm.x, arm.y); await page.mouse.down();
  for (let k = 1; k <= 10; k++) { await page.mouse.move(arm.x + (arm.x2 - arm.x) * k / 10, arm.y + (arm.y2 - arm.y) * k / 10); await sleep(16); }
  await page.mouse.up(); await sleep(150);
  const armK = await ev(() => { const d = window.opendj.engine.decks[0]; return d.position / d.duration; });
  check(Math.abs(armK - 0.5) < 0.03, `dragging the tonearm to mid-record drops the needle there (${f(armK)})`);

  // ---------------------------------------------------------------- T6 needle lock and snap on the overview
  const ov = await page.locator('.deck[data-deck="0"] .wf-overview').boundingBox();
  await ev(() => { const a = window.opendj; a.settings.deckOptions = { ...a.settings.deckOptions, needleLock: 'on' }; a.engine.decks[0].seek(10); a.engine.decks[0].play(); });
  await sleep(200);
  const n0 = await ev(() => window.opendj.engine.decks[0].position);
  await page.mouse.click(ov.x + ov.width * 0.7, ov.y + ov.height / 2); await sleep(100);
  const n1 = await ev(() => window.opendj.engine.decks[0].position);
  check(Math.abs(n1 - n0) < 1, `needle lock: a short tap on a playing deck does not jump (${f(n0, 1)} -> ${f(n1, 1)} s)`);
  await page.mouse.move(ov.x + ov.width * 0.7, ov.y + ov.height / 2); await page.mouse.down(); await sleep(480); await page.mouse.up(); await sleep(80);
  const n2 = await ev(() => { const d = window.opendj.engine.decks[0]; return d.position / d.duration; });
  check(Math.abs(n2 - 0.7) < 0.02, `needle lock: a 480 ms press drops the needle (${f(n2)})`);
  await ev(() => { const a = window.opendj; a.settings.deckOptions = { ...a.settings.deckOptions, needleLock: 'off', needleSnap: 'beat' }; a.engine.decks[0].pause(); });
  await sleep(100);
  await page.mouse.click(ov.x + ov.width * 0.4321, ov.y + ov.height / 2); await sleep(100);
  const snap = await ev(() => { const d = window.opendj.engine.decks[0]; const k = (d.position - d.gridOffset) / d.beatLen; return Math.abs(k - Math.round(k)) * d.beatLen; });
  check(snap < 0.001, `needle snap: the drop lands on the beat grid (${f(snap * 1000, 2)} ms off)`);
  await ev(() => { const a = window.opendj; a.settings.deckOptions = { ...a.settings.deckOptions, needleSnap: 'off', platterSkin: 'minimal' }; });

  // ---------------------------------------------------------------- T5 tempo glide (worklet rateRamp)
  const g = await ev(async () => {
    const d = window.opendj.engine.decks[0]; d.seek(20); d.play(); await new Promise((r) => setTimeout(r, 200));
    d.tempoGlide(4, 4); // 4 beats at 120 BPM ≈ 1.96 s
    const mid = []; for (let k = 0; k < 8; k++) { await new Promise((r) => setTimeout(r, 200)); mid.push(d.tempo); }
    await new Promise((r) => setTimeout(r, 600));
    const out = { mid, end: d.tempo, gliding: d.gliding, rate: d._rate }; d.pause(); d.setTempo(0); return out;
  });
  check(Math.abs(g.end - 4) < 0.01 && !g.gliding && g.mid.every((v, i) => i === 0 || v >= g.mid[i - 1] - 1e-9) && g.mid[3] > 0.5 && g.mid[3] < 3.8, `tempo glide to +4 % over 4 beats: monotonic (${g.mid.map((v) => v.toFixed(2)).join(' ')}), ends at ${f(g.end)} %`);

  // ---------------------------------------------------------------- T11 active loop, quantize divisions, jump sizes, loop adjust
  const al = await ev(async () => {
    const d = window.opendj.engine.decks[0]; d.pause(); d.seek(40); d.setQuantize(true);
    d.setLoop(40, 42); d.toggleActiveLoop(); d.exitLoop();
    d.seek(38); d.play(); await new Promise((r) => setTimeout(r, 2600));
    const res = { active: !!d.loop?.active, start: d.loop?.start, flagged: d.loopIsActiveLoop, pos: d.position };
    d.exitLoop(); d.pause(); d.toggleActiveLoop(); return res;
  });
  check(al.active && Math.abs(al.start - 40) < 0.002 && al.pos >= 40 && al.pos < 42.05, `active loop engages when the track reaches it (loop at ${f(al.start)}, position ${f(al.pos)})`);
  const qd = await ev(() => {
    const d = window.opendj.engine.decks[0], out = [];
    for (let k = 0; k < 5; k++) { d.cycleQuantizeDiv(); const t = d.snap(d.gridOffset + 10.013); out.push([d.quantizeDiv, Math.round(((t - d.gridOffset) / (d.beatLen * d.quantizeDiv)) * 1e6) / 1e6]); }
    return out;
  });
  check(qd.map(([v]) => v).join() === [4, 0.125, 0.25, 0.5, 1].join(), `quantize divisions cycle 1 -> 1 bar -> 1/8 -> 1/4 -> 1/2 -> 1 (${qd.map(([v, k]) => `${v}:${k}`).join(' ')})`);
  check(qd.every(([, k]) => Number.isInteger(k)), 'every division snaps to a whole number of its steps');
  await ev(() => window.opendj.engine.decks[0].setQuantizeDiv(1));
  const js = await ev(() => { const d = window.opendj.engine.decks[0]; const sizes = []; d.setJumpSize(32); d.jumpSizeStep(1); sizes.push(d.jumpSize); d.setJumpSize(1); d.jumpSizeStep(-1); sizes.push(d.jumpSize); d.seek(30); const p = d.position; d.setJumpSize(0.5); d.jumpBySize(1); const dp = d.position - p; d.setJumpSize(4); return { sizes, dp, half: d.beatLen / 2 }; });
  check(js.sizes[0] === 64 && js.sizes[1] === 0.5 && Math.abs(js.dp - js.half) < 0.002, `beat jump sizes reach 64 and ½ (½-beat jump moved ${f(js.dp)} s)`);
  await page.locator('.deck[data-deck="0"] .panel-tab[data-panel="loops"]').click();
  const jumpLbl = await page.locator('.deck[data-deck="0"] .jump-row .btn').nth(1);
  for (let k = 0; k < 4; k++) await jumpLbl.click();
  await sleep(120); // labels refresh with the deck frame
  check((await jumpLbl.innerText()).replace(/\s+/g, '').endsWith('64'), `UI jump size button cycles to 64 (${(await jumpLbl.innerText()).replace(/\s+/g, ' ')})`);
  const adj = await ev(async () => {
    const d = window.opendj.engine.decks[0]; d.seek(50); d.setLoop(50, 52);
    const t = (await import('/js/midi/midi.js')).buildTargets(window.opendj); const get = (id) => t.find((x) => x.id === id);
    get('deck1.loopOutAdjust').handler(true); get('deck1.jog').handler(240); get('deck1.loopOutAdjust').handler(false);
    const out1 = d.loop.end;
    get('deck1.loopInAdjust').handler(true); get('deck1.jog').handler(-120); get('deck1.loopInAdjust').handler(false);
    const in1 = d.loop.start; const after = d.loopAdjust; d.exitLoop(); return { out1: out1 - d.gridOffset, in1: in1 - d.gridOffset, after, step: d.beatLen / 16, g: d.gridOffset };
  });
  check(adj.out1 + adj.g > 52 && adj.in1 + adj.g < 50 && adj.after === null && [adj.out1, adj.in1].every((x) => Math.abs(x / adj.step - Math.round(x / adj.step)) < 1e-3), `loop out / in adjust with the jog (loop ${f(adj.in1 + adj.g)}-${f(adj.out1 + adj.g)} s, snapped to the 1/16-beat grid)`);

  // ---------------------------------------------------------------- T10 slip brake; T11 slip reverse, deck lock, scale play
  const sb = await ev(async () => {
    const d = window.opendj.engine.decks[0]; d.seek(20); d.play(); await new Promise((r) => setTimeout(r, 300));
    const p0 = d.position, t0 = d.ctx.currentTime; d.slipBrake(0.6); await new Promise((r) => setTimeout(r, 1200));
    const exp = p0 + (d.ctx.currentTime - t0); const res = { err: d.position - exp, playing: d.playing, slip: d.slip, rate: d._rate }; d.pause(); return res;
  });
  check(Math.abs(sb.err) < 0.03 && sb.playing && !sb.slip && Math.abs(sb.rate - 1) < 0.01, `slip brake resumes where the track would be (${f(sb.err * 1000, 1)} ms off), slip restored`);
  const sr = await ev(async () => { const d = window.opendj.engine.decks[0]; d.seek(20); d.play(); await new Promise((r) => setTimeout(r, 200)); const p0 = d.position, t0 = d.ctx.currentTime; d.toggleSlipReverse(); await new Promise((r) => setTimeout(r, 500)); const rev = d._rate; d.toggleSlipReverse(); await new Promise((r) => setTimeout(r, 200)); const res = { rev, err: d.position - (p0 + d.ctx.currentTime - t0), latched: d.slipReverse }; d.pause(); return res; });
  check(sr.rev < -0.9 && Math.abs(sr.err) < 0.03 && !sr.latched, `latching slip reverse plays backwards and resumes in place (${f(sr.err * 1000, 1)} ms off)`);
  const lock = await ev(async () => { const a = window.opendj, d = a.engine.decks[1]; d.play(); d.hardLock = true; const t = d.track.id; await a.loadTrack(1, [...a.library.tracks.keys()].find((k) => k !== t)); const same = d.track.id === t; d.hardLock = false; d.pause(); return same; });
  check(lock, 'deck lock refuses a load onto the playing deck');
  const scale = await ev(async () => { const d = window.opendj.engine.decks[0]; d.padMode('scale'); d.seek(15); d.play(); await new Promise((r) => setTimeout(r, 100)); d.padPress(4, true); await new Promise((r) => setTimeout(r, 200)); const held = { rate: d._rate, kl: d.keyLock }; d.padPress(4, false); await new Promise((r) => setTimeout(r, 150)); const res = { held, back: d._rate, kl: d.keyLock }; d.pause(); d.padMode('hotcue'); return res; });
  check(Math.abs(scale.held.rate - 2 ** (7 / 12)) < 0.01 && !scale.held.kl && Math.abs(scale.back - 1) < 0.01 && scale.kl, `scale play: pad 5 plays a fifth up by platter speed (${f(scale.held.rate)}x, key lock off while held, restored)`);

  // ---------------------------------------------------------------- T9 scratch samples: swap in and return
  await ev(() => window.opendj.engine.decks[0].padMode('scratch'));
  await ev(() => { const d = window.opendj.engine.decks[0]; d.seek(33.5); d.setSlip(false); });
  await sleep(100);
  const pad1 = page.locator('.deck[data-deck="0"] .pads .pad').first();
  check(/Ahh/.test(await pad1.innerText()), 'scratch pad mode lists the built-in sounds');
  await pad1.dispatchEvent('pointerdown'); await pad1.dispatchEvent('pointerup');
  await sleep(250);
  const inS = await ev(() => { const d = window.opendj.engine.decks[0]; return { s: !!d.scratchSample, title: d.track.title, dur: d.duration, badge: !document.querySelector('.deck[data-deck="0"] .sample-badge').hidden }; });
  check(inS.s && inS.title === 'Ahh' && inS.dur < 2 && inS.badge, `scratch sample swapped in (${inS.title}, ${f(inS.dur, 2)} s, SAMPLE badge)`);
  await ev(() => { const d = window.opendj.engine.decks[0]; d.play(); }); await sleep(300);
  await pad1.dispatchEvent('pointerdown'); await pad1.dispatchEvent('pointerup');
  await sleep(250);
  const outS = await ev(() => { const d = window.opendj.engine.decks[0]; const r = { s: !!d.scratchSample, title: d.track.title, pos: d.position, cues: d.hotCues.length }; d.pause(); d.padMode('hotcue'); return r; });
  check(!outS.s && outS.title === 'One' && outS.pos > 33.45 && outS.pos < 33.9, `back to the track at the snapshot position (${f(outS.pos)} s; playing time since the return)`);

  // ---------------------------------------------------------------- scratch view: strip, CUT, close
  const sv = await ev(async () => {
    const a = window.opendj; a.engine.setCrossfader(0);
    const m = await import('/js/ui/scratch-view.js'); const v = m.openScratchView(a, a.engine.decks[0]);
    await new Promise((r) => setTimeout(r, 200));
    const strip = v.el.querySelector('.sv-strip'), r = strip.getBoundingClientRect();
    return { open: !!document.querySelector('.scratch-view'), x: r.left + r.width / 2, top: r.top + 4, cut: (() => { const b = v.el.querySelector('.sv-cut').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, h: b.height, w: b.width }; })() };
  });
  check(sv.open, 'scratch view opens');
  await page.mouse.click(sv.x, sv.top);
  const xfOpen = await ev(() => window.opendj.engine.crossfader);
  await page.mouse.move(sv.cut.x, sv.cut.y); await page.mouse.down(); await sleep(50);
  const xfCut = await ev(() => window.opendj.engine.crossfader);
  await page.mouse.up(); await sleep(50);
  const xfBack = await ev(() => window.opendj.engine.crossfader);
  check(xfOpen < -0.9 && xfCut > 0.99 && xfBack < -0.9, `crossfader strip opens deck 1 (${f(xfOpen, 2)}), CUT closes it while held (${f(xfCut, 2)}) and reopens (${f(xfBack, 2)})`);
  check(sv.cut.h >= 44 && sv.cut.w >= 44, `CUT button is a ≥44 px touch target (${Math.round(sv.cut.w)}x${Math.round(sv.cut.h)})`);
  if (shots) await page.screenshot({ path: path.join(shots, 'decks-scratch-view.png') });
  await page.keyboard.press('Escape'); await sleep(100);
  check(!(await ev(() => !!document.querySelector('.scratch-view'))), 'Escape closes the scratch view');
  await ev(() => window.opendj.engine.setCrossfader(0));

  // ---------------------------------------------------------------- long tasks while scratching (2 decks playing)
  const lt = await ev(async () => {
    const long = []; const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(e.duration); }); po.observe({ type: 'longtask', buffered: false });
    const a = window.opendj; a.settings.deckOptions = { ...a.settings.deckOptions, platterSkin: 'vinyl' }; a.engine.decks.slice(0, 2).forEach((d) => d.play());
    const d = a.engine.decks[0]; d.jogPositionStart(performance.now());
    const t0 = performance.now(); let k = 0;
    while (performance.now() - t0 < 3000) { await new Promise((r) => setTimeout(r, 4)); k++; d.jogPosition(Math.sin(k * 0.05) * 0.4, performance.now()); }
    d.jogPositionEnd(performance.now()); a.engine.decks.forEach((x) => x.pause()); po.disconnect();
    a.settings.deckOptions = { ...a.settings.deckOptions, platterSkin: 'minimal' };
    return long;
  });
  check(lt.every((x) => x < 50), `no long tasks over 50 ms while scratching with two decks playing (${lt.length} long tasks, max ${f(Math.max(0, ...lt), 0)} ms)`);

  // ---------------------------------------------------------------- Platter panel: 6th deck tab, controls fit
  await page.locator('.deck[data-deck="0"] .panel-tab[data-panel="platter"]').click();
  const pp = await ev(() => { const p = document.querySelector('.deck[data-deck="0"] .platter-panel'); const r = p.getBoundingClientRect(); const over = [...p.querySelectorAll('.btn')].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent); return { shown: r.width > 100 && r.height > 50, knobs: p.querySelectorAll('.knob').length, over }; });
  check(pp.shown && pp.knobs === 8 && pp.over.length === 0, `Platter panel shows 8 knobs, rpm / quartz / lock buttons without clipped labels (${pp.over.join(', ') || 'none clipped'})`);
  if (shots) await page.screenshot({ path: path.join(shots, 'decks-platter-panel.png') });

  check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
} catch (e) {
  console.error(e); failed = true;
} finally {
  await browser.close();
  await app.close?.();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? '\nDECK E2E FAILED' : '\nall deck checks passed');
process.exit(failed ? 1 : 0);
