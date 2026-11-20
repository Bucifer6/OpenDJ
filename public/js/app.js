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
import { Lighting } from './lighting/lighting.js';
import { setupVideo } from './video/video-ui.js';
import { setupUpload } from './ui/upload.js';

class App {
  constructor() { this.shift = false; this._shiftKey = false; }

  async init() {
    this.settings = await api.settings();
    applyTheme(this.settings);
    this.deckCount = this.settings.deckCount || 2;
    this.engine = new Engine(this.settings);
    await this.engine.init();
    this.dialogs = new Dialogs(this);
    this.library = new LibraryUI(this);
    this.upload = setupUpload(this);
    if ('serviceWorker' in navigator && !/Electron/.test(navigator.userAgent)) navigator.serviceWorker.register('/sw.js').catch(() => {});
    this.automix = new AutoMix(this);
    this.midi = new MidiManager(this);
    this.sequencer = new Sequencer(this.engine);
    this.buildLayout();
    this.wireEvents(); // subscribe to server events before loading the library so no change is missed
    await this.midi.init();
    if (this.settings.midiClockOutput) this.midi.setClockOutput(this.settings.midiClockOutput);
    this.lighting = new Lighting(this);
    try { await this.lighting.init(); } catch (e) { console.warn('lighting init failed', e); }
    await this.library.refresh();
    this.library.refreshDrives();
    setInterval(() => this.library.refreshDrives(), 15000); // notice USB sticks being plugged in
    this.setDeckCount(this.deckCount, false);
    this.engine.setMasterVolume(0.8); this.engine.setHeadphoneVolume(0.8);
    if (this.engine.ctx.state !== 'running') this.showStartOverlay();
    const frame = (now) => { this.frame(now); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    document.getElementById('boot')?.remove();
    this.ready = true;
  }

  async setSetting(k, v) { this.settings[k] = v; try { this.settings = { ...this.settings, ...(await api.saveSettings({ [k]: v })) }; this.engine.settings = this.settings; } catch (e) { this.toast(e.message); } }

  showStartOverlay() {
    const o = el('div', { class: 'overlay start' }, el('button', { class: 'btn primary big-start', onclick: async () => { await this.engine.resume(); o.remove(); } }, '▶ Start audio engine'));
    document.body.append(o);
  }

  async loadTrack(deckIndex, trackId) {
    const t = this.library.track(trackId);
    const deck = this.engine.decks[deckIndex];
    if (!t) { this.toast('That track is no longer in the library'); throw new Error('Track not found in the library'); }
    if (deck.playing && !this.automix.enabled && !(await this.dialogs.confirm(`Deck ${deckIndex + 1} is playing. Load "${t.title}" anyway?`))) return;
    try { await deck.load({ ...t }); this.library.renderRows(true); }
    catch (e) { this.toast(`Could not load "${t.title}": ${e.message}`); throw e; }
  }

  toast(msg) {
    const t = el('div', { class: 'toast' }, msg);
    this.toasts.append(t);
    setTimeout(() => t.classList.add('out'), 4200); setTimeout(() => t.remove(), 4700);
  }

  // ---------------- layout ----------------
  buildLayout() {
    const root = document.getElementById('app');
    this.toasts = el('div', { class: 'toasts' });
    // top bar
    this.clock = el('span', { class: 'clock' });
    this.recBtn = el('button', { class: 'btn rec', onclick: () => this.toggleRecord(), title: 'Record your mix (WAV)' }, '● REC');
    this.recTime = el('span', { class: 'rec-time' });
    this.amBtn = el('button', { class: 'btn automix-btn', onclick: () => this.toggleAutomix(), title: 'Automix the current library view' }, 'AUTOMIX');
    this.amSkip = el('button', { class: 'btn sm', onclick: () => this.automix.skip(), title: 'Mix to next track now' }, '⏭');
    this.amInfo = el('span', { class: 'am-info' });
    this.midiDot = el('span', { class: 'midi-dot', title: 'MIDI activity' }, 'MIDI');
    this.cpu = el('span', { class: 'cpu' });
    const deckSel = el('div', { class: 'seg' }, ...[2, 4].map((n) => el('button', { class: 'seg-btn', 'data-n': n, onclick: () => this.setDeckCount(n) }, `${n} DECK`)));
    this.deckSel = deckSel;
    const shiftBtn = el('button', { class: 'btn sm shift-btn', title: 'Shift (or hold the Shift key)' }, 'SHIFT');
    shiftBtn.addEventListener('pointerdown', () => { this.shift = true; shiftBtn.classList.add('active'); });
    const shiftUp = () => { this.shift = this._shiftKey; shiftBtn.classList.remove('active'); };
    shiftBtn.addEventListener('pointerup', shiftUp); shiftBtn.addEventListener('pointerleave', shiftUp);
    const topbar = el('header', { class: 'topbar' },
      el('div', { class: 'logo' }, el('span', { class: 'logo-mark' }, '◐'), 'Open', el('b', {}, 'DJ')),
      deckSel, shiftBtn,
      el('div', { class: 'tb-group' }, this.amBtn, this.amSkip, this.amInfo),
      el('div', { class: 'tb-spacer' }),
      el('div', { class: 'tb-group' }, this.recBtn, this.recTime),
      this.midiDot, this.cpu, this.clock,
      el('button', { class: 'btn sm video-btn', title: 'Video mixer, visuals, YouTube & projector output', onclick: () => (this.videoUi ||= setupVideo(this)).toggleMixer() }, '🎬 VIDEO'),
      el('button', { class: 'btn sm light-btn', title: 'Lighting (DMX, Art-Net, sACN, WLED, Hue, OSC)', onclick: () => this.lighting?.openPanel() }, '💡 LIGHTS'),
      el('button', { class: 'btn icon', title: 'Settings', onclick: () => this.dialogs.settings() }, '⚙'),
      el('button', { class: 'btn icon', title: 'Full screen', onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()) }, '⛶'),
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
    this.deckArea = el('section', { class: 'deck-area' },
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
        el('button', { class: 'btn sm', onclick: () => seq.clear() }, 'Clear'), el('button', { class: 'btn sm', onclick: () => this.toggleSequencer() }, '✕')),
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
    for (const b of this.deckSel.children) b.classList.toggle('active', Number(b.dataset.n) === n);
    if (save) this.setSetting('deckCount', n);
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
    this.amInfo.textContent = a.enabled ? (a.transition ? 'Mixing…' : next ? `Next: ${next.artist ? next.artist + ' – ' : ''}${next.title}` : 'Last track') : (a.queue.length ? `${a.queue.length - a.idx} queued` : '');
  }

  async toggleRecord() {
    if (!this.engine.recording) { await this.engine.resume(); this.engine.startRecording(); this.toast('Recording started'); return; }
    const blob = await this.engine.stopRecording();
    const name = `OpenDJ mix ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')}.wav`;
    const a = el('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    this.toast(`Saved recording "${name}" (${(blob.size / 1048576).toFixed(1)} MB)`);
  }

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
    let refreshT;
    api.events({
      library: () => { clearTimeout(refreshT); refreshT = setTimeout(() => this.library.refresh(), 600); },
      scan: (p) => this.library.setJobStatus(p.done ? '' : `Scanning… ${p.scanned} files`),
      sync: (p) => this.library.setJobStatus(p.finished ? '' : `Syncing media server… ${p.done}${p.total ? '/' + p.total : ''}`),
      downloads: (d) => this.library.setDownloads(d),
      'job-error': (e) => { this.library.setJobStatus(''); this.toast(`⚠ ${e.message}`); },
    });
    this.engine.on('track-updated', (t) => this.library.updateTrack(t));
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
    window.addEventListener('beforeunload', (e) => { if (this.engine.decks.some((d) => d.playing) || this.engine.recording) { e.preventDefault(); e.returnValue = ''; } });
  }

  frame(now) {
    for (let i = 0; i < this.deckCount; i++) { this.waves[i].wf.draw(); this.deckEls[i].frame(now); }
    this.mixer.frame();
    if (!this._slow || now - this._slow > 250) {
      this._slow = now;
      this.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.recTime.textContent = this.engine.recording ? fmtTime((Date.now() - this.engine.recStarted) / 1000).slice(0, 5) : '';
      this.midiDot.classList.toggle('active', now - this.midi.activity < 150);
      this.midiDot.classList.toggle('connected', (this.midi.devices?.() || this.midi.inputs()).length > 0);
      this.midiDot.title = this.midi.inputs().map((i) => i.name).join(', ') || 'No MIDI controller';
      this.updateAutomixUi();
      // automix: ease the tempo back to the track's original speed between transitions
      const a = this.automix;
      if (a.enabled && !a.transition && a.current && Math.abs(a.current.tempo) > 0.02 && !a.current.syncOn) a.current.setTempo(a.current.tempo * 0.995);
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
