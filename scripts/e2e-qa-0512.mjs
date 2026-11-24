// QA for what 0.5.5-0.5.12 added without browser coverage: the app log (download from Settings → About, page errors
// and secrets in it, the per-minute cap), hosted-mode protection of the new routes (logs, stems engine), and
// Automix's added effects being off by default and switched off once on existing installs.
//
//   node scripts/e2e-qa-0512.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { version: VERSION } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
let failed = 0;
const check = (cond, msg) => { if (cond) console.log('ok -', msg); else { failed++; console.error('FAIL -', msg); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-qa-0512-'));
const quiet = { info() {}, warn() {}, error() {} };
const stop = async (app) => { app.shutdown?.(); app.server.closeAllConnections?.(); await new Promise((r) => app.server.close(r)); };

// ---------------- the app log ----------------
const dataDir = path.join(tmp, 'data');
const app = await start({ port: 0, dataDir, logs: true });
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 20000 });

  // a page error reaches the log with its stack; a token in a URL does not
  await page.evaluate(() => { setTimeout(() => { throw new Error('qa-page-error https://plex.example/x?X-Plex-Token=SECRET123abc'); }, 0); });
  // the page sends its errors in batches every 2 s (client-log.js)
  let log = '';
  for (let i = 0; i < 20 && !/qa-page-error/.test(log); i++) { await page.waitForTimeout(250); log = await (await fetch(app.url + 'api/logs')).text(); }
  check(log.includes(`OpenDJ ${VERSION}`), 'the log starts with the version header');
  check(/\[page\].*qa-page-error/.test(log), 'a page error is in the log, marked [page]');
  check(!log.includes('SECRET123abc'), 'a media-server token in a URL is redacted');

  // Settings → About → Logs: Download log
  await page.evaluate(() => { window.opendj.dialogs.settings('about'); }); // not awaited: it resolves when closed
  await page.waitForTimeout(500);
  let link = await page.$('[data-logs="download"]');
  if (!link) { // open Settings and the About tab by the visible controls
    await page.click('[data-action="settings"], #settingsBtn, button[title*="Settings"]').catch(() => {});
    await page.waitForTimeout(400);
    await page.click('text=About').catch(() => {});
    await page.waitForTimeout(400);
    link = await page.$('[data-logs="download"]');
  }
  check(!!link, 'Settings → About shows "Download log"');
  if (link) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), link.click()]);
    const file = await dl.path();
    const text = fs.readFileSync(file, 'utf8');
    check(dl.suggestedFilename() === `opendj-${VERSION}-log.txt`, `the download is named opendj-${VERSION}-log.txt (${dl.suggestedFilename()})`);
    check(text.includes('qa-page-error'), 'the downloaded log holds the page error');
  }

  // the page-log endpoint: at most 5 lines of 2 KB per post, 30 posts a minute
  const post = (body) => fetch(app.url + 'api/logs/client', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  await post({ lines: ['qa-long ' + 'x'.repeat(5000)] });
  const long = (await (await fetch(app.url + 'api/logs')).text()).split('\n').find((l) => l.includes('qa-long')) || '';
  check(long.length > 0 && long.length < 2300, `a long page message is cut to about 2 KB (${long.length} chars)`);
  let refused = 0;
  for (let i = 0; i < 40; i++) if (!(await post({ message: `qa-flood ${i}` })).ok) refused++;
  check(refused >= 10, `page-log flooding is capped per minute (${refused} of 40 refused)`);
  await ctx.close();
} finally { await stop(app); }

// ---------------- hosted mode: the new routes need the login ----------------
const hosted = await start({ port: 0, dataDir: path.join(tmp, 'hosted'), auth: true, password: 'qa-hosted-password', log: quiet });
try {
  for (const [method, route] of [['GET', 'api/logs'], ['POST', 'api/logs/client'], ['POST', 'api/stems/engine/warm'], ['POST', 'api/stems/gpu/retry'], ['GET', 'api/info'], ['GET', 'api/settings']]) {
    const r = await fetch(hosted.url + route, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{"message":"x"}' : undefined });
    check(r.status === 401, `hosted: ${method} /${route} without a login is refused (${r.status})`);
  }
} finally { await stop(hosted); }

// ---------------- Automix: added effects off ----------------
const fresh = await start({ port: 0, dataDir: path.join(tmp, 'fresh'), log: quiet });
try {
  const am = (await (await fetch(fresh.url + 'api/settings')).json()).automix || {};
  check(am.tricks === 'off' && am.tease === false && am.stemTransitions === false, `a new install has tricks, teases and AI-stem transitions off (${am.tricks}, ${am.tease}, ${am.stemTransitions})`);
} finally { await stop(fresh); }
// an install from before 0.5.10 with the effects on: switched off once, then the user's choice is kept
const oldDir = path.join(tmp, 'old');
fs.mkdirSync(oldDir, { recursive: true });
fs.writeFileSync(path.join(oldDir, 'settings.json'), JSON.stringify({ automix: { tricks: 'party', tease: true, stemTransitions: true, transitionBeats: 32 } }));
let old = await start({ port: 0, dataDir: oldDir, log: quiet });
try {
  const am = (await (await fetch(old.url + 'api/settings')).json()).automix || {};
  check(am.tricks === 'off' && am.tease === false && am.stemTransitions === false && am.effectsOff === 1, 'an older install has the effects switched off once');
  check(am.transitionBeats === 32, 'its other Automix settings are kept');
  await fetch(old.url + 'api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ automix: { ...am, tricks: 'subtle', tease: true } }) });
} finally { await stop(old); }
old = await start({ port: 0, dataDir: oldDir, log: quiet });
try {
  const am = (await (await fetch(old.url + 'api/settings')).json()).automix || {};
  check(am.tricks === 'subtle' && am.tease === true, `turned back on by the user, they stay on after a restart (${am.tricks}, ${am.tease})`);
} finally { await stop(old); await browser.close(); }

console.log(failed ? `QA 0.5.12 EXTRA FAILED: ${failed}` : 'QA 0.5.12 EXTRA PASSED');
process.exit(failed ? 1 : 0);
