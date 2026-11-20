// Cross-checks of the CDJ export with parsers that were written independently of OpenDJ.
// Each check is skipped when its tool is not installed (none of them is an OpenDJ dependency):
//   pyrekordbox   `pip install pyrekordbox`                  -> parses the ANLZ files (DAT / EXT / 2EX)
//   Kaitai        CDJ_KAITAI_DIR=<dir> with gen/RekordboxPdb.js + gen/RekordboxAnlz.js compiled from
//                 crate-digger's rekordbox_pdb.ksy / rekordbox_anlz.ksy (npm kaitai-struct-compiler) and
//                 node_modules/kaitai-struct                  -> parses export.pdb and the ANLZ files
//   rekordcrate   CDJ_REKORDCRATE=<path to the rekordcrate CLI> (cargo install --git …/rekordcrate)
//                                                             -> dump-pdb, list-playlists, dump-anlz
//   real exports  CDJ_REKORDBOX_SAMPLES=<dir with rekordbox-written PIONEER folders>
//                                                             -> our reader must parse rekordbox's own files
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { exportToCdj } from '../server/cdj/export.js';
import { readExportDb } from '../server/cdj/pdb-reader.js';
import { readAnlz } from '../server/cdj/anlz-reader.js';
import { Library } from '../server/library.js';
import { encodeWaveform } from '../public/js/audio/analysis-core.js';

let fixture = null;
async function exportFixture() {
  if (fixture) return fixture;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-cdjx-'));
  const lib = new Library(path.join(dir, 'data'));
  lib.media = { ffmpeg: () => null, ready: Promise.resolve(null) };
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const f = path.join(dir, `f${i}.mp3`); fs.writeFileSync(f, Buffer.alloc(1000 + i));
    const id = Library.localId(f); ids.push(id);
    lib.upsertTrack({ id, sourceType: 'local', path: f, title: i === 0 ? 'Ünïcødé 日本語 ✓' : `T${i}`, artist: i % 2 ? 'Björk' : 'X'.repeat(220), album: 'Alb', key: '8A', bpm: 126, gridOffset: 0.2, duration: 20, codec: 'mp3', color: '#00ff00', rating: 3 });
    const n = 3000; const w = { rate: 150, low: new Uint8Array(n).fill(200), mid: new Uint8Array(n).fill(100), high: new Uint8Array(n).fill(50), peak: new Uint8Array(n).fill(220) };
    fs.writeFileSync(lib.waveformPath(id), encodeWaveform(w));
  }
  lib.updateTrack(ids[0], { cues: [
    { index: 0, type: 'hot', position: 1, name: 'Drop', color: '#28e214' }, { index: 1, type: 'loop', position: 4, loopEnd: 5.904, name: '', color: '#e62828' },
    { index: 7, type: 'hot', position: 9, name: 'H' }, { index: -1, type: 'memory', position: 2, name: 'Mix in', color: '#0000ff' }, { index: -1, type: 'memory', position: 12, loopEnd: 13.904 },
  ], phrases: [{ start: 0.2, end: 8, type: 'intro' }, { start: 8, end: 16, type: 'drop' }, { start: 16, end: 20, type: 'outro' }] });
  const a = lib.createPlaylist('Main ✓', ids, { folder: 'Gigs / 2026' });
  const b = lib.createPlaylist('Root', ids.slice(0, 3));
  const usb = path.join(dir, 'usb'); fs.mkdirSync(usb);
  await exportToCdj({ library: lib }, { targetDir: usb, playlistIds: [a.id, b.id], threeBand: true });
  const db = readExportDb(fs.readFileSync(path.join(usb, 'PIONEER/rekordbox/export.pdb')), { strict: true });
  const cueTrack = db.tracks.find((t) => t.title === 'Ünïcødé 日本語 ✓');
  fixture = { usb, db, cueTrack, anlz: (ext) => path.join(usb, cueTrack.analyzePath.replace(/DAT$/, ext)) };
  return fixture;
}

const python = spawnSync('python3', ['-I', '-c', 'import pyrekordbox'], { encoding: 'utf8' });
test('pyrekordbox parses the ANLZ files (beat grid, cues, colours, comments, waveforms, phrases)', { skip: python.status !== 0 && 'pyrekordbox not installed' }, async () => {
  const fx = await exportFixture();
  const script = `
import json, sys
from pyrekordbox.anlz import AnlzFile
out = {}
for ext in ('DAT', 'EXT', '2EX'):
    a = AnlzFile.parse_file(sys.argv[1].replace('DAT', ext))
    tags = []
    for t in a.tags:
        c = t.content
        d = {'type': t.type}
        if t.type == 'PPTH': d['path'] = t.get()
        if t.type == 'PQTZ': d['n'] = len(t.get_beats()); d['bpm'] = float(t.get_bpms()[0]); d['t0'] = float(t.get_times()[0])
        if t.type in ('PCOB', 'PCO2'): d['cues'] = [[e.hot_cue, e.time, e.loop_time] + ([e.comment, e.color_code, e.color_red, e.color_green, e.color_blue] if t.type == 'PCO2' else []) for e in c.entries]
        if t.type == 'PSSI': d['mood'] = c.mood; d['entries'] = [[e.index, e.beat, e.kind] for e in c.entries]
        if t.type in ('PWV3', 'PWV5', 'PWV7'): d['n'] = c.len_entries
        if t.type in ('PWV4', 'PWV5'): t.get()
        tags.append(d)
    out[ext] = tags
print(json.dumps(out))
`;
  const r = spawnSync('python3', ['-I', '-c', script, fx.anlz('DAT')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.DAT.map((t) => t.type), ['PPTH', 'PVBR', 'PQTZ', 'PWAV', 'PWV2', 'PCOB', 'PCOB']);
  assert.equal(out.DAT[0].path, fx.cueTrack.filePath);
  assert.equal(out.DAT[2].bpm, 126); assert.equal(out.DAT[2].n, 42);
  assert.deepEqual(out.DAT[5].cues.map((c) => c[0]), [1, 2]);
  const pco2 = out.EXT.filter((t) => t.type === 'PCO2');
  assert.deepEqual(pco2[0].cues, [[1, 1000, 0xffffffff, 'Drop', 0x16, 0x28, 0xe2, 0x14], [2, 4000, 5904, '', 0x2a, 0xe6, 0x28, 0x28], [8, 9000, 0xffffffff, 'H', 0, 0, 0, 0]]);
  assert.deepEqual(pco2[1].cues.map((c) => [c[1], c[2], c[3]]), [[2000, 0xffffffff, 'Mix in'], [12000, 13904, '']]);
  const pssi = out.EXT.find((t) => t.type === 'PSSI');
  assert.equal(pssi.mood, 1); assert.deepEqual(pssi.entries.map((e) => e[2]), [1, 5, 6]);
  assert.equal(out.EXT.find((t) => t.type === 'PWV3').n, 3000);
  assert.deepEqual(out['2EX'].map((t) => t.type), ['PPTH', 'PWV7', 'PWV6', 'PWVC']);
});

const KDIR = process.env.CDJ_KAITAI_DIR;
test('Kaitai parsers generated from crate-digger\'s .ksy specs read export.pdb and the ANLZ files', { skip: !(KDIR && fs.existsSync(path.join(KDIR, 'gen', 'RekordboxPdb.js'))) && 'set CDJ_KAITAI_DIR' }, async () => {
  const fx = await exportFixture();
  const req = createRequire(path.join(KDIR, 'gen', 'x.js'));
  const KaitaiStream = req('kaitai-struct/KaitaiStream');
  const PdbM = req('./RekordboxPdb.js'); const AnlzM = req('./RekordboxAnlz.js');
  const Pdb = PdbM.RekordboxPdb || PdbM; const Anlz = AnlzM.RekordboxAnlz || AnlzM;
  const k = new Pdb(new KaitaiStream(fs.readFileSync(path.join(fx.usb, 'PIONEER/rekordbox/export.pdb'))), null, null, false);
  const rows = {};
  for (const t of k.tables) {
    let page = t.firstPage; const list = (rows[t.type] = []);
    for (;;) {
      const p = page.body;
      if (p.isDataPage) for (const g of p.rowGroups) for (const r of g.rows) if (r.present) list.push(r.body);
      if (page.index === t.lastPage.index) break;
      page = p.nextPage;
    }
  }
  const T = Pdb.PageType;
  const tracks = rows[T.TRACKS];
  assert.equal(tracks.length, 12);
  const kt = tracks.find((t) => t.id === fx.cueTrack.id);
  assert.equal(kt.title.body.text, 'Ünïcødé 日本語 ✓');
  assert.equal(kt.filePath.body.text, fx.cueTrack.filePath);
  assert.equal(kt.tempo, 12600); assert.equal(kt.colorId, 5); assert.equal(kt.rating, 3);
  assert.equal(kt.autoloadHotCues.body.text, 'ON');
  assert.ok(rows[T.ARTISTS].some((a) => a.name.body.text === 'X'.repeat(220)));
  const tree = rows[T.PLAYLIST_TREE].map((r) => [r.name.body.text, r.isFolder]);
  assert.deepEqual(tree.map((x) => x[0]).sort(), ['2026', 'Gigs', 'Main ✓', 'Root']);
  assert.equal(rows[T.PLAYLIST_ENTRIES].length, 15);
  assert.equal(rows[T.COLORS].length, 8);
  const ext = new Anlz(new KaitaiStream(fs.readFileSync(fx.anlz('EXT'))));
  const tags = ext.sections.map((s) => Anlz.SectionTags[s.fourcc]);
  assert.deepEqual(tags, ['PATH', 'WAVE_SCROLL', 'CUES', 'CUES', 'CUES_2', 'CUES_2', 'WAVE_COLOR_SCROLL', 'WAVE_COLOR_PREVIEW', 'SONG_STRUCTURE']);
  const hot = ext.sections[4].body.cues;
  assert.deepEqual(hot.map((c) => [c.hotCue, c.time, c.colorCode]), [[1, 1000, 0x16], [2, 4000, 0x2a], [8, 9000, 0]]);
  const ss = ext.sections[8].body;
  assert.equal(ss.isMasked, true); assert.equal(ss.body.mood, 1);
  const dat = new Anlz(new KaitaiStream(fs.readFileSync(fx.anlz('DAT'))));
  assert.equal(dat.sections[2].body.numBeats, 42);
});

const RC = process.env.CDJ_REKORDCRATE;
test('rekordcrate reads export.pdb, the playlist tree and every ANLZ file', { skip: !(RC && fs.existsSync(RC)) && 'set CDJ_REKORDCRATE' }, async () => {
  const fx = await exportFixture();
  const pdb = path.join(fx.usb, 'PIONEER/rekordbox/export.pdb');
  const lp = spawnSync(RC, ['list-playlists', pdb], { encoding: 'utf8' });
  assert.equal(lp.status, 0, lp.stderr);
  assert.match(lp.stdout, /Gigs[\s\S]*2026[\s\S]*Main ✓[\s\S]*Ünïcødé 日本語 ✓/);
  assert.equal(spawnSync(RC, ['dump-pdb', pdb], { encoding: 'utf8', maxBuffer: 64 << 20 }).status, 0);
  for (const ext of ['DAT', 'EXT', '2EX']) {
    const r = spawnSync(RC, ['dump-anlz', fx.anlz(ext)], { encoding: 'utf8', maxBuffer: 64 << 20 });
    assert.equal(r.status, 0, `${ext}: ${r.stderr.slice(0, 2000)}`);
  }
});

const SAMPLES = process.env.CDJ_REKORDBOX_SAMPLES;
test('our readers parse exports written by rekordbox itself', { skip: !(SAMPLES && fs.existsSync(SAMPLES)) && 'set CDJ_REKORDBOX_SAMPLES' }, () => {
  const found = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/^export\.pdb$|^ANLZ\d+\.(DAT|EXT|2EX)$/i.test(e.name)) found.push(p); } };
  walk(SAMPLES);
  assert.ok(found.length);
  for (const f of found) {
    if (f.endsWith('.pdb')) { const db = readExportDb(fs.readFileSync(f)); assert.deepEqual(db.problems, [], f); assert.equal(db.colors.length, 8); }
    else assert.ok(readAnlz(fs.readFileSync(f)).sections.length > 0, f);
  }
});
