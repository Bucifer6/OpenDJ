// Turntable and deck options: defaults, settings merge and the small pure functions behind the vinyl model, needle
// drop, quantize divisions, tempo glide and scale play. No DOM or audio here, so test/deck-physics.test.js runs it in
// Node. The audio side of the motor lives in the deck worklet (audio/worklets.js, DeckProcessor.motorStep).

/** Platter speeds offered (33 means 33⅓). They set the scratch scale and the platter's rotation, not playback speed. */
export const RPMS = [33, 45, 78];
/** Seconds of audio per platter revolution: 33⅓ -> 1.8, 45 -> 1.333, 78 -> 0.769. */
export const secPerRev = (rpm) => (Number(rpm) === 33 || !(Number(rpm) > 0) ? 1.8 : 60 / Number(rpm));

/** Per-deck vinyl model (settings.vinyl = the default for every deck, settings.vinylDecks[i] = one deck's changes). */
export const VINYL_DEFAULTS = Object.freeze({
  start: 0,        // motor start time 0 -> 1x (s); 0 = instant like a CDJ
  stop: 0,         // motor stop time 1x -> 0 on pause / reverse (s); 0 = instant
  inertia: 0,      // a stopped deck's record coasts this long after a throw (s); 0 = stops at once
  slipmat: 0,      // 0 sticky .. 1 slick
  jogWeight: 0.5,  // 0 light .. 1 heavy (0.5 = the original feel)
  rpm: 33,
  brakeTime: 1.2,  // Brake pad / MIDI brake (s); Tape Stop uses 2.5x this
  spinTime: 1,     // spin-back length (s)
  spinSpeed: 4.5,  // spin-back throw speed (x)
  quartz: false,   // tempo pinned at 0 % whatever the fader says
});
/** Range of every numeric vinyl option: [min, max]. */
export const VINYL_RANGES = Object.freeze({ start: [0, 3], stop: [0, 3], inertia: [0, 4], slipmat: [0, 1], jogWeight: [0, 1], brakeTime: [0.2, 6], spinTime: [0.4, 4], spinSpeed: [2, 8] });

/** Deck options that are not per deck (settings.deckOptions). */
export const DECK_OPTION_DEFAULTS = Object.freeze({
  platterSkin: 'minimal', // 'minimal' | 'vinyl' | 'cdj'
  haptics: 'auto',        // 'auto' (subtle on phones, off elsewhere) | 'off' | 'subtle' | 'full'
  needleLock: 'auto',     // 'auto' (on for phones) | 'on' | 'off': a playing deck needs a long press to needle drop
  needleSnap: 'off',      // 'off' | 'beat' | 'bar': needle drops snap to the grid (keeping the beat phase while playing)
  flickSpinback: false,   // a fast backwards throw of a playing platter spins the record back
  bendMode: 'ramp',       // 'ramp' (holding bend: 1 % growing to 8 % over 1 s) | 'fixed' (±4 %, the original)
  fineStep: 0.5,          // tempo +/- step (%)
  hardLock: false,        // a playing deck refuses loads (instead of asking)
  scratchHand: 'right',   // scratch view: crossfader strip on the right (right-handed) or left
});

const clampNum = (v, [lo, hi], d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
/** One deck's effective vinyl options. */
export function vinylFor(settings, index) {
  const g = settings?.vinyl || {}, o = (Array.isArray(settings?.vinylDecks) ? settings.vinylDecks[index] : null) || {};
  const v = { ...VINYL_DEFAULTS, ...g, ...o };
  for (const [k, r] of Object.entries(VINYL_RANGES)) v[k] = clampNum(v[k], r, VINYL_DEFAULTS[k]);
  v.rpm = RPMS.includes(Number(v.rpm)) ? Number(v.rpm) : 33;
  v.quartz = v.quartz === true;
  return v;
}
export const deckOptions = (settings) => ({ ...DECK_OPTION_DEFAULTS, ...(settings?.deckOptions || {}) });

// ---------------------------------------------------------------- quantize divisions and snapping
/** Quantize divisions in beats (CDJ-style quantize beat value): 1/8, 1/4, 1/2, 1 beat, 1 bar. */
export const QUANTIZE_DIVS = [1 / 8, 1 / 4, 1 / 2, 1, 4];
export const nextQuantizeDiv = (div) => QUANTIZE_DIVS[(QUANTIZE_DIVS.indexOf(div) + 1) % QUANTIZE_DIVS.length] ?? 1;
export const fmtDiv = (d) => (d >= 4 ? '1 BAR' : d === 1 ? '1' : `1/${Math.round(1 / d)}`);
/** Nearest grid point to t for a grid starting at `offset` with `beatLen` second beats and `div` beat steps. */
export function snapTo(t, offset, beatLen, div = 1) {
  const g = beatLen * div;
  if (!(g > 0)) return t;
  return offset + Math.round((t - offset) / g) * g;
}

// ---------------------------------------------------------------- beat jump sizes
export const JUMP_SIZES = [0.5, 1, 2, 4, 8, 16, 32, 64];
export const jumpSizeStep = (b, dir) => JUMP_SIZES[Math.max(0, Math.min(JUMP_SIZES.length - 1, (JUMP_SIZES.indexOf(b) < 0 ? 3 : JUMP_SIZES.indexOf(b)) + dir))];

// ---------------------------------------------------------------- tempo glide and bend
/**
 * Seconds a linear rate ramp from r0 to r1 takes to cover `beats` beats of a track (beatLen s each at rate 1):
 * track time covered = dur * (r0 + r1) / 2.
 */
export const glideDuration = (beats, beatLen, r0, r1) => (2 * beats * beatLen) / Math.max(1e-6, r0 + r1);
export const GLIDE_BEATS = [1, 4, 16, 64];
/** Ramped bend: holding a bend button for `held` seconds bends this much (1 % growing to 8 % over 1 s). */
export const bendAt = (held) => 0.01 + 0.07 * Math.min(1, Math.max(0, held));

// ---------------------------------------------------------------- needle drop
/**
 * Where a needle drop at fraction `frac` of the track lands. With snapping the target is the nearest beat / bar;
 * while playing it also keeps the current position within the beat (like a quantised hot cue), so the mix stays in phase.
 */
export function needleTarget(frac, { duration, bpm = 0, gridOffset = 0, position = 0, playing = false, snap = 'off' } = {}) {
  let t = Math.max(0, Math.min(1, Number(frac) || 0)) * (duration || 0);
  if (snap === 'off' || !bpm) return t;
  const b = 60 / bpm, div = snap === 'bar' ? 4 : 1;
  t = snapTo(t, gridOffset, b, div);
  if (playing) {
    const frac0 = (x) => (((x - gridOffset) % b) + b) % b;
    let d = frac0(position);
    if (d > b / 2) d -= b;
    t += d;
  }
  return Math.max(0, Math.min(t, Math.max(0, duration - 0.001)));
}
/** Needle lock: a press must last this long to drop the needle on a playing deck. */
export const NEEDLE_HOLD_MS = 400;

// ---------------------------------------------------------------- scale play (platter speed as an instrument)
/** Semitone steps for the 8 pads of SCALE mode. */
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11, 12],
  minor: [0, 2, 3, 5, 7, 8, 10, 12],
  pentatonic: [0, 2, 4, 7, 9, 12, 14, 16],
  blues: [0, 3, 5, 6, 7, 10, 12, 15],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7],
};
export const semitoneRate = (s) => 2 ** (s / 12);

// ---------------------------------------------------------------- strobe and tonearm (platter skins)
/** Strobe dot rows: pitch offsets each row stands still at (0 and ±3.3 %). */
export const STROBE_ROWS = [0.033, 0, -0.033];
/**
 * Strobe row drift (radians per second). A real strobe lights its dots 100 times a second and a row has as many dots
 * as pass in 1/100 s at its nominal speed, so at that speed the row stands still and 1 % off it drifts one dot a
 * second (a stopped platter stands still too: the apparent motion is the aliased step per flash). `rate` is the
 * platter speed relative to nominal (1 = 33⅓ at 0 %), `spacing` the drawn dot spacing (radians).
 */
export function strobeRate(rate, rowPct, spacing = Math.PI / 30) {
  const x = Math.abs(rate) / (1 + rowPct);
  return spacing * 100 * (x - Math.round(x)) * Math.sign(rate || 0);
}
/** strobeRate() integrated over t seconds at a steady speed (speeds in revolutions per second). */
export const strobeAngle = (speedRps, nominalRps, rowPct, t, spacing) => strobeRate(speedRps / nominalRps, rowPct, spacing) * t;

/** Tonearm: angle from the outer groove (progress 0) to the inner groove (progress 1), linear in progress. */
export const TONEARM = Object.freeze({ outer: 0.33, inner: 0.62 }); // default end angles (radians); skins pass their own
export const tonearmAngle = (progress, outer = TONEARM.outer, inner = TONEARM.inner) => outer + (inner - outer) * Math.max(0, Math.min(1, progress || 0));
export const tonearmProgress = (angle, outer = TONEARM.outer, inner = TONEARM.inner) => Math.max(0, Math.min(1, (angle - outer) / (inner - outer)));
