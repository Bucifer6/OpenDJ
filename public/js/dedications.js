// Live dedications: the DJ / MC queues a short message ("For Ana and Mihai…"); it is spoken over the mix at the next
// phrase boundary of the master deck, with the music ducked under it, in English or Romanian. Optionally shown on
// screen and on the video output (lower third), and sent as the stream's "now playing" text while it plays.
import { el } from './util.js';
import { Emitter } from './util.js';
import { VOICE_LANGS } from './audio/voice.js';

export const DEDICATION_MAX = 200;
const PHRASE_BEATS = 32, SHORT_PHRASE_BEATS = 16, MAX_WAIT = 20;
let seq = 0;

/** Plain one-line text: control / bidi characters removed, whitespace collapsed, clipped. */
export function cleanDedication(v) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DEDICATION_MAX);
}

/**
 * Seconds from now to the master deck's next phrase boundary (32 beats from the grid; 16 when 32 is over 20 s away),
 * keeping at least `lead` seconds. null when no deck with a beat grid is playing (then: now).
 */
export function secondsToPhrase(deck, lead = 0.6) {
  if (!deck?.playing || !deck.bpm || !(deck.rate > 0)) return null;
  const beat = 60 / deck.bpm, pos = deck.position, off = Number(deck.gridOffset) || 0;
  const b = (pos - off) / beat;
  for (const span of [PHRASE_BEATS, SHORT_PHRASE_BEATS, 4]) {
    let next = Math.ceil(b / span) * span;
    while ((next - b) * beat / deck.rate < lead) next += span;
    const s = (next - b) * beat / deck.rate;
    if (s <= MAX_WAIT || span === 4) return s;
  }
  return null;
}

export class Dedications extends Emitter {
  constructor(app) {
    super();
    this.app = app; this.queue = []; this.current = null; this._busy = false;
  }
  get voice() { return this.app.voice; }

  /**
   * Queue a dedication. opts: { lang: 'en'|'ro', speak (default true), overlay (default true), meta (stream
   * metadata, default true), when: 'phrase' | 'now', from: 'ui' | 'mcp' }. Returns the queued entry.
   */
  add(text, opts = {}) {
    const t = cleanDedication(text);
    if (!t) throw new Error('Write the dedication first');
    if (this.queue.length >= 10) throw new Error('At most 10 dedications can wait at once');
    const d = { id: `ded-${++seq}`, text: t, lang: opts.lang === 'ro' ? 'ro' : 'en', speak: opts.speak !== false, overlay: opts.overlay !== false, meta: opts.meta !== false, when: opts.when === 'now' ? 'now' : 'phrase', from: opts.from || 'ui', state: 'queued', at: Date.now() };
    this.queue.push(d);
    this.emit('change');
    this._pump();
    return d;
  }
  clear() { this.queue = this.queue.filter((d) => d.state !== 'queued'); this.emit('change'); }
  pending() { return this.queue.filter((d) => d.state === 'queued').length; }

  async _pump() {
    if (this._busy) return;
    this._busy = true;
    try {
      while (this.queue.length) {
        const d = this.queue[0];
        try { await this._play(d); } catch (e) { console.warn('dedication failed', e); this.app.toast?.(`Dedication: ${e.message}`); }
        this.queue.shift(); this.current = null; this.emit('change');
      }
    } finally { this._busy = false; }
  }

  async _play(d) {
    const app = this.app, E = app.engine;
    d.state = 'preparing'; this.current = d; this.emit('change');
    // render first (it takes a moment), then wait for the phrase boundary
    const prep = d.speak && this.voice ? await this.voice.prepare(d.text, d.lang) : { mode: 'text', reason: d.speak ? 'No voice available' : null };
    if (!this.queue.includes(d)) return; // removed meanwhile
    const deck = E.masterDeck?.() || E.decks.find((x) => x.playing);
    const wait = d.when === 'now' ? null : secondsToPhrase(deck, prep.mode === 'mix' ? 0.4 : 0.1);
    d.state = 'waiting'; d.startsIn = wait || 0; this.emit('change');
    let start;
    if (prep.mode === 'mix') {
      const r = this.voice.play(prep.buffer, { at: wait ? E.ctx.currentTime + wait : 0 });
      start = r.start;
      const lead = Math.max(0, (start - E.ctx.currentTime) * 1000);
      await new Promise((ok) => setTimeout(ok, lead));
      this._show(d, prep.buffer.duration, 'mix');
      await r.done;
    } else {
      if (wait) await new Promise((ok) => setTimeout(ok, wait * 1000));
      this._show(d, Math.max(5, d.text.length / 12), prep.mode);
      if (prep.mode === 'local') await this.voice.speakLocal(d.text, d.lang);
      else {
        if (d.speak && prep.reason) app.toast?.(`${prep.reason}: showing the dedication as text`);
        await new Promise((ok) => setTimeout(ok, Math.max(5, d.text.length / 12) * 1000));
      }
    }
    d.state = 'done'; d.mode = prep.mode;
    this._hide();
    this.emit('played', d);
  }

  /** On-screen banner, video lower third and stream metadata while it plays. */
  _show(d, seconds, mode) {
    const app = this.app;
    d.state = 'playing'; d.mode = mode; this.emit('change');
    if (d.overlay) {
      this._banner?.remove();
      this._banner = el('div', { class: 'dedication-banner', role: 'status', 'aria-live': 'polite' },
        el('span', { class: 'dedication-tag' }, VOICE_LANGS[d.lang]?.label === 'Română' ? 'Dedicație' : 'Dedication'), el('span', { class: 'dedication-text' }, d.text));
      document.body.append(this._banner);
      try { app.videoUi?.mixer?.showNowPlaying?.(`♥ ${d.text}`); } catch { /* video mixer not open */ }
    }
    const b = app.recording?.broadcaster;
    if (d.meta && b?.live) b.holdMetadata({ artist: d.lang === 'ro' ? 'Dedicație' : 'Dedication', title: d.text }, Math.max(8, seconds + 2) * 1000);
    this._hideTimer = setTimeout(() => this._hide(), Math.max(4, seconds + 3) * 1000);
  }
  _hide() { clearTimeout(this._hideTimer); this._banner?.remove(); this._banner = null; }
}
