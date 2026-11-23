import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Browser-only modules and workers are not necessarily imported by the Node
// tests. Parse them without executing DOM or AudioWorklet globals so a syntax
// error cannot pass CI and leave the whole app unable to start.
const root = fileURLToPath(new URL('../public/js/', import.meta.url));
for (const entry of readdirSync(root, { recursive: true }).filter(file => file.endsWith('.js')).sort()) {
  test(`browser JavaScript parses: ${entry}`, () => {
    const result = spawnSync(process.execPath, ['--check', path.join(root, entry)], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
