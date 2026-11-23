// What Automix plays (pure functions, no DOM): the library view or queue, the whole library, one playlist, or some
// genres; and for how long (the whole list, a timed set, or endless). Used by the AUTOMIX menu, the Automix dialog
// and the one-click start (app.js), and by tests.

/** Set lengths offered in the menu and the dialog: value -> label. 'all' = the whole list once. */
export const SET_LENGTHS = [
  ['all', 'Whole list (once)'],
  ['30', '30 minutes'],
  ['60', '1 hour'],
  ['120', '2 hours'],
  ['180', '3 hours'],
  ['endless', 'Endless (never runs out)'],
];

/** Automix start options for a set length: { minutes } or { endless: true } or {}. */
export function lengthOptions(value) {
  if (value === 'endless') return { endless: true };
  const m = Number(value);
  return m > 0 ? { minutes: m } : {};
}

/** Genre names in a track's genre field ("House; Deep House", "Hip-Hop/Rap" -> two each), trimmed. */
export function splitGenres(genre) {
  return String(genre || '').split(/\s*[;,/|]\s*/).map((g) => g.trim()).filter(Boolean);
}

/** Genres of a library, most tracks first: [{ name, count }]. Case-insensitive ("house" and "House" are one). */
export function libraryGenres(tracks) {
  const by = new Map();
  for (const t of tracks) {
    for (const g of new Set(splitGenres(t?.genre).map((x) => x.toLowerCase()))) {
      const e = by.get(g);
      if (e) e.count++;
      else by.set(g, { name: splitGenres(t.genre).find((x) => x.toLowerCase() === g), count: 1 });
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Tracks of a source.
 * source: { kind: 'view' } (the library view, or the queue when one is waiting) | { kind: 'library' } |
 *         { kind: 'playlist', id } | { kind: 'genres', genres: [names] }
 * ctx: { view: [tracks], queue: [tracks], tracks: [all library tracks], playlists: [{ id, name, trackIds }],
 *        track: (id) => track }
 * Returns { tracks, title } (title names the source for the dialog / toasts).
 */
export function sourceTracks(source, ctx) {
  const all = (ctx.tracks || []).filter((t) => t && !t.unreadable);
  switch (source?.kind) {
    case 'library': return { tracks: all, title: 'the whole library' };
    case 'playlist': {
      const p = (ctx.playlists || []).find((x) => x.id === source.id);
      if (!p) return { tracks: [], title: 'playlist' };
      return { tracks: (p.trackIds || []).map((id) => ctx.track?.(id)).filter((t) => t && !t.unreadable), title: `"${p.name}"` };
    }
    case 'genres': {
      const want = new Set((source.genres || []).map((g) => String(g).toLowerCase()));
      return {
        tracks: all.filter((t) => splitGenres(t.genre).some((g) => want.has(g.toLowerCase()))),
        title: [...(source.genres || [])].join(', ') || 'genres',
      };
    }
    default:
      return ctx.queue?.length ? { tracks: ctx.queue, title: 'the automix queue' } : { tracks: ctx.view || [], title: 'this view' };
  }
}
