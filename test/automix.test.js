import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoMix, smartOrder, tempoDistance, keysClash, planMixOut, incomingStart, barOffsetBeats, phraseSwapPoint, mixLevels, energyTarget } from '../public/js/automix.js';

const BPM = 124, BEAT = 60 / BPM, BAR = 4 * BEAT;

test('tempoDistance allows half / double time', () => {
  assert.ok(tempoDistance(87, 174) < 1e-9);
  assert.ok(tempoDistance(140, 70) < 1e-9);
  assert.ok(Math.abs(tempoDistance(120, 132) - Math.log(1.1)) < 1e-9);
  assert.equal(tempoDistance(0, 120), 0);
});

test('keysClash uses the Camelot wheel', () => {
  assert.equal(keysClash('Am', 'C'), false);
  assert.equal(keysClash('8A', '9A'), false);
  assert.equal(keysClash('8A', '3B'), true);
  assert.equal(keysClash(null, '3B'), false);
});

const T = (id, bpm, key, energy) => ({ id, bpm, key, energy });

test('smartOrder harmonic: keeps current API and avoids big BPM jumps', () => {
  const tracks = [T('a', 120, '8A', 5), T('b', 140, '8A', 5), T('c', 124, '3B', 5), T('d', 70, '9A', 5), T('e', 127, '9A', 5)];
  const o = AutoMix.smartOrder(tracks);
  assert.equal(o.length, 5);
  assert.equal(o[0].id, 'a');
  // every step is within 8 % (half/double allowed) when such an ordering exists
  // the {120,124,127} cluster and the {70,140} pair need exactly one jump > 8 % (half/double time is not a jump)
  let jumps = 0;
  for (let i = 1; i < o.length; i++) if (tempoDistance(o[i - 1].bpm, o[i].bpm) > Math.log(1.08)) jumps++;
  assert.equal(jumps, 1, `${o.map((t) => t.id)}`);
  assert.equal(Math.abs(o.indexOf(tracks[1]) - o.indexOf(tracks[3])), 1, `${o.map((t) => t.id)}`);
  assert.deepEqual(smartOrder(tracks.slice(0, 2)), tracks.slice(0, 2));
});

test('smartOrder energy curves: build, peak, wave', () => {
  const tracks = [3, 9, 1, 7, 5, 2, 8, 4, 6, 10].map((e, i) => T(`t${i}`, 124, '8A', e));
  const build = smartOrder(tracks, 'build').map((t) => t.energy);
  assert.deepEqual(build, [...build].sort((a, b) => a - b), `build ${build}`);
  const peak = smartOrder(tracks, { mode: 'peak' }).map((t) => t.energy);
  const top = peak.indexOf(10);
  assert.ok(top >= 4 && top <= 7, `peak ${peak}`);
  assert.ok(peak[0] <= 2 && peak.at(-1) < 10 && peak.at(-1) > peak[0], `peak ${peak}`);
  const wave = smartOrder(tracks, 'wave').map((t) => t.energy);
  assert.equal(new Set(wave).size, 10);
  assert.ok(Math.max(...wave.slice(3, 7)) >= 8 && wave[0] <= 2, `wave ${wave}`);
  assert.equal(energyTarget('harmonic', 0.5), null);
});

test('smartOrder build still avoids big tempo jumps when energies tie', () => {
  const tracks = [T('a', 124, '8A', 5), T('b', 150, '8A', 5), T('c', 126, '8A', 5), T('d', 152, '8A', 5)];
  const o = smartOrder(tracks, 'build').map((t) => t.id).join('');
  assert.ok(o === 'acbd' || o === 'cabd' || o === 'bdac' || o === 'dbca', o);
});

const outTrack = (over = {}) => ({ bpm: BPM, gridOffset: 0.1, duration: 300, endTime: 299, downbeat: 0.1, ...over });

test('planMixOut starts at the outro and adapts the length to it', () => {
  const mixOut = 0.1 + 128 * BAR; // 16-bar outro until the end
  const end = mixOut + 16 * BAR;
  const t = outTrack({ mixOut, endTime: end, duration: end + 2 });
  // transition (32 beats = 8 bars) shorter than the outro: latest 8-bar boundary inside the outro
  let p = planMixOut(t, { transitionBeats: 32 });
  assert.ok(p.phrase);
  assert.ok(Math.abs(p.start - (mixOut + 8 * BAR)) < 1e-6, `start ${p.start}`);
  assert.ok(Math.abs(p.len - 8 * BAR) < 1e-6);
  // transition longer than the outro: whole outro
  p = planMixOut(t, { transitionBeats: 128 });
  assert.ok(Math.abs(p.start - mixOut) < 1e-6);
  assert.ok(Math.abs(p.len - 16 * BAR) < 1e-6);
  // phrases without mixOut: the trailing outro is found
  p = planMixOut(outTrack({ endTime: end, duration: end + 2, phrases: [{ start: 0.1, end: mixOut, type: 'drop' }, { start: mixOut, end, type: 'outro' }] }), { transitionBeats: 64 });
  assert.ok(Math.abs(p.start - mixOut) < 1e-6);
  // skipSilence off: uses the full duration
  p = planMixOut(t, { transitionBeats: 128, skipSilence: false });
  assert.ok(Math.abs(p.end - (end + 2)) < 1e-6);
});

test('planMixOut falls back to the old grid logic without structure', () => {
  const p = planMixOut(outTrack(), { transitionBeats: 32 });
  assert.equal(p.phrase, false);
  const phrases = (p.start - 0.1) / (16 * BEAT);
  assert.ok(Math.abs(phrases - Math.round(phrases)) < 1e-6);
  assert.ok(p.len >= 32 * BEAT - 1e-6 && p.len <= 32 * BEAT * 1.6);
  const nb = planMixOut({ bpm: 0, duration: 100, endTime: 100 }, {});
  assert.equal(nb.start, 88);
});

test('incoming start + bar alignment', () => {
  assert.equal(incomingStart({ bpm: BPM, gridOffset: 0.2, mixIn: 4.07, duration: 200 }), 4.07);
  // old fallback: first beat at/after startTime
  assert.ok(Math.abs(incomingStart({ bpm: BPM, gridOffset: 0.2, startTime: 1.0 }) - (0.2 + 2 * BEAT)) < 1e-6);
  assert.equal(incomingStart({ bpm: 0, startTime: 1.5 }), 1.5);
  // late by half a beat after a planned phrase start → offset half a beat
  const t = outTrack();
  assert.ok(Math.abs(barOffsetBeats(t, 100 + BEAT / 2, 100) - 0.5) < 1e-9);
  // far past the planned start (user seeked): offset = position inside the bar
  const pos = 0.1 + 50 * BAR + 2.25 * BEAT;
  assert.ok(Math.abs(barOffsetBeats(t, pos, 10) - 2.25) < 1e-6);
  assert.ok(Math.abs(barOffsetBeats(t, pos) - 2.25) < 1e-6);
});

test('phrase swap point lands on a phrase boundary of the incoming track', () => {
  const inn = { bpm: BPM, gridOffset: 0.05, mixIn: 0.05, phrases: [{ start: 0.05, type: 'intro' }, { start: 0.05 + 16 * BAR, type: 'drop' }] };
  // 32-bar transition: swap at the intro → drop boundary (bar 16)
  assert.ok(Math.abs(phraseSwapPoint(inn, 0.05, 32 * BAR) - (0.05 + 16 * BAR)) < 1e-6);
  // 8-bar transition, no phrase boundary inside: 4-bar boundary from the mix-in point
  assert.ok(Math.abs(phraseSwapPoint(inn, 0.05, 8 * BAR) - (0.05 + 4 * BAR)) < 1e-6);
  // 2-bar transition: bar boundary
  assert.ok(Math.abs(phraseSwapPoint({ ...inn, phrases: [] }, 0.05, 2 * BAR) - (0.05 + BAR)) < 1e-6);
  assert.equal(phraseSwapPoint({ bpm: 0 }, 10, 8), 14);
});

test('mixLevels: phrase style swaps the bass exactly once at the swap point', () => {
  const pre = mixLevels('phrase', 0.4, null);
  assert.equal(pre.inLow, -1); assert.equal(pre.outLow, 0); assert.equal(pre.outVol, 0.8);
  const post = mixLevels('phrase', 0.5, 0.5);
  assert.equal(post.inLow, 0); assert.equal(post.outLow, -1); assert.ok(Math.abs(post.outVol - 0.8) < 1e-9);
  assert.ok(mixLevels('phrase', 1, 0.5).outVol < 1e-9);
  // existing styles unchanged
  assert.deepEqual(Object.keys(mixLevels('eqswap', 0.3)).sort(), ['inHigh', 'inLow', 'inVol', 'outLow', 'outVol']);
  assert.equal(mixLevels('echo', 0.8).echo, true);
  assert.ok(mixLevels('filter', 1).outVol < 1e-9);
  const cf = mixLevels('crossfade', 0.5);
  assert.ok(Math.abs(cf.inVol - cf.outVol) < 1e-9);
});

function fakeApp() {
  return { engine: { on() {}, decks: [{ index: 0 }, { index: 1 }], channels: [] }, settings: { automix: { transitionBeats: 32, style: 'phrase' } }, toast() {} };
}

test('queue editing helpers', () => {
  const am = new AutoMix(fakeApp());
  let states = 0; am.on('state', () => states++);
  const q = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
  am.queue = [...q]; am.idx = 2; // a, b played; c next
  am.move(4, 2); // e plays next
  assert.deepEqual(am.queue.map((t) => t.id), ['a', 'b', 'e', 'c', 'd']);
  assert.equal(am.nextTrack().id, 'e');
  am.remove(0); // history entry
  assert.equal(am.idx, 1); assert.equal(am.nextTrack().id, 'e');
  am.remove(1); // remove the upcoming track
  assert.equal(am.nextTrack().id, 'c');
  am.insertNext([{ id: 'x' }, { id: 'y' }]);
  assert.deepEqual(am.queue.map((t) => t.id), ['b', 'x', 'y', 'c', 'd']);
  assert.equal(am.nextTrack().id, 'x');
  am.move(0, 3); // a played track moved into the future
  assert.deepEqual(am.queue.map((t) => t.id), ['x', 'y', 'c', 'b', 'd']);
  assert.equal(am.idx, 0); assert.equal(am.nextTrack().id, 'x');
  am.remove(99); am.move(7, 1);
  assert.equal(states, 5);
});

test('planMixOut never starts after the end of the track', async () => {
  const { planMixOut } = await import('../public/js/automix.js');
  for (const duration of [20, 60, 120.5, 201.7, 333]) for (const transitionBeats of [4, 8, 16, 32]) {
    const r = planMixOut({ bpm: 128, gridOffset: 0.1, duration, endTime: duration }, { transitionBeats });
    if (!(r.start <= r.end && r.len >= 0)) throw new Error(`bad plan for ${duration}s/${transitionBeats}: ${JSON.stringify(r)}`);
  }
});

test('N3: after a transition the incoming deck eases back to its original tempo over a few bars', async () => {
  const { tempoRampValue, TEMPO_RESTORE_BARS } = await import('../public/js/automix.js');
  assert.equal(tempoRampValue(4, 0), 4); assert.equal(tempoRampValue(4, 1), 0); assert.equal(tempoRampValue(-3, 0.5), -1.5);
  for (let k = 0.05; k <= 1; k += 0.05) assert.ok(tempoRampValue(4, k) <= tempoRampValue(4, k - 0.05) + 1e-9, 'monotonic');
  assert.ok(TEMPO_RESTORE_BARS >= 4 && TEMPO_RESTORE_BARS <= 16);
  // drive the ramp with a fake deck and clock
  const app = fakeApp(); app.settings.automix.restoreTempo = true;
  const am = new AutoMix(app);
  const deck = { tempo: 3.2, syncOn: false, effectiveBpm: 128, setTempo(v) { this.tempo = v; } };
  am.current = deck;
  const realNow = performance.now; let now = 1000; performance.now = () => now;
  try {
    am.startTempoRamp(deck);
    const dur = am.tempoRamp.dur;
    assert.ok(Math.abs(dur - TEMPO_RESTORE_BARS * 4 * 60 / 128 * 1000) < 1);
    now += dur / 2; am.stepTempoRamp();
    assert.ok(Math.abs(deck.tempo - 1.6) < 1e-9, `half way ${deck.tempo}`);
    now += dur; am.stepTempoRamp();
    assert.equal(deck.tempo, 0); assert.equal(am.tempoRamp, null);
    // the user moving the tempo fader cancels it
    deck.tempo = 2; am.startTempoRamp(deck); now += dur / 4; deck.tempo = 5; am.stepTempoRamp();
    assert.equal(am.tempoRamp, null); assert.equal(deck.tempo, 5);
    // option off
    app.settings.automix.restoreTempo = false; deck.tempo = 2; am.startTempoRamp(deck); assert.equal(am.tempoRamp, null);
  } finally { performance.now = realNow; }
});
