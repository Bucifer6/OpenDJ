// Plex Home user switching: list home users, switch (with / without PIN), switch back to the owner, keep the
// current user on failure, and never expose the plex.tv account token (UI, backups, form input).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PlexClient, sourceConfigFromForm } from '../server/sources/index.js';
import { LibraryCore } from '../public/js/shared/library-core.js';
import { buildBackup, restoreBackup } from '../public/js/shared/library-tools.js';
import { start } from '../server/index.js';

const closers = [];
after(() => Promise.all(closers.map((c) => c())));

async function mock(handler) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    log.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers });
    const out = (await handler(req, url)) || { status: 404, json: {} };
    res.statusCode = out.status || 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(out.json ?? null));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${server.address().port}`, log };
}

const USERS = [
  { id: 1, uuid: 'u-owner', title: 'Owner', admin: true, protected: true, restricted: false },
  { id: 2, uuid: 'u-kid', title: 'Kid', admin: false, protected: false, restricted: true },
  { id: 3, uuid: 'u-alex', title: 'Alex', admin: false, protected: true, restricted: false },
  { id: 4, uuid: 'u-guest', title: 'Nobody', admin: false, protected: false, restricted: true },
];
// plex.tv user tokens -> this server's access tokens (what /api/v2/resources hands out)
const SERVER_TOKENS = { ACCOUNT: 'SRV-OWNER', 'TOK-KID': 'SRV-KID', 'TOK-ALEX': 'SRV-ALEX' };

async function fakes() {
  const plexTv = await mock((req, url) => {
    const tok = req.headers['x-plex-token'];
    if (!req.headers['x-plex-client-identifier']) return { status: 400 };
    if (url.pathname === '/api/v2/home/users') return tok === 'ACCOUNT' ? { json: { id: 9, name: 'Home', users: USERS } } : { status: 401 };
    const m = /^\/api\/v2\/home\/users\/([^/]+)\/switch$/.exec(url.pathname);
    if (m && req.method === 'POST') {
      if (tok !== 'ACCOUNT') return { status: 401 };
      const u = USERS.find((x) => x.uuid === m[1]);
      if (!u) return { status: 404 };
      if (u.protected && url.searchParams.get('pin') !== '1234') return { status: 403 };
      return { status: 201, json: { uuid: u.uuid, authToken: u.uuid === 'u-guest' ? 'TOK-GUEST' : u.uuid === 'u-owner' ? 'ACCOUNT' : `TOK-${u.title.toUpperCase()}` } };
    }
    if (url.pathname === '/api/v2/resources') {
      const at = SERVER_TOKENS[tok];
      return { json: [{ clientIdentifier: 'other', accessToken: 'NOPE', provides: 'server' }, ...(at ? [{ clientIdentifier: 'MACHINE', accessToken: at, provides: 'server' }] : [])] };
    }
  });
  const server = await mock((req, url) => {
    const tok = req.headers['x-plex-token'] || url.searchParams.get('X-Plex-Token');
    if (!['ACCOUNT', 'SRV-OWNER', 'SRV-KID', 'SRV-ALEX'].includes(tok)) return { status: 401 };
    if (url.pathname === '/') return { json: { MediaContainer: { friendlyName: 'Plexy', version: '1.41', machineIdentifier: 'MACHINE' } } };
    if (url.pathname === '/library/sections') return { json: { MediaContainer: { Directory: [{ key: '3', title: 'Music', type: 'artist' }] } } };
    if (url.pathname === '/library/sections/3/all') {
      const all = [{ ratingKey: '1', title: 'Shared' }, { ratingKey: '2', title: 'Grown-up only' }];
      const list = tok === 'SRV-KID' ? all.slice(0, 1) : all;
      return { json: { MediaContainer: { totalSize: list.length, size: list.length, Metadata: list } } };
    }
    if (url.pathname === '/playlists') return { json: { MediaContainer: { Metadata: [] } } };
  });
  return { plexTv, server };
}

test('plex home: list users, switch with / without PIN, keep the user on failure, switch back to the owner', async () => {
  const { plexTv, server } = await fakes();
  const c = new PlexClient({ type: 'plex', url: server.url, token: 'ACCOUNT' }, { plexTvUrl: plexTv.url });
  await c.connect();
  assert.deepEqual(c.persistable(), { token: 'ACCOUNT', accountToken: 'ACCOUNT' });

  const users = await c.homeUsers();
  assert.deepEqual(users.map((u) => [u.id, u.title, u.admin, u.protected, u.restricted, u.current]), [
    ['u-owner', 'Owner', true, true, false, true], ['u-kid', 'Kid', false, false, true, false],
    ['u-alex', 'Alex', false, true, false, false], ['u-guest', 'Nobody', false, false, true, false],
  ]);

  // managed user without a PIN: uses this server's resource access token for that user
  await c.switchUser('u-kid');
  assert.equal(c.config.token, 'SRV-KID');
  assert.deepEqual(c.config.plexUser, { id: 'u-kid', title: 'Kid' });
  assert.equal(c.config.accountToken, 'ACCOUNT', 'the account token is kept for switching back');
  assert.ok(c.streamRequest('1', { remotePath: '/library/parts/1/1/f.mp3' }).url.endsWith('X-Plex-Token=SRV-KID'));
  assert.equal((await c.listTracks()).length, 1, 'the kid only sees their libraries');
  assert.equal((await c.homeUsers()).find((u) => u.current).id, 'u-kid');

  // protected user: no PIN, wrong PIN, bad PIN format -> rejected and nothing changes
  await assert.rejects(c.switchUser('u-alex'), (e) => e.needsPin && /needs a PIN/.test(e.message));
  await assert.rejects(c.switchUser('u-alex', '9999'), /Wrong PIN/);
  await assert.rejects(c.switchUser('u-alex', '12ab'), /4 digits/);
  assert.equal(c.config.token, 'SRV-KID');
  // a user with no access to this server -> rejected, still the kid
  await assert.rejects(c.switchUser('u-guest'), /no access to this Plex server/);
  assert.equal(c.config.token, 'SRV-KID');
  await assert.rejects(c.switchUser('u-nope'), /not in this Plex Home/);

  await c.switchUser('u-alex', '1234');
  assert.equal(c.config.token, 'SRV-ALEX');
  const switchCall = plexTv.log.filter((l) => l.path === '/api/v2/home/users/u-alex/switch').at(-1);
  assert.equal(switchCall.query.get('pin'), '1234');

  // back to the owner: no PIN needed (we hold the account token), no switch request
  const before = plexTv.log.filter((l) => l.path.endsWith('/switch')).length;
  await c.switchUser('u-owner');
  assert.equal(plexTv.log.filter((l) => l.path.endsWith('/switch')).length, before);
  assert.equal(c.config.token, 'SRV-OWNER');
  assert.equal(c.config.plexUser, undefined);
  assert.deepEqual(c.persistable(), { token: 'SRV-OWNER', accountToken: 'ACCOUNT' });
  assert.equal((await c.listTracks()).length, 2);
});

test('plex home: account token and user are server-only, hidden from the UI and backups, tied to the endpoint', () => {
  const lib = new LibraryCore();
  lib.data = { version: 1, tracks: {}, playlists: [], folders: [], sources: [] };
  lib.changed = () => {};
  const saved = lib.saveSource({ id: 'px', type: 'plex', name: 'Home', url: 'http://plex:32400', token: 'SRV-KID', accountToken: 'ACCOUNT', plexUser: { id: 'u-kid', title: 'Kid' } });
  const pub = lib.publicSource(saved);
  assert.equal(pub.accountToken, undefined);
  assert.equal(pub.token, undefined);
  assert.deepEqual(pub.plexUser, { id: 'u-kid', title: 'Kid' });
  assert.equal(JSON.stringify(pub).includes('ACCOUNT'), false);

  // the form can't set them
  const cfg = sourceConfigFromForm({ type: 'plex', url: 'http://plex:32400', name: 'Home', accountToken: 'EVIL', plexUser: { id: 'x' } }, null);
  assert.equal(cfg.accountToken, undefined);
  assert.equal(cfg.plexUser, undefined);
  // editing the name keeps them; a different server drops them
  const same = sourceConfigFromForm({ id: 'px', type: 'plex', url: 'http://plex:32400', name: 'Renamed' }, saved);
  assert.equal(same.accountToken, 'ACCOUNT');
  assert.deepEqual(same.plexUser, { id: 'u-kid', title: 'Kid' });
  const moved = sourceConfigFromForm({ id: 'px', type: 'plex', url: 'http://elsewhere:32400', name: 'Home' }, saved);
  assert.equal(moved.accountToken, undefined);
  assert.equal(moved.plexUser, undefined);
  assert.equal(moved.token, undefined);

  // backups never carry the account token
  const backup = buildBackup(lib, { data: { sessions: [] } });
  assert.equal(JSON.stringify(backup).includes('ACCOUNT'), false);
});

test('plex home: restoring a backup keeps the switched user with its token', () => {
  const lib = new LibraryCore();
  lib.data = { version: 1, tracks: {}, playlists: [], folders: [], sources: [{ id: 'px', type: 'plex', name: 'Home', url: 'http://plex:32400', token: 'SRV-KID', accountToken: 'ACCOUNT', plexUser: { id: 'u-kid', title: 'Kid' } }] };
  lib.changed = () => {};
  lib.save = () => {};
  lib.settings = {};
  const backup = buildBackup(lib, { data: { sessions: [] } });
  backup.library.sources[0].plexUser = { id: 'u-alex', title: 'Alex' }; // stale user in an old backup
  restoreBackup(lib, { data: { sessions: [] }, replaceAll() {}, flush() {} }, backup);
  const s = lib.data.sources[0];
  assert.equal(s.token, 'SRV-KID');
  assert.equal(s.accountToken, 'ACCOUNT');
  assert.deepEqual(s.plexUser, { id: 'u-kid', title: 'Kid' });
});

test('plex home routes: 404 for unknown sources, 400 for non-Plex servers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-plexu-'));
  const app = await start({ port: 0, dataDir: path.join(dir, 'd'), ffmpeg: false, log: { log() {}, warn() {}, error() {} } });
  closers.push(async () => { app.server.close(); app.shutdown(); });
  const c = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${app.port}${url}`, { method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${app.port}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  assert.equal((await c('GET', '/api/sources/nope/users')).status, 404);
  assert.equal((await c('POST', '/api/sources/nope/user', { userId: 'x' })).status, 404);
  app.library.saveSource({ id: 'jf', type: 'jellyfin', name: 'JF', url: 'http://127.0.0.1:1', username: 'u' });
  const r = await c('GET', '/api/sources/jf/users');
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Plex/);
  assert.equal((await c('POST', '/api/sources/jf/user', { userId: 'x' })).status, 400);
});
