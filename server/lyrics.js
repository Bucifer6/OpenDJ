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
import { clientFor } from './remote.js';

export const LYRICS_USER_AGENT = 'OpenDJ (https://github.com/Bucifer6/OpenDJ)';
export const LYRICS_DEFAULTS = { online: false, writeLrc: false };
const LRCLIB = 'https://lrclib.net';
const MISS_TTL = 7 * 24 * 3600 * 1000;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const empty = () => ({ synced: [], plain: '', source: null });
const has = (l) => !!(l && (l.synced?.length || l.plain?.trim()));

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
/**
 * ID3 SYLT entries → lines. Lines break on "\n" at the start (or end) of a syllable; without any newline every entry is
 * a line. timeStampFormat 2 = ms, 1 = MPEG frames (converted with the frame duration).
 */
export function syltToLines(syncText, { timeStampFormat = 2, sampleRate = 44100, samplesPerFrame = 1152 } = {}) {
  const toSec = (ts) => (timeStampFormat === 1 ? (ts * samplesPerFrame) / sampleRate : ts / 1000);
  const items = (syncText || []).filter((e) => e && Number.isFinite(e.timestamp)).map((e) => ({ t: toSec(e.timestamp), text: String(e.text ?? '') }));
  if (!items.length) return [];
  const anyBreak = items.some((e) => /[\r\n]/.test(e.text));
  if (!anyBreak) return items.map((e) => ({ t: e.t, text: e.text.trim() })).filter((l) => l.text);
  const lines = [];
  let cur = null;
  for (const e of items) {
    const startsNew = /^[\r\n]/.test(e.text) || !cur || cur.closed;
    const txt = e.text.replace(/^[\r\n]+/, '');
    const closes = /[\r\n]$/.test(txt);
    const clean = txt.replace(/[\r\n]+$/, '');
    if (startsNew) { cur = { t: e.t, words: [] }; lines.push(cur); }
    if (clean) cur.words.push({ t: e.t, text: clean });
    if (closes) cur.closed = true;
  }
  return lines.map((l) => {
    const text = l.words.map((w) => w.text).join('').replace(/\s+/g, ' ').trim();
    const o = { t: l.t, text };
    if (l.words.length > 1) o.words = l.words;
    return o;
  }).filter((l) => l.text || l.words);
}

/** Lyrics from a music-metadata result (common + native tags). */
export function lyricsFromMetadata(mm) {
  if (!mm) return null;
  const sr = mm.format?.sampleRate || 44100;
  let synced = [], plain = '';
  const takeSylt = (v) => {
    if (synced.length || !v?.syncText?.length) return;
    synced = syltToLines(v.syncText, { timeStampFormat: v.timeStampFormat, sampleRate: sr });
  };
  const takeText = (v) => {
    if (plain) return;
    const s = typeof v === 'string' ? v : v?.text;
    if (typeof s !== 'string' || !s.trim()) return;
    // some taggers store a whole LRC file in USLT / LYRICS
    const p = parseLrc(s);
    if (p.synced.length && !synced.length) synced = p.synced;
    plain = p.synced.length ? p.plain : s.trim();
  };
  for (const tags of Object.values(mm.native || {})) {
    for (const { id, value } of tags || []) {
      const k = String(id).toUpperCase();
      if (k === 'SYLT') takeSylt(value);
      else if (k === 'USLT' || k === 'ULT' || k === 'LYRICS' || k === 'UNSYNCEDLYRICS' || k === 'UNSYNCED LYRICS' || k === '©LYR' || k === 'LYRICS-XXX' || k === 'WM/LYRICS') takeText(value);
    }
  }
  for (const v of mm.common?.lyrics || []) { if (v?.syncText?.length) takeSylt(v); else takeText(v); }
  if (!synced.length && !plain) return null;
  return normalizeLyrics({ synced, plain: plain || synced.map((l) => l.text).join('\n') }, 'tags');
}

export async function readEmbedded(file) {
  const mm = await parseFile(file, { duration: false, skipCovers: true }).catch(() => null);
  return lyricsFromMetadata(mm);
}

// ------------------------------------------------------------------ media servers
/** Jellyfin LyricDto { Metadata: { Offset? }, Lyrics: [{ Text, Start? (100 ns ticks) }] } → lyrics. */
export function fromJellyfin(dto) {
  const lines = Array.isArray(dto?.Lyrics) ? dto.Lyrics : [];
  if (!lines.length) return null;
  const off = Number(dto?.Metadata?.Offset) || 0; // ticks
  const timed = lines.every((l) => l.Start != null);
  if (timed) return normalizeLyrics({ synced: lines.map((l) => ({ t: (Number(l.Start) - off) / 1e7, text: l.Text || '' })) }, 'server');
  return normalizeLyrics({ synced: [], plain: lines.map((l) => l.Text || '').join('\n') }, 'server');
}
/** OpenSubsonic structuredLyrics [{ synced, offset (ms), line: [{ start (ms), value }] }] → lyrics. */
export function fromSubsonic(r) {
  const list = r?.lyricsList?.structuredLyrics || [];
  const syncedSet = list.find((x) => x.synced && x.line?.length);
  if (syncedSet) return normalizeLyrics({ synced: syncedSet.line.map((l) => ({ t: (Number(l.start) - (Number(syncedSet.offset) || 0)) / 1000, text: l.value || '' })) }, 'server');
  const plainSet = list.find((x) => x.line?.length);
  if (plainSet) return normalizeLyrics({ synced: [], plain: plainSet.line.map((l) => l.value || '').join('\n') }, 'server');
  const v = r?.lyrics?.value;
  return typeof v === 'string' && v.trim() ? normalizeLyrics({ synced: [], plain: v.trim() }, 'server') : null;
}
/** MediaMax (best effort, endpoint shape not documented here): { lrc } | { synced, plain } | { text }. */
export function fromGeneric(body) {
  if (!body) return null;
  if (typeof body === 'string') { const p = parseLrc(body); return has(p) ? normalizeLyrics(p, 'server') : null; }
  if (typeof body.lrc === 'string') { const p = parseLrc(body.lrc); if (has(p)) return normalizeLyrics(p, 'server'); }
  if (Array.isArray(body.synced) || typeof body.plain === 'string') { const l = normalizeLyrics(body, 'server'); return has(l) ? l : null; }
  const txt = body.text || body.lyrics;
  if (typeof txt === 'string' && txt.trim()) { const p = parseLrc(txt); return normalizeLyrics(p.synced.length ? p : { synced: [], plain: txt.trim() }, 'server'); }
  return null;
}

export async function remoteLyrics(library, t) {
  if (t.sourceType !== 'remote' || !t.sourceId || !t.remoteId) return null;
  let c;
  try { c = clientFor(library, t.sourceId); } catch { return null; }
  const type = String(library.getSource(t.sourceId)?.type || '').toLowerCase();
  const id = encodeURIComponent(t.remoteId);
  const retry = async (fn) => {
    try { return await fn(); } catch (e) {
      if (e.status === 401 && c.connect) { await c.connect(); return fn(); }
      throw e;
    }
  };
  try {
    if (type === 'jellyfin' || type === 'emby') return fromJellyfin(await retry(() => c._req(`/Audio/${id}/Lyrics`)));
    if (['subsonic', 'navidrome', 'airsonic'].includes(type)) {
      const r = await c._call('getLyricsBySongId', { id: t.remoteId }).catch(() => null);
      const got = fromSubsonic(r);
      if (got) return got;
      if (t.artist && t.title) return fromSubsonic(await c._call('getLyrics', { artist: t.artist, title: t.title }).catch(() => null));
      return null;
    }
    if (type === 'mediamax') return fromGeneric(await retry(() => c._req(`/api/v1/items/${id}/lyrics`)));
  } catch { /* server without lyrics support / not found */ }
  return null;
}

// ------------------------------------------------------------------ LRCLIB
const cacheKey = (q) => crypto.createHash('sha1').update(JSON.stringify([q.artist, q.title, q.album, Math.round(q.duration || 0)].map((x) => String(x ?? '').toLowerCase()))).digest('hex');

/** LRCLIB record → lyrics. */
export function fromLrclib(rec) {
  if (!rec) return null;
  if (rec.syncedLyrics) { const p = parseLrc(rec.syncedLyrics); if (p.synced.length) return { ...normalizeLyrics({ synced: p.synced, plain: rec.plainLyrics || p.plain }, 'lrclib'), lrclibId: rec.id }; }
  if (rec.plainLyrics) return { ...normalizeLyrics({ synced: [], plain: rec.plainLyrics }, 'lrclib'), lrclibId: rec.id };
  if (rec.instrumental) return { ...empty(), source: 'lrclib', instrumental: true };
  return null;
}

/**
 * Look up lyrics on LRCLIB: /api/get with the exact signature when album + duration are known, else /api/search
 * (closest duration within 3 s, synced preferred). Hits and misses are cached on disk.
 */
export async function lrclibLookup({ artist, title, album, duration }, { fetch: f = globalThis.fetch, baseUrl = LRCLIB, cacheDir = null, refresh = false, timeoutMs = 8000 } = {}) {
  if (!artist || !title) return null;
  const q = { artist, title, album, duration };
  const file = cacheDir ? path.join(cacheDir, `${cacheKey(q)}.json`) : null;
  if (file && !refresh) {
    const c = await fs.promises.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (c && (c.hit || Date.now() - c.at < MISS_TTL)) return c.hit ? fromLrclib(c.hit) : null;
  }
  const headers = { 'User-Agent': LYRICS_USER_AGENT, 'Lrclib-Client': LYRICS_USER_AGENT, Accept: 'application/json' };
  const get = async (url) => {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await f(url, { headers, signal: ctrl.signal });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`LRCLIB answered HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(tm); }
  };
  let rec = null;
  if (album && duration) {
    const u = new URL('/api/get', baseUrl);
    u.search = new URLSearchParams({ artist_name: artist, track_name: title, album_name: album, duration: String(Math.round(duration)) }).toString();
    rec = await get(u.toString());
  }
  if (!rec) {
    const u = new URL('/api/search', baseUrl);
    u.search = new URLSearchParams({ track_name: title, artist_name: artist }).toString();
    const list = await get(u.toString());
    if (Array.isArray(list) && list.length) {
      const ok = list.filter((x) => !duration || !x.duration || Math.abs(x.duration - duration) <= 3);
      rec = ok.sort((a, b) => (!!b.syncedLyrics - !!a.syncedLyrics) || (Math.abs((a.duration || 0) - (duration || 0)) - Math.abs((b.duration || 0) - (duration || 0))))[0] || null;
    }
  }
  if (file) {
    const hit = rec ? { id: rec.id, syncedLyrics: rec.syncedLyrics || null, plainLyrics: rec.plainLyrics || null, instrumental: !!rec.instrumental } : null;
    await fs.promises.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
    await fs.promises.writeFile(file, JSON.stringify({ at: Date.now(), hit })).catch(() => {});
  }
  return fromLrclib(rec);
}

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
