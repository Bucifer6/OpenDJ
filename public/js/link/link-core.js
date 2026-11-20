// Pure helpers for the renderer side of Ableton Link (no DOM): clock mapping, tempo ratio, phase error.

/** Browser clock in µs on the same epoch base as the server's host clock (performance.timeOrigin + now). */
export const browserMicros = (perf = globalThis.performance) => (perf.timeOrigin + perf.now()) * 1000;

/**
 * Clock offset server − browser from ping samples [{ t0, t1, server }] (browser µs before/after, server µs):
 * NTP-style, the sample with the smallest round trip wins.
 */
export function estimateOffset(samples) {
  let best = null;
  for (const s of samples) {
    const rtt = s.t1 - s.t0;
    if (!(rtt >= 0)) continue;
    if (!best || rtt < best.rtt) best = { rtt, offset: s.server - (s.t0 + s.t1) / 2 };
  }
  return best;
}

/**
 * How much earlier than ctx.currentTime the audio being heard right now was scheduled (seconds):
 * from getOutputTimestamp() when available (includes the device's output latency), else outputLatency + baseLatency.
 */
export function audioLagSec(ctx, perfNow = globalThis.performance?.now() ?? 0) {
  if (!ctx) return 0;
  const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
  if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
    const heard = ts.contextTime + (perfNow - ts.performanceTime) / 1000;
    const lag = ctx.currentTime - heard;
    if (lag >= 0 && lag < 1) return lag;
  }
  return (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
}

/** Track position being heard now: the deck's position minus the audio still in the output pipeline. */
export const heardPosition = (pos, rate, lagSec, playing = true) => (playing ? pos - lagSec * rate : pos);

/** Tempo ratio that brings deckBpm to linkBpm, allowing half / double time (87 ↔ 174). */
export function tempoRatio(linkBpm, deckBpm) {
  if (!(linkBpm > 0) || !(deckBpm > 0)) return 1;
  const r = linkBpm / deckBpm;
  return [r, r * 2, r / 2].reduce((a, b) => (Math.abs(Math.log(b)) < Math.abs(Math.log(a)) ? b : a));
}

/** Link beats per deck beat for a ratio from tempoRatio(): 1, 2 (deck in half time) or 0.5. */
export function beatScale(linkBpm, deckBpm, ratio = tempoRatio(linkBpm, deckBpm)) {
  const s = linkBpm / (deckBpm * ratio);
  return s > 1.5 ? 2 : s < 0.75 ? 0.5 : 1;
}

/** Wrapped difference a − b in beats, in [−q/2, q/2). */
export function phaseError(a, b, quantum = 4) {
  let d = (a - b) % quantum;
  if (d >= quantum / 2) d -= quantum;
  if (d < -quantum / 2) d += quantum;
  return d;
}

/** Beats of a deck at a track position, counted from its first downbeat when known (bar phase), else from the grid. */
export function deckBeats(deck, pos) {
  if (!deck?.bpm) return 0;
  const beatLen = 60 / deck.bpm;
  const origin = Number.isFinite(deck.track?.downbeat) ? deck.track.downbeat : deck.gridOffset || 0;
  return (pos - origin) / beatLen;
}

/** Link beat at browser time `browserUs` extrapolated from a stream frame { beat, host, bpm } and the clock offset. */
export const linkBeatAt = (state, browserUs, offsetUs) => state.beat + ((browserUs + offsetUs - state.host) * state.bpm) / 60e6;

/**
 * One follow step: what to do with the deck to lock to Link.
 * @returns {{ tempo: number|null, seek: number|null, bend: number }}  tempo % for setTempo, seek target (s), bend
 */
export function followPlan({ linkBpm, linkBeat, quantum = 4, deckBpm, deckTempo, deckPos, deckBeat, playing, phaseLock = true, hardSeekBeats = 0.25, maxBend = 0.03 }) {
  const out = { tempo: null, seek: null, bend: 0, error: 0 };
  if (!(deckBpm > 0) || !(linkBpm > 0)) return out;
  const ratio = tempoRatio(linkBpm, deckBpm);
  const pct = (ratio - 1) * 100;
  if (Math.abs(pct - deckTempo) > 0.001) out.tempo = pct;
  if (!playing || !phaseLock) return out;
  const scale = beatScale(linkBpm, deckBpm, ratio);
  const err = phaseError(linkBeat, deckBeat * scale, quantum); // link beats; + means the deck is late
  out.error = err;
  const errSec = (err / scale) * (60 / deckBpm); // track seconds
  if (Math.abs(err) > hardSeekBeats) out.seek = deckPos + errSec;
  else if (Math.abs(err) > 0.004) out.bend = Math.max(-maxBend, Math.min(maxBend, errSec * 1.5));
  return out;
}
