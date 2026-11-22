// DVS timecode decoder (pure JS, no DOM): runs inside the AudioWorklet and in Node tests.
// Original implementation for OpenDJ (MIT). See timecode-defs.js for how timecode signals work.
//
// Speed: the stereo pair is treated as a complex signal z = L + jR. Because the channels are in quadrature
// the carrier's instantaneous phase is simply arg(z), with no Hilbert transform. Per block (≈1 ms) we sum
// z[n]·conj(z[n-1]); its angle is the amplitude-weighted mean phase advance per sample (a frequency
// discriminator that ignores the amplitude-modulated data bits), divided by the nominal advance it gives the
// speed ratio; its sign is the direction. |Σ z·z*| / Σ|z||z*| ("coherence") measures how clean the rotation
// is and drives the quality metric and the needle-lift / noise gate. An adaptive one-pole filter (1.5 ms when
// the speed changes, 12 ms when steady) smooths the result.
//
// Position: the unwrapped phase counts carrier cycles. Each time the phase crosses a whole cycle (in either
// direction) the amplitude at that instant is sliced into a bit (adaptive threshold between the running
// "high" and "low" levels, normalised to the envelope). Bits extend a `bits`-wide window of the LFSR
// sequence forwards or backwards; once the window is full, every further bit must match the LFSR's
// prediction. After VERIFY_BITS correct predictions the window is looked up in the position table.

import { RPM_FACTOR } from './timecode-defs.js';

const TAU = Math.PI * 2;
export const VERIFY_BITS = 16;
const WARM_CYCLES = 8;

export class TimecodeDecoder {
  /**
   * @param {object} o
   * @param {number} o.sampleRate
   * @param {import('./timecode-defs.js').TimecodeDef} o.def
   */
  constructor({ sampleRate, def, rpm = 33, swap = false, invertPhase = false, invertBits = false, gain = 1, gate = 0.004, blockMs = 1, table = null, autoTrim = true } = {}) {
    this.sr = sampleRate;
    this.block = Math.max(16, Math.round(sampleRate * blockMs / 1000));
    this.blockDur = this.block / sampleRate;
    this.dcA = 1 - Math.exp(-TAU * 4 / sampleRate);
    this.configure({ def, rpm, swap, invertPhase, invertBits, gain, gate });
    this.table = table;
    this.gR = 1; this.rho = 0; // channel-balance / quadrature calibration
    this.autoTrim = autoTrim; this.eLL = 0; this.eRR = 0; this.eLR = 0; this._trimN = 0;
    this.dcL = 0; this.dcR = 0;
    this.pl = 0; this.pr = 0;
    this._resetBlock();
    // outputs
    this.speed = 0;        // smoothed speed ratio vs. nominal carrier (+ forward), not corrected for rpm
    this.rawSpeed = 0;
    this.pitch = 0;        // long-term speed (for the "pitch fader" display)
    this.coherence = 0; this.level = 0; this.quality = 0;
    this.signal = false; this._sigHold = 0; this.jitter = 0; this.pPre = 0; this.pPim = 0; this._over = 0;
    this.blocks = 0;
    // cycle counter / bit reader
    this.phi = 0;          // unwrapped carrier phase in cycles
    this.cyc = 0;          // round(phi): the cycle under the needle
    this.ampSum = 0; this.ampN = 0;
    this.env = 0; this.hi = 1.1; this.lo = 0.9;
    this._resetBits();
    this.bitsRead = 0; this.bitErrors = 0;
    this.scope = new Float32Array(512); this.scopeN = 0; this._scopeDec = 0;
    this._cal = null;
  }

  configure({ def, rpm, swap, invertPhase, invertBits, gain, gate }) {
    if (def && def !== this.def) {
      this.def = def; this.w0 = TAU * def.carrier / this.sr;
      this.mask = def.bits ? (def.bits >= 32 ? 0xffffffff : (1 << def.bits) - 1) : 0;
      if (this.table && this.table.length !== (1 << def.bits)) this.table = null;
      this._resetBits?.();
    }
    if (rpm != null) { this.rpm = rpm; this.rpmFactor = RPM_FACTOR[rpm] || 1; }
    if ((swap != null && !!swap !== this.swap) || (invertPhase != null && !!invertPhase !== this.invertPhase)) this._trimN = 0; // wiring changed: re-learn the trim
    if (swap != null) this.swap = !!swap;
    if (invertPhase != null) this.invertPhase = !!invertPhase;
    if (invertBits != null) this.invertBits = !!invertBits;
    if (gain != null) this.gain = gain;
    if (gate != null) this.gate = gate;
  }

  setTable(table) { this.table = table && this.def.bits && table.length === (1 << this.def.bits) ? table : null; }

  _resetBlock() { this.Pre = 0; this.Pim = 0; this.Mag = 0; this.E = 0; this.n = 0; this.Sll = 0; this.Srr = 0; this.Slr = 0; }
  _resetBits() { this.reg = 0; this.wHi = 0; this.wLo = 1; this.valid = 0; this.lock = false; this.position = -1; this._idx = -1; }

  /** Deck velocity: speed corrected for the platter rpm setting (45 rpm plays 1.35× faster). */
  get velocity() { return this.speed / this.rpmFactor; }
  get carrierHz() { return this.speed * this.def.carrier; }

  /** Feed one buffer of stereo input. onBlock(decoder) is called after every ~1 ms block. */
  process(L, R, onBlock) {
    const n = L.length, g = this.gain, dcA = this.dcA, sw = this.swap, inv = this.invertPhase ? -1 : 1;
    const gR = this.gR, rho = this.rho, ortho = 1 / Math.sqrt(Math.max(0.05, 1 - rho * rho));
    const gateSq = this.gate * this.gate * 0.25;
    for (let i = 0; i < n; i++) {
      let a = L[i] * g, b = (R ? R[i] : 0) * g;
      this.dcL += (a - this.dcL) * dcA; this.dcR += (b - this.dcR) * dcA;
      a -= this.dcL; b -= this.dcR;
      let l = sw ? b : a, r = (sw ? a : b) * inv;
      const raw = r;
      r = (r * gR - rho * l) * ortho;
      const pl = this.pl, pr = this.pr;
      const re = l * pl + r * pr, im = r * pl - l * pr;
      const m2 = l * l + r * r;
      this.Pre += re; this.Pim += im; this.Mag += Math.sqrt(m2 * (pl * pl + pr * pr)); this.E += m2;
      this.Sll += l * l; this.Srr += raw * raw; this.Slr += l * raw;
      this.pl = l; this.pr = r;
      // cycle counting + bits (only on a usable signal)
      if (this._sigHold > 0 && m2 > gateSq && (re !== 0 || im !== 0)) {
        this.phi += Math.atan2(im, re) / TAU;
        // cycle k spans phase k-½ .. k+½; its mean amplitude is sliced into a bit when the phase leaves it
        // (with hysteresis, so phase noise near a boundary cannot produce runs of tiny partial cycles)
        const dc = this.phi - this.cyc;
        if (dc > 0.6 || dc < -0.6) {
          const c = Math.round(this.phi);
          if (this.ampN >= 4) this._readBit(this.cyc, this.ampSum / this.ampN);
          this.cyc = c; this.ampSum = 0; this.ampN = 0;
        }
        this.ampSum += Math.sqrt(m2); this.ampN++;
      }
      if (++this._scopeDec >= 2) { this._scopeDec = 0; const j = (this.scopeN++ & 255) * 2; this.scope[j] = l; this.scope[j + 1] = r; }
      if (++this.n >= this.block) { this._endBlock(); onBlock?.(this); }
    }
  }

  _endBlock() {
    const cnt = this.n;
    const pMag = Math.hypot(this.Pre, this.Pim);
    const coh = this.Mag > 1e-12 ? pMag / this.Mag : 0;
    const level = Math.sqrt(this.E / cnt);
    this.level = level;
    this.coherence += (coh - this.coherence) * 0.2;
    const present = level > this.gate && coh > 0.35;
    if (present) this._sigHold = 3; else if (this._sigHold > 0) this._sigHold--;
    const wasSignal = this.signal;
    this.signal = this._sigHold > 0;
    const raw = pMag > 0 ? Math.atan2(this.Pim, this.Pre) / this.w0 : 0;
    this.rawSpeed = present ? raw : 0;
    // 2-block (≈2 ms) discriminator for the smoothed speed: phase noise only enters at the window ends,
    // so doubling the window halves the noise
    const raw2 = Math.atan2(this.Pim + this.pPim, this.Pre + this.pPre) / this.w0;
    this.pPre = this.Pre; this.pPim = this.Pim;
    const target = present ? (this._prevPresent ? raw2 : raw) : 0;
    this._prevPresent = present;
    // adaptive smoothing: follow fast when the speed really changes, average hard when it is steady.
    // "Really changes" = the deviation is well outside the measured jitter of the raw estimate.
    const dev = Math.abs(target - this.speed);
    // A single outlier block must not open the fast path; a real change (two blocks in a row, or a huge jump
    // such as a reversal) does.
    const thr = Math.max(0.004 * Math.max(0.3, Math.abs(this.speed)), 4 * this.jitter);
    const over = dev > thr ? Math.sign(target - this.speed) : 0;
    const fast = (over !== 0 && over === this._over) || dev > 5 * thr || !present;
    this._over = over;
    if (present && !over) this.jitter += (dev - this.jitter) * 0.02;
    const tau = fast ? 0.0015 : 0.012;
    this.speed += (target - this.speed) * (1 - Math.exp(-this.blockDur / tau));
    if (!this.signal && Math.abs(this.speed) < 1e-3) this.speed = 0;
    if (present && Math.abs(this.speed) > 0.05) this.pitch += (this.speed - this.pitch) * (1 - Math.exp(-this.blockDur / 0.15));
    const qInst = present ? Math.max(0, Math.min(1, (coh - 0.6) / 0.38)) : 0;
    this.quality += (qInst - this.quality) * (1 - Math.exp(-this.blockDur / 0.05));
    if (wasSignal && !this.signal) { this._idx = -1; this.env = 0; this.ampSum = 0; this.ampN = 0; } // needle lifted: the slicer re-learns the level
    // automatic channel-balance / quadrature trim (interfaces, cartridges and preamps are never perfectly matched)
    if (this.autoTrim && present && Math.abs(raw) > 0.2) {
      // running mean until the window is full, then a 0.25 s moving average (short blocks see partial cycles,
      // so a single block is a biased estimate; only the average is meaningful)
      const a = Math.max(1 - Math.exp(-this.blockDur / 0.25), 1 / ++this._trimN);
      this.eLL += (this.Sll / cnt - this.eLL) * a; this.eRR += (this.Srr / cnt - this.eRR) * a; this.eLR += (this.Slr / cnt - this.eLR) * a;
      if (this._trimN >= 60 && this.eRR > 1e-12) {
        this.gR = Math.sqrt(this.eLL / this.eRR);
        this.rho = Math.max(-0.8, Math.min(0.8, this.eLR / Math.sqrt(this.eLL * this.eRR)));
      }
    }
    if (this._cal) this._calibrateBlock(present, raw, level);
    this.blocks++;
    this._resetBlock();
  }

  // ---------- bits / absolute position ----------
  _readBit(k, amp) {
    const def = this.def;
    // envelope-normalised amplitude with an adaptive slicer
    if (!this.env) this._warm = 0;
    if (this._warm < WARM_CYCLES) { // (re)acquire: learn the mean level before slicing
      this._warm++; this.env = this.env + (amp - this.env) / this._warm;
      return;
    }
    this.env += (amp - this.env) * 0.06;
    const x = Math.max(0.3, Math.min(2, amp / (this.env || 1)));
    const thr = (this.hi + this.lo) / 2;
    let bit = x > thr ? 1 : 0;
    if (bit) this.hi += (x - this.hi) * 0.05; else this.lo += (x - this.lo) * 0.05;
    if (this.hi - this.lo < 0.02) { this.hi += 0.01; this.lo -= 0.01; } // keep the slicer open on unmodulated input
    if (!def.bits) return;
    if (this.invertBits) bit ^= 1;
    this.bitsRead++;
    const N = def.bits;
    const full = this.wHi - this.wLo + 1 >= N;
    if (k === this.wHi + 1) { // extend forwards
      if (full) {
        const pred = parityT(this.reg, def.taps);
        if (pred !== bit) { this._mismatch(k, bit); return; }
        this.valid++;
      }
      this.reg = ((this.reg >>> 1) | (bit << (N - 1))) >>> 0;
      this.wHi = k; if (this.wHi - this.wLo + 1 > N) this.wLo = this.wHi - N + 1;
    } else if (k === this.wLo - 1) { // extend backwards
      if (full) {
        const shifted = (this.reg << 1) & this.mask;
        const pred = ((this.reg >>> (N - 1)) & 1) ^ parityT(shifted, def.taps & ~1);
        if (pred !== bit) { this._mismatch(k, bit); return; }
        this.valid++;
        this.reg = (shifted | bit) >>> 0;
        this.wHi--; this.wLo--;
      } else {
        this.reg = (this.reg | (bit << (N - 1 - (this.wHi - k)))) >>> 0;
        this.wLo = k;
      }
    } else if (k >= this.wLo && k <= this.wHi) { // re-reading a known cycle (direction change / jitter)
      const known = (this.reg >>> (N - 1 - (this.wHi - k))) & 1;
      if (known !== bit) { this._mismatch(k, bit); return; }
    } else { this._mismatch(k, bit); return; }
    this._updatePosition();
  }

  _mismatch(k, bit) {
    this.bitErrors++;
    this.reg = (bit << (this.def.bits - 1)) >>> 0; this.wHi = k; this.wLo = k; this.valid = 0;
    this.lock = false; this._idx = -1;
  }

  _updatePosition() {
    const full = this.wHi - this.wLo + 1 >= this.def.bits;
    if (!full || this.valid < VERIFY_BITS || !this.table) { this.lock = false; return; }
    const idx = this.table[this.reg];
    if (idx < 0) { this.lock = false; this.valid = 0; return; }
    this.lock = true; this._idx = idx;
    this._hiAt = this.wHi;
  }

  /** Continuous position in carrier cycles (updated every sample via phi), -1 when not locked. */
  get position() { return this.lock && this._idx >= 0 ? this._idx + (this.phi - this._hiAt) : -1; }
  set position(_v) { /* reset via _resetBits */ }

  // ---------- calibration ----------
  /** Measure DC, channel balance, quadrature error, direction and rpm over `seconds` of steadily playing timecode. */
  startCalibration(seconds = 1.5) { const n = Math.round(seconds / this.blockDur); this._cal = { total: n, left: n, sp: 0, n: 0, lvl: 0 }; this._trimN = 0; }
  _calibrateBlock(present, raw, level) {
    const c = this._cal;
    // the first half lets the automatic balance/quadrature trim converge; the second half measures speed
    if (present && Math.abs(raw) > 0.3 && c.left < c.total / 2) { c.sp += raw; c.lvl += level; c.n++; }
    if (--c.left > 0) return;
    this._cal = null;
    if (c.n < 50) { this.calibration = { ok: false, error: 'No steady timecode signal: play the record forwards at normal speed' }; return; }
    const sp = c.sp / c.n;
    const res = { ok: true, gainRight: this.gR, phaseErrorDeg: Math.asin(this.rho) * 180 / Math.PI, level: c.lvl / c.n, speed: sp };
    if (sp < 0) { this.invertPhase = !this.invertPhase; res.flippedDirection = true; this.rho = -this.rho; this.eLR = -this.eLR; }
    const a = Math.abs(sp);
    res.rpm = Math.abs(a - RPM_FACTOR[45]) < Math.abs(a - 1) ? 45 : 33;
    this.configure({ rpm: res.rpm });
    res.gate = Math.max(0.0005, Math.min(0.02, res.level * 0.08));
    this.gate = res.gate;
    this.calibration = res;
  }
}

function parityT(state, taps) {
  let x = state & (taps | 1);
  x ^= x >>> 16; x ^= x >>> 8; x ^= x >>> 4;
  return (0x6996 >>> (x & 0xf)) & 1;
}
