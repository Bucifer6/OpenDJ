// End-to-end test for lyrics/karaoke and Ableton Link in the real UI (Chromium via Playwright).
// - a 120 BPM WAV with an .lrc next to it: the deck's lyrics line follows playback (also at +20 % tempo),
//   word highlighting, editor tap-to-sync, karaoke mode (VOC knob down) and the karaoke layer in the video mix;
// - Link: the LINK button enables the server's Link node, an in-process Link peer on the same (test) multicast port
//   is discovered, the peer's tempo change makes the master deck follow, and a deck tempo change reaches the peer.
// Works before and after the wiring lines are added: routes/modules that are not wired yet are mounted by this script.
// Usage: node scripts/e2e-link-lyrics.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

process.env.OPENDJ_LINK_PORT ||= String(21000 + Math.floor(Math.random() * 3000)); // never join a real Link session
const { start } = await import('../server/index.js');
const { registerLinkRoutes, LinkNode, UdpTransport, hostMicros } = await import('../server/link/index.js');
const { registerLyricsRoutes } = await import('../server/lyrics.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-lyr-'));
const outDir = process.argv[2] || tmp;
fs.mkdirSync(outDir, { recursive: true });
const music = path.join(tmp, 'Music');
fs.mkdirSync(music);

function writeWav(file, bpm, seconds) {
  const sr = 44100, n = sr * seconds, data = Buffer.alloc(44 + n * 4);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVE', 8); data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(sr, 24);
  data.writeUInt32LE(sr * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(n * 4, 40);
  const beat = 60 / bpm;
  for (let i = 0; i < n; i++) {
    const t = i / sr, tb = t % beat;
    let v = 0.2 * Math.sin(2 * Math.PI * 220 * t);
    if (tb < 0.15) v += 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb * 40)) * tb) * Math.exp(-tb * 18);
    const s = Math.max(-1, Math.min(1, v * 0.7)) * 32767;
    data.writeInt16LE(s | 0, 44 + i * 4); data.writeInt16LE(s | 0, 46 + i * 4);
  }
  fs.writeFileSync(file, data);
}
writeWav(path.join(music, 'Karaoke Artist - Sing Along.wav'), 120, 40);
const LRC = ['[ti:Sing Along]', '[ar:Karaoke Artist]'];
for (let i = 0; i < 18; i++) LRC.push(`[00:${String(1 + i * 2).padStart(2, '0')}.00]Line ${i + 1}`);
LRC.splice(3, 1, '[00:03.00]<00:03.00>Word <00:03.50>timed <00:04.00>line<00:04.80>'); // line 2 has word timing
fs.writeFileSync(path.join(music, 'Karaoke Artist - Sing Along.lrc'), LRC.join('\n'));

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });

// ---- mount the routes when server/index.js does not register them yet
let shim = null;
const wired = { link: (await fetch(`${app.url}api/link`)).status !== 404, lyrics: (await fetch(`${app.url}api/lyrics/settings`)).status !== 404 };
if (!wired.link || !wired.lyrics) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };
  const linkApi = wired.link ? null : registerLinkRoutes({ route, library: app.library, log: null });
  if (!wired.lyrics) registerLyricsRoutes({ route, library: app.library, dataDir: path.join(tmp, 'data') });
  const orig = app.server.listeners('request')[0];
  app.server.removeAllListeners('request');
  app.server.on('request', async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) return orig(req, res);
    try {
      const m = r.re.exec(url.pathname);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let body = {};
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) { const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks).toString(); body = raw ? JSON.parse(raw) : {}; }
      const out = await r.handler({ req, res, params, body, query: url.searchParams });
      if (!res.headersSent && out !== undefined) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); }
    } catch (e) { if (!res.headersSent) { res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } }
  });
  shim = { linkApi };
  console.log(`(routes not wired in server/index.js yet: mounted by the test for ${[!wired.link && 'link', !wired.lyrics && 'lyrics'].filter(Boolean).join(' + ')})`);
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 940 } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
const check = (cond, msg) => { if (!cond) throw new Error(msg); console.log('ok -', msg); };
let peer = null;

try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 15000 });
  await page.evaluate(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});
  // modules / css not wired in app.js / index.html yet: set them up from the page
  await page.evaluate(async () => {
    for (const css of ['css/link.css', 'css/lyrics.css', 'css/video.css']) {
      if (document.querySelector(`link[href$="${css}"]`)) continue;
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = css; document.head.append(l);
      await new Promise((res) => { l.onload = res; l.onerror = res; });
    }
    const app = window.opendj;
    if (!app.lyrics) (await import('/js/lyrics/lyrics.js')).setupLyrics(app);
    if (!app.link) { const { setupLink } = await import('/js/link/link.js'); setupLink(app); }
  });
  await page.waitForFunction(() => document.querySelector('.link-btn'), null, { timeout: 5000 });
  check(await page.locator('.wave-row .lyr-line').count() >= 2, 'lyrics line injected under the detail waveforms');

  const r = await page.evaluate(async (dir) => (await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) })).json(), music);
  check(r.id, 'folder added');
  await page.waitForFunction(() => window.opendj.library.tracks.size === 1, null, { timeout: 15000 });
  const id = await page.evaluate(() => [...window.opendj.library.tracks.values()][0].id);
  const lyr = await page.evaluate(async (id) => (await fetch(`/api/tracks/${id}/lyrics`)).json(), id);
  check(lyr.source === 'lrc' && lyr.synced.length === 18, `API reads the .lrc next to the audio (${lyr.source}, ${lyr.synced.length} lines)`);

  await page.evaluate(async (id) => { await window.opendj.loadTrack(0, id); }, id);
  await page.waitForFunction(() => window.opendj.engine.decks[0].track && !window.opendj.engine.decks[0].loading, null, { timeout: 20000 });
  await page.waitForFunction(() => window.opendj.lyrics.get(window.opendj.engine.decks[0].track.id), null, { timeout: 5000 });
  const sel = '.lyr-line[data-deck="0"]';
  check(await page.getAttribute(sel, 'data-mode') === 'synced', 'deck 1 lyrics line is in synced mode');

  // ---- playback: the line follows the heard position
  await page.evaluate(() => { const d = window.opendj.engine.decks[0]; d.seek(0.5); d.play(); });
  // The line display refreshes on its own 50 ms timer, so a sample taken just after a line change can still show the
  // previous line — and under CPU contention (the full e2e run next to other work) that refresh can slip by a few
  // ticks, which made this check flaky (3/104 vs an allowance of 2). A sample now counts as wrong only when the
  // display matches neither the line heard now nor the line heard LAG ms ago: display lag up to LAG is tolerated,
  // a display that is ahead of the audio, on a wrong line or late by more than LAG still fails.
  const LAG = 0.15;
  const seen = await page.evaluate(async ({ sel, LAG }) => {
    const { lyricStateAt } = await import('/js/lyrics/lrc.js');
    return new Promise((resolve) => {
    const out = []; const t0 = performance.now();
    const iv = setInterval(() => {
      const d = window.opendj.engine.decks[0], m = window.opendj.lyrics;
      const txt = document.querySelector(`${sel} .lyr-cur`).textContent;
      const st = m.stateFor(d);
      const lagged = st ? lyricStateAt(m.get(d.track.id), st.t - LAG * (d.rate || 1)) : null;
      out.push({ txt, expect: st?.line && !st.gap ? st.line.text : null, lagged: lagged?.line && !lagged.gap ? lagged.line.text : null, sung: document.querySelectorAll(`${sel} .lyr-cur .sung`).length, next: document.querySelector(`${sel} .lyr-next`).textContent, pos: d.position });
      if (performance.now() - t0 > 6200) { clearInterval(iv); resolve(out); }
    }, 60);
    });
  }, { sel, LAG });
  if (process.env.DEBUG) console.log(seen.filter((_, i) => i % 8 === 0));
  const order = [...new Set(seen.map((s) => s.txt).filter((t) => /^(Line \d+|Word timed line)$/.test(t)))];
  check(order.slice(0, 3).join(' | ') === 'Line 1 | Word timed line | Line 3', `lines appear in order while playing (${order.join(' | ')})`);
  const strict = seen.filter((s) => s.expect && s.txt !== s.expect).length;
  const off = seen.filter((s) => s.expect && s.txt !== s.expect && s.txt !== (s.lagged ?? ''));
  const mismatch = off.length;
  if (off.length) console.log('# off:', JSON.stringify(off.map(({ txt, expect, lagged, pos }) => ({ txt, expect, lagged, pos }))));
  check(mismatch <= 1, `displayed line matches the heard position (${mismatch}/${seen.length} samples off by more than ${LAG * 1000} ms of display lag; ${strict} within it, at line changes)`);
  check(seen.some((s) => s.txt === 'Word timed line' && s.sung >= 1 && s.sung < 3), 'enhanced LRC words highlight one by one');
  check(seen.some((s) => s.txt === 'Line 1' && s.next === 'Word timed line'), 'next line shown after the current one');

  // ---- tempo +20 %: lines come faster, still matching the heard position
  const fast = await page.evaluate((sel) => new Promise((resolve) => {
    const d = window.opendj.engine.decks[0];
    d.setTempo(20); d.seek(10.2);
    const out = []; const t0 = performance.now();
    const iv = setInterval(() => {
      const st = window.opendj.lyrics.stateFor(d);
      out.push({ txt: document.querySelector(`${sel} .lyr-cur`).textContent, expect: st?.line?.text, t: performance.now() - t0 });
      if (performance.now() - t0 > 3500) { clearInterval(iv); resolve(out); }
    }, 50);
  }), sel);
  const changes = []; for (let i = 1; i < fast.length; i++) if (fast[i].txt !== fast[i - 1].txt && /^Line/.test(fast[i].txt)) changes.push(fast[i].t);
  const gaps = changes.slice(1).map((t, i) => t - changes[i]);
  const avg = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length);
  check(gaps.length >= 1 && Math.abs(avg - 2000 / 1.2) < 260, `at +20 % tempo a 2 s line lasts ${avg.toFixed(0)} ms (expected ≈ 1667)`);
  await page.evaluate(() => window.opendj.engine.decks[0].setTempo(0));

  // ---- karaoke mode: VOC knob down, lyrics in the video mix
  await page.evaluate(async () => {
    const app = window.opendj;
    if (!app.video) { const { setupVideo } = await import('/js/video/video-ui.js'); setupVideo(app); }
    app.video.api.openPanel();
  });
  await page.locator(`${sel} .lyr-kara`).dispatchEvent('click');
  check(await page.evaluate(() => window.opendj.engine.channels[0].state.vocal) === 0, 'karaoke button turns the deck\'s vocals down');
  await page.waitForFunction(() => window.opendj.video?.mixer?._karaoke?.was === true, null, { timeout: 5000 });
  const lit = await page.evaluate(() => {
    const m = window.opendj.video.mixer, o = m.overlay, g = o.getContext('2d');
    const d = g.getImageData(0, Math.round(o.height * 0.66), o.width, Math.round(o.height * 0.22)).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++;
    return n;
  });
  check(lit > 500, `karaoke layer drawn on the video overlay (${lit} opaque px)`);
  await page.locator(`${sel} .lyr-kara`).dispatchEvent('click');
  check(await page.evaluate(() => window.opendj.engine.channels[0].state.vocal) === 1, 'karaoke off restores the VOC knob');

  // ---- editor: tap-to-sync the first line, save
  await page.evaluate(() => { window.opendj.engine.decks[0].pause(); window.opendj.engine.decks[0].seek(0.7); window.opendj.lyrics.openEditor(0); });
  await page.waitForSelector('.lyr-ed-row');
  check(await page.locator('.lyr-ed-row').count() === 18, 'editor lists the 18 lines');
  await page.locator('.lyr-ed-list').focus();
  await page.keyboard.press('Space');
  const t0 = await page.locator('.lyr-ed-row').first().locator('.lyr-ed-t').textContent();
  check(t0 === '00:00.70', `Space taps the cursor line to the deck position (${t0})`);
  await page.click('.modal-foot .btn.primary');
  await page.waitForFunction(() => !document.querySelector('.lyr-ed'), null, { timeout: 5000 });
  const saved = await page.evaluate(async (id) => (await fetch(`/api/tracks/${id}/lyrics`)).json(), id);
  check(saved.source === 'user' && saved.synced[0].t === 0.7, 'edited lyrics saved (user source wins)');

  // ---- Link: button, peer discovery, follow + lead
  await page.click('.link-btn');
  await page.waitForFunction(() => window.opendj.link.state.enabled, null, { timeout: 5000 });
  check(await page.locator('.link-btn.active').count() === 1, 'LINK button enables Ableton Link');
  peer = new LinkNode({ transport: new UdpTransport({ port: Number(process.env.OPENDJ_LINK_PORT) }), bpm: 133, broadcastMs: 100 });
  await new Promise((r) => setTimeout(r, 700)); // OpenDJ's session is the older one → the peer joins it
  await peer.enable();
  await page.waitForFunction(() => window.opendj.link.state.peers === 1, null, { timeout: 8000 });
  check((await page.textContent('.link-btn .link-peers')).trim() === '1', 'LINK button shows 1 peer');
  peer.setTempo(133);
  await page.waitForFunction(() => Math.abs(window.opendj.link.state.bpm - 133) < 0.01, null, { timeout: 5000 }).catch(async (e) => { console.log('DIAG session bpm wait', JSON.stringify(await page.evaluate(() => ({ st: window.opendj.link.state, follow: window.opendj.link.follow, lead: window.opendj.link.lead })))); throw e; });
  await page.evaluate(() => { const d = window.opendj.engine.decks[0]; d.setMaster(); d.play(); });
  await page.waitForFunction(() => Math.abs(window.opendj.engine.decks[0].effectiveBpm - 133) < 0.05, null, { timeout: 5000 }).catch(async (e) => { console.log('DIAG deck follow wait', JSON.stringify(await page.evaluate(() => { const d = window.opendj.engine.decks[0]; return { bpm: d.effectiveBpm, tempo: d.tempo, playing: d.playing, master: d.isMaster, st: window.opendj.link.state, follow: window.opendj.link.follow, lead: window.opendj.link.lead }; }))); throw e; });
  check(true, 'master deck follows the Link tempo (120 → 133 BPM)');
  await new Promise((r) => setTimeout(r, 1500));
  const phase = await page.evaluate(() => window.opendj.link.lastError);
  check(Math.abs(phase) < 0.05, `master deck phase locked to Link (error ${(phase * 1000).toFixed(1)} mbeat)`);
  // and the other direction: OpenDJ deck tempo → session
  await page.evaluate(() => window.opendj.engine.decks[0].setTempo((126 / 120 - 1) * 100));
  const t1 = Date.now(); while (Date.now() - t1 < 4000 && Math.abs(peer.tempo - 126) > 0.01) await new Promise((r) => setTimeout(r, 50));
  check(Math.abs(peer.tempo - 126) < 0.01, `deck tempo change reaches the Link peer (${peer.tempo.toFixed(2)} BPM)`);
  const sharedPhase = await page.evaluate(async () => (await (await fetch('/api/link')).json()));
  const pp = peer.phaseAtTime(sharedPhase.host, sharedPhase.quantum);
  const dp = ((sharedPhase.phase - pp) % 4 + 6) % 4 - 2;
  check(Math.abs(dp) < 0.02, `server Link node and peer agree on the phase (Δ ${dp.toFixed(4)} beats)`);
  await peer.disable(); peer = null;
  await page.waitForFunction(() => window.opendj.link.state.peers === 0, null, { timeout: 8000 });
  check(true, 'peer leaving is noticed');
  await page.click('.link-btn');
  await page.waitForFunction(() => !window.opendj.link.state.enabled, null, { timeout: 5000 });

  const real = errors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND|net::ERR/.test(e));
  check(real.length === 0, `no console errors${real.length ? `: ${real.join(' | ')}` : ''}`);
  await page.screenshot({ path: path.join(outDir, 'link-lyrics.png') });
  console.log('screenshot', path.join(outDir, 'link-lyrics.png'));
  console.log('PASS e2e-link-lyrics');
} catch (e) {
  console.error('FAIL:', e.message); console.error(errors.join('\n'));
  await page.screenshot({ path: path.join(outDir, 'link-lyrics-fail.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await peer?.disable().catch(() => {});
  await browser.close();
  await shim?.linkApi?.close();
  await app.lighting?.close?.();
  app.shutdown?.();
  app.server.close();
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
}
