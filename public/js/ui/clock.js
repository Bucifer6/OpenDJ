// Frame clock for drawing: AudioContext.currentTime advances in audio-buffer sized steps (often 3-20 ms), which
// makes anything positioned from it (scrolling waveforms, platter, playheads) judder. smoothTime() runs a small
// phase-locked loop against requestAnimationFrame time instead: it advances by the real frame interval and is
// gently pulled towards currentTime, so it is smooth from frame to frame yet never drifts from the audio clock.
const state = new WeakMap();

/** Smoothed audio-clock time for this animation frame (call with the rAF timestamp; same value for one frame). */
export function smoothTime(ctx, now = performance.now()) {
  const ct = ctx.currentTime;
  let s = state.get(ctx);
  if (!s) { s = { est: ct, now, frame: now }; state.set(ctx, s); return ct; }
  if (s.frame === now) return s.est;
  const dt = (now - s.now) / 1000;
  s.now = now; s.frame = now;
  if (ctx.state !== 'running' || dt <= 0 || dt > 0.25) { s.est = ct; return ct; }
  s.est += dt;
  const err = ct - s.est;
  if (Math.abs(err) > 0.06) s.est = ct; // seek, stall or tab in the background: resync
  else s.est += err * 0.1;
  return s.est;
}
