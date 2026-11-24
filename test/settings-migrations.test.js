import test from 'node:test';
import assert from 'node:assert/strict';
import { onceMigrations, DEFAULT_SETTINGS } from '../public/js/shared/library-core.js';
import { sanitizeSettings } from '../public/js/shared/settings-schema.js';

const load = (saved) => { const clean = sanitizeSettings(saved, DEFAULT_SETTINGS); return onceMigrations({ ...DEFAULT_SETTINGS, ...clean }, clean); };

test('settings: Soft RGB is the default waveform colour scheme', () => {
  assert.equal(DEFAULT_SETTINGS.waveformColors, 'soft');
  assert.equal(load({}).waveformColors, 'soft');
});

test('settings: an install on the old default (3-band RGB) moves to Soft RGB once; a later choice is kept', () => {
  const s = load({ waveformColors: 'rgb' });
  assert.equal(s.waveformColors, 'soft');
  assert.equal(s.waveformDefaults, 1);
  // the DJ picks 3-band RGB again afterwards: saved with the marker, so it stays
  assert.equal(load({ ...s, waveformColors: 'rgb' }).waveformColors, 'rgb');
});

test('settings: another scheme picked before the switch is kept', () => {
  for (const c of ['amber', 'player-blue', 'mono']) assert.equal(load({ waveformColors: c }).waveformColors, c);
});
