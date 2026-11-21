// Library maintenance that needs no file system: duplicate finder, backup / restore, settings redaction.
// Shared by the desktop server (server/library-tools.js) and the mobile app's on-device backend.
import { DEFAULT_SETTINGS, newId } from './library-core.js';
import { sourceEndpoint } from './sources/index.js';

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
    if (!b.analyzed && a.analyzed) for (const k of ['analyzed', 'bpm', 'gridOffset', 'downbeat', 'key', 'energy', 'gain', 'bpmLocked', 'gridLocked']) if (a[k] !== undefined) b[k] = a[k];
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

const isAbsolutePosixOrWin = (p) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);

/**
 * Restore a backup. `pathAllowed(p)` is the hosted-mode path check (always true on the desktop): library folders
 * and track files outside the allowed roots are dropped, so a crafted backup cannot point the server at /etc.
 */
export function restoreBackup(library, history, backup, { pathAllowed = () => true, isAbsolutePath = isAbsolutePosixOrWin } = {}) {
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
    .filter((f) => isObj(f) && validId(f.id) && typeof f.path === 'string' && isAbsolutePath(f.path) && okPath(f.path));
  const oldSources = new Map(library.data.sources.map((s) => [s.id, s]));
  library.data = {
    version: 1, tracks, playlists, folders,
    sources: (Array.isArray(lib.sources) ? lib.sources : []).filter((s) => isObj(s) && validId(s.id)).map((s) => {
      const old = oldSources.get(s.id);
      if (!old || sourceEndpoint(old) !== sourceEndpoint(s)) return s; // secrets stay bound to their endpoint
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
