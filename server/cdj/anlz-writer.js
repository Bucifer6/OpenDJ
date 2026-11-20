// ANLZ0000.DAT / .EXT / .2EX writer (rekordbox track analysis files read by CDJs / XDJs).
//
// Big-endian "PMAI" files made of tagged sections (Deep Symmetry analysis + rekordbox_anlz.ksy).
// Tag sets and order follow rekordbox 6 exports:
//   .DAT  PPTH PVBR PQTZ PWAV PWV2 PCOB(hot) PCOB(memory)            — every player (CDJ-900/2000 and up)
//   .EXT  PPTH PWV3 PCOB PCOB PCO2(hot) PCO2(memory) PWV5 PWV4 [PSSI] — nexus 2 and newer (colour, 8 hot cues)
//   .2EX  PPTH PWV7 PWV6 PWVC                                         — CDJ-3000 three-band waveforms (optional)

const FILE_HEADER_TAIL = [0x00000001, 0x00010000, 0x00010000, 0x00000000]; // as written by rekordbox

/** XOR pattern rekordbox 6 applies to PSSI bodies (added to len_entries per byte). */
export const PSSI_MASK = Buffer.from('cbe1eefae5eeadeee9d2e9ebe1e9f3e8e9f4e1', 'hex');

function be32(...v) { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeUInt32BE(x >>> 0, 4 * i)); return b; }
function be16(...v) { const b = Buffer.alloc(2 * v.length); v.forEach((x, i) => b.writeUInt16BE(x & 0xffff, 2 * i)); return b; }
const clampU32 = (v) => Math.max(0, Math.min(0xffffffff, Math.round(Number(v) || 0)));

/** A tagged section: fourcc, len_header, len_tag, header fields, body. */
function section(fourcc, header, body = Buffer.alloc(0)) {
  const lenHeader = 12 + header.length;
  const out = Buffer.alloc(lenHeader + body.length);
  out.write(fourcc, 0, 'latin1');
  out.writeUInt32BE(lenHeader, 4);
  out.writeUInt32BE(out.length, 8);
  header.copy(out, 12);
  body.copy(out, lenHeader);
  return out;
}

function file(sections) {
  const body = Buffer.concat(sections);
  const head = Buffer.alloc(0x1c);
  head.write('PMAI', 0, 'latin1');
  head.writeUInt32BE(0x1c, 4);
  head.writeUInt32BE(0x1c + body.length, 8);
  FILE_HEADER_TAIL.forEach((v, i) => head.writeUInt32BE(v, 12 + 4 * i));
  return Buffer.concat([head, body]);
}

function utf16be(s) {
  const le = Buffer.from(String(s), 'utf16le');
  for (let i = 0; i + 1 < le.length; i += 2) { const x = le[i]; le[i] = le[i + 1]; le[i + 1] = x; }
  return le;
}
const nulTerminated = (s) => Buffer.concat([utf16be(s), Buffer.alloc(2)]);

export function ppth(path) { const p = nulTerminated(path); return section('PPTH', be32(p.length), p); }

/** PVBR: rekordbox writes a zero seek index for CBR files and the total sample count in the last word. */
export function pvbr(totalSamples = 0) {
  const body = Buffer.alloc(401 * 4);
  body.writeUInt32BE(clampU32(totalSamples), 400 * 4);
  return section('PVBR', be32(0), body);
}

/** PQTZ beat grid. beats: [{ beat 1..4, tempo (BPM×100), time (ms) }] */
export function pqtz(beats) {
  const body = Buffer.alloc(beats.length * 8);
  beats.forEach((b, i) => { body.writeUInt16BE(b.beat, i * 8); body.writeUInt16BE(b.tempo, i * 8 + 2); body.writeUInt32BE(clampU32(b.time), i * 8 + 4); });
  return section('PQTZ', be32(0, 0x00080000, beats.length), body);
}

export function pwav(data400) { return section('PWAV', be32(data400.length, 0x00010000), Buffer.from(data400)); }
export function pwv2(data100) { return section('PWV2', be32(data100.length, 0x00010000), Buffer.from(data100)); }
export function pwv3(scroll) { return section('PWV3', be32(1, scroll.length, 0x00960000), Buffer.from(scroll)); }
export function pwv4(colorPreview) { return section('PWV4', be32(6, colorPreview.length / 6, 0), Buffer.from(colorPreview)); }
export function pwv5(colorScroll) {
  const body = Buffer.alloc(colorScroll.length * 2);
  colorScroll.forEach((v, i) => body.writeUInt16BE(v, i * 2));
  return section('PWV5', be32(2, colorScroll.length, 0x00960305), body);
}
export function pwv6(bands) { return section('PWV6', be32(3, bands.length / 3), Buffer.from(bands)); }
export function pwv7(bands) { return section('PWV7', be32(3, bands.length / 3, 0x00960000), Buffer.from(bands)); }
export function pwvc(values = [0, 0, 0]) { return section('PWVC', be16(0), be16(...values)); }

/**
 * Cue model shared by PCOB and PCO2:
 *   { hotCue: 0 (memory) | 1..8, type: 1 point | 2 loop, time ms, loopTime ms?, colorId 0..8 (memory cues),
 *     comment, colorCode 0..0x3e (hot cues), rgb: [r,g,b], loopNumerator, loopDenominator }
 */
export function pcob(listType, cues) {
  const sorted = [...cues].sort((a, b) => a.time - b.time);
  const entries = sorted.map((c, i) => {
    const e = Buffer.alloc(0x38);
    e.write('PCPT', 0, 'latin1');
    e.writeUInt32BE(0x1c, 4); e.writeUInt32BE(0x38, 8);
    e.writeUInt32BE(c.hotCue || 0, 0x0c);
    e.writeUInt32BE(0, 0x10);               // status (4 = active loop)
    e.writeUInt32BE(0x00010000, 0x14);
    e.writeUInt16BE(i === 0 ? 0xffff : i - 1, 0x18);                  // order_first: previous entry
    e.writeUInt16BE(i === sorted.length - 1 ? 0xffff : i + 1, 0x1a);  // order_last: next entry
    e[0x1c] = c.type === 2 ? 2 : 1;
    e[0x1d] = 0; e.writeUInt16BE(1000, 0x1e);
    e.writeUInt32BE(clampU32(c.time), 0x20);
    e.writeUInt32BE(c.type === 2 ? clampU32(c.loopTime) : 0xffffffff, 0x24);
    return e;
  });
  return section('PCOB', Buffer.concat([be32(listType), be16(0, entries.length), be32(0xffffffff)]), Buffer.concat(entries));
}

export function pco2(listType, cues) {
  const sorted = [...cues].sort((a, b) => (a.hotCue || 0) - (b.hotCue || 0) || a.time - b.time);
  const entries = sorted.map((c) => {
    const comment = c.comment ? nulTerminated(c.comment) : Buffer.alloc(0); // rekordbox: length 0 when there is no comment
    const e = Buffer.alloc(0x2c + comment.length + 4 + 20);
    e.write('PCP2', 0, 'latin1');
    e.writeUInt32BE(0x10, 4); e.writeUInt32BE(e.length, 8);
    e.writeUInt32BE(c.hotCue || 0, 0x0c);
    e[0x10] = c.type === 2 ? 2 : 1;
    e[0x11] = 0; e.writeUInt16BE(1000, 0x12);
    e.writeUInt32BE(clampU32(c.time), 0x14);
    e.writeUInt32BE(c.type === 2 ? clampU32(c.loopTime) : 0xffffffff, 0x18);
    e[0x1c] = c.hotCue ? 0 : (c.colorId || 0);
    e[0x1d] = 1;
    e.writeUInt16BE(c.loopNumerator || 0, 0x24);
    e.writeUInt16BE(c.loopDenominator || 0, 0x26);
    e.writeUInt32BE(comment.length, 0x28);
    comment.copy(e, 0x2c);
    const o = 0x2c + comment.length;
    if (c.hotCue && c.colorCode) { e[o] = c.colorCode; e[o + 1] = c.rgb?.[0] || 0; e[o + 2] = c.rgb?.[1] || 0; e[o + 3] = c.rgb?.[2] || 0; }
    return e;
  });
  return section('PCO2', Buffer.concat([be32(listType), be16(entries.length, 0)]), Buffer.concat(entries));
}

/**
 * PSSI song structure, masked the way rekordbox 6 exports it.
 * s: { mood 1 high | 2 mid | 3 low, endBeat, bank, entries: [{ beat, kind, k1, k2, k3, fill, beatFill }] }
 */
export function pssi(s, { mask = true } = {}) {
  const n = s.entries.length;
  const body = Buffer.alloc(14 + n * 24); // from the mood field on
  body.writeUInt16BE(s.mood, 0);
  body.writeUInt16BE(s.endBeat || 0, 8);
  body[10] = 1; // observed as 0x0100 in rekordbox exports
  body[12] = s.bank || 0;
  s.entries.forEach((e, i) => {
    const o = 14 + i * 24;
    body.writeUInt16BE(i + 1, o);
    body.writeUInt16BE(e.beat, o + 2);
    body.writeUInt16BE(e.kind, o + 4);
    body[o + 7] = e.k1 || 0; body[o + 9] = e.k2 || 0; body[o + 0x13] = e.k3 || 0;
    body[o + 0x15] = e.fill ? 1 : 0; body.writeUInt16BE(e.fill ? e.beatFill || 0 : 0, o + 0x16);
  });
  if (mask) for (let i = 0; i < body.length; i++) body[i] ^= (PSSI_MASK[i % PSSI_MASK.length] + n) & 0xff;
  // len_header 0x20 covers the mood/end_beat/bank fields, which therefore sit in the "header" part
  const header = Buffer.concat([be32(24), be16(n), body.subarray(0, 14)]);
  return section('PSSI', header, body.subarray(14));
}

/**
 * Build the analysis files of one track.
 * @param {object} a  { path, totalSamples, beats, hotCues, memoryCues, waveforms: { preview, tiny, scroll, colorPreview,
 *                      colorScroll, threeBandPreview?, threeBandScroll?, threeBandScale? }, phrases? }
 * @returns {{ dat: Buffer, ext: Buffer, twoEx: Buffer|null }}
 */
export function buildAnlz(a, { twoEx = false } = {}) {
  const w = a.waveforms || {};
  const oldHot = (a.hotCues || []).filter((c) => c.hotCue >= 1 && c.hotCue <= 3); // pre-nxs2 players: A–C only
  const dat = file([
    ppth(a.path), pvbr(a.totalSamples), pqtz(a.beats || []),
    pwav(w.preview || new Uint8Array(400)), pwv2(w.tiny || new Uint8Array(100)),
    pcob(1, oldHot), pcob(0, a.memoryCues || []),
  ]);
  const ext = file([
    ppth(a.path), pwv3(w.scroll || new Uint8Array(0)),
    pcob(1, oldHot), pcob(0, a.memoryCues || []),
    pco2(1, a.hotCues || []), pco2(0, a.memoryCues || []),
    pwv5(w.colorScroll || new Uint16Array(0)), pwv4(w.colorPreview || new Uint8Array(7200)),
    ...(a.phrases?.entries?.length ? [pssi(a.phrases)] : []),
  ]);
  const two = twoEx && w.threeBandScroll ? file([
    ppth(a.path), pwv7(w.threeBandScroll), pwv6(w.threeBandPreview || new Uint8Array(3600)), pwvc(w.threeBandScale),
  ]) : null;
  return { dat, ext, twoEx: two };
}
