// AudioWorklet processors for the effects that native Web Audio nodes can't do well:
//   opendj-lfo      beat-locked LFO / gate (control signal for native AudioParams)
//   opendj-reverb   feedback-delay-network reverb with smooth decay, damping and pre-delay
//   opendj-crush    bit depth + sample-rate reduction
//   opendj-limiter  look-ahead brickwall limiter for the master bus
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
