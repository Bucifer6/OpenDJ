import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createClient, SOURCE_TYPES, PlexClient, JellyfinClient, EmbyClient, SubsonicClient } from '../server/sources/index.js';

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

/** Start a mock server; handler(req, url, body) returns { status?, json?, text? }. Records requests. */
async function mock(handler) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const url = new URL(req.url, 'http://x');
    log.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const out = (await handler(req, url, body)) || { status: 404, text: 'not found' };
    res.statusCode = out.status || 200;
    if (out.json !== undefined) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out.json));
    } else res.end(out.text || '');
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, log };
}

const ok = (extra = {}) => ({ json: { 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.53', ...extra } } });
const fail = (code, message) => ({ json: { 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code, message } } } });

test('index: createClient + SOURCE_TYPES', () => {
  assert.ok(createClient({ type: 'plex', url: 'http://a' }) instanceof PlexClient);
  assert.ok(createClient({ type: 'jellyfin', url: 'http://a' }) instanceof JellyfinClient);
  assert.ok(createClient({ type: 'emby', url: 'http://a' }) instanceof EmbyClient);
  assert.ok(createClient({ type: 'subsonic', url: 'http://a' }) instanceof SubsonicClient);
  assert.throws(() => createClient({ type: 'nope' }));
  assert.deepEqual(SOURCE_TYPES.map((t) => t.type).sort(), ['emby', 'jellyfin', 'mediamax', 'plex', 'subsonic']);
  for (const t of SOURCE_TYPES) assert.ok(t.fields.some((f) => f.name === 'url'));
});

test('subsonic: token auth params, search3 paging, playlists, stream urls', async () => {
  const songs = Array.from({ length: 501 }, (_, i) => ({ id: `s${i}`, title: `T${i}`, artist: 'A', album: 'Al', duration: 200, suffix: 'flac', bpm: i === 0 ? 124 : undefined, track: 1, year: 2020 }));
  const srv = await mock((req, url) => {
    const q = url.searchParams;
    if (q.get('p')) return fail(40, 'should not use password');
    const expected = createHash('md5').update('secret' + q.get('s')).digest('hex');
    if (q.get('t') !== expected || q.get('u') !== 'dj') return fail(40, 'wrong creds');
    switch (url.pathname) {
      case '/rest/ping':
        return ok();
      case '/rest/search3': {
        const off = Number(q.get('songOffset'));
        const n = Number(q.get('songCount'));
        return ok({ searchResult3: { song: songs.slice(off, off + n) } });
      }
      case '/rest/getPlaylists':
        return ok({ playlists: { playlist: [{ id: 'p1', name: 'Warmup' }] } });
      case '/rest/getPlaylist':
        return ok({ playlist: { id: 'p1', entry: [{ id: 's1' }, { id: 's2' }] } });
    }
  });
  const c = createClient({ type: 'subsonic', url: srv.url + '/', username: 'dj', password: 'secret' });
  const info = await c.connect();
  assert.equal(info.ok, true);
  assert.equal(info.serverName, 'Navidrome');
  const first = srv.log[0].query;
  assert.equal(first.get('v'), '1.16.1');
  assert.equal(first.get('c'), 'OpenDJ');
  assert.equal(first.get('f'), 'json');
  assert.ok(first.get('s'));
  assert.equal(first.get('p'), null);

  const tracks = await c.listTracks();
  assert.equal(tracks.length, 501);
  assert.equal(tracks[0].bpm, 124);
  assert.equal(tracks[1].bpm, null);
  assert.equal(tracks[0].format, 'flac');
  assert.equal(tracks[0].duration, 200);
  const searches = srv.log.filter((l) => l.path === '/rest/search3');
  assert.deepEqual(searches.map((s) => s.query.get('songOffset')), ['0', '500']);
  assert.equal(searches[0].query.get('query'), '');

  const pls = await c.listPlaylists();
  assert.deepEqual(pls, [{ remoteId: 'p1', name: 'Warmup', trackRemoteIds: ['s1', 's2'] }]);

  const s = new URL(c.streamRequest('s1').url);
  assert.equal(s.pathname, '/rest/stream');
  assert.equal(s.searchParams.get('id'), 's1');
  assert.equal(s.searchParams.get('format'), 'raw');
  assert.ok(s.searchParams.get('t'));
  assert.equal(new URL(c.downloadRequest('s1').url).pathname, '/rest/download');
  assert.equal(new URL(c.coverRequest('s1').url).pathname, '/rest/getCoverArt');
});

test('subsonic: legacy p=enc:hex only when chosen (error 41 never auto-downgrades), and album walk when search3 is empty', async () => {
  const srv = await mock((req, url) => {
    const q = url.searchParams;
    if (q.get('t')) return fail(41, 'Token authentication not supported for LDAP users.');
    if (q.get('p') !== 'enc:' + Buffer.from('pässword').toString('hex')) return fail(40, 'bad');
    switch (url.pathname) {
      case '/rest/ping':
        return ok({ type: undefined });
      case '/rest/search3':
        return ok({ searchResult3: {} });
      case '/rest/getAlbumList2':
        return ok({ albumList2: { album: Number(q.get('offset')) === 0 ? [{ id: 'al1' }, { id: 'al2' }] : [] } });
      case '/rest/getAlbum':
        return ok({ album: { id: q.get('id'), song: [{ id: q.get('id') + '-1', title: 'x', suffix: 'mp3' }] } });
    }
  });
  const auto = new SubsonicClient({ type: 'subsonic', url: srv.url, username: 'dj', password: 'pässword' });
  await assert.rejects(auto.connect(), (e) => e.code === 41 && /Legacy password auth/.test(e.message));
  assert.equal(auto.legacyAuth, false);
  assert.equal(srv.log.length, 1, 'no retry with the password in the URL');
  assert.ok(srv.log[0].query.get('t'));
  assert.equal(srv.log[0].query.get('p'), null);
  const c = new SubsonicClient({ type: 'subsonic', url: srv.url, username: 'dj', password: 'pässword', legacyAuth: true });
  await c.connect();
  assert.deepEqual(c.persistable(), {});
  assert.ok(srv.log[1].query.get('p').startsWith('enc:'));
  const tracks = await c.listTracks();
  assert.deepEqual(tracks.map((t) => t.remoteId), ['al1-1', 'al2-1']);
  assert.ok(new URL(c.streamRequest('x').url).searchParams.get('p').startsWith('enc:'));
});

test('subsonic: non-41 errors propagate', async () => {
  const srv = await mock(() => fail(40, 'Wrong username or password'));
  const c = new SubsonicClient({ url: srv.url, username: 'a', password: 'b' });
  await assert.rejects(c.connect(), /40/);
});

test('jellyfin: auth headers, token storage, paged tracks, playlists, urls', async () => {
  const items = Array.from({ length: 750 }, (_, i) => ({
    Id: `id${i}`,
    Name: `Song ${i}`,
    Artists: ['Art'],
    AlbumArtist: 'AA',
    Album: 'Alb',
    Genres: ['House', 'Deep'],
    ProductionYear: 2019,
    IndexNumber: 3,
    RunTimeTicks: 1800000000,
    MediaSources: [{ Container: 'flac', Size: 1234, Bitrate: 900000, Path: '/m/a.flac' }],
    ImageTags: { Primary: 'abc' },
  }));
  const srv = await mock((req, url, body) => {
    const p = url.pathname;
    if (p === '/Users/AuthenticateByName' && req.method === 'POST') {
      const b = JSON.parse(body);
      if (b.Username !== 'dj' || b.Pw !== 'pw') return { status: 401 };
      return { json: { AccessToken: 'TOK', User: { Id: 'U1' } } };
    }
    if (!/Token="TOK"/.test(req.headers.authorization || '')) return { status: 401 };
    if (p === '/System/Info') return { json: { ServerName: 'Home', Version: '10.9.0' } };
    if (p === '/Users/U1/Items') {
      const q = url.searchParams;
      const start = Number(q.get('StartIndex'));
      const limit = Number(q.get('Limit'));
      if (q.get('IncludeItemTypes') === 'Playlist') return { json: { Items: [{ Id: 'pl1', Name: 'Peak', MediaType: 'Audio' }], TotalRecordCount: 1 } };
      return { json: { Items: items.slice(start, start + limit), TotalRecordCount: items.length } };
    }
    if (p === '/Playlists/pl1/Items' && url.searchParams.get('UserId') === 'U1') return { json: { Items: [{ Id: 'id3', Type: 'Audio' }, { Id: 'id1', Type: 'Audio' }] } };
  });
  const c = createClient({ type: 'jellyfin', url: srv.url, username: 'dj', password: 'pw' });
  const info = await c.connect();
  assert.deepEqual(info, { ok: true, serverName: 'Home', version: '10.9.0' });
  assert.deepEqual(c.persistable(), { token: 'TOK', userId: 'U1' });

  const authReq = srv.log[0];
  assert.match(authReq.headers.authorization, /^MediaBrowser Client="OpenDJ", Device="OpenDJ", DeviceId="opendj-[0-9a-f]+", Version="0\.1\.0"$/);
  assert.equal(authReq.headers['x-emby-authorization'], authReq.headers.authorization);

  let progress = 0;
  const tracks = await c.listTracks({ onProgress: (d) => (progress = d) });
  assert.equal(tracks.length, 750);
  assert.equal(progress, 750);
  const pages = srv.log.filter((l) => l.path === '/Users/U1/Items');
  assert.deepEqual(pages.map((l) => l.query.get('StartIndex')), ['0', '500']);
  assert.equal(pages[0].query.get('Fields'), 'Genres,MediaSources,ProductionYear,Path');
  assert.equal(pages[0].query.get('Recursive'), 'true');
  const t = tracks[0];
  assert.equal(t.duration, 180);
  assert.equal(t.genre, 'House, Deep');
  assert.equal(t.format, 'flac');
  assert.equal(t.bitrate, 900);
  assert.equal(t.year, 2019);

  assert.deepEqual(await c.listPlaylists(), [{ remoteId: 'pl1', name: 'Peak', trackRemoteIds: ['id3', 'id1'] }]);
  assert.equal(c.streamRequest('id1').url, `${srv.url}/Audio/id1/stream?static=true&api_key=TOK`);
  assert.equal(c.downloadRequest('id1').url, `${srv.url}/Items/id1/Download?api_key=TOK`);
  assert.ok(c.coverRequest('id1').url.startsWith(`${srv.url}/Items/id1/Images/Primary`));
});

test('emby: retries with /emby prefix when the bare URL 404s', async () => {
  const srv = await mock((req, url) => {
    const p = url.pathname;
    if (!p.startsWith('/emby/')) return { status: 404 };
    if (!req.headers['x-emby-authorization']) return { status: 400 };
    if (p === '/emby/Users/AuthenticateByName') return { json: { AccessToken: 'E', User: { Id: 'U' } } };
    if (p === '/emby/System/Info') return { json: { ServerName: 'Emby Box', Version: '4.8' } };
    if (p === '/emby/Users/U/Items') return { json: { Items: [{ Id: '1', Name: 'x', RunTimeTicks: 10000000 }], TotalRecordCount: 1 } };
  });
  const c = createClient({ type: 'emby', url: srv.url, username: 'u', password: 'p' });
  const info = await c.connect();
  assert.equal(info.serverName, 'Emby Box');
  assert.equal(c.persistable().pathPrefix, '/emby');
  assert.equal(srv.log[0].path, '/Users/AuthenticateByName');
  const tracks = await c.listTracks();
  assert.equal(tracks[0].duration, 1);
  assert.equal(c.streamRequest('1').url, `${srv.url}/emby/Audio/1/stream?static=true&api_key=E`);

  // A restored client keeps using the prefix.
  const c2 = createClient({ type: 'emby', url: srv.url, ...c.persistable() });
  assert.ok(c2.streamRequest('1').url.includes('/emby/Audio/1/'));
});

test('plex: sign-in, sections, container paging, part key in remotePath, stream/download', async () => {
  const meta = Array.from({ length: 620 }, (_, i) => ({
    ratingKey: String(1000 + i),
    title: `Track ${i}`,
    grandparentTitle: 'Artist',
    parentTitle: 'Album',
    parentYear: 2021,
    index: i + 1,
    duration: 241500,
    Genre: [{ tag: 'Techno' }],
    Media: [{ bitrate: 320, audioCodec: 'mp3', container: 'mp3', Part: [{ key: `/library/parts/${i}/123/file.mp3`, size: 999, container: 'mp3' }] }],
    thumb: `/library/metadata/${1000 + i}/thumb/1`,
  }));
  const srv = await mock((req, url) => {
    const p = url.pathname;
    if (p === '/users/sign_in.json') {
      if (req.method !== 'POST') return { status: 405 };
      if (req.headers.authorization !== 'Basic ' + Buffer.from('me:pw').toString('base64')) return { status: 401 };
      if (!req.headers['x-plex-client-identifier'] || req.headers['x-plex-product'] !== 'OpenDJ') return { status: 400 };
      return { status: 201, json: { user: { authToken: 'PLEXTOK' } } };
    }
    if (req.headers['x-plex-token'] !== 'PLEXTOK') return { status: 401 };
    if (req.headers.accept !== 'application/json') return { status: 406 };
    if (p === '/') return { json: { MediaContainer: { friendlyName: 'Plexy', version: '1.40' } } };
    if (p === '/library/sections')
      return { json: { MediaContainer: { Directory: [{ key: '3', title: 'Music', type: 'artist' }, { key: '1', title: 'Movies', type: 'movie' }] } } };
    const start = Number(req.headers['x-plex-container-start'] || 0);
    const size = Number(req.headers['x-plex-container-size'] || 50);
    if (p === '/library/sections/3/all' && url.searchParams.get('type') === '10')
      return { json: { MediaContainer: { size: Math.min(size, meta.length - start), totalSize: meta.length, Metadata: meta.slice(start, start + size) } } };
    if (p === '/playlists' && url.searchParams.get('playlistType') === 'audio')
      return { json: { MediaContainer: { Metadata: [{ ratingKey: '77', title: 'Closing', playlistType: 'audio' }] } } };
    if (p === '/playlists/77/items') return { json: { MediaContainer: { totalSize: 2, Metadata: [meta[5], meta[2]].slice(start, start + size) } } };
  });
  const c = new PlexClient({ type: 'plex', url: srv.url, username: 'me', password: 'pw' }, { signInUrl: srv.url + '/users/sign_in.json' });
  const info = await c.connect();
  assert.deepEqual(info, { ok: true, serverName: 'Plexy', version: '1.40' });
  assert.deepEqual(c.persistable(), { token: 'PLEXTOK', accountToken: 'PLEXTOK' });
  assert.deepEqual(await c.listLibraries(), [{ id: '3', name: 'Music' }]);

  const tracks = await c.listTracks();
  assert.equal(tracks.length, 620);
  const pageStarts = srv.log.filter((l) => l.path === '/library/sections/3/all').map((l) => l.headers['x-plex-container-start']);
  assert.deepEqual(pageStarts, ['0', '500']);
  const t = tracks[7];
  assert.equal(t.remoteId, '1007');
  assert.equal(t.remotePath, '/library/parts/7/123/file.mp3');
  assert.equal(t.duration, 241.5);
  assert.equal(t.artist, 'Artist');
  assert.equal(t.genre, 'Techno');
  assert.equal(t.format, 'mp3');
  assert.equal(t.bitrate, 320);
  assert.equal(t.trackNumber, 8);

  assert.deepEqual(await c.listPlaylists(), [{ remoteId: '77', name: 'Closing', trackRemoteIds: ['1005', '1002'] }]);

  // A fresh client restored from persisted config streams via the stored remotePath.
  const c2 = createClient({ type: 'plex', url: srv.url, token: 'PLEXTOK' });
  const s = c2.streamRequest('1007', { remotePath: t.remotePath });
  assert.equal(s.url, `${srv.url}/library/parts/7/123/file.mp3?X-Plex-Token=PLEXTOK`);
  const d = c2.downloadRequest('1007', t);
  assert.equal(d.ext, 'mp3');
  assert.ok(d.url.includes('/library/parts/7/123/file.mp3?download=1&X-Plex-Token=PLEXTOK'));
  assert.throws(() => c2.downloadRequest('1007'));
  assert.ok(c2.streamRequest('1007').url.includes('transcode'));
});

test('plex: requires token or credentials', async () => {
  const c = new PlexClient({ url: 'http://127.0.0.1:1' });
  await assert.rejects(c.connect(), /token/);
});
