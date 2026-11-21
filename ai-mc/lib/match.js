// Finds a requested song in the OpenDJ library ("guta de ce" → "Nicolae Guță - De ce...").
export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/ș|ş/g, 's').replace(/ț|ţ/g, 't').replace(/[^a-z0-9]+/g, ' ').trim();

const STOP = new Set(['si', 'cu', 'de', 'la', 'pe', 'feat', 'ft', 'the', 'a', 'o', 'un', 'vreau', 'pune', 'piesa', 'melodia', 'te', 'rog']);
const words = (s) => norm(s).split(' ').filter((w) => w && !STOP.has(w));

export function scoreTrack(qWords, t) {
  const hay = norm(`${t.artist || ''} ${t.title || ''}`);
  const hw = new Set(hay.split(' '));
  if (!qWords.length) return 0;
  let s = 0;
  for (const w of qWords) {
    if (hw.has(w)) s += 1;
    else if (w.length >= 4 && hay.includes(w)) s += 0.7;
    else if (w.length >= 4 && [...hw].some((h) => h.length >= 4 && (h.startsWith(w.slice(0, 4)) || w.startsWith(h.slice(0, 4))))) s += 0.4;
  }
  const qn = norm(qWords.join(' '));
  if (hay.includes(qn)) s += 1;
  return s / qWords.length;
}

/** Returns the best matches, each { track, score } with score 0..~2. */
export function findTracks(tracks, query, n = 5) {
  const q = words(query);
  return tracks
    .filter((t) => !t.missing && !t.unreadable)
    .map((track) => ({ track, score: scoreTrack(q, track) }))
    .filter((x) => x.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

export const label = (t) => [t?.artist, t?.title].filter(Boolean).join(' - ') || t?.title || 'piesa asta';
