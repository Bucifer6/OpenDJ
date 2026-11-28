// Stereo peak-locked phase vocoder with transient phase-reset and formant-preserving pitch shift.
// Pure ES module (zero dependencies): runs in AudioWorkletProcessor (real-time decks), OfflineAudioContext, and Node tests.
//
// Design:
//   - N = 2048 FFT, 75 % overlap (hop Hs = 512), dual-Hann window (COLA sum = 1.5 -> scale = 2/3).
//   - Packs real stereo L + i*R into a SINGLE complex FFT forward and a SINGLE complex IFFT inverse (2x faster than
//     separate L/R FFTs with bit-exact mathematical equivalence).
//   - Because DJ decks hold random-access audio buffers, each frame reads ahead so the window center (k = N/2)
//     lines up with the exact deck playhead -> zero group delay relative to `DeckProcessor.pos` and beat grids.
//   - Peak-locking (Laroche & Dolson identity phase locking) on the shared stereo power spectrum eliminates
//     phasiness while preserving exact L/R inter-channel phase differences (zero stereo collapse).
//   - Spectral-flux transient detection resets synthesis phase on kicks/snares so drums stay sharp.
//   - Spectral-envelope (formant) preservation when `pitch != 1` keeps vocals natural under Key Sync / Pitch Play.

export const PV_SIZE = 2048;
export const PV_HOP = 512;
const HALF = PV_SIZE >> 1;
const BINS = HALF + 1;
const TAU = Math.PI * 2;
const COLA = 2 / 3; // 1 / sum(hann^2) for 75 % overlap (N/Hs = 4)

// Precomputed Hann window, synthesis Hann*COLA, and radix-2 bit-reversal + twiddle tables (shared across all deck instances).
const HANN = new Float32Array(PV_SIZE);
const SYNTH_HANN = new Float32Array(PV_SIZE);
for (let i = 0; i < PV_SIZE; i++) {
  HANN[i] = 0.5 * (1 - Math.cos((TAU * i) / PV_SIZE));
  SYNTH_HANN[i] = HANN[i] * COLA;
}

const BITREV = new Uint16Array(PV_SIZE);
for (let i = 0, bits = Math.log2(PV_SIZE); i < PV_SIZE; i++) {
  let r = 0, x = i;
  for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
  BITREV[i] = r;
}

const COS = new Float32Array(HALF);
const SIN = new Float32Array(HALF);
for (let i = 0; i < HALF; i++) {
  const a = (-TAU * i) / PV_SIZE;
  COS[i] = Math.cos(a);
  SIN[i] = Math.sin(a);
}

/** In-place radix-2 Cooley-Tukey FFT (sign = -1 forward, +1 inverse with 1/N scaling). */
export function fft2048(re, im, inverse = false) {
  for (let i = 0; i < PV_SIZE; i++) {
    const j = BITREV[i];
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sgn = inverse ? -1 : 1;
  for (let size = 2; size <= PV_SIZE; size <<= 1) {
    const half = size >> 1;
    const step = PV_SIZE / size;
    for (let i = 0; i < PV_SIZE; i += size) {
      for (let j = 0, tw = 0; j < half; j++, tw += step) {
        const wr = COS[tw], wi = SIN[tw] * sgn;
        const k = i + j, l = k + half;
        const tr = re[l] * wr - im[l] * wi;
        const ti = re[l] * wi + im[l] * wr;
        re[l] = re[k] - tr; im[l] = im[k] - ti;
        re[k] += tr; im[k] += ti;
      }
    }
  }
  if (inverse) {
    const inv = 1 / PV_SIZE;
    for (let i = 0; i < PV_SIZE; i++) { re[i] *= inv; im[i] *= inv; }
  }
}

function wrapPhase(p) {
  if (p > Math.PI) {
    p -= TAU;
    if (p > Math.PI) { p = (p + Math.PI) % TAU; return p < 0 ? p + TAU - Math.PI : p - Math.PI; }
  } else if (p < -Math.PI) {
    p += TAU;
    if (p < -Math.PI) { p = (p + Math.PI) % TAU; return p < 0 ? p + TAU - Math.PI : p - Math.PI; }
  }
  return p;
}

export class StereoPhaseVocoder {
  constructor() {
    this.zRe = new Float32Array(PV_SIZE);
    this.zIm = new Float32Array(PV_SIZE);
    this.reL = new Float32Array(BINS);
    this.imL = new Float32Array(BINS);
    this.reR = new Float32Array(BINS);
    this.imR = new Float32Array(BINS);
    this.mag = new Float32Array(BINS);
    this.prevMag = new Float32Array(BINS);
    this.inPhase = new Float32Array(BINS);
    this.prevInPhase = new Float32Array(BINS);
    this.synthPhase = new Float32Array(BINS);
    this.prevSynthPhase = new Float32Array(BINS);
    this.logEnv = new Float32Array(BINS);
    this.smoothEnv = new Float32Array(BINS);
    this.peaks = new Int16Array(BINS);
    // Overlap-add stereo ring buffer (PV_SIZE frames) + current read cursor
    this.olaL = new Float32Array(PV_SIZE);
    this.olaR = new Float32Array(PV_SIZE);
    this.olaPos = 0;    // read index inside ring buffer
    this.hopRemain = 0; // samples left to read before next synthesis hop
    this.primed = false;
    this.prevHa = PV_HOP;
    this.fluxAvg = 0;
    this.tmp = new Float32Array(2);
  }

  reset() {
    this.olaL.fill(0);
    this.olaR.fill(0);
    this.prevMag.fill(0);
    this.prevInPhase.fill(0);
    this.prevSynthPhase.fill(0);
    this.olaPos = 0;
    this.hopRemain = 0;
    this.primed = false;
    this.fluxAvg = 0;
  }

  /**
   * Synthesize one hop (PV_HOP samples) into the OLA ring starting at `this.olaPos`.
   * readStereo(srcFrame, out2): writes stereo sample at fractional source frame into out2[0..1].
   */
  synthesizeFrame(readStereo, pos, tempoStep, readStep, pitch, resetPhase = false) {
    const { zRe, zIm, reL, imL, reR, imR, mag, prevMag, inPhase, prevInPhase, synthPhase, prevSynthPhase, tmp } = this;
    // Align window center (k = HALF) to the deck playhead at t + HALF output samples: zero latency!
    const srcStart = pos + HALF * (tempoStep - readStep);
    for (let i = 0; i < PV_SIZE; i++) {
      readStereo(srcStart + i * readStep, tmp);
      const w = HANN[i];
      zRe[i] = tmp[0] * w;
      zIm[i] = tmp[1] * w;
    }

    // Single complex FFT for both real stereo channels (Z = L + i*R)
    fft2048(zRe, zIm, false);

    // Unpack L(k) and R(k) via conjugate symmetry + compute shared stereo magnitude & spectral flux
    reL[0] = zRe[0]; imL[0] = 0; reR[0] = zIm[0]; imR[0] = 0;
    reL[HALF] = zRe[HALF]; imL[HALF] = 0; reR[HALF] = zIm[HALF]; imR[HALF] = 0;
    for (let k = 1; k < HALF; k++) {
      const nk = PV_SIZE - k;
      const zr = zRe[k], zi = zIm[k], nr = zRe[nk], ni = zIm[nk];
      reL[k] = 0.5 * (zr + nr);
      imL[k] = 0.5 * (zi - ni);
      reR[k] = 0.5 * (zi + ni);
      imR[k] = 0.5 * (nr - zr);
    }

    let flux = 0, magSum = 1e-6;
    for (let k = 0; k < BINS; k++) {
      const rl = reL[k], il = imL[k], rr = reR[k], ir = imR[k];
      const p2 = rl * rl + il * il + rr * rr + ir * ir;
      if (p2 <= 1e-18) { mag[k] = 0; inPhase[k] = 0; continue; }
      const m = Math.sqrt(p2);
      mag[k] = m;
      magSum += m;
      const d = m - prevMag[k];
      if (d > 0) flux += d;
      const sRe = rl + rr, sIm = il + ir;
      if (sRe * sRe + sIm * sIm > 0.06 * p2) inPhase[k] = Math.atan2(sIm, sRe);
      else inPhase[k] = Math.atan2(il, rl);
    }
    const normFlux = flux / magSum;
    const isTransient = resetPhase || (this.fluxAvg > 0 && normFlux > Math.max(0.28, this.fluxAvg * 2.35));
    this.fluxAvg = resetPhase ? normFlux : this.fluxAvg * 0.85 + normFlux * 0.15;

    // 2) Optional formant preservation when pitch-shifting (Key Sync / Pitch Play)
    const doFormant = Math.abs(pitch - 1) > 0.015 && pitch > 0.45 && pitch < 2.2;
    if (doFormant) {
      const { logEnv, smoothEnv } = this;
      for (let k = 0; k < BINS; k++) logEnv[k] = Math.log(mag[k] + 1e-5);
      const R = 10;
      let sum = 0;
      for (let k = 0; k <= R; k++) sum += logEnv[k];
      for (let k = 0; k < BINS; k++) {
        if (k + R < BINS && k > 0) sum += logEnv[k + R];
        if (k - R - 1 >= 0) sum -= logEnv[k - R - 1];
        const count = Math.min(BINS - 1, k + R) - Math.max(0, k - R) + 1;
        smoothEnv[k] = sum / count;
      }
      const amt = Math.min(1, Math.abs(Math.log2(pitch)) * 18);
      for (let k = 2; k < BINS - 1; k++) {
        const kp = k * pitch;
        if (kp >= BINS - 1) continue;
        const ki = Math.floor(kp), frac = kp - ki;
        const target = smoothEnv[ki] * (1 - frac) + smoothEnv[ki + 1] * frac;
        const diff = Math.max(-1.6, Math.min(1.6, (target - smoothEnv[k]) * amt));
        const g = Math.exp(diff);
        reL[k] *= g; imL[k] *= g;
        reR[k] *= g; imR[k] *= g;
      }
    }

    // 3) Phase propagation: transient reset vs Laroche-Dolson peak-locked phase vocoder
    const ha = Math.abs(readStep) > 1e-9 ? PV_HOP * (tempoStep / readStep) : PV_HOP;
    if (isTransient) {
      for (let k = 0; k < BINS; k++) synthPhase[k] = inPhase[k];
    } else {
      const peaks = this.peaks;
      let nPeaks = 0;
      for (let k = 1; k < BINS - 1; k++) {
        if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) peaks[nPeaks++] = k;
      }
      if (nPeaks === 0) { peaks[0] = 1; nPeaks = 1; }

      const invHa = Math.abs(ha) > 1e-6 ? 1 / ha : 1 / PV_HOP;
      const freqStep = TAU / PV_SIZE;
      for (let p = 0; p < nPeaks; p++) {
        const pk = peaks[p];
        const expected = freqStep * pk * ha;
        const dev = wrapPhase(inPhase[pk] - prevInPhase[pk] - expected);
        const omega = freqStep * pk + dev * invHa;
        const sPh = wrapPhase(prevSynthPhase[pk] + omega * PV_HOP);
        const rot = sPh - inPhase[pk];
        const c = Math.cos(rot), s = Math.sin(rot);
        const lo = p === 0 ? 0 : (peaks[p - 1] + pk + 1) >> 1;
        const hi = p === nPeaks - 1 ? BINS - 1 : (pk + peaks[p + 1]) >> 1;
        for (let k = lo; k <= hi; k++) {
          synthPhase[k] = wrapPhase(inPhase[k] + rot);
          if (k > 0 && k < HALF) {
            const rl = reL[k], il = imL[k];
            reL[k] = rl * c - il * s; imL[k] = rl * s + il * c;
            const rr = reR[k], ir = imR[k];
            reR[k] = rr * c - ir * s; imR[k] = rr * s + ir * c;
          }
        }
      }
    }

    // Repack Z(k) = L(k) + i*R(k) and Z(N-k) = L*(k) + i*R*(k) for single complex IFFT
    zRe[0] = reL[0]; zIm[0] = reR[0];
    zRe[HALF] = reL[HALF]; zIm[HALF] = reR[HALF];
    for (let k = 1; k < HALF; k++) {
      const nk = PV_SIZE - k;
      const rl = reL[k], il = imL[k], rr = reR[k], ir = imR[k];
      zRe[k] = rl - ir;
      zIm[k] = il + rr;
      zRe[nk] = rl + ir;
      zIm[nk] = rr - il;
    }

    fft2048(zRe, zIm, true);

    // Overlap-add into circular output buffer with synthesis Hann window + COLA scale
    const { olaL, olaR } = this;
    const base = this.olaPos;
    const mask = PV_SIZE - 1;
    for (let i = 0; i < PV_SIZE; i++) {
      const idx = (base + i) & mask;
      const w = SYNTH_HANN[i];
      olaL[idx] += zRe[i] * w;
      olaR[idx] += zIm[i] * w;
    }

    prevMag.set(mag);
    prevInPhase.set(inPhase);
    prevSynthPhase.set(synthPhase);
    this.prevHa = ha;
  }

  /** Prime the 3 prior overlapping frames so output sample 0 is already full-amplitude and phase-aligned. */
  prime(readStereo, pos, tempoStep, readStep, pitch) {
    this.reset();
    const mask = PV_SIZE - 1;
    for (let f = -3; f <= 0; f++) {
      const framePos = pos + f * PV_HOP * tempoStep;
      this.olaPos = (f * PV_HOP) & mask;
      this.synthesizeFrame(readStereo, framePos, tempoStep, readStep, pitch, f === -3);
      if (f < 0) {
        for (let i = 0; i < PV_HOP; i++) {
          const idx = (this.olaPos + i) & mask;
          this.olaL[idx] = 0;
          this.olaR[idx] = 0;
        }
      }
    }
    this.olaPos = 0;
    this.hopRemain = PV_HOP;
    this.primed = true;
  }

  /** Produce one stereo output sample into out2[0..1], synthesizing a new hop whenever needed. */
  nextSample(readStereo, pos, tempoStep, readStep, pitch, out2) {
    const safePos = Number.isFinite(pos) ? pos : 0;
    const safeTempo = Number.isFinite(tempoStep) && Math.abs(tempoStep) <= 8 ? tempoStep : 1;
    const safeRead = Number.isFinite(readStep) && Math.abs(readStep) <= 8 ? readStep : 1;
    const safePitch = Number.isFinite(pitch) && pitch >= 0.25 && pitch <= 4 ? pitch : 1;
    if (!this.primed) this.prime(readStereo, safePos, safeTempo, safeRead, safePitch);
    if (this.hopRemain <= 0) {
      this.synthesizeFrame(readStereo, safePos, safeTempo, safeRead, safePitch, false);
      this.hopRemain = PV_HOP;
    }
    const idx = this.olaPos;
    let l = this.olaL[idx];
    let r = this.olaR[idx];
    this.olaL[idx] = 0;
    this.olaR[idx] = 0;
    this.olaPos = (idx + 1) & (PV_SIZE - 1);
    this.hopRemain--;
    if (!Number.isFinite(l) || !Number.isFinite(r)) {
      this.reset();
      l = 0; r = 0;
    }
    out2[0] = l;
    out2[1] = r;
    return out2;
  }
}
