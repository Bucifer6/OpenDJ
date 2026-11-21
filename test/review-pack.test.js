// The app-review media pack (scripts/review-pack): manifest rules (CC0 only, pinned hashes, official sources),
// the dependency-free zip writer and the credits text. No network, no Chromium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { loadManifest, writeZip, creditsMarkdown, checksumsText } from '../scripts/review-pack/pack.mjs';

test('review pack manifest: 4–6 tracks, all CC0, hashes pinned, CC0 downloads only from freemusicarchive.org', () => {
  const m = loadManifest();
  const cc0 = m.tracks.filter((t) => t.kind === 'cc0'), gen = m.tracks.filter((t) => t.kind === 'generated');
  assert.ok(m.tracks.length >= 4 && m.tracks.length <= 6, `${m.tracks.length} tracks`);
  assert.ok(cc0.length >= 2 && cc0.length <= 4, `${cc0.length} CC0 tracks`);
  assert.ok(gen.length >= 2, `${gen.length} generated tracks`);
  assert.equal(new Set(m.tracks.map((t) => t.id)).size, m.tracks.length, 'unique ids');
  assert.equal(new Set(m.tracks.map((t) => t.file)).size, m.tracks.length, 'unique file names');
  for (const t of m.tracks) {
    assert.equal(t.licence, 'CC0-1.0', t.title);
    assert.equal(t.licenceUrl, 'https://creativecommons.org/publicdomain/zero/1.0/', t.title);
    assert.match(t.sha256 || '', /^[0-9a-f]{64}$/, `${t.title}: pack file hash pinned`);
    assert.ok(t.measured && t.measured.bpm > 60 && t.measured.key, `${t.title}: BPM / key measured`);
    assert.doesNotMatch(`${t.title} ${t.artist} ${t.credit}`, /suno|kevin macleod|komiku/i, t.title);
  }
  for (const t of cc0) {
    assert.equal(new URL(t.pageUrl).hostname, 'freemusicarchive.org', t.title);
    assert.ok(['freemusicarchive.org', 'files.freemusicarchive.org'].includes(new URL(t.fileUrl).hostname), t.title);
    assert.match(t.sourceSha256 || '', /^[0-9a-f]{64}$/, `${t.title}: downloaded file hash pinned`);
    assert.ok(t.pageCheck?.length, `${t.title}: licence check recorded`);
  }
  for (const t of gen) assert.ok(t.generator && t.generator.bpm && t.generator.seed && /OpenDJ project, CC0/.test(t.credit), t.title);
});

test('review pack zip writer: valid local headers, CRCs and central directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-zip-'));
  const file = path.join(dir, 'x.zip');
  const entries = [{ name: 'p/a.txt', data: Buffer.from('hello hello hello hello') }, { name: 'p/tracks/b.mp3', data: Buffer.from([1, 2, 3, 4, 5]) }];
  writeZip(file, entries);
  const z = fs.readFileSync(file);
  const end = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end > 0);
  assert.equal(z.readUInt16LE(end + 10), 2);
  let cd = z.readUInt32LE(end + 16);
  for (const e of entries) {
    assert.equal(z.readUInt32LE(cd), 0x02014b50);
    const method = z.readUInt16LE(cd + 10), crc = z.readUInt32LE(cd + 16), csize = z.readUInt32LE(cd + 20), nlen = z.readUInt16LE(cd + 28), off = z.readUInt32LE(cd + 42);
    assert.equal(z.subarray(cd + 46, cd + 46 + nlen).toString(), e.name);
    assert.equal(z.readUInt32LE(off), 0x04034b50);
    const body = z.subarray(off + 30 + z.readUInt16LE(off + 26), off + 30 + z.readUInt16LE(off + 26) + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    assert.deepEqual(data, e.data);
    assert.equal(crc, zlib.crc32(e.data));
    assert.equal(method, e.name.endsWith('.mp3') ? 0 : 8, 'MP3s stored, text deflated');
    cd += 46 + nlen;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('review pack credits: every track with licence and hash; missing tracks listed', () => {
  const m = loadManifest();
  const all = creditsMarkdown(m);
  for (const t of m.tracks) { assert.ok(all.includes(t.title)); assert.ok(all.includes(t.sha256)); }
  assert.match(all, /OpenDJ project, CC0/);
  const some = creditsMarkdown(m, m.tracks.filter((t) => t.kind === 'generated').map((track) => ({ track })));
  assert.match(some, /Listed but not in this copy/);
  assert.equal(checksumsText([{ name: 'a', sha256: 'f'.repeat(64) }]), `${'f'.repeat(64)}  a\n`);
});
