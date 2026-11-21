// M3U / M3U8 playlists without path handling (shared by server/m3u.js and the mobile app's on-device backend).

/** Entries of an M3U file: { path (as written, file:// URLs decoded), duration?, label? }. */
export function parseM3UEntries(content) {
  const out = [];
  let info = null;
  for (const raw of String(content).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const m = /^#EXTINF:(-?\d+)[^,]*,(.*)$/.exec(line);
      info = m ? { duration: Number(m[1]), label: m[2] } : null;
      continue;
    }
    if (line.startsWith('#')) continue;
    let p = line;
    if (p.startsWith('file://')) { try { p = decodeURIComponent(p.replace(/^file:\/\/(localhost)?/, '')).replace(/^\/([A-Za-z]:)/, '$1'); } catch { /* keep as is */ } }
    out.push({ path: p, ...(info || {}) });
    info = null;
  }
  return out;
}

/** M3U8 text for tracks; `pathOf(track)` gives the line written for each (tracks without one are skipped). */
export function buildM3UWith(tracks, pathOf = (t) => t.localPath || t.path) {
  const lines = ['#EXTM3U'];
  for (const t of tracks) {
    const p = pathOf(t);
    if (!p) continue;
    lines.push(`#EXTINF:${Math.round(t.duration || -1)},${t.artist ? t.artist + ' - ' : ''}${t.title || ''}`);
    lines.push(p);
  }
  return lines.join('\n') + '\n';
}
