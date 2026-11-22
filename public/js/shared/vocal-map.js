// Where a track's vocals are: one value per second (0 = no voice, 1 = the vocals carry the mix), measured from the AI
// vocal stem when the stems are saved (server/stems.js) and stored with the track's stems as a short base64 string.
// Used by Automix's transition planner (public/js/mix-planner.js) to keep two vocals from overlapping.

const QUIET = 1e-5; // mean square below about -50 dBFS: no voice, whatever its share of the mix

/**
 * Vocal presence per second from mean squares: the vocal stem's share of the energy of all stems, mapped so that a
 * lead vocal over a full mix reads close to 1 and breaths / bleed read 0.
 * @param {number[]} vocalMs mean square per second of the vocal stem
 * @param {number[][]} allMs mean squares per second of every stem (including the vocals)
 */
export function vocalPresence(vocalMs, allMs) {
  const n = vocalMs.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = vocalMs[i] || 0;
    if (v < QUIET) continue;
    let tot = 0; for (const s of allMs) tot += s[i] || 0;
    const share = v / (tot + 1e-12);
    out[i] = Math.max(0, Math.min(1, (share - 0.04) / 0.26));
  }
  return out;
}

/** 0..1 per second -> base64 (one byte per second: ~300 bytes for a 5-minute track). */
export function encodeVocalMap(values) {
  let s = '';
  for (const v of values) s += String.fromCharCode(Math.max(0, Math.min(255, Math.round(v * 255))));
  return btoa(s);
}

const cache = new Map();
/** base64 -> Float32Array of 0..1 per second (the last few decoded maps are kept). */
export function decodeVocalMap(b64) {
  if (!b64 || typeof b64 !== 'string') return null;
  let m = cache.get(b64);
  if (m) return m;
  try {
    const s = atob(b64);
    m = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) m[i] = s.charCodeAt(i) / 255;
  } catch { return null; }
  cache.set(b64, m);
  if (cache.size > 32) cache.delete(cache.keys().next().value);
  return m;
}
