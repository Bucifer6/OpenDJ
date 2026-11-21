// Reusable hardware-style controls. All are "controlled": they render from get() and call set(v).
import { el, clamp, uiZoom } from '../util.js';
import { cssVar } from './themes.js';
import { smoothTime } from './clock.js';

/** Rotary knob. Drag vertically, wheel to fine-tune, double-click to reset. */
export function knob({ label, min = -1, max = 1, def = 0, get, set, size = 'md', bipolar = min < 0, title, format }) {
  const ind = el('div', { class: 'knob-ind' });
  const cap = el('div', { class: `knob knob-${size}${bipolar ? ' bipolar' : ''}`, title: title || label, tabindex: 0, role: 'slider', 'aria-label': title || label || 'Knob', 'aria-valuemin': min, 'aria-valuemax': max }, ind);
  const val = el('div', { class: 'knob-val' });
  const root = el('div', { class: 'knob-wrap' }, cap, label ? el('div', { class: 'knob-label' }, label) : null, format ? val : null);
  let lastV = null;
  const render = () => {
    const v = clamp(get(), min, max);
    if (v === lastV) return; // re-rendered from state ticks: only touch styles when the value moved
    lastV = v;
    const k = (v - min) / (max - min);
    ind.style.transform = `rotate(${-135 + k * 270}deg)`;
    const from = bipolar ? 0.5 : 0;
    const a = Math.min(from, k), b = Math.max(from, k);
    cap.style.setProperty('--arc-a', `${-135 + a * 270}deg`);
    cap.style.setProperty('--arc-b', `${(b - a) * 270}deg`);
    cap.classList.toggle('off-center', Math.abs(v - def) > 1e-3);
    cap.setAttribute('aria-valuenow', String(+v.toFixed(4)));
    if (format) val.textContent = format(v);
  };
  let startY, startV;
  cap.addEventListener('pointerdown', (e) => {
    cap.setPointerCapture(e.pointerId); startY = e.clientY; startV = get(); e.preventDefault();
  });
  cap.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    const fine = e.shiftKey ? 0.2 : 1;
    let v = startV + (startY - e.clientY) / 150 * (max - min) * fine;
    if (bipolar && Math.abs(v - def) < (max - min) * 0.02 && !e.shiftKey) v = def; // centre detent
    set(clamp(v, min, max)); render();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) cap.addEventListener(ev, () => { startY = null; });
  cap.addEventListener('dblclick', () => { set(def); render(); });
  cap.addEventListener('wheel', (e) => { e.preventDefault(); set(clamp(get() - Math.sign(e.deltaY) * (max - min) / 100, min, max)); render(); }, { passive: false });
  cap.addEventListener('keydown', (e) => {
    const step = (max - min) / 50;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(clamp(get() + step, min, max)); render(); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(clamp(get() - step, min, max)); render(); e.preventDefault(); }
  });
  render();
  root.render = render;
  return root;
}

/** Linear fader. vertical by default; `invert` puts max at the bottom (tempo fader convention). */
export function fader({ label, min = 0, max = 1, def = min, get, set, horizontal = false, invert = false, cls = '', title }) {
  const thumb = el('div', { class: 'fader-thumb' });
  const track = el('div', { class: 'fader-track' }, el('div', { class: 'fader-slot' }), thumb);
  const root = el('div', { class: `fader ${horizontal ? 'fader-h' : 'fader-v'} ${cls}`, title: title || label, tabindex: 0, role: 'slider', 'aria-label': title || label || 'Fader', 'aria-valuemin': min, 'aria-valuemax': max, 'aria-orientation': horizontal ? 'horizontal' : 'vertical' }, track, label ? el('div', { class: 'fader-label' }, label) : null);
  const toK = (v) => { const k = (v - min) / (max - min); return invert ? 1 - k : k; };
  const fromK = (k) => { k = clamp(k, 0, 1); if (invert) k = 1 - k; return min + k * (max - min); };
  // The cap travels inside its track: --k (0..1) places it via CSS between "flush with one end" and "flush with the
  // other" (see .fader-thumb in app.css), so it can never be drawn past the slot, whatever the value or layout.
  let lastK = null;
  const render = () => {
    const k = clamp(toK(get()), 0, 1);
    if (!Number.isFinite(k) || k === lastK) return;
    lastK = k;
    root.style.setProperty('--k', k.toFixed(4));
    root.setAttribute('aria-valuenow', String(+get().toFixed(4)));
  };
  // pointer -> 0..1 with the same geometry (rects are in window pixels on both sides, so UI zoom cancels out)
  const posToK = (e) => {
    const r = track.getBoundingClientRect(), c = thumb.getBoundingClientRect();
    const cap = horizontal ? c.width : c.height, len = (horizontal ? r.width : r.height) - cap;
    if (len <= 0) return 0.5;
    const p = horizontal ? e.clientX - r.left - cap / 2 : e.clientY - r.top - cap / 2;
    return horizontal ? p / len : 1 - p / len;
  };
  let drag = null;
  track.addEventListener('pointerdown', (e) => {
    track.setPointerCapture(e.pointerId);
    const k0 = clamp(toK(get()), 0, 1), kp = posToK(e);
    const onThumb = e.target === thumb || Math.abs(kp - k0) < 0.06;
    drag = { off: onThumb ? kp - k0 : 0 };
    if (!onThumb) { set(fromK(kp)); render(); }
    e.preventDefault();
  });
  track.addEventListener('pointermove', (e) => { if (!drag) return; set(fromK(posToK(e) - drag.off)); render(); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) track.addEventListener(ev, () => { drag = null; });
  track.addEventListener('dblclick', () => { set(def); render(); });
  root.addEventListener('wheel', (e) => { e.preventDefault(); const dir = -Math.sign(e.deltaY) * (invert ? -1 : 1); set(clamp(get() + dir * (max - min) / 100, min, max)); render(); }, { passive: false });
  root.addEventListener('keydown', (e) => {
    const inc = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (!inc) return;
    e.preventDefault(); // also keeps the global shortcuts (crossfader/library) from reacting
    set(clamp(get() + inc * (invert ? -1 : 1) * (max - min) / (e.shiftKey ? 200 : 50), min, max)); render();
  });
  render();
  root.render = render;
  return root;
}

/** Push button. momentary: down/up handlers; toggle: active() getter drives the lit state. */
export function button(label, { cls = '', title, down, up, click, active, disabled } = {}) {
  const b = el('button', { class: `btn ${cls}`, title: title || (typeof label === 'string' ? label : '') }, label);
  if (down) b.addEventListener('pointerdown', (e) => { if (e.button === 0) down(e); });
  if (up) {
    let held = false;
    b.addEventListener('pointerdown', () => { held = true; });
    const release = (e) => { if (held) { held = false; up(e); } };
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, release);
  }
  if (click) b.addEventListener('click', (e) => click(e));
  b.render = () => {
    if (active) b.classList.toggle('active', !!active());
    if (disabled) b.disabled = !!disabled();
  };
  b.render();
  return b;
}

/** Jog wheel: drag on the platter to scratch (vinyl mode) / nudge; outer ring always nudges. */
export function jogWheel(deck) {
  const canvas = el('canvas', { class: 'jog-canvas', width: 360, height: 360 });
  const root = el('div', { class: 'jog' }, canvas);
  const g = canvas.getContext('2d');
  let last = null;
  const angleOf = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
    return { a: Math.atan2(y, x), d: Math.hypot(x, y) / (r.width / 2) };
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const { a, d } = angleOf(e);
    last = { a, t: performance.now(), outer: d > 0.78 || !deck.vinylMode };
    root.classList.add('touched'); touched = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!last) return;
    const { a } = angleOf(e);
    let da = a - last.a; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
    const now = performance.now(), dt = (now - last.t) / 1000;
    const rot = da / (2 * Math.PI);
    if (last.outer) deck.jogNudge(rot * 4); else deck.jogScratch(rot, dt);
    last.a = a; last.t = now;
  });
  const end = () => { if (last && !last.outer) deck.jogRelease(); last = null; root.classList.remove('touched'); touched = false; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); deck.jogNudge(-e.deltaY / 2000); }, { passive: false });

  // The platter body (rim, grooves, light sheen) is static: render it once per size/theme into a bitmap and only draw
  // the moving parts (marker, progress ring, centre label) per frame. Frames where nothing changed are skipped.
  let touched = false, size = 0, body = null, sig = '', deckColor = null;
  let roW = 0; // platter size from the observer entry (no layout read in the draw)
  const ro = new ResizeObserver((es) => { roW = es.at(-1).contentRect.width * uiZoom(); size = 0; });
  ro.observe(canvas);
  window.addEventListener('opendj-theme', () => { body = null; deckColor = null; sig = ''; });
  const renderBody = (W) => {
    const off = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, W) : Object.assign(document.createElement('canvas'), { width: W, height: W });
    const b = off.getContext('2d'), c = W / 2, R = c - W * 0.012;
    // outer rim (brushed metal)
    const rim = b.createLinearGradient(0, 0, 0, W);
    rim.addColorStop(0, cssVar('--platter-rim-1')); rim.addColorStop(1, cssVar('--platter-rim-2'));
    b.fillStyle = rim; b.beginPath(); b.arc(c, c, R, 0, 2 * Math.PI); b.fill();
    // ring track for the position indicator
    b.fillStyle = cssVar('--platter-3'); b.beginPath(); b.arc(c, c, R * 0.93, 0, 2 * Math.PI); b.fill();
    // platter / vinyl
    const pr = R * 0.86;
    const grad = b.createRadialGradient(c, c, pr * 0.2, c, c, pr);
    grad.addColorStop(0, cssVar('--platter-1')); grad.addColorStop(0.92, cssVar('--platter-2')); grad.addColorStop(1, cssVar('--platter-4'));
    b.fillStyle = grad; b.beginPath(); b.arc(c, c, pr, 0, 2 * Math.PI); b.fill();
    // fine grooves
    b.lineWidth = Math.max(1, W / 360);
    for (let r = pr * 0.4, k = 0; r < pr * 0.97; r += W / 120, k++) { b.strokeStyle = k % 5 === 0 ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.022)'; b.beginPath(); b.arc(c, c, r, 0, 2 * Math.PI); b.stroke(); }
    // light sheen (fixed: the light doesn't rotate with the record)
    if (b.createConicGradient) {
      const sheen = b.createConicGradient(-Math.PI / 4, c, c);
      sheen.addColorStop(0, 'rgba(255,255,255,0.07)'); sheen.addColorStop(0.12, 'rgba(255,255,255,0)'); sheen.addColorStop(0.5, 'rgba(255,255,255,0.05)'); sheen.addColorStop(0.62, 'rgba(255,255,255,0)'); sheen.addColorStop(1, 'rgba(255,255,255,0.07)');
      b.fillStyle = sheen; b.beginPath(); b.arc(c, c, pr, 0, 2 * Math.PI); b.fill();
    }
    // edge shadow
    b.strokeStyle = 'rgba(0,0,0,0.55)'; b.lineWidth = W * 0.008; b.beginPath(); b.arc(c, c, pr, 0, 2 * Math.PI); b.stroke();
    return off;
  };
  root.draw = (now = performance.now()) => {
    if (!size) {
      const w = roW || canvas.getBoundingClientRect().width;
      size = Math.max(64, Math.min(1024, Math.round(w * (devicePixelRatio || 1)))) || 360;
      if (canvas.width !== size) { canvas.width = size; canvas.height = size; body = null; sig = ''; }
    }
    const W = canvas.width, c = W / 2, R = c - W * 0.012;
    const pos = deck.positionAt(smoothTime(deck.ctx, now));
    const ang = (pos / 1.8) * 2 * Math.PI; // 33⅓ rpm
    const k = deck.duration ? pos / deck.duration : 0;
    const warn = deck.duration > 0 && deck.remaining < 30 && deck.playing;
    const blink = warn && Math.floor(now / 400) % 2 === 1;
    const bpm = deck.effectiveBpm ? deck.effectiveBpm.toFixed(1) : '--';
    const s = `${W}|${ang.toFixed(3)}|${Math.round(k * 720)}|${blink}|${warn}|${bpm}|${deck.playing}|${touched}|${!!deck.track}`;
    if (s === sig && body) return;
    sig = s;
    if (!body) body = renderBody(W);
    deckColor ||= getComputedStyle(root).getPropertyValue('--deck-color').trim() || '#3ea6ff';
    g.clearRect(0, 0, W, W);
    g.drawImage(body, 0, 0);
    // position ring (track progress)
    const rr = R * 0.895, lw = R * 0.05;
    g.lineCap = 'round'; g.lineWidth = lw;
    g.strokeStyle = 'rgba(255,255,255,0.06)'; g.beginPath(); g.arc(c, c, rr, 0, 2 * Math.PI); g.stroke();
    if (deck.track && k > 0) {
      g.strokeStyle = blink ? cssVar('--red') : warn ? cssVar('--amber') : deckColor;
      g.beginPath(); g.arc(c, c, rr, -Math.PI / 2, -Math.PI / 2 + Math.max(0.01, k) * 2 * Math.PI); g.stroke();
    }
    // rotating marker: a bright notch on the vinyl and a dot on the label
    const pr = R * 0.86;
    g.save(); g.translate(c, c); g.rotate(ang);
    g.lineCap = 'round';
    g.strokeStyle = cssVar('--platter-mark'); g.lineWidth = W * 0.016;
    g.beginPath(); g.moveTo(0, -pr * 0.94); g.lineTo(0, -pr * 0.58); g.stroke();
    g.strokeStyle = deckColor; g.globalAlpha = 0.55; g.lineWidth = W * 0.006;
    g.beginPath(); g.arc(0, 0, pr * 0.97, -Math.PI / 2 - 0.12, -Math.PI / 2 + 0.12); g.stroke(); g.globalAlpha = 1;
    g.restore();
    // centre label
    const lr = pr * 0.36;
    g.fillStyle = deck.playing || touched ? cssVar('--platter-label-on') : cssVar('--platter-label');
    g.beginPath(); g.arc(c, c, lr, 0, 2 * Math.PI); g.fill();
    g.strokeStyle = touched ? deckColor : 'rgba(255,255,255,0.08)'; g.lineWidth = W * 0.01;
    g.beginPath(); g.arc(c, c, lr, 0, 2 * Math.PI); g.stroke();
    g.fillStyle = cssVar('--platter-text'); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `600 ${Math.round(W * 0.074)}px ${cssVar('--mono')}`;
    g.fillText(bpm, c, c - W * 0.018);
    g.font = `700 ${Math.round(W * 0.036)}px ${cssVar('--font')}`; g.fillStyle = cssVar('--platter-text-2');
    g.fillText('BPM', c, c + W * 0.05);
  };
  return root;
}
