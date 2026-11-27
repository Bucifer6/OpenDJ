import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../server/library.js';
import { sqliteAvailable } from '../server/sqlite-store.js';

test('Library persists to built-in SQLite (node:sqlite), supports FTS5 search, and migrates from library.json', () => {
  assert.equal(sqliteAvailable(), true, 'Node 22+ built-in node:sqlite available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-sqlite-'));
  try {
    const lib = new Library(dir);
    lib.upsertTrack({ id: 't1', title: 'Midnight Groove', artist: 'Ada Lovelace', genre: 'Deep House', bpm: 124, key: '8A', tags: ['warmup', 'club'] });
    lib.upsertTrack({ id: 't2', title: 'Solar Flare', artist: 'Grace Hopper', genre: 'Techno', bpm: 134, key: '9A', tags: ['peak'] });
    lib.createPlaylist('Club Night', ['t1', 't2']);
    lib.flush();
    assert.ok(fs.existsSync(path.join(dir, 'library.db')), 'library.db written');

    // FTS5 prefix search
    const hits = lib.searchTracks('midn');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, 't1');
    const tagHits = lib.searchTracks('warmup');
    assert.equal(tagHits.length, 1);
    assert.equal(tagHits[0].id, 't1');

    // Incremental update & remove
    lib.updateTrack('t1', { rating: 5, playCount: 7 });
    lib.removeTracks(['t2']);
    lib.close();

    // Remove library.json to prove full reload straight from SQLite
    fs.unlinkSync(path.join(dir, 'library.json'));
    const lib2 = new Library(dir);
    assert.equal(lib2.allTracks().length, 1);
    assert.equal(lib2.getTrack('t1').rating, 5);
    assert.equal(lib2.getTrack('t1').playCount, 7);
    assert.equal(lib2.data.playlists.length, 1);
    assert.deepEqual(lib2.data.playlists[0].trackIds, ['t1']);
    // Removed track must no longer appear in FTS5 search
    assert.equal(lib2.searchTracks('solar').length, 0);
    // Updated title must be searchable via FTS5 without leaving stale entries
    lib2.updateTrack('t1', { title: 'Starlight Express' });
    assert.equal(lib2._needsFullSync, false, 'single updateTrack must stay incremental (never trigger replaceAll)');
    assert.equal(lib2.searchTracks('starlight').length, 1);
    assert.equal(lib2.searchTracks('midn').length, 0);
    lib2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Library incremental updateTrack emits track payload and stays O(1) on large libraries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-sqlite-perf-'));
  try {
    const lib = new Library(dir);
    const N = 6000;
    for (let i = 0; i < N; i++) {
      lib.upsertTrack({ id: `t_${i}`, title: `Track ${i}`, artist: `Artist ${i % 200}`, genre: 'House', bpm: 124, key: '8A' });
    }
    lib.flush();
    assert.equal(lib._needsFullSync, false);

    const events = [];
    lib.listeners.add((type, payload) => events.push({ type, payload }));
    const t0 = performance.now();
    lib.updateTrack('t_42', { bpm: 128, key: '9A', analyzed: true });
    assert.equal(lib._needsFullSync, false, 'updateTrack must mark dirty before changed()');
    lib._flushSqlite();
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 500, `single incremental SQLite flush took ${elapsed.toFixed(1)} ms (expected < 500 ms)`);
    const libEv = events.find((e) => e.type === 'library');
    assert.equal(libEv?.payload?.track?.id, 't_42', 'updateTrack emits incremental track payload');
    assert.equal(libEv?.payload?.track?.bpm, 128);
    lib.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SqliteStore migrates legacy v0.6.2 DBs (user_version 0) to rowid-aligned FTS5 seamlessly', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-sqlite-mig-'));
  try {
    const dbPath = path.join(dir, 'library.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT, artist TEXT, album TEXT, genre TEXT, bpm REAL, key_code TEXT, energy REAL, rating INTEGER, play_count INTEGER, json TEXT NOT NULL);
      CREATE TABLE meta (k TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE VIRTUAL TABLE tracks_fts USING fts5(id UNINDEXED, title, artist, album, genre, tags);
      INSERT INTO tracks (rowid, id, title, artist, album, genre, bpm, key_code, energy, rating, play_count, json)
        VALUES (10, 'old1', 'Legacy Anthem', 'DJ Retro', 'Vol 1', 'House', 122, '8A', 7, 4, 2, '{"id":"old1","title":"Legacy Anthem","artist":"DJ Retro","genre":"House","tags":["classic"]}');
      INSERT INTO tracks_fts (rowid, id, title, artist, album, genre, tags)
        VALUES (999, 'old1', 'Legacy Anthem', 'DJ Retro', 'Vol 1', 'House', 'classic');
      PRAGMA user_version = 0;
    `);
    raw.close();

    const lib = new Library(dir);
    assert.equal(lib.searchTracks('classic').length, 1);
    lib.updateTrack('old1', { title: 'Modern Anthem', tags: ['updated'] });
    lib.flush();
    assert.equal(lib.searchTracks('modern').length, 1);
    assert.equal(lib.searchTracks('updated').length, 1);
    assert.equal(lib.searchTracks('legacy').length, 0, 'old FTS entry cleaned up via aligned rowid');
    lib.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
