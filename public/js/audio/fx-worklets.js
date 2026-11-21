// AudioWorklet processors for the effects that native Web Audio nodes can't do well:
//   opendj-lfo      beat-locked LFO / gate (control signal for native AudioParams)
//   opendj-reverb   feedback-delay-network reverb with smooth decay, damping and pre-delay
//   opendj-crush    bit depth + sample-rate reduction
//   opendj-limiter  look-ahead brickwall limiter for the master bus
//   opendj-moddelay flanger / chorus / jet modulated delay
//   opendj-pitch    delay-line pitch shifter (Color FX Pitch, Spiral / Shimmer beat FX, mic pitch)
//   opendj-comp     one-knob channel compressor (exact pass-through until first used)
//   opendj-ducker   talkover envelope follower: voice on the side-chain -> ducking control signal
//   opendj-meter    BS.1770-4 / EBU R128 loudness (M, S, I), 4x true peak, RMS
//   opendj-warmth   2nd/3rd-harmonic warmth (adds only the harmonics: exact pass-through at 0)
// Loaded with audioWorklet.addModule() (see loadEffectWorklets in effects.js).

const TAU = Math.PI * 2;
/** Beat clock message { beat, at, beatSec }: beat = null -> free-run at beatSec. */
function onClock(o, m) {
  if (!m || !(m.beatSec > 0)) return;
  o.beatSec = m.beatSec;
  o.clock = Number.isFinite(m.beat) ? { beat: m.beat, at: m.at ?? currentTime } : null;
}
/** Advance a beat-locked phase: phase-lock to the clock (jump on big errors, slew small ones). */
function lockBeat(o) {
  if (!o.clock) return;
  const target = o.clock.beat + (currentTime - o.clock.at) / o.beatSec, err = target - o.beat;
  o.beat += Math.abs(err) > 0.25 ? err : err * 0.06;
}
function lfoShape(ph, shape) { return shape === 1 ? (ph < 0.5 ? ph * 2 : 2 - ph * 2) : 0.5 - 0.5 * Math.cos(TAU * ph); }
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const frac = (x) => x - Math.floor(x);

/**
 * Beat-locked LFO. Output: 2 channels in 0..1 (channel 1 is phase-shifted by `spread` for stereo modulation).
 * The beat clock comes from the deck: port message { beat, at, beatSec } = beat position `beat` at audio time `at`.
 * Between messages it free-runs at beatSec and phase-locks gently to new clock messages, so tempo changes and
 * jog nudges never make it jump.
 * Shapes: 0 sine, 1 triangle, 2 gate (square with raised-cosine edges, duty = `duty`), 3 ramp down (saw).
 */
class LfoProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'beats', defaultValue: 1, minValue: 1 / 64, maxValue: 256, automationRate: 'k-rate' },
      { name: 'shape', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'duty', defaultValue: 0.5, minValue: 0.05, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'spread', defaultValue: 0, minValue: 0, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'offset', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.beat = 0; this.beatSec = 0.5; this.clock = null; this.y = [0, 0];
    this.port.onmessage = (e) => onClock(this, e.data);
  }
  shape(ph, shape, duty, edge) {
    switch (shape) {
      case 1: return ph < 0.5 ? ph * 2 : 2 - ph * 2;
      case 2: { // gate: on for [0, duty), raised-cosine edges `edge` wide (in cycles)
        if (ph < edge) return 0.5 - 0.5 * Math.cos(Math.PI * ph / edge);
        if (ph < duty - edge) return 1;
        if (ph < duty) return 0.5 + 0.5 * Math.cos(Math.PI * (ph - duty + edge) / edge);
        return 0;
      }
      case 3: return 1 - ph;
      default: return 0.5 - 0.5 * Math.cos(TAU * ph);
    }
  }
  process(_in, outputs, p) {
    const out = outputs[0], o0 = out[0], o1 = out[1] || out[0], n = o0.length;
    const beats = p.beats[0], shape = Math.round(p.shape[0]), duty = p.duty[0], spread = p.spread[0], offset = p.offset[0];
    const dBeat = 1 / (this.beatSec * sampleRate);
    lockBeat(this); // big errors jump (new track / seek), small ones slew over ~50 ms
    const cycleSec = beats * this.beatSec, edge = clamp(0.0025 / cycleSec, 0.002, duty * 0.3);
    const k = 1 - Math.exp(-1 / (0.0015 * sampleRate)); // 1.5 ms output smoothing: no steps, even on jumps
    let y0 = this.y[0], y1 = this.y[1];
    for (let i = 0; i < n; i++) {
      const ph = frac(this.beat / beats + offset);
      y0 += (this.shape(ph, shape, duty, edge) - y0) * k;
      y1 += (this.shape(frac(ph + spread), shape, duty, edge) - y1) * k;
      o0[i] = y0; if (o1 !== o0) o1[i] = y1;
      this.beat += dBeat;
    }
    this.y[0] = y0; this.y[1] = y1;
    return true;
  }
}
registerProcessor('opendj-lfo', LfoProcessor);

/**
 * Stereo reverb: pre-delay -> early reflections + input diffusion -> 8-line feedback delay network
 * (Hadamard mixing, per-line damping, slow modulation against metallic ringing). Wet signal only.
 * Decay (RT60), damping and pre-delay are smooth AudioParams. Goes idle (no CPU) once input and tail are silent.
 */
const FDN_MS = [31.71, 37.11, 41.19, 43.73, 53.31, 59.17, 67.89, 73.37];
const DIFF_MS = [4.77, 3.59, 12.73, 9.31];
const ER = [[7.1, 0.65, 0], [11.3, 0.55, 1], [17.9, 0.45, 0], [23.3, 0.4, 1], [29.6, 0.33, 0], [37.2, 0.27, 1]]; // ms, gain, side
class ReverbProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'decay', defaultValue: 2.5, minValue: 0.1, maxValue: 30, automationRate: 'k-rate' },
      { name: 'damping', defaultValue: 6000, minValue: 200, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'predelay', defaultValue: 0.02, minValue: 0, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'size', defaultValue: 1, minValue: 0.5, maxValue: 1.5, automationRate: 'k-rate' },
      { name: 'early', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    const sr = sampleRate;
    this.preLen = Math.ceil(0.6 * sr) + 2; this.pre = new Float32Array(this.preLen); this.preW = 0;
    this.diff = DIFF_MS.map((ms) => { const len = Math.round(ms * sr / 1000); return { buf: new Float32Array(len), i: 0, len }; });
    this.lines = FDN_MS.map((ms, j) => {
      const base = ms * sr / 1000, cap = Math.ceil(base * 1.6) + 64;
      return { buf: new Float32Array(cap), cap, w: 0, base, lp: 0, g: 0, modRate: 0.3 + j * 0.07, modPh: j * 0.7 };
    });
    this.x = new Float32Array(8); this.hold = 0; this.energy = 0;
    this.last = { decay: -1, damping: -1, size: -1 };
  }
  coeffs(decay, damping, size) {
    const sr = sampleRate;
    this.damp = Math.exp(-TAU * damping / sr); // one-pole low-pass in each line
    for (const L of this.lines) { L.len = L.base * size; L.g = Math.pow(10, -3 * L.len / (sr * decay)); }
    // keep loudness roughly constant over decay times: the tail's energy grows ~ with RT60
    this.outGain = 0.55 / Math.sqrt(Math.max(0.35, decay));
    this.last.decay = decay; this.last.damping = damping; this.last.size = size;
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    const oL = out[0], oR = out[1] || out[0], n = oL.length;
    const iL = inp[0], iR = inp[1] || inp[0];
    let inE = 0;
    if (iL) for (let i = 0; i < n; i++) inE += Math.abs(iL[i]) + Math.abs(iR[i]);
    // idle (no CPU) once the input has been silent for longer than pre-delay + tail and the tank has died away
    if (inE > 1e-7) this.hold = (0.6 + 2 * p.decay[0]) * sampleRate; else this.hold -= n;
    if (this.hold <= 0 && this.energy < 1e-10) { oL.fill(0); if (oR !== oL) oR.fill(0); return true; }
    const decay = p.decay[0], damping = p.damping[0], size = p.size[0], early = p.early[0];
    if (decay !== this.last.decay || damping !== this.last.damping || size !== this.last.size) this.coeffs(decay, damping, size);
    const sr = sampleRate, pdT = clamp(p.predelay[0], 0, 0.5) * sr, pk = 1 - Math.exp(-1 / (0.05 * sr));
    if (this.pd == null) this.pd = pdT;
    let pd = this.pd;
    const pre = this.pre, preLen = this.preLen, lines = this.lines, x = this.x, damp = this.damp, og = this.outGain;
    const diff = this.diff, gDiff = 0.62;
    let energy = 0;
    // per-block modulation of the first four line lengths (±0.25 ms), interpolated read
    const mods = [0, 0, 0, 0];
    for (let j = 0; j < 4; j++) { const L = lines[j]; L.modPh += TAU * L.modRate * n / sr; mods[j] = Math.sin(L.modPh) * 0.00025 * sr; }
    for (let i = 0; i < n; i++) {
      const inL = iL ? iL[i] : 0, inR = iL ? iR[i] : 0;
      pre[this.preW] = (inL + inR) * 0.5;
      pd += (pdT - pd) * pk; // pre-delay glides (no read-pointer jumps)
      const rp = this.preW - pd; const ri = Math.floor(rp), rf = rp - ri;
      const a = pre[(ri + preLen) % preLen], b = pre[(ri + 1 + preLen) % preLen];
      let s = a + (b - a) * rf;
      // early reflections from the pre-delayed signal
      let eL = 0, eR = 0;
      for (let k = 0; k < ER.length; k++) {
        const e = ER[k], v = pre[((Math.floor(this.preW - pd - e[0] * size * sr / 1000) % preLen) + preLen) % preLen] * e[1];
        if (e[2]) eR += v; else eL += v;
      }
      this.preW = (this.preW + 1) % preLen;
      // input diffusion (series all-passes)
      for (let k = 0; k < 4; k++) { const d = diff[k], z = d.buf[d.i]; const v = s + gDiff * z; d.buf[d.i] = v; s = z - gDiff * v; d.i = (d.i + 1) % d.len; }
      // read the delay lines
      for (let j = 0; j < 8; j++) {
        const L = lines[j], len = L.len + (j < 4 ? mods[j] : 0);
        const r = L.w - len, r0 = Math.floor(r), f = r - r0;
        const c = L.cap, y0 = L.buf[(r0 % c + c) % c], y1 = L.buf[((r0 + 1) % c + c) % c];
        let y = y0 + (y1 - y0) * f;
        L.lp = y + (L.lp - y) * damp; // damping
        x[j] = L.lp * L.g;
      }
      // fast Walsh-Hadamard (orthogonal, 1/sqrt(8))
      for (let h = 1; h < 8; h <<= 1) for (let a0 = 0; a0 < 8; a0 += h << 1) for (let k = a0; k < a0 + h; k++) { const u = x[k], v = x[k + h]; x[k] = u + v; x[k + h] = u - v; }
      const sc = 0.35355339;
      let outL = 0, outR = 0;
      for (let j = 0; j < 8; j++) {
        const L = lines[j], v = x[j] * sc + s * (j & 1 ? -0.5 : 0.5);
        L.buf[L.w] = v; L.w = (L.w + 1) % L.cap;
        const y = L.lp;
        outL += (j & 1) ? -y : y; outR += (j & 2) ? -y : y;
        energy += y * y;
      }
      oL[i] = (outL * og + (eL * early) * 0.6) ; if (oR !== oL) oR[i] = (outR * og + (eR * early) * 0.6);
    }
    this.pd = pd;
    this.energy = energy / n;
    return true;
  }
}
registerProcessor('opendj-reverb', ReverbProcessor);

/** Bit crusher: sample-and-hold to `rate` Hz, then quantise to `bits` (fractional bits sweep smoothly). */
class CrushProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 8, minValue: 1, maxValue: 24, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 8000, minValue: 100, maxValue: 96000, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.acc = [1, 1]; this.hold = [0, 0]; this.bits = null; this.rate = null; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    const n = out[0].length, k = 1 - Math.exp(-n / (0.01 * sampleRate)); // ~10 ms parameter smoothing per block
    if (this.bits === null) { this.bits = p.bits[0]; this.rate = p.rate[0]; } // start at the set values, then glide
    this.bits += (p.bits[0] - this.bits) * k; this.rate += (p.rate[0] - this.rate) * k;
    const q = Math.pow(2, this.bits - 1), step = Math.min(1, this.rate / sampleRate);
    for (let c = 0; c < out.length; c++) {
      const o = out[c], x = inp[c] || inp[0];
      if (!x) { o.fill(0); continue; }
      let acc = this.acc[c] ?? 1, h = this.hold[c] ?? 0;
      for (let i = 0; i < n; i++) {
        acc += step;
        if (acc >= 1) { acc -= 1; h = Math.round(x[i] * q) / q; }
        o[i] = h;
      }
      this.acc[c] = acc; this.hold[c] = h;
    }
    return true;
  }
}
registerProcessor('opendj-crush', CrushProcessor);

/**
 * Look-ahead brickwall limiter (stereo-linked). Below the ceiling it is bit-transparent (gain exactly 1).
 * Gain: required gain per sample -> minimum over the look-ahead window -> dual release (fast for transients, slow
 * for sustained overs, so loud mixes don't pump) -> moving average over the window (smooth attack that has fully
 * arrived when the peak leaves the delay line). The audio is delayed by the look-ahead, always, so turning the
 * limiter on/off (`enabled`) never shifts timing.
 */
class LimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ceiling', defaultValue: -1, minValue: -24, maxValue: 0, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.08, minValue: 0.005, maxValue: 2, automationRate: 'k-rate' },
      { name: 'enabled', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    const L = this.L = Math.max(8, Math.round(0.003 * sampleRate)); // 3 ms look-ahead
    this.dl = [new Float32Array(L), new Float32Array(L)]; this.dw = 0;
    this.req = new Float32Array(L); // required gains in the window (ring)
    this.dqV = new Float32Array(L + 2); this.dqI = new Float64Array(L + 2); this.dqH = 0; this.dqT = 0; this.t = 0; // monotonic deque (window min)
    this.box = new Float64Array(L); this.boxSum = L; this.box.fill(1); this.bw = 0;
    this.fast = 1; this.slow = 1; this.gr = 1; this.report = 0;
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0];
    const iL = inp[0], iR = inp[1] || inp[0], oL = out[0], oR = out[1] || out[0], n = oL.length;
    const L = this.L, ceil = Math.pow(10, p.ceiling[0] / 20), on = p.enabled[0] >= 0.5;
    const relF = Math.exp(-1 / (p.release[0] * sampleRate)), relS = Math.exp(-1 / (1.2 * sampleRate)), atkS = Math.exp(-1 / (0.4 * sampleRate));
    const dqV = this.dqV, dqI = this.dqI, box = this.box, dL = this.dl[0], dR = this.dl[1];
    let minGr = 1;
    for (let i = 0; i < n; i++) {
      const xl = iL ? iL[i] : 0, xr = iL ? iR[i] : 0;
      const a = Math.max(Math.abs(xl), Math.abs(xr));
      const req = on && a > ceil ? ceil / a : 1;
      // window minimum of the required gain (monotonic deque, O(1) amortised)
      const t = this.t++;
      // window = the L+1 samples whose output gain this sample's box average can still touch
      const M = L + 2;
      while (this.dqT > this.dqH && dqV[(this.dqT - 1) % M] >= req) this.dqT--;
      dqV[this.dqT % M] = req; dqI[this.dqT % M] = t; this.dqT++;
      while (dqI[this.dqH % M] <= t - L - 1) this.dqH++;
      const wmin = dqV[this.dqH % M];
      // dual release: instant attack (the box filter smooths it), fast + slow recovery
      this.fast = wmin < this.fast ? wmin : wmin + (this.fast - wmin) * relF;
      this.slow = wmin < this.slow ? this.slow * atkS + wmin * (1 - atkS) : wmin + (this.slow - wmin) * relS;
      const g = Math.min(this.fast, Math.max(this.slow, wmin)); // slow env only holds gain down, never below need
      // moving average over the look-ahead window
      this.boxSum += g - box[this.bw]; box[this.bw] = g; this.bw = (this.bw + 1) % L;
      const gs = Math.min(1, this.boxSum / L);
      // delay line
      const yl = dL[this.dw], yr = dR[this.dw]; dL[this.dw] = xl; dR[this.dw] = xr; this.dw = (this.dw + 1) % L;
      let ol = yl * gs, or = yr * gs;
      if (on) { if (ol > ceil) ol = ceil; else if (ol < -ceil) ol = -ceil; if (or > ceil) or = ceil; else if (or < -ceil) or = -ceil; } // numerical safety
      oL[i] = ol; if (oR !== oL) oR[i] = or;
      if (gs < minGr) minGr = gs;
    }
    this.gr = Math.min(this.gr, minGr);
    if ((this.report += n) >= 4096) { this.port.postMessage({ gr: this.gr }); this.report = 0; this.gr = 1; }
    return true;
  }
}
registerProcessor('opendj-limiter', LimiterProcessor);

/**
 * Modulated delay: flanger, chorus, jet. Stereo, sample-accurate feedback, beat-locked LFO (left/right phase offset
 * `spread`). delay(t) = base + depth * lfo(t). Output = dry * x + wet * delayed (wet scaled down with feedback so the
 * comb resonance doesn't jump in level). base / depth ramp per sample between blocks: no zipper on knob sweeps.
 */
class ModDelayProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'base', defaultValue: 0.002, minValue: 0.0001, maxValue: 0.04, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.002, minValue: 0, maxValue: 0.02, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0, minValue: -0.95, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'dry', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'wet', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'spread', defaultValue: 0.25, minValue: 0, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'shape', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'beats', defaultValue: 4, minValue: 1 / 16, maxValue: 512, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.size = Math.ceil(0.064 * sampleRate);
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)]; this.w = 0;
    this.beat = 0; this.beatSec = 0.5; this.clock = null;
    this.prev = null; this.hpS = [[0, 0], [0, 0]];
    this.port.onmessage = (e) => onClock(this, e.data);
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0], n = out[0].length, sr = sampleRate;
    const base = p.base[0], depth = p.depth[0], fb = p.feedback[0], dry = p.dry[0], spread = p.spread[0];
    const shape = Math.round(p.shape[0]), beats = p.beats[0];
    // wet scaled so the comb's average power stays put as feedback rises (dry² + wet²/(1-fb²) = const)
    const wet = p.wet[0] * Math.sqrt(1 - fb * fb);
    const hpK = Math.exp(-TAU * 160 / sr); // one-pole high-pass in the feedback path: no bass boom at high feedback
    if (!this.prev) this.prev = { base, depth };
    const b0 = this.prev.base, d0 = this.prev.depth;
    lockBeat(this);
    const dBeat = 1 / (this.beatSec * sr), size = this.size, w0 = this.w;
    for (let c = 0; c < 2; c++) {
      const x = inp[c] || inp[0], o = out[c] || out[0], buf = this.buf[c];
      if (!x) { o.fill(0); continue; }
      let w = w0, beat = this.beat;
      const off = c ? spread : 0;
      for (let i = 0; i < n; i++) {
        const k = (i + 1) / n, bs = b0 + (base - b0) * k, dp = d0 + (depth - d0) * k;
        const ph = frac(beat / beats + off);
        const dl = (bs + dp * lfoShape(ph, shape)) * sr;
        let r = w - dl; if (r < 0) r += size;
        const r0 = Math.floor(r), f = r - r0, r1 = r0 + 1 >= size ? 0 : r0 + 1;
        const y = buf[r0] + (buf[r1] - buf[r0]) * f;
        const hpS = this.hpS[c], hy = hpK * (hpS[1] + y - hpS[0]); hpS[0] = y; hpS[1] = hy;
        let v = x[i] + fb * hy; v = v > 2 ? 2 : v < -2 ? -2 : v;
        buf[w] = v;
        o[i] = dry * x[i] + wet * y;
        w = w + 1 >= size ? 0 : w + 1; beat += dBeat;
      }
      if (c === 1 || out.length === 1) { this.w = w; this.beat = beat; }
    }
    this.prev.base = base; this.prev.depth = depth;
    return true;
  }
}
registerProcessor('opendj-moddelay', ModDelayProcessor);

/**
 * Pitch shifter: two read taps sweep through a 50 ms delay line at `ratio` × the write speed, each faded by a Hann
 * window that is zero where its delay wraps (the two windows always sum to 1). Output frequency = ratio × input
 * exactly; latency ~ half the window. Wet signal only.
 */
class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.W = Math.round(0.05 * sampleRate); this.size = this.W + 8;
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)]; this.w = 0; this.ph = 0; this.r = null;
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0], n = out[0].length, W = this.W, size = this.size;
    const target = p.ratio[0]; if (this.r === null) this.r = target;
    const r0 = this.r, dr = (target - r0) / n;
    const x0 = inp[0], x1 = inp[1] || inp[0];
    const b0 = this.buf[0], b1 = this.buf[1], o0 = out[0], o1 = out[1] || out[0];
    let w = this.w, ph = this.ph, r = r0;
    for (let i = 0; i < n; i++) {
      b0[w] = x0 ? x0[i] : 0; b1[w] = x1 ? x1[i] : 0;
      r += dr;
      ph -= (r - 1) / W; ph -= Math.floor(ph); // delay (in windows) shrinks when shifting up
      let y0 = 0, y1 = 0;
      for (let k = 0; k < 2; k++) {
        const phk = k ? (ph + 0.5) % 1 : ph, d = 2 + phk * W;
        let rp = w - d; if (rp < 0) rp += size;
        const i0 = Math.floor(rp), f = rp - i0, i1 = i0 + 1 >= size ? 0 : i0 + 1;
        const g = Math.sin(Math.PI * phk) ** 2;
        y0 += g * (b0[i0] + (b0[i1] - b0[i0]) * f); y1 += g * (b1[i0] + (b1[i1] - b1[i0]) * f);
      }
      o0[i] = y0; if (o1 !== o0) o1[i] = y1;
      w = w + 1 >= size ? 0 : w + 1;
    }
    this.w = w; this.ph = ph; this.r = target;
    return true;
  }
}
registerProcessor('opendj-pitch', PitchProcessor);

/**
 * One-knob compressor (mixer M11). amount 0..1 -> threshold 0 .. -30 dB, ratio 1 .. 4, 6 dB soft knee; stereo-linked
 * peak detector (instant attack, 150 ms release) with a 2 ms look-ahead so drum transients are caught, auto make-up
 * for a -14 LUFS programme. Until it is first turned up the input is copied unchanged (no latency); the first time it
 * engages the look-ahead delay glides in over ~300 ms (a 0.7 % speed change for a moment: no click, no comb filter),
 * then stays (at 0 the output is the input delayed by exactly 2 ms).
 */
class CompProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'amount', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.L = Math.round(0.002 * sampleRate); this.size = this.L + 4;
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)]; this.w = 0; this.lat = 0; this.engaged = false;
    this.env = 0; this.a = 0; this.g = 1; this.report = 0; this.minG = 1;
  }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0], n = out[0].length;
    const x0 = inp[0], x1 = inp[1] || inp[0], o0 = out[0], o1 = out[1] || out[0];
    const target = p.amount[0], ka = 1 - Math.exp(-n / (0.03 * sampleRate));
    this.a += (target - this.a) * ka; if (Math.abs(this.a - target) < 1e-4) this.a = target;
    if (!x0) { o0.fill(0); if (o1 !== o0) o1.fill(0); return true; }
    if (!this.engaged) { if (this.a === 0) { o0.set(x0); if (o1 !== o0) o1.set(x1); return true; } this.engaged = true; }
    const a = this.a, T = -30 * a, R = 1 + 3 * a, knee = 6, slope = 1 - 1 / R;
    const makeup = 0.9 * Math.max(0, -5 - T) * slope; // detector level of a -14 LUFS programme ~ -5 dB
    const rel = Math.exp(-1 / (0.15 * sampleRate)), gAtk = Math.exp(-1 / (0.0005 * sampleRate)), gRel = Math.exp(-1 / (0.002 * sampleRate));
    const L = this.L, size = this.size, b0 = this.buf[0], b1 = this.buf[1], latStep = L / (0.3 * sampleRate);
    let env = this.env, g = this.g, minG = this.minG, w = this.w, lat = this.lat;
    for (let i = 0; i < n; i++) {
      const l = x0[i], r = x1[i];
      b0[w] = l; b1[w] = r;
      if (lat < L) lat = Math.min(L, lat + latStep);
      let rp = w - lat; if (rp < 0) rp += size;
      const i0 = Math.floor(rp), f = rp - i0, i1 = i0 + 1 >= size ? 0 : i0 + 1;
      const dl = b0[i0] + (b0[i1] - b0[i0]) * f, dr = b1[i0] + (b1[i1] - b1[i0]) * f;
      w = w + 1 >= size ? 0 : w + 1;
      if (a === 0 && g === 1) { o0[i] = dl; if (o1 !== o0) o1[i] = dr; continue; }
      const e = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
      env = e > env ? e : e + (env - e) * rel;
      const over = 20 * Math.log10(env + 1e-9) - 3 - T;
      let gr = 0;
      if (over > knee / 2) gr = -over * slope; else if (over > -knee / 2) { const z = over + knee / 2; gr = -slope * z * z / (2 * knee); }
      const tg = Math.pow(10, (gr + makeup) / 20);
      g = tg < g ? tg + (g - tg) * gAtk : tg + (g - tg) * gRel;
      if (a === 0 && Math.abs(g - 1) < 1e-6) g = 1;
      o0[i] = dl * g; if (o1 !== o0) o1[i] = dr * g;
      const grLin = Math.pow(10, gr / 20); if (grLin < minG) minG = grLin;
    }
    this.env = env; this.g = g; this.minG = minG; this.w = w; this.lat = lat;
    if ((this.report += n) >= 4096) { this.port.postMessage({ gr: this.minG }); this.report = 0; this.minG = 1; }
    return true;
  }
}
registerProcessor('opendj-comp', CompProcessor);

/**
 * Talkover follower (mixer M8). Input: the voice (mic + voice bus). Output channel 0 / 1: (gain - 1) to add to the
 * music duck gain (full duck) or to the music's voice band (300 Hz - 5 kHz, "advanced" mode). The duck opens when
 * the voice peak envelope passes `threshold` (auto) or while `manual` is on, reaches `depth` within ~10 ms and
 * releases over ~250 ms after `hold`.
 */
class DuckerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -36, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: -12, minValue: -60, maxValue: 0, automationRate: 'k-rate' },
      { name: 'auto', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'manual', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'band', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: 0.12, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.env = 0; this.g = 1; this.holdN = 0; this.open = false; this.sent = null; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0], n = out[0].length, sr = sampleRate;
    const thr = Math.pow(10, p.threshold[0] / 20), depth = Math.pow(10, p.depth[0] / 20), auto = p.auto[0] >= 0.5, manual = p.manual[0] >= 0.5, band = p.band[0] >= 0.5;
    const envRel = Math.exp(-1 / (0.05 * sr)), att = Math.exp(-1 / (0.003 * sr)), rel = Math.exp(-1 / (0.08 * sr)), holdN = p.hold[0] * sr;
    const c0 = out[0], c1 = out[1] || out[0];
    let env = this.env, g = this.g;
    for (let i = 0; i < n; i++) {
      let a = 0; for (let c = 0; c < inp.length; c++) { const v = Math.abs(inp[c][i]); if (v > a) a = v; }
      env = a > env ? a : env * envRel;
      if (auto && env > thr) { this.open = true; this.holdN = holdN; } else if (this.holdN > 0) this.holdN--; else if (env < thr * 0.7) this.open = false;
      const tg = (this.open && auto) || manual ? depth : 1;
      g = tg < g ? tg + (g - tg) * att : tg + (g - tg) * rel;
      const off = g - 1;
      c0[i] = band ? 0 : off; if (c1 !== c0) c1[i] = band ? off : 0;
    }
    this.env = env; this.g = g;
    const ducking = g < 0.97;
    if (ducking !== this.sent) { this.sent = ducking; this.port.postMessage({ ducking }); }
    return true;
  }
}
registerProcessor('opendj-ducker', DuckerProcessor);

/** BS.1770-4 K-weighting coefficients for any sample rate (pre-filter shelf + RLB high-pass), as libebur128. */
export function kWeighting(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416), a0 = 1 + K / Q + K * K;
  const pre = { b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0], a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / fs);
  const d = 1 + K / Q + K * K;
  const rlb = { b: [1, -2, 1], a: [2 * (K * K - 1) / d, (1 - K / Q + K * K) / d] };
  return [pre, rlb];
}
/** 4x interpolation FIR for true peak (BS.1770-4 Annex 2: 48 taps, 4 phases x 12), Kaiser-windowed sinc. */
function truePeakFir() {
  const N = 48, P = 4, h = new Float64Array(N), beta = 7;
  const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
  for (let n = 0; n < N; n++) {
    const m = n - (N - 1) / 2, x = m / P, sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    h[n] = sinc * i0(beta * Math.sqrt(1 - (2 * n / (N - 1) - 1) ** 2)) / i0(beta);
  }
  const ph = [];
  for (let p = 0; p < P; p++) { const c = []; for (let k = p; k < N; k += P) c.push(h[k]); const s = c.reduce((a, b) => a + b, 0); ph.push(Float64Array.from(c, (v) => v / s)); }
  return ph;
}
/**
 * Loudness meter (mixer M14, EBU Tech 3341 "EBU Mode"): K-weighted momentary (400 ms), short-term (3 s) and gated
 * integrated loudness (absolute -70 LUFS, relative -10 LU, 400 ms blocks with 75 % overlap), true peak (4x
 * oversampled) and RMS / sample peak per channel. Posts { m, s, i, tp, tpMax, rms:[l,r], peak:[l,r] } 10x a second.
 * Message { cmd: 'reset' } restarts the integration.
 */
class MeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.kw = kWeighting(sampleRate); this.z = [[0, 0, 0, 0], [0, 0, 0, 0]].map((a) => [a.slice(), a.slice()]);
    this.blk = Math.round(sampleRate / 10); this.acc = [0, 0]; this.cnt = 0; this.sq = [0, 0]; this.pk = [0, 0];
    this.hist = []; // 100 ms block mean squares (sum over channels)
    this.gated = []; this.tp = 0; this.tpMax = 0;
    this.fir = truePeakFir(); this.tl = this.fir[0].length; this.tbuf = [new Float64Array(this.tl * 2), new Float64Array(this.tl * 2)]; this.tw = 0; // doubled ring: contiguous reads
    this.port.onmessage = (e) => { if (e.data?.cmd === 'reset') { this.gated = []; this.tpMax = 0; } };
  }
  static lufs(ms) { return ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity; }
  process(inputs) {
    const inp = inputs[0], n = 128;
    if (!inp || !inp.length) return true;
    const kw = this.kw, fir = this.fir, tl = this.tl;
    for (let c = 0; c < 2; c++) {
      const x = inp[c] || inp[0], z = this.z[c], tb = this.tbuf[c];
      let acc = 0, sq = 0, pk = this.pk[c], tp = this.tp;
      let tw = this.tw;
      for (let i = 0; i < x.length; i++) {
        let v = x[i];
        sq += v * v; const av = Math.abs(v); if (av > pk) pk = av;
        // true peak: 4 interpolated phases of the last 16 samples
        tb[tw] = v; tb[tw + tl] = v; tw = tw + 1 === tl ? 0 : tw + 1;
        const top = tw + tl - 1;
        for (let p = 0; p < 4; p++) { const h = fir[p]; let s = 0; for (let k = 0; k < tl; k++) s += h[k] * tb[top - k]; const a = s < 0 ? -s : s; if (a > tp) tp = a; }
        // K-weighting (two biquads, direct form I)
        for (let s = 0; s < 2; s++) {
          const f = kw[s], st = z[s];
          const y = f.b[0] * v + f.b[1] * st[0] + f.b[2] * st[1] - f.a[0] * st[2] - f.a[1] * st[3];
          st[1] = st[0]; st[0] = v; st[3] = st[2]; st[2] = y; v = y;
        }
        acc += v * v;
      }
      this.acc[c] += acc; this.sq[c] += sq; this.pk[c] = pk; this.tp = tp;
      if (c === 1) this.tw = tw;
      if (c === 0 && inp.length === 1) { this.acc[1] += acc; this.sq[1] += sq; this.pk[1] = pk; this.tw = tw; break; }
    }
    this.cnt += n;
    if (this.cnt >= this.blk) {
      const N = this.cnt;
      this.hist.push((this.acc[0] + this.acc[1]) / N); if (this.hist.length > 30) this.hist.shift();
      const mean = (k) => { const h = this.hist.slice(-k); return h.length < k ? null : h.reduce((a, b) => a + b, 0) / k; };
      const m4 = mean(4);
      if (m4 != null) this.gated.push(m4);
      const L = MeterProcessor.lufs;
      // integrated: absolute gate, then relative gate 10 LU under the absolute-gated loudness
      let I = -Infinity;
      const abs = this.gated.filter((v) => L(v) > -70);
      if (abs.length) {
        const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
        const g2 = abs.filter((v) => L(v) > rel);
        if (g2.length) I = L(g2.reduce((a, b) => a + b, 0) / g2.length);
      }
      if (this.tp > this.tpMax) this.tpMax = this.tp;
      const dB = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
      this.last = { m: m4 == null ? -Infinity : L(m4), s: mean(30) == null ? -Infinity : L(mean(30)), i: I, tp: dB(this.tp), tpMax: dB(this.tpMax), rms: [Math.sqrt(this.sq[0] / N), Math.sqrt(this.sq[1] / N)], peak: this.pk.slice() };
      this.port.postMessage(this.last);
      this.acc = [0, 0]; this.sq = [0, 0]; this.pk = [0, 0]; this.cnt = 0; this.tp = 0;
    }
    return true;
  }
}
registerProcessor('opendj-meter', MeterProcessor);

/**
 * Warmth (mixer M16): adds 2nd and 3rd harmonics, mostly 2nd, to the untouched signal: y = x + d·(0.2·DC-blocked x²
 * - 0.1·x³). At drive 0 the output is the input exactly; ~1 % THD at drive 0.5 on a -14 dBFS sine. No oversampling
 * and no latency: a 3rd-order polynomial only creates harmonics up to 3x, the level is kept low.
 */
class WarmthProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'drive', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }]; }
  constructor() { super(); this.d = 0; this.dc = [[0, 0], [0, 0]]; }
  process(inputs, outputs, p) {
    const inp = inputs[0], out = outputs[0], n = out[0].length;
    const target = p.drive[0], d0 = this.d, d1 = Math.abs(target - d0) < 1e-5 ? target : d0 + (target - d0) * (1 - Math.exp(-n / (0.03 * sampleRate)));
    const R = 1 - 2 * Math.PI * 8 / sampleRate; // DC blocker on the x² term (8 Hz)
    for (let c = 0; c < out.length; c++) {
      const x = inp[c] || inp[0], o = out[c];
      if (!x) { o.fill(0); continue; }
      if (d0 === 0 && d1 === 0) { o.set(x); this.dc[c] = [0, 0]; continue; }
      const st = this.dc[c] || (this.dc[c] = [0, 0]);
      let xp = st[0], yp = st[1];
      for (let i = 0; i < n; i++) {
        const v = x[i], xc = v > 1.2 ? 1.2 : v < -1.2 ? -1.2 : v, sq = xc * xc;
        const h2 = sq - xp + R * yp; xp = sq; yp = h2;
        const d = d0 + (d1 - d0) * (i + 1) / n;
        o[i] = v + d * (0.2 * h2 - 0.1 * xc * xc * xc);
      }
      st[0] = xp; st[1] = yp;
    }
    this.d = d1;
    return true;
  }
}
registerProcessor('opendj-warmth', WarmthProcessor);
