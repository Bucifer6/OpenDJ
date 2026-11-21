// End-to-end test of the update prompt against a fake GitHub API (OPENDJ_UPDATE_URL points the server at it; the
// production URL is fixed). Covers: no prompt for the same / an older version, the prompt for a newer one, "What's new"
// with only the newer "New in" sections (and inert XSS attempts), Esc / Later snoozing, a newer version than the
// snoozed one, Skip this version, deferral while a deck plays (badge instead), Update now with a mocked Electron IPC
// (installer, dmg and deb paths), hosted mode (login required, Docker instructions), the automatic-check setting and
// Settings → Check now, the mobile on-device mode (?local=1, phone profile, request made from the page), and, when
// Electron can start here, the real desktop app (Playwright _electron).
// Screenshots of the prompt (collapsed / expanded, desktop / phone, two themes) go to the directory given as argument.
// Usage: node scripts/e2e-update.mjs [screenshot dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { start } from '../server/index.js';

const require = createRequire(import.meta.url);
const { chromium, devices, _electron } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-update-'));
const shots = path.resolve(process.argv[2] || path.join(tmp, 'shots'));
fs.mkdirSync(shots, { recursive: true });
const music = path.join(tmp, 'music');
fs.mkdirSync(music);
const quiet = { log() {}, warn() {}, error: (...a) => console.error(...a) };
const check = (cond, msg) => { if (!cond) throw new Error(msg); console.log('ok -', msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeWav(file, seconds) {
  const sr = 44100, n = sr * seconds, data = Buffer.alloc(44 + n * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22); data.writeUInt32LE(sr, 24); data.writeUInt32LE(sr * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { const s = (0.3 * Math.sin(2 * Math.PI * 220 * i / sr) * 32767) | 0; data.writeInt16LE(s, 44 + i * 4); data.writeInt16LE(s, 46 + i * 4); }
  fs.writeFileSync(file, data);
}
writeWav(path.join(music, 'Update Artist - Long Tone.wav'), 30);

// ---------------------------------------------------------------- fake GitHub API
const NOTES = fs.readFileSync(path.join(root, 'docs', 'RELEASE_NOTES.md'), 'utf8');
const NEW_SECTION = `### New in 0.5
**Update prompt**
- OpenDJ tells you when a new version is out, with *what's new* and an **Update now** button.
- Notes support \`inline code\` and [links](https://github.com/Bucifer6/OpenDJ).

**Hostile notes stay text**
- <script>window.__xss = 1</script> and <img src=x onerror="window.__xss = 3">
- [click me](javascript:window.__xss=2) and ![tracker](https://example.invalid/pixel.png)

`;
const bodyFor = (v) => NOTES.replace('### New in 0.4', `${NEW_SECTION}### New in 0.4`).replace(/<version>/g, v) + '\n\n## What\'s Changed\n* Update prompt by @someone in https://github.com/Bucifer6/OpenDJ/pull/1\n';
const ASSETS = (v) => [`OpenDJ-Setup-${v}-x64.exe`, `OpenDJ-Setup-${v}-arm64.exe`, `OpenDJ-Setup-${v}.exe`, `OpenDJ-Portable-${v}.exe`, `OpenDJ-${v}-mac-arm64.dmg`, `OpenDJ-${v}-mac-x64.dmg`,
  `OpenDJ-${v}-linux-x86_64.AppImage`, `OpenDJ-${v}-linux-amd64.deb`, `OpenDJ-${v}-linux-x64.tar.gz`, `OpenDJ-${v}-android-debug-signed.apk`, 'SHA256SUMS.txt'];
const releaseJson = (v) => ({
  tag_name: `v${v}`, name: `OpenDJ v${v}`, draft: false, prerelease: false, published_at: '2026-11-18T10:00:00Z', html_url: 'https://evil.example/not-used',
  body: bodyFor(v), assets: ASSETS(v).map((n) => ({ name: n, size: 94371840, browser_download_url: `https://github.com/Bucifer6/OpenDJ/releases/download/v${v}/${n}` })),
});
const gh = { version: '0.4.0', hits: [], status: 200 };
const fakeGitHub = http.createServer((req, res) => {
  gh.hits.push({ url: req.url, ua: req.headers['user-agent'], inm: req.headers['if-none-match'] || null, cookie: req.headers.cookie || null });
  if (req.url !== '/repos/Bucifer6/OpenDJ/releases/latest') { res.writeHead(404); return res.end(); }
  const etag = `"v${gh.version}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
  res.writeHead(gh.status, { 'Content-Type': 'application/json', ETag: etag });
  res.end(JSON.stringify(releaseJson(gh.version)));
});
await new Promise((r) => fakeGitHub.listen(7840, '127.0.0.1', r));
process.env.OPENDJ_UPDATE_URL = 'http://127.0.0.1:7840/repos/Bucifer6/OpenDJ/releases/latest';

const servers = [];
let nextPort = 7841;
async function newServer(opts = {}) {
  const app = await start({ port: nextPort++, dataDir: opts.dataDir || fs.mkdtempSync(path.join(tmp, 'data-')), ffmpeg: false, log: quiet, ...opts });
  servers.push(app);
  return app;
}
const stopServer = (app) => { app.server.close(); app.server.closeAllConnections?.(); app.shutdown(); };

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const INIT = ({ delayMs = 300, idleMs = 1500 } = {}) => `window.__opendjUpdateTest = { delayMs: ${delayMs}, idleMs: ${idleMs} }; window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; };`;
async function openApp(app, { viewport = { width: 1440, height: 900 }, init = INIT(), extraInit = '', ctx: ctxIn, query = '' } = {}) {
  const ctx = ctxIn || await browser.newContext({ viewport });
  await ctx.addInitScript(init + extraInit);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[134]|ERR_INTERNET|net::/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${app.url}${query}`);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
  await page.locator('.overlay.start button').click({ timeout: 1500 }).catch(() => {});
  return { page, ctx };
}
const modal = (page) => page.locator('.modal.update-modal');
const waitHits = async (n, ms = 8000) => { const t = Date.now(); while (gh.hits.length < n && Date.now() - t < ms) await sleep(50); return gh.hits.length >= n; };
const setTheme = (page, id) => page.evaluate(async (theme) => { const { applyTheme } = await import('/js/ui/themes.js'); await window.opendj.setSetting('theme', theme); applyTheme(window.opendj.settings); }, id);
const settingsOf = (app) => app.library.settings;

let failed = false;
try {
  // ================================================================ 1. same version: no prompt
  console.log('\n=== same / older version ===');
  {
    gh.version = VERSION;
    const app = await newServer();
    const before = gh.hits.length;
    const { page, ctx } = await openApp(app);
    check(await waitHits(before + 1), 'the app checks for updates shortly after startup');
    const hit = gh.hits.at(-1);
    check(hit.ua === `OpenDJ/${VERSION}`, `the request carries only a generic User-Agent (${hit.ua})`);
    check(!hit.cookie, 'no cookies are sent to the update server');
    await sleep(1500);
    check(await modal(page).count() === 0, `no prompt when GitHub's latest is the running version (${VERSION})`);
    check(await page.locator('.update-badge').isHidden(), 'no update badge either');
    // Settings → Check now: "You're up to date"
    await page.evaluate(() => { window.opendj.dialogs.settings('about'); });
    await page.locator('.overlay .tab[data-k="about"]').click();
    await page.locator('.upd-check-now').click();
    await page.waitForFunction(() => /up to date/.test(document.querySelector('.upd-check-status')?.textContent || ''), null, { timeout: 5000 });
    check((await page.textContent('.upd-check-status')).includes(`You’re up to date (${VERSION})`), `Settings → Check now says "You’re up to date (${VERSION})"`);
    check(gh.hits.length === before + 1, 'a "Check now" right after the startup check reuses it (GitHub rate limits)');
    await page.screenshot({ path: path.join(shots, 'settings-about-desktop.png') });
    await ctx.close(); stopServer(app);
  }
  {
    gh.version = '0.3.9';
    const app = await newServer();
    const before = gh.hits.length;
    const { page, ctx } = await openApp(app);
    check(await waitHits(before + 1), 'checked (older release on GitHub)');
    await sleep(1500);
    check(await modal(page).count() === 0, 'no prompt when GitHub has an older version (0.3.9)');
    await ctx.close(); stopServer(app);
  }

  // ================================================================ 2. newer version: the prompt
  console.log('\n=== newer version: prompt, notes, Later ===');
  const sharedData = fs.mkdtempSync(path.join(tmp, 'data-'));
  {
    gh.version = '0.5.0';
    const app = await newServer({ dataDir: sharedData });
    const { page, ctx } = await openApp(app);
    await modal(page).waitFor({ timeout: 8000 });
    check(true, 'the prompt appears for a newer version (0.5.0)');
    check((await page.textContent('.update-modal .modal-head h2')) === 'OpenDJ 0.5.0 is available', 'title: "OpenDJ 0.5.0 is available"');
    check((await page.textContent('.upd-sub')) === `You have ${VERSION}`, `subtitle: "You have ${VERSION}"`);
    check(/Update prompt/.test(await page.textContent('.upd-summary')), 'short summary from the release notes');
    const btns = await page.locator('.update-modal .modal-foot .btn').allTextContents();
    check(JSON.stringify(btns) === JSON.stringify(['Later', 'Update now']), `two buttons: ${btns.join(' / ')}`);
    check(await page.locator('.update-modal .btn.primary').textContent() === 'Update now', '"Update now" is the primary button');
    check(await page.evaluate(() => document.activeElement?.classList.contains('upd-now')), 'focus starts on "Update now"');
    check(await page.locator('.upd-notes').isHidden(), '"What’s new" starts collapsed');
    check(await page.getAttribute('.update-modal', 'aria-modal') === 'true' && !!(await page.getAttribute('.update-modal', 'aria-labelledby')), 'dialog is aria-modal and labelled by its title');
    await page.screenshot({ path: path.join(shots, 'prompt-desktop-midnight-collapsed.png') });
    await page.locator('.upd-toggle').click();
    check(await page.getAttribute('.upd-toggle', 'aria-expanded') === 'true', 'toggle reports aria-expanded');
    const titles = await page.locator('.upd-section > h3').allTextContents();
    check(JSON.stringify(titles) === JSON.stringify(['New in 0.5']), `"What’s new" shows only the newer sections (${titles.join(', ')})`);
    const notesText = await page.textContent('.upd-notes');
    check(!/Windows 10\/11|SHA256SUMS|New in 0\.4|Phone and tablet app/.test(notesText), 'no download table and no 0.4 notes in "What’s new"');
    check(notesText.includes('<script>window.__xss = 1</script>'), 'a <script> tag in the notes shows as plain text');
    const xss = await page.evaluate(() => ({
      flag: window.__xss, scripts: document.querySelectorAll('.upd-notes script, .upd-notes img, .upd-notes iframe').length,
      hrefs: [...document.querySelectorAll('.upd-notes a')].map((a) => a.getAttribute('href')), handlers: [...document.querySelectorAll('.upd-notes *')].some((e) => [...e.attributes].some((a) => a.name.startsWith('on'))),
    }));
    check(xss.flag === undefined && xss.scripts === 0 && !xss.handlers, 'XSS attempts in the notes are inert (no script, no image, no handlers)');
    check(xss.hrefs.length >= 2 && xss.hrefs.every((h) => /^https:\/\//.test(h)), `only https links are links (${xss.hrefs.length})`);
    check(await page.locator('.upd-notes strong').count() >= 2 && await page.locator('.upd-notes code').count() >= 1, 'bold and inline code render');
    await page.locator('.upd-notes a.md-link').first().click();
    check((await page.evaluate(() => window.__opened)).at(-1) === 'https://github.com/Bucifer6/OpenDJ', 'links open externally');
    await page.screenshot({ path: path.join(shots, 'prompt-desktop-midnight-expanded.png') });
    // focus trap
    for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
    check(await page.evaluate(() => !!document.activeElement?.closest('.update-modal')), 'Tab keeps focus inside the dialog');
    // light theme
    await setTheme(page, 'light');
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shots, 'prompt-desktop-light-expanded.png') });
    await page.locator('.upd-toggle').click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shots, 'prompt-desktop-light-collapsed.png') });
    await setTheme(page, 'midnight');
    // Esc = Later
    await page.keyboard.press('Escape');
    await modal(page).waitFor({ state: 'detached', timeout: 3000 });
    const sn = settingsOf(app).updateSnooze;
    check(sn?.version === '0.5.0' && sn.until > Date.now() + 2.9 * 86400e3 && sn.until < Date.now() + 3.1 * 86400e3, 'Esc = Later: snoozed for 3 days');
    check(await page.locator('.update-badge').isVisible(), 'the "Update" badge stays in the top bar');
    await page.screenshot({ path: path.join(shots, 'badge-desktop.png'), clip: { x: 900, y: 0, width: 540, height: 60 } });
    // Later button
    await page.locator('.update-badge').click();
    await modal(page).waitFor({ timeout: 3000 });
    check(true, 'the badge opens the prompt');
    await page.locator('.update-modal .upd-later').click();
    await modal(page).waitFor({ state: 'detached', timeout: 3000 });
    check(settingsOf(app).updateSnooze?.version === '0.5.0', '"Later" snoozes 0.5.0');
    // reload: snoozed
    const before = gh.hits.length;
    await page.reload();
    await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
    await sleep(2500);
    check(gh.hits.length === before, 'the server caches the result (no new GitHub request on reload)');
    check(await modal(page).count() === 0, 'after Later the prompt does not come back on reload');
    check(await page.locator('.update-badge').isVisible(), 'the badge is still offered after Later');
    await ctx.close(); stopServer(app);
  }
  {
    gh.version = '0.5.1';
    const app = await newServer({ dataDir: sharedData });
    check(settingsOf(app).updateSnooze?.version === '0.5.0', 'the snooze survived a restart');
    const { page, ctx } = await openApp(app);
    await modal(page).waitFor({ timeout: 8000 });
    check(true, 'a newer version than the snoozed one (0.5.1) prompts again');
    await page.locator('.upd-skip').click();
    await modal(page).waitFor({ state: 'detached', timeout: 3000 });
    check(settingsOf(app).updateSnooze?.version === '0.5.1' && settingsOf(app).updateSnooze.skip === true, '"Skip this version" remembers 0.5.1');
    check(await page.locator('.update-badge').isHidden(), 'no badge for a skipped version');
    await ctx.close(); stopServer(app);
  }

  // ================================================================ 3. never during a set
  console.log('\n=== deferred while a deck plays ===');
  {
    gh.version = '0.5.0';
    const app = await newServer();
    app.library.updateSettings({ allowedRoots: [music] });
    const r = await fetch(`${app.url}api/folders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: music }) });
    check(r.ok, 'music folder added');
    for (let i = 0; i < 100 && !app.library.allTracks().length; i++) await sleep(100);
    const before = gh.hits.length;
    const { page, ctx } = await openApp(app, { init: INIT({ delayMs: 3500, idleMs: 2000 }) });
    await page.evaluate(async () => {
      await window.opendj.library.refresh();
      const t = window.opendj.library.tracks?.[0] || (await (await fetch('/api/tracks')).json())[0];
      await window.opendj.loadTrack(0, t.id);
      window.opendj.engine.decks[0].play();
    });
    check(await page.evaluate(() => window.opendj.engine.decks[0].playing), 'deck 1 is playing');
    check(await waitHits(before + 1, 10000), 'the check ran while the deck plays');
    await sleep(2500);
    check(await modal(page).count() === 0, 'no prompt while a deck plays');
    check(await page.locator('.update-badge').isVisible(), 'an unobtrusive "Update" badge appears instead');
    await page.screenshot({ path: path.join(shots, 'deferred-badge-desktop.png') });
    await page.evaluate(() => window.opendj.engine.decks[0].pause());
    await modal(page).waitFor({ timeout: 8000 });
    check(true, 'the prompt follows once playback has stopped');
    await page.keyboard.press('Escape');
    await ctx.close(); stopServer(app);
  }

  // ================================================================ 4. Update now with a mocked Electron IPC
  console.log('\n=== Update now: desktop (mocked IPC) ===');
  const MOCK = (kind) => `window.__calls = [];
    window.opendjNative = { update: {
      info: async () => { window.__calls.push('info'); return ${JSON.stringify({
        nsis: { kind: 'nsis', arch: 'x64', action: 'install', asset: { name: 'OpenDJ-Setup-0.5.0-x64.exe', size: 94371840 } },
        dmg: { kind: 'dmg', arch: 'arm64', action: 'download', asset: { name: 'OpenDJ-0.5.0-mac-arm64.dmg', size: 94371840 } },
        deb: { kind: 'deb', arch: 'x64', action: 'open', asset: { name: 'OpenDJ-0.5.0-linux-amd64.deb', size: 94371840 } },
      }[kind])}; },
      download: async () => { window.__calls.push('download');
        for (let i = 1; i <= 4; i++) { await new Promise((r) => setTimeout(r, 120)); window.__progress?.({ received: i * 23592960, total: 94371840 }); }
        return ${JSON.stringify({ nsis: { ok: true, action: 'ready', name: 'OpenDJ-Setup-0.5.0-x64.exe' }, dmg: { ok: true, action: 'opened-dmg', name: 'OpenDJ-0.5.0-mac-arm64.dmg' },
          deb: { ok: true, action: 'opened', name: 'OpenDJ-0.5.0-linux-amd64.deb', url: 'https://github.com/Bucifer6/OpenDJ/releases/download/v0.5.0/OpenDJ-0.5.0-linux-amd64.deb', hint: { text: 'When the download finishes, install it with:', command: 'sudo apt install ./OpenDJ-0.5.0-linux-amd64.deb' } } }[kind])}; },
      install: async () => { window.__calls.push('install'); return { ok: true }; },
      cancel: async () => { window.__calls.push('cancel'); },
      onProgress: (cb) => { window.__progress = cb; return () => { window.__progress = null; }; },
    } };`;
  {
    gh.version = '0.5.0';
    const app = await newServer();
    const { page, ctx } = await openApp(app, { extraInit: MOCK('nsis') });
    await modal(page).waitFor({ timeout: 8000 });
    await page.waitForFunction(() => /installer/.test(document.querySelector('.upd-how')?.textContent || ''));
    check(/SHA-256/.test(await page.textContent('.upd-how')), 'desktop: explains download + checksum + restart');
    await page.locator('.upd-now').click();
    await page.waitForFunction(() => /Downloading/.test(document.querySelector('.upd-status-text')?.textContent || ''), null, { timeout: 3000 });
    await page.screenshot({ path: path.join(shots, 'prompt-desktop-downloading.png') });
    await page.waitForFunction(() => document.querySelector('.upd-now')?.textContent === 'Restart to update', null, { timeout: 5000 });
    check(/verified/.test(await page.textContent('.upd-status-text')), 'progress, then "Downloaded and verified"');
    await page.screenshot({ path: path.join(shots, 'prompt-desktop-restart.png') });
    await page.locator('.upd-now').click();
    await page.waitForFunction(() => window.__calls.includes('install'));
    check(JSON.stringify(await page.evaluate(() => window.__calls)) === JSON.stringify(['info', 'download', 'install']), 'Update now → IPC info, download, then install on "Restart to update"');
    await ctx.close();
    for (const [kind, expect] of [['dmg', /drag OpenDJ to Applications/], ['deb', /sudo apt install \.\/OpenDJ-0\.5\.0-linux-amd64\.deb/]]) {
      const { page: p, ctx: c } = await openApp(app, { extraInit: MOCK(kind) });
      await p.locator('.update-modal').waitFor({ timeout: 8000 });
      await p.waitForFunction(() => window.__calls.includes('info'));
      await p.locator('.upd-now').click();
      await p.waitForFunction(() => document.querySelector('.upd-now')?.textContent === 'Done', null, { timeout: 5000 });
      check(expect.test(await p.textContent('.upd-body')), `desktop ${kind}: ${expect}`);
      await p.screenshot({ path: path.join(shots, `prompt-desktop-${kind}-done.png`) });
      await c.close();
    }
    stopServer(app);
  }

  // ================================================================ 5. hosted mode
  console.log('\n=== hosted mode ===');
  {
    gh.version = '0.5.0';
    const PASSWORD = 'e2e-update-password';
    const app = await newServer({ auth: true, password: PASSWORD, roots: [music] });
    const before = gh.hits.length;
    const anon = await fetch(`${app.url}api/update/check`);
    check(anon.status === 401 && gh.hits.length === before, 'hosted: /api/update/check needs a signed-in user (401, GitHub not contacted)');
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const login = await ctx.request.post(`${app.url}api/auth/login`, { data: { password: PASSWORD } });
    check(login.ok(), 'signed in');
    const { page } = await openApp(app, { ctx });
    await modal(page).waitFor({ timeout: 8000 });
    check(true, 'hosted: a signed-in user gets the prompt');
    await page.locator('.upd-now').click();
    await page.locator('.upd-instructions').waitFor({ timeout: 3000 });
    const t = await page.textContent('.upd-instructions');
    check(t.includes('docker compose pull && docker compose up -d') && t.includes('git pull && docker compose up -d --build'), 'hosted: "Update now" shows the Docker update commands');
    check((await page.evaluate(() => window.__opened)).length === 0, 'hosted: nothing is downloaded or opened');
    await page.screenshot({ path: path.join(shots, 'prompt-hosted-instructions.png') });
    await ctx.close(); stopServer(app);
  }

  // ================================================================ 6. automatic checks off + Check now
  console.log('\n=== automatic checks off, Check now ===');
  {
    gh.version = '0.5.0';
    const app = await newServer();
    app.library.updateSettings({ updateCheck: false });
    const before = gh.hits.length;
    const { page, ctx } = await openApp(app);
    await sleep(2000);
    check(gh.hits.length === before && await modal(page).count() === 0, 'with "Check for updates automatically" off, nothing is requested');
    await page.evaluate(() => { window.opendj.dialogs.settings('about'); });
    check(await page.locator('.about-pane input[type=checkbox]').isChecked() === false, 'Settings → About shows the setting off');
    await page.locator('.upd-check-now').click();
    await modal(page).waitFor({ timeout: 5000 });
    check(gh.hits.length === before + 1, 'Settings → Check now opens the prompt when a newer version exists');
    check(/0\.5\.0 is available/.test(await page.textContent('.upd-check-status')), 'and says so in Settings');
    await ctx.close(); stopServer(app);
  }

  // ================================================================ 7. mobile on-device mode (?local=1), phone
  console.log('\n=== mobile on-device mode (phone) ===');
  {
    const app = await newServer(); // static files only
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const reqs = [];
    await ctx.route('https://api.github.com/repos/Bucifer6/OpenDJ/releases/latest', (route) => {
      reqs.push(route.request().headers());
      route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ETag: '"m"' }, body: JSON.stringify(releaseJson('0.5.0')) });
    });
    const before = gh.hits.length;
    const { page } = await openApp(app, { ctx, query: '?local=1' });
    check(await page.evaluate(() => document.documentElement.classList.contains('odj-local')), 'on-device backend (no server API)');
    await modal(page).waitFor({ timeout: 10000 });
    check(reqs.length === 1 && gh.hits.length === before, 'mobile: the page itself asks GitHub (on-device backend), not the server');
    check(!('x-github-api-version' in reqs[0]) && !('if-none-match' in reqs[0]), 'mobile browser: a simple request (no custom headers, no CORS preflight)');
    await page.screenshot({ path: path.join(shots, 'prompt-phone-midnight-collapsed.png') });
    await page.locator('.upd-toggle').click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shots, 'prompt-phone-midnight-expanded.png') });
    await setTheme(page, 'light');
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shots, 'prompt-phone-light-expanded.png') });
    await page.locator('.upd-toggle').click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(shots, 'prompt-phone-light-collapsed.png') });
    const box = await page.locator('.update-modal').boundingBox();
    const vp = page.viewportSize();
    check(box.x >= 0 && box.x + box.width <= vp.width && box.y >= 0 && box.y + box.height <= vp.height, 'phone: the dialog fits the screen');
    await page.locator('.upd-now').click();
    await page.waitForFunction(() => window.__opened.length > 0);
    check((await page.evaluate(() => window.__opened))[0] === 'https://github.com/Bucifer6/OpenDJ/releases/tag/v0.5.0', 'mobile browser: Update now opens the release page');
    await ctx.close(); stopServer(app);
  }

  // ================================================================ 8. the real desktop app (Playwright _electron)
  console.log('\n=== Electron ===');
  await electronCheck();

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} catch (e) {
  failed = true;
  console.error('FAIL:', e.message);
  if (errors.length) console.error(errors.join('\n'));
}

async function electronCheck() {
  let electronPath;
  try { electronPath = require('electron'); } catch { console.log('skip - electron is not installed'); return; }
  let xvfb = null;
  const env = { ...process.env, OPENDJ_DATA: fs.mkdtempSync(path.join(tmp, 'electron-')), OPENDJ_UPDATE_URL: process.env.OPENDJ_UPDATE_URL };
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    xvfb = spawn('Xvfb', [':97', '-screen', '0', '1600x1000x24'], { stdio: 'ignore' });
    xvfb.on('error', () => {});
    await sleep(800);
    if (xvfb.exitCode != null) { console.log('skip - no display for Electron (Xvfb not available)'); return; }
    env.DISPLAY = ':97';
  }
  gh.version = '0.5.0';
  let eapp;
  try {
    eapp = await _electron.launch({ executablePath: electronPath, args: [root, '--no-sandbox'], env, timeout: 30000 });
    const page = await eapp.firstWindow();
    await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
    await eapp.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u); }; });
    check(await page.evaluate(() => typeof window.opendjNative?.update?.download === 'function'), 'electron: the preload exposes update info / download / install only');
    const info = await page.evaluate(() => window.opendjNative.update.info());
    check(info?.version === '0.5.0' && info.kind === 'source', `electron (unpackaged): main process knows the release (${info?.version}, ${info?.kind})`);
    await page.evaluate(() => window.opendj.updates.check());
    await page.locator('.update-modal').waitFor({ timeout: 8000 });
    check(true, 'electron: the prompt appears');
    await page.locator('.upd-now').click();
    await page.waitForFunction(() => document.querySelector('.upd-now')?.textContent === 'Done', null, { timeout: 8000 });
    const opened = await eapp.evaluate(() => globalThis.__opened);
    check(opened.length === 1 && opened[0] === 'https://github.com/Bucifer6/OpenDJ/releases/tag/v0.5.0', 'electron: Update now → main process opens the release page (source checkout)');
    const refused = await page.evaluate(() => window.opendjNative.update.install());
    check(refused?.ok === false, 'electron: install is refused when nothing was downloaded and verified');
    await page.screenshot({ path: path.join(shots, 'prompt-electron-source.png') });
  } catch (e) {
    if (/Process failed to launch|exited|Target page, context or browser has been closed/.test(e.message)) console.log(`skip - Electron could not start here: ${e.message.split('\n')[0]}`);
    else throw e;
  } finally {
    await eapp?.close().catch(() => {});
    xvfb?.kill();
  }
}

await browser.close();
fakeGitHub.close();
for (const s of servers) { try { stopServer(s); } catch { /* closed */ } }
console.log(`\nscreenshots: ${shots}`);
if (failed) process.exit(1);
console.log('e2e-update: all checks passed');
process.exit(0);
