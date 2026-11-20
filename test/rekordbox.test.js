import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRekordboxXml, buildRekordboxXml, pathToLocation, locationToPath } from '../server/rekordbox.js';

test('location encoding round-trips posix, windows, spaces and unicode', () => {
  assert.equal(pathToLocation('/Users/dj/My Music/a&b #1.mp3'), 'file://localhost/Users/dj/My%20Music/a%26b%20%231.mp3');
  assert.equal(pathToLocation('C:\\Music\\Tëst file.mp3'), 'file://localhost/C:/Music/T%C3%ABst%20file.mp3');
  assert.equal(locationToPath('file://localhost/C:/Music/T%C3%ABst%20file.mp3'), 'C:\\Music\\Tëst file.mp3');
  assert.equal(locationToPath('file://localhost/Users/dj/a%20b.mp3'), '/Users/dj/a b.mp3');
  assert.equal(locationToPath('file:///Users/dj/a%20b.mp3'), '/Users/dj/a b.mp3');
  assert.equal(locationToPath('file://localhost/Users/dj/100%.mp3'), '/Users/dj/100%.mp3');
  for (const p of ['/home/dj/日本語 トラック/曲 1.flac', '/a/b c/d"e<f>.wav', 'D:\\DJ\\Ünïcødé – mix.aiff']) {
    assert.equal(locationToPath(pathToLocation(p)), p);
  }
});

test('build -> parse preserves metadata, cues, grid, paths and playlists', () => {
  const tracks = [
    {
      id: 'a',
      path: '/home/dj/Music/Ünïcødé Artist/01 Track & "Friends" <Remix>.mp3',
      title: 'Track & "Friends" <Remix>',
      artist: 'Bjørk',
      album: '日本語',
      genre: 'Deep House',
      bpm: 123.45,
      key: '8A',
      duration: 312.6,
      rating: 4,
      comments: "line1\nit's",
      gridOffset: 0.123,
      cues: [
        { type: 'hot', index: 0, position: 1.5, name: 'Intro', color: '#ff0000' },
        { type: 'hot', index: 3, position: 64.25, name: 'Drop' },
        { type: 'memory', index: -1, position: 10, name: 'Mem' },
        { type: 'hot', index: 1, position: 30, name: 'Loop', loopEnd: 32 },
      ],
    },
    { id: 'b', path: 'C:\\DJ Music\\b side.flac', title: 'B', artist: 'X', bpm: 0, duration: 200, rating: 0, cues: [] },
  ];
  const xml = buildRekordboxXml({
    tracks,
    playlists: [
      { name: 'Set <1>', trackIds: ['b', 'a', 'missing'] },
      { name: 'Nested', path: ['Gigs', '2026'], trackIds: ['a'] },
    ],
  });
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<DJ_PLAYLISTS Version="1.0.0">/);
  assert.match(xml, /<PRODUCT Name="OpenDJ"/);
  assert.match(xml, /Rating="204"/);
  assert.ok(!xml.includes('<Remix>'), 'attribute values must be escaped');

  const parsed = parseRekordboxXml(xml);
  assert.equal(parsed.tracks.length, 2);
  const [a, b] = parsed.tracks;
  assert.equal(a.location, tracks[0].path);
  assert.equal(a.title, tracks[0].title);
  assert.equal(a.artist, 'Bjørk');
  assert.equal(a.album, '日本語');
  assert.equal(a.genre, 'Deep House');
  assert.equal(a.bpm, 123.45);
  assert.equal(a.key, '8A');
  assert.equal(a.duration, 313);
  assert.equal(a.rating, 4);
  assert.equal(a.comments, "line1\nit's");
  assert.deepEqual(a.grid, { bpm: 123.45, offset: 0.123 });
  assert.deepEqual(a.cues, [
    { type: 'hot', index: 0, position: 1.5, name: 'Intro', color: '#ff0000' },
    { type: 'hot', index: 3, position: 64.25, name: 'Drop' },
    { type: 'memory', index: -1, position: 10, name: 'Mem' },
    { type: 'hot', index: 1, position: 30, name: 'Loop', loopEnd: 32 },
  ]);
  assert.equal(b.location, 'C:\\DJ Music\\b side.flac');
  assert.equal(b.grid, null);
  assert.equal(b.rating, 0);
  assert.deepEqual(b.cues, []);

  assert.deepEqual(parsed.playlists, [
    { name: 'Nested', path: ['Gigs', '2026'], trackKeys: [tracks[0].path] },
    { name: 'Set <1>', path: [], trackKeys: [b.location, a.location] },
  ]);
});

test('parses a rekordbox-style export (KeyType 0 and 1, Windows paths, ratings)', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="6.8.0" Company="AlphaTheta"/>
  <COLLECTION Entries="2">
    <TRACK TrackID="11" Name="One" Artist="A" Album="" Genre="Techno" Kind="MP3 File" TotalTime="300" AverageBpm="128.00" Tonality="Am" Rating="255" Comments="" Location="file://localhost/D:/Music/One%20%26%20Only.mp3">
      <TEMPO Inizio="0.050" Bpm="128.00" Metro="4/4" Battito="1"/>
      <TEMPO Inizio="60.050" Bpm="128.00" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="" Type="0" Start="0.050" Num="-1"/>
      <POSITION_MARK Name="A" Type="0" Start="15.050" Num="0" Red="40" Green="226" Blue="20"/>
    </TRACK>
    <TRACK TrackID="12" Name="Two" Rating="102" Location="file://localhost/Users/me/two.wav"/>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="2">
      <NODE Name="ById" Type="1" KeyType="0" Entries="2"><TRACK Key="12"/><TRACK Key="11"/></NODE>
      <NODE Type="0" Name="Folder" Count="1">
        <NODE Name="ByLoc" Type="1" KeyType="1" Entries="1"><TRACK Key="file://localhost/Users/me/two.wav"/></NODE>
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`;
  const { tracks, playlists } = parseRekordboxXml(xml);
  assert.equal(tracks[0].location, 'D:\\Music\\One & Only.mp3');
  assert.equal(tracks[0].rating, 5);
  assert.equal(tracks[1].rating, 2);
  assert.equal(tracks[0].key, 'Am');
  assert.equal(tracks[0].duration, 300);
  assert.deepEqual(tracks[0].grid, { bpm: 128, offset: 0.05 });
  assert.deepEqual(tracks[0].cues, [
    { type: 'memory', index: -1, position: 0.05, name: '' },
    { type: 'hot', index: 0, position: 15.05, name: 'A', color: '#28e214' },
  ]);
  assert.equal(tracks[1].bpm, null);
  assert.deepEqual(playlists, [
    { name: 'ById', path: [], trackKeys: ['/Users/me/two.wav', 'D:\\Music\\One & Only.mp3'] },
    { name: 'ByLoc', path: ['Folder'], trackKeys: ['/Users/me/two.wav'] },
  ]);
});

test('rejects non-rekordbox XML', () => {
  assert.throws(() => parseRekordboxXml('<foo/>'), /DJ_PLAYLISTS/);
});
