// Smart mix scoring / ordering and the automix style planner (pure functions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camelotRelation, scoreTransition, smartMix, liveNext, explain, shapeTarget, weightsFrom, shuffle, isClash, tempoDistance } from '../public/js/smartmix.js';
import { pickStyle, planTransition, normStyle, STYLES, DROP_STYLES, mixLevels, AutoMix } from '../public/js/automix.js';

const T = (id, o = {}) => ({ id, title: id, artist: o.artist || `Artist ${id}`, bpm: 124, key: '8A', energy: 5, genre: 'House', ...o });

test('camelot relations', () => {
  const k = (a, b) => camelotRelation(a, b).kind;
  assert.equal(k('8A', '8A'), 'same');
  assert.equal(k('8A', '9A'), 'up');
  assert.equal(k('8A', '7A'), 'down');
  assert.equal(k('12A', '1A'), 'up');
  assert.equal(k('8A', '8B'), 'relative');
  assert.equal(k('8A', '10A'), 'boost');
  assert.equal(k('Am', 'C'), 'relative');
  assert.equal(k('8A', '3B'), 'clash');
  assert.equal(k(null, '3B'), 'unknown');
  assert.ok(isClash('8A', '2A') && !isClash('8A', '9A'));
  assert.ok(camelotRelation('8A', '8A').value > camelotRelation('8A', '10A').value);
  assert.ok(camelotRelation('8A', '10A').value > camelotRelation('8A', '3B').value);
});

test('score: harmonic, tempo (half/double), genre, variety and unknown data', () => {
  const cur = T('c');
  const s = (o) => scoreTransition(cur, T('x', o)).score;
  assert.ok(s({ key: '9A' }) > s({ key: '3B' }), 'compatible key beats a clash');
  assert.ok(s({ bpm: 126 }) > s({ bpm: 140 }), 'closer tempo wins');
  // half / double time is no jump, but a feel change: × 0.85 on the tempo part (02-selection.md §2.3)
  assert.ok(s({ bpm: 248 }) < s({ bpm: 124 }) && s({ bpm: 248 }) > s({ bpm: 124 }) - 1.5 && s({ bpm: 248 }) > s({ bpm: 128 }), 'double time is no jump');
  assert.ok(s({ genre: 'House' }) > s({ genre: 'Drum & Bass' }), 'same genre wins');
  assert.ok(s({ artist: 'Artist c' }) < s({}) - 4, 'same artist as the previous track is penalised');
  // unknown key / bpm / energy: neutral, between a clash and a perfect match
  const unk = s({ key: null, bpm: null, energy: null });
  assert.ok(unk < s({}) && unk > s({ key: '3B', bpm: 150 }));
  assert.ok(tempoDistance(87, 174) < 1e-9);
});

test('explain: readable reasons', () => {
  assert.equal(explain(T('a', { energy: 6 }), T('b', { key: '9A', bpm: 126, energy: 7 })), '8A → 9A, 124 → 126 BPM, energy +1, same genre');
  assert.match(explain(T('a'), T('b', { key: '3B', genre: 'Techno' })), /key clash.*genre change/);
  assert.match(explain(T('a', { key: null, bpm: null }), T('b')), /key \?, BPM \?/);
});

test('smartMix: no harmonic clashes when a clash-free order exists', () => {
  // two compatible chains (8A-9A-10A-…) and every pair across them clashes except through the bridge 11A
  const keys = ['8A', '3B', '9A', '4B', '10A', '5B', '11A', '4A', '3A', '6B'];
  const pool = keys.map((k, i) => T(`t${i}`, { key: k, energy: 5 }));
  const { tracks } = smartMix(pool, { shape: 'steady' });
  assert.equal(tracks.length, pool.length);
  let clashes = 0;
  for (let i = 1; i < tracks.length; i++) if (isClash(tracks[i - 1].key, tracks[i].key)) clashes++;
  // the B keys (3B 4B 5B 6B) are a chain on their own, and A keys too; one join between them is unavoidable at most
  assert.ok(clashes <= 1, tracks.map((t) => t.key).join(' '));
});

test('smartMix: rising shape gives a monotonic energy rise', () => {
  const pool = [3, 9, 1, 7, 5, 2, 8, 4, 6, 10].map((e, i) => T(`t${i}`, { energy: e, key: i % 2 ? '8A' : '9A' }));
  const { tracks, steps } = smartMix(pool, { shape: 'rising' });
  const es = tracks.map((t) => t.energy);
  for (let i = 1; i < es.length; i++) assert.ok(es[i] >= es[i - 1], `energy ${es}`);
  assert.equal(steps.length, tracks.length);
  assert.match(steps[1].reason, /BPM/);
});

test('smartMix: no artist repeats within the window when avoidable', () => {
  const pool = [];
  for (let a = 0; a < 4; a++) for (let j = 0; j < 3; j++) pool.push(T(`a${a}-${j}`, { artist: `DJ ${a}`, energy: 5 }));
  const { tracks } = smartMix(pool, { shape: 'steady', sliders: { harmonic: 0.5, energy: 0.5, variety: 0.5 } });
  const W = weightsFrom({ variety: 0.5 }).artistWindow; // 4 artists: repeats can be at least 4 apart
  const win = Math.min(W, 3);
  for (let i = 0; i < tracks.length; i++) {
    for (let j = Math.max(0, i - win); j < i; j++) assert.notEqual(tracks[i].artist, tracks[j].artist, `${tracks.map((t) => t.artist).join(', ')}`);
  }
});

test('smartMix: big pools pick a limited set, warm-up shape peaks late, recently played tracks are skipped', () => {
  const pool = Array.from({ length: 300 }, (_, i) => T(`t${i}`, { energy: 1 + (i % 10), bpm: 120 + (i % 7), key: `${1 + (i % 12)}A`, artist: `A${i % 37}` }));
  const r = smartMix(pool, { shape: 'warmup' });
  assert.equal(r.tracks.length, 40);
  const es = r.tracks.map((t) => t.energy), top = es.indexOf(Math.max(...es));
  assert.ok(es[0] <= 3 && top > 10 && es.at(-1) < Math.max(...es), `warmup ${es}`);
  const history = r.tracks.slice(0, 10);
  const next = smartMix(pool, { shape: 'steady', limit: 10, history });
  assert.equal(next.tracks.filter((t) => history.includes(t)).length, 0);
  assert.ok(shapeTarget('steady', 0.5) === null && shapeTarget('rising', 1, 1, 10) === 10);
});

test('liveNext: best next track with a reason, never a played one', () => {
  const cur = T('cur', { key: '8A', bpm: 124, energy: 5 });
  const pool = [T('clash', { key: '2B' }), T('good', { key: '9A', bpm: 125, energy: 6 }), T('played', { key: '8A' }), T('far', { bpm: 150 })];
  const r = liveNext(cur, pool, { history: [pool[2]], shape: 'rising', position: 1, setLength: 4 });
  assert.equal(r.track.id, 'good');
  assert.match(r.reason, /8A → 9A/);
  assert.equal(liveNext(cur, [pool[2]], { history: [pool[2]] }), null);
});

test('shuffle keeps every track', () => {
  let x = 1; const rand = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  const a = Array.from({ length: 20 }, (_, i) => i), s = shuffle(a, rand);
  assert.deepEqual([...s].sort((p, q) => p - q), a);
  assert.notDeepEqual(s, a);
});

test('pickStyle: auto rules', () => {
  const p = (a, b) => pickStyle(T('a', a), T('b', b)).style;
  assert.equal(p({}, { bpm: 125 }), 'blend');
  assert.equal(p({}, { bpm: 140 }), 'echo');
  assert.equal(p({ energy: 4 }, { bpm: 140, energy: 8 }), 'cut');
  assert.equal(p({ energy: 8 }, { bpm: 100, energy: 4 }), 'reverb');
  assert.equal(p({}, { key: '3B' }), 'filter');
  assert.equal(p({}, { genre: 'Drum & Bass' }), 'filter');
  assert.equal(p({}, { energy: 8 }), 'bassswap');
  assert.equal(p({ bpm: null }, {}), 'echo');
  const v = pickStyle(T('a'), T('b', { bpm: 125 }), { prev: 'blend', vary: true, seed: 'x' });
  assert.notEqual(v.style, 'blend'); assert.match(v.why, /varied/);
  assert.equal(normStyle('phrase'), 'blend'); assert.equal(normStyle('eqswap'), 'bassswap'); assert.equal(normStyle('nope'), 'blend');
  assert.equal(STYLES.length, 12);
});

test('planTransition: drop styles land on a bar line with their pre-roll; blend styles start at the mix-out point', () => {
  const bpm = 124, beat = 60 / bpm, bar = 4 * beat;
  const t = { bpm, gridOffset: 0.1, downbeat: 0.1, duration: 300, endTime: 299, mixOut: 0.1 + 128 * bar };
  const blend = planTransition(t, 'blend', { transitionBeats: 32 });
  assert.ok(blend.start >= t.mixOut - 1e-6 && blend.start + blend.len <= t.endTime + 1e-6 && Math.abs(blend.len - 32 * beat) < 1e-6, JSON.stringify(blend));
  assert.ok(planTransition(t, 'bassswap', { transitionBeats: 64 }).len <= 16 * beat + 1e-6);
  for (const style of DROP_STYLES) {
    const p = planTransition(t, style, { transitionBeats: 32 });
    const bars = (p.drop - 0.1) / bar;
    assert.ok(Math.abs(bars - Math.round(bars)) < 1e-6, `${style} drop on a bar line (${bars})`);
    assert.ok(p.drop <= t.endTime && p.drop >= t.mixOut, style);
    assert.ok(Math.abs(p.drop - p.begin - p.pre * beat) < 1e-6, style);
    const imm = planTransition(t, style, { transitionBeats: 32 }, { pos: 100, immediate: true });
    assert.ok(imm.begin >= 100 - 1e-6 && imm.drop - imm.begin >= imm.pre * beat - 1e-6, style);
  }
  // short / unanalysed tracks: never past the end
  for (const style of DROP_STYLES) {
    const p = planTransition({ bpm: 128, gridOffset: 0, duration: 40, endTime: 40 }, style, { transitionBeats: 32 });
    assert.ok(p.drop <= 40 && p.begin >= 0, `${style} ${JSON.stringify(p)}`);
  }
});

test('mixLevels: crossfade keeps constant power, filter style opens the incoming low-pass', () => {
  for (let k = 0; k <= 1; k += 0.1) {
    const { inVol, outVol } = mixLevels('crossfade', k);
    const power = (inVol / 0.8) ** 4 + (outVol / 0.8) ** 4; // fader gain = vol², power = gain²
    assert.ok(Math.abs(power - 1) < 0.3, `k=${k.toFixed(1)} power ${power.toFixed(2)}`);
  }
  assert.ok(mixLevels('filter', 0).inFilter < -0.7 && mixLevels('filter', 1).inFilter === 0);
  assert.equal(mixLevels('blend', 0.8, 0.5).outLow, -1);
});

function fakeApp(style = 'auto') {
  const toasts = [];
  const decks = [{ index: 0 }, { index: 1 }];
  return { toasts, engine: { on() {}, decks, channels: [] }, settings: { automix: { transitionBeats: 32, style, onAirLoad: 'queue' } }, toast: (m) => toasts.push(m), library: { track: () => null } };
}

test('AutoMix.userLoad: next deck -> next track; on-air deck -> per setting; during a transition -> queued', async () => {
  const app = fakeApp();
  const am = new AutoMix(app);
  am.preloadNext = () => {}; // no real decks
  const [d0, d1] = app.engine.decks;
  am.enabled = true; am.current = d0; am.queue = [T('a'), T('b'), T('c')]; am.idx = 2;
  assert.equal(await am.userLoad(1, T('user1')), 'handled');
  assert.equal(am.nextTrack().id, 'user1');
  assert.match(app.toasts.at(-1), /up next/);
  assert.equal(await am.userLoad(0, T('user2')), 'handled'); // on air, setting 'queue'
  assert.equal(am.nextTrack().id, 'user2');
  app.settings.automix.onAirLoad = 'stop';
  assert.equal(await am.userLoad(0, T('user3')), 'load');
  assert.equal(am.enabled, false);
  am.enabled = true; am.transition = { out: d0, inn: d1 };
  assert.equal(await am.userLoad(0, T('user4')), 'handled');
  assert.equal(am.nextTrack().id, 'user4');
  assert.match(app.toasts.at(-1), /mixing/);
  assert.equal(await am.userLoad(2, T('deck3')), 'ignore', 'decks 3/4 are not automix decks');
  am.enabled = false;
  assert.equal(await am.userLoad(1, T('x')), 'ignore');
});

test('AutoMix.styleFor: overrides, auto per pair, vary', () => {
  const app = fakeApp('auto');
  const am = new AutoMix(app);
  am.queue = [T('a'), T('b', { bpm: 150 }), T('c', { bpm: 151 })]; am.idx = 1;
  assert.equal(am.styleFor(1, am.queue[0]).style, 'echo');
  am.setOverride(1, 'loop');
  assert.equal(am.styleFor(1, am.queue[0]).style, 'loop');
  assert.equal(am.styleFor(1, am.queue[0]).override, true);
  am.setOverride(1, 'default');
  app.settings.automix.style = 'cut';
  assert.equal(am.styleFor(2).style, 'cut');
  app.settings.automix.style = 'phrase';
  assert.equal(am.styleFor(2).style, 'blend');
});
