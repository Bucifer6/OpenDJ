// App log (server/applog.js): run in a child process, since installing it wraps that process's stdout / stderr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { redact, stampLines } from '../server/applog.js';

test('applog: console output lands in the file with timestamps, secrets removed, rotated at the size limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-log-'));
  try {
    const script = `
      import { installAppLog, readAppLog, logLine } from ${JSON.stringify(new URL('../server/applog.js', import.meta.url).href)};
      installAppLog(${JSON.stringify(dir)}, { maxBytes: 4000, keep: 2, header: 'OpenDJ test' });
      console.log('hello from the server');
      console.warn('[stems] ffmpeg failed: http://nas/x.flac?X-Plex-Token=SECRET123&a=1');
      process.stderr.write('partial ');
      process.stderr.write('line done\\n');
      logLine('page: TypeError: x is undefined', 'page');
      for (let i = 0; i < 120; i++) console.log('filler line ' + i + ' ' + 'x'.repeat(40));
      (await import('node:fs')).writeFileSync(${JSON.stringify(path.join(dir, 'read.txt'))}, readAppLog());
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const downloaded = fs.readFileSync(path.join(dir, 'read.txt'), 'utf8'); fs.rmSync(path.join(dir, 'read.txt'));
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ['opendj.1.log', 'opendj.2.log', 'opendj.log'], 'rotated, at most keep + 1 files');
    for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 4000, `${f} within the limit`);
    const all = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    assert.ok(!all.includes('SECRET123'), 'token removed');
    assert.match(downloaded, /filler line 119/);
    assert.match(downloaded, /^\d{4}-\d\d-\d\dT[\d:.]+Z \[out\] filler line/m);
    const first = fs.readFileSync(path.join(dir, 'opendj.2.log'), 'utf8') + fs.readFileSync(path.join(dir, 'opendj.1.log'), 'utf8') + fs.readFileSync(path.join(dir, 'opendj.log'), 'utf8');
    if (first.includes('hello from the server')) { // still in a kept file
      assert.match(first, /\[app\] ---- OpenDJ started: OpenDJ test/);
      assert.match(first, /\[err\] partial line done/);
      assert.match(first, /X-Plex-Token=\*\*\*&a=1/);
      assert.match(first, /\[page\] page: TypeError/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('applog: redaction keeps ordinary text; lines are stamped and partial lines wait', () => {
  assert.equal(redact('GET /rest/stream.view?u=dj&p=enc:abc&v=1.16&id=7'), 'GET /rest/stream.view?u=***&p=***&v=1.16&id=7');
  assert.equal(redact('Authorization: Bearer abc.def'), 'Authorization: ***');
  assert.equal(redact('loaded 12 tracks in 3 s, gain=0.8'), 'loaded 12 tracks in 3 s, gain=0.8');
  const r = stampLines('one\ntwo', 'out', 'zero ', new Date(0));
  assert.equal(r.out, '1970-01-01T00:00:00.000Z [out] zero one\n'); assert.equal(r.rest, 'two');
});
