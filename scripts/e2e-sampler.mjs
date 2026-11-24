// Sampler sound check: renders every built-in pad sound in headless Chromium (OfflineAudioContext, the same code the
// app uses), then checks each one objectively: loudness (BS.1770 LUFS), true sample peak, clicks at the edges and
// inside, envelope, and spectral content (the air horn must be a harmonic-rich tone near its pitch, the kick must
// sit in the sub range, the triplet horn must have three onsets…). Writes the WAVs and ffmpeg spectrogram PNGs.
//
//   node scripts/e2e-sampler.mjs [outDir]      (default: a temp folder, printed at the end)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { start } from '../server/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
let ffmpeg = null;
try { ffmpeg = require('ffmpeg-static'); } catch { /* optional: no PNGs then */ }

const out = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-sampler-')));
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-sampler-'));
const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
let failed = 0;
const check = (cond, msg) => { if (cond) console.log('ok -', msg); else { failed++; console.error('FAIL -', msg); } };

try {
  await page.goto(app.url + 'icon.svg');
  const res = await page.evaluate(async () => {
    const S = await import('/js/audio/sampler.js');
    const fft = (re) => { // in-place radix-2 magnitude spectrum of a power-of-two frame
      const n = re.length, im = new Float64Array(n), r = Float64Array.from(re);
      for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [r[i], r[j]] = [r[j], r[i]]; } }
      for (let len = 2; len <= n; len <<= 1) {
        const a = -2 * Math.PI / len;
        for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
          const wr = Math.cos(a * k), wi = Math.sin(a * k), xr = r[i + k + len / 2], xi = im[i + k + len / 2];
          const tr = xr * wr - xi * wi, ti = xr * wi + xi * wr;
          r[i + k + len / 2] = r[i + k] - tr; im[i + k + len / 2] = im[i + k] - ti; r[i + k] += tr; im[i + k] += ti;
        }
      }
      return Array.from({ length: n / 2 }, (_, k) => Math.hypot(r[k], im[k]));
    };
    const sr = 48000, outp = {};
    const analyse = (buf, name) => {
      const L = buf.getChannelData(0), R = buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0), n = L.length;
      // envelope: 10 ms RMS frames
      const fr = Math.round(0.01 * sr), env = [];
      for (let s = 0; s + fr <= n; s += fr) { let e = 0; for (let i = s; i < s + fr; i++) e += (L[i] * L[i] + R[i] * R[i]) / 2; env.push(Math.sqrt(e / fr)); }
      const envMax = Math.max(...env), attackMs = env.findIndex((v) => v >= envMax * 0.7) * 10;
      // onsets: frames where the level jumps from below 25 % to above 60 % of the max
      let onsets = 0, low = true;
      for (const v of env) { if (low && v > envMax * 0.6) { onsets++; low = false; } else if (v < envMax * 0.25) low = true; }
      // clicks: the largest sample-to-sample step relative to the local level, outside the first 5 ms
      let maxJump = 0;
      for (let i = Math.round(0.005 * sr); i < n; i++) maxJump = Math.max(maxJump, Math.abs(L[i] - L[i - 1]));
      // spectrum of the loudest 8192-sample window (Hann)
      const N = 8192; let best = 0, bestE = -1;
      for (let s = 0; s + N <= n; s += N / 4) { let e = 0; for (let i = s; i < s + N; i += 8) e += L[i] * L[i]; if (e > bestE) { bestE = e; best = s; } }
      const frame = new Float64Array(N);
      for (let i = 0; i < N && best + i < n; i++) frame[i] = L[best + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
      const mag = fft(frame), hz = (k) => k * sr / N;
      let peakK = 1; for (let k = 2; k < mag.length; k++) if (mag[k] > mag[peakK]) peakK = k;
      let num = 0, den = 0; for (let k = 1; k < mag.length; k++) { num += hz(k) * mag[k]; den += mag[k]; }
      // harmonicity around the expected horn pitch: energy at multiples of f0 vs between them
      const harm = (f0) => {
        let on = 0, off = 0;
        for (let h = 1; h <= 12; h++) {
          const k = Math.round(h * f0 / (sr / N));
          for (let d = -2; d <= 2; d++) on += mag[k + d] ** 2;
          const m = Math.round((h + 0.5) * f0 / (sr / N));
          for (let d = -2; d <= 2; d++) off += mag[m + d] ** 2;
        }
        return on / Math.max(1e-12, off);
      };
      // band energies (share of total)
      const band = (lo, hi) => { let e = 0, t = 0; for (let k = 1; k < mag.length; k++) { const p = mag[k] ** 2; t += p; if (hz(k) >= lo && hz(k) < hi) e += p; } return e / t; };
      // f0 from the harmonic sum (sub-harmonic summation over 300..700 Hz)
      let f0 = 0, f0s = -1;
      for (let f = 300; f <= 700; f += 1) { let s = 0; for (let h = 1; h <= 8; h++) s += mag[Math.round(h * f / (sr / N))]; if (s > f0s) { f0s = s; f0 = f; } }
      return {
        name, seconds: n / sr, lufs: buf.stats.lufs, peakDb: 20 * Math.log10(buf.stats.peak), gainDb: buf.stats.gainDb,
        first: Math.max(Math.abs(L[0]), Math.abs(R[0])), last: Math.max(Math.abs(L[n - 1]), Math.abs(R[n - 1])),
        attackMs, onsets, maxJump, peakHz: hz(peakK), centroid: num / den, harm466: harm(466), f0,
        sub: band(20, 150), mid: band(300, 4000), high: band(4000, 20000),
        wav: Array.from(S.toWav(buf)),
      };
    };
    // the synthesised bank (each sound's fallback), then what the pads with a bundled recording play
    for (const { id, name } of S.SOUND_BANK) outp[id] = analyse(await S.renderSound(id, sr), name);
    const ac = new OfflineAudioContext(1, 1, sr);
    for (const { id, name, file } of S.SOUND_BANK) if (file) outp[`${id}-rec`] = analyse(await S.bankSound(id, ac), `${name} (recording)`);
    return outp;
  });

  for (const [id, r] of Object.entries(res)) {
    const wav = path.join(out, `${id}.wav`);
    fs.writeFileSync(wav, Buffer.from(r.wav));
    delete r.wav;
    if (ffmpeg) {
      const png = path.join(out, `${id}.png`);
      const p = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-lavfi', 'showspectrumpic=s=1024x512:legend=1:scale=log:fscale=lin:color=intensity', png]);
      if (p.status !== 0) console.warn('ffmpeg failed for', id, String(p.stderr));
    }
    console.log(`${id.padEnd(11)} ${r.seconds.toFixed(2)}s  ${r.lufs.toFixed(1)} LUFS  peak ${r.peakDb.toFixed(2)} dBFS  attack ${r.attackMs} ms  onsets ${r.onsets}  peakHz ${r.peakHz.toFixed(0)}  centroid ${r.centroid.toFixed(0)}  f0 ${r.f0}  harm ${r.harm466.toFixed(1)}  sub ${r.sub.toFixed(2)} mid ${r.mid.toFixed(2)} high ${r.high.toFixed(2)}  jump ${r.maxJump.toFixed(3)}`);
  }

  // ---- objective checks ----
  for (const [id, r] of Object.entries(res)) {
    check(r.peakDb <= -0.95, `${id}: peak-limited (${r.peakDb.toFixed(2)} dBFS ≤ -1)`);
    check(r.first < 0.002 && r.last < 0.002, `${id}: faded edges, no click at start/end (${r.first.toFixed(4)} / ${r.last.toFixed(4)})`);
    check(r.lufs > -24 && r.lufs < -12.5, `${id}: loudness ${r.lufs.toFixed(1)} LUFS (target -14, percussive one-shots stay below)`);
  }
  for (const id of ['airhorn', 'airhorn3', 'siren', 'riser', 'noisesweep']) check(Math.abs(res[id].lufs + 14) < 1.5, `${id}: sustained sound normalised to -14 LUFS (${res[id].lufs.toFixed(1)})`);
  const h = res.airhorn;
  check(Math.abs(h.f0 - 466) < 12, `air horn pitch ≈ 466 Hz (Bb4) (${h.f0} Hz)`);
  check(h.harm466 > 8, `air horn is harmonic (harmonic / in-between energy ${h.harm466.toFixed(1)})`);
  check(h.mid > 0.6, `air horn energy in the horn formant range 300 Hz-4 kHz (${(h.mid * 100).toFixed(0)} %)`);
  check(h.attackMs <= 40, `air horn fast attack (${h.attackMs} ms)`);
  check(h.onsets === 1 && h.seconds > 1.5, 'air horn: one long blast');
  check(res.airhorn3.onsets === 3, `air horn ×3: three blasts "ba-ba-baaah" (${res.airhorn3.onsets} onsets)`);
  // the recording the Air Horn pads play (public/samples/air-horn.mp3)
  const rh = res['airhorn-rec'], r3 = res['airhorn3-rec'];
  check(rh.onsets === 1 && rh.seconds > 2.4 && rh.seconds < 2.9, `recorded air horn: one blast with its fade (${rh.seconds.toFixed(2)} s)`);
  check(r3.onsets === 3 && Math.abs(r3.seconds - (rh.seconds + 0.38)) < 0.01, `recorded air horn ×3: two stabs, then the whole horn (${r3.onsets} onsets, ${r3.seconds.toFixed(2)} s)`);
  check(Math.abs(rh.lufs + 14) < 1.5 && Math.abs(r3.lufs + 14) < 1.5, `recorded horns normalised to -14 LUFS (${rh.lufs.toFixed(1)} / ${r3.lufs.toFixed(1)})`);
  check(res.kick.sub > 0.5 && res.kick.attackMs <= 10, `kick: sub-heavy (${(res.kick.sub * 100).toFixed(0)} % below 150 Hz), instant attack`);
  check(res.impact.sub > 0.4, `impact: sub boom (${(res.impact.sub * 100).toFixed(0)} % below 150 Hz)`);
  check(res.clap.mid > 0.6 && res.clap.attackMs <= 20, `clap: mid-band noise burst (${(res.clap.mid * 100).toFixed(0)} %)`);
  check(res.riser.attackMs > 2500, `riser: builds up (level peaks at ${res.riser.attackMs} ms)`);
  check(res.downlifter.attackMs < 200, `downlifter: starts loud and falls (${res.downlifter.attackMs} ms)`);
  check(res.laser.centroid > 800, `laser: bright zap (centroid ${res.laser.centroid.toFixed(0)} Hz)`);

  // ---- in the app: pads, bank switching (saved in settings), pad volume, sync-to-beat start ----
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 20000 });
  const ui = await page.evaluate(async () => {
    const a = window.opendj, s = a.engine.sampler;
    await s.ready;
    const names = s.slots.map((x) => x.name), loaded = s.slots.every((x) => x.buffer);
    await s.setSound(0, 'airhorn3'); s.setPadVolume(0, 0.5); s.setPadSync(0, true);
    await a.setSetting('sampler', s.config());
    const saved = (await (await fetch('/api/settings')).json()).sampler;
    s.nextBeat = () => a.engine.ctx.currentTime + 0.25;
    const quant = s.startTime(0) - a.engine.ctx.currentTime, free = s.startTime(1);
    const padText = [...document.querySelectorAll('.sampler-bar .spad')].map((b) => b.textContent);
    return { names, loaded, saved, quant, free, padText };
  });
  check(ui.loaded && ui.names.join(',') === 'Air Horn,Siren,Laser,Kick,Clap,Rewind,Riser,Impact', `app pads keep their order and names (${ui.names.join(', ')})`);
  check(ui.saved?.pads?.[0]?.sound === 'airhorn3' && ui.saved.pads[0].volume === 0.5 && ui.saved.pads[0].sync === true, 'pad sound / volume / sync saved in settings');
  check(ui.padText[0] === 'Air Horn ×3', `pad label follows the chosen sound (${ui.padText[0]})`);
  check(ui.quant > 0.2 && ui.quant < 0.3 && ui.free === 0, `sync-to-beat pads start on the next beat (${ui.quant.toFixed(3)} s), others at once`);
  check(errors.length === 0, `no page errors ${errors.join(' | ')}`);

  // ---- the recorded air horn, the CC0 library download, and both surviving a restart (server + browser) ----
  // Same port and the same browser profile on both runs, as the desktop app: browser storage is per origin.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-e2e-sampler-profile-'));
  const dataDir = path.join(tmp, 'restart-data');
  const PORT = 7902;
  const fakeFlac = (() => { // the pinned catalogue URL is answered locally (no network in CI): a 0.4 s 60 Hz thump as WAV
    const sr = 44100, n = Math.round(sr * 0.4), b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(0.8 * Math.sin(2 * Math.PI * 60 * i / sr) * Math.exp(-i / sr * 8) * 32767), 44 + i * 2);
    return b;
  })();
  const fetched = [];
  const run = async (fn) => {
    const srv = await start({ port: PORT, dataDir });
    const ctx = await chromium.launchPersistentContext(profile, { headless: true });
    await ctx.route('https://raw.githubusercontent.com/**', (r) => { fetched.push(r.request().url()); r.fulfill({ status: 200, contentType: 'audio/flac', body: fakeFlac }); });
    await ctx.route('https://evil.example/**', (r) => { fetched.push(r.request().url()); r.fulfill({ status: 200, body: fakeFlac }); });
    const pg = ctx.pages()[0] || await ctx.newPage();
    pg.on('pageerror', (e) => errors.push(String(e)));
    try {
      await pg.goto(srv.url); await pg.waitForFunction(() => window.opendj?.ready, null, { timeout: 20000 });
      return await fn(pg);
    } finally { await ctx.close(); srv.shutdown(); srv.server.closeAllConnections?.(); await new Promise((r) => srv.server.close(r)); }
  };
  const first = await run((pg) => pg.evaluate(async () => {
    const a = window.opendj, s = a.engine.sampler, { SAMPLE_CATALOG } = await import('/js/audio/sample-catalog.js');
    await s.ready;
    const horn = s.slots[0].buffer, d = horn.getChannelData(0); let pk = 0; for (const v of d) pk = Math.max(pk, Math.abs(v));
    const entry = SAMPLE_CATALOG.find((x) => x.id === 'bd_808');
    const r = await s.loadCatalogSample(1, { id: 'bd_808' });
    let refused = '';
    try { await s.loadCatalogSample(2, { id: 'evil', name: 'x', url: 'https://evil.example/x.flac' }); } catch (e) { refused = e.message; }
    let refused2 = '';
    try { await s.loadCatalogSample(2, { ...entry, id: 'not-in-catalogue', url: 'https://evil.example/y.flac' }); } catch (e) { refused2 = e.message; }
    await a.setSetting('sampler', s.config());
    // the browser dialog: 111 sounds, search filters
    a.openSamplerCatalog(3, () => {});
    await new Promise((res) => setTimeout(res, 200));
    const all = document.querySelectorAll('.sample-catalog-item').length;
    const inp = document.querySelector('.sample-catalog-modal input[type=search]'); inp.value = 'vinyl'; inp.dispatchEvent(new Event('input'));
    const vinyl = document.querySelectorAll('.sample-catalog-item').length;
    document.querySelector('.sample-catalog-modal .modal-x, .overlay .modal-x')?.click();
    return { hornDur: horn.duration, hornPeakDb: 20 * Math.log10(pk), hornName: s.slots[0].name, saved: r.saved, name: s.slots[1].name, creator: s.slots[1].creator, refused, refused2, all, vinyl, title: document.querySelectorAll('.sampler-bar .spad')[1]?.title };
  }));
  check(first.hornName === 'Air Horn' && first.hornDur > 2.4 && first.hornDur < 2.9, `pad 1 plays the recorded air horn (${first.hornDur.toFixed(2)} s)`);
  check(first.hornPeakDb <= -0.9, `recorded air horn mastered to the bank's -1 dBFS ceiling (peak ${first.hornPeakDb.toFixed(2)} dBFS)`);
  check(first.saved && first.name === 'Bd 808' && first.creator, `CC0 sample downloaded to pad 2 and stored (${first.name} by ${first.creator})`);
  check(/^Bd 808 — .+ · CC0 1\.0 · https:\/\/freesound\.org\//.test(first.title || ''), `pad tooltip credits the creator and source (${first.title})`);
  check(/Invalid sample selection/.test(first.refused) && /Invalid sample selection/.test(first.refused2) && !fetched.some((u) => u.includes('evil.example')), 'only catalogue entries are downloaded, from their pinned URL (other URLs never fetched)');
  check(fetched.length === 1 && fetched[0].includes('/ed4b23ccb77f0845cbad2b8d911cd36a455ec597/etc/samples/bd_808.flac'), 'download went to the pinned Sonic Pi commit');
  check(first.all === 111 && first.vinyl >= 3 && first.vinyl < 111, `sound library lists ${first.all} sounds, search narrows to ${first.vinyl}`);
  const second = await run((pg) => pg.evaluate(async () => {
    const s = window.opendj.engine.sampler; await s.ready;
    for (let k = 0; k < 50 && !s.slots[1].creator; k++) await new Promise((r) => setTimeout(r, 100));
    return { hornDur: s.slots[0].buffer?.duration, horn: s.slots[0].builtin && s.slots[0].sound === 'airhorn', name: s.slots[1].name, creator: s.slots[1].creator, license: s.slots[1].license, buf: s.slots[1].buffer?.duration, builtin: s.slots[1].builtin };
  }));
  check(second.horn && second.hornDur > 2.4 && second.hornDur < 2.9, 'after a restart: pad 1 is still the recorded air horn');
  check(second.name === 'Bd 808' && second.creator === first.creator && second.license === 'CC0 1.0' && second.buf > 0.3 && !second.builtin, `after a restart: the downloaded sample is still on pad 2 with its credits (${JSON.stringify(second)})`);
  check(fetched.length === 1, 'after a restart: restored from browser storage, not downloaded again');
  fs.rmSync(profile, { recursive: true, force: true });
  check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  console.log(`\nWAVs${ffmpeg ? ' + spectrogram PNGs' : ''} in ${out}`);
} catch (e) {
  failed++; console.error(e);
} finally {
  await browser.close(); app.server.close(); app.shutdown();
}
process.exit(failed ? 1 : 0);
