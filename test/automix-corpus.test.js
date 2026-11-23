// Simulated long-set regression suite (docs/PRO_DJ_AUTOMIX_RESEARCH.md P4.2, without audio). A deterministic synthetic
// library is played for three hours of party time through the real selection (smartmix liveNext) and transition
// planner (adaptive-dj planAdaptiveTransition + the P4.1 checker), and the set's aggregate quality is asserted, so a
// change that makes the automix worse fails here. Metrics, baselines and how to update them: docs/automix-research/CORPUS.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLibrary, simulateSet, setMetrics } from './fixtures/automix-corpus.js';
import { CHECK_LIMITS } from '../public/js/transition-check.js';

const BANNED = ['trk-010', 'trk-020', 'trk-064'];
const mixed = makeLibrary({ seed: 7 });
const house = makeLibrary({ seed: 11, count: 80, families: ['house', 'techhouse'], prefix: 'hs', artistsPerFamily: 24 });
const open = makeLibrary({ seed: 13, count: 90, families: ['hiphop', 'pop', 'reggaeton', 'afrobeats'], prefix: 'op', artistsPerFamily: 14 });
const bass = makeLibrary({ seed: 17, count: 70, families: ['dnb', 'dubstep'], prefix: 'bs', artistsPerFamily: 20 });

/** name → [library, simulateSet options]. */
const SCENARIOS = {
  'mixed A': [mixed, { seed: 'trk-001', banned: BANNED }],
  'mixed B': [mixed, { seed: 'trk-050', banned: BANNED }],
  'mixed C': [mixed, { seed: 'trk-100', banned: BANNED }],
  'house night': [house, { seed: 'hs-001' }],
  'open format': [open, { seed: 'op-001' }],
  'bass night': [bass, { seed: 'bs-001' }],
  // double drops forced on (AutoMix leaves them to the 35 % pair hash): exercises the double-drop invariants
  'bass, double drops': [bass, { seed: 'bs-001', minutes: 90, doubleDrops: true }],
};

/**
 * What the code achieved when the baseline was recorded (2026-11-23). Shares are floors (asserted with MARGIN below
 * them), artistRepeats a ceiling (asserted with +2). Update: CORPUS_BASELINE=1 node --test test/automix-corpus.test.js
 * prints the current values as JSON (see CORPUS.md).
 */
const BASELINE = {
  'mixed A': { onLine: 0.72, levelOk: 0.89, checkOk: 0.87, blendStretchOk: 0.98, tempoOk: 0.94, artistRepeats: 3 },
  'mixed B': { onLine: 0.69, levelOk: 0.92, checkOk: 0.88, blendStretchOk: 0.96, tempoOk: 0.9, artistRepeats: 1 },
  'mixed C': { onLine: 0.71, levelOk: 0.88, checkOk: 0.83, blendStretchOk: 0.96, tempoOk: 0.94, artistRepeats: 3 },
  'house night': { onLine: 0.6, levelOk: 0.84, checkOk: 0.84, blendStretchOk: 1, tempoOk: 1, artistRepeats: 0 },
  'open format': { onLine: 0.69, levelOk: 1, checkOk: 0.94, blendStretchOk: 0.94, tempoOk: 0.88, artistRepeats: 0 },
  'bass night': { onLine: 0.64, levelOk: 0.85, checkOk: 0.85, blendStretchOk: 1, tempoOk: 0.98, artistRepeats: 5 },
  'bass, double drops': { onLine: 0.73, levelOk: 0.77, checkOk: 0.77, blendStretchOk: 1, tempoOk: 0.97, artistRepeats: 4 },
};
const MARGIN = 0.1;

const cache = new Map();
function run(name) {
  if (!cache.has(name)) {
    const [lib, opts] = SCENARIOS[name];
    const sim = simulateSet(lib, opts);
    cache.set(name, { sim, m: setMetrics(sim, { banned: opts.banned || [] }) });
  }
  return cache.get(name);
}
const pct = (x) => `${Math.round(x * 100)}%`;
const r2 = (x) => Math.round(x * 100) / 100;

test('corpus: the synthetic library is deterministic and realistic', () => {
  const again = makeLibrary({ seed: 7 });
  assert.deepEqual(again, mixed, 'same seed → same library');
  assert.equal(mixed.length, 150);
  assert.equal(new Set(mixed.map((t) => t.id)).size, 150);
  const fams = new Set(mixed.map((t) => t.corpusFamily));
  assert.equal(fams.size, 12, 'every genre family present');
  for (const t of mixed) {
    assert.ok(t.bpm > 60 && t.bpm < 200 && t.energy >= 1 && t.energy <= 10, t.id);
    assert.equal(t.gain, Math.round((-14 - t.mainLufs) * 10) / 10, `${t.id}: gain = -14 - mainLufs`);
    assert.ok(t.phrases.length >= 7 && t.phrases.every((p, i) => p.end > p.start && (!i || Math.abs(p.start - t.phrases[i - 1].end) < 1e-6)), `${t.id}: contiguous phrases`);
    // phrase lines: every main section starts a whole number of 8-bar phrases (or a 4-bar half) from the anchor
    const bar = 240 / t.bpm;
    for (const p of t.phrases.slice(1)) assert.ok(Math.abs(((p.start - t.phraseAnchor) / bar) - Math.round((p.start - t.phraseAnchor) / bar)) < 0.01, `${t.id}: ${p.type} on the bar grid`);
    if (t.vocalMap) assert.equal(t.vocalMap.length, Math.ceil(t.duration));
  }
  assert.ok(mixed.some((t) => t.phraseAnchor - t.downbeat > 0 && t.phrases[0].bars % 8), 'some tracks have a pickup');
  assert.ok(new Set(mixed.map((t) => t.artist)).size < 150, 'artists repeat across the library');
  // the simulation itself is deterministic
  const a = simulateSet(mixed, { seed: 'trk-001', minutes: 25 }), b = simulateSet(mixed, { seed: 'trk-001', minutes: 25 });
  assert.deepEqual(a.steps.map((s) => [s.inn.id, s.style, s.bars, s.begin]), b.steps.map((s) => [s.inn.id, s.style, s.bars, s.begin]));
});

for (const name of Object.keys(SCENARIOS)) {
  test(`corpus: ${name}: a ${SCENARIOS[name][1].minutes || 180}-minute party set stays within the quality limits`, (t) => {
    const { sim, m } = run(name);
    const base = BASELINE[name];
    const blends = sim.steps.filter((s) => s.blend && s.check);
    t.diagnostic(`${name}: ${m.transitions} transitions, ${m.minutes} min in ${m.ms} ms; styles ${JSON.stringify(m.styles)}`);
    t.diagnostic(`  phrase line (4-bar) ${pct(m.onLine)}, 8-bar ${pct(m.onPhrase)}, grids aligned ${pct(m.gridAligned)}, landed ${pct(m.landed)}, `
      + `level ok ${pct(m.levelOk)} (max bump ${m.maxBump} / dip ${m.maxDip} LU), checker ok ${pct(m.checkOk)}, effects ${pct(m.effectShare)} (budget ${pct(m.fxBudget)})`);
    t.diagnostic(`  energy step ≤ 2 ${pct(m.energyOk)}, tempo ≤ 5 % ${pct(m.tempoOk)} (blends ${pct(m.blendStretchOk)}), artist repeats ≤ 8 ${m.artistRepeats}, `
      + `double drops ${m.doubleDrops}`);
    if (process.env.CORPUS_BASELINE) console.log(JSON.stringify({ [name]: { onLine: r2(m.onLine), levelOk: r2(m.levelOk), checkOk: r2(m.checkOk), blendStretchOk: r2(m.blendStretchOk), tempoOk: r2(m.tempoOk), artistRepeats: m.artistRepeats } }));

    // the set really ran: ~3 hours, ~45-60 transitions, every one planned
    const minutes = SCENARIOS[name][1].minutes || 180;
    assert.ok(m.minutes >= minutes - 2, `${m.minutes} min played`);
    assert.ok(m.transitions >= minutes / 4.5 && m.transitions <= minutes / 2.5, `${m.transitions} transitions`);
    assert.equal(m.unplanned, 0, 'every transition planned');
    assert.ok(m.ms < 5000, `simulation took ${m.ms} ms`);
    // never fail: one bassline, no level jumps, vocals not on vocals
    assert.ok(m.blendShare >= 0.85, `blend share ${pct(m.blendShare)}`);
    for (const s of blends) assert.ok(s.check.metrics.lowOverlapBeats <= CHECK_LIMITS.lowOverlapBeats, `#${s.i} ${s.style}: two basslines for ${s.check.metrics.lowOverlapBeats} beats`);
    for (const s of blends) assert.ok(s.check.metrics.bumpLu <= CHECK_LIMITS.bumpLu + 0.5, `#${s.i} ${s.style}: level bump ${s.check.metrics.bumpLu} LU`);
    for (const s of blends) assert.ok(s.check.metrics.dipLu <= 5.5, `#${s.i} ${s.style}: level dip ${s.check.metrics.dipLu} LU`);
    assert.ok(blends.filter((s) => s.check.metrics.bumpLu <= CHECK_LIMITS.bumpLu).length >= 0.95 * blends.length, 'bump ≤ 2 LU on ≥ 95 % of blends');
    assert.ok(m.vocalClash <= 0.05, `vocals overlap > 2 s on ${pct(m.vocalClash)} of blends`);
    // one continuous mix: phrase-correct, landing on the outgoing change
    assert.ok(m.landed >= 0.9, `landed ${pct(m.landed)}`);
    assert.ok(m.onLine >= base.onLine - MARGIN, `blend starts on a phrase line ${pct(m.onLine)} (baseline ${pct(base.onLine)})`);
    assert.ok(m.levelOk >= base.levelOk - MARGIN, `level within the checker limits ${pct(m.levelOk)} (baseline ${pct(base.levelOk)})`);
    assert.ok(m.checkOk >= base.checkOk - MARGIN, `checker ok ${pct(m.checkOk)} (baseline ${pct(base.checkOk)})`);
    // effects are seasoning: within the family budget, never the same effect twice running
    assert.ok(m.effectShare <= m.fxBudget + 0.1, `effects ${pct(m.effectShare)} vs budget ${pct(m.fxBudget)}`);
    assert.equal(m.sameEffectTwice, 0, 'same effect twice in a row');
    // double drops: bass music only, never twice running
    assert.equal(m.ddOutsideBass, 0, 'double drop outside drum & bass / dubstep');
    assert.equal(m.ddConsecutive, 0, 'two double drops in a row');
    // selection: no replays, no banned tracks, no artist back to back, smooth energy, little stretch
    assert.equal(m.trackRepeats, 0, 'a track played twice');
    assert.equal(m.bannedPicked, 0, 'a banned track was picked');
    assert.equal(m.backToBack, 0, 'same artist twice in a row');
    assert.ok(m.artistRepeats <= base.artistRepeats + 2, `${m.artistRepeats} artist repeats within 8 tracks (baseline ${base.artistRepeats})`);
    assert.ok(m.energyOk >= 0.9, `|ΔE| ≤ 2 on ${pct(m.energyOk)} of picks`);
    assert.ok(m.blendStretchOk >= Math.min(0.95, base.blendStretchOk - MARGIN / 2), `stretch ≤ 5 % on ${pct(m.blendStretchOk)} of blends`);
    assert.ok(m.tempoOk >= base.tempoOk - MARGIN, `tempo ≤ 5 % on ${pct(m.tempoOk)} of picks (baseline ${pct(base.tempoOk)})`);
  });
}

// ---- targets (formerly known issues, CORPUS.md; fixed: ms tolerance on exits, word-boundary artist key, hard
// artist window, 6 % blend stretch cap, per-instant checker reference) ----
const all = () => Object.keys(SCENARIOS).map((n) => [n, run(n).m]);
const CLUB = new Set(['house night', 'bass night', 'bass, double drops']);

test('corpus target: every blend starts on a (4-bar) phrase line of the outgoing track', () => {
  for (const [n, m] of all()) assert.equal(m.onLine, 1, `${n}: ${pct(m.onLine)}`);
});

test('corpus target: no artist repeat within 8 tracks', () => {
  for (const [n, m] of all()) assert.equal(m.artistRepeats, 0, `${n}: ${m.artistRepeats}`);
});

test('corpus target: tempo within 5 % on ≥ 95 % of picks in club sets (open format moves tempo on cuts)', () => {
  for (const [n, m] of all()) assert.ok(m.tempoOk >= (CLUB.has(n) ? 0.95 : 0.85), `${n}: ${pct(m.tempoOk)}`);
});

test('corpus target: level within limits on ≥ 90 % of blends', () => {
  for (const [n, m] of all()) assert.ok(m.levelOk >= 0.9, `${n}: ${pct(m.levelOk)}`);
});

// ---- real DJ mixes (docs/automix-research/04-real-mixes.md §2.1-2.2) ----
const quantile = (v, f) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(f * (s.length - 1))]; };

test('corpus target: club blends like real mixes (median 16 bars, few longer than 32)', () => {
  for (const n of ['house night', 'bass night', 'mixed A']) {
    const bars = run(n).sim.steps.filter((s) => s.blend).map((s) => s.bars);
    assert.ok(quantile(bars, 0.5) <= 16 && quantile(bars, 0.5) >= 4, `${n}: median ${quantile(bars, 0.5)} bars`);
    assert.ok(bars.filter((b) => b > 32).length <= bars.length * 0.15, `${n}: ${bars.filter((b) => b > 32).length} of ${bars.length} blends over 32 bars`);
  }
});

test('corpus target: a club track is on air about as long as DJs play one (house 3-5 min, drum & bass 2.5-4 min)', () => {
  for (const [n, lo, hi] of [['house night', 3, 5], ['bass night', 2.5, 4]]) {
    const s = run(n).sim.steps;
    const onAir = s.slice(1).map((x, i) => (x.begin - s[i].inStart) / 60).filter(Number.isFinite);
    const med = quantile(onAir, 0.5);
    assert.ok(med >= lo && med <= hi, `${n}: median ${med.toFixed(1)} min on air`);
  }
});
