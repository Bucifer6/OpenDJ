// export.pdb (DeviceSQL) writer for Pioneer CDJ / XDJ USB exports.
//
// Written from the community reverse-engineering documentation (Deep Symmetry, "rekordbox Export Structure
// Analysis" and the Kaitai spec rekordbox_pdb.ksy) and checked against exports written by rekordbox itself.
// The page layout mirrors what rekordbox produces for a fresh export:
//   page 0          file header: len_page, table count, next unused page, sequence, 20 table pointers
//   per table       an index page (flags 0x64, no index entries) followed by the table's data pages
//                   (flags 0x24); an empty table gets a zero-filled "empty candidate" page right after its
//                   index page, a filled table gets its candidate after the end of the file
//   data pages      4096 bytes: 40-byte header, rows from 0x28 upwards (4-byte aligned), row index
//                   (groups of 16 offsets + presence flags + transaction flags) from the end downwards.
// All multi-byte numbers are little-endian.
import { encodeString, isLongString } from './devicesql.js';
import { T, TABLE_COUNT, COLORS, COLUMNS, MENU17, MENU18, historyRow } from './pdb-static.js';

export const PAGE_SIZE = 4096;
const HEAP = 0x28;                       // first heap byte in a data page
const HEAP_SPACE = PAGE_SIZE - HEAP;     // 4056: heap + row index
const MAX_ROWS_PER_PAGE = 255;           // keeps the legacy "num_rows_small" byte exact for older parsers

/** The 21 string slots at the end of a track row, in order (Kaitai track_row.ofs_strings). */
export const TRACK_STRINGS = ['isrc', 'lyricist', 'unknown2', 'unknown3', 'unknown4', 'message', 'publishTrackInfo',
  'autoloadHotcues', 'unknown5', 'unknown6', 'dateAdded', 'releaseDate', 'mixName', 'unknown7', 'analyzePath',
  'analyzeDate', 'comment', 'title', 'unknown8', 'filename', 'filePath'];

/** Defaults for track row fields whose meaning is unknown, as seen in rekordbox exports. */
export const TRACK_DEFAULTS = { bitmask: 0x000c0700, u3: 0xfa80, u4: 0x05e7, u5: 0x29, u7: 3, unknown2: '3', unknown3: '3', autoloadHotcues: 'ON' };

const u8 = (v) => Math.max(0, Math.min(0xff, Math.round(Number(v) || 0)));
const u16 = (v) => Math.max(0, Math.min(0xffff, Math.round(Number(v) || 0)));
const u32 = (v) => Math.max(0, Math.min(0xffffffff, Math.round(Number(v) || 0)));
const align4 = (n) => (n + 3) & ~3;

// ---------------------------------------------------------------- row encoders
// Each returns { buf, ishift } where ishift = this row type stores index_shift at bytes 2-3.

/** Fixed part + strings, with long strings placed on 4-byte boundaries (as rekordbox does). */
function placeStrings(fixedLen, strings) {
  const parts = []; const offsets = []; let pos = fixedLen;
  for (const s of strings) {
    const b = encodeString(s);
    if (isLongString(b) && pos % 4) { parts.push(Buffer.alloc(4 - (pos % 4))); pos = align4(pos); }
    offsets.push(pos); parts.push(b); pos += b.length;
  }
  return { offsets, tail: Buffer.concat(parts), end: pos };
}

export function encodeTrackRow(t) {
  const r = { ...TRACK_DEFAULTS, ...t };
  const strings = TRACK_STRINGS.map((k) => r[k] ?? '');
  const { offsets, tail } = placeStrings(0x88, strings);
  if (offsets.at(-1) > 0xffff) throw new Error('track row too large');
  const b = Buffer.alloc(0x88 + tail.length);
  b.writeUInt16LE(0x24, 0x00);                 // subtype: 16-bit string offsets
  b.writeUInt32LE(u32(r.bitmask), 0x04);
  b.writeUInt32LE(u32(r.sampleRate), 0x08);
  b.writeUInt32LE(u32(r.composerId), 0x0c);
  b.writeUInt32LE(u32(r.fileSize), 0x10);
  b.writeUInt32LE(u32(r.u2), 0x14);
  b.writeUInt16LE(u16(r.u3), 0x18);
  b.writeUInt16LE(u16(r.u4), 0x1a);
  b.writeUInt32LE(u32(r.artworkId), 0x1c);
  b.writeUInt32LE(u32(r.keyId), 0x20);
  b.writeUInt32LE(u32(r.originalArtistId), 0x24);
  b.writeUInt32LE(u32(r.labelId), 0x28);
  b.writeUInt32LE(u32(r.remixerId), 0x2c);
  b.writeUInt32LE(u32(r.bitrate), 0x30);
  b.writeUInt32LE(u32(r.trackNumber), 0x34);
  b.writeUInt32LE(u32(r.tempo), 0x38);          // BPM × 100
  b.writeUInt32LE(u32(r.genreId), 0x3c);
  b.writeUInt32LE(u32(r.albumId), 0x40);
  b.writeUInt32LE(u32(r.artistId), 0x44);
  b.writeUInt32LE(u32(r.id), 0x48);
  b.writeUInt16LE(u16(r.discNumber), 0x4c);
  b.writeUInt16LE(u16(r.playCount), 0x4e);
  b.writeUInt16LE(u16(r.year), 0x50);
  b.writeUInt16LE(u16(r.sampleDepth), 0x52);
  b.writeUInt16LE(u16(r.duration), 0x54);       // seconds
  b.writeUInt16LE(u16(r.u5), 0x56);
  b[0x58] = u8(r.colorId);
  b[0x59] = u8(r.rating);
  b.writeUInt16LE(u16(r.fileType), 0x5a);
  b.writeUInt16LE(u16(r.u7), 0x5c);
  offsets.forEach((o, i) => b.writeUInt16LE(o, 0x5e + 2 * i));
  tail.copy(b, 0x88);
  return { buf: b, ishift: true };
}

const idName = (id, name) => Buffer.concat([u32le(id), encodeString(name)]);
function u32le(v) { const b = Buffer.alloc(4); b.writeUInt32LE(u32(v)); return b; }

export const encodeGenreRow = (g) => ({ buf: idName(g.id, g.name) });
export const encodeLabelRow = (l) => ({ buf: idName(l.id, l.name) });
export const encodeArtworkRow = (a) => ({ buf: idName(a.id, a.path) });
export const encodeHistoryPlaylistRow = (h) => ({ buf: idName(h.id, h.name) });
export function encodeKeyRow(k) { return { buf: Buffer.concat([u32le(k.id), u32le(k.id2 ?? k.id), encodeString(k.name)]) }; }
export function encodeColorRow(c) {
  const b = Buffer.alloc(8); b[4] = u8(c.id); b.writeUInt16LE(u16(c.id), 5);
  return { buf: Buffer.concat([b, encodeString(c.name)]) };
}

/** Artist rows: subtype 0x60 (8-bit name offset) or 0x64 (16-bit, for long names). */
export function encodeArtistRow(a) {
  const name = encodeString(a.name);
  const far = name.length > 200;
  const nameAt = far ? 0x0c : (isLongString(name) ? 0x0c : 0x0a);
  const b = Buffer.alloc(nameAt + name.length);
  b.writeUInt16LE(far ? 0x64 : 0x60, 0);
  b.writeUInt32LE(u32(a.id), 4);
  if (far) { b.writeUInt16LE(3, 8); b.writeUInt16LE(nameAt, 0x0a); } else { b[8] = 3; b[9] = nameAt; }
  name.copy(b, nameAt);
  return { buf: b, ishift: true };
}

/** Album rows: subtype 0x80 (8-bit name offset) or 0x84 (16-bit). */
export function encodeAlbumRow(a) {
  const name = encodeString(a.name);
  const far = name.length > 200;
  const nameAt = far ? 0x18 : (isLongString(name) ? 0x18 : 0x16);
  const b = Buffer.alloc(nameAt + name.length);
  b.writeUInt16LE(far ? 0x84 : 0x80, 0);
  b.writeUInt32LE(u32(a.artistId), 0x08);
  b.writeUInt32LE(u32(a.id), 0x0c);
  if (far) { b.writeUInt16LE(3, 0x14); b.writeUInt16LE(nameAt, 0x16); } else { b[0x14] = 3; b[0x15] = nameAt; }
  name.copy(b, nameAt);
  return { buf: b, ishift: true };
}

export function encodePlaylistTreeRow(p) {
  const b = Buffer.alloc(0x14);
  b.writeUInt32LE(u32(p.parentId), 0x00);
  b.writeUInt32LE(u32(p.sortOrder), 0x08);
  b.writeUInt32LE(u32(p.id), 0x0c);
  b.writeUInt32LE(p.isFolder ? 1 : 0, 0x10);
  return { buf: Buffer.concat([b, encodeString(p.name)]) };
}
export function encodePlaylistEntryRow(e) {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(u32(e.entryIndex), 0); b.writeUInt32LE(u32(e.trackId), 4); b.writeUInt32LE(u32(e.playlistId), 8);
  return { buf: b };
}
export function encodeHistoryEntryRow(e) {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(u32(e.trackId), 0); b.writeUInt32LE(u32(e.playlistId), 4); b.writeUInt32LE(u32(e.entryIndex), 8);
  return { buf: b };
}
function encodeColumnRow([id, code, label]) {
  const text = Buffer.from(`￺${label}￻`, 'utf16le');
  const b = Buffer.alloc(8 + text.length);
  b.writeUInt16LE(id, 0); b.writeUInt16LE(code, 2);
  b[4] = 0x90; b.writeUInt16LE(text.length + 4, 5); b[7] = 0;
  text.copy(b, 8);
  return { buf: b };
}
function encodeU16x4(v) { const b = Buffer.alloc(8); v.forEach((x, i) => b.writeUInt16LE(x, 2 * i)); return { buf: b }; }

// ---------------------------------------------------------------- pages

const indexBytes = (n) => (n ? Math.ceil(n / 16) * 4 + n * 2 : 0);

/** Split encoded rows into pages that fit (heap grows up, row index grows down, never overlapping). */
function packRows(rows) {
  const pages = []; let cur = []; let used = 0;
  for (const r of rows) {
    const size = align4(r.buf.length);
    if (size + indexBytes(1) > HEAP_SPACE) throw new Error(`row of ${r.buf.length} bytes does not fit a page`);
    if (cur.length && (cur.length >= MAX_ROWS_PER_PAGE || used + size + indexBytes(cur.length + 1) > HEAP_SPACE)) {
      pages.push(cur); cur = []; used = 0;
    }
    cur.push(r); used += size;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

function dataPage({ index, type, next, seq, rows }) {
  const p = Buffer.alloc(PAGE_SIZE);
  const n = rows.length;
  const offsets = []; let used = 0;
  rows.forEach((r, i) => {
    const buf = r.buf;
    if (r.ishift) { buf.writeUInt16LE((i * 0x20) & 0xffff, 2); } // index_shift: row slot × 0x20
    offsets.push(used);
    buf.copy(p, HEAP + used);
    used += align4(buf.length);
  });
  p.writeUInt32LE(index, 0x04);
  p.writeUInt32LE(type, 0x08);
  p.writeUInt32LE(next, 0x0c);
  p.writeUInt32LE(seq, 0x10);
  const counts = (n & 0x1fff) | ((n & 0x7ff) << 13); // num_row_offsets (13 bits) | num_rows (11 bits)
  p[0x18] = counts & 0xff; p[0x19] = (counts >> 8) & 0xff; p[0x1a] = (counts >> 16) & 0xff;
  p[0x1b] = 0x24;                                     // data page, no deleted rows
  p.writeUInt16LE(HEAP_SPACE - used - indexBytes(n), 0x1c); // free_size
  p.writeUInt16LE(used, 0x1e);                         // used_size
  p.writeUInt16LE(n, 0x20);                            // transaction_row_count: all rows written in one go
  p.writeUInt16LE(0, 0x22);                            // transaction_row_index
  for (let g = 0; g * 16 < n; g++) {
    const base = PAGE_SIZE - g * 0x24;
    const inGroup = Math.min(16, n - g * 16);
    const mask = inGroup === 16 ? 0xffff : (1 << inGroup) - 1;
    p.writeUInt16LE(mask, base - 4); // row presence flags
    p.writeUInt16LE(mask, base - 2); // transaction row flags
    for (let k = 0; k < inGroup; k++) p.writeUInt16LE(offsets[g * 16 + k], base - 6 - 2 * k);
  }
  return p;
}

/** First page of every table: an (empty) index page, laid out like rekordbox's. */
function indexPage({ index, type, next, firstData, seq }) {
  const p = Buffer.alloc(PAGE_SIZE);
  p.writeUInt32LE(index, 0x04);
  p.writeUInt32LE(type, 0x08);
  p.writeUInt32LE(next, 0x0c);
  p.writeUInt32LE(seq, 0x10);
  p[0x1b] = 0x64;
  p.writeUInt16LE(0x1fff, 0x20); p.writeUInt16LE(0x1fff, 0x22); p.writeUInt16LE(0x03ec, 0x24); p.writeUInt16LE(0, 0x26);
  p.writeUInt32LE(index, 0x28); p.writeUInt32LE(firstData ?? 0x03ffffff, 0x2c); // rekordbox: 0x03ffffff when the table is empty
  p.writeUInt32LE(0x03ffffff, 0x30); p.writeUInt32LE(0, 0x34);
  p.writeUInt16LE(0, 0x38); p.writeUInt16LE(0x1fff, 0x3a);
  for (let o = 0x3c; o < 0xfec; o += 4) p.writeUInt32LE(0x1ffffff8, o); // 1004 empty index entries
  return p;
}

// ---------------------------------------------------------------- database

/**
 * Build an export.pdb.
 * @param {object} db rows per table (models as produced by pdb-reader.js):
 *   tracks, genres, artists, albums, labels, keys, artwork, playlistTree, playlistEntries,
 *   historyPlaylists, historyEntries; optional raw: { [tableType]: Buffer[] } for tables we only copy.
 * @param {object} [o]
 * @param {string} [o.date] YYYY-MM-DD (history sync row)
 * @returns {Buffer}
 */
export function buildPdb(db = {}, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const byId = (a) => [...(a || [])].sort((x, y) => x.id - y.id);
  const raw = (type) => (db.raw?.[type] || []).map((buf) => ({ buf }));
  const rowsFor = {
    [T.tracks]: byId(db.tracks).map(encodeTrackRow),
    [T.genres]: byId(db.genres).map(encodeGenreRow),
    [T.artists]: byId(db.artists).map(encodeArtistRow),
    [T.albums]: byId(db.albums).map(encodeAlbumRow),
    [T.labels]: byId(db.labels).map(encodeLabelRow),
    [T.keys]: byId(db.keys).map(encodeKeyRow),
    [T.colors]: COLORS.map(([id, name]) => encodeColorRow({ id, name })),
    [T.playlistTree]: byId(db.playlistTree).map(encodePlaylistTreeRow),
    [T.playlistEntries]: [...(db.playlistEntries || [])].sort((a, b) => a.playlistId - b.playlistId || a.entryIndex - b.entryIndex).map(encodePlaylistEntryRow),
    [T.unknown9]: raw(T.unknown9),
    [T.unknown10]: raw(T.unknown10),
    [T.historyPlaylists]: byId(db.historyPlaylists).map(encodeHistoryPlaylistRow),
    [T.historyEntries]: [...(db.historyEntries || [])].sort((a, b) => a.playlistId - b.playlistId || a.entryIndex - b.entryIndex).map(encodeHistoryEntryRow),
    [T.artwork]: byId(db.artwork).map(encodeArtworkRow),
    [T.unknown14]: raw(T.unknown14),
    [T.unknown15]: raw(T.unknown15),
    [T.columns]: COLUMNS.map(encodeColumnRow),
    [T.menu17]: MENU17.map(encodeU16x4),
    [T.menu18]: MENU18.map(encodeU16x4),
    [T.history]: db.raw?.[T.history]?.length ? raw(T.history) : [{ buf: historyRow(date) }],
  };

  // ---- allocate page numbers: index page, then data pages or a zero "empty candidate" page
  let nextPage = 1;
  const tables = [];
  for (let type = 0; type < TABLE_COUNT; type++) {
    const pages = packRows(rowsFor[type]);
    const t = { type, indexPage: nextPage++, dataPages: [], pages };
    if (pages.length) for (let i = 0; i < pages.length; i++) t.dataPages.push(nextPage++);
    else t.emptyCandidate = nextPage++; // physically present, all zero
    tables.push(t);
  }
  const physicalPages = nextPage;
  // candidates of filled tables lie past the end of the file; like rekordbox, the last filled table gets the
  // page right at the end, the others the pages after it
  const filled = tables.filter((t) => t.emptyCandidate == null);
  if (filled.length) filled.at(-1).emptyCandidate = nextPage++;
  for (const t of filled) if (t.emptyCandidate == null) t.emptyCandidate = nextPage++;
  const nextUnused = nextPage;

  // ---- write
  const out = Buffer.alloc(physicalPages * PAGE_SIZE);
  let seq = 1;
  for (const t of tables) {
    const chain = [t.indexPage, ...t.dataPages];
    const nextOf = (i) => (i + 1 < chain.length ? chain[i + 1] : t.emptyCandidate);
    indexPage({ index: t.indexPage, type: t.type, next: nextOf(0), firstData: t.dataPages[0], seq: 1 }).copy(out, t.indexPage * PAGE_SIZE);
    t.pages.forEach((rows, i) => {
      dataPage({ index: t.dataPages[i], type: t.type, next: nextOf(i + 1), seq: ++seq, rows }).copy(out, t.dataPages[i] * PAGE_SIZE);
    });
  }
  out.writeUInt32LE(0, 0x00);
  out.writeUInt32LE(PAGE_SIZE, 0x04);
  out.writeUInt32LE(TABLE_COUNT, 0x08);
  out.writeUInt32LE(nextUnused, 0x0c);
  out.writeUInt32LE(5, 0x10);           // unknown, 5 in every rekordbox export seen
  out.writeUInt32LE(seq + 1, 0x14);     // sequence: the "next" page sequence number
  out.writeUInt32LE(0, 0x18);
  tables.forEach((t, i) => {
    const o = 0x1c + 16 * i;
    out.writeUInt32LE(t.type, o);
    out.writeUInt32LE(t.emptyCandidate, o + 4);
    out.writeUInt32LE(t.indexPage, o + 8);
    out.writeUInt32LE(t.dataPages.at(-1) ?? t.indexPage, o + 12);
  });
  return out;
}
