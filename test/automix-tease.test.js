import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTease, TEASE_BARS, TEASE_CHANCE } from '../public/js/automix-tricks.js';

const BPM = 124, BAR = 240 / BPM;
const track = (id, extra = {}) => ({ id, bpm: BPM, key: '8A', duration: 64 * BAR * 4, mixIn: 0,
  phrases: [{ type: 'intro', start: 0, end: 32 * BAR }, { type: 'drop', start: 32 * BAR, end: 96 * BAR }, { type: 'breakdown', start: 96 * BAR, end: 128 * BAR }, { type: 'drop', start: 128 * BAR, end: 224 * BAR }, { type: 'outro', start: 224 * BAR, end: 256 * BAR }], ...extra });

/** Pairs whose (stable) roll says "tease" in the given mode. */
function pairs(mode, n = 40) {
  const yes = [], no = [];
  for (let i = 0; i < n; i++) (planTease(track(`a${i}`), track(`b${i}`), { from: 0, to: 224 * BAR, mode }) ? yes : no).push(i);
  return { yes, no };
}

test('tease: sometimes (about a third of transitions, half in party mode), and the same pair always decides the same', () => {
  const subtle = pairs('subtle', 300), party = pairs('party', 300);
  assert.ok(Math.abs(subtle.yes.length / 300 - TEASE_CHANCE.subtle) < 0.1, `subtle ${subtle.yes.length}/300`);
  assert.ok(Math.abs(party.yes.length / 300 - TEASE_CHANCE.party) < 0.1, `party ${party.yes.length}/300`);
  const i = subtle.yes[0];
  assert.deepEqual(planTease(track(`a${i}`), track(`b${i}`), { from: 0, to: 224 * BAR }), planTease(track(`a${i}`), track(`b${i}`), { from: 0, to: 224 * BAR }));
  assert.equal(planTease(track('a'), track('b'), { from: 0, to: 224 * BAR, mode: 'off' }), null);
});

test('tease: 8 bars on a phrase line of the outgoing track, before the mix with room to spare, from the incoming hook', () => {
  const i = pairs('subtle').yes[0];
  const p = planTease(track(`a${i}`), track(`b${i}`), { from: 0, to: 224 * BAR });
  assert.equal(p.len, TEASE_BARS * BAR);
  assert.ok(p.end <= 224 * BAR - 8 * BAR + 1e-6, 'ends at least 8 bars before the transition');
  assert.ok(p.start >= 224 * BAR - 64 * BAR - 1e-6, 'close to the mix');
  assert.ok(Math.abs((p.start / BAR) % 8) < 1e-6, 'phrase line');
  assert.equal(p.cue, 32 * BAR, 'the incoming hook: its first drop');
  assert.equal(p.kind, 'filtered', 'no stems: top end only');
  assert.ok(p.start >= 96 * BAR && p.start < 128 * BAR || p.start >= 128 * BAR, JSON.stringify(p));
});

test('tease: with AI stems the vocal over an instrumental part, else the drums; clashing keys or tempos', () => {
  const i = pairs('party').yes[0];
  const vocals = (from, to, len = 256 * BAR) => Array.from({ length: Math.ceil(len) }, (_, s) => (s >= from && s < to ? 0.9 : 0));
  const out = track(`a${i}`, { vocalMap: vocals(0, 0) }), inn = track(`b${i}`, { vocalMap: vocals(32 * BAR, 96 * BAR) });
  assert.equal(planTease(out, inn, { from: 0, to: 224 * BAR, mode: 'party', stemsIn: true }).kind, 'vocal');
  const vocalOut = track(`a${i}`, { vocalMap: vocals(0, 256 * BAR) });
  assert.equal(planTease(vocalOut, inn, { from: 0, to: 224 * BAR, mode: 'party', stemsIn: true }).kind, 'drums', 'never two voices');
  assert.equal(planTease(out, inn, { from: 0, to: 224 * BAR, mode: 'party', stemsIn: true, keyClash: true }).kind, 'drums', 'a key clash: rhythm only');
  assert.equal(planTease(out, inn, { from: 0, to: 224 * BAR, mode: 'party', keyClash: true }), null, 'a clash without stems: no tease');
  assert.equal(planTease(out, track(`b${i}`, { bpm: 140 }), { from: 0, to: 224 * BAR, mode: 'party' }), null, 'tempos too far apart');
  assert.equal(planTease(out, inn, { from: 210 * BAR, to: 224 * BAR, mode: 'party' }), null, 'no room before the mix');
});

test('tease playback: starts on time and in phase, fades in and out, then the next deck waits on its cue again', async () => {
  const { AutoMix } = await import('../public/js/automix.js');
  const i = pairs('subtle').yes[0];
  const a = track(`a${i}`), b = track(`b${i}`);
  const chans = [0, 1].map(() => { const state = {}; return { state, set(k, v) { state[k] = v; } }; });
  const mk = (index, t) => ({ index, track: t, bpm: BPM, effectiveBpm: BPM, gridOffset: 0, beatLen: 60 / BPM, rate: 1, duration: t.duration, playing: false, loading: false, position: 0, bend: 0, syncOn: false,
    play(o) { this.playing = true; this.playedAt = o; }, pause() { this.playing = false; }, seek(p) { this.position = p; }, setBend(v) { this.bend = v; }, matchTempo() {},
    positionAt() { return this.position; }, beatPhase(p) { return ((p / this.beatLen) % 1 + 1) % 1; } });
  const out = mk(0, a), inn = mk(1, b);
  out.playing = true;
  const app = { engine: { on() {}, decks: [out, inn], channels: chans, ctx: { currentTime: 10 } }, settings: { automix: { tricks: 'subtle' } }, library: { track: () => null }, toast() {} };
  const am = new AutoMix(app);
  Object.assign(am, { enabled: true, current: out, queue: [a, b], idx: 1 });
  am.nextTransition = () => ({ begin: 224 * BAR });
  am.info = (d) => ({ ...d.track });
  out.position = 60 * BAR; am.stepTease();
  const plan = am.tease.plan;
  assert.ok(plan && !am.tease.on, 'planned, not started yet');
  out.position = plan.start; am.stepTease();
  assert.ok(am.tease.on && inn.playing, 'started on its phrase line');
  assert.equal(inn.playedAt.at, 10, 'played at the planned audio time'); assert.equal(inn.playedAt.instant, true);
  assert.equal(inn.position, plan.cue, 'from the hook, on the same beat'); assert.equal(inn.syncOn, true);
  assert.equal(chans[1].state.eqLow, -1); assert.ok(chans[1].state.filter > 0, 'top end only');
  const levels = [];
  for (let k = 0.05; k < 1; k += 0.1) { out.position = plan.start + k * plan.len; am.stepTease(); levels.push(chans[1].state.volume); }
  assert.ok(levels[0] < levels[4] && levels.at(-1) < levels[4] && Math.max(...levels) <= 0.6, `in, held, out: ${levels.map((v) => v.toFixed(2))}`);
  out.position = plan.end; am.stepTease();
  assert.equal(am.tease.on, false); assert.equal(inn.playing, false, 'stopped');
  assert.equal(chans[1].state.volume, 0); assert.equal(chans[1].state.eqLow, 0); assert.equal(chans[1].state.filter, 0);
  assert.equal(inn.position, 0, 'back on its cue for the real mix');
  out.position = plan.end + 4 * BAR; am.stepTease();
  assert.equal(inn.playing, false, 'once per pair');
});
