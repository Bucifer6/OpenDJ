// The on-device backend of the mobile app: implements the HTTP API the UI uses (see server/index.js) inside the page,
// on top of IndexedDB (library JSON) and app file storage (audio, covers, waveforms, recordings). The UI code is the
// same as on the desktop; public/js/local/shim.js routes its /api/... requests here.
//
// Nothing listens on a port and nothing leaves the device except what the user asks for (media servers they add,
// lyrics lookups when they turn them on). Features that need a server process or raw network access (folder
// scanning, lighting over UDP, Ableton Link, broadcasting, CDJ USB export) answer with a clear error and are hidden
// in the UI (public/js/platform.js).
import { Router, HttpError, EventHub, attachment } from './dispatcher.js';
import { LocalLibrary, LocalHistory } from './library.js';
import { Importer, trackMatcher } from './importer.js';
import { LocalSources, scrub } from './sources.js';
import { registerLocalRecording } from './recording.js';
import { AUDIO_MIME, ACCEPT, PLACEHOLDER_SVG, PLACEHOLDER_URL, needsAiffConversion, extOf } from './media.js';
import { evaluateSmart, normSmart, SMART_FIELDS, SMART_OPS, SOURCE_VALUES, TRACK_COLORS } from '../shared/smart.js';
import { exportSession, sessionTitle } from '../shared/history-core.js';
import { findDuplicates, mergeDuplicates, buildBackup, restoreBackup, redactSettings, REDACTED } from '../shared/library-tools.js';
import { SOURCE_TYPES, sourceConfigFromForm } from '../shared/sources/index.js';
import { parseRekordboxXmlWith, buildRekordboxXml } from '../shared/rekordbox.js';
import { parseM3UEntries, buildM3UWith } from '../shared/m3u.js';
import { aiffToWav, isAiff } from '../shared/aiff.js';
import { LYRICS_DEFAULTS, empty, has, lyricsFromMetadata, remoteLyricsFrom, lrclibLookupWith } from '../shared/lyrics-core.js';
import { parseLrc, normalizeLyrics } from '../lyrics/lrc.js';
import { mergeImportedCues } from '../shared/cues.js';
import { UpdateChecker } from '../shared/update-core.js';

const VIDEO_MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm' };
const UNAVAILABLE = (what) => new HttpError(501, `${what} is not available in the mobile app`, 'unavailable');

/**
 * @param {object} o
 * @param o.kv          key-value store (IdbKV / MemoryKV)
 * @param o.fs          file store (storage/fs.js)
 * @param o.mm          music-metadata: { parseBlob }
 * @param o.XMLParser   fast-xml-parser's XMLParser (rekordbox XML import)
 * @param o.http        fetch for media servers / LRCLIB (CapacitorHttp-backed in the app)
 * @param o.download    native downloader for media-server files, or null
 * @param o.canPlayType (mime) => boolean
 * @param o.platform    { native: boolean, os: 'ios'|'android'|'web' }
 * @param o.getEngine   () => the app's audio Engine (MediaRecorder recordings)
 * @param o.version     app version
 */
export async function createLocalBackend(o) {
  const { kv, fs, mm, XMLParser, http = globalThis.fetch?.bind(globalThis), download = null, canPlayType, platform = { native: false, os: 'web' }, getEngine, version = 'dev' } = o;
  const log = o.log || console;
  const library = await new LocalLibrary(kv).load();
  const history = await new LocalHistory(kv).load();
  const hub = new EventHub();
  const emit = (type, payload) => hub.emit(type, payload);
  hub.pending.push(...library.loadErrors, ...history.loadErrors);
  library.listeners.add(emit);
  history.onError = (e) => emit('job-error', { key: 'save', message: `Could not save play history: ${e.message}` });

  // files owned by the app: imported copies, covers, waveforms and offline downloads go when their track goes
  const filesOf = (t) => [t.sourceType === 'local' && t.sourceId === 'device' ? t.path : null, t.localPath, t.coverPath, `waveforms/${t.id.replace(/[^\w-]/g, '')}.bin`].filter(Boolean);
  const origRemove = library.removeTracks.bind(library);
  library.removeTracks = (ids) => {
    const files = ids.map((id) => library.getTrack(id)).filter(Boolean).flatMap(filesOf);
    origRemove(ids);
    for (const f of files) fs.delete(f).catch(() => {});
  };

  const importer = new Importer({ library, fs, mm, emit, canPlayType });
  const sources = new LocalSources({ library, fs, emit, fetch: http, download, mm });
  const router = new Router({ log });
  const route = router.route.bind(router);
  const track = (id) => { const t = library.getTrack(id); if (!t) throw new HttpError(404, 'Track not found'); return t; };
  const waveformPath = (id) => `waveforms/${String(id).replace(/[^\w-]/g, '')}.bin`;
  const localFile = (t) => t.localPath || (t.sourceType === 'local' ? t.path : null);
  const playlistTrackIds = (p) => (p.smart ? evaluateSmart(p.smart, library.allTracks()) : p.trackIds);
  const resolvedPlaylists = () => {
    const all = library.data.playlists.some((p) => p.smart) ? library.allTracks() : null;
    return library.data.playlists.map((p) => (p.smart ? { ...p, trackIds: evaluateSmart(p.smart, all) } : p));
  };
  const jobs = new Map();
  const runJob = (key, fn) => {
    if (jobs.has(key)) return jobs.get(key);
    const p = fn().catch((e) => { emit('job-error', { key, message: scrub(e.message) }); throw e; }).finally(() => { jobs.delete(key); emit('jobs', [...jobs.keys()]); });
    jobs.set(key, p); emit('jobs', [...jobs.keys()]); p.catch(() => {});
    return p;
  };
  const convertAiff = needsAiffConversion(canPlayType);

  // ---------------- media URLs for <img>/<audio>/<video> (see urlForSync / urlFor below) ----------------
  const remoteCache = new Map(); // trackId -> storage path of a cached remote stream / cover
  async function streamFile(t) {
    const file = localFile(t);
    if (file) {
      if (await fs.stat(file)) return { path: file, ext: extOf(file) };
      if (!t.missing) { t.missing = true; emit('library', { what: 'missing' }); }
      throw new HttpError(404, 'File missing (it was removed from the app storage)');
    }
    if (t.sourceType !== 'remote') throw new HttpError(404, 'File missing');
    const cached = remoteCache.get(`s:${t.id}`);
    if (cached && await fs.stat(cached)) return { path: cached, ext: extOf(cached) };
    const req = sources.streamRequest(t);
    const dest = `cache/stream/${t.id.replace(/[^\w-]/g, '')}.${req.ext}`;
    await pruneCache('cache/stream', 8);
    try { await sources.fetchToFile(req, dest); } catch (e) { throw new HttpError(502, scrub(e.message)); }
    remoteCache.set(`s:${t.id}`, dest);
    return { path: dest, ext: req.ext };
  }
  async function pruneCache(dir, keep) {
    const list = (await fs.list(dir)).sort((a, b) => b.mtime - a.mtime);
    for (const f of list.slice(keep)) { await fs.delete(`${dir}/${f.name}`); for (const [k, v] of remoteCache) if (v === `${dir}/${f.name}`) remoteCache.delete(k); }
  }
  async function aiffResponse(path) {
    const blob = await fs.read(path);
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (!isAiff(head)) return null;
    try { return new Response(aiffToWav(new Uint8Array(await blob.arrayBuffer())), { headers: { 'Content-Type': 'audio/wav' } }); } catch (e) { throw new HttpError(415, `Cannot read AIFF: ${e.message}`); }
  }
  async function coverFile(t) {
    if (t.coverPath) return t.coverPath;
    if (t.sourceType !== 'remote' || !t.hasCover) return null;
    const cached = remoteCache.get(`c:${t.id}`);
    if (cached) return cached;
    const req = sources.coverRequest(t);
    if (!req) return null;
    const dest = `cache/covers/${t.id.replace(/[^\w-]/g, '')}.img`;
    if (!(await fs.stat(dest))) {
      try { const r = await http(req.url, { headers: req.headers || {} }); if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) return null; await fs.write(dest, await r.blob()); } catch { return null; }
    }
    remoteCache.set(`c:${t.id}`, dest);
    return dest;
  }
  /** Warm blob URLs of covers so api.coverUrl() can answer synchronously (no-op on native: file URLs are sync). */
  let warming = null;
  function warmCovers(budgetMs = 300) {
    if (fs.kind === 'native') return Promise.resolve();
    const todo = library.allTracks().filter((t) => t.coverPath && !fs.urlSync(t.coverPath));
    if (!todo.length || warming) return warming || Promise.resolve();
    let created = 0;
    warming = (async () => {
      for (let i = 0; i < todo.length; i += 8) { await Promise.all(todo.slice(i, i + 8).map((t) => fs.url(t.coverPath).then((u) => { if (u) created++; }).catch(() => {}))); }
    })().finally(() => { warming = null; });
    const done = warming;
    return Promise.race([done, new Promise((r) => setTimeout(r, budgetMs))]).then(() => { done.then(() => { if (created) emit('library', { what: 'covers' }); }); });
  }

  // ---------------- health / capabilities ----------------
  route('GET', '/api/health', () => ({ ok: true }));
  route('GET', '/api/auth/status', () => ({ enabled: false, authenticated: true, setupRequired: false }));
  for (const p of ['/api/auth/login', '/api/auth/setup', '/api/auth/logout', '/api/auth/password']) route('POST', p, () => { throw UNAVAILABLE('Sign-in'); });
  const formats = ACCEPT.map((e) => e.slice(1)).filter((e) => !['ogg', 'oga', 'opus', 'webm'].includes(e) || canPlayType?.(`audio/${e === 'webm' ? 'webm' : 'ogg'}`));
  route('GET', '/api/capabilities', async () => ({
    ffmpeg: false, version: null, ffmpegSource: null, videoEncode: false, formats, formatGroups: { browser: formats, ffmpeg: [], all: formats },
    hosted: false, auth: false, local: true, native: !!platform.native, os: platform.os,
    upload: { maxMB: Number(library.settings.uploadMaxMB) || 2048, accept: formats.map((e) => '.' + e) }, transcodeCache: null,
    storage: await fs.usage?.().catch(() => null),
  }));
  route('GET', '/api/info', () => ({ version, dataDir: platform.native ? 'App storage' : 'Browser storage', platform: platform.os, tracks: Object.keys(library.data.tracks).length, hosted: false, auth: false, local: true }));

  // ---------------- tracks ----------------
  route('GET', '/api/tracks', async () => { await warmCovers(); return library.allTracks(); });
  route('PATCH', '/api/tracks/:id', async ({ params, body }) => library.updateTrack(track(params.id).id, body));
  route('POST', '/api/tracks/update', async ({ body }) => {
    const ids = (Array.isArray(body.ids) ? body.ids : []).filter((i) => library.getTrack(i));
    for (const i of ids) library.updateTrack(i, body.patch && typeof body.patch === 'object' ? body.patch : {});
    return { updated: ids.length };
  });
  route('GET', '/api/tracks/missing', async () => {
    const out = [];
    for (const t of library.allTracks()) { const f = localFile(t); if (f && !(await fs.stat(f))) out.push(t.id); }
    return out;
  });
  route('POST', '/api/tracks/relocate', () => { throw UNAVAILABLE('Relocating files'); });
  route('GET', '/api/tracks/duplicates', () => findDuplicates(library.allTracks()));
  route('POST', '/api/tracks/dedupe', async ({ body }) => mergeDuplicates(library, body.groups));
  route('POST', '/api/tracks/delete', async ({ body }) => {
    library.removeTracks(Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : []);
    return { ok: true };
  });
  route('POST', '/api/tracks/played', async ({ body }) => {
    const t = track(body.id); t.playCount = (t.playCount || 0) + 1; t.lastPlayed = Date.now();
    history.record(t, t.lastPlayed);
    library.changed('tracks'); return t;
  });
  route('GET', '/api/tracks/:id/stream', async ({ params }) => {
    const t = track(params.id);
    const { path, ext } = await streamFile(t);
    if ((ext === 'aif' || ext === 'aiff') && convertAiff) { const r = await aiffResponse(path); if (r) return r; }
    const r = await fs.response(path, AUDIO_MIME[ext] || 'application/octet-stream');
    if (!r) throw new HttpError(404, 'File missing');
    return r;
  });
  route('GET', '/api/tracks/:id/video', async ({ params }) => {
    const t = track(params.id);
    const file = localFile(t);
    const ext = extOf(file);
    if (!file || !VIDEO_MIME[ext] || t.hasVideo === false) throw new HttpError(404, 'This track has no video');
    const r = await fs.response(file, VIDEO_MIME[ext]);
    if (!r) throw new HttpError(404, 'File missing');
    return r;
  });
  route('GET', '/api/tracks/:id/cover', async ({ params }) => {
    const t = track(params.id);
    const f = await coverFile(t);
    const r = f ? await fs.response(f, t.coverPath ? `image/${extOf(f) === 'jpg' ? 'jpeg' : extOf(f)}` : 'image/jpeg') : null;
    return r || new Response(PLACEHOLDER_SVG, { headers: { 'Content-Type': 'image/svg+xml' } });
  });
  route('GET', '/api/tracks/:id/waveform', async ({ params }) => {
    const r = await fs.response(waveformPath(track(params.id).id), 'application/octet-stream');
    if (!r) throw new HttpError(404, 'Not analysed');
    return r;
  });
  route('PUT', '/api/tracks/:id/waveform', async ({ params, body }) => {
    if (!(body instanceof Uint8Array) && !(body instanceof Blob)) throw new HttpError(400, 'Expected binary body');
    if ((body.byteLength ?? body.size) > 16 * 1048576) throw new HttpError(413, 'Body too large');
    await fs.write(waveformPath(track(params.id).id), body);
    return { ok: true };
  });
  route('POST', '/api/files', () => { throw UNAVAILABLE('Adding files by path'); });

  // ---------------- import (copy-in) ----------------
  // Same contract as the server's browser upload: raw body (a File / Blob), file name in X-Filename.
  route('POST', '/api/upload', async ({ body, headers, query }) => {
    let name;
    try { name = decodeURIComponent(String(headers['x-filename'] || query.get('name') || '')); } catch { throw new HttpError(400, 'Bad file name'); }
    const blob = body instanceof Blob ? body : body instanceof Uint8Array ? new Blob([body]) : null;
    if (!blob) throw new HttpError(400, 'Expected a file');
    const r = await importer.importFile(blob, { name });
    library.changed('tracks');
    return r;
  }, { raw: true });

  // ---------------- playlists ----------------
  route('GET', '/api/playlists', () => resolvedPlaylists());
  route('POST', '/api/playlists', async ({ body }) => {
    const extra = body.folder ? { folder: String(body.folder).slice(0, 200) } : {};
    if (body.smart) extra.smart = normSmart(body.smart);
    const p = library.createPlaylist(body.name, Array.isArray(body.trackIds) ? body.trackIds.filter((x) => typeof x === 'string') : [], extra);
    return p.smart ? { ...p, trackIds: playlistTrackIds(p) } : p;
  });
  route('PATCH', '/api/playlists/:id', async ({ params, body }) => {
    const p = library.updatePlaylist(params.id, { ...body, ...(body.smart ? { smart: normSmart(body.smart) } : {}), ...('folder' in body ? { folder: body.folder ? String(body.folder).slice(0, 200) : body.folder } : {}) });
    if (!p) throw new HttpError(404, 'No playlist');
    return p.smart ? { ...p, trackIds: playlistTrackIds(p) } : p;
  });
  route('DELETE', '/api/playlists/:id', async ({ params }) => { library.deletePlaylist(params.id); return { ok: true }; });
  route('POST', '/api/playlists/:id/add', async ({ params, body }) => {
    if (library.getPlaylist(params.id)?.smart) throw new HttpError(400, 'Smart playlists are filled by their rules');
    const p = library.addToPlaylist(params.id, Array.isArray(body.trackIds) ? body.trackIds : []);
    if (!p) throw new HttpError(404, 'No playlist');
    return p;
  });
  route('GET', '/api/smart/fields', () => ({ fields: SMART_FIELDS, ops: SMART_OPS, sources: SOURCE_VALUES, colors: TRACK_COLORS }));
  route('POST', '/api/smart/preview', async ({ body }) => {
    const ids = evaluateSmart(normSmart(body.smart), library.allTracks());
    return { count: ids.length, trackIds: ids.slice(0, 500) };
  });
  /** Exported playlists name each file as it was imported (the app's own storage paths mean nothing elsewhere). */
  const exportName = (t) => t.fileName || (localFile(t) ? `${t.artist ? `${t.artist} - ` : ''}${t.title || t.id}.${extOf(localFile(t))}` : null);
  route('GET', '/api/playlists/:id/m3u', async ({ params }) => {
    const p = library.getPlaylist(params.id); if (!p) throw new HttpError(404, 'No playlist');
    return attachment(buildM3UWith(playlistTrackIds(p).map((t) => library.getTrack(t)).filter(Boolean), exportName), 'audio/x-mpegurl; charset=utf-8', `${String(p.name)}.m3u8`);
  });

  // ---------------- import / export of other apps' files ----------------
  const text = (body, key) => {
    if (body[key] != null) return String(body[key]);
    if (body.path) throw new HttpError(400, 'Choose the file with "Choose file…" (paths on a computer are not reachable from the phone)');
    throw new HttpError(400, 'Choose a file to import');
  };
  route('POST', '/api/import/m3u', async ({ body }) => {
    const match = trackMatcher(library.allTracks());
    const ids = [];
    for (const e of parseM3UEntries(text(body, 'content'))) { const t = match(e); if (t && !ids.includes(t.id)) ids.push(t.id); }
    return library.createPlaylist(body.name || 'Imported', ids);
  });
  route('POST', '/api/import/rekordbox', async ({ body }) => {
    let parsed;
    try { parsed = parseRekordboxXmlWith(XMLParser, text(body, 'xml')); } catch (e) { throw e.status ? e : new HttpError(400, e.message || 'Could not read this file'); }
    const match = trackMatcher(library.allTracks());
    const byLoc = new Map();
    let imported = 0, cuesAdded = 0, cuesSkipped = 0;
    for (const rt of parsed.tracks) {
      const t = match({ path: rt.location, artist: rt.artist, title: rt.title });
      if (!t) continue;
      byLoc.set(rt.location, t.id);
      const m = mergeImportedCues(t.cues, (rt.cues || []).map((c) => ({ ...c, index: c.type === 'memory' ? -1 : c.index })));
      cuesAdded += m.added; cuesSkipped += m.skipped;
      const fill = Object.fromEntries([['title', rt.title], ['artist', rt.artist], ['album', rt.album], ['genre', rt.genre]].filter(([k, v]) => v && !t[k]));
      library.updateTrack(t.id, {
        ...fill, bpm: rt.bpm || t.bpm, key: rt.key || t.key, rating: rt.rating ?? t.rating, comment: rt.comments || t.comment,
        ...(rt.cues?.length ? { cues: m.cues } : {}), gridOffset: rt.grid?.offset ?? t.gridOffset, analyzed: !!rt.bpm || t.analyzed,
        ...(rt.bpm && rt.grid ? { gridLocked: true } : rt.bpm ? { bpmLocked: true } : {}), ...(rt.color ? { color: rt.color } : {}),
      });
      imported++;
    }
    let playlists = 0;
    for (const pl of parsed.playlists) {
      const ids = pl.trackKeys.map((k) => byLoc.get(k)).filter(Boolean);
      library.createPlaylist(pl.name, ids, { folder: pl.path?.length ? pl.path.join(' / ') : 'rekordbox' }); playlists++;
    }
    return { imported, playlists, missing: parsed.tracks.length - imported, cuesAdded, cuesSkipped };
  });
  for (const k of ['traktor', 'serato', 'virtualdj']) route('POST', `/api/import/${k}`, () => { throw UNAVAILABLE(`${k[0].toUpperCase()}${k.slice(1)} import`); });
  route('GET', '/api/export/rekordbox', async () => {
    const tracks = library.allTracks().filter((t) => localFile(t)).map((t) => ({ ...t, path: exportName(t) }));
    const xml = buildRekordboxXml({ tracks, playlists: resolvedPlaylists().map((p) => ({ ...p, path: p.folder ? String(p.folder).split(' / ') : [] })) });
    return attachment(xml, 'application/xml; charset=utf-8', 'opendj-rekordbox.xml');
  });
  route('POST', '/api/export/usb', () => { throw UNAVAILABLE('Export to a USB drive'); });

  // ---------------- history ----------------
  route('GET', '/api/history', () => history.list());
  route('GET', '/api/history/:id', async ({ params }) => { const s = history.get(params.id); if (!s) throw new HttpError(404, 'No session'); return s; });
  route('PATCH', '/api/history/:id', async ({ params, body }) => { const s = history.rename(params.id, body.name); if (!s) throw new HttpError(404, 'No session'); emit('library', { what: 'history' }); return s; });
  route('DELETE', '/api/history/:id', async ({ params }) => { history.remove(params.id); emit('library', { what: 'history' }); return { ok: true }; });
  route('GET', '/api/history/:id/export', async ({ params, query }) => {
    const s = history.get(params.id); if (!s) throw new HttpError(404, 'No session');
    const fmt = ['txt', 'csv', 'm3u8'].includes(query.get('format')) ? query.get('format') : 'txt';
    const body = exportSession(s, fmt, (tid) => { const t = library.getTrack(tid); return t ? exportName(t) : null; });
    const type = { txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', m3u8: 'audio/x-mpegurl; charset=utf-8' }[fmt];
    return attachment(body, type, `${sessionTitle(s).replace(/:/g, '-')}.${fmt}`);
  });

  // ---------------- backup / restore ----------------
  route('GET', '/api/backup', async () => attachment(JSON.stringify(buildBackup(library, history)), 'application/json', `opendj-backup-${new Date().toISOString().slice(0, 10)}.json`));
  route('POST', '/api/restore', async ({ body }) => {
    // paths in a backup only mean something on the device that wrote it: keep app-storage paths, drop the rest
    const r = restoreBackup(library, history, body, { pathAllowed: (p) => /^(music|downloads|covers)\/[\w.-]+$/.test(p), isAbsolutePath: () => false });
    await library.flush(); await history.flush();
    return r;
  });

  // ---------------- folders / drives: phones have no shared music folder to scan ----------------
  route('GET', '/api/folders', () => []);
  route('POST', '/api/folders', () => { throw UNAVAILABLE('Adding folders'); });
  route('POST', '/api/folders/:id/scan', () => { throw UNAVAILABLE('Folder scanning'); });
  route('DELETE', '/api/folders/:id', async ({ params }) => { library.removeFolder(params.id); return { ok: true }; });
  route('GET', '/api/drives', () => []);
  route('GET', '/api/browse', () => { throw UNAVAILABLE('Browsing folders'); });

  // ---------------- media servers ----------------
  route('GET', '/api/source-types', () => SOURCE_TYPES);
  route('GET', '/api/sources', () => library.data.sources.map((s) => library.publicSource(s)));
  route('POST', '/api/sources', async ({ body }) => {
    const prev = typeof body.id === 'string' ? library.getSource(body.id) : null;
    if (body.id !== undefined && !prev) throw new HttpError(404, 'No source');
    let result;
    try { result = await sources.addSource(sourceConfigFromForm(body, prev)); } catch (e) { throw new HttpError(e.status || 502, scrub(e.message)); }
    runJob('sync:' + result.source.id, () => sources.syncSource(result.source.id, { onProgress: (p) => emit('sync', p) }));
    return result;
  });
  route('POST', '/api/sources/:id/sync', async ({ params }) => {
    if (!library.getSource(params.id)) throw new HttpError(404, 'No source');
    runJob('sync:' + params.id, () => sources.syncSource(params.id, { onProgress: (p) => emit('sync', p) }));
    return { started: true };
  });
  route('GET', '/api/sources/:id/libraries', async ({ params }) => {
    const c = sources.clientFor(params.id);
    try { await c.connect(); return await c.listLibraries(); } catch (e) { throw new HttpError(502, scrub(e.message)); }
  });
  // live media-server playlists and one playlist's tracks (stored as remote tracks, mirrored like the server does)
  route('GET', '/api/sources/:id/playlists', async ({ params }) => {
    if (!library.getSource(params.id)) throw new HttpError(404, 'No source');
    try { return await sources.sourcePlaylists(params.id); } catch (e) { throw new HttpError(e.status || 502, scrub(e.message)); }
  });
  route('GET', '/api/sources/:id/playlists/:pid', async ({ params, query }) => {
    if (!library.getSource(params.id)) throw new HttpError(404, 'No source');
    if (!params.pid || params.pid.length > 256) throw new HttpError(400, 'Bad playlist id');
    try { return await sources.openSourcePlaylist(params.id, params.pid, { name: query?.get?.('name') || undefined }); } catch (e) { throw new HttpError(e.status || 502, scrub(e.message)); }
  });
  route('DELETE', '/api/sources/:id', async ({ params }) => { library.removeSource(params.id); return { ok: true }; });
  route('GET', '/api/downloads', () => sources.downloads.list());
  route('POST', '/api/downloads', async ({ body }) => ({ queued: sources.downloads.enqueue(Array.isArray(body.trackIds) ? body.trackIds : []) }));
  route('POST', '/api/downloads/cancel', async ({ body }) => { sources.downloads.cancel(body.trackId); return { ok: true }; });

  // ---------------- settings ----------------
  route('GET', '/api/settings', () => redactSettings(library.settings));
  route('PUT', '/api/settings', async ({ body }) => {
    const patch = { ...body };
    for (const k of ['allowedRoots', 'recording', 'broadcast', 'downloadDir', 'uploadDir', 'transcodeCacheGB']) delete patch[k];
    const hue = patch.lighting?.outputs?.hue, curHue = library.settings.lighting?.outputs?.hue;
    if (hue?.username === REDACTED) hue.username = curHue?.username && String(hue.bridge || '') === String(curHue.bridge || '') ? curHue.username : '';
    return redactSettings(library.updateSettings(patch));
  });
  route('GET', '/api/jobs', () => [...jobs.keys()]);

  // ---------------- update check (same as the server's GET /api/update/check) ----------------
  // In the app CapacitorHttp makes the request (native networking: our own User-Agent / If-None-Match); in a plain
  // browser (?local=1) window.fetch does, without extra headers (no CORS preflight; the HTTP cache revalidates the ETag).
  const updates = new UpdateChecker({ fetch: http, version, conditional: !!platform.native, userAgent: !!platform.native });
  route('GET', '/api/update/check', async ({ query }) => {
    const force = query.get('force') === '1';
    const base = { hosted: false, auto: library.settings.updateCheck !== false };
    if (!force && library.settings.updateCheck === false) return { ...base, ok: true, disabled: true, current: updates.version, available: false, latest: null };
    return { ...base, ...(await updates.check({ force })) };
  });

  // ---------------- lyrics ----------------
  const lyricsCfg = () => ({ ...LYRICS_DEFAULTS, ...(library.settings.lyrics || {}), writeLrc: false });
  const lrcCache = { get: (k) => kv.get(`lrclib:${k}`), set: (k, v) => kv.set(`lrclib:${k}`, v) };
  async function lookupLyrics(t, { online = false, refresh = false } = {}) {
    let best = null;
    const consider = (l) => { if (!has(l) && !l?.instrumental) return false; if (!best || (!best.synced.length && l.synced?.length)) best = l; return best.synced.length > 0; };
    const user = await kv.get(`lyrics:${t.id}`).catch(() => null);
    if (user && consider(normalizeLyrics(user, 'user'))) return best;
    if (user && has(user)) return best;
    const file = localFile(t);
    if (file) {
      const blob = await fs.read(file).catch(() => null);
      const meta = blob ? await mm.parseBlob(blob, { duration: false, skipCovers: true }).catch(() => null) : null;
      if (consider(lyricsFromMetadata(meta))) return best;
    }
    if (t.sourceType === 'remote' && t.sourceId) {
      let c = null; try { c = sources.clientFor(t.sourceId); } catch { /* source gone */ }
      if (consider(await remoteLyricsFrom(c, library.getSource(t.sourceId)?.type, t).catch(() => null))) return best;
    }
    if (online || lyricsCfg().online) {
      const got = await lrclibLookupWith({ artist: t.artist, title: t.title, album: t.album, duration: t.duration }, { fetch: http, cache: lrcCache, refresh }).catch(() => null);
      if (consider(got)) return best;
    }
    return best || empty();
  }
  route('GET', '/api/tracks/:id/lyrics', async ({ params, query }) => {
    const { file, meta, ...out } = await lookupLyrics(track(params.id), { online: query.get('online') === '1', refresh: query.get('refresh') === '1' });
    return out;
  });
  route('PUT', '/api/tracks/:id/lyrics', async ({ params, body }) => {
    const t = track(params.id);
    let l = typeof body?.lrc === 'string' ? normalizeLyrics(parseLrc(body.lrc), 'user') : normalizeLyrics(body, 'user');
    if (!has(l)) throw new HttpError(400, 'No lyrics to save');
    l = { ...l, source: 'user' };
    await kv.set(`lyrics:${t.id}`, { ...l, updatedAt: Date.now() });
    emit('lyrics', { trackId: t.id });
    return { ...l, wroteLrc: null };
  });
  route('DELETE', '/api/tracks/:id/lyrics', async ({ params }) => { const t = track(params.id); await kv.del(`lyrics:${t.id}`); emit('lyrics', { trackId: t.id }); return { ok: true }; });
  route('GET', '/api/lyrics/settings', () => lyricsCfg());
  route('PUT', '/api/lyrics/settings', async ({ body }) => {
    library.updateSettings({ lyrics: { ...(library.settings.lyrics || {}), ...('online' in (body || {}) ? { online: !!body.online } : {}), writeLrc: false } });
    return lyricsCfg();
  });

  // ---------------- recording ----------------
  const recording = registerLocalRecording({ route, fs, kv, emit, getEngine, library });

  // ---------------- not on the phone (hidden in the UI; clear answers if something calls them anyway) ----------------
  route('GET', '/api/stems/status', () => ({ available: false, reason: 'AI stems are not available in the mobile app yet (the model is 174 MB and separation needs desktop-class CPU and memory).', model: { ready: false }, ort: false }));
  route('GET', '/api/lighting', () => ({ config: null, meta: null, live: null, available: false }));
  route('GET', '/api/link', () => { throw UNAVAILABLE('Ableton Link'); });
  route('GET', '/api/broadcast/config', () => { throw UNAVAILABLE('Live broadcasting'); });
  route('GET', '/api/broadcast/status', () => ({ active: false, outputs: [] }));
  for (const [m, p] of [['POST', '/api/broadcast/start'], ['GET', '/api/cdj/inspect'], ['POST', '/api/cdj/estimate'], ['POST', '/api/cdj/export'], ['PUT', '/api/lighting/config'], ['POST', '/api/stems/model/download']]) {
    route(m, p, () => { throw UNAVAILABLE(p.includes('cdj') ? 'CDJ USB export' : p.includes('lighting') ? 'Lighting control' : p.includes('stems') ? 'AI stems' : 'Live broadcasting'); });
  }

  // ---------------- public surface ----------------
  /** A URL for an /api/... media URL that <img>/<audio>/<video> can use right now, or null (then use urlFor). */
  function urlForSync(apiUrl) {
    const u = parseApi(apiUrl);
    if (!u) return null;
    if (u.kind === 'track') {
      const t = library.getTrack(u.id);
      if (!t) return u.what === 'cover' ? PLACEHOLDER_URL : null;
      if (u.what === 'cover') {
        const f = t.coverPath || remoteCache.get(`c:${t.id}`);
        if (f) return fs.urlSync(f) || null;
        return t.sourceType === 'remote' && t.hasCover ? null : PLACEHOLDER_URL;
      }
      const f = localFile(t) || remoteCache.get(`s:${t.id}`);
      if (!f || (convertAiff && /\.aiff?$/i.test(f))) return null;
      return fs.urlSync(f);
    }
    if (u.kind === 'recording') { const p = recording.fileUrlFor(u.name); return p ? fs.urlSync(p) : null; }
    return null;
  }
  /** Same as urlForSync, waiting for downloads / blob URLs where needed. */
  async function urlFor(apiUrl) {
    const now = urlForSync(apiUrl);
    if (now) return now;
    const u = parseApi(apiUrl);
    if (!u) return null;
    if (u.kind === 'track') {
      const t = library.getTrack(u.id);
      if (!t) return null;
      if (u.what === 'cover') { const f = await coverFile(t); return f ? fs.url(f) : PLACEHOLDER_URL; }
      if (u.what === 'stream' || u.what === 'video') {
        const { path, ext } = await streamFile(t);
        if ((ext === 'aif' || ext === 'aiff') && convertAiff) { const r = await aiffResponse(path); if (r) return URL.createObjectURL(await r.blob()); }
        return fs.url(path);
      }
    }
    if (u.kind === 'recording') { const p = recording.fileUrlFor(u.name); return p ? fs.url(p) : null; }
    return null;
  }

  /** Import a file picked with the native picker ({ name, size, path, webPath }) - copied by the plugin, not via JS. */
  async function importPicked(file, { copyFile, readBlob } = {}) {
    const r = await importer.importFile({ name: file.name, size: file.size, blob: null }, {
      name: file.name,
      copyIn: async (dest) => {
        if (copyFile) { try { await copyFile(file, dest); return; } catch (e) { log.warn?.('[opendj] native copy failed, streaming instead:', e?.message); } }
        await fs.write(dest, await readBlob(file));
      },
    });
    library.changed('tracks');
    return r;
  }

  // startup: tell the UI about files that vanished from app storage (e.g. the OS cleared space)
  setTimeout(async () => {
    let changed = false;
    for (const t of library.allTracks()) {
      const f = localFile(t);
      if (!f) continue;
      const miss = !(await fs.stat(f));
      if (!!t.missing !== miss) { if (miss) t.missing = true; else delete t.missing; changed = true; }
    }
    if (changed) emit('library', { what: 'missing' });
  }, 1500);

  return {
    router, hub, library, history, sources, importer, fs, kv, updates,
    handle: (method, url, init) => router.handle(method, url, init),
    subscribe: (fn) => hub.subscribe(fn),
    urlForSync, urlFor, importPicked, warmCovers,
    async flush() { await library.flush(); await history.flush(); },
  };
}

/** /api/tracks/:id/(cover|stream|video) and /api/recordings/file?name= */
export function parseApi(apiUrl) {
  let u;
  try { u = new URL(apiUrl, 'http://local.invalid'); } catch { return null; }
  const m = /^\/api\/tracks\/([^/]+)\/(cover|stream|video)$/.exec(u.pathname);
  if (m) { try { return { kind: 'track', id: decodeURIComponent(m[1]), what: m[2] }; } catch { return null; } }
  if (u.pathname === '/api/recordings/file' && !u.searchParams.get('download')) return { kind: 'recording', name: u.searchParams.get('name') };
  return null;
}
