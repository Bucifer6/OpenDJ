// Friendly media-server load errors (QA p4: the deck showed Node's "fetch failed").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaServerError } from '../server/index.js';

test('media server errors name the server and say what to check', () => {
  const u = 'http://192.168.1.20:32400/library/parts/1/file.flac?X-Plex-Token=abc';
  assert.equal(mediaServerError(u, { err: true, name: 'Living room Plex' }), "Can't reach Living room Plex (192.168.1.20:32400) — check it's on and reachable from this computer");
  assert.match(mediaServerError(u, { timeout: true }), /^192\.168\.1\.20:32400 did not answer in time/);
  assert.match(mediaServerError(u, { status: 401, name: 'Jellyfin' }), /refused the request — check the login/);
  assert.match(mediaServerError(u, { status: 404 }), /no longer has this track/);
  assert.match(mediaServerError(u, { status: 503 }), /had a problem \(HTTP 503\)/);
  assert.ok(!/token|X-Plex|fetch failed/i.test(mediaServerError(u, { err: true })), 'no token or raw error in the message');
  assert.equal(mediaServerError('not a url', { err: true }), "Can't reach the media server — check it's on and reachable from this computer");
});
