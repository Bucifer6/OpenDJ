// Tricks: the performance layer inside tracks (docs/PRO_DJ_AUTOMIX_RESEARCH.md P5). A party DJ doesn't only mix
// between records: they tease the bass before a drop, roll a loop into it, drop the music out for a beat so the crowd
// sings, rewind a banger at peak time, fire a horn in a dancehall block. This module decides *when* a trick serves the
// floor; automix.js performs it with the mixer, the deck and the sampler.
//
// Rules every trick obeys: it starts on a beat and resolves exactly on a phrase downbeat (where it lands matters
// more than what it does); never over a vocal line (except the echo freeze, which is made for one); never on a grid
// the analysis is unsure of; one trick at a time, spaced out, budgeted by the energy arc and the genre family, and
// the same trick not again for 20 minutes. Pure: no audio, no DOM.
import { styleFamily } from './dj-styles.js';

/**
 * Catalogue. slot: where it goes (preDrop: the bars before a drop / chorus; groove: a phrase line inside a long
 * section; dropStart: the downbeat of a drop / chorus; afterDrop: 16 bars into a drop). bars: length before it
 * resolves. families: genre families it suits. needs: extra conditions. weight: base desirability.
 */
export const TRICKS = {
  bassTease: { label: 'bass-cut tease', slot: 'preDrop', bars: 2, families: ['house', 'techno', 'bass', 'trance', 'disco'], weight: 1.2, modes: ['subtle', 'party'] },
  grooveLift: { label: 'one-bar bass cut', slot: 'groove', bars: 1, families: ['house', 'techno', 'trance', 'disco'], weight: 0.6, modes: ['subtle', 'party'] },
  filterBuild: { label: 'filter build', slot: 'preDrop', bars: 8, families: ['house', 'trance', 'techno', 'disco'], weight: 1, modes: ['subtle', 'party'] },
  loopRoll: { label: 'loop-roll build', slot: 'preDrop', bars: 2, families: ['house', 'bass', 'open', 'trance'], weight: 1.1, modes: ['party'], minEnergy: 6 },
  pauseDrop: { label: 'pause drop', slot: 'preDrop', bars: 0.25, families: ['open', 'bass', 'house', 'trance'], weight: 1.3, modes: ['party'], familiar: true, minEnergy: 6 },
  echoFreeze: { label: 'echo freeze', slot: 'hookEnd', bars: 1, families: ['open'], weight: 0.9, modes: ['party'], familiar: true, vocal: true },
  horn: { label: 'air horn on the drop', slot: 'dropStart', bars: 0, families: ['open'], weight: 0.8, modes: ['party'], minEnergy: 7 },
  rewind: { label: 'rewind', slot: 'afterDrop', bars: 0.5, families: ['bass', 'open'], weight: 1.4, modes: ['party'], familiar: true, minEnergy: 7, peak: true, cooldownMin: 60 },
};

/** Minutes between any two tricks, and before the same trick comes back. */
export const SPACING_MIN = { subtle: 9, party: 3.5 };
export const SAME_TRICK_MIN = 20;
const MAIN = new Set(['drop', 'chorus']);

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const barOf = (t) => (finite(t.bpm) && t.bpm > 0 ? 240 / t.bpm : 2);
const sections = (t) => (Array.isArray(t?.phrases) ? t.phrases : []).filter((p) => finite(p.start) && finite(p.end) && p.end > p.start).sort((a, b) => a.start - b.start);

/** Mean vocal presence of t in [a, b) from its per-second vocal map; null when unmeasured. */
function vocalIn(t, a, b) {
  const m = t?.vocalMap;
  if (!m?.length) return null;
  const i0 = Math.max(0, Math.floor(a)), i1 = Math.min(m.length, Math.ceil(b));
  if (i1 <= i0) return 0;
  let s = 0; for (let i = i0; i < i1; i++) s += m[i];
  return s / (i1 - i0);
}

/** Candidate slots of a track inside [from, to] (track seconds): { slot, at (resolve downbeat), section }. */
export function trickSlots(t, from, to) {
  const out = [], ph = sections(t), bar = barOf(t);
  for (let i = 0; i < ph.length; i++) {
    const p = ph[i], prev = ph[i - 1];
    if (MAIN.has(p.type) && prev && !MAIN.has(prev.type)) out.push({ slot: 'preDrop', at: p.start, section: p });
    if (MAIN.has(p.type)) { out.push({ slot: 'dropStart', at: p.start, section: p }); if (p.end - p.start >= 32 * bar - 0.01) out.push({ slot: 'afterDrop', at: p.start + 16 * bar, section: p }); }
    if (p.type === 'chorus' && ph[i + 1] && ph[i + 1].type !== 'chorus') out.push({ slot: 'hookEnd', at: p.end, section: p });
    if (p.end - p.start >= 32 * bar - 0.01) for (let b = 16; b < (p.end - p.start) / bar - 4; b += 16) out.push({ slot: 'groove', at: p.start + b * bar, section: p });
  }
  return out.filter((s) => s.at >= from && s.at <= to);
}

/**
 * Plan the tricks for the track on air.
 * t: track (bpm, phrases, energy, genre/tags, vocalMap, bpmConfidence, gridLocked).
 * ctx: { from, to (track seconds: the window free of transitions), mode: 'off'|'subtle'|'party', phase:
 *   'warmup'|'build'|'peak'|'valley'|'close', familiar: bool, history: [{ id, atMs }] (tricks done this set),
 *   nowMs, positionToMs(sec) → wall ms when the deck reaches that position (default: now + (sec - from) s) }.
 * @returns {{ id, label, slot, start, at, bars, score, why }[]} at most one (subtle) or two (party) per track
 */
export function planTricks(t, ctx = {}) {
  const mode = ctx.mode || 'off';
  if (mode === 'off' || !t || !finite(t.bpm) || t.bpm <= 0) return [];
  if (finite(t.bpmConfidence) && t.bpmConfidence < 0.5 && !t.gridLocked && !t.bpmLocked) return []; // shaky grid
  const phase = ctx.phase || 'build';
  if (phase === 'warmup' && mode !== 'party') return [];
  const family = styleFamily(t), energy = finite(t.energy) ? t.energy : 5;
  if (family === 'lounge') return [];
  const bar = barOf(t), now = ctx.nowMs ?? Date.now();
  const toMs = ctx.positionToMs || ((sec) => now + (sec - (ctx.from ?? 0)) * 1000);
  const history = ctx.history || [];
  const lastAny = Math.max(-Infinity, ...history.map((h) => h.atMs));
  const spacing = (SPACING_MIN[mode] || 9) * 60e3;
  const cands = [];
  for (const s of trickSlots(t, ctx.from ?? 0, ctx.to ?? Infinity)) {
    for (const [id, tr] of Object.entries(TRICKS)) {
      if (tr.slot !== s.slot || !tr.modes.includes(mode)) continue;
      if (family && !tr.families.includes(family)) continue;
      if (!family && !['bassTease', 'filterBuild', 'grooveLift'].includes(id)) continue;
      if (tr.minEnergy && energy < tr.minEnergy) continue;
      if (tr.familiar && !ctx.familiar) continue;
      if (tr.peak && phase !== 'peak') continue;
      const start = s.at - tr.bars * bar;
      if (start < (ctx.from ?? 0)) continue;
      const when = toMs(start);
      if (when - lastAny < spacing) continue;
      const lastSame = Math.max(-Infinity, ...history.filter((h) => h.id === id).map((h) => h.atMs));
      if (when - lastSame < Math.max(SAME_TRICK_MIN, tr.cooldownMin || 0) * 60e3) continue;
      const v = vocalIn(t, start, s.at + (id === 'pauseDrop' ? 0 : 0.5));
      if (!tr.vocal && v != null && v > 0.4) continue; // never over a vocal line
      if (tr.vocal && (v == null || v < 0.4)) continue; // the echo freeze needs a vocal to freeze
      let score = tr.weight + ({ peak: 1, build: 0.5, valley: -0.3, close: 0.2, warmup: -1 }[phase] || 0) + (ctx.familiar ? 0.4 : 0) + (energy - 6) * 0.15;
      if (s.slot === 'groove') score -= 0.4;
      cands.push({ id, label: tr.label, slot: s.slot, start, at: s.at, bars: tr.bars, score, restart: s.slot === 'afterDrop' ? s.section.start : null, why: `${tr.label}: ${phase}${ctx.familiar ? ', a known track' : ''}${family ? `, ${family}` : ''}` });
    }
  }
  // most phrase ends get no trick: keep only clear winners, spaced at least 32 bars apart
  const threshold = mode === 'party' ? 1 : 1.4, limit = mode === 'party' ? 2 : 1;
  const picked = [];
  for (const c of cands.filter((c) => c.score >= threshold).sort((a, b) => b.score - a.score)) {
    if (picked.length >= limit) break;
    if (picked.some((p) => Math.abs(p.at - c.at) < 32 * bar || p.id === c.id)) continue;
    if (picked.length && toMs(c.start) - toMs(picked[0].start) < spacing && toMs(picked[0].start) - toMs(c.start) < spacing) continue;
    picked.push(c);
  }
  return picked.sort((a, b) => a.start - b.start);
}

/** Loop-roll sizes (beats) through a roll build of `beats` beats, by beat index: 1, 1/2, 1/4, 1/8 over the last beats. */
export function rollSize(beatIndex, beats = 8) {
  const left = beats - beatIndex;
  return left > 4 ? 1 : left > 2 ? 0.5 : left > 1 ? 0.25 : 0.125;
}
