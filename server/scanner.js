// Scans local folders (internal disks, USB sticks, mounted NAS shares) for audio files.
import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { Library } from './library.js';

export const AUDIO_EXT = new Set(['.mp3', '.wav', '.aif', '.aiff', '.flac', '.m4a', '.aac', '.mp4', '.ogg', '.oga', '.opus', '.webm', '.alac']);

export async function* walk(dir, { signal } = {}) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (signal?.aborted) return;
    if (e.name.startsWith('.') || e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, { signal });
    else if (e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) yield p;
  }
}

const parseTitleFromName = (file) => {
  const base = path.basename(file, path.extname(file));
  const m = base.match(/^(?:\d+[\s.\-_]+)?(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
};

export async function readTags(file) {
  const st = await fs.promises.stat(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  const fallback = parseTitleFromName(file);
  let common = {}, format = {};
  try {
    const mm = await parseFile(file, { skipCovers: true, duration: false });
    common = mm.common; format = mm.format;
  } catch { /* unreadable tags: use file name */ }
  return {
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
    format: ext,
    size: st.size,
    mtime: st.mtimeMs,
  };
}

export async function addFile(library, file, sourceId = 'files') {
  const tid = library.trackIdForPath ? library.trackIdForPath(file) : Library.localId(file);
  const prev = library.getTrack(tid);
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st) return null;
  if (prev && prev.mtime === st.mtimeMs) return prev; // unchanged
  const tags = await readTags(file);
  return library.upsertTrack({ id: tid, sourceType: 'local', sourceId, path: path.resolve(file), ...tags });
}

/** Scan a library folder. Removes tracks whose files disappeared (unless the drive itself is gone). */
export async function scanFolder(library, folder, { onProgress, signal } = {}) {
  if (!fs.existsSync(folder.path)) throw new Error(`Folder not reachable: ${folder.path} (is the USB drive / NAS share mounted?)`);
  const seen = new Set();
  let n = 0;
  for await (const file of walk(folder.path, { signal })) {
    try {
      const t = await addFile(library, file, folder.id);
      if (t) seen.add(t.id);
    } catch { /* skip unreadable file */ }
    if (++n % 25 === 0) { onProgress?.({ folder: folder.id, scanned: n, file }); library.save(); }
  }
  const root = folder.path.endsWith(path.sep) ? folder.path : folder.path + path.sep;
  const missing = library.allTracks().filter((t) => t.sourceId === folder.id && !seen.has(t.id) && (!t.path || t.path.startsWith(root))).map((t) => t.id);
  if (missing.length && !signal?.aborted) library.removeTracks(missing);
  folder.lastScan = Date.now();
  folder.trackCount = seen.size;
  library.changed('tracks');
  onProgress?.({ folder: folder.id, scanned: n, done: true });
  return { scanned: n, added: seen.size, removed: missing.length };
}
