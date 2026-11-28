// Built-in SQLite library persistence (Node 22+ `node:sqlite`, zero external dependencies).
// Uses WAL mode for crash safety, O(1) incremental per-track upserts/deletes, and an FTS5 index for instant
// search across 50,000+ tracks. All files are chmod 0600 (owner-only) because sources may hold credentials.
// Connections are opened per transaction/query and closed immediately so no open file handles remain between
// debounced flushes (preventing Windows file-lock EPERM on dataDir cleanup, backup restores, and multi-instance tests).
import fs from 'node:fs';
import { chmodQuiet } from './jsonstore.js';

let sqliteMod = null;
try {
  sqliteMod = await import('node:sqlite');
} catch {
  sqliteMod = null;
}

export const sqliteAvailable = () => !!sqliteMod?.DatabaseSync;

const UPSERT_SQL = `
  INSERT INTO tracks (id, title, artist, album, genre, bpm, key_code, energy, rating, play_count, json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title, artist=excluded.artist, album=excluded.album, genre=excluded.genre,
    bpm=excluded.bpm, key_code=excluded.key_code, energy=excluded.energy, rating=excluded.rating,
    play_count=excluded.play_count, json=excluded.json
`;
const GET_ROWID_SQL = 'SELECT rowid FROM tracks WHERE id = ?';
const DELETE_SQL = 'DELETE FROM tracks WHERE id = ?';
const META_SQL = 'INSERT INTO meta (k, json) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET json=excluded.json';
// Key tracks_fts.rowid to tracks.rowid so single-track FTS deletes are O(log N) instead of O(N) full scans.
const FTS_DEL_SQL = 'DELETE FROM tracks_fts WHERE rowid = ?';
const FTS_INS_SQL = 'INSERT INTO tracks_fts (rowid, id, title, artist, album, genre, tags) VALUES (?, ?, ?, ?, ?, ?, ?)';

const ANALYSIS_FIELDS = ['barFeatures', 'tempoMap'];
const ANALYSIS_UPSERT_SQL = 'INSERT INTO track_analysis (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json';
const ANALYSIS_DEL_SQL = 'DELETE FROM track_analysis WHERE id = ?';
const ANALYSIS_GET_SQL = 'SELECT json FROM track_analysis WHERE id = ?';
const IDLE_CLOSE_MS = 5000;

export function stripHeavyAnalysis(t) {
  if (!t || (!('barFeatures' in t) && !('tempoMap' in t))) return t;
  const { barFeatures, tempoMap, ...slim } = t;
  return slim;
}

function extractHeavyAnalysis(t) {
  let out = null;
  for (const k of ANALYSIS_FIELDS) {
    if (t[k] !== undefined && t[k] !== null && (!Array.isArray(t[k]) || t[k].length > 0)) {
      if (!out) out = {};
      out[k] = t[k];
    }
  }
  return out;
}

export class SqliteStore {
  constructor(dbPath) {
    if (!sqliteMod?.DatabaseSync) throw new Error('node:sqlite is not available in this Node runtime');
    this.path = dbPath;
    this.hasFts = false;
    this._db = null;
    this._st = null;
    this._idleT = null;
    this._withDb((db) => {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA temp_store = MEMORY;
        PRAGMA cache_size = -16000;
        CREATE TABLE IF NOT EXISTS tracks (
          id TEXT PRIMARY KEY,
          title TEXT,
          artist TEXT,
          album TEXT,
          genre TEXT,
          bpm REAL,
          key_code TEXT,
          energy REAL,
          rating INTEGER,
          play_count INTEGER,
          json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tracks_bpm ON tracks(bpm);
        CREATE INDEX IF NOT EXISTS idx_tracks_key ON tracks(key_code);
        CREATE TABLE IF NOT EXISTS track_analysis (
          id TEXT PRIMARY KEY,
          json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
          k TEXT PRIMARY KEY,
          json TEXT NOT NULL
        );
      `);
      try {
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
            id UNINDEXED, title, artist, album, genre, tags
          );
        `);
        this.hasFts = true;
        // One-time migration for older DBs where tracks_fts.rowid was not aligned to tracks.rowid.
        const uv = Number(db.prepare('PRAGMA user_version').get()?.user_version) || 0;
        if (uv < 2) {
          db.exec('BEGIN IMMEDIATE');
          try {
            db.exec('DELETE FROM tracks_fts');
            const ftsIns = db.prepare(FTS_INS_SQL);
            for (const row of db.prepare("SELECT rowid, id, title, artist, album, genre, json_extract(json, '$.tags') AS tags_json FROM tracks").iterate()) {
              let tags = '';
              if (row.tags_json) {
                try {
                  const parsed = JSON.parse(row.tags_json);
                  if (Array.isArray(parsed)) tags = parsed.join(' ');
                } catch { /* ignore */ }
              }
              ftsIns.run(row.rowid, row.id, row.title || '', row.artist || '', row.album || '', row.genre || '', tags);
            }
            db.exec('PRAGMA user_version = 2');
            db.exec('COMMIT');
          } catch (e) {
            try { db.exec('ROLLBACK'); } catch { /* */ }
            throw e;
          }
        }
      } catch {
        this.hasFts = false;
      }
    });
    for (const suf of ['', '-wal', '-shm']) chmodQuiet(dbPath + suf, 0o600);
  }

  _open() {
    if (this._db) return this._db;
    const db = new sqliteMod.DatabaseSync(this.path);
    try {
      db.exec('PRAGMA busy_timeout = 3000; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -16000;');
    } catch (e) {
      try { db.close(); } catch { /* */ }
      throw e;
    }
    this._db = db;
    this._st = null;
    return db;
  }

  _touchIdle() {
    clearTimeout(this._idleT);
    this._idleT = setTimeout(() => this.close(), IDLE_CLOSE_MS);
    this._idleT.unref?.();
  }

  _withDb(fn) {
    const db = this._open();
    try {
      return fn(db);
    } catch (e) {
      // If the handle errored (e.g. corrupt/external change), drop it so the next call reopens cleanly.
      this.close();
      throw e;
    } finally {
      if (this._db) this._touchIdle();
    }
  }

  trackCount() {
    return this._withDb((db) => {
      if (!this._st) this._st = this._prepareWriters(db);
      return Number(this._st.countTracks.get()?.n) || 0;
    });
  }

  hasMeta() {
    return this._withDb((db) => {
      if (!this._st) this._st = this._prepareWriters(db);
      return (Number(this._st.countMeta.get()?.n) || 0) > 0;
    });
  }

  _prepareWriters(db) {
    return {
      upsert: db.prepare(UPSERT_SQL),
      getRowid: db.prepare(GET_ROWID_SQL),
      del: db.prepare(DELETE_SQL),
      meta: db.prepare(META_SQL),
      analysisUpsert: db.prepare(ANALYSIS_UPSERT_SQL),
      analysisDel: db.prepare(ANALYSIS_DEL_SQL),
      analysisGet: db.prepare(ANALYSIS_GET_SQL),
      countTracks: db.prepare('SELECT COUNT(*) AS n FROM tracks'),
      countMeta: db.prepare('SELECT COUNT(*) AS n FROM meta'),
      ftsDel: this.hasFts ? db.prepare(FTS_DEL_SQL) : null,
      ftsIns: this.hasFts ? db.prepare(FTS_INS_SQL) : null,
      ftsSearch: this.hasFts ? db.prepare('SELECT id FROM tracks_fts WHERE tracks_fts MATCH ? LIMIT ?') : null,
    };
  }

  _writeOneTrack(st, t, { isReplaceAll = false } = {}) {
    if (!t?.id) return;
    const prev = !isReplaceAll && st.ftsDel ? st.getRowid.get(t.id) : null;
    if (prev) st.ftsDel.run(prev.rowid);
    const heavy = extractHeavyAnalysis(t);
    const slim = heavy ? stripHeavyAnalysis(t) : t;
    const info = st.upsert.run(
      t.id, t.title || '', t.artist || '', t.album || '', t.genre || '',
      Number.isFinite(Number(t.bpm)) ? Number(t.bpm) : null,
      t.key || null,
      Number.isFinite(Number(t.energy)) ? Number(t.energy) : null,
      Number(t.rating) || 0, Number(t.playCount) || 0,
      JSON.stringify(slim),
    );
    if (heavy) st.analysisUpsert.run(t.id, JSON.stringify(heavy));
    if (st.ftsIns) {
      const rowid = prev ? prev.rowid : (info?.lastInsertRowid ?? st.getRowid.get(t.id)?.rowid);
      if (rowid != null) {
        st.ftsIns.run(rowid, t.id, t.title || '', t.artist || '', t.album || '', t.genre || '', Array.isArray(t.tags) ? t.tags.join(' ') : '');
      }
    }
  }

  /** Incremental O(dirty) transaction: writes only changed/removed tracks and updated metadata. */
  commitIncremental({ upserts = [], removes = [], meta = null } = {}) {
    this._withDb((db) => {
      if (!this._st) this._st = this._prepareWriters(db);
      const st = this._st;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const t of upserts) this._writeOneTrack(st, t);
        for (const id of removes) {
          if (st.ftsDel) {
            const prev = st.getRowid.get(id);
            if (prev) st.ftsDel.run(prev.rowid);
          }
          st.del.run(id);
          st.analysisDel.run(id);
        }
        if (meta) {
          for (const [k, v] of Object.entries(meta)) st.meta.run(k, JSON.stringify(v));
        }
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* */ }
        throw e;
      }
    });
  }

  /** Replace the entire DB snapshot (used during initial migration from library.json or backup restore). */
  replaceAll(data) {
    this._withDb((db) => {
      if (!this._st) this._st = this._prepareWriters(db);
      const st = this._st;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM tracks');
        db.exec('DELETE FROM track_analysis');
        if (this.hasFts) db.exec('DELETE FROM tracks_fts');
        for (const t of Object.values(data.tracks || {})) this._writeOneTrack(st, t, { isReplaceAll: true });
        for (const k of ['version', 'playlists', 'folders', 'sources', 'pathAlias']) {
          if (data[k] !== undefined) st.meta.run(k, JSON.stringify(data[k]));
        }
        if (this.hasFts) db.exec('PRAGMA user_version = 2');
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* */ }
        throw e;
      }
    });
  }

  loadAll() {
    return this._withDb((db) => {
      const out = { version: 1, tracks: {}, playlists: [], folders: [], sources: [] };
      for (const row of db.prepare('SELECT id, json FROM tracks').iterate()) {
        try { out.tracks[row.id] = JSON.parse(row.json); } catch { /* skip corrupt row */ }
      }
      for (const row of db.prepare('SELECT k, json FROM meta').all()) {
        try { out[row.k] = JSON.parse(row.json); } catch { /* */ }
      }
      return out;
    });
  }

  /** Load heavy on-demand analysis fields (`barFeatures`, `tempoMap`) for one track. */
  getAnalysis(id) {
    if (!id) return null;
    return this._withDb((db) => {
      if (!this._st) this._st = this._prepareWriters(db);
      const row = this._st.analysisGet.get(id);
      if (!row?.json) return null;
      try { return JSON.parse(row.json); } catch { return null; }
    });
  }

  /** Fast FTS5 prefix search returning matching track IDs (null if FTS unavailable or query has no tokens). */
  searchIds(query, limit = 500) {
    if (!this.hasFts) return null;
    const tokens = String(query || '').trim().toLowerCase().split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).filter((t) => t.length > 0).slice(0, 12);
    if (!tokens.length) return null;
    const expr = tokens.map((t) => `"${t}"*`).join(' AND ');
    return this._withDb((db) => {
      if (!this._st) this._st = this._prepareWriters(db);
      try {
        const rows = this._st.ftsSearch.all(expr, limit);
        return rows.map((r) => r.id);
      } catch {
        return null;
      }
    });
  }

  close() {
    clearTimeout(this._idleT);
    this._idleT = null;
    const db = this._db;
    this._db = null;
    this._st = null;
    if (db) {
      try { db.close(); } catch { /* */ }
      chmodQuiet(this.path, 0o600);
    }
  }
}

export function dbFileExists(p) {
  try { return fs.statSync(p).size > 0; } catch { return false; }
}
