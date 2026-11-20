// Synthetic timecode generator: used by the tests, the e2e script (WAV for fake audio capture) and the
// DVS panel's "test signal" mode. Produces the signal model the decoder expects: L = a·cos φ, R = a·sin φ
// with φ advancing at speed × carrier, and the amplitude `a` of cycle k set by LFSR bit k.
import { lfsrFwd } from './timecode-defs.js';

/**
 * @param {object} o
 * @param {import('./timecode-defs.js').TimecodeDef} o.def
 * @param {number} o.sampleRate
 * @param {number} o.seconds
 * @param {(t:number)=>number} [o.speed]  speed ratio at time t (negative = reverse); default 1
 * @param {number} [o.startCycle]         record position (in carrier cycles) at t = 0
 * @param {number} [o.noise]              white noise amplitude (relative to carrier amplitude 1)
 * @param {(t:number)=>boolean} [o.dropout] true while the needle is lifted (silence)
 * @param {number} [o.amplitude]          carrier peak amplitude
 * @param {number} [o.depth]              amplitude of a "0" cycle relative to a "1"
 * @param {number} [o.phaseError]         quadrature error in degrees (right channel)
 * @param {number} [o.rightGain]          right channel gain imbalance
 * @param {number} [o.seed]               noise PRNG seed
 */
export function generateTimecode({ def, sampleRate, seconds, speed = () => 1, startCycle = 0, noise = 0, dropout = null, amplitude = 0.5, depth = 0.8, phaseError = 0, rightGain = 1, seed = 1, jumps = null }) {
  const n = Math.round(seconds * sampleRate);
  const L = new Float32Array(n), R = new Float32Array(n);
  const bits = new BitSource(def);
  let phi = startCycle; // in cycles
  let rnd = seed >>> 0 || 1;
  const rand = () => { rnd ^= rnd << 13; rnd >>>= 0; rnd ^= rnd >>> 17; rnd ^= rnd << 5; rnd >>>= 0; return rnd / 4294967296; };
  const gauss = () => { let u = 0; for (let k = 0; k < 6; k++) u += rand(); return (u - 3) * Math.SQRT2; }; // ≈ N(0,1)
  const pe = phaseError * Math.PI / 180;
  const cycleSpeed = def.carrier / sampleRate;
  let jumpIdx = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    while (jumps && jumpIdx < jumps.length && t >= jumps[jumpIdx].t) { phi = jumps[jumpIdx].cycle; jumpIdx++; } // needle drop
    phi += speed(t) * cycleSpeed;
    const k = Math.round(phi);
    const a = amplitude * (bits.get(k) ? 1 : depth);
    const ang = phi * 2 * Math.PI;
    let l = a * Math.cos(ang), r = a * rightGain * Math.sin(ang + pe);
    if (dropout && dropout(t)) { l = 0; r = 0; }
    if (noise) { l += noise * amplitude * gauss(); r += noise * amplitude * gauss(); }
    L[i] = l; R[i] = r;
  }
  return { L, R, endCycle: phi };
}

/** Lazily extended LFSR bit sequence; cycles before 0 / without LFSR read as 1 (unmodulated). */
export class BitSource {
  constructor(def) { this.def = def; this.bits = new Uint8Array(0); this.state = def.seed; this.n = 0; }
  get(k) {
    if (!this.def.bits || k < 0 || (this.def.length && k >= this.def.length)) return 1;
    if (k >= this.n) this._extend(k + 1);
    return this.bits[k];
  }
  _extend(upto) {
    if (upto > this.bits.length) { const nb = new Uint8Array(Math.max(upto, this.bits.length * 2, 4096)); nb.set(this.bits); this.bits = nb; }
    const N = this.def.bits;
    while (this.n < upto) { this.bits[this.n++] = (this.state >>> (N - 1)) & 1; this.state = lfsrFwd(this.state, this.def); }
  }
}

/** 16-bit PCM WAV (stereo) as a Uint8Array. */
export function encodeWav(L, R, sampleRate) {
  const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
  }
  return new Uint8Array(buf);
}
