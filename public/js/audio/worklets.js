// AudioWorklet processors: the deck player and the mix recorder.
// Loaded with audioWorklet.addModule(); runs on the real-time audio thread.

const GRAIN = 2048; // key-lock grain size (source frames)

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.L = null; this.R = null; this.len = 0;
    this.step = 1;            // source frames per output frame at rate 1 (resample ratio)
    this.pos = 0;             // play head in source frames
    this.shadow = 0;          // slip-mode shadow position
    this.playing = false;
    this.rate = 1;            // tempo * bend (target)
    this.curRate = 0;         // smoothed actual rate (gives turntable-like start/stop)
    this.startTime = 0.0;     // motor start/stop speeds (0 = instant, like CDJ)
    this.dir = 1;
    this.keyLock = false;
    this.pitch = 1;           // key shift as a frequency ratio (2^(semitones/12))
    this.slip = false;
    this.loop = null;         // { start, end } in frames
    this.scratch = null;      // { velocity } when the jog is touched
    this.brake = 0;           // brake deceleration per frame (0 = off)
    this.grains = [{ p: 0, age: 0 }, { p: 0, age: GRAIN / 2 }];
    this.counter = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.L = m.left; this.R = m.right || m.left; this.len = this.L.length;
        this.step = m.sampleRate / sampleRate;
        this.pos = this.shadow = 0; this.playing = false; this.curRate = 0; this.loop = null; this.brake = 0;
        break;
      case 'unload': this.L = this.R = null; this.len = 0; this.playing = false; break;
      case 'play': this.playing = m.value; if (m.value) this.brake = 0; break;
      case 'rate': this.rate = m.value; break;
      case 'seek': {
        // m.at = audio-clock time the target was computed for; advance by the time that passed since then
        let f = m.frame;
        if (m.at != null && this.playing && !this.scratch) f += Math.max(0, currentTime - m.at) * sampleRate * this.rate * this.dir * this.step;
        this.pos = Math.max(0, Math.min(Math.max(0, this.len - 1), f)); if (!this.slip) this.shadow = this.pos; this.resetGrains(); break;
      }
      case 'keylock': this.keyLock = m.value; this.resetGrains(); break;
      case 'pitch': this.pitch = m.value; this.resetGrains(); break;
      case 'reverse': this.dir = m.value ? -1 : 1; if (!m.value && this.slip) this.endSlip(); break;
      case 'slip': this.slip = m.value; if (m.value) this.shadow = this.pos; else this.endSlip(true); break;
      case 'loop': this.loop = m.value; if (!m.value && this.slip) this.endSlip(); break;
      case 'scratch': this.scratch = m.value; if (!m.value && this.slip) this.endSlip(); break;
      case 'brake': this.brake = m.value; break;
      case 'motor': this.startTime = m.value; break;
    }
  }

  endSlip(force) { if (this.slip || force) { this.pos = this.shadow; this.resetGrains(); } }
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
    if (i < 1 || i + 2 >= n) return (i >= 0 && i < n) ? buf[i] : 0;
    const y0 = buf[i - 1], y1 = buf[i], y2 = buf[i + 1], y3 = buf[i + 2];
    const c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const frames = oL.length;
    if (!this.L) { oL.fill(0); if (oR !== oL) oR.fill(0); return true; }

    for (let n = 0; n < frames; n++) {
      // --- determine the instantaneous speed ---
      let target;
      if (this.scratch) target = this.scratch.velocity;
      else if (this.brake > 0) { target = 0; }
      else target = this.playing ? this.rate * this.dir : 0;

      if (this.brake > 0 && !this.scratch) {
        const s = Math.sign(this.curRate);
        this.curRate -= s * this.brake;
        if (Math.sign(this.curRate) !== s || Math.abs(this.curRate) < 0.001) { this.curRate = 0; this.brake = 0; this.playing = false; this.port.postMessage({ type: 'stopped' }); }
      } else if (this.scratch) {
        this.curRate += (target - this.curRate) * 0.02; // smooth hand movement
      } else if (this.startTime > 0) {
        const k = 1 / (this.startTime * sampleRate);
        this.curRate += Math.max(-k, Math.min(k, target - this.curRate)) * 4;
      } else this.curRate = target;

      const speed = this.curRate * this.step;
      let l = 0, r = 0;
      if (speed !== 0 && this.pos >= 0 && this.pos < this.len) {
        // grains read at the speed that gives the wanted pitch; the play head moves at the tempo rate
        const readSpeed = (this.keyLock ? 1 : Math.abs(this.curRate)) * this.pitch;
        const granular = !this.scratch && this.brake === 0 && this.curRate > 0 && Math.abs(readSpeed - this.curRate) > 0.002;
        if (granular) {
          // granular time-stretch / pitch-shift, re-seeded from the (rate-scaled) play head
          for (const g of this.grains) {
            const w = Math.sin(Math.PI * g.age / GRAIN); const ww = w * w;
            l += this.sample(this.L, g.p) * ww; r += this.sample(this.R, g.p) * ww;
            g.p += this.step * this.dir * readSpeed; g.age++;
            if (g.age >= GRAIN) { g.age = 0; g.p = this.wsolaSeed(g === this.grains[0] ? this.grains[1] : this.grains[0], readSpeed); }
          }
        } else {
          l = this.sample(this.L, this.pos); r = this.sample(this.R, this.pos);
          this.grains[0].p = this.grains[1].p = this.pos;
        }
      }
      oL[n] = l; if (oR !== oL) oR[n] = r;

      this.pos += speed;
      if (this.slip) this.shadow += this.playing ? this.rate * this.step : 0;
      if (this.loop && speed > 0 && this.pos >= this.loop.end) { this.pos -= (this.loop.end - this.loop.start); this.resetGrains(); }
      if (this.pos < 0) { this.pos = 0; if (!this.scratch) this.curRate = 0; }
      if (this.pos >= this.len) {
        this.pos = this.len - 1; this.playing = false; this.curRate = 0;
        this.port.postMessage({ type: 'ended' });
      }
    }
    if ((this.counter += frames) >= 512) {
      this.counter = 0;
      this.port.postMessage({ type: 'pos', frame: this.pos, shadow: this.shadow, rate: this.curRate, playing: this.playing, time: currentTime + frames / sampleRate });
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
