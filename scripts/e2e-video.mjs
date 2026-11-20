// End-to-end test for the video mixer: generated video track on deck 1, video follows the deck (seek / loop),
// crossfader drives layer opacity, visualizer for audio-only tracks, pop-out output window receives frames.
// Usage: node scripts/e2e-video.mjs [outDir]   (needs ffmpeg on PATH, or `npm i --no-save ffmpeg-static`)
// VIDEO_RENDERER=2d forces the 2D-canvas fallback compositor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-video-'));
const outDir = process.argv[2] || tmp;
fs.mkdirSync(outDir, { recursive: true });
const music = path.join(tmp, 'Music');
fs.mkdirSync(music);

function ffmpegBin() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch { /* not on PATH */ }
  try { return require('ffmpeg-static'); } catch { /* not installed */ }
  throw new Error('ffmpeg not found: install it or run `npm i --no-save ffmpeg-static`');
}

// 40 s 640×360 VP8 + Opus test video: colour test pattern with timecode, 120 BPM kick + tone
const kick = 'mod(t,0.5)';
execFileSync(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=40',
  '-f', 'lavfi', '-i', `aevalsrc='0.7*sin(2*PI*(50+100*exp(-${kick}*40))*${kick})*exp(-${kick}*18)+0.15*sin(2*PI*220*t)|0.7*sin(2*PI*(50+100*exp(-${kick}*40))*${kick})*exp(-${kick}*18)+0.15*sin(2*PI*220*t)':s=48000:d=40`,
  '-c:v', 'libvpx', '-b:v', '1M', '-g', '15', '-deadline', 'realtime', '-cpu-used', '8',
  '-c:a', 'libopus', '-b:a', '96k', '-shortest', path.join(music, 'Video Artist - Test Pattern.webm')]);

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
writeWav(path.join(music, 'Audio Artist - Audio Only.wav'), 124, 30, 220);


// Hermetic stand-in for the YouTube IFrame Player API (the real one needs network access to youtube.com).
const YT_STUB = () => {
  window.YT = { Player: class {
    constructor(el, opts) {
      this.opts = opts; this.vol = 100; this.muted = !!opts.playerVars?.mute; this.state = -1; this.t = opts.playerVars?.start || 0;
      this.f = document.createElement('div'); this.f.className = 'yt-stub'; this.f.dataset.videoId = opts.videoId;
      Object.assign(this.f.style, { background: '#c00', width: '100%', height: '100%' });
      el.replaceWith(this.f);
      (window.__ytPlayers ||= []).push(this);
      setTimeout(() => opts.events?.onReady?.({ target: this }), 10);
    }
    getIframe() { return this.f; }
    playVideo() { this.state = 1; this.opts.events?.onStateChange?.({ data: 1 }); }
    pauseVideo() { this.state = 2; this.opts.events?.onStateChange?.({ data: 2 }); }
    mute() { this.muted = true; } unMute() { this.muted = false; } isMuted() { return this.muted; }
    setVolume(v) { this.vol = v; } getVolume() { return this.vol; }
    getCurrentTime() { return this.t; } getPlaybackRate() { return 1; } setPlaybackRate() {} seekTo(t) { this.t = t; }
    getPlayerState() { return this.state; }
    loadVideoById(o) { this.f.dataset.videoId = o.videoId; }
    getVideoData() { return { title: 'Stub Video', author: 'Stub Channel' }; }
    destroy() { this.f.remove(); }
  } };
};

const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 960 } });
await context.addInitScript(YT_STUB);
const page = await context.newPage();
const errors = [];
const watch = (p) => { p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); p.on('pageerror', (e) => errors.push(String(e))); };
watch(page);
class CheckError extends Error {}
const check = (cond, msg) => { if (!cond) throw new CheckError(msg); console.log('ok -', msg); };
const fail = async (msg) => {
  console.error('FAIL:', msg); console.error(errors.join('\n'));
  await page.screenshot({ path: path.join(outDir, 'video-fail.png') }).catch(() => {});
  console.error('screenshot', path.join(outDir, 'video-fail.png'));
  await browser.close(); app.server.close(); process.exit(1);
};

/** Sample (video.currentTime − deck.position) on animation frames for `ms`. */
const sampleDrift = (ms) => page.evaluate((ms) => new Promise((resolve) => {
  const layer = window.opendj.video.mixer.layers[0], deck = window.opendj.engine.decks[0];
  const out = []; const t0 = performance.now();
  const step = () => {
    const v = layer.video;
    if (v) out.push({ t: performance.now() - t0, drift: v.currentTime - deck.position, seeking: v.seeking });
    if (performance.now() - t0 < ms) requestAnimationFrame(step); else resolve(out);
  };
  requestAnimationFrame(step);
}), ms);
const maxAbs = (s) => Math.max(...s.map((x) => Math.abs(x.drift)));

try {
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 15000 });
  await page.evaluate(() => window.opendj.engine.resume());
  await page.locator('.overlay.start button').click({ timeout: 1000 }).catch(() => {});

  const r = await page.evaluate(async (dir) => (await fetch('/api/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dir }) })).json(), music);
  check(r.id, 'folder added');
  await page.waitForFunction(() => window.opendj.library.tracks.size === 2, null, { timeout: 15000 });
  const ids = await page.evaluate(() => ['Test Pattern', 'Audio Only'].map((n) => [...window.opendj.library.tracks.values()].find((t) => t.title === n)?.id));
  check(ids[0] && ids[1], 'video + audio tracks scanned');

  // wiring is not in app.js yet: set the video module up from the page
  await page.evaluate(async (renderer) => {
    if (renderer) localStorage.setItem('opendj.video', JSON.stringify({ renderer })); // VIDEO_RENDERER=2d tests the 2D fallback
    if (!document.querySelector('link[href$="video.css"]')) {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'css/video.css'; document.head.append(l);
      await new Promise((res) => { l.onload = res; l.onerror = res; });
    }
    const { setupVideo } = await import('/js/video/video-ui.js');
    window.__videoApi = setupVideo(window.opendj);
    window.__videoApi.openPanel();
  }, process.env.VIDEO_RENDERER || '');
  check(await page.locator('.vid-panel').isVisible(), 'video panel opens');
  const kind = await page.evaluate(() => window.opendj.video.mixer.rendererKind);
  console.log('renderer:', kind);

  await page.evaluate(async (ids) => { await window.opendj.loadTrack(0, ids[0]); await window.opendj.loadTrack(1, ids[1]); }, ids);
  await page.waitForFunction(() => { const l = window.opendj.video.mixer.layers[0]; return l.kind === 'video' && l.video?.readyState >= 2; }, null, { timeout: 15000 });
  check(true, 'deck 1 has a video layer (muted <video> decoding)');
  check(await page.evaluate(() => window.opendj.video.mixer.layers[0].video.muted), 'video element is muted (audio comes from the deck)');
  check(await page.evaluate(() => window.opendj.video.mixer.layers[1].kind) === 'visual', 'audio-only deck 2 gets the visualizer');

  // play: video follows the deck clock
  await page.evaluate(() => { const E = window.opendj.engine; E.setCrossfader(-1); E.channels[0].set('volume', 1); E.decks[0].play(); });
  await page.waitForTimeout(1500);
  let s = await sampleDrift(1500);
  console.log(`  play: max |drift| ${(maxAbs(s) * 1000).toFixed(0)} ms over ${s.length} frames`);
  check(maxAbs(s) < 0.1, `video tracks deck while playing (max ${(maxAbs(s) * 1000).toFixed(0)} ms)`);

  // tempo change: playbackRate follows
  await page.evaluate(() => window.opendj.engine.decks[0].setTempo(6));
  await page.waitForTimeout(1200);
  s = await sampleDrift(1000);
  const pr = await page.evaluate(() => window.opendj.video.mixer.layers[0].video.playbackRate);
  check(Math.abs(pr - 1.06) < 0.04 && maxAbs(s) < 0.1, `video follows +6 % tempo (playbackRate ${pr.toFixed(3)}, max ${(maxAbs(s) * 1000).toFixed(0)} ms)`);
  await page.evaluate(() => window.opendj.engine.decks[0].setTempo(0));

  // seek (hot-cue style jump)
  await page.evaluate(() => window.opendj.engine.decks[0].seek(22.3));
  await page.waitForTimeout(500);
  s = await sampleDrift(800);
  check(maxAbs(s) < 0.1, `video re-syncs after seek (max ${(maxAbs(s) * 1000).toFixed(0)} ms, 500 ms after the jump)`);

  // loop: 1.5 s loop, sample across several wraps; after each wrap the video must be back within 100 ms
  await page.evaluate(() => { const d = window.opendj.engine.decks[0]; const p = d.position; d.setLoop(p + 0.2, p + 1.7); });
  await page.waitForTimeout(2000);
  s = await sampleDrift(3500);
  const settled = s.filter((x) => !x.seeking);
  const within = settled.filter((x) => Math.abs(x.drift) < 0.1).length / Math.max(1, settled.length);
  console.log(`  loop: ${(within * 100).toFixed(0)} % of frames within 100 ms; last ${(s.at(-1).drift * 1000).toFixed(0)} ms`);
  check(within > 0.85 && Math.abs(s.at(-1).drift) < 0.1, `video follows the loop (${(within * 100).toFixed(0)} % of frames within 100 ms)`);
  await page.evaluate(() => window.opendj.engine.decks[0].exitLoop());

  // pause → video pauses at the deck position
  await page.evaluate(() => window.opendj.engine.decks[0].pause());
  await page.waitForTimeout(500);
  const pz = await page.evaluate(() => { const l = window.opendj.video.mixer.layers[0]; return { paused: l.video.paused, drift: l.video.currentTime - window.opendj.engine.decks[0].position }; });
  check(pz.paused && Math.abs(pz.drift) < 0.05, `video pauses with the deck (drift ${(pz.drift * 1000).toFixed(0)} ms)`);
  await page.evaluate(() => window.opendj.engine.decks[0].play());

  // crossfader → layer opacity
  const op = async (x) => page.evaluate(async (x) => { window.opendj.engine.setCrossfader(x); await new Promise((r) => setTimeout(r, 120)); return window.opendj.video.mixer.weights.map((w) => +w.alpha.toFixed(3)); }, x);
  await page.evaluate(() => { window.opendj.engine.channels[1].set('volume', 1); window.opendj.engine.decks[1].play(); });
  const wA = await op(-1), wMid = await op(0), wB = await op(1);
  console.log('  weights A/mid/B', JSON.stringify([wA, wMid, wB]));
  check(wA[0] > 0.99 && wA[1] < 0.01 && wB[0] < 0.01 && wB[1] > 0.99 && Math.abs(wMid[0] - 0.5) < 0.05, 'crossfader drives layer opacity (A → mix → B)');
  await page.evaluate(() => window.opendj.video.mixer.setTransition('wipeleft'));
  const wipe = await op(0);
  check(wipe[0] > 0.99 && wipe[1] > 0.99, 'wipe transition shows both layers split');
  await page.evaluate(() => { window.opendj.video.mixer.setTransition('crossfade'); window.opendj.engine.channels[0].set('volume', 0.5); });
  const half = await op(-1);
  check(Math.abs(half[0] - 0.25) < 0.02, `fader² sets opacity (0.5 → ${half[0]})`);
  await page.evaluate(() => window.opendj.engine.channels[0].set('volume', 1));
  await op(-0.6);

  // FX + overlay
  await page.evaluate(() => { const m = window.opendj.video.mixer; m.setFx(0, 'pulse', true); m.setFx(1, 'kaleido', true); m.setOverlay({ text: 'DJ TEST' }); m.showNowPlaying(); });
  await page.waitForTimeout(700);
  await page.locator('.vid-panel').screenshot({ path: path.join(outDir, 'video-panel.png') });
  console.log('screenshot:', path.join(outDir, 'video-panel.png'));

  // pop-out output window receives frames
  await op(-1);
  const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }), page.evaluate(() => window.__videoApi.openOutputWindow())]);
  watch(popup);
  await popup.waitForLoadState('domcontentloaded');
  await popup.waitForFunction(() => { const v = document.getElementById('out'); return v.srcObject && v.readyState >= 2 && v.videoWidth > 0; }, null, { timeout: 10000 });
  await popup.waitForTimeout(800);
  const lum = await popup.evaluate(() => {
    const v = document.getElementById('out'); const c = document.createElement('canvas'); c.width = 160; c.height = 90;
    const g = c.getContext('2d'); g.drawImage(v, 0, 0, 160, 90);
    const d = g.getImageData(0, 0, 160, 90).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return s / (d.length / 4) / 3;
  });
  check(lum > 20, `pop-out output shows a non-black frame (mean luma ${lum.toFixed(1)})`);
  await popup.setViewportSize({ width: 960, height: 540 }).catch(() => {});
  await popup.screenshot({ path: path.join(outDir, 'video-output.png') });
  console.log('screenshot:', path.join(outDir, 'video-output.png'));

  // YouTube layer (stubbed IFrame API): CSS opacity follows its crossfader side, jukebox volume too, pop-out follows
  await page.evaluate(async () => {
    const E = window.opendj.engine; E.decks[1].pause(); E.channels[1].set('volume', 0);
    const yt = window.opendj.video.youtube;
    await yt.load('dQw4w9WgXcQ', { title: 'Stub Video' });
    yt.setSide('B'); yt.setJukebox(true);
  });
  const ytAt = async (x) => page.evaluate(async (x) => { window.opendj.engine.setCrossfader(x); await new Promise((r) => setTimeout(r, 150)); const p = window.__ytPlayers[0]; return { op: Number(p.f.style.opacity), vol: p.vol, muted: p.muted }; }, x);
  const y1 = await ytAt(-1), y2 = await ytAt(1);
  console.log('  youtube A/B', JSON.stringify([y1, y2]));
  check(y1.op < 0.01 && y2.op > 0.99, 'YouTube layer opacity follows its crossfader side');
  check(y1.vol === 0 && y2.vol > 50 && !y2.muted, `jukebox volume follows the crossfader (${y1.vol} → ${y2.vol})`);
  await popup.waitForFunction(() => window.__ytPlayers?.length === 1 && Number(document.getElementById('yt').style.opacity) > 0.9, null, { timeout: 5000 });
  check(await popup.evaluate(() => window.__ytPlayers[0].opts.playerVars.mute === 1), 'pop-out runs its own muted YouTube player, synced by postMessage');
  await page.evaluate(() => window.opendj.video.youtube.stop());
  await page.evaluate(() => window.opendj.engine.setCrossfader(-1));
  // black when nothing plays
  await page.evaluate(() => { const E = window.opendj.engine; E.decks.forEach((d) => d.pause()); E.channels[0].set('volume', 0); E.channels[1].set('volume', 0); window.opendj.video.mixer.setOverlay({ text: '' }); window.opendj.video.mixer.setFx(0, 'pulse', false); });
  await popup.waitForTimeout(1200);
  const lum2 = await popup.evaluate(() => {
    const v = document.getElementById('out'); const c = document.createElement('canvas'); c.width = 160; c.height = 90;
    const g = c.getContext('2d'); g.drawImage(v, 0, 0, 160, 90);
    const d = g.getImageData(0, 0, 160, 90).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return s / (d.length / 4) / 3;
  });
  check(lum2 < 30, `output goes dark with faders down (mean luma ${lum2.toFixed(1)}; lower third may still be fading)`);

  await page.screenshot({ path: path.join(outDir, 'video-app.png') });
  const real = errors.filter((e) => !/favicon|404 \(Not Found\)|youtube|ytimg/i.test(e));
  check(real.length === 0, `no console errors${real.length ? ': ' + real.join(' | ') : ''}`);
  console.log('\nE2E VIDEO PASSED');
} catch (e) { await fail(e instanceof CheckError ? e.message : e.stack || e.message); }
await browser.close();
app.server.close();
process.exit(0);
