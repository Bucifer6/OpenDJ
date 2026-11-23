// A playback deck: transport, cue logic (CDJ-style), hot cues, loops, beat jump, sync, key lock, scratch.
import { Emitter, clamp } from '../util.js';
import { api } from '../api.js';
import { decodeWaveform, toCamelot, camelotCompatible, analyzeStructure, analysisPatch, carryPhraseLufs } from './analysis-core.js';
import { effectiveGains, LOADED_STEMS } from '../stems/stem-mix.js';
import { floatToInt16 } from '../stems/stem-dsp.js';
import { onsetCurve } from './beat-phase.js';
import { StemEcho } from '../stems/stem-fx.js';
import { VINYL_DEFAULTS, secPerRev, snapTo, nextQuantizeDiv, glideDuration, bendAt, needleTarget, jumpSizeStep, semitoneRate } from './vinyl.js';

/** Tempo fader ranges (±%), as offered in the deck and Settings. */
export const TEMPO_RANGES = [6, 8, 10, 16, 25, 50, 100];

export const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];
export const stemUrl = (id, stem) => `/api/stems/${encodeURIComponent(id)}/${stem}`;

/** Tracks longer than this get a warning on load (decoding a one-hour file takes seconds and ~1 GB of memory). */
const LONG_TRACK_SEC = 30 * 60;
/** Read a fetch response body, reporting progress (0..100) when the size is known. */
async function readWithProgress(res, onPct) {
  const total = Number(res.headers.get('content-length')) || 0;
  if (!total || !res.body?.getReader) return res.arrayBuffer();
  const reader = res.body.getReader();
  let buf = new Uint8Array(total), got = 0, last = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > buf.length) { const b = new Uint8Array(Math.max(buf.length * 2, got + value.length)); b.set(buf.subarray(0, got)); buf = b; } // longer than announced
    buf.set(value, got); got += value.length;
    const pct = Math.min(100, Math.floor(got / total * 100)); if (pct !== last) { last = pct; onPct(pct); }
  }
  return got === buf.length ? buf.buffer : buf.slice(0, got).buffer;
}

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
    this.vinyl = { ...VINYL_DEFAULTS }; // motor / platter model (T1-T4), see applyVinyl()
    this.quantizeDiv = 1;   // quantize division in beats (1/8 .. 4 = 1 bar)
    this.jumpSize = 4;      // beat jump size (½ .. 64)
    this.rateMul = 1;       // scale play (pads change the platter speed)
    this.hardLock = false;  // a playing deck refuses loads
    this.slipReverse = false; this.loopAdjust = null; this._audioOff = null;
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
    this._shadow = 0; this._handPos = false; this.scratchSample = null; this._glide = null; this.loopAdjust = null;
    if (this.slipReverse) { this.slipReverse = false; this.reverse = false; }
    clearTimeout(this._scratchIdle);
    if (this.node) this.post('scratch', { value: null });
  }

  post(type, extra = {}) { this.node.port.postMessage({ type, ...extra }); }

  onWorklet(m) {
    if (m.type === 'pos') {
      // AudioContext time can be shared by a seek and an already queued worklet report.
      // Sequence acknowledgements keep that old report from undoing the user's new position.
      if (m.seekSeq != null ? m.seekSeq !== (this._seekSeq || 0) : m.time < this._seekGuard) return;
      this._pos = m.frame / this.sr; this._t = Math.min(m.time, this.ctx.currentTime); this._rate = m.rate; this._shadow = m.shadow / this.sr;
      if (this._glide && m.tempo > 0) { this.tempo = (m.tempo / ((1 + this.bend) * this.rateMul) - 1) * 100; this.emit('tempo'); }
      if (this.playing !== m.playing && !this._pendingPlay) { this.playing = m.playing; this.emit('state'); }
    } else if (m.type === 'ended') { this.playing = false; this.emit('state'); if (!this.scratchSample) this.emit('ended'); }
    else if (m.type === 'stopped') { this.playing = false; this.emit('state'); }
    else if (m.type === 'slipResumed') { if (this._slipStopPrev != null) { const p = this._slipStopPrev; this._slipStopPrev = null; this.setSlip(p); } }
    else if (m.type === 'rampDone') { if (this._glide && m.id === this._glide.id) { const g = this._glide; this._glide = null; this.setTempo(g.target); } }
    else if (m.type === 'loopEngaged') {
      if (this.scratchSample) return;
      this.loop = { start: m.start / this.sr, end: m.end / this.sr, active: true, auto: true }; this.emit('loop');
    }
    else if (m.type === 'stems') {
      if (m.seq !== this._stemSeq) return; // answer to an older load/unload
      this.stemsReady = m.loaded; this.stemsLoading = false;
      if (!m.loaded && m.rejected) this.stemsError = 'Stems do not match this track';
      this.engine.channels[this.index]?.setAiStems?.(m.loaded);
      this.emit('stems');
    }
  }

  // ---------- derived state ----------
  get position() { return this.positionAt(this.ctx.currentTime); }
  /** Track position at audio-clock time `t` (the UI passes a frame-smoothed clock so waveforms scroll evenly). */
  positionAt(t) {
    if (!this.track) return 0;
    const p = this._pos + (t - this._t) * this._rate;
    if (this.loop?.active && p > this.loop.end && this._rate > 0) return this.loop.start + ((p - this.loop.start) % (this.loop.end - this.loop.start));
    if (this.loop?.active && p < this.loop.start && this._rate < 0 && this._pos >= this.loop.start) { const L = this.loop.end - this.loop.start; return this.loop.end - ((this.loop.start - p) % L); }
    return clamp(p, 0, this.duration);
  }
  get rate() { return (1 + this.tempo / 100) * (1 + this.bend) * (this.rateMul || 1); }
  get effectiveBpm() { return this.bpm ? this.bpm * (1 + this.tempo / 100) : 0; }
  get beatLen() { return this.bpm ? 60 / this.bpm : 0.5; }
  get remaining() { return this.duration - this.position; }
  beatPhase(pos = this.position) { return this.bpm ? (((pos - this.gridOffset) / this.beatLen) % 1 + 1) % 1 : 0; }
  beatIndex(pos = this.position) { return this.bpm ? Math.floor((pos - this.gridOffset) / this.beatLen + 1e-6) : 0; }
  snap(t) {
    if (!this.quantize || !this.bpm) return t;
    return snapTo(t, this.gridOffset, this.beatLen, this.quantizeDiv || 1);
  }
  /** Quantize division (T11): 1/8, 1/4, 1/2, 1 beat or 1 bar; cues, loop in/out and needle drops snap to it. */
  setQuantizeDiv(div) { this.quantizeDiv = [0.125, 0.25, 0.5, 1, 4].includes(div) ? div : 1; this.emit('state'); }
  cycleQuantizeDiv() { this.setQuantizeDiv(nextQuantizeDiv(this.quantizeDiv)); }
  /** Seconds of audio per platter turn (33⅓ rpm = 1.8 s); scratch scale and platter rotation. */
  get secPerRev() { return secPerRev(this.vinyl.rpm); }
  get shadowPosition() { return this.slip ? this._shadow : null; }
  floorBeat(t) {
    if (!this.bpm) return t;
    const b = this.beatLen; return this.gridOffset + Math.floor((t - this.gridOffset) / b + 0.02) * b;
  }

  // ---------- loading ----------
  async load(track) {
    this._autoMixEntry = 0;
    if (this.playing && (this.engine.settings.lockPlayingDecks || this.hardLock || this.engine.settings.deckOptions?.hardLock)) throw new Error('Deck is playing');
    if (this.scratchSample) this.post('altReturn', { frame: 0 }); // the worklet's saved track is dropped by the load below
    this.post('play', { value: false }); this.post('loop', { value: null }); this.post('unload');
    this.reset(); this.track = track; this.loading = true;
    const tok = ++this._loadSeq;
    const stale = () => tok !== this._loadSeq;
    this.emit('load', track); this.emit('state');
    try {
      // load progress for the deck (a one-hour file takes many seconds): reading x %, decoding, analysing
      const phase = (name, pct = null) => { this.loadPhase = { name, pct }; this.emit('load-progress', this.loadPhase); };
      phase('Loading', 0);
      if ((Number(track.duration) || 0) > LONG_TRACK_SEC) this.engine.emit('warning', `"${track.title || 'This track'}" is ${Math.round(track.duration / 60)} minutes long: loading takes a while and needs a lot of memory`);
      // bytes fetched ahead by automix (a NAS or media server that hiccups mid-party doesn't stop the next track)
      const pre = this.engine.prefetched?.get(track.id);
      if (pre) this.engine.prefetched.delete(track.id);
      let ab = pre || null;
      if (!ab) {
        const res = await fetch(api.streamUrl(track.id));
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        ab = await readWithProgress(res, (p) => { if (!stale()) phase('Loading', p); });
      }
      if (stale()) return false; // another load superseded this one
      phase('Decoding');
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
        phase('Analysing');
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
      const ch0 = buf.getChannelData(0), ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
      // 16-bit decks: material above 0 dBFS (float files, inter-sample overs of loud lossy masters) is stored
      // peak-normalised and scaled back in the worklet, so it never clips before the channel / auto gain.
      // time-sliced (yields to the event loop every few ms) so a load never freezes the UI or the other deck's waveform
      const scale = hiPrec ? 1 : Math.max(1, await peakAbsSliced(ch0), ch1 ? await peakAbsSliced(ch1) : 0);
      if (stale()) return false;
      this.audioScale = scale;
      const left = await deckChannelSliced(ch0, hiPrec, scale);
      const right = ch1 ? await deckChannelSliced(ch1, hiPrec, scale) : null;
      if (stale()) return false;
      this.frames = left.length;
      this.node.port.postMessage({ type: 'load', left, right, sampleRate: buf.sampleRate, scale }, right ? [left.buffer, right.buffer] : [left.buffer]);
      // kick onset curve for automix's audible phase check (audio/beat-phase.js), built in the background in slices
      this.onsets = null;
      onsetCurve(ch0, ch1, buf.sampleRate).then((c) => { if (!stale()) this.onsets = c; }, () => {});
      this.resetStemControls(); this.postStemGains();
      this.rateMul = 1; this.post('rate', { value: this.rate }); this.post('keylock', { value: this.keyLock });
      this.keyShift = 0; this.post('pitch', { value: 1 });
      // first memory cue, else first beat, becomes the cue point
      const mem = (track.cues || []).filter((c) => c.index < 0).sort((a, b) => a.position - b.position)[0];
      this.cuePoint = mem ? mem.position : Math.max(0, this.bpm ? this.snap(track.startTime || 0) : track.startTime || 0);
      if (this.cuePoint < 0) this.cuePoint += this.beatLen;
      this.seek(this.cuePoint);
      this.engine.channels[this.index].setAutoGain(this.engine.settings.autoGain ? (track.gain || 0) : 0);
      this.loading = false; this.loadPhase = null;
      this.armActiveLoop();
      if (this.syncOn) this.matchTempo();
      this.emit('loaded', track); this.emit('state');
      // AI stems prepared for this track: attach them in the background (the deck already plays the original)
      if (track.stems?.ready && this.engine.settings.stemsAutoLoad !== false) this.loadStems().catch((e) => console.warn('stems', e));
      return true;
    } catch (e) {
      if (stale()) return false;
      this.loading = false; this.loadPhase = null; this.error = e.message; this.track = null; this.failedTrack = track; // keep the name for the deck title
      this.emit('error', e); this.emit('state');
      throw e;
    }
  }

  // ++_loadSeq: a load still in flight becomes stale (it must not finish into an ejected deck)
  eject() { if (this.playing) return; if (this.scratchSample) this.scratchSampleReturn(); ++this._loadSeq; this.post('unload'); this.reset(); this.emit('load', null); this.emit('state'); }

  // ---------- transport ----------
  /**
   * Start playback. opts.at: the audio-clock time the current position was planned for (the worklet catches up if
   * the message arrives late, waits if early); opts.instant: no turntable motor spin-up. Automix uses both so the
   * incoming track starts exactly on the beat.
   */
  play({ at, instant = false } = {}) {
    if (!this.track || this.loading) return;
    this.cuePreview = false; this.hotPreview = null;
    if (this.syncOn) this.alignPhase();
    this.playing = true; this.post('play', { value: true, ...(Number.isFinite(at) ? { at } : {}), ...(instant ? { instant: true } : {}) });
    this._pendingPlay = true; setTimeout(() => { this._pendingPlay = false; }, 60);
    if (!this._countedPlay) { this._countedPlay = true; api.played(this.track.id).catch(() => {}); }
    this.engine.onDeckPlay(this);
    this.emit('state');
  }
  pause() { this.playing = false; this.post('play', { value: false }); this._pendingPlay = true; setTimeout(() => { this._pendingPlay = false; }, 60); this.emit('state'); }
  /**
   * Turntable START/STOP (T1, MIDI deckN.startStop): always with motor ramps, even when the deck's start / stop times
   * are 0 (then 0.7 s / 0.8 s, like a Technics at its defaults).
   */
  startStop() {
    if (!this.track || this.loading) return;
    if (this.playing) {
      const T = this.vinyl.stop > 0 ? this.vinyl.stop : 0.8;
      this.post('brake', { value: 1 / (T * this.ctx.sampleRate) });
      return;
    }
    const T = this.vinyl.start > 0 ? this.vinyl.start : 0.7;
    if (!(this.vinyl.start > 0)) { this.post('motor', { value: { start: T } }); clearTimeout(this._ssT); this._ssT = setTimeout(() => this.post('motor', { value: { start: this.vinyl.start } }), T * 1000 + 80); }
    this.play();
  }
  togglePlay() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    if (!this.track) return;
    t = clamp(t, 0, Math.max(0, this.duration - 0.001));
    this._pos = t; this._t = this.ctx.currentTime; this._seekGuard = this.ctx.currentTime;
    this._seekSeq = (this._seekSeq || 0) + 1;
    this.post('seek', { frame: t * this.sr, at: this.ctx.currentTime, seq: this._seekSeq });
    this.emit('seek', t);
    this.armActiveLoop(t);
  }
  /**
   * Needle drop (T6) at fraction `frac` of the track: the overview waveform, the vinyl skin's tonearm and MIDI
   * deckN.needle all come here. Snaps to the grid when the needle-snap option asks for it (and keeps the beat phase
   * while playing).
   */
  needleDrop(frac) {
    if (!this.track || !this.duration || this.scratchSample) return;
    const snap = this.engine.settings.deckOptions?.needleSnap || 'off';
    this.seek(needleTarget(frac, { duration: this.duration, bpm: this.bpm, gridOffset: this.gridOffset, position: this.position, playing: this.playing, snap }));
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
    if (!this.track || this.loading) return; // (still loading: no grid, no position yet)
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
  saveCues() { this.emit('cues'); this.armActiveLoop(); if (!this.track.scratchSample) api.updateTrack(this.track.id, { cues: this.track.cues }).catch(() => {}); }

  // ---------- active loops (T11) ----------
  /** Memory loops flagged active engage by themselves when the play head reaches them (worklet-armed, sample accurate). */
  get activeLoops() { return (this.track?.cues || []).filter((c) => c.index < 0 && c.active && c.loopEnd > c.position).sort((a, b) => a.position - b.position); }
  armActiveLoop(from = this.position) {
    if (!this.track || this.scratchSample) return;
    const next = this.activeLoops.find((c) => c.position > from + 0.002);
    const key = next ? `${next.position}|${next.loopEnd}` : '';
    if (key === this._armedKey) return;
    this._armedKey = key;
    this.post('armLoop', { value: next ? { start: next.position * this.sr, end: next.loopEnd * this.sr } : null });
  }
  /** Flag the current loop as an active loop (stored as a memory loop), or clear the flag. */
  toggleActiveLoop() {
    if (!this.track || this.scratchSample) return;
    const cues = this.track.cues || [];
    const loop = this.loop;
    const near = (c) => loop && Math.abs(c.position - loop.start) < 0.005 && Math.abs((c.loopEnd || 0) - loop.end) < 0.005;
    let c = cues.find((x) => x.index < 0 && near(x));
    if (!c && !loop) { c = cues.filter((x) => x.index < 0 && x.loopEnd > x.position && x.active).sort((a, b) => Math.abs(a.position - this.position) - Math.abs(b.position - this.position))[0]; if (c) { c.active = false; this._armedKey = null; this.saveCues(); } return; }
    if (!c) { this.track.cues = [...cues, { index: -1, type: 'loop', name: '', position: loop.start, loopEnd: loop.end, active: true }]; }
    else c.active = !c.active;
    this._armedKey = null; this.saveCues();
  }
  get loopIsActiveLoop() { const l = this.loop; return !!(l && (this.track?.cues || []).some((c) => c.index < 0 && c.active && Math.abs(c.position - l.start) < 0.005 && Math.abs(c.loopEnd - l.end) < 0.005)); }

  // ---------- loops ----------
  setLoop(start, end, active = true) {
    if (end <= start) return;
    this.loop = { start, end, active };
    this.post('loop', { value: active ? { start: start * this.sr, end: end * this.sr } : null });
    if (active && this.position > end) this.seek(start + ((this.position - start) % (end - start))); // keep the phase in the loop
    this.emit('loop');
  }
  autoLoop(beats) {
    if (!this.track || this.loading) return; // a loop set now would use the 0.5 s fallback beat at 0:00
    if (this.loop?.active && Math.abs((this.loop.end - this.loop.start) - beats * this.beatLen) < 1e-3) return this.exitLoop();
    // sub-beat loops start on their own grid (a 1/4-beat loop on the 1/4-beat grid, like rolls), so the play head is
    // already inside the loop: no jump back when ½ / ¼ is pressed late in the beat
    const g = Math.min(beats, 1) * this.beatLen;
    const start = this.loop?.active ? this.loop.start : !this.quantize ? this.position : beats < 1 && this.bpm ? this.gridOffset + Math.floor((this.position - this.gridOffset) / g + 1e-6) * g : this.floorBeat(this.position);
    this.setLoop(start, start + beats * this.beatLen);
  }
  loopInPress() { this.loopIn = this.snap(this.position); if (this.loop?.active) this.exitLoop(); this.emit('loop'); }
  /**
   * Loop in / out adjust (T11): while IN or OUT is held on an active loop, the jog moves that loop point.
   * which: 'in' | 'out' | null.
   */
  setLoopAdjust(which) {
    this.loopAdjust = which && this.loop ? which : null;
    this._adjAcc = 0; this._adjBase = null; this.emit('loop'); this.emit('state');
  }
  /** Move the adjusted loop point by `sec` seconds (snapped to 1/16 beat when quantize is on). */
  adjustLoop(sec) {
    const l = this.loop; if (!l || !this.loopAdjust) return;
    this._adjAcc = (this._adjAcc || 0) + sec;
    const k = this.loopAdjust === 'in' ? 'start' : 'end';
    let v = (this._adjBase ??= l[k]) + this._adjAcc;
    if (this.quantize && this.bpm) v = snapTo(v, this.gridOffset, this.beatLen, 1 / 16);
    const minLen = this.bpm ? this.beatLen / 16 : 0.02;
    if (k === 'start') v = Math.max(0, Math.min(v, l.end - minLen)); else v = Math.min(this.duration, Math.max(v, l.start + minLen));
    if (Math.abs(v - l[k]) < 1e-6) return;
    this.setLoop(k === 'start' ? v : l.start, k === 'end' ? v : l.end, l.active);
  }
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
  /** Halve the loop, down to 1/8 beat (shorter loops are a buzz, not a loop). */
  loopHalve() {
    if (!this.loop) return;
    const len = (this.loop.end - this.loop.start) / 2;
    if (len < (this.bpm ? this.beatLen / 8 : 0.03) - 1e-6) return;
    this.setLoop(this.loop.start, this.loop.start + len, this.loop.active);
  }
  loopDouble() { if (this.loop) this.setLoop(this.loop.start, this.loop.start + (this.loop.end - this.loop.start) * 2, this.loop.active); }
  get loopBeats() { return this.loop ? Math.round(((this.loop.end - this.loop.start) / this.beatLen) * 1000) / 1000 : 0; } // rounded: no 3.999999999

  /** Loop roll: momentary loop with slip, playback resumes where it would have been. */
  rollOn(beats) {
    if (!this.track || !this.playing) return;
    this._rollPrevSlip = this.slip; this.setSlip(true);
    this._rollSavedLoop = this.loop && !this.loop.active ? { ...this.loop } : null; // the user's saved (inactive) loop
    // quantised to the roll size's own grid (1/8 beat roll -> 1/8 beat grid), so the play head is already inside the
    // loop: no jump on press, the repeat starts on the grid, the worklet cross-fades each wrap
    const pos = this.position, g = Math.min(beats, 1) * this.beatLen;
    const start = this.bpm ? this.gridOffset + Math.floor((pos - this.gridOffset) / g + 1e-6) * g : pos;
    this.setLoop(start, start + beats * this.beatLen);
    this.rolling = true;
  }
  rollOff() {
    if (!this.rolling) return;
    this.rolling = false; this.exitLoop(); this.loop = this._rollSavedLoop || null; this._rollSavedLoop = null; this.setSlip(this._rollPrevSlip); this.emit('loop');
  }

  /** Beat jump by the deck's selected size (½ .. 64 beats), back (dir -1) or forward (dir 1). */
  jumpBySize(dir) { this.beatJump(dir * this.jumpSize); }
  setJumpSize(b) { if ([0.5, 1, 2, 4, 8, 16, 32, 64].includes(b)) { this.jumpSize = b; this.emit('state'); } }
  jumpSizeStep(dir) { this.setJumpSize(jumpSizeStep(this.jumpSize, dir)); }
  beatJump(beats) {
    if (!this.track) return;
    const d = beats * this.beatLen;
    if (this.loop?.active) this.setLoop(this.loop.start + d, this.loop.end + d);
    this.seek(this.position + d);
  }

  // ---------- tempo / sync ----------
  /**
   * Tempo in % (never outside the selected tempo range). A programmatic value beyond the range (sync to a far-away
   * BPM, instant doubles, DVS, Link) widens the range to the next standard step instead of pushing the tempo fader
   * cap off its track; user input (fader, MIDI, keys) is clamped to the range by its callers.
   */
  setTempo(pct) {
    if (this._glide && !this._glideSetting) this.cancelGlide();
    pct = clamp(Number(pct) || 0, -100, 100);
    if (Math.abs(pct) > this.tempoRange + 1e-9) { this.tempoRange = TEMPO_RANGES.find((r) => r >= Math.abs(pct) - 1e-9) || 100; this.emit('tempo-range', this.tempoRange); }
    this.tempo = pct; this.post('rate', { value: this.rate }); this.emit('tempo'); this.engine.onTempoChange(this);
    if (this.stemFxOn && this.effectiveBpm) this.stemFx?.setBeat(60 / this.effectiveBpm);
  }
  setTempoFader(v) { if (this.vinyl.quartz) return; this.setTempo(clamp(Number(v) || 0, -1, 1) * this.tempoRange); if (this.syncOn && !this.isMaster) { this.syncOn = false; this.emit('state'); } } // -1..1
  /** Pick the tempo range. The tempo keeps its value when it fits the new range, otherwise it is clamped to the range. */
  setTempoRange(r) {
    r = TEMPO_RANGES.includes(Number(r)) ? Number(r) : clamp(Number(r) || 8, 1, 100);
    this.tempoRange = r; this.emit('tempo-range', r);
    if (Math.abs(this.tempo) > r) { this.setTempo(Math.sign(this.tempo) * r); if (this.syncOn && !this.isMaster) { this.syncOn = false; this.emit('state'); } } else this.emit('tempo');
    return this.tempo / r;
  }
  /** Step the tempo by `pct` (MIDI tempo +/- buttons), staying inside the tempo range. */
  stepTempo(pct) { this.setTempo(clamp(this.tempo + pct, -this.tempoRange, this.tempoRange)); }
  resetTempo() { this.setTempo(0); }
  setBend(b) { if (this._glide) this.cancelGlide(); this.bend = b; this.post('rate', { value: this.rate }); }
  /** Hold-to-bend (T5): the bend grows from 1 % to 8 % over a second (or a fixed ±4 % with bendMode 'fixed'). */
  bendStart(dir) {
    clearInterval(this._bendRamp);
    if ((this.engine.settings.deckOptions?.bendMode || 'ramp') === 'fixed') return this.setBend(0.04 * dir);
    const t0 = performance.now();
    this.setBend(bendAt(0) * dir);
    this._bendRamp = setInterval(() => { const h = (performance.now() - t0) / 1000; this.setBend(bendAt(h) * dir); if (h >= 1) clearInterval(this._bendRamp); }, 25);
  }
  bendStop() { clearInterval(this._bendRamp); this.setBend(0); }

  // ---------- tempo glide (T5) ----------
  /**
   * Glide the tempo to `targetPct` over `beats` beats with the worklet's sample-accurate rate ramp
   * (message { type: 'rateRamp', to, dur, at? }, the same one the automix engine uses).
   */
  tempoGlide(targetPct, beats = 16) {
    if (!this.track) return false;
    targetPct = clamp(Number(targetPct) || 0, -100, 100);
    if (Math.abs(targetPct) > this.tempoRange + 1e-9) { this.tempoRange = [6, 8, 10, 16, 25, 50, 100].find((r) => r >= Math.abs(targetPct) - 1e-9) || 100; this.emit('tempo-range', this.tempoRange); }
    const mul = (1 + this.bend) * (this.rateMul || 1);
    const r0 = this.rate, r1 = (1 + targetPct / 100) * mul;
    if (!this.playing || !this.bpm || Math.abs(r1 - r0) < 1e-6) { this.setTempo(targetPct); return true; }
    const dur = glideDuration(beats, this.beatLen, r0, r1);
    const id = (this._glideId = (this._glideId || 0) + 1);
    this._glide = { id, target: targetPct, from: this.tempo, t0: this.ctx.currentTime, dur };
    this.post('rateRamp', { to: r1, dur, id });
    if (this.syncOn && !this.isMaster) { this.syncOn = false; this.emit('state'); }
    this.emit('glide');
    return true;
  }
  /** Glide to the master deck's tempo (half / double time aware). */
  glideToMaster(beats = 16) {
    const m = this.engine.masterDeck(this);
    if (!m || !m.bpm || !this.bpm) return false;
    return this.tempoGlide((this.syncTargetRatio(m) - 1) * 100, beats);
  }
  cancelGlide() { if (!this._glide) return; this._glide = null; this.post('rate', { value: this.rate }); this.emit('glide'); }
  get gliding() { return !!this._glide; }
  setKeyLock(v) { this.keyLock = v; this.post('keylock', { value: v }); this.emit('state'); }
  setQuantize(v) { this.quantize = v; this.emit('state'); }
  setSlip(v) { this.slip = v; this.post('slip', { value: v }); this.emit('state'); }
  setReverse(v) { if (this.slipReverse && !v) { this.slipReverse = false; this.setSlip(this._slipRevPrev); } this.reverse = v; this.post('reverse', { value: v }); this.emit('state'); }
  /** Latching slip reverse (T11): reverse with slip on until pressed again; playback resumes where it would have been. */
  toggleSlipReverse() {
    if (!this.track) return;
    if (this.slipReverse) { this.slipReverse = false; this.post('reverse', { value: false }); this.reverse = false; this.setSlip(this._slipRevPrev); return; }
    this._slipRevPrev = this.slip; this.setSlip(true); this.reverse = true; this.slipReverse = true; this.post('reverse', { value: true }); this.emit('state');
  }

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
    if (!this.track || this.loading) return;
    if (this.syncOn) { this.syncOn = false; this.emit('state'); return; }
    this.syncOn = true;
    if (this.matchTempo() && this.playing) this.alignPhase();
    this.emit('state');
  }
  setMaster() { this.engine.setMaster(this); }

  // ---------- jog / scratch ----------
  /** deltaRot: platter rotations since last call, dt seconds; 33⅓ rpm => 1.8 s audio per rotation (rpm sets it) */
  jogScratch(deltaRot, dt) {
    if (!this.track) return;
    if (this.loopAdjust) return this.adjustLoop(deltaRot * this.secPerRev * 0.25);
    if (!this.scratching) { this.scratching = true; this._wasPlaying = this.playing; }
    const v = clamp((deltaRot * this.secPerRev) / Math.max(dt, 0.001), -12, 12);
    this.post('scratch', { value: { velocity: v } });
    clearTimeout(this._scratchIdle);
    this._scratchIdle = setTimeout(() => this.scratching && this.post('scratch', { value: { velocity: 0 } }), 40);
  }
  jogRelease() {
    if (!this.scratching) return;
    this.scratching = false; clearTimeout(this._scratchIdle); this._handPos = false;
    if (!this.external) this.post('scratch', { value: null });
  }

  // ---------- position-following scratch (T3; shared with the controller plan §4.7) ----------
  /** Map an input event's timeStamp (performance.now() clock) to the audio clock the worklet runs on. */
  audioTimeOf(ts = performance.now()) {
    const off = this.ctx.currentTime - performance.now() / 1000;
    // the audio clock advances in render-quantum steps: follow the largest offset (a step's leading edge) up at once
    // and down slowly, so event times do not jitter by a quantum
    this._audioOff = this._audioOff == null || off > this._audioOff || off < this._audioOff - 0.05 ? off : this._audioOff - 1e-5;
    return ts / 1000 + this._audioOff;
  }
  /** Hand on the record (touch, mouse, a touch-sensitive jog): the platter follows jogPosition() until jogPositionEnd(). */
  jogPositionStart(ts) {
    if (!this.track || this.external) return false;
    if (this.loopAdjust) { this._adjRot = 0; this._handPos = 'adjust'; return true; }
    this.scratching = true; this._wasPlaying = this.playing; this._handPos = true; clearTimeout(this._scratchIdle);
    this.post('scratch', { value: { pos: true } });
    this.post('scratchPos', { pos: 0, t: this.audioTimeOf(ts) });
    this._handHist = [[ts ?? performance.now(), 0]];
    return true;
  }
  /** rot: platter turns since jogPositionStart (+ = forwards), ts: the event's timeStamp. */
  jogPosition(rot, ts) {
    if (!this._handPos) return;
    if (this._handPos === 'adjust') { const d = rot - this._adjRot; this._adjRot = rot; this.adjustLoop(d * this.secPerRev * 0.25); return; }
    ts ??= performance.now();
    this.post('scratchPos', { pos: rot * this.secPerRev * this.sr, t: this.audioTimeOf(ts) });
    const h = this._handHist; h.push([ts, rot]); while (h.length > 2 && ts - h[0][0] > 60) h.shift();
  }
  /** Platter speed (x normal) of the hand over its last ~40 ms. */
  handSpeed() {
    const h = this._handHist; if (!h || h.length < 2) return 0;
    const a = h[0], b = h[h.length - 1], dt = (b[0] - a[0]) / 1000;
    return dt > 0.004 ? ((b[1] - a[1]) * this.secPerRev) / dt : 0;
  }
  /** Hand off: the motor takes over (T1 release), or a fast backwards throw spins the record back (T10). */
  jogPositionEnd(ts) {
    if (!this._handPos) return;
    if (this._handPos === 'adjust') { this._handPos = false; return; }
    const h = this._handHist;
    if (h && ts != null && ts - h[h.length - 1][0] > 50) h.push([ts, h[h.length - 1][1]]); // held still before the lift
    const v = this.handSpeed();
    this._handPos = false; this.scratching = false;
    this.post('scratch', { value: null });
    if (this.playing && v < -3 && this.engine.settings.deckOptions?.flickSpinback) this.backspin(this.vinyl.spinTime, Math.min(8, -v));
    return v;
  }
  /** Outer-ring nudge (pitch bend) or seek when paused */
  jogNudge(deltaRot) {
    if (!this.track) return;
    if (this.loopAdjust) return this.adjustLoop(deltaRot * this.secPerRev * 0.25);
    if (!this.playing) { this.seek(this.position + deltaRot * this.secPerRev * 0.25); return; }
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
          floatToInt16(src.length > frames ? src.subarray(0, frames) : src, dst, this.audioScale || 1); // same scale as the deck audio
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
  brake(seconds = this.vinyl.brakeTime || 1.2) { if (!this.playing) return; this.post('brake', { value: 1 / (seconds * this.ctx.sampleRate) }); }
  /** Backspin: the record is thrown backwards and spins down (worklet-timed, sample accurate), then the deck stops. */
  backspin(seconds = this.vinyl.spinTime || 1.0, speed = this.vinyl.spinSpeed || 4.5) {
    if (!this.track) return;
    this.post('backspin', { seconds, speed });
  }
  /** Slip brake / slip spin-back (T10): the effect plays, then the track carries on where it would have been. */
  slipBrake(seconds = this.vinyl.brakeTime || 1.2) {
    if (!this.playing) return;
    this._slipStopPrev ??= this.slip; this.setSlip(true);
    this.post('brake', { value: 1 / (seconds * this.ctx.sampleRate), slip: true });
  }
  slipBackspin(seconds = this.vinyl.spinTime || 1.0, speed = this.vinyl.spinSpeed || 4.5) {
    if (!this.track || !this.playing) return;
    this._slipStopPrev ??= this.slip; this.setSlip(true);
    this.post('backspin', { seconds, speed, slip: true });
  }

  // ---------- vinyl model (T1-T4) ----------
  /** Apply vinyl options (see audio/vinyl.js VINYL_DEFAULTS) to the worklet's motor, jog weight and rpm. */
  applyVinyl(v) {
    const old = this.vinyl || {};
    this.vinyl = { ...VINYL_DEFAULTS, ...old, ...v };
    const n = this.vinyl;
    if (['start', 'stop', 'inertia', 'slipmat'].some((k) => old[k] !== n[k]) || !this._motorSent) { this._motorSent = true; this.post('motor', { value: { start: n.start, stop: n.stop, inertia: n.inertia, slipmat: n.slipmat } }); }
    if (old.jogWeight !== n.jogWeight || !this._weightSent) { this._weightSent = true; this.post('jogWeight', { value: n.jogWeight }); }
    if (n.quartz && !old.quartz) this.setTempo(0);
    this.emit('vinyl');
  }

  // ---------- scale play (T11: pads change the platter speed) ----------
  /** Play at `semis` semitones by platter speed (key lock off while held); null returns to normal speed. */
  setRateStep(semis) {
    if (semis == null) {
      this.rateMul = 1;
      if (this._rateKeyLock != null) { this.setKeyLock(this._rateKeyLock); this._rateKeyLock = null; }
    } else {
      if (this._rateKeyLock == null) { this._rateKeyLock = this.keyLock; if (this.keyLock) this.setKeyLock(false); }
      this.rateMul = semitoneRate(semis);
    }
    this.post('rate', { value: this.rate }); this.emit('state');
  }

  // ---------- scratch samples (T9) ----------
  /**
   * Swap the deck to a short sample (an AudioBuffer under ~15 s): the platter, faders and FX work on it as on a track.
   * The track's audio stays in the worklet; scratchSampleReturn() puts it back where it would have been.
   */
  scratchSampleIn(buffer, name = 'Sample', slot = 0) {
    if (!buffer || this.loading) return false;
    const now = this.ctx.currentTime;
    if (!this.scratchSample) {
      if (!this.track) return false;
      this.scratchSample = { saved: { track: this.track, duration: this.duration, sr: this.sr, waveform: this.waveform, bpm: this.bpm, gridOffset: this.gridOffset, cuePoint: this.cuePoint, loop: this.loop, loopIn: this.loopIn, frames: this.frames, slip: this.slip, playing: this.playing, rate: this.rate, position: this.position, at: now, countedPlay: this._countedPlay } };
      if (this.loop?.active) this.post('loop', { value: null });
    }
    const ss = this.scratchSample; ss.slot = slot; ss.name = name;
    const ch0 = buffer.getChannelData(0), ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
    const left = new Float32Array(ch0), right = ch1 ? new Float32Array(ch1) : null;
    this.node.port.postMessage({ type: 'altLoad', left, right, sampleRate: buffer.sampleRate, scale: 1 }, right ? [left.buffer, right.buffer] : [left.buffer]);
    this.track = { id: `scratch:${slot}`, title: name, artist: 'Scratch sample', scratchSample: true, cues: [] };
    this.duration = buffer.duration; this.sr = buffer.sampleRate; this.waveform = null; this.bpm = 0; this.gridOffset = 0;
    this.cuePoint = 0; this.loop = null; this.loopIn = null; this.frames = buffer.length; this._countedPlay = true;
    this._pos = 0; this._t = now; this._seekGuard = now;
    this.emit('sample'); this.emit('loop'); this.emit('state');
    return true;
  }
  /** Back to the track: at the snapshot position, or where it would be now if slip was on and it was playing. */
  scratchSampleReturn() {
    const ss = this.scratchSample; if (!ss) return false;
    const s = ss.saved, now = this.ctx.currentTime;
    let pos = s.position;
    if (s.slip && s.playing) pos += (now - s.at) * s.rate;
    pos = clamp(pos, 0, Math.max(0, s.duration - 0.001));
    this.scratchSample = null;
    Object.assign(this, { track: s.track, duration: s.duration, sr: s.sr, waveform: s.waveform, bpm: s.bpm, gridOffset: s.gridOffset, cuePoint: s.cuePoint, loop: s.loop, loopIn: s.loopIn, frames: s.frames, _countedPlay: s.countedPlay });
    this.post('altReturn', { frame: pos * this.sr });
    this._pos = pos; this._t = now; this._seekGuard = now;
    if (this.loop?.active) this.post('loop', { value: { start: this.loop.start * this.sr, end: this.loop.end * this.sr } });
    this._armedKey = null; this.armActiveLoop(pos);
    this.emit('sample'); this.emit('loop'); this.emit('state');
    return true;
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
      // phrase loudness needs the audio: carry it over from the old phrases (energy-weighted by overlap)
      const patch = { phrases: carryPhraseLufs(t.phrases, st.phrases), mixIn: st.mixIn, mixOut: st.mixOut, downbeat: st.downbeat, phraseAnchor: st.phraseAnchor, phraseConfidence: st.phraseConfidence };
      Object.assign(t, patch);
      api.updateTrack(t.id, patch).catch(() => {});
      this.emit('cues');
    } catch (e) { console.warn('structure analysis failed', e); }
  }
  gridSetDownbeatHere() { this.setGrid(this.bpm, this.position); }
  gridShift(sec) { this.setGrid(this.bpm, this.gridOffset + sec); }

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
    if (!this._slicing) this._sliceSavedLoop = this.loop && !this.loop.active ? { ...this.loop } : null; // the user's saved (inactive) loop
    this._slicePrevSlip = this._slicing ? this._slicePrevSlip : this.slip;
    this._slicing = true; this.setSlip(true);
    const start = this._sliceStart + n * b;
    this.setLoop(start, start + b); this.seek(start + (this.position - this.floorBeat(this.position)));
  }
  sliceUp() {
    if (!this._slicing) return;
    this._slicing = false; this.exitLoop(); this.loop = this._sliceSavedLoop || null; this._sliceSavedLoop = null; this.setSlip(this._slicePrevSlip); this.emit('loop');
  }

  // ---------- instant doubles ----------
  async cloneFrom(src) {
    if (!src?.track || src === this || src.track.scratchSample) return;
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
export function deckChannel(src, highPrecision = false, scale = 1) {
  if (highPrecision) return new Float32Array(src);
  const out = new Int16Array(src.length);
  const g = 32767 / (scale > 1 ? scale : 1);
  let seed = 22222;
  for (let i = 0; i < src.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0; const r1 = seed / 4294967296;
    seed = (seed * 1664525 + 1013904223) >>> 0; const r2 = seed / 4294967296;
    const v = Math.round(src[i] * g + (r1 - r2)); // ±1 LSB triangular dither
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

// ---- time-sliced versions for the UI thread: same results, but they hand control back every ~6 ms ----
const SLICE = 1 << 17;
const yieldTask = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); });
/** deckChannel() in slices (identical output, including the dither sequence). */
export async function deckChannelSliced(src, highPrecision = false, scale = 1) {
  if (highPrecision) return new Float32Array(src);
  const out = new Int16Array(src.length);
  const g = 32767 / (scale > 1 ? scale : 1);
  let seed = 22222;
  for (let a = 0; a < src.length; a += SLICE) {
    const b = Math.min(src.length, a + SLICE);
    for (let i = a; i < b; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0; const r1 = seed / 4294967296;
      seed = (seed * 1664525 + 1013904223) >>> 0; const r2 = seed / 4294967296;
      const v = Math.round(src[i] * g + (r1 - r2));
      out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    if (b < src.length) await yieldTask();
  }
  return out;
}
export async function peakAbsSliced(src) {
  let p = 0;
  for (let a = 0; a < src.length; a += SLICE * 4) {
    const b = Math.min(src.length, a + SLICE * 4);
    for (let i = a; i < b; i++) { const x = src[i] < 0 ? -src[i] : src[i]; if (x > p) p = x; }
    if (b < src.length) await yieldTask();
  }
  return p;
}

/** Largest absolute sample value of a channel. */
export function peakAbs(src) {
  let p = 0;
  for (let i = 0; i < src.length; i++) { const a = src[i] < 0 ? -src[i] : src[i]; if (a > p) p = a; }
  return p;
}
