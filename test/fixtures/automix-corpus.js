// Synthetic party library + long-set simulator for the automix regression suite (test/automix-corpus.test.js,
// docs/automix-research/CORPUS.md). Deterministic: everything comes from a seeded PRNG, no audio, no clock.
//
// makeLibrary() describes tracks the way the analyser stores them (bpm / key / energy / phrases with per-section
// energy and LUFS / mainLufs / gain / vocalMap ...). simulateSet() then plays a set through the real selection
// (smartmix liveNext, party shape, endless) and the real transition planner (adaptive-dj planAdaptiveTransition, with
// the recent-styles memory AutoMix keeps), and returns one record per transition for the metrics.
import { liveNext } from '../../public/js/smartmix.js';
import { planAdaptiveTransition, offPhraseBars, gridMisalign } from '../../public/js/adaptive-dj.js';
import { DROP_STYLES, incomingStart } from '../../public/js/automix.js';
import { pairFamily, EFFECT_STYLES, FAMILIES } from '../../public/js/dj-styles.js';

/** mulberry32: small, fast, good enough for fixtures. */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Genre families of the corpus: tempo range, energy range, section layout ('club' = intro/build/drop/break/outro,
 * 'song' = verse/chorus), share of vocal tracks, main-section loudness range (LUFS), artist names.
 */
export const GENRES = {
  house: { genre: 'House', bpm: [120, 126], energy: [4, 8], layout: 'club', vocal: 0.35, lufs: [-9, -7], artists: ['Kerri Lane', 'Mondo Grove', 'Satin Hall', 'Deepa Ray', 'Low Pressure'] },
  techhouse: { genre: 'Tech House', bpm: [124, 128], energy: [5, 8], layout: 'club', vocal: 0.15, lufs: [-8, -6.5], artists: ['Fisk & Moss', 'Gully Tones', 'Rex Pantera', 'Mano Vida'] },
  techno: { genre: 'Techno', bpm: [128, 136], energy: [6, 9], layout: 'club', vocal: 0, lufs: [-8, -6], artists: ['Unit 9', 'Halvard', 'Nadia Krol', 'Concrete Field'] },
  trance: { genre: 'Trance', bpm: [136, 140], energy: [6, 9], layout: 'club', vocal: 0.3, lufs: [-8.5, -6.5], artists: ['Aria Sky', 'Solenne', 'Vector Bloom', 'Oceanlight'] },
  dnb: { genre: 'Drum & Bass', bpm: [172, 176], energy: [7, 10], layout: 'club', vocal: 0.2, lufs: [-7.5, -5.5], artists: ['Kallo', 'Subfield', 'Rinse Theory', 'Mira Volt'] },
  dubstep: { genre: 'Dubstep', bpm: [140, 140], energy: [7, 10], layout: 'club', vocal: 0.15, lufs: [-7, -5], artists: ['Grimeworks', 'Tarn', 'Wobbl'] },
  hiphop: { genre: 'Hip-Hop', bpm: [86, 98], energy: [4, 8], layout: 'song', vocal: 1, lufs: [-9, -7], artists: ['Lil Corner', 'MC Avenue', 'Big Sable', 'Jaya Rhymes', 'Northside Kid'] },
  pop: { genre: 'Pop', bpm: [100, 126], energy: [4, 8], layout: 'song', vocal: 1, lufs: [-9, -7], artists: ['Lena Bright', 'The Pastels', 'Nova Ray', 'Marco Lux', 'Ivy Sun'] },
  reggaeton: { genre: 'Reggaeton', bpm: [88, 98], energy: [5, 8], layout: 'song', vocal: 1, lufs: [-8.5, -6.5], artists: ['El Fuego', 'Dama Luna', 'Rico Ventura', 'Sol Mar'] },
  afrobeats: { genre: 'Afrobeats', bpm: [100, 112], energy: [4, 7], layout: 'song', vocal: 1, lufs: [-9.5, -7.5], artists: ['Ade Kola', 'Simi Wave', 'Tunde Blue', 'Afia'] },
  disco: { genre: 'Nu Disco', bpm: [112, 124], energy: [4, 7], layout: 'song', vocal: 0.6, lufs: [-10, -8], artists: ['Studio 9', 'The Glitter Band', 'Roxy Moon'] },
  lounge: { genre: 'Lounge', bpm: [90, 110], energy: [2, 4], layout: 'club', vocal: 0.3, lufs: [-13, -11], artists: ['Cafe Bleu', 'Amber Shore', 'Slowcraft'] },
};

const WORDS_A = ['Midnight', 'Golden', 'Electric', 'Velvet', 'Neon', 'Lost', 'Higher', 'Silver', 'Wild', 'Deep', 'Crystal', 'Broken', 'Sweet', 'Cosmic', 'Paper', 'Burning'];
const WORDS_B = ['Signal', 'Heart', 'River', 'Groove', 'Motion', 'Skyline', 'Echoes', 'Fever', 'Garden', 'Pulse', 'Lights', 'Horizon', 'Machine', 'Dreams', 'Shadow', 'Tide'];
const CLUB_E = { intro: 0.4, buildup: 0.7, drop: 0.95, breakdown: 0.35, outro: 0.45, verse: 0.6, chorus: 0.85 };
const CLUB_L = { intro: -4, buildup: -2, drop: 0, breakdown: -6, outro: -4, verse: -2, chorus: 0 };

const r1 = (x) => Math.round(x * 1000) / 1000;
const FIRST = ['Alex', 'Nico', 'Sara', 'Theo', 'Maya', 'Jonas', 'Lia', 'Omar', 'Zoe', 'Kai', 'Ines', 'Ravi', 'Elif', 'Bruno'];
const LAST = ['Varga', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Silva', 'Novak', 'Haddad', 'Keller', 'Brandt', 'Quinn', 'Rossi', 'Adeyemi'];
/** Artist names of a family: its named artists, padded with generated names up to `n`. */
function artistPool(famId, n) {
  const F = GENRES[famId], fi = Object.keys(GENRES).indexOf(famId), out = [...F.artists];
  for (let k = 0; out.length < n; k++) {
    const name = `${FIRST[(fi * 3 + k) % FIRST.length]} ${LAST[(fi * 5 + k * 7) % LAST.length]}`;
    if (!out.includes(name)) out.push(name);
  }
  return out.slice(0, Math.max(n, 1));
}

/** One track description (what the analyser would have stored), from a family spec and a PRNG. */
function makeTrack(id, famId, rand, titles, artistsPerFamily) {
  const F = GENRES[famId];
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (lo, hi) => lo + (hi - lo) * rand();
  const bpm = Math.round(between(F.bpm[0], F.bpm[1]) * 10) / 10;
  const bar = 240 / bpm;
  // section layout on 8 / 16-bar lines (lengths in bars)
  const s8 = () => (rand() < 0.5 ? 16 : 32);
  let layout;
  if (F.layout === 'club') {
    layout = [['intro', s8()], ['buildup', 8], ['drop', s8()], ['breakdown', rand() < 0.5 ? 16 : 32], ['buildup', 8], ['drop', s8()], ['outro', s8()]];
    if (rand() < 0.3) layout.splice(6, 0, ['breakdown', 16], ['drop', 16]);
  } else {
    const intro = rand() < 0.4 ? 4 : 8;
    layout = [['intro', intro], ['verse', 16], ['chorus', rand() < 0.5 ? 8 : 16], ['verse', 16], ['chorus', 16], ['breakdown', 8], ['chorus', 16], ['outro', rand() < 0.5 ? 4 : 8]];
  }
  // a 1-2 bar pickup before the first phrase line on some tracks (the phrase grid starts after it)
  const pickup = rand() < 0.2 ? (rand() < 0.5 ? 1 : 2) : 0;
  const downbeat = r1(between(0.02, 0.4));
  // phrase grid: the first main section starts on a phrase line (a 4-bar intro or a pickup sits before it)
  const phraseAnchor = r1(downbeat + (pickup + layout[0][1]) * bar);
  const mainLufs = Math.round(between(F.lufs[0], F.lufs[1]) * 10) / 10;
  const vocal = rand() < F.vocal;
  const phrases = [];
  let t = downbeat + pickup * bar;
  layout.forEach(([type, bars], i) => {
    const start = i === 0 ? downbeat : t, end = t + bars * bar;
    phrases.push({ type, start: r1(start), end: r1(end), bars: bars + (i === 0 ? pickup : 0),
      energy: Math.round(Math.min(1, Math.max(0.1, CLUB_E[type] + (rand() - 0.5) * 0.1)) * 100) / 100,
      lufs: Math.round((mainLufs + CLUB_L[type] + (rand() - 0.5)) * 10) / 10 });
    t = end;
  });
  const duration = r1(t + between(1, 4));
  // vocal map (per second): vocals on verses / choruses (song layout) or on drops (vocal club tracks), with breaths
  let vocalMap;
  if (vocal) {
    vocalMap = new Array(Math.ceil(duration)).fill(0);
    const on = F.layout === 'song' ? new Set(['verse', 'chorus']) : new Set(['drop', 'breakdown']);
    for (const p of phrases) {
      if (!on.has(p.type) || (F.layout !== 'song' && rand() < 0.4)) continue;
      for (let s = Math.ceil(p.start); s < Math.floor(p.end); s++) vocalMap[s] = (s % 9 === 8) ? 0.2 : Math.round((0.75 + 0.25 * rand()) * 100) / 100;
    }
  }
  let title;
  do title = `${pick(WORDS_A)} ${pick(WORDS_B)}`; while (titles.has(title));
  titles.add(title);
  const lo = F.energy[0], hi = F.energy[1];
  const artists = artistPool(famId, artistsPerFamily);
  return {
    id, title, artist: artists[Math.floor(rand() ** 1.4 * artists.length)], album: '', genre: F.genre, analyzed: true,
    bpm, bpmConfidence: Math.round(between(0.6, 0.99) * 100) / 100,
    key: `${1 + Math.floor(rand() * 12)}${rand() < 0.5 ? 'A' : 'B'}`, keyConfidence: Math.round(between(0.4, 0.95) * 100) / 100,
    energy: lo + Math.floor(rand() * (hi - lo + 1)),
    rating: rand() < 0.3 ? 4 + Math.floor(rand() * 2) : Math.floor(rand() * 4),
    playCount: Math.floor(rand() ** 3 * 60),
    duration, startTime: 0, endTime: r1(t), gridOffset: downbeat, downbeat, phraseAnchor, phraseConfidence: pickup ? 0.8 : 0.9,
    phrases, mainLufs, lufs: Math.round((mainLufs - 1.5) * 10) / 10, gain: Math.round((-14 - mainLufs) * 10) / 10,
    ...(vocalMap ? { vocalMap } : {}),
  };
}

/**
 * Deterministic library: `count` tracks spread over `families` (keys of GENRES; default all), from `seed`;
 * `artistsPerFamily` artists per family (popular ones get more tracks).
 * Track ids are `${prefix}-NNN`.
 */
export function makeLibrary({ seed = 1, count = 150, families = Object.keys(GENRES), prefix = 'trk', artistsPerFamily = 8 } = {}) {
  const rand = prng(seed), titles = new Set(), out = [];
  for (let i = 0; i < count; i++) {
    const fam = families[i % families.length];
    const t = makeTrack(`${prefix}-${String(i + 1).padStart(3, '0')}`, fam, rand, titles, artistsPerFamily);
    t.corpusFamily = fam;
    out.push(t);
  }
  return out;
}

const LIVE_ENDLESS_CYCLE = 30; // AutoMix's endless set length (tracks per energy cycle)
const recentLen = 6; // AutoMix keeps the last 6 transition styles

/**
 * Play a party set: start on `seed` (a track of `library`), pick each next track with liveNext (party, endless, a
 * fixed clock starting at `start`), plan each transition with planAdaptiveTransition as AutoMix does (position =
 * entry of the outgoing track, rate 1, recent styles, previous style), until `minutes` of set time have played.
 * @returns {{ steps: object[], tracks: object[], ms: number, minutes: number }}
 */
export function simulateSet(library, { seed, minutes = 180, start = new Date(2026, 5, 6, 22, 0, 0).getTime(), banned = [], lookahead, doubleDrops } = {}) {
  const t0 = performance.now();
  const bannedSet = new Set(banned);
  let cur = library.find((t) => t.id === seed) || library[0];
  let entry = incomingStart(cur);
  const played = [], steps = [];
  let recent = [], prevStyle = null, elapsed = 0;
  // `entry` is where the track came in (AutoMix plans from it); `heardFrom` is where it is when it plays alone
  let heardFrom = entry;
  while (elapsed < minutes * 60) {
    const history = played.slice(-Math.max(1, library.length - 1));
    const out = cur, outEntry = entry;
    const opts = () => ({ position: outEntry, entry: outEntry, rate: 1, recent: [...recent], prevStyle, ...(doubleDrops != null ? { doubleDrops } : {}) });
    const r = liveNext(out, library, {
      history, shape: 'party', endless: true, position: played.length % LIVE_ENDLESS_CYCLE, setLength: LIVE_ENDLESS_CYCLE,
      now: start + elapsed * 1000, elapsedMin: elapsed / 60, banned: bannedSet, energyBias: 0, ...(lookahead != null ? { lookahead } : {}),
      transitionScore: (t) => {
        const p = planAdaptiveTransition(out, t, opts());
        return p ? { score: Math.max(-4, Math.min(4, p.score / 4)), reason: p.why } : { score: -2, reason: 'limited section analysis' };
      },
    });
    if (!r) break;
    const inn = r.track;
    const p = planAdaptiveTransition(out, inn, opts());
    const step = { i: steps.length, at: elapsed, out, inn, plan: p, family: pairFamily(out, inn) };
    played.push(out);
    if (!p) {
      // no plan: AutoMix would cut at the end; count it as a failed transition
      Object.assign(step, { style: null, effect: false, blend: false });
      elapsed += Math.max(0, out.duration - heardFrom);
      entry = heardFrom = incomingStart(inn);
    } else {
      const drop = DROP_STYLES.has(p.style);
      const begin = p.timing.begin;
      Object.assign(step, {
        style: p.doubleDrop ? 'doubledrop' : p.style, rawStyle: p.style, bars: p.bars, effect: EFFECT_STYLES.has(p.style), blend: !drop,
        landed: !!p.landed, doubleDrop: !!p.doubleDrop, check: p.check, begin, exit: p.exit, inStart: p.inStart,
        offPhrase: drop ? null : offPhraseBars(out, begin), misalign: drop ? null : gridMisalign(out, begin, inn, p.inStart),
      });
      if (drop) {
        elapsed += Math.max(0, (p.timing.drop ?? p.exit) - heardFrom);
        heardFrom = p.inStart;
      } else {
        // the overlap counts once: the outgoing track until its exit, then the incoming one from where it is then
        elapsed += Math.max(0, p.exit - heardFrom);
        heardFrom = p.inStart + (p.exit - begin) * (out.bpm / inn.bpm);
      }
      entry = p.inStart;
      recent = [...recent.slice(-(recentLen - 1)), step.style];
      prevStyle = p.style;
    }
    steps.push(step);
    cur = inn;
  }
  return { steps, tracks: [...played, cur], ms: performance.now() - t0, minutes: elapsed / 60 };
}

/**
 * Lower-case main artist: the name before a ',', '&', 'feat.', 'ft.', 'vs.' or ' x ' credit. (smartmix's own artistKey
 * also splits inside names ending in "x" / "ft", e.g. "Alex Varga" → "ale": see CORPUS.md, known issues.)
 */
export const artistOf = (t) => String(t?.artist || '').toLowerCase().split(/\s*[,&]\s*|\s+(?:feat\.?|ft\.?|vs\.?|x)\s+/)[0].trim();

/** Aggregate quality metrics of a simulated set (see docs/automix-research/CORPUS.md). */
export function setMetrics(sim, { banned = [] } = {}) {
  const S = sim.steps, n = S.length || 1;
  const blends = S.filter((s) => s.blend && s.check);
  const share = (xs, pred) => (xs.length ? xs.filter(pred).length / xs.length : 1);
  const tempoPct = (s) => { const r = s.out.bpm / s.inn.bpm, b = [r, r * 2, r / 2].reduce((a, c) => (Math.abs(Math.log(c)) < Math.abs(Math.log(a)) ? c : a)); return Math.abs(b - 1) * 100; };
  let artistRepeats = 0, sameEffectTwice = 0, ddConsecutive = 0;
  const ids = sim.tracks.map((t) => t.id);
  for (let i = 0; i < sim.tracks.length; i++) {
    const a = artistOf(sim.tracks[i]);
    for (let j = Math.max(0, i - 8); j < i; j++) if (artistOf(sim.tracks[j]) === a) { artistRepeats++; break; }
  }
  for (let i = 1; i < S.length; i++) {
    if (S[i].effect && S[i - 1].effect && S[i].rawStyle === S[i - 1].rawStyle) sameEffectTwice++;
    if (S[i].doubleDrop && S[i - 1].doubleDrop) ddConsecutive++;
  }
  const fxBudget = S.reduce((s, x) => s + (FAMILIES[x.family]?.fxBudget ?? 0.3), 0) / n;
  const styles = {};
  for (const s of S) styles[s.style ?? 'none'] = (styles[s.style ?? 'none'] || 0) + 1;
  return {
    transitions: S.length,
    minutes: Math.round(sim.minutes),
    ms: Math.round(sim.ms),
    unplanned: S.filter((s) => !s.plan).length,
    blendShare: blends.length / n,
    maxLowOverlap: Math.max(0, ...blends.map((s) => s.check.metrics.lowOverlapBeats)),
    onPhrase: share(blends, (s) => s.offPhrase < 0.05),
    // 4-bar lines: 4-bar blends (open format, quick swaps) end on a phrase line and so start half a phrase before it
    onLine: share(blends, (s) => s.offPhrase < 0.05 || Math.abs(s.offPhrase - 4) < 0.05),
    gridAligned: share(blends, (s) => s.misalign < 0.05),
    landed: share(blends, (s) => s.landed),
    maxBump: Math.max(0, ...blends.map((s) => s.check.metrics.bumpLu)),
    maxDip: Math.max(0, ...blends.map((s) => s.check.metrics.dipLu)),
    levelOk: share(blends, (s) => s.check.metrics.bumpLu <= 2 && s.check.metrics.dipLu <= 3),
    vocalClash: share(blends, (s) => s.check.metrics.vocalOverlapSec > 2),
    checkOk: share(blends, (s) => s.check.ok),
    effectShare: S.filter((s) => s.effect).length / n,
    fxBudget,
    sameEffectTwice,
    artistRepeats,
    trackRepeats: ids.length - new Set(ids).size,
    backToBack: sim.tracks.filter((t, i) => i && artistOf(t) === artistOf(sim.tracks[i - 1])).length,
    energyOk: share(S, (s) => Math.abs((s.inn.energy ?? 5) - (s.out.energy ?? 5)) <= 2),
    tempoOk: share(S, (s) => tempoPct(s) <= 5),
    blendStretchOk: share(blends, (s) => s.check.metrics.stretchPct <= 5),
    doubleDrops: S.filter((s) => s.doubleDrop).length,
    ddOutsideBass: S.filter((s) => s.doubleDrop && s.family !== 'bass').length,
    ddConsecutive,
    bannedPicked: sim.tracks.filter((t) => banned.includes(t.id)).length,
    styles,
  };
}
