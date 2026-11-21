// Desktop app (Electron, Playwright _electron) checks from the handover notes:
//   - page storage survives a restart (a downloaded CC0 sampler sound, localStorage), the air horn still loads
//   - local Ollama planning against a fake Ollama (OPENDJ_OLLAMA_URL, loopback only): not running, model missing,
//     a hostile answer, and a good plan that starts automix with the spoken intro routed into the mix
//   - speechSynthesis voices in Electron (often none on Linux) vs the server speech engine (/api/tts/voices)
// Linux needs a display: the script re-runs itself under xvfb-run when DISPLAY is not set.
//   node scripts/e2e-desktop.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.OPENDJ_XVFB) {
  const r = spawnSync('xvfb-run', ['-a', process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, OPENDJ_XVFB: '1' } });
  if (r.error) { console.log('e2e-desktop: skipped (no display and no xvfb-run)'); process.exit(0); }
  process.exit(r.status ?? 1);
}

const require = createRequire(import.meta.url);
const { _electron } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-desktop-'));
const userData = path.join(tmp, 'userdata');
const music = path.join(tmp, 'Music'); fs.mkdirSync(music);
function wav(file, seconds, bpm, hz) {
  const sr = 22050, n = sr * seconds, d = Buffer.alloc(44 + n * 4);
  d.write('RIFF', 0); d.writeUInt32LE(36 + n * 4, 4); d.write('WAVEfmt ', 8); d.writeUInt32LE(16, 16); d.writeUInt16LE(1, 20); d.writeUInt16LE(2, 22);
  d.writeUInt32LE(sr, 24); d.writeUInt32LE(sr * 4, 28); d.writeUInt16LE(4, 32); d.writeUInt16LE(16, 34); d.write('data', 36); d.writeUInt32LE(n * 4, 40);
  const b = 60 / bpm;
  for (let i = 0; i < n; i++) { const t = i / sr, tb = t % b; const v = (tb < 0.12 ? 0.7 * Math.sin(2 * Math.PI * 55 * tb) * Math.exp(-tb * 20) : 0) + 0.15 * Math.sin(2 * Math.PI * hz * t); const s = Math.round(v * 32767); d.writeInt16LE(s, 44 + i * 4); d.writeInt16LE(s, 46 + i * 4); }
  fs.writeFileSync(file, d);
}
for (const [i, hz] of [[1, 220], [2, 247], [3, 196]]) wav(path.join(music, `Desk Artist ${i} - Desk Track ${i}.wav`), 30, 124 + i, hz);

// fake Ollama on loopback
let ollamaMode = 'good';
const seen = [];
const ollama = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.url === '/api/tags') return send(200, { models: [{ name: 'llama3.2:3b' }] });
  if (ollamaMode === 'missing') return send(404, { error: "model 'nope' not found, try pulling it first" });
  const n = JSON.parse(seen.at(-1).body.messages[1].content).length;
  const order = Array.from({ length: n }, (_, i) => n - 1 - i);
  if (ollamaMode === 'hostile') return send(200, { message: { content: JSON.stringify({ order: [99, -1, 'rm -rf'], intro: 'Visit http://evil.example <script>x</script>', exec: 'calc.exe' }) } });
  send(200, { message: { content: JSON.stringify({ order, intro: 'Bună seara și bine ați venit la petrecere!' }) } });
});
await new Promise((r) => ollama.listen(7914, '127.0.0.1', r));

class CheckError extends Error {}
let failed = false;
const check = (c, msg) => { console.log(`${c ? 'ok' : 'FAIL'} - ${msg}`); if (!c) failed = true; };
const launch = (env = {}) => _electron.launch({
  executablePath: require(path.join(root, 'node_modules/electron')),
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${userData}`, root],
  env: { ...process.env, OPENDJ_DATA: path.join(userData, 'library'), OPENDJ_OLLAMA_URL: 'http://127.0.0.1:7914', ...env },
});
const ready = async (app) => {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => { console.error('[page error]', String(e)); failed = true; });
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 60000 });
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
  return page;
};

let app;
try {
  // ---------- first launch ----------
  app = await launch();
  let page = await ready(app);
  check(true, `Electron ${await app.evaluate(() => process.versions.electron)}`);
  const origin1 = await page.evaluate(() => location.origin);
  const voices = await page.evaluate(async () => {
    const ss = speechSynthesis; let v = ss.getVoices();
    if (!v.length) await new Promise((r) => { const t = setTimeout(r, 1500); ss.addEventListener('voiceschanged', () => { clearTimeout(t); r(); }, { once: true }); });
    v = ss.getVoices();
    const tts = await (await fetch('/api/tts/voices')).json();
    const caps = await window.opendj.voice.capabilities({ fresh: true });
    return { n: v.length, ro: v.filter((x) => /^ro/i.test(x.lang)).map((x) => x.name), tts, caps };
  });
  console.log(`   speechSynthesis voices in Electron: ${voices.n} (ro: ${voices.ro.join(', ') || 'none'}); server engine: ${voices.tts.engine || 'none'} ${JSON.stringify(voices.tts.languages)}`);
  check(voices.caps.mix.ro === !!voices.tts.languages.ro && voices.caps.local.ro === voices.ro.length > 0, 'voice capabilities reported for the Romanian fallback logic');
  // sampler: a downloaded CC0 sound (the pinned URL is answered locally) and localStorage
  await page.route('https://raw.githubusercontent.com/**', (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: fs.readFileSync(path.join(music, 'Desk Artist 1 - Desk Track 1.wav')).subarray(0, 44 + 22050 * 4) }));
  const s1 = await page.evaluate(async () => {
    const a = window.opendj, s = a.engine.sampler; await s.ready;
    const r = await s.loadCatalogSample(2, { id: 'vinyl_scratch' }); await a.setSetting('sampler', s.config());
    localStorage.setItem('e2e-probe', 'kept');
    return { saved: r.saved, name: s.slots[2].name, horn: s.slots[0].buffer?.duration };
  });
  check(s1.saved && s1.name === 'Vinyl Scratch' && s1.horn > 0.4 && s1.horn < 1, `CC0 sound saved on pad 3, recorded air horn on pad 1 (${s1.horn?.toFixed(2)} s)`);
  // library + Ollama planning through the real dialog
  await page.evaluate((d) => fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: d }) }), music);
  await page.waitForFunction(() => window.opendj.library.tracks.size === 3, null, { timeout: 30000 });
  const plan = async (model, voice = 'ro') => {
    page.evaluate(() => { window.opendj.dialogs.automixQueue(window.opendj.library.rows); });
    await page.locator('.overlay select[data-am="mode"]').selectOption('local');
    await page.locator('.overlay input[data-am="model"]').fill(model);
    await page.locator('.overlay select[data-am="voice"]').selectOption(voice);
    await page.locator('.overlay button', { hasText: 'Start automix' }).click();
  };
  const toastFor = (re) => page.waitForFunction((src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.textContent)), re.source, { timeout: 15000 }).then(() => true, () => false);
  // the model list from /api/tags
  page.evaluate(() => { window.opendj.dialogs.automixQueue(window.opendj.library.rows); });
  await page.locator('.overlay select[data-am="mode"]').selectOption('local');
  await page.waitForFunction(() => document.querySelector('#odj-ollama-models option'), null, { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => document.querySelector('#odj-ollama-models option')?.value) === 'llama3.2:3b', 'installed Ollama models offered in the dialog');
  await page.locator('.overlay button', { hasText: 'Cancel' }).click();
  ollamaMode = 'missing'; await plan('nope');
  check(await toastFor(/not installed in Ollama.*ollama pull nope/), 'model missing: friendly message in the app');
  ollamaMode = 'hostile'; await plan('llama3.2:3b');
  const hostile = await toastFor(/usable track order/);
  check(hostile && !(await page.evaluate(() => window.opendj.automix.enabled)), 'hostile answer: refused, nothing started');
  ollama.close(); await new Promise((r) => setTimeout(r, 200));
  await plan('llama3.2:3b');
  check(await toastFor(/Ollama is not running/), 'Ollama not running: friendly message');
  await new Promise((r) => ollama.listen(7914, '127.0.0.1', r));
  const rows = await page.evaluate(() => window.opendj.library.rows.map((t) => t.title));
  ollamaMode = 'good'; await plan('llama3.2:3b', 'ro');
  await page.waitForFunction(() => window.opendj.automix.enabled && window.opendj.automix.current?.playing, null, { timeout: 60000 });
  const started = await page.evaluate(async () => {
    const a = window.opendj;
    for (let k = 0; k < 100 && !a.dedications.queue.length && !a.dedications.current; k++) await new Promise((r) => setTimeout(r, 100));
    const d = a.dedications.current || a.dedications.queue[0];
    return { queue: a.automix.queue.map((t) => t.title), intro: d?.text, lang: d?.lang, from: d?.from };
  });
  check(started.queue.join(',') === [...rows].reverse().join(','), `the model's order is used: ${started.queue.join(', ')} (the view was ${rows.join(', ')})`);
  check(started.intro === 'Bună seara și bine ați venit la petrecere!' && started.lang === 'ro' && started.from === 'announce', `Romanian intro queued for the MC voice at the next phrase ("${started.intro}")`);
  check(seen.filter((x) => x.url === '/api/chat').every((x) => !JSON.stringify(x.body).includes(music)), 'no file paths sent to Ollama');
  await page.evaluate(() => { window.opendj.automix.stop(); window.opendj.dedications.clear(); window.opendj.engine.decks.forEach((d) => d.pause()); });
  await app.close();

  // ---------- restart ----------
  app = await launch();
  page = await ready(app);
  const s2 = await page.evaluate(async () => {
    const s = window.opendj.engine.sampler; await s.ready;
    for (let k = 0; k < 50 && !s.slots[2].creator; k++) await new Promise((r) => setTimeout(r, 100));
    return { origin: location.origin, name: s.slots[2].name, creator: s.slots[2].creator, builtin: s.slots[2].builtin, probe: localStorage.getItem('e2e-probe'), model: localStorage.getItem('dj-model'), horn: s.slots[0].buffer?.duration };
  });
  check(s2.origin === origin1, `same origin after a restart (${s2.origin})`);
  check(s2.name === 'Vinyl Scratch' && s2.creator && !s2.builtin && s2.probe === 'kept' && s2.model === 'llama3.2:3b' && s2.horn > 0.4, `after a restart: CC0 sound, air horn, localStorage and the Ollama model name kept (${JSON.stringify(s2)})`);
  await app.close(); app = null;
} catch (e) {
  console.error(e instanceof CheckError ? e.message : e); failed = true;
} finally {
  await app?.close().catch(() => {});
  ollama.close();
}
console.log(failed ? '\nE2E DESKTOP FAILED' : '\nE2E DESKTOP PASSED');
process.exit(failed ? 1 : 0);
