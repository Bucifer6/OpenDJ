import { el, fmtTime } from './util.js';
import { api } from './api.js';
import { Engine } from './audio/engine.js';
import { buildDeck, DECK_COLORS } from './ui/deck-ui.js';
import { buildMixer } from './ui/mixer-ui.js';
import { DetailWaveform } from './ui/waveform.js';
import { LibraryUI } from './ui/library-ui.js';
import { Dialogs } from './ui/dialogs.js';
import { AutoMix } from './automix.js';
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
    this.settings = await api.settings();
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
    this.midi = new MidiManager(this);
    this.sequencer = new Sequencer(this.engine);
    this.buildLayout();
    setupStems(this);
    this.recording = setupRecording(this); this.engine.attachRecorder(this.recording.recorder);
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
    setInterval(() => this.library.refreshDrives(), 15000); // notice USB sticks being plugged in
    this.setLayout(this.settings.layoutMode || 'classic', false, true);
    this.setDeckCount(this.deckCount, false);
    if (!unavailable('dvs')) this.dvs.init().catch((e) => console.warn('DVS init failed', e));
    this.engine.setMasterVolume(0.8); this.engine.setHeadphoneVolume(0.8);
    if (this.engine.ctx.state !== 'running') this.showStartOverlay();
    const frame = (now) => { this.frame(now); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    document.getElementById('boot')?.remove();
    this.ready = true;
  }

  async setSetting(k, v) { this.settings[k] = v; try { this.settings = { ...this.settings, ...(await api.saveSettings({ [k]: v })) }; this.engine.settings = this.settings; } catch (e) { this.toast(e.message); } }

  /** Hosted mode (password login): Sign out in the top bar. */
  updateHostedUi() { if (this.signOutBtn) this.signOutBtn.hidden = !this.auth; }

  showStartOverlay() {
    const o = el('div', { class: 'overlay start' }, el('button', { class: 'btn primary big-start', onclick: async () => { await this.engine.resume(); o.remove(); } }, iconLabel('play', 'Start audio engine')));
    document.body.append(o);
  }

  async loadTrack(deckIndex, trackId) {
    const t = this.library.track(trackId);
    const deck = this.engine.decks[deckIndex];
    if (!t) { this.toast('That track is no longer in the library'); throw new Error('Track not found in the library'); }
    if (deck.playing && !this.automix.enabled && !(await this.dialogs.confirm(`Deck ${deckIndex + 1} is playing. Load "${t.title}" anyway?`))) return;
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

  toast(msg) {
    // "⚠ …" messages are warnings: shown with an icon and the warning colour instead of the emoji
    const warn = typeof msg === 'string' && /^⚠\uFE0F?\s*/.test(msg);
    const t = el('div', { class: `toast${warn ? ' warn' : ''}`, role: warn ? 'alert' : 'status' }, icon(warn ? 'warn' : 'info'), el('span', { class: 'toast-msg' }, warn ? msg.replace(/^⚠\uFE0F?\s*/, '') : msg));
    this.toasts.append(t);
    setTimeout(() => t.classList.add('out'), 4200); setTimeout(() => t.remove(), 4700);
  }

  // ---------------- layout ----------------
  buildLayout() {
    const root = document.getElementById('app');
    this.toasts = el('div', { class: 'toasts' });
    // top bar
    this.clock = el('span', { class: 'clock' });
    this.recBtn = el('button', { class: 'btn rec', onclick: () => this.toggleRecord(), title: 'Record your mix to disk. R = start / stop' }, el('span', { class: 'rec-dot' }), 'REC');
    this.recTime = el('span', { class: 'rec-time' });
    this.amBtn = el('button', { class: 'btn automix-btn', onclick: () => this.toggleAutomix(), title: 'Automix the current library view' }, iconLabel('automix', 'AUTOMIX'));
    this.amSkip = el('button', { class: 'btn sm icon-only', onclick: () => this.automix.skip(), title: 'Mix to next track now', 'aria-label': 'Mix to next track now' }, icon('next'));
    this.amInfo = el('span', { class: 'am-info' });
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
      el('div', { class: 'logo' }, logoMark(), el('span', { class: 'logo-word' }, 'Open', el('b', {}, 'DJ'))),
      deckSel, shiftBtn,
      el('div', { class: 'tb-group' }, this.amBtn, this.amSkip, this.amInfo),
      el('div', { class: 'tb-spacer' }),
      el('div', { class: 'tb-group' }, this.recBtn, this.recTime),
      this.midiDot, this.cpu, this.clock,
      dvsButton(this),
      el('button', { class: 'btn sm video-btn', title: 'Video mixer, visuals, YouTube & projector output', onclick: () => (this.videoUi ||= setupVideo(this)).toggleMixer() }, iconLabel('video', 'VIDEO')),
      el('button', { class: 'btn sm light-btn', title: 'Lighting (DMX, Art-Net, sACN, WLED, Hue, OSC)', onclick: () => this.lighting?.openPanel() }, iconLabel('lights', 'LIGHTS')),
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
    fileIn.addEventListener('change', async () => { try { await s.loadFile(target, fileIn.files[0]); render(); } catch (e) { this.toast(`Could not load sample: ${e.message}`); } fileIn.value = ''; });
    const pads = s.slots.map((_, i) => {
      const b = el('button', { class: 'spad', title: 'Click: play · Shift-click: stop · Right-click: load your own sample' });
      b.addEventListener('pointerdown', () => { this.engine.resume(); this.shift ? s.stop(i) : s.trigger(i); });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); target = i; fileIn.click(); });
      return b;
    });
    const render = () => { pads.forEach((b, i) => { b.textContent = s.slots[i]?.name || '—'; }); this.seqPanel?.renderNames?.(); };
    render();
    const seqBtn = el('button', { class: 'btn sm seq-btn', title: 'Step sequencer (synced to the master deck)', onclick: () => this.toggleSequencer() }, 'SEQ');
    bar.append(...pads, seqBtn, fileIn);
    return bar;
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
  toggleAutomix() {
    if (this.automix.enabled) { this.automix.stop(); this.toast('Automix stopped'); }
    else this.dialogs.automixQueue(this.automix.queue.length > this.automix.idx ? this.automix.queue.slice(this.automix.idx) : this.library.rows);
  }
  queueAdd(tracks) {
    if (!this.automix.enabled) { this.automix.queue = [...this.automix.queue.slice(this.automix.idx), ...tracks]; this.automix.idx = 0; }
    else if (this.shift) this.automix.insertNext(tracks); // Shift = play next
    else this.automix.queue.push(...tracks);
    this.toast(`${tracks.length} track(s) queued for automix`);
    this.updateAutomixUi();
  }
  updateAutomixUi() {
    const a = this.automix;
    this.amBtn.classList.toggle('active', a.enabled);
    const next = a.nextTrack();
    this.amSkip.disabled = !a.enabled || !!a.transition;
    const info = a.enabled ? (a.transition ? 'Mixing…' : next ? `Next: ${next.artist ? next.artist + ' – ' : ''}${next.title}` : 'Last track') : (a.queue.length ? `${a.queue.length - a.idx} queued` : '');
    if (this.amInfo.textContent !== info) this.amInfo.textContent = info;
  }

  toggleRecord() { return this.recording.toggle(); }


  /** Pad FX mode actions */
  padFx(deck, fx, down) {
    const ch = this.engine.channels[deck.index];
    switch (fx) {
      case 'brake': if (down) deck.brake(1.2); break;
      case 'tapeStop': if (down) deck.brake(3); break;
      case 'backspin': if (down) deck.backspin(1); break;
      case 'censor': down ? deck.censorOn() : deck.censorOff(); break;
      case 'roll1': down ? deck.rollOn(1 / 4) : deck.rollOff(); break;
      case 'roll2': down ? deck.rollOn(1 / 8) : deck.rollOff(); break;
      case 'echoOut':
        if (!down) break;
        ch.set('fxType', 'echo'); ch.set('fxBeats', 0.75); ch.set('fxParam', 0.8); ch.set('fxMix', 0.7); ch.set('fxOn', true);
        setTimeout(() => { ch.set('fxOn', false); deck.pause(); }, deck.beatLen * 1000);
        setTimeout(() => ch.set('fxParam', 0.5), deck.beatLen * 8000);
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
      library: () => {
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
    this.automix.on('state', () => { this.updateAutomixUi(); this.library.renderRows(true); });
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
  }

  frame(now) {
    for (let i = 0; i < this.deckCount; i++) { this.waves[i].wf.draw(now); this.deckEls[i].frame(now); }
    this.mixer.frame(now);
    if (!this._slow || now - this._slow > 250) {
      this._slow = now;
      const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };
      setText(this.clock, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      setText(this.recTime, this.engine.recording ? fmtTime((Date.now() - this.engine.recStarted) / 1000).slice(0, 5) : '');
      this.midiDot.classList.toggle('active', now - this.midi.activity < 150);
      this.midiDot.classList.toggle('connected', (this.midi.devices?.() || this.midi.inputs()).length > 0);
      this.midiDot.title = this.midi.inputs().map((i) => i.name).join(', ') || 'No MIDI controller';
      this.updateAutomixUi();
      this.updateDeckTabs();
    }
  }
}

const app = new App();
window.opendj = app;
app.init().catch((e) => {
  console.error(e);
  const b = document.getElementById('boot');
  if (b) b.textContent = `OpenDJ failed to start: ${e.message}`;
});
