import path from 'node:path';

export function parseM3U(content, baseDir) {
  const out = [];
  let info = null;
  for (const raw of content.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const m = /^#EXTINF:(-?\d+)[^,]*,(.*)$/.exec(line);
      info = m ? { duration: Number(m[1]), label: m[2] } : null;
      continue;
    }
    if (line.startsWith('#')) continue;
    let p = line;
    if (p.startsWith('file://')) p = decodeURIComponent(p.replace(/^file:\/\/(localhost)?/, '')).replace(/^\/([A-Za-z]:)/, '$1');
    if (!path.isAbsolute(p) && !/^[A-Za-z]:[\\/]/.test(p)) p = path.join(baseDir, p);
    out.push({ path: p, ...(info || {}) });
    info = null;
  }
  return out;
}

export function buildM3U(tracks, relativeTo) {
  const lines = ['#EXTM3U'];
  for (const t of tracks) {
    const p = t.localPath || t.path;
    if (!p) continue;
    lines.push(`#EXTINF:${Math.round(t.duration || -1)},${t.artist ? t.artist + ' - ' : ''}${t.title || ''}`);
    lines.push(relativeTo ? path.relative(relativeTo, p) : p);
  }
  return lines.join('\n') + '\n';
}
