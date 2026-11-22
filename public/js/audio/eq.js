// Channel EQ types (mixer M3) and the isolator band splitter shared by the master isolator (M12), the FX frequency
// band split (M9) and voice-band talkover (M8). Every EQ type has the same interface:
//   createEq(ctx, type, opts) -> { type, input, output, set(state, k), dispose(), biquads, bands? }
// set() takes the channel's logical controls { eqHigh, eqMid, eqLow, eqMidHigh, eqMidLow, eqFreq } (-1..1 knobs,
// eqFreq 0..1), so automix lanes and MIDI maps keep their meaning whatever the type.
import { isoKnobGain, cutKnobDb, sculptKnobDb, sculptFreq, dbToGain } from './curves.js';

/**
 * EQ presets (mixer M3): modelled on how real club / rotary / battle mixers behave. Generic names only. Reference and
 * target curve for each (⚠ = from published spec sheets / reviews, not measured on the hardware):
 *  isolator   "Isolator" (default, today's): 3-band LR8 isolator 200 Hz / 2.5 kHz, +6 dB .. -26 dB at 8 o'clock
 *             then a full kill; bands sum to a flat all-pass. Ref: club 4-channel mixers in isolator mode.
 *  classic    "Club Classic": 3-band shelving / peaking EQ like a 900-class club mixer: low shelf 70 Hz, mid peak 1 kHz
 *             (Q 0.7), high shelf 13 kHz, +6 / -26 dB (⚠ spec sheets list +6 / -26 dB at 70 Hz / 1 kHz / 13 kHz); the last
 *             tenth of the travel slides into a kill (shelves -50 dB, corners glide to 180 Hz / 5 kHz).
 *  fourBand   "4-Band": LR8 isolator 150 Hz / 1 kHz / 5 kHz with separate low-mid and high-mid; Hi and Low full
 *             kill, mids +6 / -26 dB (⚠ flagship 6-channel mixer, exact frequencies unverified).
 *  rotaryIso  "Rotary": wide-range, smooth 24 dB/oct (LR4) isolator at 300 Hz / 4 kHz, +12 dB .. -inf with a
 *             long log taper and a gentle tanh "colour" stage (⚠ boutique rotary / 4th-order isolator mixers: +12 / -inf).
 *  battle     "Battle": simple 3-band LR8 isolator at 250 Hz / 3 kHz with a steep kill (silent from 9 o'clock, v = -0.67) for
 *             cuts on scratch mixers, +6 dB boost.
 *  vintage    "Vintage Warm": analogue-feel EQ, broad overlapping bands: low shelf 100 Hz, mid peak 800 Hz (Q 0.5), high
 *             shelf 8 kHz, +10 / -20 dB, kill at the end, mild tanh colour.
 *  sculpt     "Sculpt": one wide sweepable band (+8 / -20 dB, Q 0.35, 70 Hz - 7 kHz) between cut-only HP / LP filters.
 * Logical controls are the same for all: LOW / MID / HIGH (-1..1), plus MID-LO / MID-HI (4-band; MID drives both) and
 * FREQ (sculpt). The automix's bass swap (LOW = -1) removes >= 30 dB at 60 Hz with every preset.
 */
export const EQ_PRESETS = [
  { id: 'isolator', label: 'Isolator', type: 'isolator', knobs: ['eqHigh', 'eqMid', 'eqLow'], opts: { xover: [200, 2500], order: 8, boost: 6, cut: 26, killFrom: -0.8 } },
  { id: 'classic', label: 'Club Classic', type: 'shelving', knobs: ['eqHigh', 'eqMid', 'eqLow'], opts: { freqs: [70, 1000, 13000], q: 0.7, boost: 6, cut: 26, kill: [180, 5000] } },
  { id: 'fourBand', label: '4-Band', type: 'fourBand', knobs: ['eqHigh', 'eqMidHigh', 'eqMidLow', 'eqLow'], opts: { xover: [150, 1000, 5000], order: 8 } },
  { id: 'rotaryIso', label: 'Rotary', type: 'isolator', knobs: ['eqHigh', 'eqMid', 'eqLow'], opts: { xover: [300, 4000], order: 4, boost: 12, cut: 30, killFrom: -0.55, color: 'soft' } },
  { id: 'battle', label: 'Battle', type: 'isolator', knobs: ['eqHigh', 'eqMid', 'eqLow'], opts: { xover: [250, 3000], order: 8, boost: 6, cut: 30, killFrom: -0.4, killTo: -0.67 } },
  { id: 'vintage', label: 'Vintage Warm', type: 'shelving', knobs: ['eqHigh', 'eqMid', 'eqLow'], opts: { freqs: [100, 800, 8000], q: 0.5, boost: 10, cut: 20, kill: [300, 4000], color: 'warm' } },
  { id: 'sculpt', label: 'Sculpt', type: 'sculpt', knobs: ['eqHigh', 'eqMid', 'eqFreq', 'eqLow'], opts: {} },
];
export const EQ_TYPE_IDS = EQ_PRESETS.map((t) => t.id);
export const eqPreset = (id) => EQ_PRESETS.find((p) => p.id === id) || EQ_PRESETS[0];
/** Default isolator crossovers (Hz): low < 200 < mid < 2500 < high (today's). */
export const ISO_XOVER = [200, 2500];
const BW4 = [-5.333, 2.323]; // 4th-order Butterworth stage Qs (0.5412, 1.3066) in dB (lowpass/highpass Q is in dB)
const BW4_LIN = [0.5412, 1.3066];
const BW2 = [-3.0103]; // 2nd-order Butterworth (Q 0.7071)

function bq(ctx, type, f, q, gain) {
  const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q;
  if (gain != null) n.gain.value = gain;
  return n;
}
const chain = (...n) => { n.reduce((a, b) => { a.connect(b); return b; }); return n; };

/**
 * Linkwitz-Riley band splitter (LR8 = two cascaded 4th-order Butterworths; LR4 = two 2nd-order ones on low-end
 * devices). Lower bands go through the matching all-pass of each higher crossover, so at unity the bands sum to a
 * flat all-pass: no ripple, identical phase on every channel, true band kills (> 40 dB across the band).
 * Returns the band gain nodes (in order low -> high); with sum = true they are summed into `output`.
 */
export function bandSplitter(ctx, xovers, { order = 8, sum = true } = {}) {
  const input = ctx.createGain(), output = sum ? ctx.createGain() : null;
  const stage = order === 8 ? BW4 : BW2;
  const lr = (type, f) => [...stage, ...stage].map((q) => bq(ctx, type, f, q));
  const ap = (f) => (order === 8 ? BW4_LIN : [0.7071]).map((q) => bq(ctx, 'allpass', f, q));
  const nodes = [], bands = [];
  let upper = input;
  xovers.forEach((f, i) => {
    const lo = lr('lowpass', f), aps = xovers.slice(i + 1).flatMap(ap), g = ctx.createGain();
    chain(upper, ...lo, ...aps, g);
    const hi = lr('highpass', f);
    chain(upper, ...hi);
    nodes.push(...lo, ...aps, ...hi); bands.push(g);
    upper = hi.at(-1);
  });
  const top = ctx.createGain(); upper.connect(top); bands.push(top);
  if (sum) for (const b of bands) b.connect(output);
  return { input, output, bands, biquads: nodes, dispose() { for (const n of [input, output, ...nodes, ...bands]) try { n?.disconnect(); } catch { /* */ } } };
}

const K = 0.012; // knob smoothing time constant (s), as the rest of the channel

/** Isolator knob law: +boost dB at the right, 0 at noon, cut dB at the left fading to a full kill from `killFrom`. */
export const isoLaw = (v, { boost = 6, cut = 26, killFrom = -0.8, killTo = -1 } = {}) => (v >= 0 ? dbToGain(v * boost) : v <= killTo ? 0 : dbToGain(v * cut) * (1 - smoothstep(killFrom, killTo, v)));
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Gentle colour stage: a tanh curve with unity slope at 0 (transparent at low level, rounds off peaks). */
function colorStage(ctx, kind) {
  const sh = ctx.createWaveShaper(), n = 2049, c = new Float32Array(n), k = kind === 'warm' ? 0.45 : 0.35; // -0.15 / -0.09 dB at -6 dBFS peaks
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 4 - 2; c[i] = Math.tanh(k * x) / (2 * k); }
  sh.curve = c; // pre 0.5 / post 2: the curve covers ±2 full scale (no hard clip), unity slope at 0
  const pre = ctx.createGain(), post = ctx.createGain(); pre.gain.value = 0.5; post.gain.value = 2; pre.connect(sh); sh.connect(post);
  return { input: pre, output: post, nodes: [pre, sh, post] };
}
/** Wrap an EQ with an optional colour stage after it. */
function withColor(ctx, eq, kind) {
  if (!kind) return eq;
  const c = colorStage(ctx, kind); eq.output.connect(c.input);
  const d = eq.dispose;
  return { ...eq, output: c.output, color: kind, dispose() { d(); for (const n of c.nodes) try { n.disconnect(); } catch { /* */ } } };
}

function isolator(ctx, { xover = ISO_XOVER, order = 8, boost = 6, cut = 26, killFrom = -0.8, killTo = -1 } = {}) {
  const s = bandSplitter(ctx, xover, { order });
  const [low, mid, high] = s.bands, law = { boost, cut, killFrom, killTo };
  return {
    input: s.input, output: s.output, biquads: s.biquads.length, bands: { low, mid, high },
    set(st, t, k = K) {
      high.gain.setTargetAtTime(isoLaw(st.eqHigh, law), t, k);
      mid.gain.setTargetAtTime(isoLaw(st.eqMid, law), t, k);
      low.gain.setTargetAtTime(isoLaw(st.eqLow, law), t, k);
    },
    dispose: s.dispose,
  };
}

/** Shelving knob law: +boost .. -cut dB at -0.9, then (kill on) the last tenth slides to -50 dB. */
export const shelfLawDb = (v, { boost = 6, cut = 26, kill = true } = {}) => (v >= 0 ? v * boost : !kill ? v * cut : v >= -0.9 ? v / 0.9 * cut : -cut - (50 - cut) * smoothstep(-0.9, -1, v));
/** Shelving / peaking EQ: 3 biquads, overlapping bands like an analogue EQ; in the kill zone the shelf corners glide
 *  up / down (`kill` = [low corner, high corner]) so a LOW kill removes the bass like an isolator would. */
function shelving(ctx, { freqs = [70, 1000, 13000], q = 0.7, boost = 6, cut = 26, kill = [180, 5000], killOn = true } = {}) {
  const lo = bq(ctx, 'lowshelf', freqs[0], 0, 0), mid = bq(ctx, 'peaking', freqs[1], q, 0), hi = bq(ctx, 'highshelf', freqs[2], 0, 0);
  chain(lo, mid, hi);
  const law = { boost, cut, kill: killOn }, kz = (v) => (killOn ? smoothstep(-0.9, -1, v) : 0);
  return {
    input: lo, output: hi, biquads: 3,
    set(st, t, k = K) {
      lo.gain.setTargetAtTime(shelfLawDb(st.eqLow, law), t, k); lo.frequency.setTargetAtTime(freqs[0] * Math.pow(kill[0] / freqs[0], kz(st.eqLow)), t, k);
      mid.gain.setTargetAtTime(shelfLawDb(st.eqMid, law), t, k);
      hi.gain.setTargetAtTime(shelfLawDb(st.eqHigh, law), t, k); hi.frequency.setTargetAtTime(freqs[2] * Math.pow(kill[1] / freqs[2], kz(st.eqHigh)), t, k);
    },
    dispose() { for (const n of [lo, mid, hi]) try { n.disconnect(); } catch { /* */ } },
  };
}

/** 4-band isolator (LR8 at 150 Hz, 1 kHz, 5 kHz): Hi and Low full kill, the mids -26 dB. */
function fourBand(ctx, { order = 8 } = {}) {
  const s = bandSplitter(ctx, [150, 1000, 5000], { order });
  const [low, midLow, midHigh, high] = s.bands;
  const mids = (st, key) => (Number.isFinite(st[key]) ? st[key] : st.eqMid || 0);
  return {
    input: s.input, output: s.output, biquads: s.biquads.length, bands: { low, midLow, midHigh, high },
    set(st, t, k = K) {
      high.gain.setTargetAtTime(isoKnobGain(st.eqHigh), t, k);
      midHigh.gain.setTargetAtTime(dbToGain(cutKnobDb(mids(st, 'eqMidHigh'))), t, k);
      midLow.gain.setTargetAtTime(dbToGain(cutKnobDb(mids(st, 'eqMidLow'))), t, k);
      low.gain.setTargetAtTime(isoKnobGain(st.eqLow), t, k);
    },
    dispose: s.dispose,
  };
}

/**
 * Sculpt: one wide sweepable band (+8 / -20 dB, Q 0.35, 70 Hz - 7 kHz on eqFreq) between a cut-only high-pass and
 * low-pass. LOW turned left sweeps the high-pass up (a bass kill at -1: 400 Hz, 24 dB/oct), HIGH turned left sweeps
 * the low-pass down, so the automix bass swap still removes the bass.
 */
function sculpt(ctx) {
  const park = ctx.sampleRate * 0.49;
  const hp = BW4.map((q) => bq(ctx, 'highpass', 3, q)), lp = BW4.map((q) => bq(ctx, 'lowpass', park, q));
  const pk = bq(ctx, 'peaking', 700, 0.35, 0);
  chain(...hp, pk, ...lp);
  return {
    input: hp[0], output: lp.at(-1), biquads: 5,
    set(st, t, k = K) {
      const lo = Math.min(0, st.eqLow || 0), hi = Math.min(0, st.eqHigh || 0);
      const hpF = lo < 0 ? 10 * Math.pow(40, -lo) : 3, lpF = hi < 0 ? Math.min(park, 20000 * Math.pow(0.1, -hi)) : park;
      for (const f of hp) f.frequency.setTargetAtTime(hpF, t, k);
      for (const f of lp) f.frequency.setTargetAtTime(lpF, t, k);
      pk.gain.setTargetAtTime(sculptKnobDb(st.eqMid || 0), t, k);
      pk.frequency.setTargetAtTime(sculptFreq(st.eqFreq ?? 0.5), t, k);
    },
    dispose() { for (const n of [...hp, pk, ...lp]) try { n.disconnect(); } catch { /* */ } },
  };
}

/** Create the EQ of preset `id` (EQ_PRESETS; unknown ids give the Isolator). opts override the preset's. */
export function createEq(ctx, id = 'isolator', opts = {}) {
  const p = eqPreset(id), o = { ...p.opts, ...opts };
  const f = { isolator, shelving, fourBand, sculpt }[p.type];
  const eq = withColor(ctx, f(ctx, o), o.color);
  eq.type = p.id; eq.preset = p;
  return eq;
}
