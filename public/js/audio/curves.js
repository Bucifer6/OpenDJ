// Mixer control laws as pure functions (no Web Audio): crossfader curve family with hamster reverse and cut-in,
// channel-fader curves, the rotary level taper, EQ knob laws and Center Lock. Shared by the engine, the UI, the
// tests (test/mixer-curves.test.js) and anything that needs to predict a channel's gain (recording tracklist, video).

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
export const dbToGain = (db) => Math.pow(10, db / 20);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- crossfader
/** Crossfader settings: curve 0 (linear) .. 0.5 (smooth, constant power) .. 1 (fast cut). */
export const XF_DEFAULTS = Object.freeze({ curve: 0.5, reverse: false, cutIn: 0, cutTime: 5 });
/** Ramp knee (fraction of the scaled travel) for curves above 0.5: 0.5 (smooth) .. 0.99 (cut: unity after 1 %). */
const knee = (c) => 0.5 + 0.49 * Math.pow(clamp((c - 0.5) / 0.5, 0, 1), 0.69);
/** The legacy three-way setting `crossfaderCurve` as a point of the continuous family (identical gains). */
export const LEGACY_XF = Object.freeze({ constant: { curve: 0, cutIn: 0 }, smooth: { curve: 0.5, cutIn: 0 }, sharp: { curve: 0.9, cutIn: 0 } });
/** Nearest legacy name for a continuous curve (other code that still reads settings.crossfaderCurve). */
export const legacyXfName = (curve) => (curve < 0.25 ? 'constant' : curve < 0.7 ? 'smooth' : 'sharp');

/**
 * Gain of one crossfader side. pos: -1 (A) .. 1 (B). side: 'A' | 'B' | 'THRU'.
 *   curve 0    linear: unity until the centre, then a straight line to 0 at the far end (legacy "Linear")
 *   curve 0.5  smooth: √2·cos law, +3 dB normalised constant power, unity at the centre (legacy "Smooth")
 *   curve 0.9  legacy "Scratch": unity until 92 % of the travel, then a straight line to 0
 *   curve 1    cut: unity until 1 % before the dead zone
 * Between those points the shapes blend, so the family is continuous and monotonic. cutIn (0..0.1) is a dead zone
 * at each end where nothing changes; reverse (hamster) swaps the sides.
 */
export function xfGain(pos, side, o = {}) {
  if (side === 'THRU') return 1;
  const curve = o.curve ?? o.xfCurve ?? 0.5, cutIn = o.cutIn ?? o.xfCutIn ?? 0, reverse = o.reverse ?? o.xfReverse ?? false; // (mixer config keys accepted)
  const x = (clamp(pos, -1, 1) + 1) / 2; // 0 = A end, 1 = B end
  let p = side === 'A' ? x : 1 - x; // 0 = fully this side, 1 = fully the other side
  if (reverse) p = 1 - p;
  const ci = clamp(cutIn, 0, 0.1);
  const q = clamp((p - ci) / (1 - 2 * ci), 0, 1);
  const c = clamp(curve, 0, 1);
  const lin = (u) => Math.min(1, 2 * (1 - u));
  const smooth = (u) => Math.min(1, Math.SQRT2 * Math.cos(u * Math.PI / 2));
  if (c <= 0.5) { const t = c / 0.5; return clamp(lerp(lin(q), smooth(q), t), 0, 1); }
  const k = knee(c);
  if (q <= k) return 1;
  const r = (q - k) / (1 - k); // 0..1 across the ramp
  const t = clamp((c - 0.5) / 0.25, 0, 1); // ramp shape: cosine (smooth) -> straight line from curve 0.75 up
  const cosR = Math.SQRT2 * Math.cos(Math.PI / 4 + r * Math.PI / 4);
  return clamp(lerp(cosR, 1 - r, t), 0, 1);
}

/** Continuous crossfader settings from settings.mixer, falling back to the legacy `crossfaderCurve`. */
export function xfSettings(settings = {}) {
  const m = settings.mixer || {};
  const legacy = LEGACY_XF[settings.crossfaderCurve] || LEGACY_XF.smooth;
  return {
    curve: Number.isFinite(m.xfCurve) ? clamp(m.xfCurve, 0, 1) : legacy.curve,
    cutIn: Number.isFinite(m.xfCutIn) ? clamp(m.xfCutIn, 0, 0.1) : legacy.cutIn,
    reverse: !!m.xfReverse,
    cutTime: Number.isFinite(m.xfCutTime) ? clamp(m.xfCutTime, 0.5, 30) : XF_DEFAULTS.cutTime,
  };
}

// ---------------------------------------------------------------- channel faders
export const FADER_CURVES = ['log', 'linear', 'smooth', 'cut'];
export const FADER_CURVE_LABELS = { log: 'Log (default)', linear: 'Linear', smooth: 'Smooth (long top)', cut: 'Cut (battle)' };
/** Channel fader law: log = v² (-12 dB at half travel, today's), linear = v, smooth = v³, cut = unity above 3 %. */
export function faderGain(v, curve = 'log', reverse = false) {
  v = clamp(Number(v) || 0, 0, 1);
  if (reverse) v = 1 - v;
  switch (curve) {
    case 'linear': return v;
    case 'smooth': return v * v * v;
    case 'cut': return v >= 0.03 ? 1 : 0;
    default: return v * v;
  }
}
/** Rotary channel level (rotary personality): -inf .. +6 dB audio taper (2·v³; 0.8 ≈ 0 dB). */
export const rotaryGain = (v) => { v = clamp(Number(v) || 0, 0, 1); return 2 * v * v * v; };

// ---------------------------------------------------------------- EQ knob laws (knob -1..1 -> linear gain)
/** Isolator: +6 dB at the right, 0 dB at noon, -26 dB at 8 o'clock fading to a full kill (today's law). */
export const isoKnobGain = (v) => (v >= 0 ? dbToGain(v * 6) : dbToGain(v * 26) * (1 - smoothstep(-0.8, -1, v)));
/** Cut-limited band (classic EQ, the mids of the 4-band EQ): +6 dB .. -26 dB, no kill. */
export const cutKnobDb = (v) => (v >= 0 ? v * 6 : v * 26);
/** Classic EQ with the kill option: -26 dB at -0.9, then the last tenth of the travel slides into a kill. */
export const classicKnobDb = (v, kill = true) => (!kill ? cutKnobDb(v) : v >= 0 ? v * 6 : v >= -0.9 ? v / 0.9 * 26 : -26 - 24 * smoothstep(-0.9, -1, v));
/** Sculpt band: +8 dB .. -20 dB. */
export const sculptKnobDb = (v) => (v >= 0 ? v * 8 : v * 20);
/** Master isolator: -inf .. +6 dB (or +12 dB with the rotary headroom), kill on the last 20 % like the channel EQ. */
export const masterIsoGain = (v, boostDb = 6) => (v >= 0 ? dbToGain(v * boostDb) : dbToGain(v * 26) * (1 - smoothstep(-0.8, -1, v)));
/** Sculpt / isolator frequency knob 0..1 -> 70 Hz .. 7 kHz (log). */
export const sculptFreq = (f) => 70 * Math.pow(100, clamp(Number(f) || 0, 0, 1));

// ---------------------------------------------------------------- Center Lock
/**
 * Center Lock for the filter / Color FX knob: a control that starts on one side cannot cross 12 o'clock in one go.
 * For a mouse / touch drag the lock holds until the drag ends (reset()); for MIDI it holds until the incoming value
 * comes back into the dead zone. filter(v) returns the value to apply.
 */
export function centerLock({ dead = 0.03, mode = 'drag' } = {}) {
  let side = 0, locked = false;
  return {
    filter(v) {
      if (Math.abs(v) <= dead) { if (mode === 'midi') { locked = false; side = 0; } return locked ? 0 : v; }
      const s = Math.sign(v);
      if (!side) side = s;
      if (s !== side) { locked = true; return 0; }
      locked = false; // back on its own side: follow again
      return v;
    },
    reset() { side = 0; locked = false; },
    get locked() { return locked; },
  };
}
