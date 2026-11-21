// Import collections from other DJ apps: Traktor (collection.nml), Serato (_Serato_/Subcrates/*.crate) and VirtualDJ (database.xml).
// Parsers are pure (string/buffer in, plain objects out); `importParsed` adds the tracks that exist on disk to the library.
import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { NOTE_NAMES } from './smart.js';
import { mergeImportedCues } from '../public/js/shared/cues.js';

export { mergeImportedCues };

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const num = (v, fb = null) => { if (v === undefined || v === null || v === '') return fb; const n = Number(v); return Number.isFinite(n) ? n : fb; };

function xmlParser(arrayTags) {
  return new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, parseTagValue: false,
    trimValues: true, processEntities: true, htmlEntities: true, isArray: (name) => arrayTags.has(name),
  });
}

// ---------------------------------------------------------------- Traktor NML

/** Traktor MUSICAL_KEY value (0-23) -> key name. 0-11 major C..B, 12-23 minor Cm..Bm. */
export function traktorKey(v) {
  const n = num(v);
  if (n == null || n < 0 || n > 23) return null;
  return NOTE_NAMES[n % 12] + (n >= 12 ? 'm' : '');
}

/** Traktor LOCATION (VOLUME + DIR "/:Users/:me/:Music/:" + FILE) -> candidate absolute paths, most likely first. */
export function traktorPaths(loc) {
  if (!loc) return [];
  const dir = String(loc.DIR || '').split('/:').join('/');
  const file = String(loc.FILE || '');
  const vol = String(loc.VOLUME || '');
  const rel = (dir.endsWith('/') ? dir : dir + '/') + file;
  if (/^[A-Za-z]:$/.test(vol)) return [vol + rel.replace(/\//g, '\\')];
  const out = [rel.startsWith('/') ? rel : '/' + rel];
  if (vol) out.push(path.posix.join('/Volumes', vol, rel)); // macOS external drive
  return out;
}
/** The key Traktor uses in playlists: VOLUME + DIR + FILE. */
const traktorPrimaryKey = (loc) => `${loc?.VOLUME || ''}${loc?.DIR || ''}${loc?.FILE || ''}`;

export function parseTraktorNml(xml) {
  const doc = xmlParser(new Set(['ENTRY', 'CUE_V2', 'NODE'])).parse(xml);
  const root = doc?.NML;
  if (!root) throw new Error('Not a Traktor collection (missing NML root)');
  const tracks = [];
  const byKey = new Map();
  for (const e of asArray(root.COLLECTION?.ENTRY)) {
    const loc = asArray(e.LOCATION)[0];
    if (!loc) continue;
    const info = asArray(e.INFO)[0] || {};
    const cues = [];
    let gridOffset = null;
    for (const c of asArray(e.CUE_V2)) {
      const type = num(c.TYPE, 0), start = num(c.START, 0) / 1000, len = num(c.LEN, 0) / 1000, hot = num(c.HOTCUE, -1);
      if (type === 4) { if (gridOffset == null) gridOffset = start; continue; } // beat grid marker
      if (type !== 0 && type !== 5) continue; // fade-in/out, load markers
      const cue = { type: hot >= 0 ? 'hot' : 'memory', index: hot >= 0 ? hot : -1, position: start, name: c.NAME && c.NAME !== 'n.n.' ? c.NAME : '' };
      if (type === 5 && len > 0) cue.loopEnd = start + len;
      if (hot >= 0 && hot > 7) continue;
      cues.push(cue);
    }
    const ranking = num(info.RANKING, 0);
    const t = {
      paths: traktorPaths(loc), key: traktorKey(asArray(e.MUSICAL_KEY)[0]?.VALUE) || info.KEY || '',
      title: e.TITLE || '', artist: e.ARTIST || '', album: asArray(e.ALBUM)[0]?.TITLE || '',
      genre: info.GENRE || '', comment: info.COMMENT || '', bpm: num(asArray(e.TEMPO)[0]?.BPM),
      rating: Math.max(0, Math.min(5, Math.round(ranking / 51))), playCount: num(info.PLAYCOUNT, 0),
      cues, gridOffset,
    };
    tracks.push(t);
    byKey.set(traktorPrimaryKey(loc), t);
  }
  const playlists = [];
  const walk = (node, folder) => {
    for (const n of asArray(node)) {
      if (n.TYPE === 'FOLDER') {
        const name = n.NAME === '$ROOT' ? null : n.NAME;
        walk(n.SUBNODES?.NODE, name ? [...folder, name] : folder);
      } else if (n.TYPE === 'PLAYLIST') {
        const entries = asArray(n.PLAYLIST?.ENTRY);
        const items = entries.map((x) => byKey.get(asArray(x.PRIMARYKEY)[0]?.KEY)).filter(Boolean);
        playlists.push({ name: n.NAME || 'Playlist', path: folder, tracks: items });
      }
    }
  };
  walk(root.PLAYLISTS?.NODE, []);
  return { tracks, playlists };
}

// ---------------------------------------------------------------- Serato crates

/** Iterate big-endian tag/length records: 4-byte ASCII tag, uint32 length, payload. */
function* seratoRecords(buf, start = 0, end = buf.length) {
  let o = start;
  while (o + 8 <= end) {
    const tag = buf.toString('latin1', o, o + 4);
    const len = buf.readUInt32BE(o + 4);
    const s = o + 8, e = Math.min(end, s + len);
    yield { tag, start: s, end: e };
    o = e;
  }
}
const utf16be = (buf, s, e) => {
  const b = Buffer.from(buf.subarray(s, e - ((e - s) % 2)));
  b.swap16();
  return b.toString('utf16le').replace(/\u0000+$/, '');
};

/** Parse a Serato .crate file. Returns track paths relative to the volume root (forward slashes). */
export function parseSeratoCrate(buf) {
  const paths = [];
  let version = null;
  for (const r of seratoRecords(buf)) {
    if (r.tag === 'vrsn') version = utf16be(buf, r.start, r.end);
    else if (r.tag === 'otrk') {
      for (const s of seratoRecords(buf, r.start, r.end)) if (s.tag === 'ptrk') paths.push(utf16be(buf, s.start, s.end));
    }
  }
  if (!version && !paths.length) throw new Error('Not a Serato crate file');
  return { version, paths };
}

/** Build a crate file (used by tests and could back a future Serato export). */
export function buildSeratoCrate(paths) {
  const rec = (tag, payload) => { const h = Buffer.alloc(8); h.write(tag, 0, 'latin1'); h.writeUInt32BE(payload.length, 4); return Buffer.concat([h, payload]); };
  const u16 = (s) => { const b = Buffer.from(s, 'utf16le'); b.swap16(); return b; };
  return Buffer.concat([rec('vrsn', u16('1.0/Serato ScratchLive Crate')), ...paths.map((p) => rec('otrk', rec('ptrk', u16(p))))]);
}

/** Find the `_Serato_` folder from whatever the user picked (the folder itself, its parent, or Subcrates). */
export function findSeratoDir(dir) {
  const d = path.resolve(dir);
  for (const c of [d, path.join(d, '_Serato_'), path.join(d, 'Music', '_Serato_'), path.dirname(d)]) {
    if (fs.existsSync(path.join(c, 'Subcrates'))) return c;
  }
  return null;
}

/** Crate paths are relative to the root of the volume holding `_Serato_` (home Music folder => system root). */
export function seratoPathCandidates(rel, seratoDir) {
  const r = String(rel).replace(/^[/\\]+/, '');
  const volRoot = path.parse(seratoDir).root;
  const parent = path.dirname(seratoDir);
  const out = [path.join(volRoot, r), path.join(parent, r)];
  if (/^Volumes\//.test(r)) out.unshift('/' + r);
  return [...new Set(out)];
}

/** Read all crates in a _Serato_ folder: "Parent%%Child.crate" => folder "Parent", name "Child". */
export function readSeratoCrates(dir) {
  const seratoDir = findSeratoDir(dir);
  if (!seratoDir) throw Object.assign(new Error('No _Serato_/Subcrates folder found there'), { status: 400 });
  const sub = path.join(seratoDir, 'Subcrates');
  const playlists = [];
  for (const f of fs.readdirSync(sub).filter((x) => x.toLowerCase().endsWith('.crate')).sort()) {
    let parsed;
    try { parsed = parseSeratoCrate(fs.readFileSync(path.join(sub, f))); } catch { continue; }
    const parts = f.slice(0, -6).split('%%');
    playlists.push({ name: parts.at(-1), path: parts.slice(0, -1), tracks: parsed.paths.map((p) => ({ paths: seratoPathCandidates(p, seratoDir) })) });
  }
  return { seratoDir, playlists };
}

// ---------------------------------------------------------------- VirtualDJ database.xml

export function parseVirtualDjXml(xml) {
  const doc = xmlParser(new Set(['Song', 'Poi'])).parse(xml);
  const root = doc?.VirtualDJ_Database;
  if (!root) throw new Error('Not a VirtualDJ database (missing VirtualDJ_Database root)');
  const tracks = [];
  for (const s of asArray(root.Song)) {
    if (!s.FilePath) continue;
    const tags = s.Tags || {}, scan = s.Scan || {}, infos = s.Infos || {};
    const spb = num(scan.Bpm) ?? num(tags.Bpm); // seconds per beat
    const cues = [];
    let gridOffset = null;
    for (const p of asArray(s.Poi)) {
      const type = String(p.Type || (p.Num != null ? 'cue' : '')).toLowerCase();
      const pos = num(p.Pos, 0);
      if (type === 'beatgrid') { if (gridOffset == null) gridOffset = pos; continue; }
      if (type === 'cue') {
        const n = num(p.Num, 0);
        const idx = n >= 1 && n <= 8 ? n - 1 : -1;
        cues.push({ type: idx >= 0 ? 'hot' : 'memory', index: idx, position: pos, name: p.Name || '' });
      } else if (type === 'loop' && spb) {
        const n = num(p.Num, 0);
        const size = num(p.Size, 4);
        const idx = n >= 1 && n <= 8 ? n - 1 : -1;
        cues.push({ type: idx >= 0 ? 'hot' : 'memory', index: idx, position: pos, loopEnd: pos + size * spb, name: p.Name || '' });
      }
    }
    const comment = typeof s.Comment === 'string' ? s.Comment : s.Comment?.['#text'] || '';
    tracks.push({
      paths: [String(s.FilePath)], title: tags.Title || '', artist: tags.Author || '', album: tags.Album || '', genre: tags.Genre || '',
      year: num(tags.Year), key: tags.Key || scan.Key || '', bpm: spb ? Math.round((60 / spb) * 100) / 100 : null,
      rating: num(tags.Stars) != null ? Math.max(0, Math.min(5, num(tags.Stars))) : null, playCount: num(infos.PlayCount, 0),
      comment, cues, gridOffset, size: num(s.FileSize),
    });
  }
  return { tracks, playlists: [] };
}

// ---------------------------------------------------------------- shared import step

/**
 * Add parsed tracks that exist on disk to the library (via addFile) and apply imported metadata.
 * Parsed tracks: { paths: [candidates], bpm, key, rating, comment, cues, gridOffset, playCount, ... };
 * playlists: { name, path: [folders], tracks: [parsed track objects] }.
 */
export async function importParsed(library, addFile, parsed, { folderPrefix }) {
  const idOf = new Map();
  let imported = 0, missing = 0, cuesAdded = 0, cuesSkipped = 0;
  const resolve = async (pt) => {
    if (idOf.has(pt)) return idOf.get(pt);
    const file = (pt.paths || []).find((p) => p && fs.existsSync(p));
    let id = null;
    if (file) {
      const t = await addFile(library, file).catch(() => null);
      if (t) {
        id = t.id;
        const patch = {};
        if (pt.bpm) { patch.bpm = pt.bpm; patch.analyzed = !!(pt.cues?.length || pt.gridOffset != null) || t.analyzed; }
        if (pt.key) patch.key = pt.key;
        if (pt.rating) patch.rating = pt.rating;
        if (pt.comment && !t.comment) patch.comment = pt.comment;
        if (pt.playCount && pt.playCount > (t.playCount || 0)) patch.playCount = pt.playCount;
        if (pt.cues?.length) { // merge: auto cues are replaced, the user's own cues stay, imported ones take free pads
          const m = mergeImportedCues(t.cues, pt.cues);
          if (m.added || m.cues.length !== (t.cues || []).length) patch.cues = m.cues;
          cuesAdded += m.added; cuesSkipped += m.skipped;
        }
        if (pt.gridOffset != null) patch.gridOffset = pt.gridOffset;
        // the other app's beat grid is authoritative: re-analysis on first load must not replace it
        if (pt.bpm && pt.gridOffset != null) patch.gridLocked = true;
        else if (pt.bpm) patch.bpmLocked = true;
        if (Object.keys(patch).length) library.updateTrack(t.id, patch);
        imported++;
      }
    } else missing++;
    idOf.set(pt, id);
    return id;
  };
  for (const pt of parsed.tracks || []) await resolve(pt);
  let playlists = 0;
  for (const pl of parsed.playlists || []) {
    const ids = [];
    for (const pt of pl.tracks) { const id = await resolve(pt); if (id) ids.push(id); }
    library.createPlaylist(pl.name, ids, { folder: [folderPrefix, ...(pl.path || [])].filter(Boolean).join(' / ') });
    playlists++;
  }
  library.changed('tracks');
  return { imported, playlists, missing, cuesAdded, cuesSkipped };
}

