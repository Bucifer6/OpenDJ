import { el, fmtTime } from './util.js';
import { api } from './api.js';
import { setupClientLog } from './client-log.js';
import { startPerfWatch } from './perf-watch.js';
import { Engine } from './audio/engine.js';
import { SAMPLE_CATALOG } from './audio/sample-catalog.js';
import { VoiceBus } from './audio/voice.js';
import { Dedications } from './dedications.js';
import { setupRemoteControl } from './remote-control.js';
import { buildDeck, DECK_COLORS } from './ui/deck-ui.js';
import { buildMixer } from './ui/mixer-ui.js';
import { DetailWaveform } from './ui/waveform.js';
import { LibraryUI } from './ui/library-ui.js';
import { Dialogs } from './ui/dialogs.js';
import { AutoMix, STYLES, STYLE_LABEL, DROP_STYLES } from './automix.js';
import { buildPreviewBox } from './ui/automix-preview-ui.js';
import { sourceTracks, lengthOptions, SET_LENGTHS } from './automix-sources.js';
import { MidiManager } from './midi/midi.js';
import { Sequencer } from './audio/sequencer.js';
import { applyTheme } from './ui/themes.js';
import { icon, iconLabel } from './ui/icons.js';
import { setupLibraryExtras } from './ui/library-extras.js';
import { Lighting } from './lighting/lighting.js';
import { setupVideo } from './video/video-ui.js';
import { setupUpload } from './ui/upload.js';
import { DvsManager } from './dvs/dvs.js';
import { setupLink } from './link/link.js';
import { setupStems } from './stems/stems-ui.js';
import { setupRecording } from './recording/index.js';
import { setupLyrics } from './lyrics/lyrics.js';
import { dvsButton } from './dvs/dvs-ui.js';
import { BackgroundAnalyser } from './audio/background-analysis.js';
import { isUndecodable } from './audio/analysis-queue.js';
import { platform, unavailable } from './platform.js';
import { setupUpdates } from './ui/update.js';
import { initI18n, storedLanguage, resolveLanguage, currentLanguage, t } from './i18n.js';

/** The OpenDJ mark: a platter with a tone arm, drawn in the accent colour. */
function logoMark() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'logo-mark'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="5.5" fill="none" stroke="currentColor" stroke-opacity=".45" stroke-width="1.5"/><circle cx="12" cy="12" r="2" fill="currentColor"/>';
  return s;
}

class App {
  constructor() { this.shift = false; this._shiftKey = false; }

  async init() {
    // interface language: start with the stored choice (no wait for the settings), then follow the setting
    [this.settings] = await Promise.all([api.settings(), initI18n(storedLanguage())]);
    if (resolveLanguage(this.settings.language) !== currentLanguage() || storedLanguage() !== (this.settings.language || 'auto')) await initI18n(this.settings.language || 'auto');
    applyTheme(this.settings);
    this.deckCount = Number(this.settings.deckCount) === 4 ? 4 : 2; // only 2 or 4 decks exist
    this.engine = new Engine(this.settings);
    await this.engine.init();
    this.dvs = new DvsManager(this);
    this.dialogs = new Dialogs(this);
    this.library = new LibraryUI(this);
    this.analyser = new BackgroundAnalyser(this);
    this.upload = setupUpload(this);
    // (not in the mobile app: its files are inside the app already)
    if ('serviceWorker' in navigator && !/Electron/.test(navigator.userAgent) && !platform.native) navigator.serviceWorker.register('/sw.js').catch(() => {});
    this.automix = new AutoMix(this);
    this.voice = new VoiceBus(this.engine); // MC voice: spoken intros and dedications through the master bus
    this.dedications = new Dedications(this);
    this.midi = new MidiManager(this);
    this.sequencer = new Sequencer(this.engine);
    this.buildLayout();
    setupStems(this);
    if (!platform.local) startPerfWatch(this); // page stalls / audio dropouts into the app log, with what was going on
    this.recording = setupRecording(this); this.engine.attachRecorder(this.recording.recorder);
    setupRemoteControl(this, api).then((r) => { this.remote = r; }).catch(() => {}); // AI assistant (MCP) actions, when on
    this.wireEvents(); // subscribe to server events before loading the library so no change is missed
    if (!unavailable('link')) setupLink(this); // Ableton Link: UDP multicast through the server
    setupLyrics(this);
    await this.midi.init();
    if (this.settings.midiClockOutput) this.midi.setClockOutput(this.settings.midiClockOutput);
    this.lighting = new Lighting(this);
    if (!unavailable('lighting')) { try { await this.lighting.init(); } catch (e) { console.warn('lighting init failed', e); } }
    await this.library.refresh();
    this.libraryExtras = setupLibraryExtras(this);
    this.analyser.autoQueue(); // tracks added earlier (or by another device) that were never analysed
    api.capabilities().then((c) => { this.hosted = !!c.hosted; this.auth = !!c.auth; this.library.renderEmpty(); this.updateHostedUi?.(); }).catch(() => {});
    this.library.refreshDrives();
    setInterval(() => {
      if (!document.hidden && !document.documentElement.classList.contains('lib-collapsed')) this.library.refreshDrives();
    }, 15000); // notice USB sticks being plugged in (skipped while hidden or library collapsed)
    this.setLayout(this.settings.layoutMode || 'classic', false, true);
    this.setDeckCount(this.deckCount, false);
    if (!unavailable('dvs')) this.dvs.init().catch((e) => console.warn('DVS init failed', e));
    this.engine.setMasterVolume(0.8); this.engine.setHeadphoneVolume(0.8);
    if (this.engine.ctx.state !== 'running') this.showStartOverlay();
    const frame = (now) => { this.frame(now); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    document.getElementById('boot')?.remove();
    this.updates = setupUpdates(this); // "a new version is available" (checks after a short delay, never during a set)
    // Gig Safe Mode: prevent OS sleep while decks play / gigMode is on, and snapshot deck/queue state for crash recovery
    const syncPower = () => {
      const busy = !!this.settings.gigMode || this.engine.decks.some((d) => d.playing) || !!this.recording?.recorder?.recording || !!this.automix?.enabled;
      if (busy !== this._powerLocked) { this._powerLocked = busy; window.opendjNative?.setPowerLock?.(busy).catch?.(() => {}); }
    };
    let lastSnapKey = '';
    const saveRecoverySnapshot = (cleanExit = false) => {
      try {
        const decks = this.engine.decks.map((d) => (d.track && !d.track.scratchSample ? { id: d.track.id, pos: Math.round((d.position || 0) * 10) / 10, playing: !!d.playing } : null));
        const queue = this.automix?.enabled ? (this.automix.queue || []).slice(this.automix.idx).map((x) => x.id).slice(0, 50) : [];
        if (!cleanExit && !decks.some(Boolean)) return;
        const key = JSON.stringify({ cleanExit, decks, queue });
        if (!cleanExit && key === lastSnapKey) return;
        lastSnapKey = key;
        localStorage.setItem('opendj-session-recovery', JSON.stringify({ at: Date.now(), cleanExit, decks, queue }));
      } catch { /* storage unavailable */ }
    };
    // Detect an unclean previous exit (<6h old) and expose non-intrusive session restore
    try {
      const prev = JSON.parse(localStorage.getItem('opendj-session-recovery') || 'null');
      if (prev && !prev.cleanExit && Date.now() - prev.at < 6 * 3600_000 && Array.isArray(prev.decks) && prev.decks.some((d) => d && this.library.track(d.id))) {
        this.recoverableSession = prev;
      }
    } catch { /* ignore corrupt snapshot */ }
    window.addEventListener('beforeunload', () => saveRecoverySnapshot(true));
    setInterval(() => { syncPower(); saveRecoverySnapshot(false); }, 5000);
    if (this.settings.gigMode) {
      this.engine.decks.forEach((d) => { d.hardLock = true; });
      this.stems?.setHold?.(true);
    }
    syncPower();
    this.ready = true;
  }

  /** Safely restore tracks & cue positions from the last unclean-exit session snapshot (paused so audio never blasts unexpectedly). */
  async restoreLastSession() {
    const snap = this.recoverableSession;
    if (!snap?.decks) return 0;
    let restored = 0;
    for (let i = 0; i < snap.decks.length && i < this.engine.decks.length; i++) {
      const entry = snap.decks[i];
      if (!entry?.id || !this.library.track(entry.id)) continue;
      try {
        await this.loadTrack(i, entry.id, { automix: true });
        if (Number.isFinite(entry.pos) && entry.pos > 0) this.engine.decks[i].seek(entry.pos);
        restored++;
      } catch { /* skip unreadable track */ }
    }
    this.recoverableSession = null;
    return restored;
  }

  async setSetting(k, v) {
    this.settings[k] = v;
    try {
      this.settings = { ...this.settings, ...(await api.saveSettings({ [k]: v })) };
      this.engine.settings = this.settings;
      if (k === 'gigMode') {
        this.engine.decks.forEach((d) => { d.hardLock = !!this.settings.gigMode || !!this.settings.deckOptions?.hardLock; });
        if (this.settings.gigMode) { this.analyser?.stop?.(); this.stems?.setHold?.(true); }
        else this.stems?.setHold?.(false);
        window.opendjNative?.setPowerLock?.(!!this.settings.gigMode).catch?.(() => {});
      }
    } catch (e) { this.toast(e.message); }
  }

  /** Hosted mode (password login): Sign out in the top bar. */
  updateHostedUi() { if (this.signOutBtn) this.signOutBtn.hidden = !this.auth; }

  showStartOverlay() {
    const o = el('div', { class: 'overlay start' }, el('button', { class: 'btn primary big-start', onclick: async () => { await this.engine.resume(); o.remove(); } }, iconLabel('play', 'Start audio engine')));
    document.body.append(o);
  }

  /**
   * Load a library track on a deck. Every user load path (drag & drop, "Load to deck", double-click / Enter, Shift+arrow,
   * MIDI) comes through here; automix passes { automix: true } for its own loads. While automix runs a user load on
   * deck 1 / 2 is handed to automix (next track / ask / queue), so automix never loads over the user's pick.
   */
  async loadTrack(deckIndex, trackId, { automix = false } = {}) {
    const t = this.library.track(trackId);
    const deck = this.engine.decks[deckIndex];
    if (!t) { this.toast('That track is no longer in the library'); throw new Error('Track not found in the library'); }
    let confirmed = automix;
    if (!automix && this.automix?.enabled) {
      const r = await this.automix.userLoad(deckIndex, t);
      if (r === 'handled') return;
      if (r === 'load') confirmed = true;
    }
    if (deck.playing && !automix && (deck.hardLock || this.settings.deckOptions?.hardLock)) { this.toast(`Deck ${deckIndex + 1} is locked while it plays`); return; }
    if (deck.playing && !confirmed && !(await this.dialogs.confirm(`Deck ${deckIndex + 1} is playing. Load "${t.title}" anyway?`))) return;
    try {
      if (!(await deck.load({ ...t }))) return;
      if (t.unreadable) api.updateTrack(t.id, { unreadable: false }).then((x) => this.library.updateTrack(x)).catch(() => {});
      this.library.renderRows(true);
    } catch (e) {
      const file = String(t.fileName || t.path || t.localPath || '').split(/[\\/]/).pop();
      const bad = isUndecodable(e);
      this.toast(`⚠ Could not load "${t.title}"${file && file !== t.title ? ` (${file})` : ''}: ${bad ? 'the file could not be decoded (corrupt, empty or unsupported)' : e.message}`);
      if (bad && !t.unreadable) api.updateTrack(t.id, { unreadable: true }).then((x) => this.library.updateTrack(x)).catch(() => {});
      throw e;
    }
  }

  /** Short message at the bottom; opts.duration (ms, default 4200) for longer notices. */
  toast(msg, { duration = 4200 } = {}) {
    // "⚠ …" messages are warnings: shown with an icon and the warning colour instead of the emoji
    const warn = typeof msg === 'string' && /^⚠\uFE0F?\s*/.test(msg);
    const t = el('div', { class: `toast${warn ? ' warn' : ''}`, role: warn ? 'alert' : 'status' }, icon(warn ? 'warn' : 'info'), el('span', { class: 'toast-msg' }, warn ? msg.replace(/^⚠\uFE0F?\s*/, '') : msg));
    this.toasts.append(t);
    setTimeout(() => t.classList.add('out'), duration); setTimeout(() => t.remove(), duration + 500);
  }

  // ---------------- layout ----------------
  buildLayout() {
    const root = document.getElementById('app');
    this.toasts = el('div', { class: 'toasts' });
    // top bar
    this.clock = el('span', { class: 'clock' });
    this.recBtn = el('button', { class: 'btn rec', onclick: () => this.toggleRecord(), title: 'Record your mix to disk. R = start / stop' }, el('span', { class: 'rec-dot' }), 'REC');
    this.recTime = el('span', { class: 'rec-time' });
    // one click: start a smart automix of the queue / this library view at once (what the separate AUTOMIX NOW
    // button did); click again to stop. Shift-click or right-click: the Automix dialog (order, profile, transitions).
    this.amBtn = el('button', { class: 'btn automix-btn', onclick: (e) => this.toggleAutomix({ dialog: e.shiftKey || this.shift }), oncontextmenu: (e) => { e.preventDefault(); if (!this.automix.enabled && !this._amStarting) this.toggleAutomix({ dialog: true }); }, title: 'Automix: start a smart mix of the queue, or else of this library view, with your saved preferences. Tracks already loaded on decks 1 and 2 play first. Click again to stop. ▾: whole library, a playlist, genres, 1 hour, endless. Shift-click or right-click: Automix options. Key: A' }, iconLabel('automix', 'AUTOMIX'));
    this.amMenuBtn = el('button', { class: 'btn sm icon-only am-menu-btn', title: 'Automix: what to mix and for how long (whole library, a playlist, genres, 1 hour, endless…)', 'aria-label': 'Automix options', 'aria-haspopup': 'menu', onclick: (e) => this.automixMenu(e.currentTarget) }, '▾');
    this.amSkip = el('button', { class: 'btn sm icon-only', onclick: () => this.automix.skip(), title: 'Mix to next track now', 'aria-label': 'Mix to next track now' }, icon('next'));
    this.amInfo = el('span', { class: 'am-info' });
    this.amQueueBtn = el('button', { class: 'btn sm am-queue-btn', onclick: () => this.toggleQueuePanel(), title: 'Automix queue: upcoming tracks, transition styles, smart-mix reasons' }, 'QUEUE');
    this.midiDot = el('span', { class: 'midi-dot', title: 'MIDI activity' }, 'MIDI');
    this.cpu = el('span', { class: 'cpu' });
    // layout modes: three 2-deck views + 4 decks (deckCount). data-n stays on each button for the deck count it shows.
    const LAYOUTS = [['classic', 'Classic', 'Two decks and the mixer'], ['performance', 'Perform', 'Performance: pads and loops up front'], ['waveform', 'Waves', 'Waveform focus: big waveforms, compact decks'], ['four', '4 Decks', 'Four decks']];
    const deckSel = el('div', { class: 'seg layout-seg', role: 'radiogroup', 'aria-label': 'Layout' }, ...LAYOUTS.map(([id, label, title]) => el('button', {
      class: 'seg-btn', role: 'radio', 'data-layout': id, 'data-n': id === 'four' ? 4 : 2, title,
      onclick: () => (id === 'four' ? this.setDeckCount(4) : this.setLayout(id)),
    }, label)));
    this.deckSel = deckSel;
    const shiftBtn = el('button', { class: 'btn sm shift-btn', title: 'Shift (or hold the Shift key)' }, 'SHIFT');
    shiftBtn.addEventListener('pointerdown', () => { this.shift = true; shiftBtn.classList.add('active'); });
    const shiftUp = () => { this.shift = this._shiftKey; shiftBtn.classList.remove('active'); };
    shiftBtn.addEventListener('pointerup', shiftUp); shiftBtn.addEventListener('pointerleave', shiftUp);
    const topbar = el('header', { class: 'topbar' },
      el('div', { class: 'logo', translate: 'no' }, logoMark(), el('span', { class: 'logo-word' }, 'Open', el('b', {}, 'DJ'))),
      deckSel, shiftBtn,
      el('div', { class: 'tb-group automix-actions' }, this.amBtn, this.amMenuBtn, this.amSkip, this.amQueueBtn), this.amInfo,
      el('div', { class: 'tb-spacer' }),
      el('div', { class: 'tb-group' }, this.recBtn, this.recTime),
      this.midiDot, this.cpu, this.clock,
      dvsButton(this),
      el('button', { class: 'btn sm video-btn', title: 'Video mixer, visuals, YouTube & projector output', onclick: () => (this.videoUi ||= setupVideo(this)).toggleMixer() }, iconLabel('video', 'VIDEO')),
      el('button', { class: 'btn sm light-btn', title: 'Lighting (DMX, Art-Net, sACN, WLED, Hue, OSC)', onclick: () => this.lighting?.openPanel() }, iconLabel('lights', 'LIGHTS')),
      el('button', { class: 'btn icon tb-more', title: 'More', 'aria-label': 'More', 'aria-haspopup': 'menu', onclick: (e) => this.topbarMore(e.currentTarget) }, icon('more')),
      el('button', { class: 'btn icon', title: 'Settings', 'aria-label': 'Settings', onclick: () => this.dialogs.settings() }, icon('settings')),
      this.signOutBtn = el('button', { class: 'btn sm signout-btn', hidden: true, title: 'Sign out of this OpenDJ server', onclick: async () => { if (this.engine.decks.some((d) => d.playing) && !(await this.dialogs.confirm('Music is playing. Sign out anyway?'))) return; await api.logout(); } }, iconLabel('logout', 'Sign out')),
      el('button', { class: 'btn icon', title: 'Full screen', 'aria-label': 'Full screen', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()) }, icon('fullscreen')),
    );
    // stacked detail waveforms
    this.waves = this.engine.decks.map((d, i) => {
      const w = new DetailWaveform(d, () => this.settings);
      const lbl = el('div', { class: 'wave-label', style: { color: DECK_COLORS[i] } }, String(i + 1));
      const row = el('div', { class: 'wave-row', style: { '--deck-color': DECK_COLORS[i] } }, lbl, w.canvas);
      row.wf = w; return row;
    });
    const zoomBtns = el('div', { class: 'wave-zoom' },
      el('button', { class: 'btn xs', title: 'Zoom in', onclick: () => this.waves.forEach((r) => { r.wf.zoom = Math.max(2, r.wf.zoom / 1.5); }) }, '+'),
      el('button', { class: 'btn xs', title: 'Zoom out', onclick: () => this.waves.forEach((r) => { r.wf.zoom = Math.min(60, r.wf.zoom * 1.5); }) }, '−'));
    this.waveArea = el('section', { class: 'waves' }, ...this.waves, zoomBtns);
    // decks + mixer
    this.deckEls = this.engine.decks.map((d) => buildDeck(this, d));
    this.mixer = buildMixer(this);
    // small screens show one deck at a time (css/mobile.css): these tabs pick it
    this.deckTabs = el('div', { class: 'deck-tabs', role: 'tablist' }, ...this.engine.decks.map((d, i) => el('button', {
      class: 'deck-tab', role: 'tab', style: { '--deck-color': DECK_COLORS[i] }, onclick: () => this.showDeckTab(i),
    }, el('b', {}, `DECK ${i + 1}`), el('span', {}))));
    this.deckArea = el('section', { class: 'deck-area' }, this.deckTabs,
      el('div', { class: 'deck-col left' }, this.deckEls[0], this.deckEls[2]),
      this.mixer,
      el('div', { class: 'deck-col right' }, this.deckEls[1], this.deckEls[3]));
    // sampler strip
    this.samplerBar = this.buildSamplerBar();
    // resizable browser
    const handle = el('div', { class: 'resize-handle', title: 'Drag to resize the browser' });
    let startY, startH;
    handle.addEventListener('pointerdown', (e) => { handle.setPointerCapture(e.pointerId); startY = e.clientY; startH = this.library.root.getBoundingClientRect().height; });
    handle.addEventListener('pointermove', (e) => { if (startY == null) return; const z = (this.settings.uiScale || 100) / 100, room = innerHeight / z - (this.deckCount === 4 ? 560 : 420); // always leave room for waveforms + decks
      const h = Math.max(120, Math.min(Math.max(120, room), startH - (e.clientY - startY))); document.documentElement.style.setProperty('--browser-h', `${h}px`); });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(ev, () => { startY = null; });
    root.replaceChildren(topbar, this.waveArea, this.deckArea, this.samplerBar, handle, this.library.root, this.toasts);
  }

  /** Phones and windows ≤ 1400 effective px: the secondary top bar buttons (hidden by CSS there) are offered in one menu. */
  topbarMore(anchor) {
    document.querySelector('body > .ctx-menu.tb-menu')?.remove();
    const items = [...document.querySelectorAll('.topbar .live-btn, .topbar .link-btn, .topbar .dvs-btn, .topbar .video-btn, .topbar .light-btn, .topbar .rec-more, .topbar .signout-btn, .topbar .update-badge')]
      .filter((b) => !b.hidden && !b.closest('[hidden]') && b.offsetParent === null) // hidden by the phone layout
      .filter((b) => !(document.documentElement.classList.contains('odj-local') && /dvs-btn|light-btn|video-btn|live-btn|signout-btn/.test(b.className))); // not in the mobile app
    if (!items.length) return;
    const menu = el('div', { class: 'ctx-menu tb-menu', role: 'menu' }, ...items.map((b) => el('div', { class: 'ctx-item', role: 'menuitem', tabindex: 0, onclick: () => { menu.remove(); b.click(); } },
      b.querySelector('.ico')?.cloneNode(true) || '', (b.querySelector('.lbl')?.textContent || b.title || b.textContent).trim())));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect(), z = parseFloat(document.documentElement.style.zoom) || 1;
    menu.style.top = `${r.bottom / z + 4}px`; menu.style.right = '8px';
    const close = (e) => { if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
  }

  /** Small screens: show deck i (the others stay loaded and playing, just hidden). */
  showDeckTab(i) {
    this.mobileDeck = Math.min(i, this.deckCount - 1);
    this.deckEls.forEach((d, j) => d.classList.toggle('m-hide', j !== this.mobileDeck));
    this.updateDeckTabs();
  }
  updateDeckTabs() {
    [...this.deckTabs.children].forEach((b, j) => {
      const d = this.engine.decks[j];
      b.hidden = j >= this.deckCount;
      b.classList.toggle('active', j === (this.mobileDeck || 0));
      b.classList.toggle('playing', !!d.playing);
      const name = d.track ? d.track.title || '' : '';
      if (b.lastChild.textContent !== name) b.lastChild.textContent = name;
      b.setAttribute('aria-selected', String(j === (this.mobileDeck || 0)));
    });
  }

  buildSamplerBar() {
    const s = this.engine.sampler;
    const bar = el('div', { class: 'sampler-bar' }, el('span', { class: 'sb-title' }, 'SAMPLER'));
    const fileIn = el('input', { type: 'file', accept: 'audio/*', style: { display: 'none' } });
    let target = 0;
    const save = () => this.setSetting('sampler', s.config());
    fileIn.addEventListener('change', async () => { try { await s.loadFile(target, fileIn.files[0]); save(); } catch (e) { this.toast(`Could not load sample: ${e.message}`); } fileIn.value = ''; });
    const pads = s.slots.map((_, i) => {
      const b = el('button', { class: 'spad', 'data-pad': i, title: 'Click: play · Shift-click: stop · Right-click: choose sound, load your own sample, volume, sync to beat' });
      b.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; this.engine.resume(); this.shift ? s.stop(i) : s.trigger(i); });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); this.samplerPadMenu(i, e.clientX, e.clientY, () => { target = i; fileIn.click(); }, save); });
      return b;
    });
    const render = () => {
      pads.forEach((b, i) => {
        const slot = s.slots[i];
        b.textContent = slot?.name || '—';
        b.title = slot?.source ? `${slot.name} — ${slot.creator || 'Source'} · ${slot.license || 'CC0 1.0'} · ${slot.source}` : 'Click: play · Shift-click: stop · Right-click: choose sound, load your own sample, volume, sync to beat';
        b.classList.toggle('synced', !!slot?.sync);
        b.classList.toggle('user', slot && !slot.builtin);
      });
      this.seqPanel?.renderNames?.();
    };
    s.onChange = render;
    render();
    const seqBtn = el('button', { class: 'btn sm seq-btn', title: 'Step sequencer (synced to the master deck)', onclick: () => this.toggleSequencer() }, 'SEQ');
    bar.append(...pads, seqBtn, fileIn);
    return bar;
  }

  /** Sampler pad options: built-in sound bank, own sample, pad volume, start on the next beat. */
  samplerPadMenu(i, x, y, pickFile, save) {
    const s = this.engine.sampler, slot = s.slots[i];
    const vol = Math.round((slot.volume ?? 1) * 100);
    this.dialogs.menu(x, y, [
      { label: 'Built-in sound', sub: s.constructor.bank.map((b) => ({ label: b.name, checked: !!(slot.builtin && slot.sound === b.id), action: async () => { await s.setSound(i, b.id); save(); this.engine.resume(); s.trigger(i); } })) },
      { label: 'Load your own sample…', action: pickFile },
      { label: 'Browse CC0 sound library…', action: () => this.openSamplerCatalog(i, save) },
      { label: `Pad volume (${vol} %)`, sub: [25, 50, 75, 100, 125, 150].map((v) => ({ label: `${v} %`, checked: vol === v, action: () => { s.setPadVolume(i, v / 100); save(); } })) },
      { label: 'Sync to beat (start on the next beat of the master deck)', checked: !!slot.sync, action: () => { s.setPadSync(i, !slot.sync); save(); } },
      '-',
      { label: 'Preview', action: () => { this.engine.resume(); s.trigger(i); } },
    ]);
  }

  /** Browse and download licensed one-shots into the selected sampler pad. */
  openSamplerCatalog(i, save) {
    const sampler = this.engine.sampler;
    const categories = ['All sounds', ...new Set(SAMPLE_CATALOG.map((s) => s.category))];
    const category = el('select', { class: 'sel', 'aria-label': 'Sample category' }, ...categories.map((c) => el('option', { value: c }, c)));
    const search = el('input', { class: 'inp', type: 'search', placeholder: 'Search sounds…', 'aria-label': 'Search sounds' });
    const count = el('span', { class: 'hint' }, SAMPLE_CATALOG.length + ' sounds · CC0 1.0 · downloads only when selected');
    const list = el('div', { class: 'sample-catalog-list', role: 'listbox', 'aria-label': 'Available sounds' });
    let selected = null;
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const matches = SAMPLE_CATALOG.filter((s) => (category.value === 'All sounds' || s.category === category.value)
        && (!q || (s.name + ' ' + s.creator + ' ' + s.category).toLowerCase().includes(q)));
      list.replaceChildren(...matches.map((sound) => {
        const row = el('button', { type: 'button', class: 'sample-catalog-item' + (selected?.id === sound.id ? ' selected' : ''), role: 'option', 'aria-selected': String(selected?.id === sound.id), title: sound.source },
          el('span', { class: 'sample-catalog-name' }, sound.name),
          el('span', { class: 'sample-catalog-credit' }, sound.category + ' · ' + sound.creator + ' · CC0'));
        row.addEventListener('click', () => { selected = sound; render(); });
        return row;
      }));
      if (!matches.length) list.append(el('div', { class: 'hint' }, 'No sounds match your search.'));
      count.textContent = matches.length + ' of ' + SAMPLE_CATALOG.length + ' sounds · CC0 1.0';
    };
    category.addEventListener('change', render); search.addEventListener('input', render); render();
    const body = el('div', { class: 'sample-catalog-body' },
      el('p', { class: 'hint' }, 'Curated from Sonic Pi’s CC0 collection. Every file is downloaded from a pinned source only after you choose it; creator and source details are saved with the pad.'),
      el('div', { class: 'sample-catalog-filters' }, category, search), count, list);
    this.dialogs.modal('CC0 sound library', body, [
      { label: 'Cancel', value: null },
      { label: 'Download to pad ' + (i + 1), primary: true, action: async () => {
        if (!selected) { this.toast('Choose a sound first'); return false; }
        try {
          this.toast('Downloading ' + selected.name + '…');
          const r = await sampler.loadCatalogSample(i, selected); save(); this.engine.resume(); sampler.trigger(i);
          this.toast(selected.name + ' loaded to pad ' + (i + 1) + (r?.saved === false && !r.superseded ? ' (for this session only: the browser did not allow saving it)' : ''));
        } catch (e) { this.toast('Could not download sample: ' + e.message); return false; }
      } },
    ], { wide: true, cls: 'sample-catalog-modal' });
  }

  toggleSequencer() {
    if (this.seqPanel) { this.seqPanel.remove(); this.seqPanel = null; return; }
    const seq = this.sequencer, sampler = this.engine.sampler;
    const cells = [];
    const grid = el('div', { class: 'seq-grid' });
    const names = [];
    for (let r = 0; r < seq.rows; r++) {
      const name = el('button', { class: 'seq-name', title: 'Click: mute row', onclick: () => { seq.mute[r] = !seq.mute[r]; name.classList.toggle('muted', seq.mute[r]); } });
      names.push(name);
      const row = el('div', { class: 'seq-row' }, name);
      cells[r] = [];
      for (let c = 0; c < seq.steps; c++) {
        const cell = el('button', { class: `seq-cell ${c % 4 === 0 ? 'beat' : ''}`, onclick: () => { seq.toggle(r, c); } });
        cells[r][c] = cell; row.append(cell);
      }
      grid.append(row);
    }
    const paint = () => { for (let r = 0; r < seq.rows; r++) for (let c = 0; c < seq.steps; c++) cells[r][c].classList.toggle('on', !!seq.pattern[r][c]); };
    const playBtn = el('button', { class: 'btn sm', onclick: () => (seq.running ? seq.stop() : (this.engine.resume(), seq.start())) }, 'PLAY');
    const bpmIn = el('input', { class: 'inp seq-bpm', type: 'number', min: 60, max: 200, value: seq.bpm, title: 'Tempo when no deck is playing' });
    bpmIn.addEventListener('change', () => { seq.bpm = Number(bpmIn.value) || 120; });
    const swing = el('input', { type: 'range', min: 0, max: 0.6, step: 0.05, value: seq.swing, title: 'Swing' });
    swing.addEventListener('input', () => { seq.swing = Number(swing.value); seq.save(); });
    const panel = el('div', { class: 'seq-panel' },
      el('div', { class: 'seq-head' }, el('b', {}, 'SEQUENCER'), playBtn, el('span', { class: 'hint' }, 'Follows the master deck tempo & beat grid · free BPM'), bpmIn, el('span', { class: 'hint' }, 'Swing'), swing,
        el('button', { class: 'btn sm', onclick: () => seq.clear() }, 'Clear'), el('button', { class: 'btn sm icon-only', title: 'Close', 'aria-label': 'Close', onclick: () => this.toggleSequencer() }, icon('x'))),
      grid);
    panel.renderNames = () => names.forEach((n, r) => { n.textContent = sampler.slots[r]?.name || '—'; });
    panel.renderNames(); paint();
    const offP = seq.on('pattern', paint);
    const offS = seq.on('state', () => playBtn.classList.toggle('active', seq.running));
    const offStep = seq.on('step', (k) => { grid.querySelectorAll('.seq-cell.now').forEach((x) => x.classList.remove('now')); for (let r = 0; r < seq.rows; r++) cells[r][k].classList.add('now'); });
    playBtn.classList.toggle('active', seq.running);
    const origRemove = panel.remove.bind(panel);
    panel.remove = () => { offP(); offS(); offStep(); origRemove(); };
    const onEsc = (e) => { if (e.key === 'Escape' && !document.querySelector('.overlay')) { e.preventDefault(); this.toggleSequencer(); } };
    document.addEventListener('keydown', onEsc);
    const rm = panel.remove; panel.remove = () => { document.removeEventListener('keydown', onEsc); rm(); };
    document.body.append(panel);
    this.seqPanel = panel;
  }

  async toggleMic() {
    try { await this.engine.setMic(!this.engine.micOn); this.toast(this.engine.micOn ? 'Microphone on' : 'Microphone off'); }
    catch (e) { this.toast(`Microphone: ${e.message}`); }
  }

  async setDeckCount(n, save = true) {
    n = Number(n) === 4 ? 4 : 2;
    // decks that would be hidden must not keep playing without any visible controls
    const hiddenPlaying = this.engine.decks.slice(n).filter((d) => d.playing);
    if (hiddenPlaying.length) {
      if (!(await this.dialogs.confirm(`Deck ${hiddenPlaying.map((d) => d.index + 1).join(' & ')} ${hiddenPlaying.length > 1 ? 'are' : 'is'} playing. Stop ${hiddenPlaying.length > 1 ? 'them' : 'it'} and switch to ${n} decks?`))) return;
      for (const d of hiddenPlaying) d.pause();
    }
    this.deckCount = n;
    document.body.classList.toggle('four-decks', n === 4);
    this.deckEls.forEach((d, i) => { d.style.display = i < n ? '' : 'none'; });
    this.waves.forEach((w, i) => { w.style.display = i < n ? '' : 'none'; });
    // Disconnect unloaded hidden decks (3 & 4 in 2-deck mode) from the Web Audio graph so they cost 0 idle DSP
    this.engine.channels.forEach((ch, i) => {
      const d = this.engine.decks[i];
      ch?.setActive?.(i < n || !!d?.track || !!d?.playing);
    });
    this.mixer.setDeckCount(n);
    this.renderLayoutSel();
    this.showDeckTab(this.mobileDeck || 0);
    if (save) this.setSetting('deckCount', n);
  }

  /** 2-deck view: classic | performance | waveform (body.layout-*). Switching to it from 4 decks goes back to 2. */
  async setLayout(mode, save = true, keepDecks = false) {
    mode = ['classic', 'performance', 'waveform'].includes(mode) ? mode : 'classic';
    if (this.deckCount === 4 && !keepDecks) { await this.setDeckCount(2, save); if (this.deckCount === 4) return; }
    this.layoutMode = mode;
    for (const m of ['classic', 'performance', 'waveform']) document.body.classList.toggle(`layout-${m}`, m === mode);
    this.renderLayoutSel();
    if (save && this.settings.layoutMode !== mode) this.setSetting('layoutMode', mode);
  }
  renderLayoutSel() {
    const cur = this.deckCount === 4 ? 'four' : (this.layoutMode || 'classic');
    for (const b of this.deckSel.children) { const on = b.dataset.layout === cur; b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); }
  }

  // ---------------- automix / record ----------------
  /** The tracks AUTOMIX starts from: what is left in the automix queue, else the library view (playlist, crate…). */
  automixSource() {
    const a = this.automix;
    return a.queue.length > a.idx ? { tracks: a.queue.slice(a.idx), from: 'queue' } : { tracks: this.library?.rows || [], from: 'view' };
  }
  /** AUTOMIX button / key A / MIDI automix.toggle: start at once, or stop; { dialog: true } opens the options dialog. */
  toggleAutomix({ dialog = false } = {}) {
    // pressed again while a start is still analysing / loading the first track: cancel it
    if (this._amStarting) { this._amStarting.cancelled = true; this.automix.stop(); this.toast('Automix cancelled'); return; }
    if (this.automix.enabled) { this.automix.stop(); this.toast('Automix stopped'); return; }
    if (dialog) { this.dialogs.automixQueue(this.automixSource().tracks); return; }
    return this.automixStart();
  }

  /** MC announcement (e.g. the Local AI intro): spoken over the mix at the next phrase, music ducked. */
  announce(text, { lang = 'en', overlay = false } = {}) {
    try { return this.dedications.add(text, { lang, overlay, meta: false, from: 'announce' }); } catch (e) { this.toast(e.message); return null; }
  }
  /** Queue a live dedication (UI, MCP). */
  queueDedication(text, opts = {}) { return this.dedications.add(text, opts); }

  /**
   * Deck MIX NOW. In an Automix set: start the queued transition now (waits for the next deck's preload if needed).
   * With Automix off: mix from this deck into the track loaded on the other one (AutoMix.mixOnce).
   */
  async mixNow(i = this.automix.current?.index) {
    if (!this.automix.enabled) {
      const deck = this.engine.decks[i];
      const r = await this.automix.mixOnce(deck);
      this.toast(r === 'started' ? `Mixing deck ${deck.index + 1} into deck ${this.automix.other(deck).index + 1}` : r);
      return;
    }
    const result = this.automix.skip();
    if (result === 'started') this.toast('Transition started');
    else if (result === 'preparing') this.toast('Preparing the next track; transition will start as soon as it is ready');
    else if (this.automix.transition) this.toast('A transition is already in progress');
    else this.toast(this.automix.nextTrack() ? 'Could not start the transition yet' : 'No upcoming track queued');
  }
  /**
   * One-click start with the saved preferences: a smart mix of the remaining queue, else of the library view
   * (playlist, crate, search…); shuffled when "shuffle" is the saved preference. Tracks already loaded on decks 1 / 2
   * play first (AutoMix.start). The saved set length (settings.automix.setLength) applies: whole list, timed, endless.
   */
  async automixStart() { return this.automixFrom({ kind: 'view' }); }

  /**
   * AI stems for the automix set, in play order (Automix dialog "Prepare AI stems for the whole set now"): the tracks
   * still to come that have none yet, at most `max` (an endless set adds more as it goes, see the automix 'state'
   * hook in stems-ui.js, which prepares the next two).
   */
  async prepareSetStems(max = 200) {
    const a = this.automix, lib = this.library;
    const ids = a.queue.slice(Math.max(0, a.idx - 1)).map((t) => t?.id).filter((id) => id && !lib?.track(id)?.stems?.ready).slice(0, max);
    if (!ids.length) { this.toast('Every track in the set already has AI stems'); return 0; }
    try {
      const n = await this.stems.enqueue(ids, { interactive: true });
      if (n) this.toast(`AI stems: ${n} track${n > 1 ? 's' : ''} of the set queued, in play order`);
      return n;
    } catch (e) { this.toast(`⚠ ${e.message}`); return 0; }
  }

  /** What the automix sources read: library view, queue, all tracks, playlists. */
  automixCtx() {
    const lib = this.library, a = this.automix;
    return { view: lib?.rows || [], queue: a.queue.slice(a.idx), tracks: [...(lib?.tracks?.values?.() || [])], playlists: lib?.playlists || [], track: (id) => lib?.track?.(id) };
  }

  /**
   * Start automix on a source ({ kind: 'view' | 'library' | 'playlist' | 'genres', … }, see automix-sources.js) with
   * the saved preferences, or the given mode ('shuffle' | 'smart' | 'order' | 'live') and length ('all' | minutes |
   * 'endless').
   */
  async automixFrom(source, { mode, length } = {}) {
    const { tracks, title } = sourceTracks(source, this.automixCtx());
    const onDecks = this.engine.decks.slice(0, 2).some((d) => d.track);
    if (!tracks.length && !onDecks) {
      this.toast(source.kind === 'view' ? 'No tracks in this view: open a playlist or add music, or use the ▾ menu next to AUTOMIX' : `No tracks in ${title}`);
      return;
    }
    const opts = this.settings.automix || {};
    mode ||= opts.shuffle ? 'shuffle' : 'smart';
    const lo = lengthOptions(length || opts.setLength || 'all');
    // a smart order over a whole big library would block the UI: order 40, and endless / timed sets add more as they go
    const limit = (mode === 'smart' || mode === 'live') && tracks.length > 200 ? 40 : undefined;
    // the deck tracks alone (empty view): keep mixing from the whole library
    const list = tracks.length ? tracks : this.automixCtx().tracks;
    await this.startAutomix(list, { mode, shape: opts.shape, sliders: opts.sliders, limit, pool: list, ...lo });
  }

  /** The ▾ menu next to AUTOMIX: what to mix (library, playlist, genres, this view) and for how long. */
  automixMenu(anchor) {
    document.querySelector('body > .ctx-menu.am-menu')?.remove();
    const running = this.automix.enabled || !!this._amStarting;
    const go = (source, o = {}) => () => { if (running) { this.automix.stop(); this._amStarting && (this._amStarting.cancelled = true); } this.automixFrom(source, o); };
    const saved = this.settings.automix?.setLength || 'all';
    const lengthLabel = (SET_LENGTHS.find(([v]) => v === saved) || SET_LENGTHS[0])[1];
    const items = [
      ['Shuffle the whole library · endless', go({ kind: 'library' }, { mode: 'shuffle', length: 'endless' })],
      ['Smart mix the whole library · endless', go({ kind: 'library' }, { mode: 'smart', length: 'endless' })],
      ['Endless mix of this view', go({ kind: 'view' }, { length: 'endless' })],
      ['1 hour mix of this view', go({ kind: 'view' }, { length: '60' })],
      null,
      ['Mix a playlist…', () => this.dialogs.automixQueue(null, { source: 'playlist' })],
      ['Mix genres…', () => this.dialogs.automixQueue(null, { source: 'genres' })],
      ['All automix options…', () => this.dialogs.automixQueue(this.automixSource().tracks)],
      null,
      ...SET_LENGTHS.map(([v, l]) => [`${v === saved ? '✓ ' : ''}AUTOMIX button plays: ${l}`, () => { this.setSetting('automix', { ...this.settings.automix, setLength: v }); this.toast(`AUTOMIX now plays: ${l}`); }]),
    ];
    if (running) items.unshift(['Stop automix', () => this.toggleAutomix()], null);
    const menu = el('div', { class: 'ctx-menu am-menu', role: 'menu', 'aria-label': `Automix (button plays: ${lengthLabel})` },
      ...items.map((it) => (it ? el('div', { class: 'ctx-item', role: 'menuitem', tabindex: 0, onclick: () => { menu.remove(); it[1](); }, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); menu.remove(); it[1](); } } }, it[0]) : el('div', { class: 'ctx-sep' }))));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect(), z = parseFloat(document.documentElement.style.zoom) || 1;
    menu.style.top = `${r.bottom / z + 4}px`; menu.style.left = `${Math.max(8, r.left / z)}px`;
    menu.querySelector('.ctx-item')?.focus({ preventScroll: true });
    const close = (e) => { if (e.type === 'keydown' ? e.key === 'Escape' : !menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', close, true); } };
    setTimeout(() => { document.addEventListener('pointerdown', close, true); document.addEventListener('keydown', close, true); });
  }
  queueAdd(tracks, { next = false } = {}) {
    next = next || this.shift; // Shift = play next
    if (!this.automix.enabled) { const rest = this.automix.queue.slice(this.automix.idx); this.automix.queue = next ? [...tracks, ...rest] : [...rest, ...tracks]; this.automix.idx = 0; }
    else if (next) this.automix.insertNext(tracks);
    else this.automix.queue.push(...tracks);
    this.toast(next ? `${tracks.length} track(s) will play next in automix` : `${tracks.length} track(s) queued for automix`);
    this.updateAutomixUi();
  }
  /** MIX NOW on deck i: { available, title } (in an Automix set, or with Automix off: AutoMix.mixOnceBlocked). */
  mixNowState(i) {
    const a = this.automix, next = a.nextTrack?.();
    if (!a.enabled) {
      const deck = this.engine.decks[i], why = a.mixOnceBlocked?.(deck);
      return why ? { available: false, title: `MIX NOW: ${why}` } : { available: true, title: `Mix into "${a.other(deck).track.title}" on deck ${a.other(deck).index + 1} now` };
    }
    const available = a.current?.index === i && !a.transition && !!next;
    return { available, title: available ? 'Start transition to ' + next.title + ' now' : a.transition ? 'A transition is already in progress' : !next ? 'No upcoming track queued' : 'Available on the active Automix deck' };
  }
  updateAutomixUi() {
    const a = this.automix;
    this.amBtn.classList.toggle('active', a.enabled);
    const next = a.nextTrack();
    this.amSkip.disabled = !a.enabled || !!a.transition || !next;
    for (const [i, deck] of (this.deckEls || []).entries()) {
      const mixButton = deck.querySelector('.deck-mix-now');
      if (!mixButton) continue;
      const { available, title } = this.mixNowState(i);
      mixButton.disabled = !available; mixButton.title = title;
    }
    let info = '';
    if (a.enabled) {
      if (a.transition) info = `Mixing: ${STYLE_LABEL[a.transition.style] || a.transition.style}`;
      else if (next) {
        const nt = a.nextTransition();
        info = `Next: ${next.artist ? next.artist + ' – ' : ''}${next.title}${nt ? ` · ${STYLE_LABEL[nt.style] || nt.style} in ${fmtTime(nt.beginsIn).slice(0, 5)}` : ''}`;
      } else info = 'Last track';
    } else if (a.queue.length) info = `${a.queue.length - a.idx} queued`;
    info = t(info); // translated before the comparison, so the DOM translator does not rewrite it every tick
    if (this.amInfo.textContent !== info) this.amInfo.textContent = info;
    this.queuePanel?.render?.();
  }

  /**
   * Start automix on tracks (mode: 'order' | 'shuffle' | 'smart' | 'live'). Smart modes first analyse tracks that
   * have no analysis yet (remote tracks included) for a short while, then score with whatever data there is.
   */
  async startAutomix(tracks, opts = {}) {
    // one start at a time: repeated AUTOMIX / MIX NOW presses during the analysis wait used to start several
    if (this._amStarting) { this.toast('Automix is starting…'); return; }
    const run = this._amStarting = { cancelled: false };
    try { await this._startAutomix(tracks, opts, run); } finally { if (this._amStarting === run) this._amStarting = null; }
  }
  async _startAutomix(tracks, opts, run) {
    let list = tracks.filter(Boolean);
    if (opts.mode === 'smart' || opts.mode === 'live') {
      const todo = list.filter((t) => !t.analyzed && !t.unreadable);
      if (todo.length && this.analyser) {
        const hasRemote = todo.some((t) => t.sourceType === 'remote' && !t.localPath);
        const batch = todo.slice(0, hasRemote ? 12 : 24);
        const n = this.analyser.request(batch, { auto: true });
        if (n) {
          this.toast(`Analysing ${n} track(s) before smart mix (BPM, key, energy)…`);
          const t0 = performance.now(), maxMs = Math.min(45000, 4000 + n * 3000);
          while (!run.cancelled && performance.now() - t0 < maxMs && batch.some((t) => { const f = this.library.track(t.id); return f && !f.analyzed && !f.unreadable; }) && this.analyser.running) await new Promise((r) => setTimeout(r, 300));
          const left = batch.filter((t) => !this.library.track(t.id)?.analyzed).length;
          if (left) this.toast(`${left} track(s) not analysed yet: smart mix uses the data it has for them`);
        }
      }
      list = list.map((t) => this.library.track(t.id) || t); // analysed copies
    }
    if (run.cancelled) return;
    try { await this.automix.start(list, opts); } catch (e) { this.toast(e.message); }
  }

  /** Automix queue: what plays next, with which transition style (overridable per transition) and why. */
  toggleQueuePanel() {
    if (this.queuePanel) { this.queuePanel.off?.(); this.queuePanel.remove(); this.queuePanel = null; return; }
    const a = this.automix;
    const list = el('ol', { class: 'am-queue' });
    const head = el('div', { class: 'am-queue-next' });
    let lastKey = '';
    const styleSelect = (i) => {
      const t = a.queue[i], ov = a.overrides.get(t);
      const s = el('select', { class: 'sel sm', 'data-q': i, title: 'Transition style into this track' },
        el('option', { value: 'default' }, `Default (${STYLE_LABEL[a.opts.style === 'auto' ? 'auto' : a.opts.style] || STYLE_LABEL[{ phrase: 'blend', eqswap: 'bassswap' }[a.opts.style]] || a.opts.style})`),
        ...STYLES.map(([v, l]) => el('option', { value: v }, l)));
      s.value = ov || 'default';
      s.addEventListener('change', () => a.setOverride(i, s.value));
      return s;
    };
    // drag a row onto another to reorder; Alt+↑/↓ on a focused row does the same from the keyboard
    let dragFrom = -1;
    const moveTo = (from, to) => {
      if (to < a.idx || to >= a.queue.length) return;
      a.move(from, to);
      requestAnimationFrame(() => list.querySelector(`[data-i="${to}"]`)?.focus());
    };
    const shuffleBtn = el('button', { class: 'btn sm', title: 'Shuffle the upcoming tracks (random order, still beat-matched)', onclick: () => {
      const n = a.shuffleRemaining();
      this.toast(n ? `Shuffled ${n} upcoming track(s)` : a.live && a.enabled ? 'Live smart mix picks each next track itself: nothing to shuffle' : 'Nothing to shuffle');
    } }, icon('shuffle'), 'Shuffle');
    // chosen transition length: "16 bars (auto: 16-bar outro, 32-bar intro)"; drop styles: where the drop lands
    const lengthText = (len, style) => {
      if (!len || !style) return '';
      const bars = t(len.bars === 1 ? '{n} bar' : '{n} bars', { n: len.bars });
      const what = DROP_STYLES.has(style) ? t('drop after {bars} of outro', { bars }) : bars;
      return len.auto ? (len.why ? t('{what} (auto: {why})', { what, why: len.why }) : t('{what} (auto)', { what })) : what;
    };
    const preview = buildPreviewBox(this);
    const render = () => {
      try { preview.render(); } catch (e) { console.warn('[automix] preview', e); }
      shuffleBtn.disabled = (!!a.live && a.enabled) || a.queue.length - a.idx < 2;
      const nt = a.enabled ? a.nextTransition() : null;
      const key = `${a.enabled}|${a.idx}|${a.queue.length}|${a.queue.slice(a.idx, a.idx + 50).map((t) => t.id).join()}|${[...a.overrides.values()].join()}|${a.opts.style}|${a.opts.lengthMode}|${a.opts.transitionBeats}|${!!a.transition}|${nt?.length?.bars}|${nt?.length?.why}`;
      const trLen = a.transition?.length ? `, ${lengthText(a.transition.length, a.transition.style)}` : '';
      head.textContent = !a.enabled ? 'Automix is off' : a.transition ? `Mixing now: ${STYLE_LABEL[a.transition.style]}${trLen}${a.transition.why ? ` (${a.transition.why})` : ''}`
        : nt ? `Next transition: ${STYLE_LABEL[nt.style]}, ${lengthText(nt.length, nt.style)} in ${fmtTime(nt.beginsIn).slice(0, 5)} — ${nt.why}` : 'No next track';
      if (key === lastKey) return;
      lastKey = key;
      const rows = [];
      for (let i = a.idx; i < Math.min(a.queue.length, a.idx + 50); i++) {
        const t = a.queue[i], st = a.styleFor(i, i === a.idx ? (a.current?.track && this.library.track(a.current.track.id)) || a.current?.track : null);
        const len = i === a.idx && nt ? nt.length : i > 0 ? a.lengthForQueue(i, st?.style) : null;
        const lenText = lengthText(len, st?.style);
        const name = `${t.artist ? t.artist + ' – ' : ''}${t.title}`;
        const li = el('li', { class: 'am-q-item', 'data-id': t.id, 'data-i': i, draggable: 'true', tabindex: '0', title: `${name}\nDrag to reorder (or Alt+↑/↓)` },
          el('div', { class: 'am-q-title' }, name),
          el('div', { class: 'am-q-meta' }, styleSelect(i), el('span', { class: 'hint' }, ` ${STYLE_LABEL[st?.style] || ''}${st?.why && /too far/.test(st.why) ? ` (${st.why.split('; ').pop()})` : ''}${lenText ? ` · ${lenText}` : ''}${a.reasons.get(t) ? ` · ${a.reasons.get(t)}` : ''}`)),
          el('div', { class: 'am-q-acts' },
            i > a.idx ? el('button', { class: 'btn xs icon-only', title: 'Play next', 'aria-label': 'Play next', onclick: () => a.move(i, a.idx) }, icon('chevron-up')) : null,
            el('button', { class: 'btn xs icon-only', title: 'Remove from the queue', 'aria-label': 'Remove from the queue', onclick: () => a.remove(i) }, icon('x'))));
        li.addEventListener('dragstart', (e) => { if (e.target.closest('select, button')) { e.preventDefault(); return; } dragFrom = i; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
        li.addEventListener('dragend', () => { dragFrom = -1; li.classList.remove('dragging'); });
        li.addEventListener('dragover', (e) => { if (dragFrom < 0) return; e.preventDefault(); li.classList.add('drag-over'); });
        li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
        li.addEventListener('drop', (e) => { if (dragFrom < 0) return; e.preventDefault(); li.classList.remove('drag-over'); const from = dragFrom; dragFrom = -1; if (from !== i) a.move(from, i); });
        li.addEventListener('keydown', (e) => {
          if (e.target !== li || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
          e.preventDefault(); e.stopPropagation();
          moveTo(i, i + (e.key === 'ArrowUp' ? -1 : 1));
        });
        rows.push(li);
      }
      list.replaceChildren(...rows);
      if (!rows.length) list.append(el('li', { class: 'hint' }, 'Nothing queued. Right-click tracks → Add to automix queue, or start automix on a playlist.'));
    };
    const panel = el('div', { class: 'am-queue-panel seq-panel', role: 'dialog', 'aria-label': 'Automix queue' },
      el('div', { class: 'seq-head' }, el('b', {}, 'AUTOMIX QUEUE'),
        el('button', { class: 'btn sm', onclick: () => a.skip(), title: 'Mix to the next track now' }, 'Mix now'),
        shuffleBtn,
        el('button', { class: 'btn sm icon-only', title: 'Close', 'aria-label': 'Close', onclick: () => this.toggleQueuePanel() }, icon('x'))),
      head, preview.el, list);
    panel.render = render;
    // Escape closes the panel (unless a dialog or menu on top of it gets the key)
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.overlay, .ctx-menu')) this.toggleQueuePanel(); };
    document.addEventListener('keydown', onKey);
    panel.off = () => document.removeEventListener('keydown', onKey);
    render();
    document.body.append(panel);
    this.queuePanel = panel;
  }

  toggleRecord() { return this.recording.toggle(); }


  /** Pad FX mode actions */
  padFx(deck, fx, down) {
    const ch = this.engine.channels[deck.index];
    switch (fx) {
      // amounts from the deck's Vinyl panel (defaults 1.2 s brake, 3 s tape stop, 1 s / 4.5x spin back)
      case 'brake': if (down) deck.brake(deck.vinyl?.brakeTime || 1.2); break;
      case 'tapeStop': if (down) deck.brake((deck.vinyl?.brakeTime || 1.2) * 2.5); break;
      case 'backspin': if (down) deck.backspin(); break;
      case 'censor': down ? deck.censorOn() : deck.censorOff(); break;
      case 'roll1': down ? deck.rollOn(1 / 4) : deck.rollOff(); break;
      case 'roll2': down ? deck.rollOn(1 / 8) : deck.rollOff(); break;
      case 'echoOut':
        if (!down) break;
      {
        // the user's beat FX settings come back once the echo tail has died away (unless they took the FX over)
        const saved = this._echoOutSaved || { fxType: ch.state.fxType, fxBeats: ch.state.fxBeats, fxParam: ch.state.fxParam, fxMix: ch.state.fxMix, fxOn: ch.state.fxOn };
        this._echoOutSaved = saved;
        ch.set('fxType', 'echo'); ch.set('fxBeats', 0.75); ch.set('fxParam', 0.8); ch.set('fxMix', 0.7); ch.set('fxOn', true);
        const ours = () => ch.state.fxType === 'echo' && ch.state.fxBeats === 0.75 && ch.state.fxMix === 0.7;
        setTimeout(() => { if (ours()) ch.set('fxOn', false); deck.pause(); }, deck.beatLen * 1000);
        clearTimeout(this._echoOutT);
        this._echoOutT = setTimeout(() => {
          this._echoOutSaved = null;
          if (!ours() || ch.state.fxOn) return; // changed meanwhile: leave the user's new settings alone
          for (const k of ['fxType', 'fxBeats', 'fxParam', 'fxMix']) ch.set(k, saved[k]);
          if (saved.fxOn) ch.set('fxOn', true);
        }, deck.beatLen * 8000);
      }
        break;
      case 'filterSweep': {
        clearInterval(ch._sweep);
        const target = down ? 0.75 : 0; const from = ch.state.filter; const t0 = performance.now(); const dur = down ? deck.beatLen * 8000 : 150;
        ch._sweep = setInterval(() => { const k = Math.min(1, (performance.now() - t0) / dur); ch.set('filter', from + (target - from) * k); if (k >= 1) clearInterval(ch._sweep); }, 16);
        break;
      }
    }
  }

  // ---------------- events / input ----------------
  wireEvents() {
    let refreshT, scanDone = false;
    api.events({
      library: (ev) => {
        // Single-track updates (analysis, play counts, tags, cues, stems, downloads) patch in O(1) without reloading the full library.
        if (ev?.track?.id) { this.library.updateTrack(ev.track); return; }
        // While tracks are being analysed every one of them changes the library: refresh at most every 4 s then (8 s while playing).
        if (this.analyser.running && refreshT) return;
        clearTimeout(refreshT);
        refreshT = setTimeout(async () => { refreshT = null; await this.library.refresh(); this.analyser.autoQueue({ afterScan: scanDone }); scanDone = false; }, this.analyser.running ? (this.engine.decks.some((d) => d.playing) ? 8000 : 4000) : 600);
      },
      scan: (p) => { this.library.setJobStatus(p.done ? '' : `Scanning… ${p.scanned} files`); if (p.done) scanDone = true; },
      sync: (p) => this.library.setJobStatus(p.finished ? '' : `Syncing media server… ${p.done}${p.total ? '/' + p.total : ''}`),
      downloads: (d) => this.library.setDownloads(d),
      lyrics: (e) => this.lyrics?.invalidate(e.trackId),
      'job-error': (e) => { this.library.setJobStatus(''); this.toast(`⚠ ${e.message}`); },
      // AI stems prepared by the server (its queue, finished / failed tracks, stems added or removed)
      'stems-queue': (e) => this.stems?.serverEvent('stems-queue', e),
      'stems-done': (e) => this.stems?.serverEvent('stems-done', e),
      'stems-failed': (e) => this.stems?.serverEvent('stems-failed', e),
      stems: (e) => this.stems?.serverEvent('stems', e),
    });
    this.engine.on('track-updated', (t) => this.library.updateTrack(t));
    this.analyser.on('progress', (st) => this.library.setAnalysisStatus(st));
    let unreadable = [];
    this.analyser.on('unreadable', (t) => unreadable.push(t.title || t.path));
    this.analyser.on('idle', () => {
      if (unreadable.length) this.toast(`⚠ ${unreadable.length === 1 ? `"${unreadable[0]}" could not be decoded` : `${unreadable.length} files could not be decoded (${unreadable.slice(0, 3).map((x) => `"${x}"`).join(', ')}${unreadable.length > 3 ? '…' : ''})`}: marked ⚠ in the library`);
      unreadable = [];
      this.library.applyView(); // views that depend on analysis (bpm:, smart playlists) are complete now
    });
    this.engine.on('warning', (m) => this.toast(`⚠ ${m}`));
    this.engine.on('recording', (on) => this.recBtn.classList.toggle('active', on));
    this.engine.on('master-deck', () => this.library.renderRows(true));
    this.automix.on('state', () => {
      this.updateAutomixUi();
      // the library's "now playing / queued" marks: one re-render per burst of state changes (a transition emits several)
      if (!this._amRows) this._amRows = setTimeout(() => { this._amRows = null; this.library.renderRows(true); }, 200);
    });
    this.automix.on('ending', () => this.toast('Automix: last track playing'));
    for (const d of this.engine.decks) d.on('ended', () => { if (!this.automix.enabled) d.emit('state'); });

    const keyDeck = { z: [0, 'cue'], x: [0, 'play'], c: [0, 'sync'], m: [1, 'cue'], ',': [1, 'play'], '.': [1, 'sync'], q: [0, 'loop'], w: [0, 'exit'], o: [1, 'loop'], p: [1, 'exit'] };
    const hot = { 1: [0, 0], 2: [0, 1], 3: [0, 2], 4: [0, 3], 7: [1, 0], 8: [1, 1], 9: [1, 2], 0: [1, 3] };
    const typing = (e) => /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.target.isContentEditable;
    // shortcuts are off while a dialog/menu is open or another control already handled the key
    const blocked = (e) => typing(e) || e.defaultPrevented || !!document.querySelector('.overlay, .ctx-menu');
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') { this._shiftKey = true; this.shift = true; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); this.library.search.focus(); return; }
      if (blocked(e) || e.repeat || e.ctrlKey || e.metaKey) return;
      const k = e.key.toLowerCase(), E = this.engine;
      E.resume();
      if (k === ' ') { e.preventDefault(); E.decks[0].togglePlay(); }
      else if (keyDeck[k]) {
        const [di, act] = keyDeck[k]; const d = E.decks[di];
        if (act === 'cue') d.cueDown(); else if (act === 'play') d.togglePlay(); else if (act === 'sync') d.sync(); else if (act === 'loop') d.autoLoop(4); else d.exitLoop();
      } else if (hot[e.code?.replace('Digit', '')] && /^Digit/.test(e.code)) {
        const [di, n] = hot[e.code.replace('Digit', '')]; const d = E.decks[di];
        this.shift ? d.deleteHotCue(n) : d.hotCueDown(n);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        if (this.shift) this.library.loadSelected(e.key === 'ArrowLeft' ? 0 : 1);
        else { E.setCrossfader(E.crossfader + (e.key === 'ArrowLeft' ? -0.1 : 0.1)); this.mixer.renderAll(); }
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); this.library.moveSelection(e.key === 'ArrowDown' ? 1 : -1); }
      else if (k === 'r') this.toggleRecord();
      else if (k === 'a') this.toggleAutomix();
    });
    // releasing keys while the window is in the background never reaches us: reset held state on blur
    window.addEventListener('blur', () => {
      this._shiftKey = false; this.shift = false;
      for (const d of this.engine.decks) { d.cueUp(); for (let n = 0; n < 8; n++) if (d.hotPreview === n) d.hotCueUp(n); }
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') { this._shiftKey = false; this.shift = false; }
      if (typing(e)) return;
      const k = e.key.toLowerCase();
      if (keyDeck[k]?.[1] === 'cue') this.engine.decks[keyDeck[k][0]].cueUp();
      if (/^Digit/.test(e.code) && hot[e.code.replace('Digit', '')]) { const [di, n] = hot[e.code.replace('Digit', '')]; this.engine.decks[di].hotCueUp(n); }
    });
    window.addEventListener('beforeunload', (e) => { if (this.engine.decks.some((d) => d.playing) || this.engine.recording || this.recording?.broadcaster?.live) { e.preventDefault(); e.returnValue = ''; } });
    // Wake full frame rate immediately on any pointer/keyboard input
    this._lastInputAt = performance.now();
    const bumpInput = () => { this._lastInputAt = performance.now(); };
    window.addEventListener('pointerdown', bumpInput, { passive: true });
    window.addEventListener('pointermove', bumpInput, { passive: true });
    window.addEventListener('keydown', bumpInput, { passive: true });
    window.addEventListener('wheel', bumpInput, { passive: true });
  }

  frame(now) {
    if (document.hidden) return; // hidden/minimized window: skip all canvas/DOM repaints (audio & automix keep running)
    const active = this.engine.decks.some((d) => d.playing || d.scratching || d.loading)
      || this.engine.recording || this.engine.micOn || this.automix?.enabled
      || (now - (this._lastInputAt || 0) < 1500);
    // Cap active repaints to ~60 fps (prevents 144-240 Hz monitors from burning 2-4x GPU/CPU), and idle to ~12 fps
    const minFrameMs = active ? 15.5 : 80;
    if (this._lastFrame && now - this._lastFrame < minFrameMs) return;
    this._lastFrame = now;
    for (let i = 0; i < this.deckCount; i++) { this.waves[i].wf.draw(now); this.deckEls[i].frame(now); }
    this.mixer.frame(now);
    if (!this._slow || now - this._slow > 250) {
      this._slow = now;
      const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
      if (!this._clockAt || now - this._clockAt >= 1000) {
        this._clockAt = now;
        setText(this.clock, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      }
      setText(this.recTime, this.engine.recording ? fmtTime((Date.now() - this.engine.recStarted) / 1000).slice(0, 5) : '');
      this.midiDot.classList.toggle('active', now - this.midi.activity < 150);
      const devs = this.midi.devices?.() || this.midi.inputs();
      const connected = devs.length > 0;
      this.midiDot.classList.toggle('connected', connected);
      if (devs.length !== this._midiCount) {
        this._midiCount = devs.length;
        this.midiDot.title = this.midi.inputs().map((i) => i.name).join(', ') || 'No MIDI controller';
      }
      this.updateAutomixUi();
      this.updateDeckTabs();
    }
  }
}

setupClientLog(); // page errors into the app log (Settings → About → Logs)
const app = new App();
window.opendj = app;
app.init().catch((e) => {
  console.error(e);
  const b = document.getElementById('boot');
  if (b) b.textContent = t('OpenDJ failed to start: {msg}', { msg: e.message });
});
