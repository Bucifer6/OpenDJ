import { icon, glyphIcon } from './icons.js';
import { el, uiZoom } from '../util.js';
import { api } from '../api.js';
import { THEMES, JOG_STYLE_OPTIONS, applyTheme, refreshSkinCatalog, selectedTheme } from './themes.js';
import { controllersPanel } from './controllers-panel.js';
import { platform, MOBILE_UNAVAILABLE, APP_VERSION } from '../platform.js';
import { STYLES, normStyle } from '../automix.js';
import { SET_SHAPES, PRESETS } from '../smartmix.js';

/** Automix modes offered in the start dialog. */
export const AUTOMIX_MODES = [
  ['order', 'Play in this order'],
  ['shuffle', 'Shuffle & mix (random order, still beat-matched)'],
  ['smart', 'Smart mix (order by how well tracks go together)'],
  ['live', 'Smart mix live (pick each next track while playing)'],
];
const MIX_PROFILES = [
  { id: 'club', label: 'Club flow', priority: 'balanced', shape: 'warmup', style: 'phrase', bars: 8, vary: true, keySync: true },
  { id: 'harmonic', label: 'Harmonic journey', priority: 'harmonic', shape: 'steady', style: 'blend', bars: 16, vary: false, keySync: true },
  { id: 'peak', label: 'Peak-time', priority: 'energy', shape: 'peak', style: 'bassswap', bars: 8, vary: true, keySync: true },
  { id: 'open', label: 'Open format', priority: 'variety', shape: 'rising', style: 'crossfade', bars: 8, vary: true, keySync: false },
  { id: 'quick', label: 'Quick cuts', priority: 'variety', shape: 'steady', style: 'cut', bars: 4, vary: false, keySync: false },
];
const BAR_CHOICES = [4, 8, 16, 32];
const styleValue = (s) => (s === 'auto' ? 'auto' : normStyle(s));
let modalSeq = 0;

/** Smart-mix weight controls: preset select + harmonic / energy / variety sliders. Returns { el, value() }. */
function smartControls(am, onChange) {
  const sliders = { ...PRESETS.balanced, ...(am.sliders || {}) };
  const preset = el('select', { class: 'sel', 'data-smart': 'preset' }, ...[['balanced', 'Balanced'], ['harmonic', 'Harmonic first'], ['energy', 'Energy flow first'], ['variety', 'Variety first'], ['custom', 'Custom']].map(([v, l]) => el('option', { value: v }, l)));
  preset.value = am.preset || 'balanced';
  const inputs = {};
  const applyPreset = (name) => {
    const p = PRESETS[name]; if (!p) return;
    preset.value = name;
    for (const k of Object.keys(p)) { sliders[k] = p[k]; inputs[k].value = p[k]; }
    onChange?.();
  };
  const row = (k, label) => {
    const i = el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: sliders[k], 'data-smart': k });
    i.addEventListener('input', () => { sliders[k] = Number(i.value); preset.value = 'custom'; onChange?.(); });
    inputs[k] = i;
    return el('label', { class: 'field' }, el('span', {}, label), i);
  };
  preset.addEventListener('change', () => applyPreset(preset.value));
  const node = el('div', { class: 'form' }, el('label', { class: 'field' }, el('span', {}, 'Track selector priorities'), preset),
    row('harmonic', 'Harmonic compatibility'), row('energy', 'Set energy flow'), row('variety', 'Artist and genre variety'));
  return { el: node, value: () => ({ preset: preset.value, sliders: { ...sliders } }), setPreset: applyPreset };
}

export class Dialogs {
  constructor(app) { this.app = app; }

  /**
   * A dialog. buttons: [{ label, value, primary, danger, cls, action }] (action returning false keeps it open).
   * opts.cls: extra class on the box; opts.footStart: a node at the start of the footer; opts.onOpen({ close, box }).
   */
  modal(title, body, buttons = [], { wide = false, cls = '', footStart = null, onOpen = null } = {}) {
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
      const foot = el('div', { class: 'modal-foot' }, footStart, ...buttons.map((b) => el('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''} ${b.cls || ''}`, onclick: async () => { if (b.action) { const r = await b.action(); if (r === false) return; close(r ?? b.value); } else close(b.value); } }, b.label)));
      const titleId = `modal-title-${++modalSeq}`;
      const box = el('div', { class: `modal ${wide ? 'wide' : ''} ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, 'aria-labelledby': titleId },
        el('div', { class: 'modal-head' }, el('h2', { id: titleId }, title), el('button', { class: 'modal-x', onclick: () => close(null), 'aria-label': 'Close', title: 'Close' }, icon('x'))),
        el('div', { class: 'modal-body' }, body), buttons.length ? foot : null);
      const overlay = el('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(null); } }, box);
      document.body.append(overlay);
      document.addEventListener('keydown', onKey);
      onOpen?.({ close, box });
      setTimeout(() => (box.querySelector('.modal-body input:not([type=checkbox]):not([type=color]), .modal-body select, .modal-body textarea') || box.querySelector('.modal-foot .btn.primary') || box.querySelector('.modal-x'))?.focus(), 30);
    });
  }

  menu(x, y, items) {
    document.querySelector('.ctx-menu')?.remove();
    const build = (list) => el('div', { class: 'ctx-menu' }, ...list.map((it) => {
      if (it === '-') return el('div', { class: 'ctx-sep' });
      // `checked` (true / false): a check icon slot in front of the label (radio / toggle items)
      const row = el('div', { class: `ctx-item ${it.danger ? 'danger' : ''} ${it.sub ? 'has-sub' : ''}`, role: it.checked !== undefined ? 'menuitemcheckbox' : null, 'aria-checked': it.checked !== undefined ? String(!!it.checked) : null },
        it.checked !== undefined ? el('span', { class: 'ctx-check' }, it.checked ? icon('check') : '') : null, it.label);
      if (it.sub) {
        const sub = build(it.sub); sub.classList.add('ctx-sub'); row.append(sub);
        // keep submenus inside the window (flip left / shift up when they would overflow)
        row.addEventListener('mouseenter', () => {
          sub.style.top = ''; sub.style.left = ''; sub.style.right = '';
          requestAnimationFrame(() => {
            const sr = sub.getBoundingClientRect();
            if (sr.bottom > innerHeight - 8) sub.style.top = `${Math.min(-4, innerHeight - 8 - sr.bottom - 4) / uiZoom()}px`;
            if (sr.right > innerWidth - 8) { sub.style.left = 'auto'; sub.style.right = '100%'; }
          });
        });
      }
      else row.addEventListener('click', () => { close(); it.action(); }); // close(): also drops the Esc / outside-click listeners
      return row;
    }));
    const m = build(items);
    document.body.append(m);
    const r = m.getBoundingClientRect();
    const z = uiZoom(); // window px -> zoomed CSS px
    m.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8)) / z}px`; m.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8)) / z}px`;
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
    let cur;
    try { cur = await api.browse(); } catch (e) { this.app.toast(`Cannot browse folders: ${e.message}`); return null; }
    const pathEl = el('input', { class: 'inp', value: cur.path ?? '', placeholder: 'Choose one of the allowed folders below' }); // hosted mode: the roots list has no path
    const list = el('div', { class: 'browse-list' });
    const render = () => {
      pathEl.value = cur.path ?? '';
      list.replaceChildren(
        cur.parent ? el('div', { class: 'browse-item', onclick: async () => { cur = await api.browse(cur.parent); render(); } }, '.. (up)') : null,
        ...cur.entries.map((e) => el('div', { class: 'browse-item', onclick: async () => { try { cur = await api.browse(e.path); render(); } catch (err) { this.app.toast(err.message); } } }, '🗀 ' + e.name)));
    };
    pathEl.addEventListener('change', async () => { try { cur = await api.browse(pathEl.value); render(); } catch (e) { this.app.toast(e.message); } });
    render();
    return this.modal(title, el('div', {}, pathEl, list), [{ label: 'Cancel', value: null }, { label: 'Select this folder', primary: true, action: () => cur.path }]);
  }

  async addFolder() {
    if (platform.local) { this.app.toast(MOBILE_UNAVAILABLE.folders); return this.app.upload?.pick?.(); } // phones: import instead
    const drives = await api.drives().catch(() => []);
    const pathIn = el('input', { class: 'inp', placeholder: '/media/usb  ·  /Volumes/NAS/Music  ·  \\\\nas\\music  ·  D:\\Music' });
    const nameIn = el('input', { class: 'inp', placeholder: 'Display name (optional)' });
    const body = el('div', { class: 'form' },
      el('p', { class: 'hint' }, 'Add any folder: internal disk, USB stick, external drive or a NAS share. NAS shares must be mounted by your operating system (SMB/NFS/AFP) or reachable by a network path. The folder is scanned now and can be rescanned anytime.'),
      drives.length ? el('div', { class: 'drive-grid' }, ...drives.map((d) => el('button', { class: 'drive-card', onclick: () => { pathIn.value = d.path; nameIn.value = d.name; } },
        el('div', { class: 'drive-icon' }, glyphIcon(d.kind === 'network' ? '🖧' : d.kind === 'home' ? '⌂' : '⛁')), el('div', {}, d.name), el('small', {}, d.kind === 'network' ? `NAS · ${d.fs}` : d.kind === 'home' ? 'Home' : 'Drive')))) : null,
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
        if (f.type === 'checkbox') {
          const cb = el('input', { type: 'checkbox', checked: !!existing?.[f.name] });
          inputs[f.name] = cb;
          return el('label', { class: 'check' }, cb, ` ${f.label}`, f.help ? el('small', { class: 'hint' }, ` ${f.help}`) : null);
        }
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
        for (const [k, inp] of Object.entries(inputs)) {
          if (inp.type === 'checkbox') cfg[k] = inp.checked;
          else if (inp.value.trim()) cfg[k] = inp.value.trim();
        }
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
      el('div', { class: 'drive-grid' }, ...drives.filter((d) => d.kind !== 'home').map((d) => el('button', { class: 'drive-card', onclick: () => { target.value = d.path; } }, el('div', { class: 'drive-icon' }, glyphIcon('⛁')), el('div', {}, d.name)))),
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

  /**
   * Start automix on a list of tracks. opts.mode preselects 'order' | 'shuffle' | 'smart' | 'live'; opts.title names
   * the source (playlist name). Smart modes analyse unanalysed tracks first where possible.
   */
  async automixQueue(tracks, { mode, title } = {}) {
    if (!tracks?.length) return this.app.toast('No tracks in this view');
    const o = this.app.settings.automix;
    const modeSel = el('select', { class: 'sel', 'data-am': 'mode' }, ...AUTOMIX_MODES.map(([v, l]) => el('option', { value: v }, l)));
    modeSel.value = mode || (o.shuffle ? 'shuffle' : 'smart');
    const style = el('select', { class: 'sel', 'data-am': 'style' }, ...STYLES.map(([v, l]) => el('option', { value: v }, l)));
    style.value = styleValue(o.style);
    const shape = el('select', { class: 'sel', 'data-am': 'shape' }, ...SET_SHAPES.map(([v, l]) => el('option', { value: v }, l)));
    shape.value = o.shape || 'warmup';
    const keySync = el('input', { type: 'checkbox', checked: !!o.keySync });
    const vary = el('input', { type: 'checkbox', checked: !!o.varyStyles, 'data-am': 'vary' });
    const smartStart = el('input', { type: 'checkbox', checked: o.smartStart !== false });
    const bars = el('select', { class: 'sel', 'data-am': 'bars' }, ...BAR_CHOICES.map((b) => el('option', { value: b }, `${b} bars`)));
    bars.value = String(BAR_CHOICES.reduce((a, b) => (Math.abs(b * 4 - o.transitionBeats) < Math.abs(a * 4 - o.transitionBeats) ? b : a), 8));
    const big = tracks.length > 200;
    const limit = el('input', { class: 'inp', type: 'number', min: 2, max: tracks.length, value: big ? 40 : tracks.length, 'data-am': 'limit' });
    const smartBox = smartControls(o);
    const profile = el('select', { class: 'sel', 'data-am': 'profile' },
      el('option', { value: 'custom' }, 'Custom settings'), ...MIX_PROFILES.map((p) => el('option', { value: p.id }, p.label)));
    profile.value = MIX_PROFILES.some((p) => p.id === o.profile) ? o.profile : 'custom';
    let applyingProfile = false;
    const markCustom = () => { if (!applyingProfile) profile.value = 'custom'; };
    for (const control of [modeSel, style, shape, keySync, vary, smartStart, bars]) control.addEventListener('change', markCustom);
    const applyProfile = (id) => {
      const p = MIX_PROFILES.find((x) => x.id === id);
      if (!p) return;
      applyingProfile = true;
      modeSel.value = 'smart'; shape.value = p.shape; style.value = p.style; bars.value = String(p.bars);
      vary.checked = p.vary; keySync.checked = p.keySync; smartStart.checked = true; smartBox.setPreset(p.priority);
      profile.value = p.id; applyingProfile = false;
    };
    profile.addEventListener('change', () => applyProfile(profile.value));
    const smartPart = el('div', { class: 'form' }, el('label', { class: 'field' }, el('span', {}, 'Set shape'), shape),
      el('label', { class: 'field' }, el('span', {}, 'Tracks in the set'), limit), smartBox.el);
    const showSmart = () => { smartPart.hidden = !['smart', 'live'].includes(modeSel.value); };
    modeSel.addEventListener('change', showSmart); showSmart();
    const body = el('div', { class: 'form' },
      el('p', {}, `Auto-mix ${tracks.length} tracks${title ? ` from "${title}"` : ''} on decks 1 & 2 with beat-matched transitions.`),
      el('label', { class: 'field' }, el('span', {}, 'Mix profile'), profile),
      el('label', { class: 'field' }, el('span', {}, 'Order'), modeSel),
      smartPart,
      el('label', { class: 'field' }, el('span', {}, 'Transition style'), style),
      el('label', { class: 'field' }, el('span', {}, 'Transition length'), bars),
      el('label', { class: 'check' }, smartStart, ' Start at the best analysed phrase'),
      el('label', { class: 'check' }, vary, ' Vary transition styles'),
      el('label', { class: 'check' }, keySync, ' Fix key clashes with Key Sync'));
    const native = window.opendjNative;
    const model = el('input', { class: 'inp', placeholder: 'Installed Ollama model', value: localStorage.getItem('dj-model') || '' });
    const voice = el('select', { class: 'sel' }, ...[['off','Off'],['en','English'],['ro','Romanian']].map(([value,label]) => el('option',{value},label)));
    if (native?.planSet) {
      modeSel.append(el('option',{value:'local'},'Local AI (Ollama)'));
      const settings = el('div',{class:'form'}, el('label',{class:'field'},'Model',model), el('label',{class:'field'},'Spoken introduction',voice));
      settings.hidden = true;
      modeSel.addEventListener('change', () => { settings.hidden = modeSel.value !== 'local'; });
      profile.addEventListener('change', () => { settings.hidden = modeSel.value !== 'local'; });
      body.append(settings);
    }
    const r = await this.modal('Automix', body, [{ label: 'Cancel', value: null }, { label: 'Start automix', primary: true, value: true }]);
    if (!r) return;
    if (modeSel.value === 'local') {
      const candidates = tracks.slice(0,60);
      try {
        localStorage.setItem('dj-model',model.value.trim());
        this.app.toast('Planning your set with Ollama…');
        const plan = await native.planSet({model:model.value.trim(),language:voice.value,tracks:candidates.map(({title,artist,bpm,key,energy})=>({title,artist,bpm,key,energy}))});
        tracks = [...plan.order.map(i=>candidates[i]), ...tracks.slice(60)];
        modeSel.value = 'order';
        if (voice.value !== 'off' && window.speechSynthesis && plan.intro) {
          const line = new SpeechSynthesisUtterance(plan.intro);
          line.lang = voice.value === 'ro' ? 'ro-RO' : 'en-GB';
          window.speechSynthesis.speak(line);
        }
      } catch (error) { this.app.toast('Local DJ: ' + error.message); return; }
    }
    const sm = smartBox.value();
    await this.app.setSetting('automix', { ...o, style: style.value, transitionBeats: Number(bars.value) * 4, keySync: keySync.checked,
      varyStyles: vary.checked, shape: shape.value, preset: sm.preset, sliders: sm.sliders,
      shuffle: modeSel.value === 'shuffle', smartStart: smartStart.checked, profile: profile.value });
    return this.app.startAutomix(tracks, { mode: modeSel.value, shape: shape.value, sliders: sm.sliders, limit: Number(limit.value) || undefined });
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
    // phones / tablets: no output device choice in the WebView (the system routes to speaker, headphones, Bluetooth, USB)
    const sinks = !platform.native && ('setSinkId' in (window.AudioContext?.prototype || {}) || 'setSinkId' in HTMLMediaElement.prototype);
    const audio = el('div', { class: 'form' },
      sinks ? null : el('p', { class: 'hint' }, 'Audio plays through the output the system uses (speaker, headphones, Bluetooth or a USB audio interface). For a headphone cue on one jack, use "Split cue" with a Y splitter cable.'),
      !sinks ? null : field('Master output', sel(s.masterDeviceId || 'default', outOpts, async (v) => { await set('masterDeviceId', v); app.engine.applyOutputs(); })),
      field('Headphone (cue) routing', sel(s.cueMode, [['device', 'Separate sound card / output'], ['channels34', 'Same interface, channels 3-4 (DJ controller sound card)'], ['split', 'Split cue: master mono left, cue mono right (single stereo jack)']], async (v) => { await set('cueMode', v); app.engine.applyOutputs(); }),
        'Most DJ controllers with a built-in sound card expose 4 channels: choose "channels 3-4" and select the controller as master output.'),
      !sinks ? null : field('Headphone output (separate device mode)', sel(s.cueDeviceId || '', [['', '— none —'], ...outOpts.filter(([v]) => v !== 'default')], async (v) => { await set('cueDeviceId', v); app.engine.applyOutputs(); })),
      !sinks ? null : el('button', { class: 'btn sm', onclick: async () => { try { const st = await navigator.mediaDevices.getUserMedia({ audio: true }); st.getTracks().forEach((t) => t.stop()); this.app.toast('Device names unlocked — reopen settings'); } catch (e) { this.app.toast(e.message); } } }, 'Show device names (asks for permission)'),
      field('Microphone / aux input', sel(s.micDeviceId || '', [['', 'System default input'], ...inputs.map((d) => [d.id, d.label])], async (v) => { await set('micDeviceId', v); if (app.engine.micOn) { await app.engine.setMic(false); await app.engine.setMic(true); } })),
      field('Talkover ducking', sel(s.talkoverDb ?? -12, [[-6, '−6 dB'], [-12, '−12 dB'], [-18, '−18 dB'], [-24, '−24 dB']], (v) => set('talkoverDb', Number(v)))),
      field('Audio latency', sel(s.latencyHint || 'interactive', [['interactive', 'Lowest (interactive)'], ['10', '10 ms'], ['20', '20 ms'], ['balanced', 'Balanced'], ['playback', 'Safe (high latency, no dropouts)']], (v) => { set('latencyHint', v); this.app.toast('Restart OpenDJ to apply the new latency'); }),
        'Raise this if you hear crackles; lower it for tighter scratching and cueing.'),
      el('label', { class: 'check' }, chk(s.limiter, (v) => { set('limiter', v); app.engine.setLimiter(v); }), ' Master limiter (prevents clipping)'),
      el('label', { class: 'check', title: 'On: echo and reverb tails keep ringing when you pull the channel fader down or crossfade away (echo-outs), like a club mixer. Off: the beat FX sit before the fader, so the fader cuts the tail too.' }, chk(s.fxPostFader !== false, (v) => { set('fxPostFader', v); app.engine.setFxPostFader(v); }), ' Beat FX tails ring out after the channel fader closes (post-fader FX)'),
      el('label', { class: 'check' }, chk(s.highPrecisionAudio, (v) => { set('highPrecisionAudio', v); this.app.toast('Applies to tracks loaded from now on'); }), ' High-precision deck audio (32-bit float; uses twice the memory per loaded track)'),
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
    const amSet = (patch) => set('automix', { ...app.settings.automix, ...patch });
    const amSmart = smartControls(am, () => amSet(amSmart.value()));
    const automix = el('div', { class: 'form' },
      field('Default transition style', sel(styleValue(am.style), STYLES, (v) => amSet({ style: v })), 'Auto picks a style per transition from the BPM difference, energy change, key and genre. You can override single transitions in the automix queue.'),
      field('Transition length', sel(BAR_CHOICES.reduce((a, b) => (Math.abs(b * 4 - am.transitionBeats) < Math.abs(a * 4 - am.transitionBeats) ? b : a), 8), BAR_CHOICES.map((b) => [b, `${b} bars`]), (v) => amSet({ transitionBeats: Number(v) * 4 }))),
      el('label', { class: 'check' }, chk(am.varyStyles, (v) => amSet({ varyStyles: v })), ' Vary styles (alternate between styles that suit each transition)'),
      el('label', { class: 'check' }, chk(am.keepSync, (v) => amSet({ keepSync: v })), ' Beat-match transitions'),
      el('label', { class: 'check' }, chk(am.skipSilence, (v) => amSet({ skipSilence: v })), ' Skip silence at track ends'),
      el('label', { class: 'check' }, chk(am.shuffle, (v) => amSet({ shuffle: v })), ' Shuffle'),
      el('label', { class: 'check' }, chk(am.keySync, (v) => amSet({ keySync: v })), ' Fix key clashes with Key Sync'),
      el('label', { class: 'check' }, chk(am.restoreTempo !== false, (v) => amSet({ restoreTempo: v })), ' Ease each track back to its original tempo after the transition'),
      field('Loading a track on the deck automix is playing', sel(am.onAirLoad || 'ask', [['ask', 'Ask'], ['queue', 'Play it next'], ['stop', 'Stop automix and load it']], (v) => amSet({ onAirLoad: v })), 'Loading on the other deck always makes the track the next one; during a transition it is queued next.'),
      field('Smart mix set shape', sel(am.shape || 'warmup', SET_SHAPES, (v) => amSet({ shape: v }))),
      amSmart.el,
    );
    const dlIn = el('input', { class: 'inp', value: s.downloadDir });
    dlIn.addEventListener('change', () => set('downloadDir', dlIn.value));
    const rbIn = el('input', { class: 'inp', placeholder: 'Path to rekordbox.xml (File → Export Collection in xml format)' });
    const m3uIn = el('input', { class: 'inp', placeholder: 'Path to .m3u / .m3u8 playlist' });
    const library = platform.local ? this.localLibrarySettings(chk) : el('div', { class: 'form' },
      field('Download folder (for tracks from media servers)', el('div', { class: 'row' }, dlIn, el('button', { class: 'btn', onclick: async () => { const p = await this.pickFolder('Download folder'); if (p) { dlIn.value = p; set('downloadDir', p); } } }, 'Browse…'))),
      el('label', { class: 'check' }, chk(s.autoAnalyse !== false, (v) => { set('autoAnalyse', v); if (v) app.analyser?.autoQueue({ afterScan: true }); else app.analyser?.cancel(); }), ' Analyse new tracks in the background (BPM, key, waveform, cues)'),
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
    const controllers = platform.local ? null : controllersPanel(app);
    // ---- Controller Mapper: public/controller-mapper.html in a frame, themed like the app (see tools/controller-mapper) ----
    let mapperFrame = null;
    const mapperHost = el('div', { class: 'mapper-host' });
    const mapperPane = platform.local ? null : el('div', { class: 'form mapper-pane' },
      el('div', { class: 'row mapper-intro' },
        el('p', { class: 'hint' }, 'Test and fix every control of your controller, load the community mapping for it, and share your mapping or fix with everyone. "Apply to OpenDJ" uses your changes right away.'),
        el('label', { class: 'check', title: 'When a controller without a mapping is plugged in, look it up in the OpenDJ community list and the Mixxx mapping library on GitHub' },
          chk(s.controllerLookup !== false, (v) => app.setSetting('controllerLookup', v)), ' Recognise new controllers online')),
      mapperHost);
    const loadMapper = () => {
      const dev = app.midi.mapperDevice || '', q = new URLSearchParams();
      if (dev) q.set('device', dev);
      if (app.midi.mapperPick) q.set('pick', '1');
      app.midi.mapperPick = false;
      mapperFrame = el('iframe', { class: 'mapper-frame', title: 'Controller Mapper', allow: 'midi', src: `controller-mapper.html${q.size ? `?${q}` : ''}` });
      mapperHost.replaceChildren(mapperFrame);
      app.midi.attachMapper(mapperFrame.contentWindow);
    };
    const shortcuts = el('div', { class: 'form shortcuts' }, el('table', {}, ...[
      ['Space', 'Play/pause deck 1'], ['Z / X / C', 'Deck 1 cue / play / sync'], ['M / , / .', 'Deck 2 cue / play / sync'],
      ['1 – 4', 'Deck 1 hot cues A–D (Shift = delete)'], ['7 – 0', 'Deck 2 hot cues A–D'], ['Q / W', 'Deck 1 loop 4 / exit'], ['O / P', 'Deck 2 loop 4 / exit'],
      ['← / →', 'Crossfader'], ['↑ / ↓', 'Browser selection'], ['Shift + ← / →', 'Load selected track to deck 1 / 2'],
      ['Ctrl + F', 'Search library'], ['R', 'Start / stop recording'], ['A', 'Automix on/off'], ['Shift (hold)', 'Shift layer (delete cues, set master…)'],
    ].map(([k, d]) => el('tr', {}, el('td', {}, el('kbd', {}, k)), el('td', {}, d)))));

    // ---- appearance ----
    let cards = [];
    const themeGrid = el('div', { class: 'theme-grid' });
    const jogStyle = sel('theme', JOG_STYLE_OPTIONS, async (value) => {
      const { id } = selectedTheme(app.settings);
      await set('jogStyles', { ...app.settings.jogStyles, [id]: value });
      applyTheme(app.settings);
      syncJogStyle();
    });
    const syncJogStyle = () => {
      const { id, jogStyle: suggested = 'brushed' } = selectedTheme(app.settings);
      const label = JOG_STYLE_OPTIONS.find(([value]) => value === suggested)[1];
      jogStyle.options[0].textContent = `Skin default (${label})`;
      jogStyle.value = app.settings.jogStyles?.[id] || 'theme';
    };
    const renderThemeCards = () => {
      const activeId = selectedTheme(app.settings).id;
      cards = THEMES.map((t) => el('button', { class: `theme-card${activeId === t.id ? ' active' : ''}`, 'aria-pressed': String(activeId === t.id), 'data-id': t.id, onclick: async () => {
        await set('theme', t.id); applyTheme(app.settings);
        for (const c of cards) {
          c.classList.toggle('active', c.dataset.id === t.id);
          c.setAttribute('aria-pressed', String(c.dataset.id === t.id));
        }
        syncJogStyle();
      } }, el('div', { class: 'theme-swatch' }, ...t.swatch.map((c) => el('span', { style: { background: c } }))), el('b', {}, t.name), el('small', {}, t.desc)));
      themeGrid.replaceChildren(...cards);
      syncJogStyle();
    };
    renderThemeCards();
    const skinUpdateStatus = el('span', { class: 'hint' });
    const skinUpdateButton = el('button', { class: 'btn sm', onclick: async () => {
      skinUpdateButton.disabled = true; skinUpdateButton.textContent = 'Checking…'; skinUpdateStatus.textContent = '';
      try {
        const result = await refreshSkinCatalog();
        renderThemeCards(); applyTheme(app.settings);
        skinUpdateStatus.textContent = `${result.count} skin(s) available (catalogue v${result.version}).`;
      } catch (e) { skinUpdateStatus.textContent = `Could not check for skins: ${e.message}`; }
      finally { skinUpdateButton.disabled = false; skinUpdateButton.textContent = 'Check for skin updates'; }
    } }, 'Check for skin updates');
    const accent = el('input', { type: 'color', value: s.accentColor || '#3ea6ff', title: 'Custom accent colour' });
    accent.addEventListener('input', async () => { await set('accentColor', accent.value); applyTheme(app.settings); });
    // the size is capped so the effective window stays at least 1100x700: say so instead of silently ignoring it
    const scaleNoteEl = el('p', { class: 'hint scale-note' });
    const scaleNote = () => {
      const want = app.settings.uiScale || 100, eff = Math.round(uiZoom() * 100);
      scaleNoteEl.textContent = eff < want ? `Limited to ${eff}% at this window size (the layout needs at least 1100 × 700 points); enlarge the window to use ${want}%.` : '';
    };
    scaleNote();
    const appearance = el('div', { class: 'form' },
      field('Jog wheel style', jogStyle, 'Saved separately for each skin.'),
      themeGrid,
      el('div', { class: 'row' }, skinUpdateButton, skinUpdateStatus),
      el('p', { class: 'hint' }, 'Download new and updated skins without installing a new OpenDJ release.'),
      el('div', { class: 'row' }, field('Accent colour', accent), el('button', { class: 'btn sm', onclick: async () => { await set('accentColor', ''); applyTheme(app.settings); } }, 'Use theme accent')),
      field('Interface size', sel(s.uiScale || 100, [80, 90, 100, 110, 125, 150].map((v) => [v, `${v}%`]), async (v) => { await set('uiScale', Number(v)); applyTheme(app.settings); scaleNote(); }), 'Shrink for small laptop screens, enlarge for touchscreens and big displays.'),
      scaleNoteEl,
      field('Waveform colours', sel(s.waveformColors, [['rgb', '3-band RGB'], ['blue', 'Blue'], ['mono', 'Monochrome']], (v) => set('waveformColors', v))),
    );
    const dvsTab = el('div', { class: 'form' }, el('p', { class: 'hint' }, 'Control decks with Serato or Traktor timecode vinyl / CDs through your audio interface inputs.'), el('button', { class: 'btn', onclick: () => import('../dvs/dvs-ui.js').then((m) => m.openDvsPanel(app)) }, 'Open DVS setup…'));
    const about = this.aboutPane(chk);
    const tabs = platform.local
      ? { appearance: ['Appearance', appearance], audio: ['Audio', audio], decks: ['Decks', decks], automix: ['Automix', automix], library: ['Library', library], mobile: ['Mobile', this.mobileInfo()], about: ['About', about] }
      : { appearance: ['Appearance', appearance], audio: ['Audio', audio], decks: ['Decks', decks], automix: ['Automix', automix], library: ['Library', library], controllers: ['Controllers', controllers], mapper: ['Controller Mapper', mapperPane], dvs: ['DVS', dvsTab], keys: ['Shortcuts', shortcuts], about: ['About', about] };
    if (!tabs[tab]) tab = 'audio';
    const tabBar = el('div', { class: 'tabs' });
    const pane = el('div', { class: 'tab-pane' });
    const show = (k, reload = false) => {
      const wasMapper = pane.firstChild === mapperPane;
      pane.replaceChildren(tabs[k][1]);
      for (const b of tabBar.children) b.classList.toggle('active', b.dataset.k === k);
      pane.closest('.modal')?.classList.toggle('mapper-wide', k === 'mapper');
      if (k === 'mapper' && (reload || !wasMapper || !mapperFrame)) loadMapper(); // moving a frame in the DOM reloads it anyway
      else if (k !== 'mapper') { app.midi.attachMapper(null); mapperFrame = null; mapperHost.replaceChildren(); }
    };
    for (const [k, [label]] of Object.entries(tabs)) tabBar.append(el('button', { class: 'tab', 'data-k': k, onclick: () => show(k) }, label));
    const offOpenMapper = app.midi.on?.('open-mapper', () => tabs.mapper && show('mapper', true));
    const body = el('div', {}, tabBar, pane);
    queueMicrotask(() => show(tab));
    await this.modal('Settings', body, [{ label: 'Close', primary: true, value: true }], { wide: true });
    offOpenMapper?.();
    app.midi.attachMapper(null);
    app.midi.cancelLearn();
    controllers?.destroy?.();
  }

  /** Settings → Library in the mobile app (no folders: import, rekordbox / M3U, exports through the share sheet). */
  localLibrarySettings(chk) {
    const app = this.app, s = app.settings;
    const storage = el('p', { class: 'hint' });
    api.capabilities().then((c) => { const st = c.storage; if (st?.used != null) storage.textContent = `App storage: ${(st.used / 1048576).toFixed(0)} MB used${st.quota ? ` of ${(st.quota / 1073741824).toFixed(1)} GB available to OpenDJ` : ''}.`; }).catch(() => {});
    return el('div', { class: 'form' },
      el('label', { class: 'check' }, chk(s.autoAnalyse !== false, (v) => { app.setSetting('autoAnalyse', v); if (v) app.analyser?.autoQueue({ afterScan: true }); else app.analyser?.cancel(); }), ' Analyse new tracks in the background (BPM, key, waveform, cues)'),
      el('h3', {}, 'Import'),
      el('p', { class: 'hint' }, 'Import copies music into OpenDJ, so it plays offline. The originals stay where they are.'),
      el('div', { class: 'row' },
        el('button', { class: 'btn sm', onclick: () => app.upload?.pick?.() }, '＋ Import music…'),
        el('button', { class: 'btn sm', onclick: () => app.library.dlg.importFrom('rekordbox') }, 'Import rekordbox XML…'),
        el('button', { class: 'btn sm', onclick: () => app.library.dlg.importFrom('m3u') }, 'Import M3U…')),
      el('h3', {}, 'Export'),
      el('div', { class: 'row' },
        el('a', { class: 'btn sm', href: api.rekordboxExportUrl(), download: 'opendj-rekordbox.xml' }, 'Collection as rekordbox XML'),
        el('button', { class: 'btn sm', onclick: () => app.library.dlg.backup() }, 'Back up library')),
      el('p', { class: 'hint' }, platform.native ? 'Exports open the share sheet: save to Files, send to your computer or a cloud drive.' : 'Exports are downloaded.'),
      storage);
  }

  /** Settings → About: version, automatic update checks and "Check now". */
  aboutPane(chk) {
    const app = this.app;
    const status = el('span', { class: 'hint upd-check-status', role: 'status', 'aria-live': 'polite' });
    const btn = el('button', { class: 'btn sm upd-check-now', onclick: async () => {
      btn.disabled = true; status.textContent = 'Checking…';
      const r = await app.updates?.check({ manual: true });
      btn.disabled = false;
      if (!r || r.error) status.textContent = r?.error === 'rate-limited' ? 'GitHub is limiting requests right now. Try again later.' : 'Couldn’t check for updates. Check your internet connection and try again.';
      else if (r.available && r.latest) status.textContent = `OpenDJ ${r.latest.version} is available.`;
      else status.textContent = `You’re up to date (${r.current || APP_VERSION}).`;
    } }, icon('refresh'), 'Check now');
    const who = platform.local ? 'OpenDJ' : 'The OpenDJ server';
    return el('div', { class: 'form about-pane' },
      el('div', { class: 'about-head' }, el('b', {}, 'OpenDJ'), el('span', { class: 'about-ver' }, APP_VERSION)),
      el('p', { class: 'hint' }, 'Free, open-source DJ software.'),
      el('h3', {}, 'Updates'),
      el('label', { class: 'check' }, chk(app.settings.updateCheck !== false, (v) => { app.setSetting('updateCheck', v); app.updates?.setAuto(v); }), ' Check for updates automatically'),
      el('div', { class: 'row upd-check-row' }, btn, status),
      el('p', { class: 'hint' }, `${who} asks GitHub (api.github.com) for the latest OpenDJ release at startup and every 12 hours. The request only says “OpenDJ/${APP_VERSION}”: nothing about you, your music or your settings is sent. Nothing is installed without your OK.`));
  }

  /** Settings → Mobile: what the mobile app does differently, and why some features are hidden. */
  mobileInfo() {
    const names = { folders: 'Library folders', midi: 'MIDI controllers', dvs: 'DVS (timecode vinyl)', lighting: 'Lighting (DMX / Art-Net / sACN / OSC)', link: 'Ableton Link', broadcast: 'Live streaming', cdj: 'CDJ USB export', stems: 'AI stems', video: 'Video mixer', otherImports: 'Traktor / Serato / VirtualDJ import' };
    return el('div', { class: 'form mobile-info' },
      el('p', {}, 'OpenDJ runs completely on this device: your library, analysis, mixing, playlists and recordings need no computer or server.'),
      el('h3', {}, 'Not available in the mobile app yet'),
      el('ul', { class: 'unavail-list' }, ...Object.entries(names).map(([k, n]) => el('li', {}, el('b', {}, n), ' — ', MOBILE_UNAVAILABLE[k]))),
      el('p', { class: 'hint' }, `OpenDJ ${APP_VERSION}${platform.native ? ` (${platform.os})` : ' (browser, on-device mode)'}`));
  }


}
