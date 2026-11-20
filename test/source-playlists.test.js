// Media-server playlists: listPlaylists({ tracks: false }) summaries and playlistTracks(id) for every source type,
// plus the /api/sources/:id/playlists routes (tracks become playable remote library tracks; remote 401 never leaks).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createClient } from '../server/sources/index.js';
import { start } from '../server/index.js';
import { fakeSubsonic, fakeJellyfin, beatWav } from './fake-servers.js';

const closers = [];
after(() => Promise.all(closers.map((c) => c())));

async function mock(handler) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    log.push({ path: url.pathname, query: url.searchParams, headers: req.headers });
    const out = (await handler(req, url)) || { status: 404, json: {} };
    res.statusCode = out.status || 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(out.json ?? null));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${server.address().port}`, log };
}

const SONGS = [
  { id: 's1', title: 'One', artist: 'A', genre: 'House', bpm: 124 },
  { id: 's2', title: 'Two', artist: 'B', genre: 'Techno', bpm: 128 },
  { id: 's3', title: 'Three', artist: 'C', genre: 'House', bpm: 122 },
];

test('subsonic: playlist summaries (one request) and playlist tracks in order, full track shape', async () => {
  const srv = await fakeSubsonic({ songs: SONGS, playlists: [{ id: 'p1', name: 'Warmup', songIds: ['s3', 's1'] }, { id: 'p2', name: 'Peak', songIds: ['s2'] }] });
  closers.push(srv.close);
  const c = createClient({ type: 'subsonic', url: srv.url, username: 'dj', password: 'secret' });
  const before = srv.log.length;
  const pls = await c.listPlaylists({ tracks: false });
  assert.equal(srv.log.length - before, 1, 'no getPlaylist per playlist');
  assert.deepEqual(pls, [
    { remoteId: 'p1', name: 'Warmup', trackCount: 2, duration: 60, owner: 'dj' },
    { remoteId: 'p2', name: 'Peak', trackCount: 1, duration: 30, owner: 'dj' },
  ]);
  const tracks = await c.playlistTracks('p1');
  assert.deepEqual(tracks.map((t) => [t.remoteId, t.title, t.artist, t.genre, t.bpm, t.format]), [['s3', 'Three', 'C', 'House', 122, 'wav'], ['s1', 'One', 'A', 'House', 124, 'wav']]);
  assert.equal(tracks[0].coverArt, 'al-s3');
  // legacy shape (used by sync) unchanged
  assert.deepEqual((await c.listPlaylists())[0], { remoteId: 'p1', name: 'Warmup', trackRemoteIds: ['s3', 's1'] });
  await assert.rejects(c.playlistTracks('nope'), (e) => e.code === 70);
});

test('jellyfin + emby: audio playlists with ChildCount, paged playlist items with UserId + Fields, non-audio dropped', async () => {
  const items = [
    { Id: 'i1', Name: 'Alpha', Type: 'Audio', Artists: ['X'], Genres: ['House'], RunTimeTicks: 2e9, MediaSources: [{ Container: 'flac', Size: 10, Bitrate: 900000 }] },
    { Id: 'i2', Name: 'Beta', Type: 'Audio', Artists: ['Y'], Genres: [], RunTimeTicks: 3e9 },
  ];
  for (const type of ['jellyfin', 'emby']) {
    const srv = await fakeJellyfin({ items, playlists: [{ Id: 'pl1', Name: 'Sunset', itemIds: ['i2', 'v1', 'i1'] }, { Id: 'pl2', Name: 'Films', MediaType: 'Video', itemIds: [] }] });
    closers.push(srv.close);
    const c = createClient({ type, url: srv.url, username: 'dj', password: 'secret' });
    await c.connect();
    const pls = await c.listPlaylists({ tracks: false });
    assert.deepEqual(pls, [{ remoteId: 'pl1', name: 'Sunset', trackCount: 3, duration: 90 }], type);
    const listReq = srv.log.find((l) => l.query.get('IncludeItemTypes') === 'Playlist');
    assert.equal(listReq.query.get('Fields'), 'ChildCount');
    const tracks = await c.playlistTracks('pl1');
    assert.deepEqual(tracks.map((t) => [t.remoteId, t.title, t.artist, t.duration]), [['i2', 'Beta', 'Y', 300], ['i1', 'Alpha', 'X', 200]], type);
    assert.equal(tracks[1].format, 'flac');
    const itemsReq = srv.log.find((l) => l.path === '/Playlists/pl1/Items');
    assert.equal(itemsReq.query.get('UserId'), 'U1');
    assert.match(itemsReq.query.get('Fields'), /MediaSources/);
    srv.state.revoked = true;
    await assert.rejects(c.playlistTracks('pl1'), (e) => e.status === 401);
  }
});

test('plex: audio playlist summaries (leafCount, duration, smart) and playlist items with part keys', async () => {
  const meta = (k) => ({ ratingKey: String(k), type: 'track', title: `T${k}`, grandparentTitle: 'Artist', parentTitle: 'Album', duration: 180000, Media: [{ bitrate: 320, Part: [{ key: `/library/parts/${k}/1/file.mp3`, container: 'mp3', size: 99 }] }] });
  const srv = await mock((req, url) => {
    if (url.pathname === '/playlists' && url.searchParams.get('playlistType') === 'audio') {
      return { json: { MediaContainer: { Metadata: [{ ratingKey: '77', title: 'Closing', playlistType: 'audio', leafCount: 3, duration: 540000 }, { ratingKey: '78', title: 'Fresh', playlistType: 'audio', smart: true, leafCount: 1 }] } } };
    }
    if (url.pathname === '/playlists/77/items') {
      const start = Number(req.headers['x-plex-container-start'] || 0), size = Number(req.headers['x-plex-container-size'] || 50);
      const all = [meta(5), { ratingKey: '900', type: 'episode', title: 'podcast' }, meta(2)];
      return { json: { MediaContainer: { totalSize: all.length, Metadata: all.slice(start, start + size) } } };
    }
  });
  const c = createClient({ type: 'plex', url: srv.url, token: 'PT' });
  assert.deepEqual(await c.listPlaylists({ tracks: false }), [
    { remoteId: '77', name: 'Closing', trackCount: 3, duration: 540, smart: false },
    { remoteId: '78', name: 'Fresh', trackCount: 1, duration: null, smart: true },
  ]);
  const tracks = await c.playlistTracks('77');
  assert.deepEqual(tracks.map((t) => [t.remoteId, t.remotePath, t.format]), [['5', '/library/parts/5/1/file.mp3', 'mp3'], ['2', '/library/parts/2/1/file.mp3', 'mp3']]);
  assert.equal(srv.log.at(-1).headers['x-plex-token'], 'PT');
  assert.ok(c.streamRequest(tracks[0].remoteId, tracks[0]).url.includes('/library/parts/5/1/file.mp3'));
});

test('mediamax: playlist summaries and playlist tracks with media ids and DJ analysis', async () => {
  const srv = await mock((req, url) => {
    const p = url.pathname;
    if (p === '/api/v1/auth/me') return { json: { id: 'u1' } };
    if (p === '/api/v1/system/info') return { json: { name: 'Home Max', version: '1.4' } };
    if (req.headers['x-api-key'] !== 'mmk_KEY') return { status: 401, json: { message: 'nope' } };
    if (p === '/api/v1/playlists') return { json: [{ id: 'p1', type: 'playlist', title: 'Warmup', childCount: 2, durationMs: 400000 }, { id: 'p2', type: 'playlist', title: 'Smart', smart: { rules: [] } }] };
    if (p === '/api/v1/items/p1/children') return { json: { items: [{ id: 't1', type: 'track', title: 'One', grandparentTitle: 'A' }, { id: 'v1', type: 'movie', title: 'Clip' }, { id: 't2', type: 'track', title: 'Two', grandparentTitle: 'B' }], total: 3 } };
    let m;
    if ((m = /^\/api\/v1\/items\/(t\d)\/analysis$/.exec(p))) return { json: { bpm: m[1] === 't1' ? 125 : null, key: 'A minor', camelot: '8A', energy: 0.6 } };
    if ((m = /^\/api\/v1\/items\/(t\d)$/.exec(p))) return { json: { id: m[1], media: [{ id: `med-${m[1]}`, container: 'flac', size: 5 }] } };
  });
  const c = createClient({ type: 'mediamax', url: srv.url, token: 'mmk_KEY' });
  assert.deepEqual(await c.listPlaylists({ tracks: false }), [
    { remoteId: 'p1', name: 'Warmup', trackCount: 2, duration: 400, smart: false },
    { remoteId: 'p2', name: 'Smart', trackCount: null, duration: null, smart: true },
  ]);
  const tracks = await c.playlistTracks('p1');
  assert.deepEqual(tracks.map((t) => [t.remoteId, t.remotePath, t.format, t.bpm, t.key, t.energy]), [['t1', 'med-t1', 'flac', 125, 'Am', 6], ['t2', 'med-t2', 'flac', null, 'Am', 6]]);
  assert.deepEqual((await c.playlistTracks('p1', { details: false })).map((t) => t.remotePath), [null, null]);
});

const quiet = { log() {}, warn() {}, error() {} };
async function withApp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-pl-'));
  const app = await start({ port: 0, dataDir: path.join(dir, 'd'), ffmpeg: false, log: quiet });
  const c = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${app.port}${url}`, { method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${app.port}`, Host: `127.0.0.1:${app.port}` }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* binary */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  try { await fn({ app, c }); } finally { app.server.close(); app.shutdown(); }
}
const waitJobs = async (c) => { for (let i = 0; i < 100; i++) { if (!(await c('GET', '/api/jobs')).json.length) return; await new Promise((r) => setTimeout(r, 30)); } };

test('routes: list a Subsonic server\'s playlists, open one (tracks stored + mirrored, streamable), errors never 401', () => withApp(async ({ app, c }) => {
  const songs = SONGS.map((s) => ({ ...s, wav: beatWav({ seconds: 2, bpm: s.bpm }) }));
  const srv = await fakeSubsonic({ songs, playlists: [{ id: 'p1', name: 'Warmup', songIds: ['s3', 's1'] }] });
  closers.push(srv.close);
  const add = await c('POST', '/api/sources', { type: 'subsonic', name: 'Navi', url: srv.url, username: 'dj', password: 'secret' });
  assert.equal(add.status, 200, add.text);
  const sid = add.json.source.id;
  await waitJobs(c);

  const list = await c('GET', `/api/sources/${sid}/playlists`);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.length, 1);
  assert.deepEqual([list.json[0].remoteId, list.json[0].name, list.json[0].trackCount], ['p1', 'Warmup', 2]);

  const open = await c('GET', `/api/sources/${sid}/playlists/p1`);
  assert.equal(open.status, 200, open.text);
  assert.deepEqual(open.json.tracks.map((t) => [t.title, t.sourceType, t.sourceId, t.sourceKind, t.remoteId]), [['Three', 'remote', sid, 'subsonic', 's3'], ['One', 'remote', sid, 'subsonic', 's1']]);
  const pl = open.json.playlist;
  assert.equal(pl.sourceId, sid); assert.equal(pl.remoteId, 'p1'); assert.equal(pl.name, 'Warmup');
  assert.deepEqual(pl.trackIds, open.json.tracks.map((t) => t.id));
  assert.ok((await c('GET', '/api/playlists')).json.some((p) => p.id === pl.id && p.trackIds.length === 2), 'mirrored in the library');
  assert.equal((await c('GET', `/api/sources/${sid}/playlists`)).json[0].playlistId, pl.id);

  // the tracks play like any remote track (proxied stream with Range)
  const st = await fetch(`http://127.0.0.1:${app.port}/api/tracks/${pl.trackIds[0]}/stream`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(st.status, 206);
  assert.equal((await st.arrayBuffer()).byteLength, 100);

  // re-opening keeps user work on the tracks (analysis) and updates the mirror
  app.library.updateTrack(pl.trackIds[0], { analyzed: true, bpm: 121.5, key: '8A' });
  const again = await c('GET', `/api/sources/${sid}/playlists/p1`);
  assert.equal(again.json.tracks[0].bpm, 121.5);

  // import as a local playlist keeps the remote references
  const local = await c('POST', '/api/playlists', { name: 'Warmup (local)', trackIds: pl.trackIds });
  assert.deepEqual(local.json.trackIds, pl.trackIds);
  assert.equal(local.json.sourceId, undefined);

  // errors: unknown playlist -> 404, refused login -> 400 (never 401), unknown source -> 404
  assert.equal((await c('GET', `/api/sources/${sid}/playlists/nope`)).status, 404);
  srv.state.refuse = true;
  for (const u of [`/api/sources/${sid}/playlists`, `/api/sources/${sid}/playlists/p1`, `/api/sources/${sid}/libraries`]) {
    const r = await c('GET', u);
    assert.equal(r.status, 400, u);
    assert.match(r.json.error, /refused/);
  }
  assert.equal((await c('GET', '/api/sources/nosuch/playlists')).status, 404);
  assert.equal((await c('GET', `/api/sources/${sid}/playlists/${'x'.repeat(300)}`)).status, 400);
}));

test('routes: a Jellyfin that answers HTTP 401 gives 400; an unreachable server 502', () => withApp(async ({ app, c }) => {
  const srv = await fakeJellyfin({ items: [{ Id: 'i1', Name: 'A', Type: 'Audio' }], playlists: [{ Id: 'pl1', Name: 'Sunset', itemIds: ['i1'] }] });
  closers.push(srv.close);
  const add = await c('POST', '/api/sources', { type: 'jellyfin', name: 'JF', url: srv.url, username: 'dj', password: 'secret' });
  assert.equal(add.status, 200, add.text);
  const sid = add.json.source.id;
  await waitJobs(c);
  const ok = await c('GET', `/api/sources/${sid}/playlists/pl1`);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.playlist.name, 'Sunset');
  srv.state.revoked = true;
  const r = await c('GET', `/api/sources/${sid}/playlists`);
  assert.equal(r.status, 400);
  await srv.close();
  const down = await c('GET', `/api/sources/${sid}/playlists/pl1`);
  assert.equal(down.status, 502, down.text);
  assert.ok(app.library.getSource(sid));
}));
