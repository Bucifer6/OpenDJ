// Party safety for automix (docs/PRO_DJ_AUTOMIX_RESEARCH.md P0.1): dead air is the one mistake a party never
// forgives. The watchdog looks at what actually comes out (master level) and whether the on-air deck is moving, and
// reports trouble that lasts longer than a planned silence would. Pure state machine: the caller feeds it the audio
// clock and decides how to rescue.

/** Peak below this (linear, about -50 dBFS) counts as silence. */
export const SILENCE_PEAK = Math.pow(10, -50 / 20);

/**
 * Silence / stall detector.
 * update({ t, level, position, playing, expectSilence, active }) once per tick:
 *   t: audio clock (s); level: master peak (linear); position: on-air deck position (s); playing: deck says it plays;
 *   expectSilence: the music itself is quiet here, or a planned effect (brake, pause drop) is running;
 *   active: automix is on and should be producing sound.
 * @returns {null | { kind: 'silent' | 'stalled' | 'stopped', for: number }} trouble lasting longer than its limit
 */
export class Watchdog {
  constructor({ silentFor = 2.5, stallFor = 2, stoppedFor = 1.5 } = {}) {
    this.limits = { silent: silentFor, stalled: stallFor, stopped: stoppedFor };
    this.reset();
  }
  reset() { this.since = { silent: null, stalled: null, stopped: null }; this.lastPos = null; this.lastT = null; this.cooldownUntil = -Infinity; }
  /** After a rescue, give the new track a moment to start before judging again. */
  cooldown(t, seconds = 4) { this.cooldownUntil = t + seconds; this.since = { silent: null, stalled: null, stopped: null }; }
  update({ t, level, position, playing, expectSilence = false, active = true }) {
    if (!active || !Number.isFinite(t)) { this.reset(); return null; }
    const moved = this.lastPos == null || !Number.isFinite(position) || Math.abs(position - this.lastPos) > 1e-4;
    const flags = {
      silent: !expectSilence && playing && Number.isFinite(level) && level < SILENCE_PEAK,
      stalled: playing && !moved && this.lastT != null && t > this.lastT,
      stopped: !playing,
    };
    if (moved || !playing) this.lastPos = position;
    this.lastT = t;
    if (t < this.cooldownUntil) return null;
    let worst = null;
    for (const kind of ['stopped', 'stalled', 'silent']) {
      if (!flags[kind]) { this.since[kind] = null; continue; }
      if (this.since[kind] == null) this.since[kind] = t;
      const lasted = t - this.since[kind];
      if (!worst && lasted >= this.limits[kind]) worst = { kind, for: lasted };
    }
    return worst;
  }
}

/**
 * Is the music itself quiet at `position` (track seconds)? From the deck's analysed waveform (peak per 1/rate s,
 * 0..255 relative to the track's loudest point): nothing in the next `span` seconds comes within `belowDb` of it.
 */
export function quietAt(waveform, position, span = 2, belowDb = 36) {
  const peak = waveform?.peak, rate = waveform?.rate;
  if (!peak?.length || !rate || !Number.isFinite(position)) return false;
  const i0 = Math.max(0, Math.floor(position * rate)), i1 = Math.min(peak.length, Math.ceil((position + span) * rate));
  if (i1 <= i0) return true; // past the end of the music
  const limit = 255 * Math.pow(10, -belowDb / 20);
  for (let i = i0; i < i1; i++) if (peak[i] > limit) return false;
  return true;
}
