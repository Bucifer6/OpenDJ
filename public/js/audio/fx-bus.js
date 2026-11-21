// Global beat FX units (mixer M9): `fx1` / `fx2` of the controller plan. Each wraps an FxUnit with
//  - an assign: 'off' | 'ch1'..'ch4' (post-fader insert on that channel) | 'master' (before the master limiter)
//    | 'xfA' / 'xfB' (every channel on that crossfader side) — the engine does the routing (Engine.setFxAssign)
//  - FX frequency: Low / Mid / High band toggles; bands that are off bypass the effect dry (isolator split, built
//    only while a band is off)
//  - quantise: on / off land on the next beat division of the master deck's grid
//  - the FX strip: a touch strip that momentarily engages the effect at the touched beat division
import { FxUnit, BEAT_DIVISIONS } from './effects.js';
import { bandSplitter, ISO_XOVER } from './eq.js';

/** Beat divisions on the FX strip, left to right. */
export const STRIP_DIVISIONS = [1 / 4, 1 / 2, 3 / 4, 1, 2, 4];
export const FX_ASSIGNS = ['off', 'ch1', 'ch2', 'ch3', 'ch4', 'master', 'xfA', 'xfB'];
const BANDS = ['low', 'mid', 'high'];

export class FxBus {
  constructor(ctx, index = 0) {
    this.ctx = ctx; this.index = index;
    this.unit = new FxUnit(ctx, { postFader: false });
    this.input = ctx.createGain(); this.output = ctx.createGain();
    this.direct = ctx.createGain();
    this.input.connect(this.direct); this.direct.connect(this.unit.input); this.unit.output.connect(this.output);
    this.assign = 'off'; this.bands = { low: true, mid: true, high: true }; this.quantize = false;
    this.clock = null; this.beatSec = 0.5; this.split = null; this.stripHeld = null;
  }
  get on() { return this.unit.on; }
  get type() { return this.unit.type; }
  setType(t) { this.unit.setType(t); }
  setMix(v) { this.unit.setMix(v); }
  setParam(v) { this.unit.setParam(v); }
  setParam2(v) { this.unit.setParam2(v); }
  setBeats(b) { this.unit.setBeats(b); }
  setBeatSec(s) { this.beatSec = s; this.unit.setBeatSec(s); }
  setClock(beat, at, beatSec) { this.clock = Number.isFinite(beat) ? { beat, at, beatSec } : null; if (beatSec > 0) this.beatSec = beatSec; this.unit.setClock(beat, at, beatSec); }
  /** Audio time of the next beat division boundary on the clock (null when there is no running grid). */
  nextDivision(div = this.unit.beats, now = this.ctx.currentTime) {
    const c = this.clock; if (!c || !(c.beatSec > 0)) return null;
    const beatNow = c.beat + (now - c.at) / c.beatSec, d = Math.max(1 / 16, Math.min(4, div));
    const next = Math.ceil(beatNow / d - 1e-6) * d;
    return c.at + (next - c.beat) * c.beatSec;
  }
  /** On / off; with quantise on (and a running grid) the change lands on the next beat division. */
  setOn(on) {
    const when = this.quantize ? this.nextDivision(Math.min(1, this.unit.beats)) : null;
    this.unit.setOn(on, when || 0);
    return when;
  }
  setQuantize(on) { this.quantize = !!on; }
  /** FX frequency band toggle ('low' | 'mid' | 'high'). Off bands pass dry around the effect. */
  setBand(band, on) {
    if (!BANDS.includes(band)) return;
    this.bands[band] = !!on;
    const all = BANDS.every((b) => this.bands[b]), t = this.ctx.currentTime;
    if (!all && !this.split) {
      const s = bandSplitter(this.ctx, ISO_XOVER, { sum: false });
      this.split = { s, on: [], off: [] };
      this.input.connect(s.input);
      s.bands.forEach((b) => {
        const gOn = this.ctx.createGain(), gOff = this.ctx.createGain(); gOn.gain.value = 0; gOff.gain.value = 0;
        b.connect(gOn); gOn.connect(this.unit.input); b.connect(gOff); gOff.connect(this.output);
        this.split.on.push(gOn); this.split.off.push(gOff);
      });
    }
    if (!this.split) return;
    this.direct.gain.setTargetAtTime(all ? 1 : 0, t, 0.01);
    BANDS.forEach((b, i) => {
      this.split.on[i].gain.setTargetAtTime(all ? 0 : this.bands[b] ? 1 : 0, t, 0.01);
      this.split.off[i].gain.setTargetAtTime(all ? 0 : this.bands[b] ? 0 : 1, t, 0.01);
    });
  }
  /** FX strip: position 0..1 engages the effect at that beat division; null releases it. */
  strip(pos) {
    if (pos == null) {
      if (!this.stripHeld) return;
      const h = this.stripHeld; this.stripHeld = null;
      this.unit.setOn(h.on); this.unit.setBeats(h.beats);
      return;
    }
    const div = STRIP_DIVISIONS[Math.max(0, Math.min(STRIP_DIVISIONS.length - 1, Math.floor(pos * STRIP_DIVISIONS.length)))];
    if (!this.stripHeld) this.stripHeld = { on: this.unit.on, beats: this.unit.beats };
    if (this.unit.beats !== div) this.unit.setBeats(div);
    if (!this.unit.on) this.unit.setOn(true);
    return div;
  }
  /** Beat division as a 0..1 controller value (fx1.time) and back. */
  static divisionFromValue(v) { return BEAT_DIVISIONS[Math.max(0, Math.min(BEAT_DIVISIONS.length - 1, Math.round(v * (BEAT_DIVISIONS.length - 1))))]; }
}
