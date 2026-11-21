// Recording tracklists: .cue sheets and text tracklists. Shared by server/recorder.js and the mobile app.

const baseName = (p) => String(p || '').split(/[\\/]/).pop();

export function cueTime(sec) {
  const f = Math.max(0, Math.round(sec * 75));
  const m = Math.floor(f / 4500), s = Math.floor((f % 4500) / 75), fr = f % 75;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
}
/** hh:mm:ss (or mm:ss below an hour). */
export function clockTime(sec, long = false) {
  const t = Math.max(0, Math.floor(sec)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h || long ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
const cueStr = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim().slice(0, 200);

/** Normalise tracklist entries: sorted, de-duplicated consecutive repeats, numbers only. */
export function normTracklist(tracks) {
  const out = [];
  for (const t of [...(tracks || [])].filter((x) => x && Number.isFinite(Number(x.t))).sort((a, b) => a.t - b.t)) {
    const e = { t: Math.max(0, Number(t.t)), artist: String(t.artist || '').slice(0, 300), title: String(t.title || 'Unknown').slice(0, 300), ...(t.trackId ? { trackId: String(t.trackId).slice(0, 64) } : {}) };
    const prev = out.at(-1);
    if (prev && prev.title === e.title && prev.artist === e.artist) continue;
    out.push(e);
  }
  return out;
}

/**
 * Cue sheet for one audio file. `tracks`: [{ t (s), artist, title }] relative to the file start.
 * The first track always starts at 00:00:00 (required by most cue readers).
 */
export function buildCue({ file, title = 'OpenDJ mix', performer = '', tracks = [], format = 'wav' }) {
  const list = normTracklist(tracks);
  const type = format === 'mp3' ? 'MP3' : format === 'aiff' ? 'AIFF' : 'WAVE';
  const lines = ['REM COMMENT "Recorded with OpenDJ"', `REM DATE ${new Date().getFullYear()}`];
  if (performer) lines.push(`PERFORMER "${cueStr(performer)}"`);
  lines.push(`TITLE "${cueStr(title)}"`, `FILE "${cueStr(baseName(file))}" ${type}`);
  list.forEach((t, i) => {
    lines.push(`  TRACK ${String(i + 1).padStart(2, '0')} AUDIO`, `    TITLE "${cueStr(t.title)}"`);
    if (t.artist) lines.push(`    PERFORMER "${cueStr(t.artist)}"`);
    lines.push(`    INDEX 01 ${cueTime(i === 0 ? 0 : t.t)}`);
  });
  return lines.join('\r\n') + '\r\n';
}

/** Plain-text tracklist: "00:00 Artist - Title" per line. */
export function buildTracklistText({ title = 'OpenDJ mix', tracks = [], duration = 0 }) {
  const list = normTracklist(tracks);
  const long = duration >= 3600 || list.some((t) => t.t >= 3600);
  const lines = [title, ''];
  list.forEach((t, i) => lines.push(`${String(i + 1).padStart(2, '0')}. [${clockTime(t.t, long)}] ${t.artist ? `${t.artist} - ` : ''}${t.title}`));
  if (!list.length) lines.push('(no tracks detected)');
  return lines.join('\n') + '\n';
}

/** Tracks of a part [start, end) of a recording, shifted to the part start (the track playing at the cut starts it). */
export function tracksForPart(tracks, start, end = Infinity) {
  const list = normTracklist(tracks);
  const before = list.filter((t) => t.t <= start).at(-1);
  const inside = list.filter((t) => t.t > start && t.t < end).map((t) => ({ ...t, t: t.t - start }));
  return before ? [{ ...before, t: 0 }, ...inside] : inside;
}
