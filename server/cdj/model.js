// OpenDJ track -> rekordbox device-library values (keys, colours, cue lists, beat grid, phrases, paths).
import crypto from 'node:crypto';
import path from 'node:path';
import { toCamelot, TRACK_COLORS } from '../smart.js';

// ---------------------------------------------------------------- keys
const CAMELOT_TO_NAME = {
  '1A': 'Abm', '2A': 'Ebm', '3A': 'Bbm', '4A': 'Fm', '5A': 'Cm', '6A': 'Gm', '7A': 'Dm', '8A': 'Am', '9A': 'Em', '10A': 'Bm', '11A': 'F#m', '12A': 'Dbm',
  '1B': 'B', '2B': 'F#', '3B': 'Db', '4B': 'Ab', '5B': 'Eb', '6B': 'Bb', '7B': 'F', '8B': 'C', '9B': 'G', '10B': 'D', '11B': 'A', '12B': 'E',
};
/** "8A" / "Am" / "A minor" -> "Am" (rekordbox classic notation, as shown on the players). */
export function keyName(k) {
  const c = toCamelot(k);
  return c ? CAMELOT_TO_NAME[c] : (k ? String(k).slice(0, 16) : '');
}

// ---------------------------------------------------------------- colours
const hexRgb = (h) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(h || '').trim()); return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : null; };
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const nearest = (rgb, list) => list.reduce((best, c, i) => { const d = dist2(rgb, c); return d < best.d ? { i, d } : best; }, { i: -1, d: Infinity });

/** Track / memory-cue colour: one of the 8 rekordbox colour ids (1 pink … 8 purple), 0 = none. */
export function colorId(hex) {
  const rgb = hexRgb(hex);
  if (!rgb) return 0;
  const exact = TRACK_COLORS.findIndex((c) => c.hex.toLowerCase() === String(hex).toLowerCase());
  if (exact >= 0) return exact + 1;
  const n = nearest(rgb, TRACK_COLORS.map((c) => hexRgb(c.hex)));
  return n.d < 120 ** 2 ? n.i + 1 : 0;
}

/**
 * rekordbox hot cue palette: colour code 0x01..0x3e -> RGB (the colours rekordbox shows; codes as documented by
 * the rekordbox export analysis / Beat Link). Players light their pads with the RGB we store next to the code.
 */
const HOT_CUE_PALETTE = ('305aff 5073ff 508cff 50a0ff 50b4ff 50b0f2 50aee8 45acdb 00e0ff 19daf0 32d2e6 21b4b9 20aaa0 1fa392 19a08c 14a584 '
  + '14aa7d 10b176 30d26e 37de5a 3ceb50 28e214 7dc13d 8cc832 9bd723 a5e116 a5dc0a aad208 b4c805 b4be04 bab404 c3af04 '
  + 'e1aa00 ffa000 ff9600 ff8c00 ff7500 e0641b e0461e e0301e e02823 e62828 ff376f ff2d6f ff127b f51e8c eb2da0 e637b4 '
  + 'de44cf de448d e630b4 e619dc e600ff dc00ff cc00ff b432ff b93cff c542ff aa5aff aa72ff 8272ff 6473ff').split(' ').map(hexRgb);

/** Hot cue colour -> { colorCode, rgb } (nearest palette entry); no colour -> code 0 (players show green). */
export function hotCueColor(hex) {
  const rgb = hexRgb(hex);
  if (!rgb) return { colorCode: 0, rgb: [0, 0, 0] };
  const n = nearest(rgb, HOT_CUE_PALETTE);
  return { colorCode: n.i + 1, rgb: HOT_CUE_PALETTE[n.i] };
}

// ---------------------------------------------------------------- formats
/** export.pdb file_type values. */
export const FILE_TYPES = { mp3: 0x01, m4a: 0x04, mp4: 0x04, aac: 0x04, flac: 0x05, wav: 0x0b, aif: 0x0c, aiff: 0x0c };
export const fileTypeOf = (file) => FILE_TYPES[path.extname(String(file)).slice(1).toLowerCase()] || 0;

// ---------------------------------------------------------------- beat grid
/**
 * Constant-tempo beat grid over the whole track: [{ beat 1..4, tempo BPM×100, time ms }].
 * gridOffset = time of the first beat (s); downbeat = time of a bar's first beat (s), defaults to gridOffset.
 */
export function beatGrid({ bpm, gridOffset = 0, downbeat, duration }) {
  if (!(bpm > 0) || !(duration > 0)) return [];
  const beatLen = 60 / bpm;
  let first = Number(gridOffset) || 0;
  first -= Math.floor(first / beatLen) * beatLen; // earliest beat at or after 0 on the grid
  const db = Number.isFinite(Number(downbeat)) && downbeat != null ? Number(downbeat) : Number(gridOffset) || 0;
  const tempo = Math.round(bpm * 100);
  const beats = [];
  for (let t = first, i = 0; t < duration && beats.length < 65535; t = first + ++i * beatLen) {
    const k = Math.round((t - db) / beatLen);
    beats.push({ beat: (((k % 4) + 4) % 4) + 1, tempo, time: Math.round(t * 1000) });
  }
  return beats;
}

/** 1-based beat number (index into the PQTZ grid) closest to a time in seconds. */
export function beatNumberAt(beats, t) {
  if (!beats.length) return 0;
  const ms = t * 1000;
  let lo = 0, hi = beats.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (beats[mid].time < ms) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(beats[lo - 1].time - ms) <= Math.abs(beats[lo].time - ms)) lo--;
  return lo + 1;
}

// ---------------------------------------------------------------- cues
/** Loop length as a power-of-two beat fraction (numerator, denominator), or zeros when not quantised. */
function loopFraction(len, bpm) {
  if (!(bpm > 0) || !(len > 0)) return [0, 0];
  const beats = len / (60 / bpm);
  for (let e = -5; e <= 9; e++) {
    const v = 2 ** e;
    if (Math.abs(beats - v) / v < 0.01) return e >= 0 ? [v, 1] : [1, 2 ** -e];
  }
  return [0, 0];
}

/** OpenDJ cues ({ index 0-7 hot | -1 memory, position s, name, color, loopEnd? }) -> PCOB/PCO2 cue models. */
export function cueLists(track) {
  const hotCues = []; const memoryCues = [];
  const seenHot = new Set();
  for (const c of Array.isArray(track.cues) ? track.cues : []) {
    const pos = Number(c.position);
    if (!Number.isFinite(pos) || pos < 0) continue;
    const isLoop = Number(c.loopEnd) > pos;
    const base = {
      type: isLoop ? 2 : 1, time: Math.round(pos * 1000), loopTime: isLoop ? Math.round(Number(c.loopEnd) * 1000) : undefined,
      comment: String(c.name || '').slice(0, 100),
    };
    if (isLoop) [base.loopNumerator, base.loopDenominator] = loopFraction(c.loopEnd - pos, track.bpm);
    const idx = Number(c.index);
    const hot = c.type !== 'memory' && Number.isInteger(idx) && idx >= 0;
    if (hot) {
      if (idx > 7 || seenHot.has(idx)) continue; // players have 8 hot cues (A–H)
      seenHot.add(idx);
      hotCues.push({ ...base, hotCue: idx + 1, ...hotCueColor(c.color) });
    } else memoryCues.push({ ...base, hotCue: 0, colorId: colorId(c.color) });
  }
  return { hotCues, memoryCues };
}

// ---------------------------------------------------------------- phrases (PSSI, "high" mood)
const PHRASE_KIND = { intro: [1, { k1: 1 }], buildup: [2, {}], verse: [2, {}], drop: [5, { k1: 1 }], breakdown: [3, {}], outro: [6, { k1: 1 }] };
/** OpenDJ phrases ({ start, end, type }) -> PSSI model on the given beat grid; null when not possible. */
export function phraseStructure(phrases, beats) {
  if (!Array.isArray(phrases) || !phrases.length || !beats.length) return null;
  const entries = [];
  for (const p of phrases) {
    const [kind, k] = PHRASE_KIND[p.type] || [2, {}];
    const beat = beatNumberAt(beats, Number(p.start) || 0);
    if (entries.length && beat <= entries.at(-1).beat) continue;
    entries.push({ beat, kind, ...k });
  }
  if (!entries.length) return null;
  const endBeat = Math.max(entries.at(-1).beat + 1, beatNumberAt(beats, Number(phrases.at(-1).end) || 0));
  return { mood: 1, bank: 0, endBeat: Math.min(0xffff, endBeat), entries: entries.slice(0, 255) };
}

// ---------------------------------------------------------------- paths
/** FAT32-safe path segment (CDJs read long UTF-16 file names; we keep them short-ish). */
export function safeSegment(s, max = 64, fallback = 'Unknown') {
  let v = String(s ?? '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/\s+/g, ' ').trim();
  v = v.replace(/[. ]+$/, '').replace(/^\.+/, '');
  if (v.length > max) v = v.slice(0, max).replace(/[. ]+$/, '');
  if (!v || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(v)) v = fallback;
  return v;
}

/** rekordbox-style analysis folder: /PIONEER/USBANLZ/Pxxx/xxxxxxxx (derived from a hash of the audio path). */
export function anlzDir(devicePath) {
  const h = crypto.createHash('sha1').update(String(devicePath)).digest();
  const p = (h.readUInt16BE(0) & 0x3ff).toString(16).toUpperCase().padStart(3, '0');
  const d = (h.readUInt32BE(2) & 0x7ffffff).toString(16).toUpperCase().padStart(8, '0');
  return `/PIONEER/USBANLZ/P${p}/${d}`;
}

/** Small stable non-zero number for the track row's unknown "u2" word (rekordbox stores some id there). */
export function u2For(devicePath) { return crypto.createHash('md5').update(String(devicePath)).digest().readUInt32LE(0) >>> 0; }
