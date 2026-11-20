// Auto-mix: plays a queue non-stop on decks 1 & 2 with beat-matched, phrase-aligned transitions.
import { Emitter } from './util.js';
import { toCamelot, camelotCompatible } from './audio/analysis-core.js';

export class AutoMix extends Emitter {
  constructor(app) {
    super();
    this.app = app; this.engine = app.engine;
    this.enabled = false; this.queue = []; this.idx = 0; this.transition = null;
    this.engine.on('tick', () => this.tick());
  }
  get opts() { return this.app.settings.automix; }

  /** Order a list so each next track is harmonically and tempo-wise close (greedy walk). */
  static smartOrder(tracks) {
    if (tracks.length < 3) return tracks;
    const rest = [...tracks]; const out = [rest.shift()];
    while (rest.length) {
      const cur = out.at(-1), cc = toCamelot(cur.key);
      let best = 0, bestScore = -Infinity;
      rest.forEach((t, i) => {
        let s = 0;
        if (cur.bpm && t.bpm) s -= Math.abs(Math.log(t.bpm / cur.bpm)) * 60;
        if (cc && camelotCompatible(cc, toCamelot(t.key))) s += 6;
        if (cur.energy && t.energy) s -= Math.abs(t.energy - cur.energy) * 0.5;
        if (s > bestScore) { bestScore = s; best = i; }
      });
      out.push(rest.splice(best, 1)[0]);
    }
    return out;
  }

  async start(tracks, { smart = false } = {}) {
    if (!tracks.length) throw new Error('Queue is empty');
    let list = [...tracks];
    if (this.opts.shuffle) list.sort(() => Math.random() - 0.5);
    if (smart) list = AutoMix.smartOrder(list);
    this.queue = list; this.idx = 0; this.enabled = true; this.transition = null;
    const [a, b] = this.engine.decks;
    await this.engine.resume();
    const playing = [a, b].find((d) => d.playing);
    if (!playing) {
      await this.app.loadTrack(0, this.queue[0].id);
      this.prepare(a);
      a.play();
      this.idx = 1;
    }
    this.current = playing || a;
    this.preloadNext();
    this.emit('state');
  }
  stop() { this.enabled = false; if (this.transition) this.finishTransition(true); this.emit('state'); }
  skip() { if (this.enabled && !this.transition) this.beginTransition(true); }

  other(d) { return d === this.engine.decks[0] ? this.engine.decks[1] : this.engine.decks[0]; }
  nextTrack() { return this.queue[this.idx] || null; }

  prepare(deck) {
    const ch = this.engine.channels[deck.index];
    ch.set('xfAssign', 'THRU'); ch.set('eqLow', 0); ch.set('eqMid', 0); ch.set('eqHigh', 0); ch.set('filter', 0); ch.set('volume', 0.8);
    deck.setKeyLock(true);
  }

  async preloadNext() {
    const t = this.nextTrack(); if (!t) return;
    const deck = this.other(this.current);
    if (deck.track?.id === t.id || deck.loading) return;
    this._loading = true;
    try { await this.app.loadTrack(deck.index, t.id); } catch (e) { this.app.toast(`Automix: skipping "${t.title}" (${e.message})`); this.idx++; this._loading = false; return this.preloadNext(); }
    this._loading = false;
    const ch = this.engine.channels[deck.index];
    ch.set('xfAssign', 'THRU'); ch.set('volume', 0);
    this.emit('state');
  }

  mixOutPoint(deck) {
    const end = this.opts.skipSilence ? Math.min(deck.duration, deck.track?.endTime || deck.duration) : deck.duration;
    const beats = this.opts.transitionBeats;
    const lenSec = deck.bpm ? (beats * 60) / deck.effectiveBpm * (deck.effectiveBpm / deck.bpm) : 12; // track time
    let start = end - Math.min(lenSec, deck.duration * 0.4);
    if (deck.bpm) { // align to a 4-bar phrase
      const phrase = deck.beatLen * 16;
      start = deck.gridOffset + Math.floor((start - deck.gridOffset) / phrase) * phrase;
      if (end - start > lenSec * 1.6) start += phrase;
    }
    return { start, len: end - start };
  }

  tick() {
    if (!this.enabled) return;
    const cur = this.current;
    if (!cur) return;
    if (this.transition) return this.stepTransition();
    if (!cur.playing && !cur.loading && cur.track && cur.position >= cur.duration - 0.05) {
      // track ended without a transition (e.g. next track failed to load)
      if (this.nextTrack()) this.beginTransition(true); else this.stop();
      return;
    }
    if (!cur.track || !cur.playing) return;
    const nxt = this.other(cur);
    if (!nxt.track && !this._loading) this.preloadNext();
    if (!nxt.track || nxt.loading) return;
    const { start } = this.mixOutPoint(cur);
    if (cur.position >= start) this.beginTransition();
  }

  beginTransition(immediate = false) {
    const out = this.current, inn = this.other(out);
    if (!inn.track || inn.loading) { if (!this.nextTrack()) this.stop(); return; }
    const { len } = immediate ? { len: 4 } : this.mixOutPoint(out);
    const outRate = out.rate || 1;
    const durWall = Math.max(2, len / outRate);
    // tempo-match the incoming track, start it on its first beat, phase-aligned
    this.prepare(inn);
    this.engine.channels[inn.index].set('volume', 0);
    const startAt = inn.bpm ? Math.max(inn.gridOffset, inn.snap(inn.track.startTime || 0)) : (inn.track.startTime || 0);
    inn.seek(startAt < 0 ? startAt + inn.beatLen : startAt);
    if (this.opts.keepSync && out.bpm && inn.bpm) { out.setMaster(); inn.syncOn = true; inn.matchTempo(); }
    inn.play();
    this.transition = { out, inn, t0: performance.now(), dur: durWall * 1000, style: this.opts.style };
    this.idx++;
    this.emit('state');
  }

  stepTransition() {
    const tr = this.transition;
    const k = Math.min(1, (performance.now() - tr.t0) / tr.dur);
    const chO = this.engine.channels[tr.out.index], chI = this.engine.channels[tr.inn.index];
    const ease = (x) => x * x * (3 - 2 * x);
    if (tr.style === 'eqswap') {
      chI.set('volume', 0.8 * Math.min(1, k * 2.5));
      chI.set('eqLow', k < 0.5 ? -1 : 0);
      chO.set('eqLow', k < 0.5 ? 0 : -1);
      chO.set('volume', 0.8 * (k < 0.75 ? 1 : 1 - ease((k - 0.75) / 0.25)));
      chI.set('eqHigh', k < 0.25 ? -0.5 + k * 2 : 0);
    } else if (tr.style === 'filter') {
      chI.set('volume', 0.8 * ease(Math.min(1, k * 1.5)));
      chO.set('filter', Math.min(0.85, k * 1.1));
      chO.set('volume', 0.8 * (1 - ease(Math.max(0, (k - 0.5) / 0.5))));
    } else if (tr.style === 'echo') {
      chI.set('volume', 0.8 * ease(k));
      if (k > 0.7 && !chO.state.fxOn) { chO.set('fxType', 'echo'); chO.set('fxBeats', 0.75); chO.set('fxMix', 0.6); chO.set('fxOn', true); }
      chO.set('volume', 0.8 * (k < 0.75 ? 1 : 1 - ease((k - 0.75) / 0.25)));
    } else { // plain crossfade
      chI.set('volume', 0.8 * Math.sin(k * Math.PI / 2));
      chO.set('volume', 0.8 * Math.cos(k * Math.PI / 2));
    }
    if (k >= 1) this.finishTransition();
  }

  finishTransition(aborted = false) {
    const { out, inn } = this.transition;
    this.transition = null;
    if (aborted) return;
    out.pause();
    const chO = this.engine.channels[out.index];
    chO.set('fxOn', false); chO.set('filter', 0); chO.set('eqLow', 0);
    inn.setMaster(); inn.syncOn = false;
    this.current = inn;
    if (this.nextTrack()) setTimeout(() => this.preloadNext(), 500);
    else this.emit('ending');
    this.emit('state');
  }
}
