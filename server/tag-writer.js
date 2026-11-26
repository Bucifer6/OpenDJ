// Opt-in non-destructive ID3v2.3 tag write-back (TBPM, TKEY, and Serato-compatible GEOB "Serato Markers2").
// Pure Node module (zero external deps): parses existing ID3v2 headers on MP3 files, updates or adds only the
// requested DJ metadata frames while preserving all other frames (APIC artwork, TIT2, TPE1, etc.), and writes
// atomically via a temporary file + rename so the original audio stream is never truncated or corrupted.
import fs from 'node:fs';

function syncsafeEncode(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}
function syncsafeDecode(buf, off) {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) | ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}

function makeTextFrame(id, text) {
  const payload = Buffer.concat([Buffer.from([0x03]), Buffer.from(String(text), 'utf8')]); // UTF-8 encoding
  const hdr = Buffer.alloc(10);
  hdr.write(id, 0, 4, 'ascii');
  hdr.writeUInt32BE(payload.length, 4);
  return Buffer.concat([hdr, payload]);
}

/**
 * Encode OpenDJ hot cues + track colour into a Serato Markers2 binary payload (Base64 inside a GEOB frame).
 * Compatible with Serato / Mixxx / Rekordbox Serato-GEOB readers:
 *   header 0x01 0x01 + base64(0x01 0x01 + entries: CUE\0 <len> <0x00> <idx> <ms u32be> <0x00> <R G B> <0x00 0x00> <name\0>)
 */
export function buildSeratoMarkers2(cues = [], colorHex = null) {
  const parts = [Buffer.from([0x01, 0x01])];
  const hexRgb = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    return m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)] : [0x2e, 0xcc, 0x71];
  };
  if (colorHex) {
    const [r, g, b] = hexRgb(colorHex);
    const body = Buffer.from([0x00, r, g, b]);
    const entry = Buffer.concat([Buffer.from('COLOR\0', 'ascii'), Buffer.alloc(4), body]);
    entry.writeUInt32BE(body.length, 6);
    parts.push(entry);
  }
  const hot = (Array.isArray(cues) ? cues : []).filter((c) => Number.isInteger(c?.index) && c.index >= 0 && c.index < 8 && Number.isFinite(c.position));
  for (const c of hot) {
    const ms = Math.max(0, Math.round(c.position * 1000));
    const [r, g, b] = hexRgb(c.color);
    const name = Buffer.from(String(c.name || '').slice(0, 60) + '\0', 'utf8');
    const body = Buffer.alloc(13 + name.length);
    body[0] = 0x00;
    body[1] = c.index & 0xff;
    body.writeUInt32BE(ms, 2);
    body[6] = 0x00;
    body[7] = r; body[8] = g; body[9] = b;
    body[10] = 0x00; body[11] = 0x00;
    name.copy(body, 12);
    const hdr = Buffer.alloc(8);
    hdr.write('CUE\0', 0, 4, 'ascii');
    hdr.writeUInt32BE(body.length, 4);
    parts.push(hdr, body);
  }
  const inner = Buffer.concat(parts);
  const b64 = inner.toString('base64');
  // Wrap in Serato GEOB format: 0x01 0x01 + line-wrapped base64 + null terminator
  const data = Buffer.concat([Buffer.from([0x01, 0x01]), Buffer.from(b64, 'ascii'), Buffer.from([0x00])]);
  // GEOB frame payload: encoding(0) + mime('\0') + filename('\0') + description('Serato Markers2\0') + data
  const payload = Buffer.concat([Buffer.from([0x00, 0x00, 0x00]), Buffer.from('Serato Markers2\0', 'ascii'), data]);
  const hdr = Buffer.alloc(10);
  hdr.write('GEOB', 0, 4, 'ascii');
  hdr.writeUInt32BE(payload.length, 4);
  return Buffer.concat([hdr, payload]);
}

/** Parse existing ID3v2.3/2.4 frames from an MP3 buffer, returning { audioOffset, frames: [{ id, desc, raw }] }. */
export function parseId3v2(buf) {
  if (!buf || buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return { audioOffset: 0, frames: [] };
  const ver = buf[3];
  const tagSize = syncsafeDecode(buf, 6);
  const audioOffset = Math.min(buf.length, 10 + tagSize);
  const frames = [];
  let pos = 10;
  // Skip extended header if present
  if (buf[5] & 0x40) {
    const extLen = ver === 4 ? syncsafeDecode(buf, pos) : buf.readUInt32BE(pos);
    pos += ver === 4 ? extLen : extLen + 4;
  }
  while (pos + 10 <= audioOffset) {
    const id = buf.toString('ascii', pos, pos + 4);
    if (id === '\0\0\0\0' || !/^[A-Z0-9]{4}$/.test(id)) break;
    const size = ver === 4 ? syncsafeDecode(buf, pos + 4) : buf.readUInt32BE(pos + 4);
    if (size <= 0 || pos + 10 + size > audioOffset) break;
    const raw = buf.subarray(pos, pos + 10 + size);
    let desc = '';
    if (id === 'GEOB') {
      // Extract description after encoding(1) + mime\0 + filename\0
      const p0 = buf.indexOf(0, pos + 11);
      const p1 = p0 >= 0 ? buf.indexOf(0, p0 + 1) : -1;
      const p2 = p1 >= 0 ? buf.indexOf(0, p1 + 1) : -1;
      if (p1 >= 0 && p2 > p1) desc = buf.toString('utf8', p1 + 1, p2);
    }
    frames.push({ id, desc, raw });
    pos += 10 + size;
  }
  return { audioOffset, frames };
}

/** Build a new MP3 buffer with updated TBPM, TKEY, and Serato Markers2 GEOB frames. */
export function patchMp3Tags(buf, { bpm = null, key = null, cues = null, color = null } = {}) {
  const { audioOffset, frames } = parseId3v2(buf);
  const kept = frames.filter((f) => {
    if (bpm != null && f.id === 'TBPM') return false;
    if (key != null && f.id === 'TKEY') return false;
    if ((cues != null || color != null) && f.id === 'GEOB' && f.desc === 'Serato Markers2') return false;
    return true;
  }).map((f) => f.raw);
  if (bpm != null && Number.isFinite(Number(bpm)) && Number(bpm) > 0) kept.push(makeTextFrame('TBPM', String(Math.round(Number(bpm) * 100) / 100)));
  if (key != null && String(key).trim()) kept.push(makeTextFrame('TKEY', String(key).trim()));
  if ((Array.isArray(cues) && cues.length) || color) kept.push(buildSeratoMarkers2(cues || [], color));
  const body = Buffer.concat(kept);
  const hdr = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([0x03, 0x00, 0x00]), syncsafeEncode(body.length)]);
  return Buffer.concat([hdr, body, buf.subarray(audioOffset)]);
}

/** Atomically write DJ tags (BPM, Key, Serato GEOB hot cues) into an MP3 file on disk. */
export async function writeTrackTagsToFile(filePath, track) {
  if (!/\.mp3$/i.test(filePath)) throw new Error('Tag write-back currently supports MP3 files (ID3v2 + Serato GEOB)');
  const orig = await fs.promises.readFile(filePath);
  const patched = patchMp3Tags(orig, { bpm: track.bpm, key: track.key, cues: track.cues, color: track.color });
  const tmp = `${filePath}.opendj-tag.tmp`;
  await fs.promises.writeFile(tmp, patched);
  await fs.promises.rename(tmp, filePath);
  return { ok: true, bytes: patched.length };
}
