// Tracklist detection from deck play events: a track is "on air" once its deck plays it audibly (channel fader up,
// crossfader on its side) for `minSeconds`; it is logged at the moment it became audible. Pure logic in
// TracklistTracker (unit-tested under Node); watchTracklist() feeds it from the live engine.

/** Crossfader gain (0..1) for a channel assignment, matching Engine.applyCrossfader(). */
export function crossfaderGain(crossfader, assign, curve = 'smooth') {
  if (assign === 'THRU' || !assign) return 1;
  const x = (crossfader + 1) / 2;
  const p = assign === 'A' ? x : 1 - x;
  if (curve === 'sharp') return p < 0.92 ? 1 : (1 - p) / 0.08;
  if (curve === 'constant') return Math.min(1, 2 * (1 - p));
  return Math.min(1, Math.cos(p * Math.PI / 2) / Math.cos(Math.PI / 4));
}

/** Snapshot of the decks for the tracker: [{ index, key, artist, title, trackId, audible, level }]. */
export function deckSnapshot(engine, { minVolume = 0.2, minXf = 0.3 } = {}) {
  return engine.decks.map((d, i) => {
    const ch = engine.channels[i];
    const s = ch?.state || {};
    const xf = crossfaderGain(engine.crossfader || 0, s.xfAssign, engine.settings?.crossfaderCurve);
    const t = d.track;
    const audible = !!(t && d.playing && !d.cuePreview && (s.volume ?? 1) > minVolume && xf > minXf);
    return { index: i, key: t ? `${t.id || ''}|${t.title || ''}` : null, artist: t?.artist || '', title: t?.title || '', trackId: t?.id || null, audible, level: (s.volume ?? 1) * xf };
  });
}

export class TracklistTracker {
  constructor({ minSeconds = 10, onTrack = () => {} } = {}) {
    this.minSeconds = minSeconds; this.onTrack = onTrack;
    this.since = new Map();   // deck index -> { key, t } when it became audible with this track
    this.logged = [];         // [{ t, artist, title, trackId, deck }]
    this.current = null;      // key of the last logged track
  }
  /** now: seconds on the recording / broadcast clock. decks: deckSnapshot(). Returns newly logged entries. */
  update(now, decks) {
    const out = [];
    for (const d of decks) {
      const prev = this.since.get(d.index);
      if (!d.audible || !d.key) { this.since.delete(d.index); continue; }
      if (!prev || prev.key !== d.key) this.since.set(d.index, { key: d.key, t: now, done: false, d });
    }
    // candidates that have been audible long enough, oldest first
    const ready = [...this.since.values()].filter((s) => !s.done && now - s.t >= this.minSeconds).sort((a, b) => a.t - b.t);
    for (const s of ready) {
      s.done = true;
      if (s.key === this.current) continue;
      this.current = s.key;
      const e = { t: Math.max(0, s.t), artist: s.d.artist, title: s.d.title, trackId: s.d.trackId, deck: s.d.index };
      this.logged.push(e); out.push(e);
      this.onTrack(e);
    }
    return out;
  }
  /** The track that is most likely on air now (loudest audible deck), for "now playing". */
  static nowPlaying(decks) {
    const a = decks.filter((d) => d.audible).sort((x, y) => y.level - x.level)[0];
    return a ? { artist: a.artist, title: a.title, trackId: a.trackId } : null;
  }
}

/** Feed a tracker from the engine every 500 ms + on deck state changes. clock(): seconds. Returns a stop function. */
export function watchTracklist(engine, clock, tracker) {
  const tick = () => tracker.update(clock(), deckSnapshot(engine));
  const offs = engine.decks.map((d) => d.on?.('state', tick)).filter(Boolean);
  const iv = setInterval(tick, 500);
  tick();
  return () => { clearInterval(iv); offs.forEach((o) => o()); };
}
