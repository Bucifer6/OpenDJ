// Persistent library store: tracks, playlists, folders, remote sources and settings.
// Stored as JSON files in the data directory (no native database dependency).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonSafe, writeJsonAtomic, chmodQuiet } from './jsonstore.js';
import { sanitizeSetting, sanitizeSettings } from './settings-schema.js';

export const DEFAULT_SETTINGS = {
  deckCount: 2,
  theme: 'midnight',
  accentColor: '',
  uiScale: 100,
  masterDeviceId: 'default',
  cueDeviceId: '',            // '' = no separate headphone device
  cueMode: 'device',          // 'device' | 'split' (mono master L / mono cue R) | 'channels34'
  crossfaderCurve: 'smooth',  // 'smooth' | 'sharp' | 'constant'
  tempoRange: 8,
  keyLockDefault: true,
  quantize: true,
  syncMode: 'beat',           // 'beat' | 'tempo'
  autoGain: true,
  waveformZoom: 8,            // seconds visible
  waveformColors: 'rgb',      // 'rgb' | 'blue' | 'mono'
  downloadDir: '',
  automix: { transitionBeats: 32, style: 'eqswap', keepSync: true, skipSilence: true, shuffle: false, keySync: false, order: 'harmonic' },
  midiMappings: {},           // deviceName -> mapping object
  recordFormat: 'wav',
  limiter: true,
  latencyHint: 'interactive',
  micDeviceId: '',
  talkoverDb: -12,
  midiClockOutput: '',
  colorFx: 'filter',
  autoCues: true,
  sequencer: null,            // object; replaced wholesale on update (not merged)
  link: { enabled: false, quantum: 4, startStopSync: false },
  lyrics: { online: false, writeLrc: false },
  stemsModelUrl: '', stemsModelSha256: '', stemsBackend: 'auto', stemsAutoLoad: true, stemsOverlap: 0.25,
  highPrecisionAudio: false,  // decks keep 32-bit float audio (2x RAM) instead of 16-bit
  recording: null,
  broadcast: null,
  lighting: null,             // lighting rig + outputs (server/lighting); replaced wholesale on update
  transcodeCacheGB: 4,        // FFmpeg transcode cache cap (data dir/transcode-cache), LRU
  uploadDir: '',              // browser uploads land here ('' = <data dir>/Uploads, or OPENDJ_UPLOAD_DIR)
  uploadMaxMB: 2048,          // per-file upload limit
  downloadMaxMB: 4096,        // per-file limit for offline copies downloaded from media servers
  allowedRoots: null,
  youtubeApiKey: '',          // YouTube Data API key for search (never written to backups)         // hosted mode: folders the web UI may browse/add/export to (OPENDJ_MUSIC_ROOTS wins)
};
// Object-valued settings that are replaced on update instead of shallow-merged.
const REPLACE_SETTINGS = new Set(['midiMappings', 'sequencer', 'lighting']);

const id = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
export const normTags = (v) => {
  const list = Array.isArray(v) ? v : String(v ?? '').split(',');
  const out = [];
  for (const x of list) { const s = String(x).trim().replace(/\s+/g, ' ').slice(0, 60); if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s); }
  return out;
};
// Track fields edited through the API are rendered by the UI: coerce them to the expected types.
const NUM_FIELDS = new Set(['bpm', 'energy', 'rating', 'year', 'duration', 'gridOffset', 'startTime', 'endTime', 'mixIn', 'mixOut', 'downbeat', 'keyShift', 'gain', 'playCount', 'lastPlayed']);
const STR_FIELDS = { title: 500, artist: 500, album: 500, genre: 200, comment: 2000, key: 16, color: 32 };
export function sanitizeField(k, v) {
  if (NUM_FIELDS.has(k)) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (Object.hasOwn(STR_FIELDS, k)) return v === null || v === undefined ? (k === 'key' || k === 'color' ? null : '') : String(v).slice(0, STR_FIELDS[k]);
  if (k === 'analyzed' || k === 'bpmLocked' || k === 'gridLocked') return !!v;
  if (['cues', 'loops', 'phrases', 'hotLoops'].includes(k)) return Array.isArray(v) ? v.slice(0, 1000) : [];
  return v;
}
export const newId = () => crypto.randomBytes(8).toString('hex');
// Ids index plain objects (data.tracks) or come from URLs: never let one name an Object.prototype property.
const BAD_IDS = new Set(['__proto__', 'constructor', 'prototype']);
export const okId = (id) => typeof id === 'string' && id.length > 0 && !BAD_IDS.has(id);

export class Library {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); // new data dirs are private to the user
    fs.mkdirSync(path.join(dataDir, 'waveforms'), { recursive: true });
    this.file = path.join(dataDir, 'library.json');
    this.settingsFile = path.join(dataDir, 'settings.json');
    // files written by older versions were 0644: they hold source passwords / tokens and API keys
    for (const f of [this.file, this.settingsFile, path.join(dataDir, 'auth.json'), path.join(dataDir, 'secrets.json')]) {
      for (const x of [f, f + '.bak', f + '.tmp']) chmodQuiet(x, 0o600);
    }
    this.listeners = new Set();
    this.data = { version: 1, tracks: {}, playlists: [], folders: [], sources: [] };
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.loadErrors = []; // corrupt/missing files recovered at startup (shown to the user)
    this.load();
    if (!this.settings.downloadDir) this.settings.downloadDir = path.join(dataDir, 'Downloads');
  }

  load() {
    const lib = readJsonSafe(this.file);
    if (lib.error) this.loadErrors.push(lib.error);
    const d = lib.data;
    if (d && typeof d === 'object') {
      Object.assign(this.data, d);
      if (!this.data.tracks || typeof this.data.tracks !== 'object' || Array.isArray(this.data.tracks)) this.data.tracks = {};
      for (const k of ['playlists', 'folders', 'sources']) if (!Array.isArray(this.data[k])) this.data[k] = [];
      for (const p of this.data.playlists) if (!Array.isArray(p.trackIds)) p.trackIds = [];
    }
    const st = readJsonSafe(this.settingsFile);
    if (st.error) this.loadErrors.push(st.error);
    const s = st.data && typeof st.data === 'object' ? st.data : {};
    const clean = sanitizeSettings(s, DEFAULT_SETTINGS); // known keys only, invalid values -> default (a bad value must not brick the UI)
    this.settings = { ...this.settings, ...clean, automix: { ...this.settings.automix, ...(clean.automix || {}) } };
    for (const e of this.loadErrors) console.error('[opendj]', e);
  }

  _writeAtomic(file, obj) { writeJsonAtomic(file, obj); }

  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      try { this.flush(); this._saveFailures = 0; } catch (e) {
        // Disk full / read-only / unplugged: keep the data in memory, tell the UI and retry later.
        this._saveFailures = (this._saveFailures || 0) + 1;
        console.error('[opendj] saving the library failed:', e.message);
        this.emit('job-error', { key: 'save', message: `Could not save the library: ${e.message}` });
        this._t = setTimeout(() => this.save(), Math.min(60000, 2000 * this._saveFailures));
      }
    }, 400);
  }
  flush() {
    clearTimeout(this._t);
    this._writeAtomic(this.file, this.data);
    this._writeAtomic(this.settingsFile, this.settings);
  }

  emit(type, payload) { for (const l of this.listeners) l(type, payload); }
  changed(what = 'tracks') { this.save(); this.emit('library', { what }); }

  // ---------- tracks ----------
  static localId(p) { return id('file:' + path.resolve(p)); }
  static remoteId(sourceId, remoteId) { return id(`remote:${sourceId}:${remoteId}`); }

  allTracks() { return Object.values(this.data.tracks); }
  getTrack(tid) { return okId(tid) && Object.hasOwn(this.data.tracks, tid) ? this.data.tracks[tid] : undefined; }

  upsertTrack(t) {
    if (!okId(t?.id)) throw new Error('Bad track id');
    const prev = this.getTrack(t.id);
    // Never overwrite the user's analysis / cue work with re-scanned tag data.
    const keep = prev ? {
      cues: prev.cues, loops: prev.loops, gridOffset: prev.gridOffset, analyzed: prev.analyzed,
      rating: prev.rating, playCount: prev.playCount, lastPlayed: prev.lastPlayed, addedAt: prev.addedAt,
      localPath: prev.localPath, gain: prev.gain, color: prev.color, comment: prev.comment || t.comment,
      tags: prev.tags, phrases: prev.phrases, mixIn: prev.mixIn, mixOut: prev.mixOut, downbeat: prev.downbeat, hotLoops: prev.hotLoops, keyShift: prev.keyShift, bpmLocked: prev.bpmLocked, gridLocked: prev.gridLocked,
      ...(prev.userEdited ? { title: prev.title, artist: prev.artist, album: prev.album, genre: prev.genre, year: prev.year } : {}),
      bpm: prev.analyzed ? prev.bpm : (t.bpm || prev.bpm), key: prev.key || t.key,
    } : {};
    this.data.tracks[t.id] = {
      cues: [], loops: [], rating: 0, playCount: 0, addedAt: Date.now(), ...prev, ...t, ...keep,
    };
    return this.data.tracks[t.id];
  }

  updateTrack(tid, patch) {
    const t = this.getTrack(tid);
    if (!t) return null;
    const allowed = ['title', 'artist', 'album', 'genre', 'year', 'bpm', 'key', 'rating', 'comment', 'cues', 'loops',
      'gridOffset', 'analyzed', 'gain', 'color', 'playCount', 'lastPlayed', 'duration', 'endTime', 'startTime', 'energy', 'bpmLocked', 'gridLocked',
      'phrases', 'tags', 'hotLoops', 'keyShift', 'mixIn', 'mixOut', 'downbeat'];
    for (const k of allowed) if (k in patch) t[k] = sanitizeField(k, patch[k]);
    if ('tags' in patch) t.tags = normTags(patch.tags);
    // Tag edits made in OpenDJ survive a rescan of the file.
    if (['title', 'artist', 'album', 'genre', 'year'].some((k) => k in patch)) t.userEdited = true;
    this.changed('tracks');
    return t;
  }

  /** Track id for a local path: honours relocated tracks (whose id was derived from their old path). */
  trackIdForPath(p) {
    const abs = path.resolve(p);
    const alias = this.data.pathAlias && Object.hasOwn(this.data.pathAlias, abs) ? this.data.pathAlias[abs] : undefined;
    if (alias && this.getTrack(alias)) return alias;
    return Library.localId(abs);
  }
  /** Point an existing track at a new file, keeping its id (and so its cues, analysis and playlist entries). */
  relocateTrack(tid, newPath, sourceId) {
    const t = this.getTrack(tid);
    if (!t) return null;
    const abs = path.resolve(newPath);
    this.data.pathAlias ||= {};
    for (const [k, v] of Object.entries(this.data.pathAlias)) if (v === tid) delete this.data.pathAlias[k];
    if (Library.localId(abs) !== tid) this.data.pathAlias[abs] = tid;
    t.path = abs;
    if (sourceId) t.sourceId = sourceId;
    t.mtime = null; // force a tag re-read on next scan
    return t;
  }
  /** Library folder containing a path (for sourceId of relocated tracks). */
  folderFor(p) {
    const abs = path.resolve(p);
    return this.data.folders.filter((f) => abs === f.path || abs.startsWith(f.path.endsWith(path.sep) ? f.path : f.path + path.sep))
      .sort((a, b) => b.path.length - a.path.length)[0] || null;
  }

  removeTracks(ids) {
    const set = new Set(ids);
    for (const tid of ids) {
      if (!okId(tid)) continue;
      delete this.data.tracks[tid];
      try { fs.unlinkSync(this.waveformPath(tid)); } catch { /* none */ }
    }
    for (const p of this.data.playlists) p.trackIds = p.trackIds.filter((x) => !set.has(x));
    if (this.data.pathAlias) for (const [k, v] of Object.entries(this.data.pathAlias)) if (set.has(v)) delete this.data.pathAlias[k];
    this.changed('tracks');
  }

  waveformPath(tid) { return path.join(this.dataDir, 'waveforms', tid.replace(/[^a-z0-9]/gi, '') + '.bin'); }

  // ---------- playlists ----------
  createPlaylist(name, trackIds = [], extra = {}) {
    const p = { id: newId(), name: String(name ?? '').slice(0, 200) || 'New playlist', trackIds: extra.smart ? [] : [...trackIds], createdAt: Date.now(), ...extra };
    this.data.playlists.push(p);
    this.changed('playlists');
    return p;
  }
  getPlaylist(pid) { return okId(pid) ? this.data.playlists.find((p) => p.id === pid) : undefined; }
  updatePlaylist(pid, patch) {
    const p = this.getPlaylist(pid);
    if (!p) return null;
    if (typeof patch.name === 'string') p.name = patch.name.slice(0, 200) || p.name;
    if (Array.isArray(patch.trackIds) && !p.smart) p.trackIds = patch.trackIds.filter((t) => this.getTrack(t));
    if ('folder' in patch) p.folder = patch.folder;
    if (patch.smart && p.smart) p.smart = patch.smart;
    this.changed('playlists');
    return p;
  }
  addToPlaylist(pid, trackIds) {
    const p = this.getPlaylist(pid);
    if (!p || p.smart) return null;
    for (const t of trackIds) if (this.getTrack(t)) p.trackIds.push(t);
    this.changed('playlists');
    return p;
  }
  deletePlaylist(pid) {
    this.data.playlists = this.data.playlists.filter((p) => p.id !== pid);
    this.changed('playlists');
  }

  // ---------- folders ----------
  addFolder(p, name) {
    const abs = path.resolve(p);
    let f = this.data.folders.find((x) => x.path === abs);
    if (!f) {
      f = { id: id('folder:' + abs), path: abs, name: name || path.basename(abs) || abs, addedAt: Date.now() };
      this.data.folders.push(f);
      this.changed('folders');
    }
    return f;
  }
  getFolder(fid) { return okId(fid) ? this.data.folders.find((x) => x.id === fid) : undefined; }
  removeFolder(fid, { removeTracks = true } = {}) {
    const f = this.data.folders.find((x) => x.id === fid);
    this.data.folders = this.data.folders.filter((x) => x.id !== fid);
    if (f && removeTracks) {
      this.removeTracks(this.allTracks().filter((t) => t.sourceId === fid).map((t) => t.id));
    }
    this.changed('folders');
  }

  // ---------- remote sources ----------
  publicSource(s) {
    const { password, token, ...rest } = s; // never send secrets to the UI
    return { ...rest, hasPassword: !!password, hasToken: !!token };
  }
  getSource(sid) { return okId(sid) ? this.data.sources.find((s) => s.id === sid) : undefined; }
  /** Add or update a source. `replace`: the stored entry becomes exactly `cfg` (dropped secrets stay dropped). */
  saveSource(cfg, { replace = false } = {}) {
    const existing = cfg.id && this.getSource(cfg.id);
    if (existing && replace) for (const k of Object.keys(existing)) if (k !== 'id' && k !== 'addedAt' && !(k in cfg)) delete existing[k];
    if (existing) Object.assign(existing, cfg);
    else this.data.sources.push({ ...cfg, id: cfg.id || newId(), addedAt: Date.now() });
    this.changed('sources');
    return existing || this.data.sources.at(-1);
  }
  removeSource(sid) {
    this.data.sources = this.data.sources.filter((s) => s.id !== sid);
    // Keep downloaded copies; drop stream-only entries.
    const gone = this.allTracks().filter((t) => t.sourceId === sid && !t.localPath).map((t) => t.id);
    for (const t of this.allTracks()) if (t.sourceId === sid && t.localPath) { t.sourceType = 'local'; t.path = t.localPath; }
    this.removeTracks(gone);
    this.data.playlists = this.data.playlists.filter((p) => p.sourceId !== sid || p.trackIds.length);
    this.changed('sources');
  }

  // ---------- settings ----------
  updateSettings(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (!Object.hasOwn(DEFAULT_SETTINGS, k)) continue;
      const r = sanitizeSetting(k, v); // invalid values (and invalid sub-values of objects) are ignored: settings-schema.js
      if (!r.ok) continue;
      this.settings[k] = (r.value && typeof r.value === 'object' && !Array.isArray(r.value) && !REPLACE_SETTINGS.has(k))
        ? { ...this.settings[k], ...r.value } : r.value;
    }
    this.save();
    return this.settings;
  }
}
