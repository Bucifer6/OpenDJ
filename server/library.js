// Persistent library store: tracks, playlists, folders, remote sources and settings.
// Stored as JSON files in the data directory (no native database dependency).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_SETTINGS = {
  deckCount: 2,
  theme: 'dark',
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
  automix: { transitionBeats: 32, style: 'eqswap', keepSync: true, skipSilence: true, shuffle: false },
  midiMappings: {},           // deviceName -> mapping object
  recordFormat: 'wav',
  limiter: true,
};

const id = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
export const newId = () => crypto.randomBytes(8).toString('hex');

export class Library {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'waveforms'), { recursive: true });
    this.file = path.join(dataDir, 'library.json');
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.listeners = new Set();
    this.data = { version: 1, tracks: {}, playlists: [], folders: [], sources: [] };
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.load();
    if (!this.settings.downloadDir) this.settings.downloadDir = path.join(dataDir, 'Downloads');
  }

  load() {
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* new library */ }
    try {
      const s = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      this.settings = { ...this.settings, ...s, automix: { ...this.settings.automix, ...(s.automix || {}) } };
    } catch { /* defaults */ }
  }

  _writeAtomic(file, obj) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  }

  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush(), 400);
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
  getTrack(tid) { return this.data.tracks[tid]; }

  upsertTrack(t) {
    const prev = this.data.tracks[t.id];
    // Never overwrite the user's analysis / cue work with re-scanned tag data.
    const keep = prev ? {
      cues: prev.cues, loops: prev.loops, gridOffset: prev.gridOffset, analyzed: prev.analyzed,
      rating: prev.rating, playCount: prev.playCount, lastPlayed: prev.lastPlayed, addedAt: prev.addedAt,
      localPath: prev.localPath, gain: prev.gain, color: prev.color, comment: prev.comment || t.comment,
      bpm: prev.analyzed ? prev.bpm : (t.bpm || prev.bpm), key: prev.key || t.key,
    } : {};
    this.data.tracks[t.id] = {
      cues: [], loops: [], rating: 0, playCount: 0, addedAt: Date.now(), ...prev, ...t, ...keep,
    };
    return this.data.tracks[t.id];
  }

  updateTrack(tid, patch) {
    const t = this.data.tracks[tid];
    if (!t) return null;
    const allowed = ['title', 'artist', 'album', 'genre', 'year', 'bpm', 'key', 'rating', 'comment', 'cues', 'loops',
      'gridOffset', 'analyzed', 'gain', 'color', 'playCount', 'lastPlayed', 'duration', 'endTime', 'startTime', 'energy', 'bpmLocked'];
    for (const k of allowed) if (k in patch) t[k] = patch[k];
    this.changed('tracks');
    return t;
  }

  removeTracks(ids) {
    const set = new Set(ids);
    for (const tid of ids) {
      delete this.data.tracks[tid];
      try { fs.unlinkSync(this.waveformPath(tid)); } catch { /* none */ }
    }
    for (const p of this.data.playlists) p.trackIds = p.trackIds.filter((x) => !set.has(x));
    this.changed('tracks');
  }

  waveformPath(tid) { return path.join(this.dataDir, 'waveforms', tid.replace(/[^a-z0-9]/gi, '') + '.bin'); }

  // ---------- playlists ----------
  createPlaylist(name, trackIds = [], extra = {}) {
    const p = { id: newId(), name: name || 'New playlist', trackIds: [...trackIds], createdAt: Date.now(), ...extra };
    this.data.playlists.push(p);
    this.changed('playlists');
    return p;
  }
  getPlaylist(pid) { return this.data.playlists.find((p) => p.id === pid); }
  updatePlaylist(pid, patch) {
    const p = this.getPlaylist(pid);
    if (!p) return null;
    if (typeof patch.name === 'string') p.name = patch.name;
    if (Array.isArray(patch.trackIds)) p.trackIds = patch.trackIds.filter((t) => this.data.tracks[t]);
    if ('folder' in patch) p.folder = patch.folder;
    this.changed('playlists');
    return p;
  }
  addToPlaylist(pid, trackIds) {
    const p = this.getPlaylist(pid);
    if (!p) return null;
    for (const t of trackIds) if (this.data.tracks[t]) p.trackIds.push(t);
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
  getSource(sid) { return this.data.sources.find((s) => s.id === sid); }
  saveSource(cfg) {
    const existing = cfg.id && this.getSource(cfg.id);
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
      if (!(k in DEFAULT_SETTINGS)) continue;
      this.settings[k] = (v && typeof v === 'object' && !Array.isArray(v) && k !== 'midiMappings')
        ? { ...this.settings[k], ...v } : v;
    }
    this.save();
    return this.settings;
  }
}
