// LRC lyrics: parser / writer and timing lookups. Pure (no DOM): used by the server (server/lyrics.js) and the UI.
//
// Lyrics object: { synced: [{ t, text, words?: [{ t, text }], end? }], plain: string, meta: {}, source? }
// times are seconds of the audio file (track time), already corrected by [offset:].
//
// Supported LRC: [mm:ss.xx] / [mm:ss.xxx] / [mm:ss] / [mm:ss:xx] line stamps (minutes may exceed 59), several stamps per line
// ([00:12.00][01:30.00]chorus), metadata tags ([ti:] [ar:] [al:] [au:] [by:] [length:] [offset:+/-ms] …), and enhanced
// (A2) word timing: [00:12.00]<00:12.00>Word <00:12.40>by <00:12.90>word<00:13.50> (a trailing stamp ends the last word).

const TS = String.raw`(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?`;
const LINE_TS = new RegExp(String.raw`^\s*\[${TS}\]`);
const WORD_TS = new RegExp(String.raw`<${TS}>`, 'g');
const META = /^\s*\[([a-zA-Z#][\w#-]*):(.*)\]\s*$/;

/** "mm", "ss", "frac" groups → seconds ([mm:ss.xx], [mm:ss.xxx], [mm:ss:xx], [mm:ss]; minutes may exceed 59). */
function tsToSec(a, b, c) {
  return Number(a) * 60 + Number(b) + (c !== undefined ? Number(`0.${c.padEnd(2, '0')}`) : 0);
}

/** Split a line's text into words with enhanced timing. Returns { text, words, end } */
function parseWords(raw, lineT) {
  WORD_TS.lastIndex = 0;
  if (!WORD_TS.test(raw)) return { text: raw.trim(), words: null, end: null };
  WORD_TS.lastIndex = 0;
  const words = [];
  let last = 0, curT = lineT, m, end = null;
  const push = (txt, t) => { if (txt.length) words.push({ t, text: txt }); };
  while ((m = WORD_TS.exec(raw))) {
    push(raw.slice(last, m.index), curT);
    curT = tsToSec(m[1], m[2], m[3]);
    last = m.index + m[0].length;
  }
  const tail = raw.slice(last);
  if (tail.trim().length) push(tail, curT); else end = curT;
  // drop whitespace-only chunks but keep spacing on the words themselves
  const clean = words.filter((w) => w.text.trim().length);
  const text = clean.map((w) => w.text).join('').replace(/\s+/g, ' ').trim();
  return { text, words: clean.length ? clean : null, end };
}

/**
 * Parse LRC text.
 * @returns {{ synced: {t:number,text:string,words?:{t:number,text:string}[],end?:number}[], plain: string, meta: Record<string,string>, offset: number }}
 */
export function parseLrc(input) {
  const text = String(input ?? '').replace(/^﻿/, '');
  const meta = {};
  const entries = [];
  const plainLines = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    let line = rawLine;
    const stamps = [];
    let m;
    while ((m = LINE_TS.exec(line))) { stamps.push(tsToSec(m[1], m[2], m[3])); line = line.slice(m[0].length); }
    if (stamps.length) {
      // enhanced word stamps are absolute for the first line stamp; repeated stamps get them shifted
      const parsed = parseWords(line, stamps[0]);
      for (const t of stamps) {
        const shift = t - stamps[0];
        const e = { t, text: parsed.text };
        if (parsed.words) e.words = parsed.words.map((w) => ({ t: w.t + shift, text: w.text }));
        if (parsed.end != null) e.end = parsed.end + shift;
        entries.push(e);
      }
      continue;
    }
    const mm = META.exec(line);
    if (mm && !/^\d+$/.test(mm[1])) { meta[mm[1].toLowerCase()] = mm[2].trim(); continue; }
    if (line.trim()) plainLines.push(line.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim());
  }
  const offsetMs = Number(String(meta.offset ?? '0').replace(/\s+/g, '')) || 0;
  const off = offsetMs / 1000; // + = lyrics come earlier
  const adj = (t) => Math.max(0, Math.round((t - off) * 1000) / 1000);
  const synced = entries
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map(({ i, ...e }) => {
      const out = { t: adj(e.t), text: e.text };
      if (e.words) out.words = e.words.map((w) => ({ t: adj(w.t), text: w.text }));
      if (e.end != null) out.end = adj(e.end);
      return out;
    });
  const plain = synced.length ? synced.map((l) => l.text).filter((s, i, a) => s || (i > 0 && a[i - 1])).join('\n').trim() : plainLines.join('\n');
  return { synced, plain, meta, offset: offsetMs };
}

/** [mm:ss.xx] */
export function formatTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const m = Math.floor(cs / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Lyrics object → LRC text (enhanced word stamps when words are present). Times are written without [offset:]. */
export function buildLrc(lyrics, meta = lyrics?.meta || {}) {
  const out = [];
  for (const k of ['ti', 'ar', 'al', 'au', 'length', 'by']) if (meta[k]) out.push(`[${k}:${meta[k]}]`);
  out.push('[re:OpenDJ]');
  const synced = Array.isArray(lyrics?.synced) ? lyrics.synced : [];
  if (synced.length) {
    for (const l of synced) {
      if (l.words?.length) {
        const body = l.words.map((w) => `<${formatTime(w.t)}>${w.text}`).join('') + (l.end != null ? `<${formatTime(l.end)}>` : '');
        out.push(`[${formatTime(l.t)}]${body}`);
      } else out.push(`[${formatTime(l.t)}]${l.text || ''}`);
    }
  } else if (lyrics?.plain) out.push(...String(lyrics.plain).split(/\r?\n/));
  return out.join('\n') + '\n';
}

/** Plain text → unsynced lines (t = null) for the editor. */
export const plainToLines = (plain) => String(plain || '').split(/\r?\n/).map((text) => ({ t: null, text: text.trim() })).filter((l, i, a) => l.text || (i > 0 && a[i - 1].text));

/** Coerce anything lyrics-like (API payloads, user input) into a clean lyrics object. */
export function normalizeLyrics(v, source = v?.source ?? null) {
  const clampT = (t) => (Number.isFinite(Number(t)) && Number(t) >= 0 ? Math.round(Number(t) * 1000) / 1000 : null);
  const synced = (Array.isArray(v?.synced) ? v.synced : [])
    .map((l) => {
      const t = clampT(l?.t);
      if (t == null) return null;
      const o = { t, text: String(l.text ?? '').slice(0, 1000) };
      if (Array.isArray(l.words) && l.words.length) {
        const words = l.words.map((w) => ({ t: clampT(w?.t), text: String(w?.text ?? '').slice(0, 200) })).filter((w) => w.t != null && w.text);
        if (words.length) o.words = words.slice(0, 200);
      }
      const end = clampT(l.end);
      if (end != null && end >= t) o.end = end;
      return o;
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t)
    .slice(0, 5000);
  const plain = String(v?.plain ?? (synced.length ? synced.map((l) => l.text).join('\n') : '')).slice(0, 100000);
  return { synced, plain, source };
}

/** Index of the line playing at time t (last line with line.t ≤ t), −1 before the first. Binary search. */
export function lineIndexAt(synced, t) {
  let lo = 0, hi = (synced?.length || 0) - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (synced[mid].t <= t + 1e-9) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Where we are in the lyrics at track time t.
 * @returns {{ index, line, next, prev, progress, wordIndex, wordProgress, gap }}
 *   progress: 0..1 through the current line (until the next line or its end stamp); gap: true between a line's end
 *   and the next line (instrumental part).
 */
export function lyricStateAt(lyrics, t) {
  const s = lyrics?.synced || [];
  const index = lineIndexAt(s, t);
  const line = index >= 0 ? s[index] : null;
  const next = s[index + 1] || null;
  const prev = index > 0 ? s[index - 1] : null;
  const out = { index, line, next, prev, progress: 0, wordIndex: -1, wordProgress: 0, gap: false };
  if (!line) return out;
  const lineEnd = line.end ?? (line.words?.length ? Math.min(next?.t ?? Infinity, lineWordEnd(line)) : next?.t ?? line.t + 5);
  out.gap = !line.text || t > lineEnd;
  out.progress = lineEnd > line.t ? Math.max(0, Math.min(1, (t - line.t) / (lineEnd - line.t))) : 1;
  if (line.words?.length) {
    const w = line.words;
    let wi = -1;
    for (let i = 0; i < w.length; i++) if (w[i].t <= t + 1e-9) wi = i; else break;
    out.wordIndex = wi;
    if (wi >= 0) {
      const wEnd = w[wi + 1]?.t ?? lineEnd;
      out.wordProgress = wEnd > w[wi].t ? Math.max(0, Math.min(1, (t - w[wi].t) / (wEnd - w[wi].t))) : 1;
    }
  }
  return out;
}

/** End of the last word: its explicit end, else an estimate from its length. */
function lineWordEnd(line) {
  if (line.end != null) return line.end;
  const w = line.words[line.words.length - 1];
  return w.t + Math.max(0.3, Math.min(2, w.text.trim().length * 0.09));
}

/** Shift all times by dt seconds (offset nudge in the editor). */
export function shiftLyrics(lyrics, dt) {
  const sh = (t) => Math.max(0, Math.round((t + dt) * 1000) / 1000);
  return { ...lyrics, synced: (lyrics.synced || []).map((l) => ({ ...l, t: sh(l.t), ...(l.end != null ? { end: sh(l.end) } : {}), ...(l.words ? { words: l.words.map((w) => ({ ...w, t: sh(w.t) })) } : {}) })) };
}

/**
 * Track time that is being heard now on a deck: position minus what is still in the audio pipeline, scaled by the
 * playback rate (a tempo change makes the same latency cover more track time). Lyrics compare against this.
 */
export const heardTrackTime = (position, rate, lagSec, playing = true) => (playing ? Math.max(0, position - lagSec * rate) : position);
