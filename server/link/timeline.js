// Link timeline math. A timeline maps time (µs) to beats: beats(t) = beatOrigin + (t - timeOrigin) · bpm / 60e6.
// The session timeline lives in "ghost time" (a clock shared by the session); each app keeps a client timeline in its
// own host time whose timeOrigin is the host time of session beat 0, because session beat 0 is the origin of the
// quantization grid for everybody: two peers are in phase when beats mod quantum agree.

export const MIN_BPM = 20;
export const MAX_BPM = 999;
/** Tempo as it survives the wire (integer µs per beat). */
export const quantizeBpm = (bpm) => 60e6 / Math.round(60e6 / Math.max(MIN_BPM, Math.min(MAX_BPM, Number(bpm) || 120)));

export const toBeats = (tl, t) => tl.beatOrigin + ((t - tl.timeOrigin) * tl.bpm) / 60e6;
export const fromBeats = (tl, b) => tl.timeOrigin + ((b - tl.beatOrigin) * 60e6) / tl.bpm;

/** beats mod quantum in [0, quantum), negative beats handled. */
export function phase(beats, quantum) {
  if (!(quantum > 0)) return 0;
  const r = beats % quantum;
  return r < 0 ? r + quantum : r + 0; // + 0 turns -0 into 0
}
/** Smallest value ≥ x whose phase equals target's phase. */
export function nextPhaseMatch(x, target, quantum) {
  if (!(quantum > 0)) return x;
  let d = (phase(target, quantum) - phase(x, quantum)) % quantum;
  if (d < 0) d += quantum;
  return x + d;
}
/** Value closest to x with the same phase as target. */
export const closestPhaseMatch = (x, target, quantum) => (quantum > 0 ? nextPhaseMatch(x - 0.5 * quantum, target, quantum) : x);

/** Client beat at host time t, snapped so its phase matches the session grid (session beat 0 = client timeOrigin). */
export function toPhaseEncodedBeats(client, t, quantum) {
  const b = toBeats(client, t);
  return closestPhaseMatch(b, b - client.beatOrigin, quantum);
}
/** Inverse of toPhaseEncodedBeats (host time at which a phase-encoded beat happens). */
export function fromPhaseEncodedBeats(client, beat, quantum) {
  let t = fromBeats(client, beat);
  for (let i = 0; i < 3; i++) {
    const err = beat - toPhaseEncodedBeats(client, t, quantum);
    if (Math.abs(err) < 1e-9) break;
    t += (err * 60e6) / client.bpm;
  }
  return t;
}

/**
 * New client timeline after the session timeline changed: keeps the client's beat count continuous at atHost,
 * takes the session tempo, and re-anchors timeOrigin at the host time of session beat 0.
 */
export function updateClientFromSession(client, session, atHost, ghostToHost) {
  const temp = { bpm: session.bpm, beatOrigin: toBeats(client, atHost), timeOrigin: atHost };
  const hostBeatZero = ghostToHost(fromBeats(session, 0));
  return { bpm: session.bpm, beatOrigin: toBeats(temp, hostBeatZero), timeOrigin: hostBeatZero };
}

/**
 * New session timeline from a client change (tempo and/or grid shift) at atHost.
 * The returned beatOrigin is the old session's beat at atHost but always > the old beatOrigin, because peers
 * resolve competing timelines of one session by the larger beatOrigin.
 */
export function updateSessionFromClient(session, client, atHost, hostToGhost) {
  const ghostBeat0 = hostToGhost(client.timeOrigin);
  if (Math.abs(ghostBeat0 - fromBeats(session, 0)) < 1 && Math.abs(client.bpm - session.bpm) < 1e-9) return session;
  const temp = { bpm: client.bpm, beatOrigin: 0, timeOrigin: ghostBeat0 };
  const atGhost = hostToGhost(atHost);
  // integer micro-beats so the value we keep equals what peers decode
  const newBeatOrigin = Math.round(Math.max(toBeats(session, atGhost), session.beatOrigin + 1) * 1e6) / 1e6;
  return { bpm: client.bpm, beatOrigin: newBeatOrigin, timeOrigin: Math.round(fromBeats(temp, newBeatOrigin)) };
}

/** Median of numbers (measurement result). */
export function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
