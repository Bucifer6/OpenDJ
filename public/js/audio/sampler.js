// Sample pads: a bank of built-in DJ FX one-shots plus user-loaded samples. Air Horn and Air Horn ×3 play a bundled CC0
// recording (public/samples/air-horn.mp3, mastered like the rest: bankSound below); the others are synthesised.
//
// Every built-in sound is synthesised with real Web Audio nodes (oscillators, filters, wave shapers, a convolver
// with a generated room / hall impulse, parameter envelopes) in an OfflineAudioContext, then mastered the same way:
// DC / rumble high-pass, loudness normalised to about -14 LUFS (ITU-R BS.1770 K-weighted, gated), peak-limited to
// -1 dBFS (look-ahead limiter) and faded at both edges (no clicks). Each sound is rendered once per sample rate and
// cached. Pad order and names stay compatible with older settings / MIDI maps (pads 1-8 = Air Horn, Siren, Laser,
// Kick, Clap, Rewind, Riser, Impact).
import { SAMPLE_CATALOG, SAMPLE_SOURCE } from './sample-catalog.js';
import { integratedLoudness } from './loudness.js';

const TARGET_LUFS = -14;
const CEILING = 10 ** (-1 / 20); // -1 dBFS
const MAX_LIMIT_DB = 6; // never squash a transient by more than this to reach the loudness target

// ------------------------------------------------------------------ small helpers (all run inside the offline context)

/** Deterministic PRNG so every render of a sound is identical. */
function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
}
function noiseBuffer(ctx, seconds, seed = 7, channels = 2) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(channels, len, ctx.sampleRate);
  for (let c = 0; c < channels; c++) { const r = rng(seed + c * 101), d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = r(); }
  return buf;
}
function noise(ctx, seconds, seed) { const s = ctx.createBufferSource(); s.buffer = noiseBuffer(ctx, seconds, seed); return s; }
function osc(ctx, type, freq, detuneCents = 0) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; o.detune.value = detuneCents; return o; }
function gain(ctx, v = 1) { const g = ctx.createGain(); g.gain.value = v; return g; }
function biquad(ctx, type, freq, Q = 0.707, g = 0) { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = Q; f.gain.value = g; return f; }
/** Soft saturation (tanh), drive > 1 adds harmonics. */
function shaper(ctx, drive = 2) {
  const ws = ctx.createWaveShaper(), n = 2048, curve = new Float32Array(n), norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(drive * x) / norm; }
  ws.curve = curve; ws.oversample = '4x';
  return ws;
}
/** Stereo room / hall impulse: decorrelated noise with an exponential decay that also darkens over time. */
function impulse(ctx, seconds = 0.8, decay = 3, { seed = 3, damp = 0.5, predelay = 0.008 } = {}) {
  const len = Math.floor(ctx.sampleRate * seconds), pre = Math.floor(ctx.sampleRate * predelay);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const r = rng(seed + c * 977), d = buf.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const k = (i - pre) / (len - pre), a = 1 - damp * k * 0.9; // one-pole low-pass closing as the tail decays
      lp = lp * (1 - a) + r() * a;
      d[i] = lp * Math.pow(1 - k, decay);
    }
  }
  return buf;
}
/** dry + convolution reverb send; returns { input, output }. */
function room(ctx, { seconds = 0.8, decay = 3, wet = 0.2, damp = 0.5, seed = 3 } = {}) {
  const input = gain(ctx), output = gain(ctx), conv = ctx.createConvolver(), w = gain(ctx, wet);
  conv.buffer = impulse(ctx, seconds, decay, { seed, damp });
  input.connect(output); input.connect(conv); conv.connect(w); w.connect(output);
  return { input, output };
}
/** Feedback delay (dub echo) with a darkening feedback path; returns { input, output }. */
function echo(ctx, { time = 0.375, feedback = 0.45, wet = 0.4, tone = 2500 } = {}) {
  const input = gain(ctx), output = gain(ctx), d = ctx.createDelay(2), fb = gain(ctx, feedback), lp = biquad(ctx, 'lowpass', tone), w = gain(ctx, wet);
  d.delayTime.value = time;
  input.connect(output); input.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(w); w.connect(output);
  return { input, output };
}
/** Attack / hold / exponential release on a gain param. */
function ahr(param, t0, { attack = 0.005, hold = 0, release = 0.3, peak = 1, floor = 0.0001 } = {}) {
  param.setValueAtTime(floor, t0);
  param.linearRampToValueAtTime(peak, t0 + attack);
  param.setValueAtTime(peak, t0 + attack + hold);
  param.exponentialRampToValueAtTime(floor, t0 + attack + hold + release);
}

/** A short synthetic groove (kick, hats, bass, chord stab) used as the "record" for rewind / vinyl stop. */
async function grooveBuffer(sampleRate, seconds = 2) {
  const ctx = new OfflineAudioContext(2, Math.floor(sampleRate * seconds), sampleRate);
  const beat = 60 / 124, out = gain(ctx, 0.9); out.connect(ctx.destination);
  for (let t = 0; t < seconds; t += beat) {
    const k = osc(ctx, 'sine', 50), kg = gain(ctx, 0);
    k.frequency.setValueAtTime(160, t); k.frequency.exponentialRampToValueAtTime(48, t + 0.06);
    ahr(kg.gain, t, { attack: 0.002, release: 0.28, peak: 0.9 });
    k.connect(kg); kg.connect(out); k.start(t); k.stop(t + 0.32);
    const h = noise(ctx, 0.08, 40 + Math.round(t * 10)), hf = biquad(ctx, 'highpass', 7000), hg = gain(ctx, 0);
    ahr(hg.gain, t + beat / 2, { attack: 0.001, release: 0.05, peak: 0.25 });
    h.connect(hf); hf.connect(hg); hg.connect(out); h.start(t + beat / 2);
  }
  // bass line + a minor chord stab (A minor), bright enough that pitch changes are obvious
  [110, 110, 130.8, 98, 110, 146.8].forEach((f, i) => {
    const t = i * beat + beat * 0.5; if (t >= seconds) return;
    const b = osc(ctx, 'sawtooth', f), lp = biquad(ctx, 'lowpass', 900, 4), g = gain(ctx, 0);
    ahr(g.gain, t, { attack: 0.004, hold: beat * 0.2, release: 0.2, peak: 0.35 });
    b.connect(lp); lp.connect(g); g.connect(out); b.start(t); b.stop(t + beat);
  });
  for (const f of [440, 523.3, 659.3]) {
    const s = osc(ctx, 'sawtooth', f, 6), lp = biquad(ctx, 'lowpass', 3200, 1), g = gain(ctx, 0);
    ahr(g.gain, beat * 1.5, { attack: 0.004, hold: 0.12, release: 0.3, peak: 0.12 });
    s.connect(lp); lp.connect(g); g.connect(out); s.start(beat * 1.5); s.stop(beat * 1.5 + 0.6);
  }
  return ctx.startRendering();
}

// ------------------------------------------------------------------ the sounds (each draws into `out`)

/** One air-horn blast: detuned saw / pulse stack, onset pitch scoop, formant band-passes, saturation. */
function hornBlast(ctx, dest, t0, dur, { f0 = 466, level = 1 } = {}) {
  const sum = gain(ctx), amp = gain(ctx, 0);
  // the classic horn is one buzzy reed voice doubled slightly out of tune, plus a weaker voice a minor third up
  const voices = [
    ['sawtooth', 1, -9, 0.55], ['sawtooth', 1, 0, 0.6], ['sawtooth', 1, 8, 0.55], ['square', 1, 4, 0.28],
    ['sawtooth', 1.189, -5, 0.22], ['sawtooth', 1.189, 6, 0.2], ['sawtooth', 0.5, 0, 0.18],
  ];
  const oscs = voices.map(([type, ratio, cents, lv]) => {
    const f = f0 * ratio, o = osc(ctx, type, f, cents), g = gain(ctx, lv);
    // pitch scoop: the reed starts flat while the pressure builds, overshoots a hair, then settles
    o.frequency.setValueAtTime(f * 0.78, t0);
    o.frequency.exponentialRampToValueAtTime(f * 1.012, t0 + 0.055);
    o.frequency.exponentialRampToValueAtTime(f, t0 + 0.12);
    o.frequency.setValueAtTime(f, t0 + Math.max(0.13, dur - 0.08));
    o.frequency.exponentialRampToValueAtTime(f * 0.94, t0 + dur + 0.05); // sags as the pressure drops
    o.connect(g); g.connect(sum);
    return o;
  });
  // pressure flutter (slight, fast AM) on top of the envelope
  const flutter = osc(ctx, 'sine', 23), fd = gain(ctx, 0.06);
  flutter.connect(fd); fd.connect(amp.gain);
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.linearRampToValueAtTime(level, t0 + 0.012);
  amp.gain.setValueAtTime(level, t0 + Math.max(0.02, dur - 0.04));
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.06);
  // horn body: band-passes at the bell's formants, mixed with a darkened direct path
  const pre = shaper(ctx, 1.6), body = gain(ctx), direct = biquad(ctx, 'lowpass', 3800, 0.8);
  sum.connect(pre);
  pre.connect(direct); direct.connect(body);
  for (const [f, q, lv] of [[1150, 3, 1.1], [2400, 4, 0.9], [3600, 5, 0.5], [620, 2, 0.6]]) {
    const bp = biquad(ctx, 'bandpass', f, q), g = gain(ctx, lv);
    pre.connect(bp); bp.connect(g); g.connect(body);
  }
  const sat = shaper(ctx, 2.2), hp = biquad(ctx, 'highpass', 180, 0.7);
  body.connect(sat); sat.connect(hp); hp.connect(amp); amp.connect(dest);
  for (const o of [...oscs, flutter]) { o.start(t0); o.stop(t0 + dur + 0.3); }
}

function airHorn(ctx, out, pattern) {
  const r = room(ctx, { seconds: 0.9, decay: 3.2, wet: 0.22, damp: 0.6 });
  r.output.connect(out);
  for (const [t, d] of pattern) hornBlast(ctx, r.input, t, d);
}

/** Dub siren: square + saw oscillators swept by a rising saw LFO, resonant low-pass, dub echo. */
function siren(ctx, out) {
  const e = echo(ctx, { time: 0.36, feedback: 0.5, wet: 0.45, tone: 2200 });
  const r = room(ctx, { seconds: 1.2, decay: 2.5, wet: 0.15 });
  e.output.connect(r.input); r.output.connect(out);
  const o = osc(ctx, 'square', 620), o2 = osc(ctx, 'sawtooth', 620, 7), lfo = osc(ctx, 'sawtooth', 2.4), depth = gain(ctx, 330);
  lfo.connect(depth); depth.connect(o.frequency); depth.connect(o2.frequency);
  // the "wind-up": the sweep rate and the pitch both rise over the first second
  lfo.frequency.setValueAtTime(1.2, 0); lfo.frequency.linearRampToValueAtTime(3.6, 1.2);
  for (const x of [o, o2]) { x.frequency.setValueAtTime(420, 0); x.frequency.linearRampToValueAtTime(700, 1.0); }
  const lp = biquad(ctx, 'lowpass', 2600, 5), mix = gain(ctx), g = gain(ctx, 0), o2g = gain(ctx, 0.5);
  o.connect(mix); o2.connect(o2g); o2g.connect(mix); mix.connect(lp); lp.connect(g); g.connect(e.input);
  g.gain.setValueAtTime(0.0001, 0); g.gain.linearRampToValueAtTime(0.6, 0.05); g.gain.setValueAtTime(0.6, 2.0); g.gain.exponentialRampToValueAtTime(0.0001, 2.2);
  for (const n of [o, o2, lfo]) { n.start(0); n.stop(2.3); }
}

/** Laser zap: FM "pew" with a fast exponential pitch fall and a few echoes. */
function laser(ctx, out) {
  const e = echo(ctx, { time: 0.14, feedback: 0.35, wet: 0.35, tone: 6000 });
  e.output.connect(out);
  const t = 0, f = 4200;
  const car = osc(ctx, 'triangle', f), mod = osc(ctx, 'sine', f * 1.5), md = gain(ctx, f * 2), g = gain(ctx, 0);
  mod.connect(md); md.connect(car.frequency);
  car.frequency.setValueAtTime(f, t); car.frequency.exponentialRampToValueAtTime(90, t + 0.3);
  mod.frequency.setValueAtTime(f * 1.5, t); mod.frequency.exponentialRampToValueAtTime(130, t + 0.3);
  md.gain.setValueAtTime(f * 2, t); md.gain.exponentialRampToValueAtTime(40, t + 0.3);
  ahr(g.gain, t, { attack: 0.002, hold: 0.03, release: 0.3, peak: 0.7 });
  const hp = biquad(ctx, 'highpass', 120);
  car.connect(g); g.connect(hp); hp.connect(e.input);
  for (const n of [car, mod]) { n.start(t); n.stop(t + 0.4); }
}

/** Kick: sine body with a pitch drop, click transient, saturation for punch. */
function kick(ctx, out) {
  const body = osc(ctx, 'sine', 50), bg = gain(ctx, 0), sat = shaper(ctx, 2.5);
  body.frequency.setValueAtTime(190, 0); body.frequency.exponentialRampToValueAtTime(58, 0.05); body.frequency.exponentialRampToValueAtTime(45, 0.4);
  bg.gain.setValueAtTime(0.0001, 0); bg.gain.linearRampToValueAtTime(1, 0.002); bg.gain.setTargetAtTime(0, 0.06, 0.12);
  body.connect(sat); sat.connect(bg); bg.connect(out);
  const click = noise(ctx, 0.02, 11), cf = biquad(ctx, 'bandpass', 3500, 0.8), cg = gain(ctx, 0);
  ahr(cg.gain, 0, { attack: 0.0005, release: 0.012, peak: 0.6 });
  click.connect(cf); cf.connect(cg); cg.connect(out);
  body.start(0); body.stop(0.6); click.start(0);
}

/** Clap: four band-passed noise bursts a few ms apart, then a short diffuse tail in a small room. */
function clap(ctx, out) {
  const r = room(ctx, { seconds: 0.35, decay: 4, wet: 0.25, damp: 0.3 });
  r.output.connect(out);
  const bp = biquad(ctx, 'bandpass', 1250, 1.1), hp = biquad(ctx, 'highpass', 500), g = gain(ctx, 0);
  const src = noise(ctx, 0.5, 21);
  src.connect(bp); bp.connect(hp); hp.connect(g); g.connect(r.input);
  g.gain.setValueAtTime(0, 0);
  for (const [t, p] of [[0, 1], [0.011, 0.9], [0.022, 0.85], [0.031, 1]]) { g.gain.setValueAtTime(p, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.009); }
  g.gain.setValueAtTime(0.9, 0.033); g.gain.exponentialRampToValueAtTime(0.0001, 0.033 + 0.22);
  src.start(0);
}

/** Rewind: a groove played backwards, spun up and slowed by hand (rate automation), band-limited like a turntable. */
async function rewind(ctx, out) {
  const groove = await grooveBuffer(ctx.sampleRate, 3);
  const rev = ctx.createBuffer(2, groove.length, groove.sampleRate);
  for (let c = 0; c < 2; c++) { const s = groove.getChannelData(c), d = rev.getChannelData(c); for (let i = 0; i < s.length; i++) d[i] = s[s.length - 1 - i]; }
  const src = ctx.createBufferSource(); src.buffer = rev;
  src.playbackRate.setValueAtTime(0.3, 0);
  src.playbackRate.exponentialRampToValueAtTime(2.6, 0.35);
  src.playbackRate.setValueAtTime(2.6, 0.55);
  src.playbackRate.exponentialRampToValueAtTime(0.25, 1.1);
  const hp = biquad(ctx, 'highpass', 90), lp = biquad(ctx, 'lowpass', 7000), g = gain(ctx, 0);
  g.gain.setValueAtTime(0.0001, 0); g.gain.linearRampToValueAtTime(1, 0.05); g.gain.setValueAtTime(1, 0.9); g.gain.exponentialRampToValueAtTime(0.0001, 1.18);
  // a little needle friction noise while it spins
  const fr = noise(ctx, 1.2, 33), fbp = biquad(ctx, 'bandpass', 2500, 0.7), fg = gain(ctx, 0.025);
  fr.connect(fbp); fbp.connect(fg); fg.connect(g);
  src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(out);
  src.start(0); fr.start(0);
}

/** Vinyl stop: the groove forwards, slowing to a halt (pitch and speed fall together), closing low-pass. */
async function vinylStop(ctx, out) {
  const groove = await grooveBuffer(ctx.sampleRate, 3);
  const src = ctx.createBufferSource(); src.buffer = groove;
  src.playbackRate.setValueAtTime(1, 0); src.playbackRate.setValueAtTime(1, 0.25);
  src.playbackRate.exponentialRampToValueAtTime(0.03, 1.55);
  const lp = biquad(ctx, 'lowpass', 16000), g = gain(ctx, 1);
  lp.frequency.setValueAtTime(16000, 0.25); lp.frequency.exponentialRampToValueAtTime(400, 1.55);
  g.gain.setValueAtTime(1, 1.2); g.gain.exponentialRampToValueAtTime(0.0001, 1.6);
  src.connect(lp); lp.connect(g); g.connect(out);
  src.start(0);
}

/** Riser / uplifter: band-passed noise sweeping up with rising resonance, plus a supersaw climbing an octave. */
function riser(ctx, out, T = 4) {
  const r = room(ctx, { seconds: 1.5, decay: 2.2, wet: 0.25, damp: 0.4 });
  r.output.connect(out);
  const n = noise(ctx, T + 0.1, 51), bp = biquad(ctx, 'bandpass', 300, 1), ng = gain(ctx, 0);
  bp.frequency.setValueAtTime(300, 0); bp.frequency.exponentialRampToValueAtTime(9000, T);
  bp.Q.setValueAtTime(0.8, 0); bp.Q.linearRampToValueAtTime(6, T);
  ng.gain.setValueAtTime(0.02, 0); ng.gain.exponentialRampToValueAtTime(0.9, T - 0.05); ng.gain.linearRampToValueAtTime(0, T);
  n.connect(bp); bp.connect(ng); ng.connect(r.input); n.start(0);
  const lp = biquad(ctx, 'lowpass', 600, 2), sg = gain(ctx, 0);
  for (const c of [-14, -5, 0, 6, 13]) {
    const s = osc(ctx, 'sawtooth', 220, c);
    s.frequency.setValueAtTime(220, 0); s.frequency.exponentialRampToValueAtTime(440, T);
    s.connect(lp); s.start(0); s.stop(T + 0.05);
  }
  lp.frequency.setValueAtTime(500, 0); lp.frequency.exponentialRampToValueAtTime(7000, T);
  sg.gain.setValueAtTime(0.005, 0); sg.gain.exponentialRampToValueAtTime(0.18, T - 0.05); sg.gain.linearRampToValueAtTime(0, T);
  lp.connect(sg); sg.connect(r.input);
}

/** Downlifter: a falling noise sweep with a pitch-dropping sine and a long tail. */
function downlifter(ctx, out, T = 3) {
  const r = room(ctx, { seconds: 1.8, decay: 2.4, wet: 0.3, damp: 0.5 });
  r.output.connect(out);
  const n = noise(ctx, T, 61), bp = biquad(ctx, 'bandpass', 9000, 4), ng = gain(ctx, 0);
  bp.frequency.setValueAtTime(9000, 0); bp.frequency.exponentialRampToValueAtTime(180, T);
  bp.Q.setValueAtTime(5, 0); bp.Q.linearRampToValueAtTime(0.8, T);
  ng.gain.setValueAtTime(0.0001, 0); ng.gain.linearRampToValueAtTime(0.9, 0.02); ng.gain.exponentialRampToValueAtTime(0.0001, T);
  n.connect(bp); bp.connect(ng); ng.connect(r.input); n.start(0);
  const s = osc(ctx, 'sine', 880), sg = gain(ctx, 0);
  s.frequency.setValueAtTime(880, 0); s.frequency.exponentialRampToValueAtTime(55, T);
  sg.gain.setValueAtTime(0.0001, 0); sg.gain.linearRampToValueAtTime(0.35, 0.02); sg.gain.exponentialRampToValueAtTime(0.0001, T);
  s.connect(sg); sg.connect(r.input); s.start(0); s.stop(T);
}

/** Impact / boom: sub drop, noise crack, saturated, in a big hall. */
function impact(ctx, out) {
  const r = room(ctx, { seconds: 2.4, decay: 2.2, wet: 0.35, damp: 0.7, seed: 9 });
  r.output.connect(out);
  const sub = osc(ctx, 'sine', 60), sg = gain(ctx, 0), sat = shaper(ctx, 3);
  sub.frequency.setValueAtTime(120, 0); sub.frequency.exponentialRampToValueAtTime(52, 0.08); sub.frequency.exponentialRampToValueAtTime(32, 2.2);
  sg.gain.setValueAtTime(0.0001, 0); sg.gain.linearRampToValueAtTime(1, 0.004); sg.gain.setTargetAtTime(0, 0.15, 0.55);
  sub.connect(sat); sat.connect(sg); sg.connect(r.input);
  const crack = noise(ctx, 0.6, 71), lp = biquad(ctx, 'lowpass', 5000), cg = gain(ctx, 0);
  lp.frequency.setValueAtTime(6000, 0); lp.frequency.exponentialRampToValueAtTime(300, 0.5);
  ahr(cg.gain, 0, { attack: 0.001, release: 0.45, peak: 0.6 });
  crack.connect(lp); lp.connect(cg); cg.connect(r.input);
  sub.start(0); sub.stop(2.6); crack.start(0);
}

/** White-noise sweep: resonant high-pass sweeping up while the noise swells, then a quick fall back. */
function noiseSweep(ctx, out, T = 2.5) {
  const r = room(ctx, { seconds: 1, decay: 2.5, wet: 0.2 });
  r.output.connect(out);
  const n = noise(ctx, T, 81), hp = biquad(ctx, 'highpass', 150, 4), g = gain(ctx, 0);
  hp.frequency.setValueAtTime(150, 0); hp.frequency.exponentialRampToValueAtTime(11000, T * 0.8); hp.frequency.exponentialRampToValueAtTime(3000, T);
  g.gain.setValueAtTime(0.0001, 0); g.gain.exponentialRampToValueAtTime(0.8, T * 0.75); g.gain.exponentialRampToValueAtTime(0.0001, T);
  n.connect(hp); hp.connect(g); g.connect(r.input); n.start(0);
}

/** Air Horn ×3: two stabs, then the long blast. [start s, length s]; for the recording, null = all of it. */
const HORN_TRIPLE = [[0.0, 0.11], [0.19, 0.11], [0.38, null]];

/**
 * The built-in bank. `seconds` is the render length (tails included). `file` names a bundled recording (public/samples)
 * the pad plays instead, cut into `cuts` when given; the synthesised `render` is its fallback.
 */
export const SOUND_BANK = [
  { id: 'airhorn', name: 'Air Horn', seconds: 1.9, file: 'air-horn.mp3', render: (c, o) => airHorn(c, o, [[0.0, 1.25]]) },
  { id: 'siren', name: 'Siren', seconds: 3.4, render: siren },
  { id: 'laser', name: 'Laser', seconds: 1.2, render: laser },
  { id: 'kick', name: 'Kick', seconds: 0.7, render: kick },
  { id: 'clap', name: 'Clap', seconds: 0.6, render: clap },
  { id: 'rewind', name: 'Rewind', seconds: 1.3, render: rewind },
  { id: 'riser', name: 'Riser', seconds: 5.2, render: (c, o) => riser(c, o, 4) },
  { id: 'impact', name: 'Impact', seconds: 3.6, render: impact },
  { id: 'airhorn3', name: 'Air Horn ×3', seconds: 2.0, file: 'air-horn.mp3', cuts: HORN_TRIPLE,
    render: (c, o) => airHorn(c, o, HORN_TRIPLE.map(([at, len]) => [at, len ?? 1.0])) },
  { id: 'downlifter', name: 'Downlifter', seconds: 4.4, render: (c, o) => downlifter(c, o, 3) },
  { id: 'noisesweep', name: 'Noise Sweep', seconds: 3.3, render: (c, o) => noiseSweep(c, o, 2.5) },
  { id: 'vinylstop', name: 'Vinyl Stop', seconds: 1.7, render: vinylStop },
];
/** Default sound per pad (pad order = the old fixed bank, so saved MIDI maps keep working). */
export const DEFAULT_PADS = ['airhorn', 'siren', 'laser', 'kick', 'clap', 'rewind', 'riser', 'impact'];

// ------------------------------------------------------------------ mastering / measurement

// Integrated loudness (LUFS, BS.1770-4) lives in loudness.js; re-exported here under its old name. Sounds are passed
// as an array of channels (measured as given, BS.1770 channel sum); shorter than one 400 ms block = one block.
export { integratedLoudness };

export function peakOf(channels) { let p = 0; for (const c of channels) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > p) p = a; } return p; }

/** Look-ahead peak limiter (in place): |x| never exceeds `ceiling`; 1.5 ms attack ramp, 60 ms release. */
export function limit(channels, sampleRate, ceiling = CEILING) {
  const n = channels[0].length, L = Math.max(1, Math.round(0.0015 * sampleRate));
  const req = new Float32Array(n);
  for (let i = 0; i < n; i++) { let p = 0; for (const c of channels) p = Math.max(p, Math.abs(c[i])); req[i] = p > ceiling ? ceiling / p : 1; }
  // forward window minimum over [i, i + L] (monotonic deque)
  const wmin = new Float32Array(n), dq = new Int32Array(n + 1); let h = 0, t = 0;
  for (let j = 0; j < n + L; j++) {
    if (j < n) { while (t > h && req[dq[t - 1]] >= req[j]) t--; dq[t++] = j; }
    const i = j - L; if (i < 0) continue;
    while (dq[h] < i) h++;
    wmin[i] = req[dq[h]];
  }
  // causal moving average of that minimum (a smooth attack that is still below the requirement at the peak), then release
  const rel = 1 - Math.exp(-1 / (0.06 * sampleRate));
  const ring = new Float32Array(L).fill(1); let acc = L, g = 1;
  for (let i = 0; i < n; i++) {
    acc += wmin[i] - ring[i % L]; ring[i % L] = wmin[i];
    const target = acc / L;
    g = target < g ? target : g + (target - g) * rel;
    for (const c of channels) { c[i] *= g; if (c[i] > ceiling) c[i] = ceiling; else if (c[i] < -ceiling) c[i] = -ceiling; }
  }
}

/** Half-cosine fades at both ends (no clicks). */
export function edgeFades(channels, sampleRate, fadeIn = 0.0015, fadeOut = 0.02) {
  const n = channels[0].length, fi = Math.min(n, Math.round(fadeIn * sampleRate)), fo = Math.min(n, Math.round(fadeOut * sampleRate));
  for (const c of channels) {
    for (let i = 0; i < fi; i++) c[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / fi);
    for (let i = 0; i < fo; i++) c[n - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / fo);
  }
}

/** Normalise to TARGET_LUFS (with at most MAX_LIMIT_DB of limiting), limit to -1 dBFS, fade the edges. In place. */
export function master(channels, sampleRate) {
  const lufs = integratedLoudness(channels, sampleRate), peak = peakOf(channels);
  if (!Number.isFinite(lufs) || !peak) return { lufs, peak, gainDb: 0 };
  let g = 10 ** ((TARGET_LUFS - lufs) / 20);
  g = Math.min(g, (CEILING * 10 ** (MAX_LIMIT_DB / 20)) / peak); // percussive one-shots keep their transient
  for (const c of channels) for (let i = 0; i < c.length; i++) c[i] *= g;
  limit(channels, sampleRate);
  edgeFades(channels, sampleRate);
  return { lufs: integratedLoudness(channels, sampleRate), peak: peakOf(channels), gainDb: 20 * Math.log10(g) };
}

const cache = new Map(); // `${id}@${sampleRate}` -> Promise<AudioBuffer>

/**
 * A built-in sound as its pad plays it: the bundled recording when the bank names one (`file`, cut into `cuts`),
 * mastered like the synthesised sounds, else the synthesised render, which is also the fallback when the file can't
 * be loaded. Cached per sound and sample rate; the decoded file itself is not kept.
 */
export function bankSound(id, ctx) {
  const def = SOUND_BANK.find((s) => s.id === id);
  if (!def?.file) return renderSound(id, ctx.sampleRate);
  const key = `${id}-rec@${ctx.sampleRate}`;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    try {
      const r = await fetch(new URL(`../../samples/${def.file}`, import.meta.url));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const b = cutBuffer(ctx, await ctx.decodeAudioData(await r.arrayBuffer()), def.cuts);
      b.stats = master(Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)), b.sampleRate);
      return b;
    } catch (e) { console.warn(`sampler: ${def.file} unavailable, using the synthesised ${def.name}`, e); return renderSound(id, ctx.sampleRate); }
  })();
  cache.set(key, p);
  return p;
}

/**
 * Pieces of `src` laid out in a new buffer: cuts = [[start s, length s or null for all of it]], which must not
 * overlap; a piece shorter than the source ends in a 15 ms fade (no click). Without cuts, `src` itself.
 */
function cutBuffer(ctx, src, cuts) {
  if (!cuts) return src;
  const sr = src.sampleRate, fade = Math.round(0.015 * sr);
  const parts = cuts.map(([at, len]) => ({ o: Math.round(at * sr), n: len == null ? src.length : Math.min(src.length, Math.round(len * sr)) }));
  const out = ctx.createBuffer(src.numberOfChannels, Math.max(...parts.map((q) => q.o + q.n)), sr);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const from = src.getChannelData(c), to = out.getChannelData(c);
    for (const { o, n } of parts) {
      to.set(from.subarray(0, n), o);
      if (n < src.length) for (let i = Math.max(0, n - fade); i < n; i++) to[o + i] *= (n - i) / fade;
    }
  }
  return out;
}

/** Render (once, cached) a built-in sound at a sample rate. Resolves a stereo AudioBuffer with `.stats`. */
export function renderSound(id, sampleRate = 48000) {
  const key = `${id}@${sampleRate}`;
  if (cache.has(key)) return cache.get(key);
  const def = SOUND_BANK.find((s) => s.id === id);
  if (!def) return Promise.reject(new Error(`Unknown sound: ${id}`));
  const p = (async () => {
    const ctx = new OfflineAudioContext(2, Math.ceil(def.seconds * sampleRate), sampleRate);
    const hp = biquad(ctx, 'highpass', 25, 0.6); // DC / sub-rumble
    hp.connect(ctx.destination);
    await def.render(ctx, hp);
    const buf = await ctx.startRendering();
    buf.stats = master([buf.getChannelData(0), buf.getChannelData(1)], sampleRate);
    return buf;
  })();
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  return p;
}

/** 16-bit PCM WAV bytes of an AudioBuffer (for inspection / export). */
export function toWav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate, out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true);
  out.setUint16(22, ch, true); out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) out.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(data[c][i] * 32767))), true);
  return new Uint8Array(out.buffer);
}

// ------------------------------------------------------------------ user samples (kept in this browser, IndexedDB)

const DB = 'opendj-sampler', STORE = 'pads';
function idb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no IndexedDB'));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result); tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

const MAX_SAMPLE_BYTES = 8 * 1024 * 1024; // the largest catalogue file is about 0.7 MB
const clampVol = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1.5, n)) : 1; };

// ------------------------------------------------------------------ the sampler

export class Sampler {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination
   * @param {{ pads?: {sound?:string, volume?:number, sync?:boolean}[] }} [config]  saved pad settings (settings.sampler)
   */
  constructor(ctx, destination, config = {}) {
    this.ctx = ctx;
    this.out = ctx.createGain(); this.out.gain.value = 0.8; this.out.connect(destination);
    this.pre = ctx.createGain(); this.pre.connect(this.out); // pads -> pre (sampler cue taps here, before the volume) -> out
    /** () => AudioContext time of the master deck's next beat, or null. Set by the engine. */
    this.nextBeat = null;
    /** Called when a pad's sound / name / settings change (UI refresh). */
    this.onChange = null;
    const pads = Array.isArray(config?.pads) ? config.pads : [];
    this.slots = DEFAULT_PADS.map((id, i) => this._builtinSlot(pads[i]?.sound || id, pads[i]));
    this.ready = Promise.all(this.slots.map((s, i) => this._fill(i, s))).then(() => this.restoreUserSamples());
  }
  static get bank() { return SOUND_BANK.map(({ id, name }) => ({ id, name })); }
  _builtinSlot(id, cfg = {}) {
    const def = SOUND_BANK.find((s) => s.id === id) || SOUND_BANK[0];
    return { name: def.name, sound: def.id, buffer: null, builtin: true, playing: null, mode: 'oneshot', volume: clampVol(cfg?.volume), sync: !!cfg?.sync };
  }
  async _fill(i, slot) {
    try {
      const b = await bankSound(slot.sound, this.ctx);
      if (this.slots[i] === slot) { slot.buffer = b; this.onChange?.(); }
    } catch (e) { console.warn('sampler: could not render', slot.sound, e); }
  }
  /** Pad settings to save (settings.sampler). */
  config() { return { pads: this.slots.map((s) => ({ sound: s.sound, volume: s.volume, sync: s.sync })) }; }
  setVolume(v) { this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  setPadVolume(i, v) { const s = this.slots[i]; if (s) { s.volume = clampVol(v); this.onChange?.(); } }
  setPadSync(i, on) { const s = this.slots[i]; if (s) { s.sync = !!on; this.onChange?.(); } }
  /** Put a built-in sound on a pad (replaces a user sample there). */
  async setSound(i, id) {
    const old = this.slots[i]; if (!old) return;
    const s = this._builtinSlot(id, old);
    this.slots[i] = s; this.onChange?.();
    idbDo('readwrite', (st) => st.delete(i)).catch(() => {});
    await this._fill(i, s);
  }
  /**
   * Download a curated CC0 one-shot (an entry of SAMPLE_CATALOG, matched by id: only its pinned URL is fetched) and
   * assign it to a pad. Resolves { saved } (false: kept for this session only, browser storage refused it).
   */
  async loadCatalogSample(i, sample) {
    const entry = SAMPLE_CATALOG.find((x) => x.id === sample?.id);
    if (!entry || !this.slots[i]) throw new Error('Invalid sample selection');
    if (!entry.url.startsWith(SAMPLE_SOURCE)) throw new Error('This sample is not from the pinned source');
    const token = (this._dl ||= [])[i] = {};
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
    let bytes;
    try {
      const response = await fetch(entry.url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: ctl.signal });
      if (!response.ok) throw new Error(`Sample download failed (HTTP ${response.status})`);
      if (Number(response.headers.get('content-length')) > MAX_SAMPLE_BYTES) throw new Error('Sample file is too large');
      bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_SAMPLE_BYTES) throw new Error('Sample file is too large');
    } catch (e) { throw e.name === 'AbortError' ? new Error('Sample download timed out') : e; } finally { clearTimeout(timer); }
    const buf = await this.ctx.decodeAudioData(bytes.slice(0));
    if (this._dl[i] !== token) return { saved: false, superseded: true }; // another sound was chosen meanwhile
    const old = this.slots[i] || {};
    const metadata = { name: entry.name, creator: entry.creator, source: entry.source, license: entry.license || 'CC0 1.0', catalogId: entry.id };
    this.slots[i] = { ...old, ...metadata, sound: old.sound, buffer: buf, builtin: false, playing: null, mode: 'oneshot', volume: clampVol(old.volume), sync: !!old.sync };
    this.onChange?.();
    try { await idbDo('readwrite', (st) => st.put({ ...metadata, bytes }, i)); return { saved: true }; } catch { return { saved: false }; }
  }
  async loadFile(i, file) {
    const bytes = await file.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(bytes.slice(0));
    const old = this.slots[i] || {};
    this.slots[i] = { name: String(file.name || 'Sample').replace(/\.[^.]+$/, '').slice(0, 60), sound: old.sound, buffer: buf, builtin: false, playing: null, mode: 'oneshot', volume: clampVol(old.volume), sync: !!old.sync };
    this.onChange?.();
    idbDo('readwrite', (st) => st.put({ name: this.slots[i].name, bytes }, i)).catch(() => {}); // remembered in this browser
  }
  async restoreUserSamples() {
    let rows;
    try { rows = await Promise.all(this.slots.map((_, i) => idbDo('readonly', (st) => st.get(i)))); } catch { return; }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]; if (!r?.bytes) continue;
      try {
        const buf = await this.ctx.decodeAudioData(r.bytes.slice(0));
        this.slots[i] = { ...this.slots[i], name: r.name || 'Sample', creator: r.creator, source: r.source, license: r.license, buffer: buf, builtin: false, playing: null };
      } catch { /* unreadable: keep the built-in sound */ }
    }
    this.onChange?.();
  }
  /** Start time for a pad: now (0), or the master deck's next beat when the pad syncs to the beat and a deck plays. */
  startTime(i, when = 0) {
    if (when) return when;
    const s = this.slots[i], now = this.ctx.currentTime;
    if (!s?.sync || !this.nextBeat) return 0;
    const t = this.nextBeat();
    return t && t > now + 0.003 && t < now + 2 ? t : 0;
  }
  trigger(i, { velocity = 1, when = 0, choke = true } = {}) {
    const s = this.slots[i]; if (!s?.buffer) return;
    const at = this.startTime(i, when);
    if (s.playing && choke) {
      // a short fade instead of a hard stop: no click when re-triggering a pad that is still ringing
      const p = s.playing, t = Math.max(at, this.ctx.currentTime);
      try { p.gainNode.gain.setTargetAtTime(0, t, 0.006); p.stop(t + 0.05); } catch { /* ended */ }
    }
    const src = this.ctx.createBufferSource(); src.buffer = s.buffer;
    const g = this.ctx.createGain(); g.gain.value = velocity * (s.volume ?? 1);
    src.gainNode = g;
    src.connect(g); g.connect(this.pre); src.start(at || 0);
    s.playing = src; src.onended = () => { if (s.playing === src) s.playing = null; };
  }
  stop(i) {
    const s = this.slots[i]; if (!s?.playing) return;
    const p = s.playing, t = this.ctx.currentTime;
    try { p.gainNode.gain.setTargetAtTime(0, t, 0.008); p.stop(t + 0.06); } catch { /* ended */ }
    s.playing = null;
  }
}
