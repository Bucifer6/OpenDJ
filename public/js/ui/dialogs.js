import { el } from '../util.js';
import { api } from '../api.js';
import { THEMES, applyTheme } from './themes.js';
import { controllersPanel } from './controllers-panel.js';

export class Dialogs {
  constructor(app) { this.app = app; }

  modal(title, body, buttons = [], { wide = false } = {}) {
    return new Promise((resolve) => {
      const close = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      // only the top-most dialog reacts to Escape
      const onKey = (e) => {
        if ([...document.querySelectorAll('.overlay')].at(-1) !== overlay) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(null); return; }
        if (e.key === 'Tab') { // keep keyboard focus inside the dialog
          const f = [...box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
          if (!f.length) return;
          const i = f.indexOf(document.activeElement);
          if (e.shiftKey && (i <= 0)) { e.preventDefault(); f.at(-1).focus(); } else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
        }
      };
      const foot = el('div', { class: 'modal-foot' }, ...buttons.map((b) => el('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`, onclick: async () => { if (b.action) { const r = await b.action(); if (r === false) return; close(r ?? b.value); } else close(b.value); } }, b.label)));
      const box = el('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-label': title },
        el('div', { class: 'modal-head' }, el('h2', {}, title), el('button', { class: 'modal-x', onclick: () => close(null), 'aria-label': 'Close' }, '✕')),
        el('div', { class: 'modal-body' }, body), buttons.length ? foot : null);
      const overlay = el('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(null); } }, box);
      document.body.append(overlay);
      document.addEventListener('keydown', onKey);
      setTimeout(() => (box.querySelector('.modal-body input:not([type=checkbox]):not([type=color]), .modal-body select, .modal-body textarea') || box.querySelector('.modal-foot .btn.primary') || box.querySelector('.modal-x'))?.focus(), 30);
    });
  }

  menu(x, y, items) {
    document.querySelector('.ctx-menu')?.remove();
    const build = (list) => el('div', { class: 'ctx-menu' }, ...list.map((it) => {
      if (it === '-') return el('div', { class: 'ctx-sep' });
      const row = el('div', { class: `ctx-item ${it.danger ? 'danger' : ''} ${it.sub ? 'has-sub' : ''}` }, it.label);
      if (it.sub) {
        const sub = build(it.sub); sub.classList.add('ctx-sub'); row.append(sub);
        // keep submenus inside the window (flip left / shift up when they would overflow)
        row.addEventListener('mouseenter', () => {
          sub.style.top = ''; sub.style.left = ''; sub.style.right = '';
          requestAnimationFrame(() => {
            const sr = sub.getBoundingClientRect();
            if (sr.bottom > innerHeight - 8) sub.style.top = `${Math.min(-4, innerHeight - 8 - sr.bottom - 4)}px`;
            if (sr.right > innerWidth - 8) { sub.style.left = 'auto'; sub.style.right = '100%'; }
          });
        });
      }
      else row.addEventListener('click', () => { m.remove(); it.action(); });
      return row;
    }));
    const m = build(items);
    document.body.append(m);
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`; m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
    const close = () => { m.remove(); document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc, true); };
    const off = (e) => { if (!m.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
    setTimeout(() => { document.addEventListener('mousedown', off); document.addEventListener('keydown', esc, true); }, 0);
  }

  async prompt(title, label, value = '') {
    const input = el('input', { class: 'inp', value });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
    let ok;
    const p = this.modal(title, el('label', { class: 'field' }, el('span', {}, label), input), [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, action: () => input.value.trim() }]);
    ok = [...document.querySelectorAll('.overlay')].at(-1)?.querySelector('.modal-foot .btn.primary');
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
      (() => { // hosted web app: sign out
        const box = el('div', { class: 'row' });
        api.authStatus?.().then((st) => { if (st?.enabled && st?.loggedIn !== false) box.append(el('button', { class: 'btn sm', onclick: async () => { await api.logout(); location.href = '/login.html'; } }, 'Sign out')); }).catch(() => {});
        return box;
      })(),
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
    const controllers = controllersPanel(app);
    const shortcuts = el('div', { class: 'form shortcuts' }, el('table', {}, ...[
      ['Space', 'Play/pause deck 1'], ['Z / X / C', 'Deck 1 cue / play / sync'], ['M / , / .', 'Deck 2 cue / play / sync'],
      ['1 – 4', 'Deck 1 hot cues A–D (Shift = delete)'], ['7 – 0', 'Deck 2 hot cues A–D'], ['Q / W', 'Deck 1 loop 4 / exit'], ['O / P', 'Deck 2 loop 4 / exit'],
      ['← / →', 'Crossfader'], ['↑ / ↓', 'Browser selection'], ['Shift + ← / →', 'Load selected track to deck 1 / 2'],
      ['Ctrl + F', 'Search library'], ['R', 'Start / stop recording'], ['A', 'Automix on/off'], ['Shift (hold)', 'Shift layer (delete cues, set master…)'],
    ].map(([k, d]) => el('tr', {}, el('td', {}, el('kbd', {}, k)), el('td', {}, d)))));

    // ---- appearance ----
    const cards = THEMES.map((t) => el('button', { class: `theme-card ${(s.theme || 'midnight') === t.id ? 'active' : ''}`, 'data-id': t.id, onclick: async () => {
      await set('theme', t.id); applyTheme(app.settings);
      for (const c of cards) c.classList.toggle('active', c.dataset.id === t.id);
    } }, el('div', { class: 'theme-swatch' }, ...t.swatch.map((c) => el('span', { style: { background: c } }))), el('b', {}, t.name), el('small', {}, t.desc)));
    const accent = el('input', { type: 'color', value: s.accentColor || '#3ea6ff', title: 'Custom accent colour' });
    accent.addEventListener('input', async () => { await set('accentColor', accent.value); applyTheme(app.settings); });
    const appearance = el('div', { class: 'form' },
      el('div', { class: 'theme-grid' }, ...cards),
      el('div', { class: 'row' }, field('Accent colour', accent), el('button', { class: 'btn sm', onclick: async () => { await set('accentColor', ''); applyTheme(app.settings); } }, 'Use theme accent')),
      field('Interface size', sel(s.uiScale || 100, [80, 90, 100, 110, 125, 150].map((v) => [v, `${v}%`]), async (v) => { await set('uiScale', Number(v)); applyTheme(app.settings); }), 'Shrink for small laptop screens, enlarge for touchscreens and big displays.'),
      field('Waveform colours', sel(s.waveformColors, [['rgb', '3-band RGB'], ['blue', 'Blue'], ['mono', 'Monochrome']], (v) => set('waveformColors', v))),
    );
    const dvsTab = el('div', { class: 'form' }, el('p', { class: 'hint' }, 'Control decks with Serato or Traktor timecode vinyl / CDs through your audio interface inputs.'), el('button', { class: 'btn', onclick: () => import('../dvs/dvs-ui.js').then((m) => m.openDvsPanel(app)) }, 'Open DVS setup…'));
    const tabs = { appearance: ['Appearance', appearance], audio: ['Audio', audio], decks: ['Decks', decks], automix: ['Automix', automix], library: ['Library', library], controllers: ['Controllers', controllers], dvs: ['DVS', dvsTab], keys: ['Shortcuts', shortcuts] };
    const tabBar = el('div', { class: 'tabs' });
    const pane = el('div', { class: 'tab-pane' });
    const show = (k) => { pane.replaceChildren(tabs[k][1]); for (const b of tabBar.children) b.classList.toggle('active', b.dataset.k === k); };
    for (const [k, [label]] of Object.entries(tabs)) tabBar.append(el('button', { class: 'tab', 'data-k': k, onclick: () => show(k) }, label));
    show(tab);
    await this.modal('Settings', el('div', {}, tabBar, pane), [{ label: 'Close', primary: true, value: true }], { wide: true });
    app.midi.cancelLearn();
    controllers.destroy?.();
  }


}
