// End-to-end check of the hosted web app: password login in Chromium, browser upload, load to a deck, play.
// The server runs with login forced on (as when bound to 0.0.0.0 on a NAS) and file access limited to a music root.
// When FFmpeg is available it also uploads a WMA file and checks that Chromium decodes the transcoded FLAC stream.
// Usage: node scripts/e2e-webapp.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';
import { findFfmpeg } from '../server/media.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PASSWORD = 'e2e-web-password';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-web-'));
const music = path.join(tmp, 'music');
fs.mkdirSync(music);

function writeWav(file, bpm, seconds) {
  const sr = 44100, n = sr * seconds;
  const data = Buffer.alloc(44 + n * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22); data.writeUInt32LE(sr, 24); data.writeUInt32LE(sr * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(n * 4, 40);
  const beat = 60 / bpm;
  for (let i = 0; i < n; i++) {
    const t = i / sr, tb = t % beat;
    let v = 0.25 * Math.sin(2 * Math.PI * 220 * t);
    if (tb < 0.15) v += 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb * 40)) * tb) * Math.exp(-tb * 18);
    const s = Math.max(-1, Math.min(1, v * 0.7)) * 32767;
    data.writeInt16LE(s | 0, 44 + i * 4); data.writeInt16LE(s | 0, 46 + i * 4);
  }
  fs.writeFileSync(file, data);
}
const upWav = path.join(tmp, 'Web Artist - Uploaded Groove.wav');
writeWav(upWav, 124, 20);
const ff = await findFfmpeg(undefined);
let wma = null;
if (ff) {
  wma = path.join(tmp, 'Web Artist - Windows Media.wma');
  spawnSync(ff.path, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=330:d=6', '-ac', '2', '-c:a', 'wmav2', wma]);
}

const quiet = { log() {}, warn() {}, error: (...a) => console.error(...a) };
const app = await start({ port: 0, dataDir: path.join(tmp, 'data'), auth: true, password: PASSWORD, roots: [music], log: quiet });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[13]|Unauthorized/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const fail = async (msg) => { console.error('FAIL:', msg); console.error(errors.join('\n')); await page.screenshot({ path: path.join(tmp, 'fail.png') }); console.error('screenshot', path.join(tmp, 'fail.png')); await browser.close(); app.server.close(); process.exit(1); };
class CheckError extends Error {}
const check = (cond, msg) => { if (!cond) throw new CheckError(msg); console.log('ok -', msg); };

try {
  // ---- login
  await page.goto(app.url);
  check(page.url().endsWith('/login.html'), 'app redirects to the login page');
  await page.waitForSelector('#login:not([hidden])');
  await page.fill('#pw', 'wrong password');
  await page.click('#login button');
  await page.waitForFunction(() => document.querySelector('#login .err').textContent.length > 0);
  check(/wrong password/i.test(await page.textContent('#login .err')), 'wrong password is rejected');
  await page.fill('#pw', PASSWORD);
  await page.click('#login button');
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 15000 });
  check(true, 'logged in, app booted');
  const cookies = await page.context().cookies();
  const sess = cookies.find((c) => c.name === 'opendj_session');
  check(sess && sess.httpOnly && sess.sameSite === 'Strict', 'session cookie is HttpOnly + SameSite=Strict');
  check(!(await page.evaluate(() => document.cookie)).includes('opendj_session'), 'session cookie not readable from JS');
  await page.evaluate(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});

  // ---- service worker (registered by the login page)
  const sw = await page.evaluate(async () => !!(await navigator.serviceWorker?.getRegistration('/')));
  check(sw, 'service worker registered');

  // ---- upload through the UI: drag-and-drop hook + Upload… button (file chooser)
  await page.evaluate(async () => {
    const m = await import('/js/ui/upload.js');
    window.__upload = window.opendj.upload || m.setupUpload(window.opendj);
    const b = m.uploadButton(window.opendj, { always: true });
    b.id = 'e2e-upload-btn';
    document.body.append(b);
  });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#e2e-upload-btn')]);
  await chooser.setFiles(upWav);
  await page.waitForFunction(() => [...window.opendj.library.tracks.values()].some((t) => t.title === 'Uploaded Groove'), null, { timeout: 15000 });
  check(true, 'uploaded WAV appears in the library (via server events)');
  check(await page.locator('.upl-panel').isVisible(), 'upload progress panel shown');
  const id = await page.evaluate(() => [...window.opendj.library.tracks.values()].find((t) => t.title === 'Uploaded Groove').id);
  check(fs.existsSync(path.join(tmp, 'data', 'Uploads', 'Web Artist - Uploaded Groove.wav')), 'file stored in the uploads folder');

  // drop a file on the library (synthetic DataTransfer)
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(10)], 'notes.txt', { type: 'text/plain' }));
    const zone = window.opendj.library.root;
    zone.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Skipped 1 file/.test(t.textContent)), null, { timeout: 5000 });
  check(true, 'non-media drop is refused client-side with a message');

  // ---- load to a deck and play
  await page.evaluate((tid) => window.opendj.loadTrack(0, tid), id);
  const dur = await page.evaluate(() => window.opendj.engine.decks[0].duration);
  check(Math.abs(dur - 20) < 0.1, `uploaded track loaded to deck 1 (${dur.toFixed(2)} s)`);
  await page.evaluate(() => window.opendj.engine.decks[0].play());
  await page.waitForTimeout(1000);
  const pos = await page.evaluate(() => window.opendj.engine.decks[0].position);
  check(pos > 0.5, `deck 1 plays (pos ${pos.toFixed(2)})`);
  await page.evaluate(() => window.opendj.engine.decks[0].pause?.() ?? window.opendj.engine.decks[0].play(false));

  // ---- exotic format: upload WMA, server transcodes to FLAC, Chromium decodes it
  if (wma) {
    const ids = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return window.__upload.upload([new File([bytes], 'Web Artist - Windows Media.wma')]);
    }, fs.readFileSync(wma).toString('base64'));
    check(ids.length === 1, 'WMA uploaded');
    await page.waitForFunction((tid) => window.opendj.library.tracks.has(tid), ids[0]);
    await page.evaluate((tid) => window.opendj.loadTrack(1, tid), ids[0]);
    const d2 = await page.evaluate(() => window.opendj.engine.decks[1].duration);
    check(Math.abs(d2 - 6) < 0.2, `WMA transcoded on the fly and decoded in Chromium (${d2.toFixed(2)} s)`);
  } else console.log('skip - no ffmpeg: WMA transcode check');

  // ---- roots are enforced for the web UI
  const outside = await page.evaluate(async () => (await fetch('/api/browse?path=/')).status);
  check(outside === 403, 'browsing outside the music root is refused');

  // ---- logout -> back to login on next API call
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await page.evaluate(async () => { const { api } = await import('/js/api.js'); try { await api.tracks(); } catch { /* redirects */ } });
  await page.waitForURL(/login\.html/, { timeout: 5000 });
  check(true, 'after logout, the next API call goes to the login page');

  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  console.log('\nE2E WEBAPP PASSED');
  await browser.close();
  app.server.close(); app.shutdown();
  process.exit(0);
} catch (e) {
  await fail(e instanceof CheckError ? e.message : e.stack);
}
