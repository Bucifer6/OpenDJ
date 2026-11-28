// Gamepads (Gamepad API) as controllers: any USB / Bluetooth pad, joystick or wheel. Polled every animation frame.
// Keys: gp:btn:<index> (buttons; analog triggers also usable as faders) and gp:axis:<index>.
// Axes drive absolute targets as 0..1, or relative targets (jog, browser) as a speed while deflected.
// Mappings live under `gamepad:<id>` in the shared mapping store.
import { clamp } from '../util.js';

export const gamepadKey = (gp) => `gamepad:${gp.id}`;
export function describeGamepadKey(k) {
  const [, kind, i] = k.split(':');
  return kind === 'axis' ? `Axis ${i}` : `Button ${i}`;
}
const DEAD = 0.15;

export class GamepadManager {
  constructor(midi) {
    this.midi = midi;
    this.state = new Map(); // gamepad key -> { buttons: number[], axes: number[], rest?: {...} }
    this.acc = new WeakMap(); // entry -> accumulated relative movement
    this.running = false;
  }
  get supported() { return typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'; }
  init() {
    if (!this.supported || typeof window === 'undefined') return;
    window.addEventListener('gamepadconnected', () => { this.start(); this.midi.emit('devices'); });
    window.addEventListener('gamepaddisconnected', (e) => { this.state.delete(gamepadKey(e.gamepad)); this.midi.emit('devices'); });
    if (this.pads().length) this.start();
  }
  pads() { try { return [...navigator.getGamepads()].filter(Boolean); } catch { return []; } }
  list() { return this.pads().map((gp) => ({ key: gamepadKey(gp), name: gp.id.replace(/\s*\(.*?Vendor.*?\)\s*/i, ' ').trim() || `Gamepad ${gp.index + 1}` })); }
  start() {
    if (this.running) return;
    this.running = true;
    let lastAt = 0;
    const loop = (now) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      if (document.hidden || (lastAt && now - lastAt < 15.5)) return;
      this._dtScale = lastAt ? Math.min(3, (now - lastAt) / 16.667) : 1;
      lastAt = now;
      this.poll();
    };
    requestAnimationFrame(loop);
  }

  poll() {
    const pads = this.pads();
    if (!pads.length) { this.running = false; return; }
    for (const gp of pads) this.process(gamepadKey(gp), gp.buttons.map((b) => (typeof b === 'object' ? b.value || (b.pressed ? 1 : 0) : b)), [...gp.axes]);
  }

  /** Handle one snapshot of a pad. buttons: values 0..1, axes: −1..1. Public for tests / e2e. */
  process(key, buttons, axes) {
    const st = this.state.get(key) || { buttons: buttons.map(() => 0), axes: axes.slice() };
    this.state.set(key, st);
    const changed = buttons.some((v, i) => Math.abs(v - (st.buttons[i] ?? 0)) > 0.01) || axes.some((v, i) => Math.abs(v - (st.axes[i] ?? 0)) > 0.02);
    if (changed) this.midi.touch(key);

    const L = this.midi.learning;
    if (L && L.deviceName === key) {
      if (!st.rest || st.rest.target !== L.targetId) st.rest = { target: L.targetId, axes: st.axes.slice() };
      const t = this.midi.byId.get(L.targetId);
      let entry = null;
      const bi = buttons.findIndex((v, i) => v > 0.5 && (st.buttons[i] ?? 0) <= 0.5);
      const ai = axes.findIndex((v, i) => Math.abs(v - (st.rest.axes[i] ?? 0)) > 0.5);
      if (bi >= 0 && (t?.kind === 'button' || ai < 0)) entry = { key: `gp:btn:${bi}`, target: L.targetId };
      else if (ai >= 0) entry = { key: `gp:axis:${ai}`, target: L.targetId, ...(t?.kind === 'abs' ? {} : { mode: 'rate' }), ...(Math.abs(st.rest.axes[ai] + 1) < 0.1 ? { trigger: true } : {}) };
      st.buttons = buttons.slice(); st.axes = axes.slice();
      if (entry) { st.rest = null; this.midi.completeLearn(key, entry); }
      return;
    }
    if (this.midi.suppress === key) { st.buttons = buttons.slice(); st.axes = axes.slice(); return; }
    const map = this.midi.mappings[key];
    if (map) for (const e of map.entries) {
      const [, kind, idxs] = e.key.split(':');
      const i = +idxs;
      const t = this.midi.byId.get(e.target);
      if (!t) continue;
      if (kind === 'btn') {
        const v = buttons[i] ?? 0, old = st.buttons[i] ?? 0;
        if (t.kind === 'button') { if ((v > 0.5) !== (old > 0.5)) this.midi.dispatch(e, v > 0.5 ? 1 : 0); }
        else if (t.kind === 'abs') { if (Math.abs(v - old) > 0.002) this.midi.dispatch(e, v); }
        else if (v > 0.5) this.relStep(e, t, v);
        continue;
      }
      const v = axes[i] ?? 0, old = st.axes[i] ?? 0;
      if (t.kind === 'abs') { if (Math.abs(v - old) > 0.002) this.midi.dispatch(e, clamp((v + 1) / 2, 0, 1)); }
      else if (t.kind === 'button') { if ((Math.abs(v) > 0.5) !== (Math.abs(old) > 0.5)) this.midi.dispatch(e, Math.abs(v) > 0.5 ? 1 : 0); }
      else if (Math.abs(v) > DEAD) this.relStep(e, t, v);
    }
    st.buttons = buttons.slice(); st.axes = axes.slice();
  }
  /** Deflection → steady movement: jog turns ~0.7 rev/s at full tilt, list targets scroll ~15 rows/s. */
  relStep(e, t, v) {
    const speed = (/jog/i.test(t.id) ? 8 : 0.25) * (this._dtScale || 1);
    const a = (this.acc.get(e) || 0) + v * speed;
    const whole = Math.trunc(a);
    this.acc.set(e, a - whole);
    if (whole) this.midi.dispatch(e, whole);
  }
}
