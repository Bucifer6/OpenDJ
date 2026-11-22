import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateSmart, toCamelot, normSmart } from '../server/smart.js';
import { History, exportSession, SESSION_GAP_MS } from '../server/history.js';
import { Library } from '../server/library.js';
import { relocateTracks, findDuplicates, mergeDuplicates, MissingChecker } from '../server/library-tools.js';
import { start } from '../server/index.js';
import { buildRekordboxXml, parseRekordboxXml } from '../server/rekordbox.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-lib-'));
const DAY = 864e5;
const NOW = Date.UTC(2026, 10, 20, 12);

const TRACKS = [
  { id: 'a', title: 'Deep One', artist: 'Alpha', genre: 'Deep House', bpm: 122, key: 'Am', rating: 4, color: '#ff0000', tags: ['Warmup', 'Vocal'], energy: 5, year: 2019, addedAt: NOW - 2 * DAY, playCount: 3, sourceType: 'local', duration: 360 },
  { id: 'b', title: 'Peak Time', artist: 'Beta', genre: 'Techno', bpm: 132, key: '9A', rating: 2, tags: ['Peak'], energy: 9, year: 2023, addedAt: NOW - 40 * DAY, playCount: 0, sourceType: 'remote', duration: 420 },
  { id: 'c', title: 'Sunset', artist: 'Gamma', genre: 'House', bpm: 124, key: 'C', rating: 5, color: '#00ff00', energy: 6, year: 2021, addedAt: NOW - 10 * DAY, playCount: 1, sourceType: 'remote', localPath: '/x/c.mp3', duration: 300 },
  { id: 'd', title: 'Night Drive', artist: 'Alpha', genre: 'Techno', bpm: 128, key: '5A', rating: 0, energy: 7, addedAt: NOW - 1 * DAY, sourceType: 'local', duration: 200 },
];
const run = (match, rules, extra = {}) => evaluateSmart({ match, rules, ...extra }, TRACKS, { now: NOW }).sort();

test('smart rules: numbers, text, between, any/all', () => {
  assert.deepEqual(run('all', [{ field: 'bpm', op: 'between', value: 120, value2: 125 }]), ['a', 'c']);
  assert.deepEqual(run('all', [{ field: 'genre', op: 'contains', value: 'house' }, { field: 'rating', op: 'gt', value: 3 }]), ['a', 'c']);
  assert.deepEqual(run('any', [{ field: 'genre', op: 'is', value: 'techno' }, { field: 'artist', op: 'is', value: 'gamma' }]), ['b', 'c', 'd']);
  assert.deepEqual(run('all', [{ field: 'genre', op: 'not_contains', value: 'house' }]), ['b', 'd']);
  assert.deepEqual(run('all', [{ field: 'bpm', op: 'is', value: 128 }]), ['d']);
  assert.deepEqual(run('all', [{ field: 'duration', op: 'gt', value: 6.5 }]), ['b']); // minutes
  assert.deepEqual(run('all', [{ field: 'playCount', op: 'is', value: 0 }]), ['b', 'd']);
  assert.deepEqual(run('all', [{ field: 'year', op: 'lt', value: 2022 }]), ['a', 'c']);
  assert.deepEqual(run('all', []), ['a', 'b', 'c', 'd']);
});

test('smart rules: key, colour, tags, dates, source, limit', () => {
  assert.equal(toCamelot('Am'), '8A');
  assert.deepEqual(run('all', [{ field: 'key', op: 'is', value: '8A' }]), ['a']);
  // compatible with 8A: 7A, 8A, 9A, 8B (C major = 8B)
  assert.deepEqual(run('all', [{ field: 'key', op: 'compatible', value: '8A' }]), ['a', 'b', 'c']);
  assert.deepEqual(run('all', [{ field: 'color', op: 'is', value: '#FF0000' }]), ['a']);
  assert.deepEqual(run('all', [{ field: 'color', op: 'empty' }]), ['b', 'd']);
  assert.deepEqual(run('all', [{ field: 'tags', op: 'contains', value: 'vocal' }]), ['a']);
  assert.deepEqual(run('all', [{ field: 'tags', op: 'not_contains', value: 'Peak' }]), ['a', 'c', 'd']);
  assert.deepEqual(run('all', [{ field: 'addedAt', op: 'in_last', value: 7 }]), ['a', 'd']);
  assert.deepEqual(run('all', [{ field: 'source', op: 'is', value: 'downloaded' }]), ['c']);
  assert.deepEqual(run('all', [{ field: 'source', op: 'is', value: 'remote' }]), ['b']);
  assert.deepEqual(run('all', [{ field: 'source', op: 'is', value: 'local' }]), ['a', 'd']);
  // limit keeps the newest additions
  assert.deepEqual(evaluateSmart({ rules: [], limit: 2 }, TRACKS, { now: NOW }), ['d', 'a']);
  assert.deepEqual(normSmart({ match: 'x', rules: [{ field: 'nope' }, { field: 'bpm', op: 'gt', value: 1 }] }), { match: 'all', rules: [{ field: 'bpm', op: 'gt', value: 1 }] });
});

test('history: sessions split after a 2h gap; setlist export', () => {
  const dir = tmpdir();
  const h = new History(dir);
  const t0 = new Date(2026, 10, 20, 22, 0).getTime();
  h.record({ id: 'a', title: 'One', artist: 'X', bpm: 124, duration: 300 }, t0);
  h.record({ id: 'b', title: 'Two', artist: 'Y, "Z"' }, t0 + 5 * 60e3);
  h.record({ id: 'c', title: 'Three', artist: '' }, t0 + 5 * 60e3 + SESSION_GAP_MS + 1);
  h.flush();
  const h2 = new History(dir);
  const list = h2.list();
  assert.equal(list.length, 2);
  assert.equal(list[1].count, 2); // list is newest first
  const s = h2.get(list[1].id);
  const txt = exportSession(s, 'txt');
  assert.match(txt, /22:00 X – One\n22:05 Y, "Z" – Two\n/);
  const csv = exportSession(s, 'csv');
  assert.match(csv, /^#,Time,Artist,Title,BPM,Key,Length\r\n1,22:00,X,One,124\.0,,5:00\r\n2,22:05,"Y, ""Z""",Two/);
  const m3u = exportSession(s, 'm3u8', (id) => (id === 'a' ? '/music/one.mp3' : null));
  assert.equal(m3u, '#EXTM3U\n#EXTINF:300,X - One\n/music/one.mp3\n');
});

test('missing detection + relocate keeps id, cues and playlists; rescans do not duplicate', async () => {
  const dir = tmpdir();
  const lib = new Library(path.join(dir, 'data'));
  const oldDir = path.join(dir, 'old'), newDir = path.join(dir, 'new', 'sub');
  fs.mkdirSync(oldDir); fs.mkdirSync(newDir, { recursive: true });
  const oldPath = path.join(oldDir, 'Song.mp3');
  const id = Library.localId(oldPath);
  lib.upsertTrack({ id, sourceType: 'local', sourceId: 'files', path: oldPath, title: 'Song', size: 5, cues: [{ index: 0, position: 1 }] });
  lib.createPlaylist('Set', [id]);
  const checker = new MissingChecker(lib);
  assert.deepEqual([...checker.missingIds(undefined, { sync: true })], [id]);
  // two candidates with the same name: the one with the same size wins
  fs.writeFileSync(path.join(dir, 'new', 'song.mp3'), 'xxxxxxxx');
  fs.writeFileSync(path.join(newDir, 'Song.mp3'), 'xxxxx');
  const r = await relocateTracks(lib, path.join(dir, 'new'), [id]);
  assert.equal(r.relocated.length, 1);
  const t = lib.getTrack(id);
  assert.equal(t.path, path.join(newDir, 'Song.mp3'));
  assert.equal(t.cues.length, 1);
  assert.deepEqual(lib.data.playlists[0].trackIds, [id]);
  checker.invalidate([id]);
  assert.equal(checker.missingIds(undefined, { sync: true }).size, 0);
  assert.equal(lib.trackIdForPath(path.join(newDir, 'Song.mp3')), id);
  lib.flush();
});

test('duplicate finder groups by artist+title and size+length; merge rewires playlists', () => {
  const dir = tmpdir();
  const lib = new Library(path.join(dir, 'data'));
  lib.upsertTrack({ id: 'a', title: 'Strings of Life (Original Mix)', artist: 'Rhythim Is Rhythim', sourceType: 'local', path: '/a.mp3', playCount: 2, analyzed: true });
  lib.upsertTrack({ id: 'b', title: 'Strings Of Life', artist: 'Rhythim is Rhythim feat. X', sourceType: 'local', path: '/b.mp3', playCount: 1 });
  lib.upsertTrack({ id: 'c', title: 'Other', artist: 'Q', size: 1000, duration: 200.2, sourceType: 'local', path: '/c.mp3' });
  lib.upsertTrack({ id: 'd', title: 'Other (copy)', artist: 'Unknown', size: 1000, duration: 200.4, sourceType: 'local', path: '/d.mp3' });
  lib.upsertTrack({ id: 'e', title: 'Unique', artist: 'Z', sourceType: 'local', path: '/e.mp3' });
  const groups = findDuplicates(lib.allTracks());
  assert.equal(groups.length, 2);
  const g1 = groups.find((g) => g.ids.includes('a'));
  assert.deepEqual(g1.ids, ['a', 'b']); // analysed copy first
  assert.deepEqual(groups.find((g) => g.ids.includes('c')).ids.sort(), ['c', 'd']);
  lib.createPlaylist('P', ['b', 'e', 'a']);
  mergeDuplicates(lib, [{ keep: 'a', remove: ['b'] }]);
  assert.equal(lib.getTrack('b'), undefined);
  assert.equal(lib.getTrack('a').playCount, 3);
  assert.deepEqual(lib.data.playlists[0].trackIds, ['a', 'e']);
  lib.flush();
});

test('backup / restore round trip (no secrets), via the HTTP API', async () => {
  const dir = tmpdir();
  const app = await start({ port: 0, dataDir: path.join(dir, 'data') });
  const J = async (m, u, b) => { const r = await fetch(app.url + u.slice(1), { method: m, headers: { 'Content-Type': 'application/json' }, body: b && JSON.stringify(b) }); const txt = await r.text(); return { status: r.status, body: txt ? JSON.parse(txt) : null, headers: r.headers }; };
  try {
    const lib = app.library;
    lib.upsertTrack({ id: 't1', title: 'One', artist: 'A', sourceType: 'local', path: path.join(dir, 'gone.mp3'), cues: [{ index: 0, position: 2 }] });
    lib.saveSource({ id: 's1', type: 'plex', name: 'Plex', url: 'http://x', token: 'SECRET' });
    await J('POST', '/api/tracks/played', { id: 't1' });
    const smart = (await J('POST', '/api/playlists', { name: 'Smart', smart: { match: 'all', rules: [{ field: 'title', op: 'contains', value: 'one' }] } })).body;
    assert.deepEqual(smart.trackIds, ['t1']);
    await J('PUT', '/api/settings', { tempoRange: 16, sequencer: { steps: [1] }, automix: { keySync: true } });
    // missing flag on GET /api/tracks
    const tracks = (await J('GET', '/api/tracks')).body;
    assert.equal(tracks[0].missing, true);
    assert.equal(lib.getTrack('t1').missing, undefined, 'missing flag is not persisted');

    const r = await fetch(app.url + 'api/backup');
    assert.match(r.headers.get('content-disposition'), /attachment/);
    const backup = await r.json();
    assert.equal(JSON.stringify(backup).includes('SECRET'), false);
    assert.equal(backup.history.sessions.length, 1);

    // wipe, then restore
    lib.removeTracks(['t1']);
    await J('PUT', '/api/settings', { tempoRange: 8 });
    assert.equal((await J('POST', '/api/restore', { nope: 1 })).status, 400);
    const res = (await J('POST', '/api/restore', backup)).body;
    assert.deepEqual(res, { tracks: 1, playlists: 1, sessions: 1 });
    assert.equal(lib.getTrack('t1').cues[0].position, 2);
    assert.equal(lib.settings.tempoRange, 16);
    assert.equal(lib.settings.automix.keySync, true);
    assert.equal(lib.getSource('s1').token, 'SECRET', 'existing credentials are kept');
    const pls = (await J('GET', '/api/playlists')).body;
    assert.deepEqual(pls[0].trackIds, ['t1']);
    const hist = (await J('GET', '/api/history')).body;
    const txt = await (await fetch(`${app.url}api/history/${hist[0].id}/export?format=txt`)).text();
    assert.match(txt, /\d\d:\d\d A – One/);
    // smart playlists reject manual adds
    assert.equal((await J('POST', `/api/playlists/${smart.id}/add`, { trackIds: ['t1'] })).status, 400);
    // bulk update + tags normalised
    await J('POST', '/api/tracks/update', { ids: ['t1'], patch: { tags: 'Peak, peak , Vocal', color: '#ff007f' } });
    assert.deepEqual(lib.getTrack('t1').tags, ['Peak', 'Vocal']);
    // rekordbox export carries the colour
    const xml = await (await fetch(app.url + 'api/export/rekordbox')).text();
    assert.match(xml, /Colour="0xFF007F"/);
  } finally { app.shutdown(); app.server.close(); }
});

test('rekordbox XML colour round trip and comment field', () => {
  const xml = buildRekordboxXml({ tracks: [{ id: 'x', path: '/m/a.mp3', title: 'A', color: '#25fde9', comment: 'hi' }] });
  assert.match(xml, /Colour="0x25FDE9"/);
  const p = parseRekordboxXml(xml);
  assert.equal(p.tracks[0].color, '#25fde9');
  assert.equal(p.tracks[0].comments, 'hi');
});
