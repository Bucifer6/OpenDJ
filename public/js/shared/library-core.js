// Library model shared by the desktop server (server/library.js, JSON files on disk) and the on-device backend of
// the mobile app (public/js/local/, IndexedDB): tracks, playlists, folders, remote sources and settings, with the
// same merge rules (a rescan never overwrites the user's cues / analysis) and the same input sanitising.
// Persistence is the subclass's job: it implements flush() (and may override save()).
import { sanitizeSetting } from './settings-schema.js';
import { sha1Hex, randomHex } from './hash.js';

export const DEFAULT_SETTINGS = {
  deckCount: 2,
  theme: 'midnight',
  jogStyles: {},
  accentColor: '',
  uiScale: 100,
  language: 'auto',           // interface language: 'auto' (browser) | 'en' | 'ro' (public/js/i18n.js)
  layoutMode: 'classic',      // 'classic' | 'performance' | 'waveform' (decks view; 4 decks is deckCount)
  libraryRows: 'compact',     // 'compact' | 'art' (larger artwork rows)
  masterDeviceId: 'default',
  cueDeviceId: '',            // '' = no separate headphone device
  cueMode: 'device',          // 'device' | 'split' (mono master L / mono cue R) | 'channels34'
  crossfaderCurve: 'smooth',  // 'smooth' | 'sharp' | 'constant'
  tempoRange: 8,
  keyLockDefault: true,
  quantize: true,
  syncMode: 'beat',           // 'beat' | 'tempo'
  autoGain: true,
  waveformColors: 'rgb',      // see WAVEFORM_STYLES in ui/waveform.js
  waveformShape: 'bars',      // 'bars' | 'half' | 'smooth' | 'outline'
  downloadDir: '',
  // Automix defaults (0.5.7): Auto style and length (the planner picks per transition), varied styles, beat-matched;
  // (0.5.10) no added effects: tricks, teases of the next track and AI-stem transitions are opt-in
  automix: { transitionBeats: 32, lengthMode: 'auto', style: 'auto', keepSync: true, skipSilence: true, shuffle: false, keySync: false, order: 'harmonic', restoreTempo: true, varyStyles: true, smartStart: true, tricks: 'off', tease: false, stemTransitions: false, effectsOff: 1, onAirLoad: 'ask', shape: 'warmup', preset: 'balanced', sliders: { harmonic: 0.5, energy: 0.5, variety: 0.5 } },
  midiMappings: {},           // deviceName -> mapping object
  recordFormat: 'wav',
  limiter: true,
  latencyHint: 'interactive',
  micDeviceId: '',
  talkoverDb: -12,
  voiceDuckDb: -14, voiceVolume: 1, dedicationLang: 'en', // MC voice / dedications (audio/voice.js, dedications.js)
  midiClockOutput: '',
  colorFx: 'filter',
  mixer: {},                  // mixer v2 config (audio/mixer-config.js fills defaults; crossfaderCurve migrates into it)
  fxPostFader: true,          // beat FX tails ring out after the channel fader / crossfader closes (false = pre-fader FX)
  autoCues: true,
  autoAnalyse: true,          // analyse new tracks (BPM, key, waveform, cues) in the background, in the browser
  updateCheck: true,          // check GitHub for a newer OpenDJ release at startup and every 12 hours
  updateSnooze: null,         // { version, until } after "Later", { version, skip: true } after "Skip this version"
  sequencer: null,            // object; replaced wholesale on update (not merged)
  sampler: null,              // { pads: [{ sound, volume, sync }] } built-in sound / volume / sync-to-beat per pad; replaced wholesale
  link: { enabled: false, quantum: 4, startStopSync: false },
  lyrics: { online: false, writeLrc: false },
  stemsModelUrl: '', stemsModelSha256: '', stemsBackend: 'auto', stemsEngine: 'auto', stemsAutoPrepare: true, stemsAutoLoad: true, stemsOverlap: 0.25, stemsBackground: false, stemsCacheGB: 40, mixLearning: { n: 0, bias: {} },
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
  // turntables (docs/MIXER_AND_TURNTABLES_PLAN.md §6): defaults live in public/js/audio/vinyl.js; {} = all defaults
  vinyl: {},                  // vinyl model for every deck: start, stop, inertia, slipmat, jogWeight, rpm, brakeTime, spinTime, spinSpeed, quartz
  vinylDecks: [],             // per-deck changes to `vinyl` (index = deck), made in each deck's Vinyl panel
  deckOptions: {},            // platterSkin, haptics, needleLock, needleSnap, flickSpinback, bendMode, fineStep, hardLock, scratchHand, tempoResetBeats
};
// Object-valued settings that are replaced on update instead of shallow-merged.
export const REPLACE_SETTINGS = new Set(['midiMappings', 'sequencer', 'lighting', 'sampler', 'updateSnooze']);

/** Short stable id (first 16 hex chars of SHA-1). */
export const hashId = (s) => sha1Hex(String(s)).slice(0, 16);
export const normTags = (v) => {
  const list = Array.isArray(v) ? v : String(v ?? '').split(',');
  const out = [];
  for (const x of list) { const s = String(x).trim().replace(/\s+/g, ' ').slice(0, 60); if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s); }
  return out;
};
// Track fields edited through the API are rendered by the UI: coerce them to the expected types.
const NUM_FIELDS = new Set(['bpm', 'energy', 'rating', 'year', 'duration', 'gridOffset', 'startTime', 'endTime', 'mixIn', 'mixOut', 'downbeat', 'keyShift', 'gain', 'playCount', 'lastPlayed',
  'lufs', 'mainLufs', 'phraseAnchor']); // lufs / mainLufs: LUFS (BS.1770); phraseAnchor: s (a downbeat starting an 8-bar phrase)
const UNIT_FIELDS = new Set(['bpmConfidence', 'keyConfidence', 'phraseConfidence']); // 0..1
const STR_FIELDS = { title: 500, artist: 500, album: 500, genre: 200, comment: 2000, key: 16, color: 32 };
export function sanitizeField(k, v) {
  if (UNIT_FIELDS.has(k)) return v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(1, Number(v)));
  if (NUM_FIELDS.has(k)) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (Object.hasOwn(STR_FIELDS, k)) return v === null || v === undefined ? (k === 'key' || k === 'color' ? null : '') : String(v).slice(0, STR_FIELDS[k]);
  if (k === 'analyzed' || k === 'bpmLocked' || k === 'gridLocked' || k === 'unreadable') return !!v;
  if (['cues', 'loops', 'phrases', 'hotLoops'].includes(k)) return Array.isArray(v) ? v.slice(0, 1000) : [];
  return v;
}
export const newId = () => randomHex(8);
// Ids index plain objects (data.tracks) or come from URLs: never let one name an Object.prototype property.
const BAD_IDS = new Set(['__proto__', 'constructor', 'prototype']);
export const okId = (id) => typeof id === 'string' && id.length > 0 && !BAD_IDS.has(id);

/** Track fields the API may edit (PATCH /api/tracks/:id). */
export const EDITABLE_TRACK_FIELDS = ['title', 'artist', 'album', 'genre', 'year', 'bpm', 'key', 'rating', 'comment', 'cues', 'loops',
  'gridOffset', 'analyzed', 'gain', 'color', 'playCount', 'lastPlayed', 'duration', 'endTime', 'startTime', 'energy', 'bpmLocked', 'gridLocked',
  'phrases', 'tags', 'hotLoops', 'keyShift', 'mixIn', 'mixOut', 'downbeat', 'unreadable', 'bpmConfidence',
  'keyConfidence', 'lufs', 'mainLufs', 'phraseAnchor', 'phraseConfidence'];

export class LibraryCore {
  constructor() {
    this.listeners = new Set();
    this.data = { version: 1, tracks: {}, playlists: [], folders: [], sources: [] };
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.loadErrors = []; // corrupt/missing data recovered at startup (shown to the user)
  }

  /** Validate loaded library data in place (wrong shapes from older versions / hand edits become empty). */
  adoptData(d) {
    if (!d || typeof d !== 'object') return;
    Object.assign(this.data, d);
    if (!this.data.tracks || typeof this.data.tracks !== 'object' || Array.isArray(this.data.tracks)) this.data.tracks = {};
    for (const k of ['playlists', 'folders', 'sources']) if (!Array.isArray(this.data[k])) this.data[k] = [];
    for (const p of this.data.playlists) if (!Array.isArray(p.trackIds)) p.trackIds = [];
  }

  /** Persist now. Implemented by subclasses (may return a promise). */
  flush() {}
  /** Debounced flush; failures are reported to the UI and retried. */
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(async () => {
      try { await this.flush(); this._saveFailures = 0; } catch (e) {
        this._saveFailures = (this._saveFailures || 0) + 1;
        console.error('[opendj] saving the library failed:', e.message);
        this.emit('job-error', { key: 'save', message: `Could not save the library: ${e.message}` });
        this._t = setTimeout(() => this.save(), Math.min(60000, 2000 * this._saveFailures));
      }
    }, 400);
  }

  emit(type, payload) { for (const l of this.listeners) l(type, payload); }
  changed(what = 'tracks') { this.save(); this.emit('library', { what }); }

  // ---------- tracks ----------
  static remoteId(sourceId, remoteId) { return hashId(`remote:${sourceId}:${remoteId}`); }

  allTracks() { return Object.values(this.data.tracks); }
  getTrack(tid) { return okId(tid) && Object.hasOwn(this.data.tracks, tid) ? this.data.tracks[tid] : undefined; }

  upsertTrack(t) {
    if (!okId(t?.id)) throw new Error('Bad track id');
    const prev = this.getTrack(t.id);
    // Never overwrite the user's analysis / cue work with re-scanned tag data.
    const keep = prev ? {
      cues: prev.cues, loops: prev.loops, gridOffset: prev.gridOffset, analyzed: prev.analyzed, bpmConfidence: prev.bpmConfidence,
      rating: prev.rating, playCount: prev.playCount, lastPlayed: prev.lastPlayed, addedAt: prev.addedAt,
      localPath: prev.localPath, gain: prev.gain, color: prev.color, comment: prev.comment || t.comment,
      keyConfidence: prev.keyConfidence, lufs: prev.lufs, mainLufs: prev.mainLufs, phraseAnchor: prev.phraseAnchor, phraseConfidence: prev.phraseConfidence,
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
    const oldKey = t.key;
    for (const k of EDITABLE_TRACK_FIELDS) if (k in patch) t[k] = sanitizeField(k, patch[k]);
    // a key changed without a confidence (typed by the user, imported) is trusted: 1; a cleared key has none
    if ('key' in patch && !('keyConfidence' in patch) && t.key !== oldKey) t.keyConfidence = t.key ? 1 : null;
    if ('tags' in patch) t.tags = normTags(patch.tags);
    // Tag edits made in OpenDJ survive a rescan of the file.
    if (['title', 'artist', 'album', 'genre', 'year'].some((k) => k in patch)) t.userEdited = true;
    this.changed('tracks');
    return t;
  }

  /** Called with the ids of removed tracks (subclasses delete waveforms / cached files). */
  onTracksRemoved(_ids) {}
  removeTracks(ids) {
    const set = new Set(ids);
    const gone = [];
    for (const tid of ids) {
      if (!okId(tid)) continue;
      delete this.data.tracks[tid];
      gone.push(tid);
    }
    this.onTracksRemoved(gone);
    for (const p of this.data.playlists) p.trackIds = p.trackIds.filter((x) => !set.has(x));
    if (this.data.pathAlias) for (const [k, v] of Object.entries(this.data.pathAlias)) if (set.has(v)) delete this.data.pathAlias[k];
    this.changed('tracks');
  }

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
    const { password, token, accountToken, ...rest } = s; // never send secrets to the UI
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
