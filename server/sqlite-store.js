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
const DELETE_SQL = 'DELETE FROM tracks WHERE id = ?';
const META_SQL = 'INSERT INTO meta (k, json) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET json=excluded.json';
const FTS_DEL_SQL = 'DELETE FROM tracks_fts WHERE id = ?';
const FTS_INS_SQL = 'INSERT INTO tracks_fts (id, title, artist, album, genre, tags) VALUES (?, ?, ?, ?, ?, ?)';

export class SqliteStore {
  constructor(dbPath) {
    if (!sqliteMod?.DatabaseSync) throw new Error('node:sqlite is not available in this Node runtime');
    this.path = dbPath;
    this.hasFts = false;
    this._withDb((db) => {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA temp_store = MEMORY;
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
      } catch {
        this.hasFts = false;
      }
    });
    for (const suf of ['', '-wal', '-shm']) chmodQuiet(dbPath + suf, 0o600);
  }

  _withDb(fn) {
    const db = new sqliteMod.DatabaseSync(this.path);
    try {
      db.exec('PRAGMA busy_timeout = 3000; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY;');
      return fn(db);
    } finally {
      try { db.close(); } catch { /* */ }
      chmodQuiet(this.path, 0o600);
    }
  }

  trackCount() {
    return this._withDb((db) => Number(db.prepare('SELECT COUNT(*) AS n FROM tracks').get()?.n) || 0);
  }

  hasMeta() {
    return this._withDb((db) => (Number(db.prepare('SELECT COUNT(*) AS n FROM meta').get()?.n) || 0) > 0);
  }

  _prepareWriters(db) {
    return {
      upsert: db.prepare(UPSERT_SQL),
      del: db.prepare(DELETE_SQL),
      meta: db.prepare(META_SQL),
      ftsDel: this.hasFts ? db.prepare(FTS_DEL_SQL) : null,
      ftsIns: this.hasFts ? db.prepare(FTS_INS_SQL) : null,
    };
  }

  _writeOneTrack(st, t) {
    if (!t?.id) return;
    st.upsert.run(
      t.id, t.title || '', t.artist || '', t.album || '', t.genre || '',
      Number.isFinite(Number(t.bpm)) ? Number(t.bpm) : null,
      t.key || null,
      Number.isFinite(Number(t.energy)) ? Number(t.energy) : null,
      Number(t.rating) || 0, Number(t.playCount) || 0,
      JSON.stringify(t),
    );
    if (st.ftsDel && st.ftsIns) {
      st.ftsDel.run(t.id);
      st.ftsIns.run(t.id, t.title || '', t.artist || '', t.album || '', t.genre || '', Array.isArray(t.tags) ? t.tags.join(' ') : '');
    }
  }

  /** Incremental O(dirty) transaction: writes only changed/removed tracks and updated metadata. */
  commitIncremental({ upserts = [], removes = [], meta = null } = {}) {
    this._withDb((db) => {
      const st = this._prepareWriters(db);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const t of upserts) this._writeOneTrack(st, t);
        for (const id of removes) {
          st.del.run(id);
          if (st.ftsDel) st.ftsDel.run(id);
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
      const st = this._prepareWriters(db);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM tracks');
        if (this.hasFts) db.exec('DELETE FROM tracks_fts');
        for (const t of Object.values(data.tracks || {})) this._writeOneTrack(st, t);
        for (const k of ['version', 'playlists', 'folders', 'sources', 'pathAlias']) {
          if (data[k] !== undefined) st.meta.run(k, JSON.stringify(data[k]));
        }
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
      for (const row of db.prepare('SELECT id, json FROM tracks').all()) {
        try { out.tracks[row.id] = JSON.parse(row.json); } catch { /* skip corrupt row */ }
      }
      for (const row of db.prepare('SELECT k, json FROM meta').all()) {
        try { out[row.k] = JSON.parse(row.json); } catch { /* */ }
      }
      return out;
    });
  }

  /** Fast FTS5 prefix search returning matching track IDs (null if FTS unavailable or query has no tokens). */
  searchIds(query, limit = 500) {
    if (!this.hasFts) return null;
    const tokens = String(query || '').trim().toLowerCase().split(/\s+/)
      .map((t) => t.replace(/[^a-z0-9\u00c0-\u024f]/gi, '')).filter((t) => t.length > 0);
    if (!tokens.length) return null;
    const expr = tokens.map((t) => `"${t}"*`).join(' AND ');
    return this._withDb((db) => {
      try {
        const rows = db.prepare('SELECT id FROM tracks_fts WHERE tracks_fts MATCH ? LIMIT ?').all(expr, limit);
        return rows.map((r) => r.id);
      } catch {
        return null;
      }
    });
  }

  close() {
    // Connections are scoped to each operation and closed immediately.
  }
}

export function dbFileExists(p) {
  try { return fs.statSync(p).size > 0; } catch { return false; }
}
