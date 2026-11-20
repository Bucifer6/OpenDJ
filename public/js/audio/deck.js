// A playback deck: transport, cue logic (CDJ-style), hot cues, loops, beat jump, sync, key lock, scratch.
import { Emitter, clamp } from '../util.js';
import { api } from '../api.js';
import { decodeWaveform, toCamelot, camelotCompatible, analyzeStructure, analysisPatch } from './analysis-core.js';
import { effectiveGains, LOADED_STEMS } from '../stems/stem-mix.js';
import { floatToInt16 } from '../stems/stem-dsp.js';
import { StemEcho } from '../stems/stem-fx.js';

export const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];
export const stemUrl = (id, stem) => `/api/stems/${encodeURIComponent(id)}/${stem}`;

export class Deck extends Emitter {
  constructor(engine, index) {
    super();
    this.engine = engine; this.ctx = engine.ctx; this.index = index;
    // output 0: deck audio; output 1: stem FX send (e.g. vocal echo), see setStemFx()
    this.node = new AudioWorkletNode(this.ctx, 'deck-processor', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [2, 2] });
    this.node.port.onmessage = (e) => this.onWorklet(e.data);
    this.reset();
    this.tempoRange = 8; this.tempo = 0; this.bend = 0; this.keyLock = true;
    this.quantize = true; this.slip = false; this.reverse = false; this.syncOn = false; this.isMaster = false;
    this.vinylMode = true; this.keyShift = 0; this._loadSeq = 0;
    this.stemMacro = [1, 1]; // channel VOC / INST knobs (they drive the AI stems once loaded)
    this.stemFxOn = false; this.stemFx = null;
    this.resetStemControls();
  }

  reset() {
    this.track = null; this.duration = 0; this.sr = this.ctx.sampleRate;
    this._pos = 0; this._t = 0; this._rate = 0; this._seekGuard = 0; this.playing = false;
    this.cuePoint = 0; this.loop = null; this.loopIn = null; this.waveform = null;
    this.bpm = 0; this.gridOffset = 0; this.loading = false; this.error = null; this.failedTrack = null;
    this._countedPlay = false;
    this.frames = 0; this._stemSeq = (this._stemSeq || 0) + 1;
    if (this.stemsReady || this.stemsLoading) { this.stemsReady = false; this.engine.channels?.[this.index]?.setAiStems?.(false); }
    this.stemsReady = false; this.stemsLoading = false; this.stemsError = null;
    this.external = false;
    this.scratching = false; this._slicing = false; this.rolling = false; this.cuePreview = false; this.hotPreview = null;
    clearTimeout(this._scratchIdle);
    if (this.node) this.post('scratch', { value: null });
  }

  post(type, extra = {}) { this.node.port.postMessage({ type, ...extra }); }

  onWorklet(m) {
    if (m.type === 'pos') {
      if (m.time < this._seekGuard) return; // report produced before our last seek reached the audio thread
      this._pos = m.frame / this.sr; this._t = Math.min(m.time, this.ctx.currentTime); this._rate = m.rate;
      if (this.playing !== m.playing && !this._pendingPlay) { this.playing = m.playing; this.emit('state'); }
    } else if (m.type === 'ended') { this.playing = false; this.emit('state'); this.emit('ended'); }
    else if (m.type === 'stopped') { this.playing = false; this.emit('state'); }
    else if (m.type === 'stems') {
      if (m.seq !== this._stemSeq) return; // answer to an older load/unload
      this.stemsReady = m.loaded; this.stemsLoading = false;
      if (!m.loaded && m.rejected) this.stemsError = 'Stems do not match this track';
      this.engine.channels[this.index]?.setAiStems?.(m.loaded);
      this.emit('stems');
    }
  }

  // ---------- derived state ----------
  get position() {
    if (!this.track) return 0;
    const p = this._pos + (this.ctx.currentTime - this._t) * this._rate;
    if (this.loop?.active && p > this.loop.end && this._rate > 0) return this.loop.start + ((p - this.loop.start) % (this.loop.end - this.loop.start));
    return clamp(p, 0, this.duration);
  }
  get rate() { return (1 + this.tempo / 100) * (1 + this.bend); }
  get effectiveBpm() { return this.bpm ? this.bpm * (1 + this.tempo / 100) : 0; }
  get beatLen() { return this.bpm ? 60 / this.bpm : 0.5; }
  get remaining() { return this.duration - this.position; }
  beatPhase(pos = this.position) { return this.bpm ? (((pos - this.gridOffset) / this.beatLen) % 1 + 1) % 1 : 0; }
  beatIndex(pos = this.position) { return this.bpm ? Math.floor((pos - this.gridOffset) / this.beatLen + 1e-6) : 0; }
  snap(t) {
    if (!this.quantize || !this.bpm) return t;
    const b = this.beatLen; return this.gridOffset + Math.round((t - this.gridOffset) / b) * b;
  }
  floorBeat(t) {
    if (!this.bpm) return t;
    const b = this.beatLen; return this.gridOffset + Math.floor((t - this.gridOffset) / b + 0.02) * b;
  }

  // ---------- loading ----------
  async load(track) {
    if (this.playing && this.engine.settings.lockPlayingDecks) throw new Error('Deck is playing');
    this.post('play', { value: false }); this.post('loop', { value: null }); this.post('unload');
    this.reset(); this.track = track; this.loading = true;
    const tok = ++this._loadSeq;
    const stale = () => tok !== this._loadSeq;
    this.emit('load', track); this.emit('state');
    try {
      const res = await fetch(api.streamUrl(track.id));
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      if (stale()) return false; // another load superseded this one
      const buf = await this.ctx.decodeAudioData(ab);
      if (stale()) return false;
      this.sr = buf.sampleRate; this.duration = buf.duration;
      // waveform + analysis (cached on the server after the first time)
      let wave = track.analyzed ? decodeWaveform(await api.waveform(track.id) || new ArrayBuffer(0)) : null;
      if (stale()) return false;
      if (!wave) { // analyse once; tracks whose BPM can't be detected aren't re-analysed on every load
        // analysis copy straight from the decoded audio (no intermediate full-length float copies)
        const c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
        const mono = new Float32Array(c0.length);
        if (c1) for (let i = 0; i < mono.length; i++) mono[i] = (c0[i] + c1[i]) * 0.5; else mono.set(c0);
        const r = await this.engine.analyze(mono, buf.sampleRate);
        if (stale()) return false;
        wave = decodeWaveform(r.wave.buffer);
        const patch = analysisPatch(track, r.result, { duration: buf.duration, autoCues: this.engine.settings.autoCues });
        Object.assign(track, patch);
        api.saveWaveform(track.id, r.wave).catch(() => {});
        api.updateTrack(track.id, patch).then((t) => this.engine.emit('track-updated', t)).catch(() => {});
      }
      this.waveform = wave;
      this.bpm = track.bpm || 0; this.gridOffset = track.gridOffset || 0;
      if (!track.phrases && wave && this.bpm) this.refreshStructure(false); // tracks analysed before phrase detection existed
      // Deck memory: 16-bit samples by default (CD resolution, half the RAM of float); 32-bit float on request.
      const hiPrec = !!this.engine.settings.highPrecisionAudio;
      const left = deckChannel(buf.getChannelData(0), hiPrec);
      const right = buf.numberOfChannels > 1 ? deckChannel(buf.getChannelData(1), hiPrec) : null;
      this.frames = left.length;
      this.node.port.postMessage({ type: 'load', left, right, sampleRate: buf.sampleRate }, right ? [left.buffer, right.buffer] : [left.buffer]);
      this.resetStemControls(); this.postStemGains();
      this.post('rate', { value: this.rate }); this.post('keylock', { value: this.keyLock });
      this.keyShift = 0; this.post('pitch', { value: 1 });
      // first memory cue, else first beat, becomes the cue point
      const mem = (track.cues || []).filter((c) => c.index < 0).sort((a, b) => a.position - b.position)[0];
      this.cuePoint = mem ? mem.position : Math.max(0, this.bpm ? this.snap(track.startTime || 0) : track.startTime || 0);
      if (this.cuePoint < 0) this.cuePoint += this.beatLen;
      this.seek(this.cuePoint);
      this.engine.channels[this.index].setAutoGain(this.engine.settings.autoGain ? (track.gain || 0) : 0);
      this.loading = false;
      if (this.syncOn) this.matchTempo();
      this.emit('loaded', track); this.emit('state');
      // AI stems prepared for this track: attach them in the background (the deck already plays the original)
      if (track.stems?.ready && this.engine.settings.stemsAutoLoad !== false) this.loadStems().catch((e) => console.warn('stems', e));
      return true;
    } catch (e) {
      if (stale()) return false;
      this.loading = false; this.error = e.message; this.track = null; this.failedTrack = track; // keep the name for the deck title
      this.emit('error', e); this.emit('state');
      throw e;
    }
  }

  eject() { if (this.playing) return; this.post('unload'); this.reset(); this.emit('load', null); this.emit('state'); }

  // ---------- transport ----------
  play() {
    if (!this.track || this.loading) return;
    this.cuePreview = false; this.hotPreview = null;
    if (this.syncOn) this.alignPhase();
    this.playing = true; this.post('play', { value: true });
    this._pendingPlay = true; setTimeout(() => { this._pendingPlay = false; }, 60);
    if (!this._countedPlay) { this._countedPlay = true; api.played(this.track.id).catch(() => {}); }
    this.engine.onDeckPlay(this);
    this.emit('state');
  }
  pause() { this.playing = false; this.post('play', { value: false }); this._pendingPlay = true; setTimeout(() => { this._pendingPlay = false; }, 60); this.emit('state'); }
  togglePlay() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    if (!this.track) return;
    t = clamp(t, 0, Math.max(0, this.duration - 0.001));
    this._pos = t; this._t = this.ctx.currentTime; this._seekGuard = this.ctx.currentTime;
    this.post('seek', { frame: t * this.sr, at: this.ctx.currentTime });
    this.emit('seek', t);
  }

  cueDown() {
    if (!this.track) return;
    if (this.playing && !this.cuePreview) { this.pause(); this.seek(this.cuePoint); return; }
    if (Math.abs(this.position - this.cuePoint) < 0.02) { // preview from cue while held
      this.cuePreview = true; this.playing = true; this.post('play', { value: true }); this.emit('state');
    } else {
      this.cuePoint = this.snap(this.position); this.seek(this.cuePoint); this.emit('cues');
    }
  }
  cueUp() {
    if (this.cuePreview) { this.cuePreview = false; this.pause(); this.seek(this.cuePoint); }
  }

  // ---------- hot cues ----------
  get hotCues() { return (this.track?.cues || []).filter((c) => c.index >= 0); }
  hotCue(i) { return this.hotCues.find((c) => c.index === i); }
  hotCueDown(i) {
    if (!this.track) return;
    const c = this.hotCue(i);
    if (!c && this.loop?.active) { this.saveLoopToHotCue(i); return; }
    if (!c) {
      const position = this.snap(this.position);
      this.track.cues = [...(this.track.cues || []), { index: i, type: 'hot', position, name: '', color: HOTCUE_COLORS[i % 8] }];
      this.saveCues();
      return;
    }
    if (c.loopEnd > c.position) { // saved loop: jump in and engage it
      this.setLoop(c.position, c.loopEnd);
      this.seek(this.playing ? this.phaseTarget(c.position) : c.position);
      if (!this.playing) { this.hotPreview = i; this.playing = true; this.post('play', { value: true }); this.emit('state'); }
      return;
    }
    this.seek(this.playing ? this.phaseTarget(c.position) : c.position);
    if (!this.playing) { this.hotPreview = i; this.playing = true; this.post('play', { value: true }); this.emit('state'); }
  }
  /** Quantized jump: keep the current position within the beat so the mix stays in phase. */
  phaseTarget(t) {
    if (!this.quantize || !this.bpm) return t;
    const b = this.beatLen;
    const frac = (x) => (((x - this.gridOffset) % b) + b) % b;
    let d = frac(this.position) - frac(t);
    if (d > b / 2) d -= b; if (d < -b / 2) d += b;
    return Math.max(0, t + d);
  }
  /** Store the active loop on a hot cue pad (saved loop). */
  saveLoopToHotCue(i) {
    if (!this.track || !this.loop) return;
    this.track.cues = [...(this.track.cues || []).filter((c) => c.index !== i), { index: i, type: 'loop', position: this.loop.start, loopEnd: this.loop.end, name: `Loop ${this.loopBeats >= 1 ? Math.round(this.loopBeats) : this.loopBeats.toFixed(2)}`, color: '#2ed47a' }];
    this.saveCues();
  }
  hotCueUp(i) {
    if (this.hotPreview === i) { this.hotPreview = null; this.pause(); const c = this.hotCue(i); if (c?.loopEnd) this.exitLoop(); if (c) this.seek(c.position); }
  }
  deleteHotCue(i) { if (!this.track) return; this.track.cues = (this.track.cues || []).filter((c) => c.index !== i); this.saveCues(); }
  addMemoryCue() {
    if (!this.track) return;
    const loop = this.loop?.active ? { position: this.loop.start, loopEnd: this.loop.end } : { position: this.snap(this.position) };
    this.track.cues = [...(this.track.cues || []), { index: -1, type: loop.loopEnd ? 'loop' : 'memory', name: '', ...loop }];
    this.saveCues();
  }
  saveCues() { this.emit('cues'); api.updateTrack(this.track.id, { cues: this.track.cues }).catch(() => {}); }

  // ---------- loops ----------
  setLoop(start, end, active = true) {
    if (end <= start) return;
    this.loop = { start, end, active };
    this.post('loop', { value: active ? { start: start * this.sr, end: end * this.sr } : null });
    if (active && this.position > end) this.seek(start);
    this.emit('loop');
  }
  autoLoop(beats) {
    if (!this.track) return;
    if (this.loop?.active && Math.abs((this.loop.end - this.loop.start) - beats * this.beatLen) < 1e-3) return this.exitLoop();
    const start = this.loop?.active ? this.loop.start : (this.quantize ? this.floorBeat(this.position) : this.position);
    this.setLoop(start, start + beats * this.beatLen);
  }
  loopInPress() { this.loopIn = this.snap(this.position); if (this.loop?.active) this.exitLoop(); this.emit('loop'); }
  loopOutPress() {
    const start = this.loopIn ?? this.loop?.start;
    if (start == null) return;
    const end = this.snap(this.position);
    if (end > start + 0.01) this.setLoop(start, end);
  }
  exitLoop() { if (!this.loop) return; this.loop.active = false; this.post('loop', { value: null }); this.emit('loop'); }
  reloop() {
    if (!this.loop) return;
    if (this.loop.active) return this.exitLoop();
    this.setLoop(this.loop.start, this.loop.end); this.seek(this.loop.start);
  }
  loopHalve() { if (this.loop) this.setLoop(this.loop.start, this.loop.start + (this.loop.end - this.loop.start) / 2, this.loop.active); }
  loopDouble() { if (this.loop) this.setLoop(this.loop.start, this.loop.start + (this.loop.end - this.loop.start) * 2, this.loop.active); }
  get loopBeats() { return this.loop ? (this.loop.end - this.loop.start) / this.beatLen : 0; }

  /** Loop roll: momentary loop with slip, playback resumes where it would have been. */
  rollOn(beats) {
    if (!this.track || !this.playing) return;
    this._rollPrevSlip = this.slip; this.setSlip(true);
    const start = this.floorBeat(this.position);
    this.setLoop(start, start + beats * this.beatLen);
    this.rolling = true;
  }
  rollOff() {
    if (!this.rolling) return;
    this.rolling = false; this.exitLoop(); this.loop = null; this.setSlip(this._rollPrevSlip); this.emit('loop');
  }

  beatJump(beats) {
    if (!this.track) return;
    const d = beats * this.beatLen;
    if (this.loop?.active) this.setLoop(this.loop.start + d, this.loop.end + d);
    this.seek(this.position + d);
  }

  // ---------- tempo / sync ----------
  setTempo(pct) {
    this.tempo = clamp(pct, -100, 100); this.post('rate', { value: this.rate }); this.emit('tempo'); this.engine.onTempoChange(this);
    if (this.stemFxOn && this.effectiveBpm) this.stemFx?.setBeat(60 / this.effectiveBpm);
  }
  setTempoFader(v) { this.setTempo(v * this.tempoRange); if (this.syncOn && !this.isMaster) { this.syncOn = false; this.emit('state'); } } // -1..1
  setTempoRange(r) { const f = this.tempo / this.tempoRange; this.tempoRange = r; this.emit('tempo'); return f; }
  resetTempo() { this.setTempo(0); }
  setBend(b) { this.bend = b; this.post('rate', { value: this.rate }); }
  setKeyLock(v) { this.keyLock = v; this.post('keylock', { value: v }); this.emit('state'); }
  setQuantize(v) { this.quantize = v; this.emit('state'); }
  setSlip(v) { this.slip = v; this.post('slip', { value: v }); this.emit('state'); }
  setReverse(v) { this.reverse = v; this.post('reverse', { value: v }); this.emit('state'); }

  syncTargetRatio(master) {
    // allow half / double time matching (e.g. 87 vs 174)
    const r = master.effectiveBpm / this.bpm;
    const cands = [r, r * 2, r / 2];
    return cands.reduce((a, b) => (Math.abs(Math.log(b)) < Math.abs(Math.log(a)) ? b : a));
  }
  matchTempo() {
    const m = this.engine.masterDeck(this);
    if (!m || !m.bpm || !this.bpm) return false;
    this.setTempo((this.syncTargetRatio(m) - 1) * 100);
    return true;
  }
  alignPhase() {
    const m = this.engine.masterDeck(this);
    if (!m || !m.playing || !m.bpm || !this.bpm || this.engine.settings.syncMode === 'tempo') return;
    let d = m.beatPhase() - this.beatPhase();
    if (d > 0.5) d -= 1; if (d < -0.5) d += 1;
    let t = this.position + d * this.beatLen;
    if (t < 0) t += this.beatLen; // can't go before the start: align to the next beat instead
    this.seek(t);
  }
  sync() {
    if (!this.track) return;
    if (this.syncOn) { this.syncOn = false; this.emit('state'); return; }
    this.syncOn = true;
    if (this.matchTempo() && this.playing) this.alignPhase();
    this.emit('state');
  }
  setMaster() { this.engine.setMaster(this); }

  // ---------- jog / scratch ----------
  /** deltaRot: platter rotations since last call, dt seconds; 33⅓ rpm => 1.8 s audio per rotation */
  jogScratch(deltaRot, dt) {
    if (!this.track) return;
    if (!this.scratching) { this.scratching = true; this._wasPlaying = this.playing; }
    const v = clamp((deltaRot * 1.8) / Math.max(dt, 0.001), -12, 12);
    this.post('scratch', { value: { velocity: v } });
    clearTimeout(this._scratchIdle);
    this._scratchIdle = setTimeout(() => this.scratching && this.post('scratch', { value: { velocity: 0 } }), 40);
  }
  jogRelease() {
    if (!this.scratching) return;
    this.scratching = false; clearTimeout(this._scratchIdle);
    if (!this.external) this.post('scratch', { value: null });
  }
  /** Outer-ring nudge (pitch bend) or seek when paused */
  jogNudge(deltaRot) {
    if (!this.track) return;
    if (!this.playing) { this.seek(this.position + deltaRot * 1.8 * 0.25); return; }
    this.setBend(clamp(deltaRot * 4, -0.25, 0.25));
    clearTimeout(this._bendT); this._bendT = setTimeout(() => this.setBend(0), 70);
  }

  // ---------- AI stems (vocals / drums / bass / other) ----------
  resetStemControls() { this.stemLevels = [1, 1, 1, 1]; this.stemMute = [false, false, false, false]; this.emit('stems'); }
  /** Fetch the prepared stems, decode, keep them as Int16 and hand them to the worklet (sample-locked to the track). */
  async loadStems() {
    const track = this.track;
    if (!track || this.loading || this.stemsReady || this.stemsLoading) return this.stemsReady;
    const seq = this._stemSeq, frames = this.frames;
    const stale = () => seq !== this._stemSeq || this.track !== track;
    this.stemsLoading = true; this.stemsError = null; this.emit('stems');
    try {
      const out = [];
      for (const name of STEM_NAMES.slice(0, LOADED_STEMS)) { // "other" is the residual, computed in the worklet
        const res = await fetch(stemUrl(track.id, name), { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`stem ${name}: HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        if (stale()) return false;
        const buf = await this.ctx.decodeAudioData(ab);
        if (stale()) return false;
        if (Math.abs(buf.length - frames) > this.ctx.sampleRate * 0.5) throw new Error('Stems do not match this file (prepare them again)');
        const pair = {};
        for (const [k, c] of [['L', 0], ['R', Math.min(1, buf.numberOfChannels - 1)]]) {
          const src = buf.getChannelData(c), dst = new Int16Array(frames);
          floatToInt16(src.length > frames ? src.subarray(0, frames) : src, dst);
          pair[k] = dst;
        }
        out.push(pair);
      }
      if (stale()) return false;
      this.node.port.postMessage({ type: 'stems', value: out, seq }, out.flatMap((p) => [p.L.buffer, p.R.buffer]));
      return true; // stemsReady is set when the worklet confirms
    } catch (e) {
      if (!stale()) { this.stemsLoading = false; this.stemsError = e.message; this.emit('stems'); }
      throw e;
    }
  }
  unloadStems() {
    const seq = ++this._stemSeq;
    this.post('stems', { value: null, seq });
    this.stemsLoading = false;
    if (this.stemsReady) { this.stemsReady = false; this.engine.channels[this.index]?.setAiStems?.(false); }
    this.emit('stems');
  }
  get stemsActive() { return this.stemsReady; }
  setStemMute(i, on) { this.stemMute[i] = !!on; this.postStemGains(); }
  toggleStem(i) { this.setStemMute(i, !this.stemMute[i]); }
  setStemLevel(i, v) { this.stemLevels[i] = Math.max(0, Math.min(1, v)); this.postStemGains(); }
  /** Acapella: vocals only (press again for all stems). */
  stemAcapella() { const on = this.isAcapella; this.stemMute = on ? [false, false, false, false] : [false, true, true, true]; this.postStemGains(); }
  /** Instrumental: everything but vocals (press again for all stems). */
  stemInstrumental() { const on = this.isInstrumental; this.stemMute = on ? [false, false, false, false] : [true, false, false, false]; this.postStemGains(); }
  get isAcapella() { const m = this.stemMute; return !m[0] && m[1] && m[2] && m[3]; }
  get isInstrumental() { const m = this.stemMute; return m[0] && !m[1] && !m[2] && !m[3]; }
  /** Channel VOC / INST knobs (called by the mixer channel). */
  applyStemMacro(vocal, inst) { if (this.stemMacro[0] === vocal && this.stemMacro[1] === inst) return; this.stemMacro = [vocal, inst]; this.postStemGains(); }
  get stemGains() { return [...effectiveGains({ levels: this.stemLevels, mute: this.stemMute }, this.stemMacro[0], this.stemMacro[1])]; }
  postStemGains() {
    const g = this.stemGains;
    this.post('stemGains', { value: g });
    this.post('stemSend', { value: this.stemFxOn ? [g[0], 0, 0, 0] : [0, 0, 0, 0] });
    if (this.stemFxOn) this.stemFx?.setBeat(this.effectiveBpm ? 60 / this.effectiveBpm : 0.5);
    this.emit('stems');
  }
  /** Stem FX: beat-synced echo on the vocal stem only (send from worklet output 1 into this channel). */
  setStemFx(on) {
    if (on && !this.stemFx) {
      this.stemFx = new StemEcho(this.ctx);
      this.node.connect(this.stemFx.input, 1);
      this.stemFx.output.connect(this.engine.channels[this.index].trimNode);
    }
    this.stemFxOn = !!on; this.postStemGains();
  }

  // ---------- external control (DVS) ----------
  /** v: playback speed (1 = normal, <0 = reverse) from an external source; null hands control back.
   *  viaPort: the speed already reaches the worklet directly (attachExternalPort); only update transport state. */
  setExternalSpeed(v, viaPort = false) {
    if (v == null) { if (!this.external) return; this.external = false; if (!viaPort) this.post('scratch', { value: null }); return; }
    if (!this.track || this.loading) return;
    this.external = true;
    if (!viaPort) this.post('scratch', { value: { velocity: clamp(v, -16, 16) } });
    const moving = Math.abs(v) > 0.05;
    if (moving !== this.playing) { this.playing = moving; this.post('play', { value: moving }); if (moving) this.engine.onDeckPlay(this); this.emit('state'); }
  }
  /** Let the DVS decoder worklet post 'scratch' messages straight to this deck's processor (audio thread -> audio thread). */
  attachExternalPort(port) { this.node.port.postMessage({ type: 'ext-port', port }, [port]); }

  // ---------- performance effects ----------
  brake(seconds = 1.2) { if (!this.playing) return; this.post('brake', { value: 1 / (seconds * this.ctx.sampleRate) }); }
  backspin(seconds = 1.0) {
    if (!this.track) return;
    let v = -6; const t0 = performance.now();
    this.post('scratch', { value: { velocity: v } });
    const iv = setInterval(() => {
      const k = (performance.now() - t0) / 1000 / seconds;
      if (k >= 1) { clearInterval(iv); this.post('scratch', { value: null }); this.pause(); return; }
      this.post('scratch', { value: { velocity: v * (1 - k) } });
    }, 20);
  }
  censorOn() { this._censorSlip = this.slip; this.setSlip(true); this.setReverse(true); }
  censorOff() { this.setReverse(false); this.setSlip(this._censorSlip); }

  // ---------- beat grid editing ----------
  setGrid(bpm, offset) {
    if (!this.track || !(bpm >= 20 && bpm <= 400) || !Number.isFinite(offset)) return false;
    this.bpm = bpm; this.gridOffset = offset;
    Object.assign(this.track, { bpm, gridOffset: offset });
    api.updateTrack(this.track.id, { bpm, gridOffset: offset }).catch(() => {});
    if (this.syncOn) this.matchTempo();
    this.refreshStructure(true);
    this.emit('grid'); this.engine.onTempoChange(this);
  }
  /** Recompute phrases / mix points from the waveform (cheap; no audio needed). */
  refreshStructure(save) {
    if (!this.track || !this.waveform || !this.bpm) return;
    try {
      const t = this.track;
      const st = analyzeStructure(this.waveform, this.bpm, this.gridOffset, { startTime: t.startTime, endTime: t.endTime, duration: this.duration || t.duration });
      const patch = { phrases: st.phrases, mixIn: st.mixIn, mixOut: st.mixOut, downbeat: st.downbeat };
      Object.assign(t, patch);
      api.updateTrack(t.id, patch).catch(() => {});
      this.emit('cues');
    } catch (e) { console.warn('structure analysis failed', e); }
  }
  gridSetDownbeatHere() { this.setGrid(this.bpm, this.position); }
  gridShift(sec) { this.setGrid(this.bpm, this.gridOffset + sec); }
  gridScale(f) { this.setGrid(Math.round(this.bpm * f * 100) / 100, this.gridOffset); }

  get camelot() { return toCamelot(this.track?.key); }

  // ---------- key shift / key sync ----------
  /** Total pitch change in semitones: key shift plus the tempo's pitch change when key lock is off. */
  get pitchSemis() { return this.keyShift + (this.keyLock ? 0 : 12 * Math.log2(this.rate || 1)); }
  /** Camelot code of what is actually heard (after key shift / tempo). */
  get playingCamelot() { return shiftCamelot(this.camelot, Math.round(this.pitchSemis)); }
  setKeyShift(semis) {
    this.keyShift = Math.max(-12, Math.min(12, Math.round(semis * 100) / 100));
    this.post('pitch', { value: Math.pow(2, this.keyShift / 12) });
    if (this.track) { this.track.keyShift = this.keyShift; }
    this.emit('state'); this.emit('key');
  }
  /** Shift this deck's key by the smallest amount that makes it harmonically compatible with another deck. */
  keySyncTo(other) {
    other = other || this.engine.masterDeck(this);
    const mine = this.camelot, target = other?.playingCamelot;
    if (!mine || !target) return false;
    // key sync always works with key lock on, so the tempo no longer changes the pitch
    if (!this.keyLock) this.setKeyLock(true);
    const base = 0;
    let best = null;
    for (const s of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6]) {
      const cam = shiftCamelot(mine, Math.round(base + s));
      if (camelotCompatible(cam, target)) { best = s; break; } // smallest shift that mixes harmonically
    }
    if (best === null) return false;
    this.setKeyShift(best);
    return true;
  }

  // ---------- slicer: 8 slices of the current 8-beat window ----------
  sliceDown(n) {
    if (!this.track || !this.bpm) return;
    const b = this.beatLen;
    if (this._sliceStart == null || this.position > this._sliceStart + 8 * b || this.position < this._sliceStart) this._sliceStart = this.floorBeat(this.position - ((this.beatIndex() % 8) + 8) % 8 * b);
    this._slicePrevSlip = this._slicing ? this._slicePrevSlip : this.slip;
    this._slicing = true; this.setSlip(true);
    const start = this._sliceStart + n * b;
    this.setLoop(start, start + b); this.seek(start + (this.position - this.floorBeat(this.position)));
  }
  sliceUp() {
    if (!this._slicing) return;
    this._slicing = false; this.exitLoop(); this.loop = null; this.setSlip(this._slicePrevSlip); this.emit('loop');
  }

  // ---------- instant doubles ----------
  async cloneFrom(src) {
    if (!src?.track || src === this) return;
    if ((await this.load({ ...src.track })) === false) return;
    this.setTempo(src.tempo); this.setKeyLock(src.keyLock); this.setKeyShift(src.keyShift);
    this.stemMute = [...src.stemMute]; this.stemLevels = [...src.stemLevels]; this.postStemGains();
    if (src.loop?.active) this.setLoop(src.loop.start, src.loop.end);
    this.seek(src.position);
    if (src.playing) this.play();
  }
}

export const HOTCUE_COLORS = ['#2ecc71', '#e74c3c', '#f39c12', '#3498db', '#9b59b6', '#1abc9c', '#e67e22', '#ecf0f1'];

/** Move a Camelot key by n semitones (each semitone is 7 steps around the wheel). */
export function shiftCamelot(cam, n) {
  const m = /^(\d+)([AB])$/.exec(cam || '');
  if (!m) return null;
  return `${((((+m[1] - 1 + 7 * n) % 12) + 12) % 12) + 1}${m[2]}`;
}

/** Copy one decoded channel for the deck worklet: Int16 with TPDF dither (default) or Float32 (high precision). */
export function deckChannel(src, highPrecision = false) {
  if (highPrecision) return new Float32Array(src);
  const out = new Int16Array(src.length);
  let seed = 22222;
  for (let i = 0; i < src.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0; const r1 = seed / 4294967296;
    seed = (seed * 1664525 + 1013904223) >>> 0; const r2 = seed / 4294967296;
    const v = Math.round(src[i] * 32767 + (r1 - r2)); // ±1 LSB triangular dither
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}
