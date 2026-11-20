// Library maintenance: missing-file detection, relocation, duplicate finder, backup / restore.
import fs from 'node:fs';
import path from 'node:path';
import { AUDIO_EXT } from './scanner.js';
import { DEFAULT_SETTINGS } from './library.js';

// ---------------------------------------------------------------- missing files

/**
 * Cached "does this local file exist" checks. Libraries can hold 50k tracks (and live on slow NAS shares),
 * so each GET only spends a small time budget on synchronous checks; the rest are checked in the background
 * and `onChange` fires when that changes any status.
 */
export class MissingChecker {
  constructor(library, { ttl = 15_000, budgetMs = 150, onChange } = {}) {
    this.library = library; this.ttl = ttl; this.budgetMs = budgetMs; this.onChange = onChange;
    this.cache = new Map(); // trackId -> { path, missing, at }
    this._bg = null;
  }
  static fileOf(t) { return t.sourceType === 'local' ? t.path : null; }

  _check(t, now) {
    const file = MissingChecker.fileOf(t);
    const missing = !!file && !fs.existsSync(file);
    const prev = this.cache.get(t.id);
    this.cache.set(t.id, { path: file, missing, at: now });
    return prev ? prev.missing !== missing : missing;
  }
  _fresh(t, now) {
    const c = this.cache.get(t.id);
    return c && c.path === MissingChecker.fileOf(t) && now - c.at < this.ttl ? c : null;
  }

  /** Set of missing track ids (best effort within the time budget; stale entries refresh in the background). */
  missingIds(tracks = this.library.allTracks(), { sync = false } = {}) {
    const now = Date.now(), start = performance.now();
    const stale = [];
    for (const t of tracks) {
      if (t.sourceType !== 'local') continue;
      if (this._fresh(t, now)) continue;
      if (sync || !this.cache.has(t.id) && performance.now() - start < this.budgetMs) this._check(t, now);
      else stale.push(t);
    }
    if (stale.length) this._background(stale);
    const out = new Set();
    for (const t of tracks) if (this.cache.get(t.id)?.missing && t.sourceType === 'local') out.add(t.id);
    return out;
  }
  _background(list) {
    if (this._bg) return;
    this._bg = (async () => {
      let changed = false;
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (this.library.getTrack(t.id) && this._check(t, Date.now())) changed = true;
        if (i % 200 === 199) await new Promise((r) => setImmediate(r));
      }
      this._bg = null;
      if (changed) this.onChange?.();
    })();
  }
  invalidate(ids) { if (!ids) this.cache.clear(); else for (const i of ids) this.cache.delete(i); }
}

// ---------------------------------------------------------------- relocate

async function* walkAudio(dir, depth = 0) {
  if (depth > 32) return;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkAudio(p, depth + 1);
    else if (e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) yield p;
  }
}

const baseKey = (p) => path.basename(String(p).replace(/\\/g, '/')).toLowerCase();

/**
 * Search `folder` recursively for the files of the given tracks, matching by file name, then by size when several
 * files share a name. Tracks keep their id (cues, analysis, playlists stay intact); only `path` changes.
 */
export async function relocateTracks(library, folder, trackIds) {
  if (!folder || !fs.existsSync(folder)) throw Object.assign(new Error('Folder does not exist'), { status: 400 });
  const want = trackIds.map((id) => library.getTrack(id)).filter((t) => t && t.sourceType === 'local');
  const names = new Set(want.map((t) => baseKey(t.path)));
  const index = new Map(); // basename -> [paths]
  let scanned = 0;
  for await (const f of walkAudio(path.resolve(folder))) {
    scanned++;
    const k = baseKey(f);
    if (!names.has(k)) continue;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(f);
  }
  const relocated = [], notFound = [], taken = new Set();
  for (const t of want) {
    let cands = (index.get(baseKey(t.path)) || []).filter((p) => !taken.has(p));
    if (cands.length > 1 && t.size) {
      const same = cands.filter((p) => { try { return fs.statSync(p).size === t.size; } catch { return false; } });
      if (same.length) cands = same;
    }
    if (!cands.length) { notFound.push(t.id); continue; }
    const p = cands[0];
    taken.add(p);
    const old = t.path;
    library.relocateTrack(t.id, p, library.folderFor(p)?.id || 'files');
    relocated.push({ id: t.id, from: old, to: p });
  }
  if (relocated.length) library.changed('tracks');
  return { relocated, notFound, scanned };
}

// ---------------------------------------------------------------- duplicates

export function normTitle(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\((original|extended)( mix)?\)|\[(original|extended)( mix)?\]/g, '')
    .replace(/\b(feat|ft|featuring)\.?\s.*$/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
const normArtist = (s) => normTitle(String(s || '').split(/,|\s(?:feat|ft|featuring|vs|x)\.?\s/i)[0]);

/**
 * Group duplicate tracks: same normalised artist + title, or same file size + duration (±1 s).
 * @returns {{ ids: string[], reason: string }[]}
 */
export function findDuplicates(tracks) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const reason = new Map();
  for (const t of tracks) parent.set(t.id, t.id);
  const byName = new Map(), bySize = new Map();
  for (const t of tracks) {
    const title = normTitle(t.title);
    if (title) {
      const k = normArtist(t.artist) + '\u0000' + title;
      if (byName.has(k)) { union(byName.get(k), t.id); reason.set(t.id, 'artist + title'); } else byName.set(k, t.id);
    }
    if (t.size && t.duration) {
      const k = `${t.size}:${Math.round(t.duration)}`;
      if (bySize.has(k)) { union(bySize.get(k), t.id); if (!reason.has(t.id)) reason.set(t.id, 'file size + length'); } else bySize.set(k, t.id);
    }
  }
  const groups = new Map();
  for (const t of tracks) { const r = find(t.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); }
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    // Best copy first: analysed, most cues, most played, best bitrate, local over streaming.
    const score = (t) => (t.analyzed ? 1000 : 0) + (t.cues?.length || 0) * 50 + (t.playCount || 0) * 5 + (t.bitrate || 0) / 10 + (t.sourceType === 'local' || t.localPath ? 200 : 0);
    g.sort((a, b) => score(b) - score(a));
    out.push({ ids: g.map((t) => t.id), reason: g.map((t) => reason.get(t.id)).find(Boolean) || 'artist + title' });
  }
  return out;
}

/** Remove duplicates, pointing playlist entries at the kept copy. groups: [{ keep, remove: [] }] */
export function mergeDuplicates(library, groups) {
  const map = new Map();
  for (const g of groups || []) for (const r of g.remove || []) if (r !== g.keep && library.getTrack(g.keep)) map.set(r, g.keep);
  if (!map.size) return { removed: 0 };
  for (const p of library.data.playlists) {
    if (p.smart) continue;
    const seen = new Set();
    p.trackIds = p.trackIds.map((id) => map.get(id) || id).filter((id) => (seen.has(id) ? false : seen.add(id)));
  }
  // Carry over play counts.
  for (const [from, to] of map) {
    const a = library.getTrack(from), b = library.getTrack(to);
    if (a && b) { b.playCount = (b.playCount || 0) + (a.playCount || 0); b.lastPlayed = Math.max(a.lastPlayed || 0, b.lastPlayed || 0) || b.lastPlayed; }
  }
  library.removeTracks([...map.keys()]);
  return { removed: map.size };
}

// ---------------------------------------------------------------- backup / restore

const SECRET_KEYS = ['password', 'token'];

export function buildBackup(library, history) {
  return {
    app: 'OpenDJ', type: 'library-backup', version: 1, createdAt: new Date().toISOString(),
    library: {
      ...library.data,
      // Media-server credentials are never written to backups; existing ones are kept on restore.
      sources: library.data.sources.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !SECRET_KEYS.includes(k)))),
    },
    settings: library.settings,
    history: history.data,
  };
}

export function restoreBackup(library, history, backup) {
  if (!backup || backup.app !== 'OpenDJ' || backup.type !== 'library-backup' || !backup.library || typeof backup.library.tracks !== 'object') {
    throw Object.assign(new Error('Not an OpenDJ library backup'), { status: 400 });
  }
  const lib = backup.library;
  const oldSources = new Map(library.data.sources.map((s) => [s.id, s]));
  library.data = {
    version: 1, tracks: lib.tracks || {}, playlists: Array.isArray(lib.playlists) ? lib.playlists : [],
    folders: Array.isArray(lib.folders) ? lib.folders : [],
    sources: (Array.isArray(lib.sources) ? lib.sources : []).map((s) => {
      const old = oldSources.get(s.id);
      if (!old) return s;
      const keep = Object.fromEntries(SECRET_KEYS.filter((k) => old[k]).map((k) => [k, old[k]]));
      return { ...s, ...keep };
    }),
    ...(lib.pathAlias ? { pathAlias: lib.pathAlias } : {}),
  };
  if (backup.settings && typeof backup.settings === 'object') {
    const s = backup.settings;
    library.settings = { ...structuredClone(DEFAULT_SETTINGS), ...library.settings, ...s, automix: { ...DEFAULT_SETTINGS.automix, ...(s.automix || {}) } };
  }
  if (backup.history) history.replaceAll(backup.history);
  library.flush();
  history.flush();
  library.emit('library', { what: 'restore' });
  return { tracks: Object.keys(library.data.tracks).length, playlists: library.data.playlists.length, sessions: history.data.sessions.length };
}
