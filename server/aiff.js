// AIFF -> WAV conversion lives in public/js/shared/aiff.js (shared with the on-device backend of the mobile app).
import { aiffToWav as toWav } from '../public/js/shared/aiff.js';

/** Convert an AIFF / AIFF-C (uncompressed) Buffer to a WAV Buffer. */
export function aiffToWav(buf) {
  const u8 = toWav(buf);
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}
