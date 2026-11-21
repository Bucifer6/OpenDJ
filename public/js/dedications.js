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
  remove(id) { const i = this.queue.findIndex((d) => d.id === id && d.state === 'queued'); if (i >= 0) { this.queue.splice(i, 1); this.emit('change'); } }
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

  /** The dialog: write, choose language and options, queue; the queue is listed below. */
  open() {
    const app = this.app;
    const text = el('textarea', { class: 'inp dedication-input', rows: 3, maxlength: DEDICATION_MAX, placeholder: 'For Ana and Mihai, happy anniversary!', 'aria-label': 'Dedication text' });
    const count = el('span', { class: 'hint' }, `0 / ${DEDICATION_MAX}`);
    text.addEventListener('input', () => { count.textContent = `${text.value.length} / ${DEDICATION_MAX}`; });
    const lang = el('select', { class: 'sel', 'aria-label': 'Language' }, ...Object.entries(VOICE_LANGS).map(([v, x]) => el('option', { value: v }, x.label)));
    lang.value = app.settings.dedicationLang === 'ro' ? 'ro' : 'en';
    const when = el('select', { class: 'sel', 'aria-label': 'When' }, el('option', { value: 'phrase' }, 'At the next phrase'), el('option', { value: 'now' }, 'Right away'));
    const speak = el('input', { type: 'checkbox', checked: true }), overlay = el('input', { type: 'checkbox', checked: true }), meta = el('input', { type: 'checkbox', checked: true });
    const status = el('p', { class: 'hint dedication-voice' }, 'Checking voices…');
    const list = el('ol', { class: 'dedication-list' });
    const renderList = () => {
      list.replaceChildren(...this.queue.map((d) => el('li', { class: `ded-${d.state}` },
        el('span', { class: 'ded-text' }, d.text), el('small', {}, ` ${d.lang.toUpperCase()} · ${d.state === 'waiting' && d.startsIn ? `in ${Math.ceil(d.startsIn)} s` : d.state}`),
        d.state === 'queued' ? el('button', { class: 'btn xs', title: 'Remove', onclick: () => this.remove(d.id) }, '✕') : null)));
      if (!this.queue.length) list.append(el('li', { class: 'hint', style: { listStyle: 'none', marginLeft: '-18px' } }, 'Nothing queued.'));
    };
    const off = this.on('change', renderList); renderList();
    const voiceNote = async () => {
      const caps = await this.voice?.capabilities().catch(() => null);
      const l = lang.value, name = VOICE_LANGS[l].label;
      if (!caps) { status.textContent = 'No voice available: the dedication will be shown as text.'; return; }
      status.textContent = caps.mix[l] ? `Spoken in ${name} by ${caps.mix.label} into the master output: heard, recorded and broadcast, music ducked.`
        : caps.local[l] ? `Spoken in ${name} by the system voice on this computer only (not recorded or broadcast: install ${l === 'ro' ? 'a Romanian speech voice' : 'a speech engine'} for that).`
          : `No ${name} voice is installed: the dedication will be shown as text. ${l === 'ro' ? 'Windows: Settings > Time & language > Speech > Add voices > Romanian. macOS: Spoken Content > Ioana. Linux: install espeak-ng.' : ''}`;
    };
    lang.addEventListener('change', voiceNote); voiceNote();
    const body = el('div', { class: 'form dedication-form' },
      el('label', { class: 'field' }, el('span', {}, 'Dedication'), text), count,
      el('div', { class: 'row' }, el('label', { class: 'field' }, el('span', {}, 'Language'), lang), el('label', { class: 'field' }, el('span', {}, 'When'), when)),
      el('label', { class: 'check' }, speak, ' Speak it over the mix'),
      el('label', { class: 'check' }, overlay, ' Show it on screen and on the video output'),
      el('label', { class: 'check' }, meta, ' Show it in the stream\'s "now playing" while live'),
      status, el('h4', {}, 'Queue'), list);
    app.dialogs.modal('Dedication', body, [
      { label: 'Close', value: null },
      { label: 'Queue dedication', primary: true, action: () => {
        try {
          this.add(text.value, { lang: lang.value, when: when.value, speak: speak.checked, overlay: overlay.checked, meta: meta.checked });
          app.setSetting?.('dedicationLang', lang.value);
          text.value = ''; count.textContent = `0 / ${DEDICATION_MAX}`;
          app.toast?.(when.value === 'now' ? 'Dedication coming up' : 'Dedication queued for the next phrase');
        } catch (e) { app.toast?.(e.message); }
        return false; // keep the dialog open for the queue
      } },
    ]).finally?.(off);
  }
}
