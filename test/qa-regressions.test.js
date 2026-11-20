// Regression tests for the pre-release QA pass (deck audio, loops, worklet, library helpers, settings schema…).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckChannel, peakAbs } from '../public/js/audio/deck.js';
import { floatToInt16 } from '../public/js/stems/stem-dsp.js';

// ---- minimal AudioWorklet global scope, so the real deck processor can run under Node ----
const processors = {};
globalThis.sampleRate = 44100;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: () => {}, onmessage: null }; } };
globalThis.registerProcessor = (name, cls) => { processors[name] = cls; };
await import('../public/js/audio/worklets.js');

function deckProcessor() {
  const p = new processors['deck-processor']();
  const sent = []; p.port.postMessage = (m) => sent.push(m);
  return { p, sent, msg: (m) => p.onMessage(m) };
}
function render(p, frames) {
  const L = new Float32Array(frames), R = new Float32Array(frames);
  for (let o = 0; o < frames; o += 128) {
    const l = new Float32Array(128), r = new Float32Array(128);
    p.process([], [[l, r], [new Float32Array(128), new Float32Array(128)]]);
    L.set(l.subarray(0, Math.min(128, frames - o)), o); R.set(r.subarray(0, Math.min(128, frames - o)), o);
  }
  return { L, R };
}

test('M3: 16-bit deck audio above 0 dBFS is peak-normalised instead of clipped', () => {
  const n = 4410, src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = 1.6 * Math.sin(2 * Math.PI * 440 * i / 44100);
  const peak = peakAbs(src);
  assert.ok(Math.abs(peak - 1.6) < 1e-3);
  const i16 = deckChannel(src, false, peak);
  let clipped = 0; for (const v of i16) if (v === 32767 || v === -32768) clipped++;
  assert.ok(clipped < 20, `only the peak samples touch full scale, no hard clipping (${clipped})`);
  // the worklet scales back up: the played signal matches the float source
  const { p, msg } = deckProcessor();
  msg({ type: 'load', left: i16, right: i16, sampleRate: 44100, scale: peak });
  msg({ type: 'play', value: true });
  const out = render(p, 2048);
  let err = 0; for (let i = 10; i < 2000; i++) err = Math.max(err, Math.abs(out.L[i] - src[i]));
  assert.ok(err < 0.002, `worklet output matches source (max err ${err})`);
  // unscaled (old behaviour) would have clipped most of the waveform
  let old = 0; for (const v of deckChannel(src)) if (v === 32767 || v === -32768) old++;
  assert.ok(old > n / 4);
});

test('M3: tracks within 0 dBFS keep scale 1 and stems use the same scale as the deck audio', () => {
  const src = Float32Array.from({ length: 1000 }, (_, i) => 0.5 * Math.sin(i / 10));
  assert.ok(peakAbs(src) <= 1);
  const a = floatToInt16(src), b = floatToInt16(src, undefined, 1);
  assert.deepEqual([...a], [...b]);
  const scaled = floatToInt16(Float32Array.from([1.6, -1.6, 0.8]), undefined, 1.6);
  assert.deepEqual([...scaled], [32767, -32767, 16384]);
});

test('m2: reverse playback wraps inside an active loop', () => {
  const n = 44100, src = new Int16Array(n).fill(1000);
  const { p, msg } = deckProcessor();
  msg({ type: 'load', left: src, right: src, sampleRate: 44100, scale: 1 });
  msg({ type: 'seek', frame: 20000 });
  msg({ type: 'loop', value: { start: 10000, end: 22000 } });
  msg({ type: 'reverse', value: true });
  msg({ type: 'play', value: true });
  for (let k = 0; k < 40; k++) { render(p, 1024); assert.ok(p.pos >= 10000 - 2 && p.pos <= 22000 + 2, `pos ${p.pos} stays in the loop`); }
});

test('m1: loop length in beats is rounded (no 3.999999999)', async () => {
  const { Deck } = await import('../public/js/audio/deck.js');
  const d = Object.create(Deck.prototype);
  d.bpm = 126; d.loop = { start: 2.3784722222222223, end: 2.3784722222222223 + 4 * (60 / 126) };
  assert.equal(d.loopBeats, 4);
  d.loop.end = d.loop.start + (60 / 126); assert.equal(d.loopBeats, 1);
});

test('M7: rekordbox import marks the imported grid as authoritative (gridLocked)', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { start } = await import('../server/index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-qa-rb-'));
  const file = path.join(dir, 'a b.wav');
  const b = Buffer.alloc(44 + 400); b.write('RIFF', 0); b.writeUInt32LE(36 + 400, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(400, 40);
  fs.writeFileSync(file, b);
  const loc = 'file://localhost' + file.split('/').map(encodeURIComponent).join('/');
  fs.writeFileSync(path.join(dir, 'rb.xml'), `<?xml version="1.0" encoding="UTF-8"?><DJ_PLAYLISTS Version="1.0.0"><COLLECTION Entries="1">
<TRACK TrackID="1" Name="A" AverageBpm="126.00" Tonality="Gm" Location="${loc}"><TEMPO Inizio="0.300" Bpm="126.00" Metro="4/4" Battito="1"/></TRACK></COLLECTION><PLAYLISTS><NODE Type="0" Name="ROOT" Count="0"></NODE></PLAYLISTS></DJ_PLAYLISTS>`);
  const app = await start({ port: 0, dataDir: path.join(dir, 'data') });
  try {
    const r = await (await fetch(app.url + 'api/import/rekordbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path.join(dir, 'rb.xml') }) })).json();
    assert.equal(r.imported, 1);
    const t = app.library.allTracks()[0];
    assert.equal(t.gridOffset, 0.3); assert.equal(t.bpm, 126); assert.equal(t.gridLocked, true);
  } finally { app.shutdown(); app.server.close(); }
});

test('m6/M9: settings are validated on update and when settings.json is loaded', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { Library, DEFAULT_SETTINGS } = await import('../server/library.js');
  const { sanitizeSetting } = await import('../server/settings-schema.js');
  assert.deepEqual(sanitizeSetting('deckCount', '4'), { ok: true, value: 4 });
  assert.equal(sanitizeSetting('deckCount', 3).ok, false);
  assert.equal(sanitizeSetting('latencyHint', 'bogus').ok, false);
  assert.deepEqual(sanitizeSetting('latencyHint', '20'), { ok: true, value: '20' });
  assert.equal(sanitizeSetting('tempoRange', -5).ok, false);
  assert.equal(sanitizeSetting('theme', 42).ok, false);
  assert.equal(sanitizeSetting('automix', 'x').ok, false);
  assert.equal(sanitizeSetting('unknownFutureKey', { a: 1 }).ok, true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-qa-set-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ latencyHint: 'bogus', deckCount: '4', theme: 'neon', tempoRange: -5, automix: { style: 'nope', transitionBeats: 16 }, uiScale: 'huge' }));
  const lib = new Library(dir);
  assert.equal(lib.settings.latencyHint, DEFAULT_SETTINGS.latencyHint);
  assert.equal(lib.settings.deckCount, 4);
  assert.equal(lib.settings.theme, 'neon');
  assert.equal(lib.settings.tempoRange, DEFAULT_SETTINGS.tempoRange);
  assert.equal(lib.settings.uiScale, DEFAULT_SETTINGS.uiScale);
  assert.equal(lib.settings.automix.style, DEFAULT_SETTINGS.automix.style);
  assert.equal(lib.settings.automix.transitionBeats, 16);

  lib.updateSettings({ deckCount: 3, automix: { style: 'echo', order: 'sideways' }, latencyHint: 'nope', crossfaderCurve: 'sharp' });
  assert.equal(lib.settings.deckCount, 4, 'invalid deckCount ignored');
  assert.equal(lib.settings.automix.style, 'echo');
  assert.equal(lib.settings.automix.order, DEFAULT_SETTINGS.automix.order, 'invalid sub-value ignored, the rest merged');
  assert.equal(lib.settings.latencyHint, DEFAULT_SETTINGS.latencyHint);
  assert.equal(lib.settings.crossfaderCurve, 'sharp');
  clearTimeout(lib._t);
});

test('UAT M4/M5: imported cues merge with existing ones (auto cues replaceable, free pads, skipped counted)', async () => {
  const { mergeImportedCues } = await import('../server/importers.js');
  const existing = [{ index: 0, type: 'hot', position: 5, name: 'Mine' }, { index: 1, type: 'hot', position: 9, auto: true }, { index: -1, type: 'memory', position: 2 }];
  const imported = [{ index: 0, type: 'hot', position: 30 }, { index: 1, type: 'hot', position: 40 }, { index: -1, type: 'memory', position: 2 }];
  const m = mergeImportedCues(existing, imported);
  assert.deepEqual(m.cues.filter((c) => c.index >= 0).map((c) => [c.index, c.position]).sort(), [[0, 5], [1, 40], [2, 30]]);
  assert.equal(m.added, 2); assert.equal(m.skipped, 1);
  assert.equal(m.cues.some((c) => c.auto), false, 'auto cues replaced');
  assert.deepEqual(mergeImportedCues(existing, []).cues, existing, 'no imported cues: unchanged');
  const full = Array.from({ length: 8 }, (_, i) => ({ index: i, type: 'hot', position: i }));
  assert.equal(mergeImportedCues(full, [{ index: 2, type: 'hot', position: 99 }]).skipped, 1);
});

test('UAT M4/N4/N5: rekordbox import keeps cues & rating when the XML has none, fills empty tags, 400 on bad files', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { start } = await import('../server/index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-qa-rb2-'));
  const file = path.join(dir, 'x.wav');
  const b = Buffer.alloc(44 + 400); b.write('RIFF', 0); b.writeUInt32LE(36 + 400, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(400, 40);
  fs.writeFileSync(file, b);
  const loc = 'file://localhost' + file.split('/').map(encodeURIComponent).join('/');
  fs.writeFileSync(path.join(dir, 'rb.xml'), `<?xml version="1.0"?><DJ_PLAYLISTS><COLLECTION><TRACK TrackID="1" Name="RB Title" Genre="Techno" Location="${loc}"/></COLLECTION><PLAYLISTS/></DJ_PLAYLISTS>`);
  fs.writeFileSync(path.join(dir, 'bad.nml'), '<foo/>');
  const app = await start({ port: 0, dataDir: path.join(dir, 'data') });
  const post = async (u, body) => { const r = await fetch(app.url + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { s: r.status, j: await r.json() }; };
  try {
    const t0 = (await app.library.addFile?.(file)) || null;
    const first = await post('api/import/rekordbox', { path: path.join(dir, 'rb.xml') });
    assert.equal(first.s, 200);
    const t = app.library.allTracks()[0];
    app.library.updateTrack(t.id, { rating: 4, cues: [{ index: 0, type: 'hot', position: 3 }], title: '' });
    await post('api/import/rekordbox', { path: path.join(dir, 'rb.xml') });
    const u = app.library.getTrack(t.id);
    assert.equal(u.rating, 4, 'missing Rating keeps the track rating');
    assert.equal(u.cues.length, 1, 'no cue points in the XML: cues kept');
    assert.equal(u.genre, 'Techno'); assert.equal(u.title, 'RB Title');
    const bad = await post('api/import/traktor', { path: path.join(dir, 'bad.nml') });
    assert.equal(bad.s, 400); assert.match(bad.j.error, /Traktor/);
    const gone = await post('api/import/traktor', { path: path.join(dir, 'nope.nml') });
    assert.equal(gone.s, 400); assert.equal(gone.j.error, 'File not found');
    void t0;
  } finally { app.shutdown(); app.server.close(); }
});
