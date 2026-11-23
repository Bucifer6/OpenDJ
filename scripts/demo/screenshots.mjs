// README screenshots: starts OpenDJ on a throw-away data folder with the fictional demo library
// (scripts/demo/make-demo-library.mjs), sets up a realistic mid-set state and captures docs/images/*.
//
//   node scripts/demo/screenshots.mjs [shot ...] [--lib=<dir>] [--out=<dir>] [--no-gif]
//
// Shots: hero four-decks library stems video lighting controllers cdj-export recording dvs automix
//        settings-appearance themes gif   (default: all)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { start } from '../../server/index.js';
import { makeDemoLibrary, ffmpegPath, TRACKS } from './make-demo-library.mjs';
import { TIMECODES } from '../../public/js/dvs/timecode-defs.js';
import { generateTimecode, encodeWav } from '../../public/js/dvs/timecode-gen.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const ALL = ['hero', 'four-decks', 'library', 'stems', 'video', 'lighting', 'controllers', 'cdj-export', 'recording', 'automix', 'settings-appearance', 'themes', 'gif', 'dvs'];
let wanted = argv.filter((a) => !a.startsWith('--'));
if (!wanted.length) wanted = ALL.filter((s) => !(s === 'gif' && argv.includes('--no-gif')));
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/images')));
fs.mkdirSync(OUT, { recursive: true });
const VIEW = { width: 1600, height: 960 };
const DSF = 2;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-shots-'));
const lib = await makeDemoLibrary(path.resolve(opt('lib', path.join(os.tmpdir(), 'opendj-demo-library'))));
const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const log = (...a) => console.log('[shots]', ...a);

// a Serato timecode "record" for the DVS shot (Chromium's fake capture device plays it as the audio input)
const tcDef = TIMECODES.serato_2a;
const tc = generateTimecode({ def: tcDef, sampleRate: 44100, seconds: 60, startCycle: 95 * tcDef.carrier, amplitude: 0.45, noise: 0.01 });
const tcWav = path.join(tmp, 'timecode.wav');
fs.writeFileSync(tcWav, encodeWav(tc.L, tc.R, 44100));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${tcWav}`] });
const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: DSF, permissions: ['microphone'] });
const page = await context.newPage();
const failures = [];
page.on('pageerror', (e) => { failures.push(String(e)); console.error('[page error]', String(e)); });
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[console]', m.text()); });
const sleep = (ms) => page.waitForTimeout(ms);
const ev = (fn, arg) => page.evaluate(fn, arg);

const sizes = [];
async function save(name, opts = {}) {
  const jpeg = opts.type === 'jpeg';
  const file = path.join(OUT, `${name}.${jpeg ? 'jpg' : 'png'}`);
  await ev(() => document.activeElement?.blur?.());
  await (opts.locator || page).screenshot({ path: file, ...(jpeg ? { type: 'jpeg', quality: opts.quality || 88 } : {}), ...(opts.clip ? { clip: opts.clip } : {}) });
  const kb = Math.round(fs.statSync(file).size / 1024);
  sizes.push([path.basename(file), kb]);
  log(`${path.basename(file)} ${kb} KB`);
  return file;
}
async function closeOverlays() {
  await ev(() => { document.querySelectorAll('.overlay .modal-x').forEach((x) => x.click()); document.querySelectorAll('.ctx-menu, .toast').forEach((x) => x.remove()); });
  await sleep(150);
}
/** Library state shared by every shot: ratings, colours, tags, playlists, a smart playlist and play history. */
async function setupLibrary() {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
  await ev(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
  await ev(async (dir) => fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir, name: 'Demo Music' }) }), lib);
  await page.waitForFunction((n) => window.opendj.library.tracks.size === n, TRACKS.length, { timeout: 60000 });
  const ids = await ev(() => Object.fromEntries([...window.opendj.library.tracks.values()].map((t) => [t.title, t.id])));
  const T = (title) => ids[title];
  // ratings, colours and My Tags
  const meta = {
    'Midnight Transit': { rating: 5, color: '#ff007f', tags: ['Peak', 'Vocal'] },
    'Glass Horizon': { rating: 4, color: '#25fde9', tags: ['Warm-up'] },
    'Pressure Index': { rating: 5, color: '#ffa500', tags: ['Peak', 'Groovy'] },
    'Copper Skyline': { rating: 4, color: '#ffa500', tags: ['Groovy'] },
    'Iron Meridian': { rating: 3, color: '#ff0000', tags: ['Dark'] },
    'Static Bloom': { rating: 4, color: '#ff0000', tags: ['Dark', 'Peak'] },
    'Signal Fire': { rating: 5, color: '#00ff00', tags: ['Energy'] },
    // the analyser hears this one half-time (86): lock the tagged tempo like a DJ would in the beat grid editor
    'Liquid Coastline': { rating: 3, color: '#0000ff', tags: ['Rollers'], bpm: 172, bpmLocked: true },
    'Saturday Satellite': { rating: 4, color: '#ffff00', tags: ['Warm-up', 'Classic feel'] },
    'Golden Hour Fever': { rating: 5, color: '#ffff00', tags: ['Sunset'] },
    'Concrete Lullaby': { rating: 3, color: '#660099', tags: ['Chill'] },
    'Late Night Ledger': { rating: 4, color: '#660099', tags: ['Chill'] },
  };
  for (const [title, patch] of Object.entries(meta)) await ev(([id, p]) => fetch(`/api/tracks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }), [T(title), patch]);
  const post = (url, body) => ev(([u, b]) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json()), [url, body]);
  await post('/api/playlists', { name: 'Friday — Warehouse', folder: 'Gigs', trackIds: ['Copper Skyline', 'Pressure Index', 'Midnight Transit', 'Iron Meridian', 'Static Bloom'].map(T) });
  await post('/api/playlists', { name: 'Rooftop Sunset', folder: 'Gigs', trackIds: ['Golden Hour Fever', 'Saturday Satellite', 'Glass Horizon', 'Midnight Transit'].map(T) });
  await post('/api/playlists', { name: 'Late Night Beats', trackIds: ['Concrete Lullaby', 'Late Night Ledger', 'Liquid Coastline'].map(T) });
  await post('/api/playlists', { name: 'Peak Time 124–132', smart: { match: 'all', rules: [{ field: 'bpm', op: 'between', value: 124, value2: 132 }, { field: 'rating', op: 'gt', value: 3 }] } });
  await post('/api/playlists', { name: 'Five Stars', smart: { match: 'all', rules: [{ field: 'rating', op: 'is', value: 5 }] } });
  // play history: last Saturday's set (recorded straight into the server's history store)
  const tracks = await ev(() => [...window.opendj.library.tracks.values()]);
  const byTitle = Object.fromEntries(tracks.map((t) => [t.title, t]));
  const sat = new Date(); sat.setDate(sat.getDate() - ((sat.getDay() + 1) % 7 || 7)); sat.setHours(22, 4, 0, 0);
  // the older session first: a play is appended to the latest session unless it starts 2 h after it
  let at = sat.getTime() - 6 * 864e5 + 2 * 3600e3;
  for (const title of ['Saturday Satellite', 'Golden Hour Fever', 'Glass Horizon', 'Midnight Transit']) { app.history.record(byTitle[title], at); at += 4 * 60e3; }
  app.history.rename(app.history.list()[0].id, 'Rooftop Sunset');
  at = sat.getTime();
  for (const title of ['Glass Horizon', 'Copper Skyline', 'Pressure Index', 'Midnight Transit', 'Static Bloom', 'Iron Meridian', 'Signal Fire']) { app.history.record(byTitle[title], at); at += 4 * 60e3 + Math.round(Math.random() * 60e3); }
  app.history.rename(app.history.list()[0].id, 'Warehouse Party');
  app.history.flush();
  await ev(() => window.opendj.library.refresh());
  return { ids, T };
}

async function loadDeck(i, id) {
  if (await ev(([i, id]) => window.opendj.engine.decks[i].track?.id === id, [i, id])) return;
  await ev((i) => window.opendj.engine.decks[i].pause(), i); // loading onto a playing deck asks for confirmation
  await ev(([i, id]) => window.opendj.loadTrack(i, id), [i, id]);
  await page.waitForFunction((i) => !!window.opendj.engine.decks[i].waveform, i, { timeout: 60000 });
}

// --------------------------------------------------------------------- main
const { T } = await setupLibrary();
log('library ready');
// analyse every track (loading analyses it) so BPM / key / energy show in the library
for (const title of Object.keys(TRACKS.reduce((a, t) => ({ ...a, [t.title]: 1 }), {}))) await loadDeck(3, T(title));
log('all tracks analysed');

async function heroState() {
  await closeOverlays();
  await ev(() => { const a = window.opendj; a.engine.decks.forEach((d) => { d.pause(); d.exitLoop?.(); }); a.setDeckCount(2, false); a.engine.channels.forEach((c) => { for (const k of ['eqLow', 'eqMid', 'eqHigh', 'filter']) c.set(k, 0); c.set('fxOn', false); }); });
  await loadDeck(0, T('Pressure Index'));
  await loadDeck(1, T('Copper Skyline'));
  await ev(() => {
    const a = window.opendj, E = a.engine, [d1, d2] = E.decks;
    E.decks.forEach((d) => d.showPanel?.('cues'));
    d1.setMaster?.();
    d1.seek(d1.beatLen * 4 * 46); // inside the first drop
    d2.seek(d2.beatLen * 4 * 8);
    E.channels[0].set('volume', 1); E.channels[1].set('volume', 0.85);
    E.channels[1].set('eqLow', -0.75); // bass swapped out on the incoming deck
    E.channels[0].set('eqHigh', 0.15);
    E.channels[0].set('fxType', 'echo'); E.channels[0].set('fxOn', true); E.channels[0].set('fxMix', 0.35);
    E.channels[1].set('filter', 0.18);
    E.setCrossfader(0);
    d1.play(); d2.play(); d2.sync();
    d1.setKeyLock?.(true); d2.setKeyLock?.(true);
  });
  await sleep(400);
  await ev(() => { const d2 = window.opendj.engine.decks[1]; d2.autoLoop(8); });
  await ev(() => { window.opendj.mixer.renderAll?.(); window.opendj.library.select?.('playlist'); });
}

const deckArea = () => ev(() => { const r = document.querySelector('.deck-area').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
const setBrowserHeight = (px) => ev((px) => document.documentElement.style.setProperty('--browser-h', px ? `${px}px` : ''), px);
const setTheme = (id) => ev(async (id) => { const { applyTheme } = await import('/js/ui/themes.js'); await window.opendj.setSetting('theme', id); applyTheme(window.opendj.settings); }, id);
const view = (kind, name) => ev(([kind, name]) => {
  const L = window.opendj.library;
  const p = name ? (kind === 'session' ? L.sessions.find((s) => (s.name || '') === name) : L.playlists.find((x) => x.name === name)) : null;
  return L.setView(p ? { kind, id: p.id } : { kind }, p?.name || name || 'Collection');
}, [kind, name]);

const shots = {
  async hero() {
    await heroState();
    await sleep(1500);
    await save('hero', { type: 'jpeg' });
  },

  async 'four-decks'() {
    await heroState();
    await ev(() => window.opendj.setDeckCount(4, false));
    await loadDeck(2, T('Static Bloom'));
    await loadDeck(3, T('Midnight Transit'));
    await ev(() => {
      const E = window.opendj.engine, [, , d3, d4] = E.decks;
      d3.seek(d3.beatLen * 4 * 24); d4.seek(d4.beatLen * 4 * 56);
      d3.play(); d3.sync(); E.channels[2].set('volume', 0.6); E.channels[2].set('eqHigh', -0.4);
      d4.sync(); E.channels[3].set('volume', 0);
    });
    await sleep(1200);
    await save('four-decks', { type: 'jpeg' });
    await ev(() => { const E = window.opendj.engine; E.decks[2].pause(); E.decks[3].pause(); window.opendj.setDeckCount(2, false); });
  },

  async library() {
    await heroState();
    await setBrowserHeight(540);
    await view('all');
    await sleep(600);
    await sleep(300);
    const r = await ev(() => { const b = document.querySelector('.library, .browser, #library') || window.opendj.library.root; const x = b.getBoundingClientRect(); return { x: 0, y: x.y - 2, width: innerWidth, height: innerHeight - x.y + 2 }; });
    await save('library', { clip: r, type: 'jpeg' });
    await setBrowserHeight(0);
    await view('all');
  },

  async stems() {
    await heroState();
    await ev(() => { window.opendj.engine.decks.forEach((d) => d.pause()); });
    await ev(async (id) => { const a = window.opendj; a.stems.useStub('bands'); await a.stems.enqueue([id], { interactive: false }); }, T('Midnight Transit'));
    await page.waitForFunction((id) => window.opendj.library.track(id)?.stems?.ready, T('Midnight Transit'), { timeout: 300000 });
    await loadDeck(0, T('Midnight Transit'));
    await page.waitForFunction(() => window.opendj.engine.decks[0].stemsReady, null, { timeout: 60000 });
    await ev(() => {
      const a = window.opendj, E = a.engine, d = E.decks[0];
      d.showPanel('stems');
      d.seek(d.beatLen * 4 * 72); d.play(); d.sync?.();
      d.setStemMute(1, true); // drums out
      d.setStemLevel(2, 0.6);
      E.channels[0].set('volume', 1);
    });
    await sleep(1500);
    const r = await deckArea();
    const right = await ev(() => document.querySelector('.deck-area .mixer, .deck-area > :nth-child(2)').getBoundingClientRect().right);
    await save('stems', { clip: { x: 0, y: r.y - 170, width: right + 4, height: r.height + 170 }, type: 'jpeg' });
    await ev(() => { const d = window.opendj.engine.decks[0]; d.setStemMute(1, false); d.setStemLevel(2, 1); });
  },

  async video() {
    await heroState();
    await ev(async () => {
      const a = window.opendj;
      const api = (a.videoUi ||= (await import('/js/video/video-ui.js')).setupVideo(a));
      api.openPanel();
      const m = a.video.mixer; m.setFx(0, 'kaleido', true); m.setOverlay({ text: 'WAREHOUSE · SAT' });
      m.showNowPlaying('Kairo Vance – Pressure Index');
    });
    await sleep(2500);
    await save('video', { type: 'jpeg' });
    await ev(() => { const a = window.opendj; a.video.mixer.setFx(0, 'kaleido', false); a.video.mixer.setOverlay({ text: '' }); a.video.api.closePanel(); });
  },

  async lighting() {
    await heroState();
    await ev(async () => {
      const L = window.opendj.lighting;
      await L.saveConfig({
        enabled: true,
        fixtures: [
          ...[1, 2, 3, 4].map((n) => ({ id: `par${n}`, name: `Par ${n}`, type: 'rgb', channels: ['dim', 'r', 'g', 'b', 'strobe'], universe: 1, address: 1 + (n - 1) * 5, group: n <= 2 ? 'left' : 'right' })),
          { id: 'mh1', name: 'Wash L', type: 'rgb', channels: ['dim', 'r', 'g', 'b'], universe: 1, address: 21, group: 'left' },
          { id: 'mh2', name: 'Wash R', type: 'rgb', channels: ['dim', 'r', 'g', 'b'], universe: 1, address: 25, group: 'right' },
          { id: 'strobe1', name: 'Strobe', type: 'strobe', channels: ['dim', 'rate'], universe: 1, address: 29 },
          { id: 'strip1', name: 'Bar strip', type: 'wled-strip', host: '', pixels: 60 },
        ],
        show: { auto: true, colorMode: 'key' },
        outputs: {},
      });
      L.setLive({ auto: true });
      L.openPanel();
    });
    await page.waitForSelector('.lt-stage .lt-node', { timeout: 10000 }).catch(() => {});
    await sleep(1800);
    await save('lighting', { type: 'jpeg' });
  },

  async controllers() {
    await ev(() => {
      const m = window.opendj.midi;
      const input = { id: 'in1', name: 'DDJ-FLX4', state: 'connected' };
      const output = { id: 'out1', name: 'DDJ-FLX4', state: 'connected', send: () => {} };
      m.access = { inputs: new Map([['in1', input]]), outputs: new Map([['out1', output]]), onstatechange: null };
      m.unsupported = false; m.error = undefined; m.onUnmappedDevice = null;
      m.bind();
      document.querySelectorAll('.toast').forEach((t) => t.remove());
      window.opendj.dialogs.settings('controllers'); // resolves on close: not awaited
    });
    await sleep(1200);
    await ev(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await save('controllers', { locator: page.locator('.overlay .modal').last() });
  },

  async 'cdj-export'() {
    const usb = path.join(tmp, 'USB-STICK'); fs.mkdirSync(usb, { recursive: true });
    await ev(async () => {
      const a = window.opendj; const ids = a.library.playlists.filter((p) => p.folder === 'Gigs').map((p) => p.id);
      (await import('/js/cdj/export-dialog.js')).openCdjExport(a, ids);
    });
    await page.waitForSelector('.cdj-target', { timeout: 10000 });
    await page.locator('.cdj-target').fill(usb);
    await page.locator('.cdj-target').dispatchEvent('change');
    await sleep(1500);
    await ev(() => { document.querySelector('.cdj-target').value = '/Volumes/DJ-USB'; }); // cosmetic: hide the temp path
    await save('cdj-export', { locator: page.locator('.overlay .modal').last() });
  },

  async recording() {
    await heroState();
    await ev((folder) => fetch('/api/recording/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder, format: 'flac', splitTracks: true }) }), path.join(tmp, 'Recordings'));
    await ev(() => fetch('/api/broadcast/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: [{ type: 'icecast', name: 'Home radio', host: 'radio.example.org', port: 8000, mount: '/live', password: 'demo', format: 'mp3', bitrate: 192, enabled: true }, { type: 'rtmp', name: 'Stream (RTMP)', url: 'rtmp://live.example.com/app', key: 'demo', enabled: false }] }) }));
    await ev(() => { window.opendj.recording.openPanel('record'); }); // resolves when the dialog closes: don't wait for it
    await sleep(1200);
    await ev(() => { // cosmetic: show typical paths instead of the temp folder
      const m = document.querySelectorAll('.overlay .modal'); const box = m[m.length - 1];
      for (const i of box.querySelectorAll('input')) if (i.value.includes('opendj-shots-')) i.value = '~/Music/OpenDJ Recordings';
      for (const n of box.querySelectorAll('.hint, small, p, span')) if (n.children.length === 0 && /^Default: /.test(n.textContent)) n.textContent = 'Default: ~/Music/OpenDJ Recordings';
    });
    await save('recording', { locator: page.locator('.overlay .modal').last() });
    await closeOverlays();
    await ev(() => { window.opendj.recording.openPanel('broadcast'); }); // resolves when the dialog closes: don't wait for it
    await sleep(1000);
    await save('broadcast', { locator: page.locator('.overlay .modal').last() });
  },

  async automix() {
    await heroState();
    await ev(() => { window.opendj.engine.decks.forEach((d) => d.pause()); });
    await view('playlist', 'Friday — Warehouse');
    await ev(() => {
      const a = window.opendj;
      a.dialogs.automixQueue(a.library.rows, { mode: 'live', title: 'Friday — Warehouse' });
    }); // resolves when the dialog closes: don't wait for it
    await page.locator('[data-am="style"]').selectOption('auto');
    await page.locator('[data-am="bars"]').selectOption('auto');
    await sleep(800);
    await save('automix', { locator: page.locator('.overlay .modal').last() });
  },

  async 'settings-appearance'() {
    await ev(() => { window.opendj.dialogs.settings('appearance'); }); // resolves when the dialog closes: don't wait for it
    await sleep(800);
    await save('settings-appearance', { locator: page.locator('.overlay .modal').last() });
  },

  async themes() {
    await heroState();
    const list = [['midnight', 'Midnight'], ['neon', 'Neon'], ['club', 'Club Red'], ['light', 'Daylight'], ['gold', 'Black & Gold'], ['contrast', 'High Contrast']];
    const files = [];
    for (const [id, name] of list) {
      await setTheme(id);
      await sleep(900);
      const f = path.join(tmp, `theme-${id}.jpg`);
      await page.screenshot({ path: f, type: 'jpeg', quality: 92, scale: 'css' });
      files.push([f, name]);
    }
    await setTheme('midnight');
    const p2 = await context.newPage();
    await p2.setViewportSize({ width: 2400, height: 1000 });
    const imgs = files.map(([f, n]) => `<figure><img src="data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}"><figcaption>${n}</figcaption></figure>`).join('');
    await p2.setContent(`<!doctype html><style>body{margin:0;background:#0b0d10;font:600 22px Inter,sans-serif;color:#e8edf3}main{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:24px}figure{margin:0}img{width:100%;display:block;border-radius:10px;box-shadow:0 6px 24px #0008}figcaption{padding:10px 4px 0;text-align:center}</style><main>${imgs}</main>`);
    await p2.waitForTimeout(300);
    const file = path.join(OUT, 'themes.jpg');
    await p2.locator('main').screenshot({ path: file, type: 'jpeg', quality: 86, scale: 'css' });
    sizes.push(['themes.jpg', Math.round(fs.statSync(file).size / 1024)]); log(`themes.jpg ${sizes.at(-1)[1]} KB`);
    await p2.close();
  },

  async gif() {
    await heroState();
    await ev(() => { const E = window.opendj.engine; E.setCrossfader(-0.9); E.channels[1].set('eqLow', -1); window.opendj.mixer.renderAll?.(); });
    await sleep(500);
    const dir = path.join(tmp, 'frames'); fs.mkdirSync(dir, { recursive: true });
    const clip = await ev(() => { const r = document.querySelector('.deck-area').getBoundingClientRect(); return { x: 0, y: 0, width: innerWidth, height: r.bottom + 4 }; });
    const N = 84, t0 = Date.now();
    for (let i = 0; i < N; i++) {
      const k = i / (N - 1);
      await ev((k) => { const E = window.opendj.engine, a = window.opendj; E.setCrossfader(-0.9 + 1.8 * Math.min(1, k * 1.25)); if (k > 0.45) E.channels[1].set('eqLow', Math.min(0, -1 + (k - 0.45) * 4)); if (k > 0.45) E.channels[0].set('eqLow', Math.max(-1, -(k - 0.45) * 4)); a.mixer.renderAll?.(); }, k);
      await page.screenshot({ path: path.join(dir, `f${String(i).padStart(3, '0')}.jpg`), type: 'jpeg', quality: 92, clip, scale: 'css' });
    }
    const fps = N / ((Date.now() - t0) / 1000);
    log(`captured ${N} frames at ${fps.toFixed(1)} fps`);
    const file = path.join(OUT, 'demo.gif');
    const r = spawnSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', fps.toFixed(2), '-i', path.join(dir, 'f%03d.jpg'), '-vf', 'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', file], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ffmpeg gif failed');
    sizes.push(['demo.gif', Math.round(fs.statSync(file).size / 1024)]); log(`demo.gif ${sizes.at(-1)[1]} KB`);
    await ev(() => { const E = window.opendj.engine; E.channels[0].set('eqLow', 0); });
  },

  async dvs() { // last: DVS takes over deck 1
    await heroState();
    await ev(async () => {
      const a = window.opendj; const s = a.dvs.settings;
      s.enabled = true; s.channelCount = 2; s.decks[0] = { ...s.decks[0], mode: 'rel', pair: 0, timecode: 'serato_2a', rpm: 33 };
      await a.dvs.save(s);
      await a.dvs.start();
      (await import('/js/dvs/dvs-ui.js')).openDvsPanel(a);
    });
    await page.waitForSelector('.dvs-panel .dvs-scope', { timeout: 10000 });
    await sleep(2000);
    await ev(() => { for (const n of document.querySelectorAll('.dvs-panel *')) if (n.children.length === 0 && n.textContent.includes('Fake Default Audio Input')) n.textContent = n.textContent.replace('Fake Default Audio Input', 'USB audio interface'); }); // Chromium's fake capture device
    await save('dvs', { locator: page.locator('.overlay .modal').last() });
  },
};

for (const name of wanted) {
  if (!shots[name]) { log(`(no shot "${name}")`); continue; }
  log(`--- ${name}`);
  let timer;
  try {
    await Promise.race([shots[name](), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out after 5 min')), 300000); })]);
  } catch (e) { failures.push(`${name}: ${e.message}`); console.error(`shot ${name} failed:`, e); }
  finally { clearTimeout(timer); }
  await closeOverlays();
}
log('sizes:', sizes.map(([f, k]) => `${f} ${k} KB`).join(', '));
await browser.close();
app.shutdown?.();
app.server.close();
if (failures.length) console.error('Screenshot failures:', failures);
process.exit(failures.length ? 1 : 0);
