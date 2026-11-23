// Interface translations (public/js/i18n.js + public/js/locales/ro.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { t, setDictionary, translateText, resolveLanguage } from '../public/js/i18n.js';
import ro from '../public/js/locales/ro.js';
import { sanitizeSetting } from '../public/js/shared/settings-schema.js';
import { DEFAULT_SETTINGS } from '../public/js/shared/library-core.js';

test('i18n: English is the identity, parameters are filled', () => {
  setDictionary('en', {});
  assert.equal(t('Load to deck {n}', { n: 2 }), 'Load to deck 2');
  assert.equal(translateText('Settings'), null);
});

test('i18n: exact, whitespace-tolerant and pattern lookups', () => {
  setDictionary('xx', {
    Settings: 'Setări', 'Deck {0} is empty': 'Deck {0} este gol', 'Deck {0} {1}': 'Deck {0} {1}', 'Tempo reset': 'Resetare tempo',
    'Find {0} missing file{1} in…': 'Caută {0} fișiere lipsă în…', 'Imported {0} tracks{1}': 'Importate {0} piese{1}', '({0} files not found)': '({0} fișiere negăsite)',
  });
  assert.equal(t('Settings'), 'Setări');
  assert.equal(translateText(' Settings '), ' Setări ');           // text nodes keep their spaces
  assert.equal(translateText('Deck 2 is empty'), 'Deck 2 este gol');  // the specific pattern wins over 'Deck {0} {1}'
  assert.equal(translateText('Deck 3 Tempo reset'), 'Deck 3 Resetare tempo'); // captured parts are translated too
  assert.equal(translateText('Find 1 missing file in…'), 'Caută 1 fișiere lipsă în…'); // English plural suffix may be empty
  assert.equal(translateText('Imported 5 tracks (2 files not found)'), 'Importate 5 piese (2 fișiere negăsite)');
  assert.equal(translateText('Unknown text'), null);
  assert.equal(t('Unknown text'), 'Unknown text');                   // missing key: English
  setDictionary('en', {});
});

test('i18n: the Romanian dictionary keeps every placeholder and uses comma-below ș / ț', () => {
  for (const [k, v] of Object.entries(ro)) {
    assert.equal(typeof v, 'string', k);
    const keyPh = new Set(k.match(/\{\w+\}/g) || []);
    for (const p of v.match(/\{\w+\}/g) || []) assert.ok(keyPh.has(p), `${k}: ${p} is not in the key`);
    assert.doesNotMatch(v, /[şţŞŢ]/, `${k}: use ș / ț (comma below), not cedilla`);
  }
});

test('i18n: language setting', () => {
  assert.equal(DEFAULT_SETTINGS.language, 'auto');
  for (const v of ['auto', 'en', 'ro']) assert.deepEqual(sanitizeSetting('language', v), { ok: true, value: v });
  assert.equal(sanitizeSetting('language', 'xx').ok, false);
  assert.equal(resolveLanguage('ro'), 'ro');
  assert.equal(resolveLanguage('en'), 'en');
});

test('i18n-extract: tags are stripped completely before the prose test', async () => {
  const { stripTags, looksLikeUi } = await import('../scripts/i18n-extract.mjs');
  assert.equal(stripTags('Press <b>Play</b> now'), 'Press Play now');
  assert.equal(stripTags('<<b>script>alert(1)<</b>/script>'), 'alert(1)', 'nested tags leave no tag behind');
  assert.ok(!/[<>]/.test(stripTags('<<b>i>x <')));
  assert.equal(looksLikeUi({ text: '<span class="x">1</span>', before: '', after: '' }), false, 'markup without prose');
  assert.equal(looksLikeUi({ text: 'Drop your <b>Tracks here</b>', before: '', after: '' }), true);
});
