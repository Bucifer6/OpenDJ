// Smooth playback while other work runs: background AI-stem separation in the window waits between chunks during a
// mix transition or a deck load, and page stalls / audio dropouts are written to the app log with what was going on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHold } from '../public/js/stems/stem-dsp.js';
import { dropoutCount, perfContext, startPerfWatch } from '../public/js/perf-watch.js';

test('makeHold: gated chunks wait while held and carry on in order when released', async () => {
  const hold = makeHold(), done = [];
  const chunk = hold.gate(async (i) => { done.push(i); return i * 2; });
  assert.equal(await chunk(1), 2);
  hold.set(true);
  const p2 = chunk(2), p3 = chunk(3);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(done, [1], 'nothing runs while held');
  hold.set(false);
  assert.deepEqual(await Promise.all([p2, p3]), [4, 6]);
  assert.deepEqual(done, [1, 2, 3]);
});

test('StemsManager.setHold: holds a background job in this window, never one the DJ asked for', async () => {
  const { StemsManager } = await import('../public/js/stems/stems.js');
  const sent = [];
  const sm = Object.create(StemsManager.prototype);
  Object.assign(sm, { _wanted: new Set(), worker: { postMessage: (m) => sent.push(m) }, emit() {}, current: { id: 'bg', phase: 'separating' } });
  sm.setHold(true); assert.deepEqual(sent.at(-1), { type: 'hold', on: true }); assert.equal(sm.current.phase, 'waiting for the mix');
  sm.setHold(true); assert.equal(sent.length, 1, 'no repeat messages');
  sm.setHold(false); assert.deepEqual(sent.at(-1), { type: 'hold', on: false });
  sm.current = { id: 'mine', phase: 'separating' }; sm._wanted.add('mine');
  sm.setHold(true); assert.equal(sent.length, 2, 'a job the DJ asked for is not held');
  sm.current = null; sm.setHold(true); assert.equal(sent.length, 2, 'nothing to hold');
});

test('perf watch: dropouts where the browser counts them, the context, and one log line per window', async () => {
  assert.equal(dropoutCount({}), null);
  assert.equal(dropoutCount({ playbackStats: { underrunEvents: 3 } }), 3);
  assert.equal(dropoutCount({ playoutStats: { toJSON: () => ({ fallbackFramesEvents: 2 }) } }), 2);
  const app = { engine: { decks: [{ index: 0, playing: true }, { index: 1, playing: false, loading: true }], ctx: { playbackStats: { underrunEvents: 0 } } },
    automix: { transition: { style: 'blend' } }, stems: { current: { phase: 'separating' }, backend: { backend: 'webgpu' } } };
  assert.equal(perfContext(app), '1 deck(s) playing, Automix blend transition, deck 2 loading, stems separating in this window (webgpu)');
  // the watcher: a stall and two dropouts give one line; a quiet window gives none
  const lines = [];
  let observer = null;
  const win = { PerformanceObserver: class { constructor(cb) { observer = cb; } observe() {} } };
  const id = startPerfWatch(app, { every: 30, win, log: (t) => lines.push(t) });
  await new Promise((r) => setTimeout(r, 45));
  observer({ getEntries: () => [{ duration: 80 }, { duration: 250 }] });
  app.engine.ctx.playbackStats.underrunEvents = 2;
  await new Promise((r) => setTimeout(r, 40));
  await new Promise((r) => setTimeout(r, 40));
  clearInterval(id);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.match(lines[0], /^\[perf\] page busy 1x \(longest 250 ms\), audio dropouts 2x while 1 deck\(s\) playing, Automix blend transition/);
});
