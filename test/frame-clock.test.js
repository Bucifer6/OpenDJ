import test from 'node:test';
import assert from 'node:assert/strict';
import { smoothTime } from '../public/js/ui/clock.js';

// A fake AudioContext whose clock advances in 10 ms buffer steps, with an optional burst (a stall, then a catch-up).
function run({ frames = 300, burstAt = -1, stall = 0 }) {
  const ctx = { state: 'running', currentTime: 0 };
  let audio = 0; const out = [];
  for (let i = 0; i <= frames; i++) {
    const now = i * (1000 / 60);
    let real = now / 1000;
    if (burstAt >= 0 && i >= burstAt && i < burstAt + Math.round(stall * 60)) real = burstAt / 60; // clock stalls
    audio = Math.max(audio, real);
    ctx.currentTime = Math.floor(audio / 0.01) * 0.01;
    out.push([now, smoothTime(ctx, now), ctx.currentTime]);
  }
  return out;
}
const steps = (out) => out.slice(1).map((x, i) => (x[1] - out[i][1]) * 1000);

test('frame clock: smooth steps from a stepped audio clock, and stays locked to it', () => {
  const out = run({});
  const st = steps(out).slice(30);
  assert.ok(Math.max(...st) - Math.min(...st) < 3, `steps vary ${Math.min(...st)}..${Math.max(...st)} ms`);
  assert.ok(Math.abs(out.at(-1)[1] - out.at(-1)[2]) < 0.012, 'locked to the audio clock');
});

test('frame clock: a burst of the audio clock (stall then 80 ms catch-up) is glided over, not jumped', () => {
  const out = run({ burstAt: 100, stall: 0.08 });
  const st = steps(out);
  const frame = 1000 / 60;
  // never more than 25 % faster or slower than real time (+ the PLL's own small correction), never backwards
  for (const s of st.slice(30)) assert.ok(s > frame * 0.7 && s < frame * 1.3 + 1, `frame step ${s.toFixed(2)} ms`);
  assert.ok(Math.abs(out.at(-1)[1] - out.at(-1)[2]) < 0.012, 'back in lock afterwards');
});

test('frame clock: a real discontinuity (a suspended context, a background tab) resyncs at once', () => {
  const ctx = { state: 'running', currentTime: 1 };
  smoothTime(ctx, 0); smoothTime(ctx, 16.7);
  ctx.currentTime = 3; // 2 s later in audio time after one 16.7 ms frame
  assert.equal(smoothTime(ctx, 33.4), 3);
  ctx.state = 'suspended'; ctx.currentTime = 5;
  assert.equal(smoothTime(ctx, 50), 5);
});
