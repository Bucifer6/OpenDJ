// Lighting integration (renderer side).
//  - feeds the master deck's beat clock / phrase / level / key to the server's show engine (~12 Hz + on every beat)
//  - drives an Enttec DMX USB Pro-compatible widget over Web Serial with frames streamed from the server
//  - optional MIDI notes on beat / phrase for lighting software that listens to MIDI
//  - opens the lighting panel
import { api } from '../api.js';
import { Emitter } from '../util.js';
import { toCamelot } from '../audio/analysis-core.js';
import { encodeEnttecDmx, base64ToBytes } from './enttec.js';

const SEND_MS = 80; // regular state updates (~12 Hz); beat and phrase changes are sent immediately
const POLL_MS = 20;
const PHRASES = ['intro', 'verse', 'buildup', 'drop', 'breakdown', 'outro'];

export class Lighting extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.config = null; this.meta = null; this.live = {};
    this.usb = { port: null, writer: null, es: null, connected: false, frames: 0, error: null, busy: false };
    this._last = { beat: null, phrase: null, sent: 0 };
    this._inflight = false;
  }

  async init() {
    try {
      const r = await api.lighting();
      this.config = r.config; this.meta = r.meta; this.live = r.live;
    } catch (e) { console.warn('[lighting]', e.message); return; }
    this._apply();
    // reconnect a previously granted USB DMX widget without a prompt
    if (this.config.outputs.usbdmx.enabled && navigator.serial?.getPorts) {
      const [port] = await navigator.serial.getPorts().catch(() => []);
      if (port) this.connectUsb(port).catch(() => {});
    }
  }

  get enabled() { return !!this.config?.enabled; }

  _apply() {
    const on = this.enabled;
    if (on && !this._timer) this._timer = setInterval(() => this._poll(), POLL_MS);
    if (!on && this._timer) { clearInterval(this._timer); this._timer = null; this._push({ playing: false, at: Date.now() }); }
    if (this.usb.connected) this._openDmxStream();
    this.emit('config', this.config);
  }

  async saveConfig(cfg) {
    this.config = await api.saveLightingConfig(cfg);
    this._apply();
    return this.config;
  }
  async update(fn) { const c = structuredClone(this.config); fn(c); return this.saveConfig(c); }
  async setEnabled(on) { return this.update((c) => { c.enabled = !!on; }); }

  async setLive(patch) {
    const r = await api.lightingLive(patch);
    this.live = r.live; Object.assign(this.config.show, r.show);
    this.emit('live', this.live);
    return r;
  }
  test(ms = 1000) { return api.lightingTest(ms); }

  async openPanel(tab) {
    const { openLightingPanel } = await import('./panel.js');
    return openLightingPanel(this, tab);
  }

  // ---------------------------------------------------------------- music state feed
  /** Snapshot of the master deck, with the beat position corrected for audio output latency. */
  sample() {
    const eng = this.app.engine;
    const at = Date.now();
    const d = eng?.masterDeck?.();
    if (!d || !d.track || !d.bpm) return { playing: false, at, bpm: this._last.bpm || 0, beat: 0 };
    const rate = Math.abs(d.rate || 1);
    const lat = (eng.ctx?.outputLatency || eng.ctx?.baseLatency || 0);
    const pos = d.position - (d.playing ? lat * rate : 0);
    const beatLen = d.beatLen;
    const beat = (pos - d.gridOffset) / beatLen;
    const t = d.track;
    const ph = (t.phrases || []).find((p) => pos >= p.start && pos < p.end);
    const db = Number.isFinite(t.downbeat) ? Math.round((t.downbeat - d.gridOffset) / beatLen) : 0;
    let level = 0;
    if (d.playing) {
      try { const [l, r] = eng.masterLevels(); level = Math.min(1, Math.max(l, r)); } catch { /* no meter */ }
    }
    return {
      playing: !!d.playing, at, bpm: Math.round(d.bpm * rate * 1000) / 1000, beat: Math.round(beat * 10000) / 10000,
      barOffset: ((db % 4) + 4) % 4,
      phrase: ph?.type || null, phraseBeat: ph ? Math.round((pos - ph.start) / beatLen * 1000) / 1000 : 0,
      phraseLen: ph ? Math.round((ph.end - ph.start) / beatLen * 1000) / 1000 : 0, phraseEnergy: ph?.energy ?? null,
      level: Math.round(level * 1000) / 1000, key: toCamelot(t.key), energy: t.energy || null, deck: d.index,
    };
  }

  _poll() {
    const s = this.sample();
    const beat = s.playing ? Math.floor(s.beat + 1e-6) : null;
    const now = s.at;
    const playingChanged = s.playing !== this._last.playing;
    const beatChanged = beat !== this._last.beat, phraseChanged = s.phrase !== this._last.phrase;
    const minSend = s.playing ? SEND_MS : 1000;
    if (playingChanged || beatChanged || phraseChanged || now - this._last.sent >= minSend) this._push(s);
    if (beatChanged && beat != null) this._midiBeat(((beat - s.barOffset) % 4 + 4) % 4 === 0);
    if (phraseChanged && s.phrase && s.playing) this._midiPhrase(s.phrase);
    this._last.beat = beat; this._last.phrase = s.phrase; this._last.bpm = s.bpm; this._last.playing = s.playing;
  }

  _push(s) {
    if (this._inflight) { this._pending = s; return; }
    this._inflight = true; this._last.sent = s.at;
    api.lightingState(s).catch(() => {}).finally(() => {
      this._inflight = false;
      if (this._pending) { const p = this._pending; this._pending = null; this._push({ ...p }); }
    });
  }

  // ---------------------------------------------------------------- MIDI notes (optional)
  _midiOut() {
    const m = this.config?.outputs?.midi;
    if (!m?.enabled || !m.output) return null;
    const out = this.app.midi?.outputs?.().find((o) => o.name === m.output);
    return out ? { out, m } : null;
  }
  _note(note) {
    const o = this._midiOut(); if (!o) return;
    const ch = (o.m.channel - 1) & 15;
    try { o.out.send([0x90 | ch, note & 127, 127]); o.out.send([0x80 | ch, note & 127, 0], performance.now() + 60); } catch { /* port gone */ }
  }
  _midiBeat(downbeat) { const m = this.config?.outputs?.midi; if (m?.enabled) this._note(downbeat ? m.downbeatNote : m.beatNote); }
  _midiPhrase(type) { const m = this.config?.outputs?.midi; if (m?.enabled) this._note(m.phraseNote + Math.max(0, PHRASES.indexOf(type))); }

  // ---------------------------------------------------------------- USB DMX (Enttec DMX USB Pro compatible, Web Serial)
  get serialSupported() { return !!navigator.serial; }

  async connectUsb(port) {
    if (!navigator.serial) throw new Error('Web Serial is not available in this browser (use the desktop app, Chrome or Edge).');
    await this.disconnectUsb();
    port = port || await navigator.serial.requestPort();
    await port.open({ baudRate: 57600 }); // FTDI-based Pro widgets ignore the baud rate
    const info = port.getInfo?.() || {};
    Object.assign(this.usb, { port, writer: port.writable.getWriter(), connected: true, error: null, frames: 0,
      name: info.usbVendorId ? `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId || 0).toString(16).padStart(4, '0')}` : 'Serial port' });
    port.addEventListener?.('disconnect', () => { this.usb.error = 'Disconnected'; this.disconnectUsb(); });
    this._openDmxStream();
    this.emit('usb', this.usb);
  }

  _openDmxStream() {
    this.usb.es?.close();
    const u = this.config?.outputs?.usbdmx;
    if (!u?.enabled) { this.usb.es = null; return; }
    const es = this.usb.es = new EventSource(api.lightingStreamUrl({ dmx: u.universe }));
    es.addEventListener('dmx', (e) => this._writeDmx(base64ToBytes(e.data)));
  }

  async _writeDmx(data) {
    const w = this.usb.writer;
    if (!w || this.usb.busy) { this.usb.queued = data; return; } // keep only the newest frame
    this.usb.busy = true;
    try { await w.write(encodeEnttecDmx(data)); this.usb.frames++; } catch (e) { this.usb.error = e.message; }
    this.usb.busy = false;
    if (this.usb.queued) { const q = this.usb.queued; this.usb.queued = null; this._writeDmx(q); }
  }

  async disconnectUsb() {
    const u = this.usb;
    u.es?.close(); u.es = null;
    try { u.writer?.releaseLock(); } catch { /* */ }
    try { await u.port?.close(); } catch { /* */ }
    Object.assign(u, { port: null, writer: null, connected: false, busy: false, queued: null });
    this.emit('usb', u);
  }
}
