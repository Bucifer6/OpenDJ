// Chromium (desktop browsers, Electron, Android WebView) cannot decode AIFF, which many DJs use. Convert big-endian
// AIFF PCM to a WAV file on the fly. Works on any Uint8Array (a Node Buffer is one); returns a Uint8Array.
// Shared by the desktop server (server/aiff.js) and the on-device backend of the mobile app.

const ascii = (u8, a, b) => String.fromCharCode(...u8.subarray(a, b));

function readExtended80(buf, off) {
  // IEEE 754 80-bit extended -> number (sample rate)
  const exp = ((buf[off] & 0x7f) << 8) | buf[off + 1];
  let mant = 0;
  for (let i = 0; i < 8; i++) mant = mant * 256 + buf[off + 2 + i];
  if (exp === 0 && mant === 0) return 0;
  return mant * Math.pow(2, exp - 16383 - 63);
}

/** Is this the start of an AIFF / AIFF-C file? */
export const isAiff = (u8) => u8.length >= 12 && ascii(u8, 0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(u8, 8, 12));

export function aiffToWav(buf) {
  if (!(buf instanceof Uint8Array)) buf = new Uint8Array(buf);
  if (buf.length < 12 || ascii(buf, 0, 4) !== 'FORM') throw new Error('not AIFF');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const formType = ascii(buf, 8, 12);
  if (formType !== 'AIFF' && formType !== 'AIFC') throw new Error('not AIFF');
  let off = 12, channels = 2, bits = 16, rate = 44100, frames = 0, data = null, compression = 'NONE';
  let comm = false;
  while (off + 8 <= buf.length) {
    const id = ascii(buf, off, off + 4);
    const size = dv.getUint32(off + 4);
    const body = off + 8;
    if (id === 'COMM') {
      if (body + 18 > buf.length || (formType === 'AIFC' && body + 22 > buf.length)) throw new Error('AIFF COMM chunk truncated');
      comm = true;
      channels = dv.getUint16(body);
      frames = dv.getUint32(body + 2);
      bits = dv.getUint16(body + 6);
      rate = readExtended80(buf, body + 8);
      if (formType === 'AIFC') compression = ascii(buf, body + 18, body + 22);
    } else if (id === 'SSND') {
      if (body + 8 > buf.length) throw new Error('AIFF SSND chunk truncated');
      const dataOffset = dv.getUint32(body);
      const start = body + 8 + dataOffset;
      if (start > buf.length) throw new Error('AIFF SSND offset out of range');
      data = buf.subarray(start, Math.max(start, Math.min(buf.length, body + size)));
    }
    off = body + size + (size & 1);
  }
  if (!comm) throw new Error('AIFF has no COMM chunk');
  if (!data) throw new Error('AIFF has no sound data');
  if (![8, 16, 24, 32].includes(bits)) throw new Error(`Unsupported AIFF bit depth ${bits}`);
  if (!(channels >= 1 && channels <= 32)) throw new Error(`Invalid AIFF channel count ${channels}`);
  if (!(rate > 0 && rate <= 1536000)) throw new Error(`Invalid AIFF sample rate ${rate}`);
  const littleEndian = compression === 'sowt';
  if (compression !== 'NONE' && compression !== 'sowt' && compression !== 'twos') throw new Error(`Unsupported AIFC compression ${compression}`);
  const bytes = bits / 8;
  const len = Math.min(data.length, frames * channels * bytes);
  const out = new Uint8Array(44 + len);
  const pcm = out.subarray(44);
  if (littleEndian || bytes === 1) {
    pcm.set(data.subarray(0, len));
    if (bytes === 1) for (let i = 0; i < len; i++) pcm[i] = (pcm[i] + 128) & 0xff; // signed -> unsigned 8-bit
  } else {
    for (let i = 0; i + bytes <= len; i += bytes) for (let b = 0; b < bytes; b++) pcm[i + b] = data[i + bytes - 1 - b];
  }
  const h = new DataView(out.buffer, 0, 44);
  const w = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); h.setUint32(4, 36 + len, true); w(8, 'WAVE');
  w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, channels, true);
  h.setUint32(24, Math.round(rate), true); h.setUint32(28, Math.round(rate) * channels * bytes, true);
  h.setUint16(32, channels * bytes, true); h.setUint16(34, bits, true);
  w(36, 'data'); h.setUint32(40, len, true);
  return out;
}
