// Lyrics for tracks. Registered from server/index.js with registerLyricsRoutes({ route, library, emit, dataDir, canRead }).
//
// Sources, first hit wins (synced beats plain: a plain hit keeps looking for a synced one further down):
//   1. user edits saved in OpenDJ           <data dir>/lyrics/<trackId>.json
//   2. .lrc next to the audio file           same basename (Song.mp3 → Song.lrc / Song.LRC / Song.mp3.lrc)
//   3. embedded tags                         ID3 SYLT (synced) / USLT, Vorbis/FLAC LYRICS / UNSYNCEDLYRICS, MP4 ©lyr (music-metadata)
//   4. the media server                      Jellyfin/Emby /Audio/{id}/Lyrics, OpenSubsonic getLyricsBySongId / getLyrics, MediaMax
//   5. LRCLIB (lrclib.net)                   only when settings.lyrics.online is on (or ?online=1 from an explicit user action);
//                                            cached in <data dir>/lyrics-cache, sends only artist/title/album/duration and a
//                                            generic User-Agent.
//   GET    /api/tracks/:id/lyrics[?online=1&refresh=1]  → { synced: [{t, text, words?}], plain, source }
//   PUT    /api/tracks/:id/lyrics  { synced?, plain?, lrc?, writeLrc? }  save user edits (and optionally the .lrc file)
//   DELETE /api/tracks/:id/lyrics  forget user edits
//   GET/PUT /api/lyrics/settings   { online, writeLrc }
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { parseLrc, buildLrc, normalizeLyrics } from '../public/js/lyrics/lrc.js';
import { LRCLIB, LYRICS_DEFAULTS, bad, empty, has, lyricsFromMetadata, remoteLyricsFrom, lrclibLookupWith, lrclibCacheKey } from '../public/js/shared/lyrics-core.js';

export { LYRICS_USER_AGENT, LYRICS_DEFAULTS, syltToLines, lyricsFromMetadata, fromJellyfin, fromSubsonic, fromGeneric, fromLrclib } from '../public/js/shared/lyrics-core.js';
import { clientFor } from './remote.js';

// ------------------------------------------------------------------ files
/** Decode a lyrics text file: UTF-8 (BOM or not), UTF-16 with BOM, else Latin-1 when it is not valid UTF-8. */
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString('utf16le'); }
  const s = buf.toString('utf8');
  return s.includes('�') ? buf.toString('latin1') : s.replace(/^﻿/, '');
}

export function sidecarCandidates(file) {
  const dir = path.dirname(file), base = path.basename(file, path.extname(file));
  return [path.join(dir, `${base}.lrc`), path.join(dir, `${base}.LRC`), `${file}.lrc`];
}

export async function readSidecar(file) {
  for (const f of sidecarCandidates(file)) {
    const buf = await fs.promises.readFile(f).catch(() => null);
    if (!buf || buf.length > 2 * 1024 * 1024) continue;
    const p = parseLrc(decodeText(buf));
    if (has(p)) return { ...normalizeLyrics(p, 'lrc'), meta: p.meta, file: f };
  }
  return null;
}

// ------------------------------------------------------------------ embedded tags
export async function readEmbedded(file) {
  const mm = await parseFile(file, { duration: false, skipCovers: true }).catch(() => null);
  return lyricsFromMetadata(mm);
}

// ------------------------------------------------------------------ media servers
export async function remoteLyrics(library, t) {
  if (t.sourceType !== 'remote' || !t.sourceId || !t.remoteId) return null;
  let c;
  try { c = clientFor(library, t.sourceId); } catch { return null; }
  return remoteLyricsFrom(c, library.getSource(t.sourceId)?.type, t);
}

// ------------------------------------------------------------------ LRCLIB
/**
 * Look up lyrics on LRCLIB: /api/get with the exact signature when album + duration are known, else /api/search
 * (closest duration within 3 s, synced preferred). Hits and misses are cached on disk (cacheDir).
 */
export function lrclibLookup(q, { fetch: f = globalThis.fetch, baseUrl = LRCLIB, cacheDir = null, refresh = false, timeoutMs = 8000 } = {}) {
  const file = (key) => path.join(cacheDir, `${key}.json`);
  const cache = cacheDir ? {
    get: (key) => fs.promises.readFile(file(key), 'utf8').then(JSON.parse).catch(() => null),
    set: async (key, rec) => { await fs.promises.mkdir(cacheDir, { recursive: true }).catch(() => {}); await fs.promises.writeFile(file(key), JSON.stringify(rec)).catch(() => {}); },
  } : null;
  return lrclibLookupWith(q, { fetch: f, baseUrl, cache, refresh, timeoutMs });
}
export { lrclibCacheKey };

// ------------------------------------------------------------------ routes
export function registerLyricsRoutes({ route, library, emit = () => {}, dataDir = library?.dataDir, fetch: f = globalThis.fetch, canRead = () => true, canWrite = canRead, lrclibUrl = LRCLIB } = {}) {
  const userDir = path.join(dataDir, 'lyrics');
  const cacheDir = path.join(dataDir, 'lyrics-cache');
  let local = {}; // used when settings.lyrics is not a known settings key yet
  const cfg = () => ({ ...LYRICS_DEFAULTS, ...(library.settings?.lyrics || {}), ...local });
  const userFile = (id) => path.join(userDir, `${String(id).replace(/[^a-z0-9_-]/gi, '')}.json`);
  const track = (id) => { const t = library.getTrack(id); if (!t) throw bad('Track not found', 404); return t; };
  const localFile = (t) => {
    const p = t.localPath || (t.sourceType === 'local' ? t.path : null);
    return p && canRead(p) ? p : null;
  };

  async function lookup(t, { online = false, refresh = false } = {}) {
    let best = null;
    const consider = (l) => {
      if (!has(l) && !l?.instrumental) return false;
      if (!best || (!best.synced.length && l.synced?.length)) best = l;
      return best.synced.length > 0;
    };
    const user = await fs.promises.readFile(userFile(t.id), 'utf8').then(JSON.parse).catch(() => null);
    if (user && consider(normalizeLyrics(user, 'user'))) return best;
    if (user && has(user)) return best; // the user's own (plain) text wins over anything found elsewhere
    const file = localFile(t);
    if (file) {
      if (consider(await readSidecar(file))) return best;
      if (consider(await readEmbedded(file))) return best;
    }
    if (consider(await remoteLyrics(library, t))) return best;
    if (online || cfg().online) {
      const got = await lrclibLookup({ artist: t.artist, title: t.title, album: t.album, duration: t.duration }, { fetch: f, baseUrl: lrclibUrl, cacheDir, refresh }).catch(() => null);
      if (consider(got)) return best;
    }
    return best || empty();
  }

  route('GET', '/api/tracks/:id/lyrics', async ({ params, query }) => {
    const t = track(params.id);
    const l = await lookup(t, { online: query?.get?.('online') === '1', refresh: query?.get?.('refresh') === '1' });
    const { file, meta, ...out } = l;
    return out;
  });

  route('PUT', '/api/tracks/:id/lyrics', async ({ params, body }) => {
    const t = track(params.id);
    let l = typeof body?.lrc === 'string' ? normalizeLyrics(parseLrc(body.lrc), 'user') : normalizeLyrics(body, 'user');
    if (!has(l)) throw bad('No lyrics to save');
    l = { ...l, source: 'user' };
    await fs.promises.mkdir(userDir, { recursive: true });
    const tmp = `${userFile(t.id)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ ...l, updatedAt: Date.now() }));
    await fs.promises.rename(tmp, userFile(t.id));
    let wroteLrc = null;
    if (body?.writeLrc ?? cfg().writeLrc) {
      const file = localFile(t);
      if (!file || !canWrite(file)) throw bad('Saved in OpenDJ, but an .lrc file can only be written next to local files', 409);
      const lrcPath = sidecarCandidates(file)[0];
      await fs.promises.writeFile(lrcPath, buildLrc(l, { ti: t.title, ar: t.artist, al: t.album, length: t.duration ? `${Math.floor(t.duration / 60)}:${String(Math.round(t.duration % 60)).padStart(2, '0')}` : '' }));
      wroteLrc = lrcPath;
    }
    emit('lyrics', { trackId: t.id });
    return { ...l, wroteLrc };
  });

  route('DELETE', '/api/tracks/:id/lyrics', async ({ params }) => {
    const t = track(params.id);
    await fs.promises.unlink(userFile(t.id)).catch(() => {});
    emit('lyrics', { trackId: t.id });
    return { ok: true };
  });

  route('GET', '/api/lyrics/settings', () => cfg());
  route('PUT', '/api/lyrics/settings', async ({ body }) => {
    const patch = {};
    for (const k of Object.keys(LYRICS_DEFAULTS)) if (k in (body || {})) patch[k] = !!body[k];
    local = { ...local, ...patch };
    try { library.updateSettings?.({ lyrics: { ...(library.settings?.lyrics || {}), ...cfg() } }); } catch { /* */ }
    return cfg();
  });

  return { lookup };
}
