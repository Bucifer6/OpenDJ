// Waveform renderers: scrolling detail view (with beat grid, cues, loop) and full-track overview.
import { el, clamp } from '../util.js';
import { cssVar } from './themes.js';

const PALETTES = {
  rgb: { low: [48, 128, 255], mid: [255, 170, 40], high: [240, 245, 255] },
  blue: { low: [20, 90, 220], mid: [60, 160, 255], high: [200, 235, 255] },
  mono: { low: [120, 130, 145], mid: [170, 180, 195], high: [230, 235, 240] },
};

function colorAt(w, i, pal) {
  const l = w.low[i], m = w.mid[i], h = w.high[i];
  const s = l + m + h + 1;
  const r = (pal.low[0] * l + pal.mid[0] * m + pal.high[0] * h) / s;
  const g = (pal.low[1] * l + pal.mid[1] * m + pal.high[1] * h) / s;
  const b = (pal.low[2] * l + pal.mid[2] * m + pal.high[2] * h) / s;
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

export const PHRASE_COLORS = { intro: '#3ea6ff', verse: '#8a96a8', buildup: '#ffb020', drop: '#ff3b4d', chorus: '#ff3b4d', breakdown: '#2ed47a', bridge: '#2ed47a', outro: '#c06cff' };

export class DetailWaveform {
  constructor(deck, getSettings) {
    this.deck = deck; this.getSettings = getSettings;
    this.canvas = el('canvas', { class: 'wf-detail' });
    this.g = this.canvas.getContext('2d');
    this.zoom = 8; // seconds across the view
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoom = clamp(this.zoom * (e.deltaY > 0 ? 1.15 : 0.87), 2, 60);
      else this.deck.jogNudge(-e.deltaY / 1500);
    }, { passive: false });
    // drag to scratch / seek on the waveform
    let last = null;
    this.canvas.addEventListener('pointerdown', (e) => { this.canvas.setPointerCapture(e.pointerId); last = { x: e.clientX, t: performance.now() }; });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!last) return;
      const w = this.canvas.getBoundingClientRect().width;
      const secs = -(e.clientX - last.x) / w * this.zoom;
      const now = performance.now();
      if (this.deck.playing) this.deck.jogScratch(secs / 1.8, (now - last.t) / 1000); else this.deck.seek(this.deck.position + secs);
      last = { x: e.clientX, t: now };
    });
    const up = () => { if (last && this.deck.playing) this.deck.jogRelease(); last = null; };
    this.canvas.addEventListener('pointerup', up); this.canvas.addEventListener('pointercancel', up);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  draw() {
    this.resize();
    const { g, canvas, deck } = this; const W = canvas.width, H = canvas.height, mid = H / 2;
    g.fillStyle = cssVar('--wave-bg'); g.fillRect(0, 0, W, H);
    const w = deck.waveform;
    const s = this.getSettings();
    const pal = PALETTES[s.waveformColors] || PALETTES.rgb;
    const pos = deck.position;
    const span = this.zoom * (deck.rate || 1); // keep beat spacing stable when tempo changes
    const t0 = pos - span / 2, pxPerSec = W / span;
    const dpr = devicePixelRatio || 1;
    if (deck.loading) { g.fillStyle = '#6b7685'; g.font = `${12 * dpr}px Inter, system-ui`; g.fillText('Loading & analysing…', 12 * dpr, mid); }
    // loop region
    if (deck.loop) {
      const x1 = (deck.loop.start - t0) * pxPerSec, x2 = (deck.loop.end - t0) * pxPerSec;
      g.fillStyle = deck.loop.active ? 'rgba(46, 204, 113, 0.18)' : 'rgba(46, 204, 113, 0.07)'; g.fillRect(x1, 0, x2 - x1, H);
    }
    if (w) {
      const step = 1 / w.rate;
      const colW = Math.max(1, Math.ceil(dpr));
      for (let x = 0; x < W; x += colW) {
        const t = t0 + x / pxPerSec;
        const i = Math.floor(t / step);
        if (i < 0 || i >= w.peak.length) continue;
        // take max over the bin range this column covers
        const i2 = Math.min(w.peak.length - 1, Math.floor((t + colW / pxPerSec) / step));
        let p = 0, j = i, best = i; for (; j <= i2; j++) if (w.peak[j] > p) { p = w.peak[j]; best = j; }
        const hh = (p / 255) * (mid - 2);
        g.fillStyle = colorAt(w, best, pal);
        g.globalAlpha = t < pos ? 0.55 : 1;
        g.fillRect(x, mid - hh, colW, hh * 2);
        // low band core for a punchier look
        const lh = (w.low[best] / 255) * (mid - 2) * 0.55;
        g.fillStyle = `rgba(${pal.low.join(',')},0.55)`;
        g.fillRect(x, mid - lh, colW, lh * 2);
      }
      g.globalAlpha = 1;
    }
    // beat grid
    if (deck.bpm) {
      const bl = deck.beatLen;
      let k = Math.ceil((t0 - deck.gridOffset) / bl);
      for (let t = deck.gridOffset + k * bl; t < t0 + span; t += bl, k++) {
        const x = (t - t0) * pxPerSec;
        const bar = ((k % 4) + 4) % 4 === 0;
        g.fillStyle = bar ? 'rgba(255,60,60,0.85)' : 'rgba(255,255,255,0.28)';
        g.fillRect(x, 0, bar ? 2 * dpr : dpr, bar ? H : H * 0.12);
        if (!bar) g.fillRect(x, H - H * 0.12, dpr, H * 0.12);
      }
    }
    // phrase labels
    for (const p of deck.track?.phrases || []) {
      const x = (p.start - t0) * pxPerSec;
      if (x < -200 || x > W) continue;
      g.fillStyle = PHRASE_COLORS[p.type] || '#6b7685';
      g.fillRect(x, H - 3 * dpr, Math.max(0, (p.end - p.start) * pxPerSec - 2 * dpr), 3 * dpr);
      g.font = `600 ${9 * dpr}px Inter, system-ui`; g.fillText(p.type.toUpperCase(), x + 4 * dpr, H - 6 * dpr);
    }
    // cues
    const cues = deck.track?.cues || [];
    for (const c of cues) {
      const x = (c.position - t0) * pxPerSec;
      if (x < -20 || x > W + 20) continue;
      g.fillStyle = c.index >= 0 ? (c.color || '#2ecc71') : '#ff4757';
      g.fillRect(x, 0, 2 * dpr, H);
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 12 * dpr, 0); g.lineTo(x, 12 * dpr); g.fill();
      if (c.index >= 0) { g.fillStyle = '#000'; g.font = `bold ${9 * dpr}px Inter, system-ui`; g.fillText(String.fromCharCode(65 + c.index), x + 2 * dpr, 9 * dpr); }
    }
    if (deck.track) { const x = (deck.cuePoint - t0) * pxPerSec; g.fillStyle = '#ffb020'; g.beginPath(); g.moveTo(x - 6 * dpr, H); g.lineTo(x + 6 * dpr, H); g.lineTo(x, H - 9 * dpr); g.fill(); }
    // playhead
    g.fillStyle = '#ffffff'; g.fillRect(W / 2 - dpr, 0, 2 * dpr, H);
    g.fillStyle = deck.playing ? '#ff3b4d' : '#ffffff';
    g.beginPath(); g.moveTo(W / 2 - 6 * dpr, 0); g.lineTo(W / 2 + 6 * dpr, 0); g.lineTo(W / 2, 7 * dpr); g.fill();
  }
}

export class OverviewWaveform {
  constructor(deck, getSettings) {
    this.deck = deck; this.getSettings = getSettings;
    this.canvas = el('canvas', { class: 'wf-overview' });
    this.g = this.canvas.getContext('2d');
    this.cache = null; this.cacheKey = '';
    const seek = (e) => {
      if (!deck.duration) return;
      const r = this.canvas.getBoundingClientRect();
      const t = clamp((e.clientX - r.left) / r.width, 0, 1) * deck.duration;
      deck.seek(t);
    };
    let down = false;
    this.canvas.addEventListener('pointerdown', (e) => { down = true; this.canvas.setPointerCapture(e.pointerId); seek(e); });
    this.canvas.addEventListener('pointermove', (e) => { if (down) seek(e); });
    this.canvas.addEventListener('pointerup', () => { down = false; });
  }
  renderCache(W, H) {
    const w = this.deck.waveform; const s = this.getSettings();
    const pal = PALETTES[s.waveformColors] || PALETTES.rgb;
    const off = document.createElement('canvas'); off.width = W; off.height = H;
    const g = off.getContext('2d');
    const n = w.peak.length, mid = H / 2;
    for (let x = 0; x < W; x++) {
      const a = Math.floor(x / W * n), b = Math.max(a + 1, Math.floor((x + 1) / W * n));
      let p = 0, best = a; for (let i = a; i < b && i < n; i++) if (w.peak[i] > p) { p = w.peak[i]; best = i; }
      const hh = p / 255 * (mid - 1);
      g.fillStyle = colorAt(w, best, pal); g.fillRect(x, mid - hh, 1, hh * 2);
    }
    return off;
  }
  draw() {
    const r = this.canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; this.cacheKey = ''; }
    const { g, deck } = this;
    g.fillStyle = cssVar('--wave-bg'); g.fillRect(0, 0, W, H);
    if (!deck.waveform || !deck.duration) return;
    const key = `${deck.track?.id}:${W}:${H}:${this.getSettings().waveformColors}`;
    if (key !== this.cacheKey) { this.cache = this.renderCache(W, H); this.cacheKey = key; }
    g.drawImage(this.cache, 0, 0);
    const k = deck.position / deck.duration;
    g.fillStyle = 'rgba(7,9,12,0.55)'; g.fillRect(0, 0, k * W, H); // played portion dimmed
    if (deck.loop) { g.fillStyle = 'rgba(46,204,113,0.3)'; g.fillRect(deck.loop.start / deck.duration * W, 0, Math.max(2, (deck.loop.end - deck.loop.start) / deck.duration * W), H); }
    // phrase / structure bands along the top (intro, drop, breakdown, outro…)
    for (const p of deck.track?.phrases || []) {
      g.fillStyle = PHRASE_COLORS[p.type] || '#6b7685';
      g.fillRect(p.start / deck.duration * W + dpr, 0, Math.max(1, (p.end - p.start) / deck.duration * W - 2 * dpr), 3 * dpr);
    }
    for (const c of deck.track?.cues || []) {
      g.fillStyle = c.index >= 0 ? (c.color || '#2ecc71') : '#ff4757';
      g.fillRect(c.position / deck.duration * W, 0, Math.max(1, dpr * 1.5), H);
      if (c.loopEnd) { g.fillStyle = 'rgba(46,212,122,0.25)'; g.fillRect(c.position / deck.duration * W, H - 4 * dpr, Math.max(2, (c.loopEnd - c.position) / deck.duration * W), 4 * dpr); }
    }
    // bar ticks every 16 bars
    if (deck.bpm) {
      g.fillStyle = 'rgba(255,255,255,0.12)';
      const p = deck.beatLen * 64;
      for (let t = deck.gridOffset; t < deck.duration; t += p) g.fillRect(t / deck.duration * W, H - 3 * dpr, dpr, 3 * dpr);
    }
    g.fillStyle = '#fff'; g.fillRect(k * W - dpr, 0, 2 * dpr, H);
  }
}
