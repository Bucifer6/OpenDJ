// Audio engine: AudioContext, mixer channel strips, crossfader, master/headphone routing, recorder, analysis worker.
import { Emitter, clamp, dbToGain } from '../util.js';
import { Deck } from './deck.js';
import { FxUnit } from './effects.js';
import { Sampler } from './sampler.js';

const knobToDb = (v) => (v >= 0 ? v * 6 : v <= -0.98 ? -60 : v * 26); // EQ knob -1..1: kill .. 0 .. +6 dB

class Channel extends Emitter {
  constructor(engine, index) {
    super();
    const ctx = this.ctx = engine.ctx; this.engine = engine; this.index = index;
    this.trimNode = ctx.createGain();
    this.low = ctx.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 220;
    this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1100; this.mid.Q.value = 0.65;
    this.high = ctx.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 4500;
    this.lpf = ctx.createBiquadFilter(); this.lpf.type = 'lowpass'; this.lpf.frequency.value = 22000; this.lpf.Q.value = 0.9;
    this.hpf = ctx.createBiquadFilter(); this.hpf.type = 'highpass'; this.hpf.frequency.value = 10; this.hpf.Q.value = 0.9;
    this.fx = new FxUnit(ctx);
    this.fader = ctx.createGain(); this.xf = ctx.createGain();
    this.cueSend = ctx.createGain(); this.cueSend.gain.value = 0;
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 512;
    this.meterBuf = new Float32Array(this.meter.fftSize);
    this.trimNode.connect(this.low); this.low.connect(this.mid); this.mid.connect(this.high);
    this.high.connect(this.hpf); this.hpf.connect(this.lpf); this.lpf.connect(this.fx.input);
    this.fx.output.connect(this.fader); this.fx.output.connect(this.cueSend); this.fx.output.connect(this.meter);
    this.fader.connect(this.xf); this.xf.connect(engine.masterBus); this.cueSend.connect(engine.cueBus);
    this.state = { trim: 0, autoGain: 0, eqHigh: 0, eqMid: 0, eqLow: 0, filter: 0, volume: 0.8, cue: false, xfAssign: index % 2 === 0 ? 'A' : 'B', fxOn: false, fxType: 'echo', fxMix: 0.5, fxParam: 0.5, fxBeats: 0.5 };
    this.apply();
  }
  set(key, value) {
    if (this.state[key] === value) return;
    this.state[key] = value;
    switch (key) {
      case 'fxOn': this.fx.setOn(value); break;
      case 'fxType': this.fx.setType(value); break;
      case 'fxMix': this.fx.setMix(value); break;
      case 'fxParam': this.fx.setParam(value); break;
      case 'fxBeats': this.fx.setBeats(value); break;
      default: this.apply();
    }
    if (key === 'xfAssign') this.engine.applyCrossfader();
    this.emit('change', key, value);
    this.engine.emit('mixer', this.index, key, value);
  }
  setAutoGain(db) { this.state.autoGain = db; this.apply(); }
  apply() {
    const s = this.state, t = this.ctx.currentTime, k = 0.012;
    this.trimNode.gain.setTargetAtTime(dbToGain(s.trim * 12 + s.autoGain), t, k);
    this.high.gain.setTargetAtTime(knobToDb(s.eqHigh), t, k);
    this.mid.gain.setTargetAtTime(knobToDb(s.eqMid), t, k);
    this.low.gain.setTargetAtTime(knobToDb(s.eqLow), t, k);
    // one-knob filter: left = low-pass, right = high-pass
    const f = s.filter;
    const dead = Math.abs(f) < 0.03;
    this.lpf.frequency.setTargetAtTime(dead || f > 0 ? 22000 : 20000 * Math.pow(60 / 20000, -f), t, k);
    this.hpf.frequency.setTargetAtTime(dead || f < 0 ? 10 : 20 * Math.pow(9000 / 20, f), t, k);
    const res = dead ? 0.7 : 0.7 + Math.abs(f) * 4;
    this.lpf.Q.setTargetAtTime(res, t, k); this.hpf.Q.setTargetAtTime(res, t, k);
    this.fader.gain.setTargetAtTime(s.volume * s.volume, t, 0.005);
    this.cueSend.gain.setTargetAtTime(s.cue ? 1 : 0, t, 0.005);
  }
  level() {
    this.meter.getFloatTimeDomainData(this.meterBuf);
    let p = 0; for (const v of this.meterBuf) { const a = Math.abs(v); if (a > p) p = a; }
    return p;
  }
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
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(new URL('./worklets.js', import.meta.url));
    const ctx = this.ctx;
    this.masterBus = ctx.createGain();
    this.cueBus = ctx.createGain();
    this.masterGain = ctx.createGain(); this.masterGain.gain.value = 0.8;
    this.limiter = ctx.createDynamicsCompressor();
    Object.assign(this.limiter, {});
    this.limiter.threshold.value = -1.5; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.12;
    this.masterOut = ctx.createGain();
    this.masterMeterL = ctx.createAnalyser(); this.masterMeterR = ctx.createAnalyser();
    this.masterMeterL.fftSize = this.masterMeterR.fftSize = 512;
    const split = ctx.createChannelSplitter(2);
    this.masterBus.connect(this.masterGain);
    this.setLimiter(this.settings.limiter !== false);
    this.masterOut.connect(split); split.connect(this.masterMeterL, 0); split.connect(this.masterMeterR, 1);
    // headphones: blend of cue bus and master
    this.hpCue = ctx.createGain(); this.hpMaster = ctx.createGain(); this.hpOut = ctx.createGain();
    this.cueBus.connect(this.hpCue); this.masterOut.connect(this.hpMaster);
    this.hpCue.connect(this.hpOut); this.hpMaster.connect(this.hpOut);
    this.setCueMix(0); this.hpOut.gain.value = 0.8;
    // sampler -> master
    this.sampler = new Sampler(ctx, this.masterBus);
    // recorder tap
    this.recNode = new AudioWorkletNode(ctx, 'recorder-processor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    const sink = ctx.createGain(); sink.gain.value = 0;
    this.masterOut.connect(this.recNode); this.recNode.connect(sink); sink.connect(ctx.destination);
    this.recNode.port.onmessage = (e) => this.onRecChunk(e.data);

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

  resume() { if (this.ctx.state !== 'running') return this.ctx.resume(); }

  analyze(mono, sampleRate) {
    return new Promise((resolve, reject) => {
      const id = ++this._analysisId;
      this._analysisCb.set(id, (d) => (d.error ? reject(new Error(d.error)) : resolve(d)));
      this.worker.postMessage({ id, mono, sampleRate }, [mono.buffer]);
    });
  }

  // ---------- master / outputs ----------
  setLimiter(on) {
    this.masterGain.disconnect();
    if (on) { this.masterGain.connect(this.limiter); this.limiter.connect(this.masterOut); }
    else { try { this.limiter.disconnect(); } catch { /* */ } this.masterGain.connect(this.masterOut); }
  }
  setMasterVolume(v) { this.masterVolume = v; this.masterGain.gain.setTargetAtTime(v * v * 1.25, this.ctx.currentTime, 0.01); this.emit('master', 'volume', v); }
  setCueMix(v) { this.cueMix = v; this.hpCue.gain.value = Math.cos(v * Math.PI / 2); this.hpMaster.gain.value = Math.sin(v * Math.PI / 2); this.emit('master', 'cueMix', v); }
  setHeadphoneVolume(v) { this.hpVolume = v; this.hpOut.gain.setTargetAtTime(v * v * 1.25, this.ctx.currentTime, 0.01); this.emit('master', 'hpVolume', v); }

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
    this.masterOut.connect(this.hpMaster); this.masterOut.connect(this.recNode);
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
    for (let i = 0; i < 4; i++) {
      const d = this.decks[i];
      const bpm = d.effectiveBpm || this.master?.effectiveBpm || 120;
      this.channels[i].fx.setBeatSec(60 / bpm);
    }
    if (this.master && !this.master.playing) {
      const other = this.decks.find((d) => d.playing && d.track && d !== this.master);
      if (other) this.setMaster(other);
    }
    this.emit('tick');
  }

  masterLevels() {
    const b = new Float32Array(512); const peak = (an) => { an.getFloatTimeDomainData(b); let p = 0; for (const v of b) p = Math.max(p, Math.abs(v)); return p; };
    return [peak(this.masterMeterL), peak(this.masterMeterR)];
  }

  // ---------- recording ----------
  startRecording() {
    if (this.recording) return;
    this.recChunks = []; this.recFrames = 0; this.recording = true; this.recStarted = Date.now();
    this.recNode.port.postMessage({ record: true });
    this.emit('recording', true);
  }
  onRecChunk({ l, r, flush }) {
    if (!this.recChunks) return;
    const n = l.length, pcm = new Int16Array(n * 2);
    for (let i = 0; i < n; i++) { pcm[2 * i] = clamp(l[i], -1, 1) * 32767; pcm[2 * i + 1] = clamp(r[i], -1, 1) * 32767; }
    this.recChunks.push(pcm); this.recFrames += n;
    if (flush && this._recResolve) { this._recResolve(); this._recResolve = null; }
  }
  async stopRecording() {
    if (!this.recording) return null;
    this.recording = false;
    const flushed = new Promise((res) => { this._recResolve = res; setTimeout(res, 500); });
    this.recNode.port.postMessage({ record: false });
    await flushed;
    const sr = this.ctx.sampleRate, dataLen = this.recFrames * 4;
    const hdr = new DataView(new ArrayBuffer(44));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) hdr.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); hdr.setUint32(4, 36 + dataLen, true); w(8, 'WAVE'); w(12, 'fmt ');
    hdr.setUint32(16, 16, true); hdr.setUint16(20, 1, true); hdr.setUint16(22, 2, true); hdr.setUint32(24, sr, true);
    hdr.setUint32(28, sr * 4, true); hdr.setUint16(32, 4, true); hdr.setUint16(34, 16, true); w(36, 'data'); hdr.setUint32(40, dataLen, true);
    const blob = new Blob([hdr, ...this.recChunks], { type: 'audio/wav' });
    this.recChunks = null;
    this.emit('recording', false);
    return blob;
  }
}
