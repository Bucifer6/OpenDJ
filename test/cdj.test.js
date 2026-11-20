// Export to CDJ USB: export.pdb / ANLZ writers checked against independent readers (written from the
// Deep Symmetry analysis + Kaitai specs), byte-level header checks, end-to-end exports and incremental updates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeString, decodeString } from '../server/cdj/devicesql.js';
import { buildPdb, PAGE_SIZE } from '../server/cdj/pdb-writer.js';
import { readPdb, readExportDb } from '../server/cdj/pdb-reader.js';
import { buildAnlz, pssi } from '../server/cdj/anlz-writer.js';
import { readAnlz } from '../server/cdj/anlz-reader.js';
import { cdjWaveforms } from '../server/cdj/waveforms.js';
import { beatGrid, cueLists, keyName, colorId, hotCueColor, phraseStructure, anlzDir, safeSegment } from '../server/cdj/model.js';
import { planFormat } from '../server/cdj/formats.js';
import { exportToCdj, inspectCdjExport, SIDECAR } from '../server/cdj/export.js';
import { registerCdjRoutes } from '../server/cdj/routes.js';
import { Library } from '../server/library.js';
import { encodeWaveform } from '../public/js/audio/analysis-core.js';

const tmpdir = (p = 'opendj-cdj-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------------------------------------------------------------- DeviceSQL strings
test('DeviceSQL strings: short ASCII, long ASCII and UTF-16LE round-trip with documented headers', () => {
  const short = encodeString('Demo Track 1');
  assert.equal(short[0], ((12 + 1) << 1) | 1); // 0x1b, as in rekordbox exports
  assert.deepEqual(decodeString(short, 0), { text: 'Demo Track 1', size: 13, kind: 'short' });
  assert.deepEqual([...encodeString('')], [0x03]);
  const long = encodeString('x'.repeat(200));
  assert.equal(long[0], 0x40); assert.equal(long.readUInt16LE(1), 204); assert.equal(long[3], 0);
  assert.equal(decodeString(long, 0).text, 'x'.repeat(200));
  const wide = encodeString('Björk – 日本語 🎧');
  assert.equal(wide[0], 0x90); assert.equal(wide.readUInt16LE(1), wide.length); assert.equal(wide[3], 0);
  assert.equal(decodeString(wide, 0).text, 'Björk – 日本語 🎧');
  assert.equal(decodeString(encodeString('tab\there'), 0).text, 'tabhere'); // control characters dropped
});

// ---------------------------------------------------------------- export.pdb
function sampleDb(nTracks = 3) {
  const tracks = Array.from({ length: nTracks }, (_, i) => ({
    id: i + 1, title: i === 0 ? 'Ünïcødé Tïtle 日本語' : `Track ${i + 1}`, artistId: (i % 2) + 1, albumId: 1, genreId: 1, keyId: 1, colorId: (i % 8) + 1,
    rating: i % 6, tempo: 12800 + i, duration: 200 + i, sampleRate: 44100, bitrate: 320, sampleDepth: 16, fileSize: 1000 + i, fileType: 1,
    filename: `t${i + 1}.mp3`, filePath: `/Contents/A/B/t${i + 1}.mp3`, analyzePath: `/PIONEER/USBANLZ/P001/0000000${i % 10}/ANLZ0000.DAT`,
    dateAdded: '2026-01-02', analyzeDate: '2026-01-03', comment: i === 1 ? 'c'.repeat(150) : '',
  }));
  return {
    tracks,
    artists: [{ id: 1, name: 'Björk & Friends' }, { id: 2, name: 'A'.repeat(230) }],
    albums: [{ id: 1, name: 'Album ✓', artistId: 1 }, { id: 2, name: 'L'.repeat(240), artistId: 2 }],
    genres: [{ id: 1, name: 'House' }], labels: [{ id: 1, name: 'Label' }], keys: [{ id: 1, name: 'Am' }],
    artwork: [{ id: 1, path: '/PIONEER/Artwork/00001/a1.jpg' }],
    playlistTree: [
      { id: 1, parentId: 0, sortOrder: 1, isFolder: true, name: 'Gigs' },
      { id: 2, parentId: 1, sortOrder: 1, isFolder: true, name: '2026' },
      { id: 3, parentId: 2, sortOrder: 1, isFolder: false, name: 'Main ✓' },
      { id: 4, parentId: 0, sortOrder: 2, isFolder: false, name: 'Root' },
    ],
    playlistEntries: tracks.map((t, i) => ({ entryIndex: i + 1, trackId: t.id, playlistId: 3 })).concat([{ entryIndex: 1, trackId: 1, playlistId: 4 }]),
  };
}

test('export.pdb: file header, table pointers and page layout match the documented / rekordbox structure', () => {
  const buf = buildPdb(sampleDb(), { date: '2026-11-20' });
  assert.equal(buf.length % PAGE_SIZE, 0);
  assert.equal(buf.readUInt32LE(0), 0);
  assert.equal(buf.readUInt32LE(4), 4096);           // len_page
  assert.equal(buf.readUInt32LE(8), 20);             // num_tables (types 0..19, like rekordbox)
  assert.equal(buf.readUInt32LE(0x10), 5);           // unknown, always 5 in rekordbox exports
  assert.equal(buf.readUInt32LE(0x18), 0);
  const pages = buf.length / PAGE_SIZE;
  assert.ok(buf.readUInt32LE(0x0c) > pages);         // next_unused_page points past the end
  for (let i = 0; i < 20; i++) {
    const o = 0x1c + 16 * i;
    const [type, cand, first, last] = [0, 4, 8, 12].map((x) => buf.readUInt32LE(o + x));
    assert.equal(type, i);
    const fp = first * PAGE_SIZE;
    assert.equal(buf[fp + 0x1b], 0x64, 'first page of each table is an index page');
    assert.equal(buf.readUInt32LE(fp + 4), first);
    assert.equal(buf.readUInt16LE(fp + 0x24), 0x03ec);
    assert.equal(buf.readUInt32LE(fp + 0x3c), 0x1ffffff8, 'empty index entries');
    if (first === last) { // empty table: candidate page follows and is zero
      assert.equal(cand, first + 1); assert.ok(buf.subarray(cand * PAGE_SIZE, (cand + 1) * PAGE_SIZE).every((b) => b === 0));
      assert.equal(buf.readUInt32LE(fp + 0x0c), cand);
      assert.equal(buf.readUInt32LE(fp + 0x2c), 0x03ffffff, 'index header: no data page');
    } else {
      assert.equal(buf.readUInt32LE(fp + 0x2c), buf.readUInt32LE(fp + 0x0c), 'index header names the first data page');
      assert.ok(cand >= pages, 'candidate of a filled table lies past the end of the file');
      assert.equal(buf[last * PAGE_SIZE + 0x1b], 0x24);
      assert.equal(buf.readUInt32LE(last * PAGE_SIZE + 0x0c), cand, 'last page links to the empty candidate');
    }
  }
  // colours page: byte-identical row layout to rekordbox (Pink row: 00 00 00 00 01 01 00 00 0b "Pink")
  const colors = buf.readUInt32LE(0x1c + 16 * 6 + 12) * PAGE_SIZE;
  assert.equal(buf.subarray(colors + 0x28, colors + 0x28 + 13).toString('hex'), '00000000010100000b50696e6b');
  assert.equal(buf.readUInt16LE(colors + 0xffc), 0xff); // 8 rows present
  assert.equal(buf.readUInt16LE(colors + 0xffe), 0xff); // transaction flags
  // row counts: 13-bit num_row_offsets | 11-bit num_rows
  const c = buf[colors + 0x18] | (buf[colors + 0x19] << 8) | (buf[colors + 0x1a] << 16);
  assert.equal(c & 0x1fff, 8); assert.equal(c >>> 13, 8);
});

test('export.pdb round-trips through the independent reader (tracks, far names, nested playlists, static tables)', () => {
  const db = sampleDb();
  const r = readExportDb(buildPdb(db, { date: '2026-11-20' }), { strict: true });
  assert.deepEqual(r.problems, []);
  assert.equal(r.tracks.length, 3);
  const t = r.tracks.find((x) => x.id === 1);
  assert.equal(t.title, 'Ünïcødé Tïtle 日本語');
  assert.equal(t.filePath, '/Contents/A/B/t1.mp3');
  assert.equal(t.tempo, 12800); assert.equal(t.autoloadHotcues, 'ON'); assert.equal(t.subtype, 0x24); assert.equal(t.bitmask, 0x000c0700);
  assert.equal(r.tracks.find((x) => x.id === 2).comment, 'c'.repeat(150));
  assert.equal(r.artists.find((a) => a.id === 2).name, 'A'.repeat(230));
  assert.equal(r.artists.find((a) => a.id === 2).subtype, 0x64);      // far name offset
  assert.equal(r.artists.find((a) => a.id === 1).subtype, 0x60);
  assert.equal(r.albums.find((a) => a.id === 2).subtype, 0x84);
  assert.equal(r.albums.find((a) => a.id === 1).name, 'Album ✓');
  assert.deepEqual(r.playlistTree.map((p) => [p.id, p.parentId, p.isFolder, p.name]).sort(), [[1, 0, true, 'Gigs'], [2, 1, true, '2026'], [3, 2, false, 'Main ✓'], [4, 0, false, 'Root']]);
  assert.deepEqual(r.playlistEntries.filter((e) => e.playlistId === 3).sort((a, b) => a.entryIndex - b.entryIndex).map((e) => e.trackId), [1, 2, 3]);
  assert.deepEqual(r.colors.map((x) => x.name), ['Pink', 'Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple']);
  assert.equal(r.rows.columns.length, 27);
  assert.equal(r.rows.columns[0].name, 'GENRE');
  assert.equal(r.rows.menu17.length, 22); assert.equal(r.rows.menu18.length, 17);
  assert.equal(r.raw[19].length, 1);
});

test('export.pdb: large tables span page chains (1000 tracks, 3000 playlist entries)', () => {
  const db = sampleDb(1000);
  db.playlistEntries = Array.from({ length: 3000 }, (_, i) => ({ entryIndex: i + 1, trackId: (i % 1000) + 1, playlistId: 3 }));
  const t0 = Date.now();
  const buf = buildPdb(db);
  const r = readExportDb(buf, { strict: true });
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(r.tracks.length, 1000);
  assert.equal(new Set(r.tracks.map((t) => t.id)).size, 1000);
  assert.equal(r.playlistEntries.length, 3000);
  const tracksTable = r.tables[0];
  assert.ok(tracksTable.pages.length > 50);
  for (const p of tracksTable.pages.slice(1)) assert.ok(p.numRows <= 255 && p.free < 4096);
  const entryPages = r.tables[8].pages.slice(1);
  assert.ok(entryPages.length >= 12);
  assert.ok(entryPages.every((p) => p.numRows <= 255));
});

test('the reader accepts rekordbox-style deleted rows and rejects broken chains', () => {
  const buf = buildPdb(sampleDb());
  const bad = Buffer.from(buf);
  const first = bad.readUInt32LE(0x1c + 8);
  bad.writeUInt32LE(9999, first * PAGE_SIZE + 0x0c); // break the tracks chain
  assert.throws(() => readPdb(bad), /beyond end of file|leaves the file/);
  assert.throws(() => readPdb(Buffer.alloc(10)), /too short/);
});

// ---------------------------------------------------------------- model helpers
test('keys, colours, hot cue palette, beat grid and phrases', () => {
  assert.equal(keyName('8A'), 'Am'); assert.equal(keyName('Am'), 'Am'); assert.equal(keyName('F# minor'), 'F#m'); assert.equal(keyName('5B'), 'Eb'); assert.equal(keyName(''), '');
  assert.equal(colorId('#ff007f'), 1); assert.equal(colorId('#660099'), 8); assert.equal(colorId('#25fde9'), 6); assert.equal(colorId(''), 0);
  assert.deepEqual(hotCueColor('#28e214'), { colorCode: 0x16, rgb: [0x28, 0xe2, 0x14] });
  assert.equal(hotCueColor('#e62828').colorCode, 0x2a);
  assert.equal(hotCueColor(null).colorCode, 0);
  const beats = beatGrid({ bpm: 120, gridOffset: 0.25, downbeat: 0.75, duration: 10 });
  assert.equal(beats[0].time, 250); assert.equal(beats[1].time, 750);
  assert.equal(beats[1].beat, 1); assert.equal(beats[0].beat, 4); assert.equal(beats[2].beat, 2);
  assert.ok(beats.every((b) => b.tempo === 12000));
  assert.equal(beats.length, 20);
  assert.deepEqual(beatGrid({ bpm: 0, duration: 10 }), []);
  const ps = phraseStructure([{ start: 0.25, end: 4.25, type: 'intro' }, { start: 4.25, end: 8.25, type: 'drop' }, { start: 8.25, end: 10, type: 'outro' }], beats);
  assert.deepEqual(ps.entries.map((e) => [e.beat, e.kind]), [[1, 1], [9, 5], [17, 6]]);
  assert.equal(ps.mood, 1);
  assert.match(anlzDir('/Contents/a.mp3'), /^\/PIONEER\/USBANLZ\/P[0-9A-F]{3}\/[0-9A-F]{8}$/);
  assert.equal(safeSegment('AC/DC: "Live"?.'), 'AC_DC_ _Live__');
  assert.equal(safeSegment(' '), 'Unknown');
});

test('cue lists: hot cues A–H with colours, memory cues, hot and memory loops with beat fractions', () => {
  const { hotCues, memoryCues } = cueLists({
    bpm: 128,
    cues: [
      { index: 0, type: 'hot', position: 1, name: 'Drop', color: '#28e214' },
      { index: 1, type: 'loop', position: 4, loopEnd: 5.875, name: 'Loop 4', color: '#e62828' },
      { index: 9, type: 'hot', position: 3 },                                 // beyond H: dropped
      { index: 0, type: 'hot', position: 2 },                                 // duplicate A: dropped
      { index: -1, type: 'memory', position: 2.5, name: 'Mix in', color: '#0000ff' },
      { index: -1, type: 'memory', position: 10, loopEnd: 10.234375 },        // half-beat memory loop
    ],
  });
  assert.deepEqual(hotCues.map((c) => [c.hotCue, c.type, c.time, c.loopTime, c.colorCode, c.loopNumerator, c.loopDenominator]), [[1, 1, 1000, undefined, 0x16, undefined, undefined], [2, 2, 4000, 5875, 0x2a, 4, 1]]);
  assert.deepEqual(memoryCues.map((c) => [c.type, c.time, c.loopTime, c.colorId, c.loopNumerator, c.loopDenominator]), [[1, 2500, undefined, 7, undefined, undefined], [2, 10000, 10234, 0, 1, 2]]);
});

// ---------------------------------------------------------------- ANLZ
function fakeWave(seconds) {
  const n = Math.round(seconds * 150);
  const w = { rate: 150, low: new Uint8Array(n), mid: new Uint8Array(n), high: new Uint8Array(n), peak: new Uint8Array(n) };
  for (let i = 0; i < n; i++) { w.low[i] = (i * 7) % 256; w.mid[i] = (i * 3) % 256; w.high[i] = (i * 11) % 128; w.peak[i] = Math.max(w.low[i], w.mid[i], w.high[i]); }
  return w;
}

test('ANLZ DAT/EXT/2EX round-trip: path, grid, cues, extended cues, waveforms, masked phrases', () => {
  const dur = 30;
  const beats = beatGrid({ bpm: 128, gridOffset: 0.1, duration: dur });
  const { hotCues, memoryCues } = cueLists({ bpm: 128, cues: [
    { index: 0, position: 1, name: 'Ä', color: '#28e214' }, { index: 3, position: 3, name: '', color: '#305aff' }, { index: 5, position: 4, loopEnd: 5.875, name: 'L' },
    { index: -1, type: 'memory', position: 2, name: 'mem', color: '#ff0000' },
  ] });
  const wf = cdjWaveforms(fakeWave(dur), dur);
  const phrases = phraseStructure([{ start: 0.1, end: 15.1, type: 'intro' }, { start: 15.1, end: 30, type: 'drop' }], beats);
  const a = buildAnlz({ path: '/Contents/Ä/b c/日本.mp3', totalSamples: dur * 44100, beats, hotCues, memoryCues, waveforms: wf, phrases }, { twoEx: true });

  const dat = readAnlz(a.dat);
  assert.equal(a.dat.toString('latin1', 0, 4), 'PMAI');
  assert.deepEqual(dat.header, [1, 0x10000, 0x10000, 0]);
  assert.deepEqual(dat.sections.map((s) => s.fourcc), ['PPTH', 'PVBR', 'PQTZ', 'PWAV', 'PWV2', 'PCOB', 'PCOB']);
  assert.deepEqual(dat.sections.map((s) => s.lenHeader), [0x10, 0x10, 0x18, 0x14, 0x14, 0x18, 0x18]); // documented header sizes
  assert.equal(dat.byTag.PPTH[0].path, '/Contents/Ä/b c/日本.mp3');
  assert.equal(dat.byTag.PVBR[0].tail, dur * 44100);
  assert.deepEqual(dat.byTag.PQTZ[0].beats.slice(0, 2), [{ beat: 1, tempo: 12800, time: 100 }, { beat: 2, tempo: 12800, time: 569 }]);
  assert.equal(dat.byTag.PWAV[0].data.length, 400); assert.equal(dat.byTag.PWV2[0].data.length, 100);
  assert.ok(dat.byTag.PWV2[0].data.every((b) => b <= 15));
  const [hotOld, memOld] = dat.byTag.PCOB;
  assert.equal(hotOld.listType, 1); assert.equal(memOld.listType, 0);
  assert.deepEqual(hotOld.cues.map((c) => c.hotCue), [1, 3 + 1].filter((x) => x <= 3)); // only A–C for old players
  assert.deepEqual(memOld.cues.map((c) => [c.type, c.time, c.orderFirst, c.orderLast]), [[1, 2000, 0xffff, 0xffff]]);

  const ext = readAnlz(a.ext);
  assert.deepEqual(ext.sections.map((s) => s.fourcc), ['PPTH', 'PWV3', 'PCOB', 'PCOB', 'PCO2', 'PCO2', 'PWV5', 'PWV4', 'PSSI']);
  assert.equal(ext.byTag.PWV3[0].data.length, dur * 150); assert.equal(ext.byTag.PWV3[0].unknown, 0x00960000);
  assert.equal(ext.byTag.PWV5[0].data.length, dur * 150); assert.equal(ext.byTag.PWV5[0].unknown, 0x00960305);
  assert.equal(ext.byTag.PWV4[0].entries, 1200); assert.equal(ext.byTag.PWV4[0].data.length, 7200);
  const hot = ext.byTag.PCO2[0].cues;
  assert.deepEqual(hot.map((c) => [c.hotCue, c.type, c.time, c.comment, c.colorCode]), [[1, 1, 1000, 'Ä', 0x16], [4, 1, 3000, '', 0x01], [6, 2, 4000, 'L', 0]]);
  assert.deepEqual(hot[0].rgb, [0x28, 0xe2, 0x14]);
  assert.equal(hot[2].loopTime, 5875); assert.equal(hot[2].loopNumerator, 4); assert.equal(hot[2].loopDenominator, 1);
  assert.deepEqual(ext.byTag.PCO2[1].cues.map((c) => [c.hotCue, c.comment, c.colorId]), [[0, 'mem', 2]]);
  const ps = ext.byTag.PSSI[0];
  assert.equal(ps.masked, true); assert.equal(ps.mood, 1); assert.deepEqual(ps.entries.map((e) => [e.index, e.beat, e.kind]), [[1, 1, 1], [2, 33, 5]]);
  assert.equal(ps.endBeat, phrases.endBeat);

  const two = readAnlz(a.twoEx);
  assert.deepEqual(two.sections.map((s) => s.fourcc), ['PPTH', 'PWV7', 'PWV6', 'PWVC']);
  assert.equal(two.byTag.PWV7[0].entries, dur * 150); assert.equal(two.byTag.PWV6[0].entries, 1200);
});

test('waveform conversion: PWV3/PWAV byte layout and PWV5 colour packing', () => {
  const w = { rate: 150, low: Uint8Array.of(255, 0, 0, 0), mid: Uint8Array.of(0, 255, 0, 0), high: Uint8Array.of(0, 0, 255, 0), peak: Uint8Array.of(255, 255, 255, 0) };
  const out = cdjWaveforms(w, 4 / 150);
  assert.equal(out.colorScroll[0] >> 13, 7); assert.equal((out.colorScroll[0] >> 10) & 7, 0);
  assert.equal((out.colorScroll[1] >> 10) & 7, 7); assert.equal((out.colorScroll[2] >> 7) & 7, 7);
  assert.equal((out.colorScroll[0] >> 2) & 31, 31); assert.equal(out.colorScroll[0] & 3, 0);
  assert.equal(out.scroll[0] & 31, 31); assert.equal(out.scroll[3], 0);
  assert.equal(out.scroll[2] >> 5, 7); // all-high column: whitest
  assert.equal(out.preview.length, 400); assert.ok(out.preview.every((b) => (b & 31) <= 24));
  // other sample rates are resampled to 150 points/s
  const w2 = fakeWave(10); const half = { rate: 75, low: w2.low.slice(0, 750), mid: w2.mid.slice(0, 750), high: w2.high.slice(0, 750), peak: w2.peak.slice(0, 750) };
  assert.equal(cdjWaveforms(half, 10).scroll.length, 1500);
  assert.equal(cdjWaveforms(null, 2).scroll.length, 300);
});

test('PSSI mask is the documented XOR pattern (+ len_entries)', () => {
  const tag = pssi({ mood: 1, endBeat: 64, entries: [{ beat: 1, kind: 1 }] });
  // mood (0x0001) masked: 0x00 ^ (0xcb + 1), 0x01 ^ (0xe1 + 1)
  assert.equal(tag[0x12], 0xcc); assert.equal(tag[0x13], 0xe3);
  assert.equal(tag.readUInt32BE(0x0c), 24); assert.equal(tag.readUInt16BE(0x10), 1);
  const plain = pssi({ mood: 3, endBeat: 64, entries: [{ beat: 1, kind: 1 }] }, { mask: false });
  assert.equal(plain.readUInt16BE(0x12), 3);
});

// ---------------------------------------------------------------- formats
test('format planning per player profile', () => {
  const ff = { path: '/x/ffmpeg', encoders: { libmp3lame: true, aac: true } };
  assert.equal(planFormat({ file: 'a.mp3', codec: 'mp3' }).action, 'copy');
  assert.equal(planFormat({ file: 'a.flac' }, { profile: 'nxs2' }).action, 'copy');
  assert.equal(planFormat({ file: 'a.flac' }, { profile: 'legacy' }).action, 'skip');
  assert.deepEqual(planFormat({ file: 'a.flac', bitsPerSample: 24 }, { profile: 'legacy', ffmpeg: ff }).to, 'aiff');
  assert.equal(planFormat({ file: 'a.m4a', codec: 'alac' }, { profile: 'nxs2' }).action, 'copy');
  assert.equal(planFormat({ file: 'a.m4a', codec: 'alac' }, { profile: 'legacy', ffmpeg: ff }).to, 'aiff');
  assert.equal(planFormat({ file: 'a.m4a', codec: 'aac' }).action, 'copy');
  assert.equal(planFormat({ file: 'a.ogg', codec: 'vorbis' }, { ffmpeg: ff }).to, 'mp3');
  assert.equal(planFormat({ file: 'a.ogg', codec: 'vorbis' }, { ffmpeg: { path: 'f', encoders: { libmp3lame: false, aac: true } } }).to, 'm4a');
  assert.match(planFormat({ file: 'a.ogg' }).reason, /FFmpeg/);
  const hires = planFormat({ file: 'a.wav', sampleRate: 192000, bitsPerSample: 24 }, { profile: 'nxs2', ffmpeg: ff });
  assert.equal(hires.to, 'aiff'); assert.equal(hires.rate, 96000);
  assert.equal(planFormat({ file: 'a.wav', sampleRate: 88200 }, { profile: 'legacy', ffmpeg: ff }).rate, 44100);
  assert.equal(planFormat({ file: 'a.wav', sampleRate: 96000 }, { profile: 'nxs2' }).action, 'copy');
  assert.equal(planFormat({ file: 'a.dsf' }, { ffmpeg: ff }).rate, 88200);
  assert.equal(planFormat({ file: 'v.mp4', codec: 'aac', hasVideo: true }, { ffmpeg: ff }).action, 'convert');
});

// ---------------------------------------------------------------- end-to-end
function makeLibrary({ n = 4, waveforms = true } = {}) {
  const dir = tmpdir();
  const music = path.join(dir, 'music'); fs.mkdirSync(music);
  const lib = new Library(path.join(dir, 'data'));
  lib.media = { ffmpeg: () => null, ready: Promise.resolve(null) };
  const ids = [];
  for (let i = 0; i < n; i++) {
    const f = path.join(music, `${String(i + 1).padStart(4, '0')} file ${i}.mp3`);
    fs.writeFileSync(f, Buffer.alloc(2048 + i, i % 251));
    const id = Library.localId(f);
    lib.upsertTrack({ id, sourceType: 'local', path: f, title: i === 0 ? 'Ünïcødé Tïtle 日本語' : `Song ${i}`, artist: i % 3 ? `Artist ${i % 3}` : 'Björk', album: i % 2 ? 'Album' : '', genre: 'House', key: '8A', bpm: 124 + (i % 5), gridOffset: 0.12, duration: 30 + (i % 7), format: 'mp3', codec: 'mp3', sampleRate: 44100, bitrate: 320, rating: i % 6, color: i % 2 ? '#ff0000' : null, addedAt: Date.UTC(2025, 0, 2) });
    ids.push(id);
    if (waveforms) fs.writeFileSync(lib.waveformPath(id), encodeWaveform(fakeWave(30 + (i % 7))));
  }
  lib.updateTrack(ids[0], { cues: [{ index: 0, type: 'hot', position: 1, name: 'Drop', color: '#28e214' }, { index: 2, type: 'loop', position: 4, loopEnd: 5.935, name: 'Loop' }, { index: -1, type: 'memory', position: 8, name: 'Mix out' }],
    phrases: [{ start: 0.12, end: 15.6, type: 'intro' }, { start: 15.6, end: 30, type: 'drop' }], downbeat: 0.12 });
  return { dir, music, lib, ids };
}

test('end-to-end export: files on the stick, database, analysis, playlists in folders, skipped tracks', async () => {
  const { dir, music, lib, ids } = makeLibrary({ n: 5 });
  // tracks that cannot be exported
  const remote = { id: 'remote1', sourceType: 'remote', title: 'Stream only', duration: 100 }; lib.upsertTrack(remote);
  const missing = path.join(music, 'gone.mp3'); lib.upsertTrack({ id: 'gone1', sourceType: 'local', path: missing, title: 'Gone', duration: 10 });
  const ogg = path.join(music, 'x.ogg'); fs.writeFileSync(ogg, 'OggS'); lib.upsertTrack({ id: 'ogg1', sourceType: 'local', path: ogg, title: 'Ogg', codec: 'vorbis', duration: 10 });
  const main = lib.createPlaylist('Main ✓', [...ids, 'remote1', 'gone1', 'ogg1'], { folder: 'Gigs / 2026' });
  const warm = lib.createPlaylist('Warmup', ids.slice(0, 2), { folder: 'Gigs' });
  const usb = path.join(dir, 'usb'); fs.mkdirSync(usb);
  const events = [];
  const r = await exportToCdj({ library: lib, emit: (type, p) => events.push([type, p.phase]) }, { targetDir: usb, playlistIds: [main.id, warm.id] });
  assert.equal(r.ok, true);
  assert.equal(r.tracks, 5); assert.equal(r.copied, 5);
  assert.deepEqual(r.skipped.map((s) => s.id).sort(), ['gone1', 'ogg1', 'remote1']);
  assert.match(r.skipped.find((s) => s.id === 'ogg1').reason, /FFmpeg/);
  assert.ok(events.some(([t, p]) => t === 'cdj-export' && p === 'done'));
  assert.ok(events.some(([, p]) => p === 'tracks'));

  const db = readExportDb(fs.readFileSync(path.join(usb, 'PIONEER/rekordbox/export.pdb')), { strict: true });
  assert.deepEqual(db.problems, []);
  assert.equal(db.tracks.length, 5);
  const t1 = db.tracks.find((t) => t.title === 'Ünïcødé Tïtle 日本語');
  assert.ok(t1);
  assert.equal(t1.filePath, '/Contents/Björk/Unknown Album/0001 file 0.mp3');
  assert.equal(fs.readFileSync(path.join(usb, 'Contents/Björk/Unknown Album/0001 file 0.mp3')).length, 2048);
  assert.equal(t1.fileSize, 2048); assert.equal(t1.fileType, 1); assert.equal(t1.tempo, 12400);
  assert.equal(db.artists.find((a) => a.id === t1.artistId).name, 'Björk');
  assert.equal(db.keys.find((k) => k.id === t1.keyId).name, 'Am');
  assert.equal(t1.dateAdded, '2025-01-02');
  const red = db.tracks.find((t) => t.title === 'Song 1');
  assert.equal(red.colorId, 2); assert.equal(red.rating, 1);
  assert.equal(db.albums.find((a) => a.id === red.albumId).name, 'Album');
  // playlist tree: Gigs / 2026 / Main ✓ and Gigs / Warmup
  const byName = Object.fromEntries(db.playlistTree.map((p) => [p.name, p]));
  assert.equal(byName.Gigs.isFolder, true); assert.equal(byName.Gigs.parentId, 0);
  assert.equal(byName['2026'].parentId, byName.Gigs.id);
  assert.equal(byName['Main ✓'].parentId, byName['2026'].id); assert.equal(byName['Main ✓'].isFolder, false);
  assert.equal(byName.Warmup.parentId, byName.Gigs.id);
  const entries = (pl) => db.playlistEntries.filter((e) => e.playlistId === byName[pl].id).sort((a, b) => a.entryIndex - b.entryIndex).map((e) => db.tracks.find((t) => t.id === e.trackId).title);
  assert.deepEqual(entries('Main ✓'), ['Ünïcødé Tïtle 日本語', 'Song 1', 'Song 2', 'Song 3', 'Song 4']);
  assert.deepEqual(entries('Warmup'), ['Ünïcødé Tïtle 日本語', 'Song 1']);
  // analysis files of the cue track
  const dat = readAnlz(fs.readFileSync(path.join(usb, t1.analyzePath)));
  const ext = readAnlz(fs.readFileSync(path.join(usb, t1.analyzePath.replace(/DAT$/, 'EXT'))));
  assert.equal(dat.byTag.PPTH[0].path, t1.filePath);
  assert.equal(dat.byTag.PQTZ[0].beats[0].time, 120);
  assert.equal(dat.byTag.PQTZ[0].beats[0].tempo, 12400);
  assert.deepEqual(ext.byTag.PCO2[0].cues.map((c) => [c.hotCue, c.type, c.time, c.loopTime, c.comment]), [[1, 1, 1000, 0xffffffff, 'Drop'], [3, 2, 4000, 5935, 'Loop']]);
  assert.deepEqual(ext.byTag.PCO2[1].cues.map((c) => [c.time, c.comment]), [[8000, 'Mix out']]);
  assert.equal(ext.byTag.PWV3[0].data.length, 30 * 150);
  assert.ok(ext.byTag.PWV3[0].data.some((b) => (b & 31) > 20), 'waveform came from the OpenDJ analysis cache');
  assert.equal(ext.byTag.PSSI[0].entries.length, 2);
  assert.ok(!fs.existsSync(path.join(usb, t1.analyzePath.replace(/DAT$/, '2EX'))));
  const side = JSON.parse(fs.readFileSync(path.join(usb, SIDECAR), 'utf8'));
  assert.equal(side.tracks[ids[0]].pdbId, t1.id);
  const insp = await inspectCdjExport(usb);
  assert.equal(insp.tracks, 5); assert.equal(insp.byOpenDJ, true); assert.equal(insp.playlists.length, 2);
});

test('incremental update keeps track IDs, adds playlists, replaces same-name playlists and reuses audio', async () => {
  const { dir, lib, ids } = makeLibrary({ n: 6, waveforms: false });
  const usb = path.join(dir, 'usb'); fs.mkdirSync(usb);
  const a = lib.createPlaylist('A', ids.slice(0, 3));
  await exportToCdj({ library: lib }, { targetDir: usb, playlistIds: [a.id] });
  const db1 = readExportDb(fs.readFileSync(path.join(usb, 'PIONEER/rekordbox/export.pdb')), { strict: true });
  const idOf1 = Object.fromEntries(db1.tracks.map((t) => [t.filePath, t.id]));
  const copiedFile = path.join(usb, db1.tracks[0].filePath);
  const mtime1 = fs.statSync(copiedFile).mtimeMs;

  // second export: a new playlist + a changed version of A
  const b = lib.createPlaylist('B', ids.slice(2, 6), { folder: 'More' });
  lib.updatePlaylist(a.id, { trackIds: [ids[1], ids[0]] });
  const est = await exportToCdj({ library: lib }, { targetDir: usb, playlistIds: [a.id, b.id], dryRun: true });
  assert.equal(est.dryRun, true); assert.equal(est.reuse, 3); assert.equal(est.copy, 3); assert.deepEqual(est.existingExport, { tracks: 3, playlists: 1 });
  const r = await exportToCdj({ library: lib }, { targetDir: usb, playlistIds: [a.id, b.id] });
  assert.equal(r.copied, 3); assert.equal(r.reuse, 3);
  const db2 = readExportDb(fs.readFileSync(path.join(usb, 'PIONEER/rekordbox/export.pdb')), { strict: true });
  assert.equal(db2.tracks.length, 6);
  for (const t of db2.tracks) if (idOf1[t.filePath]) assert.equal(t.id, idOf1[t.filePath], 'existing track keeps its ID');
  assert.equal(fs.statSync(copiedFile).mtimeMs, mtime1, 'audio already on the stick is not copied again');
  const pl = Object.fromEntries(db2.playlistTree.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(pl).sort(), ['A', 'B', 'More']);
  assert.equal(db2.playlistEntries.filter((e) => e.playlistId === pl.A.id).length, 2, 'A was replaced, not duplicated');
  assert.equal(db2.playlistEntries.filter((e) => e.playlistId === pl.B.id).length, 4);
  assert.equal(pl.B.parentId, pl.More.id);

  // a third export of only B keeps A on the stick
  await exportToCdj({ library: lib }, { targetDir: usb, playlistIds: [b.id] });
  const db3 = readExportDb(fs.readFileSync(path.join(usb, 'PIONEER/rekordbox/export.pdb')), { strict: true });
  assert.ok(db3.playlistTree.some((p) => p.name === 'A'));
  // replace mode drops what is not exported now
  await exportToCdj({ library: lib }, { targetDir: usb, playlistIds: [b.id], mode: 'replace' });
  const db4 = readExportDb(fs.readFileSync(path.join(usb, 'PIONEER/rekordbox/export.pdb')), { strict: true });
  assert.deepEqual(db4.playlistTree.map((p) => p.name).sort(), ['B', 'More']);
  assert.equal(db4.tracks.length, 4);
});

test('edge cases: same-name playlists, "/" inside folder names, very long titles, smart playlists via playlistTrackIds', async () => {
  const { dir, lib, ids } = makeLibrary({ n: 3, waveforms: false });
  lib.updateTrack(ids[1], { title: 'T'.repeat(500), artist: 'Ä'.repeat(500) });
  const usb = path.join(dir, 'usb'); fs.mkdirSync(usb);
  const p1 = lib.createPlaylist('Set', [ids[0]], { folder: 'AC/DC / Live' });
  const p2 = lib.createPlaylist('Set', [ids[1]], { folder: 'AC/DC / Live' });
  const smart = lib.createPlaylist('Smart', [], { smart: { match: 'all', rules: [] } });
  const r = await exportToCdj({ library: lib, playlistTrackIds: (p) => (p.smart ? [ids[2]] : p.trackIds) }, { targetDir: usb, playlistIds: [p1.id, p2.id, smart.id] });
  assert.equal(r.skipped.length, 0);
  const db = readExportDb(fs.readFileSync(path.join(usb, 'PIONEER/rekordbox/export.pdb')), { strict: true });
  const names = db.playlistTree.map((p) => p.name).sort();
  assert.deepEqual(names, ['AC/DC', 'Live', 'Set', 'Set (2)', 'Smart']);
  assert.equal(db.tracks.find((t) => t.title.startsWith('TTT')).title.length, 255);
  const smartNode = db.playlistTree.find((p) => p.name === 'Smart');
  assert.equal(db.playlistEntries.filter((e) => e.playlistId === smartNode.id).length, 1);
});

test('dry run writes nothing; bad requests are rejected', async () => {
  const { dir, lib, ids } = makeLibrary({ n: 2, waveforms: false });
  const usb = path.join(dir, 'usb'); fs.mkdirSync(usb);
  const p = lib.createPlaylist('P', ids);
  const est = await exportToCdj({ library: lib }, { targetDir: usb, playlistIds: [p.id], dryRun: true });
  assert.equal(est.tracks, 2); assert.ok(est.bytesNeeded > 4096); assert.equal(est.bytesAudio, 2048 + 2049);
  assert.deepEqual(fs.readdirSync(usb), []);
  await assert.rejects(exportToCdj({ library: lib }, { targetDir: usb, playlistIds: [] }), /playlist/);
  await assert.rejects(exportToCdj({ library: lib }, { targetDir: path.join(dir, 'nope'), playlistIds: [p.id] }), /not a folder/);
});

test('routes: estimate, background export with progress events, status, inspect', async () => {
  const { dir, lib, ids } = makeLibrary({ n: 3, waveforms: false });
  const usb = path.join(dir, 'usb'); fs.mkdirSync(usb);
  const p = lib.createPlaylist('P', ids);
  const routes = {}; const events = [];
  registerCdjRoutes({ route: (m, pat, h) => { routes[`${m} ${pat}`] = h; }, library: lib, emit: (type, payload) => events.push({ type, ...payload }) });
  const est = await routes['POST /api/cdj/estimate']({ body: { targetDir: usb, playlistIds: [p.id] } });
  assert.equal(est.tracks, 3);
  await assert.rejects(routes['POST /api/cdj/estimate']({ body: { playlistIds: [p.id] } }), (e) => e.status === 400);
  const started = await routes['POST /api/cdj/export']({ body: { targetDir: usb, playlistIds: [p.id] } });
  assert.ok(started.jobId);
  for (let i = 0; i < 200 && !(await routes['GET /api/cdj/status']()).last; i++) await new Promise((r) => setTimeout(r, 20));
  const st = await routes['GET /api/cdj/status']();
  assert.equal(st.running, null); assert.equal(st.last.result.ok, true);
  assert.ok(events.some((e) => e.type === 'cdj-export' && e.phase === 'done' && e.jobId === started.jobId));
  const insp = await routes['GET /api/cdj/inspect']({ query: new URLSearchParams({ targetDir: usb }) });
  assert.equal(insp.tracks, 3);
  // hosted mode: allowPath refuses
  const r2 = {};
  registerCdjRoutes({ route: (m, pat, h) => { r2[`${m} ${pat}`] = h; }, library: lib, allowPath: () => { throw Object.assign(new Error('outside'), { status: 403 }); } });
  await assert.rejects(r2['POST /api/cdj/export']({ body: { targetDir: usb, playlistIds: [p.id] } }), (e) => e.status === 403);
});

test('1000-track library exports quickly and stays consistent', async () => {
  const { dir, lib, ids } = makeLibrary({ n: 1000, waveforms: false });
  const usb = path.join(dir, 'usb'); fs.mkdirSync(usb);
  const p1 = lib.createPlaylist('All', ids);
  const p2 = lib.createPlaylist('Half', ids.filter((_, i) => i % 2), { folder: 'Sub / Deep' });
  const t0 = Date.now();
  const r = await exportToCdj({ library: lib }, { targetDir: usb, playlistIds: [p1.id, p2.id] });
  const ms = Date.now() - t0;
  assert.equal(r.tracks, 1000); assert.equal(r.skipped.length, 0);
  assert.ok(ms < 60000, `export took ${ms} ms`);
  const t1 = Date.now();
  const db = readExportDb(fs.readFileSync(path.join(usb, 'PIONEER/rekordbox/export.pdb')), { strict: true });
  assert.ok(Date.now() - t1 < 3000);
  assert.equal(db.tracks.length, 1000);
  assert.equal(db.playlistEntries.length, 1500);
  assert.equal(new Set(db.tracks.map((t) => t.analyzePath)).size, 1000, 'every track has its own analysis folder');
});
