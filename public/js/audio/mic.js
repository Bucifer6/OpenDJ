// Microphone strip v2 (mixer M8) and the voice bus. Built on any BaseAudioContext, so the whole chain can be rendered
// offline in tests. The engine connects getUserMedia to `input` and `output` to its mic bus (master, booth, record).
//
//   input -> level -> HPF 100 Hz -> low shelf 200 Hz -> peak 1.5 kHz -> high shelf 5 kHz -> [feedback notches]
//         -> compressor -> dry ---------------------------------------------> output
//                       -> FX send (echo / reverb: parallel, no added latency) -> output
//                       -> FX insert (megaphone / pitch: cross-faded with dry)
// Feedback-safe defaults: 100 Hz high-pass, level 0.7, the mic is not sent to the booth (engine) and the optional
// feedback reducer notches narrow sustained peaks.
import { createMicFx, MIC_FX_LIST } from './effects.js';

const FB_NOTCHES = 4;

export class MicStrip {
  constructor(ctx) {
    this.ctx = ctx;
    const bq = (type, f, q, g) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; if (q != null) n.Q.value = q; if (g != null) n.gain.value = g; return n; };
    this.input = ctx.createGain();
    this.level = ctx.createGain(); this.level.gain.value = 0.7 * 0.7 * 1.5;
    this.hp = bq('highpass', 100, 0.7071);
    this.low = bq('lowshelf', 200, null, 0); this.mid = bq('peaking', 1500, 0.8, 0); this.high = bq('highshelf', 5000, null, 0);
    this.notchIn = ctx.createGain(); this.notchOut = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor(); this.comp.threshold.value = -24; this.comp.ratio.value = 4;
    this.dry = ctx.createGain(); this.fxSend = ctx.createGain(); this.fxWet = ctx.createGain(); this.output = ctx.createGain();
    this.fxSend.gain.value = 0; this.fxWet.gain.value = 0;
    this.input.connect(this.level); this.level.connect(this.hp); this.hp.connect(this.low); this.low.connect(this.mid); this.mid.connect(this.high);
    this.high.connect(this.notchIn); this.notchIn.connect(this.notchOut); this.notchOut.connect(this.comp);
    this.comp.connect(this.dry); this.dry.connect(this.output);
    this.comp.connect(this.fxSend); this.fxWet.connect(this.output);
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 512; this.comp.connect(this.meter); this._buf = new Float32Array(512);
    this.fxType = 'echo'; this.fxOn = false; this.fxLevel = 0.5; this.fx = null; this.fxFade = null; this.beatSec = 0.5;
    this.notches = null; this.fbOn = false; this.fbState = null;
  }
  setVolume(v) { this.level.gain.setTargetAtTime(v * v * 1.5, this.ctx.currentTime, 0.02); }
  /** EQ band 'low' | 'mid' | 'high', v -1..1 -> ±12 dB. */
  setEq(band, v) { const n = { low: this.low, mid: this.mid, high: this.high }[band]; if (n) n.gain.setTargetAtTime(Math.max(-1, Math.min(1, v)) * 12, this.ctx.currentTime, 0.02); }
  setFxType(id) {
    if (!MIC_FX_LIST.some((f) => f.id === id) || (id === this.fxType && this.fx)) { this.fxType = id; return; }
    this.fxType = id;
    if (this.fx) this._buildFx(); // swap while running (cross-fade)
  }
  setFx(on) { this.fxOn = !!on; if (this.fxOn && !this.fx) this._buildFx(); this._applyFx(); }
  setFxLevel(v) { this.fxLevel = Math.max(0, Math.min(1, v)); this._applyFx(); }
  setTempo(beatSec) { if (beatSec > 0) { this.beatSec = beatSec; this.fx?.setTempo?.(beatSec); } }
  _buildFx() {
    const c = this.ctx, t = c.currentTime;
    if (this.fx) { const old = this.fx, fade = this.fxFade; fade.gain.setTargetAtTime(0, t, 0.012); setTimeout(() => { try { this.fxSend.disconnect(old.input); } catch { /* */ } try { fade.disconnect(); } catch { /* */ } old.dispose(); }, 200); }
    this.fx = createMicFx(c, this.fxType);
    this.fxFade = c.createGain(); this.fxFade.gain.value = 0; this.fxFade.gain.setTargetAtTime(1, t, 0.012);
    this.fxSend.connect(this.fx.input); this.fx.output.connect(this.fxFade); this.fxFade.connect(this.fxWet);
    this.fx.setTempo?.(this.beatSec);
    this._applyFx();
  }
  _applyFx() {
    const t = this.ctx.currentTime, on = this.fxOn && !!this.fx, ins = this.fx?.kind === 'insert', L = this.fxLevel;
    // send: the dry voice stays, the wet adds; insert: dry -> wet cross-fade by the level knob
    // (a switched-off echo / reverb keeps its wet level so the tail rings out; only its input closes)
    this.fxSend.gain.setTargetAtTime(ins || on ? 1 : 0, t, 0.006);
    this.fxWet.gain.setTargetAtTime(ins ? (on ? L : 0) : L * 1.2, t, 0.015);
    this.dry.gain.setTargetAtTime(on && ins ? 1 - L : 1, t, 0.015);
  }
  level01() { this.meter.getFloatTimeDomainData(this._buf); let p = 0; for (const v of this._buf) p = Math.max(p, Math.abs(v)); return p; }

  // ---------- feedback reducer (P2): narrow sustained peaks get a Q 30 notch, up to 4 ----------
  setFeedbackReducer(on) {
    this.fbOn = !!on;
    if (on && !this.notches) {
      const c = this.ctx;
      this.notches = Array.from({ length: FB_NOTCHES }, () => { const n = c.createBiquadFilter(); n.type = 'peaking'; n.frequency.value = 1000; n.Q.value = 30; n.gain.value = 0; return n; });
      this.fbAn = c.createAnalyser(); this.fbAn.fftSize = 4096; this.fbAn.smoothingTimeConstant = 0.6; this.fbBins = new Float32Array(this.fbAn.frequencyBinCount);
      this.comp.connect(this.fbAn);
      // insert the notches between notchIn and notchOut (all at 0 dB = exact pass-through until one is placed)
      this.notchIn.disconnect(); let prev = this.notchIn;
      for (const n of this.notches) { prev.connect(n); prev = n; }
      prev.connect(this.notchOut);
      this.fbState = { cand: new Map(), placed: [] };
    }
    if (!on && this.notches) { for (const n of this.notches) n.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05); if (this.fbState) this.fbState.placed = []; }
    if (on && typeof setInterval === 'function' && !this._fbTimer && !(typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext)) this._fbTimer = setInterval(() => this.feedbackStep(0.05), 50);
    if (!on && this._fbTimer) { clearInterval(this._fbTimer); this._fbTimer = null; }
  }
  /** One analysis step (50 ms apart in the app; tests call it directly): find howls, place notches. */
  feedbackStep(dt = 0.05) {
    if (!this.fbOn || !this.fbAn) return;
    const b = this.fbBins, an = this.fbAn; an.getFloatFrequencyData(b);
    const st = this.fbState, binHz = this.ctx.sampleRate / an.fftSize, seen = new Set();
    for (let i = 8; i < b.length - 8; i++) {
      if (b[i] < -60 || b[i] < b[i - 1] || b[i] < b[i + 1]) continue;
      const nb = []; for (let k = 4; k <= 8; k++) nb.push(b[i - k], b[i + k]);
      nb.sort((x, y) => x - y);
      if (b[i] - nb[nb.length >> 1] < 12) continue; // must stand > 12 dB above its neighbourhood
      const f = i * binHz, key = Math.round(f / (binHz * 2));
      seen.add(key);
      const c = st.cand.get(key) || { f, t: 0 }; c.t += dt; c.f = f; st.cand.set(key, c);
      if (c.t >= 0.3 && !st.placed.some((p) => Math.abs(p - f) < binHz * 3) && st.placed.length < FB_NOTCHES) {
        const n = this.notches[st.placed.length]; st.placed.push(f);
        n.frequency.setValueAtTime(f, this.ctx.currentTime); n.gain.setTargetAtTime(-24, this.ctx.currentTime, 0.02);
      }
    }
    for (const k of [...st.cand.keys()]) if (!seen.has(k)) st.cand.delete(k);
  }
  get notchFreqs() { return this.fbState ? [...this.fbState.placed] : []; }
  dispose() { if (this._fbTimer) clearInterval(this._fbTimer); }
}
