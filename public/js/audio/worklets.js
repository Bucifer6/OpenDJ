// AudioWorklet processors: the deck player and the mix recorder.
// Loaded with audioWorklet.addModule(); runs on the real-time audio thread.
import { readStemMix, stemCoefficients, smoothGains, isUnity, isSilent } from '../stems/stem-mix.js';

const GRAIN = 2048; // key-lock grain size (source frames)
const SPIN_FLICK = 0.06; // backspin: time for the hand to throw the record from play speed to full reverse (s)
const VEL_KNEE = 0.3; // below this speed (resampled playback) the level follows the platter speed, like a cartridge
const HAND_K = 0.02; // velocity-mode hand smoothing per sample at the default jog weight (about a 1 ms time constant)
const MAX_HAND = 16; // fastest platter speed a hand (or a throw) can give, x normal
const EXTRAPOLATE = 0.03; // position mode: past its newest sample the hand eases onto it over this long (s)
const HAND_OUT_K = 1 - Math.exp(-1 / (0.0012 * sampleRate)); // position mode: platter speed smoothing (~1.2 ms)
const LAG_SLEW = 0.1;      // position mode: the render delay changes by at most 0.1 s per second
const MAX_GAP = 0.025;    // position mode: input intervals above this are pauses, not the input rate (s)
const LAG_GAP = 0.75;     // position mode: how much of the input interval the hand is rendered behind (interpolation margin)

/**
 * Jog weight 0 (light) .. 1 (heavy) -> velocity-mode smoothing coefficient per sample: 0.06 .. 0.005, exactly 0.02 at
 * the default 0.5 (today's feel). Exported for tests and the UI.
 */
export function handCoef(w) {
  w = Math.max(0, Math.min(1, Number(w)));
  if (!Number.isFinite(w) || w === 0.5) return HAND_K;
  return w < 0.5 ? 0.06 * (HAND_K / 0.06) ** (w / 0.5) : HAND_K * (0.005 / HAND_K) ** ((w - 0.5) / 0.5);
}
/** Position mode: the hand tracker's time constants (s) for a jog weight: position error and velocity smoothing. */
export function handTau(w) {
  w = Math.max(0, Math.min(1, Number(w) || 0));
  return { pos: 0.003 + 0.006 * w, vel: 0.0015 + 0.0045 * w };
}

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = null; this.R = null; this.len = 0; this.k = 1; this.scale = 1;
    this.step = 1;            // source frames per output frame at rate 1 (resample ratio)
    this.pos = 0;             // play head in source frames
    this.shadow = 0;          // slip-mode shadow position
    this.playing = false;
    this.rate = 1;            // tempo * bend (target)
    this.curRate = 0;         // smoothed actual rate (gives turntable-like start/stop)
    // vinyl motor (T1): start = seconds from 0 to 1x (torque), stop = seconds from 1x to 0 on pause / reverse
    // (friction + drag), inertia = seconds a record released with speed coasts before it stops (deck stopped),
    // slipmat 0..1 = how far the record creeps under a still hand / how much faster it spins up after a release.
    // All 0: instant, like a CDJ (and bit-identical to the deck before the motor model existed).
    this.motor = { start: 0, stop: 0, inertia: 0, slipmat: 0 };
    this.motorRamp = false;   // the motor is bringing the platter to speed (resampled playback, pitch follows)
    this.releaseRamp = false; // spin-up after the hand let go (slip-mat shortens it)
    this.coast = null;        // a released record coasting to a stop { T, v0 }
    this.handK = HAND_K;      // velocity-mode hand smoothing (jog weight)
    this.tau = handTau(0.5);  // position-mode tracker time constants (jog weight)
    this.hand = null;         // position-mode hand { anchor, pts: [[t, pos]...], lag, vs, creep }
    this.rateRamp = null;     // sample-accurate tempo glide { t0, t1, r0, r1 } (audio-clock seconds)
    this.armed = null;        // active loop waiting for the play head { start, end } (frames)
    this.alt = null;          // the track's audio while a scratch sample plays on this deck
    this.swap = null;         // pending buffer swap, done at the bottom of a short fade-out
    this.fout = 0;            // fade-out counter for the swap
    this.slipStop = false;    // brake / backspin: resume at the slip shadow instead of stopping
    this.dir = 1;
    this.keyLock = false;
    this.pitch = 1;           // key shift as a frequency ratio (2^(semitones/12))
    this.slip = false;
    this.loop = null;         // { start, end } in frames
    this.scratch = null;      // { velocity } when the jog is touched
    this.brake = 0;           // brake deceleration per frame (0 = off)
    this.bA = 0; this.bB = 0; // brake model dv/dt = -(bA + bB * v): friction + drag, stops in the requested time
    this.spin = null;         // backspin in progress { t, T, v0, from }
    this.FADE = Math.max(32, Math.round(0.004 * sampleRate)); // 4 ms de-click cross-fade
    this.ghost = { n: 0, p: 0, v: 0, w: 1 }; // the old play head, fading out after a jump / stop
    this.ghost2 = { n: 0, p: 0, v: 0, w: 0 }; // second grain when leaving key-lock granular playback
    this.fin = 1;             // fade-in of the main play head after a jump / start
    this.grains = [{ p: 0, age: 0 }, { p: 0, age: GRAIN / 2 }];
    this.counter = 0;
    this.seekSeq = 0;
    // AI stems: original + vocals/drums/bass (Int16), "other" = residual (see stems/stem-mix.js)
    this.stems = null;
    this.stemTarget = new Float32Array([1, 1, 1, 1]); this.stemCur = new Float32Array([1, 1, 1, 1]); this.stemCoef = stemCoefficients(this.stemCur);
    this.sendTarget = new Float32Array(4); this.sendCur = new Float32Array(4); this.sendCoef = stemCoefficients(this.sendCur); // stem FX send (output 1)
    this.stemK = 1 - Math.exp(-1 / (0.005 * sampleRate)); // ~5 ms gain smoothing: click-free, still sample accurate
    this.mo = new Float32Array(2); this.so = new Float32Array(2);
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.L = m.left; this.R = m.right || m.left; this.len = this.L.length;
        // 16-bit decks use half the memory; tracks peaking above 0 dBFS are stored peak-normalised and scaled back
        // up here (m.scale = the track's peak), so nothing clips before the channel gain / auto gain.
        this.scale = m.scale > 0 ? m.scale : 1;
        this.k = this.L instanceof Int16Array ? this.scale / 32767 : 1; // sample scale
        this.scaleCoef(stemCoefficients(this.stemCur, this.stemCoef));
        this.scaleCoef(stemCoefficients(this.sendCur, this.sendCoef));
        this.step = m.sampleRate / sampleRate;
        this.pos = this.shadow = 0; this.playing = false; this.curRate = 0; this.loop = null; this.brake = 0; this.spin = null;
        this.scratch = null; this.dir = 1; this.slip = false; this.endedSent = false; this.stems = null; this.ghost.n = 0; this.ghost2.n = 0; this.fin = 1;
        this.hand = null; this.coast = null; this.rateRamp = null; this.armed = null; this.alt = null; this.swap = null; this.fout = 0; this.slipStop = false; this.motorRamp = this.releaseRamp = false;
        break;
      case 'unload': this.L = this.R = null; this.len = 0; this.playing = false; this.scratch = null; this.dir = 1; this.slip = false; this.stems = null; this.spin = null; this.ghost.n = 0; this.ghost2.n = 0;
        this.hand = null; this.coast = null; this.rateRamp = null; this.armed = null; this.alt = null; this.swap = null; this.fout = 0; break;
      case 'ping': this.port.postMessage({ type: 'pong', id: m.id }); break; // sync point for tests
      case 'stems': // [{ L, R }] Int16 vocals, drums, bass with exactly the original's length (else ignored: stale load)
        this.stems = Array.isArray(m.value) && m.value.length && m.value.every((x) => x.L.length === this.len && x.R.length === this.len) ? m.value : null;
        this.port.postMessage({ type: 'stems', loaded: !!this.stems, rejected: !!m.value && !this.stems, seq: m.seq });
        break;
      case 'ext-port': m.port.onmessage = (e) => this.onMessage(e.data); break; // DVS decoder -> deck, audio thread to audio thread
      case 'stemGains': this.stemTarget.set(m.value); break;
      case 'stemSend': this.sendTarget.set(m.value); break;
      case 'play': this.playing = m.value; this.startAt = null;
        if (m.value) {
          this.brake = 0; this.spin = null; this.coast = null; this.slipStop = false;
          // m.at: the audio-clock time the start position was planned for (automix): starting late, the play head
          // catches up by the time that passed; arriving early, it waits for that time, so beats land where planned
          if (Number.isFinite(m.at) && !this.scratch) {
            const late = currentTime - m.at;
            if (late > 0) this.pos = Math.max(0, Math.min(Math.max(0, this.len - 1), this.pos + Math.min(0.5, late) * sampleRate * this.rate * this.dir * this.step));
            else if (late > -1) this.startAt = m.at;
          }
          if (m.instant) { this.curRate = this.rate * this.dir; this.motorRamp = false; } // no motor spin-up: on the beat at once
        }
        break;
      case 'rate': this.rate = m.value; this.rateRamp = null; break;
      // tempo glide (T5; also the automix engine's rateRamp): the rate moves linearly from its current value to `to`
      // over `dur` seconds, starting at audio time `at` (default: now). Sample accurate; a 'rate' message cancels it.
      case 'rateRamp': {
        const t0 = m.at != null ? m.at : currentTime, dur = Math.max(0, Number(m.dur) || 0);
        if (!(Number.isFinite(m.to) && m.to > 0)) { this.rateRamp = null; break; }
        if (dur === 0) { this.rate = m.to; this.rateRamp = null; this.port.postMessage({ type: 'rampDone', rate: m.to, id: m.id }); break; }
        this.rateRamp = { t0, t1: t0 + dur, r0: m.from > 0 ? m.from : this.rate, r1: m.to, id: m.id };
        break;
      }
      case 'seek': {
        if (Number.isSafeInteger(m.seq)) this.seekSeq = m.seq;
        // m.at = audio-clock time the target was computed for; advance by the time that passed since then
        let f = m.frame;
        if (m.at != null && this.playing && !this.scratch) f += Math.max(0, currentTime - m.at) * sampleRate * this.rate * this.dir * this.step;
        f = Math.max(0, Math.min(Math.max(0, this.len - 1), f));
        if (Math.abs(f - this.pos) > 1) this.startGhost();
        if (this.hand) this.hand.anchor += f - this.pos; // a jump under the hand: the hand keeps its place on the record
        this.pos = f; if (!this.slip) this.shadow = this.pos; this.resetGrains(); break;
      }
      // (no grain reset: jumping the grains to the play head mid-grain clicked; a mode change is cross-faded in process())
      case 'keylock': this.keyLock = m.value; break;
      case 'pitch': this.pitch = m.value; break;
      case 'reverse': this.dir = m.value ? -1 : 1; if (!m.value && this.slip) this.endSlip(); break;
      case 'slip': this.slip = m.value; if (m.value) this.shadow = this.pos; else this.endSlip(true); break;
      case 'loop': this.loop = m.value; if (!m.value && this.slip) this.endSlip(); break;
      case 'scratch': this.setScratch(m.value); break;
      // position-following scratch (T3; controller plan §4.7): pos = the hand's travel in source frames since the
      // touch ({ type: 'scratch', value: { pos: true } }), t = the input event's audio-clock time
      case 'scratchPos': this.handPoint(m.pos, m.t); break;
      case 'jogWeight': this.handK = handCoef(m.value); this.tau = handTau(m.value); break;
      case 'armLoop': this.armed = m.value && m.value.end > m.value.start ? { start: m.value.start, end: m.value.end } : null; break;
      // scratch samples (T9): play a short sample on this deck, then return to the track (its audio stays here)
      case 'altLoad': this.swap = { kind: 'in', m }; this.fout = this.L && this.curRate !== 0 ? this.FADE : 0; break;
      case 'altReturn': if (this.alt || (this.swap && this.swap.kind === 'in')) { this.swap = { kind: 'out', frame: m.frame }; this.fout = this.L && this.curRate !== 0 ? this.FADE : 0; } break;
      case 'brake': // m.value = 1 / (stop time * sampleRate), as before; m.slip: resume at the shadow afterwards
        this.brake = m.value > 0 ? m.value : 0;
        if (this.brake) { const T = 1 / (this.brake * sampleRate); this.bB = Math.log(3) / T; this.bA = this.bB / 2; this.coast = null; } // v(T) = 0
        this.slipStop = !!(this.brake && m.slip);
        break;
      case 'backspin': // throw the record backwards, then let it spin down and stop
        if (this.L) { this.spin = { t: 0, T: Math.max(0.2, m.seconds || 1), v0: Math.abs(m.speed || 4.5), from: this.curRate }; this.brake = 0; this.coast = null; this.slipStop = !!m.slip; }
        break;
      // motor: a number = start time (the original hook), or { start, stop, inertia, slipmat } (any subset)
      case 'motor': {
        const v = typeof m.value === 'number' ? { start: m.value } : m.value || {};
        for (const k of ['start', 'stop', 'inertia', 'slipmat']) if (Number.isFinite(v[k]) && v[k] >= 0) this.motor[k] = k === 'slipmat' ? Math.min(1, v[k]) : Math.min(10, v[k]);
        break;
      }
    }
  }

  /** Motor (T1): approach the target speed with the start torque, slow down with the stop brake (friction + drag). */
  motorStep(target) {
    const sr = sampleRate, m = this.motor;
    let v = this.curRate;
    const toward0 = target === 0 || Math.sign(target) !== Math.sign(v) && v !== 0;
    if (toward0) { // pause, or reverse: brake through zero first
      if (m.stop > 0) {
        const b = Math.log(3) / m.stop, a = Math.abs(v), s = Math.sign(v), nv = a - (b / 2 + b * a) / sr;
        v = nv <= 0.001 ? 0 : s * nv;
      } else v = 0;
      if (v === 0 && target === 0) this.releaseRamp = false;
    } else { // torque-limited approach: dv/dt = clamp(K (target - v), +-1/start), 0 -> 1x in `start` seconds
      const T = m.start * (this.releaseRamp ? 1 - 0.6 * m.slipmat : 1);
      if (T > 0) {
        const acc = 1 / (T * sr), d = target - v;
        let dv = d * 40 * acc; if (dv > acc) dv = acc; else if (dv < -acc) dv = -acc;
        v += dv;
        if (Math.abs(target - v) < 1e-5) v = target;
      } else v = target;
    }
    this.curRate = v;
    if (v === target) this.releaseRamp = false;
  }
  /** A brake or backspin reached zero: stop the deck, or (slip variants) carry on at the shadow position. */
  stopDone() {
    if (this.slipStop) {
      this.slipStop = false;
      if (Math.abs(this.shadow - this.pos) > 1) { this.pos = this.shadow; this.resetGrains(); }
      this.fin = 0;
      this.port.postMessage({ type: 'slipResumed' });
      return;
    }
    this.playing = false; this.port.postMessage({ type: 'stopped' });
  }
  /** Scratch samples: swap the deck's audio for a short sample (and back) at the bottom of a fade. */
  doSwap() {
    const sw = this.swap; this.swap = null;
    if (sw.kind === 'in') {
      const m = sw.m;
      if (!this.alt) this.alt = { L: this.L, R: this.R, len: this.len, k: this.k, scale: this.scale, step: this.step, stems: this.stems, loop: this.loop };
      this.L = m.left; this.R = m.right || m.left; this.len = this.L.length;
      this.scale = m.scale > 0 ? m.scale : 1; this.k = this.L instanceof Int16Array ? this.scale / 32767 : 1;
      this.step = m.sampleRate / sampleRate; this.stems = null; this.loop = null; this.armed = null;
      this.pos = this.shadow = 0; this.endedSent = false;
    } else {
      const a = this.alt; if (!a) return;
      this.alt = null;
      this.L = a.L; this.R = a.R; this.len = a.len; this.k = a.k; this.scale = a.scale; this.step = a.step; this.stems = a.stems; this.loop = null;
      const f = Number.isFinite(sw.frame) ? sw.frame : 0;
      this.pos = this.shadow = Math.max(0, Math.min(Math.max(0, this.len - 1), f)); this.endedSent = false;
      this.port.postMessage({ type: 'altReturned', frame: this.pos });
    }
    this.scaleCoef(stemCoefficients(this.stemCur, this.stemCoef));
    this.scaleCoef(stemCoefficients(this.sendCur, this.sendCoef));
    if (this.hand) this.hand.anchor = this.pos - (this.hand.pts.length ? this.hand.pts[this.hand.pts.length - 1][1] : 0);
    this.ghost.n = 0; this.ghost2.n = 0; this.fin = 0; this.resetGrains();
  }

  /** Apply the sample scales to stem-mix coefficients: [0] the original (this.k), [1..3] the Int16 stems (same peak scale). */
  scaleCoef(c) { c[0] *= this.k; c[1] *= this.scale; c[2] *= this.scale; c[3] *= this.scale; return c; }

  /** Hand on / off the record. value: null (release), { velocity } (velocity mode) or { pos: true } (position mode). */
  setScratch(value) {
    const was = this.scratch;
    this.scratch = value || null;
    if (value && value.pos) {
      if (!this.hand) this.hand = { anchor: this.pos, pts: [], lag: 0, lagTarget: 0, delay: 0, gap: 1 / 120, vs: this.curRate * this.step, creep: 0 };
    } else this.hand = null;
    if (value) { this.coast = null; this.releaseRamp = false; return; }
    if (!was) return;
    if (this.slip) this.endSlip();
    // let go: a stopped deck's record coasts (inertia); a playing deck's motor brings it back to speed (start time)
    if (!this.playing && this.motor.inertia > 0 && Math.abs(this.curRate) > 0.05) this.coast = { T: this.motor.inertia, v0: Math.abs(this.curRate) };
    else if (this.playing && this.motor.start > 0) this.releaseRamp = true;
  }
  /** Position mode: one hand sample (travel in frames since the touch, at audio time t). */
  handPoint(pos, t) {
    const h = this.hand;
    if (!h || !Number.isFinite(pos)) return;
    if (!Number.isFinite(t)) t = currentTime;
    const pts = h.pts;
    let i = pts.length;
    while (i > 0 && pts[i - 1][0] >= t) i--; // in time order (a late sample replaces / slots in)
    if (i < pts.length && pts[i][0] === t) pts[i][1] = pos; else pts.splice(i, 0, [t, pos]);
    if (pts.length > 24) pts.shift();
    if (i > 0) { const dt = t - pts[i - 1][0]; if (dt > 0 && dt < 0.1) h.gap += (Math.min(dt, MAX_GAP) - h.gap) * 0.2; }
    // render the hand this far behind real time, so samples are interpolated, not guessed: the arrival delay (followed
    // up at once, back down slowly) plus part of the input interval
    const d = Math.max(0, Math.min(0.1, currentTime - t));
    h.delay = Math.max(d, h.delay - 0.00002);
    h.lagTarget = Math.min(0.1, h.delay + LAG_GAP * h.gap);
    if (pts.length <= 2) h.lag = h.lagTarget; // (followHand slews it after that: no time jumps, no speed spikes)
  }
  /** Position mode: the hand's position (frames from the anchor) and speed (frames per second) at audio time t. */
  handAt(t) {
    const pts = this.hand.pts, n = pts.length;
    if (!n) return [0, 0];
    if (t <= pts[0][0]) return [pts[0][1], 0];
    for (let i = n - 1; i > 0; i--) {
      const a = pts[i - 1], b = pts[i];
      if (t >= a[0]) {
        const v = (b[1] - a[1]) / (b[0] - a[0]);
        if (t <= b[0]) return [a[1] + v * (t - a[0]), v];
        // past the newest sample (late input, or the hand stopped and sends nothing): carry on with the last speed
        // and ease back onto the newest sample within EXTRAPOLATE, so a stopped hand leaves the record where it stopped
        const s = t - b[0];
        if (s >= EXTRAPOLATE) return [b[1], 0];
        const k = 1 - s / EXTRAPOLATE;
        return [b[1] + v * s * k * k, v * k * (1 - 3 * s / EXTRAPOLATE)];
      }
    }
    return [pts[n - 1][1], 0];
  }
  /** Position mode, per sample: drive the platter so the play head follows the hand (velocity feed-forward + position correction). */
  followHand(t) {
    const h = this.hand, sr = sampleRate;
    const dl = h.lagTarget - h.lag, maxd = LAG_SLEW / sr; // render-delay changes warp time by at most LAG_SLEW
    h.lag += dl > maxd ? maxd : dl < -maxd ? -maxd : dl;
    const [x, v] = this.handAt(t - h.lag);
    // slip-mat: a still hand lets a running platter drag the record along a little
    if (this.playing && this.motor.slipmat > 0) h.creep += this.motor.slipmat * 0.03 * this.rate * this.dir * this.step;
    const target = h.anchor + x + h.creep;
    h.vs += (v / sr - h.vs) * (1 - Math.exp(-1 / (this.tau.vel * sr)));
    let speed = h.vs + (target - this.pos) * (1 - Math.exp(-1 / (this.tau.pos * sr)));
    const lim = MAX_HAND * this.step;
    if (speed > lim) speed = lim; else if (speed < -lim) speed = -lim;
    // a last ~1 ms smoothing of the platter speed: a late hand sample that bends the path must not step the speed
    // (below VEL_KNEE the level follows the speed, so a speed step would be a level step: a click)
    this.curRate += (speed / this.step - this.curRate) * HAND_OUT_K;
  }

  endSlip(force) { if (this.slip || force) { if (Math.abs(this.shadow - this.pos) > 1) this.startGhost(); this.pos = this.shadow; this.resetGrains(); } }
  /** Keep the current play head sounding for a few ms, fading out, while the new one fades in (no click on jumps). */
  startGhost(speed = this.curRate * this.step) {
    if (!this.L || speed === 0) return;
    this.ghost.p = this.pos; this.ghost.v = speed; this.ghost.n = this.FADE; this.ghost.w = 1; this.ghost2.n = 0; this.fin = 0;
  }
  /** WSOLA: start the new grain near the play head, at the offset whose waveform best continues the other grain. */
  wsolaSeed(other, speed) {
    const target = this.pos, L = this.L, R = this.R, n = this.len;
    const win = 192, search = 320, stride = 3, sp = this.step * this.dir * speed;
    const ref = other.p;
    if (ref < 0 || ref + win * sp >= n || target - search < 1 || target + search + win * sp >= n) return target;
    let best = 0, bestScore = -Infinity;
    for (let d = -search; d <= search; d += 4) {
      let c = 0;
      for (let k = 0; k < win; k += stride) {
        const a = Math.floor(ref + k * sp), b = Math.floor(target + d + k * sp);
        c += (L[a] + R[a]) * (L[b] + R[b]);
      }
      if (c > bestScore) { bestScore = c; best = d; }
    }
    return target + best;
  }

  resetGrains() { this.grains[0].p = this.pos; this.grains[0].age = 0; this.grains[1].p = this.pos; this.grains[1].age = GRAIN / 2; }

  // 4-point Hermite interpolation
  sample(buf, x) {
    const i = Math.floor(x); const f = x - i; const n = this.len;
    const k = this.k;
    if (i < 1 || i + 2 >= n) return (i >= 0 && i < n) ? buf[i] * k : 0;
    const y0 = buf[i - 1], y1 = buf[i], y2 = buf[i + 1], y3 = buf[i + 2];
    const c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return (((c3 * f + c2) * f + c1) * f + y1) * k;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const frames = oL.length;
    const fx = outputs[1], fL = fx?.[0], fR = fx?.[1] || fL; // stem FX send
    if (fL) { fL.fill(0); if (fR !== fL) fR.fill(0); }
    if (this.swap && this.fout <= 0) this.doSwap();
    if (!this.L) { oL.fill(0); if (oR !== oL) oR.fill(0); return true; }
    let stems = this.stems; const mo = this.mo, so = this.so;

    for (let n = 0; n < frames; n++) {
      const tNow = currentTime + n / sampleRate;
      if (this.startAt != null) { // a start scheduled for a precise audio time (see 'play'): silent until then
        if (tNow < this.startAt) { oL[n] = 0; if (oR !== oL) oR[n] = 0; continue; }
        this.startAt = null;
      }
      if (this.rateRamp) { // tempo glide: linear in rate between t0 and t1
        const rr = this.rateRamp;
        if (tNow >= rr.t1) { this.rate = rr.r1; this.rateRamp = null; this.port.postMessage({ type: 'rampDone', rate: rr.r1, id: rr.id }); }
        else if (tNow >= rr.t0) this.rate = rr.r0 + (rr.r1 - rr.r0) * (tNow - rr.t0) / (rr.t1 - rr.t0);
      }
      // --- determine the instantaneous speed ---
      let target;
      const prevRate = this.curRate;
      if (this.scratch) target = this.scratch.pos ? this.curRate : this.scratch.velocity + (this.playing && this.motor.slipmat > 0 ? this.motor.slipmat * 0.03 * this.rate * this.dir : 0);
      else if (this.brake > 0 || this.spin) { target = 0; }
      else target = this.playing ? this.rate * this.dir : 0;

      if (this.spin && !this.scratch) {
        const sp = this.spin; sp.t += 1 / sampleRate;
        if (sp.t < SPIN_FLICK) { const k = 0.5 - 0.5 * Math.cos(Math.PI * sp.t / SPIN_FLICK); this.curRate = sp.from + (-sp.v0 - sp.from) * k; }
        else { // friction spin-down (same model as the brake), reaches 0 after sp.T
          const b = Math.log(3) / sp.T, v = -this.curRate - (b / 2 + b * -this.curRate / sp.v0) * sp.v0 / sampleRate;
          if (v <= 0.001) { this.curRate = 0; this.spin = null; this.stopDone(); }
          else this.curRate = -v;
        }
      } else if (this.brake > 0 && !this.scratch) {
        const s = Math.sign(this.curRate), v = Math.abs(this.curRate) - (this.bA + this.bB * Math.abs(this.curRate)) / sampleRate;
        if (v <= 0.001 || s === 0) { this.curRate = 0; this.brake = 0; this.stopDone(); }
        else this.curRate = s * v;
      } else if (this.scratch) {
        if (this.scratch.pos) this.followHand(tNow); // position mode: the play head follows the hand
        else this.curRate += (target - this.curRate) * this.handK; // smooth hand movement (jog weight)
      } else if (this.coast) { // released record coasting (deck stopped): friction + drag, stops after coast.T
        const c = this.coast, b = Math.log(3) / c.T, s = Math.sign(this.curRate), a = Math.abs(this.curRate);
        const v = a - (b / 2 + b * a / c.v0) * c.v0 / sampleRate;
        if (v <= 0.001 || s === 0 || this.playing) { this.coast = null; if (!this.playing) this.curRate = 0; }
        else this.curRate = s * v;
      } else if ((this.motor.start > 0 || this.motor.stop > 0) && this.curRate !== target) {
        this.motorStep(target);
      } else { this.curRate = target; this.releaseRamp = false; }
      this.motorRamp = !this.scratch && this.curRate !== target && (this.motor.start > 0 || this.motor.stop > 0);
      // instant speed jumps (play, pause, censor reverse): cross-fade instead of stepping the waveform
      if (!this.scratch && Math.abs(this.curRate - prevRate) > 0.2) { if (this.ghost.n < this.FADE) this.startGhost(prevRate * this.step); this.fin = 0; }

      // stem gains: per-sample smoothing; the plain original path is used whenever every stem is at unity
      let useMix = false, useSend = false;
      if (stems) {
        if (smoothGains(this.stemCur, this.stemTarget, this.stemK)) this.scaleCoef(stemCoefficients(this.stemCur, this.stemCoef));
        if (smoothGains(this.sendCur, this.sendTarget, this.stemK)) this.scaleCoef(stemCoefficients(this.sendCur, this.sendCoef));
        useMix = !isUnity(this.stemCur);
        useSend = !!fL && !isSilent(this.sendCur);
      }
      const speed = this.curRate * this.step;
      let l = 0, r = 0, sl = 0, sr = 0;
      if (speed !== 0 && this.pos >= 0 && this.pos < this.len) {
        // grains read at the speed that gives the wanted pitch; the play head moves at the tempo rate
        const readSpeed = (this.keyLock ? 1 : Math.abs(this.curRate)) * this.pitch;
        const granular = !this.scratch && this.brake === 0 && !this.coast && !this.motorRamp && this.curRate > 0 && Math.abs(readSpeed - this.curRate) > 0.002;
        if (granular !== this.wasGranular) {
          // switching between direct resampling and the key-lock grains (nudge, bend, tempo to / from 0 %, key lock
          // or key shift): the voice we leave keeps sounding for a few ms, fading out, while the new one fades in
          if (this.wasGranular) { // leave the grains: both grains fade out as ghosts, at their positions, weights and read speed
            const v = this.step * this.dir * this.lastRead;
            this.grains.forEach((g, k) => { const gh = k ? this.ghost2 : this.ghost; gh.p = g.p; gh.v = v; gh.n = this.FADE; gh.w = Math.sin(Math.PI * g.age / GRAIN) ** 2; });
            this.fin = 0;
          } else this.resetGrains(); // enter: grain 1 sits at full weight on the play head, so this is seamless
          this.wasGranular = granular;
        }
        if (granular) {
          this.lastRead = readSpeed;
          // granular time-stretch / pitch-shift, re-seeded from the (rate-scaled) play head
          for (const g of this.grains) {
            const w = Math.sin(Math.PI * g.age / GRAIN); const ww = w * w;
            if (useMix) { readStemMix(this.L, this.R, stems, this.stemCoef, g.p, this.len, mo); l += mo[0] * ww; r += mo[1] * ww; }
            else { l += this.sample(this.L, g.p) * ww; r += this.sample(this.R, g.p) * ww; }
            if (useSend) { readStemMix(this.L, this.R, stems, this.sendCoef, g.p, this.len, so); sl += so[0] * ww; sr += so[1] * ww; }
            g.p += this.step * this.dir * readSpeed; g.age++;
            if (g.age >= GRAIN) { g.age = 0; g.p = this.wsolaSeed(g === this.grains[0] ? this.grains[1] : this.grains[0], readSpeed); }
          }
        } else {
          if (useMix) { readStemMix(this.L, this.R, stems, this.stemCoef, this.pos, this.len, mo); l = mo[0]; r = mo[1]; }
          else { l = this.sample(this.L, this.pos); r = this.sample(this.R, this.pos); }
          if (useSend) { readStemMix(this.L, this.R, stems, this.sendCoef, this.pos, this.len, so); sl = so[0]; sr = so[1]; }
          this.grains[0].p = this.grains[1].p = this.pos;
        }
      } else this.wasGranular = false;
      // resampled playback below VEL_KNEE: level follows the platter speed (brakes / spin-downs / slow scratches fade
      // to silence instead of ending on a DC step)
      const av = Math.abs(this.curRate);
      if (av < VEL_KNEE && !(this.keyLock && !this.scratch && this.brake === 0 && !this.spin && !this.coast && !this.motorRamp && this.curRate > 0)) { const g = av / VEL_KNEE; l *= g; r *= g; sl *= g; sr *= g; }
      if (this.fin < 1) { const g = 0.5 - 0.5 * Math.cos(Math.PI * this.fin); l *= g; r *= g; sl *= g; sr *= g; this.fin = Math.min(1, this.fin + 1 / this.FADE); }
      if (this.swap) { // fading out before a buffer swap (scratch sample in / out): silent once the fade is done
        const g = this.fout > 0 ? 0.5 - 0.5 * Math.cos(Math.PI * this.fout / this.FADE) : 0; l *= g; r *= g; sl *= g; sr *= g;
        if (this.fout > 0) this.fout--;
      }
      for (const gh of [this.ghost, this.ghost2]) {
        if (gh.n <= 0) continue;
        if (this.swap) { gh.n = 0; continue; }
        const g = (0.5 - 0.5 * Math.cos(Math.PI * gh.n / this.FADE)) * gh.w; // raised-cosine fade-out
        if (gh.p >= 0 && gh.p < this.len) {
          if (useMix) { readStemMix(this.L, this.R, stems, this.stemCoef, gh.p, this.len, mo); l += mo[0] * g; r += mo[1] * g; }
          else { l += this.sample(this.L, gh.p) * g; r += this.sample(this.R, gh.p) * g; }
        }
        gh.p += gh.v; gh.n--;
      }
      oL[n] = l; if (oR !== oL) oR[n] = r;
      if (useSend) { fL[n] = sl; if (fR !== fL) fR[n] = sr; }

      const prevPos = this.pos;
      this.pos += speed;
      if (this.slip) this.shadow += this.playing ? this.rate * this.step : 0;
      // active loop: engages when the play head reaches its start going forwards (sample accurate)
      if (this.armed && speed > 0 && prevPos < this.armed.start && this.pos >= this.armed.start) {
        this.loop = this.armed; this.armed = null;
        this.port.postMessage({ type: 'loopEngaged', start: this.loop.start, end: this.loop.end });
      }
      const preWrap = this.pos;
      // loop wrap: modulo the loop length, so a play head far past the end (loop engaged late, halved) lands inside the
      // loop in one wrap with one ghost voice instead of wrapping (and restarting the ghost) every sample
      if (this.loop && speed > 0 && this.pos >= this.loop.end) { const ln = this.loop.end - this.loop.start; this.startGhost(speed); this.pos = ln > 0 ? this.loop.start + ((this.pos - this.loop.start) % ln) : this.loop.start; this.resetGrains(); }
      else if (this.loop && speed < 0 && this.pos < this.loop.start) { const ln = this.loop.end - this.loop.start; this.startGhost(speed); this.pos = ln > 0 ? this.loop.end - ((this.loop.end - this.pos) % ln || ln) : this.loop.start; this.resetGrains(); } // reverse wraps too
      if (this.hand && this.pos !== preWrap) this.hand.anchor += this.pos - preWrap; // loop wrap under the hand
      if (this.pos < 0) { this.pos = 0; if (!this.scratch) { this.curRate = 0; this.coast = null; } }
      if (this.pos >= this.len) {
        this.pos = this.len - 1; this.curRate = 0; this.coast = null;
        if (!this.endedSent && !this.scratch) { this.endedSent = true; this.playing = false; this.port.postMessage({ type: 'ended' }); }
      } else if (this.endedSent && this.pos < this.len - 2) this.endedSent = false;
    }
    if ((this.counter += frames) >= 512) {
      this.counter = 0;
      this.port.postMessage({ type: 'pos', frame: this.pos, shadow: this.shadow, rate: this.curRate, playing: this.playing, time: currentTime + frames / sampleRate, alt: !!this.alt, tempo: this.rate, seekSeq: this.seekSeq });
    }
    return true;
  }
}
registerProcessor('deck-processor', DeckProcessor);

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.port.onmessage = (e) => { this.on = e.data.record; };
    this.bufL = new Float32Array(16384); this.bufR = new Float32Array(16384); this.n = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (this.on && inp.length) {
      const l = inp[0], r = inp[1] || inp[0];
      for (let i = 0; i < l.length; i++) {
        this.bufL[this.n] = l[i]; this.bufR[this.n] = r[i];
        if (++this.n === this.bufL.length) {
          this.port.postMessage({ l: this.bufL, r: this.bufR }, [this.bufL.buffer, this.bufR.buffer]);
          this.bufL = new Float32Array(16384); this.bufR = new Float32Array(16384); this.n = 0;
        }
      }
    } else if (!this.on && this.n) {
      this.port.postMessage({ l: this.bufL.slice(0, this.n), r: this.bufR.slice(0, this.n), flush: true });
      this.n = 0;
    }
    return true;
  }
}
registerProcessor('recorder-processor', RecorderProcessor);
