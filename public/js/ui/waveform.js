// Waveform renderers: scrolling detail view (with beat grid, cues, loop) and full-track overview.
//
// Performance: the detail view never redraws the waveform itself per frame. The track is rendered once, lazily, into
// fixed-width tiles (offscreen canvases at device resolution); each frame just blits the visible tiles at the
// interpolated play position and draws the thin overlays (grid, cues, playhead) on top. A frame where nothing moved
// is skipped entirely. Tempo changes scale the blit instead of re-rendering, so beat spacing stays stable.
import { el, clamp, uiZoom } from '../util.js';
import { cssVar } from './themes.js';
import { smoothTime } from './clock.js';
import { NEEDLE_HOLD_MS } from '../audio/vinyl.js';
import { decodeVocalMap } from '../shared/vocal-map.js';

// 3-band colours: low (kick/bass), mid (vocals, synths), high (hats, cymbals). 'rgb' follows the theme tokens; 'soft'
// is the default.
// `body` is how strongly the soft full-band envelope behind the bands shows (default 0.35); the softer palettes keep
// their colours below full saturation and let the bands blend instead of stacking into solid blocks of colour.
const PALETTES = {
  blue: { low: [24, 92, 214], mid: [70, 160, 255], high: [205, 236, 255] },
  mono: { low: [96, 106, 122], mid: [160, 170, 186], high: [232, 236, 242] },
  // "Player Blue" (a blue body with white / cyan peaks) and "Player RGB" (3-band: low dark blue, mid amber, high white)
  'player-blue': { low: [18, 84, 230], mid: [60, 150, 255], high: [236, 250, 255], solo: true },
  'player-rgb': { low: [16, 70, 220], mid: [255, 168, 38], high: [252, 252, 255] },
  // softer presets
  soft: { low: [78, 128, 212], mid: [226, 160, 92], high: [206, 222, 240], alpha: 0.85, body: 0.3 },
  pastel: { low: [150, 132, 230], mid: [118, 208, 168], high: [250, 206, 184], alpha: 0.85, body: 0.3 },
  amber: { low: [138, 82, 34], mid: [212, 146, 72], high: [250, 222, 170], alpha: 0.9, body: 0.3 },
  ocean: { low: [26, 92, 118], mid: [70, 166, 176], high: [204, 236, 236], alpha: 0.88, body: 0.3 },
  sunset: { low: [150, 62, 92], mid: [222, 128, 96], high: [250, 214, 170], alpha: 0.85, body: 0.3 },
};
/** Waveform colour schemes offered in Settings → Appearance (the first is the default). */
export const WAVEFORM_STYLES = [['soft', 'Soft RGB'], ['rgb', '3-band RGB (theme)'], ['pastel', 'Pastel'], ['amber', 'Amber'], ['ocean', 'Ocean'], ['sunset', 'Sunset'], ['blue', 'Blue'], ['mono', 'Monochrome'], ['player-blue', 'Player Blue'], ['player-rgb', 'Player RGB']];
/** Waveform shapes: mirrored bars (default), one-sided bars from the bottom, a smooth filled envelope, outlines. */
export const WAVEFORM_SHAPES = [['bars', 'Bars'], ['half', 'Half (from the bottom)'], ['smooth', 'Smooth'], ['outline', 'Outline']];
const proStyle = (name) => name === 'player-blue' || name === 'player-rgb';
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
function binBlend(arr, a, b) { let m = 0, s = 0; for (let i = a; i < b; i++) { const v = arr[i]; s += v; if (v > m) m = v; } return 0.35 * m + 0.65 * s / (b - a); }

/**
 * Paint columns [x0, x1) of a 3-band waveform into g (device pixels). `binAt(x)` maps a column to its first bin.
 * Layers (back to front): soft full-band envelope, low, mid, high — each centred, like a 3-band club display.
 */
function paintBands(g, w, pal, x0, x1, H, binAt, opts = {}) {
  const shape = opts.shape || 'bars', pad = opts.pad ?? 1;
  const half = shape === 'half', smooth = shape === 'smooth' || shape === 'outline';
  // half: bars grow up from the bottom edge, over the full height; otherwise mirrored around the centre line
  const base = half ? H - pad : H / 2, amp = half ? H - 2 * pad : H / 2 - pad;
  const n = w.peak.length;
  // one extra column on each side, so the smooth shapes join up across tile edges
  const cols = x1 - x0 + 2;
  const P = new Float32Array(cols), L = new Float32Array(cols), M = new Float32Array(cols), Hh = new Float32Array(cols);
  for (let x = x0 - 1; x <= x1; x++) {
    const a = binAt(x);
    if (a < 0 || a >= n) continue;
    const b = Math.min(Math.max(binAt(x + 1), a + 1), n);
    const k = x - x0 + 1, p = binMax(w.peak, a, b) / 255;
    // bands: max when a column covers a couple of bins, else a max/mean blend so a zoomed-out view (overview) keeps
    // its 3-band character instead of saturating to the top layer
    const band = b - a <= 2 ? binMax : binBlend;
    P[k] = p; L[k] = p * band(w.low, a, b) / 255; M[k] = p * band(w.mid, a, b) / 255; Hh[k] = p * band(w.high, a, b) / 255;
  }
  const A = pal.alpha ?? 1, lw = opts.lw || 1;
  const layer = (arr, scale, c, alpha, edge = false) => {
    const style = rgba(c, alpha * A);
    if (!smooth) {
      g.fillStyle = style; g.beginPath();
      for (let k = 1; k < cols - 1; k++) {
        const h = arr[k] * scale * amp;
        if (h >= 0.5) { if (half) g.rect(x0 + k - 1, base - h, 1, h); else g.rect(x0 + k - 1, base - h, 1, h * 2); }
      }
      g.fill();
      return;
    }
    // smooth / outline: one filled envelope per layer, lightly smoothed over neighbouring columns
    const hs = (k) => (arr[k - 1] + 2 * arr[k] + arr[k + 1]) / 4 * scale * amp;
    if (shape === 'outline' && !edge) { g.fillStyle = rgba(c, alpha * A * 0.55); } // inner bands: soft fills
    g.beginPath(); g.moveTo(x0, base);
    for (let k = 1; k < cols - 1; k++) g.lineTo(x0 + k - 0.5, base - hs(k));
    g.lineTo(x1, base);
    for (let k = cols - 2; k >= 1; k--) g.lineTo(x0 + k - 0.5, base + hs(k));
    g.closePath();
    if (shape === 'outline' && edge) { // the full-band envelope: a faint fill and a crisp line
      g.fillStyle = rgba(c, 0.12 * A); g.fill();
      g.strokeStyle = rgba(c, A); g.lineWidth = lw; g.lineJoin = 'round'; g.stroke();
    } else { if (shape !== 'outline') g.fillStyle = style; g.fill(); }
  };
  if (pal.solo) { // Player Blue: a solid blue body (full band), a lighter core and white / cyan peaks from the highs
    layer(P, 1, pal.low, 1, true);
    layer(M, 0.85, pal.mid, 0.85);
    const W2 = new Float32Array(cols); for (let k = 0; k < cols; k++) W2[k] = Math.min(P[k], Hh[k] * 1.6 + 0.35 * P[k] * (P[k] > 0.8 ? 1 : 0));
    layer(W2, 0.6, pal.high, 0.9);
    return;
  }
  if (shape === 'outline') { // envelope line in the high colour, the bands as soft fills inside it
    layer(L, 1, pal.low, 1); layer(M, 0.78, pal.mid, 1); layer(Hh, 0.5, pal.high, 1); layer(P, 1, pal.high, 1, true);
    return;
  }
  layer(P, 1, pal.low, pal.body ?? 0.35);
  layer(L, 1, pal.low, 1);
  layer(M, 0.78, pal.mid, 1);
  layer(Hh, 0.5, pal.high, 1);
}

const newCanvas = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));
const TILE = 256; // css px per tile (times render DPR)
const MAX_TILES = 20; // >2.5x viewport width; cuts offscreen canvas/GPU memory by ~60% per deck
const waveDpr = () => Math.min(2, devicePixelRatio || 1); // keep dense displays crisp without multiplying raster cost
const validPhrase = (p) => typeof p?.type === 'string' && Number.isFinite(p.start) && Number.isFinite(p.end);

export class DetailWaveform {
  static all = new Set();
  constructor(deck, getSettings) {
    this.deck = deck; this.getSettings = getSettings;
    this.canvas = el('canvas', { class: 'wf-detail' });
    this.g = this.canvas.getContext('2d', { alpha: false });
    this.zoom = 8; // seconds across the view at normal speed (target; viewZoom eases towards it)
    this.viewZoom = 8; this.lastNow = 0; this.deckColor = null;
    DetailWaveform.all.add(this);
    this.tiles = new Map(); this.tileKey = ''; this.sig = ''; this.cw = 0; this.ch = 0;
    this.pendingTiles = new Set(); this.tileQueue = []; this.tileScheduled = false;
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      // zoom all decks together so synced tracks keep the same beat spacing (beat alignment at a glance)
      if (e.ctrlKey || e.metaKey) { const z = clamp(this.zoom * (e.deltaY > 0 ? 1.15 : 0.87), 2, 60); for (const w of DetailWaveform.all) w.zoom = z; }
      else this.deck.jogNudge(-e.deltaY / 1500);
    }, { passive: false });
    // drag to scratch (playing: the same position-following API as the platter, pixels -> seconds from the zoom) or
    // seek (paused)
    let last = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (last) return; // one pointer drags the waveform
      this.canvas.setPointerCapture(e.pointerId);
      const w = this.canvas.getBoundingClientRect().width || 1;
      last = { id: e.pointerId, x0: e.clientX, x: e.clientX, w, scratch: this.deck.playing && this.deck.jogPositionStart(e.timeStamp) };
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!last || e.pointerId !== last.id) return;
      if (last.scratch) {
        const spr = this.deck.secPerRev || 1.8;
        for (const ce of e.getCoalescedEvents?.() || [e]) this.deck.jogPosition((-(ce.clientX - last.x0) / last.w * this.viewZoom) / spr, ce.timeStamp);
      } else { this.deck.seek(this.deck.position - (e.clientX - last.x) / last.w * this.zoom); }
      last.x = e.clientX;
    });
    // release based on how the drag started, not on whether the deck is still playing (it may have stopped mid-drag)
    const up = (e) => { if (!last || (e.pointerId != null && e.pointerId !== last.id)) return; if (last.scratch) this.deck.jogPositionEnd(e.timeStamp); last = null; };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) this.canvas.addEventListener(ev, up);
    // size from a ResizeObserver instead of reading layout every frame (contentRect is in layout px: zoom-safe)
    // (the size comes from the observer entry: reading it back with getBoundingClientRect in the next frame forced a
    // layout per canvas after a layout switch, 10-20 forced layouts in one 50-90 ms task)
    this.ro = new ResizeObserver((es) => { const r = es.at(-1).contentRect, z = uiZoom(); this.cw = r.width * z; this.ch = r.height * z; });
    this.ro.observe(this.canvas);
  }

  wfStyle() { return this.getSettings().waveformColors || 'soft'; }
  wfShape() { return this.getSettings().waveformShape || 'bars'; }
  resize() {
    const dpr = waveDpr();
    if (!this.cw) { const r = this.canvas.getBoundingClientRect(); this.cw = r.width || 1; this.ch = r.height || 1; }
    const w = Math.max(1, Math.round(this.cw * dpr)), h = Math.max(1, Math.round(this.ch * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this.sig = ''; }
  }

  /** Offscreen tile `i`; cache misses are rasterized during browser idle time, away from the audio UI frame. */
  tile(i, pps, H, w, pal) {
    let t = this.tiles.get(i);
    if (t) { this.tiles.delete(i); this.tiles.set(i, t); return t; } // LRU order
    const pendingKey = `${this.tileKey}|${i}`;
    if (!this.pendingTiles.has(pendingKey)) {
      this.pendingTiles.add(pendingKey);
      this.tileQueue.push({ i, pps, H, w, pal, cacheKey: this.tileKey, pendingKey });
      this.scheduleTileRaster();
    }
    return null;
  }

  scheduleTileRaster() {
    if (this.tileScheduled || !this.tileQueue.length) return;
    this.tileScheduled = true;
    const run = (deadline = { timeRemaining: () => 0 }) => {
      this.tileScheduled = false;
      let made = 0;
      while (this.tileQueue.length && (made === 0 || (deadline.timeRemaining?.() ?? 0) > 3) && made < 2) {
        const job = this.tileQueue.shift();
        this.pendingTiles.delete(job.pendingKey);
        if (job.cacheKey !== this.tileKey) continue;
        const dpr = waveDpr(), TW = Math.round(TILE * dpr);
        const tile = newCanvas(TW, job.H), x0 = job.i * TW, binsPerPx = job.w.rate / job.pps;
        paintBands(tile.getContext('2d'), job.w, job.pal, 0, TW, job.H,
          (x) => Math.floor((x0 + x) * binsPerPx), { pad: 2 * dpr, shape: this.wfShape(), lw: dpr });
        if (job.cacheKey !== this.tileKey) continue;
        this.tiles.set(job.i, tile);
        while (this.tiles.size > MAX_TILES) this.tiles.delete(this.tiles.keys().next().value);
        this.sig = ''; // repaint once the missing tile is ready, even while playback is stopped
        made++;
      }
      if (this.tileQueue.length) this.scheduleTileRaster();
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 120 });
    else setTimeout(() => run(), 12);
  }
  draw(now = performance.now()) {
    this.resize();
    const { g, canvas, deck } = this; const W = canvas.width, H = canvas.height, mid = H / 2;
    const s = this.getSettings();
    const w = deck.waveform;
    const pos = deck.positionAt(smoothTime(deck.ctx, now));
    // smooth zoom: ease the displayed zoom towards the target (tiles are rendered once at the target and scaled)
    const dt = this.lastNow ? Math.min(0.1, (now - this.lastNow) / 1000) : 1; this.lastNow = now;
    if (Math.abs(this.viewZoom - this.zoom) > this.zoom * 0.002) this.viewZoom += (this.zoom - this.viewZoom) * Math.min(1, dt * 14); else this.viewZoom = this.zoom;
    const rate = deck.rate || 1;
    const cues = deck.track?.cues || [];
    const loop = deck.loop;
    // nothing moved and nothing changed: keep the last frame
    const sig = `${pos.toFixed(5)}|${rate}|${W}x${H}|${this.viewZoom}|${themeRev}|${this.wfStyle()}/${this.wfShape()}|${deck.track?.id}|${!!w}|${deck.loading}|${deck.playing}|${loop ? `${loop.start},${loop.end},${loop.active}` : ''}|${cues.length}:${cues.reduce((a, c) => a + c.position + (c.index + 1) * 7, 0)}|${deck.cuePoint}|${deck.bpm}|${deck.gridOffset}|${(deck.track?.phrases || []).length}`;
    if (sig === this.sig) return;
    this.sig = sig;

    const dpr = waveDpr();
    const bg = cssVar('--wave-bg'), font = cssVar('--font');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const base = W / this.zoom;               // device px per second at rate 1 (tile resolution)
    const pxPerSec = W / this.viewZoom / rate; // displayed: keep beat spacing stable when tempo changes
    const t0 = pos - (W / 2) / pxPerSec;
    const X = (t) => (t - t0) * pxPerSec;
    if (this.wfShape() !== 'half') { g.fillStyle = cssVar('--wf-axis'); g.fillRect(0, Math.round(mid), W, Math.max(1, Math.round(dpr / 2))); }
    if (deck.loading && !w) { g.fillStyle = cssVar('--text-3'); g.font = `500 ${11 * dpr}px ${font}`; g.textBaseline = 'middle'; g.fillText('Loading & analysing…', 12 * dpr, mid); }
    // loop region (under the waveform)
    if (loop) {
      const x1 = X(loop.start), x2 = X(loop.end);
      g.fillStyle = loop.active ? 'rgba(46, 212, 122, 0.20)' : 'rgba(46, 212, 122, 0.08)'; g.fillRect(x1, 0, x2 - x1, H);
    }
    if (!w) {
      if (this.tiles.size || this.tileKey) { this.tiles.clear(); this.pendingTiles.clear(); this.tileQueue.length = 0; this.tileKey = ''; }
    } else {
      const key = `${deck.track?.id}|${H}|${base.toFixed(3)}|${this.wfStyle()}/${this.wfShape()}|${themeRev}|${w.peak.length}`;
      if (key !== this.tileKey) { this.tiles.clear(); this.pendingTiles.clear(); this.tileQueue.length = 0; this.tileKey = key; }
      const pal = palette(this.wfStyle());
      const TW = Math.round(TILE * dpr), tileSecs = TW / base, scale = pxPerSec / base, dur = w.peak.length / w.rate;
      const first = Math.max(0, Math.floor(t0 / tileSecs)), last = Math.min(Math.floor(dur / tileSecs), Math.floor((t0 + W / pxPerSec) / tileSecs));
      const exact = Math.abs(scale - 1) < 1e-6;
      for (let i = first; i <= last; i++) {
        const x = X(i * tileSecs);
        const tile = this.tile(i, base, H, w, pal);
        if (!tile) continue; // lazy rasterization: keep the animation responsive while the cache fills
        if (exact) g.drawImage(tile, Math.round(x), 0); // 1:1 blit, crisp
        else g.drawImage(tile, x, 0, TW * scale + 0.5, H);
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
    const phrases = Array.isArray(deck.track?.phrases) ? deck.track.phrases : [];
    for (const p of phrases) {
      if (!validPhrase(p)) continue;
      const x = X(p.start);
      if (x > W || X(p.end) < 0) continue;
      g.fillStyle = PHRASE_COLORS[p.type] || '#6b7685';
      g.fillRect(Math.round(x), H - 3 * dpr, Math.max(0, Math.round((p.end - p.start) * pxPerSec - 2 * dpr)), 3 * dpr);
      g.fillText(p.type.toUpperCase(), Math.round(Math.max(x, 0)) + 4 * dpr, H - 6 * dpr);
    }
    // vocal activity strip along the top edge (from AI stem vocal map or DSP VAD)
    const vRaw = deck.track?.stems?.vocals || deck.track?.vocalMapAuto;
    if (vRaw) {
      if (this._vKey !== vRaw) { this._vKey = vRaw; this._vMap = decodeVocalMap(vRaw); }
      const vm = this._vMap;
      if (vm?.length) {
        const s0 = Math.max(0, Math.floor(t0)), s1 = Math.min(vm.length - 1, Math.ceil(t0 + W / pxPerSec));
        const vh = Math.max(2, Math.round(2.5 * dpr));
        for (let s = s0; s <= s1; s++) {
          if (vm[s] < 0.35) continue;
          const x1 = Math.round(X(s)), x2 = Math.round(X(s + 1));
          g.fillStyle = `rgba(218, 112, 214, ${Math.min(0.85, vm[s] * 0.85).toFixed(2)})`;
          g.fillRect(x1, 0, Math.max(1, x2 - x1), vh);
        }
      }
    }
    // Performance HUD: bars-to-next-phrase countdown (and ELASTIC badge for tempo-mapped tracks)
    if (deck.bpm > 0 && phrases.length) {
      const nextP = phrases.find((p) => validPhrase(p) && p.start > pos + 0.05);
      if (nextP) {
        const barsLeft = Math.max(0, Math.ceil((nextP.start - pos) / (deck.beatLen * 4)));
        if (barsLeft > 0 && barsLeft <= 64) {
          const badge = `${barsLeft} BAR${barsLeft === 1 ? '' : 'S'} → ${nextP.type.toUpperCase()}${deck.track?.tempoMap?.length >= 2 ? ' · ELASTIC' : ''}`;
          const bFont = `700 ${9 * dpr}px ${font}`;
          g.font = bFont;
          const bKey = `${badge}|${bFont}`;
          if (this._badgeKey !== bKey) { this._badgeKey = bKey; this._badgeW = g.measureText(badge).width + 10 * dpr; }
          const tw = this._badgeW, th = 14 * dpr;
          const bx = W - tw - 6 * dpr, by = 4 * dpr;
          g.fillStyle = 'rgba(11, 13, 16, 0.78)';
          g.fillRect(bx, by, tw, th);
          g.fillStyle = PHRASE_COLORS[nextP.type] || '#e8ecf2';
          g.textBaseline = 'middle';
          g.fillText(badge, bx + 5 * dpr, by + th / 2 + 0.5 * dpr);
          g.textBaseline = 'alphabetic';
        }
      }
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
    if (themeRev !== this.colorRev) { this.colorRev = themeRev; this.deckColor = getComputedStyle(canvas).getPropertyValue('--deck-color').trim() || null; }
    g.fillStyle = this.deckColor || cssVar('--playhead');
    g.beginPath(); g.moveTo(cx - 5 * dpr, 0); g.lineTo(cx + 5 * dpr, 0); g.lineTo(cx, 6 * dpr); g.fill();
    g.beginPath(); g.moveTo(cx - 5 * dpr, H); g.lineTo(cx + 5 * dpr, H); g.lineTo(cx, H - 6 * dpr); g.fill();
  }
}

export class OverviewWaveform {
  /** opts: { needleLocked() -> bool, needleHint() } (needle lock, T6) */
  constructor(deck, getSettings, opts = {}) {
    this.deck = deck; this.getSettings = getSettings; this.opts = opts;
    this.canvas = el('canvas', { class: 'wf-overview' });
    this.g = this.canvas.getContext('2d', { alpha: false });
    this.cache = null; this.cacheKey = ''; this.sig = ''; this.cw = 0; this.ch = 0;
    // needle drop (T6): click / drag = drop the needle there (deck.needleDrop: optional grid snap). With needle lock
    // (Settings → Decks; on by default on phones) a playing deck needs a 400 ms press first, so a stray tap on air
    // never jumps the track.
    let rect = null, frac = 0;
    const fracOf = (e) => clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const drop = () => { if (deck.duration) deck.needleDrop(frac); };
    let down = false, armed = false, holdT = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!deck.duration) return;
      down = true; this.canvas.setPointerCapture(e.pointerId); rect = this.canvas.getBoundingClientRect(); frac = fracOf(e);
      const locked = deck.playing && !!this.opts.needleLocked?.();
      armed = !locked;
      clearTimeout(holdT);
      if (armed) drop();
      else { this.canvas.classList.add('needle-hold'); holdT = setTimeout(() => { if (down) { armed = true; this.canvas.classList.remove('needle-hold'); drop(); } }, NEEDLE_HOLD_MS); }
    });
    this.canvas.addEventListener('pointermove', (e) => { if (!down) return; frac = fracOf(e); if (armed) drop(); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) this.canvas.addEventListener(ev, () => {
      if (down && !armed && ev === 'pointerup') this.opts.needleHint?.();
      clearTimeout(holdT); this.canvas.classList.remove('needle-hold'); down = false; armed = false; rect = null;
    });
    this.ro = new ResizeObserver((es) => { this._roSeen = true; const r = es.at(-1).contentRect, z = uiZoom(); this.cw = r.width * z; this.ch = r.height * z; });
    this.ro.observe(this.canvas);
  }
  wfStyle() { return this.getSettings().waveformColors || 'soft'; }
  wfShape() { return this.getSettings().waveformShape || 'bars'; }
  renderCache(W, H) {
    const w = this.deck.waveform;
    const off = newCanvas(W, H);
    const g = off.getContext('2d');
    g.fillStyle = cssVar('--wave-bg'); g.fillRect(0, 0, W, H);
    const n = w.peak.length;
    paintBands(g, w, palette(this.wfStyle()), 0, W, H, (x) => Math.floor(x / W * n), { pad: 1, shape: this.wfShape(), lw: waveDpr() });
    return off;
  }
  draw(now = performance.now()) {
    if (this._roSeen && (this.cw <= 0 || this.ch <= 0)) return;
    const dpr = waveDpr();
    if (!this.cw) { const r = this.canvas.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return; this.cw = r.width; this.ch = r.height; }
    const W = Math.max(1, Math.round(this.cw * dpr)), H = Math.max(1, Math.round(this.ch * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; this.cacheKey = ''; this.sig = ''; }
    const { g, deck } = this;
    const k = deck.duration ? deck.positionAt(smoothTime(deck.ctx, now)) / deck.duration : 0;
    const px = Math.round(k * W);
    const cues = deck.track?.cues || [];
    const loop = deck.loop;
    const warn = deck.duration > 0 && deck.playing && deck.duration * (1 - k) < 30;
    const sig = `${px}|${W}x${H}|${themeRev}|${this.wfStyle()}/${this.wfShape()}|${deck.track?.id}|${!!deck.waveform}|${loop ? `${loop.start},${loop.end},${loop.active}` : ''}|${cues.length}:${cues.reduce((a, c) => a + c.position, 0)}|${(deck.track?.phrases || []).length}|${deck.bpm}|${warn}`;
    if (sig === this.sig) return;
    this.sig = sig;
    g.fillStyle = cssVar('--wave-bg'); g.fillRect(0, 0, W, H);
    if (!deck.waveform || !deck.duration) {
      if (this.cache) { this.cache = null; this.cacheKey = ''; }
      return;
    }
    const key = `${deck.track?.id}:${W}:${H}:${this.wfStyle()}/${this.wfShape()}:${themeRev}`;
    if (key !== this.cacheKey) { this.cache = this.renderCache(W, H); this.cacheKey = key; }
    // Single cached offscreen canvas + 1 translucent rect for the played section (halves build CPU & VRAM)
    g.drawImage(this.cache, 0, 0);
    if (px > 0) { g.globalAlpha = 0.6; g.fillStyle = cssVar('--wave-bg'); g.fillRect(0, 0, px, H); g.globalAlpha = 1; }
    if (loop) { g.fillStyle = 'rgba(46,212,122,0.30)'; g.fillRect(loop.start / deck.duration * W, 0, Math.max(2, (loop.end - loop.start) / deck.duration * W), H); }
    // phrase / structure bands (intro, drop, breakdown, outro…): along the top, or a strip along the bottom in the
    // the Player styles
    const pro = proStyle(this.wfStyle()), ph = pro ? 4 * dpr : 3 * dpr, py = pro ? H - ph : 0;
    const phrases = Array.isArray(deck.track?.phrases) ? deck.track.phrases : [];
    for (const p of phrases) {
      if (!validPhrase(p)) continue;
      g.fillStyle = PHRASE_COLORS[p.type] || '#6b7685';
      g.fillRect(Math.round(p.start / deck.duration * W + dpr), py, Math.max(1, Math.round((p.end - p.start) / deck.duration * W - 2 * dpr)), ph);
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
    g.fillStyle = warn ? cssVar('--red') : pro ? '#ffffff' : cssVar('--playhead'); g.fillRect(px - Math.round(dpr / 2), 0, Math.max(1, Math.round(1.5 * dpr)), H);
    if (pro) { g.beginPath(); g.moveTo(px - 4 * dpr, 0); g.lineTo(px + 4 * dpr, 0); g.lineTo(px, 5 * dpr); g.fill(); } // position needle
  }
}
