// A playback deck: transport, cue logic (CDJ-style), hot cues, loops, beat jump, sync, key lock, scratch.
import { Emitter, clamp } from '../util.js';
import { api } from '../api.js';
import { decodeWaveform, toCamelot, camelotCompatible } from './analysis-core.js';

export class Deck extends Emitter {
  constructor(engine, index) {
    super();
    this.engine = engine; this.ctx = engine.ctx; this.index = index;
    this.node = new AudioWorkletNode(this.ctx, 'deck-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.port.onmessage = (e) => this.onWorklet(e.data);
    this.reset();
    this.tempoRange = 8; this.tempo = 0; this.bend = 0; this.keyLock = true;
    this.quantize = true; this.slip = false; this.reverse = false; this.syncOn = false; this.isMaster = false;
    this.vinylMode = true; this.keyShift = 0;
  }

  reset() {
    this.track = null; this.duration = 0; this.sr = this.ctx.sampleRate;
    this._pos = 0; this._t = 0; this._rate = 0; this._seekGuard = 0; this.playing = false;
    this.cuePoint = 0; this.loop = null; this.loopIn = null; this.waveform = null;
    this.bpm = 0; this.gridOffset = 0; this.loading = false; this.error = null;
  }

  post(type, extra = {}) { this.node.port.postMessage({ type, ...extra }); }

  onWorklet(m) {
    if (m.type === 'pos') {
      if (m.time < this._seekGuard) return; // report produced before our last seek reached the audio thread
      this._pos = m.frame / this.sr; this._t = Math.min(m.time, this.ctx.currentTime); this._rate = m.rate;
      if (this.playing !== m.playing && !this._pendingPlay) { this.playing = m.playing; this.emit('state'); }
    } else if (m.type === 'ended') { this.playing = false; this.emit('state'); this.emit('ended'); }
    else if (m.type === 'stopped') { this.playing = false; this.emit('state'); }
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
    this.emit('load', track); this.emit('state');
    try {
      const res = await fetch(api.streamUrl(track.id));
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      if (this.track !== track) return; // another load superseded this one
      const buf = await this.ctx.decodeAudioData(ab);
      if (this.track !== track) return;
      this.sr = buf.sampleRate; this.duration = buf.duration;
      const left = new Float32Array(buf.getChannelData(0));
      const right = buf.numberOfChannels > 1 ? new Float32Array(buf.getChannelData(1)) : null;
      // waveform + analysis (cached on the server after the first time)
      let wave = track.analyzed ? decodeWaveform(await api.waveform(track.id) || new ArrayBuffer(0)) : null;
      if (!wave || !track.bpm) {
        const mono = new Float32Array(left.length);
        if (right) for (let i = 0; i < mono.length; i++) mono[i] = (left[i] + right[i]) * 0.5; else mono.set(left);
        const r = await this.engine.analyze(mono, buf.sampleRate);
        wave = decodeWaveform(r.wave.buffer);
        const patch = {
          bpm: track.bpm && track.bpmLocked ? track.bpm : r.result.bpm, gridOffset: r.result.gridOffset,
          key: track.key || r.result.key, gain: r.result.gain, startTime: r.result.startTime, endTime: r.result.endTime,
          energy: r.result.energy, duration: buf.duration, analyzed: true,
        };
        for (const k of ['phrases', 'mixIn', 'mixOut', 'downbeat']) if (r.result[k] !== undefined) patch[k] = r.result[k];
        // automatic cue creation (like rekordbox auto cue / SMART CUE) for tracks without any cues yet
        if (!(track.cues || []).length && Array.isArray(r.result.autoCues) && r.result.autoCues.length && this.engine.settings.autoCues !== false) {
          patch.cues = r.result.autoCues;
        }
        Object.assign(track, patch);
        api.saveWaveform(track.id, r.wave).catch(() => {});
        api.updateTrack(track.id, patch).then((t) => this.engine.emit('track-updated', t)).catch(() => {});
      }
      this.waveform = wave;
      this.bpm = track.bpm || 0; this.gridOffset = track.gridOffset || 0;
      this.node.port.postMessage({ type: 'load', left, right, sampleRate: buf.sampleRate }, right ? [left.buffer, right.buffer] : [left.buffer]);
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
    } catch (e) {
      if (this.track !== track) return;
      this.loading = false; this.error = e.message; this.track = null;
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
    if (this.hotPreview === i) { this.hotPreview = null; this.pause(); const c = this.hotCue(i); if (c?.loopEnd) this.exitLoop(); this.seek(c.position); }
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
  setTempo(pct) { this.tempo = clamp(pct, -100, 100); this.post('rate', { value: this.rate }); this.emit('tempo'); this.engine.onTempoChange(this); }
  setTempoFader(v) { this.setTempo(v * this.tempoRange); if (this.syncOn && !this.isMaster) this.syncOn = false; } // -1..1
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
    this.post('scratch', { value: null });
  }
  /** Outer-ring nudge (pitch bend) or seek when paused */
  jogNudge(deltaRot) {
    if (!this.track) return;
    if (!this.playing) { this.seek(this.position + deltaRot * 1.8 * 0.25); return; }
    this.setBend(clamp(deltaRot * 4, -0.25, 0.25));
    clearTimeout(this._bendT); this._bendT = setTimeout(() => this.setBend(0), 70);
  }

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
    if (!this.track) return;
    this.bpm = bpm; this.gridOffset = offset;
    Object.assign(this.track, { bpm, gridOffset: offset });
    api.updateTrack(this.track.id, { bpm, gridOffset: offset }).catch(() => {});
    if (this.syncOn) this.matchTempo();
    this.emit('grid'); this.engine.onTempoChange(this);
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
    const base = this.keyLock ? 0 : 12 * Math.log2(this.rate || 1);
    let best = null;
    for (const s of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6]) {
      const cam = shiftCamelot(mine, Math.round(base + s));
      if (camelotCompatible(cam, target)) { best = s; break; } // smallest shift that mixes harmonically
    }
    if (best === null) return false;
    if (!this.keyLock) this.setKeyLock(true);
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
    await this.load({ ...src.track });
    this.setTempo(src.tempo); this.setKeyLock(src.keyLock); this.setKeyShift(src.keyShift);
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
