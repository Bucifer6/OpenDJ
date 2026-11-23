// Smart mix track selection rules (docs/PRO_DJ_AUTOMIX_RESEARCH.md §P3, docs/automix-research/02-selection.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  camelotRelation, scoreTransition, liveNext, smartMix, explain, shapeTarget, partyTarget, arcPhase, SET_SHAPES,
  songKey, vocalDensity, familiarityInfo, isFamiliar, skipFeedback, playFeedback, isOpenFormat, genreFamilies, soundSimilarity,
} from '../public/js/smartmix.js';
import { encodeVocalMap } from '../public/js/shared/vocal-map.js';

const T = (id, o = {}) => ({ id, title: id, artist: o.artist || `Artist ${id}`, bpm: 124, key: '8A', energy: 5, genre: 'House', ...o });
const at = (h, m = 0) => new Date(2026, 5, 6, h, m).getTime(); // local clock time on a Saturday
const vocals = (level) => ({ stems: { vocals: encodeVocalMap(new Array(60).fill(level)) } });

test('camelot values follow the research ranking; kinds unchanged', () => {
  const v = (a, b) => camelotRelation(a, b).value;
  assert.deepEqual([v('8A', '8A'), v('8A', '9A'), v('8A', '8B'), v('8A', '7A'), v('8A', '9B'), v('8A', '10A'), v('8A', '3A'), v('8A', '6A'), v('8A', '2A')],
    [1, 0.9, 0.85, 0.85, 0.75, 0.6, 0.4, 0.4, -1]);
  assert.equal(camelotRelation('8A', '9B').kind, 'diagonal');
  assert.equal(camelotRelation('8A', '3A').kind, 'semitone');
});

test('harmonic part is scaled by key confidence (min of both, missing = 1)', () => {
  const cur = T('c');
  const h = (o, co = {}) => scoreTransition({ ...cur, ...co }, T('x', o)).parts.harmonic;
  assert.ok(Math.abs(h({ key: '9A' }) - 0.9) < 1e-9);
  assert.ok(Math.abs(h({ key: '9A', keyConfidence: 0.5 }) - 0.9 * 0.7) < 1e-9);
  assert.ok(Math.abs(h({ key: '9A', keyConfidence: 0.9 }, { keyConfidence: 0 }) - 0.9 * 0.4) < 1e-9, 'min of the two');
  assert.ok(h({ key: '2A', keyConfidence: 0.2 }) > h({ key: '2A' }), 'an unsure clash hurts less');
});

test('boost / semitone key moves: only good when the arc rises; at most 1 per 6 tracks', () => {
  const cur = T('c', { energy: 5 });
  const rising = { shape: 'rising', x: 7 / 9, lo: 1, hi: 10 }; // target 8 > 5
  const flat = { shape: 'steady' };
  const boost = T('b', { key: '10A', energy: 6 });
  assert.ok(scoreTransition(cur, boost, rising).parts.harmonic > scoreTransition(cur, boost, flat).parts.harmonic + 0.3);
  assert.ok(scoreTransition(cur, T('s', { key: '3A' }), flat).parts.harmonic <= 0);
  // a boost three tracks ago: the next one is penalised
  const history = [T('h1', { key: '6A' }), T('h2', { key: '8A' }), T('h3', { key: '8A' })];
  assert.ok(scoreTransition(cur, boost, { ...rising, history }).parts.harmonic < scoreTransition(cur, boost, rising).parts.harmonic - 0.4);
  const old = [T('o1', { key: '6A' }), ...['8A', '8A', '8A', '8A', '8A', '8A'].map((k, i) => T(`o${i + 2}`, { key: k }))];
  assert.equal(scoreTransition(cur, boost, { ...rising, history: old }).parts.harmonic, scoreTransition(cur, boost, rising).parts.harmonic);
});

test('tempo: 1.0 within 1.5 %, 0.5 at the family tolerance (3 % dance, 5 % open format), hard jump beyond 8 %', () => {
  const bpm = (a, b) => scoreTransition(a, b).parts.bpm;
  assert.equal(bpm(T('a', { bpm: 124 }), T('b', { bpm: 125.5 })), 1);
  const at3 = bpm(T('a', { bpm: 100 }), T('b', { bpm: 103 }));
  assert.ok(Math.abs(at3 - 0) < 1e-6, `3 % dance → S 0.5 → part 0 (${at3})`);
  const at5 = bpm(T('a', { bpm: 100, genre: 'Hip-Hop' }), T('b', { bpm: 105, genre: 'Hip-Hop' }));
  assert.ok(Math.abs(at5) < 1e-6, `5 % open format → part 0 (${at5})`);
  assert.ok(bpm(T('a', { bpm: 100, genre: 'Reggaeton' }), T('b', { bpm: 104 })) > bpm(T('a', { bpm: 100 }), T('b', { bpm: 104 })) + 0.5, 'open format is looser');
  assert.ok(bpm(T('a', { bpm: 100 }), T('b', { bpm: 106 })) <= -1 + 1e-9, '2× tolerance → 0');
  assert.ok(bpm(T('a', { bpm: 100 }), T('b', { bpm: 112 })) < -2, 'beyond 8 % is a jump');
  assert.ok(Math.abs(bpm(T('a', { bpm: 87 }), T('b', { bpm: 174 })) - 0.7) < 1e-9, 'double time × 0.85');
  assert.ok(isOpenFormat({ genre: 'R&B' }) && isOpenFormat({ tags: ['afrobeats'] }) && !isOpenFormat({ genre: 'Tech House' }));
});

test('energy: Gaussian around the target plus −0.3 per level beyond a ±1 step; +2 allowed on a planned lift', () => {
  const cur = T('c', { energy: 5 });
  const e = (en, ctx = {}) => scoreTransition(cur, T('x', { energy: en }), ctx).parts.energy;
  assert.ok(e(5) > e(6) && e(6) > e(7) && e(7) > e(8), 'steady: follow the current level');
  // target 5.5 (no lift): a +2 step pays the step penalty on top of the Gaussian
  const noLift = { shape: 'rising', x: 4.5 / 9 };
  assert.ok(Math.abs(e(7, noLift) - (2 * Math.exp(-(1.5 ** 2)) - 1 - 0.3)) < 1e-9);
  // target 7 (lift of 2): +2 is the best move, no step penalty
  const lift = { shape: 'rising', x: 6 / 9 };
  assert.ok(Math.abs(e(7, lift) - 1) < 1e-9);
  assert.ok(e(7, lift) > e(6, lift));
});

test('energyBias shifts the target', () => {
  const cur = T('c', { energy: 5 });
  const s = (en, energyBias) => scoreTransition(cur, T('x', { energy: en }), { shape: 'steady', energyBias }).score;
  assert.ok(s(5, 0) > s(7, 0));
  assert.ok(s(7, 2) > s(5, 2));
  assert.ok(s(4, -1) > s(6, -1));
  // clamped to ±2
  assert.equal(scoreTransition(cur, T('x', { energy: 7 }), { shape: 'steady', energyBias: 5 }).target, 7);
});

test('familiarity: share toward the phase target, ≤ 3 bangers and ≤ 5 unfamiliar in a row', () => {
  const pool = Array.from({ length: 20 }, (_, i) => T(`p${i}`, { playCount: i }));
  const fam = familiarityInfo(pool);
  assert.equal(fam.threshold, 14);
  assert.ok(isFamiliar({ rating: 4 }, fam) && isFamiliar({ playCount: 15 }, fam) && !isFamiliar({ playCount: 13, rating: 3 }, fam));
  assert.equal(familiarityInfo([T('a'), T('b')]).enabled, false);
  const famT = (id, o = {}) => T(id, { rating: 5, ...o }), unf = (id, o = {}) => T(id, { rating: 1, ...o });
  const f = (history, cand, x, shape = 'warmup') => scoreTransition(history.at(-1), cand, { shape, x, history, familiarity: fam }).parts.familiarity;
  // warm-up with mostly familiar tracks so far: an unfamiliar one moves the share toward 25 %
  const famHist = [famT('h1'), famT('h2'), unf('h3'), famT('h4')];
  assert.ok(f(famHist, unf('u'), 0) > 0 && f(famHist, famT('k'), 0) < 0);
  // close with mostly unfamiliar tracks: a familiar one moves the share toward 75 %
  const unfHist = [unf('h1'), famT('h2'), unf('h3'), unf('h4')];
  assert.ok(f(unfHist, famT('k'), 0.95) > 0 && f(unfHist, unf('u'), 0.95) < 0);
  // 3 bangers in a row: a 4th is penalised, a lower-energy familiar track is not
  const bangers = [famT('b1', { energy: 9 }), famT('b2', { energy: 8 }), famT('b3', { energy: 9 })];
  assert.ok(f(bangers, famT('b4', { energy: 9 }), 0.6) <= -1);
  assert.ok(f(bangers, famT('k', { energy: 7 }), 0.6) > -1);
  // 5 unfamiliar in a row: a 6th is penalised
  const deep = [1, 2, 3, 4, 5].map((i) => unf(`d${i}`));
  assert.ok(f(deep, unf('d6'), 0.1) < -1);
  assert.ok(f(deep.slice(1), unf('d6'), 0.1) > -1, 'four in a row is fine in the warm-up');
  // no familiarity data in the pool: neutral
  assert.equal(scoreTransition(T('a'), T('b', { rating: 5 }), { familiarity: familiarityInfo([T('a'), T('b')]) }).parts.familiarity, 0);
});

test('vocal density: decoded vocal map, else phrases, else unknown', () => {
  assert.ok(Math.abs(vocalDensity(T('v', vocals(0.8))) - 0.8) < 0.01);
  assert.ok(vocalDensity(T('i', vocals(0.05))) < 0.1);
  const phr = { phrases: [{ type: 'intro', start: 0, end: 30 }, { type: 'chorus', start: 30, end: 90 }, { type: 'verse', start: 90, end: 150 }, { type: 'outro', start: 150, end: 180 }] };
  assert.ok(Math.abs(vocalDensity(T('p', phr)) - (60 + 36) / 180) < 1e-9);
  assert.equal(vocalDensity(T('u')), null);
});

test('vocal alternation: ≤ 3 vocal-heavy tracks in a row, then a breather', () => {
  const history = [T('v1', vocals(0.7)), T('v2', vocals(0.8)), T('v3', vocals(0.6))];
  const cur = history.at(-1);
  const p = (cand, h = history) => scoreTransition(cur, cand, { history: h }).parts.vocal;
  assert.equal(p(T('v4', vocals(0.7))), -1.5);
  assert.equal(p(T('i', vocals(0.05))), 0.5);
  assert.equal(p(T('u')), 0, 'unknown: neutral');
  assert.equal(p(T('v4', vocals(0.7)), history.slice(1)), 0, 'two in a row is fine');
  assert.match(explain(cur, T('i', vocals(0.05)), { history }), /vocal breather/);
  const pick = liveNext(cur, [T('v4', vocals(0.7)), T('i', vocals(0.05))], { history: history.slice(0, -1), shape: 'steady' });
  assert.equal(pick.track.id, 'i');
});

test('artist gap: hard 8 tracks, soft to 15', () => {
  const histWith = (gap) => [...Array.from({ length: 20 - gap }, (_, i) => T(`f${i}`)), T('same', { artist: 'Repeat' }), ...Array.from({ length: gap - 1 }, (_, i) => T(`g${i}`))];
  const v = (gap) => { const h = histWith(gap); return scoreTransition(h.at(-1), T('x', { artist: 'Repeat' }), { history: h }).parts; };
  assert.equal(v(1).artistGap, 1);
  assert.equal(v(1).variety, -10);
  assert.equal(v(8).variety, -8);
  assert.ok(v(9).variety > -1 && v(9).variety < 0);
  assert.ok(v(15).variety < 0 && v(15).variety > v(9).variety);
  assert.equal(v(16).variety, 0);
  const h5 = histWith(5);
  assert.match(explain(h5.at(-1), T('x', { artist: 'Repeat' }), { history: h5 }), /artist gap 5/);
});

test('remixes / edits of the same song count as a replay', () => {
  const k = songKey({ title: 'Losing It' });
  assert.equal(k, 'losing it');
  for (const t of ['Losing It (Original Mix)', 'Losing It [Radio Edit]', 'Losing It - Extended Mix', 'Losing It feat. Someone', 'Losing It (Someone VIP Remix)', 'LOSING IT!']) assert.equal(songKey({ title: t }), k, t);
  assert.notEqual(songKey({ title: 'Losing You' }), k);
  assert.equal(songKey({ title: 'Intro' }), '');
  const history = [T('orig', { title: 'Losing It (Original Mix)' }), T('c')];
  const remix = T('rmx', { title: 'Losing It (Someone Remix)', artist: 'Someone' });
  const p = scoreTransition(history.at(-1), remix, { history }).parts;
  assert.equal(p.sameSong, true);
  assert.equal(p.variety, -3);
  assert.equal(scoreTransition(history.at(-1), T('other', { title: 'Other Song' }), { history }).parts.variety, 0);
});

test('partyTarget follows the clock and the set template', () => {
  assert.ok(SET_SHAPES.some(([v, l]) => v === 'party' && /clock/i.test(l)));
  // endless: background before 22:00, peak around 01:00, deeper 6-7 after 04:00
  assert.ok(partyTarget({ now: at(19) }) <= 5);
  assert.ok(partyTarget({ now: at(21, 30) }) <= 5);
  for (let m = 0; m < 40; m += 5) assert.ok(partyTarget({ now: at(1, m) }) >= 7.5, `01:${m}`);
  for (let m = 0; m < 40; m += 5) { const e = partyTarget({ now: at(5, m) }); assert.ok(e >= 6 && e <= 7, `05:${m} ${e}`); }
  assert.ok(partyTarget({ now: at(0, 30) }) > partyTarget({ now: at(22, 30) }) - 1.3);
  // the endless cycle moves: build → peak → valley within 40 minutes
  const cyc = Array.from({ length: 8 }, (_, i) => partyTarget({ now: at(0, 40 + i * 5) }));
  assert.ok(Math.max(...cyc) - Math.min(...cyc) > 1, cyc.join(' '));
  // known set length at midnight: warm-up < peak 1 > valley < main peak > close
  const s = (tau) => partyTarget({ now: at(0), tau });
  assert.ok(s(0) < s(0.5) && s(0.5) < s(0.64) && s(0.69) < s(0.64) && s(0.88) > s(0.64) && s(1) < s(0.88));
  assert.ok(Math.abs(partyTarget({ now: at(0), elapsedMin: 30, setMinutes: 120 }) - s(0.25)) < 1e-9);
  // mapped to the pool range like shapeTarget
  const m = partyTarget({ now: at(1), tau: 0.9, lo: 4, hi: 8 });
  assert.ok(m >= 4 && m <= 8);
  assert.equal(shapeTarget('party', 0.9, 4, 8, { now: at(1) }), m);
  assert.equal(shapeTarget('party', 0.9, 4, 8, { now: at(1), elapsedMin: 90, setMinutes: 100 }), m);
  assert.equal(arcPhase('party', 0.1, { now: at(20) }), 'warmup');
  assert.equal(arcPhase('party', 0.95, { now: at(1) }), 'close');
  assert.equal(arcPhase('party', 0.68, { now: at(1) }), 'valley');
});

test('party shape in liveNext / smartMix: early evening stays low, the night peaks', () => {
  const pool = Array.from({ length: 30 }, (_, i) => T(`t${i}`, { energy: 1 + (i % 10), key: `${1 + (i % 3)}A` }));
  const early = liveNext(pool[0], pool, { shape: 'party', now: at(20), endless: true, lookahead: 0 });
  const peak = liveNext(pool[0], pool, { shape: 'party', now: at(1, 35), endless: true, lookahead: 0 });
  assert.ok(early.track.energy <= 5, `20:00 → ${early.track.energy}`);
  assert.ok(peak.track.energy >= 7, `01:35 → ${peak.track.energy}`);
  assert.match(peak.reason, /party arc/);
  const set = smartMix(pool, { shape: 'party', now: at(23), limit: 12 });
  assert.equal(set.tracks.length, 12);
});

test('banned tracks are never picked', () => {
  const cur = T('c');
  const pool = [T('best', { key: '8A' }), T('ok', { key: '9A' })];
  assert.equal(liveNext(cur, pool, {}).track.id, 'best');
  assert.equal(liveNext(cur, pool, { banned: ['best'] }).track.id, 'ok');
  assert.equal(liveNext(cur, pool, { banned: new Set(['best', 'ok']) }), null);
  assert.ok(scoreTransition(cur, pool[0], { banned: ['best'] }).score < -1e5);
  assert.ok(!smartMix(pool, { banned: new Set(['best']) }).tracks.some((t) => t.id === 'best'));
});

test('vibe lock prefers the same genre family and a similar sound', () => {
  const cur = T('c', { genre: 'Tech House', energy: 6 });
  const pool = [T('techno', { genre: 'Techno', key: '8A', energy: 6 }), T('house', { genre: 'Deep House', key: '9A', energy: 6 }), T('dnb', { genre: 'Drum & Bass', bpm: 174, energy: 6 })];
  assert.ok(genreFamilies(pool[1]).has('house') && genreFamilies(T('r', { genre: 'R&B' })).has('hiphop'));
  assert.ok(soundSimilarity(cur, pool[1]) > soundSimilarity(cur, pool[2]));
  const sliders = { harmonic: 1, energy: 0.5, variety: 1 }; // genre weight low: the key wins without the lock
  assert.equal(liveNext(cur, pool, { shape: 'steady', sliders, lookahead: 0 }).track.id, 'techno');
  assert.equal(liveNext(cur, pool, { shape: 'steady', sliders, lookahead: 0, vibeLock: true }).track.id, 'house');
});

test('skipFeedback: early skips are strong, late weak; track, artist and genre are penalised', () => {
  const now = at(23);
  const a = T('a', { artist: 'Skipper', genre: 'Hard Techno' });
  const early = skipFeedback(null, a, { playedSeconds: 12, now });
  const late = skipFeedback(undefined, a, { playedSeconds: 200, now });
  assert.ok(early.tracks.a.w > late.tracks.a.w * 2);
  assert.equal(early.resetSuggested, false);
  const cur = T('c');
  const fb = (cand, feedback) => scoreTransition(cur, cand, { feedback, now }).parts.feedback;
  assert.ok(fb(a, early) < fb(a, late) && fb(a, late) < 0);
  assert.ok(fb(T('x', { artist: 'Skipper', genre: 'Pop' }), early) < 0, 'same artist');
  assert.ok(fb(T('y', { genre: 'Techno' }), early) < 0, 'shared genre word');
  assert.equal(fb(T('z', { genre: 'Pop' }), early), 0);
  // the penalty fades
  assert.ok(scoreTransition(cur, a, { feedback: early, now: now + 12 * 3600e3 }).parts.feedback > fb(a, early) / 4);
  // the skipped track drops behind an equal one
  const pool = [{ ...a, genre: 'House', artist: 'A1' }, T('b', { artist: 'B1' })];
  assert.equal(liveNext(cur, pool, { feedback: skipFeedback(null, pool[0], { playedSeconds: 5, now }), now, shape: 'steady' }).track.id, 'b');
});

test('skipFeedback: 2 skips in the last 4 tracks suggest a context reset toward a different style', () => {
  const now = at(23);
  const h = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((id) => T(id));
  let st = skipFeedback(null, h[1], { playedSeconds: 10, now, history: h.slice(0, 2) });
  assert.equal(st.resetSuggested, false);
  const far = skipFeedback(st, h[5], { playedSeconds: 10, now, history: h });
  assert.equal(far.resetSuggested, false, 'skips 5 tracks apart');
  st = skipFeedback(st, h[3], { playedSeconds: 10, now, history: h.slice(0, 4) });
  assert.equal(st.resetSuggested, true);
  // without history: the recorded plays / skips count
  let r = skipFeedback(null, h[0], { playedSeconds: 10, now });
  r = playFeedback(r, h[1], { now }); r = playFeedback(r, h[2], { now }); r = playFeedback(r, h[3], { now });
  r = playFeedback(r, h[4], { now });
  assert.equal(skipFeedback(r, h[5], { playedSeconds: 10, now }).resetSuggested, false);
  r = skipFeedback(r, h[5], { playedSeconds: 10, now });
  assert.equal(skipFeedback(r, T('h7'), { playedSeconds: 50, now }).resetSuggested, true);
  // reset: a genre change wins over more of the same
  const cur = T('c', { genre: 'House' });
  const pool = [T('same', { genre: 'House', key: '8A' }), T('diff', { genre: 'Disco Funk', key: '9A' })];
  assert.equal(liveNext(cur, pool, { shape: 'steady', now }).track.id, 'same');
  const pick = liveNext(cur, pool, { shape: 'steady', now, feedback: st });
  assert.equal(pick.track.id, 'diff');
  assert.match(pick.reason, /fresh direction after skips/);
  assert.equal(playFeedback(st, pick.track, { now }).resetSuggested, false);
});

test('lookahead avoids a tempo dead end that greedy falls into', () => {
  // A is the better next track by key (same key) but leaves only a big tempo step; B (+1 key) leads into F1, F2.
  const cur = T('cur', { bpm: 126, key: '8A' });
  const A = T('A', { bpm: 124, key: '8A' }), B = T('B', { bpm: 128, key: '9A' });
  const F = [T('F1', { bpm: 131, key: '9A' }), T('F2', { bpm: 131, key: '9A' }), T('F3', { bpm: 131.5, key: '9A' })];
  const pool = [A, B, ...F];
  const greedy = liveNext(cur, pool, { shape: 'steady', lookahead: 0 });
  assert.equal(greedy.track.id, 'A');
  assert.deepEqual(greedy.plan.map((t) => t.id), ['A']);
  const planned = liveNext(cur, pool, { shape: 'steady' });
  assert.equal(planned.track.id, 'B');
  assert.equal(planned.plan.length, 3);
  assert.equal(planned.plan[0], planned.track);
  assert.ok(planned.plan.slice(1).every((t) => t.id.startsWith('F')));
});

test('lookahead does not spend all the bangers early', () => {
  const fam = { rating: 5, energy: 9 };
  const history = [T('b1', fam), T('b2', fam)];
  const cur = T('b3', fam);
  // one more banger is allowed now, but then two non-bangers would be forced; the plan keeps it for later
  const pool = [T('b4', { ...fam, key: '8A' }), T('n1', { energy: 9, rating: 2, key: '9A' }), T('n2', { energy: 9, rating: 2, key: '9A' }), T('n3', { energy: 9, rating: 2, key: '9A' })];
  const r = liveNext(cur, pool, { history, shape: 'steady' });
  assert.ok(r.plan.filter((t) => t.id === 'b4').length <= 1);
  assert.ok(r.plan.length === 3);
});

test('transitionScore is only called for the first-step finalists; bounded runtime for 3,000 tracks', () => {
  const genres = ['House', 'Tech House', 'Techno', 'Hip-Hop', 'Pop', 'Disco'];
  const pool = Array.from({ length: 3000 }, (_, i) => T(`t${i}`, {
    energy: 1 + (i % 10), bpm: 100 + (i % 40), key: `${1 + (i % 12)}${i % 2 ? 'A' : 'B'}`, artist: `A${i % 300}`, genre: genres[i % 6],
    rating: i % 7 === 0 ? 5 : 0, playCount: i % 13, title: `Song ${i % 2500}`,
  }));
  const history = pool.slice(0, 20);
  let calls = 0;
  const t0 = performance.now();
  const r = liveNext(pool[20], pool, { history, shape: 'party', now: at(0, 30), position: 20, setLength: 40, transitionScore: () => { calls++; return { score: 0 }; } });
  const ms = performance.now() - t0;
  assert.ok(r && r.plan.length === 3);
  assert.ok(calls <= 6, `${calls} calls`);
  assert.ok(ms < 300, `${ms.toFixed(0)} ms`);
});

test('explain without ctx is unchanged; with ctx it names familiar bangers and the party arc', () => {
  assert.equal(explain(T('a', { energy: 6 }), T('b', { key: '9A', bpm: 126, energy: 7 })), '8A → 9A, 124 → 126 BPM, energy +1, same genre');
  const fam = familiarityInfo([T('x', { rating: 5 })]);
  const s = explain(T('a', { energy: 8 }), T('b', { energy: 9, rating: 5 }), { shape: 'party', now: at(1), familiarity: fam, x: 0.8 });
  assert.match(s, /familiar banger/);
  assert.match(s, /party arc: peak/);
});
