// DeviceSQL string encoding used inside rekordbox export.pdb rows.
//
// Format (Deep Symmetry "rekordbox Export Structure Analysis", section DeviceSQL Strings):
//   short ASCII : one byte lengthAndKind = ((len + 1) << 1) | 1, then `len` ASCII bytes (len <= 126)
//   long ASCII  : 0x40, u16le total length (= len + 4), one pad byte 0x00, then ASCII bytes
//   long UTF-16 : 0x90, u16le total length (= byteLen + 4), one pad byte 0x00, then UTF-16LE bytes
// No terminators. rekordbox only writes these three kinds, so that is all we write.

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** Encode a JS string as a DeviceSQL string. Control characters are dropped. */
export function encodeString(value) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '');
  if (PRINTABLE_ASCII.test(s)) {
    if (s.length <= 126) {
      const b = Buffer.alloc(1 + s.length);
      b[0] = ((s.length + 1) << 1) | 1;
      b.write(s, 1, 'latin1');
      return b;
    }
    const b = Buffer.alloc(4 + s.length);
    b[0] = 0x40; b.writeUInt16LE(s.length + 4, 1); b[3] = 0;
    b.write(s, 4, 'latin1');
    return b;
  }
  const body = Buffer.from(s, 'utf16le');
  const b = Buffer.alloc(4 + body.length);
  b[0] = 0x90; b.writeUInt16LE(body.length + 4, 1); b[3] = 0;
  body.copy(b, 4);
  return b;
}

/** True when encodeString(s) yields a long (0x40/0x90) string. rekordbox puts those on 4-byte boundaries. */
export const isLongString = (buf) => buf[0] === 0x40 || buf[0] === 0x90;

/**
 * Decode a DeviceSQL string at `pos`. Returns { text, size, kind } or throws on malformed data.
 * Independent of the encoder above (follows the documented layout byte by byte).
 */
export function decodeString(buf, pos) {
  if (pos < 0 || pos >= buf.length) throw new RangeError(`string offset ${pos} out of range`);
  const lk = buf[pos];
  if (lk & 1) {
    const total = lk >> 1; // includes the length byte
    if (total < 1 || pos + total > buf.length) throw new RangeError(`short string overruns buffer at ${pos}`);
    return { text: buf.toString('latin1', pos + 1, pos + total), size: total, kind: 'short' };
  }
  if (lk === 0x40 || lk === 0x90) {
    if (pos + 4 > buf.length) throw new RangeError(`long string header overruns buffer at ${pos}`);
    const total = buf.readUInt16LE(pos + 1);
    if (total < 4 || pos + total > buf.length) throw new RangeError(`long string overruns buffer at ${pos}`);
    if (lk === 0x40) return { text: buf.toString('latin1', pos + 4, pos + total), size: total, kind: 'ascii' };
    if ((total - 4) % 2) throw new RangeError(`odd UTF-16 length at ${pos}`);
    return { text: buf.toString('utf16le', pos + 4, pos + total), size: total, kind: 'utf16' };
  }
  throw new RangeError(`unknown DeviceSQL string kind 0x${lk.toString(16)} at ${pos}`);
}
