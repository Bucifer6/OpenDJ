import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseNotes, releaseBody } from '../scripts/release-notes.mjs';

const notes = `## OpenDJ\n\nIntro.\n\n### Download\n| a | b |\n\n### New in 1.2.1\n- fix two\n\n### Adaptive DJ (1.2.0 candidate)\n- cand\n\n### New in 1.2\n- big\n- list\n`;

test('release notes: a release page gets the introduction and its own section only', () => {
  const body = releaseBody(notes, 'v1.2.1');
  assert.match(body, /^## OpenDJ\n\nIntro\.\n\n### Download\n\| a \| b \|\n\n### New in 1\.2\.1\n- fix two\n$/);
  assert.ok(!/fix|big|cand/.test(releaseBody(notes, '1.2').replace('- big\n- list', '')), 'no other version');
  assert.match(releaseBody(notes, '1.2'), /### New in 1\.2\n- big\n- list\n$/);
  assert.throws(() => releaseBody(notes, '9.9'), /no "### New in 9\.9" section/);
  assert.deepEqual(parseNotes(notes).sections.map((s) => s.version), ['1.2.1', null, '1.2']);
});

test('release notes: the file has a section for the current version and keeps at most 10 versions', () => {
  const text = fs.readFileSync(new URL('../docs/RELEASE_NOTES.md', import.meta.url), 'utf8');
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(releaseBody(text, version).includes(`### New in ${version}`), `notes for ${version}`);
  assert.ok(parseNotes(text).sections.length <= 10, 'only the 10 most recent versions');
});
