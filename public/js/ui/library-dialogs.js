// Library & prep dialogs: track info editor, smart playlist builder, importers, relocate, duplicates, backup/restore.
import { el } from '../util.js';
import { icon } from './icons.js';
import { openCdjExport } from '../cdj/export-dialog.js';
import { api } from '../api.js';
import { platform, unavailable } from '../platform.js';

// rekordbox's 8 track colour labels (tracks store the hex value).
export const TRACK_COLORS = [
  ['#ff007f', 'Pink'], ['#ff0000', 'Red'], ['#ffa500', 'Orange'], ['#ffff00', 'Yellow'],
  ['#00ff00', 'Green'], ['#25fde9', 'Aqua'], ['#0000ff', 'Blue'], ['#660099', 'Purple'],
];
export const colorName = (hex) => TRACK_COLORS.find(([h]) => h === String(hex || '').toLowerCase())?.[1] || '';

const field = (label, ctrl, cls = '') => el('label', { class: `field ${cls}` }, el('span', {}, label), ctrl);
const download = (url) => { const a = el('a', { href: url, download: '' }); document.body.append(a); a.click(); a.remove(); };

/** Open sub-menus to the left when the context menu sits near the right edge of the window. */
export function flipSubmenus() {
  const m = document.querySelector('body > .ctx-menu');
  if (m && m.getBoundingClientRect().right + 230 > innerWidth) m.classList.add('flip-sub');
}

export class LibraryDialogs {
  constructor(app, lib) { this.app = app; this.lib = lib; this._fields = null; }
  get dialogs() { return this.app.dialogs; }
  toast(m) { this.app.toast(m); }

  allTags() {
    const counts = new Map();
    for (const t of this.lib.tracks.values()) for (const tag of t.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }

  // ---------------------------------------------------------------- track info editor
  async editTracks(tracks) {
    tracks = tracks.filter(Boolean);
    if (!tracks.length) return;
    const multi = tracks.length > 1;
    const dirty = new Set();
    const common = (k, fmt = (v) => v) => {
      const vals = tracks.map((t) => fmt(t[k]));
      return vals.every((v) => JSON.stringify(v) === JSON.stringify(vals[0])) ? { value: vals[0], mixed: false } : { value: '', mixed: true };
    };
    const input = (k, { type = 'text', fmt, step } = {}) => {
      const c = common(k, fmt);
      const inp = el('input', { class: 'inp', type, step, value: c.value ?? '', placeholder: c.mixed ? '(multiple values)' : '' });
      inp.addEventListener('input', () => dirty.add(k));
      return inp;
    };
    const ins = {
      title: input('title'), artist: input('artist'), album: input('album'), genre: input('genre'),
      year: input('year', { type: 'number' }), bpm: input('bpm', { type: 'number', step: '0.01', fmt: (v) => (v ? Math.round(v * 100) / 100 : '') }),
      key: input('key'),
    };
    ins.key.placeholder = ins.key.placeholder || '8A, Am, F#m…';
    const commentC = common('comment');
    const comment = el('textarea', { class: 'inp le-comment', rows: 2, placeholder: commentC.mixed ? '(multiple values)' : '' });
    comment.value = commentC.value || '';
    comment.addEventListener('input', () => dirty.add('comment'));

    // rating
    let rating = common('rating', (v) => v || 0);
    const stars = el('div', { class: 'le-stars' });
    const renderStars = () => stars.replaceChildren(...[1, 2, 3, 4, 5].map((s) => el('span', {
      class: !rating.mixed && s <= rating.value ? 'on' : '', title: `${s} star${s > 1 ? 's' : ''}`,
      onclick: () => { rating = { value: rating.value === s && !rating.mixed ? 0 : s, mixed: false }; dirty.add('rating'); renderStars(); },
    }, '★')), ...(rating.mixed ? [el('small', { class: 'hint' }, ' (mixed)')] : []));
    renderStars();

    // colour
    let color = common('color', (v) => v || '');
    const swatches = el('div', { class: 'le-swatches' });
    const renderSw = () => swatches.replaceChildren(
      el('button', { class: `le-sw none ${!color.mixed && !color.value ? 'on' : ''}`, title: 'No colour', type: 'button', onclick: () => { color = { value: '', mixed: false }; dirty.add('color'); renderSw(); } }, '⊘'),
      ...TRACK_COLORS.map(([hex, name]) => el('button', {
        class: `le-sw ${!color.mixed && color.value === hex ? 'on' : ''}`, title: name, type: 'button', style: { background: hex },
        onclick: () => { color = { value: hex, mixed: false }; dirty.add('color'); renderSw(); },
      })));
    renderSw();

    // tags
    const tagsC = common('tags', (v) => (v || []).join(', '));
    const tagsIn = el('input', { class: 'inp', value: tagsC.value, placeholder: tagsC.mixed ? '(multiple values — typing replaces them)' : 'e.g. Warmup, Vocal, Peak time' });
    tagsIn.addEventListener('input', () => { dirty.add('tags'); renderSugg(); });
    const sugg = el('div', { class: 'le-tag-sugg' });
    const known = this.allTags();
    const renderSugg = () => {
      const cur = tagsIn.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      let partial = (tagsIn.value.split(',').at(-1) || '').trim().toLowerCase();
      if (known.some((k) => k.toLowerCase() === partial)) partial = '';
      const list = known.filter((t) => !cur.includes(t.toLowerCase()) && (!partial || t.toLowerCase().includes(partial))).slice(0, 14);
      sugg.replaceChildren(...list.map((t) => el('button', {
        class: 'tag-chip', type: 'button', onclick: () => {
          const parts = tagsIn.value.split(',').map((s) => s.trim()).filter(Boolean);
          if (partial && parts.length && t.toLowerCase().includes(parts.at(-1).toLowerCase()) && !known.some((k) => k.toLowerCase() === parts.at(-1).toLowerCase())) parts.pop();
          parts.push(t); tagsIn.value = parts.join(', ') + ', '; dirty.add('tags'); renderSugg(); tagsIn.focus();
        },
      }, '+ ' + t)));
    };
    renderSugg();

    const t0 = tracks[0];
    const body = el('div', { class: 'form le-form' },
      multi ? el('p', { class: 'hint' }, `Editing ${tracks.length} tracks. Only the fields you change are applied to all of them.`)
        : el('p', { class: 'hint le-path', title: t0.localPath || t0.path || '' }, t0.missing ? `⚠ File missing: ${t0.path}` : (t0.localPath || t0.path || t0.sourceKind || '')),
      el('div', { class: 'le-grid' },
        field('Title', ins.title, 'span2'), field('Artist', ins.artist, 'span2'),
        field('Album', ins.album, 'span2'), field('Genre', ins.genre),
        field('Year', ins.year), field('BPM', ins.bpm), field('Key', ins.key),
        field('Rating', stars), field('Colour', swatches, 'span3'),
        field('My Tags (comma separated)', el('div', {}, tagsIn, sugg), 'span4'),
        field('Comment', comment, 'span4')));

    const r = await this.dialogs.modal(multi ? `Edit ${tracks.length} tracks` : 'Edit track info', body, [
      { label: 'Cancel', value: null },
      {
        label: 'Save', primary: true, action: async () => {
          const patch = {};
          for (const k of ['title', 'artist', 'album', 'genre', 'key']) if (dirty.has(k)) patch[k] = ins[k].value.trim();
          if (dirty.has('year')) patch.year = ins.year.value ? Math.round(Number(ins.year.value)) : null;
          if (dirty.has('bpm')) { const b = Number(ins.bpm.value); if (b > 0) { patch.bpm = b; patch.bpmLocked = true; } }
          if (dirty.has('comment')) patch.comment = comment.value.trim();
          if (dirty.has('rating')) patch.rating = rating.value;
          if (dirty.has('color')) patch.color = color.value || null;
          if (dirty.has('tags')) patch.tags = tagsIn.value.split(',').map((s) => s.trim()).filter(Boolean);
          if (!Object.keys(patch).length) return true;
          try { await api.updateTracks(tracks.map((t) => t.id), patch); } catch (e) { this.toast(e.message); return false; }
          return patch;
        },
      },
    ], { wide: true });
    if (r && typeof r === 'object') {
      for (const t of tracks) this.lib.updateTrack({ ...t, ...r, ...(r.tags ? { tags: [...new Set(r.tags)] } : {}) });
      this.toast(multi ? `Updated ${tracks.length} tracks` : 'Track info saved');
    }
  }

  async setColor(tracks, hex) {
    await api.updateTracks(tracks.map((t) => t.id), { color: hex || null });
    for (const t of tracks) this.lib.updateTrack({ ...t, color: hex || null });
  }

  // ---------------------------------------------------------------- smart playlists
  async smartFields() { return (this._fields ||= await api.smartFields()); }

  async smartPlaylist(existing) {
    const meta = await this.smartFields();
    const F = new Map(meta.fields.map((f) => [f.id, f]));
    const smart = structuredClone(existing?.smart || { match: 'all', rules: [{ field: 'genre', op: 'contains', value: '' }] });
    const nameIn = el('input', { class: 'inp', value: existing?.name || '', placeholder: 'e.g. Peak-time techno 128-135' });
    const matchSel = el('select', { class: 'sel' }, el('option', { value: 'all' }, 'all'), el('option', { value: 'any' }, 'any'));
    matchSel.value = smart.match;
    const limitIn = el('input', { class: 'inp sm-limit', type: 'number', min: 0, value: smart.limit || '', placeholder: 'no limit' });
    const rulesEl = el('div', { class: 'sm-rules' });
    const count = el('span', { class: 'sm-count' });
    const tagList = el('datalist', { id: 'sm-tags' }, ...this.allTags().map((t) => el('option', { value: t })));

    let tmr;
    const preview = () => { clearTimeout(tmr); tmr = setTimeout(async () => { try { const r = await api.smartPreview(collect()); count.textContent = `${r.count.toLocaleString()} matching tracks`; } catch (e) { count.textContent = e.message; } }, 200); };
    const collect = () => ({ match: matchSel.value, rules: smart.rules, ...(Number(limitIn.value) > 0 ? { limit: Number(limitIn.value) } : {}) });

    const valueCtrl = (r) => {
      const f = F.get(r.field);
      if (['empty', 'not_empty', 'never'].includes(r.op)) return el('span', { class: 'sm-val' });
      const set = (k) => (e) => { r[k] = e.target.value; preview(); };
      if (f.type === 'color') {
        const s = el('select', { class: 'sel sm-val', onchange: set('value') }, ...meta.colors.map((c) => el('option', { value: c.hex }, c.label)));
        if (!r.value) r.value = meta.colors[0].hex;
        s.value = r.value; return s;
      }
      if (f.type === 'source') {
        const s = el('select', { class: 'sel sm-val', onchange: set('value') }, ...meta.sources.map(([v, l]) => el('option', { value: v }, l)));
        if (!r.value) r.value = meta.sources[0][0];
        s.value = r.value; return s;
      }
      const isNum = f.type === 'number' || f.type === 'date';
      const ph = f.type === 'key' ? (r.op === 'compatible' ? 'e.g. 8A' : 'e.g. 8A, 9A or Am') : f.type === 'date' ? 'days' : f.type === 'tags' ? 'tag, tag…' : '';
      const mk = (k) => el('input', { class: 'inp', type: isNum ? 'number' : 'text', value: r[k] ?? '', placeholder: ph, list: f.type === 'tags' ? 'sm-tags' : null, oninput: set(k) });
      if (r.op === 'between') return el('span', { class: 'sm-val sm-between' }, mk('value'), el('span', { class: 'hint' }, 'and'), mk('value2'));
      return el('span', { class: 'sm-val' }, mk('value'), f.type === 'date' ? el('span', { class: 'hint' }, 'days') : null);
    };
    const render = () => {
      rulesEl.replaceChildren(...smart.rules.map((r, i) => {
        const fieldSel = el('select', { class: 'sel' }, ...meta.fields.map((f) => el('option', { value: f.id }, f.label)));
        fieldSel.value = r.field;
        const f = F.get(r.field);
        const opSel = el('select', { class: 'sel' }, ...f.ops.map((o) => el('option', { value: o }, meta.ops[o] || o)));
        if (!f.ops.includes(r.op)) r.op = f.ops[0];
        opSel.value = r.op;
        fieldSel.addEventListener('change', () => { const nf = F.get(fieldSel.value); r.field = nf.id; if (nf.type !== f.type) { r.value = ''; delete r.value2; } render(); preview(); });
        opSel.addEventListener('change', () => { r.op = opSel.value; render(); preview(); });
        return el('div', { class: 'sm-rule' }, fieldSel, opSel, valueCtrl(r),
          el('button', { class: 'btn xs', title: 'Remove rule', type: 'button', onclick: () => { smart.rules.splice(i, 1); render(); preview(); } }, icon('x')));
      }));
    };
    matchSel.addEventListener('change', preview); limitIn.addEventListener('input', preview);
    render(); preview();

    const body = el('div', { class: 'form' },
      field('Name', nameIn),
      el('div', { class: 'row sm-match' }, el('span', {}, 'Match'), matchSel, el('span', {}, 'of the following rules:')),
      rulesEl, tagList,
      el('div', { class: 'row sm-foot' },
        el('button', { class: 'btn sm', type: 'button', onclick: () => { smart.rules.push({ field: 'bpm', op: 'between', value: '', value2: '' }); render(); preview(); } }, '+ Add rule'),
        el('span', { class: 'sm-limit-wrap' }, el('span', { class: 'hint' }, 'Limit to'), limitIn, el('span', { class: 'hint' }, 'tracks (newest first)')),
        count),
      el('p', { class: 'hint' }, 'Smart playlists update automatically as your library changes. They work with automix, export and USB export like any playlist.'));
    const r = await this.dialogs.modal(existing ? `Edit smart playlist` : 'New smart playlist', body, [
      { label: 'Cancel', value: null },
      {
        label: existing ? 'Save' : 'Create', primary: true, action: async () => {
          const name = nameIn.value.trim() || 'Smart playlist';
          try {
            return existing ? await api.updatePlaylist(existing.id, { name, smart: collect() }) : await api.createSmartPlaylist(name, collect());
          } catch (e) { this.toast(e.message); return false; }
        },
      },
    ], { wide: true });
    if (r) { await this.lib.refresh(); if (!existing) this.lib.setView({ kind: 'playlist', id: r.id }, r.name); }
  }

  // ---------------------------------------------------------------- importers
  importInfo(kind) {
    return {
      rekordbox: { title: 'Import rekordbox XML', label: 'rekordbox.xml', accept: '.xml', ext: ['xml'], hint: platform.local ? 'In rekordbox choose File → Export Collection in xml format, and import the music into OpenDJ first. Hot cues, memory cues, beat grids, colours and playlists are applied to the tracks it matches (by file name, then artist and title).' : 'In rekordbox choose File → Export Collection in xml format. Imports tracks, hot cues, memory cues, beat grids, colours and playlists.', run: (b) => api.importRekordbox(b), content: 'xml' },
      traktor: { title: 'Import Traktor collection', label: 'collection.nml', accept: '.nml', ext: ['nml'], hint: 'Usually in Documents/Native Instruments/Traktor <version>/collection.nml. Imports BPM, key, rating, hot cues, loops, beat grid and playlists.', run: (b) => api.importTraktor(b), content: 'xml' },
      virtualdj: { title: 'Import VirtualDJ database', label: 'database.xml', accept: '.xml', ext: ['xml'], hint: 'Usually in Documents/VirtualDJ/database.xml (external drives have their own VirtualDJ/database.xml). Imports BPM, key, cues and beat grid.', run: (b) => api.importVirtualDJ(b), content: 'xml' },
      m3u: { title: 'Import M3U playlist', label: '.m3u / .m3u8 playlist', accept: '.m3u,.m3u8', ext: ['m3u', 'm3u8'], hint: platform.local ? 'Entries are matched to music you already imported into OpenDJ (by file name, then artist and title) and saved as a new playlist.' : 'Tracks that exist on disk are added to the library and to a new playlist.', run: (b) => api.importM3U(b), content: 'content' },
      serato: { title: 'Import Serato crates', label: '_Serato_ folder', folder: true, hint: 'Pick the _Serato_ folder (in your Music folder, or at the root of an external drive). Imports crates only: every crate becomes a playlist and subcrates become folders. Serato cues, beat grids and BPMs (stored in the files) are not imported; OpenDJ analyses the tracks itself.', run: (b) => api.importSerato(b) },
    }[kind];
  }

  async importFrom(kind) {
    const info = this.importInfo(kind);
    if (platform.local && (info.folder || unavailable('otherImports') && !['rekordbox', 'm3u'].includes(kind))) return this.toast(unavailable('otherImports'));
    const pathIn = el('input', { class: 'inp', placeholder: `Path to ${info.label}`, ...(platform.local ? { readonly: true, placeholder: `Choose your ${info.label}` } : {}) });
    let fileContent = null;
    const fileIn = el('input', { type: 'file', accept: info.accept, style: { display: 'none' } });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0]; if (!f) return;
      const p = window.opendjNative?.pathForFile?.(f);
      if (p) { pathIn.value = p; fileContent = null; } else { fileContent = await f.text(); pathIn.value = f.name; pathIn.dataset.fromFile = f.name; }
    });
    pathIn.addEventListener('input', () => { fileContent = null; });
    const browse = el('button', {
      class: 'btn', type: 'button', onclick: async () => {
        if (info.folder) { const p = await this.dialogs.pickFolder(info.title); if (p) pathIn.value = p; return; }
        if (window.opendjNative?.pickFiles) { const [p] = await window.opendjNative.pickFiles([{ name: info.label, extensions: info.ext }]); if (p) { pathIn.value = p; fileContent = null; } return; }
        const nativePick = api.local?.backend?.pickText;
        if (nativePick) { // mobile app: the system document picker
          try { const f = await nativePick({ types: ['application/xml', 'text/xml', 'audio/x-mpegurl', 'audio/mpegurl', 'application/vnd.apple.mpegurl', 'text/plain', 'application/octet-stream'] }); if (f) { fileContent = f.text; pathIn.value = f.name; pathIn.dataset.fromFile = f.name; } } catch (e) { if (!/cancel/i.test(e?.message || '')) status.textContent = `✕ ${e.message}`; }
          return;
        }
        fileIn.click();
      },
    }, info.folder ? 'Browse…' : 'Choose file…');
    const status = el('p', { class: 'hint' });
    const body = el('div', { class: 'form' }, el('p', { class: 'hint' }, info.hint), el('div', { class: 'row' }, pathIn, browse, fileIn), status);
    const r = await this.dialogs.modal(info.title, body, [
      { label: 'Cancel', value: null },
      {
        label: 'Import', primary: true, action: async () => {
          const req = fileContent != null && pathIn.value === pathIn.dataset.fromFile ? { [info.content]: fileContent, name: pathIn.value.replace(/\.m3u8?$/i, '') } : { path: pathIn.value.trim() };
          if (!req.path && fileContent == null) { status.textContent = 'Choose a file or enter a path'; return false; }
          status.textContent = 'Importing…';
          try { return await info.run(req); } catch (e) { status.textContent = `✕ ${e.message}`; return false; }
        },
      },
    ]);
    if (!r) return;
    if (kind === 'm3u') this.toast(`Imported playlist "${r.name}" (${r.trackIds.length} tracks)`);
    else this.toast(`Imported ${r.imported} tracks${r.playlists ? `, ${r.playlists} playlists` : ''}${r.missing ? ` (${r.missing} files not found)` : ''}${r.cuesSkipped ? ` · ${r.cuesSkipped} cue(s) skipped (pads taken or already there)` : ''}`);
    this.lib.refresh();
  }

  // ---------------------------------------------------------------- missing files
  async relocate(ids) {
    const n = ids?.length || [...this.lib.tracks.values()].filter((t) => t.missing).length;
    if (!n) return this.toast('No missing files');
    const folder = await this.dialogs.pickFolder(`Find ${n} missing file${n > 1 ? 's' : ''} in…`);
    if (!folder) return;
    this.lib.setJobStatus('Searching for missing files…');
    try {
      const r = await api.relocate(folder, ids);
      this.toast(`Relocated ${r.relocated.length} track(s)${r.notFound.length ? `, ${r.notFound.length} not found` : ''} (searched ${r.scanned.toLocaleString()} files)`);
    } catch (e) { this.toast(e.message); }
    this.lib.setJobStatus('');
    this.lib.refresh();
  }

  async removeMissing() {
    const ids = [...this.lib.tracks.values()].filter((t) => t.missing).map((t) => t.id);
    if (!ids.length) return;
    if (!(await this.dialogs.confirm(`Remove ${ids.length} missing track(s) from the library? Their cues and analysis are lost.`))) return;
    await api.deleteTracks(ids); this.lib.refresh();
  }

  // ---------------------------------------------------------------- duplicates
  async removeDuplicates(groups) {
    if (!groups?.length) return this.toast('No duplicates found');
    const n = groups.reduce((a, g) => a + g.ids.length - 1, 0);
    if (!(await this.dialogs.confirm(`Remove ${n} duplicate track(s) from the library? In each group the best copy (analysed, most cues, most played) is kept and playlists are pointed at it. Files are not deleted.`))) return;
    const r = await api.dedupe(groups.map((g) => ({ keep: g.ids[0], remove: g.ids.slice(1) })));
    this.toast(`Removed ${r.removed} duplicate(s)`);
    this.lib.refresh();
  }

  // ---------------------------------------------------------------- history
  sessionMenu(x, y, s) {
    this.dialogs.menu(x, y, [
      { label: 'Export setlist (.txt)', action: () => download(api.historyExportUrl(s.id, 'txt')) },
      { label: 'Export as CSV', action: () => download(api.historyExportUrl(s.id, 'csv')) },
      { label: 'Export as M3U8 playlist', action: () => download(api.historyExportUrl(s.id, 'm3u8')) },
      { label: 'Save as playlist', action: () => this.sessionToPlaylist(s) },
      '-',
      { label: 'Rename…', action: async () => { const n = await this.dialogs.prompt('Rename session', 'Name', s.name || this.lib.sessionLabel(s)); if (n) { await api.renameHistory(s.id, n); this.lib.refresh(); } } },
      { label: 'Delete session', danger: true, action: async () => { if (await this.dialogs.confirm('Delete this history session?')) { await api.deleteHistory(s.id); if (this.lib.view.id === s.id) this.lib.setView({ kind: 'all' }, 'Collection'); this.lib.refresh(); } } },
    ]);
  }
  async sessionToPlaylist(s) {
    const full = await api.historySession(s.id);
    const ids = full.entries.map((e) => e.trackId).filter((id) => this.lib.tracks.has(id));
    const name = await this.dialogs.prompt('Save session as playlist', 'Playlist name', `Set ${this.lib.sessionLabel(s)}`);
    if (!name) return;
    await api.createPlaylist(name, ids, 'History');
    this.toast(`Saved ${ids.length} tracks to "${name}"`);
    this.lib.refresh();
  }

  // ---------------------------------------------------------------- backup / restore
  backup() { download(api.backupUrl()); this.toast('Downloading library backup…'); }
  restore() {
    const fileIn = el('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0]; fileIn.remove(); if (!f) return;
      let data;
      try { data = JSON.parse(await f.text()); } catch { return this.toast('That file is not a valid backup'); }
      if (data?.app !== 'OpenDJ' || data.type !== 'library-backup') return this.toast('That file is not an OpenDJ library backup');
      const n = Object.keys(data.library?.tracks || {}).length;
      if (!(await this.dialogs.confirm(`Restore the backup from ${new Date(data.createdAt).toLocaleString()} (${n.toLocaleString()} tracks, ${(data.library.playlists || []).length} playlists)? This replaces your current library, playlists, settings and history.`))) return;
      try {
        await api.restore(data);
        this.toast('Library restored — reloading…');
        setTimeout(() => location.reload(), 900);
      } catch (e) { this.toast(e.message); }
    });
    document.body.append(fileIn);
    fileIn.click();
  }

  // ---------------------------------------------------------------- "⋯ Library" menu
  libraryMenu(x, y) {
    const missing = [...this.lib.tracks.values()].filter((t) => t.missing).length;
    this.dialogs.menu(x, y, [
      { label: 'New smart playlist…', action: () => this.smartPlaylist() },
      { label: 'Edit selected track info…', action: () => this.editTracks(this.lib.selectedTracks()) },
      { label: 'Analyse all tracks', action: () => { const n = this.app.analyser.request([...this.lib.tracks.values()]); this.app.toast(n ? `Analysing ${n.toLocaleString()} track(s) in the background` : 'All tracks are analysed'); } },
      { label: 'Analyse selected tracks', action: () => { const n = this.app.analyser.request(this.lib.selectedTracks()); this.app.toast(n ? `Analysing ${n} track(s)` : 'Select tracks that are not analysed yet'); } },
      '-',
      { label: 'Import', sub: [
        ...(platform.local ? [{ label: 'Music files…', action: () => this.app.upload?.pick?.() }] : []),
        { label: 'rekordbox XML…', action: () => this.importFrom('rekordbox') },
        ...(unavailable('otherImports') ? [] : [
          { label: 'Traktor collection (NML)…', action: () => this.importFrom('traktor') },
          { label: 'Serato crates…', action: () => this.importFrom('serato') },
          { label: 'VirtualDJ database…', action: () => this.importFrom('virtualdj') }]),
        { label: 'M3U / M3U8 playlist…', action: () => this.importFrom('m3u') },
      ] },
      { label: 'Export', sub: [
        ...(unavailable('cdj') ? [] : [{ label: 'Playlists to CDJ USB (rekordbox device library)…', action: () => openCdjExport(this.app, []) }]),
        { label: 'Collection as rekordbox XML', action: () => download(api.rekordboxExportUrl()) },
        ...(unavailable('usbExport') ? [] : [{ label: 'Playlists to USB / folder…', action: () => this.dialogs.exportUsb([]) }]),
      ] },
      '-',
      { label: `Missing files${missing ? ` (${missing})` : ''}`, action: () => this.lib.setView({ kind: 'missing' }, 'Missing files') },
      ...(platform.local ? [] : [{ label: 'Relocate missing files…', action: () => this.relocate() }]),
      { label: 'Find duplicates', action: () => this.lib.setView({ kind: 'duplicates' }, 'Duplicates') },
      '-',
      { label: 'Back up library…', action: () => this.backup() },
      { label: 'Restore from backup…', action: () => this.restore() },
    ]);
    flipSubmenus();
  }
}
