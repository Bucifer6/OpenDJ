// Audio-reactive deck scenes: cover ring, spectrum, waveform, particles and prism tunnel.
// Draws into its own small canvas; the mixer uses that canvas as a layer texture.
// Taps the channel's post-FX signal with our own AnalyserNode (engine.js is not modified).
import { api } from '../api.js';
import { cssVar } from '../ui/themes.js';
import { visualStyle } from './video-core.js';

const W = 640, H = 360;

export class Visualizer {
  constructor(app, index) {
    this.app = app; this.index = index;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.g = this.canvas.getContext('2d');
    this.analyser = null; this.bins = null; this.cover = null; this.coverFor = null;
    this.energy = 0; this.smooth = new Float32Array(48); this.hue = 0;
    this.style = 'ring'; this.wave = null;
    this.accent = cssVar('--accent');
    this._onTheme = () => { this.accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3ea6ff'; };
    window.addEventListener('opendj-theme', this._onTheme);
    this.ready = true;
  }

  get width() { return W; }
  get height() { return H; }
  setStyle(id) { this.style = visualStyle(id); }

  ensureAnalyser() {
    if (this.analyser) return;
    const eng = this.app.engine, ch = eng.channels[this.index];
    this.analyser = eng.ctx.createAnalyser();
    this.analyser.fftSize = 512; this.analyser.smoothingTimeConstant = 0.6;
    ch.fx.output.connect(this.analyser); // fan-out tap: does not change the audio path
    ch.fx.wetOut?.connect(this.analyser); // post-fader FX tails (silent in pre-fader mode)
    this.bins = new Uint8Array(this.analyser.frequencyBinCount);
    this.wave = new Uint8Array(this.analyser.fftSize);
  }

  setTrack(track) {
    if (!track) { this.cover = null; this.coverFor = null; return; }
    if (this.coverFor === track.id) return;
    this.coverFor = track.id; this.cover = null;
    const img = new Image();
    img.onload = () => { if (this.coverFor === track.id && img.naturalWidth) this.cover = img; };
    img.src = api.coverUrl(track.id);
  }

  /** Render one frame. deck gives the beat phase; work stays bounded per style. */
  draw(deck, now) {
    this.ensureAnalyser();
    const g = this.g, a = this.analyser, bins = this.bins;
    a.getByteFrequencyData(bins);
    // bass energy for the pulse, 48 log-spaced bands for the ring
    let bass = 0; for (let i = 1; i < 8; i++) bass += bins[i]; bass /= 7 * 255;
    this.energy += (bass - this.energy) * 0.3;
    const n = this.smooth.length;
    for (let k = 0; k < n; k++) {
      const lo = Math.floor(2 * Math.pow(bins.length / 2, k / n)), hi = Math.max(lo + 1, Math.floor(2 * Math.pow(bins.length / 2, (k + 1) / n)));
      let m = 0; for (let i = lo; i < hi && i < bins.length; i++) m = Math.max(m, bins[i]);
      this.smooth[k] += (m / 255 - this.smooth[k]) * 0.45;
    }
    const phase = deck?.bpm ? deck.beatPhase() : (now / 500) % 1;
    const beat = deck?.playing ? Math.exp(-phase * 5) : 0;
    const accent = this.accent;
    // background: dark radial wash in the accent colour
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    g.fillStyle = '#05070a'; g.fillRect(0, 0, W, H);
    const rg = g.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, W * 0.7);
    rg.addColorStop(0, withAlpha(accent, 0.18 + 0.3 * this.energy)); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
    // blurred cover backdrop
    if (this.cover) {
      g.globalAlpha = 0.22 + 0.15 * beat;
      const s = Math.max(W / this.cover.naturalWidth, H / this.cover.naturalHeight) * (1.1 + 0.04 * beat);
      const cw = this.cover.naturalWidth * s, chh = this.cover.naturalHeight * s;
      g.drawImage(this.cover, (W - cw) / 2, (H - chh) / 2, cw, chh);
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, W, H);
    }
    if (this.style !== 'ring') {
      this.drawStyle(now, beat, accent);
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
      return;
    }
    // spectrum ring
    const cx = W / 2, cy = H / 2, r0 = 86 + 10 * beat;
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = accent; g.lineCap = 'round'; g.lineWidth = 5;
    g.beginPath();
    for (let k = 0; k < n * 2; k++) {
      const v = this.smooth[k < n ? k : 2 * n - 1 - k];
      const ang = (k / (n * 2)) * Math.PI * 2 - Math.PI / 2 + now / 8000;
      const r1 = r0 + 4 + v * 70;
      g.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      g.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    }
    g.globalAlpha = 0.9; g.stroke();
    // beat ring
    g.globalAlpha = 0.6 * beat; g.lineWidth = 3;
    g.beginPath(); g.arc(cx, cy, r0 + 90 * (1 - beat) + 20, 0, Math.PI * 2); g.stroke();
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    // cover disc in the middle
    g.save(); g.beginPath(); g.arc(cx, cy, r0 - 6, 0, Math.PI * 2); g.clip();
    if (this.cover) {
      const d = (r0 - 6) * 2, s = Math.max(d / this.cover.naturalWidth, d / this.cover.naturalHeight);
      g.drawImage(this.cover, cx - this.cover.naturalWidth * s / 2, cy - this.cover.naturalHeight * s / 2, this.cover.naturalWidth * s, this.cover.naturalHeight * s);
    } else {
      g.fillStyle = '#10141a'; g.fillRect(cx - r0, cy - r0, r0 * 2, r0 * 2);
      g.fillStyle = accent; g.font = '800 54px Inter, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(this.index + 1), cx, cy + 2);
    }
    g.restore();
  }

  /** Bounded Canvas2D scenes at 640×360; no particles or audio nodes allocated per frame. */
  drawStyle(now, beat, accent) {
    const g = this.g, bands = this.smooth, n = bands.length, cx = W / 2, cy = H / 2;
    const t = now / 1000;
    g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
    if (this.style === 'bars') {
      const step = (W - 64) / n;
      for (let k = 0; k < n; k++) {
        const h = 6 + bands[k] * 230, x = 32 + k * step;
        g.fillStyle = withAlpha(accent, 0.45 + bands[k] * 0.55);
        g.fillRect(x, H - 48 - h, step - 3, h);
        g.fillStyle = 'rgba(225,245,255,.85)'; g.fillRect(x, H - 52 - h, step - 3, 2);
        g.fillStyle = withAlpha(accent, 0.12); g.fillRect(x, H - 42, step - 3, h * 0.12);
      }
    } else if (this.style === 'scope') {
      this.analyser.getByteTimeDomainData(this.wave);
      g.strokeStyle = withAlpha(accent, 0.15); g.lineWidth = 1;
      g.beginPath();
      for (let y = 60; y < H; y += 60) { g.moveTo(24, y); g.lineTo(W - 24, y); }
      for (let x = 32; x < W; x += 48) { g.moveTo(x, 30); g.lineTo(x, H - 30); }
      g.stroke();
      for (const [width, alpha] of [[10, 0.14], [3, 1]]) {
        g.strokeStyle = withAlpha(accent, alpha); g.lineWidth = width; g.beginPath();
        for (let k = 0; k < this.wave.length; k += 2) {
          const x = 24 + k / (this.wave.length - 2) * (W - 48), y = cy + (this.wave[k] - 128) / 128 * (110 + beat * 18);
          if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
      }
    } else if (this.style === 'orbit') {
      for (let k = 0; k < 80; k++) {
        const band = bands[k % n], angle = k * 2.399963 + t * (0.12 + (k % 4) * 0.035);
        const radius = 28 + Math.sqrt(k / 80) * 130 + band * 48 + beat * 8;
        const x = cx + Math.cos(angle) * radius * 1.55, y = cy + Math.sin(angle) * radius * 0.8;
        g.fillStyle = withAlpha(accent, 0.25 + band * 0.65); g.beginPath();
        g.arc(x, y, 1.3 + band * 3.5, 0, Math.PI * 2); g.fill();
      }
      g.strokeStyle = withAlpha(accent, 0.5 + this.energy * 0.4); g.lineWidth = 2;
      g.beginPath(); g.ellipse(cx, cy, 56 + this.energy * 30, 24 + beat * 5, -t * 0.15, 0, Math.PI * 2); g.stroke();
    } else if (this.style === 'tunnel') {
      for (let k = 0; k < 14; k++) {
        const depth = ((k / 14 + t * 0.08) % 1), radius = 12 + depth * depth * 420;
        const twist = t * 0.16 + depth * 0.9;
        g.strokeStyle = withAlpha(accent, 0.12 + depth * 0.7); g.lineWidth = 1 + depth * 2;
        g.beginPath();
        for (let j = 0; j <= 6; j++) {
          const a = j * Math.PI / 3 + twist, r = radius * (1 + bands[(k * 3) % n] * 0.16 + beat * 0.025);
          const x = cx + Math.cos(a) * r * 1.4, y = cy + Math.sin(a) * r;
          if (j === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
      }
    }
  }

  dispose() {
    window.removeEventListener('opendj-theme', this._onTheme);
    try { this.app.engine.channels[this.index].fx.output.disconnect(this.analyser); } catch { /* already gone */ }
    try { this.app.engine.channels[this.index].fx.wetOut?.disconnect(this.analyser); } catch { /* already gone */ }
    this.analyser = null;
  }
}

/** '#rrggbb' or 'rgb()' + alpha → rgba() */
export function withAlpha(c, a) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c).trim());
  if (m) {
    let h = m[1]; if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const n = parseInt(h, 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const r = /rgba?\(([^)]+)\)/.exec(c);
  if (r) { const p = r[1].split(',').slice(0, 3).join(','); return `rgba(${p},${a})`; }
  return `rgba(62,166,255,${a})`;
}
