// Platter styles for the jog wheel (T7), drawn in OpenDJ's own deck layout: Minimal (the original look, default),
// Vinyl (a spinning record with the cover art on its label, strobe dots, a tonearm that shows track progress and drops
// the needle when dragged) and Player (a jog display: artwork, position ring, slip ghost, loop arc, hot-cue ticks, BPM
// and time remaining).
// Rendering budget: every static layer (platter body, record with grooves and label art, strobe dot rows, sheen) is
// drawn once per size / theme / track into an offscreen canvas; a frame is a handful of drawImage calls (rotated by
// the canvas transform) plus a few strokes. The jog wheel skips frames whose signature did not change.
import { cssVar } from './themes.js';
import { api } from '../api.js';
import { tonearmAngle, tonearmProgress, STROBE_ROWS } from '../audio/vinyl.js';

export const PLATTER_SKINS = [['minimal', 'Minimal'], ['vinyl', 'Vinyl'], ['player', 'Player']];
export const STROBE_DOTS = 60; // dots per strobe row (drawn spacing 6°)

const offscreen = (W, H = W) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H }));
const TAU = 2 * Math.PI;

// ---------------------------------------------------------------- cover art cache (ImageBitmap, max 512 px)
const covers = new Map(); // track id -> Promise<ImageBitmap|null>
/** The track's cover as a small ImageBitmap (decoded once, kept for the last 8 tracks), or null. */
export function coverBitmap(id) {
  if (id == null || String(id).startsWith('scratch:')) return Promise.resolve(null);
  if (covers.has(id)) { const p = covers.get(id); covers.delete(id); covers.set(id, p); return p; }
  const p = (async () => {
    try {
      // an <img> (not fetch): on-device covers are blob: URLs, which the page's connect-src does not allow
      const img = new Image(); img.decoding = 'async'; img.src = api.coverUrl(id);
      await img.decode();
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return null;
      const s = Math.min(1, 512 / Math.max(w, h));
      return await createImageBitmap(img, s < 1 ? { resizeWidth: Math.max(1, Math.round(w * s)), resizeHeight: Math.max(1, Math.round(h * s)), resizeQuality: 'medium' } : {});
    } catch { return null; }
  })();
  covers.set(id, p);
  while (covers.size > 8) { const [k, old] = covers.entries().next().value; covers.delete(k); old.then((b) => b?.close?.()).catch(() => {}); }
  return p;
}

/** Draw `img` cover-fitted into a circle of radius r at (x, y). */
function circleImage(b, img, x, y, r) {
  b.save(); b.beginPath(); b.arc(x, y, r, 0, TAU); b.clip();
  const s = Math.max((2 * r) / img.width, (2 * r) / img.height);
  b.drawImage(img, x - (img.width * s) / 2, y - (img.height * s) / 2, img.width * s, img.height * s);
  b.restore();
}

// ---------------------------------------------------------------- Minimal (the original platter)
class MinimalSkin {
  id = 'minimal';
  sig(st) { return `${st.ang.toFixed(3)}|${Math.round(st.k * 720)}|${st.blink}|${st.warn}|${st.bpm}|${st.playing}|${st.touched}|${st.hasTrack}`; }
  body(W) {
    const off = offscreen(W);
    const b = off.getContext('2d'), c = W / 2, R = c - W * 0.012;
    const rim = b.createLinearGradient(0, 0, 0, W);
    rim.addColorStop(0, cssVar('--platter-rim-1')); rim.addColorStop(1, cssVar('--platter-rim-2'));
    b.fillStyle = rim; b.beginPath(); b.arc(c, c, R, 0, TAU); b.fill();
    b.fillStyle = cssVar('--platter-3'); b.beginPath(); b.arc(c, c, R * 0.93, 0, TAU); b.fill();
    const pr = R * 0.86;
    const grad = b.createRadialGradient(c, c, pr * 0.2, c, c, pr);
    grad.addColorStop(0, cssVar('--platter-1')); grad.addColorStop(0.92, cssVar('--platter-2')); grad.addColorStop(1, cssVar('--platter-4'));
    b.fillStyle = grad; b.beginPath(); b.arc(c, c, pr, 0, TAU); b.fill();
    b.lineWidth = Math.max(1, W / 360);
    for (let r = pr * 0.4, k = 0; r < pr * 0.97; r += W / 120, k++) { b.strokeStyle = k % 5 === 0 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.022)'; b.beginPath(); b.arc(c, c, r, 0, TAU); b.stroke(); }
    if (b.createConicGradient) {
      const sheen = b.createConicGradient(-Math.PI / 4, c, c);
      sheen.addColorStop(0, 'rgba(255,255,255,0.07)'); sheen.addColorStop(0.12, 'rgba(255,255,255,0)'); sheen.addColorStop(0.5, 'rgba(255,255,255,0.05)'); sheen.addColorStop(0.62, 'rgba(255,255,255,0)'); sheen.addColorStop(1, 'rgba(255,255,255,0.07)');
      b.fillStyle = sheen; b.beginPath(); b.arc(c, c, pr, 0, TAU); b.fill();
    }
    b.strokeStyle = 'rgba(0,0,0,0.55)'; b.lineWidth = W * 0.008; b.beginPath(); b.arc(c, c, pr, 0, TAU); b.stroke();
    return off;
  }
  draw(g, W, st, body) {
    const c = W / 2, R = c - W * 0.012;
    g.clearRect(0, 0, W, W);
    g.drawImage(body, 0, 0);
    const rr = R * 0.895, lw = R * 0.05;
    g.lineCap = 'round'; g.lineWidth = lw;
    g.strokeStyle = 'rgba(255,255,255,0.06)'; g.beginPath(); g.arc(c, c, rr, 0, TAU); g.stroke();
    if (st.hasTrack && st.k > 0) {
      g.strokeStyle = st.blink ? cssVar('--red') : st.warn ? cssVar('--amber') : st.deckColor;
      g.beginPath(); g.arc(c, c, rr, -Math.PI / 2, -Math.PI / 2 + Math.max(0.01, st.k) * TAU); g.stroke();
    }
    const pr = R * 0.86;
    g.save(); g.translate(c, c); g.rotate(st.ang);
    g.lineCap = 'round';
    g.strokeStyle = cssVar('--platter-mark'); g.lineWidth = W * 0.016;
    g.beginPath(); g.moveTo(0, -pr * 0.94); g.lineTo(0, -pr * 0.58); g.stroke();
    g.strokeStyle = st.deckColor; g.globalAlpha = 0.55; g.lineWidth = W * 0.006;
    g.beginPath(); g.arc(0, 0, pr * 0.97, -Math.PI / 2 - 0.12, -Math.PI / 2 + 0.12); g.stroke(); g.globalAlpha = 1;
    g.restore();
    const lr = pr * 0.36;
    g.fillStyle = st.playing || st.touched ? cssVar('--platter-label-on') : cssVar('--platter-label');
    g.beginPath(); g.arc(c, c, lr, 0, TAU); g.fill();
    g.strokeStyle = st.touched ? st.deckColor : 'rgba(255,255,255,0.08)'; g.lineWidth = W * 0.01;
    g.beginPath(); g.arc(c, c, lr, 0, TAU); g.stroke();
    g.fillStyle = cssVar('--platter-text'); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `600 ${Math.round(W * 0.074)}px ${cssVar('--mono')}`;
    g.fillText(st.bpm, c, c - W * 0.018);
    g.font = `700 ${Math.round(W * 0.036)}px ${cssVar('--font')}`; g.fillStyle = cssVar('--platter-text-2');
    g.fillText('BPM', c, c + W * 0.05);
  }
}

// ---------------------------------------------------------------- Vinyl
class VinylSkin {
  id = 'vinyl';
  constructor() { this.layers = null; this.layerKey = ''; }
  /** Tonearm geometry for canvas width W: pivot, arm length and the end angles for the outer and inner grooves. */
  geometry(W) {
    if (this._geo?.W === W) return this._geo;
    const c = W / 2, R = c - W * 0.012, rr = R * 0.86;
    const pa = -0.72; // pivot direction from the centre (radians, screen coordinates: up-right)
    const px = Math.cos(pa) * R * 0.9, py = Math.sin(pa) * R * 0.9, A = Math.hypot(px, py), L = R * 0.84;
    const beta = Math.atan2(px, py);
    // needle N(phi) = P + L (-sin phi, cos phi); |N| = r  ->  cos(phi + beta) = (r^2 - A^2 - L^2) / (2 A L)
    const phiAt = (r) => Math.acos(Math.max(-1, Math.min(1, (r * r - A * A - L * L) / (2 * A * L)))) - beta;
    let outer = phiAt(rr * 0.94), inner = phiAt(rr * 0.42);
    const norm = (a) => ((a % TAU) + 3 * Math.PI) % TAU - Math.PI;
    outer = norm(outer); inner = norm(inner);
    this._geo = { W, c, R, rr, px: c + px, py: c + py, L, outer, inner, rest: outer - (inner - outer) * 0.3 };
    return this._geo;
  }
  needle(geo, phi) { return [geo.px - Math.sin(phi) * geo.L, geo.py + Math.cos(phi) * geo.L]; }
  armPhi(geo, st) { return st.armK != null ? tonearmAngle(st.armK, geo.outer, geo.inner) : st.hasTrack ? tonearmAngle(st.k, geo.outer, geo.inner) : geo.rest; }
  /** Is canvas point (x, y) on the tonearm head (where a drag starts a needle drop)? */
  hitArm(x, y, W, st) {
    const geo = this.geometry(W), phi = this.armPhi(geo, st), [nx, ny] = this.needle(geo, phi);
    if (Math.hypot(x - nx, y - ny) < W * 0.1) return true;
    // or along the arm's outer half
    const t = ((x - geo.px) * (nx - geo.px) + (y - geo.py) * (ny - geo.py)) / (geo.L * geo.L);
    if (t < 0.45 || t > 1) return false;
    const qx = geo.px + (nx - geo.px) * t, qy = geo.py + (ny - geo.py) * t;
    return Math.hypot(x - qx, y - qy) < W * 0.045;
  }
  /** Track progress for a drag point (the arm points at it). */
  armProgressAt(x, y, W) {
    const geo = this.geometry(W);
    return tonearmProgress(Math.atan2(-(x - geo.px), y - geo.py), geo.outer, geo.inner);
  }
  sig(st) {
    return `${st.reduced ? 0 : st.ang.toFixed(3)}|${st.strobe.map((a) => a.toFixed(3)).join(',')}|${Math.round((st.armK ?? st.k) * 2000)}|${st.touched}|${st.playing}|${st.hasTrack}|${st.artKey}|${st.blink}|${st.rpmLabel}`;
  }
  body(W) {
    const off = offscreen(W), b = off.getContext('2d'), c = W / 2, R = c - W * 0.012;
    // platter rim (metal) with the strobe band
    const rim = b.createLinearGradient(0, 0, W, W);
    rim.addColorStop(0, '#9aa0a6'); rim.addColorStop(0.5, '#5d6268'); rim.addColorStop(1, '#2b2e32');
    b.fillStyle = rim; b.beginPath(); b.arc(c, c, R, 0, TAU); b.fill();
    b.fillStyle = 'rgba(0,0,0,0.25)'; b.beginPath(); b.arc(c, c, R * 0.895, 0, TAU); b.fill();
    // slip-mat (felt)
    b.fillStyle = '#121214'; b.beginPath(); b.arc(c, c, R * 0.885, 0, TAU); b.fill();
    return off;
  }
  /** Rotating record (grooves + label art) and strobe rows, cached per size / track / art / theme. */
  ensureLayers(W, st) {
    const key = `${W}|${st.artKey}|${st.deckColor}|${st.title}`;
    if (this.layers && this.layerKey === key) return this.layers;
    const c = W / 2, R = c - W * 0.012, rr = R * 0.86;
    const rec = offscreen(W), b = rec.getContext('2d');
    const vin = b.createRadialGradient(c, c, rr * 0.3, c, c, rr);
    vin.addColorStop(0, '#1d1d20'); vin.addColorStop(1, '#0a0a0b');
    b.fillStyle = vin; b.beginPath(); b.arc(c, c, rr, 0, TAU); b.fill();
    b.lineWidth = Math.max(1, W / 420);
    for (let r = rr * 0.4, k = 0; r < rr * 0.985; r += W / 170, k++) {
      const gap = k % 23 === 22; // track gaps: a wider, shinier groove
      b.strokeStyle = gap ? 'rgba(255,255,255,0.10)' : k % 3 ? 'rgba(255,255,255,0.028)' : 'rgba(255,255,255,0.05)';
      b.beginPath(); b.arc(c, c, r, 0, TAU); b.stroke();
    }
    b.strokeStyle = 'rgba(0,0,0,0.6)'; b.lineWidth = W * 0.006; b.beginPath(); b.arc(c, c, rr, 0, TAU); b.stroke();
    // label: cover art, else a coloured label with the title
    const lr = rr * 0.36;
    if (st.art) circleImage(b, st.art, c, c, lr);
    else {
      b.fillStyle = st.deckColor; b.beginPath(); b.arc(c, c, lr, 0, TAU); b.fill();
      b.fillStyle = 'rgba(0,0,0,0.55)'; b.textAlign = 'center'; b.textBaseline = 'middle';
      b.font = `800 ${Math.round(W * 0.034)}px ${cssVar('--font')}`;
      const t = (st.title || 'OpenDJ').slice(0, 18); b.fillText(t, c, c - W * 0.045);
      b.font = `700 ${Math.round(W * 0.022)}px ${cssVar('--font')}`; b.fillText('33⅓ · 45 · 78', c, c + W * 0.05);
    }
    // a printed mark so the rotation shows even on plain art
    b.fillStyle = 'rgba(255,255,255,0.85)'; b.beginPath(); b.arc(c, c - lr * 0.78, W * 0.009, 0, TAU); b.fill();
    b.strokeStyle = 'rgba(0,0,0,0.35)'; b.lineWidth = W * 0.004; b.beginPath(); b.arc(c, c, lr, 0, TAU); b.stroke();
    b.fillStyle = '#c9ccd0'; b.beginPath(); b.arc(c, c, W * 0.014, 0, TAU); b.fill(); // spindle
    // strobe rows (dots on the platter edge, three rows)
    const rows = STROBE_ROWS.map((_, i) => {
      const s = offscreen(W), d = s.getContext('2d'), r = R * (0.915 + i * 0.026), dot = W * 0.0062;
      d.fillStyle = '#d6dade';
      for (let n = 0; n < STROBE_DOTS; n++) { const a = (n / STROBE_DOTS) * TAU; d.beginPath(); d.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, dot, 0, TAU); d.fill(); }
      return s;
    });
    // fixed light: sheen over the record (does not rotate)
    const sh = offscreen(W), h = sh.getContext('2d');
    if (h.createConicGradient) {
      const g = h.createConicGradient(-Math.PI / 4, c, c);
      g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(0.1, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.07)'); g.addColorStop(0.6, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,0.10)');
      h.fillStyle = g; h.beginPath(); h.arc(c, c, rr, 0, TAU); h.arc(c, c, rr * 0.37, 0, TAU, true); h.fill('evenodd');
    }
    this.layers = { rec, rows, sheen: sh }; this.layerKey = key;
    return this.layers;
  }
  draw(g, W, st, body) {
    const c = W / 2, R = c - W * 0.012;
    const L = this.ensureLayers(W, st);
    g.clearRect(0, 0, W, W);
    g.drawImage(body, 0, 0);
    // strobe: each row drawn at its apparent (aliased) angle
    // strobe: the dots turn with the platter, the lamp freezes them: each row is drawn at its apparent (aliased) angle
    for (let i = 0; i < L.rows.length; i++) { g.save(); g.translate(c, c); g.rotate(st.strobe[i]); g.drawImage(L.rows[i], -c, -c); g.restore(); }
    g.save(); g.translate(c, c); g.rotate(st.ang);
    g.drawImage(L.rec, -c, -c);
    g.restore();
    g.drawImage(L.sheen, 0, 0);
    if (st.touched) { g.strokeStyle = st.deckColor; g.lineWidth = W * 0.012; g.globalAlpha = 0.7; g.beginPath(); g.arc(c, c, R * 0.86, 0, TAU); g.stroke(); g.globalAlpha = 1; }
    // tonearm: angle = track progress (outer -> inner groove), parked when empty
    const geo = this.geometry(W), phi = this.armPhi(geo, st), [nx, ny] = this.needle(geo, phi);
    const dx = nx - geo.px, dy = ny - geo.py, ux = dx / geo.L, uy = dy / geo.L;
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = W * 0.024; // shadow
    g.beginPath(); g.moveTo(geo.px + W * 0.012, geo.py + W * 0.016); g.lineTo(nx + W * 0.012, ny + W * 0.016); g.stroke();
    g.strokeStyle = '#c7ccd1'; g.lineWidth = W * 0.016;
    g.beginPath(); g.moveTo(geo.px - ux * W * 0.07, geo.py - uy * W * 0.07); g.lineTo(nx - ux * W * 0.05, ny - uy * W * 0.05); g.stroke();
    // counterweight, pivot, headshell
    g.fillStyle = '#7c8288'; g.beginPath(); g.arc(geo.px - ux * W * 0.085, geo.py - uy * W * 0.085, W * 0.032, 0, TAU); g.fill();
    g.fillStyle = '#3a3f44'; g.beginPath(); g.arc(geo.px, geo.py, W * 0.04, 0, TAU); g.fill();
    g.fillStyle = '#d9dde1'; g.beginPath(); g.arc(geo.px, geo.py, W * 0.018, 0, TAU); g.fill();
    g.save(); g.translate(nx, ny); g.rotate(Math.atan2(uy, ux) + 0.35);
    g.fillStyle = st.armK != null ? st.deckColor : '#e6e9ec'; g.fillRect(-W * 0.06, -W * 0.018, W * 0.075, W * 0.036);
    g.restore();
    // rpm and end-of-track warning
    g.font = `800 ${Math.round(W * 0.034)}px ${cssVar('--font')}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = st.blink ? cssVar('--red') : 'rgba(255,255,255,0.75)';
    g.fillText(st.rpmLabel, c - R * 0.64, c + R * 0.66);
  }
}

// ---------------------------------------------------------------- Jog display (media-player style)
class PlayerSkin {
  id = 'player';
  constructor() { this.art = null; this.artKey = ''; }
  sig(st) {
    return `${st.reduced ? 0 : st.ang.toFixed(3)}|${Math.round(st.k * 1440)}|${st.touched}|${st.playing}|${st.hasTrack}|${st.artKey}|${st.blink}|${st.warn}|${st.bpm}|${Math.floor(st.remaining * 10)}|${st.shadowAng == null ? '' : st.shadowAng.toFixed(3)}|${st.loop ? `${st.loop.a.toFixed(4)},${st.loop.b.toFixed(4)},${st.loop.on}` : ''}|${st.cueSig}`;
  }
  body(W) {
    const off = offscreen(W), b = off.getContext('2d'), c = W / 2, R = c - W * 0.012;
    const rim = b.createLinearGradient(0, 0, 0, W);
    rim.addColorStop(0, cssVar('--platter-rim-1')); rim.addColorStop(1, cssVar('--platter-rim-2'));
    b.fillStyle = rim; b.beginPath(); b.arc(c, c, R, 0, TAU); b.fill();
    // knurled jog edge
    b.strokeStyle = 'rgba(0,0,0,0.35)'; b.lineWidth = Math.max(1, W / 300);
    for (let n = 0; n < 120; n++) { const a = (n / 120) * TAU; b.beginPath(); b.moveTo(c + Math.cos(a) * R * 0.94, c + Math.sin(a) * R * 0.94); b.lineTo(c + Math.cos(a) * R, c + Math.sin(a) * R); b.stroke(); }
    b.fillStyle = '#07090b'; b.beginPath(); b.arc(c, c, R * 0.84, 0, TAU); b.fill(); // display glass
    b.strokeStyle = 'rgba(255,255,255,0.08)'; b.lineWidth = W * 0.006; b.beginPath(); b.arc(c, c, R * 0.84, 0, TAU); b.stroke();
    return off;
  }
  ensureArt(W, st) {
    const key = `${W}|${st.artKey}|${st.deckColor}`;
    if (this.art && this.artKey === key) return this.art;
    const c = W / 2, R = c - W * 0.012, ar = R * 0.56;
    const off = offscreen(W), b = off.getContext('2d');
    if (st.art) { circleImage(b, st.art, c, c, ar); b.fillStyle = 'rgba(0,0,0,0.42)'; b.beginPath(); b.arc(c, c, ar, 0, TAU); b.fill(); }
    else { const g = b.createRadialGradient(c, c, 0, c, c, ar); g.addColorStop(0, '#1b2026'); g.addColorStop(1, '#0d1013'); b.fillStyle = g; b.beginPath(); b.arc(c, c, ar, 0, TAU); b.fill(); }
    this.art = off; this.artKey = key;
    return off;
  }
  draw(g, W, st, body) {
    const c = W / 2, R = c - W * 0.012;
    g.clearRect(0, 0, W, W);
    g.drawImage(body, 0, 0);
    g.drawImage(this.ensureArt(W, st), 0, 0);
    // progress ring with loop arc and hot-cue ticks
    const pr = R * 0.76, top = -Math.PI / 2;
    g.lineCap = 'butt'; g.lineWidth = R * 0.05;
    g.strokeStyle = 'rgba(255,255,255,0.07)'; g.beginPath(); g.arc(c, c, pr, 0, TAU); g.stroke();
    if (st.hasTrack && st.k > 0) { g.strokeStyle = st.blink ? cssVar('--red') : st.warn ? cssVar('--amber') : st.deckColor; g.beginPath(); g.arc(c, c, pr, top, top + Math.max(0.005, st.k) * TAU); g.stroke(); }
    if (st.loop) { g.strokeStyle = st.loop.on ? '#2ed47a' : 'rgba(46,212,122,0.45)'; g.lineWidth = R * 0.085; g.beginPath(); g.arc(c, c, pr, top + st.loop.a * TAU, top + Math.max(st.loop.b, st.loop.a + 0.004) * TAU); g.stroke(); }
    for (const q of st.cues) { const a = top + q.k * TAU; g.strokeStyle = q.color; g.lineWidth = W * 0.008; g.beginPath(); g.moveTo(c + Math.cos(a) * R * 0.70, c + Math.sin(a) * R * 0.70); g.lineTo(c + Math.cos(a) * R * 0.82, c + Math.sin(a) * R * 0.82); g.stroke(); }
    // rotating position indicator (one turn per platter revolution) and the slip ghost
    const ir = R * 0.65;
    if (st.shadowAng != null) {
      g.save(); g.translate(c, c); g.rotate(st.shadowAng); g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = W * 0.022; g.lineCap = 'round';
      g.beginPath(); g.arc(0, 0, ir, -Math.PI / 2 - 0.09, -Math.PI / 2 + 0.09); g.stroke(); g.restore();
    }
    g.save(); g.translate(c, c); g.rotate(st.ang);
    g.strokeStyle = st.touched ? st.deckColor : '#ffffff'; g.lineWidth = W * 0.026; g.lineCap = 'round';
    g.beginPath(); g.arc(0, 0, ir, -Math.PI / 2 - 0.07, -Math.PI / 2 + 0.07); g.stroke();
    g.restore();
    if (st.touched) { g.strokeStyle = st.deckColor; g.lineWidth = W * 0.012; g.beginPath(); g.arc(c, c, R * 0.84, 0, TAU); g.stroke(); }
    // BPM and time remaining
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffffff'; g.font = `700 ${Math.round(W * 0.085)}px ${cssVar('--mono')}`;
    g.fillText(st.bpm, c, c - W * 0.03);
    g.font = `700 ${Math.round(W * 0.026)}px ${cssVar('--font')}`; g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillText('BPM', c, c - W * 0.105);
    if (st.hasTrack) {
      const r = Math.max(0, st.remaining), m = Math.floor(r / 60), s = Math.floor(r % 60), ds = Math.floor((r * 10) % 10);
      g.font = `600 ${Math.round(W * 0.05)}px ${cssVar('--mono')}`; g.fillStyle = st.blink ? cssVar('--red') : st.warn ? cssVar('--amber') : 'rgba(255,255,255,0.9)';
      g.fillText(`-${m}:${String(s).padStart(2, '0')}.${ds}`, c, c + W * 0.07);
    }
  }
}

export function makeSkin(id) { return id === 'vinyl' ? new VinylSkin() : id === 'player' ? new PlayerSkin() : new MinimalSkin(); }
