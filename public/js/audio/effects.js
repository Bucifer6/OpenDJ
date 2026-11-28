// Beat FX and Color FX, built from native Web Audio nodes plus a few AudioWorklets (fx-worklets.js).
//
// Effect instance: { input, output, kind, setParam(p), setParam2(p), setTempo(beatSec, beats), setClock(beat, at, beatSec),
//                    setActive(on), dispose() }   (all but input/output/dispose optional)
//   kind 'send'      echo / reverb: the FX unit gates the *input*, so tails keep ringing after switching off
//   kind 'insert'    replaces the dry signal (the FX unit cross-fades dry and wet, levels matched)
//   kind 'generator' makes its own sound (noise); setActive() fades it in and out
// Every parameter change goes through setTargetAtTime (no zipper noise), every on/off and type change is a short
// cross-fade (no clicks). Beat-synced LFOs are phase-locked to the deck's beat grid (setClock).

const smooth = (param, v, ctx, tc = 0.02) => param.setTargetAtTime(v, ctx.currentTime, tc);
const lerpExp = (a, b, x) => a * Math.pow(b / a, x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const dbQ = (q) => 20 * Math.log10(q); // lowpass/highpass BiquadFilter Q is in dB (Web Audio spec)
const BUTTER_Q = dbQ(Math.SQRT1_2);

const loaded = new WeakMap();
/** Load the effect worklets into a context (once). Effects fall back to pass-through if this was never done. */
export function loadEffectWorklets(ctx) {
  if (!loaded.has(ctx)) loaded.set(ctx, ctx.audioWorklet.addModule(new URL('./fx-worklets.js', import.meta.url)).then(() => { ctx.__opendjFx = true; }));
  return loaded.get(ctx);
}
function worklet(ctx, name, opts, params = {}) {
  if (ctx.__opendjFx) {
    try {
      const n = new AudioWorkletNode(ctx, name, opts);
      for (const [k, v] of Object.entries(params)) n.parameters.get(k).value = v;
      return n;
    } catch (e) { console.warn(`effect worklet ${name} unavailable`, e); }
  }
  // pass-through stand-in with dummy parameters, so the graph still works
  const g = ctx.createGain();
  const fake = new Map(); for (const k of Object.keys(params)) fake.set(k, ctx.createGain().gain);
  g.parameters = { get: (k) => fake.get(k) || (fake.set(k, ctx.createGain().gain), fake.get(k)) };
  g.port = { postMessage() {} };
  return g;
}
function biquad(ctx, type, freq, q, gain) {
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
  if (q != null) f.Q.value = q; if (gain != null) f.gain.value = gain;
  return f;
}
/** Beat-locked LFO (fx-worklets.js opendj-lfo): two outputs 0..1 (left, right = phase + spread). */
function beatLfo(ctx, params) {
  const node = worklet(ctx, 'opendj-lfo', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] }, params);
  const split = ctx.createChannelSplitter(2); node.connect(split);
  return {
    node, split,
    p: (k) => node.parameters.get(k),
    clock(beat, at, beatSec) { node.port.postMessage({ beat, at, beatSec }); },
    connect(param, side = 0, scale = 1) { const g = ctx.createGain(); g.gain.value = scale; split.connect(g, side); g.connect(param); return g; },
    dispose() { try { node.disconnect(); split.disconnect(); } catch { /* */ } },
  };
}
let noiseBuf = null;
/** 4 s of stereo pink-ish noise (decorrelated channels), shared by all noise effects. */
function noiseBuffer(ctx) {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const len = ctx.sampleRate * 4, buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c); let b0 = 0, b1 = 0, b2 = 0, s = 12345 + c * 777, acc = 0;
    for (let i = 0; i < len; i++) {
      s = (s * 1664525 + 1013904223) >>> 0; const w = s / 2147483648 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = b0 + b1 + b2 + w * 0.1848; acc += d[i] * d[i];
    }
    const g = 0.25 / Math.sqrt(acc / len); for (let i = 0; i < len; i++) d[i] *= g; // -12 dBFS RMS
  }
  return (noiseBuf = buf);
}
function noiseSource(ctx) { const s = ctx.createBufferSource(); s.buffer = noiseBuffer(ctx); s.loop = true; s.loopStart = Math.random() * 3; s.start(0, Math.random() * 3); return s; }
/** Gentle soft clip with unity slope at 0 (keeps echo feedback bounded, colours loud repeats like tape). */
function softClip(ctx, a = 0.9) { const s = ctx.createWaveShaper(), n = 1025, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = a * Math.tanh(x / a); } s.curve = c; return s; }
const disconnectAll = (...nodes) => { for (const n of nodes) { try { n.disconnect(); } catch { /* */ } } };

/**
 * Delay with filtered, saturating feedback. In Chrome a DelayNode inside a cycle adds one render quantum (128
 * frames), so the loop delay is shortened by that much: echoes land exactly on the beat division.
 *   in -> first(D) -> sum -> HP -> LP -> softclip = taps -> loop(D·k - 128f) -> fb -> sum
 */
function feedbackDelay(ctx, { loopFactor = 1, insert = null, extraLatency = 0 } = {}) {
  const q = 128 / ctx.sampleRate + extraLatency;
  const first = ctx.createDelay(4.1), sum = ctx.createGain(), loop = ctx.createDelay(8.2), fb = ctx.createGain();
  const hp = biquad(ctx, 'highpass', 150, BUTTER_Q), lp = biquad(ctx, 'lowpass', 5000, BUTTER_Q), sat = softClip(ctx);
  first.connect(sum); sum.connect(hp); hp.connect(lp); lp.connect(sat);
  if (insert) { sat.connect(insert); insert.connect(loop); } else sat.connect(loop);
  loop.connect(fb); fb.connect(sum);
  let d = 0;
  return {
    input: first, taps: sat, fb, hp, lp,
    setTime(sec, glide = true) {
      sec = Math.min(4, Math.max(128 / ctx.sampleRate * 1.5, sec));
      if (Math.abs(sec - d) < 1e-6) return;
      const t = ctx.currentTime, loopT = Math.max(q * 0.5, sec * loopFactor - q);
      if (!glide || !d) { first.delayTime.cancelScheduledValues(t); loop.delayTime.cancelScheduledValues(t); first.delayTime.setValueAtTime(sec, t); loop.delayTime.setValueAtTime(loopT, t); }
      else { first.delayTime.setTargetAtTime(sec, t, 0.04); loop.delayTime.setTargetAtTime(loopT, t, 0.04); } // tape-style glide on changes
      d = sec;
    },
    setTone(x) { // 0 dark dub .. 0.5 warm .. 1 bright
      smooth(lp.frequency, lerpExp(1500, 16000, x), ctx, 0.03);
      smooth(hp.frequency, lerpExp(420, 35, x), ctx, 0.03);
    },
    nodes: [first, sum, loop, fb, hp, lp, sat],
  };
}

const FX = {
  echo: {
    label: 'Echo', kind: 'send', params: ['Feedback', 'Tone'],
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const d = feedbackDelay(ctx);
      input.connect(d.input); d.taps.connect(output);
      return {
        input, output,
        setParam: (p) => smooth(d.fb.gain, 0.12 + 0.83 * p, ctx), // repeats: a few .. near-infinite dub
        setParam2: (p) => d.setTone(p),
        setTempo: (beatSec, beats) => d.setTime(beatSec * beats),
        dispose: () => disconnectAll(input, output, ...d.nodes),
      };
    },
  },
  pingpong: {
    label: 'Ping Pong', kind: 'send', params: ['Feedback', 'Tone'],
    create(ctx) {
      // left echoes at D, 3D, 5D…, right at 2D, 4D…: one feedback loop of 2D, right tap delayed by D
      const input = ctx.createGain(), output = ctx.createGain();
      const mono = ctx.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit';
      const d = feedbackDelay(ctx, { loopFactor: 2 });
      const right = ctx.createDelay(4.1), merge = ctx.createChannelMerger(2);
      input.connect(mono); mono.connect(d.input);
      d.taps.connect(merge, 0, 0); d.taps.connect(right); right.connect(merge, 0, 1); merge.connect(output);
      output.gain.value = 1.2; // each side carries half the echoes
      let cur = 0;
      return {
        input, output,
        setParam: (p) => smooth(d.fb.gain, (0.12 + 0.83 * p) ** 2, ctx), // one loop = two echoes: same decay as Echo
        setParam2: (p) => d.setTone(p),
        setTempo: (beatSec, beats) => {
          const sec = Math.min(4, beatSec * beats); d.setTime(sec);
          if (!cur) right.delayTime.value = sec; else smooth(right.delayTime, sec, ctx, 0.04);
          cur = sec;
        },
        dispose: () => disconnectAll(input, output, mono, right, merge, ...d.nodes),
      };
    },
  },
  reverb: {
    label: 'Reverb', kind: 'send', params: ['Decay', 'Tone'],
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const hp = biquad(ctx, 'highpass', 160, BUTTER_Q);
      const rv = worklet(ctx, 'opendj-reverb', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }, { decay: 2.5, damping: 6000, predelay: 0.02, early: 0.5 });
      input.connect(hp); hp.connect(rv); rv.connect(output);
      output.gain.value = 1.4;
      const P = (k) => rv.parameters.get(k);
      return {
        input, output,
        setParam: (p) => { smooth(P('decay'), lerpExp(0.6, 9, p), ctx, 0.05); smooth(P('predelay'), 0.008 + 0.03 * p, ctx, 0.05); },
        setParam2: (p) => smooth(P('damping'), lerpExp(1500, 15000, p), ctx, 0.05),
        dispose: () => disconnectAll(input, output, hp, rv),
      };
    },
  },
  flanger: {
    label: 'Flanger', kind: 'insert', params: ['Feedback', 'Depth'], cycle: 8,
    create(ctx) { return modDelay(ctx, { base: 0.0006, depth: 0.004, fb: 0.6, dry: 0.7, wet: 0.7, spread: 0.25, shape: 1, cycle: 8, p1: (p) => ({ fb: -0.2 + 1.1 * p }), p2: (p) => ({ depth: 0.0008 + 0.0072 * p }) }); },
  },
  phaser: {
    label: 'Phaser', kind: 'insert', params: ['Depth', 'Resonance'], cycle: 4,
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
      const lfo = beatLfo(ctx, { beats: 2, shape: 0, spread: 0.25 });
      const chains = [0, 1].map((side) => {
        const st = [180, 260, 380, 560].map((f) => biquad(ctx, 'allpass', f, 0.7));
        const depth = ctx.createGain(); depth.gain.value = 3000; lfo.split.connect(depth, side);
        for (const s of st) depth.connect(s.detune);
        st.reduce((a, b) => { a.connect(b); return b; });
        const dry = ctx.createGain(), wet = ctx.createGain(); dry.gain.value = 0.6; wet.gain.value = 0.6;
        split.connect(st[0], side); split.connect(dry, side); st[3].connect(wet);
        dry.connect(merge, 0, side); wet.connect(merge, 0, side);
        return { st, depth };
      });
      input.connect(split); merge.connect(output);
      return {
        input, output,
        setParam: (p) => { for (const c of chains) smooth(c.depth.gain, 1200 + p * 4200, ctx, 0.05); },
        setParam2: (p) => { for (const c of chains) for (const s of c.st) smooth(s.Q, 0.35 + p * 2.2, ctx, 0.05); },
        setTempo: (beatSec, beats) => smooth(lfo.p('beats'), beats * 4, ctx, 0.01),
        setClock: (b, at, s) => lfo.clock(b, at, s),
        dispose: () => { lfo.dispose(); disconnectAll(input, output, split, merge, ...chains.flatMap((c) => [...c.st, c.depth])); },
      };
    },
  },
  chorus: {
    label: 'Chorus', kind: 'insert', params: ['Depth', 'Width'], cycle: 4,
    create(ctx) { return modDelay(ctx, { base: 0.012, depth: 0.004, fb: 0, dry: 0.75, wet: 0.65, spread: 0.25, shape: 0, cycle: 4, p1: (p) => ({ depth: 0.001 + 0.007 * p }), p2: (p) => ({ spread: p * 0.5 }) }); },
  },
  autofilter: {
    label: 'Auto Filter', kind: 'insert', params: ['Resonance', 'Depth'], cycle: 2,
    create(ctx) { return autoFilter(ctx, 2); },
  },
  tripletFilter: {
    label: 'Triplet Filter', kind: 'insert', params: ['Resonance', 'Depth'], cycle: 2 / 3,
    create(ctx) { return autoFilter(ctx, 2 / 3); },
  },
  trans: {
    label: 'Trans', kind: 'insert', params: ['Depth', 'Gate'], cycle: 1,
    create(ctx) {
      // gate locked to the beat grid, 2.5 ms raised-cosine edges: chops without clicks
      const input = ctx.createGain(), output = ctx.createGain(), vca = ctx.createGain();
      vca.gain.value = 0;
      const lfo = beatLfo(ctx, { beats: 0.5, shape: 2, duty: 0.5 });
      const amt = lfo.connect(vca.gain, 0, 1);
      const floor = ctx.createConstantSource(); floor.offset.value = 0; floor.connect(vca.gain); floor.start();
      input.connect(vca); vca.connect(output);
      return {
        input, output,
        setParam: (p) => { smooth(amt.gain, 0.3 + 0.7 * p, ctx); smooth(floor.offset, 0.7 - 0.7 * p, ctx); },
        setParam2: (p) => smooth(lfo.p('duty'), 0.2 + 0.6 * p, ctx, 0.01),
        setTempo: (beatSec, beats) => smooth(lfo.p('beats'), beats, ctx, 0.005),
        setClock: (b, at, s) => lfo.clock(b, at, s),
        dispose: () => { lfo.dispose(); floor.stop(); disconnectAll(input, output, vca, amt, floor); },
      };
    },
  },
  bitcrush: {
    label: 'Bit Crusher', kind: 'insert', params: ['Bits', 'Rate'],
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const cr = worklet(ctx, 'opendj-crush', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }, { bits: 8, rate: 6000 });
      const lp = biquad(ctx, 'lowpass', 14000, BUTTER_Q);
      input.connect(cr); cr.connect(lp); lp.connect(output);
      return {
        input, output,
        setParam: (p) => smooth(cr.parameters.get('bits'), 12 - 9 * Math.pow(p, 0.8), ctx, 0.03),
        setParam2: (p) => smooth(cr.parameters.get('rate'), lerpExp(22050, 1100, p), ctx, 0.03),
        dispose: () => disconnectAll(input, output, cr, lp),
      };
    },
  },
  distortion: {
    label: 'Distortion', kind: 'insert', params: ['Drive', 'Tone'],
    create(ctx) {
      // fixed tanh curve, drive as a smooth pre-gain (no curve swapping = no zipper), level-compensated output
      const input = ctx.createGain(), output = ctx.createGain(), pre = ctx.createGain(), post = ctx.createGain();
      const shaper = ctx.createWaveShaper(); shaper.oversample = '4x';
      const n = 2049, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(3 * x) / Math.tanh(3); } shaper.curve = c;
      const hp = biquad(ctx, 'highpass', 30, BUTTER_Q), tone = biquad(ctx, 'lowpass', 7000, BUTTER_Q);
      input.connect(hp); hp.connect(pre); pre.connect(shaper); shaper.connect(tone); tone.connect(post); post.connect(output);
      return {
        input, output,
        setParam: (p) => { const g = lerpExp(0.5, 12, p); smooth(pre.gain, g, ctx, 0.03); smooth(post.gain, 1.45 / (0.75 + 1.1 * g), ctx, 0.03); },
        setParam2: (p) => smooth(tone.frequency, lerpExp(1800, 16000, p), ctx, 0.03),
        dispose: () => disconnectAll(input, output, pre, post, shaper, hp, tone),
      };
    },
  },
  noise: {
    label: 'Noise Sweep', kind: 'generator', params: ['Sweep', 'Resonance'],
    create(ctx) {
      const output = ctx.createGain(), input = ctx.createGain();
      const src = noiseSource(ctx);
      const hp = biquad(ctx, 'highpass', 400, 6), lp = biquad(ctx, 'lowpass', 16000, BUTTER_Q), level = ctx.createGain();
      level.gain.value = 0;
      src.connect(hp); hp.connect(lp); lp.connect(level); level.connect(output);
      return {
        input, output,
        setParam: (p) => smooth(hp.frequency, lerpExp(80, 12000, p), ctx, 0.04),
        setParam2: (p) => smooth(hp.Q, p * 14, ctx, 0.04),
        setActive: (on) => level.gain.setTargetAtTime(on ? 0.7 : 0, ctx.currentTime, on ? 0.04 : 0.18),
        dispose: () => { src.stop(); disconnectAll(input, output, src, hp, lp, level); },
      };
    },
  },
  spiral: {
    label: 'Spiral', kind: 'send', params: ['Feedback', 'Pitch'],
    create(ctx) {
      // an echo whose repeats climb in pitch: the pitch shifter sits in the feedback loop (its average latency, half
      // its window, is taken off the loop delay so the repeats stay near the beat division)
      const input = ctx.createGain(), output = ctx.createGain();
      const ps = worklet(ctx, 'opendj-pitch', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }, { ratio: 1.12 });
      const d = feedbackDelay(ctx, { insert: ps, extraLatency: 0.026 });
      input.connect(d.input); d.taps.connect(output);
      return {
        input, output,
        setParam: (p) => smooth(d.fb.gain, 0.3 + 0.6 * p, ctx),
        setParam2: (p) => smooth(ps.parameters.get('ratio'), Math.pow(2, (0.5 + 6.5 * p) / 12), ctx, 0.05),
        setTempo: (beatSec, beats) => d.setTime(beatSec * beats),
        dispose: () => disconnectAll(input, output, ps, ...d.nodes),
      };
    },
  },
  helix: {
    label: 'Helix', kind: 'send', params: ['Sustain', 'Tone'],
    create(ctx) {
      // captures one beat division into a loop and keeps repeating it (input closed after the capture); switching
      // off lets the loop decay
      const input = ctx.createGain(), output = ctx.createGain(), gate = ctx.createGain();
      const d = feedbackDelay(ctx); gate.gain.value = 0;
      input.connect(gate); gate.connect(d.input); d.taps.connect(output); output.gain.value = 0.75;
      let sec = 0.25, sustain = 0.96, on = false;
      const hold = () => smooth(d.fb.gain, on ? sustain : 0.45, ctx, on ? 0.02 : 0.15);
      return {
        input, output,
        setParam: (p) => { sustain = 0.85 + 0.13 * p; hold(); },
        setParam2: (p) => d.setTone(p),
        setTempo: (beatSec, beats) => { sec = Math.min(4, beatSec * beats); d.setTime(sec); },
        setActive: (a) => {
          on = !!a; const t = ctx.currentTime;
          gate.gain.cancelScheduledValues(t); gate.gain.setTargetAtTime(on ? 1 : 0, t, 0.004);
          if (on) gate.gain.setTargetAtTime(0, t + sec, 0.004); // capture one division, then freeze
          hold();
        },
        dispose: () => disconnectAll(input, output, gate, ...d.nodes),
      };
    },
  },
  lowCutEcho: {
    label: 'Low-Cut Echo', kind: 'send', params: ['Feedback', 'Low cut'],
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const d = feedbackDelay(ctx); d.setTone(0.7);
      input.connect(d.input); d.taps.connect(output);
      return {
        input, output,
        setParam: (p) => smooth(d.fb.gain, 0.2 + 0.7 * p, ctx),
        setParam2: (p) => smooth(d.hp.frequency, lerpExp(250, 2500, p), ctx, 0.03), // each repeat thinner
        setTempo: (beatSec, beats) => d.setTime(beatSec * beats),
        dispose: () => disconnectAll(input, output, ...d.nodes),
      };
    },
  },
  shimmer: {
    label: 'Shimmer', kind: 'send', params: ['Decay', 'Shimmer'],
    create(ctx) {
      // reverb fed by the dry send plus an octave-up copy: a bright, rising halo
      const input = ctx.createGain(), output = ctx.createGain(), oct = ctx.createGain();
      const hp = biquad(ctx, 'highpass', 250, BUTTER_Q);
      const ps = worklet(ctx, 'opendj-pitch', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }, { ratio: 2 });
      const rv = worklet(ctx, 'opendj-reverb', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }, { decay: 4, damping: 9000, predelay: 0.03, early: 0.3 });
      input.connect(hp); hp.connect(rv); hp.connect(ps); ps.connect(oct); oct.connect(rv); rv.connect(output);
      output.gain.value = 1.3; oct.gain.value = 0.6;
      const P = (k) => rv.parameters.get(k);
      return {
        input, output,
        setParam: (p) => smooth(P('decay'), lerpExp(1.5, 12, p), ctx, 0.05),
        setParam2: (p) => smooth(oct.gain, 1.2 * p, ctx, 0.05),
        dispose: () => disconnectAll(input, output, oct, hp, ps, rv),
      };
    },
  },
};

/** Auto filter: resonant low-pass swept by a beat-locked LFO, `mult` LFO cycles per beat division. */
function autoFilter(ctx, mult) {
  const input = ctx.createGain(), output = ctx.createGain();
  const f1 = biquad(ctx, 'lowpass', 220, 6), f2 = biquad(ctx, 'lowpass', 220, BUTTER_Q);
  const lfo = beatLfo(ctx, { beats: 1, shape: 0 });
  const depth = lfo.connect(f1.detune, 0, 6000), d2 = lfo.connect(f2.detune, 0, 6000);
  const makeup = ctx.createGain(); makeup.gain.value = 1.05;
  input.connect(f1); f1.connect(f2); f2.connect(makeup); makeup.connect(output);
  return {
    input, output,
    setParam: (p) => smooth(f1.Q, 1 + p * 13, ctx, 0.05),
    setParam2: (p) => { const c = 2400 + p * 4800; smooth(depth.gain, c, ctx, 0.05); smooth(d2.gain, c, ctx, 0.05); smooth(makeup.gain, 0.92 + (1 - p) * 0.26, ctx, 0.05); }, // was +3-5 dB over dry at full mix (QA p3)
    setTempo: (beatSec, beats) => smooth(lfo.p('beats'), beats * mult, ctx, 0.01),
    setClock: (b, at, s) => lfo.clock(b, at, s),
    dispose: () => { lfo.dispose(); disconnectAll(input, output, f1, f2, makeup, depth, d2); },
  };
}

/**
 * Modulated delay (flanger / chorus / jet) in the opendj-moddelay worklet: stereo, beat-locked LFO, sample-accurate
 * feedback (a native DelayNode cycle can't go below 128 frames, far too long for a flanger comb).
 */
function modDelay(ctx, o) {
  const input = ctx.createGain(), output = ctx.createGain();
  const md = worklet(ctx, 'opendj-moddelay', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] },
    { base: o.base, depth: o.depth, feedback: o.fb, dry: o.dry, wet: o.wet, spread: o.spread, shape: o.shape, beats: o.cycle / 2 });
  input.connect(md); md.connect(output);
  const P = (k) => md.parameters.get(k);
  const set = (obj) => { for (const [k, v] of Object.entries(obj)) smooth(P(k === 'fb' ? 'feedback' : k), v, ctx, 0.04); };
  return {
    input, output, md,
    setParam: (p) => set(o.p1(p)),
    setParam2: (p) => set(o.p2(p)),
    setManual: (obj) => set(obj),
    setTempo: (beatSec, beats) => smooth(P('beats'), beats * o.cycle, ctx, 0.01),
    setClock: (b, at, s) => md.port.postMessage({ beat: b, at, beatSec: s }),
    dispose: () => disconnectAll(input, output, md),
  };
}

// ---------------------------------------------------------------- Color FX (mixer channel, follow the filter knob)
// setColor(x, side): x = 0..1 amount (dead zone already removed), side = -1 (left / low-pass side) or +1.
// kind 'send': the channel gates its input by `sendAmount`, the tail keeps ringing back at the centre (Space, Dub Echo).
// kind 'insert': the channel cross-fades dry -> wet by `wetAmount` (Crush, Jet). kind 'generator': Noise.
const COLOR = {
  space: {
    kind: 'send', dryFilter: 0.35,
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const hp = biquad(ctx, 'highpass', 200, BUTTER_Q);
      const rv = worklet(ctx, 'opendj-reverb', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }, { decay: 3, damping: 7000, predelay: 0.025, early: 0.6 });
      const wLp = biquad(ctx, 'lowpass', 20000, BUTTER_Q), wHp = biquad(ctx, 'highpass', 20, BUTTER_Q);
      input.connect(hp); hp.connect(rv); rv.connect(wLp); wLp.connect(wHp); wHp.connect(output);
      output.gain.value = 1.15;
      const P = (k) => rv.parameters.get(k);
      return {
        input, output,
        sendAmount: (x) => Math.min(1, x * 1.6),
        setColor(x, side, p = 0.5) {
          smooth(P('decay'), (1.6 + 4.4 * x) * (0.4 + 1.2 * p), ctx, 0.06);
          smooth(wLp.frequency, side < 0 ? lerpExp(16000, 1100, x) : 20000, ctx, 0.03);
          smooth(wHp.frequency, side > 0 ? lerpExp(120, 3500, x) : 20, ctx, 0.03);
        },
        dispose: () => disconnectAll(input, output, hp, rv, wLp, wHp),
      };
    },
  },
  dubecho: {
    kind: 'send', dryFilter: 0.35,
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const d = feedbackDelay(ctx); d.setTone(0.3);
      const wLp = biquad(ctx, 'lowpass', 20000, BUTTER_Q), wHp = biquad(ctx, 'highpass', 20, BUTTER_Q);
      input.connect(d.input); d.taps.connect(wLp); wLp.connect(wHp); wHp.connect(output);
      return {
        input, output,
        sendAmount: (x) => Math.min(1, x * 1.8),
        setColor(x, side, p = 0.5) {
          smooth(d.fb.gain, Math.min(0.95, 0.45 + 0.4 * x + (p - 0.5) * 0.3), ctx, 0.05);
          smooth(wLp.frequency, side < 0 ? lerpExp(12000, 900, x) : 20000, ctx, 0.03);
          smooth(wHp.frequency, side > 0 ? lerpExp(150, 3000, x) : 20, ctx, 0.03);
        },
        setTempo: (beatSec) => d.setTime(beatSec * 0.75),
        dispose: () => disconnectAll(input, output, wLp, wHp, ...d.nodes),
      };
    },
  },
  noise: {
    kind: 'generator', dryFilter: 0.55,
    create(ctx) {
      // white-ish noise through a resonant filter that follows the knob: left = LPF closing, right = HPF opening
      const input = ctx.createGain(), output = ctx.createGain();
      const src = noiseSource(ctx);
      const lp = biquad(ctx, 'lowpass', 20000, 4), hp = biquad(ctx, 'highpass', 20, 4), level = ctx.createGain();
      level.gain.value = 0;
      src.connect(lp); lp.connect(hp); hp.connect(level); level.connect(output);
      return {
        input, output,
        setColor(x, side, p = 0.5) {
          smooth(level.gain, 0.55 * Math.pow(x, 1.3) * (0.3 + 1.4 * p), ctx, 0.03);
          smooth(lp.frequency, side < 0 ? lerpExp(18000, 250, x) : 20000, ctx, 0.03);
          smooth(hp.frequency, side > 0 ? lerpExp(40, 9000, x) : 20, ctx, 0.03);
        },
        dispose: () => { src.stop(); disconnectAll(input, output, src, lp, hp, level); },
      };
    },
  },
  crush: {
    kind: 'insert', dryFilter: 0.55,
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const cr = worklet(ctx, 'opendj-crush', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }, { bits: 12, rate: 20000 });
      const lp = biquad(ctx, 'lowpass', 15000, BUTTER_Q);
      input.connect(cr); cr.connect(lp); lp.connect(output);
      return {
        input, output,
        wetAmount: (x) => smoothstep(0, 0.25, x),
        setColor(x, side, p = 0.5) {
          smooth(cr.parameters.get('bits'), Math.max(1.5, 12 - 8.5 * Math.pow(x, 0.7) * (0.5 + p)), ctx, 0.03);
          smooth(cr.parameters.get('rate'), lerpExp(20000, 1800, x), ctx, 0.03);
        },
        dispose: () => disconnectAll(input, output, cr, lp),
      };
    },
  },
  pitch: { // "Jet": a flanger swept by hand with the knob, high feedback (left: negative, right: positive)
    kind: 'insert', dryFilter: 0,
    create(ctx) {
      const m = modDelay(ctx, { base: 0.006, depth: 0.0003, fb: 0, dry: 0.7, wet: 0.7, spread: 0.2, shape: 0, cycle: 16, p1: () => ({}), p2: () => ({}) });
      return {
        input: m.input, output: m.output,
        wetAmount: (x) => smoothstep(0, 0.12, x),
        setColor(x, side) { m.setManual({ base: lerpExp(0.008, 0.0007, x), feedback: side < 0 ? -0.55 - 0.3 * x : 0.55 + 0.3 * x }); },
        setTempo: (s) => m.setTempo(s, 1), setClock: m.setClock,
        dispose: m.dispose,
      };
    },
  },
  sweep: { // a band that narrows with the knob: left towards the bass, right towards the treble
    kind: 'insert', dryFilter: 0,
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const hp = [biquad(ctx, 'highpass', 20, BUTTER_Q), biquad(ctx, 'highpass', 20, BUTTER_Q)];
      const lp = [biquad(ctx, 'lowpass', 20000, BUTTER_Q), biquad(ctx, 'lowpass', 20000, BUTTER_Q)];
      const pk = biquad(ctx, 'peaking', 1000, 1.2, 0);
      input.connect(hp[0]); hp[0].connect(hp[1]); hp[1].connect(lp[0]); lp[0].connect(lp[1]); lp[1].connect(pk); pk.connect(output);
      return {
        input, output,
        wetAmount: (x) => smoothstep(0, 0.1, x),
        setColor(x, side, p = 0.5) {
          const lo = side < 0;
          const hpF = lo ? lerpExp(20, 70, x) : lerpExp(20, 3500, x), lpF = lo ? lerpExp(20000, 380, x) : lerpExp(20000, 11000, x);
          for (const f of hp) smooth(f.frequency, hpF, ctx, 0.03);
          for (const f of lp) smooth(f.frequency, lpF, ctx, 0.03);
          smooth(pk.frequency, lo ? lerpExp(1000, 160, x) : lerpExp(1000, 6000, x), ctx, 0.03);
          smooth(pk.gain, 7 * smoothstep(0, 0.6, x) * (0.3 + 1.4 * p), ctx, 0.03); // resonant edge (PARAMETER), level-matched below
          smooth(output.gain, lo ? 1 + 0.8 * x : 1 + 0.9 * x, ctx, 0.03);
        },
        dispose: () => disconnectAll(input, output, ...hp, ...lp, pk),
      };
    },
  },
  crunch: { // controlled harmonic distortion (tanh drive, 2x oversampled) before the channel filter
    kind: 'insert', dryFilter: 0.6,
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), pre = ctx.createGain(), post = ctx.createGain();
      const shaper = ctx.createWaveShaper(); shaper.oversample = '2x';
      const n = 2049, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(2.5 * x) / Math.tanh(2.5); } shaper.curve = c;
      const tone = biquad(ctx, 'lowpass', 12000, BUTTER_Q);
      input.connect(pre); pre.connect(shaper); shaper.connect(tone); tone.connect(post); post.connect(output);
      return {
        input, output,
        wetAmount: (x) => smoothstep(0, 0.15, x),
        setColor(x, side) {
          const g = lerpExp(0.6, 9, x); smooth(pre.gain, g, ctx, 0.03); smooth(post.gain, 1.25 / (0.55 + 1.05 * g), ctx, 0.03);
          smooth(tone.frequency, side < 0 ? lerpExp(12000, 3000, x) : 12000, ctx, 0.03);
        },
        dispose: () => disconnectAll(input, output, pre, post, shaper, tone),
      };
    },
  },
  pitchshift: { // real pitch shift: up to an octave down (left) / up (right)
    kind: 'insert', dryFilter: 0,
    create(ctx) {
      const input = ctx.createGain(), output = ctx.createGain();
      const ps = worklet(ctx, 'opendj-pitch', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }, { ratio: 1 });
      input.connect(ps); ps.connect(output);
      return {
        input, output,
        wetAmount: (x) => smoothstep(0, 0.08, x),
        setColor(x, side) { smooth(ps.parameters.get('ratio'), Math.pow(2, side * x), ctx, 0.02); },
        dispose: () => disconnectAll(input, output, ps),
      };
    },
  },
};

/** Color FX menu (id, label). `pitch` keeps its stored id but is labelled Jet. */
export const COLOR_FX = [['filter', 'Filter'], ['space', 'Space'], ['dubecho', 'Dub Echo'], ['noise', 'Noise'], ['crush', 'Crush'], ['pitch', 'Jet'], ['sweep', 'Sweep'], ['crunch', 'Crunch'], ['pitchshift', 'Pitch']];

// ---------------------------------------------------------------- mic FX (mixer M8)
// kind 'send': parallel to the dry voice (no added latency); kind 'insert': the mic cross-fades dry -> wet.
const MIC_FX = {
  echo: { label: 'Echo', kind: 'send', create(ctx) {
    const input = ctx.createGain(), output = ctx.createGain(), d = feedbackDelay(ctx); d.setTone(0.55);
    smooth(d.fb.gain, 0.42, ctx); input.connect(d.input); d.taps.connect(output);
    return { input, output, setTempo: (beatSec) => d.setTime(Math.min(1.2, beatSec * 0.75)), dispose: () => disconnectAll(input, output, ...d.nodes) };
  } },
  reverb: { label: 'Reverb', kind: 'send', create(ctx) {
    const input = ctx.createGain(), output = ctx.createGain(), hp = biquad(ctx, 'highpass', 200, BUTTER_Q);
    const rv = worklet(ctx, 'opendj-reverb', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }, { decay: 1.8, damping: 7000, predelay: 0.02, early: 0.5 });
    input.connect(hp); hp.connect(rv); rv.connect(output); output.gain.value = 1.2;
    return { input, output, dispose: () => disconnectAll(input, output, hp, rv) };
  } },
  megaphone: { label: 'Megaphone', kind: 'insert', create(ctx) {
    const input = ctx.createGain(), output = ctx.createGain(), pre = ctx.createGain();
    const hp = biquad(ctx, 'highpass', 500, 1), lp = biquad(ctx, 'lowpass', 3000, 1), sh = ctx.createWaveShaper();
    const n = 1025, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(4 * x) / Math.tanh(4); } sh.curve = c;
    pre.gain.value = 2.5; output.gain.value = 0.55;
    input.connect(hp); hp.connect(lp); lp.connect(pre); pre.connect(sh); sh.connect(output);
    return { input, output, dispose: () => disconnectAll(input, output, pre, hp, lp, sh) };
  } },
  pitch: { label: 'Pitch', kind: 'insert', create(ctx) {
    const input = ctx.createGain(), output = ctx.createGain();
    const ps = worklet(ctx, 'opendj-pitch', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }, { ratio: Math.pow(2, 5 / 12) });
    input.connect(ps); ps.connect(output);
    return { input, output, setParam: (p) => smooth(ps.parameters.get('ratio'), Math.pow(2, (p * 24 - 12) / 12), ctx, 0.03), dispose: () => disconnectAll(input, output, ps) };
  } },
};
export const MIC_FX_LIST = Object.entries(MIC_FX).map(([id, f]) => ({ id, label: f.label, kind: f.kind }));
export function createMicFx(ctx, id) { const f = MIC_FX[id]; if (!f) return null; const e = f.create(ctx); e.kind = f.kind; return e; }

// ---------------------------------------------------------------- send / return FX (mixer M10)
export const SEND_FX = [
  { id: 'shortDelay', label: 'Short Delay', fx: 'echo', beats: 1 / 4, param: 0.25, param2: 0.6 },
  { id: 'longDelay', label: 'Long Delay', fx: 'echo', beats: 1, param: 0.45, param2: 0.5 },
  { id: 'dubEcho', label: 'Dub Echo', fx: 'echo', beats: 3 / 4, param: 0.7, param2: 0.2 },
  { id: 'reverb', label: 'Reverb', fx: 'reverb', beats: 1, param: 0.55, param2: 0.55 },
];
/** A built-in send effect (wet only): { input, output, setTempo(beatSec), dispose }. */
export function createSendFx(ctx, id) {
  const def = SEND_FX.find((f) => f.id === id) || SEND_FX[3];
  const e = createEffect(ctx, def.fx);
  e.setParam?.(def.param); e.setParam2?.(def.param2);
  const setTempo = (beatSec) => e.setTempo?.(beatSec, def.beats);
  setTempo(0.5);
  return { ...e, id: def.id, setTempo };
}

/** Create a standalone Beat FX instance. */
export function createEffect(ctx, id) { const f = FX[id]; if (!f) return null; const e = f.create(ctx); e.kind = f.kind; return e; }
/** Create a Color FX instance for a mixer channel (null for plain 'filter'). */
export function createColorFx(ctx, id) { const f = COLOR[id]; if (!f) return null; const e = f.create(ctx); e.kind = f.kind; e.dryFilter = f.dryFilter; return e; }

export const EFFECTS = Object.entries(FX).map(([id, e]) => ({ id, label: e.label, kind: e.kind, params: e.params, cycle: e.cycle || 1 }));
/** Names of an effect's PARAM and PARAM 2 knobs. */
export const effectParams = (id) => FX[id]?.params || ['Param', 'Param 2'];
/** What a beat division means for an effect: delay time (echo) or LFO cycle (flanger: 8x, phaser 4x, ...), in beats. */
export const effectBeats = (id, division) => division * (FX[id]?.cycle || 1);
export const BEAT_DIVISIONS = [1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8];

const FADE = 0.012; // on/off and type-change cross-fade time constant (s)

/**
 * One FX unit per channel. Dry: input -> dry -> output. Effect: send -> effect -> fade -> wet, then
 *  - pre-fader (classic):   input  -> preTap  -> send ... wet -> preRet  -> output   (output goes through the faders)
 *  - post-fader tails:      postIn -> postTap -> send ... wet -> postRet -> wetOut   (wetOut is summed after the faders)
 * In post-fader mode the channel feeds `postIn` with the signal scaled by its channel fader and crossfader (a mirror
 * of their gains), and sums `wetOut` straight into the music bus: closing a fader stops new signal from entering the
 * echo / reverb but lets what is already in it ring out, while the dry signal is cut. Exactly one tap and one return
 * are open at a time (switching cross-fades them), so nothing is doubled; with the faders open both modes are identical.
 */
export class FxUnit {
  constructor(ctx, { postFader = false } = {}) {
    this.ctx = ctx;
    this.input = ctx.createGain(); this.output = ctx.createGain();
    this.postIn = ctx.createGain(); this.wetOut = ctx.createGain();
    this.dry = ctx.createGain(); this.send = ctx.createGain(); this.wet = ctx.createGain();
    this.preTap = ctx.createGain(); this.postTap = ctx.createGain(); this.preRet = ctx.createGain(); this.postRet = ctx.createGain();
    this.send.gain.value = 0; this.wet.gain.value = 0;
    this.input.connect(this.dry); this.dry.connect(this.output);
    this.input.connect(this.preTap); this.postIn.connect(this.postTap); this.preTap.connect(this.send); this.postTap.connect(this.send);
    this.wet.connect(this.preRet); this.wet.connect(this.postRet); this.preRet.connect(this.output); this.postRet.connect(this.wetOut);
    this.postFader = !!postFader;
    for (const [n, on] of [[this.preTap, !this.postFader], [this.preRet, !this.postFader], [this.postTap, this.postFader], [this.postRet, this.postFader]]) n.gain.value = on ? 1 : 0;
    this.type = 'echo'; this.on = false; this.mix = 0.5; this.param = 0.5; this.param2 = 0.5; this.beats = 1 / 2; this.beatSec = 0.5;
    this.clock = null; this.fx = null; this.fade = null;
    // Lazily instantiate the default 'echo' delay graph on first setOn(true) (saves ~19 MB of DelayNode buffers
    // and 8 biquads + 4 waveshapers across 4 channels while Beat FX are off). Keep a muted send->wet link so
    // upstream post-fader gain automation stays connected to the destination graph.
    this.send.connect(this.wet);
    this._lazyLink = true;
  }
  /** Post-fader FX tails on / off (off = the whole FX unit sits before the channel fader, as before). */
  setPostFader(on) {
    on = !!on; if (on === this.postFader) return;
    this.postFader = on;
    const c = this.ctx;
    smooth(this.preTap.gain, on ? 0 : 1, c, FADE); smooth(this.preRet.gain, on ? 0 : 1, c, FADE);
    smooth(this.postTap.gain, on ? 1 : 0, c, FADE); smooth(this.postRet.gain, on ? 1 : 0, c, FADE);
  }
  _clearLazyLink() {
    if (!this._lazyLink) return;
    this._lazyLink = false;
    try { this.send.disconnect(this.wet); } catch { /* */ }
  }
  _ensureFx() {
    if (this.fx) return this.fx;
    this._clearLazyLink();
    const c = this.ctx;
    this.fx = createEffect(c, this.type || 'echo');
    this.fade = c.createGain(); this.fade.gain.value = 1;
    this.send.connect(this.fx.input); this.fx.output.connect(this.fade); this.fade.connect(this.wet);
    this.fx.setParam?.(this.param); this.fx.setParam2?.(this.param2);
    this.fx.setTempo?.(this.beatSec, this.beats);
    if (this.clock) this.fx.setClock?.(...this.clock);
    return this.fx;
  }
  setType(type) {
    if (!FX[type] || (type === this.type && (this.fx || !this.on))) return;
    // Keep send effects (echo, reverb, ...) lazy until turned on if no effect has been built yet;
    // insert effects (flanger, chorus, ...) build immediately so their delay lines pre-fill cleanly.
    if (!this.on && !this.fx && FX[type].kind === 'send') { this.type = type; return; }
    this._clearLazyLink();
    const c = this.ctx, t = c.currentTime;
    if (this.fx) { // fade the old effect out, then free it
      const old = this.fx, oldFade = this.fade, send = this.send;
      oldFade.gain.cancelScheduledValues(t); oldFade.gain.setTargetAtTime(0, t, FADE);
      setTimeout(() => { try { send.disconnect(old.input); } catch { /* */ } disconnectAll(oldFade); old.dispose(); }, 150);
    }
    this.type = type; this.fx = createEffect(c, type);
    this.fade = c.createGain(); this.fade.gain.value = 0; this.fade.gain.setTargetAtTime(1, t, FADE);
    this.send.connect(this.fx.input); this.fx.output.connect(this.fade); this.fade.connect(this.wet);
    this.fx.setParam?.(this.param); this.fx.setParam2?.(this.param2);
    this.fx.setTempo?.(this.beatSec, this.beats);
    if (this.clock) this.fx.setClock?.(...this.clock);
    this.apply();
  }
  /** FX on / off, optionally at audio time `when` (quantised starts land exactly on the beat division). */
  setOn(on, when) { this.on = !!on; this.at = when || 0; if (this.on && !this.fx) this._ensureFx(); this.apply(); }
  setMix(m) { this.mix = m; this.apply(); }
  setParam(p) { this.param = p; this.fx?.setParam?.(p); }
  setParam2(p) { this.param2 = p; this.fx?.setParam2?.(p); }
  setBeats(b) { this.beats = b; this.fx?.setTempo?.(this.beatSec, b); }
  setBeatSec(s) { if (s > 0 && Math.abs(s - this.beatSec) > 1e-5) { this.beatSec = s; this.fx?.setTempo?.(s, this.beats); } }
  /** Beat grid of the deck: beat position `beat` at audio time `at` (null = free-running). */
  setClock(beat, at, beatSec) { this.clock = [beat, at, beatSec]; this.fx?.setClock?.(beat, at, beatSec); }
  apply() {
    if (!this.fx) { this.at = 0; return; }
    const c = this.ctx, kind = this.fx.kind, on = this.on, m = this.mix;
    const t0 = Math.max(c.currentTime, this.at || 0), sm = (param, v, tc) => param.setTargetAtTime(v, t0, tc);
    if (t0 > c.currentTime + 0.003) setTimeout(() => this.fx?.setActive?.(this.on), (t0 - c.currentTime) * 1000); else this.fx.setActive?.(on);
    if (kind === 'insert') {
      // Gate send to 0 when OFF so inactive insert FX (Crush, Distortion, Phaser, ModDelay, LFO) hit silent bypass
      sm(this.send.gain, on ? 1 : 0, 0.004);
      sm(this.dry.gain, on ? 1 - m : 1, FADE); sm(this.wet.gain, on ? m : 0, FADE);
    } else {
      // send / generator: dry stays (slight duck at high mix for even loudness), wet level is the mix knob, so a
      // switched-off echo or reverb keeps ringing out
      sm(this.send.gain, on && kind === 'send' ? 1 : 0, 0.004);
      sm(this.dry.gain, on ? 1 - 0.15 * m : 1, FADE * 2); sm(this.wet.gain, m, FADE);
    }
    this.at = 0;
  }
}
