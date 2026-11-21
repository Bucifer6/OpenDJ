// Lyrics lookups that need no file system: embedded tags (from a music-metadata result), media-server lyrics
// endpoints and LRCLIB (lrclib.net). Shared by the desktop server (server/lyrics.js) and the mobile app's on-device
// backend. Callers pass in fetch, the media-server client and a cache.
import { parseLrc, normalizeLyrics } from '../lyrics/lrc.js';
import { sha1Hex } from './hash.js';

export const LYRICS_USER_AGENT = 'OpenDJ (https://github.com/Bucifer6/OpenDJ)';
export const LYRICS_DEFAULTS = { online: false, writeLrc: false };
export const LRCLIB = 'https://lrclib.net';
const MISS_TTL = 7 * 24 * 3600 * 1000;
export const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
export const empty = () => ({ synced: [], plain: '', source: null });
export const has = (l) => !!(l && (l.synced?.length || l.plain?.trim()));

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

const TXXX_LYRICS = new Set(['LYRICS', 'UNSYNCEDLYRICS', 'UNSYNCED LYRICS', 'SYNCEDLYRICS', 'SYNCED LYRICS', 'USLT', 'LYRICS-XXX']);

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
      let k = String(id).toUpperCase();
      // ID3 user text frames: ffmpeg / Mp3tag / foobar2000 store lyrics as TXXX:LYRICS, TXXX:USLT, TXXX:UNSYNCEDLYRICS…
      if (k.startsWith('TXXX:')) {
        k = k.slice(5).trim();
        if (!TXXX_LYRICS.has(k)) continue;
        for (const v of Array.isArray(value) ? value : [value]) takeText(v);
        continue;
      }
      if (k === 'SYLT') takeSylt(value);
      else if (k === 'USLT' || k === 'ULT' || k === 'LYRICS' || k === 'UNSYNCEDLYRICS' || k === 'UNSYNCED LYRICS' || k === '©LYR' || k === 'LYRICS-XXX' || k === 'WM/LYRICS') takeText(value);
    }
  }
  for (const v of mm.common?.lyrics || []) { if (v?.syncText?.length) takeSylt(v); else takeText(v); }
  if (!synced.length && !plain) return null;
  return normalizeLyrics({ synced, plain: plain || synced.map((l) => l.text).join('\n') }, 'tags');
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

/** Lyrics of remote track `t` from its media server (`c`: its SourceClient, `type`: the source type). */
export async function remoteLyricsFrom(c, type, t) {
  if (!c || t.sourceType !== 'remote' || !t.remoteId) return null;
  type = String(type || '').toLowerCase();
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
export const lrclibCacheKey = (q) => sha1Hex(JSON.stringify([q.artist, q.title, q.album, Math.round(q.duration || 0)].map((x) => String(x ?? '').toLowerCase())));

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
/** `cache`: optional { get(key) -> record | null, set(key, record) } (async), keyed by lrclibCacheKey(). */
export async function lrclibLookupWith({ artist, title, album, duration }, { fetch: f = globalThis.fetch, baseUrl = LRCLIB, cache = null, refresh = false, timeoutMs = 8000 } = {}) {
  if (!artist || !title) return null;
  const q = { artist, title, album, duration };
  const key = cache ? lrclibCacheKey(q) : null;
  if (cache && !refresh) {
    const c = await Promise.resolve(cache.get(key)).catch(() => null);
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
  if (cache) {
    const hit = rec ? { id: rec.id, syncedLyrics: rec.syncedLyrics || null, plainLyrics: rec.plainLyrics || null, instrumental: !!rec.instrumental } : null;
    await Promise.resolve(cache.set(key, { at: Date.now(), hit })).catch(() => {});
  }
  return fromLrclib(rec);
}

