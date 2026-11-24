// Desktop packaging (electron-builder `build` in package.json). A platform `files` list that holds only exclusions is
// read by electron-builder as "everything, minus these": 0.5.5-0.5.12 shipped the whole repository (docs images,
// mobile projects, tests, scripts, about 40 MB) in every desktop app that way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { build } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));

test('packaging: every platform files list keeps the top-level includes, so the repository is never packaged whole', () => {
  const includes = build.files.filter((p) => !p.startsWith('!'));
  assert.ok(includes.length > 0 && !includes.some((p) => p === '**/*' || p === '**'), 'the top-level list names what to package');
  for (const os of ['win', 'mac', 'linux']) {
    const files = build[os]?.files;
    if (!files) continue; // no platform list: electron-builder uses the top-level one
    const own = files.filter((p) => !p.startsWith('!'));
    assert.ok(own.length > 0, `${os}.files has includes, not only exclusions`);
    for (const p of build.files) assert.ok(files.includes(p), `${os}.files keeps "${p}" from the top-level list`);
    assert.ok(!own.some((p) => /^(docs|test|scripts|mobile|tools)\b/.test(p)), `${os}.files includes no repository-only folders`);
  }
});
