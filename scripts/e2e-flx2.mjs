// End-to-end test for the bundled DDJ-FLX2 mapping: fakes the controller's Web MIDI ports, replays every mapped message
// and checks it reaches its target, checks real effects, LED output and the shift layers, the controller-audio offer,
// the Controller test view and its capture file, the mixer's Smart Fader button and DECK SELECT layers.
//   Usage: node scripts/e2e-flx2.mjs [screenshot-dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-flx2-'));
const shots = process.argv[2] || path.join(tmp, 'shots');
fs.mkdirSync(shots, { recursive: true });
const music = path.join(tmp, 'Music'); fs.mkdirSync(music);
function wav(file, seconds, bpm, f0) {
  const sr = 22050, n = sr * seconds, d = Buffer.alloc(44 + n * 4);
  d.write('RIFF', 0); d.writeUInt32LE(36 + n * 4, 4); d.write('WAVEfmt ', 8); d.writeUInt32LE(16, 16); d.writeUInt16LE(1, 20); d.writeUInt16LE(2, 22);
  d.writeUInt32LE(sr, 24); d.writeUInt32LE(sr * 4, 28); d.writeUInt16LE(4, 32); d.writeUInt16LE(16, 34); d.write('data', 36); d.writeUInt32LE(n * 4, 40);
  const b = 60 / bpm;
  for (let i = 0; i < n; i++) { const t = i / sr, tb = (t + b * 100) % b; const v = (tb < 0.15 ? 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb * 40)) * tb) * Math.exp(-tb * 18) : 0) + 0.12 * Math.sin(2 * Math.PI * f0 * t); const s = Math.round(v * 0.7 * 32767); d.writeInt16LE(s, 44 + i * 4); d.writeInt16LE(s, 46 + i * 4); }
  fs.writeFileSync(file, d);
}
wav(path.join(music, 'Flx Artist - First Groove.wav'), 40, 124, 220);
wav(path.join(music, 'Flx Artist - Second Groove.wav'), 40, 126, 247);
wav(path.join(music, 'Flx Artist - Third Groove.wav'), 30, 122, 196);
wav(path.join(music, 'Flx Artist - Fourth Groove.wav'), 30, 128, 262);

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(m.text())) errors.push(`console: ${m.text()}`); });
let failed = false, checks = 0;
const check = (c, msg) => { checks++; console.log(`${c ? 'ok' : 'FAIL'} - ${msg}`); if (!c) failed = true; };
const ev = (fn, arg) => page.evaluate(fn, arg);
const DEV = 'DDJ-FLX2 MIDI 1';
const midi = (bytes) => ev(([d, b]) => window.opendj.midi.onMessage({ name: d }, Uint8Array.from(b)), [DEV, bytes]);

try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
  await ev(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 800 }).catch(() => {});
  await ev((d) => fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: d }) }), music);
  await page.waitForFunction(() => window.opendj.library.tracks.size === 4, null, { timeout: 30000 });
  const ids = await ev(() => [...window.opendj.library.tracks.values()].sort((a, b) => a.title.localeCompare(b.title)).map((t) => t.id));
  for (let i = 0; i < 2; i++) { await ev(([i, id]) => window.opendj.loadTrack(i, id), [i, ids[i]]); await page.waitForFunction((i) => !!window.opendj.engine.decks[i].track, i, { timeout: 30000 }); }

  // ---------- plug and play: fake the FLX2's ports ----------
  await ev((DEV) => {
    const m = window.opendj.midi;
    window.__sent = [];
    localStorage.removeItem('opendj.audioOffer.opendj-flx2');
    const input = { id: 'flx-in', name: DEV, state: 'connected' };
    const output = { id: 'flx-out', name: 'DDJ-FLX2 MIDI 1', state: 'connected', send: (msg) => window.__sent.push([...msg]) };
    m.access = { inputs: new Map([['flx-in', input]]), outputs: new Map([['flx-out', output]]), onstatechange: null };
    m.unsupported = false; m.error = undefined; m.bind();
  }, DEV);
  const stored = await ev((DEV) => window.opendj.midi.mappings[DEV], DEV);
  check(stored?.presetId === 'opendj-flx2' && stored.entries.length > 150, `FLX2 detected by port name: first-party mapping applied (${stored?.entries.length} entries)`);
  await page.waitForSelector('.toast.audio-offer', { timeout: 4000 }).catch(() => {});
  check(await page.locator('.toast.audio-offer').count() === 1, 'offers to route master / headphones to the controller\'s own sound card');
  await ev(() => document.querySelectorAll('.toast.ctl-offer').forEach((t) => t.remove()));
  await ev((DEV) => { window.opendj.midi._presetSeen.clear(); window.opendj.midi.bind(); }, DEV);
  await page.waitForTimeout(200);
  check(await page.locator('.toast.audio-offer').count() === 0, 'the audio offer is made only once');

  // ---------- replay: every mapped message reaches its target ----------
  const routing = await ev((DEV) => {
    const m = window.opendj.midi, map = m.mappings[DEV], hit = [];
    const orig = m.dispatch; m.dispatch = (e) => hit.push(e.target);
    const miss = [];
    for (const e of map.entries) {
      hit.length = 0;
      const [type, ch, num] = e.key.split(':'); const st = (type === 'cc' ? 0xb0 : 0x90) | +ch;
      m.onMessage({ name: DEV }, Uint8Array.from([st, +num, type === 'cc' ? 0x41 : 0x7f]));
      if (!hit.includes(e.target)) miss.push(`${e.key}→${e.target}`);
      if (e.lsbKey) { hit.length = 0; const [, c2, n2] = e.lsbKey.split(':'); m.onMessage({ name: DEV }, Uint8Array.from([0xb0 | +c2, +n2, 0x10])); if (!hit.includes(e.target)) miss.push(`${e.lsbKey}(lsb)→${e.target}`); }
      if (type === 'note') m.onMessage({ name: DEV }, Uint8Array.from([st, +num, 0]));
    }
    m.dispatch = orig; m.resetRuntime();
    return { n: map.entries.length, miss, unknown: map.entries.filter((e) => !m.byId.has(e.target)).map((e) => e.target) };
  }, DEV);
  check(!routing.miss.length && !routing.unknown.length, `all ${routing.n} mapped messages reach their target${routing.miss.length ? ' — missed ' + routing.miss.slice(0, 6).join(', ') : ''}${routing.unknown.length ? ' — unknown ' + routing.unknown.join(', ') : ''}`);

  // ---------- real effects ----------
  await ev(() => { window.opendj.engine.decks.forEach((d) => d.pause()); window.opendj.shift = false; });
  await midi([0x90, 0x0b, 0x7f]); await midi([0x90, 0x0b, 0x00]);
  check(await ev(() => window.opendj.engine.decks[0].playing), 'PLAY/PAUSE (note 0x0B ch1) starts deck 1');
  await midi([0x90, 0x0b, 0x7f]); await midi([0x90, 0x0b, 0x00]);
  check(await ev(() => !window.opendj.engine.decks[0].playing), 'PLAY/PAUSE again pauses it');
  await midi([0xb1, 0x13, 0x00]); await midi([0xb1, 0x33, 0x00]);
  check(await ev(() => window.opendj.engine.channels[1].state.volume < 0.01), 'channel 2 fader (14-bit CC 0x13/0x33) to zero');
  await midi([0xb1, 0x13, 0x7f]); await midi([0xb1, 0x33, 0x7f]);
  await midi([0xb6, 0x1f, 0x00]); await midi([0xb6, 0x3f, 0x00]);
  check(await ev(() => window.opendj.engine.crossfader <= -0.99), 'crossfader (CC 0x1F ch7) hard left');
  await midi([0xb6, 0x1f, 0x40]); await midi([0xb6, 0x3f, 0x00]);
  await midi([0xb0, 0x07, 0x00]); await midi([0xb0, 0x27, 0x00]);
  check(await ev(() => window.opendj.engine.channels[0].state.eqHigh < -0.99), 'HI EQ ch1 (CC 0x07) to kill');
  await midi([0xb0, 0x07, 0x40]); await midi([0xb0, 0x27, 0x00]);
  await midi([0xb6, 0x18, 0x10]);
  check(await ev(() => window.opendj.engine.channels[1].state.filter < -0.5), 'CFX ch2 (CC 0x18 ch7) turns the filter');
  await midi([0xb6, 0x18, 0x40]); await midi([0xb6, 0x38, 0x00]);
  await midi([0x91, 0x54, 0x7f]); await midi([0x91, 0x54, 0x00]);
  check(await ev(() => window.opendj.engine.channels[1].state.cue), 'headphone CUE 2 (note 0x54 ch2) on');
  await midi([0x90, 0x3f, 0x7f]); check(await ev(() => window.opendj.shift === true), 'SHIFT held');
  await midi([0x90, 0x3f, 0x00]); check(await ev(() => window.opendj.shift === false), 'SHIFT released');
  // pads + shift layers
  await midi([0x97, 0x01, 0x7f]); await midi([0x97, 0x01, 0x00]);
  check(await ev(() => !!window.opendj.engine.decks[0].hotCue(1)), 'pad 2 (HOT CUE bank, ch8) sets hot cue B');
  await midi([0x98, 0x01, 0x7f]); await midi([0x98, 0x01, 0x00]);
  check(await ev(() => !window.opendj.engine.decks[0].hotCue(1)), 'SHIFT + pad 2 (ch9 shift layer) deletes it');
  await midi([0x97, 0x64, 0x7f]); await midi([0x97, 0x64, 0x00]);
  check(await ev(() => window.opendj.engine.decks[0].loop?.active && Math.abs(window.opendj.engine.decks[0].loopBeats - 4) < 1e-3), 'LOOP bank pad 5 (note 0x64) sets a 4-beat loop');
  await ev(() => window.opendj.engine.decks[0].exitLoop());
  await midi([0x90, 0x5c, 0x7f]); await midi([0x90, 0x5c, 0x00]); // SHIFT + BEAT SYNC: pad mode selection on the unit
  await midi([0x90, 0x05, 0x7f]); await midi([0x90, 0x05, 0x00]); // then pad 2
  check(await ev(() => window.opendj.ctl.padMode[1] === 'padfx'), 'pad mode selection: pad 2 (note 0x05 ch1) selects PAD FX');
  await midi([0x90, 0x00, 0x7f]); await midi([0x90, 0x00, 0x00]);
  check(await ev(() => window.opendj.ctl.padMode[1] === 'hotcue'), 'pad mode selection: pad 1 (note 0x00) selects HOT CUE');
  await midi([0xb0, 0x00, 0x00]); await midi([0xb0, 0x20, 0x00]);
  check(await ev(() => window.opendj.engine.decks[0].tempo <= -window.opendj.engine.decks[0].tempoRange + 0.01), 'TEMPO at 0x00 is the − end');
  await midi([0xb0, 0x00, 0x40]); await midi([0xb0, 0x20, 0x00]);
  await midi([0xb6, 0x0d, 0x00]); await midi([0xb6, 0x2d, 0x00]);
  check(await ev(() => (window.opendj.engine.hpVolume ?? 1) < 0.01), 'HEADPHONES LEVEL (CC 0x0D ch7)');
  await midi([0xb6, 0x0d, 0x66]); await midi([0xb6, 0x2d, 0x00]);
  // jog: touch + scratch, ring nudge, shift search
  await ev(() => { const d = window.opendj.engine.decks[1]; d.pause(); d.seek(5); });
  await page.waitForTimeout(100);
  const pos0 = await ev(() => window.opendj.engine.decks[1].position);
  await midi([0xb1, 0x29, 0x50]);
  check(await ev((p) => window.opendj.engine.decks[1].position > p + 0.5, pos0), 'SHIFT + jog (CC 0x29) searches forward');
  await midi([0x91, 0x36, 0x7f]);
  check(await ev(() => window.opendj.engine.decks[1]._jogTouched), 'jog touch (note 0x36)');
  await midi([0x91, 0x36, 0x00]);
  // smart functions
  await midi([0x96, 0x00, 0x7f]); await midi([0x96, 0x00, 0x00]);
  check(await ev(() => window.opendj.engine.channels[0].state.colorFx !== 'filter'), 'SHIFT + MASTER (SMART CFX, note 0x00 ch7) on: CFX knobs play a Color FX');
  await midi([0x91, 0x08, 0x7f]); await midi([0x91, 0x08, 0x00]);
  const preset = await ev(() => window.opendj.engine.channels[0].state.colorFx);
  await midi([0x96, 0x00, 0x7f]); await midi([0x96, 0x00, 0x00]);
  check(await ev(() => window.opendj.engine.channels[0].state.colorFx === 'filter') && preset !== 'filter', `SHIFT + CUE 2 (FX SELECT ▶ = Color FX next, note 0x08 ch2) picks ${preset}; SMART CFX off restores the filter`);
  await midi([0x96, 0x01, 0x7f]); await midi([0x96, 0x01, 0x00]);
  await midi([0xb6, 0x1f, 0x7f]); await midi([0xb6, 0x3f, 0x7f]);
  check(await ev(() => window.opendj.ctl.smartFader && window.opendj.engine.channels[0].state.eqLow < -0.9), 'SMART FADER: crossfader to B swaps the bass out of deck 1');
  await midi([0x96, 0x01, 0x7f]); await midi([0x96, 0x01, 0x00]);
  check(await ev(() => !window.opendj.ctl.smartFader && Math.abs(window.opendj.engine.channels[0].state.eqLow) < 0.01), 'SMART FADER off restores the EQ');
  await midi([0xb6, 0x1f, 0x40]); await midi([0xb6, 0x3f, 0x00]);
  await midi([0x96, 0x63, 0x7f]); await midi([0x96, 0x63, 0x00]);
  check(await ev(() => window.opendj.ctl.masterCue), 'MASTER cue on');
  await midi([0x96, 0x63, 0x7f]); await midi([0x96, 0x63, 0x00]);

  // ---------- LEDs ----------
  await ev(() => { window.__sent.length = 0; window.opendj.midi.ledState.clear(); const d = window.opendj.engine.decks[0]; d.play(); d.hotCueDown(0); d.hotCueUp(0); window.opendj.engine.channels[0].set('cue', true); window.opendj.engine.channels[1].set('cue', false); });
  await page.waitForTimeout(250);
  const leds = await ev(() => window.__sent.map((m) => m.join(',')));
  const has = (s) => leds.includes(s);
  check(has('144,11,127'), 'LED: deck 1 PLAY lit while playing');
  check(has('151,0,127') && has('151,1,0'), 'LED: hot cue pad A lit, B dark');
  check(has('144,84,127') && has('145,84,0'), 'LED: headphone CUE 1 lit, CUE 2 dark');
  check(has('144,0,127') && has('144,5,0'), 'LED: HOT CUE pad mode lit, PAD FX dark (pad mode selection notes)');
  check(has('159,0,127') && has('159,1,127') && has('144,23,127'), 'MIDI-OUT: track-loaded LEDs (ch16) and vinyl mode on (note 0x17)');
  check(leds.some((s) => s.startsWith('144,12,')) && leds.some((s) => s.startsWith('144,88,')), 'LED: CUE and BEAT SYNC sent');
  await ev(() => window.opendj.engine.decks.forEach((d) => d.pause()));

  // ---------- Controller test view + capture ----------
  await ev(async (DEV) => { const { openControllerTest } = await import('/js/ui/controller-test.js'); openControllerTest(window.opendj, DEV); }, DEV);
  await page.waitForSelector('.ctltest');
  await page.locator('.ctltest-rec').click();
  await midi([0x90, 0x0c, 0x7f]); await midi([0x90, 0x0c, 0x00]); await midi([0x90, 0x7e, 0x7f]);
  await page.waitForTimeout(100);
  check(await page.locator('.ctltest-row.ok').count() >= 2 && await page.locator('.ctltest-row.miss').count() >= 1, 'Controller test: shows mapped and unmapped messages live');
  check(await page.locator('.ctltest-item.seen').count() >= 1 && await page.locator('.ctltest-item.unv').count() === 0 && await page.locator('.ctltest-item.inf').count() >= 3, 'Controller test: checklist marks seen controls; every entry is from the chart, inferred functions are labelled');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.ctltest-rec').click()]);
  const capPath = path.join(tmp, 'capture.json'); await dl.saveAs(capPath);
  const cap = JSON.parse(fs.readFileSync(capPath, 'utf8'));
  check(cap.opendjCapture === 1 && cap.device === DEV && cap.events.length === 3 && cap.mapping.presetId === 'opendj-flx2', `capture file saved (${cap.events.length} events)`);
  await page.screenshot({ path: path.join(shots, 'controller-test.png') });
  await page.keyboard.press('Escape');

  // ---------- Smart Fader button next to the crossfader ----------
  await page.locator('.mixer .smart-xf:visible').first().click();
  check(await ev(() => window.opendj.ctl.smartFader) && await page.locator('.smart-xf.active').count() === 1, 'mixer SMART button turns the Smart Fader on');
  await midi([0x96, 0x01, 0x7f]); await midi([0x96, 0x01, 0x00]); await page.waitForTimeout(80);
  check(await ev(() => !window.opendj.ctl.smartFader) && await page.locator('.smart-xf.active').count() === 0, 'the hardware SMART FADER turns it off and the button follows');
  await page.screenshot({ path: path.join(shots, 'mixer-smart-fader.png'), clip: await page.locator('.mixer').boundingBox() });

  // ---------- DECK SELECT layers ----------
  await ev(async () => { const a = window.opendj; await a.setDeckCount(4, false); });
  for (let i = 2; i < 4; i++) { await ev(([i, id]) => window.opendj.loadTrack(i, id), [i, ids[i]]); await page.waitForFunction((i) => !!window.opendj.engine.decks[i].track, i, { timeout: 30000 }); }
  await ev(async (DEV) => { const { controllersPanel } = await import('/js/ui/controllers-panel.js'); const { el } = await import('/js/util.js'); document.body.append(el('div', { class: 'overlay e2e-ctl' }, el('div', { class: 'modal wide' }, el('div', { class: 'modal-body' }, controllersPanel(window.opendj))))); }, DEV);
  await page.locator('.ctl-card', { hasText: DEV }).click();
  await page.locator('.ctl-layers .ctl-layer').first().locator('button', { hasText: 'Deck 3' }).click();
  await ev(() => window.opendj.engine.decks.forEach((d) => d.pause()));
  await midi([0x90, 0x0b, 0x7f]); await midi([0x90, 0x0b, 0x00]);
  check(await ev(() => window.opendj.engine.decks[2].playing && !window.opendj.engine.decks[0].playing), 'Settings → Controllers: left side on deck 3, the controller\'s left PLAY plays deck 3');
  await midi([0xb0, 0x13, 0x00]); await midi([0xb0, 0x33, 0x00]);
  check(await ev(() => window.opendj.engine.channels[2].state.volume < 0.01 && window.opendj.engine.channels[0].state.volume > 0.5), 'its channel fader drives channel 3');
  await page.screenshot({ path: path.join(shots, 'controllers-deck-layers.png') });
  await ev(() => { window.opendj.midi.dispatch({ target: 'deckSelect.left' }, 1); window.opendj.engine.decks.forEach((d) => d.pause()); window.opendj.engine.channels[2].set('volume', 0.8); document.querySelector('.e2e-ctl')?.remove(); });
  check(await ev(() => window.opendj.ctl.layer[0] === 0), '"Deck select: left" target switches back to deck 1');
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 4).join(' | ') : ''}`);
  console.log(`screenshots: ${shots}`);
} catch (e) { console.error(e); failed = true; }
await browser.close(); app.server.close();
console.log(`\n${checks} checks`);
console.log(failed ? 'FLX2 E2E FAILED' : 'FLX2 E2E PASSED');
process.exit(failed ? 1 : 0);
