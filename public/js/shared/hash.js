// Small synchronous hashes and encodings that work the same in Node and in the browser (no node:crypto, no Buffer).
// Used by the media-server clients (shared by the desktop server and the on-device backend of the mobile app):
// SHA-1 for stable device ids, MD5 for Subsonic token auth. Not for passwords at rest or anything security-critical
// beyond what those protocols themselves require.

const enc = new TextEncoder();
const toBytes = (s) => (typeof s === 'string' ? enc.encode(s) : s instanceof Uint8Array ? s : new Uint8Array(s));
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** SHA-1 of a string (UTF-8) or bytes, as lower-case hex. */
export function sha1Hex(input) {
  const msg = toBytes(input);
  const ml = msg.length;
  const words = new Uint32Array((((ml + 8) >> 6) + 1) * 16);
  for (let i = 0; i < ml; i++) words[i >> 2] |= msg[i] << (24 - (i % 4) * 8);
  words[ml >> 2] |= 0x80 << (24 - (ml % 4) * 8);
  words[words.length - 1] = ml * 8; // messages < 512 MB: the high word stays 0
  words[words.length - 2] = Math.floor((ml * 8) / 2 ** 32);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < words.length; off += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[off + t];
    for (let t = 16; t < 80; t++) { const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]; w[t] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}

const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

/** MD5 of a string (UTF-8) or bytes, as lower-case hex (Subsonic's token = md5(password + salt)). */
export function md5Hex(input) {
  const msg = toBytes(input);
  const ml = msg.length;
  const words = new Uint32Array((((ml + 8) >> 6) + 1) * 16);
  for (let i = 0; i < ml; i++) words[i >> 2] |= msg[i] << ((i % 4) * 8);
  words[ml >> 2] |= 0x80 << ((ml % 4) * 8);
  words[words.length - 2] = (ml * 8) >>> 0;
  words[words.length - 1] = Math.floor((ml * 8) / 2 ** 32);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < words.length; off += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d; d = c; c = b;
      const x = (a + f + MD5_K[i] + words[off + g]) >>> 0;
      b = (b + ((x << MD5_S[i]) | (x >>> (32 - MD5_S[i])))) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, i) => { out[i * 4] = v & 255; out[i * 4 + 1] = (v >>> 8) & 255; out[i * 4 + 2] = (v >>> 16) & 255; out[i * 4 + 3] = v >>> 24; });
  return hex(out);
}

/** n random bytes as hex (crypto.getRandomValues: Node 19+ and every browser). */
export function randomHex(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return hex(b);
}

/** UTF-8 bytes of a string as hex (Subsonic legacy "enc:" passwords). */
export const utf8Hex = (s) => hex(enc.encode(String(s)));

/** Base64 of a string's UTF-8 bytes (HTTP Basic auth). */
export function base64Utf8(s) {
  const bytes = enc.encode(String(s));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
