// Auto-mix: plays a queue non-stop on decks 1 & 2 with beat-matched, phrase-aligned transitions.
// Uses the track structure (phrases, mixIn / mixOut from analysis-core) when available: transitions start at the
// outgoing track's outro, the incoming track starts at its first downbeat so phrase boundaries line up, and the
// transition length adapts to the outro (bounded by settings.automix.transitionBeats).
import { Emitter } from './util.js';
import { toCamelot, camelotCompatible, analyzeStructure } from './audio/analysis-core.js';

const LOG_BPM_JUMP = Math.log(1.08); // > 8 % tempo change (after half/double matching) is a "big jump"

/** Tempo distance as |log ratio|, allowing half / double time (87 ↔ 174 = 0). */
export function tempoDistance(a, b) {
  if (!a || !b) return 0;
  const r = Math.abs(Math.log(b / a));
  return Math.min(r, Math.abs(r - Math.LN2), Math.abs(r - 2 * Math.LN2));
}

/** True when two keys clash (both known and not neighbours on the Camelot wheel). */
export function keysClash(a, b) {
  const ca = toCamelot(a), cb = toCamelot(b);
  return !!(ca && cb && !camelotCompatible(ca, cb));
}

function transitionScore(cur, t) {
  let s = 0;
  if (cur.bpm && t.bpm) {
    const d = tempoDistance(cur.bpm, t.bpm);
    s -= d * 60;
    if (d > LOG_BPM_JUMP) s -= 20 + (d - LOG_BPM_JUMP) * 100;
  }
  const cc = toCamelot(cur.key);
  if (cc && camelotCompatible(cc, toCamelot(t.key))) s += 6;
  return s;
}

/** Target energy (1..10 scale) at position x (0..1) of the set for each energy-curve mode. */
export function energyTarget(mode, x, lo = 1, hi = 10, n = 10) {
  const span = hi - lo;
  if (mode === 'build') return lo + span * x;
  if (mode === 'peak') return x < 0.65 ? lo + span * (x / 0.65) : hi - span * 0.7 * ((x - 0.65) / 0.35);
  if (mode === 'wave') { const cycles = Math.max(1, Math.round(n / 8)); return lo + span * (0.5 - 0.5 * Math.cos(2 * Math.PI * cycles * x)); }
  return null;
}

/**
 * Order a list so each next track is harmonically and tempo-wise close (greedy walk), optionally following an
 * energy curve: 'harmonic' (default), 'build' (rising energy), 'peak' (rise then fall), 'wave' (up and down).
 * Big tempo jumps (> 8 %, half/double time excepted) are avoided.
 */
export function smartOrder(tracks, mode = 'harmonic') {
  if (typeof mode === 'object' && mode) mode = mode.mode || mode.order || 'harmonic';
  const curve = mode === 'build' || mode === 'peak' || mode === 'wave';
  if (tracks.length < (curve ? 2 : 3)) return tracks;
  const E = (t) => (Number.isFinite(t.energy) ? t.energy : 5);
  const es = tracks.map(E), lo = Math.min(...es), hi = Math.max(...es), n = tracks.length;
  const target = (i) => energyTarget(mode, n > 1 ? i / (n - 1) : 0, lo, hi, n);
  const rest = [...tracks];
  let first = 0;
  if (curve) { // start with the track closest to the curve's start (low energy, then lowest tempo)
    const t0 = target(0);
    rest.forEach((t, i) => {
      const d = Math.abs(E(t) - t0), bd = Math.abs(E(rest[first]) - t0);
      if (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && (t.bpm || 0) < (rest[first].bpm || 0))) first = i;
    });
  }
  const out = [rest.splice(first, 1)[0]];
  while (rest.length) {
    const cur = out.at(-1), tgt = curve ? target(out.length) : null;
    let best = 0, bestScore = -Infinity;
    rest.forEach((t, i) => {
      let s = transitionScore(cur, t);
      if (curve) s -= Math.abs(E(t) - tgt) * 2.5;
      else if (cur.energy && t.energy) s -= Math.abs(t.energy - cur.energy) * 0.5;
      if (s > bestScore) { bestScore = s; best = i; }
    });
    out.push(rest.splice(best, 1)[0]);
  }
  return out;
}

const snapTo = (t, grid, beat) => grid + Math.round((t - grid) / beat) * beat;

/**
 * Where to start mixing out of a track and for how long (track seconds).
 * t: { bpm, gridOffset, duration, endTime, mixOut?, downbeat?, phrases? }
 * @returns {{ start: number, len: number, end: number, phrase: boolean }} phrase = start is a phrase boundary from the analysis
 */
export function planMixOut(t, { transitionBeats = 32, skipSilence = true } = {}) {
  const dur = t.duration || 0;
  const end = skipSilence ? Math.min(dur, t.endTime || dur) : dur;
  if (!t.bpm) { const len = Math.min(12, dur * 0.4); return { start: end - len, len, end, phrase: false }; }
  const beat = 60 / t.bpm, bar = 4 * beat;
  const maxLen = Math.min(transitionBeats * beat, dur * 0.4);
  let mo = t.mixOut;
  if (mo == null && t.phrases?.length) { // start of the trailing outro section
    let i = t.phrases.length - 1;
    if (t.phrases[i].type === 'outro') { while (i > 0 && t.phrases[i - 1].type === 'outro') i--; mo = t.phrases[i].start; }
  }
  const minLen = Math.min(maxLen, 8 * beat);
  if (mo != null && mo > 0 && end - mo >= minLen - 1e-3) {
    // long outro: start on the latest 8-bar phrase boundary inside it that still leaves room for the transition
    let start = mo;
    if (end - mo > maxLen) start = mo + Math.floor((end - mo - maxLen) / (8 * bar) + 1e-6) * 8 * bar;
    return { start, len: Math.min(end - start, maxLen), end, phrase: true };
  }
  // fallback: align to a 4-bar phrase counted from the first downbeat / grid
  const anchor = t.downbeat ?? t.gridOffset ?? 0;
  const lenSec = transitionBeats * beat;
  let start = end - Math.min(lenSec, dur * 0.4);
  const phrase = beat * 16;
  start = anchor + Math.floor((start - anchor) / phrase) * phrase;
  if (end - start > lenSec * 1.6) start += phrase;
  // never start after the music ends (short / unanalysed tracks, short transitions)
  const minStart = end - Math.min(lenSec, dur * 0.4);
  if (!(start <= minStart)) start = Math.max(0, minStart);
  return { start, len: Math.max(0, end - start), end, phrase: false };
}

/** Position (track seconds) to start the incoming track: its mix-in point (first downbeat), else first beat. */
export function incomingStart(t) {
  if (t.mixIn != null && t.mixIn >= 0 && (!t.duration || t.mixIn < t.duration - 1)) return t.mixIn;
  const st = t.startTime || 0;
  if (!t.bpm) return st;
  const beat = 60 / t.bpm;
  let s = Math.max(t.gridOffset || 0, snapTo(st, t.gridOffset || 0, beat));
  if (s < 0) s += beat;
  return s;
}

/**
 * Beats to offset the incoming start so its bars line up with the outgoing track.
 * pos: outgoing position; start: planned transition start (a phrase boundary) or null for an immediate mix.
 */
export function barOffsetBeats(t, pos, start = null) {
  if (!t.bpm) return 0;
  const beat = 60 / t.bpm;
  if (start != null) {
    const late = (pos - start) / beat;
    if (late >= 0 && late <= 4) return late;
  }
  const anchor = t.downbeat ?? t.gridOffset ?? 0;
  return ((((pos - anchor) / beat) % 4) + 4) % 4;
}

/**
 * Bass-swap point for the 'phrase' style, in incoming-track seconds: a phrase boundary of the incoming track inside
 * the transition window [inStart, inStart + lenIn] (closest to its middle); falls back to 8-, 4- or 1-bar boundaries
 * counted from the mix-in point.
 */
export function phraseSwapPoint(t, inStart, lenIn) {
  const lo = inStart + 0.2 * lenIn, hi = inStart + 0.85 * lenIn, mid = inStart + 0.5 * lenIn;
  const pick = (cands) => cands.filter((x) => x >= lo && x <= hi).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
  const fromPhrases = pick((t.phrases || []).map((p) => p.start));
  if (fromPhrases != null) return fromPhrases;
  if (t.bpm) {
    const bar = 240 / t.bpm, anchor = t.mixIn ?? t.downbeat ?? t.gridOffset ?? 0;
    for (const bars of [8, 4, 2, 1]) {
      const step = bars * bar, c = [];
      for (let k = Math.ceil((lo - anchor) / step - 1e-6); anchor + k * step <= hi + 1e-6; k++) c.push(anchor + k * step);
      const p = pick(c);
      if (p != null) return p;
    }
  }
  return mid;
}

const ease = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Mixer settings at transition progress k (0..1). kSwap: progress at which the 'phrase' bass swap happened (null = not yet).
 * Returns only the controls the style touches: inVol, outVol (0..0.8), inLow, outLow, inHigh (EQ -1..1), outFilter, echo (bool).
 */
export function mixLevels(style, k, kSwap = null) {
  if (style === 'phrase') {
    if (kSwap == null) return { inVol: 0.8 * ease(clamp01(k * 3)), outVol: 0.8, inLow: -1, outLow: 0, inHigh: k < 0.3 ? -0.5 + (k / 0.3) * 0.5 : 0 };
    return { inVol: 0.8, outVol: 0.8 * (1 - ease(clamp01((k - kSwap) / Math.max(1e-3, 1 - kSwap)))), inLow: 0, outLow: -1, inHigh: 0 };
  }
  if (style === 'eqswap') {
    return {
      inVol: 0.8 * Math.min(1, k * 2.5), inLow: k < 0.5 ? -1 : 0, outLow: k < 0.5 ? 0 : -1,
      outVol: 0.8 * (k < 0.75 ? 1 : 1 - ease((k - 0.75) / 0.25)), inHigh: k < 0.25 ? -0.5 + k * 2 : 0,
    };
  }
  if (style === 'filter') return { inVol: 0.8 * ease(Math.min(1, k * 1.5)), outFilter: Math.min(0.85, k * 1.1), outVol: 0.8 * (1 - ease(Math.max(0, (k - 0.5) / 0.5))) };
  if (style === 'echo') return { inVol: 0.8 * ease(k), echo: k > 0.7, outVol: 0.8 * (k < 0.75 ? 1 : 1 - ease((k - 0.75) / 0.25)) };
  return { inVol: 0.8 * Math.sin(k * Math.PI / 2), outVol: 0.8 * Math.cos(k * Math.PI / 2) }; // plain crossfade
}

const structureCache = new WeakMap();

/** Bars over which the incoming track eases back to its original tempo after a transition. */
export const TEMPO_RESTORE_BARS = 8;
/** Tempo (%) during the ease-back: smooth (ease-in-out) from `from` to 0 as k goes 0 → 1. */
export function tempoRampValue(from, k) {
  k = Math.min(1, Math.max(0, k));
  return from * (1 - k * k * (3 - 2 * k));
}

export class AutoMix extends Emitter {
  constructor(app) {
    super();
    this.app = app; this.engine = app.engine;
    this.enabled = false; this.queue = []; this.idx = 0; this.transition = null;
    this.engine.on('tick', () => this.tick());
  }
  get opts() { return this.app.settings.automix; }

  static smartOrder(tracks, mode) { return smartOrder(tracks, mode); }

  async start(tracks, { smart = false, order } = {}) {
    if (!tracks.length) throw new Error('Queue is empty');
    let list = [...tracks];
    if (this.opts.shuffle) list.sort(() => Math.random() - 0.5);
    if (smart) list = smartOrder(list, order || this.opts.order || 'harmonic');
    this.queue = list; this.idx = 0; this.enabled = true; this.transition = null;
    const [a, b] = this.engine.decks;
    await this.engine.resume();
    const playing = [a, b].find((d) => d.playing);
    if (!playing) {
      // start with the first track that actually loads (missing files / server errors are skipped)
      let loaded = false;
      while (this.idx < this.queue.length && this.enabled) {
        try { await this.app.loadTrack(0, this.queue[this.idx].id); loaded = true; this.idx++; break; }
        catch (e) { this.app.toast?.(`Automix: skipping "${this.queue[this.idx].title}" (${e.message})`); this.idx++; }
      }
      if (!loaded) { this.enabled = false; this.emit('state'); throw new Error('None of the tracks in the queue could be loaded'); }
      this.prepare(a);
      a.play();
    }
    this.current = playing || a;
    this.preloadNext();
    this.emit('state');
  }
  stop() { this.enabled = false; if (this.transition) this.finishTransition(true); this.emit('state'); }
  skip() { if (this.enabled && !this.transition) this.beginTransition(true); }

  // ---------- queue editing ----------
  /** Remove queue entry i (absolute index into this.queue). */
  remove(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.queue.splice(i, 1);
    if (i < this.idx) this.idx--;
    this.queueChanged();
  }
  /** Move queue entry from → to (absolute indices). Moving an upcoming track to this.idx makes it play next. */
  move(from, to) {
    const q = this.queue;
    if (from < 0 || from >= q.length || from === to) return;
    to = Math.max(0, Math.min(q.length - 1, to));
    let b = this.idx;
    const [t] = q.splice(from, 1);
    if (from < b) b--;
    q.splice(to, 0, t);
    if (to < b) b++;
    this.idx = b;
    this.queueChanged();
  }
  /** Insert tracks to play right after the current one. */
  insertNext(tracks) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    if (!list.length) return;
    this.queue.splice(this.idx, 0, ...list);
    this.queueChanged();
  }
  queueChanged() {
    if (this.enabled && !this.transition && this.current) this.preloadNext();
    this.emit('state');
  }

  other(d) { return d === this.engine.decks[0] ? this.engine.decks[1] : this.engine.decks[0]; }
  nextTrack() { return this.queue[this.idx] || null; }

  /** Structure info for the track on a deck: analysed fields, else derived from the deck's waveform (older analyses). */
  info(deck) {
    const t = deck.track || {};
    const base = { bpm: deck.bpm, gridOffset: deck.gridOffset, duration: deck.duration || t.duration, startTime: t.startTime, endTime: t.endTime };
    if (t.mixOut != null || t.mixIn != null) return { ...base, mixIn: t.mixIn, mixOut: t.mixOut, downbeat: t.downbeat, phrases: t.phrases };
    if (!deck.bpm || !deck.waveform || !deck.track) return { ...base, phrases: t.phrases };
    const key = `${deck.bpm}|${deck.gridOffset}|${t.startTime}|${t.endTime}`;
    let c = structureCache.get(deck.track);
    if (!c || c.key !== key) {
      try {
        c = { key, s: analyzeStructure(deck.waveform, deck.bpm, deck.gridOffset, { startTime: t.startTime || 0, endTime: t.endTime || deck.duration, duration: deck.duration }) };
      } catch { c = { key, s: {} }; }
      structureCache.set(deck.track, c);
    }
    return { ...base, ...c.s, phrases: t.phrases?.length ? t.phrases : c.s.phrases };
  }

  prepare(deck) {
    const ch = this.engine.channels[deck.index];
    ch.set('xfAssign', 'THRU'); ch.set('eqLow', 0); ch.set('eqMid', 0); ch.set('eqHigh', 0); ch.set('filter', 0); ch.set('volume', 0.8);
    deck.setKeyLock(true);
  }

  async preloadNext() {
    const t = this.nextTrack(); if (!t) return;
    const deck = this.other(this.current);
    if (this._loading || deck.track?.id === t.id || deck.loading) return;
    this._loading = true;
    try { await this.app.loadTrack(deck.index, t.id); } catch (e) {
      this.app.toast(`Automix: skipping "${t.title}" (${e.message})`);
      this.idx++; this._loading = false; this.emit('state'); return this.preloadNext();
    }
    this._loading = false;
    const ch = this.engine.channels[deck.index];
    ch.set('xfAssign', 'THRU'); ch.set('volume', 0);
    this.emit('state');
  }

  mixOutPoint(deck) { return planMixOut(this.info(deck), this.opts); }

  tick() {
    if (!this.enabled) return;
    const cur = this.current;
    if (!cur) return;
    if (this.transition) return this.stepTransition();
    if (this.tempoRamp) this.stepTempoRamp();
    const next = this.nextTrack();
    if (!cur.playing && !cur.loading && cur.track && cur.position >= cur.duration - 0.05) {
      // track ended without a transition (e.g. next track failed to load)
      if (next) this.beginTransition(true); else this.stop();
      return;
    }
    if (!cur.track || !cur.playing || !next) return;
    const nxt = this.other(cur);
    if (nxt.track?.id !== next.id) { if (!this._loading && !nxt.loading) this.preloadNext(); return; }
    if (nxt.loading) return;
    const { start } = this.mixOutPoint(cur);
    if (cur.position >= start) this.beginTransition();
  }

  /**
   * After a transition the incoming track keeps the outgoing track's tempo; without this every track would
   * inherit the previous one's speed and the drift adds up. Ease it back to 0 % over a few bars (setting
   * automix.restoreTempo, default on). Moving the tempo fader / sync by hand cancels it.
   */
  startTempoRamp(deck) {
    this.tempoRamp = null;
    if (this.opts.restoreTempo === false || !deck || Math.abs(deck.tempo) < 0.01 || deck.syncOn) return;
    const bpm = deck.effectiveBpm || 120;
    this.tempoRamp = { deck, from: deck.tempo, last: deck.tempo, t0: performance.now(), dur: (TEMPO_RESTORE_BARS * 4 * 60 / bpm) * 1000 };
  }
  stepTempoRamp() {
    const r = this.tempoRamp, d = r.deck;
    if (d !== this.current || d.syncOn || Math.abs(d.tempo - r.last) > 0.05) { this.tempoRamp = null; return; } // user took over
    const k = (performance.now() - r.t0) / r.dur;
    r.last = tempoRampValue(r.from, k);
    d.setTempo(k >= 1 ? 0 : r.last);
    if (k >= 1) this.tempoRamp = null;
  }

  beginTransition(immediate = false) {
    this.tempoRamp = null;
    const out = this.current, inn = this.other(out);
    const next = this.nextTrack();
    if (!next) { if (!out.playing) this.stop(); return; }
    if (!inn.track || inn.loading || inn.track.id !== next.id) { if (!inn.loading && !this._loading) this.preloadNext(); return; }
    const oi = this.info(out), ii = this.info(inn);
    const pos = out.position;
    let len, offBeats;
    if (immediate) {
      len = 4; offBeats = barOffsetBeats(oi, pos);
    } else {
      const plan = planMixOut(oi, this.opts);
      const late = pos - plan.start;
      offBeats = barOffsetBeats(oi, pos, plan.start);
      len = out.bpm && late / out.beatLen <= 4 ? plan.len - Math.max(0, late) : Math.min(plan.len, plan.end - pos);
    }
    len = Math.max(2, len);
    const outRate = out.rate || 1;
    const durWall = Math.max(2, len / outRate);
    // tempo-match the incoming track and start it at its mix-in point, bar/phrase-aligned with the outgoing track
    this.prepare(inn);
    this.engine.channels[inn.index].set('volume', 0);
    const inStart = incomingStart(ii) + (inn.bpm && out.bpm ? offBeats * inn.beatLen : 0);
    inn.seek(inStart);
    if (this.opts.keepSync && out.bpm && inn.bpm) { out.setMaster(); inn.syncOn = true; inn.matchTempo(); }
    // key clash → shift the incoming track's key to a compatible one (if the deck supports it)
    if (this.opts.keySync && typeof inn.keySyncTo === 'function') {
      const outKey = out.playingCamelot || out.camelot || out.track?.key;
      if (keysClash(outKey, inn.camelot || inn.track?.key)) { try { inn.keySyncTo(out); } catch (e) { console.warn('keySyncTo failed', e); } }
    }
    inn.play();
    const style = this.opts.style;
    const lenIn = inn.bpm && out.bpm ? (len / out.beatLen) * inn.beatLen : len;
    this.transition = { out, inn, t0: performance.now(), dur: durWall * 1000, style, inStart, swapAt: style === 'phrase' ? phraseSwapPoint(ii, inStart, lenIn) : null, kSwap: null };
    this.idx++;
    this.emit('state');
  }

  stepTransition() {
    const tr = this.transition;
    const k = Math.min(1, (performance.now() - tr.t0) / tr.dur);
    const chO = this.engine.channels[tr.out.index], chI = this.engine.channels[tr.inn.index];
    if (tr.style === 'phrase' && tr.kSwap == null && (tr.inn.position >= tr.swapAt - 0.005 || k >= 0.9)) tr.kSwap = k;
    const L = mixLevels(tr.style, k, tr.kSwap);
    if (L.inVol != null) chI.set('volume', L.inVol);
    if (L.outVol != null) chO.set('volume', L.outVol);
    if (L.inLow != null) chI.set('eqLow', L.inLow);
    if (L.outLow != null) chO.set('eqLow', L.outLow);
    if (L.inHigh != null) chI.set('eqHigh', L.inHigh);
    if (L.outFilter != null) chO.set('filter', L.outFilter);
    if (L.echo && !chO.state.fxOn) { chO.set('fxType', 'echo'); chO.set('fxBeats', 0.75); chO.set('fxMix', 0.6); chO.set('fxOn', true); }
    if (k >= 1) this.finishTransition();
  }

  finishTransition(aborted = false) {
    const { out, inn } = this.transition;
    this.transition = null;
    if (aborted) {
      // stopping mid-transition: finish the move to the incoming deck so the mixer isn't left half-mixed
      out.pause();
      const chO = this.engine.channels[out.index], chI = this.engine.channels[inn.index];
      for (const ch of [chO, chI]) { ch.set('eqLow', 0); ch.set('eqMid', 0); ch.set('eqHigh', 0); ch.set('filter', 0); ch.set('fxOn', false); }
      chI.set('volume', 0.8); chO.set('volume', 0.8);
      inn.syncOn = false; inn.setMaster?.(); this.current = inn;
      return;
    }
    out.pause();
    const chO = this.engine.channels[out.index], chI = this.engine.channels[inn.index];
    chO.set('fxOn', false); chO.set('filter', 0); chO.set('eqLow', 0);
    chI.set('eqLow', 0); chI.set('eqHigh', 0);
    inn.setMaster(); inn.syncOn = false;
    this.current = inn;
    this.startTempoRamp(inn);
    if (this.nextTrack()) setTimeout(() => this.preloadNext(), 500);
    else this.emit('ending');
    this.emit('state');
  }
}
