import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aiffToWav } from '../server/aiff.js';
import { parseM3U, buildM3U } from '../server/m3u.js';
import { start } from '../server/index.js';

function makeAiff(samples) {
  const n = samples.length, ssndSize = 8 + n * 2;
  const b = Buffer.alloc(12 + 26 + 8 + ssndSize);
  b.write('FORM', 0); b.writeUInt32BE(b.length - 8, 4); b.write('AIFF', 8);
  b.write('COMM', 12); b.writeUInt32BE(18, 16); b.writeUInt16BE(1, 20); b.writeUInt32BE(n, 22); b.writeUInt16BE(16, 26);
  b.set([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0], 28); // 44100 as 80-bit extended
  b.write('SSND', 38); b.writeUInt32BE(ssndSize, 42);
  samples.forEach((s, i) => b.writeInt16BE(s, 54 + i * 2));
  return b;
}

test('AIFF to WAV conversion swaps endianness and keeps rate', () => {
  const wav = aiffToWav(makeAiff([1000, -2000, 32767]));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 44100);
  assert.deepEqual([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)], [1000, -2000, 32767]);
});

test('M3U parse/build round trip with relative paths', () => {
  const base = path.resolve('/music');
  const m3u = buildM3U([{ path: path.join(base, 'a b.mp3'), title: 'A', artist: 'X', duration: 61 }], base);
  const p = parseM3U(m3u, base);
  assert.equal(p[0].path, path.join(base, 'a b.mp3'));
  assert.equal(p[0].duration, 61);
});

test('library API: folder scan, playlists, settings, CSRF guard', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-t-'));
  const music = path.join(tmp, 'm'); fs.mkdirSync(music);
  const wav = Buffer.alloc(44 + 400); wav.write('RIFF', 0); wav.writeUInt32LE(36 + 400, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(400, 40);
  fs.writeFileSync(path.join(music, 'Artist - Song.wav'), wav);
  fs.writeFileSync(path.join(music, 'Track.aiff'), makeAiff(new Array(200).fill(5)));
  const app = await start({ port: 0, dataDir: path.join(tmp, 'data') });
  const J = (m, u, b, h = {}) => fetch(app.url + u.slice(1), { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: b && JSON.stringify(b) });
  try {
    await (await J('POST', '/api/folders', { path: music })).json();
    let tracks = [];
    for (let i = 0; i < 50 && tracks.length < 2; i++) { await new Promise((r) => setTimeout(r, 50)); tracks = await (await J('GET', '/api/tracks')).json(); }
    assert.equal(tracks.length, 2);
    const song = tracks.find((t) => t.title === 'Song');
    assert.equal(song.artist, 'Artist');
    const aiff = tracks.find((t) => t.format === 'aiff');
    const s = await fetch(`${app.url}api/tracks/${aiff.id}/stream`);
    assert.equal(s.headers.get('content-type'), 'audio/wav');
    const r = await fetch(`${app.url}api/tracks/${song.id}/stream`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(r.status, 206); assert.equal((await r.arrayBuffer()).byteLength, 10);
    const pl = await (await J('POST', '/api/playlists', { name: 'Set', trackIds: [song.id] })).json();
    assert.deepEqual(pl.trackIds, [song.id]);
    const m3u = await (await fetch(`${app.url}api/playlists/${pl.id}/m3u`)).text();
    assert.match(m3u, /Artist - Song\.wav/);
    const st = await (await J('PUT', '/api/settings', { deckCount: 4, bogus: 1 })).json();
    assert.equal(st.deckCount, 4); assert.equal(st.bogus, undefined);
    const evil = await J('POST', '/api/playlists', { name: 'x' }, { Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
  } finally { app.server.close(); app.shutdown(); }
});
