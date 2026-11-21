// End-to-end test of the mobile app's standalone mode: the UI runs with the on-device backend (?local=1: IndexedDB +
// OPFS, no OpenDJ server API) in Chromium with mobile emulation (iPhone 13, Pixel 7, a tablet in landscape).
// The Node server below only serves the static files of public/ (like the app's WebView does); any request to its
// /api/ fails the test.
// Covers: import through the file picker fallback, tags + cover art, background analysis, two decks playing, sync,
// crossfader, hot cue, playlist, a 10 s recording (WAV length checked), exports, reload persistence, hidden desktop-only
// features, no console errors, and a 4x CPU-throttled run (playback + background analysis).
// Usage: node scripts/e2e-mobile.mjs [screenshot dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-mobile-'));
const shots = path.resolve(process.argv[2] || path.join(tmp, 'shots'));
fs.mkdirSync(shots, { recursive: true });
const music = path.join(tmp, 'music');
fs.mkdirSync(music);

// ---------------------------------------------------------------- test audio (ffmpeg-static, like e2e-video)
function ffmpegBin() {
  try { return require('ffmpeg-static'); } catch { /* not installed */ }
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch { /* not on PATH */ }
  throw new Error('ffmpeg not found: run `npm i --no-save ffmpeg-static` or install ffmpeg');
}
const FF = ffmpegBin();
const ff = (...args) => execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
// kick on every beat + a tone: easy for the BPM detector
const beat = (bpm, hz, secs) => `aevalsrc='0.7*sin(2*PI*(45+90*exp(-mod(t,60/${bpm})*30))*mod(t,60/${bpm}))*exp(-mod(t,60/${bpm})*14)+0.18*sin(2*PI*${hz}*t)|0.7*sin(2*PI*(45+90*exp(-mod(t,60/${bpm})*30))*mod(t,60/${bpm}))*exp(-mod(t,60/${bpm})*14)+0.18*sin(2*PI*${hz}*t)':s=44100:d=${secs}`;
const cover = path.join(tmp, 'cover.png');
ff('-f', 'lavfi', '-i', 'color=c=0xff5500:s=96x96', '-frames:v', '1', cover);
const FILES = {
  mp3: path.join(music, 'Mobile Artist - Pocket Groove.mp3'),
  m4a: path.join(music, 'Second Artist - Bus Ride.m4a'),
  wav: path.join(music, 'Third Artist - Tram Loop.wav'),
  flac: path.join(music, 'Fourth - Late Analysis.flac'),
};
ff('-f', 'lavfi', '-i', beat(124, 220, 45), '-i', cover, '-map', '0', '-map', '1', '-c:a', 'libmp3lame', '-b:a', '192k', '-c:v', 'png', '-id3v2_version', '3',
  '-metadata', 'title=Pocket Groove', '-metadata', 'artist=Mobile Artist', '-metadata', 'album=Phone Sessions', '-metadata', 'genre=House', '-disposition:v', 'attached_pic', FILES.mp3);
ff('-f', 'lavfi', '-i', beat(128, 196, 45), '-c:a', 'aac', '-b:a', '160k', '-metadata', 'title=Bus Ride', '-metadata', 'artist=Second Artist', FILES.m4a);
ff('-f', 'lavfi', '-i', beat(122, 174.6, 40), '-c:a', 'pcm_s16le', FILES.wav);
ff('-f', 'lavfi', '-i', beat(126, 246.9, 60), '-c:a', 'flac', FILES.flac);
const unsupported = path.join(music, 'Old Format.wma');
fs.writeFileSync(unsupported, 'not really wma');

// ---------------------------------------------------------------- static server (its API must never be used)
const app = await start({ port: 7702, dataDir: path.join(tmp, 'data') });
const base = `http://127.0.0.1:${app.port}/?local=1`;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let failed = false;
const results = [];
const check = (cond, msg) => { if (!cond) throw new Error(msg); console.log('ok -', msg); };

const PROFILES = [
  { name: 'iphone13', device: devices['iPhone 13'] },
  { name: 'pixel7', device: devices['Pixel 7'] },
  { name: 'tablet-landscape', device: { ...devices['iPad (gen 7) landscape'] } }, // 1080x810: the tightest iPad landscape (QA M4)
];

async function runProfile({ name, device }) {
  console.log(`\n=== ${name} (${device.viewport.width}x${device.viewport.height}) ===`);
  const ctx = await browser.newContext({ ...device, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [], apiHits = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) apiHits.push(r.url()); });
  const shot = (n) => page.screenshot({ path: path.join(shots, `${name}-${n}.png`) });
  const ready = async () => {
    await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
    await page.locator('.overlay.start button').click({ timeout: 1500 }).catch(() => {});
  };
  try {
    await page.goto(base);
    await ready();
    check(await page.evaluate(() => document.documentElement.classList.contains('odj-local')), 'on-device mode is on (html.odj-local)');
    await shot('1-empty');
    check(/library is empty/i.test(await page.locator('.lib-empty').innerText()) && await page.locator('.lib-empty button', { hasText: 'Import music' }).count() === 1, 'empty library offers "Import music"');

    // ---- desktop-only features are hidden ----
    const hidden = await page.evaluate(() => {
      const vis = (sel) => [...document.querySelectorAll(sel)].some((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0);
      return {
        lights: vis('.light-btn'), dvs: vis('.dvs-btn'), video: vis('.video-btn'), live: vis('.live-btn'), midi: vis('.midi-dot'), stems: vis('.deck-stems'),
        folder: [...document.querySelectorAll('.lib-tools button')].some((b) => /\+ Folder/.test(b.textContent) && b.offsetParent),
        folders: [...document.querySelectorAll('.tree-head')].some((h) => /FOLDERS/.test(h.textContent)),
      };
    });
    check(Object.values(hidden).every((v) => !v), `desktop-only features hidden (${JSON.stringify(hidden)})`);

    // ---- import through the picker fallback (<input type=file>) ----
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.lib-tools .import-btn').click();
    await (await chooser).setFiles([FILES.mp3, FILES.m4a, FILES.wav, unsupported]);
    await page.waitForFunction(() => window.opendj.library.tracks.size === 3, null, { timeout: 30000 });
    check(true, 'three files imported (copy-in)');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /WMA files need FFmpeg|not an audio file OpenDJ can play/i.test(t.textContent)) || /WMA/.test(document.querySelector('.upl-panel')?.textContent || ''), null, { timeout: 5000 });
    check(true, 'the WMA file is refused with a clear message');
    const tags = await page.evaluate(() => [...window.opendj.library.tracks.values()].map((t) => ({ title: t.title, artist: t.artist, album: t.album, hasCover: t.hasCover, path: t.path, fileName: t.fileName })));
    const mp3 = tags.find((t) => t.title === 'Pocket Groove');
    check(mp3 && mp3.artist === 'Mobile Artist' && mp3.album === 'Phone Sessions' && mp3.hasCover, `ID3 tags + cover art read in the browser (${JSON.stringify(mp3)})`);
    check(tags.find((t) => t.title === 'Tram Loop')?.artist === 'Third Artist', 'title / artist from the file name when there are no tags');
    check(tags.every((t) => /^music\/[0-9a-f]{16}\.(mp3|m4a|wav)$/.test(t.path)), 'files copied into app storage (music/<id>.<ext>)');
    const coverSrc = await page.evaluate(() => { const t = [...window.opendj.library.tracks.values()].find((x) => x.hasCover); return window.opendj.library.app && (document.querySelector('.lib-rows .art') ? getComputedStyle([...document.querySelectorAll('.lib-rows .lr')].find((r) => r.textContent.includes(t.title)).querySelector('.art')).backgroundImage : ''); });
    check(/blob:/.test(coverSrc), `cover shown from app storage (${coverSrc.slice(0, 40)}…)`);

    // ---- background analysis ----
    await page.waitForFunction(() => [...window.opendj.library.tracks.values()].every((t) => t.analyzed) && !window.opendj.analyser.running, null, { timeout: 120000 });
    const bpms = await page.evaluate(() => Object.fromEntries([...window.opendj.library.tracks.values()].map((t) => [t.title, t.bpm])));
    check(Math.abs(bpms['Pocket Groove'] - 124) < 1.5 && Math.abs(bpms['Bus Ride'] - 128) < 1.5 && Math.abs(bpms['Tram Loop'] - 122) < 1.5, `analysed in the background: ${JSON.stringify(bpms)}`);
    const wave = await page.evaluate(async () => { const t = [...window.opendj.library.tracks.values()][0]; const r = await fetch(`/api/tracks/${t.id}/waveform`); return r.ok ? (await r.arrayBuffer()).byteLength : 0; });
    check(wave > 100, `waveform stored (${wave} bytes)`);
    await shot('2-library');

    // ---- two decks: load, play, sync, crossfade, hot cue ----
    const ids = await page.evaluate(() => Object.fromEntries([...window.opendj.library.tracks.values()].map((t) => [t.title, t.id])));
    await page.evaluate(async ([a, b]) => { await window.opendj.loadTrack(0, a); await window.opendj.loadTrack(1, b); }, [ids['Pocket Groove'], ids['Bus Ride']]);
    check(await page.evaluate(() => window.opendj.engine.decks.slice(0, 2).every((d) => d.track && d.duration > 30)), 'two decks loaded');
    await page.locator('.deck[data-deck="0"] .transport button').nth(1).tap();
    const deck2Visible = await page.evaluate(() => window.opendj.deckEls[1].offsetParent !== null);
    if (!deck2Visible) await page.locator('.deck-tab').nth(1).tap();
    await page.locator('.deck[data-deck="1"] .transport button').nth(1).tap();
    await page.waitForTimeout(600);
    check(await page.evaluate(() => window.opendj.engine.decks[0].playing && window.opendj.engine.decks[1].playing), 'both decks play (tapped PLAY)');
    await page.locator('.deck[data-deck="1"] .sync-row button').first().tap();
    await page.waitForTimeout(300);
    const sync = await page.evaluate(() => { const [a, b] = window.opendj.engine.decks; return { a: a.effectiveBpm, b: b.effectiveBpm }; });
    check(Math.abs(sync.a - sync.b) < 0.05, `SYNC: deck 2 follows deck 1 (${sync.a.toFixed(2)} / ${sync.b.toFixed(2)} BPM)`);
    // crossfader by touch drag
    await page.evaluate(() => { const p = document.querySelector('.upl-panel'); if (p) p.hidden = true; }); // the import panel may cover it
    const xfLoc = page.locator('.xfader-row .crossfader .fader-track, .xfader-row .crossfader').first();
    await xfLoc.scrollIntoViewIfNeeded();
    const xf = await xfLoc.boundingBox();
    if (xf) {
      await page.evaluate(() => window.opendj.engine.setCrossfader(-1));
      await page.mouse.move(xf.x + 4, xf.y + xf.height / 2); await page.mouse.down();
      await page.mouse.move(xf.x + xf.width * 0.85, xf.y + xf.height / 2, { steps: 8 }); await page.mouse.up();
    }
    const x = await page.evaluate(() => window.opendj.engine.crossfader);
    check(x > 0.2, `crossfader moved by dragging (${x.toFixed(2)})`);
    if (!deck2Visible) await page.locator('.deck-tab').nth(0).tap();
    const pad = page.locator('.deck[data-deck="0"] .pads .pad').first();
    await pad.tap();
    await page.waitForTimeout(200);
    const cue = await page.evaluate(() => window.opendj.engine.decks[0].hotCues.find((c) => c.index === 0)?.position);
    check(cue > 0, `hot cue A set by tapping the pad (${cue?.toFixed(2)} s)`);
    await page.waitForTimeout(800);
    await pad.tap();
    await page.waitForTimeout(100);
    const back = await page.evaluate(() => window.opendj.engine.decks[0].position);
    check(Math.abs(back - cue) < 0.6, `tapping hot cue A jumps back (${back.toFixed(2)} s)`);
    await shot('3-decks');

    // ---- playlist ----
    await page.locator('.tree-head button[title="New playlist"]').tap();
    await page.locator('.modal input').fill('Phone Set');
    await page.locator('.modal .btn.primary').tap();
    await page.waitForFunction(() => window.opendj.library.playlists.some((p) => p.name === 'Phone Set'), null, { timeout: 5000 });
    const pl = await page.evaluate(async (tids) => { const p = window.opendj.library.playlists.find((x) => x.name === 'Phone Set'); const r = await fetch(`/api/playlists/${p.id}/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackIds: tids }) }); await window.opendj.library.refresh(); return (await r.json()).trackIds.length; }, [ids['Pocket Groove'], ids['Tram Loop']]);
    check(pl === 2, 'playlist "Phone Set" created with 2 tracks');
    // export it (M3U through the share fallback: a download in the browser)
    const m3u = await page.evaluate(async () => { const p = window.opendj.library.playlists.find((x) => x.name === 'Phone Set'); return (await fetch(`/api/playlists/${p.id}/m3u`)).text(); });
    check(/#EXTM3U/.test(m3u) && m3u.includes('Mobile Artist - Pocket Groove.mp3'), 'M3U export names the imported files');
    const dl = page.waitForEvent('download', { timeout: 10000 });
    await page.evaluate(() => { const a = document.createElement('a'); a.href = '/api/export/rekordbox'; a.download = ''; document.body.append(a); a.click(); a.remove(); });
    const xml = fs.readFileSync(await (await dl).path(), 'utf8');
    check(/DJ_PLAYLISTS/.test(xml) && /Phone Set/.test(xml), 'rekordbox XML export downloaded through the export path');

    // ---- record 10 s ----
    await page.evaluate(() => window.opendj.engine.setCrossfader(0));
    await page.locator('.topbar .btn.rec').tap();
    await page.waitForFunction(() => window.opendj.recording.recording, null, { timeout: 5000 });
    await page.waitForTimeout(10300);
    const stopped = page.evaluate(() => new Promise((r) => window.opendj.recording.recorder.once?.('stopped', r) ?? window.opendj.recording.recorder.on('stopped', r)));
    await page.locator('.topbar .btn.rec').tap();
    const rec = await stopped;
    check(rec?.name && !rec.error, `recording saved (${rec?.name})`);
    const wav = await page.evaluate(async (n) => {
      const b = new Uint8Array(await (await fetch(`/api/recordings/file?name=${encodeURIComponent(n)}`)).arrayBuffer());
      const v = new DataView(b.buffer); const s = (o) => String.fromCharCode(...b.subarray(o, o + 4));
      return { riff: s(0), wave: s(8), sr: v.getUint32(24, true), ch: v.getUint16(22, true), bits: v.getUint16(34, true), data: v.getUint32(40, true), size: b.byteLength };
    }, rec.name);
    const secs = wav.data / (wav.sr * wav.ch * wav.bits / 8);
    check(wav.riff === 'RIFF' && wav.wave === 'WAVE' && wav.size === wav.data + 44 && secs > 9.3 && secs < 11.5, `WAV is valid: ${secs.toFixed(2)} s, ${wav.sr} Hz, ${wav.ch} ch, header matches the file size`);
    const list = await page.evaluate(async () => (await (await fetch('/api/recordings')).json()).recordings);
    check(list.length === 1 && Math.abs(list[0].duration - secs) < 0.01, 'recordings list shows it with its length');
    await page.evaluate(() => window.opendj.engine.decks.forEach((d) => d.playing && d.pause()));

    // ---- settings: the Mobile tab explains what is missing ----
    await page.evaluate(() => { window.opendj.dialogs.settings('mobile'); }); // resolves when closed: don't wait
    await page.waitForSelector('.mobile-info');
    const info = await page.locator('.mobile-info').innerText();
    check(/MIDI controllers/.test(info) && /Ableton Link/.test(info) && /Lighting/.test(info) && /DVS/.test(info) && /CDJ USB export/.test(info), 'Settings → Mobile lists the unavailable features with reasons');
    await shot('4-settings-mobile');
    await page.keyboard.press('Escape');
    await page.locator('.modal .btn.primary').click({ timeout: 1000 }).catch(() => {});

    // ---- persistence: reload ----
    await page.evaluate(() => window.opendj.library.app && fetch('/api/settings').then(() => null)); // settle
    await page.waitForTimeout(800); // debounced save
    await page.evaluate(() => { window.onbeforeunload = null; });
    page.once('dialog', (d) => d.accept().catch(() => {}));
    await page.reload();
    await ready();
    const after = await page.evaluate(async () => ({
      tracks: window.opendj.library.tracks.size, analysed: [...window.opendj.library.tracks.values()].filter((t) => t.analyzed).length,
      cues: [...window.opendj.library.tracks.values()].find((t) => t.title === 'Pocket Groove')?.cues?.filter((c) => c.index === 0).length,
      playlist: window.opendj.library.playlists.find((p) => p.name === 'Phone Set')?.trackIds.length,
      recordings: (await (await fetch('/api/recordings')).json()).recordings.length,
      plays: (await (await fetch('/api/history')).json()).length,
    }));
    check(after.tracks === 3 && after.analysed === 3 && after.cues === 1 && after.playlist === 2 && after.recordings === 1, `library, analysis, hot cue, playlist and recording survive a reload (${JSON.stringify(after)})`);
    const audioOk = await page.evaluate(async () => { const t = [...window.opendj.library.tracks.values()][0]; const r = await fetch(`/api/tracks/${t.id}/stream`); return r.ok && (await r.blob()).size > 10000; });
    check(audioOk, 'audio files are still in app storage after the reload');

    // ---- touch targets and layout ----
    const layout = await page.evaluate(() => {
      const vis = (e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0;
      const small = [...document.querySelectorAll('.deck .transport button, .deck .pads .pad, .deck .sync-row button, .topbar .btn.rec, .deck-tab, .lib-tools .import-btn')]
        .filter(vis).filter((b) => { const r = b.getBoundingClientRect(); return r.height < 43.5 || r.width < 43.5; }).map((b) => `${b.className}:${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`);
      return { small, sw: document.documentElement.scrollWidth, w: innerWidth, decks: window.opendj.deckEls.filter(vis).length, zoom: document.documentElement.style.zoom, viewport: document.querySelector('meta[name=viewport]').content };
    });
    check(layout.sw <= layout.w + 1, `no horizontal scrolling (${layout.sw} <= ${layout.w})`);
    check(!layout.small.length, `main touch targets are at least 44 px (${layout.small.slice(0, 6).join(', ')})`);
    check(/user-scalable=no/.test(layout.viewport) && /viewport-fit=cover/.test(layout.viewport), 'pinch zoom off, safe-area aware viewport');
    const landscape = device.viewport.width > device.viewport.height;
    if (landscape && name.startsWith('tablet')) {
      // iPad landscape: desktop layout at 100 %, a usable channel fader, visible meters, 36 px tap targets,
      // nothing clipped or cut off (QA M4: 37 px fader, invisible meters, 16-21 px buttons, "KEY LC")
      const tab = await page.evaluate(() => {
        const vis = (e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0;
        const ch = [...document.querySelectorAll('.mixer .strip')].filter(vis);
        const fader = Math.min(...ch.map((s) => s.querySelector('.fader-v .fader-track').getBoundingClientRect().height));
        const vu = Math.min(...ch.map((s) => s.querySelector('.vu')?.getBoundingClientRect().height || 0));
        const small = [...document.querySelectorAll('.deck .btn, .deck .pad-mode, .deck .panel-tab, .mixer .btn')].filter(vis).filter((e) => e.getBoundingClientRect().height < 31.5).map((e) => `${e.textContent.trim()}:${Math.round(e.getBoundingClientRect().height)}`);
        const clipped = [...document.querySelectorAll('.deck .btn, .deck .pad-mode, .deck .panel-tab')].filter(vis).filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.trim());
        const cut = window.opendj.deckEls.filter(vis).map((d) => { const m = d.querySelector('.deck-mid'); return m.scrollHeight - m.clientHeight; }).filter((x) => x > 1);
        return { tablet: document.documentElement.classList.contains('tablet'), fader: Math.round(fader), vu: Math.round(vu), small: small.slice(0, 6), clipped: clipped.slice(0, 6), cut };
      });
      check(tab.tablet && tab.fader >= 90 && tab.vu >= 60, `iPad landscape: channel fader ${tab.fader} px, meters ${tab.vu} px`);
      check(!tab.small.length && !tab.clipped.length && !tab.cut.length, `iPad landscape: deck and mixer buttons >= 32 px, no clipped labels, nothing cut off (${JSON.stringify(tab)})`);
    }
    check(landscape ? layout.decks >= 2 : layout.decks === 1, `${landscape ? 'landscape: two decks side by side' : 'portrait: one deck at a time'} (${layout.decks} visible)`);

    // ---- mid-range phone: 4x CPU throttling with two decks playing and analysis in the background ----
    if (name === 'pixel7') {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.evaluate(async ([a, b]) => { await window.opendj.loadTrack(0, a); await window.opendj.loadTrack(1, b); const [x, y] = window.opendj.engine.decks; x.play(); y.play(); }, [ids['Pocket Groove'], ids['Bus Ride']]);
      // a new import starts the background analysis while both decks play
      const chooser2 = page.waitForEvent('filechooser');
      await page.locator('.lib-tools .import-btn').click();
      await (await chooser2).setFiles([FILES.flac]);
      await page.waitForFunction(() => window.opendj.library.tracks.size === 4 && window.opendj.analyser.running, null, { timeout: 60000 });
      const perf = await page.evaluate(() => new Promise((resolve) => {
        let frames = 0, longest = 0, last = performance.now(); const t0 = last;
        const tick = (now) => { frames++; longest = Math.max(longest, now - last); last = now; if (now - t0 < 6000) requestAnimationFrame(tick); else resolve({ fps: frames / ((now - t0) / 1000), longest, analysing: window.opendj.analyser.running, playing: window.opendj.engine.decks.filter((d) => d.playing).length, ctx: window.opendj.engine.ctx.state }); };
        requestAnimationFrame(tick);
      }));
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      results.push({ profile: name, throttled4x: perf });
      check(perf.playing === 2 && perf.ctx === 'running', `4x CPU throttling: both decks still playing (${perf.fps.toFixed(1)} fps UI, longest frame ${perf.longest.toFixed(0)} ms, analysing: ${perf.analysing})`);
      check(perf.fps >= 10, `4x CPU throttling: the UI keeps updating (${perf.fps.toFixed(1)} fps)`);
      await page.waitForFunction(() => [...window.opendj.library.tracks.values()].every((t) => t.analyzed), null, { timeout: 120000 });
      check(true, 'background analysis finished while the decks played');
      await page.evaluate(() => window.opendj.engine.decks.forEach((d) => d.playing && d.pause()));
    }
    await page.evaluate(() => window.opendj.library.setView({ kind: 'all' }, 'Collection'));
    await page.evaluate(() => window.opendj.loadTrack(0, [...window.opendj.library.tracks.values()][0].id).then(() => window.opendj.engine.decks[0].play()));
    await page.waitForTimeout(700);
    await shot('5-playing');
    await page.evaluate(() => window.opendj.engine.decks.forEach((d) => d.playing && d.pause()));

    check(!apiHits.length, `the server API was never used (${apiHits.slice(0, 3).join(', ')})`);
    check(!errors.length, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  } catch (e) {
    failed = true;
    console.error(`FAIL [${name}]:`, e.message);
    if (errors.length) console.error(errors.join('\n'));
    await page.screenshot({ path: path.join(shots, `${name}-fail.png`) }).catch(() => {});
  }
  await ctx.close();
}

for (const p of PROFILES) await runProfile(p);
await browser.close(); app.server.close();
if (results.length) console.log('\nperformance:', JSON.stringify(results));
console.log(`screenshots: ${shots}`);
console.log(failed ? '\nE2E MOBILE FAILED' : '\nE2E MOBILE PASSED');
process.exit(failed ? 1 : 0);
