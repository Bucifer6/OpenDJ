// 0.5.10: Automix's added effects (tricks, teases of the next track, AI-stem transitions) are opt-in, and switched off
// once for existing installs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../server/library.js';
import { DEFAULT_SETTINGS } from '../public/js/shared/library-core.js';
import { AutoMix } from '../public/js/automix.js';

test('effects off: new installs default to no tricks, no teases, no AI-stem transitions', () => {
  assert.equal(DEFAULT_SETTINGS.automix.tricks, 'off');
  assert.equal(DEFAULT_SETTINGS.automix.tease, false);
  assert.equal(DEFAULT_SETTINGS.automix.stemTransitions, false);
});

test('effects off: existing settings are switched off once; a choice made afterwards is kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-fx-'));
  try {
    const lib0 = new Library(dir);
    const file = lib0.settingsFile;
    lib0.flush?.();
    fs.writeFileSync(file, JSON.stringify({ automix: { tricks: 'party', tease: true, stemTransitions: true, style: 'auto' } }));
    let lib = new Library(dir);
    assert.equal(lib.settings.automix.tricks, 'off'); assert.equal(lib.settings.automix.tease, false); assert.equal(lib.settings.automix.stemTransitions, false);
    assert.equal(lib.settings.automix.style, 'auto', 'other settings kept');
    fs.writeFileSync(file, JSON.stringify({ automix: { tricks: 'subtle', tease: true, effectsOff: 1 } }));
    lib = new Library(dir);
    assert.equal(lib.settings.automix.tricks, 'subtle', 'turned back on after the switch-off: kept');
    assert.equal(lib.settings.automix.tease, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('effects off: with the defaults Automix plans no tricks or teases, and the planner is not offered stems', () => {
  const app = { engine: { on() {}, decks: [{ index: 0 }, { index: 1 }], channels: [] }, settings: { automix: { ...DEFAULT_SETTINGS.automix } }, toast() {} };
  const am = new AutoMix(app);
  let tricks = 0, teases = 0;
  am.stepTricks = () => { tricks++; }; am.stepTease = () => { teases++; };
  am.enabled = true; am.current = { playing: true, track: { id: 'a' } }; am.watch = () => false; am.nextTrack = () => null;
  am.tick();
  assert.equal(tricks, 0); assert.equal(teases, 0);
  app.settings.automix.tricks = 'subtle'; am.tick();
  assert.equal(tricks, 1); assert.equal(teases, 0, 'teases need their own switch');
  app.settings.automix.tease = true; am.tick();
  assert.equal(teases, 1);
});
