// Queue logic for background analysis (pure: no DOM / audio, unit-tested in test/analysis-queue.test.js).

/**
 * Does this track still need the automatic analysis (BPM / grid, key, energy, phrases, waveform)?
 * Skipped: analysed tracks, tracks with a locked BPM or imported grid (their grid is the user's / the other
 * DJ app's), unreadable and missing files, and, unless asked for explicitly, streaming-only media server
 * tracks (analysing those would download every file from the server).
 * `explicit` (the user picked "Analyse selected" / "Analyse all") includes streaming tracks and re-tries
 * tracks marked unreadable.
 */
export function needsAnalysis(t, { explicit = false } = {}) {
  if (!t || t.analyzed || t.missing) return false;
  if (t.bpmLocked || t.gridLocked) return false;
  if (t.unreadable && !explicit) return false;
  if (t.sourceType === 'remote' && !t.localPath && !explicit) return false;
  return true;
}

/** FIFO of track ids with de-duplication, priority insertion and progress counters. */
export class AnalysisQueue {
  constructor() { this.ids = []; this.set = new Set(); this.done = 0; this.failed = 0; this.total = 0; }
  get size() { return this.ids.length; }
  has(id) { return this.set.has(id); }
  /** Add ids (already queued ones are skipped; `front` moves them to the head, e.g. "Analyse selected"). Returns how many were new. */
  add(ids, { front = false } = {}) {
    let added = 0;
    const fresh = [];
    for (const id of ids) {
      if (this.set.has(id)) { if (front) { this.ids.splice(this.ids.indexOf(id), 1); fresh.push(id); } continue; }
      this.set.add(id); fresh.push(id); added++;
    }
    if (front) this.ids.unshift(...fresh); else this.ids.push(...fresh);
    this.total += added;
    return added;
  }
  /** Next id to analyse; `skip(id)` = drop ids that no longer need it (analysed meanwhile on a deck, removed…). */
  next(skip = () => false) {
    while (this.ids.length) {
      const id = this.ids.shift(); this.set.delete(id);
      if (skip(id)) { this.total = Math.max(this.done + this.failed, this.total - 1); continue; }
      return id;
    }
    return null;
  }
  finished(ok) { if (ok) this.done++; else this.failed++; }
  clear() { this.ids = []; this.set.clear(); this.reset(); }
  reset() { this.done = 0; this.failed = 0; this.total = this.ids.length; }
  /** "Analysing 12 / 2,000" (1-based position of the track being analysed). */
  label() {
    const n = this.done + this.failed + 1;
    return `Analysing ${Math.min(n, this.total).toLocaleString('en-US')} / ${this.total.toLocaleString('en-US')}`;
  }
}

/** Errors that mean the file itself can't be decoded (as opposed to a network hiccup or a server that is busy). */
export function isUndecodable(err) {
  if (!err) return false;
  if (err.name === 'EncodingError' || err.undecodable) return true;
  return /unable to decode|decod(e|ing) (audio )?data|empty file|no audio/i.test(String(err.message || ''));
}
