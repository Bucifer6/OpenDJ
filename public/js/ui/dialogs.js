import { el } from '../util.js';
import { api } from '../api.js';
import { describeKey } from '../midi/midi.js';
import { PRESETS } from '../midi/presets.js';

export class Dialogs {
  constructor(app) { this.app = app; }

  modal(title, body, buttons = [], { wide = false } = {}) {
    return new Promise((resolve) => {
      const close = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      const foot = el('div', { class: 'modal-foot' }, ...buttons.map((b) => el('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`, onclick: async () => { if (b.action) { const r = await b.action(); if (r === false) return; close(r ?? b.value); } else close(b.value); } }, b.label)));
      const box = el('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-label': title },
        el('div', { class: 'modal-head' }, el('h2', {}, title), el('button', { class: 'modal-x', onclick: () => close(null), 'aria-label': 'Close' }, '✕')),
        el('div', { class: 'modal-body' }, body), buttons.length ? foot : null);
      const overlay = el('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(null); } }, box);
      document.body.append(overlay);
      document.addEventListener('keydown', onKey);
      setTimeout(() => box.querySelector('input, select, button.primary')?.focus(), 30);
    });
  }

  menu(x, y, items) {
    document.querySelector('.ctx-menu')?.remove();
    const build = (list) => el('div', { class: 'ctx-menu' }, ...list.map((it) => {
      if (it === '-') return el('div', { class: 'ctx-sep' });
      const row = el('div', { class: `ctx-item ${it.danger ? 'danger' : ''} ${it.sub ? 'has-sub' : ''}` }, it.label);
      if (it.sub) { const sub = build(it.sub); sub.classList.add('ctx-sub'); row.append(sub); }
      else row.addEventListener('click', () => { m.remove(); it.action(); });
      return row;
    }));
    const m = build(items);
    document.body.append(m);
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`; m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
    setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); } }), 0);
  }

  async prompt(title, label, value = '') {
    const input = el('input', { class: 'inp', value });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
    let ok;
    const p = this.modal(title, el('label', { class: 'field' }, el('span', {}, label), input), [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, action: () => input.value.trim() }]);
    ok = document.querySelector('.modal .btn.primary');
    return p;
  }
  confirm(text) { return this.modal('Confirm', el('p', {}, text), [{ label: 'Cancel', value: false }, { label: 'OK', primary: true, value: true }]); }

  // ---------- folder picker (native in Electron, server-side browser otherwise) ----------
  async pickFolder(title = 'Choose folder') {
    if (window.opendjNative?.pickFolder) return window.opendjNative.pickFolder(title);
    let cur = await api.browse();
    const pathEl = el('input', { class: 'inp', value: cur.path });
    const list = el('div', { class: 'browse-list' });
    const render = () => {
      pathEl.value = cur.path;
      list.replaceChildren(
        cur.parent ? el('div', { class: 'browse-item', onclick: async () => { cur = await api.browse(cur.parent); render(); } }, '⬑ ..') : null,
        ...cur.entries.map((e) => el('div', { class: 'browse-item', onclick: async () => { try { cur = await api.browse(e.path); render(); } catch (err) { this.app.toast(err.message); } } }, '🗀 ' + e.name)));
    };
    pathEl.addEventListener('change', async () => { try { cur = await api.browse(pathEl.value); render(); } catch (e) { this.app.toast(e.message); } });
    render();
    return this.modal(title, el('div', {}, pathEl, list), [{ label: 'Cancel', value: null }, { label: 'Select this folder', primary: true, action: () => cur.path }]);
  }

  async addFolder() {
    const drives = await api.drives().catch(() => []);
    const pathIn = el('input', { class: 'inp', placeholder: '/media/usb  ·  /Volumes/NAS/Music  ·  \\\\nas\\music  ·  D:\\Music' });
    const nameIn = el('input', { class: 'inp', placeholder: 'Display name (optional)' });
    const body = el('div', { class: 'form' },
      el('p', { class: 'hint' }, 'Add any folder: internal disk, USB stick, external drive or a NAS share. NAS shares must be mounted by your operating system (SMB/NFS/AFP) or reachable by a network path. The folder is scanned now and can be rescanned anytime.'),
      drives.length ? el('div', { class: 'drive-grid' }, ...drives.map((d) => el('button', { class: 'drive-card', onclick: () => { pathIn.value = d.path; nameIn.value = d.name; } },
        el('div', { class: 'drive-icon' }, d.kind === 'network' ? '🖧' : d.kind === 'home' ? '⌂' : '⛁'), el('div', {}, d.name), el('small', {}, d.kind === 'network' ? `NAS · ${d.fs}` : d.kind === 'home' ? 'Home' : 'Drive')))) : null,
      el('div', { class: 'row' }, pathIn, el('button', { class: 'btn', onclick: async () => { const p = await this.pickFolder(); if (p) pathIn.value = p; } }, 'Browse…')),
      nameIn,
    );
    const r = await this.modal('Add music folder', body, [{ label: 'Cancel', value: null }, {
      label: 'Add & scan', primary: true, action: async () => {
        try { await api.addFolder(pathIn.value.trim(), nameIn.value.trim() || undefined); return true; } catch (e) { this.app.toast(e.message); return false; }
      },
    }]);
    if (r) { this.app.toast('Scanning folder…'); this.app.library.refresh(); }
  }

  async addSource(existing) {
    const types = await api.sourceTypes();
    const typeSel = el('select', { class: 'sel' }, ...types.map((t) => el('option', { value: t.type }, t.label)));
    if (existing) { typeSel.value = existing.type; typeSel.disabled = true; }
    const nameIn = el('input', { class: 'inp', placeholder: 'Name, e.g. "Home Plex"', value: existing?.name || '' });
    const fieldsEl = el('div', { class: 'form' });
    const inputs = {};
    const renderFields = () => {
      const t = types.find((x) => x.type === typeSel.value);
      fieldsEl.replaceChildren(...t.fields.map((f) => {
        const inp = el('input', { class: 'inp', type: f.type === 'password' ? 'password' : 'text', placeholder: f.placeholder || (existing && f.type === 'password' ? '(unchanged)' : ''), value: existing && f.type !== 'password' ? existing[f.name] || '' : '' });
        inputs[f.name] = inp;
        return el('label', { class: 'field' }, el('span', {}, f.label + (f.required ? ' *' : '')), inp, f.help ? el('small', { class: 'hint' }, f.help) : null);
      }));
    };
    typeSel.addEventListener('change', renderFields); renderFields();
    const status = el('div', { class: 'hint' });
    const body = el('div', { class: 'form' },
      el('p', { class: 'hint' }, 'Stream tracks straight from your media server, or download them for offline gigs. Supports Plex, Jellyfin, Emby, Subsonic-compatible servers (Navidrome, Airsonic, Gonic…) and MediaMax.'),
      el('label', { class: 'field' }, el('span', {}, 'Server type'), typeSel), el('label', { class: 'field' }, el('span', {}, 'Name'), nameIn), fieldsEl, status);
    const r = await this.modal(existing ? 'Edit media server' : 'Add media server', body, [{ label: 'Cancel', value: null }, {
      label: 'Connect', primary: true, action: async () => {
        const cfg = { type: typeSel.value, name: nameIn.value.trim() || typeSel.selectedOptions[0].textContent };
        if (existing) cfg.id = existing.id;
        for (const [k, inp] of Object.entries(inputs)) if (inp.value.trim()) cfg[k] = inp.value.trim();
        status.textContent = 'Connecting…';
        try { const res = await api.addSource(cfg); return res; } catch (e) { status.textContent = `✕ ${e.message}`; return false; }
      },
    }]);
    if (r) { this.app.toast(`Connected to ${r.info?.serverName || r.source.name}. Syncing library…`); this.app.library.refresh(); }
  }

  async exportUsb(playlistIds) {
    const pls = this.app.library.playlists;
    const checks = pls.map((p) => { const c = el('input', { type: 'checkbox', checked: playlistIds.includes(p.id) }); c.dataset.id = p.id; return el('label', { class: 'check' }, c, ` ${p.name} (${p.trackIds.length})`); });
    const target = el('input', { class: 'inp', placeholder: 'USB drive or folder' });
    const drives = await api.drives().catch(() => []);
    const body = el('div', { class: 'form' },
      el('p', { class: 'hint' }, 'Copies the audio files plus an .m3u8 per playlist and a rekordbox.xml into an "OpenDJ" folder on the target. Streaming-only tracks must be downloaded first.'),
      el('div', { class: 'check-list' }, ...checks),
      el('div', { class: 'drive-grid' }, ...drives.filter((d) => d.kind !== 'home').map((d) => el('button', { class: 'drive-card', onclick: () => { target.value = d.path; } }, el('div', { class: 'drive-icon' }, '⛁'), el('div', {}, d.name)))),
      el('div', { class: 'row' }, target, el('button', { class: 'btn', onclick: async () => { const p = await this.pickFolder('Export target'); if (p) target.value = p; } }, 'Browse…')));
    const r = await this.modal('Export to USB', body, [{ label: 'Cancel', value: null }, {
      label: 'Export', primary: true, action: async () => {
        const ids = checks.map((c) => c.querySelector('input')).filter((c) => c.checked).map((c) => c.dataset.id);
        if (!ids.length || !target.value) { this.app.toast('Choose playlists and a target'); return false; }
        this.app.toast('Exporting…');
        try { return await api.exportUsb(ids, target.value); } catch (e) { this.app.toast(e.message); return false; }
      },
    }]);
    if (r) this.app.toast(`Exported ${r.files} files to ${r.target}`);
  }

  async automixQueue(tracks) {
    if (!tracks?.length) return this.app.toast('No tracks in this view');
    const smart = el('input', { type: 'checkbox', checked: true });
    const o = this.app.settings.automix;
    const style = el('select', { class: 'sel' }, ...[['phrase', 'Phrase-aligned bass swap'], ['eqswap', 'EQ swap (bass swap)'], ['crossfade', 'Smooth crossfade'], ['filter', 'Filter fade'], ['echo', 'Echo out']].map(([v, l]) => el('option', { value: v }, l)));
    style.value = o.style;
    const order = el('select', { class: 'sel' }, ...[['harmonic', 'Harmonic (key + tempo)'], ['build', 'Build up (rising energy)'], ['peak', 'Peak (rise, then cool down)'], ['wave', 'Waves (up and down)']].map(([v, l]) => el('option', { value: v }, l)));
    order.value = o.order || 'harmonic';
    const keySync = el('input', { type: 'checkbox', checked: !!o.keySync });
    const beats = el('select', { class: 'sel' }, ...[8, 16, 32, 64].map((b) => el('option', { value: b }, `${b} beats`)));
    beats.value = String(o.transitionBeats);
    const body = el('div', { class: 'form' },
      el('p', {}, `Auto-mix ${tracks.length} tracks on decks 1 & 2 with beat-matched transitions.`),
      el('label', { class: 'check' }, smart, ' Smart order'),
      el('label', { class: 'field' }, el('span', {}, 'Energy curve'), order),
      el('label', { class: 'check' }, keySync, ' Fix key clashes with Key Sync'),
      el('label', { class: 'field' }, el('span', {}, 'Transition style'), style),
      el('label', { class: 'field' }, el('span', {}, 'Transition length'), beats));
    const r = await this.modal('Automix', body, [{ label: 'Cancel', value: null }, { label: 'Start automix', primary: true, value: true }]);
    if (!r) return;
    this.app.setSetting('automix', { ...o, style: style.value, transitionBeats: Number(beats.value), order: order.value, keySync: keySync.checked });
    try { await this.app.automix.start(tracks, { smart: smart.checked, order: order.value }); } catch (e) { this.app.toast(e.message); }
  }

  gridEditor(deck) {
    if (!deck.track) return;
    const bpmIn = el('input', { class: 'inp', type: 'number', step: '0.01', value: deck.bpm.toFixed(2) });
    let taps = [];
    const tapBtn = el('button', { class: 'btn', onclick: () => {
      const now = performance.now(); taps = taps.filter((t) => now - t < 3000); taps.push(now);
      if (taps.length > 3) { const avg = (taps.at(-1) - taps[0]) / (taps.length - 1); bpmIn.value = (60000 / avg / (1 + deck.tempo / 100)).toFixed(2); }
    } }, 'TAP');
    const shift = (s) => deck.gridShift(s);
    const body = el('div', { class: 'form' },
      el('p', { class: 'hint' }, 'Fix the beat grid if auto-detection was off. Play the track and use "Downbeat here" on a kick at the start of a bar.'),
      el('div', { class: 'row' }, el('label', { class: 'field' }, el('span', {}, 'BPM'), bpmIn), tapBtn,
        el('button', { class: 'btn', onclick: () => { bpmIn.value = (bpmIn.value / 2).toFixed(2); } }, '÷2'),
        el('button', { class: 'btn', onclick: () => { bpmIn.value = (bpmIn.value * 2).toFixed(2); } }, '×2'),
        el('button', { class: 'btn primary', onclick: () => deck.setGrid(Number(bpmIn.value), deck.gridOffset) }, 'Apply BPM')),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => shift(-0.01) }, '◀ 10ms'), el('button', { class: 'btn', onclick: () => shift(-0.001) }, '◀ 1ms'),
        el('button', { class: 'btn primary', onclick: () => deck.gridSetDownbeatHere() }, 'Downbeat here'),
        el('button', { class: 'btn', onclick: () => shift(0.001) }, '1ms ▶'), el('button', { class: 'btn', onclick: () => shift(0.01) }, '10ms ▶')),
      el('label', { class: 'check' }, (() => { const c = el('input', { type: 'checkbox', checked: !!deck.track.bpmLocked }); c.addEventListener('change', () => { deck.track.bpmLocked = c.checked; api.updateTrack(deck.track.id, { bpmLocked: c.checked }); }); return c; })(), ' Lock BPM (don\'t overwrite on re-analysis)'));
    this.modal(`Beat grid — Deck ${deck.index + 1}`, body, [{ label: 'Done', primary: true, value: true }]);
  }

  // ---------- settings ----------
  async settings(tab = 'audio') {
    const app = this.app, s = app.settings;
    const set = (k, v) => app.setSetting(k, v);
    const sel = (value, options, onChange) => { const e = el('select', { class: 'sel' }, ...options.map(([v, l]) => el('option', { value: v }, l))); e.value = String(value); e.addEventListener('change', () => onChange(e.value)); return e; };
    const chk = (value, onChange) => { const e = el('input', { type: 'checkbox', checked: !!value }); e.addEventListener('change', () => onChange(e.checked)); return e; };
    const field = (label, ctrl, hint) => el('label', { class: 'field' }, el('span', {}, label), ctrl, hint ? el('small', { class: 'hint' }, hint) : null);

    const outputs = await app.engine.listOutputs();
    const inputs = await navigator.mediaDevices?.enumerateDevices?.().then((ds) => ds.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default').map((d) => ({ id: d.deviceId, label: d.label || `Input ${d.deviceId.slice(0, 6)}` }))).catch(() => []) || [];
    const outOpts = [['default', 'System default'], ...outputs.filter((o) => o.id !== 'default').map((o) => [o.id, o.label])];
    const audio = el('div', { class: 'form' },
      field('Master output', sel(s.masterDeviceId || 'default', outOpts, async (v) => { await set('masterDeviceId', v); app.engine.applyOutputs(); })),
      field('Headphone (cue) routing', sel(s.cueMode, [['device', 'Separate sound card / output'], ['channels34', 'Same interface, channels 3-4 (DJ controller sound card)'], ['split', 'Split cue: master mono left, cue mono right (single stereo jack)']], async (v) => { await set('cueMode', v); app.engine.applyOutputs(); }),
        'Most DJ controllers with a built-in sound card expose 4 channels: choose "channels 3-4" and select the controller as master output.'),
      field('Headphone output (separate device mode)', sel(s.cueDeviceId || '', [['', '— none —'], ...outOpts.filter(([v]) => v !== 'default')], async (v) => { await set('cueDeviceId', v); app.engine.applyOutputs(); })),
      el('button', { class: 'btn sm', onclick: async () => { try { const st = await navigator.mediaDevices.getUserMedia({ audio: true }); st.getTracks().forEach((t) => t.stop()); this.app.toast('Device names unlocked — reopen settings'); } catch (e) { this.app.toast(e.message); } } }, 'Show device names (asks for permission)'),
      field('Microphone / aux input', sel(s.micDeviceId || '', [['', 'System default input'], ...inputs.map((d) => [d.id, d.label])], async (v) => { await set('micDeviceId', v); if (app.engine.micOn) { await app.engine.setMic(false); await app.engine.setMic(true); } })),
      field('Talkover ducking', sel(s.talkoverDb ?? -12, [[-6, '−6 dB'], [-12, '−12 dB'], [-18, '−18 dB'], [-24, '−24 dB']], (v) => set('talkoverDb', Number(v)))),
      field('Audio latency', sel(s.latencyHint || 'interactive', [['interactive', 'Lowest (interactive)'], ['10', '10 ms'], ['20', '20 ms'], ['balanced', 'Balanced'], ['playback', 'Safe (high latency, no dropouts)']], (v) => { set('latencyHint', v); this.app.toast('Restart OpenDJ to apply the new latency'); }),
        'Raise this if you hear crackles; lower it for tighter scratching and cueing.'),
      el('label', { class: 'check' }, chk(s.limiter, (v) => { set('limiter', v); app.engine.setLimiter(v); }), ' Master limiter (prevents clipping)'),
      el('label', { class: 'check' }, chk(s.autoGain, (v) => set('autoGain', v)), ' Auto gain (level-match tracks on load)'),
      el('p', { class: 'hint' }, `Sample rate ${app.engine.ctx.sampleRate} Hz · output latency ≈ ${Math.round(((app.engine.ctx.outputLatency || 0) + (app.engine.ctx.baseLatency || 0)) * 1000)} ms`),
    );
    const decks = el('div', { class: 'form' },
      field('Decks', sel(app.deckCount, [['2', '2 decks'], ['4', '4 decks']], (v) => app.setDeckCount(Number(v)))),
      field('Default tempo range', sel(s.tempoRange, [6, 8, 10, 16, 25, 50, 100].map((r) => [r, `±${r}%`]), (v) => { set('tempoRange', Number(v)); for (const d of app.engine.decks) d.setTempoRange(Number(v)); })),
      field('Sync mode', sel(s.syncMode, [['beat', 'Beat sync (tempo + phase)'], ['tempo', 'Tempo sync only']], (v) => set('syncMode', v))),
      el('label', { class: 'check' }, chk(s.keyLockDefault, (v) => set('keyLockDefault', v)), ' Key lock on by default'),
      el('label', { class: 'check' }, chk(s.quantize, (v) => { set('quantize', v); for (const d of app.engine.decks) d.setQuantize(v); }), ' Quantize'),
      field('Waveform colours', sel(s.waveformColors, [['rgb', '3-band RGB'], ['blue', 'Blue'], ['mono', 'Monochrome']], (v) => set('waveformColors', v))),
    );
    const am = s.automix;
    const automix = el('div', { class: 'form' },
      field('Transition style', sel(am.style, [['phrase', 'Phrase-aligned bass swap'], ['eqswap', 'EQ swap (bass swap)'], ['crossfade', 'Smooth crossfade'], ['filter', 'Filter fade'], ['echo', 'Echo out']], (v) => set('automix', { ...app.settings.automix, style: v }))),
      field('Transition length', sel(am.transitionBeats, [8, 16, 32, 64].map((b) => [b, `${b} beats`]), (v) => set('automix', { ...app.settings.automix, transitionBeats: Number(v) }))),
      el('label', { class: 'check' }, chk(am.keepSync, (v) => set('automix', { ...app.settings.automix, keepSync: v })), ' Beat-match transitions'),
      el('label', { class: 'check' }, chk(am.skipSilence, (v) => set('automix', { ...app.settings.automix, skipSilence: v })), ' Skip silence at track ends'),
      el('label', { class: 'check' }, chk(am.shuffle, (v) => set('automix', { ...app.settings.automix, shuffle: v })), ' Shuffle'),
      el('label', { class: 'check' }, chk(am.keySync, (v) => set('automix', { ...app.settings.automix, keySync: v })), ' Fix key clashes with Key Sync'),
      field('Smart order energy curve', sel(am.order || 'harmonic', [['harmonic', 'Harmonic'], ['build', 'Build up'], ['peak', 'Peak'], ['wave', 'Waves']], (v) => set('automix', { ...app.settings.automix, order: v }))),
    );
    const dlIn = el('input', { class: 'inp', value: s.downloadDir });
    dlIn.addEventListener('change', () => set('downloadDir', dlIn.value));
    const rbIn = el('input', { class: 'inp', placeholder: 'Path to rekordbox.xml (File → Export Collection in xml format)' });
    const m3uIn = el('input', { class: 'inp', placeholder: 'Path to .m3u / .m3u8 playlist' });
    const library = el('div', { class: 'form' },
      field('Download folder (for tracks from media servers)', el('div', { class: 'row' }, dlIn, el('button', { class: 'btn', onclick: async () => { const p = await this.pickFolder('Download folder'); if (p) { dlIn.value = p; set('downloadDir', p); } } }, 'Browse…'))),
      el('h3', {}, 'Import'),
      el('div', { class: 'row' }, ...[['rekordbox', 'rekordbox XML'], ['traktor', 'Traktor NML'], ['serato', 'Serato crates'], ['virtualdj', 'VirtualDJ database']].map(([k, l]) => el('button', { class: 'btn sm', onclick: () => app.library.dlg.importFrom(k) }, `Import ${l}…`))),
      el('div', { class: 'row' }, rbIn, el('button', { class: 'btn', onclick: async () => {
        try { const r = await api.importRekordbox({ path: rbIn.value.trim() }); this.app.toast(`Imported ${r.imported} tracks, ${r.playlists} playlists from rekordbox${r.missing ? ` (${r.missing} files not found)` : ''}`); app.library.refresh(); } catch (e) { this.app.toast(e.message); }
      } }, 'Import rekordbox XML')),
      el('div', { class: 'row' }, m3uIn, el('button', { class: 'btn', onclick: async () => {
        try { const p = await api.importM3U({ path: m3uIn.value.trim() }); this.app.toast(`Imported playlist "${p.name}" (${p.trackIds.length} tracks)`); app.library.refresh(); } catch (e) { this.app.toast(e.message); }
      } }, 'Import M3U')),
      el('h3', {}, 'Export'),
      el('div', { class: 'row' },
        el('a', { class: 'btn', href: api.rekordboxExportUrl(), download: 'opendj-rekordbox.xml' }, 'Export collection as rekordbox XML'),
        el('button', { class: 'btn', onclick: () => this.exportUsb([]) }, 'Export playlists to USB…')),
      el('p', { class: 'hint' }, 'The rekordbox XML export (cues, loops, beat grids, playlists) can be imported into rekordbox, Serato (via plugins), Traktor or Mixxx.'),
    );
    const controllers = this.midiPanel();
    const shortcuts = el('div', { class: 'form shortcuts' }, el('table', {}, ...[
      ['Space', 'Play/pause deck 1'], ['Z / X / C', 'Deck 1 cue / play / sync'], ['M / , / .', 'Deck 2 cue / play / sync'],
      ['1 – 4', 'Deck 1 hot cues A–D (Shift = delete)'], ['7 – 0', 'Deck 2 hot cues A–D'], ['Q / W', 'Deck 1 loop 4 / exit'], ['O / P', 'Deck 2 loop 4 / exit'],
      ['← / →', 'Crossfader'], ['↑ / ↓', 'Browser selection'], ['Shift + ← / →', 'Load selected track to deck 1 / 2'],
      ['Ctrl + F', 'Search library'], ['R', 'Start / stop recording'], ['A', 'Automix on/off'], ['Shift (hold)', 'Shift layer (delete cues, set master…)'],
    ].map(([k, d]) => el('tr', {}, el('td', {}, el('kbd', {}, k)), el('td', {}, d)))));

    const tabs = { audio: ['Audio', audio], decks: ['Decks', decks], automix: ['Automix', automix], library: ['Library', library], controllers: ['Controllers', controllers], keys: ['Shortcuts', shortcuts] };
    const tabBar = el('div', { class: 'tabs' });
    const pane = el('div', { class: 'tab-pane' });
    const show = (k) => { pane.replaceChildren(tabs[k][1]); for (const b of tabBar.children) b.classList.toggle('active', b.dataset.k === k); };
    for (const [k, [label]] of Object.entries(tabs)) tabBar.append(el('button', { class: 'tab', 'data-k': k, onclick: () => show(k) }, label));
    show(tab);
    await this.modal('Settings', el('div', {}, tabBar, pane), [{ label: 'Close', primary: true, value: true }], { wide: true });
    app.midi.cancelLearn();
  }

  midiPanel() {
    const midi = this.app.midi;
    const wrap = el('div', { class: 'form' });
    if (midi.unsupported || midi.error) {
      wrap.append(el('p', { class: 'hint' }, midi.error ? `MIDI unavailable: ${midi.error}` : 'Web MIDI is not available in this browser. Use the OpenDJ desktop app, Chrome or Edge.'));
      return wrap;
    }
    const devSel = el('select', { class: 'sel' });
    const monitor = el('div', { class: 'midi-monitor' }, 'Move a control on your controller…');
    const filterIn = el('input', { class: 'inp', type: 'search', placeholder: 'Filter functions…' });
    const clockSel = el('select', { class: 'sel' }, el('option', { value: '' }, 'Off'), ...midi.outputs().map((o) => el('option', { value: o.name }, o.name)));
    clockSel.value = this.app.settings.midiClockOutput || '';
    clockSel.addEventListener('change', () => { midi.setClockOutput(clockSel.value); this.app.setSetting('midiClockOutput', clockSel.value); });
    const table = el('div', { class: 'midi-table' });
    const presetSel = el('select', { class: 'sel' }, el('option', { value: '' }, 'Apply preset…'), ...PRESETS.map((p) => el('option', { value: p.name }, p.name)));
    presetSel.addEventListener('change', () => { if (devSel.value && presetSel.value) { midi.applyPreset(devSel.value, presetSel.value); render(); } presetSel.value = ''; });
    const fillDevices = () => {
      const names = midi.inputs().map((i) => i.name);
      devSel.replaceChildren(...(names.length ? names : ['(no controller connected)']).map((n) => el('option', { value: names.length ? n : '' }, n)));
    };
    const render = () => {
      const dev = devSel.value;
      const map = dev ? midi.mappings[dev] : null;
      const q = filterIn.value.toLowerCase();
      table.replaceChildren(...midi.targets.filter((t) => !q || t.label.toLowerCase().includes(q) || t.id.includes(q)).slice(0, 400).map((t) => {
        const entries = map?.entries.filter((e) => e.target === t.id) || [];
        const learning = midi.learning?.targetId === t.id;
        return el('div', { class: `midi-row ${learning ? 'learning' : ''}` },
          el('span', { class: 'mr-label' }, t.label), el('span', { class: 'mr-kind' }, t.kind),
          el('span', { class: 'mr-map' }, entries.map((e) => describeKey(e.key) + (e.lsbKey ? ' (14-bit)' : '') + (e.invert ? ' ⇅' : '')).join(', ') || '—'),
          el('button', { class: 'btn xs', disabled: !dev, onclick: () => { learning ? midi.cancelLearn() : midi.learn(dev, t.id); render(); } }, learning ? 'Listening…' : 'Learn'),
          entries.length ? el('button', { class: 'btn xs', title: 'Invert', onclick: () => { for (const e of entries) e.invert = !e.invert; midi.save(); render(); } }, '⇅') : null,
          entries.length ? el('button', { class: 'btn xs', title: 'Clear', onclick: () => { map.entries = map.entries.filter((e) => e.target !== t.id); midi.save(); render(); } }, '✕') : null);
      }));
    };
    midi.on('message', (m) => { if (m.device === devSel.value || !devSel.value) monitor.textContent = `${m.device}: ${describeKey(m.key)} = ${m.value}`; });
    midi.on('learning', render); midi.on('devices', () => { fillDevices(); render(); });
    devSel.addEventListener('change', render); filterIn.addEventListener('input', render);
    const fileIn = el('input', { type: 'file', accept: '.json', style: { display: 'none' } });
    fileIn.addEventListener('change', async () => { try { midi.importMapping(devSel.value, await fileIn.files[0].text()); render(); this.app.toast('Mapping imported'); } catch (e) { this.app.toast(e.message); } });
    fillDevices(); render();
    wrap.append(
      el('p', { class: 'hint' }, 'Plug in any MIDI DJ controller. Click "Learn" next to a function, then move the knob / press the button on your controller. 14-bit faders, relative jog wheels and LED feedback are supported.'),
      el('div', { class: 'row' }, devSel, presetSel,
        el('button', { class: 'btn sm', onclick: () => { const blob = new Blob([midi.exportMapping(devSel.value)], { type: 'application/json' }); const a = el('a', { href: URL.createObjectURL(blob), download: `${devSel.value || 'controller'}.opendj-midi.json` }); a.click(); } }, 'Export'),
        el('button', { class: 'btn sm', onclick: () => fileIn.click() }, 'Import'), fileIn),
      el('label', { class: 'field' }, el('span', {}, 'Send MIDI clock (follows the master deck tempo) to'), clockSel),
      monitor, filterIn, table);
    return wrap;
  }
}
