// Building blocks for whole-layout controller skins (Compact Controller, All-in-One): buttons, knobs, faders, jog
// wheels, pads and LED meters drawn in CSS/SVG. Every control drives a MIDI target (midi.js buildTargets), so a
// skin does exactly what the hardware does, and reads its state back from the same targets every frame, so the skin
// moves and lights up when the real controller is used. Hardware presses also flash the matching on-screen control.
//
// Performance: one requestAnimationFrame loop per skin, only while it is shown. Fast controls (jogs, faders, knobs,
// meters) update every frame, the rest at 20 Hz; each writes to the DOM only when its value changed, and only
// transforms / classes change (no layout).
import { el, clamp } from '../util.js';
import { padInfo, PAD_MODES } from '../midi/controller-extras.js';

const SVGNS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  for (const k of kids.flat()) if (k) e.append(k);
  return e;
}
const resolve = (x) => (typeof x === 'function' ? x() : x);

export class SkinRuntime {
  constructor(app, name) {
    this.app = app; this.name = name; this.ctrls = []; this.n = 0; this.raf = 0; this.offs = [];
  }
  get midi() { return this.app.midi; }
  has(id) { return !!this.midi?.byId?.has(id); }
  /** Drive a target exactly like a controller message would. */
  fire(id, v) {
    if (!id || !this.has(id)) return;
    this.app.engine.resume?.();
    this.midi.dispatch({ target: id }, v);
  }
  value(id, def = 0.5) { const t = this.midi.byId.get(id); if (!t?.get) return def; try { const v = t.get(); return Number.isFinite(v) ? v : def; } catch { return def; } }
  lit(id) { return !!id && this.midi.stateValue(id) > 0; }
  add(c) { this.ctrls.push(c); return c.el; }
  start() {
    if (this.raf) return;
    const loop = () => { this.raf = requestAnimationFrame(loop); this.frame(); };
    this.raf = requestAnimationFrame(loop);
    // flash on-screen controls when the hardware sends their message
    this.offs.push(this.midi.on('message', (m) => this.hw(m)));
  }
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; this.offs.splice(0).forEach((f) => f()); }
  frame() {
    const slow = this.n++ % 3 === 0;
    for (const c of this.ctrls) if (c.fast || slow) c.update();
  }
  hw({ device, key, isOff, type, value }) {
    const map = this.midi.mappings[device]; if (!map) return;
    const targets = new Set(map.entries.filter((e) => e.key === key || e.lsbKey === key).map((e) => e.target));
    if (!targets.size) return;
    for (const c of this.ctrls) {
      if (!c.target) continue;
      const t = resolve(c.target);
      if (!targets.has(t)) continue;
      const off = isOff || (type === 'cc' && value === 0);
      if (c.kind === 'button' || c.kind === 'pad') c.el.classList.toggle('hw', !off);
      else { c.el.classList.add('hw'); clearTimeout(c._hwT); c._hwT = setTimeout(() => c.el.classList.remove('hw'), 160); }
    }
  }
}

/**
 * Button. opts: target (id or () => id), label, sub (small text under), cls, lit (() => bool, default: the target's
 * LED), press (custom (down) => void instead of the target), disabled (string = tooltip why), title, toggle (send
 * only the press, e.g. for click-to-toggle buttons; holds still send release).
 */
export function button(rt, opts) {
  const { label = '', sub, cls = '', title, disabled } = opts;
  const b = el('button', { class: `sk-btn ${cls}`, type: 'button', title: disabled || title || (typeof label === 'string' ? label : null), 'aria-label': opts.aria || (typeof label === 'string' ? label : title) || null },
    label ? el('span', { class: 'sk-lbl' }, label) : null, sub ? el('span', { class: 'sk-sub' }, sub) : null);
  if (disabled) { b.classList.add('sk-na'); b.setAttribute('aria-disabled', 'true'); }
  let down = false;
  const send = (v) => { if (disabled) return; if (opts.press) opts.press(!!v); else rt.fire(resolve(opts.target), v); };
  b.addEventListener('pointerdown', (e) => { if (e.button > 0) return; e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch { /* */ } down = true; b.classList.add('down'); send(1); });
  const up = () => { if (!down) return; down = false; b.classList.remove('down'); send(0); };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, up);
  b.addEventListener('click', (e) => { if (e.detail === 0) { send(1); send(0); } }); // keyboard (Enter / Space)
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  let last = null, lastT = null;
  const c = {
    el: b, kind: 'button', target: opts.target, fast: !!opts.fast,
    update() {
      const t = resolve(opts.target);
      if (t !== lastT) { lastT = t; if (t) b.dataset.target = t; }
      const on = opts.lit ? !!opts.lit() : rt.lit(t);
      if (on !== last) { last = on; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
      opts.render?.(b);
    },
  };
  rt.add(c);
  return b;
}

/** Rotary knob 0..1 (bipolar knobs show a centre detent). opts: target, label, def, cls, get, set, disabled, title. */
export function knob(rt, opts) {
  const { label = '', def = 0.5, cls = '', disabled, title } = opts;
  const face = el('div', { class: 'sk-knob-face' });
  const ring = svg('svg', { class: 'sk-knob-ring', viewBox: '0 0 100 100', 'aria-hidden': 'true' },
    ...Array.from({ length: 11 }, (_, i) => { const a = (-135 + i * 27) * Math.PI / 180; return svg('line', { x1: 50 + Math.sin(a) * 44, y1: 50 - Math.cos(a) * 44, x2: 50 + Math.sin(a) * 49, y2: 50 - Math.cos(a) * 49 }); }));
  const k = el('div', { class: `sk-knob ${cls}`, role: 'slider', tabindex: disabled ? -1 : 0, 'aria-label': label || title || 'knob', 'aria-valuemin': 0, 'aria-valuemax': 100, title: disabled || title || label },
    el('div', { class: 'sk-knob-body' }, ring, face), label ? el('span', { class: 'sk-cap-lbl' }, label) : null);
  if (disabled) { k.classList.add('sk-na'); k.setAttribute('aria-disabled', 'true'); }
  const get = () => (opts.get ? opts.get() : rt.value(resolve(opts.target), def));
  const set = (v) => { if (disabled) return; v = clamp(v, 0, 1); if (opts.set) opts.set(v); else rt.fire(resolve(opts.target), v); };
  let drag = null;
  k.addEventListener('pointerdown', (e) => { if (disabled || e.button > 0) return; e.preventDefault(); k.setPointerCapture(e.pointerId); drag = { y: e.clientY, x: e.clientX, v: get() }; k.classList.add('down'); });
  k.addEventListener('pointermove', (e) => { if (!drag) return; const d = (drag.y - e.clientY) + (e.clientX - drag.x) * 0.5; set(drag.v + d / (e.shiftKey ? 600 : 180)); });
  const end = () => { drag = null; k.classList.remove('down'); };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) k.addEventListener(ev, end);
  k.addEventListener('dblclick', () => set(def));
  k.addEventListener('wheel', (e) => { if (disabled) return; e.preventDefault(); set(get() - Math.sign(e.deltaY) * 0.025); }, { passive: false });
  k.addEventListener('keydown', (e) => {
    const step = { ArrowUp: 0.02, ArrowRight: 0.02, ArrowDown: -0.02, ArrowLeft: -0.02, PageUp: 0.1, PageDown: -0.1 }[e.key];
    if (step) { e.preventDefault(); e.stopPropagation(); set(get() + step); } else if (e.key === 'Home') set(0); else if (e.key === 'End') set(1); else if (e.key === 'Delete' || e.key === 'Backspace') set(def);
  });
  let last = -1, lastT = null;
  rt.add({
    el: k, kind: 'knob', target: opts.target, fast: true,
    update() {
      const t = resolve(opts.target);
      if (t !== lastT) { lastT = t; if (t) k.dataset.target = t; }
      const v = get();
      if (Math.abs(v - last) < 0.002) return;
      last = v;
      face.style.transform = `rotate(${(v * 270 - 135).toFixed(1)}deg)`;
      k.setAttribute('aria-valuenow', Math.round(v * 100));
    },
  });
  return k;
}

/**
 * Fader. opts: target, orient 'v' | 'h', topMax (vertical: the top is 1; false for tempo faders where − is at the
 * top), def, cls, marks (silkscreen marks along the slot), label, disabled.
 */
export function fader(rt, opts) {
  const { orient = 'v', topMax = true, def = 0.5, cls = '', marks = [], label = '', disabled, title } = opts;
  const cap = el('div', { class: 'sk-fcap' });
  const mover = el('div', { class: 'sk-fmove' }, cap);
  const rail = el('div', { class: 'sk-frail' }, mover);
  const f = el('div', { class: `sk-fader ${orient} ${cls}`, role: 'slider', tabindex: disabled ? -1 : 0, 'aria-orientation': orient === 'v' ? 'vertical' : 'horizontal', 'aria-label': label || title || 'fader', 'aria-valuemin': 0, 'aria-valuemax': 100, title: disabled || title || label },
    el('div', { class: 'sk-fslot' }), el('div', { class: 'sk-fmarks', 'aria-hidden': 'true' }, ...marks.map((m) => el('span', {}, m))), rail);
  if (disabled) { f.classList.add('sk-na'); f.setAttribute('aria-disabled', 'true'); }
  const get = () => (opts.get ? opts.get() : rt.value(resolve(opts.target), def));
  const set = (v) => { if (disabled) return; v = clamp(v, 0, 1); if (opts.set) opts.set(v); else rt.fire(resolve(opts.target), v); };
  // position p (0 = top / left) <-> value
  const toV = (p) => (orient === 'v' && topMax ? 1 - p : p);
  const posOf = (e) => { const r = rail.getBoundingClientRect(); return clamp(orient === 'v' ? (e.clientY - r.top) / (r.height || 1) : (e.clientX - r.left) / (r.width || 1), 0, 1); };
  let drag = null;
  f.addEventListener('pointerdown', (e) => {
    if (disabled || e.button > 0) return; e.preventDefault(); f.setPointerCapture(e.pointerId); f.classList.add('down');
    const p = posOf(e), onCap = e.target === cap || cap.contains(e.target);
    drag = { offset: onCap ? p - (orient === 'v' && topMax ? 1 - get() : get()) : 0 };
    if (!onCap) set(toV(p));
  });
  f.addEventListener('pointermove', (e) => { if (drag) set(toV(clamp(posOf(e) - drag.offset, 0, 1))); });
  const end = () => { drag = null; f.classList.remove('down'); };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) f.addEventListener(ev, end);
  f.addEventListener('dblclick', () => set(def));
  f.addEventListener('keydown', (e) => {
    const s = { ArrowUp: 0.02, ArrowRight: 0.02, ArrowDown: -0.02, ArrowLeft: -0.02, PageUp: 0.1, PageDown: -0.1 }[e.key];
    if (s) { e.preventDefault(); e.stopPropagation(); set(get() + (orient === 'v' && !topMax ? -s : s)); } else if (e.key === 'Delete' || e.key === 'Backspace') set(def);
  });
  let last = -1, lastT = null;
  rt.add({
    el: f, kind: 'fader', target: opts.target, fast: true,
    update() {
      const t = resolve(opts.target);
      if (t !== lastT) { lastT = t; if (t) f.dataset.target = t; }
      const v = clamp(get(), 0, 1);
      if (Math.abs(v - last) < 0.001) return;
      last = v;
      const p = orient === 'v' && topMax ? 1 - v : v;
      mover.style.transform = orient === 'v' ? `translateY(${(p * 100).toFixed(2)}%)` : `translateX(${(p * 100).toFixed(2)}%)`;
      f.setAttribute('aria-valuenow', Math.round(v * 100));
    },
  });
  return f;
}

/**
 * Jog wheel for deck index () => d. Touching the top scratches (vinyl mode) or bends; the outer ring nudges. The
 * platter turns with the playback position (33⅓ rpm) and its LED ring shows the cue / play state.
 */
export function jog(rt, opts) {
  const deckIdx = () => resolve(opts.deck);
  const ticks = svg('g', { class: 'sk-jog-ticks' }, ...Array.from({ length: 120 }, (_, i) => { const a = i * 3 * Math.PI / 180; const r1 = i % 5 ? 45.6 : 44.4; return svg('line', { x1: 50 + Math.sin(a) * r1, y1: 50 - Math.cos(a) * r1, x2: 50 + Math.sin(a) * 47.4, y2: 50 - Math.cos(a) * 47.4 }); }));
  const spin = svg('g', { class: 'sk-jog-spin' },
    svg('circle', { class: 'sk-jog-top', cx: 50, cy: 50, r: 41 }),
    svg('circle', { class: 'sk-jog-groove', cx: 50, cy: 50, r: 34 }),
    svg('circle', { class: 'sk-jog-groove', cx: 50, cy: 50, r: 26 }),
    svg('line', { class: 'sk-jog-mark', x1: 50, y1: 11, x2: 50, y2: 19 }));
  const s = svg('svg', { class: 'sk-jog-svg', viewBox: '0 0 100 100', 'aria-hidden': 'true' },
    svg('circle', { class: 'sk-jog-rim', cx: 50, cy: 50, r: 49.4 }), ticks, spin,
    svg('circle', { class: 'sk-jog-center', cx: 50, cy: 50, r: 9.5 }), svg('circle', { class: 'sk-jog-dot', cx: 50, cy: 50, r: 3.2 }));
  const center = opts.center ? opts.center : null;
  const j = el('div', { class: `sk-jog ${opts.cls || ''}`, role: 'slider', tabindex: 0, 'aria-label': opts.label || 'Jog wheel', title: 'Jog wheel: drag the top to scratch (vinyl mode), the outer ring to nudge. Arrow keys nudge.' }, s, center);
  const tgt = (suffix) => `deck${deckIdx() + 1}.${suffix}`;
  let drag = null;
  const angle = (e) => { const r = j.getBoundingClientRect(); return Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))); };
  j.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return; e.preventDefault(); j.setPointerCapture(e.pointerId);
    const r = j.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const ring = Math.hypot(dx, dy) > r.width * 0.43;
    drag = { a: angle(e), ring };
    if (!ring) rt.fire(tgt('jogTouch'), 1);
    j.classList.add(ring ? 'ring' : 'touch');
  });
  j.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const a = angle(e); let d = a - drag.a; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; drag.a = a;
    const ticksN = d / (2 * Math.PI) * 720;
    if (Math.abs(ticksN) > 0.01) rt.fire(tgt(drag.ring ? 'jogRing' : 'jog'), ticksN);
  });
  const end = () => { if (drag && !drag.ring) rt.fire(tgt('jogTouch'), 0); drag = null; j.classList.remove('touch', 'ring'); };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) j.addEventListener(ev, end);
  j.addEventListener('wheel', (e) => { e.preventDefault(); rt.fire(tgt('jogRing'), -Math.sign(e.deltaY) * 8); }, { passive: false });
  j.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); rt.fire(tgt('jogRing'), e.key === 'ArrowRight' ? 10 : -10); } });
  let lastA = 1e9, lastSt = '';
  rt.add({
    el: j, kind: 'jog', target: () => tgt('jog'), fast: true,
    update() {
      const deck = rt.app.engine.decks[deckIdx()]; if (!deck) return;
      const a = ((deck.track ? deck.position : 0) * 200) % 360; // 33⅓ rpm = 200°/s
      if (Math.abs(a - lastA) > 0.25) { lastA = a; spin.style.transform = `rotate(${a.toFixed(1)}deg)`; }
      const st = `${deck.playing ? 'p' : ''}${deck.track ? 'l' : ''}${deck._jogTouched ? 't' : ''}${deck.vinylMode ? 'v' : ''}`;
      if (st !== lastSt) { lastSt = st; j.classList.toggle('playing', deck.playing); j.classList.toggle('loaded', !!deck.track); j.classList.toggle('touched', !!deck._jogTouched); j.classList.toggle('vinyl', !!deck.vinylMode); }
      opts.render?.(deck);
    },
  });
  return j;
}

/** Performance pad n (0-7) for deck () => d, in the controller pad mode (app.ctl). */
export function pad(rt, opts) {
  const d = () => resolve(opts.deck), n = opts.n;
  const lbl = el('span', { class: 'sk-pad-lbl' });
  const p = el('button', { class: `sk-pad ${opts.cls || ''}`, type: 'button', 'aria-label': `Pad ${n + 1}` }, lbl);
  let down = false;
  const target = () => `deck${d() + 1}.ctlPad${n + 1}`;
  p.addEventListener('pointerdown', (e) => { if (e.button > 0) return; e.preventDefault(); try { p.setPointerCapture(e.pointerId); } catch { /* */ } down = true; p.classList.add('down'); rt.fire(target(), 1); });
  const up = () => { if (!down) return; down = false; p.classList.remove('down'); rt.fire(target(), 0); };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) p.addEventListener(ev, up);
  p.addEventListener('click', (e) => { if (e.detail === 0) { rt.fire(target(), 1); rt.fire(target(), 0); } });
  p.addEventListener('contextmenu', (e) => e.preventDefault());
  let sig = '';
  rt.add({
    el: p, kind: 'pad', target, fast: false,
    update() {
      const info = padInfo(rt.app, d(), n), mode = rt.app.ctl?.padMode[d() + 1] || 'hotcue';
      const s = `${info.text}|${info.color}|${info.lit}|${mode}`;
      if (s === sig) return;
      sig = s;
      lbl.textContent = info.text;
      p.dataset.target = target();
      p.style.setProperty('--pad', info.color || PAD_MODES[mode]?.color || '#ff8a2a');
      p.classList.toggle('set', !!info.color);
      p.classList.toggle('on', !!info.lit);
    },
  });
  return p;
}

/** LED meter: level () => 0..1 (peak, linear), segments n. */
export function meter(rt, { level, segs = 12, cls = '', orient = 'v' }) {
  const leds = Array.from({ length: segs }, (_, i) => el('i', { class: i >= segs - 2 ? 'clip' : i >= segs - 5 ? 'hot' : '' }));
  const m = el('div', { class: `sk-meter ${orient} ${cls}`, 'aria-hidden': 'true' }, ...(orient === 'v' ? [...leds].reverse() : leds));
  let lit = -1, hold = 0;
  rt.add({
    el: m, kind: 'meter', fast: true,
    update() {
      let v = 0; try { v = level() || 0; } catch { v = 0; }
      const db = 20 * Math.log10(v + 1e-9), k = clamp((db + 42) / 45, 0, 1);
      hold = Math.max(k, hold - 0.025);
      const n = Math.round(hold * segs);
      if (n === lit) return;
      for (let i = 0; i < segs; i++) { const on = i < n; if ((i < lit) !== on) leds[i].classList.toggle('on', on); }
      lit = n;
    },
  });
  return m;
}

/** Text that follows state (low rate). */
export function text(rt, cls, fn) {
  const e = el('span', { class: cls });
  let last = null;
  rt.add({ el: e, kind: 'text', fast: false, update() { let t = ''; try { t = String(fn() ?? ''); } catch { t = ''; } if (t !== last) { last = t; e.textContent = t; } } });
  return e;
}

/** Silkscreen label. */
export const silk = (txt, cls = '') => el('span', { class: `sk-silk ${cls}` }, txt);
