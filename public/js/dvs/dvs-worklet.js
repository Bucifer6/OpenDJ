// AudioWorklet: one timecode decoder per deck. Loaded with ctx.audioWorklet.addModule(); runs on the audio thread.
// Input: one stereo pair (the deck's timecode channels). Output: silence (connected to a muted sink so the
// node keeps being processed).
// Messages in:  config {def, rpm, swap, invertPhase, invertBits, gain, gate, mode, enabled}, table {table},
//               calibrate {seconds}, trim {value}, deckPort {port}  (direct link to the deck processor), resync
// Messages out: v {v, speed, sig, pos, lock, t}  ~every 128 frames
//               status {...meters, scope}         ~30 per second
//               calibrated {result}
import { TimecodeDecoder } from './timecode-core.js';

class DvsDecoderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.dec = new TimecodeDecoder({ sampleRate, def: o.def, rpm: o.rpm, swap: o.swap, invertPhase: o.invertPhase, invertBits: o.invertBits, gain: o.gain, gate: o.gate });
    this.mode = o.mode || 'rel';
    this.trim = 1;
    this.deckPort = null; this.lastSent = null;
    this.statusEvery = Math.round(sampleRate / 30); this.statusCount = 0;
    this._vEvery = Math.round(sampleRate / 30); this._vCount = 0; this._lastSig = false;
    this.peak = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'config': this.dec.configure(m); if (m.mode) this.mode = m.mode; if (m.gR != null) { this.dec.gR = m.gR; this.dec.rho = m.rho || 0; } break;
      case 'table': this.dec.setTable(m.table); break;
      case 'calibrate': this.dec.startCalibration(m.seconds || 1.5); this.calibrating = true; break;
      case 'trim': this.trim = m.value; break;
      case 'deckPort': this.deckPort = m.port || null; this.lastSent = null; break;
      case 'resync': this.lastSent = NaN; break; // deck reloaded: re-send the speed even if unchanged
    }
  }

  process(inputs) {
    const inp = inputs[0];
    const L = inp && inp[0], R = inp && (inp[1] || inp[0]);
    if (!L) return true;
    const d = this.dec;
    for (let i = 0; i < L.length; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > this.peak) this.peak = a; if (b > this.peak) this.peak = b; }
    d.process(L, R);
    const v = d.velocity * this.trim;
    const external = this.mode === 'abs' || this.mode === 'rel';
    // direct, audio-thread-to-audio-thread speed control (no main-thread latency), when the deck supports it
    if (this.deckPort && external) {
      const vv = Math.abs(v) < 1e-3 ? 0 : v;
      if (this.lastSent === null || (vv === 0) !== (this.lastSent === 0) || Math.abs(vv - this.lastSent) > 1e-4) {
        this.deckPort.postMessage({ type: 'scratch', value: { velocity: vv } });
        this.lastSent = vv;
      }
    } else if (this.deckPort && this.lastSent !== null) { this.deckPort.postMessage({ type: 'scratch', value: null }); this.lastSent = null; }
    // When deckPort handles audio-thread velocity directly, only send main-thread 'v' updates at ~30 Hz (or immediately on ABS lock / signal transitions)
    const sigChanged = !!d.signal !== this._lastSig;
    this._lastSig = !!d.signal;
    this._vCount += L.length;
    const needV = !this.deckPort || (this.mode === 'abs' && d.lock) || sigChanged || (external && d.signal && this._vCount >= this._vEvery);
    if (needV) {
      this._vCount = 0;
      this.port.postMessage({ type: 'v', v, speed: d.speed, sig: d.signal, pos: d.position, lock: d.lock, t: currentTime });
    }
    if (this.calibrating && d.calibration && !d._cal) {
      this.calibrating = false;
      this.port.postMessage({ type: 'calibrated', result: d.calibration, gR: d.gR, rho: d.rho, invertPhase: d.invertPhase, rpm: d.rpm, gate: d.gate });
      d.calibration = null;
    }
    if ((this.statusCount += L.length) >= this.statusEvery) {
      this.statusCount = 0;
      const hasSig = this.peak > 1e-6 || d.signal;
      let scope = null;
      if (hasSig) {
        const n = Math.min(256, d.scopeN);
        scope = new Float32Array(n * 2);
        for (let k = 0; k < n; k++) { const j = ((d.scopeN - n + k) & 255) * 2; scope[2 * k] = d.scope[j]; scope[2 * k + 1] = d.scope[j + 1]; }
      }
      this.port.postMessage({
        type: 'status', level: d.level, peak: this.peak, quality: d.quality, coherence: d.coherence, speed: d.speed, pitch: d.pitch,
        velocity: d.velocity, carrierHz: d.carrierHz, signal: d.signal, lock: d.lock, pos: d.position, bitErrors: d.bitErrors, bitsRead: d.bitsRead,
        rpm: d.rpm, scope, t: currentTime,
      }, scope ? [scope.buffer] : []);
      this.peak = 0;
    }
    return true;
  }
}
registerProcessor('dvs-decoder', DvsDecoderProcessor);
