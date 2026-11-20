// 16-step sample sequencer locked to the master deck's beat grid (like rekordbox Sequencer / Serato Sampler grid).
import { Emitter } from '../util.js';

const STORE = 'opendj.sequencer';

export class Sequencer extends Emitter {
  constructor(engine) {
    super();
    this.engine = engine; this.ctx = engine.ctx;
    this.steps = 16; this.rows = engine.sampler.slots.length;
    this.pattern = Array.from({ length: this.rows }, () => new Array(this.steps).fill(0));
    this.swing = 0; this.bpm = 120; this.running = false; this.step = 0; this.mute = new Array(this.rows).fill(false);
    try { const p = JSON.parse(localStorage.getItem(STORE)); if (p?.pattern?.length === this.rows) Object.assign(this, { pattern: p.pattern, swing: p.swing || 0 }); } catch { /* fresh */ }
  }
  save() { try { localStorage.setItem(STORE, JSON.stringify({ pattern: this.pattern, swing: this.swing })); } catch { /* storage unavailable */ } }
  toggle(r, c) { this.pattern[r][c] = this.pattern[r][c] ? 0 : 1; this.save(); this.emit('pattern'); }
  clear() { this.pattern = this.pattern.map((row) => row.fill(0)); this.save(); this.emit('pattern'); }

  /** Tempo + phase source: the master deck if one is playing, else the free-running internal clock. */
  clock() {
    const m = this.engine.masterDeck();
    if (m?.playing && m.bpm) {
      const beatSec = 60 / m.effectiveBpm;
      const beatPos = (m.position - m.gridOffset) / m.beatLen; // beats since grid start
      return { beatSec, beatPos, now: this.ctx.currentTime };
    }
    return null;
  }

  start() {
    if (this.running) return;
    this.running = true; this.k = null; this.nextTime = this.ctx.currentTime + 0.05; this.freeK = 0;
    this.timer = setInterval(() => this.schedule(), 25);
    this.emit('state');
  }
  stop() { this.running = false; clearInterval(this.timer); this.emit('state'); }

  fire(k, when, beatSec) {
    const step = ((k % this.steps) + this.steps) % this.steps;
    if (k % 2 && this.swing) when += this.swing * beatSec / 8;
    for (let r = 0; r < this.rows; r++) if (this.pattern[r][step] && !this.mute[r]) this.engine.sampler.trigger(r, { when, choke: false });
    setTimeout(() => this.emit('step', step), Math.max(0, (when - this.ctx.currentTime) * 1000));
  }

  schedule() {
    const horizon = this.ctx.currentTime + 0.12;
    const c = this.clock();
    if (c) {
      // locked to the master deck: 16th note k sits at grid position k/4 beats
      const at = (k) => c.now + (k / 4 - c.beatPos) * c.beatSec;
      const cur = Math.ceil(c.beatPos * 4 + 0.05);
      if (this.k == null || at(this.k) < this.ctx.currentTime - 0.02 || this.k > cur + 4) this.k = cur; // start, seek or loop
      while (at(this.k) < horizon) { this.fire(this.k, Math.max(at(this.k), this.ctx.currentTime), c.beatSec); this.k++; }
      this.nextTime = at(this.k);
    } else {
      const beatSec = 60 / this.bpm;
      if (this.k != null) { this.freeK = this.k; this.k = null; }
      while (this.nextTime < horizon) { this.fire(this.freeK, this.nextTime, beatSec); this.freeK++; this.nextTime += beatSec / 4; }
    }
  }
}
