import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createClient, SOURCE_TYPES, MediaMaxClient } from '../server/sources/index.js';
import { mediaMaxKeyToTag } from '../server/sources/mediamax.js';

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

/** Mock MediaMax server. handler(req, url, body) -> { status?, json? } */
async function mock(handler) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const url = new URL(req.url, 'http://x');
    log.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const out = (await handler(req, url, body)) || { status: 404, json: { error: 'not_found', message: 'Not found', statusCode: 404 } };
    res.statusCode = out.status || 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(out.json ?? null));
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, log };
}

const unauth = { status: 401, json: { error: 'unauthorized', message: 'Authentication required', statusCode: 401 } };

/** A small MediaMax: 2 music libraries (+1 movies), 501 tracks in lib m1, 1 in m2. */
function mediamaxHandler(state) {
  const tracks = Array.from({ length: 501 }, (_, i) => ({
    id: `t${i}`, libraryId: 'm1', type: 'track', title: `Track ${i}`, parentTitle: 'Album', grandparentTitle: 'Artist',
    year: 2021, index: i + 1, durationMs: 200000, genres: ['House', 'Deep House'], posterUrl: '/api/v1/images/img-album', parentId: 'al1',
  }));
  const other = [{ id: 'x1', libraryId: 'm2', type: 'track', title: 'Other', grandparentTitle: 'B', parentTitle: 'C', durationMs: 1000, genres: [], posterUrl: null }];
  return (req, url, body) => {
    const p = url.pathname;
    if (p === '/api/v1/system/info') return { json: { id: 's', name: 'Home Max', version: '1.4.2', setupRequired: false } };
    if (p === '/api/v1/auth/login' && req.method === 'POST') {
      const b = JSON.parse(body);
      if (b.username !== 'dj' || b.password !== 'secret') return { status: 401, json: { error: 'unauthorized', message: 'Invalid username or password', statusCode: 401 } };
      state.logins++;
      state.valid = `tok${state.logins}`;
      return { json: { token: state.valid, user: { id: 'u1', username: 'dj' } } };
    }
    const authOk = req.headers.authorization === `Bearer ${state.valid}` || req.headers['x-api-key'] === 'mmk_KEY';
    if (!authOk) return unauth;
    if (p === '/api/v1/auth/me') return { json: { id: 'u1', username: 'dj' } };
    if (p === '/api/v1/libraries')
      return { json: [{ id: 'm1', name: 'Music', type: 'music' }, { id: 'mv', name: 'Movies', type: 'movies' }, { id: 'm2', name: 'Vinyl rips', type: 'music' }] };
    if (p === '/api/v1/items') {
      assert.equal(url.searchParams.get('type'), 'track');
      const src = url.searchParams.get('libraryId') === 'm2' ? other : tracks;
      const off = Number(url.searchParams.get('offset'));
      const lim = Number(url.searchParams.get('limit'));
      return { json: { items: src.slice(off, off + lim), total: src.length, offset: off, limit: lim } };
    }
    let m;
    if ((m = /^\/api\/v1\/items\/([^/]+)\/analysis$/.exec(p))) {
      if (m[1] === 't0') return { json: { itemId: 't0', bpm: 124.004, bpmConfidence: 0.9, beatOffsetMs: 250, key: 'A minor', camelot: '8A', energy: 0.73 } };
      if (m[1] === 't1') return { json: { itemId: 't1', bpm: null, key: 'F# major', camelot: '2B', energy: 0.2 } };
      return { json: null }; // analysis failed -> null
    }
    if ((m = /^\/api\/v1\/items\/([^/]+)$/.exec(p))) {
      return { json: { id: m[1], type: 'track', media: [{ id: `med-${m[1]}`, container: 'flac', size: 31000000, bitrate: 1010, durationMs: 200000 }] } };
    }
    if (p === '/api/v1/playlists')
      return { json: [{ id: 'p1', type: 'playlist', title: 'Warmup', smart: null }, { id: 'p2', type: 'playlist', title: 'Peak (smart)', smart: { rules: [] } }, { id: 'p3', type: 'playlist', title: 'Videos' }] };
    if ((m = /^\/api\/v1\/items\/([^/]+)\/children$/.exec(p))) {
      const kids = { p1: [{ id: 't1', type: 'track' }, { id: 't2', type: 'track' }], p2: [{ id: 't0', type: 'track' }, { id: 'v9', type: 'movie' }], p3: [{ id: 'v1', type: 'movie' }] }[m[1]] || [];
      return { json: { items: kids, total: kids.length, offset: 0, limit: 2000 } };
    }
  };
}

test('mediamax: registered in index', () => {
  assert.ok(createClient({ type: 'mediamax', url: 'http://a' }) instanceof MediaMaxClient);
  const t = SOURCE_TYPES.find((x) => x.type === 'mediamax');
  assert.equal(t.label, 'MediaMax');
  assert.equal(t.fields.find((f) => f.name === 'url').placeholder, 'http://192.168.1.10:8484');
  for (const n of ['username', 'password', 'token']) assert.ok(t.fields.some((f) => f.name === n));
});

test('mediamax: key text conversion', () => {
  assert.equal(mediaMaxKeyToTag('A minor'), 'Am');
  assert.equal(mediaMaxKeyToTag('F# major'), 'F#');
  assert.equal(mediaMaxKeyToTag('Eb minor'), 'Ebm');
  assert.equal(mediaMaxKeyToTag(null), null);
});

test('mediamax: login, token persistence, paging, analysis mapping, playlists, stream/download/cover', async () => {
  const state = { logins: 0, valid: null };
  const srv = await mock(mediamaxHandler(state));
  const c = createClient({ id: 'src1', type: 'mediamax', url: srv.url + '/', username: 'dj', password: 'secret' });
  const info = await c.connect();
  assert.deepEqual(info, { ok: true, serverName: 'Home Max', version: '1.4.2' });

  const login = srv.log.find((r) => r.path === '/api/v1/auth/login');
  const lb = JSON.parse(login.body);
  assert.equal(lb.username, 'dj');
  assert.equal(lb.platform, 'other');
  assert.ok(lb.deviceId.startsWith('opendj-'));
  const persisted = c.persistable();
  assert.equal(persisted.token, 'tok1');
  assert.equal(persisted.userId, 'u1');
  assert.equal(persisted.password, undefined);

  // Restore from persisted token without a password.
  const restored = createClient({ type: 'mediamax', url: srv.url, ...persisted });
  assert.equal((await restored.connect()).ok, true);
  assert.equal(state.logins, 1);

  assert.deepEqual(await c.listLibraries(), [{ id: 'm1', name: 'Music' }, { id: 'm2', name: 'Vinyl rips' }]);

  const progress = [];
  const tracks = await c.listTracks({ onProgress: (d, t) => progress.push([d, t]) });
  assert.equal(tracks.length, 502);
  const pages = srv.log.filter((r) => r.path === '/api/v1/items' && r.query.get('libraryId') === 'm1');
  assert.deepEqual(pages.map((r) => r.query.get('offset')), ['0', '500']);
  assert.ok(srv.log.every((r) => r.query.get('libraryId') !== 'mv'));
  assert.deepEqual(progress.at(-1), [502, 502]);

  const t0 = tracks.find((t) => t.remoteId === 't0');
  assert.equal(t0.title, 'Track 0');
  assert.equal(t0.artist, 'Artist');
  assert.equal(t0.album, 'Album');
  assert.equal(t0.genre, 'House, Deep House');
  assert.equal(t0.trackNumber, 1);
  assert.equal(t0.duration, 200);
  assert.equal(t0.bpm, 124);
  assert.equal(t0.key, 'Am');
  assert.equal(t0.camelot, '8A');
  assert.equal(t0.energy, 7);
  assert.equal(t0.gridOffset, 0.25);
  assert.equal(t0.format, 'flac');
  assert.equal(t0.size, 31000000);
  assert.equal(t0.bitrate, 1010);
  assert.equal(t0.remotePath, 'med-t0');
  assert.equal(t0.coverUrl, srv.url + '/api/v1/images/img-album');
  assert.equal(t0.coverImageId, 'img-album');
  const t1 = tracks.find((t) => t.remoteId === 't1');
  assert.equal(t1.bpm, null);
  assert.equal(t1.key, 'F#');
  assert.equal(t1.energy, 2);
  const t5 = tracks.find((t) => t.remoteId === 't5');
  assert.equal(t5.bpm, null);
  assert.equal(t5.key, null);
  assert.equal(t5.energy, undefined);
  assert.equal(tracks.find((t) => t.remoteId === 'x1').coverUrl, null);

  const pls = await c.listPlaylists();
  assert.deepEqual(pls.map((p) => [p.remoteId, p.name, p.trackRemoteIds, p.smart]), [
    ['p1', 'Warmup', ['t1', 't2'], false],
    ['p2', 'Peak (smart)', ['t0'], true],
  ]);

  const s = c.streamRequest('t0', { remotePath: 'med-t0' });
  assert.equal(s.url, `${srv.url}/api/v1/stream/direct/med-t0`);
  assert.deepEqual(s.headers, { Authorization: 'Bearer tok1' });
  assert.ok(!s.url.includes('token'));
  const s2 = c.streamRequest('t0', {});
  assert.equal(s2.url, `${srv.url}/api/v1/stream/download/t0?quality=original`);
  const d = c.downloadRequest('t0', t0);
  assert.equal(d.url, `${srv.url}/api/v1/stream/download/t0?quality=original`);
  assert.equal(d.ext, 'flac');
  assert.deepEqual(d.headers, { Authorization: 'Bearer tok1' });
  const cv = c.coverRequest('t0', { coverImageId: 'img-album' });
  assert.equal(cv.url, `${srv.url}/api/v1/images/img-album?w=600`);
  assert.equal(c.coverRequest('x1', {}), null);
});

test('mediamax: expired token triggers re-login with stored password', async () => {
  const state = { logins: 0, valid: 'fresh-token-unknown-to-client' };
  const srv = await mock(mediamaxHandler(state));
  const c = createClient({ type: 'mediamax', url: srv.url, username: 'dj', password: 'secret', token: 'stale', userId: 'u1' });
  const info = await c.connect();
  assert.equal(info.ok, true);
  assert.equal(state.logins, 1);
  assert.equal(c.persistable().token, 'tok1');
  // Server revokes the token mid-sync: the next request re-logs in once.
  state.valid = 'rotated';
  const libs = await c.listLibraries();
  assert.equal(libs.length, 2);
  assert.equal(state.logins, 2);
  assert.equal(c.persistable().token, 'tok2');

  // Without a stored password a 401 surfaces as an error.
  const noPw = createClient({ type: 'mediamax', url: srv.url, token: 'stale' });
  await assert.rejects(noPw.connect(), (e) => e.status === 401);
});

test('mediamax: API key auth uses X-Api-Key and never logs in', async () => {
  const state = { logins: 0, valid: null };
  const srv = await mock(mediamaxHandler(state));
  const c = createClient({ type: 'mediamax', url: srv.url, token: 'mmk_KEY' });
  assert.equal((await c.connect()).ok, true);
  assert.equal(state.logins, 0);
  const me = srv.log.find((r) => r.path === '/api/v1/auth/me');
  assert.equal(me.headers['x-api-key'], 'mmk_KEY');
  assert.equal(me.headers.authorization, undefined);
  const tracks = await c.listTracks({ details: false });
  assert.equal(tracks.length, 502);
  assert.equal(tracks[0].remotePath, null);
  assert.deepEqual(c.streamRequest('t0', { remotePath: 'med-t0' }).headers, { 'X-Api-Key': 'mmk_KEY' });
  assert.equal(c.persistable().token, 'mmk_KEY');
});
