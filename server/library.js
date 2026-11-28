// Persistent library store: tracks, playlists, folders, remote sources and settings.
// Backed by Node 22's built-in SQLite (`node:sqlite`, WAL mode + FTS5) for O(1) incremental writes across
// 50,000+ track libraries, with seamless migration and backup compatibility with `library.json`.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe, writeJsonAtomic, chmodQuiet } from './jsonstore.js';
import { SqliteStore, sqliteAvailable, dbFileExists, stripHeavyAnalysis } from './sqlite-store.js';
import { sanitizeSettings } from './settings-schema.js';
import { LibraryCore, DEFAULT_SETTINGS, hashId, onceMigrations, EDITABLE_TRACK_FIELDS, sanitizeField, normTags } from '../public/js/shared/library-core.js';

export { DEFAULT_SETTINGS, normTags, sanitizeField, newId, okId } from '../public/js/shared/library-core.js';

const id = hashId;
const JSON_MIRROR_LIMIT = 5000; // keep library.json mirrored on flush for small/medium libraries; large libraries stay SQLite-only for speed
const JSON_MIRROR_THROTTLE_MS = 60_000; // when SQLite is active, only refresh the library.json mirror every 60 s (and on close/flush)
const ANALYSIS_CACHE_MAX = 64;

export class Library extends LibraryCore {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); // new data dirs are private to the user
    fs.mkdirSync(path.join(dataDir, 'waveforms'), { recursive: true });
    this.file = path.join(dataDir, 'library.json');
    this.dbFile = path.join(dataDir, 'library.db');
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.sqlite = null;
    this._dirtyTracks = new Set();
    this._removedTracks = new Set();
    this._dirtyMeta = false;
    this._dirtySettings = false;
    this._dirtyJson = false;
    this._needsFullSync = false;
    this._lastJsonMirrorAt = 0;
    this._rev = 0;
    this._analysisCache = new Map(); // trackId -> { barFeatures?, tempoMap? } LRU
    // files written by older versions were 0644: they hold source passwords / tokens and API keys
    for (const f of [this.file, this.dbFile, this.settingsFile, path.join(dataDir, 'auth.json'), path.join(dataDir, 'secrets.json')]) {
      for (const x of [f, f + '.bak', f + '.tmp']) chmodQuiet(x, 0o600);
    }
    this.load();
    if (!this.settings.downloadDir) this.settings.downloadDir = path.join(dataDir, 'Downloads');
  }

  load() {
    const jsonExists = fs.existsSync(this.file);
    const dbExists = dbFileExists(this.dbFile);
    const useSqlite = process.env.OPENDJ_STORAGE !== 'json' && sqliteAvailable();
    let loadedFromJson = false;

    const dbMtimeOf = () => {
      let m = 0;
      for (const suf of ['', '-wal']) {
        try { const t = fs.statSync(this.dbFile + suf).mtimeMs; if (t > m) m = t; } catch { /* */ }
      }
      return m;
    };

    // Stat mtimes BEFORE parsing library.json so normal SQLite startups skip reading/parsing a multi-MB JSON file.
    if (jsonExists) {
      const jsonMtime = (() => { try { return fs.statSync(this.file).mtimeMs; } catch { return 0; } })();
      const dbMtime = dbExists ? dbMtimeOf() : 0;
      if (!useSqlite || !dbExists || jsonMtime > dbMtime) {
        const lib = readJsonSafe(this.file);
        if (lib.error) this.loadErrors.push(lib.error);
        this.adoptData(lib.data);
        loadedFromJson = true;
      }
    }

    if (useSqlite) {
      try {
        this.sqlite = new SqliteStore(this.dbFile);
        if (loadedFromJson) {
          this.sqlite.replaceAll(this.data);
          this._needsFullSync = false;
        } else if (this.sqlite.trackCount() > 0 || this.sqlite.hasMeta()) {
          this.adoptData(this.sqlite.loadAll());
          this._needsFullSync = false;
        } else if (jsonExists) {
          const lib = readJsonSafe(this.file);
          if (lib.error) this.loadErrors.push(lib.error);
          this.adoptData(lib.data);
          this.sqlite.replaceAll(this.data);
          this._needsFullSync = false;
        }
      } catch (e) {
        console.warn('[opendj] SQLite library damaged or unavailable, recovering:', e.message);
        this.sqlite = null;
        // Quarantine corrupt library.db so a fresh DB can be rebuilt from library.json / .bak
        if (dbExists) {
          const ts = Date.now();
          for (const suf of ['', '-wal', '-shm']) {
            try { if (fs.existsSync(this.dbFile + suf)) fs.renameSync(this.dbFile + suf, `${this.dbFile}.corrupt-${ts}${suf}`); } catch { /* */ }
          }
          this.loadErrors.push(`Damaged library.db was quarantined (library.db.corrupt-${ts}) and recovered from backup.`);
        }
        if (!loadedFromJson && (jsonExists || fs.existsSync(this.file + '.bak'))) {
          const lib = readJsonSafe(this.file);
          if (lib.error) this.loadErrors.push(lib.error);
          this.adoptData(lib.data);
        }
        // Rebuild a fresh SQLite store from the recovered in-memory data if possible
        try {
          this.sqlite = new SqliteStore(this.dbFile);
          this.sqlite.replaceAll(this.data);
          this._needsFullSync = false;
        } catch {
          this.sqlite = null;
        }
      }
    }
    const st = readJsonSafe(this.settingsFile);
    if (st.error) this.loadErrors.push(st.error);
    const s = st.data && typeof st.data === 'object' ? st.data : {};
    const clean = sanitizeSettings(s, DEFAULT_SETTINGS); // known keys only, invalid values -> default (a bad value must not brick the UI)
    this.settings = { ...this.settings, ...clean, automix: { ...this.settings.automix, ...(clean.automix || {}) } };
    // 0.5.10: Automix's added effects (tricks, teases, AI-stem transitions) were reported as odd beeps in mixes; they
    // are switched off once for everyone (effectsOff marks it done), and stay opt-in in Settings → Automix
    onceMigrations(this.settings, clean);
    if (!(clean.automix?.effectsOff >= 1)) Object.assign(this.settings.automix, { tricks: 'off', tease: false, stemTransitions: false, effectsOff: 1 });
    for (const e of this.loadErrors) console.error('[opendj]', e);
    if (process.platform === 'win32') this.sqlite?.close();
  }

  _writeAtomic(file, obj) { writeJsonAtomic(file, obj); }

  adoptData(d) {
    super.adoptData(d);
    this._needsFullSync = true;
    this._dirtyJson = true;
    this._dirtyTracks?.clear();
    this._removedTracks?.clear();
    this._dirtyMeta = false;
    this._analysisCache?.clear();
    this._rev = (this._rev || 0) + 1;
  }

  markTrackDirty(tid) {
    if (!tid) return;
    this._dirtyTracks.add(tid);
    this._removedTracks.delete(tid);
    this._dirtyJson = true;
    this._rev++;
  }
  markMetaDirty() {
    this._dirtyMeta = true;
    this._dirtyJson = true;
    this._rev++;
  }

  upsertTrack(t) {
    const res = super.upsertTrack(t);
    this._dirtyTracks.add(res.id);
    this._removedTracks.delete(res.id);
    this._dirtyJson = true;
    this._rev++;
    return res;
  }
  updateTrack(tid, patch) {
    // Mark dirty BEFORE super.updateTrack() invokes this.changed('tracks') so we stay on O(1) incremental SQLite writes.
    const existed = !!this.getTrack(tid);
    if (existed) {
      this._dirtyTracks.add(tid);
      this._removedTracks.delete(tid);
      this._dirtyJson = true;
      this._rev++;
      if (patch && ('barFeatures' in patch || 'tempoMap' in patch)) this._analysisCache.delete(tid);
    }
    const res = super.updateTrack(tid, patch);
    if (!res && existed) this._dirtyTracks.delete(tid);
    return res;
  }
  /** Batch-edit many tracks with a single SQLite flush and single SSE event (avoids N SSE broadcasts). */
  updateTracksBatch(ids, patch) {
    if (!Array.isArray(ids) || !ids.length || !patch || typeof patch !== 'object') return 0;
    let updated = 0;
    for (const tid of ids) {
      const t = this.getTrack(tid);
      if (!t) continue;
      const oldKey = t.key;
      for (const k of EDITABLE_TRACK_FIELDS) if (k in patch) t[k] = sanitizeField(k, patch[k]);
      if ('key' in patch && !('keyConfidence' in patch) && t.key !== oldKey) t.keyConfidence = t.key ? 1 : null;
      if ('tags' in patch) t.tags = normTags(patch.tags);
      if (['title', 'artist', 'album', 'genre', 'year'].some((k) => k in patch)) t.userEdited = true;
      this._dirtyTracks.add(tid);
      this._removedTracks.delete(tid);
      if ('barFeatures' in patch || 'tempoMap' in patch) this._analysisCache.delete(tid);
      updated++;
    }
    if (updated) {
      this._dirtyJson = true;
      this._rev++;
      this.changed('tracks');
    }
    return updated;
  }
  /** Load on-demand heavy analysis fields (`barFeatures`, `tempoMap`) for a track (LRU cached). */
  getTrackAnalysis(tid) {
    const t = this.getTrack(tid);
    if (!t) return null;
    if (t.barFeatures || t.tempoMap) {
      return { ...(t.barFeatures ? { barFeatures: t.barFeatures } : {}), ...(t.tempoMap ? { tempoMap: t.tempoMap } : {}) };
    }
    if (this._analysisCache.has(tid)) {
      const hit = this._analysisCache.get(tid);
      this._analysisCache.delete(tid);
      this._analysisCache.set(tid, hit);
      return hit;
    }
    const data = this.sqlite?.getAnalysis(tid) || {};
    this._analysisCache.set(tid, data);
    if (this._analysisCache.size > ANALYSIS_CACHE_MAX) this._analysisCache.delete(this._analysisCache.keys().next().value);
    return data;
  }
  /** Return track object stripped of heavy on-demand analysis blobs (`barFeatures`, `tempoMap`). */
  slimTrack(t) { return stripHeavyAnalysis(t); }
  updateSettings(patch) {
    this._dirtySettings = true;
    return super.updateSettings(patch);
  }
  removeTracks(ids) {
    const existing = [];
    for (const tid of ids) {
      if (this.getTrack(tid)) {
        this._dirtyTracks.delete(tid);
        this._removedTracks.add(tid);
        this._analysisCache.delete(tid);
        existing.push(tid);
      }
    }
    if (!existing.length) return;
    this._dirtyMeta = true;
    this._dirtyJson = true;
    this._rev++;
    return super.removeTracks(existing);
  }
  changed(what = 'tracks', extra = null) {
    if (what === 'all') this._needsFullSync = true;
    else if (what !== 'tracks') this._dirtyMeta = true;
    this._dirtyJson = true;
    this._rev++;
    return super.changed(what, extra);
  }

  /** Fast FTS5 full-text search across the library (falls back to in-memory filter if FTS unavailable or DB busy). */
  searchTracks(query, limit = 500) {
    const q = String(query || '').trim();
    if (!q) return this.allTracks().slice(0, limit);
    if (this.sqlite) {
      try {
        // Flush pending incremental writes so FTS reflects latest edits immediately
        if (this._needsFullSync || this._dirtyTracks.size || this._removedTracks.size) this._flushSqlite();
        const ids = this.sqlite.searchIds(q, limit);
        if (ids) return ids.map((tid) => this.getTrack(tid)).filter(Boolean);
      } catch (e) {
        console.warn('[opendj] SQLite search failed, falling back to memory search:', e.message);
      }
    }
    const low = q.toLowerCase();
    return this.allTracks().filter((t) => `${t.title || ''} ${t.artist || ''} ${t.album || ''} ${t.genre || ''} ${(t.tags || []).join(' ')}`.toLowerCase().includes(low)).slice(0, limit);
  }

  _flushSqlite() {
    if (!this.sqlite) return;
    if (this._needsFullSync) {
      this.sqlite.replaceAll(this.data);
      this._needsFullSync = false;
      this._dirtyTracks.clear();
      this._removedTracks.clear();
      this._dirtyMeta = false;
      return;
    }
    if (this._dirtyTracks.size || this._removedTracks.size || this._dirtyMeta) {
      const upserts = [...this._dirtyTracks].map((tid) => this.getTrack(tid)).filter(Boolean);
      const removes = [...this._removedTracks];
      const meta = this._dirtyMeta ? {
        version: this.data.version ?? 1,
        playlists: this.data.playlists || [],
        folders: this.data.folders || [],
        sources: this.data.sources || [],
        pathAlias: this.data.pathAlias || {},
      } : null;
      this.sqlite.commitIncremental({ upserts, removes, meta });
      this._dirtyTracks.clear();
      this._removedTracks.clear();
      this._dirtyMeta = false;
    }
  }

  _writeJsonMirror() {
    this._writeAtomic(this.file, this.data);
    this._dirtyJson = false;
    this._lastJsonMirrorAt = Date.now();
    // Keep the mirror's mtime slightly behind library.db so healthy startups skip re-parsing library.json,
    // while any external edit or corruption after flush() has jsonMtime > dbMtime and is detected immediately.
    if (this.sqlite) {
      let dbMtime = 0;
      for (const suf of ['', '-wal']) {
        try { const t = fs.statSync(this.dbFile + suf).mtimeMs; if (t > dbMtime) dbMtime = t; } catch { /* */ }
      }
      if (dbMtime > 0) {
        try { const d = new Date(dbMtime - 20); fs.utimesSync(this.file, d, d); } catch { /* */ }
      }
    }
  }

  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      try {
        if (this.sqlite) {
          const hadWork = this._needsFullSync || this._dirtyTracks.size || this._removedTracks.size || this._dirtyMeta || this._dirtyJson || this._dirtySettings;
          this._flushSqlite();
          if (this._dirtyJson && Object.keys(this.data.tracks).length <= JSON_MIRROR_LIMIT && Date.now() - this._lastJsonMirrorAt >= JSON_MIRROR_THROTTLE_MS) {
            this._writeJsonMirror();
          }
          if (this._dirtySettings || !hadWork) {
            this._writeAtomic(this.settingsFile, this.settings);
            this._dirtySettings = false;
          }
          if (process.platform === 'win32') this.sqlite.close();
        } else {
          this.flush();
        }
        this._saveFailures = 0;
      } catch (e) {
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
    this._flushSqlite();
    if (!this.sqlite || Object.keys(this.data.tracks).length <= JSON_MIRROR_LIMIT) {
      this._writeJsonMirror();
    }
    this._writeAtomic(this.settingsFile, this.settings);
    this._dirtySettings = false;
    if (process.platform === 'win32') this.sqlite?.close();
  }
  close() {
    try { this.flush(); } catch { /* */ }
    this.sqlite?.close();
    this.sqlite = null;
  }

  // ---------- tracks ----------
  static localId(p) { return id('file:' + path.resolve(p)); }

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
    this._dirtyTracks.add(tid);
    this._dirtyMeta = true;
    return t;
  }
  /** Library folder containing a path (for sourceId of relocated tracks). */
  folderFor(p) {
    const abs = path.resolve(p);
    return this.data.folders.filter((f) => abs === f.path || abs.startsWith(f.path.endsWith(path.sep) ? f.path : f.path + path.sep))
      .sort((a, b) => b.path.length - a.path.length)[0] || null;
  }

  onTracksRemoved(ids) {
    for (const tid of ids) fs.promises.unlink(this.waveformPath(tid)).catch(() => {});
  }

  waveformPath(tid) { return path.join(this.dataDir, 'waveforms', tid.replace(/[^a-z0-9]/gi, '') + '.bin'); }

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
}
