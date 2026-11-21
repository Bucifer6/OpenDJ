// MC voice and dedications: server-side speech (server/tts.js), voice choice and phrase timing (pure helpers).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../server/index.js';
import { cleanSpeech, fixWavSizes, ENGINES, TTS_MAX_CHARS, detectTts } from '../server/tts.js';
import { pickVoice } from '../public/js/audio/voice.js';
import { secondsToPhrase, cleanDedication, DEDICATION_MAX } from '../public/js/dedications.js';

const quiet = { log() {}, warn() {}, error() {} };
const wav = (n = 100) => { const b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(0x7ffff000, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(22050, 24); b.writeUInt32LE(44100, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(0x7ffff000, 40); return b; };

async function withServer(detect, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odj-tts-'));
  const app = await start({ port: 0, dataDir: dir, log: quiet, ffmpeg: false, tts: detect });
  try { await fn(app); } finally { app.shutdown(); app.server.closeAllConnections?.(); await new Promise((r) => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
}
const say = (app, body) => fetch(app.url + 'api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('TTS route: speaks through the engine, cleans and clips the text, fixes streamed WAV sizes', async () => {
  const spoken = [];
  const engine = { label: 'Fake', speak: async (text, lang) => { spoken.push({ text, lang }); return wav(); } };
  await withServer(async () => ({ id: 'fake', engine, voices: [], languages: { en: true, ro: true } }), async (app) => {
    assert.deepEqual(await (await fetch(app.url + 'api/tts/voices')).json(), { engine: 'fake', label: 'Fake', languages: { en: true, ro: true } });
    const r = await say(app, { text: 'Pentru Ana\u0000 și‮ Mihai\n' + 'x'.repeat(900), lang: 'ro' });
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'audio/wav');
    const b = Buffer.from(await r.arrayBuffer());
    assert.equal(b.readUInt32LE(40), b.length - 44, 'data size set from the real length');
    assert.equal(b.readUInt32LE(4), b.length - 8);
    assert.equal(spoken[0].lang, 'ro');
    assert.ok(spoken[0].text.startsWith('Pentru Ana și Mihai x') && spoken[0].text.length === TTS_MAX_CHARS, 'control / bidi characters removed, clipped');
    assert.equal((await say(app, { text: '   ' })).status, 400);
    assert.equal((await say(app, { text: 'hi', lang: 'xx' })).status, 200); assert.equal(spoken.at(-1).lang, 'en', 'unknown language -> English');
  });
});

test('TTS route: no engine / no Romanian voice -> 501 with a code the page falls back on; rate limit', async () => {
  await withServer(async () => null, async (app) => {
    const r = await say(app, { text: 'hello' });
    assert.equal(r.status, 501); assert.equal((await r.json()).code, 'no-tts');
  });
  const engine = { label: 'Fake', speak: async () => wav() };
  await withServer(async () => ({ id: 'fake', engine, voices: [], languages: { en: true, ro: false } }), async (app) => {
    const r = await say(app, { text: 'Bună seara', lang: 'ro' });
    assert.equal(r.status, 501); const j = await r.json(); assert.equal(j.code, 'no-voice'); assert.match(j.error, /Romanian/);
    let last; for (let i = 0; i < 31; i++) last = await say(app, { text: 'hi ' + i });
    assert.equal(last.status, 429, 'at most 30 announcements a minute');
  });
});

test('engines never put the text on a command line', () => {
  const src = fs.readFileSync(new URL('../server/tts.js', import.meta.url), 'utf8');
  for (const id of ['sapi', 'say', 'espeak']) assert.ok(ENGINES[id].speak.toString().includes('input'), `${id} passes the text through stdin`);
  assert.ok(!/shell:\s*true/.test(src) && /shell: false/.test(src));
  assert.match(src, /ConvertFrom-Json/, 'PowerShell reads a JSON request from stdin; the script is constant');
});

test('engine detection picks the platform engine and reports languages', async () => {
  const fake = (voices, ok = true) => ({ voices: async () => { if (!ok) throw new Error('missing'); return voices; }, has: (v, l) => v.includes(l) });
  const d = await detectTts({ platform: 'win32', engines: { sapi: fake(['en']) } });
  assert.deepEqual(d.languages, { en: true, ro: false });
  assert.equal(await detectTts({ platform: 'linux', engines: { espeak: fake([], false) } }), null);
  assert.equal((await detectTts({ platform: 'darwin', engines: { say: fake([], false), espeak: fake(['en', 'ro']) } })).id, 'espeak');
  assert.deepEqual(ENGINES.sapi.has([{ culture: 'ro-RO' }], 'ro'), true);
  assert.deepEqual(ENGINES.say.has([{ culture: 'ro_RO', name: 'Ioana' }], 'ro'), true);
  assert.equal(cleanSpeech('a​b  c'), 'a b c');
  assert.equal(fixWavSizes(Buffer.from('not a wav')).toString(), 'not a wav');
});

test('speechSynthesis voice choice: exact region, then the language, else none (no Romanian voice)', () => {
  const v = (lang, localService = true) => ({ lang, localService, name: lang });
  assert.equal(pickVoice([v('en-US'), v('ro-RO')], 'ro').lang, 'ro-RO');
  assert.equal(pickVoice([v('en-US'), v('ro_MD')], 'ro').lang, 'ro_MD');
  assert.equal(pickVoice([v('en-US'), v('en-GB')], 'ro'), null, 'Chromium / Electron on Linux and many Windows installs have no ro-RO voice');
  assert.equal(pickVoice([v('en-US'), v('en-GB')], 'en').lang, 'en-GB');
  assert.equal(pickVoice([], 'en'), null, 'Electron on Linux: getVoices() is empty');
});

test('dedications: next phrase boundary of the master deck, text cleaned', () => {
  const deck = (position, bpm = 120, rate = 1, gridOffset = 0) => ({ playing: true, bpm, rate, position, gridOffset });
  assert.equal(secondsToPhrase(deck(0.2)), 16 - 0.2, '120 BPM: 32 beats = 16 s');
  assert.ok(Math.abs(secondsToPhrase(deck(15.8)) - 16.2) < 1e-9, 'too close: the phrase after');
  assert.equal(secondsToPhrase(deck(1, 60)), 15, '60 BPM: 32 beats = 32 s is too long, 16 beats instead');
  assert.equal(secondsToPhrase({ playing: false }), null, 'nothing playing: now');
  assert.ok(Math.abs(secondsToPhrase(deck(0.2, 120, 2)) - 7.9) < 1e-9, 'faster playback: shorter wait');
  assert.equal(cleanDedication('  For Ana\n\nand Mihai‮ '), 'For Ana and Mihai');
  assert.equal(cleanDedication('x'.repeat(500)).length, DEDICATION_MAX);
});
