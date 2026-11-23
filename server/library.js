// Persistent library store: tracks, playlists, folders, remote sources and settings.
// Stored as JSON files in the data directory (no native database dependency). The model itself (merge rules,
// sanitising, playlists, sources, settings) is public/js/shared/library-core.js, shared with the mobile app.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonSafe, writeJsonAtomic, chmodQuiet } from './jsonstore.js';
import { sanitizeSettings } from './settings-schema.js';
import { LibraryCore, DEFAULT_SETTINGS, hashId } from '../public/js/shared/library-core.js';

export { DEFAULT_SETTINGS, normTags, sanitizeField, newId, okId } from '../public/js/shared/library-core.js';

const id = hashId;

export class Library extends LibraryCore {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); // new data dirs are private to the user
    fs.mkdirSync(path.join(dataDir, 'waveforms'), { recursive: true });
    this.file = path.join(dataDir, 'library.json');
    this.settingsFile = path.join(dataDir, 'settings.json');
    // files written by older versions were 0644: they hold source passwords / tokens and API keys
    for (const f of [this.file, this.settingsFile, path.join(dataDir, 'auth.json'), path.join(dataDir, 'secrets.json')]) {
      for (const x of [f, f + '.bak', f + '.tmp']) chmodQuiet(x, 0o600);
    }
    this.load();
    if (!this.settings.downloadDir) this.settings.downloadDir = path.join(dataDir, 'Downloads');
  }

  load() {
    const lib = readJsonSafe(this.file);
    if (lib.error) this.loadErrors.push(lib.error);
    this.adoptData(lib.data);
    const st = readJsonSafe(this.settingsFile);
    if (st.error) this.loadErrors.push(st.error);
    const s = st.data && typeof st.data === 'object' ? st.data : {};
    const clean = sanitizeSettings(s, DEFAULT_SETTINGS); // known keys only, invalid values -> default (a bad value must not brick the UI)
    this.settings = { ...this.settings, ...clean, automix: { ...this.settings.automix, ...(clean.automix || {}) } };
    // 0.5.10: Automix's added effects (tricks, teases, AI-stem transitions) were reported as odd beeps in mixes; they
    // are switched off once for everyone (effectsOff marks it done), and stay opt-in in Settings → Automix
    if (!(clean.automix?.effectsOff >= 1)) Object.assign(this.settings.automix, { tricks: 'off', tease: false, stemTransitions: false, effectsOff: 1 });
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
    return t;
  }
  /** Library folder containing a path (for sourceId of relocated tracks). */
  folderFor(p) {
    const abs = path.resolve(p);
    return this.data.folders.filter((f) => abs === f.path || abs.startsWith(f.path.endsWith(path.sep) ? f.path : f.path + path.sep))
      .sort((a, b) => b.path.length - a.path.length)[0] || null;
  }

  onTracksRemoved(ids) {
    for (const tid of ids) { try { fs.unlinkSync(this.waveformPath(tid)); } catch { /* none */ } }
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
