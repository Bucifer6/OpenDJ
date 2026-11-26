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
    lib2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
