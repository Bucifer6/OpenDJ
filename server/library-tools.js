// Library maintenance: missing-file detection, relocation, duplicate finder, backup / restore.
import fs from 'node:fs';
import path from 'node:path';
import { AUDIO_EXT } from './scanner.js';
import { DEFAULT_SETTINGS, newId } from './library.js';

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

  /**
   * Non-blocking variant for HTTP handlers: checks with async fs (a hung NAS share can't freeze the server), a few at
   * a time, each with a timeout (a timed-out check keeps the previous status). Waits at most `budgetMs` unless `full`;
   * checks still running then finish in the background and fire onChange.
   */
  async missingIdsAsync(tracks = this.library.allTracks(), { full = false, budgetMs = this.budgetMs, concurrency = 4, timeoutMs = 5000 } = {}) {
    const now = Date.now();
    const stale = tracks.filter((t) => t.sourceType === 'local' && !this._fresh(t, now));
    if (stale.length) {
      let i = 0, changed = false;
      const worker = async () => {
        while (i < stale.length) {
          const t = stale[i++];
          const file = MissingChecker.fileOf(t);
          const st = file ? await Promise.race([fs.promises.stat(file).then(() => 'ok', () => 'missing'), new Promise((r) => { const tm = setTimeout(() => r('timeout'), timeoutMs); tm.unref?.(); })]) : 'ok';
          if (st === 'timeout') continue;
          const prev = this.cache.get(t.id);
          const missing = st === 'missing';
          this.cache.set(t.id, { path: file, missing, at: Date.now() });
          if (prev ? prev.missing !== missing : missing) changed = true;
        }
      };
      const all = Promise.all(Array.from({ length: Math.min(concurrency, stale.length) }, worker));
      if (full) await all;
      else {
        let timer;
        const done = await Promise.race([all.then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), budgetMs); })]);
        clearTimeout(timer);
        if (!done) all.then(() => { if (changed) this.onChange?.(); });
      }
    }
    const out = new Set();
    for (const t of tracks) if (this.cache.get(t.id)?.missing && t.sourceType === 'local') out.add(t.id);
    return out;
  }
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
export async function relocateTracks(library, folder, trackIds, { confirm = {} } = {}) {
  if (!folder || !(await fs.promises.stat(folder).catch(() => null))?.isDirectory()) throw Object.assign(new Error('Folder does not exist'), { status: 400 });
  const want = trackIds.map((id) => library.getTrack(id)).filter((t) => t && t.sourceType === 'local');
  const names = new Set(want.map((t) => baseKey(t.path)));
  const index = new Map(); // basename -> [paths]
  let scanned = 0;
  for await (const f of walkAudio(path.resolve(folder))) {
    scanned++;
    const k = baseKey(f);
    if (!names.has(k)) continue;
    // a file that already is another track in the library is not a candidate
    const owner = library.getTrack(library.trackIdForPath(f));
    if (owner && owner.path === path.resolve(f)) continue;
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(f);
  }
  const sizeOf = async (p) => (await fs.promises.stat(p).catch(() => null))?.size ?? null;
  const relocated = [], notFound = [], ambiguous = [], taken = new Set();
  for (const t of want) {
    let cands = (index.get(baseKey(t.path)) || []).filter((p) => !taken.has(p));
    const forced = confirm[t.id] && cands.includes(path.resolve(confirm[t.id])) ? path.resolve(confirm[t.id]) : null;
    if (!forced) {
      // Same name is not enough: when the size is known it must match, and several equal candidates need the user.
      if (t.size) {
        const sized = [];
        for (const p of cands) if ((await sizeOf(p)) === t.size) sized.push(p);
        if (!sized.length && cands.length) { ambiguous.push({ id: t.id, reason: 'size differs', candidates: cands.slice(0, 20) }); continue; }
        cands = sized;
      }
      if (cands.length > 1) { ambiguous.push({ id: t.id, reason: 'several matches', candidates: cands.slice(0, 20) }); continue; }
    }
    const p = forced || cands[0];
    if (!p) { notFound.push(t.id); continue; }
    taken.add(p);
    const old = t.path;
    library.relocateTrack(t.id, p, library.folderFor(p)?.id || 'files');
    relocated.push({ id: t.id, from: old, to: p });
  }
  if (relocated.length) library.changed('tracks');
  return { relocated, notFound, ambiguous, scanned };
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
  for (const g of Array.isArray(groups) ? groups : []) {
    const remove = Array.isArray(g?.remove) ? g.remove : [];
    if (!library.getTrack(g?.keep) || remove.includes(g.keep)) continue; // keep must exist and not also be removed
    for (const r of remove) if (r !== g.keep && library.getTrack(r)) map.set(r, g.keep);
  }
  // Chained groups (a->b, b->c): follow to the final survivor; drop cycles.
  const resolve = (id) => { const seen = new Set(); while (map.has(id) && !seen.has(id)) { seen.add(id); id = map.get(id); } return map.has(id) ? null : id; };
  for (const k of [...map.keys()]) { const to = resolve(k); if (!to || to === k) map.delete(k); else map.set(k, to); }
  if (!map.size) return { removed: 0 };
  for (const p of library.data.playlists) {
    if (p.smart) continue;
    const seen = new Set();
    p.trackIds = p.trackIds.map((id) => map.get(id) || id).filter((id) => (seen.has(id) ? false : seen.add(id)));
  }
  // Carry over play counts and the user's prep work the kept copy lacks.
  for (const [from, to] of map) {
    const a = library.getTrack(from), b = library.getTrack(to);
    if (!a || !b) continue;
    b.playCount = (b.playCount || 0) + (a.playCount || 0);
    b.lastPlayed = Math.max(a.lastPlayed || 0, b.lastPlayed || 0) || b.lastPlayed;
    for (const k of ['cues', 'loops', 'hotLoops', 'phrases']) if (!b[k]?.length && a[k]?.length) b[k] = a[k];
    if (!b.analyzed && a.analyzed) for (const k of ['analyzed', 'bpm', 'gridOffset', 'downbeat', 'key', 'energy', 'gain', 'bpmLocked']) if (a[k] !== undefined) b[k] = a[k];
    if (!b.localPath && a.localPath) b.localPath = a.localPath;
    if (a.rating > (b.rating || 0)) b.rating = a.rating;
    if (!b.comment && a.comment) b.comment = a.comment;
    if (!b.color && a.color) b.color = a.color;
    if (a.tags?.length) b.tags = [...new Set([...(b.tags || []), ...a.tags])];
  }
  library.removeTracks([...map.keys()]);
  return { removed: map.size };
}

// ---------------------------------------------------------------- backup / restore

const SECRET_KEYS = ['password', 'token'];
/** Settings that describe this machine/server, not the user's library (never taken from a backup). */
const LOCAL_ONLY_SETTINGS = new Set(['allowedRoots', 'uploadDir', 'downloadDir', 'youtubeApiKey']);
export const REDACTED = '••••••';

/** Settings as sent to the UI / written to backups: the Hue bridge key is replaced (UI only needs to know it exists). */
export function redactSettings(settings, { forBackup = false } = {}) {
  if (forBackup && settings?.youtubeApiKey) settings = { ...settings, youtubeApiKey: '' };
  const hue = settings?.lighting?.outputs?.hue;
  if (!hue?.username) return settings;
  return { ...settings, lighting: { ...settings.lighting, outputs: { ...settings.lighting.outputs, hue: { ...hue, username: forBackup ? '' : REDACTED } } } };
}

export function buildBackup(library, history) {
  return {
    app: 'OpenDJ', type: 'library-backup', version: 1, createdAt: new Date().toISOString(),
    library: {
      ...library.data,
      // Media-server credentials are never written to backups; existing ones are kept on restore.
      sources: library.data.sources.map((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !SECRET_KEYS.includes(k)))),
    },
    settings: redactSettings(library.settings, { forBackup: true }),
    history: history.data,
  };
}

/** Ids that may appear in URLs / file names (track, folder and playlist ids are hex or short slugs). */
export const ID_RE = /^[\w-]{1,64}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const validId = (id) => typeof id === 'string' && ID_RE.test(id) && !BAD_KEYS.has(id);

/**
 * Restore a backup. `pathAllowed(p)` is the hosted-mode path check (always true on the desktop): library folders
 * and track files outside the allowed roots are dropped, so a crafted backup cannot point the server at /etc.
 */
export function restoreBackup(library, history, backup, { pathAllowed = () => true } = {}) {
  const prevLighting = library.settings.lighting;
  if (!backup || backup.app !== 'OpenDJ' || backup.type !== 'library-backup' || !backup.library || typeof backup.library.tracks !== 'object') {
    throw Object.assign(new Error('Not an OpenDJ library backup'), { status: 400 });
  }
  const lib = backup.library;
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(lib.tracks)) throw Object.assign(new Error('Not an OpenDJ library backup'), { status: 400 });
  const okPath = (p) => typeof p === 'string' && p.length > 0 && !p.includes('\0') && pathAllowed(p);
  const tracks = {};
  for (const [id, t] of Object.entries(lib.tracks)) {
    if (!isObj(t) || !validId(id)) continue;
    const r = { ...t, id, cues: Array.isArray(t.cues) ? t.cues : [], loops: Array.isArray(t.loops) ? t.loops : [] };
    for (const k of ['path', 'localPath']) if (k in r && !okPath(r[k])) delete r[k];
    tracks[id] = r;
  }
  const playlists = (Array.isArray(lib.playlists) ? lib.playlists : []).filter(isObj).map((p) => ({
    ...p, id: validId(p.id) ? p.id : newId(), name: String(p.name ?? 'Playlist').slice(0, 200),
    trackIds: Array.isArray(p.trackIds) ? p.trackIds.filter(validId) : [],
    ...(p.smart && !isObj(p.smart) ? { smart: undefined } : {}),
  }));
  const folders = (Array.isArray(lib.folders) ? lib.folders : [])
    .filter((f) => isObj(f) && validId(f.id) && typeof f.path === 'string' && path.isAbsolute(f.path) && okPath(f.path));
  const oldSources = new Map(library.data.sources.map((s) => [s.id, s]));
  library.data = {
    version: 1, tracks, playlists, folders,
    sources: (Array.isArray(lib.sources) ? lib.sources : []).filter((s) => isObj(s) && validId(s.id)).map((s) => {
      const old = oldSources.get(s.id);
      if (!old) return s;
      const keep = Object.fromEntries(SECRET_KEYS.filter((k) => old[k]).map((k) => [k, old[k]]));
      return { ...s, ...keep };
    }),
    ...(isObj(lib.pathAlias) ? { pathAlias: Object.fromEntries(Object.entries(lib.pathAlias).filter(([k, v]) => validId(v) && okPath(k))) } : {}),
  };
  if (isObj(backup.settings)) {
    const s = Object.fromEntries(Object.entries(backup.settings).filter(([k]) => Object.hasOwn(DEFAULT_SETTINGS, k) && !LOCAL_ONLY_SETTINGS.has(k)));
    library.settings = { ...structuredClone(DEFAULT_SETTINGS), ...library.settings, ...s, automix: { ...DEFAULT_SETTINGS.automix, ...(isObj(s.automix) ? s.automix : {}) } };
    // a backup carries no Hue key: keep the paired one
    const hue = library.settings.lighting?.outputs?.hue, oldHue = prevLighting?.outputs?.hue;
    if (hue && !hue.username && oldHue?.username && hue.bridge === oldHue.bridge) hue.username = oldHue.username;
  }
  if (isObj(backup.history)) history.replaceAll({ sessions: (Array.isArray(backup.history.sessions) ? backup.history.sessions : []).filter((x) => isObj(x) && Array.isArray(x.entries)) });
  library.flush();
  history.flush();
  library.emit('library', { what: 'restore' });
  return { tracks: Object.keys(library.data.tracks).length, playlists: library.data.playlists.length, sessions: history.data.sessions.length };
}
