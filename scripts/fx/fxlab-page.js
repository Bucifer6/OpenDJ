// FX lab, browser side: renders OpenDJ's real effect nodes (FX unit, mixer channel, master limiter, deck worklet)
// in an OfflineAudioContext. Injected into the running app by scripts/fx/fxlab.mjs; everything is driven by a
// JSON spec so the Node side can script parameter moves at exact times.
const effects = await import('/js/audio/effects.js');
const engine = await import('/js/audio/engine.js');

// ---------------------------------------------------------------- test signals (deterministic)
function rng(seed = 1) { let s = seed >>> 0; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296 * 2 - 1; }; }

/** Kick / snare / hats loop with a sustained chord on top, so tails and modulation are audible. */
function drums(sr, n, bpm = 120) {
  const L = new Float32Array(n), R = new Float32Array(n), r = rng(7), beat = 60 / bpm;
  const hpState = [0, 0];
  for (let i = 0; i < n; i++) {
    const t = i / sr, b = t / beat, tb = (b % 1) * beat, t8 = ((b * 2) % 1) * beat / 2, bar = Math.floor(b) % 4;
    const kick = Math.sin(2 * Math.PI * (45 * tb + (75 / 30) * (1 - Math.exp(-tb * 30)))) * Math.exp(-tb * 7) * 0.8;
    const noise = r();
    const snare = (bar === 1 || bar === 3) ? (noise * 0.45 + Math.sin(2 * Math.PI * 185 * tb) * 0.25) * Math.exp(-tb * 16) : 0;
    hpState[0] = 0.6 * (hpState[0] + noise - hpState[1]); hpState[1] = noise; // crude HP for hats
    const hat = hpState[0] * Math.exp(-t8 * 60) * 0.25;
    const pad = 0.06 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t));
    L[i] = kick + snare + hat * 0.9 + pad; R[i] = kick + snare * 0.9 + hat + pad;
  }
  return [L, R];
}
function sweep(sr, n, f0 = 20, f1 = 20000, amp = 0.5) {
  const x = new Float32Array(n), T = n / sr, k = Math.log(f1 / f0);
  for (let i = 0; i < n; i++) { const t = i / sr; x[i] = amp * Math.sin(2 * Math.PI * f0 * T / k * (Math.exp(t / T * k) - 1)); }
  return [x, x];
}
function pink(sr, n, rms = 0.125) {
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) {
    const r = rng(11 + c), x = out[c]; let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, acc = 0;
    for (let i = 0; i < n; i++) {
      const w = r();
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926; acc += x[i] * x[i];
    }
    const g = rms / Math.sqrt(acc / n); for (let i = 0; i < n; i++) x[i] *= g;
  }
  return out;
}
function sine(sr, n, f = 220, amp = 0.5) { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / sr); return [x, x]; }
function impulse(sr, n, at = 0.1, amp = 0.8) { const x = new Float32Array(n); x[Math.round(at * sr)] = amp; return [x, x]; }
/** A short 2 kHz tone burst (1 cycle Hann) at `at`: echoes of it are easy to locate. */
function burst(sr, n, at = 0.1, f = 2000, amp = 0.8) {
  const x = new Float32Array(n), len = Math.round(sr * 4 / f), s0 = Math.round(at * sr);
  for (let i = 0; i < len; i++) x[s0 + i] = amp * Math.sin(2 * Math.PI * f * i / sr) * Math.sin(Math.PI * i / len) ** 2;
  return [x, x];
}
let demoCache = null;
async function demo(ctx, n) {
  if (!demoCache) demoCache = await (await fetch('/__fxlab/demo.wav')).arrayBuffer();
  const buf = await ctx.decodeAudioData(demoCache.slice(0));
  const L = new Float32Array(n), R = new Float32Array(n);
  L.set(buf.getChannelData(0).subarray(0, n)); R.set(buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0).subarray(0, n));
  return [L, R];
}
async function signal(ctx, spec, n) {
  const sr = ctx.sampleRate, s = spec.signal || 'drums', o = spec.signalOpts || {};
  let ch;
  switch (s) {
    case 'drums': ch = drums(sr, n, o.bpm || 120); break;
    case 'sweep': ch = sweep(sr, n, o.f0, o.f1, o.amp); break;
    case 'pink': ch = pink(sr, n, o.rms); break;
    case 'sine': ch = sine(sr, n, o.f, o.amp); break;
    case 'impulse': ch = impulse(sr, n, o.at, o.amp); break;
    case 'burst': ch = burst(sr, n, o.at, o.f, o.amp); break;
    case 'demo': ch = await demo(ctx, n); break;
    case 'multitone': { // equal-level sines (EQ / filter frequency response)
      const x = new Float32Array(n), fs = o.freqs || [100, 1000, 10000], a = o.amp || 0.05;
      for (const f of fs) { const ph = f * 0.37; for (let i = 0; i < n; i++) x[i] += a * Math.sin(2 * Math.PI * f * i / sr + ph); }
      ch = [x, x]; break;
    }
    case 'silence': ch = [new Float32Array(n), new Float32Array(n)]; break;
    default: throw new Error(`unknown signal ${s}`);
  }
  if (o.gain) for (const c of ch) for (let i = 0; i < c.length; i++) c[i] *= o.gain;
  if (o.until) for (const c of ch) c.fill(0, Math.round(o.until * sr));
  return ch;
}

// ---------------------------------------------------------------- graph under test
function fakeEngine(ctx, settings = {}) {
  const musicBus = ctx.createGain(), cueBus = ctx.createGain();
  return { ctx, settings, musicBus, cueBus, decks: [], channels: [], emit() {}, applyCrossfader() {} };
}

async function build(ctx, spec, src) {
  switch (spec.chain) {
    case 'fx': { // one FX unit (what a channel's FX section is)
      const u = new effects.FxUnit(ctx);
      src.connect(u.input); u.output.connect(ctx.destination);
      return { target: u };
    }
    case 'effect': { // one bare effect instance (wet output only)
      const e = effects.createEffect(ctx, spec.effect);
      src.connect(e.input); e.output.connect(ctx.destination);
      return { target: e };
    }
    case 'color': // a whole mixer channel; EQ / filter / Color FX / FX unit
    case 'channel': {
      const fe = fakeEngine(ctx, spec.settings || {});
      const ch = new engine.Channel(fe, 0);
      src.connect(ch.trimNode); fe.musicBus.connect(ctx.destination);
      return { target: ch };
    }
    case 'eq2': { // two channels summed (blend test)
      const fe = fakeEngine(ctx, spec.settings || {});
      const a = new engine.Channel(fe, 0), b = new engine.Channel(fe, 1);
      src.connect(a.trimNode); src.connect(b.trimNode); fe.musicBus.connect(ctx.destination);
      return { target: { a, b } };
    }
    case 'mixer4': { // 4 channel strips (EQ, filter, Color FX, FX unit) -> master limiter: whole-mixer CPU cost
      const fe = fakeEngine(ctx, spec.settings || {});
      const chans = [0, 1, 2, 3].map((i) => new engine.Channel(fe, i));
      const lim = engine.createLimiter ? engine.createLimiter(ctx) : { input: ctx.createGain(), output: null };
      lim.output ||= lim.input;
      for (const ch of chans) src.connect(ch.trimNode);
      fe.musicBus.connect(lim.input); lim.output.connect(ctx.destination);
      return { target: chans };
    }
    case 'limiter': {
      const pre = ctx.createGain(); pre.gain.value = spec.preGain ?? 1;
      src.connect(pre);
      let lim;
      if (engine.createLimiter) lim = engine.createLimiter(ctx);
      else { // the original master limiter settings (engine.js before the FX work)
        const c = ctx.createDynamicsCompressor();
        c.threshold.value = -1.5; c.knee.value = 0; c.ratio.value = 20; c.attack.value = 0.002; c.release.value = 0.12;
        lim = { input: c, output: c };
      }
      pre.connect(lim.input); lim.output.connect(ctx.destination);
      return { target: lim };
    }
    case 'deck': { // the deck worklet playing the signal as a track
      await ctx.audioWorklet.addModule('/js/audio/worklets.js');
      const node = new AudioWorkletNode(ctx, 'deck-processor', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [2, 2] });
      node.connect(ctx.destination);
      return { target: node, deckNode: node };
    }
    default: throw new Error(`unknown chain ${spec.chain}`);
  }
}

function resolve(target, path) { let o = target; for (const k of (path || '').split('.').filter(Boolean)) o = o[k]; return o; }
async function doOp(target, op) {
  if (op.msg) { target.port.postMessage(op.msg); return; }
  const obj = resolve(target, op.on);
  if (typeof obj?.[op.call] !== "function") { if (op.optional) return; throw new Error(`no method ${op.call}`); }
  return obj[op.call](...(op.args || []));
}

/** Wait until the deck worklet has handled every message posted so far ('ping' -> 'pong'; older builds: a pause). */
let pingId = 0;
function deckSync(node) {
  return new Promise((resolve) => {
    const id = ++pingId, t = setTimeout(done, 150);
    function done() { clearTimeout(t); node.port.removeEventListener('message', on); resolve(); }
    function on(e) { if (e.data?.type === 'pong' && e.data.id === id) done(); }
    node.port.addEventListener('message', on); node.port.start();
    node.port.postMessage({ type: 'ping', id });
  });
}

async function run(spec) {
  const sr = spec.sr || 48000, n = Math.round(spec.secs * sr);
  const ctx = new OfflineAudioContext(2, n, sr);
  if (spec.fxWorklets !== false && effects.loadEffectWorklets) await effects.loadEffectWorklets(ctx);
  const [L, R] = await signal(ctx, spec, n);
  let b;
  if (spec.chain === 'deck') {
    b = await build(ctx, spec, null);
    b.target.port.postMessage({ type: 'load', left: L, right: R, sampleRate: sr, scale: 1 });
    for (const op of spec.init || []) await doOp(b.target, op);
  } else {
    const buf = ctx.createBuffer(2, n, sr); buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
    const src = ctx.createBufferSource(); src.buffer = buf;
    b = await build(ctx, spec, src);
    for (const op of spec.init || []) await doOp(b.target, op);
    src.start(0);
  }
  // group events per render quantum (suspend() needs unique, quantised times)
  const q = 128 / sr, groups = new Map();
  if (spec.chain === 'deck') groups.set(1, []); // a first stop so the load message reaches the worklet
  for (const ev of spec.events || []) { const k = Math.max(1, Math.round(ev.t / q)); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(ev); }
  for (const [k, evs] of groups) {
    ctx.suspend(k * q).then(async () => {
      for (const ev of evs) await doOp(b.target, ev);
      if (spec.chain === 'deck') await deckSync(b.target); // let worklet messages land
      ctx.resume();
    });
  }
  const t0 = performance.now();
  const out = await ctx.startRendering();
  const ms = performance.now() - t0;
  const enc = (f) => { const u = new Uint8Array(f.buffer, f.byteOffset, f.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  return { sr, L: enc(out.getChannelData(0)), R: enc(out.getChannelData(1)), ms, dry: spec.returnDry ? [enc(L), enc(R)] : null };
}

window.fxlab = { run, effects: effects.EFFECTS, ready: true };
