// Reusable hardware-style controls. All are "controlled": they render from get() and call set(v).
import { el, clamp, uiZoom } from '../util.js';
import { cssVar } from './themes.js';
import { smoothTime } from './clock.js';
import { makeSkin, coverBitmap, STROBE_DOTS } from './platter-skins.js';
import { strobeRate, STROBE_ROWS } from '../audio/vinyl.js';
import { paintJogFace, paintJogOverlay } from './jog-art.js';

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
  let startY, startV, latestPointer = null, moveFrame = 0;
  const applyPointer = () => {
    moveFrame = 0;
    if (startY == null || !latestPointer) return;
    const { y, fine: fineMode } = latestPointer; latestPointer = null;
    const fine = fineMode ? 0.2 : 1;
    let v = startV + (startY - y) / 150 * (max - min) * fine;
    if (bipolar && Math.abs(v - def) < (max - min) * 0.02 && !fineMode) v = def; // centre detent
    set(clamp(v, min, max)); render();
  };
  const flushPointer = () => { if (moveFrame) cancelAnimationFrame(moveFrame); applyPointer(); };
  cap.addEventListener('pointerdown', (e) => {
    cap.setPointerCapture(e.pointerId); startY = e.clientY; startV = get(); e.preventDefault();
  });
  cap.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    latestPointer = { y: e.clientY, fine: e.shiftKey };
    if (!moveFrame) moveFrame = requestAnimationFrame(applyPointer);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) cap.addEventListener(ev, () => { flushPointer(); startY = null; });
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
  // Measure once at drag start. Reading layout on every pointermove forces a reflow and makes control motion stutter.
  const measure = () => {
    const r = track.getBoundingClientRect(), cap = thumb.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, capWidth: cap.width, capHeight: cap.height };
  };
  const posToK = (e, m) => {
    const cap = horizontal ? m.capWidth : m.capHeight, len = (horizontal ? m.width : m.height) - cap;
    if (len <= 0) return 0.5;
    const p = horizontal ? e.clientX - m.left - cap / 2 : e.clientY - m.top - cap / 2;
    return horizontal ? p / len : 1 - p / len;
  };
  let drag = null, latestPointer = null, moveFrame = 0;
  const applyPointer = () => {
    moveFrame = 0;
    if (!drag || !latestPointer) return;
    const e = latestPointer; latestPointer = null;
    set(fromK(posToK(e, drag.metrics) - drag.off)); render();
  };
  const flushPointer = () => { if (moveFrame) cancelAnimationFrame(moveFrame); applyPointer(); };
  track.addEventListener('pointerdown', (e) => {
    track.setPointerCapture(e.pointerId);
    const metrics = measure(), k0 = clamp(toK(get()), 0, 1), kp = posToK(e, metrics);
    const onThumb = e.target === thumb || Math.abs(kp - k0) < 0.06;
    drag = { off: onThumb ? kp - k0 : 0, metrics };
    if (!onThumb) { set(fromK(kp)); render(); }
    e.preventDefault();
  });
  track.addEventListener('pointermove', (e) => {
    if (!drag) return;
    latestPointer = { clientX: e.clientX, clientY: e.clientY };
    if (!moveFrame) moveFrame = requestAnimationFrame(applyPointer);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) track.addEventListener(ev, () => { flushPointer(); drag = null; });
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

/**
 * Jog wheel / platter (T3, T7, T8). Every pointer is tracked on its own (pointerId):
 *  - the first finger on the platter top scratches through the position-following API (deck.jogPositionStart /
 *    jogPosition / jogPositionEnd), using the events' own timestamps and getCoalescedEvents() samples;
 *  - a second finger anywhere on the same platter holds the record still ("hand on the record") until it lifts; if
 *    the scratching finger lifts first, the holding finger takes over;
 *  - the outer ring (or the whole platter with VINYL off) nudges; the mouse wheel nudges;
 *  - on the Vinyl skin the tonearm head can be dragged: the needle drops where it is let go (T6).
 * opts: { skin: () => skin id, haptics, onTouch(bool) }.
 */
/** A skin's jog style from jog-art.js, behind the platter-skin interface (body / sig / draw). */
class JogArtSkin {
  constructor(style) { this.style = style; this.id = 'minimal'; }
  sig(st) { return `${st.ang.toFixed(3)}|${Math.round(st.k * 720)}|${st.blink}|${st.warn}|${st.bpm}|${st.playing}|${st.touched}|${st.deckColor}`; }
  body(W) {
    const off = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, W) : Object.assign(document.createElement('canvas'), { width: W, height: W });
    paintJogFace(off.getContext('2d'), W, this.style);
    return off;
  }
  draw(g, W, st, body) {
    g.clearRect(0, 0, W, W);
    g.drawImage(body, 0, 0);
    const signal = st.blink ? cssVar('--red') : st.warn ? cssVar('--amber') : st.deckColor;
    paintJogOverlay(g, W, this.style, { angle: st.ang, progress: st.k, colour: st.deckColor, signal, bpm: st.bpm, playing: st.playing, touched: st.touched });
  }
}

export function jogWheel(deck, opts = {}) {
  const canvas = el('canvas', { class: 'jog-canvas', width: 360, height: 360, 'aria-label': `Deck ${deck.index + 1} platter` });
  const root = el('div', { class: 'jog' }, canvas);
  const g = canvas.getContext('2d');
  const pointers = new Map(); // pointerId -> { kind: 'scratch' | 'hold' | 'nudge' | 'arm', a, rot }
  let rect = null; // measured once per gesture (no layout read per move)
  const angleOf = (e) => {
    const r = rect || canvas.getBoundingClientRect();
    const cx = ((e.clientX - r.left) / r.width) * canvas.width, cy = ((e.clientY - r.top) / r.height) * canvas.height;
    const x = cx - canvas.width / 2, y = cy - canvas.height / 2;
    return { a: Math.atan2(y, x), d: Math.hypot(x, y) / (canvas.width / 2), cx, cy };
  };
  const wrap = (da) => (da > Math.PI ? da - 2 * Math.PI : da < -Math.PI ? da + 2 * Math.PI : da);
  let rot = 0, holding = 0, lastTick = 0, lastBeat = null;
  const scratcher = () => [...pointers.values()].find((p) => p.kind === 'scratch');
  const setTouched = (on) => { if (on !== touched) { touched = on; root.classList.toggle('touched', on); opts.onTouch?.(on); } };
  const feel = () => { // haptics: a groove tick every 1/16 turn, a bump on beats (Full) and hot cues
    const h = opts.haptics; if (!h) return;
    const k = Math.floor(rot * 16); if (k !== lastTick) { lastTick = k; h.tick(); }
    if (deck.bpm) {
      const pos = deck.position, b = deck.beatIndex(pos);
      if (lastBeat != null && b !== lastBeat) {
        const lo = Math.min(lastBeat, b) * deck.beatLen + deck.gridOffset, hi = Math.max(lastBeat, b) * deck.beatLen + deck.gridOffset + deck.beatLen;
        if (deck.hotCues.some((c) => c.position >= lo && c.position < hi)) h.impact('light'); else h.impact('light', 'full');
      }
      lastBeat = b;
    }
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    canvas.setPointerCapture(e.pointerId);
    if (!pointers.size) rect = canvas.getBoundingClientRect();
    const { a, d, cx, cy } = angleOf(e);
    if (skin.hitArm && deck.track && !deck.track.scratchSample && skin.hitArm(cx, cy, canvas.width, frameState) && !pointers.size) {
      pointers.set(e.pointerId, { kind: 'arm', a }); armK = skin.armProgressAt(cx, cy, canvas.width); sig = ''; e.preventDefault(); return;
    }
    const s = scratcher();
    if (s || [...pointers.values()].some((p) => p.kind === 'hold')) { // another finger is on the record: hold it still
      pointers.set(e.pointerId, { kind: 'hold', a });
      if (!holding++ && s) deck.jogPosition(rot, e.timeStamp);
      e.preventDefault(); return;
    }
    if (pointers.size) { pointers.set(e.pointerId, { kind: 'ignore', a }); return; } // extra finger while nudging
    const outer = d > 0.78 || !deck.vinylMode;
    if (!outer && deck.jogPositionStart(e.timeStamp)) { rot = 0; lastTick = 0; lastBeat = null; pointers.set(e.pointerId, { kind: 'scratch', a }); }
    else pointers.set(e.pointerId, { kind: 'nudge', a });
    setTouched(true);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const evs = (p.kind === 'scratch' && e.getCoalescedEvents?.()) || [e];
    for (const ce of evs.length ? evs : [e]) {
      const { a, cx, cy } = angleOf(ce);
      const da = wrap(a - p.a); p.a = a;
      if (p.kind === 'scratch') {
        if (holding) continue; // the other finger holds the record
        rot += da / (2 * Math.PI);
        deck.jogPosition(rot, ce.timeStamp);
      } else if (p.kind === 'nudge') deck.jogNudge((da / (2 * Math.PI)) * 4);
      else if (p.kind === 'arm') { armK = skin.armProgressAt(cx, cy, canvas.width); sig = ''; }
    }
    if (p.kind === 'scratch' && !holding) feel();
  });
  const end = (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    pointers.delete(e.pointerId);
    if (p.kind === 'arm') { if (e.type === 'pointerup' && armK != null) deck.needleDrop(armK); armK = null; sig = ''; }
    else if (p.kind === 'hold') {
      holding = Math.max(0, holding - 1);
      const s = scratcher();
      if (!s) { // the scratching finger lifted first: this was the last hand on the record
        const other = [...pointers.entries()].find(([, q]) => q.kind === 'hold');
        if (other) { other[1].kind = 'scratch'; holding--; } else deck.jogPositionEnd(e.timeStamp);
      }
    } else if (p.kind === 'scratch') {
      const h = [...pointers.values()].find((q) => q.kind === 'hold');
      if (h) { h.kind = 'scratch'; holding = Math.max(0, holding - 1); } // the holding finger becomes the scratching one
      else deck.jogPositionEnd(e.timeStamp);
    }
    if (![...pointers.values()].some((q) => q.kind !== 'ignore')) { pointers.clear(); holding = 0; rect = null; setTouched(false); }
  };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(ev, end);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); deck.jogNudge(-e.deltaY / 2000); }, { passive: false });
  root.pointerCount = () => pointers.size;
  root.holding = () => holding > 0;

  // Static layers are rendered once per size / theme / skin (platter-skins.js); a frame draws the moving parts only,
  // and frames whose signature did not change are skipped.
  let touched = false, size = 0, body = null, sig = '', deckColor = null, skinId = '', skin = null, armK = null;
  let roW = 0, roObserved = false; // platter size from the observer entry (no layout read in the draw)
  let art = null, artKey = '', artFor = null, lastNow = 0;
  const strobe = [0, 0, 0];
  const reducedQ = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const frameState = { ang: 0, k: 0, strobe, cues: [] };
  const ro = new ResizeObserver((es) => { roObserved = true; roW = es.at(-1).contentRect.width * uiZoom(); size = 0; });
  ro.observe(canvas);
  // The deck's platter style (Settings → Decks) wins; with Minimal, the skin's own jog style (Brushed / Digital / Vinyl,
  // Settings → Appearance) is drawn by jog-art.js, and 'classic' is the Minimal platter.
  let jogStyle = document.documentElement.dataset.jogStyle || 'classic';
  const onTheme = () => { jogStyle = document.documentElement.dataset.jogStyle || 'classic'; body = null; deckColor = null; sig = ''; };
  window.addEventListener('opendj-theme', onTheme);
  root.destroy = () => {
    ro.disconnect();
    window.removeEventListener('opendj-theme', onTheme);
    body = null; skin = null; art = null;
    canvas.width = 0; canvas.height = 0;
  };
  const pickSkin = () => {
    const chosen = opts.skin?.() || 'minimal';
    const id = chosen === 'minimal' && jogStyle !== 'classic' ? `jog:${jogStyle}` : chosen;
    if (id !== skinId) { skinId = id; skin = id.startsWith('jog:') ? new JogArtSkin(jogStyle) : makeSkin(id); body = null; sig = ''; root.dataset.skin = id.startsWith('jog:') ? 'minimal' : id; }
  };
  const maxBacking = opts.maxBacking || 640;
  root.draw = (now = performance.now()) => {
    // Skip rendering completely when platter is display:none (Performance / Waveform / 4-Deck layouts)
    if (roObserved && roW <= 0) return;
    pickSkin();
    if (!size) {
      const w = roW || canvas.getBoundingClientRect().width;
      if (w <= 0) return;
      const dpr = Math.min(2, devicePixelRatio || 1);
      size = Math.max(64, Math.min(maxBacking, Math.round(w * dpr))) || 360;
      if (canvas.width !== size) { canvas.width = size; canvas.height = size; body = null; sig = ''; }
    }
    const W = canvas.width;
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0; lastNow = now;
    const t = deck.track;
    // cover art for the skins that show it (decoded once per track, off the frame path)
    if (skinId !== 'minimal' && !skinId.startsWith('jog:') && (t?.id ?? null) !== artFor) {
      artFor = t?.id ?? null; art = null; artKey = `${artFor}|none`;
      if (t && !t.scratchSample) { const want = artFor; coverBitmap(want).then((b) => { if (artFor === want) { art = b; artKey = `${want}|${b ? 'art' : 'none'}`; sig = ''; } }); }
    }
    const pos = deck.positionAt(smoothTime(deck.ctx, now));
    const spr = deck.secPerRev || 1.8;
    const reduced = !!reducedQ?.matches;
    const ang = reduced && skinId !== 'minimal' && !skinId.startsWith('jog:') ? 0 : (pos / spr) * 2 * Math.PI;
    const k = deck.duration ? pos / deck.duration : 0;
    const warn = deck.duration > 0 && deck.remaining < 30 && deck.playing;
    const blink = warn && Math.floor(now / 400) % 2 === 1;
    const bpm = deck.effectiveBpm ? deck.effectiveBpm.toFixed(1) : '--';
    if (skinId === 'vinyl') { const r = deck.playing || touched ? (deck._rate || 0) : 0; for (let i = 0; i < 3; i++) strobe[i] = reduced ? 0 : (strobe[i] + strobeRate(r, STROBE_ROWS[i], (2 * Math.PI) / STROBE_DOTS) * dt) % (2 * Math.PI); }
    deckColor ||= getComputedStyle(root).getPropertyValue('--deck-color').trim() || '#3ea6ff';
    const st = Object.assign(frameState, { ang, k, warn, blink, bpm, playing: deck.playing, touched, hasTrack: !!t, deckColor, art, artKey, title: t?.title || '', reduced, armK, rpmLabel: deck.vinyl?.rpm === 45 ? '45' : deck.vinyl?.rpm === 78 ? '78' : '33⅓' });
    if (skinId === 'player') {
      const sh = deck.shadowPosition;
      st.shadowAng = sh != null && Math.abs(sh - pos) > 0.05 ? (sh / spr) * 2 * Math.PI : null;
      const l = deck.loop, D = deck.duration || 1;
      st.loop = l && deck.duration ? { a: l.start / D, b: l.end / D, on: !!l.active } : null;
      const hc = deck.hotCues;
      st.cues = hc.map((c) => ({ k: c.position / D, color: c.color || '#2ecc71' }));
      st.cueSig = hc.map((c) => c.position.toFixed(2)).join(',');
      st.remaining = Math.max(0, (deck.duration || 0) - pos);
    }
    const s = `${W}|${skinId}|${skin.sig(st)}`;
    if (s === sig && body) return;
    sig = s;
    if (!body) body = skin.body(W);
    skin.draw(g, W, st, body);
  };
  return root;
}
