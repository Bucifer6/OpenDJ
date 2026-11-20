// Beat-synced effects built from native Web Audio nodes.
// Each effect: { input, output, kind: 'send'|'insert', setParam(0..1), setBeatTime(seconds), dispose() }
// 'send' effects keep their tails ringing after being switched off (echo/reverb), 'insert' effects replace the dry signal.

const smooth = (param, v, ctx, tc = 0.02) => param.setTargetAtTime(v, ctx.currentTime, tc);

function makeImpulse(ctx, seconds = 2.8, decay = 3) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function lfo(ctx, type = 'sine') {
  const osc = ctx.createOscillator(); osc.type = type;
  const depth = ctx.createGain();
  osc.connect(depth); osc.start();
  return { osc, depth };
}

const FX = {
  echo: {
    label: 'Echo', kind: 'send',
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const delay = ctx.createDelay(4), fb = ctx.createGain(), tone = ctx.createBiquadFilter();
      tone.type = 'lowpass'; tone.frequency.value = 6000;
      input.connect(delay); delay.connect(tone); tone.connect(fb); fb.connect(delay); tone.connect(output);
      return {
        input, output,
        setParam: (p) => smooth(fb.gain, 0.2 + p * 0.7, ctx),
        setBeatTime: (s) => smooth(delay.delayTime, Math.min(3.9, s), ctx, 0.05),
        dispose: () => { input.disconnect(); delay.disconnect(); fb.disconnect(); tone.disconnect(); },
      };
    },
  },
  pingpong: {
    label: 'Ping Pong', kind: 'send',
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const mono = ctx.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit';
      const dl = ctx.createDelay(4), dr = ctx.createDelay(4), fb = ctx.createGain();
      const merge = ctx.createChannelMerger(2);
      input.connect(mono); mono.connect(dl); dl.connect(dr); dr.connect(fb); fb.connect(dl);
      dl.connect(merge, 0, 0); dr.connect(merge, 0, 1); merge.connect(output);
      return {
        input, output,
        setParam: (p) => smooth(fb.gain, 0.2 + p * 0.7, ctx),
        setBeatTime: (s) => { smooth(dl.delayTime, Math.min(3.9, s), ctx, 0.05); smooth(dr.delayTime, Math.min(3.9, s), ctx, 0.05); },
        dispose: () => { input.disconnect(); mono.disconnect(); dl.disconnect(); dr.disconnect(); fb.disconnect(); merge.disconnect(); },
      };
    },
  },
  reverb: {
    label: 'Reverb', kind: 'send',
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const conv = ctx.createConvolver(); conv.buffer = makeImpulse(ctx);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 200;
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
      input.connect(hp); hp.connect(conv); conv.connect(tone); tone.connect(output);
      return {
        input, output,
        setParam: (p) => { smooth(tone.frequency, 1500 + p * 12000, ctx); smooth(output.gain, 0.6 + p * 0.8, ctx); },
        setBeatTime: () => {},
        dispose: () => { input.disconnect(); hp.disconnect(); conv.disconnect(); tone.disconnect(); },
      };
    },
  },
  flanger: {
    label: 'Flanger', kind: 'insert',
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const delay = ctx.createDelay(0.05), fb = ctx.createGain();
      delay.delayTime.value = 0.004;
      const { osc, depth } = lfo(ctx); depth.gain.value = 0.0025; depth.connect(delay.delayTime);
      input.connect(output); input.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(output);
      return {
        input, output,
        setParam: (p) => smooth(fb.gain, p * 0.85, ctx),
        setBeatTime: (s) => smooth(osc.frequency, 1 / Math.max(0.05, s * 4), ctx, 0.1),
        dispose: () => { osc.stop(); input.disconnect(); delay.disconnect(); fb.disconnect(); },
      };
    },
  },
  phaser: {
    label: 'Phaser', kind: 'insert',
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const stages = Array.from({ length: 6 }, () => { const f = ctx.createBiquadFilter(); f.type = 'allpass'; f.frequency.value = 800; f.Q.value = 0.6; return f; });
      const { osc, depth } = lfo(ctx); depth.gain.value = 600;
      stages.reduce((a, b) => { a.connect(b); return b; });
      for (const s of stages) depth.connect(s.frequency);
      const wet = ctx.createGain(); wet.gain.value = 0.7;
      input.connect(output); input.connect(stages[0]); stages.at(-1).connect(wet); wet.connect(output);
      return {
        input, output,
        setParam: (p) => { smooth(depth.gain, 200 + p * 1200, ctx); for (const s of stages) smooth(s.frequency, 400 + p * 1200, ctx); },
        setBeatTime: (s) => smooth(osc.frequency, 1 / Math.max(0.05, s * 2), ctx, 0.1),
        dispose: () => { osc.stop(); input.disconnect(); for (const s of stages) s.disconnect(); wet.disconnect(); },
      };
    },
  },
  autofilter: {
    label: 'Auto Filter', kind: 'insert',
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1000; f.Q.value = 4;
      const { osc, depth } = lfo(ctx, 'triangle'); depth.gain.value = 900; depth.connect(f.frequency);
      const g = ctx.createGain(); g.gain.value = 2;
      input.connect(f); f.connect(g); g.connect(output);
      return {
        input, output,
        setParam: (p) => { smooth(f.Q, 1 + p * 12, ctx); smooth(f.frequency, 400 + p * 2500, ctx); },
        setBeatTime: (s) => smooth(osc.frequency, 1 / Math.max(0.05, s), ctx, 0.1),
        dispose: () => { osc.stop(); input.disconnect(); f.disconnect(); g.disconnect(); },
      };
    },
  },
  trans: {
    label: 'Trans', kind: 'insert',
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), vca = ctx.createGain();
      vca.gain.value = 0;
      const osc = ctx.createOscillator(); osc.type = 'square';
      const shape = ctx.createWaveShaper(); shape.curve = new Float32Array([0, 0, 1]); // square -1..1 -> 0..1
      const amt = ctx.createGain(); amt.gain.value = 1;
      osc.connect(shape); shape.connect(amt); amt.connect(vca.gain); osc.start();
      const floor = ctx.createConstantSource(); floor.offset.value = 0; floor.connect(vca.gain); floor.start();
      input.connect(vca); vca.connect(output);
      return {
        input, output,
        setParam: (p) => { smooth(amt.gain, 0.3 + p * 0.7, ctx); smooth(floor.offset, 0.7 - p * 0.7, ctx); },
        setBeatTime: (s) => smooth(osc.frequency, 1 / Math.max(0.03, s), ctx, 0.01),
        dispose: () => { osc.stop(); floor.stop(); input.disconnect(); vca.disconnect(); },
      };
    },
  },
  bitcrush: {
    label: 'Bit Crusher', kind: 'insert',
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), shaper = ctx.createWaveShaper();
      const curveFor = (bits) => { const n = 4096, c = new Float32Array(n), steps = Math.pow(2, bits); for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.round(x * steps) / steps; } return c; };
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000;
      input.connect(shaper); shaper.connect(lp); lp.connect(output);
      return {
        input, output,
        setParam: (p) => { shaper.curve = curveFor(Math.round(12 - p * 10)); smooth(lp.frequency, 12000 - p * 9000, ctx); },
        setBeatTime: () => {},
        dispose: () => { input.disconnect(); shaper.disconnect(); lp.disconnect(); },
      };
    },
  },
  distortion: {
    label: 'Distortion', kind: 'insert',
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), shaper = ctx.createWaveShaper(); shaper.oversample = '2x';
      const comp = ctx.createGain();
      input.connect(shaper); shaper.connect(comp); comp.connect(output);
      return {
        input, output,
        setParam: (p) => {
          const k = 1 + p * 60, n = 2048, c = new Float32Array(n);
          for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
          shaper.curve = c; smooth(comp.gain, 1 / (1 + p * 1.5), ctx);
        },
        setBeatTime: () => {},
        dispose: () => { input.disconnect(); shaper.disconnect(); comp.disconnect(); },
      };
    },
  },
  noise: {
    label: 'Noise Sweep', kind: 'send',
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 6;
      const g = ctx.createGain(); g.gain.value = 0;
      // the send gain (input) gates the noise level so tails decay when switched off
      const env = ctx.createGain(); env.gain.value = 0;
      src.connect(hp); hp.connect(g); g.connect(output); src.start();
      const follower = ctx.createConstantSource(); follower.offset.value = 0.15; follower.connect(g.gain); follower.start();
      const gate = ctx.createGain(); input.connect(env);
      return {
        input, output, gateTarget: follower.offset,
        setParam: (p) => smooth(hp.frequency, 200 + p * p * 12000, ctx, 0.05),
        setBeatTime: () => {},
        setActive: (on) => smooth(follower.offset, on ? 0.15 : 0, ctx, 0.3),
        dispose: () => { src.stop(); follower.stop(); input.disconnect(); hp.disconnect(); g.disconnect(); env.disconnect(); gate.disconnect(); },
      };
    },
  },
};

/** Create a standalone effect instance (used by Color FX). */
export function createEffect(ctx, id) { const f = FX[id]; if (!f) return null; const e = f.create(ctx); e.kind = f.kind; return e; }

export const EFFECTS = Object.entries(FX).map(([id, e]) => ({ id, label: e.label }));
// Deck-level performance effects handled by the deck itself (not audio nodes)
export const DECK_FX = [{ id: 'roll', label: 'Loop Roll' }, { id: 'brake', label: 'Vinyl Brake' }, { id: 'backspin', label: 'Backspin' }, { id: 'censor', label: 'Reverse (Censor)' }];
export const BEAT_DIVISIONS = [1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8];

/** One FX unit per channel: input -> dry -> output; input -> send -> effect -> wet -> output */
export class FxUnit {
  constructor(ctx) {
    this.ctx = ctx;
    this.input = ctx.createGain(); this.output = ctx.createGain();
    this.dry = ctx.createGain(); this.send = ctx.createGain(); this.wet = ctx.createGain();
    this.send.gain.value = 0; this.wet.gain.value = 0;
    this.input.connect(this.dry); this.dry.connect(this.output);
    this.input.connect(this.send); this.wet.connect(this.output);
    this.type = 'echo'; this.on = false; this.mix = 0.5; this.param = 0.5; this.beats = 1 / 2; this.beatSec = 0.5;
    this.fx = null;
    this.setType('echo');
  }
  setType(type) {
    if (!FX[type]) return;
    const old = this.fx;
    if (old) { this.send.disconnect(); old.output.disconnect(); setTimeout(() => old.dispose(), 50); }
    this.type = type; this.fx = FX[type].create(this.ctx); this.fx.kind = FX[type].kind;
    this.send.connect(this.fx.input); this.fx.output.connect(this.wet);
    this.fx.setParam(this.param); this.fx.setBeatTime(this.beatSec * this.beats);
    this.apply();
  }
  setOn(on) { this.on = on; this.apply(); }
  setMix(m) { this.mix = m; this.apply(); }
  setParam(p) { this.param = p; this.fx?.setParam(p); }
  setBeats(b) { this.beats = b; this.fx?.setBeatTime(this.beatSec * b); }
  setBeatSec(s) { if (Math.abs(s - this.beatSec) > 1e-4) { this.beatSec = s; this.fx?.setBeatTime(s * this.beats); } }
  apply() {
    const c = this.ctx; const send = this.fx.kind === 'send';
    this.fx.setActive?.(this.on);
    smooth(this.send.gain, this.on ? 1 : 0, c, 0.01);
    if (send) { smooth(this.dry.gain, 1, c); smooth(this.wet.gain, this.mix * 1.2, c); }
    else { smooth(this.dry.gain, this.on ? 1 - this.mix : 1, c); smooth(this.wet.gain, this.on ? this.mix : 0, c); }
  }
}
