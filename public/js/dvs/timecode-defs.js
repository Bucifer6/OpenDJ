// Timecode definitions and LFSR helpers for DVS (digital vinyl system) control.
//
// A timecode record/CD carries a stereo sine carrier with the right channel 90° out of phase with the left.
// Speed = carrier frequency / nominal frequency, direction = rotation sense of the (L, R) Lissajous.
// Absolute position: every carrier cycle carries one bit (the cycle's amplitude is high or low). The bit
// sequence is the output of a maximal-length linear feedback shift register (LFSR), so the last `bits`
// bits read identify the position uniquely. Position = number of LFSR steps from `seed`.
//
// LFSR convention used here (Fibonacci form, newest bit enters at the MSB):
//   forward:  b = parity(state & (taps | 1));  next = (state >>> 1) | (b << (bits - 1))
//   reverse:  the inverse of forward (see lfsrRev)
// Cycle k of the record carries bit c_k = MSB of state_k, state_0 = seed.
//
// PROVENANCE / VERIFICATION: carrier frequencies (Serato 1 kHz, Traktor Scratch 2 kHz) and bit counts
// (Serato 20, Traktor 23) are widely documented. The seed/taps/length values below are the community
// reverse-engineered parameters published for xwax-compatible decoders; they have NOT been verified
// against physical media in OpenDJ (no real vinyl/CDs were available). The bit-reading details of real
// pressings (which channel carries the modulation, polarity, sampling phase) may need the per-deck
// "invert bits" / "swap channels" options or a new definition. Relative mode never depends on them.

/** @typedef {{ id:string, name:string, carrier:number, bits:number, seed:number, taps:number, length:number, safe:number, leadIn:number, verified:boolean, relativeOnly?:boolean }} TimecodeDef */

/** @type {Record<string, TimecodeDef>} */
export const TIMECODES = {
  serato_2a: { id: 'serato_2a', name: 'Serato CV02 vinyl, side A (33⅓)', carrier: 1000, bits: 20, seed: 0x59017, taps: 0x361e4, length: 712000, safe: 625000, leadIn: 0, verified: false },
  serato_2b: { id: 'serato_2b', name: 'Serato CV02 vinyl, side B (33⅓)', carrier: 1000, bits: 20, seed: 0x8f3c6, taps: 0x4f0d8, length: 922000, safe: 905000, leadIn: 0, verified: false },
  serato_cd: { id: 'serato_cd', name: 'Serato control CD', carrier: 1000, bits: 20, seed: 0xd8b40, taps: 0x34d54, length: 950000, safe: 890000, leadIn: 0, verified: false },
  traktor_a: { id: 'traktor_a', name: 'Traktor Scratch MK1/MK2 vinyl, side A', carrier: 2000, bits: 23, seed: 0x134503, taps: 0x041040, length: 1500000, safe: 605000, leadIn: 0, verified: false },
  traktor_b: { id: 'traktor_b', name: 'Traktor Scratch MK1/MK2 vinyl, side B', carrier: 2000, bits: 23, seed: 0x32066c, taps: 0x041040, length: 2110000, safe: 907000, leadIn: 0, verified: false },
  generic_1k: { id: 'generic_1k', name: 'Any 1 kHz timecode (relative only)', carrier: 1000, bits: 0, seed: 0, taps: 0, length: 0, safe: 0, leadIn: 0, verified: true, relativeOnly: true },
  generic_2k: { id: 'generic_2k', name: 'Any 2 kHz timecode (relative only)', carrier: 2000, bits: 0, seed: 0, taps: 0, length: 0, safe: 0, leadIn: 0, verified: true, relativeOnly: true },
};

export const RPM_FACTOR = { 33: 1, 45: 45 / (100 / 3) };

/** Parity (XOR of all bits) of a 32-bit integer. */
export function parity(x) {
  x ^= x >>> 16; x ^= x >>> 8; x ^= x >>> 4;
  return (0x6996 >>> (x & 0xf)) & 1;
}

export function lfsrFwd(state, def) {
  const b = parity(state & (def.taps | 1));
  return (state >>> 1) | (b << (def.bits - 1));
}

/** Inverse of lfsrFwd: the state one step earlier. */
export function lfsrRev(state, def) {
  const mask = def.bits >= 32 ? 0xffffffff : (1 << def.bits) - 1;
  const shifted = (state << 1) & mask;
  const msb = (state >>> (def.bits - 1)) & 1;
  const x = msb ^ parity(shifted & (def.taps | 1) & ~1);
  return shifted | x;
}

/**
 * State -> position lookup table (Int32Array of 2^bits, -1 = not on the record).
 * Traktor (23 bits) needs 32 MB, Serato (20 bits) 4 MB. Build it off the audio thread and transfer it.
 */
export function buildPositionTable(def) {
  if (!def.bits) return null;
  const table = new Int32Array(1 << def.bits).fill(-1);
  let s = def.seed;
  for (let i = 0; i < def.length; i++) { table[s] = i; s = lfsrFwd(s, def); }
  return table;
}

/** The bit carried by each cycle 0..n-1 (MSB of the LFSR state at that cycle). */
export function cycleBits(def, n) {
  const out = new Uint8Array(n);
  let s = def.seed;
  for (let i = 0; i < n; i++) { out[i] = (s >>> (def.bits - 1)) & 1; s = lfsrFwd(s, def); }
  return out;
}
