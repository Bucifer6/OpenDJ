// Audio engine: AudioContext, mixer channel strips, crossfader, master/booth/headphone routing, mic + voice bus,
// global FX units, send/return, recorder tap, analysis worker.
//
// Signal flow (mixer v2; everything after "music bus" is built in Engine.buildGraph, which works on any
// BaseAudioContext so the tests can render the whole mixer offline):
//   channel: trim -> [compressor] -> quick stems -> EQ (type) -> HPF/LPF -> Color FX -> channel FX -> fader -> xf
//            -> (FX unit insert) -> music bus;  pre/post-fader cue A/B, post-fader send, meter
//   music bus -> [voice-band split] -> talkover duck -> program bus (+ sampler, + send return)
//   program bus -> [master FX unit] -> [master isolator] -> [warmth] -> program out -> master bus (+ mic bus)
//   master bus -> master volume -> [balance / mono] -> limiter -> master out -> outputs, meters, headphones,
//                 booth (or its own mic-free mix), record tap (or its own record mix)
// [brackets] = built on first use and inserted with a cross-fade, so unused features cost nothing.
import { Emitter, clamp, dbToGain } from '../util.js';
import { Deck } from './deck.js';
import { FxUnit, createColorFx, createSendFx, loadEffectWorklets } from './effects.js';
import { Sampler } from './sampler.js';
import { createEq, bandSplitter, ISO_XOVER } from './eq.js';
import { isoKnobGain, xfGain, faderGain, rotaryGain, masterIsoGain } from './curves.js';
import { MicStrip } from './mic.js';
import { FxBus } from './fx-bus.js';
import { normalizeMixer } from './mixer-config.js';

const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** EQ knob -1..1 -> band gain: +6 dB at the right, 0 dB at 12 o'clock, -26 dB at 8 o'clock fading to a full kill. */
export const eqKnobGain = isoKnobGain;
/** Filter knob dead zone around 12 o'clock. */
const FILTER_DEAD = 0.03;

/** Value range of each continuous channel control (knobs, faders, MIDI, automation are clamped to it). */
const CHANNEL_LIMITS = { trim: [-1, 1], eqHigh: [-1, 1], eqMid: [-1, 1], eqLow: [-1, 1], eqMidHigh: [-1, 1], eqMidLow: [-1, 1], eqFreq: [0, 1], filter: [-1, 1], filterHp: [0, 1], filterLp: [0, 1], volume: [0, 1], fxMix: [0, 1], fxParam: [0, 1], fxParam2: [0, 1], vocal: [0, 1], inst: [0, 1], comp: [0, 1], send: [0, 1], colorParam: [0, 1] };
const mixerOf = (engine) => engine.mx || normalizeMixer(engine.settings || {});

// ---------------------------------------------------------------- automation helpers
/** Value of a param at time t from our own bookkeeping (linear ramps) or its current value. */
function heldValue(param, st, t) {
  if (st.kind === 'ramp') return t >= st.t1 ? st.v1 : st.v0 + (st.v1 - st.v0) * (t - st.t0) / Math.max(1e-9, st.t1 - st.t0);
  return param.value;
}
/** Linear ramp to v over `dur` seconds from now, starting from wherever the param is (no jump, mid-ramp safe). */
export function rampParam(param, v, ctx, st, dur) {
  const t = ctx.currentTime, cur = heldValue(param, st, t);
  if (st.kind === 'curve' && t <= st.t1 + 0.005) {
    param.cancelScheduledValues(0);
    param.setValueAtTime(cur, t);
  } else {
    param.cancelScheduledValues(t);
    param.setValueAtTime(cur, t);
  }
  param.linearRampToValueAtTime(v, t + Math.max(1e-4, dur));
  st.kind = 'ramp'; st.t0 = t; st.v0 = cur; st.t1 = t + Math.max(1e-4, dur); st.v1 = v;
}
/** Exponential approach (setTargetAtTime), first freezing any of our ramps or curves still running. */
function targetParam(param, v, ctx, st, tc) {
  const t = ctx.currentTime;
  if (st.kind === 'ramp' && t < st.t1) {
    const cur = heldValue(param, st, t);
    param.cancelScheduledValues(t);
    param.setValueAtTime(cur, t);
  } else if (st.kind === 'curve' && t <= st.t1 + 0.005) {
    // Web Audio forbids setTargetAtTime overlapping an active setValueCurveAtTime (even by sub-quantum ε)
    const cur = param.value;
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(t);
    else param.cancelScheduledValues(0);
    param.setValueAtTime(cur, t);
  }
  try {
    param.setTargetAtTime(v, t, tc);
  } catch {
    const cur = param.value;
    param.cancelScheduledValues(0);
    param.setValueAtTime(cur, t);
    param.setTargetAtTime(v, t, tc);
  }
  st.kind = 'target';
}
/** Equal-gain cross-fade between two gains over `dur` (linear ramps). */
function xfade(ctx, from, to, dur = 0.03) {
  const t = ctx.currentTime;
  for (const [g, v] of [[from, 0], [to, 1]]) { if (!g) continue; const cur = g.gain.value; g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(cur, t); g.gain.linearRampToValueAtTime(v, t + dur); }
}

/**
 * Insert slot: in -> dry -> out, plus (once engaged) in -> processor -> wet -> out. engage() / bypass() cross-fade,
 * so processors with phase shift (isolators) or latency can be inserted and removed without clicks.
 */
class Slot {
  constructor(ctx) { this.ctx = ctx; this.in = ctx.createGain(); this.dry = ctx.createGain(); this.out = ctx.createGain(); this.in.connect(this.dry); this.dry.connect(this.out); this.wet = null; this.proc = null; this.engaged = false; }
  attach(input, output) {
    if (this.proc && this.proc.input === input) return;
    this.detach();
    this.wet = this.ctx.createGain(); this.wet.gain.value = 0;
    this.in.connect(input); output.connect(this.wet); this.wet.connect(this.out);
    this.proc = { input, output };
  }
  detach() { if (!this.proc) return; try { this.in.disconnect(this.proc.input); } catch { /* */ } try { this.proc.output.disconnect(this.wet); } catch { /* */ } try { this.wet.disconnect(); } catch { /* */ } this.proc = null; this.wet = null; if (this.engaged) { this.engaged = false; this.dry.gain.cancelScheduledValues(this.ctx.currentTime); this.dry.gain.value = 1; } }
  engage(dur = 0.03) { if (!this.proc || this.engaged) return; this.engaged = true; xfade(this.ctx, this.dry, this.wet, dur); }
  bypass(dur = 0.03) { if (!this.engaged) return; this.engaged = false; xfade(this.ctx, this.wet, this.dry, dur); }
}

export class Channel extends Emitter {
  constructor(engine, index) {
    super();
    const ctx = this.ctx = engine.ctx; this.engine = engine; this.index = index;
    const mx = mixerOf(engine);
    this.trimNode = ctx.createGain();
    this.compDry = ctx.createGain(); this.compNode = null; this.compWet = null;
    const bq = (type, f, q) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
    const chain = (...n) => { n.reduce((a, b) => { a.connect(b); return b; }); return n; };
    // EQ (eq.js): isolator by default (LR8 at 200 Hz / 2.5 kHz, bands sum to a flat all-pass, true kills), or the
    // classic / 4-band / sculpt types; switching types cross-fades the two chains (setEqType)
    this.eqIn = ctx.createGain(); this.eqOut = ctx.createGain(); this.eq = null; this.eqFade = null; this.eqKey = '';
    // one-knob filter: 24 dB/oct resonant low-pass (left) / high-pass (right); parked at 0.98 x Nyquist / 3 Hz
    this.parkLp = ctx.sampleRate * 0.49;
    // (parked just inside the range: the special-case formulas at exactly Nyquist / 0 Hz would click on the way out)
    this.lpf = [bq('lowpass', this.parkLp, -5.33), bq('lowpass', this.parkLp, 2.32)];
    this.hpf = [bq('highpass', 3, -5.33), bq('highpass', 3, 2.32)];
    this.fx = new FxUnit(ctx, { postFader: engine.settings.fxPostFader !== false });
    this.fader = ctx.createGain(); this.xf = ctx.createGain();
    // post-fader FX feed: mirrors of the channel fader and crossfader gains (set together in apply() / setXfGain())
    this.postFader = ctx.createGain(); this.postXf = ctx.createGain();
    this.busOut = ctx.createGain(); this.fxTaps = [];
    // headphone cue: pre-fader (default) or post-fader source, to cue bus A (and B with dual headphones)
    this.cuePre = ctx.createGain(); this.cuePostG = ctx.createGain(); this.cuePostG.gain.value = 0; this.cueSrc = ctx.createGain();
    this.cueSend = ctx.createGain(); this.cueSend.gain.value = 0; this.cueSend2 = null; this.sendG = null;
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 512;
    this.meterBuf = new Float32Array(this.meter.fftSize);
    // Quick stems (DSP): lazily built only when VOCAL or INST is turned down (<1) without AI stems.
    // At default unity (1, 1) the channel bypasses M/S split & 3 biquads completely (zero idle DSP cost, bit-exact).
    this.stemIn = ctx.createGain();
    this.stemOut = ctx.createGain();
    this.stemIn.connect(this.stemOut);
    this._quickStemsBuilt = false;
    this._quickStemsEngaged = false;
    // Color FX: a sound-colour effect whose amount follows the filter knob (rekordbox-style)
    this.colorIn = ctx.createGain(); this.colorDry = ctx.createGain(); this.colorSend = ctx.createGain(); this.colorWet = ctx.createGain();
    this.colorSend.gain.value = 0; this.colorWet.gain.value = 0;
    this.colorOut = ctx.createGain();
    this.colorIn.connect(this.colorDry); this.colorDry.connect(this.colorOut); this.colorIn.connect(this.colorSend); this.colorWet.connect(this.colorOut);
    this.colorOut.connect(this.fx.input); this.colorOut.connect(this.postFader); this.postFader.connect(this.postXf); this.postXf.connect(this.fx.postIn);
    this.colorType = 'filter'; this.colorFx = null; this.colorFade = null;
    this.trimNode.connect(this.compDry); this.compDry.connect(this.stemIn); this.stemOut.connect(this.eqIn);
    chain(this.eqOut, this.hpf[0], this.hpf[1], this.lpf[0], this.lpf[1], this.colorIn);
    this.fx.output.connect(this.fader); this.fx.output.connect(this.cuePre); this.fx.output.connect(this.meter);
    this.fader.connect(this.xf); this.xf.connect(this.busOut); this.busOut.connect(engine.musicBus);
    this._busConnected = true;
    this.fader.connect(this.cuePostG);
    this.cuePre.connect(this.cueSrc); this.cuePostG.connect(this.cueSrc); this.cueSrc.connect(this.cueSend); this.cueSend.connect(engine.cueBus);
    // post-fader FX tails: the wet signal is summed after the faders (silent in pre-fader mode)
    this.fx.wetOut.connect(engine.musicBus); this.fx.wetOut.connect(this.cueSrc); this.fx.wetOut.connect(this.meter);
    this.state = { trim: 0, autoGain: 0, eqHigh: 0, eqMid: 0, eqLow: 0, eqMidHigh: 0, eqMidLow: 0, eqFreq: 0.5, filter: 0, filterHp: 0, filterLp: 0, volume: 0.8, cue: false, cue2: false, cuePost: !!mx.cuePost, faderReverse: false, comp: 0, send: 0, colorParam: 0.5, xfAssign: index % 2 === 0 ? 'A' : 'B', fxOn: false, fxType: 'echo', fxMix: 0.5, fxParam: 0.5, fxParam2: 0.5, fxBeats: 0.5, vocal: 1, inst: 1, colorFx: engine.settings.colorFx || 'filter' };
    this.pst = { fader: {}, postFader: {}, xf: {}, postXf: {} }; // automation bookkeeping per param
    this.setEqType(mx.eqType, false);
    this.setColorFx(this.state.colorFx);
    this.apply();
  }
  set(key, value) {
    const lim = CHANNEL_LIMITS[key];
    if (lim) { value = Number(value); if (!Number.isFinite(value)) return; value = clamp(value, lim[0], lim[1]); } // knobs/MIDI/automation can't overshoot
    if (this.state[key] === value) return;
    this.state[key] = value;
    switch (key) {
      case 'fxOn': this.fx.setOn(value); break;
      case 'fxType': this.fx.setType(value); break;
      case 'fxMix': this.fx.setMix(value); break;
      case 'fxParam': this.fx.setParam(value); break;
      case 'fxParam2': this.fx.setParam2(value); break;
      case 'fxBeats': this.fx.setBeats(value); break;
      case 'colorFx': this.setColorFx(value); break;
      case 'comp': this.setComp(value); break;
      case 'send': this.applySend(); break;
      case 'eqMid': this.state.eqMidHigh = this.state.eqMidLow = value; this.apply(); break; // 4-band: MID drives both mids
      default: this.apply();
    }
    if (key === 'xfAssign') this.engine.applyCrossfader();
    this.emit('change', key, value);
    this.engine.emit('mixer', this.index, key, value);
  }
  /**
   * EQ moves at a future audio time (automix bass swap on the beat, P0.5): the EQ is scheduled now for `at`; until then
   * other updates leave the EQ alone so they can't pull the swap forward.
   */
  scheduleEq(changes, at) {
    const t = this.ctx.currentTime; at = Math.max(t, Number(at) || t);
    const next = { ...this.state };
    for (const [key, v] of Object.entries(changes)) if (CHANNEL_LIMITS[key]) next[key] = clamp(Number(v), ...CHANNEL_LIMITS[key]);
    if (next.eqMid !== this.state.eqMid) next.eqMidHigh = next.eqMidLow = next.eqMid;
    this.eq?.set(next, at, 0.004);
    this._eqHoldUntil = at;
    for (const key of Object.keys(changes)) if (next[key] !== this.state[key]) { this.state[key] = next[key]; this.emit('change', key, next[key]); this.engine.emit('mixer', this.index, key, next[key]); }
    if (next.eqMid !== undefined) { this.state.eqMidHigh = next.eqMidHigh; this.state.eqMidLow = next.eqMidLow; }
  }
  /**
   * Schedule an AudioParam value curve directly on the Web Audio clock (P0.5 full audio-clock automation).
   * Supports 'volume' (fader + postFader), 'eqLow' / 'eqMid' / 'eqHigh' (isolator band gains), and 'filter'.
   * values: array/Float32Array of logical knob/fader values; startAt: audio time (s); dur: seconds (> 0).
   */
  scheduleCurve(key, values, startAt, dur) {
    if (!values || values.length < 2 || !Number.isFinite(dur) || !(dur > 0.005)) return false;
    const t = Math.max(this.ctx.currentTime, Number.isFinite(Number(startAt)) ? Number(startAt) : this.ctx.currentTime);
    const n = values.length;
    const cancel = (param) => {
      if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(t);
      else param.cancelScheduledValues(t);
    };
    if (key === 'volume') {
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = faderGain(clamp(Number.isFinite(values[i]) ? values[i] : 0, 0, 1), 'log');
      try {
        for (const [param, st] of [[this.fader.gain, this.pst.fader], [this.postFader.gain, this.pst.postFader]]) {
          if (typeof param?.setValueCurveAtTime !== 'function') return false;
          cancel(param);
          param.setValueCurveAtTime(curve, t, dur);
          st.kind = 'curve'; st.t0 = t; st.t1 = t + dur; st.v1 = curve[n - 1];
        }
      } catch {
        // Roll back partial scheduling so fader and postFader never diverge
        for (const [param, st] of [[this.fader.gain, this.pst.fader], [this.postFader.gain, this.pst.postFader]]) {
          try { const cur = param.value; param.cancelScheduledValues(0); param.setValueAtTime(cur, t); } catch { /* */ }
          st.kind = 'target';
        }
        return false;
      }
      this._autoHold = this._autoHold || {};
      this._autoHold[key] = t + dur + 0.005;
      return true;
    }
    if ((key === 'eqLow' || key === 'eqMid' || key === 'eqHigh') && this.eq?.bands) {
      const band = this.eq.bands[key === 'eqLow' ? 'low' : key === 'eqMid' ? 'mid' : 'high'];
      if (!band || typeof band.gain?.setValueCurveAtTime !== 'function') return false;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = isoKnobGain(clamp(Number.isFinite(values[i]) ? values[i] : 0, -1, 1));
      try {
        cancel(band.gain);
        band.gain.setValueCurveAtTime(curve, t, dur);
      } catch {
        return false;
      }
      this._autoHold = this._autoHold || {};
      this._autoHold[key] = t + dur;
      return true;
    }
    return false;
  }
  /** Cancel any scheduled audio-clock automation on `key` (called on manual takeover or transition abort). */
  cancelAutomation(key) {
    const t = this.ctx.currentTime;
    if (this._autoHold) delete this._autoHold[key];
    const stop = (param) => {
      if (!param) return;
      try {
        if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(t);
        else if (typeof param.cancelScheduledValues === 'function') { const v = param.value; param.cancelScheduledValues(t); param.setValueAtTime(v, t); }
      } catch { /* ignore if AudioParam not active */ }
    };
    if (key === 'volume') {
      stop(this.fader?.gain);
      stop(this.postFader?.gain);
    } else if ((key === 'eqLow' || key === 'eqMid' || key === 'eqHigh') && this.eq?.bands) {
      const band = this.eq.bands[key === 'eqLow' ? 'low' : key === 'eqMid' ? 'mid' : 'high'];
      stop(band?.gain);
    }
  }
  /** Logical control as set from the UI or a controller: Center Lock applies to the filter knob there (not automix).
   *  Also emits 'user-control' so Automix can release just this lane for manual takeover mid-transition. */
  controlSet(key, value, lock) {
    if (lock && key === 'filter' && mixerOf(this.engine).centerLock) value = lock.filter(value);
    this.cancelAutomation(key);
    this.emit('user-control', key, value);
    this.engine.emit('user-control', this.index, key, value);
    this.set(key, value);
  }

  /** EQ type: builds the new chain, cross-fades 20 ms (equal gain), frees the old one. */
  setEqType(type, fade = true) {
    const mx = mixerOf(this.engine), opts = { killOn: mx.classicKill !== false };
    if (type === 'isolator' && Array.isArray(mx.eqXover) && String(mx.eqXover) !== '200,2500') opts.xover = mx.eqXover; // advanced crossover adjust
    if (this.engine.lowEnd && type === 'fourBand') opts.order = 4; // phones: LR4 fallback
    const key = `${type}|${opts.xover || ''}|${opts.killOn}|${opts.order || 8}`;
    if (key === this.eqKey) return;
    const ctx = this.ctx, t = ctx.currentTime, old = this.eq, oldFade = this.eqFade;
    const eq = createEq(ctx, type, opts), g = ctx.createGain();
    eq.set(this.state, t, 0.0005);
    this.eqIn.connect(eq.input); eq.output.connect(g); g.connect(this.eqOut);
    if (old && fade) {
      // 20 ms: two EQ types have different phase at noon, so a long equal-gain fade would dip the bass while both play
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.02);
      oldFade.gain.cancelScheduledValues(t); oldFade.gain.setValueAtTime(1, t); oldFade.gain.linearRampToValueAtTime(0, t + 0.02);
      setTimeout(() => { try { this.eqIn.disconnect(old.input); } catch { /* */ } try { oldFade.disconnect(); } catch { /* */ } old.dispose(); }, 150);
    } else if (old) { try { this.eqIn.disconnect(old.input); } catch { /* */ } oldFade.disconnect(); old.dispose(); }
    this.eq = eq; this.eqFade = g; this.eqKey = key;
  }
  setColorFx(type) {
    const t = this.ctx.currentTime;
    if (this.colorFx) { // fade the old Color FX out, then free it
      const old = this.colorFx, fade = this.colorFade, send = this.colorSend;
      fade.gain.setTargetAtTime(0, t, 0.012);
      setTimeout(() => { try { send.disconnect(old.input); } catch { /* */ } try { fade.disconnect(); } catch { /* */ } old.dispose(); }, 150);
      this.colorFx = null;
    }
    this.colorType = type;
    this.colorFx = createColorFx(this.ctx, type);
    if (this.colorFx) {
      this.colorFade = this.ctx.createGain();
      this.colorSend.connect(this.colorFx.input); this.colorFx.output.connect(this.colorFade); this.colorFade.connect(this.colorWet);
      this.colorFx.setTempo?.(this.beatSec || 0.5);
    }
    this.apply();
  }
  /** One-knob compressor (M11): built on first use, cross-faded in (identical signal at that moment: seamless). */
  setComp(v) {
    const ctx = this.ctx, t = ctx.currentTime;
    if (v > 0 && !this.compNode && ctx.__opendjFx) {
      try {
        this.compNode = new AudioWorkletNode(ctx, 'opendj-comp', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        this.compNode.port.onmessage = (e) => { this.compGr = e.data.gr; };
        this.compWet = ctx.createGain(); this.compWet.gain.value = 0;
        this.trimNode.connect(this.compNode); this.compNode.connect(this.compWet); this.compWet.connect(this.stemIn);
        xfade(ctx, this.compDry, this.compWet, 0.03);
      } catch (e) { console.warn('compressor unavailable', e); this.compNode = null; }
    }
    this.compNode?.parameters.get('amount').setTargetAtTime(v, t, 0.01);
  }
  /** Post-fader send to the send / return bus (M10). Never into its own return (no feedback loop). */
  applySend() {
    const e = this.engine, v = this.state.send;
    if (v > 0 && !this.sendG && e.sendBus) { this.sendG = this.ctx.createGain(); this.sendG.gain.value = 0; this.xf.connect(this.sendG); this.sendG.connect(e.sendBus); e.ensureSendFx?.(); }
    if (!this.sendG) return;
    const own = mixerOf(e).returnTo === `ch${this.index + 1}`;
    this.sendG.gain.setTargetAtTime(own ? 0 : v * v, this.ctx.currentTime, 0.01);
  }
  /** Divert this channel's post-crossfader signal into global FX unit `bus` (or back to the music bus). */
  divert(bus) {
    const ctx = this.ctx;
    if ((this.divertedTo || null) === (bus || null)) return;
    const prev = this.divertedTo; this.divertedTo = bus;
    let tap = null;
    if (bus) {
      tap = this.fxTaps[bus.index];
      if (!tap) { tap = this.fxTaps[bus.index] = ctx.createGain(); tap.gain.value = 0; this.xf.connect(tap); tap.connect(bus.input); }
    }
    const prevTap = prev ? this.fxTaps[prev.index] : this.busOut;
    xfade(ctx, prevTap, tap || this.busOut, 0.012);
  }
  /** Tempo / beat grid of this channel's deck, for the beat FX and tempo-synced Color FX. */
  setBeatSec(s) { this.beatSec = s; this.fx.setBeatSec(s); this.colorFx?.setTempo?.(s); }
  setClock(beat, at, beatSec) { this.fx.setClock(beat, at, beatSec); this.colorFx?.setClock?.(beat, at, beatSec); }
  setAutoGain(db) { this.state.autoGain = db; this.apply(); }
  /** Crossfader gain of this channel (engine.applyCrossfader): a linear ramp over the cut time (M1 fast cut). */
  setXfGain(g) {
    const ms = mixerOf(this.engine).xfCutTime ?? 5;
    rampParam(this.xf.gain, g, this.ctx, this.pst.xf, ms / 1000); rampParam(this.postXf.gain, g, this.ctx, this.pst.postXf, ms / 1000);
  }
  /** Beat FX tails after the channel fader (default) or the whole FX unit before it. */
  setFxPostFader(on) { this.fx.setPostFader(on); }
  /** AI stems loaded on this channel's deck: VOC / INST then drive the stems and the DSP quick-stems chain is bypassed. */
  setAiStems(on) { if (this.aiStems === !!on) return; this.aiStems = !!on; this.apply(); this.emit('change', 'aiStems', this.aiStems); }
  /** Channel level gain for the current fader law (M2 curves, M17 rotary taper; automix always uses the club law). */
  faderTarget() {
    const mx = mixerOf(this.engine), v = this.state.volume;
    if (this.engine.automixDriving) return faderGain(v, 'log');
    if (mx.rotary) return rotaryGain(this.state.faderReverse ? 1 - v : v);
    return faderGain(v, mx.faderCurve, this.state.faderReverse);
  }
  /** Personality switch: glide the fader gain to the new law over `sec` (never an abrupt level change). */
  glideFader(sec = 2.5) {
    const g = this.faderTarget(); this._fg = g;
    rampParam(this.fader.gain, g, this.ctx, this.pst.fader, sec); rampParam(this.postFader.gain, g, this.ctx, this.pst.postFader, sec);
  }
  apply() {
    const s = this.state, t = this.ctx.currentTime, k = 0.012, mx = mixerOf(this.engine);
    this.trimNode.gain.setTargetAtTime(dbToGain(s.trim * 12 + s.autoGain), t, k);
    if (!(this._eqHoldUntil > t) && !(this._autoHold && (this._autoHold.eqLow > t || this._autoHold.eqMid > t || this._autoHold.eqHigh > t))) this.eq?.set(s, t, k); // (a scheduled swap/curve is pending)
    const db = (v) => 20 * Math.log10(Math.max(0.01, v));
    // AI stems (deck worklet) when the track has them, else lazy DSP "quick stems" (built only when VOC/INST < 1)
    const ai = !!this.aiStems, vocal = ai ? 1 : s.vocal, inst = ai ? 1 : s.inst;
    this.engine.decks?.[this.index]?.applyStemMacro?.(ai ? s.vocal : 1, ai ? s.inst : 1);
    const wantQuick = vocal < 0.999 || inst < 0.999;
    if (wantQuick && !this._quickStemsBuilt) this._ensureQuickStems();
    if (this._quickStemsBuilt) {
      this.vocBand.gain.setTargetAtTime(db(vocal) - (inst < 1 ? db(inst) * 0.6 : 0), t, k);
      this.instLow.gain.setTargetAtTime(db(inst), t, k);
      this.instHigh.gain.setTargetAtTime(db(inst), t, k);
      this.sideGain.gain.setTargetAtTime(inst, t, k);
    }
    // Color FX amount follows the filter knob (dead zone at 12 o'clock); the channel filter is gentler in colour modes
    const side = s.filter < 0 ? -1 : 1, x = Math.max(0, (Math.abs(s.filter) - FILTER_DEAD) / (1 - FILTER_DEAD));
    const cfx = this.colorFx;
    if (cfx) {
      cfx.setColor(x, side, s.colorParam ?? 0.5);
      if (cfx.kind === 'send') { this.colorSend.gain.setTargetAtTime(cfx.sendAmount(x), t, k); this.colorWet.gain.setTargetAtTime(1, t, k); this.colorDry.gain.setTargetAtTime(1, t, k); }
      else if (cfx.kind === 'insert') { const w = x > 0 ? cfx.wetAmount(x) : 0; this.colorSend.gain.setTargetAtTime(1, t, k); this.colorWet.gain.setTargetAtTime(w, t, k); this.colorDry.gain.setTargetAtTime(1 - w, t, k); }
      else { this.colorSend.gain.setTargetAtTime(0, t, k); this.colorWet.gain.setTargetAtTime(1, t, k); this.colorDry.gain.setTargetAtTime(1, t, k); }
      this.colorFade?.gain.setTargetAtTime(1, t, 0.012);
    } else { this.colorDry.gain.setTargetAtTime(1, t, k); this.colorWet.gain.setTargetAtTime(0, t, k); this.colorSend.gain.setTargetAtTime(0, t, k); }
    const dry = x * (cfx ? cfx.dryFilter : 1);
    if (mx.filterMode === 'dual') this.applyDualFilter(Math.max(s.filterHp, side > 0 ? dry : 0), Math.max(s.filterLp, side < 0 ? dry : 0), t);
    else this.applyFilter(dry, side, t, s.colorParam ?? 0.5);
    // channel fader: today's 5 ms smoothing; the cut curve uses the fast-cut ramp, the rotary knob a heavy 30 ms
    const g = this.faderTarget();
    if (g !== this._fg && !this.engine._holdFader && !(this._autoHold?.volume > t)) { // (a personality switch glides / audio-clock curve owns it)
      this._fg = g;
      const auto = this.engine.automixDriving, curve = auto ? 'log' : mx.faderCurve;
      if (curve === 'cut' && !mx.rotary) { const d = (mx.xfCutTime ?? 5) / 1000; rampParam(this.fader.gain, g, this.ctx, this.pst.fader, d); rampParam(this.postFader.gain, g, this.ctx, this.pst.postFader, d); }
      else { const tc = mx.rotary && !auto ? 0.03 : 0.005; targetParam(this.fader.gain, g, this.ctx, this.pst.fader, tc); targetParam(this.postFader.gain, g, this.ctx, this.pst.postFader, tc); }
    }
    this.cueSend.gain.setTargetAtTime(s.cue ? 1 : 0, t, 0.005);
    const post = !!s.cuePost;
    this.cuePre.gain.setTargetAtTime(post ? 0 : 1, t, 0.005); this.cuePostG.gain.setTargetAtTime(post ? 1 : 0, t, 0.005);
    if (s.cue2 && !this.cueSend2 && this.engine.cueBus2) { this.cueSend2 = this.ctx.createGain(); this.cueSend2.gain.value = 0; this.cueSrc.connect(this.cueSend2); this.cueSend2.connect(this.engine.cueBus2); }
    this.cueSend2?.gain.setTargetAtTime(s.cue2 ? 1 : 0, t, 0.005);
  }
  /** Build the M/S quick-stems biquad graph on first use (saves 3 biquads + splitter/merger per channel when unused). */
  _ensureQuickStems() {
    if (this._quickStemsBuilt) return;
    this._quickStemsBuilt = true;
    const ctx = this.ctx;
    try { this.stemIn.disconnect(this.stemOut); } catch { /* */ }
    const split = ctx.createChannelSplitter(2);
    const mid = ctx.createGain(), side = ctx.createGain();
    for (const n of [mid, side]) { n.channelCount = 1; n.channelCountMode = 'explicit'; }
    const lM = ctx.createGain(), rM = ctx.createGain(), lS = ctx.createGain(), rS = ctx.createGain();
    lM.gain.value = 0.5; rM.gain.value = 0.5; lS.gain.value = 0.5; rS.gain.value = -0.5;
    this.stemIn.connect(split);
    split.connect(lM, 0); split.connect(rM, 1); split.connect(lS, 0); split.connect(rS, 1);
    lM.connect(mid); rM.connect(mid); lS.connect(side); rS.connect(side);
    this.instLow = ctx.createBiquadFilter(); this.instLow.type = 'lowshelf'; this.instLow.frequency.value = 220;
    this.instHigh = ctx.createBiquadFilter(); this.instHigh.type = 'highshelf'; this.instHigh.frequency.value = 5000;
    this.vocBand = ctx.createBiquadFilter(); this.vocBand.type = 'peaking'; this.vocBand.frequency.value = 1100; this.vocBand.Q.value = 0.45;
    this.sideGain = ctx.createGain();
    const sideNeg = ctx.createGain(); sideNeg.gain.value = -1;
    mid.connect(this.instLow); this.instLow.connect(this.instHigh); this.instHigh.connect(this.vocBand);
    side.connect(this.sideGain); this.sideGain.connect(sideNeg);
    const merge = ctx.createChannelMerger(2);
    this.vocBand.connect(merge, 0, 0); this.vocBand.connect(merge, 0, 1);
    this.sideGain.connect(merge, 0, 0); sideNeg.connect(merge, 0, 1);
    merge.connect(this.stemOut);
  }
  /** Connect or disconnect this channel's output from the music bus so unloaded hidden decks (3/4 in 2-deck mode) cost 0 DSP. */
  setActive(on) {
    on = !!on;
    if (this._busConnected === on) return;
    this._busConnected = on;
    try {
      if (on) { this.busOut.connect(this.engine.musicBus); this.fx.wetOut.connect(this.engine.musicBus); }
      else { this.busOut.disconnect(this.engine.musicBus); this.fx.wetOut.disconnect(this.engine.musicBus); }
    } catch { /* already connected/disconnected */ }
  }
  /** One-knob filter: amount x (0..1, dead zone removed), side -1 = low-pass, +1 = high-pass. */
  applyFilter(x, side, t, param = 0.5) {
    const k = 0.012;
    const lpOn = x > 0 && side < 0, hpOn = x > 0 && side > 0;
    // exponential sweeps: LPF 18 kHz -> 70 Hz (1.1 kHz half way), HPF 20 Hz -> 8 kHz (400 Hz half way); parked
    // filters are inaudible (flat to < 0.01 dB)
    const lpF = lpOn ? Math.min(this.parkLp, 18000 * Math.pow(70 / 18000, x)) : this.parkLp;
    const hpF = hpOn ? 20 * Math.pow(8000 / 20, x) : 3;
    // resonance fades in over the first 20 % of travel (no jump out of the dead zone), eases off at the extremes
    const res = smoothstep(0, 0.2, x) * (1 - 0.35 * smoothstep(0.8, 1, x));
    const q2 = 2.32 + 4.2 * res * (0.2 + 1.6 * param); // dB: Butterworth 2nd stage (+2.3 dB) up to ~+6.5 dB resonant peak (PARAMETER 0.5)
    for (const f of this.lpf) f.frequency.setTargetAtTime(lpF, t, k);
    for (const f of this.hpf) f.frequency.setTargetAtTime(hpF, t, k);
    this.lpf[1].Q.setTargetAtTime(lpOn ? q2 : 2.32, t, k); this.hpf[1].Q.setTargetAtTime(hpOn ? q2 : 2.32, t, k);
  }
  /** Dual filter mode (M4): separate cut-only HPF (20 Hz -> 2 kHz) and LPF (20 kHz -> 300 Hz), Butterworth, no resonance. */
  applyDualFilter(hp, lp, t) {
    const k = 0.012;
    const hpF = hp > 0 ? 20 * Math.pow(100, hp) : 3, lpF = lp > 0 ? Math.min(this.parkLp, 20000 * Math.pow(300 / 20000, lp)) : this.parkLp;
    for (const f of this.hpf) f.frequency.setTargetAtTime(hpF, t, k);
    for (const f of this.lpf) f.frequency.setTargetAtTime(lpF, t, k);
    this.lpf[1].Q.setTargetAtTime(2.32, t, k); this.hpf[1].Q.setTargetAtTime(2.32, t, k);
  }
  level() {
    this.meter.getFloatTimeDomainData(this.meterBuf);
    let p = 0; for (const v of this.meterBuf) { const a = Math.abs(v); if (a > p) p = a; }
    return p;
  }
  /** Per-band levels (low < 200 Hz < mid < 2.5 kHz < high) for the advanced drawer; the analyser exists only while asked for. */
  bandLevels(on = true) {
    if (!on) { if (this.bandAn) { try { this.fx.output.disconnect(this.bandAn); } catch { /* */ } this.bandAn = null; } return null; }
    if (!this.bandAn) { this.bandAn = this.ctx.createAnalyser(); this.bandAn.fftSize = 2048; this.bandAn.smoothingTimeConstant = 0.5; this.bandBuf = new Float32Array(1024); this.fx.output.connect(this.bandAn); }
    this.bandAn.getFloatFrequencyData(this.bandBuf);
    const hz = this.ctx.sampleRate / 2048, sum = [0, 0, 0];
    for (let i = 1; i < 1024; i++) { const f = i * hz, p = Math.pow(10, this.bandBuf[i] / 10); sum[f < ISO_XOVER[0] ? 0 : f < ISO_XOVER[1] ? 1 : 2] += p; }
    return sum.map((p) => Math.sqrt(p) * 2 / 1024 * 8);
  }
}

/**
 * Master limiter: look-ahead brickwall (fx-worklets.js opendj-limiter), -1 dBFS ceiling, transparent below it.
 * Falls back to a DynamicsCompressor + hard clip where AudioWorklets are missing.
 */
export function createLimiter(ctx, { ceiling = -1 } = {}) {
  if (ctx.__opendjFx) {
    const node = new AudioWorkletNode(ctx, 'opendj-limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    node.parameters.get('ceiling').value = ceiling;
    const lim = { input: node, output: node, node, gainReduction: 1, setEnabled: (on) => { node.parameters.get('enabled').value = on ? 1 : 0; }, setCeiling: (db) => { node.parameters.get('ceiling').setTargetAtTime(db, ctx.currentTime, 0.02); } };
    node.port.onmessage = (e) => { lim.gainReduction = e.data.gr; };
    return lim;
  }
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = ceiling - 2; c.knee.value = 2; c.ratio.value = 20; c.attack.value = 0.001; c.release.value = 0.1;
  const clip = ctx.createWaveShaper(); const cv = new Float32Array(1025), m = dbToGain(ceiling);
  for (let i = 0; i < cv.length; i++) { const x = (i / 1024) * 2 - 1; cv[i] = Math.max(-m, Math.min(m, x)); }
  clip.curve = cv; c.connect(clip);
  const out = ctx.createGain(), bypass = ctx.createGain(), wet = ctx.createGain(), input = ctx.createGain();
  input.connect(c); clip.connect(wet); wet.connect(out); input.connect(bypass); bypass.connect(out); bypass.gain.value = 0;
  return { input, output: out, setCeiling: (db) => { c.threshold.value = db - 2; }, setEnabled: (on) => { wet.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.01); bypass.gain.setTargetAtTime(on ? 0 : 1, ctx.currentTime, 0.01); } };
}

export class Engine extends Emitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.decks = []; this.channels = [];
    this.crossfader = 0; // -1 (A) .. 1 (B)
    this.master = null;
    this._analysisId = 0; this._analysisCb = new Map();
    // mixer v2 knob state (not persisted, like the master volume)
    this.boothVolume = 0.8; this.boothEq = { high: 0, low: 0 }; this.iso = { low: 0, mid: 0, high: 0 }; this.isoOn = true;
    this.warmth = 0; this.balance = 0; this.recLevelDb = 0; this.returnLevel = 0.7; this.hp2Volume = 0.8; this.hp2CueMix = 0;
    this.masterCue = false; this.samplerCue = false; this.micEq = { low: 0, mid: 0, high: 0 }; this.micFxLevel = 0.5; this.micFxOn = false; this.sendOn = true;
    this.automixDriving = false; this.lowEnd = false; this.fxBuses = [];
  }
  /** Mixer configuration (settings.mixer with defaults; legacy crossfaderCurve migrated). */
  get mx() {
    const s = this.settings || {};
    if (s.mixer !== this._mxFor || s.crossfaderCurve !== this._mxLegacy || !this._mx) { this._mx = normalizeMixer(s); this._mxFor = s.mixer; this._mxLegacy = s.crossfaderCurve; }
    return this._mx;
  }

  async init() {
    const lh = this.settings.latencyHint || 'interactive';
    try { this.ctx = new AudioContext({ latencyHint: /^\d/.test(lh) ? Number(lh) / 1000 : lh }); }
    catch (e) { console.warn(`Invalid audio latency setting (${lh}); using the default`, e); this.ctx = new AudioContext(); } // never brick startup
    await this.ctx.audioWorklet.addModule(new URL('./worklets.js', import.meta.url));
    await loadEffectWorklets(this.ctx).catch((e) => console.warn('Effect worklets unavailable', e));
    // phones / small tablets: lighter EQ fallbacks (4-band as LR4)
    this.lowEnd = typeof navigator !== 'undefined' && ((navigator.hardwareConcurrency || 8) <= 4 || /Android|iPhone|iPad/i.test(navigator.userAgent || ''));
    this.buildGraph();
    this.worker = null; // lazily spawned on first analyze() and terminated when idle (saves ~25-35 MB RAM)
    this._workerIdleT = null;
    await this.applyOutputs();
    // Drive engine ticks at ~30 Hz only while playing / scratching / automixing; sleep when completely idle
    let lastTick = 0;
    const isBusy = () => this.automixDriving || this.decks.some((d) => d.playing || d.scratching || d.loading);
    const tick = (now = performance.now()) => {
      this._raf = 0;
      if (document.hidden) return;
      const busy = isBusy();
      if (busy) this._raf = requestAnimationFrame(tick);
      if (busy && now - lastTick < 32) return;
      lastTick = now;
      this.tick();
    };
    this._wakeTick = () => { if (!this._raf && !document.hidden) this._raf = requestAnimationFrame(tick); };
    for (const d of this.decks) { d.on('state', this._wakeTick); d.on('load', this._wakeTick); }
    document.addEventListener('visibilitychange', () => { if (!document.hidden && isBusy()) this._wakeTick(); });
    this.tick();
    setInterval(() => {
      if (!isBusy()) return;
      if (document.hidden) this.tick();
      else this._wakeTick();
    }, 50); // keep automix/sync alive when hidden and wake rAF if automixDriving starts externally
  }

  /** Build the mixer graph on this.ctx (also used offline by the tests with { decks: false }). */
  buildGraph({ decks = true } = {}) {
    const ctx = this.ctx, mx = this.mx;
    this._offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
    this.masterBus = ctx.createGain();
    this.musicBus = ctx.createGain(); this.duck = ctx.createGain();
    this.voiceSlot = new Slot(ctx); // [voice-band split for the "advanced" talkover]
    this.musicBus.connect(this.voiceSlot.in); this.voiceSlot.out.connect(this.duck);
    this.programBus = ctx.createGain(); this.programOut = ctx.createGain();
    this.duck.connect(this.programBus);
    this.slotFx = new Slot(ctx); this.slotIso = new Slot(ctx); this.slotWarm = new Slot(ctx);
    this.programBus.connect(this.slotFx.in); this.slotFx.out.connect(this.slotIso.in); this.slotIso.out.connect(this.slotWarm.in); this.slotWarm.out.connect(this.programOut);
    this.programOut.connect(this.masterBus);
    this.micBus = ctx.createGain(); this.micBus.connect(this.masterBus);
    this.cueBus = ctx.createGain();
    this.sendBus = ctx.createGain();
    this.masterGain = ctx.createGain(); this.masterGain.gain.value = 0.8;
    this.stereoSlot = new Slot(ctx); // [balance / mono]
    this.limiter = createLimiter(ctx, { ceiling: mx.limiterCeiling });
    this.masterOut = ctx.createGain();
    this.masterMeterL = ctx.createAnalyser(); this.masterMeterR = ctx.createAnalyser();
    this.masterMeterL.fftSize = this.masterMeterR.fftSize = 512;
    const split = ctx.createChannelSplitter(2);
    this.masterBus.connect(this.masterGain); this.masterGain.connect(this.stereoSlot.in); this.stereoSlot.out.connect(this.limiter.input); this.limiter.output.connect(this.masterOut);
    this.setLimiter(this.settings.limiter !== false);
    this.masterOut.connect(split); split.connect(this.masterMeterL, 0); split.connect(this.masterMeterR, 1);
    // output ports: applyOutputs() only re-wires these, internal taps on masterOut stay connected
    this.portMaster = ctx.createGain(); this.masterOut.connect(this.portMaster);
    // headphones: blend of cue bus and master; CUE MST puts the master into the cue bus too
    this.hpCue = ctx.createGain(); this.hpMaster = ctx.createGain(); this.hpOut = ctx.createGain(); this.portHp = ctx.createGain();
    this.cueBus.connect(this.hpCue); this.masterOut.connect(this.hpMaster);
    this.hpCue.connect(this.hpOut); this.hpMaster.connect(this.hpOut); this.hpOut.connect(this.portHp);
    this.masterCueG = ctx.createGain(); this.masterCueG.gain.value = 0; this.masterOut.connect(this.masterCueG); this.masterCueG.connect(this.cueBus);
    this.setCueMix(0); this.hpOut.gain.value = 0.8;
    // record tap (M15): the master by default, or a separate record mix (mic excluded / record level)
    this.recTap = ctx.createGain(); this.recFromMaster = ctx.createGain(); this.masterOut.connect(this.recFromMaster); this.recFromMaster.connect(this.recTap);
    // sampler -> program bus (pre-volume tap for sampler cue)
    this.sampler = new Sampler(ctx, this.programBus, this.settings.sampler || {});
    this.samplerCueG = ctx.createGain(); this.samplerCueG.gain.value = 0; (this.sampler.pre || this.sampler.out).connect(this.samplerCueG); this.samplerCueG.connect(this.cueBus);
    // pads set to "sync to beat" start on the master deck's next beat
    this.sampler.nextBeat = () => {
      const m = this.masterDeck();
      if (!m?.playing || !m.bpm || !m.rate) return null;
      const ph = m.beatPhase();
      if (ph < 0.04) return null; // just on the beat: play now
      return this.ctx.currentTime + ((1 - ph) * m.beatLen) / m.rate;
    };
    for (let i = 0; i < 4; i++) {
      const ch = new Channel(this, i); this.channels.push(ch);
      if (decks) {
        const d = new Deck(this, i); this.decks.push(d);
        d.node.connect(ch.trimNode);
        d.tempoRange = this.settings.tempoRange || 8;
        d.keyLock = this.settings.keyLockDefault !== false;
        d.quantize = this.settings.quantize !== false;
      }
    }
    this.applyCrossfader();
    this.applyMixerConfig(true);
  }

  /** React to settings.mixer changes (EQ type, filter mode, curves, routes, ...); call after updating the setting. */
  applyMixerConfig(initial = false) {
    const mx = this.mx, prev = initial ? {} : (this._mxApplied || {});
    const changed = (...k) => k.some((x) => JSON.stringify(mx[x]) !== JSON.stringify(prev[x]));
    if (!initial && changed('eqType', 'eqXover', 'classicKill')) for (const ch of this.channels) ch.setEqType(mx.eqType);
    if (!initial && changed('filterMode', 'faderCurve', 'rotary', 'cuePost', 'xfCutTime')) for (const ch of this.channels) { if (changed('cuePost')) ch.state.cuePost = !!mx.cuePost; ch.apply(); }
    if (!initial && changed('xfCurve', 'xfCutIn', 'xfReverse', 'xfCutTime')) this.applyCrossfader();
    if (!initial && changed('limiterCeiling')) for (const l of [this.limiter, this.booth?.lim, this.rec?.lim]) l?.setCeiling?.(mx.limiterCeiling);
    if (changed('mono')) this.applyStereo();
    if (changed('talkoverMode', 'talkoverThreshold')) this.applyTalkoverMode();
    if (changed('micToBooth') && this.booth) this.applyBoothSource();
    if (changed('micToRecord')) this.applyRecRouting();
    if (!initial && changed('masterIsoXover') && this.isoNode) { this.slotIso.detach(); this.isoNode.dispose(); this.isoNode = null; this.applyIso(); }
    if (!initial && changed('masterIsoBoost')) this.applyIso();
    if (changed('micFx')) this.mic?.setFxType(mx.micFx);
    if (changed('feedbackReducer')) this.mic?.setFeedbackReducer(mx.feedbackReducer);
    if (!initial && changed('sendType') && this.sendFx) this.buildSendFx();
    if (!initial && changed('returnTo')) { this.routeReturn(); for (const ch of this.channels) ch.applySend(); }
    for (const u of [0, 1]) {
      const k = `fx${u + 1}`, c = mx[k];
      if (!changed(k)) continue;
      if (c.assign !== 'off' || this.fxBuses[u]) { const b = this.fxBus(u); b.setType(c.type); b.setQuantize(c.quantize); if (b.assign !== c.assign) this.setFxAssign(u, c.assign); }
    }
    if (!initial && changed('boothRoute', 'boothDeviceId', 'hp2Route', 'hp2DeviceId')) this.applyOutputs();
    this._mxApplied = { ...mx };
    this.emit('mixer-config');
  }

  // ---------- microphone / aux input with talkover ----------
  ensureMic() {
    if (this.mic) return this.mic;
    this.mic = new MicStrip(this.ctx);
    this.mic.output.connect(this.micBus);
    const mx = this.mx;
    this.mic.setFxType(mx.micFx); this.mic.setFxLevel(this.micFxLevel);
    for (const b of ['low', 'mid', 'high']) this.mic.setEq(b, this.micEq[b]);
    if (this.micVolume != null) this.mic.setVolume(this.micVolume);
    if (mx.feedbackReducer) this.mic.setFeedbackReducer(true);
    this.mic.setTempo(this._beatSec || 0.5);
    this.micMeter = this.mic.meter; this.micGain = this.mic.level;
    return this.mic;
  }
  async setMic(on) {
    if (!on) {
      this.micStream?.getTracks().forEach((t) => t.stop()); this.micStream = null;
      try { this.micSrc?.disconnect(); } catch { /* */ }
      this.micOn = false; this.setTalkover(false); this.emit('mic'); return;
    }
    const id = this.settings.micDeviceId;
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    this.ensureMic();
    this.micSrc = this.ctx.createMediaStreamSource(this.micStream);
    this.micSrc.connect(this.mic.input);
    this.micOn = true; this.emit('mic');
  }
  setMicVolume(v) { v = clamp(Number(v) || 0, 0, 1); this.micVolume = v; this.mic?.setVolume(v); this.emit('master', 'micVolume', v); }
  /** Mic EQ: band 'low' | 'mid' | 'high', v -1..1 (±12 dB). */
  setMicEq(band, v) { if (!(band in this.micEq)) return; this.micEq[band] = clamp(Number(v) || 0, -1, 1); this.mic?.setEq(band, this.micEq[band]); this.emit('master', `micEq.${band}`, v); }
  setMicFx(on) { this.micFxOn = !!on; this.ensureMic().setFx(this.micFxOn); this.emit('master', 'micFx', this.micFxOn); }
  setMicFxLevel(v) { this.micFxLevel = clamp(Number(v) || 0, 0, 1); this.mic?.setFxLevel(this.micFxLevel); this.emit('master', 'micFxLevel', v); }
  setTalkover(on) {
    this.talkover = on;
    if (this.ducker) this.ducker.parameters.get('manual').value = on ? 1 : 0;
    else {
      const db = this.settings.talkoverDb ?? -12;
      this.duck.gain.setTargetAtTime(on ? Math.pow(10, db / 20) : 1, this.ctx.currentTime, on ? 0.05 : 0.25);
    }
    this.emit('master', 'talkover', on);
  }
  /** Talkover depth in dB (the old fixed settings.talkoverDb; the knob writes the same setting). */
  applyTalkoverDepth() { const db = this.settings.talkoverDb ?? -12; if (this.ducker) this.ducker.parameters.get('depth').value = db; else if (this.talkover) this.setTalkover(true); }
  /**
   * Talkover mode (M8): 'manual' (TALK button, today's), 'auto' (the voice opens the duck) or 'advanced' (auto, and only
   * the music's voice band 300 Hz - 5 kHz is ducked so the bass keeps going). Auto modes use the opendj-ducker follower
   * on the mic bus, so the MC / text-to-speech voice on the voice bus triggers it too.
   */
  applyTalkoverMode() {
    const mx = this.mx, mode = mx.talkoverMode;
    if (mode === 'manual' && !this.ducker) return;
    if (!this.ducker && this.ctx.__opendjFx) {
      try {
        const d = this.ducker = new AudioWorkletNode(this.ctx, 'opendj-ducker', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        d.port.onmessage = (e) => { this.ducking = e.data.ducking; this.emit('master', 'ducking', this.ducking); };
        this.micBus.connect(d);
        const sp = this.ctx.createChannelSplitter(2); d.connect(sp);
        this.duck.gain.cancelScheduledValues(this.ctx.currentTime); this.duck.gain.setValueAtTime(1, this.ctx.currentTime);
        sp.connect(this.duck.gain, 0); this.duckSplit = sp;
      } catch (e) { console.warn('auto talkover unavailable', e); this.ducker = null; return; }
    }
    if (!this.ducker) return;
    const P = (k) => this.ducker.parameters.get(k);
    P('auto').value = mode === 'manual' ? 0 : 1; P('band').value = mode === 'advanced' ? 1 : 0;
    P('threshold').value = mx.talkoverThreshold; P('depth').value = this.settings.talkoverDb ?? -12; P('manual').value = this.talkover ? 1 : 0;
    if (mode === 'advanced' && !this.voiceSplit) {
      this.voiceSplit = bandSplitter(this.ctx, [300, 5000], { order: 4 });
      this.voiceSlot.attach(this.voiceSplit.input, this.voiceSplit.output);
      this.duckSplit.connect(this.voiceSplit.bands[1].gain, 1);
    }
    if (mode === 'advanced') this.voiceSlot.engage(); else this.voiceSlot.bypass();
  }
  micLevel() { if (!this.micOn || !this.mic) return 0; return this.mic.level01(); }

  // ---------- voice bus: the MC / text-to-speech voice joins the mic bus ----------
  /**
   * Voice bus input for spoken audio that is not the mic (MC voice, text-to-speech, dedications). Whatever is connected
   * here is mixed like the mic: into the master (before the limiter, after the master isolator), the booth when "mic
   * in booth" is on, the recording when "mic in recording" is on, and it triggers auto talkover. Returns the GainNode.
   */
  voiceInput() {
    if (!this.voiceIn) { this.voiceIn = this.ctx.createGain(); this.voiceIn.connect(this.micBus); }
    return this.voiceIn;
  }

  resume() { if (this.ctx.state !== 'running') return this.ctx.resume(); }

  analyze(mono, sampleRate) {
    clearTimeout(this._workerIdleT);
    if (!this.worker) {
      this.worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const cb = this._analysisCb.get(e.data.id); this._analysisCb.delete(e.data.id); cb?.(e.data);
        if (this._analysisCb.size === 0) {
          clearTimeout(this._workerIdleT);
          this._workerIdleT = setTimeout(() => { if (this._analysisCb.size === 0 && this.worker) { this.worker.terminate(); this.worker = null; } }, 30_000);
        }
      };
    }
    return new Promise((resolve, reject) => {
      const id = ++this._analysisId;
      this._analysisCb.set(id, (d) => (d.error ? reject(new Error(d.error)) : resolve(d)));
      this.worker.postMessage({ id, mono, sampleRate }, [mono.buffer]);
    });
  }

  // ---------- master / outputs ----------
  /** The limiter stays in the signal path (constant latency); off = unity gain, so toggling never clicks. */
  setLimiter(on) { this.limiter.setEnabled(on); }
  /** Post-fader beat FX tails (settings.fxPostFader, default on) for every channel. */
  setFxPostFader(on) { for (const ch of this.channels) ch.setFxPostFader(on); }
  setMasterVolume(v) {
    v = clamp(Number(v) || 0, 0, 1); this.masterVolume = v; const g = v * v * 1.25, t = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(g, t, 0.01);
    for (const m of [this.booth?.mg, this.rec?.mg]) m?.gain.setTargetAtTime(g, t, 0.01); // mirrors in the mic-free mixes
    this.emit('master', 'volume', v);
  }
  setCueMix(v) { v = clamp(Number(v) || 0, 0, 1); this.cueMix = v; this.hpCue.gain.value = Math.cos(v * Math.PI / 2); this.hpMaster.gain.value = Math.sin(v * Math.PI / 2); this.emit('master', 'cueMix', v); }
  setHeadphoneVolume(v) { v = clamp(Number(v) || 0, 0, 1); this.hpVolume = v; this.hpOut.gain.setTargetAtTime(v * v * 1.25, this.ctx.currentTime, 0.01); this.emit('master', 'hpVolume', v); }
  /** CUE MST: the master into the headphone cue bus (M7). */
  setMasterCue(on) { this.masterCue = !!on; this.masterCueG.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01); this.emit('master', 'masterCue', this.masterCue); }
  /** Sampler cue: pads into the headphones, before the sampler volume (M7). */
  setSamplerCue(on) { this.samplerCue = !!on; this.samplerCueG.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01); this.emit('master', 'samplerCue', this.samplerCue); }
  /** Limiter gain reduction (1 = none), as posted by the limiter worklet about 12x a second. */
  limiterGr() { return this.limiter.gainReduction ?? 1; }

  // ---------- balance / mono (M13) ----------
  setBalance(v) { this.balance = clamp(Number(v) || 0, -1, 1); this.applyStereo(); this.emit('master', 'balance', this.balance); }
  applyStereo() {
    const mono = !!this.mx.mono, b = this.balance || 0;
    if (!mono && !b && !this.stereo) return;
    const c = this.ctx;
    if (!this.stereo) {
      const sp = c.createChannelSplitter(2), mg = c.createChannelMerger(2), input = c.createGain(), output = c.createGain();
      const g = { LL: c.createGain(), LR: c.createGain(), RL: c.createGain(), RR: c.createGain() };
      input.connect(sp); sp.connect(g.LL, 0); sp.connect(g.RL, 0); sp.connect(g.LR, 1); sp.connect(g.RR, 1);
      g.LL.connect(mg, 0, 0); g.LR.connect(mg, 0, 0); g.RL.connect(mg, 0, 1); g.RR.connect(mg, 0, 1); mg.connect(output);
      this.stereo = { input, output, g };
      this.stereoSlot.attach(input, output);
    }
    const m = mono ? 0.5 : 0, gL = Math.min(1, 1 - b), gR = Math.min(1, 1 + b), t = c.currentTime, G = this.stereo.g;
    G.LL.gain.setTargetAtTime(gL * (1 - m), t, 0.01); G.LR.gain.setTargetAtTime(gL * m, t, 0.01);
    G.RL.gain.setTargetAtTime(gR * m, t, 0.01); G.RR.gain.setTargetAtTime(gR * (1 - m), t, 0.01);
    if (mono || b) this.stereoSlot.engage(); else this.stereoSlot.bypass();
  }

  // ---------- master isolator (M12) ----------
  setMasterIso(band, v) { if (!(band in this.iso)) return; this.iso[band] = clamp(Number(v) || 0, -1, 1); this.applyIso(); this.emit('master', `iso.${band}`, this.iso[band]); }
  setMasterIsoOn(on) { this.isoOn = !!on; this.applyIso(); this.emit('master', 'isoOn', this.isoOn); }
  applyIso() {
    const active = this.isoOn && Object.values(this.iso).some((v) => Math.abs(v) > 1e-4);
    if (!active && !this.isoNode) return;
    if (!this.isoNode) { this.isoNode = bandSplitter(this.ctx, this.mx.masterIsoXover, { order: 8 }); this.slotIso.attach(this.isoNode.input, this.isoNode.output); }
    const [lo, mid, hi] = this.isoNode.bands, t = this.ctx.currentTime, boost = this.mx.masterIsoBoost;
    lo.gain.setTargetAtTime(masterIsoGain(this.iso.low, boost), t, 0.012); mid.gain.setTargetAtTime(masterIsoGain(this.iso.mid, boost), t, 0.012); hi.gain.setTargetAtTime(masterIsoGain(this.iso.high, boost), t, 0.012);
    if (active) this.slotIso.engage(); else this.slotIso.bypass(); // at noon: bypassed (no phase change when unused)
  }

  // ---------- warmth (M16) ----------
  setWarmth(v) {
    this.warmth = clamp(Number(v) || 0, 0, 1);
    if (this.warmth > 0 && !this.warmNode && this.ctx.__opendjFx) {
      this.warmNode = new AudioWorkletNode(this.ctx, 'opendj-warmth', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      this.slotWarm.attach(this.warmNode, this.warmNode); this.slotWarm.engage(0.02); // identical at drive 0: seamless
    }
    this.warmNode?.parameters.get('drive').setTargetAtTime(this.warmth, this.ctx.currentTime, 0.03);
    this.emit('master', 'warmth', this.warmth);
  }

  // ---------- booth (M6) ----------
  /** Booth output: master (or a mic-free mix with its own limiter) -> 2-band booth EQ -> booth level -> booth port. */
  ensureBooth() {
    if (this.booth) return this.booth;
    const c = this.ctx, b = this.booth = {};
    b.in = c.createGain(); b.fromMaster = c.createGain(); b.fromProgram = c.createGain(); b.fromMaster.gain.value = 0; b.fromProgram.gain.value = 0;
    this.masterOut.connect(b.fromMaster); b.fromMaster.connect(b.in); b.fromProgram.connect(b.in);
    b.low = c.createBiquadFilter(); b.low.type = 'lowshelf'; b.low.frequency.value = 150; b.low.gain.value = 0;
    b.high = c.createBiquadFilter(); b.high.type = 'highshelf'; b.high.frequency.value = 5000; b.high.gain.value = 0;
    b.gain = c.createGain(); b.out = c.createGain();
    b.in.connect(b.low); b.low.connect(b.high); b.high.connect(b.gain); b.gain.connect(b.out);
    this.applyBoothSource(); this.setBoothVolume(this.boothVolume); this.setBoothEq('high', this.boothEq.high); this.setBoothEq('low', this.boothEq.low);
    return b;
  }
  applyBoothSource() {
    const b = this.booth, withMic = !!this.mx.micToBooth, c = this.ctx;
    if (!withMic && !b.mg) { // mic-free booth mix: program x master volume -> its own limiter
      b.mg = c.createGain(); b.mg.gain.value = this.masterGain.gain.value; b.lim = createLimiter(c, { ceiling: this.mx.limiterCeiling });
      this.programOut.connect(b.mg); b.mg.connect(b.lim.input); b.lim.output.connect(b.fromProgram);
    }
    const t = c.currentTime;
    b.fromMaster.gain.setTargetAtTime(withMic ? 1 : 0, t, 0.01); b.fromProgram.gain.setTargetAtTime(withMic ? 0 : 1, t, 0.01);
  }
  setBoothVolume(v) { this.boothVolume = clamp(Number(v) || 0, 0, 1); if (this.booth) this.booth.gain.gain.setTargetAtTime(this.boothVolume * this.boothVolume * 1.5625, this.ctx.currentTime, 0.01); this.emit('master', 'boothVolume', this.boothVolume); }
  /** Booth EQ band 'high' | 'low', v -1..1 -> ±12 dB (shelves at 5 kHz / 150 Hz: full ±12 dB by 12 kHz / 50 Hz). */
  setBoothEq(band, v) { if (!(band in this.boothEq)) return; this.boothEq[band] = clamp(Number(v) || 0, -1, 1); const n = this.booth?.[band]; n?.gain.setTargetAtTime(this.boothEq[band] * 12, this.ctx.currentTime, 0.01); this.emit('master', `boothEq.${band}`, this.boothEq[band]); }

  // ---------- dual headphones (M7, P2) ----------
  ensureHp2() {
    if (this.hp2) return this.hp2;
    const c = this.ctx, h = this.hp2 = {};
    this.cueBus2 = c.createGain(); h.cue = c.createGain(); h.master = c.createGain(); h.out = c.createGain();
    this.cueBus2.connect(h.cue); this.masterOut.connect(h.master); h.cue.connect(h.out); h.master.connect(h.out);
    this.setHp2CueMix(this.hp2CueMix); this.setHp2Volume(this.hp2Volume);
    for (const ch of this.channels) ch.apply();
    return h;
  }
  setHp2Volume(v) { this.hp2Volume = clamp(Number(v) || 0, 0, 1); this.hp2?.out.gain.setTargetAtTime(this.hp2Volume * this.hp2Volume * 1.25, this.ctx.currentTime, 0.01); this.emit('master', 'hp2Volume', this.hp2Volume); }
  setHp2CueMix(v) { this.hp2CueMix = clamp(Number(v) || 0, 0, 1); if (this.hp2) { this.hp2.cue.gain.value = Math.cos(this.hp2CueMix * Math.PI / 2); this.hp2.master.gain.value = Math.sin(this.hp2CueMix * Math.PI / 2); } this.emit('master', 'hp2CueMix', this.hp2CueMix); }

  // ---------- record section (M15) ----------
  /** Record level in dB (-12 .. +12) and the mic in / out of the recording: a separate record mix when not the master. */
  setRecordLevel(db) { this.recLevelDb = clamp(Number(db) || 0, -12, 12); this.applyRecRouting(); this.emit('master', 'recLevel', this.recLevelDb); }
  applyRecRouting() {
    const sep = !this.mx.micToRecord || Math.abs(this.recLevelDb) > 1e-3, c = this.ctx;
    if (!sep && !this.rec) return;
    if (!this.rec) {
      const r = this.rec = {};
      r.mg = c.createGain(); r.mg.gain.value = this.masterGain.gain.value; r.mic = c.createGain(); r.sum = c.createGain();
      r.lim = createLimiter(c, { ceiling: this.mx.limiterCeiling }); r.level = c.createGain(); r.out = c.createGain(); r.out.gain.value = 0;
      this.programOut.connect(r.mg); r.mg.connect(r.sum); this.micBus.connect(r.mic); r.mic.connect(r.sum);
      r.sum.connect(r.lim.input); r.lim.output.connect(r.level); r.level.connect(r.out); r.out.connect(this.recTap);
    }
    const t = c.currentTime;
    this.rec.mic.gain.setTargetAtTime(this.mx.micToRecord ? 1 : 0, t, 0.01);
    this.rec.level.gain.setTargetAtTime(dbToGain(this.recLevelDb), t, 0.01);
    if (sep !== this._recSep) { this._recSep = sep; xfade(c, sep ? this.recFromMaster : this.rec.out, sep ? this.rec.out : this.recFromMaster, 0.02); }
  }

  // ---------- send / return (M10) ----------
  ensureSendFx() { if (!this.sendFx) this.buildSendFx(); return this.sendFx; }
  buildSendFx() {
    const c = this.ctx;
    if (!this.returnGain) { this.returnGain = c.createGain(); this.returnGain.gain.value = this.returnLevel; this.sendGate = c.createGain(); this.sendGate.gain.value = this.sendOn ? 1 : 0; this.sendBus.connect(this.sendGate); this.routeReturn(); }
    if (this.sendFx) { const old = this.sendFx; try { this.sendGate.disconnect(old.input); } catch { /* */ } setTimeout(() => { try { old.output.disconnect(); } catch { /* */ } old.dispose?.(); }, 3000); }
    this.sendFx = createSendFx(c, this.mx.sendType);
    this.sendFx.setTempo(this._beatSec || 0.5);
    this.sendGate.connect(this.sendFx.input); this.sendFx.output.connect(this.returnGain);
  }
  /** Return to the master (program bus) or into a channel strip ('ch1'..'ch4': through its EQ and fader). */
  routeReturn() {
    if (!this.returnGain) return;
    try { this.returnGain.disconnect(); } catch { /* */ }
    const m = /^ch([1-4])$/.exec(this.mx.returnTo || '');
    this.returnGain.connect(m ? this.channels[m[1] - 1].trimNode : this.programBus);
  }
  setReturnLevel(v) { this.returnLevel = clamp(Number(v) || 0, 0, 1); this.returnGain?.gain.setTargetAtTime(this.returnLevel, this.ctx.currentTime, 0.01); this.emit('master', 'returnLevel', this.returnLevel); }
  setSendOn(on) { this.sendOn = !!on; this.sendGate?.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.005); this.emit('master', 'sendOn', this.sendOn); }

  // ---------- global FX units (M9) ----------
  fxBus(u) {
    if (this.fxBuses[u]) return this.fxBuses[u];
    const b = this.fxBuses[u] = new FxBus(this.ctx, u), c = this.mx[`fx${u + 1}`];
    b.outMusic = this.ctx.createGain(); b.output.connect(b.outMusic); b.outMusic.connect(this.musicBus);
    b.setType(c.type); b.setQuantize(c.quantize); b.setBeatSec(this._beatSec || 0.5);
    return b;
  }
  /** Assign FX unit u (0/1) to 'off' | 'ch1'..'ch4' | 'master' | 'xfA' | 'xfB'. A target held by the other unit moves. */
  setFxAssign(u, target) {
    const b = this.fxBus(u), other = this.fxBuses[1 - u];
    if (target !== 'off' && other?.assign === target) this.setFxAssign(1 - u, 'off');
    const prev = b.assign; b.assign = target;
    if (prev === 'master' && target !== 'master') {
      this.slotFx.bypass(0.02);
      const done = () => { if (b.assign === 'master') return; this.slotFx.detach(); try { b.output.connect(b.outMusic); } catch { /* */ } };
      if (this._offline) done(); else setTimeout(done, 60);
    }
    if (target === 'master') {
      try { b.output.disconnect(b.outMusic); } catch { /* */ } // never a cycle through the music bus
      this.slotFx.attach(b.input, b.output); this.slotFx.engage(0.02);
    }
    this.routeFx();
  }
  /** Which unit (if any) takes each channel's post-crossfader signal: a channel assign beats a crossfader-side one. */
  routeFx() {
    for (const ch of this.channels) {
      const n = `ch${ch.index + 1}`, side = ch.state.xfAssign === 'A' ? 'xfA' : ch.state.xfAssign === 'B' ? 'xfB' : null;
      const bus = this.fxBuses.find((b) => b?.assign === n) || (side && this.fxBuses.find((b) => b?.assign === side)) || null;
      ch.divert(bus);
    }
  }

  // ---------- loudness meter (M14) ----------
  /** Start the loudness meter on the master output; readings arrive as engine.loudness / 'loudness' events. */
  ensureMeter() {
    if (this.meterNode || !this.ctx.__opendjFx) return this.meterNode;
    this.meterNode = new AudioWorkletNode(this.ctx, 'opendj-meter', { numberOfInputs: 1, numberOfOutputs: 0 });
    this.meterNode.port.onmessage = (e) => { this.loudness = e.data; this.emit('loudness', e.data); };
    this.masterOut.connect(this.meterNode);
    return this.meterNode;
  }
  resetLoudness() { this.meterNode?.port.postMessage({ cmd: 'reset' }); }

  async listOutputs() {
    try {
      // labels are only exposed after a media permission grant in some browsers
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'audiooutput').map((d) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'System default' : `Output ${d.deviceId.slice(0, 6)}`) }));
    } catch { return []; }
  }

  /**
   * Outputs. The master always sits on channels 1/2 (split cue: master mono L, cue mono R). Further stereo outputs
   * take channel pairs on the same interface (headphones 3/4, booth 3/4 or 5/6, headphones B 5/6 or 7/8) when
   * the device has the channels, or a second / third sound card via MediaStreamDestination + <audio>.setSinkId.
   */
  async applyOutputs() {
    const s = this.settings, mx = this.mx, ctx = this.ctx;
    if (mx.boothRoute !== 'off') this.ensureBooth();
    if (mx.hp2Route !== 'off') this.ensureHp2();
    for (const n of [this.portMaster, this.portHp, this.booth?.out, this.hp2?.out]) { try { n?.disconnect(); } catch { /* */ } }
    for (const k of ['hpAudio', 'boothAudio', 'hp2Audio']) if (this[k]) { this[k].pause(); this[k].srcObject = null; this[k] = null; }
    try {
      const sink = s.masterDeviceId && s.masterDeviceId !== 'default' ? s.masterDeviceId : '';
      if (ctx.setSinkId && (ctx.sinkId ?? '') !== sink) await ctx.setSinkId(sink);
    } catch (e) { this.emit('warning', `Could not open master output: ${e.message}`); }
    const max = ctx.destination.maxChannelCount || 2, map = [], devices = [], used = new Set();
    const place = (node, ch, label, mono = false) => {
      const need = mono ? [ch] : [ch, ch + 1];
      if (need.some((c) => c >= max)) { this.emit('warning', `${label}: the output device has only ${max} channels`); return false; }
      if (need.some((c) => used.has(c))) { this.emit('warning', `${label}: channels ${ch + 1}-${ch + 2} are already in use`); return false; }
      need.forEach((c) => used.add(c)); map.push({ node, ch, mono }); return true;
    };
    const split = s.cueMode === 'split';
    if (split) { place(this.portMaster, 0, 'Master', true); place(this.portHp, 1, 'Headphones', true); } else place(this.portMaster, 0, 'Master');
    const hp34 = s.cueMode === 'channels34' && max >= 4;
    if (hp34) place(this.portHp, 2, 'Headphones');
    else if (!split && s.cueDeviceId) devices.push(['hpAudio', this.portHp, s.cueDeviceId, 'headphone']);
    if (this.booth && mx.boothRoute !== 'off') {
      if (mx.boothRoute === 'device') { if (mx.boothDeviceId) devices.push(['boothAudio', this.booth.out, mx.boothDeviceId, 'booth']); }
      else place(this.booth.out, mx.boothRoute === 'channels56' ? 4 : 2, 'Booth');
    }
    if (this.hp2 && mx.hp2Route !== 'off') {
      if (mx.hp2Route === 'device') { if (mx.hp2DeviceId) devices.push(['hp2Audio', this.hp2.out, mx.hp2DeviceId, 'headphones B']); }
      else place(this.hp2.out, mx.hp2Route === 'channels78' ? 6 : 4, 'Headphones B');
    }
    const n = Math.max(...map.map((m) => m.ch + (m.mono ? 1 : 2)));
    if (n <= 2 && !split) {
      if (ctx.destination.channelCount !== 2) { ctx.destination.channelCount = 2; ctx.destination.channelInterpretation = 'speakers'; }
      this.portMaster.connect(ctx.destination);
    } else {
      if (n > 2) { ctx.destination.channelCount = n; ctx.destination.channelInterpretation = 'discrete'; } else if (ctx.destination.channelCount !== 2) { ctx.destination.channelCount = 2; ctx.destination.channelInterpretation = 'speakers'; }
      const m = ctx.createChannelMerger(Math.max(2, n));
      for (const e of map) {
        if (e.mono) { const g = ctx.createGain(); g.channelCount = 1; g.channelCountMode = 'explicit'; e.node.connect(g); g.connect(m, 0, e.ch); }
        else { const sp = ctx.createChannelSplitter(2); e.node.connect(sp); sp.connect(m, 0, e.ch); sp.connect(m, 1, e.ch + 1); }
      }
      m.connect(ctx.destination);
    }
    for (const [key, node, id, label] of devices) {
      if (typeof Audio === 'undefined') continue;
      // a second / third sound card via a MediaStream routed to an <audio> element
      const dest = ctx.createMediaStreamDestination(); node.connect(dest);
      const a = new Audio(); a.srcObject = dest.stream; a.autoplay = true;
      try { if (a.setSinkId) await a.setSinkId(id); await a.play(); this[key] = a; }
      catch (e) { this.emit('warning', `Could not open ${label} output: ${e.message}`); }
    }
    this.emit('outputs');
  }

  // ---------- crossfader ----------
  setCrossfader(x) { this.crossfader = clamp(x, -1, 1); this.applyCrossfader(); this.emit('master', 'crossfader', this.crossfader); }
  applyCrossfader() {
    const mx = this.mx;
    for (const ch of this.channels) ch.setXfGain(xfGain(this.crossfader, ch.state.xfAssign, mx));
    if (this.fxBuses.some((b) => b && /^xf/.test(b.assign))) this.routeFx();
  }

  // ---------- master deck / sync ----------
  masterDeck(except) {
    if (this.master && this.master !== except && this.master.track && this.master.bpm) return this.master;
    // otherwise: a playing, audible deck
    return this.decks.find((d) => d !== except && d.track && d.bpm && d.playing && this.channels[d.index].state.volume > 0.05)
      || this.decks.find((d) => d !== except && d.track && d.bpm && d.playing) || null;
  }
  setMaster(deck) {
    for (const d of this.decks) d.isMaster = d === deck;
    this.master = deck; this.emit('master-deck', deck);
    for (const d of this.decks) d.emit('state');
  }
  onDeckPlay(deck) {
    if (!this.master || !this.master.playing) { if (!deck.syncOn || !this.master) this.setMaster(deck); }
  }
  onTempoChange(deck) {
    if (deck === this.master) for (const d of this.decks) if (d !== deck && d.syncOn) d.matchTempo();
  }

  tick() {
    // keep beat-synced FX in time with each deck's tempo
    const now = this.ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      const d = this.decks[i], ch = this.channels[i];
      if (!d) continue;
      const bpm = d.effectiveBpm || this.master?.effectiveBpm || 120, beatSec = 60 / bpm;
      ch.setBeatSec(beatSec);
      // beat grid for the beat-locked LFOs (Trans, Flanger, ...): refreshed ~8x a second and on tempo changes
      const live = d.playing && d.bpm > 0 && !d.scratching;
      if (now - (ch._clockAt || 0) > 0.12 || ch._clockSec !== beatSec || ch._clockLive !== live) {
        ch._clockAt = now; ch._clockSec = beatSec; ch._clockLive = live;
        ch.setClock(live ? (d.position - d.gridOffset) / d.beatLen : null, now, beatSec);
      }
    }
    // global FX units, mic echo and send delays follow the master deck
    const m = this.masterDeck(), mBeat = 60 / (m?.effectiveBpm || 120);
    if (this._beatSec !== mBeat) { this._beatSec = mBeat; this.mic?.setTempo(mBeat); this.sendFx?.setTempo(mBeat); }
    if (this.fxBuses.length && now - (this._fxClockAt || 0) > 0.12) {
      this._fxClockAt = now;
      const live = m && m.playing && m.bpm > 0 && !m.scratching;
      for (const b of this.fxBuses) if (b) { b.setBeatSec(mBeat); b.setClock(live ? (m.position - m.gridOffset) / m.beatLen : null, now, mBeat); }
    }
    if (this.master && !this.master.playing) {
      const other = this.decks.find((d) => d.playing && d.track && d !== this.master);
      if (other) this.setMaster(other);
    }
    this.emit('tick');
  }

  masterLevels() {
    const b = (this._mBuf ||= new Float32Array(512)); const peak = (an) => { an.getFloatTimeDomainData(b); let p = 0; for (const v of b) p = Math.max(p, Math.abs(v)); return p; };
    return [peak(this.masterMeterL), peak(this.masterMeterR)];
  }
  /** Master peak and RMS per side (one analyser read each) for the RMS bar + peak dot meters. */
  masterMeter() {
    const b = (this._mBuf ||= new Float32Array(512)), out = { peak: [0, 0], rms: [0, 0] };
    [this.masterMeterL, this.masterMeterR].forEach((an, i) => { an.getFloatTimeDomainData(b); let p = 0, s = 0; for (const v of b) { const a = v < 0 ? -v : v; if (a > p) p = a; s += v * v; } out.peak[i] = p; out.rms[i] = Math.sqrt(s / b.length); });
    return out;
  }

  /** Live Audio Health telemetry for the club/gig HUD (latency, sample rate, channels, underrun dropouts). */
  audioHealth() {
    const c = this.ctx;
    if (!c) return null;
    const baseMs = Number.isFinite(c.baseLatency) ? Math.round(c.baseLatency * 10000) / 10 : null;
    const outMs = Number.isFinite(c.outputLatency) ? Math.round(c.outputLatency * 10000) / 10 : null;
    const dropouts = c.playbackStats?.underrunEvents ?? c.playoutStats?.toJSON?.()?.fallbackFramesEvents ?? null;
    return {
      state: c.state,
      sampleRate: c.sampleRate,
      maxChannels: c.destination?.maxChannelCount || 2,
      activeChannels: c.destination?.channelCount || 2,
      baseLatencyMs: baseMs,
      outputLatencyMs: outMs,
      totalLatencyMs: baseMs != null || outMs != null ? Math.round(((baseMs || 0) + (outMs || 0)) * 10) / 10 : null,
      dropouts,
      gigMode: !!this.settings?.gigMode,
    };
  }

  // ---------- recording (streamed to disk by public/js/recording) ----------
  attachRecorder(rec) { this.recorder = rec; }
  get recording() { return !!this.recorder?.recording; }
  get recStarted() { return Date.now() - (this.recorder?.elapsed || 0) * 1000; }
  startRecording(opts) { return this.recorder?.start(opts); }
  async stopRecording() { await this.recorder?.stop(); return null; }

}
