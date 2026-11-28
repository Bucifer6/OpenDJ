// DVS (digital vinyl system): control decks with timecode vinyl / CDs through an audio interface's inputs.
//
//   getUserMedia(multi-channel, no processing) → MediaStreamSource → ChannelSplitter
//     → per deck: ChannelMerger(2) of its channel pair → AudioWorkletNode 'dvs-decoder' → muted sink
//
// The decoder reports the record's speed (and position, for timecodes with a known LFSR) every 128 frames.
// Modes per deck:
//   ABS  the track position follows the record (needle drops jump), speed follows the platter
//   REL  only speed / direction follow the record; needle drops are ignored
//   INT  the deck plays from software (the decoder keeps running for the scope)
import { Emitter, clamp } from '../util.js';
import { TIMECODES, RPM_FACTOR, buildPositionTable } from './timecode-defs.js';

export const DVS_MODES = ['abs', 'rel', 'int'];
const SENSITIVITY = { line: { gain: 1, gate: 0.004 }, phono: { gain: 6, gate: 0.004 }, cd: { gain: 1, gate: 0.008 } };
const END_WARNING_SECONDS = 60;

const deckDefaults = (i) => ({ mode: 'rel', pair: i, timecode: 'serato_2a', rpm: 33, sensitivity: 'line', swap: false, invertPhase: false, invertBits: false, offset: 0, cal: null });
export function dvsDefaults() { return { enabled: false, deviceId: '', channelCount: 4, decks: [0, 1, 2, 3].map(deckDefaults) }; }

/**
 * Speed control of a deck from an external source. Uses deck.setExternalSpeed() when the deck provides it;
 * otherwise the same behaviour through the deck's public message API.
 * v: playback speed (1 = normal, negative = reverse), null = hand control back to the deck.
 * viaPort: the speed itself already reaches the deck worklet directly (only update the transport state).
 */
export function setExternalSpeed(deck, v, viaPort = false) {
  if (typeof deck.setExternalSpeed === 'function') return deck.setExternalSpeed(v, viaPort);
  if (v == null) {
    if (!deck.external) return;
    deck.external = false;
    if (!viaPort) deck.post('scratch', { value: null });
    return;
  }
  if (!deck.track || deck.loading) return;
  deck.external = true;
  if (!viaPort) deck.post('scratch', { value: { velocity: clamp(v, -16, 16) } });
  const moving = Math.abs(v) > 0.05;
  if (moving !== deck.playing) {
    deck.playing = moving; deck.post('play', { value: moving });
    if (moving) deck.engine.onDeckPlay?.(deck);
    deck.emit('state');
  }
}

export class DvsManager extends Emitter {
  constructor(app) {
    super();
    this.app = app; this.engine = app.engine; this.ctx = app.engine.ctx;
    this.decks = [0, 1, 2, 3].map((i) => new DvsDeck(this, i));
    this.running = false; this.error = null; this.stream = null; this.channels = 0;
    this._tables = new Map();
  }

  get settings() {
    const s = this.app.settings?.dvs || {};
    const d = dvsDefaults();
    return { ...d, ...s, decks: d.decks.map((x, i) => ({ ...x, ...(s.decks?.[i] || {}) })) };
  }
  async save(patch) {
    const next = { ...this.settings, ...patch };
    if (this.app.setSetting) await this.app.setSetting('dvs', next); else this.app.settings = { ...this.app.settings, dvs: next };
    this.emit('change');
  }
  async saveDeck(i, patch) {
    const s = this.settings; s.decks[i] = { ...s.decks[i], ...patch };
    await this.save({ decks: s.decks });
    this.decks[i].applyConfig();
  }

  async init() { if (this.settings.enabled) await this.start().catch((e) => { this.error = e.message; this.emit('change'); }); }

  async listInputs() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'audioinput').map((d) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'System default' : `Input ${d.deviceId.slice(0, 6)}`) }));
    } catch { return []; }
  }

  async _loadModule() {
    if (!this._module) this._module = this.ctx.audioWorklet.addModule(new URL('./dvs-worklet.js', import.meta.url));
    await this._module;
  }

  /** Open the audio interface (or use `stream`, e.g. a test signal) and start decoding. */
  async start(stream = null) {
    await this.stop(false);
    this.error = null;
    await this._loadModule();
    const s = this.settings;
    if (!stream) {
      const audio = {
        deviceId: s.deviceId ? { exact: s.deviceId } : undefined,
        channelCount: { ideal: s.channelCount || 2 },
        sampleRate: { ideal: this.ctx.sampleRate },
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        latency: { ideal: 0.003 },
      };
      stream = await navigator.mediaDevices.getUserMedia({ audio });
      this._ownStream = true;
    } else this._ownStream = false;
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    const st = track?.getSettings?.() || {};
    this.source = this.ctx.createMediaStreamSource(stream);
    this.channels = Math.max(1, st.channelCount || this.source.channelCount || 2);
    this.source.channelCountMode = 'explicit'; this.source.channelInterpretation = 'discrete';
    this.splitter = this.ctx.createChannelSplitter(Math.max(2, Math.min(32, this.channels)));
    this.source.connect(this.splitter);
    this.sink = this.ctx.createGain(); this.sink.gain.value = 0; this.sink.connect(this.ctx.destination);
    this.deviceLabel = track?.label || '';
    this.running = true;
    this.engine._dvsRunning = true;
    this.engine._wakeTick?.();
    if (!this._deckHooks) { // keep the decoder's direct link in step with deck reloads
      this._deckHooks = this.engine.decks.map((d, i) => d.on('loaded', () => this.decks[i].node?.port.postMessage({ type: 'resync' })));
    }
    for (const d of this.decks) await d.connect();
    if ((s.channelCount || 2) > this.channels) this.engine.emit?.('warning', `DVS: the input delivers ${this.channels} channel(s); ${s.channelCount} were requested`);
    this.emit('change');
  }

  async stop(emit = true) {
    for (const d of this.decks) d.disconnect();
    try { this.source?.disconnect(); this.splitter?.disconnect(); this.sink?.disconnect(); } catch { /* */ }
    if (this._ownStream) this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.source = null; this.splitter = null; this.running = false;
    this.engine._dvsRunning = false;
    if (emit) this._tables.clear();
    if (emit) this.emit('change');
  }

  async setEnabled(on) {
    await this.save({ enabled: on });
    if (on) { try { await this.start(); } catch (e) { this.error = e.message; this.emit('change'); throw e; } } else await this.stop();
  }

  /** LFSR position table for a timecode (cached; built on the main thread, copied into each decoder). */
  table(def) {
    if (!def.bits) return null;
    if (!this._tables.has(def.id)) this._tables.set(def.id, buildPositionTable(def));
    return this._tables.get(def.id);
  }
}

export class DvsDeck extends Emitter {
  constructor(mgr, index) {
    super();
    this.mgr = mgr; this.index = index; this.node = null; this.merger = null;
    this.status = null; this.trim = 1; this.direct = false;
    this.leadIn = false; this.endWarning = false; this.lastSeek = 0; this.lastV = 0; this._lastTempoAt = 0;
  }
  get settings() { return this.mgr.settings.decks[this.index]; }
  get deck() { return this.mgr.engine.decks[this.index]; }
  get def() { return TIMECODES[this.settings.timecode] || TIMECODES.serato_2a; }
  get mode() { return this.settings.mode; }
  get active() { return this.mgr.running && !!this.node; }

  async connect() {
    const m = this.mgr, s = this.settings, ctx = m.ctx;
    const ch0 = s.pair * 2, ch1 = ch0 + 1;
    if (ch0 >= m.channels) return; // pair not delivered by the interface
    const sens = SENSITIVITY[s.sensitivity] || SENSITIVITY.line;
    this.node = new AudioWorkletNode(ctx, 'dvs-decoder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete',
      processorOptions: { def: this.def, rpm: s.rpm, swap: s.swap, invertPhase: s.invertPhase, invertBits: s.invertBits, gain: sens.gain, gate: s.cal?.gate ?? sens.gate, mode: s.mode },
    });
    this.merger = ctx.createChannelMerger(2);
    m.splitter.connect(this.merger, ch0, 0);
    m.splitter.connect(this.merger, Math.min(ch1, m.channels - 1), 1);
    this.merger.connect(this.node); this.node.connect(m.sink);
    this.node.port.onmessage = (e) => this.onMessage(e.data);
    if (s.cal?.gR) this.node.port.postMessage({ type: 'config', gR: s.cal.gR, rho: s.cal.rho });
    // direct worklet-to-worklet link (lowest latency) when the deck supports it
    this.direct = false;
    if (typeof this.deck.attachExternalPort === 'function') {
      const ch = new MessageChannel();
      try { this.deck.attachExternalPort(ch.port2); this.node.port.postMessage({ type: 'deckPort', port: ch.port1 }, [ch.port1]); this.direct = true; } catch { /* fall back to the main thread */ }
    }
    this.sendTable();
  }

  sendTable() {
    if (!this.node) return;
    const def = this.def;
    if (this.mode !== 'abs' || !def.bits) {
      if (this._sentTableId) {
        this._sentTableId = null;
        this.node.port.postMessage({ type: 'table', table: null });
      }
      return;
    }
    if (this._sentTableId === def.id) return;
    const t = this.mgr.table(def);
    const copy = t.slice();
    this._sentTableId = def.id;
    this.node.port.postMessage({ type: 'table', table: copy }, [copy.buffer]);
  }

  disconnect() {
    if (this.node) { try { this.node.port.postMessage({ type: 'config', mode: 'int' }); this.merger.disconnect(); this.node.disconnect(); } catch { /* */ } }
    this.node = null; this.merger = null; this.status = null; this._sentTableId = null;
    this.release(false);
  }

  /** Settings changed (mode, timecode, rpm …): reconfigure the running decoder. */
  applyConfig() {
    if (!this.node) { if (this.mgr.running) this.connect(); return; }
    const s = this.settings, sens = SENSITIVITY[s.sensitivity] || SENSITIVITY.line;
    const prevMode = this._mode;
    this.node.port.postMessage({ type: 'config', def: this.def, rpm: s.rpm, swap: s.swap, invertPhase: s.invertPhase, invertBits: s.invertBits, gain: sens.gain, gate: s.cal?.gate ?? sens.gate, mode: s.mode });
    this.sendTable();
    if (s.mode === 'int' && prevMode && prevMode !== 'int') this.release(true);
    this._mode = s.mode;
    this.emit('change');
  }

  async setMode(mode) {
    if (!DVS_MODES.includes(mode)) return;
    const was = this.mode;
    await this.mgr.saveDeck(this.index, { mode });
    if (mode === 'int' && was !== 'int') this.release(true);
  }
  cycleMode() { return this.setMode(DVS_MODES[(DVS_MODES.indexOf(this.mode) + 1) % DVS_MODES.length]); }

  /** Hand the deck back to software control; keepPlaying = continue at the record's last speed (INT mode). */
  release(keepPlaying) {
    const d = this.deck, v = this.lastV;
    if (!d) return;
    if (this.node && this.direct) this.node.port.postMessage({ type: 'config', mode: 'int' });
    setExternalSpeed(d, null, false);
    if (keepPlaying && d.track && Math.abs(v) > 0.1) {
      if (v > 0) { d.setTempo(clamp((v - 1) * 100, -100, 100)); d.play(); } else d.pause();
    }
    this.lastV = 0; this.trim = 1;
  }

  calibrate(seconds = 1.5) {
    if (!this.node) return Promise.reject(new Error('DVS input not running for this deck'));
    return new Promise((resolve, reject) => {
      this._calResolve = { resolve, reject };
      this.node.port.postMessage({ type: 'calibrate', seconds });
      setTimeout(() => { if (this._calResolve) { this._calResolve = null; reject(new Error('Calibration timed out')); } }, seconds * 1000 + 3000);
    });
  }

  onMessage(m) {
    if (m.type === 'v') this.onSpeed(m);
    else if (m.type === 'status') { this.status = m; this.emit('status', m); }
    else if (m.type === 'calibrated') {
      const r = m.result, p = this._calResolve; this._calResolve = null;
      if (!r.ok) { p?.reject(new Error(r.error)); return; }
      this.mgr.saveDeck(this.index, { cal: { gR: m.gR, rho: m.rho, gate: m.gate }, invertPhase: m.invertPhase, rpm: m.rpm });
      p?.resolve(r);
    }
  }

  /** ~375×/s: drive the deck from the decoded speed (and position in ABS mode). */
  onSpeed(m) {
    const mode = this._mode = this.mode;
    if (mode === 'int' || this.index >= (this.mgr.app.deckCount || 4)) return;
    const d = this.deck;
    if (!d.track || d.loading) return;
    const now = d.ctx.currentTime;
    const rpmF0 = RPM_FACTOR[this.settings.rpm] || 1;
    let v = m.v; // includes the ABS trim
    const base = m.speed / rpmF0; // the record's own speed
    this.lastV = base;
    if (mode === 'abs' && m.lock && m.pos >= 0) {
      const def = this.def, s = this.settings, rpmF = RPM_FACTOR[s.rpm] || 1;
      const target = m.pos / (def.carrier * rpmF) - (def.leadIn || 0) + (s.offset || 0) + Math.max(0, now - m.t) * base;
      this.leadIn = target < 0;
      const end = def.safe ? (def.safe / def.carrier) - END_WARNING_SECONDS : Infinity;
      const near = m.pos / def.carrier > end;
      if (near !== this.endWarning) { this.endWarning = near; if (near) this.mgr.engine.emit?.('warning', `Deck ${this.index + 1}: near the end of the timecode record`); this.emit('change'); }
      if (this.leadIn) { if (d.position > 0.02 && now - this.lastSeek > 0.1) { d.seek(0); this.lastSeek = now; } v = 0; this.setTrim(0); } // hold at the start
      else {
        const err = target - d.position;
        if (Math.abs(err) > 0.2 && now - this.lastSeek > 0.15) { d.seek(Math.min(target, Math.max(0, d.duration - 0.01))); this.lastSeek = now; this.setTrim(1); this.emit('needle-drop', target); }
        else if (Math.abs(base) > 0.2 && Math.abs(err) > 0.004) this.setTrim(1 + clamp(err * 0.8, -0.04, 0.04)); // pull gently into place
        else this.setTrim(1);
      }
    } else { if (this.trim !== 1) this.setTrim(1); this.leadIn = false; }
    setExternalSpeed(d, v, this.direct);
    // the turntable's pitch fader becomes the deck tempo (BPM display, sync, INT hand-over)
    if (m.sig && base > 0.3 && now - this._lastTempoAt > 0.1 && this.status) {
      this._lastTempoAt = now;
      const rpmF = RPM_FACTOR[this.settings.rpm] || 1;
      const pct = clamp((this.status.pitch / rpmF - 1) * 100, -50, 50);
      if (Math.abs(pct - d.tempo) > 0.05 && Math.abs(base - this.status.pitch / rpmF) < 0.05) d.setTempo(Math.round(pct * 100) / 100);
    }
  }

  setTrim(t) {
    if (Math.abs(t - this.trim) < 1e-4) return;
    this.trim = t;
    this.node?.port.postMessage({ type: 'trim', value: t });
  }
}
