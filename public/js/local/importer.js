// Import into the on-device library. Phones have no "music folder" the app may scan (iOS has none at all), so
// import is copy-in: the picked file is copied into app storage (music/<id>.<ext>), its tags and cover art are read
// in the browser (music-metadata's browser build) and the background analysis does the rest (BPM, key, waveform).
// Also matches rekordbox XML / M3U entries to tracks already imported (by file name), since their paths point at
// files on another computer.
import { hashId } from '../shared/library-core.js';
import { normCodec, mmVideoInfo } from '../shared/codec.js';
import { checkFormat, safeImageType, extOf } from './media.js';
import { HttpError } from './dispatcher.js';

export const DEVICE_SOURCE = 'device';

export function parseTitleFromName(name) {
  const base = String(name || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const m = base.match(/^(?:\d+[\s.\-_]+)?(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}

/**
 * Tags, format info and the first picture of a file (Blob / File), like server/scanner.js readTags.
 * @param mm  music-metadata (browser bundle in the app; the npm package in tests): { parseBlob }
 */
export async function readTagsFromBlob(blob, name, mm, { covers = true } = {}) {
  const fallback = parseTitleFromName(name);
  let common = {}, format = {};
  try {
    const r = await mm.parseBlob(blob, { skipCovers: !covers, duration: false });
    common = r.common; format = r.format;
  } catch { /* unreadable tags: use the file name */ }
  const { hasVideo, videoCodec } = mmVideoInfo(format);
  const codec = normCodec(format.codec);
  const pic = covers ? common.picture?.[0] : null;
  return {
    tags: {
      codec: codec || null, hasVideo, ...(hasVideo ? { videoCodec: videoCodec || null } : {}), needsTranscode: false,
      title: common.title || fallback.title,
      artist: common.artist || common.albumartist || fallback.artist,
      album: common.album || '',
      albumArtist: common.albumartist || '',
      genre: (common.genre || [])[0] || '',
      year: common.year || null,
      trackNumber: common.track?.no || null,
      bpm: common.bpm ? Math.round(Number(common.bpm) * 100) / 100 : null,
      key: common.key || null,
      comment: (common.comment || []).map((c) => (typeof c === 'string' ? c : c?.text || '')).join(' ').slice(0, 300),
      duration: format.duration || null,
      bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
      sampleRate: format.sampleRate || null,
      format: extOf(name),
      size: blob.size,
    },
    picture: pic?.data?.length && safeImageType(pic.format) ? { data: pic.data, type: safeImageType(pic.format) } : null,
  };
}

/** Stable track id for an imported file: the same file imported again is recognised (name + size). */
export const deviceTrackId = (name, size) => hashId(`device:${String(name).toLowerCase()}:${Number(size) || 0}`);

export class Importer {
  /** @param {object} o { library, fs, mm, emit, canPlayType?, transcoder?, maxMB? } */
  constructor(o) { Object.assign(this, o); }

  /**
   * Import one file. `source`: a Blob / File (browser picker, drag & drop, upload API), or { blob, name, size }.
   * `copyIn(dest)`: optional native fast path that copies the picked file into storage without passing it through
   * JavaScript (iOS / Android); falls back to writing the Blob.
   * @returns {{ id, track, duplicate? }}
   */
  async importFile(source, { name, copyIn } = {}) {
    const blob = source instanceof Blob ? source : source?.blob;
    name = String(name || source?.name || 'upload').replace(/^.*[\\/]/, '').slice(0, 255);
    const size = Number(blob?.size ?? source?.size) || 0;
    const fmt = checkFormat(name, { canPlayType: this.canPlayType, transcoder: this.transcoder });
    if (!fmt.ok) throw new HttpError(415, `${name}: ${fmt.reason}`);
    if (!size) throw new HttpError(400, `${name}: empty file`);
    const limit = (Number(this.maxMB?.() ?? this.library.settings.uploadMaxMB) || 2048) * 1048576;
    if (size > limit) throw new HttpError(413, `${name} is larger than the ${Math.round(limit / 1048576)} MB limit`);
    const id = deviceTrackId(name, size);
    const prev = this.library.getTrack(id);
    if (prev && prev.path && (await this.fs.stat(prev.path))?.size === size) return { id, track: prev, duplicate: true };
    const path = `music/${id}.${fmt.ext}`;
    if (copyIn) {
      try { await copyIn(path); } catch { if (!blob) throw new HttpError(500, `${name}: could not copy the file into the app`); await this.fs.write(path, blob); }
    } else await this.fs.write(path, blob);
    const stored = blob || await this.fs.read(path);
    const { tags, picture } = await readTagsFromBlob(stored, name, this.mm);
    let coverPath = null;
    if (picture) {
      coverPath = `covers/${id}.${picture.type === 'image/png' ? 'png' : picture.type === 'image/webp' ? 'webp' : 'jpg'}`;
      try { await this.fs.write(coverPath, new Blob([picture.data], { type: picture.type })); } catch { coverPath = null; }
    }
    const track = this.library.upsertTrack({
      id, sourceType: 'local', sourceId: DEVICE_SOURCE, path, fileName: name, mtime: Date.now(), importedAt: Date.now(),
      ...tags, needsTranscode: !!fmt.transcode, hasCover: !!coverPath, coverPath,
    });
    return { id, track };
  }
}

// ------------------------------------------------------------------ playlist files from other computers

const baseName = (p) => String(p || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
const stemOf = (p) => baseName(p).replace(/\.[^.]+$/, '');
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Index of the device library for matching entries of playlists made on another computer: by file name, then by
 * file name without extension (the phone may hold an MP3 of the desktop's FLAC), then by "artist - title".
 */
export function trackMatcher(tracks) {
  const byName = new Map(), byStem = new Map(), byTitle = new Map();
  const add = (m, k, t) => { if (k && !m.has(k)) m.set(k, t); };
  for (const t of tracks) {
    const n = t.fileName || t.path;
    add(byName, baseName(n), t); add(byStem, stemOf(n), t);
    if (t.title) add(byTitle, `${norm(t.artist)}|${norm(t.title)}`, t);
  }
  return ({ path, artist, title, label } = {}) => {
    if (path) { const hit = byName.get(baseName(path)) || byStem.get(stemOf(path)); if (hit) return hit; }
    if (title) { const hit = byTitle.get(`${norm(artist)}|${norm(title)}`); if (hit) return hit; }
    if (label) { const m = /^(.*?)\s+-\s+(.*)$/.exec(label); if (m) return byTitle.get(`${norm(m[1])}|${norm(m[2])}`) || null; }
    if (path) { const p = parseTitleFromName(path); if (p.artist) return byTitle.get(`${norm(p.artist)}|${norm(p.title)}`) || null; }
    return null;
  };
}
