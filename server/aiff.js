// Chromium cannot decode AIFF, which many DJs use. Convert big-endian AIFF PCM to a WAV buffer on the fly.

function readExtended80(buf, off) {
  // IEEE 754 80-bit extended -> number (sample rate)
  const exp = ((buf[off] & 0x7f) << 8) | buf[off + 1];
  let mant = 0;
  for (let i = 0; i < 8; i++) mant = mant * 256 + buf[off + 2 + i];
  if (exp === 0 && mant === 0) return 0;
  return mant * Math.pow(2, exp - 16383 - 63);
}

export function aiffToWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'FORM') throw new Error('not AIFF');
  const formType = buf.toString('ascii', 8, 12);
  if (formType !== 'AIFF' && formType !== 'AIFC') throw new Error('not AIFF');
  let off = 12, channels = 2, bits = 16, rate = 44100, frames = 0, data = null, compression = 'NONE';
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    const body = off + 8;
    if (id === 'COMM') {
      channels = buf.readUInt16BE(body);
      frames = buf.readUInt32BE(body + 2);
      bits = buf.readUInt16BE(body + 6);
      rate = readExtended80(buf, body + 8);
      if (formType === 'AIFC') compression = buf.toString('ascii', body + 18, body + 22);
    } else if (id === 'SSND') {
      const dataOffset = buf.readUInt32BE(body);
      data = buf.subarray(body + 8 + dataOffset, Math.min(buf.length, body + size));
    }
    off = body + size + (size & 1);
  }
  if (!data) throw new Error('AIFF has no sound data');
  const littleEndian = compression === 'sowt';
  if (compression !== 'NONE' && compression !== 'sowt' && compression !== 'twos') throw new Error(`Unsupported AIFC compression ${compression}`);
  const bytes = bits / 8;
  const len = Math.min(data.length, frames * channels * bytes);
  const pcm = Buffer.alloc(len);
  if (littleEndian || bytes === 1) {
    data.copy(pcm, 0, 0, len);
    if (bytes === 1) for (let i = 0; i < len; i++) pcm[i] = (pcm[i] + 128) & 0xff; // signed -> unsigned 8-bit
  } else {
    for (let i = 0; i + bytes <= len; i += bytes) for (let b = 0; b < bytes; b++) pcm[i + b] = data[i + bytes - 1 - b];
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + len, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(channels, 22);
  hdr.writeUInt32LE(Math.round(rate), 24); hdr.writeUInt32LE(Math.round(rate) * channels * bytes, 28);
  hdr.writeUInt16LE(channels * bytes, 32); hdr.writeUInt16LE(bits, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(len, 40);
  return Buffer.concat([hdr, pcm]);
}
