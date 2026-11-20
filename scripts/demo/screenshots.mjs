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
page.on('pageerror', (e) => console.error('[page error]', String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[console]', m.text()); });
const sleep = (ms) => page.waitForTimeout(ms);
const ev = (fn, arg) => page.evaluate(fn, arg);

const sizes = [];
async function save(name, opts = {}) {
  const jpeg = opts.type === 'jpeg';
  const file = path.join(OUT, `${name}.${jpeg ? 'jpg' : 'png'}`);
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
    'Liquid Coastline': { rating: 3, color: '#0000ff', tags: ['Rollers'] },
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
  let at = sat.getTime();
  for (const title of ['Glass Horizon', 'Copper Skyline', 'Pressure Index', 'Midnight Transit', 'Static Bloom', 'Iron Meridian', 'Signal Fire']) { app.history.record(byTitle[title], at); at += 4 * 60e3 + Math.round(Math.random() * 60e3); }
  const s1 = app.history.list()[0]; app.history.rename(s1.id, 'Warehouse Party · Sat 22:04');
  at = sat.getTime() - 6 * 864e5 + 2 * 3600e3;
  for (const title of ['Saturday Satellite', 'Golden Hour Fever', 'Glass Horizon']) { app.history.record(byTitle[title], at); at += 4 * 60e3; }
  app.history.flush();
  await ev(() => window.opendj.library.refresh());
  return { ids, T };
}

async function loadDeck(i, id) {
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
  await ev(() => window.opendj.setDeckCount(2, false));
  await loadDeck(0, T('Pressure Index'));
  await loadDeck(1, T('Copper Skyline'));
  await ev(() => {
    const a = window.opendj, E = a.engine, [d1, d2] = E.decks;
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

const shots = {
  async hero() {
    await heroState();
    await sleep(1500);
    await save('hero', { type: 'jpeg' });
  },
};

for (const name of wanted) {
  if (!shots[name]) { log(`(no shot "${name}")`); continue; }
  log(`--- ${name}`);
  try { await shots[name](); } catch (e) { console.error(`shot ${name} failed:`, e); }
  await closeOverlays();
}
log('sizes:', sizes.map(([f, k]) => `${f} ${k} KB`).join(', '));
await browser.close();
app.shutdown?.();
app.server.close();
process.exit(0);
