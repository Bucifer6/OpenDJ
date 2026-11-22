// Lyrics in the UI: per-deck lyrics line under each detail waveform (current + next line, timed by what is heard),
// karaoke mode per deck (vocals down: AI stem mute when the deck has stems, else the quick-stems VOC knob) and a
// karaoke layer in the video mix. setupLyrics(app) → app.lyrics.
import { el } from '../util.js';
import { icon } from '../ui/icons.js';
import { lyricStateAt, heardTrackTime } from './lrc.js';
import { installKaraokeOverlay } from './karaoke-overlay.js';
import { openLyricsEditor } from './editor.js';

const STORE = 'opendj.lyrics';
const req = async (method, url, body) => {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
};

/** Output-pipeline delay (s) of the AudioContext: from getOutputTimestamp(), else outputLatency + baseLatency. */
export function outputLagSec(ctx, perfNow = performance.now()) {
  if (!ctx) return 0;
  const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
  if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
    const lag = ctx.currentTime - (ts.contextTime + (perfNow - ts.performanceTime) / 1000);
    if (lag >= 0 && lag < 1) return lag;
  }
  return (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
}

export class LyricsManager {
  constructor(app) {
    this.app = app; this.engine = app.engine;
    this.cache = new Map(); // trackId -> lyrics | Promise
    this.karaoke = new Set(); // deck indices in karaoke mode
    this.saved = new Map();   // deck index -> { vocal, stemMute } before karaoke
    this.rows = [];
    let p = {};
    try { p = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { /* */ }
    this.prefs = { deckLine: true, video: 'auto', videoDeck: 'auto', ...p }; // video: 'auto' (karaoke decks) | 'on' | 'off'
  }

  savePrefs() { try { localStorage.setItem(STORE, JSON.stringify(this.prefs)); } catch { /* */ } }

  // ------------------------------------------------------------------ data
  get(trackId) { const v = this.cache.get(trackId); return v && !(v instanceof Promise) ? v : null; }
  async fetch(trackId, { online = false, refresh = false } = {}) {
    const q = new URLSearchParams(); if (online) q.set('online', '1'); if (refresh) q.set('refresh', '1');
    const l = await req('GET', `/api/tracks/${encodeURIComponent(trackId)}/lyrics${q.size ? `?${q}` : ''}`);
    if (!online) this.cache.set(trackId, l);
    return l;
  }
  load(trackId) {
    if (!trackId) return Promise.resolve(null);
    const v = this.cache.get(trackId);
    if (v) return Promise.resolve(v);
    const p = this.fetch(trackId).catch(() => { this.cache.delete(trackId); return null; });
    this.cache.set(trackId, p);
    return p;
  }
  async save(trackId, body) { const r = await req('PUT', `/api/tracks/${encodeURIComponent(trackId)}/lyrics`, body); this.cache.set(trackId, r); this.refreshDecks(); return r; }
  async remove(trackId) { await req('DELETE', `/api/tracks/${encodeURIComponent(trackId)}/lyrics`); this.cache.delete(trackId); await this.load(trackId); this.refreshDecks(); }
  settings() { return req('GET', '/api/lyrics/settings'); }
  saveSettings(p) { return req('PUT', '/api/lyrics/settings', p); }
  invalidate(trackId) { this.cache.delete(trackId); for (const d of this.engine.decks) if (d.track?.id === trackId) this.load(trackId).then(() => this.refreshDecks()); }

  /** Track time being heard on a deck now (latency-compensated, tempo-aware). */
  heardTime(deck) {
    const extra = (Number(this.prefs.offsetMs) || 0) / 1000;
    return heardTrackTime(deck.position, deck.rate || 1, outputLagSec(this.engine.ctx) + extra, deck.playing);
  }
  stateFor(deck) {
    const l = deck.track ? this.get(deck.track.id) : null;
    if (!l?.synced?.length) return null;
    const t = this.heardTime(deck);
    return { ...lyricStateAt(l, t), t };
  }

  // ------------------------------------------------------------------ deck lines
  init() {
    this.mountDeckLines();
    for (const d of this.engine.decks) {
      d.on('load', () => { this.lastKey[d.index] = null; this.renderRow(d.index, true); });
      d.on('loaded', (t) => this.load(t?.id).then(() => this.renderRow(d.index, true)));
      if (d.track) this.load(d.track.id).then(() => this.renderRow(d.index, true));
    }
    this._t = setInterval(() => this.tick(), 50);
    this._videoT = setInterval(() => this.attachVideo(), 1000);
    return this;
  }

  /** Inject a lyrics line into each detail-waveform row (app.waves) — no deck-ui changes needed. */
  mountDeckLines() {
    this.lastKey = [];
    const waves = this.app.waves || [];
    this.rows = this.engine.decks.map((d, i) => {
      const cur = el('span', { class: 'lyr-cur' });
      const next = el('span', { class: 'lyr-next' });
      const text = el('div', { class: 'lyr-text', title: 'Lyrics (click to edit / sync)', onclick: () => this.openEditor(i) }, cur, next);
      const kBtn = el('button', { class: 'lyr-kara', title: 'Karaoke mode: vocals down + lyrics on the video output', onclick: (e) => { e.stopPropagation(); this.toggleKaraoke(i); } }, icon('mic'));
      const eBtn = el('button', { class: 'lyr-edit', title: 'Lyrics editor (tap to sync, import / export .lrc)', onclick: (e) => { e.stopPropagation(); this.openEditor(i); } }, icon('pencil'));
      const root = el('div', { class: 'lyr-line', 'data-deck': i }, text, kBtn, eBtn);
      const row = waves[i];
      if (row) { row.classList.add('has-lyrics'); row.append(root); }
      return { root, cur, next, kBtn, row };
    });
  }

  renderRow(i, force = false) {
    const deck = this.engine.decks[i];
    const targets = [this.rows[i]].filter(Boolean);
    if (!targets.length) return;
    const l = deck.track ? this.get(deck.track.id) : null;
    const show = this.prefs.deckLine && !!deck.track;
    let curT = '', nextT = '', mode = 'none', wordsHtml = null;
    if (l?.synced?.length) {
      const s = this.stateFor(deck);
      const line = s.line && !s.gap ? s.line : null;
      curT = line?.text || (s.index < 0 ? '' : '♪');
      nextT = s.next?.text || '';
      mode = 'synced';
      if (line?.words?.length) wordsHtml = { words: line.words, wi: s.wordIndex };
      const key = `${s.index}|${s.gap}|${s.wordIndex}`;
      if (!force && key === this.lastKey[i]) return;
      this.lastKey[i] = key;
    } else if (l?.plain) {
      mode = 'plain'; curT = 'Lyrics (not synced): click to sync'; nextT = '';
      if (!force && this.lastKey[i] === 'plain') return;
      this.lastKey[i] = 'plain';
    } else {
      if (!force && this.lastKey[i] === 'none') return;
      this.lastKey[i] = 'none';
    }
    for (const r of targets) {
      r.root.hidden = !show;
      r.root.dataset.mode = mode;
      if (wordsHtml) {
        r.cur.replaceChildren(...wordsHtml.words.map((w, k) => el('span', { class: k <= wordsHtml.wi ? 'sung' : '' }, w.text)));
      } else r.cur.textContent = curT;
      r.next.textContent = nextT;
      r.kBtn?.classList.toggle('active', this.karaoke.has(i));
    }
  }
  refreshDecks() { for (let i = 0; i < this.engine.decks.length; i++) this.renderRow(i, true); }

  tick() {
    const n = this.app.deckCount || this.engine.decks.length;
    for (let i = 0; i < n; i++) this.renderRow(i);
  }

  openEditor(i) { return openLyricsEditor(this.app, this.engine.decks[i], this); }

  // ------------------------------------------------------------------ karaoke mode
  /** Vocals down on a deck: AI vocal stem muted when the deck has stems loaded, else the quick-stems VOC knob at 0. */
  setKaraoke(i, on) {
    const deck = this.engine.decks[i], ch = this.engine.channels[i];
    if (!deck || !ch) return;
    if (on && !this.karaoke.has(i)) {
      this.saved.set(i, { vocal: ch.state?.vocal ?? 1, stemMute: Array.isArray(deck.stemMute) ? deck.stemMute[0] : null });
      ch.set('vocal', 0);
      const vi = 0; // STEM_NAMES[0] === 'vocals'
      if (typeof deck.setStemMute === 'function' && (deck.stemsReady || deck.stemsActive)) deck.setStemMute(vi, true);
      else if (typeof deck.loadStems === 'function' && deck.track?.stems?.ready && !deck.stemsLoading) {
        // prepared AI stems exist: load them, then mute the vocal stem
        deck.loadStems().then(() => { if (this.karaoke.has(i)) setTimeout(() => deck.setStemMute?.(vi, true), 50); }).catch(() => {});
      }
      this.karaoke.add(i);
      if (deck.track) this.load(deck.track.id);
    } else if (!on && this.karaoke.has(i)) {
      const s = this.saved.get(i) || { vocal: 1, stemMute: false };
      ch.set('vocal', s.vocal);
      if (typeof deck.setStemMute === 'function' && s.stemMute != null) deck.setStemMute(0, s.stemMute);
      this.karaoke.delete(i); this.saved.delete(i);
    }
    this.app.mixer?.renderAll?.();
    this.renderRow(i, true);
    this.attachVideo();
  }
  toggleKaraoke(i) { this.setKaraoke(i, !this.karaoke.has(i)); }

  // ------------------------------------------------------------------ video
  /** Deck whose lyrics go to the video: a karaoke deck (most audible), else (prefs.video 'on') the master deck. */
  videoDeck() {
    const decks = this.engine.decks, E = this.engine;
    if (this.prefs.videoDeck !== 'auto') return decks[Number(this.prefs.videoDeck)] || null;
    const level = (d) => (d.playing ? (E.channels[d.index]?.state.volume ?? 1) : 0);
    const kd = [...this.karaoke].map((i) => decks[i]).filter((d) => d?.track).sort((a, b) => level(b) - level(a))[0];
    if (kd) return kd;
    if (this.prefs.video === 'on') return E.master || E.masterDeck?.() || null;
    return null;
  }
  videoFrame() {
    if (this.prefs.video === 'off') return null;
    const deck = this.videoDeck();
    if (!deck?.track) return null;
    const state = this.stateFor(deck);
    if (!state || (!state.line && !state.next)) return null;
    const color = getComputedStyle(document.documentElement).getPropertyValue(`--deck${deck.index + 1}`).trim() || '#3ea6ff';
    return { state, color };
  }
  /** Hook the karaoke layer into the video mixer once it exists (app.video.mixer is created lazily). */
  attachVideo() {
    const mixer = this.app.video?.mixer;
    if (!mixer || this._mixer === mixer) return;
    this._mixer = mixer;
    installKaraokeOverlay(mixer, () => this.videoFrame());
  }

  dispose() {
    clearInterval(this._t); clearInterval(this._videoT);
    for (const r of this.rows) { r.root.remove(); r.row?.classList.remove('has-lyrics'); }
    this.app.video?.mixer?._karaoke?.uninstall();
  }
}

export function setupLyrics(app) {
  const m = new LyricsManager(app);
  app.lyrics = m;
  m.init();
  return m;
}

/** MIDI learn targets (push into buildTargets' list). */
export function lyricsMidiTargets(app) {
  const T = [];
  for (let d = 0; d < 4; d++) {
    T.push({ id: `deck${d + 1}.karaoke`, label: `Deck ${d + 1} Karaoke mode`, kind: 'button', handler: (down) => down && app.lyrics?.toggleKaraoke(d), led: () => !!app.lyrics?.karaoke.has(d) });
    T.push({ id: `deck${d + 1}.lyricsEditor`, label: `Deck ${d + 1} Lyrics editor`, kind: 'button', handler: (down) => down && app.lyrics?.openEditor(d) });
  }
  T.push({ id: 'lyrics.video', label: 'Lyrics on the video output (on/off)', kind: 'button', handler: (down) => { if (!down || !app.lyrics) return; app.lyrics.prefs.video = app.lyrics.prefs.video === 'on' ? 'auto' : 'on'; app.lyrics.savePrefs(); }, led: () => app.lyrics?.prefs.video === 'on' });
  return T;
}
