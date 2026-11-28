// Karaoke layer for the video mixer: current line (sung part highlighted word by word, or as a wipe when only line
// times are known) and the next line, drawn on the mixer's overlay canvas.
// installKaraokeOverlay(mixer, getFrame) wraps mixer.paintOverlay without touching video/mixer.js; getFrame(now)
// returns null (nothing to show) or { state, color } where state = lyricStateAt(...).

const FONT = 'Inter, "Segoe UI", system-ui, sans-serif';

/** Fit text into maxW by shrinking the font size. Returns the size used. */
function fitFont(g, text, weight, size, maxW) {
  let s = size;
  g.font = `${weight} ${Math.round(s)}px ${FONT}`;
  const w = g.measureText(text).width;
  if (w > maxW) { s = Math.max(size * 0.45, (size * maxW) / w); g.font = `${weight} ${Math.round(s)}px ${FONT}`; }
  return s;
}

/**
 * Draw one karaoke frame. Pure canvas drawing (works on any 2D context: overlay, tests, OffscreenCanvas).
 * @param {CanvasRenderingContext2D} g
 * @param {number} W @param {number} H
 * @param {{ state: object, color?: string, title?: string, showNext?: boolean }} f
 */
export function drawKaraoke(g, W, H, { state, color = '#3ea6ff', showNext = true, position = 'bottom' } = {}) {
  if (!state) return false;
  const s = H / 720, maxW = W - 120 * s;
  const yCur = position === 'center' ? H * 0.5 : H * 0.74, yNext = yCur + 62 * s;
  const line = state.line && !state.gap ? state.line : null;
  const next = state.next;
  g.save();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  // soft band for legibility over video
  if (line || next) {
    const grd = g.createLinearGradient(0, yCur - 70 * s, 0, yNext + 50 * s);
    grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(0.25, 'rgba(0,0,0,.55)'); grd.addColorStop(0.8, 'rgba(0,0,0,.55)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, yCur - 70 * s, W, yNext - yCur + 120 * s);
  }
  g.shadowColor = 'rgba(0,0,0,.85)'; g.shadowBlur = 10 * s;
  if (line) {
    const text = line.text;
    fitFont(g, text, 800, 48 * s, maxW);
    const total = g.measureText(text).width;
    const x0 = W / 2 - total / 2;
    // sung fraction in pixels: per word when we have word stamps, else a wipe across the line
    let sungPx;
    if (line.words?.length && state.wordIndex >= 0) {
      let acc = 0;
      // words carry their own spacing; measure the same way the line text was joined
      const joined = line.words.map((w) => w.text);
      for (let i = 0; i < state.wordIndex; i++) acc += g.measureText(joined[i]).width;
      acc += g.measureText(joined[state.wordIndex] || '').width * state.wordProgress;
      sungPx = Math.min(total, acc * (total / Math.max(1, g.measureText(joined.join('')).width)));
    } else sungPx = line.words?.length ? 0 : total * state.progress;
    g.fillStyle = '#ffffff'; g.fillText(text, W / 2, yCur);
    if (sungPx > 0) {
      g.save();
      g.beginPath(); g.rect(x0 - 4, yCur - 60 * s, sungPx + 4, 120 * s); g.clip();
      g.fillStyle = color; g.fillText(text, W / 2, yCur);
      g.restore();
    }
  } else if (state.gap && next) {
    // instrumental gap: count-in dots before the next line
    const dt = next.t - (state.t ?? next.t);
    if (dt > 0 && dt < 4) {
      g.fillStyle = color;
      const n = Math.ceil(dt);
      for (let i = 0; i < n; i++) { g.beginPath(); g.arc(W / 2 + (i - (n - 1) / 2) * 30 * s, yCur, 8 * s, 0, Math.PI * 2); g.fill(); }
    }
  }
  if (showNext && next?.text) {
    fitFont(g, next.text, 600, 30 * s, maxW);
    g.fillStyle = 'rgba(255,255,255,.62)';
    g.fillText(next.text, W / 2, line ? yNext : yCur + (state.gap ? 52 * s : 0));
  }
  g.restore();
  return true;
}

function karaokeSig(f) {
  if (!f?.state) return '';
  const s = f.state;
  const gapDots = s.gap && s.next ? Math.ceil(Math.max(0, s.next.t - (s.t ?? s.next.t))) : 0;
  return `${s.line?.t ?? ''}|${s.line?.text ?? ''}|${s.wordIndex ?? -1}|${Math.round((s.wordProgress || 0) * 60)}|${Math.round((s.progress || 0) * 160)}|${s.next?.t ?? ''}|${s.gap ? 1 : 0}|${gapDots}|${f.color || ''}|${f.showNext === false ? 0 : 1}`;
}

/** Hook the karaoke layer into a VideoMixer instance (idempotent). Returns { uninstall }. */
export function installKaraokeOverlay(mixer, getFrame) {
  if (!mixer || typeof mixer.paintOverlay !== 'function') return null;
  if (mixer._karaoke) { mixer._karaoke.getFrame = getFrame; return mixer._karaoke; }
  const orig = mixer.paintOverlay;
  const k = { getFrame, was: false, lastSig: '' };
  mixer.paintOverlay = function paintOverlayWithKaraoke(now) {
    let f = null;
    try { f = k.getFrame(now); } catch (e) { console.warn('karaoke overlay', e); }
    const sig = karaokeSig(f);
    const changed = sig !== k.lastSig;
    if (changed) { this.overlayDirty = true; k.lastSig = sig; }
    k.was = !!f;
    const wasDirty = this.overlayDirty;
    const has = orig.call(this, now);
    if (!f) return has;
    if (wasDirty || changed) {
      const drawn = drawKaraoke(this.og, this.overlay.width, this.overlay.height, f);
      this._overlayChanged = true;
      return has || drawn;
    }
    return true;
  };
  k.uninstall = () => { mixer.paintOverlay = orig; delete mixer._karaoke; mixer.overlayDirty = true; };
  mixer._karaoke = k;
  return k;
}
