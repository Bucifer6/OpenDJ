// Store preview videos recorded from OpenDJ's own UI while the review-pack tracks mix (house 124 into techno 128,
// synced, crossfader + bass swap, a loop, the sampler, FX and, on the desktop, the visualiser). The soundtrack is
// OpenDJ's own master output, taken from the same PCM tap its recorder uses (public/js/recording/pcm-tap.js), so
// what you hear is exactly the mix on screen. Frames come from Chromium's screencast with their timestamps and are
// muxed with the audio by ffmpeg (ffmpeg-static) into H.264 / AAC MP4 files.
//
//   node scripts/review-pack/store-video.mjs [--only=appstore,play] [--seconds=26] [--out=<dir>] [--port=7942]
//
//   appstore  docs/store/video/appstore-preview-iphone-886x1920.mp4   phone mode (?local=1), portrait,
//             886×1920, 30 fps, H.264 High ≤ L4.0, AAC 256 kb/s 48 kHz stereo, 15–30 s (Apple app preview spec)
//   play      docs/store/video/play-promo-1280x720.mp4   desktop UI, 16:9, 720p (upload to YouTube for Google Play)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { start } from '../../server/index.js';
import { ensureProxyEnv, prepareTracks, ROOT, DEFAULT_CACHE } from './pack.mjs';
import { ffmpegPath } from '../demo/make-demo-library.mjs';

ensureProxyEnv();
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const log = (...a) => console.log('[store-video]', ...a);
const only = opt('only', 'appstore,play').split(',');
const SECONDS = Math.min(30, Math.max(15, Number(opt('seconds', 26))));
const OUT = path.resolve(opt('out', path.join(ROOT, 'docs/store/video')));
const PORT = Number(opt('port', 7942));
fs.mkdirSync(OUT, { recursive: true });

const VIDEOS = {
  appstore: { local: true, viewport: [443, 960], dsf: 2, size: [886, 1920], file: 'appstore-preview-iphone-886x1920.mp4', crf: 20 },
  // 1280×720: headless Chromium renders the full desktop UI at ~5 fps in 1080p, at a usable rate in 720p
  play: { local: false, viewport: [1280, 720], dsf: 1, size: [1280, 720], file: 'play-promo-1280x720.mp4', crf: 22 },
};

const { tracks } = await prepareTracks({ cache: path.resolve(opt('cache', DEFAULT_CACHE)), cc0: !argv.includes('--no-cc0'), log: (s) => log(s) });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-store-video-'));
const musicDir = path.join(tmp, 'OpenDJ Review Pack');
fs.mkdirSync(musicDir);
for (const t of tracks) fs.copyFileSync(t.file, path.join(musicDir, t.track.file));
const files = tracks.map((t) => path.join(musicDir, t.track.file));
const app = await start({ port: PORT, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const FF = ffmpegPath();
/** The empty library's "Import music" button, else the toolbar's Import (hidden in some narrow layouts). */
const importButton = (page) => page.locator('.lib-empty button', { hasText: 'Import music' }).or(page.locator('.lib-tools .import-btn:visible')).first();
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';

async function record(name, V) {
  const [width, height] = V.viewport;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: V.dsf, ...(V.local ? { isMobile: true, hasTouch: true, userAgent: MOBILE_UA } : {}) });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${name} page error]`, String(e)));
  await page.goto(`${app.url.replace(/\/$/, '')}/${V.local ? '?local=1' : ''}`);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
  await page.evaluate(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1500 }).catch(() => {});
  if (V.local) {
    const chooser = page.waitForEvent('filechooser');
    await importButton(page).click();
    await (await chooser).setFiles(files);
  } else if (!(await page.evaluate(() => window.opendj.library.tracks.size))) {
    await page.evaluate((dir) => fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir, name: 'Review Pack' }) }), musicDir);
  }
  await page.waitForFunction((n) => window.opendj.library.tracks.size === n, files.length, { timeout: 120000 });
  // background analysis would compete for the CPU (and show a progress pill) while recording
  await page.waitForFunction(() => [...window.opendj.library.tracks.values()].every((t) => t.analyzed) && !window.opendj.analyser.running, null, { timeout: 300000 });
  const ids = await page.evaluate(() => Object.fromEntries([...window.opendj.library.tracks.values()].map((t) => [t.title, t.id])));
  for (const [i, t] of [[0, 'Open Circuit'], [1, 'Iron Lattice']]) {
    await page.evaluate(([i, id]) => window.opendj.loadTrack(i, id), [i, ids[t]]);
    await page.waitForFunction((i) => !!window.opendj.engine.decks[i].waveform, i, { timeout: 60000 });
  }
  // starting state: deck 1 in its first drop, deck 2 cued 16 bars before its drop, crossfader on A, deck 2 bass cut
  await page.evaluate(() => {
    const a = window.opendj, E = a.engine, [d1, d2] = E.decks;
    document.querySelectorAll('.toast, .upl-panel').forEach((x) => x.remove());
    d1.setMaster(); d1.seek(d1.beatLen * 4 * 24 - 0.05); d2.seek(d2.beatLen * 4 * 8);
    E.channels.forEach((c) => { for (const k of ['eqLow', 'eqMid', 'eqHigh', 'filter']) c.set(k, 0); c.set('fxOn', false); c.set('volume', 1); });
    E.channels[1].set('eqLow', -1);
    E.setCrossfader(-1);
    E.decks.forEach((d) => d.showPanel?.('cues'));
    a.showDeckTab?.(0); a.mixer.renderAll?.();
    document.querySelector('#app')?.scrollTo?.(0, 0); window.scrollTo(0, 0);
    d1.play();
  });
  await page.waitForTimeout(1500); // let the meters and waveforms settle before the first frame

  // ---- audio: OpenDJ's master output through the recorder's PCM tap, stamped with the wall clock
  await page.evaluate(async () => {
    const { tapFor } = await import('/js/recording/pcm-tap.js');
    const tap = tapFor(window.opendj.engine);
    window.__rec = { chunks: [], t0: 0, sr: tap.sampleRate };
    window.__recOff = await tap.subscribe((m) => { if (!window.__rec.t0) window.__rec.t0 = Date.now() - (m.frames / tap.sampleRate) * 1000; window.__rec.chunks.push(m.pcm.slice()); });
  });
  // ---- video: CDP screencast frames with their timestamps
  const cdp = await ctx.newCDPSession(page);
  const frameDir = path.join(tmp, `frames-${name}`); fs.mkdirSync(frameDir);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    const file = path.join(frameDir, `f${String(frames.length).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp * 1000 });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: V.size[0], maxHeight: V.size[1], everyNthFrame: 1 });
  const tStart = Date.now();

  // ---- the performance (times in seconds from the start)
  const steps = [
    [1.0, () => { const [, d2] = window.opendj.engine.decks; d2.play(); d2.sync(); }],
    [2.0, ({ local }) => { if (local) document.querySelector('.mixer')?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }],
    [3.0, 'xfade', -1, 0, 5.0],
    [8.0, () => { const s = window.opendj.engine.sampler; const i = s.slots.findIndex((x) => /riser/i.test(x?.name || '')); s.trigger(i >= 0 ? i : 0); }],
    [9.5, 'bassSwap', 2.0],
    [12.0, 'xfade', 0, 1, 3.0],
    [12.5, ({ local }) => { if (local) { window.opendj.showDeckTab(1); document.querySelector('.deck[data-deck="1"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }],
    [14.0, () => { const [, d2] = window.opendj.engine.decks; d2.showPanel?.('loops'); d2.autoLoop(4); }],
    [16.0, () => { const E = window.opendj.engine, [, d2] = E.decks; d2.showPanel?.('fx'); E.channels[1].set('fxType', 'echo'); E.channels[1].set('fxMix', 0.5); E.channels[1].set('fxOn', true); }],
    [18.0, () => { const E = window.opendj.engine, [, d2] = E.decks; d2.exitLoop?.(); if (d2.loop?.active) d2.autoLoop(4); E.channels[1].set('fxOn', false); }],
    [20.5, async ({ local }) => {
      const a = window.opendj;
      if (local) { a.dialogs.automixQueue([...a.library.tracks.values()], { title: 'Review Pack' }); return; } // the phone app has no video mixer
      const api = (a.videoUi ||= (await import('/js/video/video-ui.js')).setupVideo(a));
      api.openPanel();
      for (const b of document.querySelectorAll('[class*="vid"] button')) if (b.textContent.trim() === 'YouTube') b.style.display = 'none';
      const f = document.querySelector('.vid-fps'); if (f) f.style.visibility = 'hidden';
      a.video.mixer.showNowPlaying?.('OpenDJ Demo – Iron Lattice');
    }],
  ];
  const at = (s) => tStart + s * 1000;
  for (const [t, kind, ...args] of steps) {
    const wait = at(t) - Date.now(); if (wait > 0) await page.waitForTimeout(wait);
    if (typeof kind === 'function') await page.evaluate(`(${kind})(${JSON.stringify({ local: V.local })})`).catch((e) => console.error(e.message));
    else if (kind === 'xfade') await page.evaluate(([from, to, dur]) => new Promise((res) => { const E = window.opendj.engine, t0 = performance.now(); const tick = () => { const k = Math.min(1, (performance.now() - t0) / (dur * 1000)); E.setCrossfader(from + (to - from) * (0.5 - Math.cos(Math.PI * k) / 2)); window.opendj.mixer.renderAll?.(); if (k < 1) requestAnimationFrame(tick); else res(); }; tick(); setTimeout(res, dur * 1000 + 500); }), args).catch(() => {});
    else if (kind === 'bassSwap') page.evaluate((dur) => { const E = window.opendj.engine, t0 = performance.now(); const tick = () => { const k = Math.min(1, (performance.now() - t0) / (dur * 1000)); E.channels[0].set('eqLow', -k); E.channels[1].set('eqLow', -1 + k); window.opendj.mixer.renderAll?.(); if (k < 1) requestAnimationFrame(tick); }; tick(); }, args[0]).catch(() => {});
  }
  const end = at(SECONDS + 0.4) - Date.now(); if (end > 0) await page.waitForTimeout(end);
  await cdp.send('Page.stopScreencast');
  const audio = await page.evaluate(async () => {
    window.__recOff();
    const r = window.__rec, n = r.chunks.reduce((a, c) => a + c.length, 0), pcm = new Int16Array(n);
    let o = 0; for (const c of r.chunks) { for (let i = 0; i < c.length; i++) { const v = c[i]; pcm[o++] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767); } }
    const u8 = new Uint8Array(pcm.buffer); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return { b64: btoa(s), t0: r.t0, sr: r.sr };
  });
  await ctx.close();
  log(`${name}: ${frames.length} frames in ${SECONDS} s (${(frames.length / SECONDS).toFixed(1)} fps captured), audio ${audio.sr} Hz`);

  // ---- mux: frames held for their real duration, re-timed to 30 fps; audio cut to the same wall-clock window
  const raw = path.join(tmp, `${name}.s16`); fs.writeFileSync(raw, Buffer.from(audio.b64, 'base64'));
  const startMs = Math.max(frames[0].t, audio.t0);
  const list = [];
  for (let i = 0; i < frames.length; i++) {
    const t = frames[i].t, next = frames[i + 1]?.t ?? (t + 33);
    if (next <= startMs) continue;
    list.push(`file '${frames[i].file}'`, `duration ${((next - Math.max(t, startMs)) / 1000).toFixed(4)}`);
  }
  list.push(`file '${frames.at(-1).file}'`);
  const listFile = path.join(tmp, `${name}.txt`); fs.writeFileSync(listFile, list.join('\n'));
  const audioOffset = (startMs - audio.t0) / 1000;
  const out = path.join(OUT, V.file);
  const [w, h] = V.size;
  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-f', 's16le', '-ar', String(audio.sr), '-ac', '2', '-ss', audioOffset.toFixed(3), '-i', raw,
    '-t', String(SECONDS),
    '-vf', `scale=${w}:${h}:flags=lanczos,fps=30,format=yuv420p,fade=t=in:st=0:d=0.4,fade=t=out:st=${SECONDS - 0.6}:d=0.6`,
    '-af', `afade=t=in:st=0:d=0.3,afade=t=out:st=${SECONDS - 0.8}:d=0.8,aresample=48000`,
    '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.0', '-preset', 'slow', '-crf', String(V.crf), '-maxrate', '8M', '-bufsize', '16M', '-r', '30', '-g', '60',
    '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', out];
  const r = spawnSync(FF, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${name}`);
  log(`${path.relative(ROOT, out)} ${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
  // a poster frame for the docs
  spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '6', '-i', out, '-frames:v', '1', '-q:v', '4', out.replace(/\.mp4$/, '-poster.jpg')]);
}

for (const [name, V] of Object.entries(VIDEOS)) if (only.includes(name)) await record(name, V);
await browser.close();
app.shutdown?.(); app.server.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
