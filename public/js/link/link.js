// Ableton Link in the renderer: LINK button in the top bar (peers count), follow / lead logic for the master deck.
// - lead:   when the master deck's tempo changes, propose it as the session tempo (and, alone in the session or when
//           "push phase" is used, move the session grid to the deck's beats);
// - follow: set the master deck's tempo to the Link tempo and keep its beat phase locked like SYNC does
//           (hard seek for big errors, tiny pitch bend for small ones), using the audio actually heard
//           (AudioContext output timestamp + outputLatency + a user offset) against Link's host-time beat clock.
// Server: server/link (UDP discovery + measurement); state arrives on /api/link/stream at ~20 Hz.
import { icon } from '../ui/icons.js';
import { el, uiZoom } from '../util.js';
import {
  browserMicros, estimateOffset, audioLagSec, heardPosition, deckBeats, linkBeatAt, followPlan, phaseError, beatScale, tempoRatio,
} from './link-core.js';

const STORE = 'opendj.link';
const jget = async (url) => { const r = await fetch(url, { credentials: 'same-origin' }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.json(); };
const jsend = async (method, url, body) => {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
};

function loadPrefs() {
  const def = { follow: true, lead: true, latencyMs: 0, phaseLock: true };
  try { return { ...def, ...JSON.parse(localStorage.getItem(STORE) || '{}') }; } catch { return def; }
}

export class LinkClient {
  constructor(app) {
    this.app = app; this.engine = app.engine;
    this.state = { enabled: false, peers: 0, bpm: 120, beat: 0, phase: 0, quantum: 4, host: 0, playing: false };
    this.prefs = loadPrefs();
    this.offset = 0; this.offsetRtt = Infinity; // server host µs − browser µs
    this.available = true;
    this._proposed = { bpm: 0, at: 0 }; this._bendOwned = null; this._listeners = new Set(); this._wasPlaying = new Map(); // deck → playing
  }

  savePrefs() { try { localStorage.setItem(STORE, JSON.stringify(this.prefs)); } catch { /* private mode */ } }
  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _changed() { this._syncTimers(); for (const fn of this._listeners) { try { fn(this.state); } catch (e) { console.error(e); } } this.render?.(); }

  /** Start/stop 20 Hz follow/beat loops and 10 s clock-sync HTTP probes only while Link is enabled. */
  _syncTimers() {
    if (this.state.enabled && this.available) {
      if (!this._clockT) {
        if (!Number.isFinite(this.offsetRtt)) this.syncClock().catch(() => {});
        this._clockT = setInterval(() => this.syncClock().catch(() => {}), 10000);
      }
      if (!this._loopT) this._loopT = setInterval(() => this.step(), 50);
      if (this.beatEl && !this._beatT) this._beatT = setInterval(() => this._renderBeat(), 50);
    } else {
      if (this._clockT) { clearInterval(this._clockT); this._clockT = null; }
      if (this._loopT) { clearInterval(this._loopT); this._loopT = null; }
      if (this._beatT) { clearInterval(this._beatT); this._beatT = null; }
      this.releaseBend();
      this._renderBeat();
    }
  }

  async init({ topbar = true } = {}) {
    try { Object.assign(this.state, await jget('/api/link')); } catch { this.available = false; }
    if (topbar) this.mountButton();
    if (!this.available) return this;
    if (this.state.enabled) {
      this.openStream();
      await this.syncClock().catch(() => {});
    }
    this._syncTimers();
    for (const d of this.engine.decks) {
      d.on('tempo', () => this.onDeckTempo(d));
      d.on('state', () => this.onDeckState(d));
    }
    // a newly chosen master deck only pushes its tempo when we're not following: with Follow on it adopts the
    // session tempo instead (otherwise picking a master would overwrite tempo changes made by other Link apps)
    this.engine.on('master-deck', () => { if (this.prefs.lead && !this.prefs.follow) this.onDeckTempo(this.engine.master); });
    return this;
  }

  openStream() {
    this.es?.close();
    this.es = new EventSource('/api/link/stream');
    this.es.addEventListener('state', (e) => {
      let s; try { s = JSON.parse(e.data); } catch { return; }
      const changed = s.enabled !== this.state.enabled || s.peers !== this.state.peers || Math.abs(s.bpm - this.state.bpm) > 0.005;
      const playChanged = s.playing !== this.state.playing;
      this.state = { ...this.state, ...s, receivedAt: browserMicros() };
      if (changed) this._changed(); else this.renderBeat?.();
      // start / stop from other Link apps (when start/stop sync is on): play or stop the master deck
      if (playChanged && s.enabled && s.startStopSync && this.prefs.follow) {
        const d = this.engine.master;
        if (d?.track && !!d.playing !== !!s.playing) { this._wasPlaying.set(d, !!s.playing); s.playing ? (this._snapNext = true, d.play()) : d.pause(); }
      }
    });
  }

  async syncClock() {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const t0 = browserMicros();
      const { host } = await jget('/api/link/time');
      samples.push({ t0, t1: browserMicros(), server: host });
    }
    const best = estimateOffset(samples);
    if (best) { this.offset = best.offset; this.offsetRtt = best.rtt; }
  }

  /** Server host time (µs) for "now" in the browser. */
  hostNow() { return browserMicros() + this.offset; }
  /** Link beat for the audio being heard now. */
  beatNow() { return this.state.host ? linkBeatAt(this.state, browserMicros(), this.offset) : 0; }

  // ------------------------------------------------------------------ actions
  async setEnabled(on) {
    try {
      this.state = { ...this.state, ...(await jsend('PUT', '/api/link', { enabled: !!on })) };
      if (this.state.enabled && !this.es) this.openStream();
      else if (!this.state.enabled && this.es) { this.es.close(); this.es = null; }
      this._changed();
    } catch (e) { this.app.toast?.(`Link: ${e.message}`); }
    if (on && this.prefs.lead && !this.prefs.follow) this.onDeckTempo(this.engine.master);
  }
  toggle() { return this.setEnabled(!this.state.enabled); }
  setFollow(v) { this.prefs.follow = !!v; this.savePrefs(); this.releaseBend(); this._changed(); }
  setLead(v) { this.prefs.lead = !!v; this.savePrefs(); this._changed(); }
  async setQuantum(q) { try { this.state = { ...this.state, ...(await jsend('PUT', '/api/link', { quantum: Number(q) })) }; this._changed(); } catch (e) { this.app.toast?.(e.message); } }
  async setStartStopSync(v) { try { this.state = { ...this.state, ...(await jsend('PUT', '/api/link', { startStopSync: !!v })) }; this._changed(); } catch (e) { this.app.toast?.(e.message); } }

  async proposeTempo(bpm) {
    if (!this.state.enabled || !(bpm > 0)) return;
    if (Math.abs(bpm - this.state.bpm) < 0.005) return;
    this._proposed = { bpm, at: performance.now() };
    this.state.bpm = bpm; // optimistic, so follow doesn't fight the proposal before the stream echoes it
    // a fader move fires many changes: send the latest one at most every 40 ms
    this._pendingBpm = bpm;
    if (!this._postT) {
      this._postT = setTimeout(() => { this._postT = null; jsend('POST', '/api/link/tempo', { bpm: this._pendingBpm }).catch(() => {}); }, 40);
    }
    this._changed();
  }

  /** Move the session grid so the master deck's current beat is "now" (anti-social with peers: explicit action only). */
  async pushPhase(deck = this.engine.master) {
    if (!this.state.enabled || !deck?.bpm || !deck.track) return;
    const lag = audioLagSec(this.engine.ctx) + this.prefs.latencyMs / 1000;
    const pos = heardPosition(deck.position, deck.rate, lag, deck.playing);
    const scale = beatScale(this.state.bpm, deck.bpm);
    const beat = deckBeats(deck, pos) * scale;
    await jsend('POST', '/api/link/beat', { beat, at: this.hostNow(), quantum: this.state.quantum, force: true }).catch((e) => this.app.toast?.(e.message));
  }

  // ------------------------------------------------------------------ deck hooks
  onDeckTempo(deck) {
    if (!deck || !this.state.enabled || !this.prefs.lead || deck !== this.engine.master || !deck.effectiveBpm) return;
    if (this._applying) return; // our own follow change
    this.proposeTempo(deck.effectiveBpm * (this.prefs.follow ? beatScale(this.state.bpm, deck.bpm) : 1));
  }

  onDeckState(deck) {
    const playing = !!deck.playing;
    const was = !!this._wasPlaying.get(deck);
    if (was === playing) return;
    this._wasPlaying.set(deck, playing);
    if (deck !== this.engine.master) return;
    const started = playing && !was;
    if (!this.state.enabled) return;
    if (started && this.prefs.follow) this._snapNext = true; // align at once
    // lead without follow, alone in the session: the session grid follows our deck
    if (started && this.prefs.lead && !this.prefs.follow && this.state.peers === 0) setTimeout(() => this.pushPhase(deck), 30);
    if (this.state.startStopSync) jsend('POST', '/api/link/playing', { playing, at: this.hostNow() }).catch(() => {});
  }

  releaseBend() {
    if (this._bendOwned) { try { this._bendOwned.setBend(0); } catch { /* */ } this._bendOwned = null; }
  }

  /** 20 Hz: follow the session (tempo + phase) on the master deck. */
  step() {
    if (!this.state.enabled || !this.prefs.follow || !this.state.host) { this.releaseBend(); return; }
    const deck = this.engine.master || this.engine.masterDeck?.();
    if (!deck?.track || !deck.bpm || deck.loading || deck.scratching) { this.releaseBend(); return; }
    if (this._bendOwned && this._bendOwned !== deck) this.releaseBend();
    // don't undo a tempo we just proposed before the session echoes it
    const proposing = performance.now() - this._proposed.at < 600 && Math.abs(this.state.bpm - this._proposed.bpm) > 0.01;
    const lag = audioLagSec(this.engine.ctx) + this.prefs.latencyMs / 1000;
    const pos = deck.position;
    const heard = heardPosition(pos, deck.rate, lag, deck.playing);
    const plan = followPlan({
      linkBpm: this.state.bpm, linkBeat: this.beatNow(), quantum: this.state.quantum, deckBpm: deck.bpm, deckTempo: deck.tempo,
      deckPos: pos, deckBeat: deckBeats(deck, heard), playing: deck.playing,
      phaseLock: this.prefs.phaseLock && this.engine.settings?.syncMode !== 'tempo',
      hardSeekBeats: this._snapNext ? 0.01 : 0.25,
    });
    this.lastError = plan.error;
    this._applying = true;
    try {
      if (plan.tempo != null && !proposing) deck.setTempo(plan.tempo);
      if (plan.seek != null && !deck.loop?.active) { deck.seek(Math.max(0, plan.seek)); this._snapNext = false; }
      else if (deck.playing) {
        if (plan.bend || this._bendOwned) { deck.setBend(plan.bend); this._bendOwned = plan.bend ? deck : null; }
        if (Math.abs(plan.error) < 0.05) this._snapNext = false;
      }
    } finally { this._applying = false; }
  }

  // ------------------------------------------------------------------ UI
  mountButton() {
    const topbar = document.querySelector('.topbar');
    if (!topbar || this.btn) return;
    this.peersEl = el('span', { class: 'link-peers' }, '0');
    this.beatEl = el('span', { class: 'link-beats' }, ...[0, 1, 2, 3].map(() => el('i')));
    this.btn = el('button', { class: 'btn sm link-btn', title: 'Ableton Link: tempo & beat sync with other apps on the network (right-click for options)' }, icon('link'), el('span', { class: 'lbl' }, 'LINK'), this.peersEl);
    this.btn.addEventListener('click', () => this.toggle());
    this.btn.addEventListener('contextmenu', (e) => { e.preventDefault(); this.togglePopover(); });
    const more = el('button', { class: 'btn sm link-more', title: 'Link options', 'aria-label': 'Link options', onclick: () => this.togglePopover() }, icon('chevron-down'));
    this.wrap = el('div', { class: 'link-wrap' }, this.btn, this.beatEl, more);
    const anchor = topbar.querySelector('.midi-dot') || topbar.querySelector('.tb-spacer')?.nextSibling || null;
    topbar.insertBefore(this.wrap, anchor);
    this.render = () => this._render();
    this.renderBeat = () => this._renderBeat();
    this._render();
    this._renderBeat();
    if (this.state.enabled && !this._beatT) this._beatT = setInterval(() => this._renderBeat(), 50);
  }

  _render() {
    if (!this.btn) return;
    const s = this.state;
    this.btn.classList.toggle('active', !!s.enabled);
    this.btn.disabled = !this.available;
    this.wrap.classList.toggle('on', !!s.enabled);
    this.peersEl.textContent = String(s.peers || 0);
    this.peersEl.hidden = !s.enabled;
    this.btn.title = !this.available ? 'Ableton Link is not available on this server'
      : s.enabled ? `Ableton Link on · ${s.peers || 0} peer${s.peers === 1 ? '' : 's'} · ${(+s.bpm).toFixed(2)} BPM${this.prefs.follow ? ' · following' : ''}${this.prefs.lead ? ' · leading' : ''}`
        : 'Ableton Link off: click to sync tempo & beat with other Link apps on the network';
    if (this.pop) this.fillPopover();
  }

  _renderBeat() {
    if (!this.beatEl || (typeof document !== 'undefined' && document.hidden)) return;
    const on = !!(this.state.enabled && this.state.host);
    const q = this.state.quantum || 4;
    const b = on ? this.beatNow() : 0;
    const cur = on ? Math.floor(((b % q) + q) % q) : -1;
    const sig = `${on ? 1 : 0}|${q}|${cur}`;
    if (sig === this._lastBeatSig) return;
    this._lastBeatSig = sig;
    const dots = this.beatEl.children;
    const n = Math.min(dots.length, q);
    for (let i = 0; i < dots.length; i++) {
      dots[i].hidden = i >= n;
      dots[i].classList.toggle('on', on && (q <= 4 ? cur === i : Math.floor(cur / (q / 4)) === i));
    }
  }

  togglePopover() {
    if (this.pop) { this.pop.remove(); this.pop = null; document.removeEventListener('pointerdown', this._outside, true); return; }
    this.pop = el('div', { class: 'link-pop', role: 'dialog', 'aria-label': 'Ableton Link' });
    this.fillPopover();
    document.body.append(this.pop);
    const r = this.wrap.getBoundingClientRect();
    const z = uiZoom(); Object.assign(this.pop.style, { top: `${(r.bottom + 6) / z}px`, left: `${Math.max(8, Math.min(innerWidth - 300 * z, r.left)) / z}px` }); // zoom: see util.uiZoom
    this._outside = (e) => { if (!this.pop?.contains(e.target) && !this.wrap.contains(e.target)) this.togglePopover(); };
    document.addEventListener('pointerdown', this._outside, true);
  }

  fillPopover() {
    const s = this.state, p = this.prefs;
    const chk = (label, checked, on, title) => el('label', { class: 'link-chk', title: title || '' }, el('input', { type: 'checkbox', checked, onchange: (e) => on(e.target.checked) }), label);
    const qSel = el('select', { class: 'sel tiny', onchange: (e) => this.setQuantum(e.target.value) }, ...[1, 2, 4, 8, 16].map((q) => el('option', { value: q, selected: q === s.quantum }, `${q} beat${q > 1 ? 's' : ''}`)));
    const lat = el('input', { class: 'inp tiny', type: 'number', step: 1, min: -500, max: 500, value: p.latencyMs, title: 'Extra output latency compensation (ms): raise it if OpenDJ sounds late against the other Link apps' });
    lat.addEventListener('change', () => { p.latencyMs = Number(lat.value) || 0; this.savePrefs(); });
    const deck = this.engine.master;
    this.pop.replaceChildren(
      el('div', { class: 'link-pop-head' }, el('b', {}, 'Ableton Link'), el('span', { class: 'link-pop-st' }, s.enabled ? `${s.peers || 0} peer${s.peers === 1 ? '' : 's'} · ${(+s.bpm).toFixed(2)} BPM` : 'off')),
      el('button', { class: `btn sm ${s.enabled ? 'active' : 'primary'}`, onclick: () => this.toggle() }, s.enabled ? 'Disable Link' : 'Enable Link'),
      chk('Follow Link (master deck tempo + phase)', p.follow, (v) => this.setFollow(v), 'The master deck plays at the Link tempo and stays in phase with the session'),
      chk('Lead (send master deck tempo changes)', p.lead, (v) => this.setLead(v), 'Moving the master deck tempo changes the session tempo for everybody'),
      chk('Start / stop sync', !!s.startStopSync, (v) => this.setStartStopSync(v), 'Share play / stop with Link apps that support it'),
      el('label', { class: 'link-row' }, el('span', {}, 'Quantum'), qSel),
      el('label', { class: 'link-row' }, el('span', {}, 'Latency offset (ms)'), lat),
      el('div', { class: 'link-row' },
        el('button', { class: 'btn sm', disabled: !s.enabled || !deck?.bpm, title: 'Move the session beat grid to the master deck (shifts every peer: use with care)', onclick: () => this.pushPhase() }, 'Push phase'),
        el('button', { class: 'btn sm', disabled: !s.enabled || !deck?.effectiveBpm, title: 'Send the master deck tempo to the session', onclick: () => this.proposeTempo(deck.effectiveBpm) }, 'Send tempo')),
      el('p', { class: 'hint' }, this.available ? (s.error ? `⚠ ${s.error}` : 'Works with Ableton Live, Traktor, Serato, rekordbox, Bitwig and Link-enabled iOS apps on the same network.') : 'Link is not available on this server.'),
    );
  }

  dispose() {
    clearInterval(this._clockT); clearInterval(this._loopT); clearInterval(this._beatT);
    this.es?.close(); this.wrap?.remove(); this.pop?.remove(); this.releaseBend();
  }
}

/** Create, initialise and return the Link client (app.link). */
export function setupLink(app, opts) {
  const link = new LinkClient(app);
  app.link = link;
  link.init(opts).catch((e) => console.warn('Link init failed', e));
  return link;
}

/** MIDI learn targets (push into buildTargets' list). */
export function linkMidiTargets(app) {
  return [
    { id: 'link.toggle', label: 'Ableton Link on/off', kind: 'button', handler: (down) => down && app.link?.toggle(), led: () => !!app.link?.state.enabled },
    { id: 'link.follow', label: 'Ableton Link: follow on/off', kind: 'button', handler: (down) => down && app.link?.setFollow(!app.link.prefs.follow), led: () => !!app.link?.prefs.follow },
    { id: 'link.lead', label: 'Ableton Link: lead on/off', kind: 'button', handler: (down) => down && app.link?.setLead(!app.link.prefs.lead), led: () => !!app.link?.prefs.lead },
    { id: 'link.pushPhase', label: 'Ableton Link: push phase', kind: 'button', handler: (down) => down && app.link?.pushPhase() },
  ];
}

export { tempoRatio, phaseError };
