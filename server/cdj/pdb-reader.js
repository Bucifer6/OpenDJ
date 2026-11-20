// export.pdb reader / validator. Follows the Kaitai spec (rekordbox_pdb.ksy) and the Deep Symmetry analysis
// field by field, independently of pdb-writer.js, so it can check our own output and read exports written by
// rekordbox (used for "update existing export"). Throws on structurally broken files; softer problems are
// collected in `problems`.
import { decodeString } from './devicesql.js';
import { T } from './pdb-static.js';
import { TRACK_STRINGS } from './pdb-writer.js';

const TYPE_NAMES = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

function readRows(buf, pageOff, pageSize, problems, where) {
  const counts = buf[pageOff + 0x18] | (buf[pageOff + 0x19] << 8) | (buf[pageOff + 0x1a] << 16);
  const numOffsets = counts & 0x1fff;
  const numRows = counts >>> 13;
  const rows = [];
  if (!numOffsets) return { rows, numOffsets, numRows };
  const groups = Math.floor((numOffsets - 1) / 16) + 1;
  let present = 0;
  for (let g = 0; g < groups; g++) {
    const base = pageOff + pageSize - g * 0x24;
    const flags = buf.readUInt16LE(base - 4);
    for (let k = 0; k < 16 && g * 16 + k < numOffsets; k++) {
      if (!((flags >> k) & 1)) continue;
      const ofs = buf.readUInt16LE(base - 6 - 2 * k);
      const at = pageOff + 0x28 + ofs;
      if (at >= pageOff + pageSize) { problems.push(`${where}: row ${g * 16 + k} offset ${ofs} outside page`); continue; }
      rows.push({ slot: g * 16 + k, at });
      present++;
    }
  }
  if (present !== numRows) problems.push(`${where}: ${present} rows flagged present but num_rows says ${numRows}`);
  return { rows, numOffsets, numRows };
}

const str = (buf, at) => decodeString(buf, at).text;

const ROW = {
  [T.tracks](b, a) {
    const ofs = (i) => b.readUInt16LE(a + 0x5e + 2 * i);
    const r = {
      subtype: b.readUInt16LE(a), indexShift: b.readUInt16LE(a + 2), bitmask: b.readUInt32LE(a + 4),
      sampleRate: b.readUInt32LE(a + 0x08), composerId: b.readUInt32LE(a + 0x0c), fileSize: b.readUInt32LE(a + 0x10),
      u2: b.readUInt32LE(a + 0x14), u3: b.readUInt16LE(a + 0x18), u4: b.readUInt16LE(a + 0x1a),
      artworkId: b.readUInt32LE(a + 0x1c), keyId: b.readUInt32LE(a + 0x20), originalArtistId: b.readUInt32LE(a + 0x24),
      labelId: b.readUInt32LE(a + 0x28), remixerId: b.readUInt32LE(a + 0x2c), bitrate: b.readUInt32LE(a + 0x30),
      trackNumber: b.readUInt32LE(a + 0x34), tempo: b.readUInt32LE(a + 0x38), genreId: b.readUInt32LE(a + 0x3c),
      albumId: b.readUInt32LE(a + 0x40), artistId: b.readUInt32LE(a + 0x44), id: b.readUInt32LE(a + 0x48),
      discNumber: b.readUInt16LE(a + 0x4c), playCount: b.readUInt16LE(a + 0x4e), year: b.readUInt16LE(a + 0x50),
      sampleDepth: b.readUInt16LE(a + 0x52), duration: b.readUInt16LE(a + 0x54), u5: b.readUInt16LE(a + 0x56),
      colorId: b[a + 0x58], rating: b[a + 0x59], fileType: b.readUInt16LE(a + 0x5a), u7: b.readUInt16LE(a + 0x5c),
    };
    TRACK_STRINGS.forEach((k, i) => { r[k] = str(b, a + ofs(i)); });
    return r;
  },
  [T.genres]: (b, a) => ({ id: b.readUInt32LE(a), name: str(b, a + 4) }),
  [T.labels]: (b, a) => ({ id: b.readUInt32LE(a), name: str(b, a + 4) }),
  [T.artwork]: (b, a) => ({ id: b.readUInt32LE(a), path: str(b, a + 4) }),
  [T.historyPlaylists]: (b, a) => ({ id: b.readUInt32LE(a), name: str(b, a + 4) }),
  [T.keys]: (b, a) => ({ id: b.readUInt32LE(a), id2: b.readUInt32LE(a + 4), name: str(b, a + 8) }),
  [T.colors]: (b, a) => ({ id: b.readUInt16LE(a + 5), name: str(b, a + 8) }),
  [T.artists](b, a) {
    const subtype = b.readUInt16LE(a);
    const ofs = subtype & 4 ? b.readUInt16LE(a + 0x0a) : b[a + 9];
    return { subtype, indexShift: b.readUInt16LE(a + 2), id: b.readUInt32LE(a + 4), name: str(b, a + ofs) };
  },
  [T.albums](b, a) {
    const subtype = b.readUInt16LE(a);
    const ofs = subtype & 4 ? b.readUInt16LE(a + 0x16) : b[a + 0x15];
    return { subtype, indexShift: b.readUInt16LE(a + 2), artistId: b.readUInt32LE(a + 8), id: b.readUInt32LE(a + 0x0c), name: str(b, a + ofs) };
  },
  [T.playlistTree]: (b, a) => ({ parentId: b.readUInt32LE(a), sortOrder: b.readUInt32LE(a + 8), id: b.readUInt32LE(a + 0x0c), isFolder: b.readUInt32LE(a + 0x10) !== 0, name: str(b, a + 0x14) }),
  [T.playlistEntries]: (b, a) => ({ entryIndex: b.readUInt32LE(a), trackId: b.readUInt32LE(a + 4), playlistId: b.readUInt32LE(a + 8) }),
  [T.historyEntries]: (b, a) => ({ trackId: b.readUInt32LE(a), playlistId: b.readUInt32LE(a + 4), entryIndex: b.readUInt32LE(a + 8) }),
  [T.columns](b, a) {
    const s = decodeString(b, a + 4).text;
    return { id: b.readUInt16LE(a), code: b.readUInt16LE(a + 2), name: s.replace(/^￺|￻$/g, '') };
  },
  [T.menu17]: (b, a) => ({ values: [0, 2, 4, 6].map((o) => b.readUInt16LE(a + o)) }),
  [T.menu18]: (b, a) => ({ values: [0, 2, 4, 6].map((o) => b.readUInt16LE(a + o)) }),
};

/**
 * Parse an export.pdb buffer.
 * @returns {{ pageSize, numTables, nextUnusedPage, sequence, tables: object[], rows: Record<string, object[]>, raw: Record<number, Buffer[]>, problems: string[] }}
 */
export function readPdb(buf, { strict = false } = {}) {
  if (buf.length < 0x1c) throw new Error('export.pdb too short');
  if (buf.readUInt32LE(0) !== 0) throw new Error('export.pdb: first word is not 0');
  const pageSize = buf.readUInt32LE(4);
  if (![512, 1024, 2048, 4096, 8192, 16384].includes(pageSize)) throw new Error(`export.pdb: odd page size ${pageSize}`);
  const numTables = buf.readUInt32LE(8);
  if (numTables > 64 || 0x1c + numTables * 16 > pageSize) throw new Error(`export.pdb: bad table count ${numTables}`);
  const out = {
    pageSize, numTables, nextUnusedPage: buf.readUInt32LE(0x0c), unknown: buf.readUInt32LE(0x10), sequence: buf.readUInt32LE(0x14),
    tables: [], rows: {}, raw: {}, problems: [],
  };
  const P = out.problems;
  const filePages = Math.floor(buf.length / pageSize);
  if (buf.length % pageSize) P.push(`file size ${buf.length} is not a multiple of the page size`);
  for (let i = 0; i < numTables; i++) {
    const o = 0x1c + 16 * i;
    const t = { type: buf.readUInt32LE(o), emptyCandidate: buf.readUInt32LE(o + 4), firstPage: buf.readUInt32LE(o + 8), lastPage: buf.readUInt32LE(o + 12), pages: [] };
    out.tables.push(t);
    const name = TYPE_NAMES[t.type] || `type${t.type}`;
    const rows = (out.rows[name] ||= []);
    const raw = (out.raw[t.type] ||= []);
    if (t.emptyCandidate < filePages && buf.subarray(t.emptyCandidate * pageSize, (t.emptyCandidate + 1) * pageSize).some((x) => x)) {
      P.push(`${name}: empty candidate page ${t.emptyCandidate} is not empty`);
    }
    if (t.emptyCandidate >= out.nextUnusedPage) P.push(`${name}: empty candidate ${t.emptyCandidate} >= next_unused_page`);
    let page = t.firstPage; const seen = new Set();
    for (;;) {
      if (page >= filePages) throw new Error(`${name}: page ${page} beyond end of file`);
      if (seen.has(page)) throw new Error(`${name}: page chain loops at ${page}`);
      seen.add(page);
      const po = page * pageSize;
      const where = `${name} page ${page}`;
      if (buf.readUInt32LE(po) !== 0) P.push(`${where}: first word not 0`);
      if (buf.readUInt32LE(po + 4) !== page) P.push(`${where}: page_index ${buf.readUInt32LE(po + 4)} != ${page}`);
      if (buf.readUInt32LE(po + 8) !== t.type) P.push(`${where}: type ${buf.readUInt32LE(po + 8)} != ${t.type}`);
      const next = buf.readUInt32LE(po + 0x0c);
      const flags = buf[po + 0x1b];
      const pg = { index: page, next, flags, seq: buf.readUInt32LE(po + 0x10), free: buf.readUInt16LE(po + 0x1c), used: buf.readUInt16LE(po + 0x1e) };
      t.pages.push(pg);
      if (flags & 0x40) {
        if (buf.readUInt16LE(po + 0x24) !== 0x03ec) P.push(`${where}: index page magic missing`);
      } else {
        const r = readRows(buf, po, pageSize, P, where);
        Object.assign(pg, { numOffsets: r.numOffsets, numRows: r.numRows });
        const ib = r.numOffsets ? Math.ceil(r.numOffsets / 16) * 4 + r.numOffsets * 2 : 0;
        if (pg.used + pg.free + ib > pageSize - 0x28) P.push(`${where}: used ${pg.used} + free ${pg.free} + index ${ib} exceed the page`);
        if (0x28 + pg.used > pageSize - ib) P.push(`${where}: heap overlaps row index`);
        const ends = r.rows.map((x) => x.at - po).sort((a, b) => a - b);
        if (ends.length && ends.at(-1) >= 0x28 + pg.used) P.push(`${where}: a row starts beyond used_size`);
        for (const { at, slot } of r.rows) {
          const dec = ROW[t.type];
          try {
            if (dec) { const row = dec(buf, at); rows.push(row); } else raw.push(rawRow(buf, at, po, r.rows, pageSize, ib));
          } catch (e) { P.push(`${where} row ${slot}: ${e.message}`); if (strict) throw e; }
        }
      }
      if (page === t.lastPage) {
        if (next !== t.emptyCandidate && next < filePages && t.type < 20) P.push(`${name}: last page links to ${next}, not the empty candidate ${t.emptyCandidate}`);
        break;
      }
      if (next >= filePages) throw new Error(`${name}: chain leaves the file at page ${page} before last_page ${t.lastPage}`);
      page = next;
    }
  }
  if (out.nextUnusedPage < filePages) P.push(`next_unused_page ${out.nextUnusedPage} < file pages ${filePages}`);
  if (strict && P.length) throw new Error(`export.pdb problems:\n${P.join('\n')}`);
  return out;
}

/** Rows of tables we do not model are kept as raw bytes (up to the next row start / the heap end). */
function rawRow(buf, at, po, all, pageSize, ib) {
  const starts = all.map((x) => x.at).filter((x) => x > at).sort((a, b) => a - b);
  const end = starts[0] ?? po + 0x28 + buf.readUInt16LE(po + 0x1e);
  return Buffer.from(buf.subarray(at, Math.min(end, po + pageSize - ib)));
}

/** Convenience: parsed database as plain arrays + lookups. */
export function readExportDb(buf, opts) {
  const p = readPdb(buf, opts);
  const r = p.rows;
  return {
    ...p,
    tracks: r.tracks || [], genres: r.genres || [], artists: r.artists || [], albums: r.albums || [], labels: r.labels || [],
    keys: r.keys || [], colors: r.colors || [], artwork: r.artwork || [], playlistTree: r.playlistTree || [],
    playlistEntries: r.playlistEntries || [], historyPlaylists: r.historyPlaylists || [], historyEntries: r.historyEntries || [],
  };
}
