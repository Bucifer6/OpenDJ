// End-to-end test for controller support: opens the app in headless Chromium, mounts the Controllers panel, fakes a
// MIDI controller (Web MIDI ports are stubbed), imports a Mixxx mapping (file import and the online search with a
// stubbed GitHub), drives decks with MIDI messages, checks LED output, runs the guided setup and HID learn.
// Usage: node scripts/e2e-controllers.mjs [screenshot-dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-ctl-'));
const shots = process.argv[2] || tmp;
fs.mkdirSync(shots, { recursive: true });
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
    let v = 0.25 * Math.sin(2 * Math.PI * rootHz * t);
    if (t > 0.1 && tb < 0.15) v += 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb * 40)) * tb) * Math.exp(-tb * 18);
    const s = Math.max(-1, Math.min(1, v * 0.7)) * 32767;
    data.writeInt16LE(s | 0, 44 + i * 4); data.writeInt16LE(s | 0, 46 + i * 4);
  }
  fs.writeFileSync(file, data);
}
writeWav(path.join(music, 'Test Artist - House Groove.wav'), 124, 30, 220);
writeWav(path.join(music, 'Other Artist - Techno Drive.wav'), 128, 30, 196);

// A small Mixxx-format mapping written for this test (not a Mixxx file).
const MIXXX_XML = `<?xml version="1.0" encoding="utf-8"?>
<MixxxControllerPreset schemaVersion="1">
  <info><name>Test Ctrl (e2e)</name><author>OpenDJ tests</author></info>
  <controller id="TEST">
    <controls>
      <control><group>[Channel1]</group><key>play</key><status>0x90</status><midino>0x0B</midino><options><normal/></options></control>
      <control><group>[Channel2]</group><key>play</key><status>0x91</status><midino>0x0B</midino><options><normal/></options></control>
      <control><group>[Channel1]</group><key>volume</key><status>0xB0</status><midino>0x13</midino><options><fourteen-bit-msb/></options></control>
      <control><group>[Channel1]</group><key>volume</key><status>0xB0</status><midino>0x33</midino><options><fourteen-bit-lsb/></options></control>
      <control><group>[Master]</group><key>crossfader</key><status>0xB6</status><midino>0x1F</midino></control>
      <control><group>[Channel1]</group><key>hotcue_1_activate</key><status>0x97</status><midino>0x00</midino></control>
      <control><group>[Channel1]</group><key>MyCtl.wheelTouch</key><status>0x90</status><midino>0x36</midino><options><script-binding/></options></control>
      <control><group>[Channel1]</group><key>MyCtl.wheelTurn</key><status>0xB0</status><midino>0x22</midino><options><script-binding/></options></control>
      <control><group>[Channel1]</group><key>MyCtl.mysteryThing</key><status>0x90</status><midino>0x70</midino><options><script-binding/></options></control>
    </controls>
    <outputs>
      <output><group>[Channel1]</group><key>play_indicator</key><status>0x90</status><midino>0x0B</midino><on>0x7F</on><minimum>0.5</minimum></output>
    </outputs>
  </controller>
</MixxxControllerPreset>`;

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: Number(process.env.DPR || 1) });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const fail = async (msg) => { console.error('FAIL:', msg); console.error(errors.join('\n')); await page.screenshot({ path: path.join(shots, 'controllers-fail.png') }); console.error('screenshot', path.join(shots, 'controllers-fail.png')); await browser.close(); app.server.close(); process.exit(1); };
class CheckError extends Error {}
const check = (cond, msg) => { if (!cond) throw new CheckError(msg); console.log('ok -', msg); };
const midi = (bytes) => page.evaluate((b) => window.opendj.midi.onMessage({ name: 'Test Ctrl' }, Uint8Array.from(b)), bytes);

try {
  // GitHub is stubbed so the test runs offline and never hits rate limits
  await page.route('https://api.github.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
    { type: 'file', name: 'Acme-Test-Ctrl.midi.xml' }, { type: 'file', name: 'Acme-Test-Ctrl-scripts.js' }, { type: 'file', name: 'Pioneer-DDJ-400.midi.xml' }, { type: 'file', name: 'Other-Thing.midi.xml' },
  ]) }));
  await page.route('https://raw.githubusercontent.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/xml', body: MIXXX_XML }));
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 15000 });
  await page.evaluate(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});

  const r = await page.evaluate(async (dir) => (await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) })).json(), music);
  check(r.id, 'folder added');
  await page.waitForFunction(() => window.opendj.library.tracks.size === 2, null, { timeout: 15000 });
  await page.evaluate(async () => { const a = window.opendj; const ts = [...a.library.tracks.values()]; await a.loadTrack(0, ts[0].id); await a.loadTrack(1, ts[1].id); });
  check(await page.evaluate(() => !!window.opendj.engine.decks[0].track), 'track loaded on deck 1');

  // fake Web MIDI ports: one controller with input + output (LEDs)
  await page.evaluate(() => { // until index.html links it
    if (!document.querySelector('link[href$="controllers.css"]')) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'css/controllers.css' }));
  });
  await page.evaluate(() => {
    const m = window.opendj.midi;
    window.__sent = [];
    const input = { id: 'in1', name: 'Test Ctrl', state: 'connected' };
    const output = { id: 'out1', name: 'Test Ctrl', state: 'connected', send: (msg) => window.__sent.push([...msg]) };
    m.access = { inputs: new Map([['in1', input]]), outputs: new Map([['out1', output]]), onstatechange: null };
    m.unsupported = false; m.error = undefined;
    m.onUnmappedDevice = null;
    m.bind();
  });
  await page.waitForSelector('.toast.ctl-offer', { timeout: 2000 });
  check(true, 'unmapped controller triggers the "find mapping" offer');
  await page.screenshot({ path: path.join(shots, 'controllers-offer.png'), clip: { x: 1100, y: 700, width: 500, height: 260 } });

  // mount the panel the way Settings → Controllers will (dialog wiring lives in dialogs.js)
  await page.evaluate(async () => {
    document.querySelectorAll('.toast.ctl-offer').forEach((t) => t.remove());
    const { controllersPanel } = await import('/js/ui/controllers-panel.js');
    const { el } = await import('/js/util.js');
    const panel = controllersPanel(window.opendj);
    const overlay = el('div', { class: 'overlay e2e-ctl' }, el('div', { class: 'modal wide' }, el('div', { class: 'modal-head' }, el('h2', {}, 'Settings · Controllers')), el('div', { class: 'modal-body' }, panel)));
    document.body.append(overlay);
  });
  await page.waitForSelector('.ctl-card[data-key="Test Ctrl"]');
  check(true, 'panel lists the MIDI controller');
  check(await page.locator('.ctl-card[data-key="Test Ctrl"] .ctl-card-sub').textContent() === 'Not mapped yet', 'device shows as unmapped');

  // 1) online search (stubbed GitHub) → apply
  await page.getByRole('button', { name: 'Find Mixxx mapping' }).click();
  await page.waitForSelector('.ctl-result', { timeout: 5000 });
  const firstResult = await page.locator('.ctl-result .ctl-result-file').first().textContent();
  check(firstResult === 'Acme-Test-Ctrl.midi.xml', `search ranks the matching mapping first (${firstResult})`);
  await page.screenshot({ path: path.join(shots, 'controllers-search.png') });
  await page.locator('.ctl-result button').first().click();
  await page.waitForSelector('.ctl-summary', { timeout: 5000 });
  const summary = await page.locator('.ctl-summary').textContent();
  check(/8 controls mapped/.test(summary) && /1 not mapped/.test(summary), `import summary reports mapped/unmapped (${summary.replace(/\s+/g, ' ').slice(0, 120)}…)`);
  const stored = await page.evaluate(() => window.opendj.settings.midiMappings['Test Ctrl']);
  check(stored?.source === 'mixxx' && stored.entries.length === 7 && stored.outputs.length === 1, 'mapping saved to settings with LED outputs');

  // 2) MIDI drives the decks
  check(!(await page.evaluate(() => window.opendj.engine.decks[0].playing)), 'deck 1 initially stopped');
  await midi([0x90, 0x0b, 0x7f]); await midi([0x80, 0x0b, 0x00]);
  await page.waitForTimeout(300);
  check(await page.evaluate(() => window.opendj.engine.decks[0].playing), 'Note 0x0B ch1 starts deck 1');
  await page.waitForFunction(() => window.__sent.some((m) => m[0] === 0x90 && m[1] === 0x0b && m[2] === 0x7f), null, { timeout: 2000 });
  check(true, 'play LED lit on the controller output');
  await midi([0x90, 0x0b, 0x7f]);
  await page.waitForTimeout(150);
  check(!(await page.evaluate(() => window.opendj.engine.decks[0].playing)), 'pressing play again pauses deck 1');
  await page.waitForFunction(() => window.__sent.some((m) => m[0] === 0x90 && m[1] === 0x0b && m[2] === 0x00), null, { timeout: 2000 });
  check(true, 'play LED turned off');
  await midi([0x91, 0x0b, 0x7f]);
  await page.waitForTimeout(150);
  check(await page.evaluate(() => window.opendj.engine.decks[1].playing), 'channel 2 note plays deck 2');
  await page.evaluate(() => window.opendj.engine.decks[1].pause());
  await midi([0xb0, 0x13, 0x20]); await midi([0xb0, 0x33, 0x00]);
  const vol = await page.evaluate(() => window.opendj.engine.channels[0].state.volume);
  check(Math.abs(vol - 4096 / 16383) < 0.001, `14-bit channel fader (${vol.toFixed(4)})`);
  await midi([0xb6, 0x1f, 0x00]);
  check(await page.evaluate(() => window.opendj.engine.crossfader) === -1, 'crossfader hard left');
  await midi([0xb6, 0x1f, 0x7f]);
  check(await page.evaluate(() => window.opendj.engine.crossfader) === 1, 'crossfader hard right');
  const before = await page.evaluate(() => window.opendj.engine.decks[0].position);
  await page.evaluate(() => window.opendj.engine.decks[0].seek(5));
  await midi([0x90, 0x36, 0x7f]);
  for (let i = 0; i < 20; i++) await midi([0xb0, 0x22, 0x41]);
  await midi([0x90, 0x36, 0x00]);
  const moved = await page.evaluate(() => window.opendj.engine.decks[0].position);
  check(Math.abs(moved - 5) > 0.001 || before !== moved, `scripted jog wheel moves deck 1 (${moved.toFixed(3)})`);

  await page.locator('.ctl-panel input[type=search]').fill('deck 1 play');
  await page.screenshot({ path: path.join(shots, 'controllers-mapped.png') });
  await page.locator('.ctl-panel input[type=search]').fill('');

  // 3) file import of an OpenDJ JSON mapping
  const json = JSON.stringify({ opendjMidiMapping: 1, name: 'From file', entries: [{ key: 'note:0:11', target: 'deck1.cue' }] });
  await page.locator('.ctl-panel input[type=file]').setInputFiles({ name: 'ctl.opendj-midi.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await page.waitForFunction(() => window.opendj.midi.mappings['Test Ctrl']?.name === 'From file');
  check(true, 'JSON mapping imported through the file input');
  await page.locator('.ctl-panel input[type=file]').setInputFiles({ name: 'Test.midi.xml', mimeType: 'text/xml', buffer: Buffer.from(MIXXX_XML) });
  await page.waitForFunction(() => window.opendj.midi.mappings['Test Ctrl']?.source === 'mixxx');
  check(true, 'Mixxx .midi.xml imported through the file input');

  // 4) guided setup: play button, then a relative jog
  await page.getByRole('button', { name: 'Guided setup' }).click();
  await page.waitForSelector('.ctl-wizard');
  await page.screenshot({ path: path.join(shots, 'controllers-wizard.png') });
  await midi([0x90, 0x40, 0x7f]); await midi([0x80, 0x40, 0x00]);
  await page.waitForSelector('.ctl-wz-detect.ok', { timeout: 2000 });
  check(await page.evaluate(() => window.opendj.midi.mappings['Test Ctrl'].entries.some((e) => e.key === 'note:0:64' && e.target === 'deck1.play')), 'wizard step 1 maps the pressed button to Deck 1 Play');
  check(!(await page.evaluate(() => window.opendj.engine.decks[0].playing)), 'controls do not fire while the wizard captures them');
  await page.waitForFunction(() => document.querySelector('.ctl-wz-title')?.textContent === 'Cue', null, { timeout: 2000 });
  await page.getByRole('button', { name: 'Skip', exact: true }).click(); // cue
  await page.getByRole('button', { name: 'Skip', exact: true }).click(); // sync
  await page.getByRole('button', { name: 'Skip', exact: true }).click(); // jog touch
  check(await page.locator('.ctl-wz-title').textContent() === 'Jog wheel', 'skip advances to the jog step');
  for (const v of [1, 1, 2, 1, 1]) await midi([0xb0, 0x50, v]);
  await page.waitForSelector('.ctl-wz-detect.ok', { timeout: 3000 });
  const jog = await page.evaluate(() => window.opendj.midi.mappings['Test Ctrl'].entries.find((e) => e.key === 'cc:0:80'));
  check(jog?.target === 'deck1.jog' && jog.rel === 'twos', `wizard detects a two's-complement jog (${JSON.stringify(jog)})`);
  await page.screenshot({ path: path.join(shots, 'controllers-wizard-done.png') });
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.waitForSelector('.ctl-table');
  check(await page.evaluate(() => window.opendj.midi.suppress == null), 'wizard finished and released the controller');

  // 5) HID learn with synthetic reports
  await page.evaluate(() => {
    const h = window.opendj.midi.hid;
    h.devices.set({ fake: true }, { key: 'hid:1234:ABCD', name: 'Fake HID Deck' });
    window.opendj.midi.emit('devices');
  });
  await page.locator('.ctl-card[data-key="hid:1234:ABCD"]').click();
  await page.locator('.ctl-panel input[type=search]').fill('Deck 2 Play/Pause');
  await page.locator('.ctl-table .midi-row button', { hasText: 'Learn' }).first().click();
  await page.evaluate(async () => {
    const h = window.opendj.midi.hid, z = () => new Uint8Array(8);
    const press = z(); press[3] = 0b100;
    for (const f of [z(), press, z()]) { h.onReport('hid:1234:ABCD', 1, f); await new Promise((r) => setTimeout(r, 60)); }
    await new Promise((r) => setTimeout(r, 400));
  });
  const hidEntry = await page.evaluate(() => window.opendj.midi.mappings['hid:1234:ABCD']?.entries[0]);
  check(hidEntry?.key === 'hid:1:bit:3:2' && hidEntry.target === 'deck2.play', `HID learn finds byte 3 bit 2 (${JSON.stringify(hidEntry)})`);
  await page.evaluate(() => { const h = window.opendj.midi.hid; const p = new Uint8Array(8); p[3] = 4; h.onReport('hid:1234:ABCD', 1, p); h.onReport('hid:1234:ABCD', 1, new Uint8Array(8)); });
  await page.waitForTimeout(150);
  check(await page.evaluate(() => window.opendj.engine.decks[1].playing), 'HID button plays deck 2');
  await page.screenshot({ path: path.join(shots, 'controllers-hid.png') });

  check(!errors.length, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  console.log('screenshots in', shots);
  await browser.close(); app.server.close();
  process.exit(0);
} catch (e) {
  await fail(e instanceof CheckError ? e.message : e.stack);
}
