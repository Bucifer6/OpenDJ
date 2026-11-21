import { el, fmtDur, escapeHtml } from '../util.js';
import { uploadButton } from './upload.js';
import { openCdjExport } from '../cdj/export-dialog.js';
import { stemsMenuItems } from '../stems/stems-ui.js';
import { api } from '../api.js';
import { toCamelot, camelotCompatible } from '../audio/analysis-core.js';
import { LibraryDialogs, TRACK_COLORS, colorName, flipSubmenus } from './library-dialogs.js';
import { icon as uiIcon, iconLabel, glyphIcon } from './icons.js';
import { platform, unavailable } from '../platform.js';

// rows are taller on touch screens (phones, tablets) so a finger can pick one
const COARSE = !!globalThis.matchMedia?.('(pointer: coarse)').matches;
let ROW_H = COARSE ? 40 : 26; // 'art' rows (Settings / library toolbar) are 44 px: see setRowMode()
const COLS = [
  { id: '#', label: '#', w: 34, ordered: true }, // position in a playlist / set / history view (only shown there)
  { id: 'art', label: '', w: 30, sort: null },
  { id: 'title', label: 'Title', w: 'minmax(160px, 2.2fr)' },
  { id: 'artist', label: 'Artist', w: 'minmax(120px, 1.5fr)' },
  { id: 'bpm', label: 'BPM', w: 62 },
  { id: 'key', label: 'Key', w: 56 },
  { id: 'duration', label: 'Time', w: 56 },
  { id: 'energy', label: 'Nrg', w: 40 },
  { id: 'genre', label: 'Genre', w: 'minmax(80px, 0.8fr)' },
  { id: 'tags', label: 'Tags', w: 'minmax(70px, 0.7fr)' },
  { id: 'album', label: 'Album', w: 'minmax(100px, 1fr)' },
  { id: 'rating', label: 'Rating', w: 78 },
  { id: 'source', label: 'Source', w: 96 },
  { id: 'addedAt', label: 'Added', w: 86 },
];
/** Views whose tracks have an intrinsic order (shown in the # column, the default sort there). */
const ORDERED_VIEWS = new Set(['playlist', 'session', 'played', 'history']);
const SOURCE_ICONS = { plex: 'Plex', jellyfin: 'Jellyfin', emby: 'Emby', subsonic: 'Subsonic', mediamax: 'MediaMax', local: 'Local' };

export class LibraryUI {
  constructor(app) {
    this.app = app;
    this.tracks = new Map(); this.playlists = []; this.folders = []; this.sources = []; this.drives = [];
    this.view = { kind: 'all' }; this.sort = { col: 'addedAt', dir: -1 }; this.query = '';
    this.rows = []; this.selected = new Set(); this.cursor = -1; this.downloads = { queued: [], active: [], done: [] };
    this.sessions = []; this.sessionRows = []; this.dupGroups = []; this.dupIndex = new Map(); this.showAllSessions = false;
    this.remoteLists = new Map(); // source id -> { lists, error, loading } (live media-server playlists)
    this.dlg = new LibraryDialogs(app, this);
    this.build();
  }

  // ---------------- data ----------------
  async refresh() {
    const [tracks, playlists, folders, sources, sessions] = await Promise.all([api.tracks(), api.playlists(), api.folders(), api.sources(), api.history().catch(() => [])]);
    this.tracks = new Map(tracks.map((t) => [t.id, t]));
    this.playlists = playlists; this.folders = folders; this.sources = sources; this.sessions = sessions;
    await this.loadViewData();
    this.renderTree(); this.applyView();
    for (const src of sources) if (!this.remoteLists.has(src.id)) this.loadRemoteLists(src.id);
  }
  /** Fetch a media server's playlists (live) for the sidebar. */
  async loadRemoteLists(sourceId) {
    const prev = this.remoteLists.get(sourceId);
    this.remoteLists.set(sourceId, { ...(prev || { lists: [] }), loading: true, error: null });
    try { this.remoteLists.set(sourceId, { lists: await api.sourcePlaylists(sourceId), loading: false, error: null }); }
    catch (e) { this.remoteLists.set(sourceId, { lists: prev?.lists || [], loading: false, error: e.message }); }
    this.renderTree();
  }
  /** Open a media-server playlist: its tracks become remote library tracks and the playlist is mirrored. Returns the tracks. */
  async openRemotePlaylist(src, rp, { show = true } = {}) {
    this.setJobStatus(`Loading "${rp.name}" from ${src.name || src.type}…`);
    let r;
    try { r = await api.sourcePlaylist(src.id, rp.remoteId, rp.name); }
    catch (e) { this.setJobStatus(''); this.app.toast(`Could not open "${rp.name}": ${e.message}`); throw e; }
    this.setJobStatus('');
    rp.playlistId = r.playlist.id;
    await this.refresh();
    if (show) await this.setView({ kind: 'playlist', id: r.playlist.id }, rp.name);
    return r.tracks.map((t) => this.tracks.get(t.id) || t);
  }
  remotePlaylistMenu(src, rp, e) {
    const r = this.tree.getBoundingClientRect();
    const x = e?.clientX ?? r.right - 20, y = e?.clientY ?? r.top + 100;
    const withTracks = (fn) => async () => { let t; try { t = await this.openRemotePlaylist(src, rp, { show: false }); } catch { return; } if (!t.length) { this.app.toast(`"${rp.name}" is empty`); return; } fn(t); };
    this.app.dialogs.menu(x, y, [
      { label: 'Open', action: () => this.openRemotePlaylist(src, rp).catch(() => {}) },
      { label: 'Automix this playlist', action: withTracks((t) => this.app.dialogs.automixQueue(t, { mode: 'order', title: rp.name })) },
      { label: 'Shuffle & mix', action: withTracks((t) => this.app.dialogs.automixQueue(t, { mode: 'shuffle', title: rp.name })) },
      { label: 'Smart mix', action: withTracks((t) => this.app.dialogs.automixQueue(t, { mode: 'smart', title: rp.name })) },
      { label: 'Add to automix queue', action: withTracks((t) => this.app.queueAdd(t)) },
      '-',
      { label: 'Import as local playlist', action: withTracks(async (t) => { await api.createPlaylist(rp.name, t.map((x) => x.id), src.name || src.serverName || 'Imported'); await this.refresh(); this.app.toast(`Imported "${rp.name}" (${t.length} tracks, streamed from ${src.name || src.type} until downloaded)`); }) },
      { label: 'Download all for offline use', action: withTracks((t) => { const ids = t.filter((x) => x.sourceType === 'remote' && !x.localPath).map((x) => x.id); if (ids.length) this.download(ids); else this.app.toast('All tracks are already downloaded'); }) },
    ]);
  }
  /** Fetch server-side data needed by the current view (history session entries, duplicate groups). */
  async loadViewData() {
    const v = this.view;
    try {
      if (v.kind === 'session') {
        const s = await api.historySession(v.id);
        this.sessionRows = s.entries.map((e, i) => { const t = this.tracks.get(e.trackId); return t ? { ...t, _playedAt: e.at, _order: i } : null; }).filter(Boolean);
      } else if (v.kind === 'duplicates') {
        this.dupGroups = await api.duplicates();
        this.dupIndex = new Map(this.dupGroups.flatMap((g, gi) => g.ids.map((id) => [id, gi])));
      }
    } catch { this.sessionRows = []; }
  }
  selectedTracks() { return [...this.selected].map((id) => this.tracks.get(id)).filter(Boolean); }
  sessionLabel(s) {
    if (s.name) return s.name;
    const d = new Date(s.startedAt);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })} · ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  }
  async refreshDrives() { try { this.drives = await api.drives(); } catch { this.drives = []; } this.renderTree(); }
  track(id) { return this.tracks.get(id); }
  // background analysis updates tracks one after another, also during playback: coalesce the row redraws to one per frame
  updateTrack(t) { if (t?.id) { this.tracks.set(t.id, { ...this.tracks.get(t.id), ...t }); this._rowsRaf ||= requestAnimationFrame(() => { this._rowsRaf = 0; this.renderRows(true); }); } }

  viewTracks() {
    const all = [...this.tracks.values()]; const v = this.view;
    switch (v.kind) {
      case 'playlist': { const p = this.playlists.find((x) => x.id === v.id); return p ? p.trackIds.map((id) => this.tracks.get(id)).filter(Boolean) : []; }
      case 'folder': case 'source': return all.filter((t) => t.sourceId === v.id);
      case 'recent': return all.filter((t) => Date.now() - (t.addedAt || 0) < 30 * 864e5);
      case 'played': return all.filter((t) => t.playCount).sort((a, b) => b.playCount - a.playCount);
      case 'history': return all.filter((t) => t.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed);
      case 'session': return this.sessionRows;
      case 'missing': return all.filter((t) => t.missing);
      case 'duplicates': return this.dupGroups.flatMap((g) => g.ids.map((id) => this.tracks.get(id)).filter(Boolean));
      case 'tagged': return all.filter((t) => (t.tags || []).includes(v.id));
      case 'downloaded': return all.filter((t) => t.localPath && t.sourceType === 'remote');
      case 'streaming': return all.filter((t) => t.sourceType === 'remote' && !t.localPath);
      case 'unanalysed': return all.filter((t) => !t.analyzed);
      case 'matching': {
        const m = this.app.engine.masterDeck(); if (!m?.track) return [];
        const cam = toCamelot(m.track.key), bpm = m.effectiveBpm;
        return all.filter((t) => t.id !== m.track.id && (!cam || camelotCompatible(cam, toCamelot(t.key))) && (!bpm || !t.bpm || Math.abs(t.bpm / bpm - 1) < 0.06 || Math.abs(t.bpm * 2 / bpm - 1) < 0.06 || Math.abs(t.bpm / 2 / bpm - 1) < 0.06));
      }
      default: return all;
    }
  }

  filter(list) {
    let q = this.query.trim().toLowerCase();
    if (!q) return list;
    const tests = [];
    // a whole-number upper bound includes its decimals: bpm:120-128 matches 128.5 like bpm:128 does
    const upper = (v) => (v.includes('.') ? +v : +v + 0.999);
    q = q.replace(/bpm:(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?/g, (_, a, b) => { const lo = +a, hi = upper(b ?? a); tests.push((t) => t.bpm >= lo && t.bpm <= hi); return ''; });
    // chips (ui/lib-chips.js): bpm:near = within 6 % of the master deck (or half / double time), key:compat = harmonic match
    const m = this.app.engine.masterDeck?.(), mBpm = m?.effectiveBpm, mCam = toCamelot(m?.track?.key);
    q = q.replace(/bpm:near/g, () => { tests.push((t) => !mBpm || (t.bpm > 0 && [1, 2, 0.5].some((f) => Math.abs(t.bpm * f / mBpm - 1) < 0.06))); return ''; });
    q = q.replace(/key:compat/g, () => { tests.push((t) => !mCam || camelotCompatible(mCam, toCamelot(t.key))); return ''; });
    q = q.replace(/key:(\S*)/g, (_, k) => { const c = toCamelot(k); tests.push(c ? (t) => toCamelot(t.key) === c : () => false); return ''; }); // unknown key: no match
    q = q.replace(/genre:(\S+)/g, (_, g) => { tests.push((t) => (t.genre || '').toLowerCase().includes(g)); return ''; });
    q = q.replace(/tag:(\S+)/g, (_, g) => { tests.push((t) => (t.tags || []).some((x) => x.toLowerCase().includes(g))); return ''; });
    const words = q.split(/\s+/).filter(Boolean);
    return list.filter((t) => {
      if (!tests.every((f) => f(t))) return false;
      const hay = `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.key || ''} ${toCamelot(t.key) || ''} ${t.comment || ''} ${(t.tags || []).join(' ')} ${colorName(t.color)}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  /** Row style: 'compact' (26 px, 40 px on touch screens) or 'art' (44 px with larger artwork). */
  setRowMode(mode) {
    ROW_H = mode === 'art' ? 44 : COARSE ? 40 : 26;
    this.root?.classList.toggle('rows-art', mode === 'art');
    this.root?.style.setProperty('--row-h', `${ROW_H}px`);
    this.renderRows(true);
  }

  get showOrder() { return ORDERED_VIEWS.has(this.view.kind); }
  applyView() {
    const base = this.viewTracks();
    this.orderOf = new Map(); base.forEach((t, i) => { if (!this.orderOf.has(t)) this.orderOf.set(t, i); });
    let list = this.filter(base);
    const { col, dir } = this.sort;
    if (col === '#') { if (dir < 0) list = [...list].reverse(); } // the view's own order (playlist / set / history)
    else if (col && this.view.kind !== 'duplicates') {
      const session = this.view.kind === 'session';
      const val = (t) => (col === 'key' ? (toCamelot(t.key) ? toCamelot(t.key).padStart(3, '0') : '') : col === 'source' ? (t.sourceKind || 'local')
        : col === 'tags' ? (t.tags || []).join(', ') : col === 'addedAt' && session ? t._playedAt : t[col]);
      list = [...list].sort((a, b) => {
        const x = val(a), y = val(b);
        if (x == null || x === '') return 1; if (y == null || y === '') return -1;
        return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir;
      });
    }
    this.rows = list;
    this.countEl.textContent = `${list.length.toLocaleString()} tracks`;
    this.renderRows(true);
    this.renderViewActions();
    this.renderEmpty();
  }

  /** Why a view is empty: first launch (how to add music), or analysis still running for views that need BPM / key. */
  renderEmpty() {
    const e = this.emptyEl;
    if (this.rows.length) { e.hidden = true; return; }
    const an = this.app.analyser?.status?.();
    const needsAnalysis = /bpm:|key:/.test(this.query) || ['matching'].includes(this.view.kind)
      || (this.view.kind === 'playlist' && this.playlists.find((p) => p.id === this.view.id)?.smart);
    if (!this.tracks.size && this.view.kind === 'all' && !this.query.trim() && platform.local) {
      e.replaceChildren(
        el('h3', {}, 'Your library is empty'),
        el('p', {}, 'OpenDJ keeps its own copy of the music you import, so it works offline and needs no computer or server.'),
        el('ul', {},
          el('li', {}, el('button', { class: 'btn sm', onclick: () => this.app.upload?.pick?.() }, '＋ Import music'), platform.native && platform.os === 'ios' ? ' from the Files app (iCloud Drive, On My iPhone, USB drives, cloud storage)' : ' from your files (Downloads, Music, a USB stick or a cloud drive)'),
          el('li', {}, el('button', { class: 'btn sm', onclick: () => this.app.dialogs.addSource() }, '+ Media server'), ' stream from Plex, Jellyfin, Emby, Subsonic / Navidrome and download for offline use'),
          el('li', {}, 'bring cues and playlists from rekordbox: ', el('button', { class: 'btn sm', onclick: (ev) => { const r = ev.currentTarget.getBoundingClientRect(); this.dlg.libraryMenu(r.left, r.bottom + 4); } }, '⋯ Library → Import'), ' (after importing the music)')),
        el('p', { class: 'hint' }, 'MP3, AAC / M4A, WAV, AIFF and FLAC play everywhere; Ogg / Opus where the phone supports it. New tracks are analysed in the background (BPM, key, waveform, cues).'));
    } else if (!this.tracks.size && this.view.kind === 'all' && !this.query.trim()) {
      const hosted = !!this.app.hosted;
      e.replaceChildren(
        el('h3', {}, 'Your library is empty'),
        el('p', {}, 'Add music to get started:'),
        el('ul', {},
          el('li', {}, el('button', { class: 'btn sm', onclick: () => this.app.dialogs.addFolder() }, '+ Folder'), ' add a folder, USB stick or NAS share (it is scanned and kept in sync)'),
          hosted ? el('li', {}, el('button', { class: 'btn sm', onclick: () => this.app.upload?.pick?.() || document.querySelector('.upload-btn')?.click() }, '⇪ Upload'), ' upload files from this device') : null,
          el('li', {}, 'drop audio files or folders anywhere on this window'),
          el('li', {}, 'import from rekordbox, Serato, Traktor or VirtualDJ: ', el('button', { class: 'btn sm', onclick: (ev) => { const r = ev.currentTarget.getBoundingClientRect(); this.dlg.libraryMenu(r.left, r.bottom + 4); } }, '⋯ Library → Import')),
          el('li', {}, el('button', { class: 'btn sm', onclick: () => this.app.dialogs.addSource() }, '+ Media server'), ' Plex, Jellyfin, Emby, Subsonic / Navidrome')),
        el('p', { class: 'hint' }, 'New tracks are analysed in the background (BPM, key, waveform, cues).'));
    } else if (an?.running && (needsAnalysis || this.view.kind === 'unanalysed' || this.query.trim())) {
      e.replaceChildren(el('h3', {}, 'Nothing here yet'), el('p', {}, `Tracks are still being analysed (${an.remaining.toLocaleString()} to go). BPM, key and energy fill in as each one finishes.`));
    } else if (needsAnalysis && [...this.tracks.values()].some((t) => !t.analyzed)) {
      e.replaceChildren(el('h3', {}, 'No matches'), el('p', {}, 'Some tracks are not analysed yet, so they have no BPM / key. Use ⋯ Library → Analyse all tracks.'));
    } else { e.hidden = true; return; }
    e.hidden = false;
  }

  setAnalysisStatus(st) {
    const show = st.running || st.remaining > 0;
    this.analysisEl.hidden = !show;
    this.analysisText.textContent = show ? `${st.label || 'Analysing…'}${st.paused ? ' (paused)' : ''}` : '';
    this.analysisEl.title = 'Analysing the library in the background: BPM, key, energy, waveform and cues';
    if (!this.rows.length) this.renderEmpty();
  }

  /** Buttons for the current view (relocate, dedupe, setlist export, smart rules…). */
  renderViewActions() {
    const v = this.view, b = (label, fn, title) => el('button', { class: 'btn sm', title, onclick: fn }, label);
    const acts = [];
    if (v.kind === 'missing') acts.push(b('Relocate…', () => this.dlg.relocate(), 'Search a folder for the missing files'), b('Remove all', () => this.dlg.removeMissing()));
    if (v.kind === 'duplicates') acts.push(b('Remove duplicates…', () => this.dlg.removeDuplicates(this.dupGroups), 'Keep the best copy in each group'));
    if (v.kind === 'session') {
      const s = this.sessions.find((x) => x.id === v.id);
      if (s) acts.push(b('Export setlist ▾', (e) => { const r = e.target.getBoundingClientRect(); this.dlg.sessionMenu(r.left, r.bottom + 4, s); }));
    }
    const p = v.kind === 'playlist' && this.playlists.find((x) => x.id === v.id);
    if (p?.smart) acts.push(b('Edit rules…', () => this.dlg.smartPlaylist(p)));
    this.viewActions.replaceChildren(...acts);
  }

  // ---------------- DOM ----------------
  build() {
    this.tree = el('nav', { class: 'lib-tree' });
    this.search = el('input', { class: 'lib-search', type: 'search', placeholder: 'Search…  (try bpm:120-128  key:8A  genre:house)' });
    let tmr; this.search.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(() => { this.query = this.search.value; this.applyView(); }, 120); });
    this.countEl = el('span', { class: 'lib-count' });
    this.viewTitle = el('span', { class: 'lib-view-title' }, 'Collection');
    this.statusEl = el('span', { class: 'lib-status' });
    this.analysisText = el('span', {});
    this.analysisEl = el('span', { class: 'lib-analysis', hidden: true }, this.analysisText,
      el('button', { class: 'btn xs', title: 'Stop analysing (Analyse all in ⋯ Library starts it again)', onclick: () => this.app.analyser?.cancel() }, uiIcon('x')));
    this.viewActions = el('span', { class: 'lib-view-actions' });
    const tools = el('div', { class: 'lib-tools' },
      this.viewTitle, this.countEl, this.viewActions, this.search,
      platform.local ? null : el('button', { class: 'btn sm', onclick: () => this.app.dialogs.addFolder(), title: 'Add a folder, USB drive or NAS share' }, iconLabel('folder-plus', 'Folder')),
      uploadButton(this.app),
      el('button', { class: 'btn sm', onclick: () => this.app.dialogs.addSource(), title: 'Connect Plex, Jellyfin, Emby, Subsonic/Navidrome or MediaMax' }, iconLabel('server', 'Media server')),
      el('button', { class: 'btn sm', onclick: () => this.app.dialogs.automixQueue(this.rows), title: 'Auto-mix the tracks in this view' }, iconLabel('automix', 'Automix view')),
      el('button', { class: 'btn sm lib-menu-btn', title: 'Smart playlists, import from rekordbox / Traktor / Serato / VirtualDJ, missing files, duplicates, backup', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); this.dlg.libraryMenu(r.left, r.bottom + 4); } }, iconLabel('more', 'Library')),
      this.statusEl, this.analysisEl,
    );
    this.header = el('div', { class: 'lib-header' });
    this.renderHeader();
    this.spacer = el('div', { class: 'lib-spacer' });
    this.rowsEl = el('div', { class: 'lib-rows' });
    this.emptyEl = el('div', { class: 'lib-empty', hidden: true });
    this.scroller = el('div', { class: 'lib-scroll', tabindex: 0 }, this.spacer, this.rowsEl, this.emptyEl);
    this.scroller.addEventListener('scroll', () => this.renderRows());
    this.scroller.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.renderRows(true)).observe(this.scroller);
    this.preview = new Audio();
    this.root = el('section', { class: 'library' }, this.tree, el('div', { class: 'lib-main' }, tools, this.header, this.scroller));
  }

  cols() { return COLS.filter((c) => !c.ordered || this.showOrder); }
  gridTemplate() { return this.cols().map((c) => (typeof c.w === 'number' ? `${c.w}px` : c.w)).join(' '); }
  renderHeader() {
    this.header.style.gridTemplateColumns = this.gridTemplate();
    const label = (c) => (c.id === 'addedAt' && this.view.kind === 'session' ? 'Played' : c.label);
    this.header.replaceChildren(...this.cols().map((c) => el('div', {
      class: `lh ${this.sort.col === c.id ? 'sorted' : ''}`,
      onclick: () => { if (c.sort === null) return; this.sort = { col: c.id, dir: this.sort.col === c.id ? -this.sort.dir : 1 }; this.renderHeader(); this.applyView(); },
    }, label(c), this.sort.col === c.id ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : '')));
  }

  renderRows(force) {
    const H = this.scroller.clientHeight || 300;
    this.spacer.style.height = `${this.rows.length * ROW_H}px`;
    const first = Math.max(0, Math.floor(this.scroller.scrollTop / ROW_H) - 5);
    const last = Math.min(this.rows.length, first + Math.ceil(H / ROW_H) + 10);
    if (!force && this._range && this._range[0] === first && this._range[1] === last) return;
    this._range = [first, last];
    const master = this.app.engine.masterDeck();
    const mCam = master?.camelot, mBpm = master?.effectiveBpm;
    const loaded = new Set(this.app.engine.decks.map((d) => d.track?.id).filter(Boolean));
    const dl = new Set([...this.downloads.queued, ...this.downloads.active].map((x) => x.trackId));
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const t = this.rows[i];
      const cam = toCamelot(t.key);
      const comp = mCam && cam && camelotCompatible(mCam, cam);
      const bpmClose = mBpm && t.bpm && Math.abs(t.bpm / mBpm - 1) < 0.04;
      const src = t.sourceType === 'remote' ? (SOURCE_ICONS[t.sourceKind] || 'Server') + (t.localPath ? ' ✓' : '') : 'Local';
      const dup = this.view.kind === 'duplicates' ? ` dup-${this.dupIndex.get(t.id) % 2 ? 'b' : 'a'} ${this.dupGroups[this.dupIndex.get(t.id)]?.ids[0] === t.id ? 'dup-keep' : ''}` : '';
      const sw = t.color ? `<i class="lc-sw" style="background:${escapeHtml(t.color)}" title="${escapeHtml(colorName(t.color) || t.color)}"></i>` : '';
      const when = this.view.kind === 'session' ? (t._playedAt ? new Date(t._playedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '') : (t.addedAt ? new Date(t.addedAt).toLocaleDateString() : '');
      const row = el('div', {
        class: `lr ${this.selected.has(t.id) ? 'sel' : ''} ${i === this.cursor ? 'cursor' : ''} ${loaded.has(t.id) ? 'loaded' : ''} ${t.playCount ? 'played' : ''} ${t.missing ? 'missing' : ''} ${t.unreadable ? 'unreadable' : ''}${dup}`,
        title: t.missing ? `File missing: ${t.path}` : t.unreadable ? `Could not decode this file: ${t.path || t.title}` : null,
        style: { top: `${i * ROW_H}px`, gridTemplateColumns: this.gridTemplate() },
        draggable: 'true', 'data-i': i,
        html: (this.showOrder ? `<div class="num ord">${(this.orderOf?.get(t) ?? i) + 1}</div>` : '') + `<div class="art" style="background-image:url(${api.coverUrl(t.id)})"></div>`
          + `<div class="c-title" title="${escapeHtml(t.title)}">${sw}${t.missing ? '<span class="lc-miss">⚠</span>' : t.unreadable ? '<span class="lc-miss lc-unreadable" title="Unreadable: the file could not be decoded">⚠</span>' : ''}${escapeHtml(t.title)}</div><div title="${escapeHtml(t.artist)}">${escapeHtml(t.artist)}</div>`
          + `<div class="num ${bpmClose ? 'match' : ''}">${Number(t.bpm) > 0 ? Number(t.bpm).toFixed(Number(t.bpm) % 1 ? 1 : 0) : ''}</div>`
          + `<div class="key ${cam ? `cam-${cam.replace(/\D/g, '')}` : ''} ${comp ? 'match' : ''}">${escapeHtml(cam || t.key || '')}</div>`
          + `<div class="num">${fmtDur(t.duration)}</div><div class="num">${escapeHtml(t.energy ?? '')}</div>`
          + `<div>${escapeHtml(t.genre)}</div><div class="lc-tags">${(t.tags || []).map((x) => `<span class="tag-chip">${escapeHtml(x)}</span>`).join('')}</div><div>${escapeHtml(t.album)}</div>`
          + `<div class="stars" data-rate>${[1, 2, 3, 4, 5].map((s) => `<span data-s="${s}" class="${s <= (t.rating || 0) ? 'on' : ''}">★</span>`).join('')}</div>`
          + `<div class="src ${t.sourceType === 'remote' && !t.localPath ? 'stream' : ''}">${dl.has(t.id) ? '⬇ …' : escapeHtml(src)}</div>`
          + `<div class="num">${when}</div>`,
      });
      frag.append(row);
    }
    this.rowsEl.replaceChildren(frag);
    if (!this._wired) this.wireRows();
  }

  wireRows() {
    this._wired = true;
    const idx = (e) => { const r = e.target.closest('.lr'); return r ? +r.dataset.i : -1; };
    this.rowsEl.addEventListener('click', (e) => {
      const i = idx(e); if (i < 0) return;
      if (e.detail === 2 && !e.target.closest('[data-s]')) { this.loadToFreeDeck(this.rows[i].id); return; }
      const star = e.target.closest('[data-s]');
      if (star) { const t = this.rows[i]; const r = +star.dataset.s === t.rating ? 0 : +star.dataset.s; t.rating = r; api.updateTrack(t.id, { rating: r }).catch((err) => this.app.toast(`Could not save the rating: ${err.message}`)); this.renderRows(true); return; }
      const id = this.rows[i].id;
      if (e.shiftKey && this.cursor >= 0) { const [a, b] = [Math.min(this.cursor, i), Math.max(this.cursor, i)]; for (let k = a; k <= b; k++) this.selected.add(this.rows[k].id); }
      else if (e.ctrlKey || e.metaKey) { this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id); }
      else { this.selected = new Set([id]); }
      this.cursor = i; this.renderRows(true); this.scroller.focus({ preventScroll: true });
    });
    this.rowsEl.addEventListener('dragstart', (e) => {
      const i = idx(e); if (i < 0) return;
      const id = this.rows[i].id;
      if (!this.selected.has(id)) { this.selected = new Set([id]); this.cursor = i; }
      e.dataTransfer.setData('text/x-opendj-track', id);
      e.dataTransfer.setData('text/x-opendj-tracks', JSON.stringify([...this.selected]));
      e.dataTransfer.effectAllowed = 'copyMove';
    });
    // drag tracks within a playlist (shown in its own order, no search filter) to reorder it
    const clearMark = () => this.rowsEl.querySelectorAll('.drop-before, .drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    const dropSlot = (e) => {
      const r = e.target.closest('.lr'); if (!r) return null;
      const b = r.getBoundingClientRect(), after = e.clientY > b.top + b.height / 2;
      return { row: r, after, index: +r.dataset.i + (after ? 1 : 0) };
    };
    this.rowsEl.addEventListener('dragover', (e) => {
      if (!this.canReorder() || !e.dataTransfer.types.includes('text/x-opendj-tracks')) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      const slot = dropSlot(e); clearMark(); if (slot) slot.row.classList.add(slot.after ? 'drop-after' : 'drop-before');
    });
    this.rowsEl.addEventListener('dragleave', (e) => { if (!this.rowsEl.contains(e.relatedTarget)) clearMark(); });
    this.rowsEl.addEventListener('drop', (e) => {
      if (!this.canReorder() || !e.dataTransfer.types.includes('text/x-opendj-tracks')) return;
      e.preventDefault(); const slot = dropSlot(e); clearMark();
      if (slot) this.reorderPlaylist(slot.index);
    });
    this.rowsEl.addEventListener('dragend', clearMark);
    this.rowsEl.addEventListener('contextmenu', (e) => {
      e.preventDefault(); const i = idx(e); if (i < 0) return;
      const id = this.rows[i].id; if (!this.selected.has(id)) { this.selected = new Set([id]); this.cursor = i; this.renderRows(true); }
      this.contextMenu(e.clientX, e.clientY);
    });
  }

  onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.moveSelection(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Enter' && this.cursor >= 0) this.loadToFreeDeck(this.rows[this.cursor].id);
    else if (e.key === 'Delete' && this.view.kind === 'playlist') this.removeFromPlaylist();
    else if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); this.selected = new Set(this.rows.map((t) => t.id)); this.renderRows(true); }
  }
  moveSelection(d) {
    if (!this.rows.length) return;
    this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + d));
    this.selected = new Set([this.rows[this.cursor].id]);
    const top = this.cursor * ROW_H, H = this.scroller.clientHeight;
    if (top < this.scroller.scrollTop) this.scroller.scrollTop = top;
    else if (top + ROW_H > this.scroller.scrollTop + H) this.scroller.scrollTop = top + ROW_H - H;
    this.renderRows(true);
  }
  loadSelected(deck) { const t = this.rows[this.cursor]; if (t) this.app.loadTrack(deck, t.id).catch(() => {}); }
  loadToFreeDeck(id) {
    const n = this.app.deckCount;
    const d = this.app.engine.decks.slice(0, n).find((x) => !x.playing && !x.track) || this.app.engine.decks.slice(0, n).find((x) => !x.playing);
    if (d) this.app.loadTrack(d.index, id).catch(() => {}); else this.app.toast('All decks are playing');
  }

  /** The current view is a normal playlist shown in its own order (# ascending, no search filter). */
  canReorder() {
    if (this.view.kind !== 'playlist' || this.sort.col !== '#' || this.sort.dir !== 1 || this.query.trim()) return false;
    const p = this.playlists.find((x) => x.id === this.view.id);
    return !!p && !p.smart && !p.sourceId;
  }
  /** Move the selected tracks so they start at row `index` (0..rows.length) of the playlist. */
  async reorderPlaylist(index) {
    const p = this.playlists.find((x) => x.id === this.view.id); if (!p) return;
    const ids = p.trackIds, sel = this.selected;
    const moving = ids.filter((id) => sel.has(id));
    if (!moving.length) return;
    const before = ids.slice(0, index).filter((id) => !sel.has(id)).length; // non-moving tracks above the drop point
    const rest = ids.filter((id) => !sel.has(id));
    const next = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
    if (next.every((id, i) => id === ids[i])) return;
    p.trackIds = next; this.applyView(); // instant feedback, then save
    try { await api.updatePlaylist(p.id, { trackIds: next }); } catch (e) { this.app.toast(`Could not reorder: ${e.message}`); }
    this.refresh();
  }

  async removeFromPlaylist() {
    const p = this.playlists.find((x) => x.id === this.view.id); if (!p) return;
    await api.updatePlaylist(p.id, { trackIds: p.trackIds.filter((t) => !this.selected.has(t)) });
    this.selected.clear(); await this.refresh();
  }

  contextMenu(x, y) {
    const ids = [...this.selected]; const tracks = ids.map((i) => this.tracks.get(i));
    const remote = tracks.filter((t) => t.sourceType === 'remote' && !t.localPath);
    const items = [];
    for (let d = 0; d < this.app.deckCount; d++) items.push({ label: `Load to deck ${d + 1}`, action: () => this.app.loadTrack(d, ids[0]).catch(() => {}) });
    items.push({ label: 'Preview in headphones', action: () => this.previewTrack(ids[0]) });
    items.push('-');
    items.push({ label: ids.length > 1 ? `Edit info of ${ids.length} tracks…` : 'Edit track info…', action: () => this.dlg.editTracks(tracks) });
    items.push({ label: 'Colour', sub: [{ label: '⊘ None', action: () => this.dlg.setColor(tracks, null) }, ...TRACK_COLORS.map(([hex, name]) => ({ label: `● ${name}`, color: hex, action: () => this.dlg.setColor(tracks, hex) }))] });
    const missing = tracks.filter((t) => t.missing);
    if (missing.length) items.push({ label: `Relocate missing file${missing.length > 1 ? 's' : ''}…`, action: () => this.dlg.relocate(missing.map((t) => t.id)) });
    if (this.view.kind === 'duplicates' && ids.length === 1) {
      const g = this.dupGroups[this.dupIndex.get(ids[0])];
      if (g) items.push({ label: 'Keep this copy, remove the others', action: async () => { await api.dedupe([{ keep: ids[0], remove: g.ids.filter((x) => x !== ids[0]) }]); this.refresh(); } });
    }
    items.push('-');
    items.push({ label: 'Add to playlist', sub: [{ label: '+ New playlist…', action: async () => { const n = await this.app.dialogs.prompt('New playlist', 'Playlist name'); if (n) { await api.createPlaylist(n, ids); this.refresh(); } } }, ...this.playlists.filter((p) => !p.sourceId && !p.smart).map((p) => ({ label: p.name, action: async () => { await api.addToPlaylist(p.id, ids); this.refresh(); this.app.toast(`Added ${ids.length} to ${p.name}`); } }))] });
    items.push({ label: 'Add to automix queue', action: () => this.app.queueAdd(tracks) });
    if (remote.length) items.push({ label: `Download ${remote.length > 1 ? remote.length + ' tracks' : 'for offline use'}`, action: () => this.download(remote.map((t) => t.id)) });
    const unanalysed = tracks.filter((t) => !t.analyzed);
    if (unanalysed.length) items.push({ label: `Analyse ${unanalysed.length > 1 ? `${unanalysed.length} tracks` : 'now'} (BPM, key, waveform)`, action: () => { const n = this.app.analyser.request(unanalysed); this.app.toast(n ? `Analysing ${n} track(s) in the background` : 'Nothing to analyse (locked BPM / imported grid)'); } });
    else items.push({ label: 'Re-analyse (BPM, key, waveform)', action: async () => { const ok = tracks.filter((t) => !t.bpmLocked); for (const t of ok) { await api.updateTrack(t.id, { analyzed: false, gridLocked: false }); t.analyzed = false; t.gridLocked = false; } const n = this.app.analyser.request(ok); this.app.toast(`Re-analysing ${n} track(s) in the background${ok.length < tracks.length ? ' (locked BPMs kept)' : ''}`); } });
    if (!unavailable('stems')) items.push(...stemsMenuItems(this.app, tracks));
    if (window.opendjNative && tracks[0] && (tracks[0].localPath || tracks[0].path)) items.push({ label: 'Show in folder', action: () => window.opendjNative.reveal(tracks[0].localPath || tracks[0].path) });
    items.push('-');
    const curPl = this.view.kind === 'playlist' && this.playlists.find((p) => p.id === this.view.id);
    if (curPl && !curPl.sourceId && !curPl.smart) items.push({ label: 'Remove from playlist', action: () => this.removeFromPlaylist() });
    items.push({ label: 'Remove from library', danger: true, action: async () => { if (await this.app.dialogs.confirm(platform.local ? `Remove ${ids.length} track(s) from OpenDJ? The copies imported into the app are deleted from this device (your original files are not touched).` : `Remove ${ids.length} track(s) from the library? Files are not deleted.`)) { await api.deleteTracks(ids); this.selected.clear(); this.refresh(); } } });
    this.app.dialogs.menu(x, y, items);
    flipSubmenus();
    // Colour dots for the colour sub-menu (menu() renders plain labels).
    const sub = [...document.querySelectorAll('.ctx-menu .ctx-sub .ctx-item')];
    for (const it of sub) { const c = TRACK_COLORS.find(([, n]) => it.textContent === `● ${n}`); if (c) it.style.setProperty('--sw', c[0]), it.classList.add('ctx-color'); }
  }

  async download(ids) {
    const r = await api.download(ids);
    this.app.toast(`Downloading ${r.queued} track(s) to your download folder`);
  }

  previewTrack(id) {
    const a = this.preview;
    if (a.dataset.id === id && !a.paused) { a.pause(); return; }
    a.src = api.streamUrl(id); a.dataset.id = id;
    const dev = this.app.settings.cueDeviceId;
    (dev && a.setSinkId ? a.setSinkId(dev).catch(() => {}) : Promise.resolve()).then(() => { a.currentTime = 0; a.play().catch(() => {}); const t = this.tracks.get(id); if (t?.duration > 60) a.currentTime = t.duration * 0.35; });
    this.app.toast('Previewing… (right-click → Preview again to stop)');
  }

  setDownloads(d) {
    this.downloads = d;
    const n = d.queued.length + d.active.length;
    const act = d.active[0];
    this.dlStatus = n ? `⬇ ${n} downloading${act?.total ? ` (${Math.round(act.received / act.total * 100)}%)` : ''}` : '';
    this.updateStatus();
    if (!n && this._hadDl) this.refresh();
    this._hadDl = n > 0;
  }
  setJobStatus(s) { this.jobStatus = s; this.updateStatus(); }
  updateStatus() { this.statusEl.textContent = [this.jobStatus, this.dlStatus].filter(Boolean).join('  ·  '); }

  // ---------------- sidebar tree ----------------
  async setView(v, title) {
    const wasOrdered = ORDERED_VIEWS.has(this.view.kind);
    this.view = v; this.viewTitle.textContent = title; this.selected.clear(); this.cursor = -1; this.scroller.scrollTop = 0;
    // playlists, sets and play history open in their own order (# column); other views get the user's sort back
    if (ORDERED_VIEWS.has(v.kind)) { if (!wasOrdered) this._prevSort = this.sort; this.sort = { col: '#', dir: 1 }; }
    else if (wasOrdered && this._prevSort) { this.sort = this._prevSort; this._prevSort = null; }
    this.renderHeader(); this.renderTree();
    await this.loadViewData();
    if (this.view === v) this.applyView();
  }

  renderTree() {
    const item = (label, v, { icon = '', actions = [], count, drop, cls = '', click } = {}) => {
      const active = this.view.kind === v.kind && this.view.id === v.id;
      const node = el('div', { class: `tree-item ${active ? 'active' : ''} ${cls}`, onclick: () => (click ? click() : this.setView(v, label)) },
        el('span', { class: 'ti-icon' }, glyphIcon(icon)), el('span', { class: 'ti-label' }, label),
        count != null ? el('span', { class: 'ti-count' }, String(count)) : null,
        ...actions.map((a) => el('button', { class: 'ti-act', title: a.title, 'aria-label': a.title, onclick: (e) => { e.stopPropagation(); a.fn(e); } }, glyphIcon(a.icon))));
      if (actions[0]?.menu) node.addEventListener('contextmenu', (e) => { e.preventDefault(); actions[0].fn(e); });
      if (drop) {
        node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('drop'); });
        node.addEventListener('dragleave', () => node.classList.remove('drop'));
        node.addEventListener('drop', (e) => { e.preventDefault(); node.classList.remove('drop'); const ids = JSON.parse(e.dataTransfer.getData('text/x-opendj-tracks') || '[]'); if (ids.length) drop(ids); });
      }
      return node;
    };
    const head = (label, ...btns) => el('div', { class: 'tree-head' }, el('span', {}, label), ...btns);
    const userPl = this.playlists.filter((p) => !p.sourceId && !p.smart);
    const smartPl = this.playlists.filter((p) => p.smart);
    const nMissing = [...this.tracks.values()].reduce((n, t) => n + (t.missing ? 1 : 0), 0);
    const sessions = this.showAllSessions ? this.sessions : this.sessions.slice(0, 8);
    const groups = new Map();
    for (const p of userPl) { const f = p.folder || ''; if (!groups.has(f)) groups.set(f, []); groups.get(f).push(p); }
    const plNodes = [];
    for (const [folder, pls] of [...groups.entries()].sort()) {
      if (folder) plNodes.push(el('div', { class: 'tree-folder' }, '▸ ' + folder));
      for (const p of pls) {
        plNodes.push(item(p.name, { kind: 'playlist', id: p.id }, {
          icon: '♫', count: p.trackIds.length, cls: folder ? 'nested' : '',
          drop: async (ids) => { await api.addToPlaylist(p.id, ids); this.refresh(); this.app.toast(`Added ${ids.length} to ${p.name}`); },
          actions: [{ icon: '⋯', title: 'Playlist options', menu: true, fn: (e) => this.playlistMenu(p, e) }],
        }));
      }
    }
    const remotePl = this.playlists.filter((p) => p.sourceId);
    this.tree.replaceChildren(
      item('Collection', { kind: 'all' }, { icon: '◉', count: this.tracks.size }),
      item('Matching master deck', { kind: 'matching' }, { icon: '⚡' }),
      item('Recently added', { kind: 'recent' }, { icon: '✦' }),
      item('Recently played', { kind: 'history' }, { icon: '↺' }),
      item('Most played', { kind: 'played' }, { icon: '♥' }),
      item('Downloaded', { kind: 'downloaded' }, { icon: '⬇' }),
      item('Streaming only', { kind: 'streaming' }, { icon: '☁' }),
      item('Not analysed', { kind: 'unanalysed' }, { icon: '?' }),
      item('Missing files', { kind: 'missing' }, { icon: '⚠', count: nMissing || null, cls: nMissing ? 'has-missing' : '' }),
      item('Duplicates', { kind: 'duplicates' }, { icon: '⧉' }),
      head('SMART PLAYLISTS', el('button', { class: 'ti-act', title: 'New smart playlist', onclick: () => this.dlg.smartPlaylist() }, '+')),
      ...smartPl.map((p) => item(p.name, { kind: 'playlist', id: p.id }, {
        icon: '⚙', count: p.trackIds.length, actions: [{ icon: '⋯', title: 'Smart playlist options', menu: true, fn: (e) => this.playlistMenu(p, e) }],
      })),
      head('HISTORY'),
      ...sessions.map((s) => {
        const node = item(this.sessionLabel(s), { kind: 'session', id: s.id }, { icon: '◷', count: s.count, actions: [{ icon: '⋯', title: 'Export setlist…', fn: () => { const r = node.getBoundingClientRect(); this.dlg.sessionMenu(r.right - 20, r.top, s); } }] });
        return node;
      }),
      ...(this.sessions.length > 8 ? [el('div', { class: 'tree-more', onclick: () => { this.showAllSessions = !this.showAllSessions; this.renderTree(); } }, this.showAllSessions ? 'Show fewer' : `Show all ${this.sessions.length} sessions`)] : []),
      ...(!this.sessions.length ? [el('div', { class: 'tree-empty' }, 'Sets you play are recorded here')] : []),
      head('PLAYLISTS', el('button', { class: 'ti-act', title: 'New playlist', onclick: async () => { const n = await this.app.dialogs.prompt('New playlist', 'Playlist name'); if (n) { await api.createPlaylist(n); this.refresh(); } } }, '+')),
      ...plNodes,
      ...(platform.local ? [] : [head('FOLDERS · USB · NAS', el('button', { class: 'ti-act', title: 'Add folder', onclick: () => this.app.dialogs.addFolder() }, '+'))]),
      ...this.folders.map((f) => item(f.name, { kind: 'folder', id: f.id }, {
        icon: f.online ? '🗀' : '⚠', count: f.trackCount, cls: f.online ? '' : 'offline',
        actions: [{ icon: '⟳', title: 'Rescan', fn: () => api.rescanFolder(f.id).catch((e) => this.app.toast(e.message)) }, { icon: '✕', title: 'Remove folder from library', fn: async () => { if (await this.app.dialogs.confirm(`Remove "${f.name}" from the library? (Files stay on disk.)`)) { await api.removeFolder(f.id); this.refresh(); } } }],
      })),
      ...(platform.local ? [] : this.drives).filter((d) => !this.folders.some((f) => f.path === d.path)).map((d) => el('div', { class: 'tree-item drive', title: `${d.path} — click to add to library`, onclick: async () => { await api.addFolder(d.path, d.name); this.refresh(); this.app.toast(`Scanning ${d.name}…`); } },
        el('span', { class: 'ti-icon' }, glyphIcon(d.kind === 'network' ? '🖧' : d.kind === 'home' ? '⌂' : '⛁')), el('span', { class: 'ti-label' }, `${d.name}`), el('span', { class: 'ti-count' }, d.kind === 'network' ? 'NAS +' : d.kind === 'home' ? '+' : 'USB +'))),
      head('MEDIA SERVERS', el('button', { class: 'ti-act', title: 'Add media server', onclick: () => this.app.dialogs.addSource() }, '+')),
      ...this.sources.flatMap((s) => [
        item(s.name || s.serverName || s.type, { kind: 'source', id: s.id }, {
          icon: '☁', count: s.trackCount,
          actions: [{ icon: '⬇', title: 'Download all tracks for offline use', fn: () => this.download([...this.tracks.values()].filter((t) => t.sourceId === s.id && !t.localPath).map((t) => t.id)) },
            { icon: '⟳', title: 'Sync library and reload its playlists', fn: () => { api.syncSource(s.id).catch((e) => this.app.toast(e.message)); this.loadRemoteLists(s.id); } },
            { icon: '✎', title: 'Edit connection', fn: () => this.app.dialogs.addSource(s) },
            { icon: '✕', title: 'Remove server', fn: async () => { if (await this.app.dialogs.confirm(`Disconnect ${s.name}? Downloaded tracks are kept.`)) { await api.removeSource(s.id); this.refresh(); } } }],
        }),
        ...this.sourcePlaylistNodes(s, remotePl, item),
      ]),
    );
  }

  /** Sidebar entries under a media server: its live playlists (click to open), plus mirrored ones it no longer lists. */
  sourcePlaylistNodes(s, remotePl, item) {
    const st = this.remoteLists.get(s.id);
    const live = st?.lists || [];
    const nodes = live.map((rp) => {
      const mirror = remotePl.find((p) => p.sourceId === s.id && p.remoteId === rp.remoteId);
      const node = item(rp.name, { kind: 'playlist', id: mirror?.id || `remote:${s.id}:${rp.remoteId}` }, {
        icon: rp.smart ? '⚙' : '♫', count: rp.trackCount ?? mirror?.trackIds.length, cls: 'nested remote-pl',
        actions: [{ icon: '⋯', title: 'Playlist options: automix, shuffle & mix, smart mix, import, download', menu: true, fn: (e) => this.remotePlaylistMenu(s, rp, e) }],
        click: () => this.openRemotePlaylist(s, rp).catch(() => {}),
      });
      node.dataset.remotePl = rp.remoteId;
      return node;
    });
    for (const p of remotePl.filter((x) => x.sourceId === s.id && !live.some((rp) => rp.remoteId === x.remoteId))) {
      nodes.push(item(p.name, { kind: 'playlist', id: p.id }, { icon: '♫', count: p.trackIds.length, cls: 'nested', actions: [{ icon: '⋯', title: 'Playlist options', menu: true, fn: (e) => this.playlistMenu(p, e) }] }));
    }
    if (st?.loading && !live.length) nodes.push(el('div', { class: 'tree-empty nested' }, 'Loading playlists…'));
    else if (st?.error) nodes.push(el('div', { class: 'tree-empty nested', title: st.error }, 'Playlists unavailable ', el('button', { class: 'ti-act', title: 'Try again', onclick: () => this.loadRemoteLists(s.id) }, '⟳')));
    return nodes;
  }

  playlistMenu(p, e) {
    const r = this.tree.getBoundingClientRect();
    const x = e?.clientX ?? r.right - 20, y = e?.clientY ?? r.top + 100;
    const items = [
      ...(p.smart ? [{ label: 'Edit rules…', action: () => this.dlg.smartPlaylist(p) }] : []),
      { label: 'Automix this playlist', action: () => this.app.dialogs.automixQueue(p.trackIds.map((i) => this.tracks.get(i)).filter(Boolean), { mode: 'order', title: p.name }) },
      { label: 'Shuffle & mix', action: () => this.app.dialogs.automixQueue(p.trackIds.map((i) => this.tracks.get(i)).filter(Boolean), { mode: 'shuffle', title: p.name }) },
      { label: 'Smart mix', action: () => this.app.dialogs.automixQueue(p.trackIds.map((i) => this.tracks.get(i)).filter(Boolean), { mode: 'smart', title: p.name }) },
      { label: 'Download all for offline use', action: () => this.download(p.trackIds.filter((i) => { const t = this.tracks.get(i); return t?.sourceType === 'remote' && !t.localPath; })) },
      { label: 'Export as M3U8', action: () => { const a = el('a', { href: api.m3uUrl(p.id), download: '' }); document.body.append(a); a.click(); a.remove(); } }, // no navigation: beforeunload would ask while decks play
      ...(unavailable('usbExport') ? [] : [{ label: 'Export to USB / folder…', action: () => this.app.dialogs.exportUsb([p.id]) }]),
      ...(unavailable('cdj') ? [] : [{ label: 'Export to CDJ USB (rekordbox)…', action: () => openCdjExport(this.app, [p.id]) }]),
      ...(unavailable('stems') ? [] : [{ label: 'Prepare AI stems for playlist', action: () => this.app.stems?.enqueue(p.trackIds).catch((e) => this.app.toast(e.message)) }]),
    ];
    if (p.smart) {
      items.push('-',
        { label: 'Save snapshot as normal playlist', action: async () => { await api.createPlaylist(p.name, p.trackIds, p.folder); this.refresh(); this.app.toast(`Created "${p.name}" with ${p.trackIds.length} tracks`); } },
        { label: 'Delete smart playlist', danger: true, action: async () => { if (await this.app.dialogs.confirm(`Delete smart playlist "${p.name}"?`)) { await api.deletePlaylist(p.id); if (this.view.id === p.id) this.setView({ kind: 'all' }, 'Collection'); this.refresh(); } } });
    } else if (!p.sourceId) {
      items.push('-',
        { label: 'Rename…', action: async () => { const n = await this.app.dialogs.prompt('Rename playlist', 'Name', p.name); if (n) { await api.updatePlaylist(p.id, { name: n }); this.refresh(); } } },
        { label: 'Move to folder…', action: async () => { const n = await this.app.dialogs.prompt('Playlist folder', 'Folder name (empty = none)', p.folder || ''); if (n !== null) { await api.updatePlaylist(p.id, { folder: n }); this.refresh(); } } },
        { label: 'Delete playlist', danger: true, action: async () => { if (await this.app.dialogs.confirm(`Delete playlist "${p.name}"?`)) { await api.deletePlaylist(p.id); if (this.view.id === p.id) this.setView({ kind: 'all' }, 'Collection'); this.refresh(); } } });
    }
    this.app.dialogs.menu(x, y, items);
  }
}
