// Library maintenance: missing-file detection and relocation (file system). The duplicate finder, backup / restore
// and settings redaction are public/js/shared/library-tools.js, shared with the mobile app.
import fs from 'node:fs';
import path from 'node:path';
import { AUDIO_EXT } from './scanner.js';
import { restoreBackup as restoreShared } from '../public/js/shared/library-tools.js';

export { normTitle, findDuplicates, mergeDuplicates, REDACTED, redactSettings, buildBackup, ID_RE, validId } from '../public/js/shared/library-tools.js';

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


/**
 * Restore a backup. `pathAllowed(p)` is the hosted-mode path check (always true on the desktop): library folders
 * and track files outside the allowed roots are dropped, so a crafted backup cannot point the server at /etc.
 */
export function restoreBackup(library, history, backup, { pathAllowed = () => true } = {}) {
  return restoreShared(library, history, backup, { pathAllowed, isAbsolutePath: path.isAbsolute });
}
