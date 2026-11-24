// Frame clock for drawing: AudioContext.currentTime advances in audio-buffer sized steps (often 3-20 ms), which
// makes anything positioned from it (scrolling waveforms, platter, playheads) judder. smoothTime() runs a small
// phase-locked loop against requestAnimationFrame time instead: it advances by the real frame interval and is
// gently pulled towards currentTime, so it is smooth from frame to frame yet never drifts from the audio clock.
//
// Under load (a track decoding, a mix starting) the audio clock itself runs in bursts: it can stall for a few frames
// and then jump 50-100 ms at once. The loop doesn't follow that jump: it glides back, running at most SLEW faster or
// slower than real time, so the waveform and platters speed up or slow down slightly for a moment instead of
// jumping. Only a real discontinuity (RESYNC_S or more: the tab was in the background, the context was suspended)
// snaps straight to the audio clock.
const state = new WeakMap();
const GAIN = 0.1, SLEW = 0.25, RESYNC_S = 0.5;

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
  if (Math.abs(err) >= RESYNC_S) s.est = ct;
  else { const lim = SLEW * dt; s.est += Math.max(-lim, Math.min(lim, err * GAIN)); }
  return s.est;
}
