// Channel EQ types (mixer M3) and the isolator band splitter shared by the master isolator (M12), the FX frequency
// band split (M9) and voice-band talkover (M8). Every EQ type has the same interface:
//   createEq(ctx, type, opts) -> { type, input, output, set(state, k), dispose(), biquads, bands? }
// set() takes the channel's logical controls { eqHigh, eqMid, eqLow, eqMidHigh, eqMidLow, eqFreq } (-1..1 knobs,
// eqFreq 0..1), so automix lanes and MIDI maps keep their meaning whatever the type.
import { isoKnobGain, cutKnobDb, classicKnobDb, sculptKnobDb, sculptFreq, dbToGain } from './curves.js';

export const EQ_TYPES = [
  { id: 'isolator', label: 'Isolator', knobs: ['eqHigh', 'eqMid', 'eqLow'], biquads: 18 },
  { id: 'classic', label: 'Classic (full kill)', knobs: ['eqHigh', 'eqMid', 'eqLow'], biquads: 3 },
  { id: 'fourBand', label: '4-band', knobs: ['eqHigh', 'eqMidHigh', 'eqMidLow', 'eqLow'], biquads: 30 },
  { id: 'sculpt', label: 'Sculpt', knobs: ['eqHigh', 'eqMid', 'eqFreq', 'eqLow'], biquads: 5 },
];
export const EQ_TYPE_IDS = EQ_TYPES.map((t) => t.id);
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

function isolator(ctx, { xover = ISO_XOVER, order = 8 } = {}) {
  const s = bandSplitter(ctx, xover, { order });
  const [low, mid, high] = s.bands;
  return {
    input: s.input, output: s.output, biquads: s.biquads.length, bands: { low, mid, high },
    set(st, t, k = K) {
      high.gain.setTargetAtTime(isoKnobGain(st.eqHigh), t, k);
      mid.gain.setTargetAtTime(isoKnobGain(st.eqMid), t, k);
      low.gain.setTargetAtTime(isoKnobGain(st.eqLow), t, k);
    },
    dispose: s.dispose,
  };
}

/** Classic shelving / peaking EQ: 3 biquads, overlapping bands like an analogue EQ, -26 dB with a kill at the end. */
function classic(ctx, { kill = true } = {}) {
  const lo = bq(ctx, 'lowshelf', 150, 0, 0), mid = bq(ctx, 'peaking', 1000, 0.7, 0), hi = bq(ctx, 'highshelf', 7000, 0, 0);
  chain(lo, mid, hi);
  return {
    input: lo, output: hi, biquads: 3,
    set(st, t, k = K) {
      lo.gain.setTargetAtTime(classicKnobDb(st.eqLow, kill), t, k);
      mid.gain.setTargetAtTime(classicKnobDb(st.eqMid, kill), t, k);
      hi.gain.setTargetAtTime(classicKnobDb(st.eqHigh, kill), t, k);
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

/** Create an EQ of `type` ('isolator' | 'classic' | 'fourBand' | 'sculpt'); unknown types give the isolator. */
export function createEq(ctx, type = 'isolator', opts = {}) {
  const f = { isolator, classic, fourBand, sculpt }[type] || isolator;
  const eq = f(ctx, opts);
  eq.type = { isolator: 1, classic: 1, fourBand: 1, sculpt: 1 }[type] ? type : 'isolator';
  return eq;
}
