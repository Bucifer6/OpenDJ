// Audio engine: AudioContext, mixer channel strips, crossfader, master/headphone routing, recorder, analysis worker.
import { Emitter, clamp, dbToGain } from '../util.js';
import { Deck } from './deck.js';
import { FxUnit, createColorFx, loadEffectWorklets } from './effects.js';
import { Sampler } from './sampler.js';

const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** EQ knob -1..1 -> band gain: +6 dB at the right, 0 dB at 12 o'clock, -26 dB at 8 o'clock fading to a full kill. */
export const eqKnobGain = (v) => (v >= 0 ? dbToGain(v * 6) : dbToGain(v * 26) * (1 - smoothstep(-0.8, -1, v)));
const BUTTER_Q = 20 * Math.log10(Math.SQRT1_2); // lowpass/highpass BiquadFilter Q is in dB
/** EQ crossover points (Hz): isolator bands low < 200 < mid < 2500 < high. */
export const EQ_XOVER = [200, 2500];
/** Filter knob dead zone around 12 o'clock. */
const FILTER_DEAD = 0.03;

/** Value range of each continuous channel control (knobs, faders, MIDI, automation are clamped to it). */
const CHANNEL_LIMITS = { trim: [-1, 1], eqHigh: [-1, 1], eqMid: [-1, 1], eqLow: [-1, 1], filter: [-1, 1], volume: [0, 1], fxMix: [0, 1], fxParam: [0, 1], fxParam2: [0, 1], vocal: [0, 1], inst: [0, 1] };

export class Channel extends Emitter {
  constructor(engine, index) {
    super();
    const ctx = this.ctx = engine.ctx; this.engine = engine; this.index = index;
    this.trimNode = ctx.createGain();
    const bq = (type, f, q) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
    const chain = (...n) => { n.reduce((a, b) => { a.connect(b); return b; }); return n; };
    // 3-band isolator EQ: Linkwitz-Riley 48 dB/oct crossovers (LR8 = two cascaded 4th-order Butterworths). The low
    // band goes through the matching all-pass of the upper crossover, so at 12 o'clock the bands sum to a flat
    // all-pass (no level ripple), every channel has the same phase (blending two decks never thins the bass) and each
    // kill is a true band kill (> 40 dB across the band).
    const [x1, x2] = EQ_XOVER, BW4 = [-5.333, 2.323]; // 4th-order Butterworth stage Qs (0.5412, 1.3066) in dB
    const lr8 = (type, f) => [...BW4, ...BW4].map((q) => bq(type, f, q));
    const ap4 = (f) => [0.5412, 1.3066].map((q) => bq('allpass', f, q)); // LP8 + HP8 of the upper crossover
    this.eqIn = ctx.createGain(); this.eqOut = ctx.createGain();
    this.low = ctx.createGain(); this.mid = ctx.createGain(); this.high = ctx.createGain();
    chain(this.eqIn, ...lr8('lowpass', x1), ...ap4(x2), this.low, this.eqOut);
    const upper = chain(this.eqIn, ...lr8('highpass', x1)).at(-1);
    chain(upper, ...lr8('lowpass', x2), this.mid, this.eqOut);
    chain(upper, ...lr8('highpass', x2), this.high, this.eqOut);
    // one-knob filter: 24 dB/oct resonant low-pass (left) / high-pass (right); parked at 0.98 x Nyquist / 3 Hz
    this.parkLp = ctx.sampleRate * 0.49;
    // (parked just inside the range: the special-case formulas at exactly Nyquist / 0 Hz would click on the way out)
    this.lpf = [bq('lowpass', this.parkLp, -5.33), bq('lowpass', this.parkLp, 2.32)];
    this.hpf = [bq('highpass', 3, -5.33), bq('highpass', 3, 2.32)];
    this.fx = new FxUnit(ctx);
    this.fader = ctx.createGain(); this.xf = ctx.createGain();
    this.cueSend = ctx.createGain(); this.cueSend.gain.value = 0;
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 512;
    this.meterBuf = new Float32Array(this.meter.fftSize);
    // Quick stems (DSP): split into mid (L+R) and side (L-R). Centred vocals live in the mid signal's voice band.
    // VOCAL scales that band with a wide peaking EQ; INST scales the side signal and the mid's lows/highs.
    // All filters are minimum-phase EQs, so with both knobs at 1 the signal passes unchanged.
    this.stemIn = ctx.createGain();
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
    this.stemOut = ctx.createGain(); merge.connect(this.stemOut);
    // Color FX: a sound-colour effect whose amount follows the filter knob (rekordbox-style)
    this.colorIn = ctx.createGain(); this.colorDry = ctx.createGain(); this.colorSend = ctx.createGain(); this.colorWet = ctx.createGain();
    this.colorSend.gain.value = 0; this.colorWet.gain.value = 0;
    this.colorIn.connect(this.colorDry); this.colorDry.connect(this.fx.input); this.colorIn.connect(this.colorSend); this.colorWet.connect(this.fx.input);
    this.colorType = 'filter'; this.colorFx = null; this.colorFade = null;
    this.trimNode.connect(this.stemIn); this.stemOut.connect(this.eqIn);
    chain(this.eqOut, this.hpf[0], this.hpf[1], this.lpf[0], this.lpf[1], this.colorIn);
    this.fx.output.connect(this.fader); this.fx.output.connect(this.cueSend); this.fx.output.connect(this.meter);
    this.fader.connect(this.xf); this.xf.connect(engine.musicBus); this.cueSend.connect(engine.cueBus);
    this.state = { trim: 0, autoGain: 0, eqHigh: 0, eqMid: 0, eqLow: 0, filter: 0, volume: 0.8, cue: false, xfAssign: index % 2 === 0 ? 'A' : 'B', fxOn: false, fxType: 'echo', fxMix: 0.5, fxParam: 0.5, fxParam2: 0.5, fxBeats: 0.5, vocal: 1, inst: 1, colorFx: engine.settings.colorFx || 'filter' };
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
      default: this.apply();
    }
    if (key === 'xfAssign') this.engine.applyCrossfader();
    this.emit('change', key, value);
    this.engine.emit('mixer', this.index, key, value);
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
  /** Tempo / beat grid of this channel's deck, for the beat FX and tempo-synced Color FX. */
  setBeatSec(s) { this.beatSec = s; this.fx.setBeatSec(s); this.colorFx?.setTempo?.(s); }
  setClock(beat, at, beatSec) { this.fx.setClock(beat, at, beatSec); this.colorFx?.setClock?.(beat, at, beatSec); }
  setAutoGain(db) { this.state.autoGain = db; this.apply(); }
  /** AI stems loaded on this channel's deck: VOC / INST then drive the stems and the DSP quick-stems chain is bypassed. */
  setAiStems(on) { if (this.aiStems === !!on) return; this.aiStems = !!on; this.apply(); this.emit('change', 'aiStems', this.aiStems); }
  apply() {
    const s = this.state, t = this.ctx.currentTime, k = 0.012;
    this.trimNode.gain.setTargetAtTime(dbToGain(s.trim * 12 + s.autoGain), t, k);
    this.high.gain.setTargetAtTime(eqKnobGain(s.eqHigh), t, k);
    this.mid.gain.setTargetAtTime(eqKnobGain(s.eqMid), t, k);
    this.low.gain.setTargetAtTime(eqKnobGain(s.eqLow), t, k);
    const db = (v) => 20 * Math.log10(Math.max(0.01, v));
    // AI stems (deck worklet) when the track has them, else the DSP "quick stems" approximation (fallback)
    const ai = !!this.aiStems, vocal = ai ? 1 : s.vocal, inst = ai ? 1 : s.inst;
    this.engine.decks?.[this.index]?.applyStemMacro?.(ai ? s.vocal : 1, ai ? s.inst : 1);
    this.vocBand.gain.setTargetAtTime(db(vocal) - (inst < 1 ? db(inst) * 0.6 : 0), t, k); // keep vocals up when inst is cut
    this.instLow.gain.setTargetAtTime(db(inst), t, k);
    this.instHigh.gain.setTargetAtTime(db(inst), t, k);
    this.sideGain.gain.setTargetAtTime(inst, t, k);
    // Color FX amount follows the filter knob (dead zone at 12 o'clock); the channel filter is gentler in colour modes
    const side = s.filter < 0 ? -1 : 1, x = Math.max(0, (Math.abs(s.filter) - FILTER_DEAD) / (1 - FILTER_DEAD));
    const cfx = this.colorFx;
    if (cfx) {
      cfx.setColor(x, side);
      if (cfx.kind === 'send') { this.colorSend.gain.setTargetAtTime(cfx.sendAmount(x), t, k); this.colorWet.gain.setTargetAtTime(1, t, k); this.colorDry.gain.setTargetAtTime(1, t, k); }
      else if (cfx.kind === 'insert') { const w = x > 0 ? cfx.wetAmount(x) : 0; this.colorSend.gain.setTargetAtTime(1, t, k); this.colorWet.gain.setTargetAtTime(w, t, k); this.colorDry.gain.setTargetAtTime(1 - w, t, k); }
      else { this.colorSend.gain.setTargetAtTime(0, t, k); this.colorWet.gain.setTargetAtTime(1, t, k); this.colorDry.gain.setTargetAtTime(1, t, k); }
      this.colorFade?.gain.setTargetAtTime(1, t, 0.012);
    } else { this.colorDry.gain.setTargetAtTime(1, t, k); this.colorWet.gain.setTargetAtTime(0, t, k); this.colorSend.gain.setTargetAtTime(0, t, k); }
    this.applyFilter(x * (cfx ? cfx.dryFilter : 1), side, t);
    this.fader.gain.setTargetAtTime(s.volume * s.volume, t, 0.005);
    this.cueSend.gain.setTargetAtTime(s.cue ? 1 : 0, t, 0.005);
  }
  /** One-knob filter: amount x (0..1, dead zone removed), side -1 = low-pass, +1 = high-pass. */
  applyFilter(x, side, t) {
    const k = 0.012;
    const lpOn = x > 0 && side < 0, hpOn = x > 0 && side > 0;
    // exponential sweeps: LPF 18 kHz -> 70 Hz, HPF 25 Hz -> 9 kHz; parked filters are inaudible (flat to < 0.01 dB)
    const lpF = lpOn ? Math.min(this.parkLp, 18000 * Math.pow(70 / 18000, Math.pow(x, 0.85))) : this.parkLp;
    const hpF = hpOn ? 25 * Math.pow(9000 / 25, Math.pow(x, 0.85)) : 3;
    // resonance fades in over the first 20 % of travel (no jump out of the dead zone), eases off at the extremes
    const res = smoothstep(0, 0.2, x) * (1 - 0.35 * smoothstep(0.8, 1, x));
    const q2 = 2.32 + 4.2 * res; // dB: Butterworth 2nd stage (+2.3 dB) up to ~+6.5 dB resonant peak
    for (const f of this.lpf) f.frequency.setTargetAtTime(lpF, t, k);
    for (const f of this.hpf) f.frequency.setTargetAtTime(hpF, t, k);
    this.lpf[1].Q.setTargetAtTime(lpOn ? q2 : 2.32, t, k); this.hpf[1].Q.setTargetAtTime(hpOn ? q2 : 2.32, t, k);
  }
  level() {
    this.meter.getFloatTimeDomainData(this.meterBuf);
    let p = 0; for (const v of this.meterBuf) { const a = Math.abs(v); if (a > p) p = a; }
    return p;
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
    const lim = { input: node, output: node, node, gainReduction: 1, setEnabled: (on) => { node.parameters.get('enabled').value = on ? 1 : 0; } };
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
  return { input, output: out, setEnabled: (on) => { wet.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.01); bypass.gain.setTargetAtTime(on ? 0 : 1, ctx.currentTime, 0.01); } };
}

export class Engine extends Emitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.decks = []; this.channels = [];
    this.crossfader = 0; // -1 (A) .. 1 (B)
    this.master = null;
    this._analysisId = 0; this._analysisCb = new Map();
  }

  async init() {
    const lh = this.settings.latencyHint || 'interactive';
    try { this.ctx = new AudioContext({ latencyHint: /^\d/.test(lh) ? Number(lh) / 1000 : lh }); }
    catch (e) { console.warn(`Invalid audio latency setting (${lh}); using the default`, e); this.ctx = new AudioContext(); } // never brick startup
    await this.ctx.audioWorklet.addModule(new URL('./worklets.js', import.meta.url));
    await loadEffectWorklets(this.ctx).catch((e) => console.warn('Effect worklets unavailable', e));
    const ctx = this.ctx;
    this.masterBus = ctx.createGain();
    this.musicBus = ctx.createGain(); this.duck = ctx.createGain();
    this.musicBus.connect(this.duck); this.duck.connect(this.masterBus);
    this.cueBus = ctx.createGain();
    this.masterGain = ctx.createGain(); this.masterGain.gain.value = 0.8;
    this.limiter = createLimiter(ctx);
    this.masterOut = ctx.createGain();
    this.masterMeterL = ctx.createAnalyser(); this.masterMeterR = ctx.createAnalyser();
    this.masterMeterL.fftSize = this.masterMeterR.fftSize = 512;
    const split = ctx.createChannelSplitter(2);
    this.masterBus.connect(this.masterGain); this.masterGain.connect(this.limiter.input); this.limiter.output.connect(this.masterOut);
    this.setLimiter(this.settings.limiter !== false);
    this.masterOut.connect(split); split.connect(this.masterMeterL, 0); split.connect(this.masterMeterR, 1);
    // headphones: blend of cue bus and master
    this.hpCue = ctx.createGain(); this.hpMaster = ctx.createGain(); this.hpOut = ctx.createGain();
    this.cueBus.connect(this.hpCue); this.masterOut.connect(this.hpMaster);
    this.hpCue.connect(this.hpOut); this.hpMaster.connect(this.hpOut);
    this.setCueMix(0); this.hpOut.gain.value = 0.8;
    // sampler -> master
    this.sampler = new Sampler(ctx, this.masterBus);

    for (let i = 0; i < 4; i++) {
      const ch = new Channel(this, i); this.channels.push(ch);
      const d = new Deck(this, i); this.decks.push(d);
      d.node.connect(ch.trimNode);
      d.tempoRange = this.settings.tempoRange || 8;
      d.keyLock = this.settings.keyLockDefault !== false;
      d.quantize = this.settings.quantize !== false;
    }
    this.applyCrossfader();
    this.worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => { const cb = this._analysisCb.get(e.data.id); this._analysisCb.delete(e.data.id); cb?.(e.data); };
    await this.applyOutputs();
    const tick = () => { this.tick(); this._raf = requestAnimationFrame(tick); };
    tick();
    setInterval(() => { if (document.hidden) this.tick(); }, 50); // keep automix/sync alive when hidden
  }

  // ---------- microphone / aux input with talkover ----------
  async setMic(on) {
    if (!on) {
      this.micStream?.getTracks().forEach((t) => t.stop()); this.micStream = null;
      try { this.micSrc?.disconnect(); } catch { /* */ }
      this.micOn = false; this.setTalkover(false); this.emit('mic'); return;
    }
    const id = this.settings.micDeviceId;
    this.micStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (!this.micChain) {
      const c = this.ctx;
      this.micGain = c.createGain(); this.micGain.gain.value = 0.8;
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
      this.micHigh = c.createBiquadFilter(); this.micHigh.type = 'highshelf'; this.micHigh.frequency.value = 5000;
      this.micLow = c.createBiquadFilter(); this.micLow.type = 'lowshelf'; this.micLow.frequency.value = 200;
      const comp = c.createDynamicsCompressor(); comp.threshold.value = -24; comp.ratio.value = 4;
      this.micGain.connect(hp); hp.connect(this.micLow); this.micLow.connect(this.micHigh); this.micHigh.connect(comp); comp.connect(this.masterBus);
      this.micMeter = c.createAnalyser(); this.micMeter.fftSize = 512; comp.connect(this.micMeter);
      this.micChain = true;
    }
    this.micSrc = this.ctx.createMediaStreamSource(this.micStream);
    this.micSrc.connect(this.micGain);
    this.micOn = true; this.emit('mic');
  }
  setMicVolume(v) { v = clamp(Number(v) || 0, 0, 1); this.micVolume = v; if (this.micGain) this.micGain.gain.setTargetAtTime(v * v * 1.5, this.ctx.currentTime, 0.02); this.emit('master', 'micVolume', v); }
  setMicEq(band, v) { const n = band === 'high' ? this.micHigh : this.micLow; if (n) n.gain.setTargetAtTime(v * 12, this.ctx.currentTime, 0.02); }
  setTalkover(on) {
    this.talkover = on;
    const db = this.settings.talkoverDb ?? -12;
    this.duck.gain.setTargetAtTime(on ? Math.pow(10, db / 20) : 1, this.ctx.currentTime, on ? 0.05 : 0.25);
    this.emit('master', 'talkover', on);
  }
  micLevel() { if (!this.micOn || !this.micMeter) return 0; const b = (this._micBuf ||= new Float32Array(512)); this.micMeter.getFloatTimeDomainData(b); let p = 0; for (const v of b) p = Math.max(p, Math.abs(v)); return p; }

  resume() { if (this.ctx.state !== 'running') return this.ctx.resume(); }

  analyze(mono, sampleRate) {
    return new Promise((resolve, reject) => {
      const id = ++this._analysisId;
      this._analysisCb.set(id, (d) => (d.error ? reject(new Error(d.error)) : resolve(d)));
      this.worker.postMessage({ id, mono, sampleRate }, [mono.buffer]);
    });
  }

  // ---------- master / outputs ----------
  /** The limiter stays in the signal path (constant latency); off = unity gain, so toggling never clicks. */
  setLimiter(on) { this.limiter.setEnabled(on); }
  setMasterVolume(v) { v = clamp(Number(v) || 0, 0, 1); this.masterVolume = v; this.masterGain.gain.setTargetAtTime(v * v * 1.25, this.ctx.currentTime, 0.01); this.emit('master', 'volume', v); }
  setCueMix(v) { v = clamp(Number(v) || 0, 0, 1); this.cueMix = v; this.hpCue.gain.value = Math.cos(v * Math.PI / 2); this.hpMaster.gain.value = Math.sin(v * Math.PI / 2); this.emit('master', 'cueMix', v); }
  setHeadphoneVolume(v) { v = clamp(Number(v) || 0, 0, 1); this.hpVolume = v; this.hpOut.gain.setTargetAtTime(v * v * 1.25, this.ctx.currentTime, 0.01); this.emit('master', 'hpVolume', v); }

  async listOutputs() {
    try {
      // labels are only exposed after a media permission grant in some browsers
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'audiooutput').map((d) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'System default' : `Output ${d.deviceId.slice(0, 6)}`) }));
    } catch { return []; }
  }

  async applyOutputs() {
    const s = this.settings, ctx = this.ctx;
    for (const n of [this.masterOut, this.hpOut]) { try { n.disconnect(); } catch { /* */ } }
    // reconnect internal taps removed by disconnect()
    const split = ctx.createChannelSplitter(2);
    this.masterOut.connect(split); split.connect(this.masterMeterL, 0); split.connect(this.masterMeterR, 1);
    this.masterOut.connect(this.hpMaster);
    if (this.hpAudio) { this.hpAudio.pause(); this.hpAudio.srcObject = null; this.hpAudio = null; }
    try {
      const sink = s.masterDeviceId && s.masterDeviceId !== 'default' ? s.masterDeviceId : '';
      if (ctx.setSinkId && (ctx.sinkId ?? '') !== sink) await ctx.setSinkId(sink);
    } catch (e) { this.emit('warning', `Could not open master output: ${e.message}`); }

    if (s.cueMode === 'split') {
      const m = ctx.createChannelMerger(2);
      const monoM = ctx.createGain(); monoM.channelCount = 1; monoM.channelCountMode = 'explicit';
      const monoH = ctx.createGain(); monoH.channelCount = 1; monoH.channelCountMode = 'explicit';
      this.masterOut.connect(monoM); this.hpOut.connect(monoH);
      monoM.connect(m, 0, 0); monoH.connect(m, 0, 1); m.connect(ctx.destination);
    } else if (s.cueMode === 'channels34' && ctx.destination.maxChannelCount >= 4) {
      ctx.destination.channelCount = 4; ctx.destination.channelInterpretation = 'discrete';
      const m = ctx.createChannelMerger(4), sm = ctx.createChannelSplitter(2), sh = ctx.createChannelSplitter(2);
      this.masterOut.connect(sm); this.hpOut.connect(sh);
      sm.connect(m, 0, 0); sm.connect(m, 1, 1); sh.connect(m, 0, 2); sh.connect(m, 1, 3);
      m.connect(ctx.destination);
    } else {
      if (ctx.destination.channelCount !== 2) { ctx.destination.channelCount = 2; ctx.destination.channelInterpretation = 'speakers'; }
      this.masterOut.connect(ctx.destination);
      if (s.cueDeviceId) {
        // headphones on a second sound card via a MediaStream routed to an <audio> element
        const dest = ctx.createMediaStreamDestination();
        this.hpOut.connect(dest);
        const a = new Audio(); a.srcObject = dest.stream; a.autoplay = true;
        try { if (a.setSinkId) await a.setSinkId(s.cueDeviceId); await a.play(); this.hpAudio = a; }
        catch (e) { this.emit('warning', `Could not open headphone output: ${e.message}`); }
      }
    }
    this.emit('outputs');
  }

  // ---------- crossfader ----------
  setCrossfader(x) { this.crossfader = clamp(x, -1, 1); this.applyCrossfader(); this.emit('master', 'crossfader', this.crossfader); }
  applyCrossfader() {
    const x = (this.crossfader + 1) / 2; // 0 = A, 1 = B
    const curve = this.settings.crossfaderCurve;
    const gainFor = (side) => {
      const p = side === 'A' ? x : 1 - x; // 0 = fully this side
      if (curve === 'sharp') return p < 0.92 ? 1 : (1 - p) / 0.08;
      if (curve === 'constant') return Math.min(1, 2 * (1 - p));
      return Math.cos(p * Math.PI / 2) / Math.cos(Math.PI / 4) > 1 ? 1 : Math.cos(p * Math.PI / 2) / Math.cos(Math.PI / 4);
    };
    for (const ch of this.channels) {
      const a = ch.state.xfAssign;
      ch.xf.gain.setTargetAtTime(a === 'THRU' ? 1 : gainFor(a), this.ctx.currentTime, 0.004);
    }
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
      const bpm = d.effectiveBpm || this.master?.effectiveBpm || 120, beatSec = 60 / bpm;
      ch.setBeatSec(beatSec);
      // beat grid for the beat-locked LFOs (Trans, Flanger, ...): refreshed ~8x a second and on tempo changes
      const live = d.playing && d.bpm > 0 && !d.scratching;
      if (now - (ch._clockAt || 0) > 0.12 || ch._clockSec !== beatSec || ch._clockLive !== live) {
        ch._clockAt = now; ch._clockSec = beatSec; ch._clockLive = live;
        ch.setClock(live ? (d.position - d.gridOffset) / d.beatLen : null, now, beatSec);
      }
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

  // ---------- recording (streamed to disk by public/js/recording) ----------
  attachRecorder(rec) { this.recorder = rec; }
  get recording() { return !!this.recorder?.recording; }
  get recStarted() { return Date.now() - (this.recorder?.elapsed || 0) * 1000; }
  startRecording(opts) { return this.recorder?.start(opts); }
  async stopRecording() { await this.recorder?.stop(); return null; }

}
