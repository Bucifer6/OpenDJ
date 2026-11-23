// VideoMixer: composites the decks' video / visualizer layers into one master canvas.
// Layer opacity follows the audio mix by default (fader² × crossfader side gain), or an A/B video transition
// driven by the crossfader. Per-layer FX, text/logo overlay and a "now playing" lower third.
// The canvas feeds the preview panel and (via captureStream) the pop-out output window.
import { Emitter } from '../util.js';
import { computeLayers, dominantLayer, nowPlayingText, lowerThirdAlpha, TRANSITIONS, FX, visualStyle } from './video-core.js';
import { VideoDeckLayer } from './video-deck.js';
import { GLRenderer, CanvasRenderer } from './renderers.js';
import { withAlpha } from './visualizer.js';

const STORE = 'opendj.video';
export const RESOLUTIONS = { '540p': [960, 540], '720p': [1280, 720], '1080p': [1920, 1080] };

function loadConfig() {
  const def = {
    transition: 'crossfade', resolution: '720p', renderer: 'auto',
    fx: [{}, {}, {}, {}], modes: ['auto', 'auto', 'auto', 'auto'],
    visualStyles: ['ring', 'ring', 'ring', 'ring'],
    overlay: { text: '', textPos: 'tl', logo: '', logoPos: 'tr', lowerThird: true, hold: 8 },
  };
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || '{}');
    return { ...def, ...s, overlay: { ...def.overlay, ...(s.overlay || {}) }, fx: def.fx.map((d, i) => ({ ...(s.fx?.[i] || {}) })), modes: def.modes.map((d, i) => s.modes?.[i] || d), visualStyles: def.visualStyles.map((d, i) => visualStyle(s.visualStyles?.[i])) };
  } catch { return def; }
}

export class VideoMixer extends Emitter {
  constructor(app, opts = {}) {
    super();
    this.app = app; this.engine = app.engine;
    this.config = loadConfig();
    // hidden but on-screen host: keeps <video> elements decoding and the canvas alive for captureStream
    this.host = document.createElement('div');
    this.host.className = 'vid-host';
    this.host.setAttribute('aria-hidden', 'true');
    document.body.append(this.host);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'vid-canvas';
    this.setResolution(this.config.resolution, false);
    this.renderer = (this.config.renderer !== '2d' && !opts.force2d && GLRenderer.create(this.canvas)) || new CanvasRenderer(this.canvas);
    this.host.append(this.canvas);
    this.overlay = document.createElement('canvas');
    this.og = this.overlay.getContext('2d');
    this.overlay.width = this.canvas.width; this.overlay.height = this.canvas.height;
    this.overlayDirty = true; this.logoImg = null; this.setLogo(this.config.overlay.logo, false);
    this.layers = this.engine.decks.map((d, i) => { const l = new VideoDeckLayer(app, d, this.host); l.setVisualStyle(this.config.visualStyles[i]); l.mode = this.config.modes[i]; if (l.mode !== 'auto') l.setTrack(d.track, true); return l; });
    this.extra = null; // external CSS layer (YouTube): { active, volume, xfAssign, setWeight(w), title() }
    this.weights = []; this.outputs = new Set(); this.running = false;
    this.lt = { text: '', start: -1e9, key: null };
    this.stats = { fps: 0, frames: 0, t0: performance.now(), drawn: 0 };
    this._wasBlack = false; this._items = [];
    this._loop = (now) => { if (!this.running) return; this._raf = requestAnimationFrame(this._loop); this.frame(now); };
    for (const d of this.engine.decks) d.on('loaded', () => { this.lt.key = null; });
  }

  save() { try { localStorage.setItem(STORE, JSON.stringify(this.config)); } catch { /* quota / private mode */ } }

  get deckCount() { return this.app.deckCount || 2; }
  get rendererKind() { return this.renderer.kind; }
  supportsFx(id) { return this.renderer.supports(id); }

  setResolution(key, save = true) {
    const [w, h] = RESOLUTIONS[key] || RESOLUTIONS['720p'];
    this.config.resolution = RESOLUTIONS[key] ? key : '720p';
    this.canvas.width = w; this.canvas.height = h;
    if (this.overlay) { this.overlay.width = w; this.overlay.height = h; this.overlayDirty = true; }
    if (save) this.save();
    this.emit('config');
  }
  setTransition(t) { if (TRANSITIONS.some((x) => x.id === t)) { this.config.transition = t; this.save(); this.emit('config'); } }
  setFx(i, id, on) { this.config.fx[i][id] = !!on; this.save(); this.emit('config'); }
  setMode(i, m) { this.config.modes[i] = m; this.layers[i].setMode(m); this.save(); this.emit('config'); }
  setVisualStyle(i, id) { if (!this.layers[i]) return; this.config.visualStyles[i] = visualStyle(id); this.layers[i].setVisualStyle(id); this.save(); this.emit('config'); }
  setOverlay(patch) { Object.assign(this.config.overlay, patch); this.overlayDirty = true; this.save(); this.emit('config'); }
  setLogo(dataUrl, save = true) {
    this.config.overlay.logo = dataUrl || '';
    this.logoImg = null;
    if (dataUrl) { const img = new Image(); img.onload = () => { this.logoImg = img; this.overlayDirty = true; }; img.src = dataUrl; }
    this.overlayDirty = true;
    if (save) this.save();
  }
  /** Show the lower third now for the dominant source. */
  showNowPlaying(text) { this.lt = { text: text || this.lt.text, start: performance.now(), key: this.lt.key, manual: true }; this.overlayDirty = true; }

  // ---------------------------------------------------------------- outputs / loop
  addOutput(name) { this.outputs.add(name); this.update(); }
  removeOutput(name) { this.outputs.delete(name); this.update(); }
  update() {
    const want = this.outputs.size > 0;
    if (want && !this.running) { this.running = true; this._raf = requestAnimationFrame(this._loop); }
    else if (!want && this.running) { this.running = false; cancelAnimationFrame(this._raf); for (const l of this.layers) l.sync(false); }
    this.emit('running', this.running);
  }

  /** Stream of the master canvas (shared by all pop-out windows). */
  stream() {
    if (!this._stream || this._stream.getVideoTracks().every((t) => t.readyState === 'ended')) this._stream = this.canvas.captureStream(60);
    return this._stream;
  }

  // ---------------------------------------------------------------- per-frame
  computeWeights() {
    const E = this.engine, n = this.deckCount;
    const layers = [];
    for (let i = 0; i < n; i++) {
      const l = this.layers[i], st = E.channels[i].state;
      layers.push({ volume: st.volume, xfAssign: st.xfAssign, active: l.kind !== 'none' && !!l.deck.track });
    }
    const ex = this.extra;
    if (ex) layers.push({ volume: ex.volume, xfAssign: ex.xfAssign, active: !!ex.active });
    return computeLayers({ layers, crossfader: E.crossfader, curve: E.settings.crossfaderCurve, transition: this.config.transition });
  }

  fxFor(i, deck, now) {
    const f = this.config.fx[i] || {};
    const playing = deck.playing;
    const phase = deck.bpm ? deck.beatPhase() : (now / 500) % 1;
    const hit = playing ? Math.exp(-phase * 6) : 0;
    const R = this.renderer;
    return {
      bright: f.pulse ? 0.7 + 0.7 * hit : 1,
      strobe: f.strobe && playing && ((phase * 2) % 1) < 0.18 ? 0.85 : 0,
      invert: !!f.invert,
      mirror: !!f.mirror,
      blur: f.blur ? 6 : 0,
      rgb: f.rgb && R.supports('rgb') ? 4 + 22 * hit : 0,
      kaleido: !!f.kaleido && R.supports('kaleido'),
    };
  }

  frame(now) {
    const n = this.deckCount;
    const w = this.computeWeights();
    this.weights = w;
    // YouTube (or another CSS layer) sits over the canvas: canvas layers are scaled so the CSS "over" blend
    // gives the same result as additive mixing.
    let exW = 0;
    if (this.extra) { exW = w[n]?.alpha || 0; this.extra.setWeight(exW, w[n]); }
    const k = exW < 0.999 ? 1 / (1 - exW) : 0;
    for (let i = 0; i < this.layers.length; i++) this.layers[i].sync(i < n && !!this.layers[i].deck.track);
    const items = this._items; items.length = 0;
    for (let i = 0; i < n; i++) {
      const wt = w[i];
      if (!wt || wt.alpha <= 0.002) continue;
      const src = this.layers[i].source(now, true);
      if (!src) continue;
      items.push({ slot: i, src, alpha: Math.min(1, wt.alpha * k), scale: wt.scale, clip: wt.clip, fx: this.fxFor(i, this.layers[i].deck, now), time: now / 1000 });
    }
    this.updateLowerThird(w, now);
    const hasOverlay = this.paintOverlay(now);
    // nothing visible: draw black once and idle
    if (!items.length && !hasOverlay) {
      if (!this._wasBlack) { this.renderer.draw(items, null, false); this._wasBlack = true; }
    } else {
      this._wasBlack = false;
      this.renderer.draw(items, hasOverlay ? this.overlay : null, this._overlayChanged);
      this.stats.drawn++;
    }
    this._overlayChanged = false;
    const s = this.stats; s.frames++;
    if (now - s.t0 > 1000) { s.fps = Math.round((s.frames * 1000) / (now - s.t0)); s.frames = 0; s.t0 = now; this.emit('stats', s); }
    this.emit('frame', w);
  }

  updateLowerThird(w, now) {
    if (!this.config.overlay.lowerThird) return;
    if (this.lt.manual && performance.now() - this.lt.start < 1000 * ((this.config.overlay.hold || 8) + 1.4)) return;
    const n = this.deckCount;
    const dom = dominantLayer(w, 0.45);
    if (dom < 0) return;
    let key = null, text = '';
    if (dom < n) {
      const d = this.layers[dom].deck;
      if (!d.track || !d.playing) return;
      key = `d:${d.track.id}`; text = nowPlayingText(d.track);
    } else if (this.extra?.active) { key = `x:${this.extra.key?.() || ''}`; text = this.extra.title?.() || ''; }
    if (key && key !== this.lt.key && text) { this.lt = { text, start: now, key, manual: false }; this.overlayDirty = true; }
  }

  /** Redraw the overlay canvas when needed. Returns whether anything is on it. */
  paintOverlay(now) {
    const o = this.config.overlay;
    const ltA = o.lowerThird || this.lt.manual ? lowerThirdAlpha((now - this.lt.start) / 1000, o.hold || 8) : 0;
    const animating = ltA > 0 && ltA < 1;
    if (animating || (this._ltWas > 0) !== (ltA > 0)) this.overlayDirty = true;
    this._ltWas = ltA;
    const has = !!(o.text || this.logoImg || ltA > 0);
    if (!this.overlayDirty) return has;
    this.overlayDirty = false; this._overlayChanged = true;
    const g = this.og, W = this.overlay.width, H = this.overlay.height, s = H / 720;
    g.clearRect(0, 0, W, H);
    if (!has) return false;
    const pad = 36 * s;
    const corner = (pos, bw, bh) => ({
      x: pos[1] === 'l' ? pad : pos[1] === 'r' ? W - pad - bw : (W - bw) / 2,
      y: pos[0] === 't' ? pad : pos[0] === 'b' ? H - pad - bh - (ltA > 0 ? 120 * s : 0) : (H - bh) / 2,
    });
    if (this.logoImg) {
      const lh = 90 * s, lw = Math.min(260 * s, lh * (this.logoImg.naturalWidth / this.logoImg.naturalHeight || 1));
      const p = corner(o.logoPos || 'tr', lw, lh);
      g.globalAlpha = 0.92; g.drawImage(this.logoImg, p.x, p.y, lw, lh); g.globalAlpha = 1;
    }
    if (o.text) {
      g.font = `800 ${Math.round(44 * s)}px Inter, "Segoe UI", system-ui, sans-serif`;
      g.textBaseline = 'top';
      const tw = g.measureText(o.text).width;
      const p = corner(o.textPos || 'tl', tw, 50 * s);
      g.shadowColor = 'rgba(0,0,0,.75)'; g.shadowBlur = 14 * s;
      g.fillStyle = '#fff'; g.fillText(o.text, p.x, p.y);
      g.shadowBlur = 0;
    }
    if (ltA > 0 && this.lt.text) {
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3ea6ff';
      const ease = 1 - Math.pow(1 - ltA, 3);
      const x = pad - (1 - ease) * 60 * s, y = H - pad - 84 * s;
      g.globalAlpha = ltA;
      g.font = `700 ${Math.round(34 * s)}px Inter, "Segoe UI", system-ui, sans-serif`;
      const parts = this.lt.text.split(' – ');
      const title = parts.length > 1 ? parts.slice(1).join(' – ') : parts[0], artist = parts.length > 1 ? parts[0] : '';
      const tw = Math.min(W - 2 * pad, Math.max(g.measureText(title).width, (g.font = `500 ${Math.round(24 * s)}px Inter, system-ui, sans-serif`, g.measureText(artist).width)) + 48 * s);
      g.fillStyle = 'rgba(8,10,14,.78)'; g.fillRect(x, y, tw, 84 * s);
      g.fillStyle = accent; g.fillRect(x, y, 6 * s, 84 * s);
      g.fillStyle = withAlpha(accent, 0.9); g.font = `600 ${Math.round(13 * s)}px Inter, system-ui, sans-serif`; g.textBaseline = 'top';
      g.fillText('NOW PLAYING', x + 24 * s, y + 10 * s);
      g.fillStyle = '#fff'; g.font = `700 ${Math.round(30 * s)}px Inter, "Segoe UI", system-ui, sans-serif`;
      g.fillText(title, x + 24 * s, y + 28 * s, tw - 36 * s);
      if (artist) { g.fillStyle = 'rgba(255,255,255,.75)'; g.font = `500 ${Math.round(18 * s)}px Inter, system-ui, sans-serif`; g.fillText(artist, x + 24 * s, y + 60 * s, tw - 36 * s); }
      g.globalAlpha = 1;
    }
    return true;
  }

  dispose() {
    this.running = false; cancelAnimationFrame(this._raf);
    for (const l of this.layers) l.dispose();
    this.host.remove();
  }
}

export { TRANSITIONS, FX };
