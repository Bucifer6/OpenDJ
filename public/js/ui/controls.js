// Reusable hardware-style controls. All are "controlled": they render from get() and call set(v).
import { el, clamp } from '../util.js';
import { cssVar } from './themes.js';

/** Rotary knob. Drag vertically, wheel to fine-tune, double-click to reset. */
export function knob({ label, min = -1, max = 1, def = 0, get, set, size = 'md', bipolar = min < 0, title, format }) {
  const ind = el('div', { class: 'knob-ind' });
  const cap = el('div', { class: `knob knob-${size}`, title: title || label, tabindex: 0 }, ind);
  const val = el('div', { class: 'knob-val' });
  const root = el('div', { class: 'knob-wrap' }, cap, label ? el('div', { class: 'knob-label' }, label) : null, format ? val : null);
  const render = () => {
    const v = get();
    const k = (v - min) / (max - min);
    ind.style.transform = `rotate(${-135 + k * 270}deg)`;
    const from = bipolar ? 0.5 : 0;
    const a = Math.min(from, k), b = Math.max(from, k);
    cap.style.setProperty('--arc-a', `${-135 + a * 270}deg`);
    cap.style.setProperty('--arc-b', `${(b - a) * 270}deg`);
    cap.classList.toggle('off-center', Math.abs(v - def) > 1e-3);
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
  cap.addEventListener('pointerup', () => { startY = null; });
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
  const root = el('div', { class: `fader ${horizontal ? 'fader-h' : 'fader-v'} ${cls}`, title: title || label, tabindex: 0 }, track, label ? el('div', { class: 'fader-label' }, label) : null);
  const toK = (v) => { const k = (v - min) / (max - min); return invert ? 1 - k : k; };
  const fromK = (k) => { k = clamp(k, 0, 1); if (invert) k = 1 - k; return min + k * (max - min); };
  const render = () => {
    const k = toK(get());
    if (horizontal) thumb.style.left = `${k * 100}%`; else thumb.style.top = `${(1 - k) * 100}%`;
  };
  const posToK = (e) => {
    const r = track.getBoundingClientRect();
    return horizontal ? (e.clientX - r.left) / r.width : 1 - (e.clientY - r.top) / r.height;
  };
  let drag = null;
  track.addEventListener('pointerdown', (e) => {
    track.setPointerCapture(e.pointerId);
    const k0 = toK(get()), kp = posToK(e);
    const onThumb = e.target === thumb || Math.abs(kp - k0) < 0.06;
    drag = { off: onThumb ? kp - k0 : 0 };
    if (!onThumb) { set(fromK(kp)); render(); }
    e.preventDefault();
  });
  track.addEventListener('pointermove', (e) => { if (!drag) return; set(fromK(posToK(e) - drag.off)); render(); });
  track.addEventListener('pointerup', () => { drag = null; });
  track.addEventListener('dblclick', () => { set(def); render(); });
  root.addEventListener('wheel', (e) => { e.preventDefault(); const dir = -Math.sign(e.deltaY) * (invert ? -1 : 1); set(clamp(get() + dir * (max - min) / 100, min, max)); render(); }, { passive: false });
  render();
  root.render = render;
  return root;
}

/** Push button. momentary: down/up handlers; toggle: active() getter drives the lit state. */
export function button(label, { cls = '', title, down, up, click, active, disabled } = {}) {
  const b = el('button', { class: `btn ${cls}`, title: title || (typeof label === 'string' ? label : '') }, label);
  if (down) b.addEventListener('pointerdown', (e) => { if (e.button === 0) down(e); });
  if (up) { b.addEventListener('pointerup', (e) => up(e)); b.addEventListener('pointerleave', (e) => { if (e.buttons) up(e); }); }
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
    root.classList.add('touched');
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
  const end = () => { if (last && !last.outer) deck.jogRelease(); last = null; root.classList.remove('touched'); };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); deck.jogNudge(-e.deltaY / 2000); }, { passive: false });

  root.draw = () => {
    const W = canvas.width, c = W / 2;
    g.clearRect(0, 0, W, W);
    const pos = deck.position;
    const ang = (pos / 1.8) * 2 * Math.PI;
    // platter
    const grad = g.createRadialGradient(c, c, 20, c, c, c);
    grad.addColorStop(0, cssVar('--platter-1')); grad.addColorStop(0.75, cssVar('--platter-2')); grad.addColorStop(0.77, cssVar('--platter-3')); grad.addColorStop(1, cssVar('--platter-4'));
    g.fillStyle = grad; g.beginPath(); g.arc(c, c, c - 4, 0, 2 * Math.PI); g.fill();
    // grooves
    g.strokeStyle = 'rgba(255,255,255,0.04)'; g.lineWidth = 1;
    for (let r = 60; r < c * 0.74; r += 7) { g.beginPath(); g.arc(c, c, r, 0, 2 * Math.PI); g.stroke(); }
    // position ring (track progress)
    const k = deck.duration ? pos / deck.duration : 0;
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 6;
    g.beginPath(); g.arc(c, c, c - 12, 0, 2 * Math.PI); g.stroke();
    const warn = deck.duration && deck.remaining < 30;
    g.strokeStyle = warn && Math.floor(performance.now() / 400) % 2 ? '#ff4757' : getComputedStyle(root).getPropertyValue('--deck-color') || '#3ea6ff';
    g.beginPath(); g.arc(c, c, c - 12, -Math.PI / 2, -Math.PI / 2 + k * 2 * Math.PI); g.stroke();
    // marker line
    g.save(); g.translate(c, c); g.rotate(ang);
    g.strokeStyle = cssVar('--platter-mark'); g.lineWidth = 5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(0, -c * 0.32); g.lineTo(0, -c * 0.72); g.stroke();
    g.restore();
    // centre label
    g.fillStyle = deck.playing ? cssVar('--platter-1') : cssVar('--platter-4'); g.beginPath(); g.arc(c, c, c * 0.28, 0, 2 * Math.PI); g.fill();
    g.fillStyle = cssVar('--platter-text'); g.font = '600 26px Inter, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(deck.effectiveBpm ? deck.effectiveBpm.toFixed(1) : '--', c, c - 8);
    g.font = '500 16px Inter, system-ui, sans-serif'; g.fillStyle = cssVar('--platter-text-2');
    g.fillText('BPM', c, c + 18);
  };
  return root;
}
