// FX lab, Node side: starts OpenDJ on a throw-away data folder, injects scripts/fx/fxlab-page.js and renders
// effect specs offline in Chromium. Also: signal metrics (RMS, peak, clicks, echo period) and WAV / spectrogram
// writers for listening tests. Used by scripts/e2e-fx.mjs and for before/after audits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { start } from '../../server/index.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

export async function openLab({ demoWav } = {}) {
  const { chromium } = require('playwright');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-fxlab-'));
  const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/__fxlab/fxlab-page.js', (r) => r.fulfill({ path: path.join(here, 'fxlab-page.js'), contentType: 'text/javascript' }));
  if (demoWav) await page.route('**/__fxlab/demo.wav', (r) => r.fulfill({ path: demoWav, contentType: 'audio/wav' }));
  await page.goto(app.url);
  await page.waitForFunction(() => window.opendj?.ready, null, { timeout: 30000 });
  await page.addScriptTag({ type: 'module', url: '/__fxlab/fxlab-page.js' });
  await page.waitForFunction(() => window.fxlab?.ready, null, { timeout: 20000 });
  const dec = (b64) => { const b = Buffer.from(b64, 'base64'); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
  return {
    page, errors,
    effects: await page.evaluate(() => window.fxlab.effects),
    async render(spec) {
      const r = await page.evaluate((s) => window.fxlab.run(s), spec);
      return { sr: r.sr, L: dec(r.L), R: dec(r.R), ms: r.ms, dry: r.dry ? r.dry.map(dec) : null };
    },
    async close() { await browser.close(); app.shutdown?.(); app.server.close(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

// ---------------------------------------------------------------- metrics
export const db = (x) => 20 * Math.log10(Math.max(1e-12, x));
const idx = (sr, t) => Math.max(0, Math.round(t * sr));
export function rms(x, sr, t0 = 0, t1 = x.length / sr) { const a = idx(sr, t0), b = Math.min(x.length, idx(sr, t1)); let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); }
export function peak(x, sr, t0 = 0, t1 = x.length / sr) { const a = idx(sr, t0), b = Math.min(x.length, idx(sr, t1)); let p = 0; for (let i = a; i < b; i++) p = Math.max(p, Math.abs(x[i])); return p; }
/** Largest sample-to-sample jump in [t0, t1). */
export function maxJump(x, sr, t0 = 0, t1 = x.length / sr) { const a = Math.max(1, idx(sr, t0)), b = Math.min(x.length, idx(sr, t1)); let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1])); return m; }
/** Largest second difference (curvature): a click / step stands out far above smooth audio. */
export function maxCurv(x, sr, t0 = 0, t1 = x.length / sr) { const a = Math.max(2, idx(sr, t0)), b = Math.min(x.length, idx(sr, t1)); let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2])); return m; }
/** Times (s) of local maxima of |x| above `thresh`, at least `gap` s apart. */
export function onsets(x, sr, thresh, gap = 0.02, t0 = 0) {
  const out = []; let last = -1e9;
  for (let i = idx(sr, t0) + 1; i < x.length - 1; i++) {
    const a = Math.abs(x[i]);
    if (a > thresh && a >= Math.abs(x[i - 1]) && a >= Math.abs(x[i + 1])) {
      if (i - last > gap * sr) { out.push(i); last = i; } else if (a > Math.abs(x[out.at(-1)])) { out[out.length - 1] = i; last = i; }
    }
  }
  return out.map((i) => i / sr);
}
/** Sine-correlation magnitude response of a render vs a dry log sweep: returns dB at the given frequencies. */
export function bandLevel(x, sr, f, t0, t1) {
  // Goertzel-ish: correlate against sin/cos of f over [t0, t1)
  const a = idx(sr, t0), b = Math.min(x.length, idx(sr, t1)); let re = 0, im = 0;
  for (let i = a; i < b; i++) { const w = 2 * Math.PI * f * i / sr; re += x[i] * Math.cos(w); im += x[i] * Math.sin(w); }
  return 2 * Math.hypot(re, im) / Math.max(1, b - a);
}

// ---------------------------------------------------------------- output
export function writeWav(file, L, R, sr) {
  const n = L.length, d = Buffer.alloc(44 + n * 8);
  d.write('RIFF', 0); d.writeUInt32LE(36 + n * 8, 4); d.write('WAVEfmt ', 8); d.writeUInt32LE(16, 16); d.writeUInt16LE(3, 20); d.writeUInt16LE(2, 22);
  d.writeUInt32LE(sr, 24); d.writeUInt32LE(sr * 8, 28); d.writeUInt16LE(8, 32); d.writeUInt16LE(32, 34); d.write('data', 36); d.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) { d.writeFloatLE(L[i], 44 + i * 8); d.writeFloatLE(R[i], 48 + i * 8); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, d);
}
export function ffmpegPath() { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } }
export function spectrogram(wav, png, title = '') {
  const r = spawnSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-lavfi',
    `showspectrumpic=s=1200x480:legend=1:fscale=log:scale=log:mode=combined${title ? '' : ''}`, png]);
  if (r.status !== 0) console.warn(`spectrogram failed for ${wav}: ${r.stderr}`);
}
