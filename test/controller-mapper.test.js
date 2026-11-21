// The Controller Mapper (tools/controller-mapper → public/controller-mapper.html), the community mappings in mappings/
// and the GitHub intake that turns Mapper submissions into pull requests (scripts/mapping-intake.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, buildIndex, buildBundle, targetList, mappingFiles, OUT, INDEX, BUNDLE } from '../scripts/build-controller-mapper.mjs';
import { matchController, guessController, hashEntries } from '../public/js/midi/community.js';
import { mappingErrors, mappingPath, cleanEntries } from '../scripts/lib/mapping-schema.mjs';
import { parseForm, issueKind, mappingFromForm, processIssue } from '../scripts/mapping-intake.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ids = new Set(targetList().map((t) => t.id));

test('controller mapper: committed files are up to date (run node scripts/build-controller-mapper.mjs)', () => {
  assert.equal(readFileSync(INDEX, 'utf8'), buildIndex());
  assert.equal(readFileSync(BUNDLE, 'utf8'), buildBundle());
  assert.equal(readFileSync(OUT, 'utf8'), build());
});

test('controller mapper: page embeds every OpenDJ function, the wizard code and the controller list', () => {
  const html = build();
  assert.ok(ids.size > 300);
  for (const id of ['deck1.play', 'deck4.hotcue8', 'mixer2.eqLow', 'mixer.crossfader', 'global.shift', 'browser.scroll']) assert.ok(ids.has(id), id);
  for (const fn of ['function detectMidiControl', 'function entryFor', 'function wizardSteps', 'function classifyCcValues']) assert.ok(html.includes(fn), fn);
  assert.ok(!/^export /m.test(html));
  assert.ok(!/\/\*@@|@@[A-Z]+@@/.test(html));
  assert.ok(html.includes('"opendjControllerIndex":1'));
  // works offline when double-clicked: no external scripts or stylesheets
  assert.ok(!/<script[^>]+src=|<link[^>]+href=/i.test(html));
});

test('controller mapper: strict CSP allows exactly its own inline scripts', () => {
  const html = build();
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self' https:\/\/raw\.githubusercontent\.com;/);
  assert.ok(!/script-src[^;]*unsafe/.test(csp));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2);
  for (const s of scripts) assert.ok(csp.includes(`'sha256-${createHash('sha256').update(s).digest('base64')}'`));
});

test('controller list: index covers community mappings and requests, with statuses', () => {
  const idx = JSON.parse(buildIndex());
  assert.equal(idx.opendjControllerIndex, 1);
  const flx4 = idx.controllers.find((c) => c.model === 'DDJ-FLX4');
  assert.equal(flx4.status, 'needs-verification');
  assert.ok(idx.controllers.some((c) => c.status === 'wanted'));
  for (const c of idx.controllers) {
    assert.ok(c.brand && c.model, JSON.stringify(c));
    assert.ok(['verified', 'needs-verification', 'wanted'].includes(c.status));
    assert.ok(Array.isArray(c.midiNames));
  }
  const req = JSON.parse(readFileSync(join(root, 'mappings', 'requested.json'), 'utf8'));
  const seen = new Set();
  for (const c of req.controllers) { const k = `${c.brand}|${c.model}`.toLowerCase(); assert.ok(!seen.has(k), `duplicate request ${k}`); seen.add(k); }
});

test('community mappings: every file in mappings/ is a valid CC0 OpenDJ mapping', () => {
  for (const file of mappingFiles()) {
    const rel = file.slice(root.length + 1);
    let m;
    assert.doesNotThrow(() => { m = JSON.parse(readFileSync(file, 'utf8')); }, `${rel}: not valid JSON`);
    assert.deepEqual(mappingErrors(m, ids), [], rel);
  }
});

test('mapping schema: rejects bad keys, unknown functions and missing licence', () => {
  const ok = { opendjMidiMapping: 1, name: 'X', contributed: { brand: 'Acme', model: 'DJ-2', license: 'CC0-1.0' }, entries: [{ key: 'note:0:11', target: 'deck1.play' }, { key: 'cc:0:0', lsbKey: 'cc:0:32', target: 'deck1.tempo', invert: true }, { key: 'pitch:1:0', target: 'deck2.tempo' }] };
  assert.deepEqual(mappingErrors(ok, ids), []);
  const errs = mappingErrors({ ...ok, contributed: { brand: 'Acme', model: 'DJ-2' }, entries: [{ key: 'note:16:0', target: 'deck1.play' }, { key: 'cc:0:128', target: 'x' }, { key: 'pitch:0:3', target: 'deck1.play', rel: 'weird' }] }, ids);
  assert.equal(errs.length, 6, errs.join('\n'));
  assert.deepEqual(cleanEntries([{ target: 'deck1.play', key: 'note:0:1', extra: '<script>', invert: 'yes' }]), [{ key: 'note:0:1', target: 'deck1.play' }]);
  assert.equal(mappingPath('Pioneer DJ', 'DDJ-FLX4'), 'Pioneer DJ/Pioneer_DJ-DDJ-FLX4.opendj-midi.json');
  assert.equal(mappingPath('../..', 'a/b\\c'), 'Unknown/Unknown-a_b_c.opendj-midi.json');
});

// ---------- intake: issue → files for a pull request ----------
const form = (fields) => Object.entries(fields).map(([k, v]) => `### ${k}\n\n${v || '_No response_'}`).join('\n\n');
const mappingJson = (entries = [{ key: 'note:0:11', target: 'deck1.play' }]) => JSON.stringify({ opendjMidiMapping: 1, device: 'ACME DJ-2 MIDI 1', name: 'Acme DJ-2', entries });
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'opendj-intake-'));
  mkdirSync(join(dir, 'mappings'), { recursive: true });
  writeFileSync(join(dir, 'mappings', 'requested.json'), JSON.stringify({ controllers: [{ brand: 'Numark', model: 'Party Mix', midiNames: [] }] }));
  return dir;
}
const run = (dir, issue) => processIssue({ number: 7, user: { login: 'alice' }, labels: [], ...issue }, { root: dir, ids, mappingFiles: (d) => mappingFiles(d) });

test('intake: parses issue forms and kinds', async () => {
  const f = parseForm(form({ Brand: 'Acme', Model: 'DJ-2', Notes: '' }));
  assert.deepEqual(f, { Brand: 'Acme', Model: 'DJ-2', Notes: '' });
  assert.equal(issueKind({ title: 'Controller mapping: Acme DJ-2' }), 'new');
  assert.equal(issueKind({ title: 'Mapping problem: Acme DJ-2' }), 'change');
  assert.equal(issueKind({ title: 'Verified mapping: Acme DJ-2' }), 'verify');
  assert.equal(issueKind({ title: 'x', labels: [{ name: 'controller-request' }] }), 'request');
  assert.equal(issueKind({ title: 'Crash on start' }), null);
  assert.deepEqual(await mappingFromForm('```json\n{"a":1}\n```'), { a: 1 });
  // attached file: only github.com/user-attachments URLs are fetched
  let fetched = '';
  const fake = async (u) => { fetched = u; return { ok: true, text: async () => '{"b":2}' }; };
  assert.deepEqual(await mappingFromForm('[m.json](https://github.com/user-attachments/files/123/m.json)', fake), { b: 2 });
  assert.equal(fetched, 'https://github.com/user-attachments/files/123/m.json');
  assert.equal(await mappingFromForm('[m.json](https://evil.example/m.json)', fake), null);
});

test('intake: new mapping → file with needs verification; change → replaced entries, verifications cleared', async () => {
  const dir = sandbox();
  try {
    const body = form({ Brand: 'Acme', Model: 'DJ-2', 'MIDI name': 'ACME DJ-2 MIDI 1', 'Tested on': 'Windows 11', Mapping: '```json\n' + mappingJson() + '\n```', Notes: 'works', Licence: '- [X] I made this mapping myself' });
    const r = await run(dir, { title: 'Controller mapping: Acme DJ-2', body });
    assert.equal(r.action, 'pr', r.comment);
    assert.equal(r.branch, 'mapping-intake/issue-7');
    const file = join(dir, 'mappings', 'Acme', 'Acme-DJ-2.opendj-midi.json');
    const m = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(m.contributed.author, '@alice');
    assert.deepEqual(m.contributed.verifiedBy, []);
    assert.deepEqual(m.contributed.midiNames, ['ACME DJ-2 MIDI 1']);
    assert.deepEqual(mappingErrors(m, ids), []);

    // verified by someone else
    m.contributed.verifiedBy = ['@carol']; writeFileSync(file, JSON.stringify(m));
    // a fix from bob replaces the entries and needs verifying again
    const fix = form({ Brand: 'Acme', Model: 'DJ-2', Mapping: '```json\n' + mappingJson([{ key: 'note:0:12', target: 'deck1.play' }, { key: 'note:0:13', target: 'deck1.cue' }]) + '\n```', Licence: '- [x] My changes are released under CC0' });
    const r2 = await processIssue({ number: 8, title: 'Mapping change: Acme DJ-2', user: { login: 'bob' }, body: fix }, { root: dir, ids, mappingFiles });
    assert.equal(r2.action, 'pr', r2.comment);
    const m2 = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(m2.entries.length, 2);
    assert.equal(m2.contributed.author, '@alice');
    assert.deepEqual(m2.contributed.changedBy, ['@bob']);
    assert.deepEqual(m2.contributed.verifiedBy, []);

    // bob can't verify his own change; dave can
    const v = form({ Brand: 'Acme', Model: 'DJ-2', 'Tested on': 'macOS 15' });
    const r3 = await processIssue({ number: 9, title: 'Verified mapping: Acme DJ-2', user: { login: 'bob' }, body: v }, { root: dir, ids, mappingFiles });
    assert.equal(r3.action, 'comment');
    const r4 = await processIssue({ number: 10, title: 'Verified mapping: Acme DJ-2', user: { login: 'dave' }, body: v }, { root: dir, ids, mappingFiles });
    assert.equal(r4.action, 'pr');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).contributed.verifiedBy, ['@dave']);

    // a problem report without a mapping only gets a label
    const r5 = await processIssue({ number: 11, title: 'Mapping problem: Acme DJ-2', user: { login: 'erin' }, body: form({ Brand: 'Acme', Model: 'DJ-2', "What's wrong": 'jog is reversed', Mapping: '' }) }, { root: dir, ids, mappingFiles });
    assert.equal(r5.action, 'comment');
    assert.deepEqual(r5.labels, ['needs-verification']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('intake: rejects invalid or unlicensed mappings and odd names; requests go to requested.json', async () => {
  const dir = sandbox();
  try {
    const bad = form({ Brand: 'Acme', Model: 'DJ-2', Mapping: '```json\n' + mappingJson([{ key: 'note:0:11', target: 'deck1.rm -rf' }]) + '\n```', Licence: '- [X] yes' });
    const r = await run(dir, { title: 'Controller mapping: Acme DJ-2', body: bad });
    assert.equal(r.action, 'comment'); assert.match(r.comment, /unknown function/);
    const unlicensed = form({ Brand: 'Acme', Model: 'DJ-2', Mapping: '```json\n' + mappingJson() + '\n```', Licence: '- [ ] yes' });
    assert.match((await run(dir, { title: 'Controller mapping: Acme DJ-2', body: unlicensed })).comment, /CC0/);
    assert.match((await run(dir, { title: 'Controller mapping: x', body: form({ Brand: '$(curl evil)', Model: 'X', Mapping: '{}' }) })).comment, /unusual characters/);
    assert.ok(!existsSync(join(dir, 'mappings', 'Acme')));

    const req = await run(dir, { title: 'Add controller: Acme DJ-2', body: form({ Brand: 'Acme', Model: 'DJ-2', 'MIDI name': 'ACME DJ-2' }) });
    assert.equal(req.action, 'pr');
    const list = JSON.parse(readFileSync(join(dir, 'mappings', 'requested.json'), 'utf8')).controllers;
    assert.deepEqual(list.find((c) => c.model === 'DJ-2'), { brand: 'Acme', model: 'DJ-2', midiNames: ['ACME DJ-2'], requestedBy: '@alice', issue: 7 });
    assert.equal((await run(dir, { title: 'Add controller: Numark Party Mix', body: form({ Brand: 'Numark', Model: 'Party Mix' }) })).action, 'comment');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recognition: controllers are matched from their MIDI port name; unknown ones get a brand guess', () => {
  const list = [{ brand: 'Pioneer DJ', model: 'DDJ-400', midiNames: ['DDJ-400'] }, { brand: 'Pioneer DJ', model: 'DDJ-400-Pro', midiNames: ['DDJ-400-Pro'] }, { brand: 'X', model: 'Y', midiNames: ['ab'] }];
  assert.equal(matchController(list, 'DDJ-400 MIDI 1').model, 'DDJ-400');
  assert.equal(matchController(list, 'PIONEER DDJ-400-PRO').model, 'DDJ-400-Pro');
  assert.equal(matchController(list, 'Lab Synth'), null); // matches shorter than 3 characters are ignored
  assert.deepEqual(guessController('DDJ-FLX10 MIDI 1'), { brand: 'Pioneer DJ', model: 'DDJ-FLX10' });
  assert.deepEqual(guessController('Numark Mixtrack Pro FX'), { brand: 'Numark', model: 'Mixtrack Pro FX' });
  assert.equal(guessController('Some Box 2').brand, '');
  assert.equal(hashEntries([{ key: 'note:0:1', target: 'deck1.play' }]), hashEntries([{ key: 'note:0:1', target: 'deck1.play' }]));
  assert.notEqual(hashEntries([{ key: 'note:0:1', target: 'deck1.play' }]), hashEntries([{ key: 'note:0:2', target: 'deck1.play' }]));
});

test('bundle: community mappings are built into the app with their version hash', () => {
  const b = JSON.parse(buildBundle());
  assert.equal(b.opendjCommunityBundle, 1);
  for (const c of b.index.controllers) if (c.file && b.mappings[c.file]) assert.equal(hashEntries(b.mappings[c.file].entries), c.hash);
});
