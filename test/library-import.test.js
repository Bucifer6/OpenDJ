import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTraktorNml, traktorKey, traktorPaths, parseSeratoCrate, buildSeratoCrate, readSeratoCrates, parseVirtualDjXml } from '../server/importers.js';
import { start } from '../server/index.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-imp-'));
function wav(file) {
  const b = Buffer.alloc(44 + 400); b.write('RIFF', 0); b.writeUInt32LE(36 + 400, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(400, 40);
  fs.writeFileSync(file, b);
}
// Traktor encodes "/home/x/a b.wav" as DIR="/:home/:x/:" FILE="a b.wav"
const nmlDir = (dir) => dir.split('/').filter(Boolean).map((s) => '/:' + s).join('') + '/:';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function nml(dir) {
  const d = esc(nmlDir(dir));
  return `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<NML VERSION="19"><HEAD COMPANY="www.native-instruments.com" PROGRAM="Traktor"></HEAD>
<COLLECTION ENTRIES="2">
<ENTRY MODIFIED_DATE="2024/1/1" TITLE="Track &amp; One" ARTIST="Artist A">
<LOCATION DIR="${d}" FILE="one.wav" VOLUME="" VOLUMEID=""></LOCATION>
<ALBUM TITLE="Album X"></ALBUM>
<INFO BITRATE="320000" GENRE="Techno" COMMENT="nice" RANKING="204" PLAYCOUNT="7" KEY="8A"></INFO>
<TEMPO BPM="128.000061" BPM_QUALITY="100.000000"></TEMPO>
<MUSICAL_KEY VALUE="21"></MUSICAL_KEY>
<CUE_V2 NAME="AutoGrid" DISPL_ORDER="0" TYPE="4" START="52.5" LEN="0.000000" REPEATS="-1" HOTCUE="-1"></CUE_V2>
<CUE_V2 NAME="Drop" DISPL_ORDER="0" TYPE="0" START="30000.0" LEN="0.000000" REPEATS="-1" HOTCUE="0"></CUE_V2>
<CUE_V2 NAME="n.n." DISPL_ORDER="0" TYPE="5" START="60000.0" LEN="1875.0" REPEATS="-1" HOTCUE="2"></CUE_V2>
<CUE_V2 NAME="Mem" DISPL_ORDER="0" TYPE="0" START="1000.0" LEN="0" REPEATS="-1" HOTCUE="-1"></CUE_V2>
<CUE_V2 NAME="fade" DISPL_ORDER="0" TYPE="1" START="1000.0" LEN="0" REPEATS="-1" HOTCUE="-1"></CUE_V2>
</ENTRY>
<ENTRY TITLE="Gone" ARTIST="B"><LOCATION DIR="/:nowhere/:" FILE="gone.mp3" VOLUME="" ></LOCATION><MUSICAL_KEY VALUE="0"></MUSICAL_KEY></ENTRY>
</COLLECTION>
<PLAYLISTS><NODE TYPE="FOLDER" NAME="$ROOT"><SUBNODES COUNT="1">
<NODE TYPE="FOLDER" NAME="Gigs"><SUBNODES COUNT="1">
<NODE TYPE="PLAYLIST" NAME="Friday"><PLAYLIST ENTRIES="2" TYPE="LIST" UUID="1">
<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="${d}one.wav"></PRIMARYKEY></ENTRY>
<ENTRY><PRIMARYKEY TYPE="TRACK" KEY="/:nowhere/:gone.mp3"></PRIMARYKEY></ENTRY>
</PLAYLIST></NODE></SUBNODES></NODE>
</SUBNODES></NODE></PLAYLISTS></NML>`;
}

test('Traktor NML parsing: keys, paths, cues, grid, playlists', () => {
  assert.equal(traktorKey(21), 'Am');
  assert.equal(traktorKey(0), 'C');
  assert.equal(traktorKey(18), 'F#m');
  assert.deepEqual(traktorPaths({ VOLUME: 'C:', DIR: '/:Music/:House/:', FILE: 'a.mp3' }), ['C:\\Music\\House\\a.mp3']);
  assert.deepEqual(traktorPaths({ VOLUME: 'USB', DIR: '/:DJ/:', FILE: 'a.mp3' }), ['/DJ/a.mp3', '/Volumes/USB/DJ/a.mp3']);
  const p = parseTraktorNml(nml('/home/dj/Music'));
  assert.equal(p.tracks.length, 2);
  const t = p.tracks[0];
  assert.equal(t.paths[0], '/home/dj/Music/one.wav');
  assert.equal(t.title, 'Track & One');
  assert.equal(t.key, 'Am');
  assert.equal(t.rating, 4);
  assert.equal(t.playCount, 7);
  assert.ok(Math.abs(t.bpm - 128) < 0.001);
  assert.equal(t.gridOffset, 0.0525);
  assert.deepEqual(t.cues, [
    { type: 'hot', index: 0, position: 30, name: 'Drop' },
    { type: 'hot', index: 2, position: 60, name: '', loopEnd: 61.875 },
    { type: 'memory', index: -1, position: 1, name: 'Mem' },
  ]);
  assert.equal(p.playlists.length, 1);
  assert.deepEqual(p.playlists[0].path, ['Gigs']);
  assert.equal(p.playlists[0].tracks.length, 2);
  assert.throws(() => parseTraktorNml('<foo/>'), /Traktor/);
});

test('Serato crate binary parsing', () => {
  const buf = buildSeratoCrate(['Users/dj/Music/a b.mp3', 'Music/Ünï/c.flac']);
  assert.equal(buf.toString('latin1', 0, 4), 'vrsn');
  const p = parseSeratoCrate(buf);
  assert.equal(p.version, '1.0/Serato ScratchLive Crate');
  assert.deepEqual(p.paths, ['Users/dj/Music/a b.mp3', 'Music/Ünï/c.flac']);
  // records with column definitions before the tracks are skipped
  const col = Buffer.concat([Buffer.from('osrt'), Buffer.from([0, 0, 0, 2]), Buffer.from([0, 0])]);
  assert.deepEqual(parseSeratoCrate(Buffer.concat([col, buf])).paths.length, 2);
});

test('VirtualDJ database parsing (BPM stored as seconds per beat)', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<VirtualDJ_Database Version="2024">
 <Song FilePath="C:\\Music\\a.mp3" FileSize="12345">
  <Tags Author="Art" Title="Tune" Genre="House" Album="LP" Year="2020" Key="Am" Bpm="0.46875" Stars="4" Flag="1" />
  <Infos SongLength="300.0" PlayCount="3" />
  <Comment>Great &amp; fun</Comment>
  <Scan Version="801" Bpm="0.46875" Volume="1.0" Key="Am" />
  <Poi Pos="0.120" Type="beatgrid" />
  <Poi Name="Intro" Pos="10.5" Num="1" Type="cue" />
  <Poi Pos="20.0" Num="3" Type="loop" Size="4" />
  <Poi Pos="5.0" Type="automix" Point="realStart" />
 </Song>
</VirtualDJ_Database>`;
  const p = parseVirtualDjXml(xml);
  const t = p.tracks[0];
  assert.deepEqual(t.paths, ['C:\\Music\\a.mp3']);
  assert.equal(t.bpm, 128);
  assert.equal(t.key, 'Am');
  assert.equal(t.rating, 4);
  assert.equal(t.comment, 'Great & fun');
  assert.equal(t.gridOffset, 0.12);
  assert.deepEqual(t.cues, [
    { type: 'hot', index: 0, position: 10.5, name: 'Intro' },
    { type: 'hot', index: 2, position: 20, loopEnd: 21.875, name: '' },
  ]);
});

test('import endpoints add existing files with cues, playlists into folders', async () => {
  const dir = tmpdir();
  const music = path.join(dir, 'Music'); fs.mkdirSync(music);
  wav(path.join(music, 'one.wav'));
  wav(path.join(music, 'two.wav'));
  fs.writeFileSync(path.join(dir, 'collection.nml'), nml(music));
  // Serato: _Serato_ lives at the volume root; paths are relative to it
  const serato = path.join(dir, '_Serato_', 'Subcrates'); fs.mkdirSync(serato, { recursive: true });
  const rel = path.relative(path.parse(dir).root, music).split(path.sep).join('/');
  fs.writeFileSync(path.join(serato, 'Warmup%%Early.crate'), buildSeratoCrate([`${rel}/two.wav`, `${rel}/missing.wav`]));
  fs.writeFileSync(path.join(dir, 'database.xml'), `<VirtualDJ_Database Version="8"><Song FilePath="${path.join(music, 'two.wav')}"><Tags Bpm="0.5" Key="5A" /><Poi Pos="3" Num="2" Type="cue" /></Song></VirtualDJ_Database>`);

  const app = await start({ port: 0, dataDir: path.join(dir, 'data') });
  const J = async (u, b) => (await fetch(app.url + u.slice(1), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
  try {
    const r1 = await J('/api/import/traktor', { path: path.join(dir, 'collection.nml') });
    assert.deepEqual(r1, { imported: 1, playlists: 1, missing: 1 });
    const one = app.library.allTracks().find((t) => t.path.endsWith('one.wav'));
    assert.equal(one.key, 'Am');
    assert.equal(one.cues.length, 3);
    assert.equal(one.gridOffset, 0.0525);
    assert.equal(one.gridLocked, true, 'imported beat grid is authoritative (not replaced by analysis on first load)');
    const pl = app.library.data.playlists.find((p) => p.name === 'Friday');
    assert.equal(pl.folder, 'Traktor / Gigs');
    assert.deepEqual(pl.trackIds, [one.id]);

    const r2 = await J('/api/import/serato', { path: path.join(dir, '_Serato_') });
    assert.deepEqual(r2, { imported: 1, playlists: 1, missing: 1 });
    const early = app.library.data.playlists.find((p) => p.name === 'Early');
    assert.equal(early.folder, 'Serato / Warmup');
    assert.equal(early.trackIds.length, 1);

    const r3 = await J('/api/import/virtualdj', { path: path.join(dir, 'database.xml') });
    assert.equal(r3.imported, 1);
    const two = app.library.getTrack(early.trackIds[0]);
    assert.equal(two.bpm, 120);
    assert.equal(two.key, '5A');
    assert.equal(two.bpmLocked, true, 'imported BPM without a grid is locked');
    assert.deepEqual(two.cues, [{ type: 'hot', index: 1, position: 3, name: '' }]);
    assert.equal(readSeratoCrates(dir).playlists.length, 1, 'parent folder of _Serato_ is accepted too');
  } finally { app.shutdown(); app.server.close(); }
});
