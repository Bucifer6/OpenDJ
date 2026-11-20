// Waveform renderers: scrolling detail view (with beat grid, cues, loop) and full-track overview.
//
// Performance: the detail view never redraws the waveform itself per frame. The track is rendered once, lazily, into
// fixed-width tiles (offscreen canvases at device resolution); each frame just blits the visible tiles at the
// interpolated play position and draws the thin overlays (grid, cues, playhead) on top. A frame where nothing moved
// is skipped entirely. Tempo changes scale the blit instead of re-rendering, so beat spacing stays stable.
import { el, clamp } from '../util.js';
import { cssVar } from './themes.js';
import { smoothTime } from './clock.js';

// 3-band colours: low (kick/bass), mid (vocals, synths), high (hats, cymbals). 'rgb' follows the theme tokens.
const PALETTES = {
  blue: { low: [24, 92, 214], mid: [70, 160, 255], high: [205, 236, 255] },
  mono: { low: [96, 106, 122], mid: [160, 170, 186], high: [232, 236, 242] },
};
const hex = (s, d) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(s).trim()); if (!m) return d; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
function palette(name) {
  if (PALETTES[name]) return PALETTES[name];
  return { low: hex(cssVar('--wf-low'), [32, 120, 255]), mid: hex(cssVar('--wf-mid'), [255, 158, 40]), high: hex(cssVar('--wf-high'), [246, 248, 255]) };
}
const rgba = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export const PHRASE_COLORS = { intro: '#3ea6ff', verse: '#8a96a8', buildup: '#ffb020', drop: '#ff3b4d', chorus: '#ff3b4d', breakdown: '#2ed47a', bridge: '#2ed47a', outro: '#c06cff' };

let themeRev = 0;
window.addEventListener('opendj-theme', () => { themeRev++; });

/** Max of a band over bins [a, b). */
function binMax(arr, a, b) { let m = 0; for (let i = a; i < b; i++) if (arr[i] > m) m = arr[i]; return m; }

/**
 * Paint columns [x0, x1) of a 3-band waveform into g (device pixels). `binAt(x)` maps a column to its first bin.
 * Layers (back to front): soft full-band envelope, low, mid, high — each centred, like a 3-band club display.
 */
function paintBands(g, w, pal, x0, x1, H, binAt, opts = {}) {
  const mid = H / 2, amp = mid - (opts.pad ?? 1);
  const n = w.peak.length;
  const cols = x1 - x0;
  const P = new Float32Array(cols), L = new Float32Array(cols), M = new Float32Array(cols), Hh = new Float32Array(cols);
  for (let x = x0; x < x1; x++) {
    const a = binAt(x);
    if (a < 0 || a >= n) continue;
    const b = Math.min(Math.max(binAt(x + 1), a + 1), n);
    const k = x - x0, p = binMax(w.peak, a, b) / 255;
    P[k] = p; L[k] = p * binMax(w.low, a, b) / 255; M[k] = p * binMax(w.mid, a, b) / 255; Hh[k] = p * binMax(w.high, a, b) / 255;
  }
  const layer = (arr, scale, style) => {
    g.fillStyle = style; g.beginPath();
    for (let k = 0; k < cols; k++) {
      const h = arr[k] * scale * amp;
      if (h >= 0.5) g.rect(x0 + k, mid - h, 1, h * 2);
    }
    g.fill();
  };
  layer(P, 1, rgba(pal.low, 0.35));
  layer(L, 1, rgba(pal.low));
  layer(M, 0.78, rgba(pal.mid));
  layer(Hh, 0.5, rgba(pal.high));
}

const newCanvas = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
const TILE = 256; // css px per tile (times devicePixelRatio)
const MAX_TILES = 48;

export class DetailWaveform {
  constructor(deck, getSettings) {
    this.deck = deck; this.getSettings = getSettings;
    this.canvas = el('canvas', { class: 'wf-detail' });
    this.g = this.canvas.getContext('2d', { alpha: false });
    this.zoom = 8; // seconds across the view at normal speed
    this.tiles = new Map(); this.tileKey = ''; this.sig = ''; this.cw = 0; this.ch = 0;
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) this.zoom = clamp(this.zoom * (e.deltaY > 0 ? 1.15 : 0.87), 2, 60);
      else this.deck.jogNudge(-e.deltaY / 1500);
    }, { passive: false });
    // drag to scratch / seek on the waveform
    let last = null;
    this.canvas.addEventListener('pointerdown', (e) => { this.canvas.setPointerCapture(e.pointerId); last = { x: e.clientX, t: performance.now(), scratch: this.deck.playing }; });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!last) return;
      const w = this.canvas.getBoundingClientRect().width;
      const secs = -(e.clientX - last.x) / w * this.zoom;
      const now = performance.now();
      if (last.scratch) this.deck.jogScratch(secs / 1.8, (now - last.t) / 1000); else this.deck.seek(this.deck.position + secs);
      last = { ...last, x: e.clientX, t: now };
    });
    // release based on how the drag started, not on whether the deck is still playing (it may have stopped mid-drag)
    const up = () => { if (last?.scratch) this.deck.jogRelease(); last = null; };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) this.canvas.addEventListener(ev, up);
    // size from a ResizeObserver instead of reading layout every frame (contentRect is in layout px: zoom-safe)
    this.ro = new ResizeObserver(() => { this.cw = 0; });
    this.ro.observe(this.canvas);
  }

  resize() {
    const dpr = (devicePixelRatio || 1);
    if (!this.cw) { const r = this.canvas.getBoundingClientRect(); this.cw = r.width || 1; this.ch = r.height || 1; }
    const w = Math.max(1, Math.round(this.cw * dpr)), h = Math.max(1, Math.round(this.ch * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this.sig = ''; }
  }

  /** Offscreen tile `i` of the waveform at `pps` device px per second (rate 1). */
  tile(i, pps, H, w, pal) {
    let t = this.tiles.get(i);
    if (t) { this.tiles.delete(i); this.tiles.set(i, t); return t; } // LRU order
    const TW = Math.round(TILE * (devicePixelRatio || 1));
    t = newCanvas(TW, H);
    const x0 = i * TW, binsPerPx = w.rate / pps;
    paintBands(t.getContext('2d'), w, pal, 0, TW, H, (x) => Math.floor((x0 + x) * binsPerPx), { pad: 2 * (devicePixelRatio || 1) });
    this.tiles.set(i, t);
    while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value);
    return t;
  }

  draw(now = performance.now()) {
    this.resize();
    const { g, canvas, deck } = this; const W = canvas.width, H = canvas.height, mid = H / 2;
    const s = this.getSettings();
    const w = deck.waveform;
    const pos = deck.positionAt(smoothTime(deck.ctx, now));
    const rate = deck.rate || 1;
    const cues = deck.track?.cues || [];
    const loop = deck.loop;
    // nothing moved and nothing changed: keep the last frame
    const sig = `${pos.toFixed(5)}|${rate}|${W}x${H}|${this.zoom}|${themeRev}|${s.waveformColors}|${deck.track?.id}|${!!w}|${deck.loading}|${deck.playing}|${loop ? `${loop.start},${loop.end},${loop.active}` : ''}|${cues.length}:${cues.reduce((a, c) => a + c.position + (c.index + 1) * 7, 0)}|${deck.cuePoint}|${deck.bpm}|${deck.gridOffset}|${(deck.track?.phrases || []).length}`;
    if (sig === this.sig) return;
    this.sig = sig;

    const dpr = devicePixelRatio || 1;
    const bg = cssVar('--wave-bg'), font = cssVar('--font');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const base = W / this.zoom;               // device px per second at rate 1 (tile resolution)
    const pxPerSec = base / rate;              // displayed: keep beat spacing stable when tempo changes
    const t0 = pos - (W / 2) / pxPerSec;
    const X = (t) => (t - t0) * pxPerSec;
    g.fillStyle = cssVar('--wf-axis'); g.fillRect(0, Math.round(mid), W, Math.max(1, Math.round(dpr / 2)));
    if (deck.loading && !w) { g.fillStyle = cssVar('--text-3'); g.font = `500 ${11 * dpr}px ${font}`; g.textBaseline = 'middle'; g.fillText('Loading & analysing…', 12 * dpr, mid); }
    // loop region (under the waveform)
    if (loop) {
      const x1 = X(loop.start), x2 = X(loop.end);
      g.fillStyle = loop.active ? 'rgba(46, 212, 122, 0.20)' : 'rgba(46, 212, 122, 0.08)'; g.fillRect(x1, 0, x2 - x1, H);
    }
    if (w) {
      const key = `${deck.track?.id}|${H}|${base.toFixed(3)}|${s.waveformColors}|${themeRev}|${w.peak.length}`;
      if (key !== this.tileKey) { this.tiles.clear(); this.tileKey = key; }
      const pal = palette(s.waveformColors);
      const TW = Math.round(TILE * dpr), tileSecs = TW / base, scale = 1 / rate, dur = w.peak.length / w.rate;
      const first = Math.max(0, Math.floor(t0 / tileSecs)), last = Math.min(Math.floor(dur / tileSecs), Math.floor((t0 + W / pxPerSec) / tileSecs));
      const exact = Math.abs(scale - 1) < 1e-6;
      for (let i = first; i <= last; i++) {
        const x = X(i * tileSecs);
        if (exact) g.drawImage(this.tile(i, base, H, w, pal), Math.round(x), 0); // 1:1 blit, crisp
        else g.drawImage(this.tile(i, base, H, w, pal), x, 0, TW * scale + 0.5, H);
      }
      // warm the next tile ahead of the playhead so it is ready before it scrolls in
      const ahead = last + 1; if (!this.tiles.has(ahead) && ahead * tileSecs < dur) this.tile(ahead, base, H, w, pal);
      // played part: dimmed
      g.globalAlpha = 0.45; g.fillStyle = bg; g.fillRect(0, 0, Math.round(W / 2), H); g.globalAlpha = 1;
    }
    // beat grid: thin beat ticks top and bottom, full-height bar lines
    if (deck.bpm > 0 && deck.track) {
      const bl = deck.beatLen, span = W / pxPerSec;
      let k = Math.ceil((t0 - deck.gridOffset) / bl);
      const beatC = cssVar('--wf-beat'), barC = cssVar('--wf-bar');
      const tick = Math.round(H * 0.14), lw = Math.max(1, Math.round(dpr));
      for (let t = deck.gridOffset + k * bl, n = 0; t < t0 + span && n < 2000; t += bl, k++, n++) {
        const x = Math.round(X(t));
        if (((k % 4) + 4) % 4 === 0) { g.fillStyle = barC; g.fillRect(x, 0, lw, H); }
        else { g.fillStyle = beatC; g.fillRect(x, 0, lw, tick); g.fillRect(x, H - tick, lw, tick); }
      }
    }
    // phrase bands + labels along the bottom
    g.textBaseline = 'alphabetic';
    g.font = `700 ${8.5 * dpr}px ${font}`;
    for (const p of deck.track?.phrases || []) {
      const x = X(p.start);
      if (x > W || X(p.end) < 0) continue;
      g.fillStyle = PHRASE_COLORS[p.type] || '#6b7685';
      g.fillRect(Math.round(x), H - 3 * dpr, Math.max(0, Math.round((p.end - p.start) * pxPerSec - 2 * dpr)), 3 * dpr);
      g.fillText(p.type.toUpperCase(), Math.round(Math.max(x, 0)) + 4 * dpr, H - 6 * dpr);
    }
    // hot cues / memory cues: flag at the top with the pad letter
    for (const c of cues) {
      const x = Math.round(X(c.position));
      if (x < -20 || x > W + 20) continue;
      g.fillStyle = c.index >= 0 ? (c.color || '#2ecc71') : '#ff4757';
      g.fillRect(x, 0, Math.max(1, Math.round(dpr)), H);
      if (c.index >= 0) {
        const fw = 12 * dpr, fh = 11 * dpr;
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x + fw, 0); g.lineTo(x + fw, fh - 3 * dpr); g.lineTo(x + fw - 3 * dpr, fh); g.lineTo(x, fh); g.fill();
        g.fillStyle = '#0b0d10'; g.font = `800 ${8.5 * dpr}px ${font}`; g.textBaseline = 'middle';
        g.fillText(String.fromCharCode(65 + c.index), x + 3 * dpr, fh / 2 + 0.5 * dpr);
        g.textBaseline = 'alphabetic';
      } else { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 7 * dpr, 0); g.lineTo(x, 7 * dpr); g.fill(); }
    }
    // main cue point: amber marker at the bottom
    if (deck.track) { const x = Math.round(X(deck.cuePoint)); g.fillStyle = cssVar('--amber'); g.beginPath(); g.moveTo(x - 5 * dpr, H); g.lineTo(x + 5 * dpr, H); g.lineTo(x, H - 7 * dpr); g.fill(); }
    // playhead
    const cx = Math.round(W / 2);
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(cx - 2 * dpr, 0, 4 * dpr, H);
    g.fillStyle = cssVar('--playhead'); g.fillRect(cx - Math.round(dpr / 2), 0, Math.max(1, Math.round(dpr * 1.5)), H);
    g.beginPath(); g.moveTo(cx - 5 * dpr, 0); g.lineTo(cx + 5 * dpr, 0); g.lineTo(cx, 6 * dpr); g.fill();
    g.beginPath(); g.moveTo(cx - 5 * dpr, H); g.lineTo(cx + 5 * dpr, H); g.lineTo(cx, H - 6 * dpr); g.fill();
  }
}

export class OverviewWaveform {
  constructor(deck, getSettings) {
    this.deck = deck; this.getSettings = getSettings;
    this.canvas = el('canvas', { class: 'wf-overview' });
    this.g = this.canvas.getContext('2d', { alpha: false });
    this.cache = null; this.cacheKey = ''; this.sig = ''; this.cw = 0; this.ch = 0;
    const seek = (e) => {
      if (!deck.duration) return;
      const r = this.canvas.getBoundingClientRect();
      const t = clamp((e.clientX - r.left) / r.width, 0, 1) * deck.duration;
      deck.seek(t);
    };
    let down = false;
    this.canvas.addEventListener('pointerdown', (e) => { down = true; this.canvas.setPointerCapture(e.pointerId); seek(e); });
    this.canvas.addEventListener('pointermove', (e) => { if (down) seek(e); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) this.canvas.addEventListener(ev, () => { down = false; });
    this.ro = new ResizeObserver(() => { this.cw = 0; });
    this.ro.observe(this.canvas);
  }
  renderCache(W, H, played) {
    const w = this.deck.waveform; const s = this.getSettings();
    const off = newCanvas(W, H);
    const g = off.getContext('2d');
    g.fillStyle = cssVar('--wave-bg'); g.fillRect(0, 0, W, H);
    const n = w.peak.length;
    paintBands(g, w, palette(s.waveformColors), 0, W, H, (x) => Math.floor(x / W * n), { pad: 1 });
    if (played) { g.globalAlpha = 0.6; g.fillStyle = cssVar('--wave-bg'); g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
    return off;
  }
  draw(now = performance.now()) {
    const dpr = devicePixelRatio || 1;
    if (!this.cw) { const r = this.canvas.getBoundingClientRect(); this.cw = r.width || 1; this.ch = r.height || 1; }
    const W = Math.max(1, Math.round(this.cw * dpr)), H = Math.max(1, Math.round(this.ch * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; this.cacheKey = ''; this.sig = ''; }
    const { g, deck } = this;
    const k = deck.duration ? deck.positionAt(smoothTime(deck.ctx, now)) / deck.duration : 0;
    const px = Math.round(k * W);
    const cues = deck.track?.cues || [];
    const loop = deck.loop;
    const warn = deck.duration > 0 && deck.playing && deck.duration * (1 - k) < 30;
    const sig = `${px}|${W}x${H}|${themeRev}|${this.getSettings().waveformColors}|${deck.track?.id}|${!!deck.waveform}|${loop ? `${loop.start},${loop.end},${loop.active}` : ''}|${cues.length}:${cues.reduce((a, c) => a + c.position, 0)}|${(deck.track?.phrases || []).length}|${deck.bpm}|${warn}`;
    if (sig === this.sig) return;
    this.sig = sig;
    g.fillStyle = cssVar('--wave-bg'); g.fillRect(0, 0, W, H);
    if (!deck.waveform || !deck.duration) return;
    const key = `${deck.track?.id}:${W}:${H}:${this.getSettings().waveformColors}:${themeRev}`;
    if (key !== this.cacheKey) { this.cache = this.renderCache(W, H, false); this.cachePlayed = this.renderCache(W, H, true); this.cacheKey = key; }
    // played part from the dimmed copy, the rest at full colour
    if (px > 0) g.drawImage(this.cachePlayed, 0, 0, px, H, 0, 0, px, H);
    if (px < W) g.drawImage(this.cache, px, 0, W - px, H, px, 0, W - px, H);
    if (loop) { g.fillStyle = 'rgba(46,212,122,0.30)'; g.fillRect(loop.start / deck.duration * W, 0, Math.max(2, (loop.end - loop.start) / deck.duration * W), H); }
    // phrase / structure bands along the top (intro, drop, breakdown, outro…)
    for (const p of deck.track?.phrases || []) {
      g.fillStyle = PHRASE_COLORS[p.type] || '#6b7685';
      g.fillRect(Math.round(p.start / deck.duration * W + dpr), 0, Math.max(1, Math.round((p.end - p.start) / deck.duration * W - 2 * dpr)), 3 * dpr);
    }
    // bar ticks every 16 bars
    if (deck.bpm > 0) {
      g.fillStyle = cssVar('--wf-beat');
      const p = deck.beatLen * 64;
      for (let t = deck.gridOffset; t < deck.duration; t += p) g.fillRect(Math.round(t / deck.duration * W), H - 3 * dpr, Math.max(1, Math.round(dpr)), 3 * dpr);
    }
    for (const c of cues) {
      const x = Math.round(c.position / deck.duration * W);
      g.fillStyle = c.index >= 0 ? (c.color || '#2ecc71') : '#ff4757';
      g.fillRect(x, 0, Math.max(1, Math.round(dpr * 1.5)), H);
      if (c.index >= 0) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 5 * dpr, 0); g.lineTo(x, 5 * dpr); g.fill(); }
      if (c.loopEnd) { g.fillStyle = 'rgba(46,212,122,0.25)'; g.fillRect(x, H - 4 * dpr, Math.max(2, (c.loopEnd - c.position) / deck.duration * W), 4 * dpr); }
    }
    // playhead
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(px - 2 * dpr, 0, 4 * dpr, H);
    g.fillStyle = warn ? cssVar('--red') : cssVar('--playhead'); g.fillRect(px - Math.round(dpr / 2), 0, Math.max(1, Math.round(1.5 * dpr)), H);
  }
}
