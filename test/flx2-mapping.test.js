// First-party DDJ-FLX2 mapping: every entry hits an existing target, the chart-cited facts are what the mapping
// says, shift layers sit on their own channels, the device is matched by port name, and the extras (smart fader,
// smart CFX, pad modes) behave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MidiManager, buildTargets, buildStates } from '../public/js/midi/midi.js';
import { PRESETS } from '../public/js/midi/presets.js';
import { FLX2_PRESET, FLX2_MATCH, FLX2_PAD_BANKS, FLX2_PAD_CH } from '../public/js/midi/mappings/ddj-flx2.js';
import { ctlState, setPadMode, padAction, setSmartCfx, setSmartFader, SMART_CFX } from '../public/js/midi/controller-extras.js';

function fakeApp() {
  const calls = [];
  const rec = (name) => new Proxy({}, { get: (o, p) => (p in o ? o[p] : typeof p === 'string' ? (...a) => calls.push([`${name}.${p}`, ...a]) : undefined) });
  const decks = [0, 1, 2, 3].map((i) => Object.assign(rec(`deck${i + 1}`), { index: i, playing: false, tempo: 0, tempoRange: 8, keyShift: 0, syncOn: false, isMaster: false, keyLock: false, slip: false, quantize: false, reverse: false, cuePreview: false, _jogTouched: false, vinylMode: true, position: 0, cuePoint: 0, loopBeats: 0, bpm: 120 + i, beatLen: 0.5, rate: 1, gridOffset: 0, track: {}, hotCue: (n) => (n === 2 ? { position: 3 } : null), loop: null }));
  for (const d of decks) d.setTempo = (p) => { calls.push([`deck${d.index + 1}.setTempo`, p]); d.tempo = p; };
  const channels = [0, 1, 2, 3].map((i) => Object.assign(rec(`ch${i + 1}`), { state: { volume: 0.8, eqHigh: 0, eqMid: 0, eqLow: 0, filter: 0, trim: 0, fxMix: 0.5, fxParam: 0.5, cue: false, fxOn: false, xfAssign: i % 2 ? 'B' : 'A', colorFx: 'filter' }, level: () => 0.7 }));
  for (const ch of channels) ch.set = (k, v) => { calls.push([`ch${channels.indexOf(ch) + 1}.set`, k, v]); ch.state[k] = v; };
  const listeners = new Map();
  const engine = Object.assign(rec('engine'), {
    decks, channels, sampler: Object.assign(rec('sampler'), { slots: [] }), crossfader: 0, cueMix: 0,
    on: (ev, fn) => { listeners.set(ev, fn); return () => listeners.delete(ev); },
    setCrossfader: (x) => { engine.crossfader = x; listeners.get('master')?.('crossfader', x); },
    setCueMix: (v) => { engine.cueMix = v; },
  });
  const app = { engine, settings: { midiMappings: {} }, library: rec('library'), automix: {}, deckCount: 2, toast: (m) => calls.push(['toast', m]), setSetting: (k, v) => { app.settings[k] = v; }, padFx: (d, fx, down) => calls.push(['padFx', d.index, fx, down]) };
  return { app, calls, decks, channels, engine };
}
function manager() {
  const f = fakeApp();
  const m = new MidiManager(f.app);
  m.targets = buildTargets(f.app); m.byId = new Map(m.targets.map((t) => [t.id, t])); m.states = buildStates(f.app);
  return { ...f, m };
}
const DEV = { name: 'DDJ-FLX2 MIDI 1' };

test('FLX2: preset is bundled, matched by port name and listed first', () => {
  assert.equal(PRESETS[0], FLX2_PRESET);
  for (const n of ['DDJ-FLX2', 'DDJ-FLX2 MIDI 1', 'ddj flx2', 'DDJFLX2 20:0']) assert.ok(FLX2_MATCH.test(n), n);
  for (const n of ['DDJ-FLX4', 'DDJ-400', 'DDJ-FLX10']) assert.ok(!FLX2_MATCH.test(n), n);
  assert.equal(PRESETS.find((p) => p.match.test('DDJ-FLX2')), FLX2_PRESET);
  assert.equal(FLX2_PRESET.licence, 'CC0-1.0');
});

test('FLX2: every entry points at an existing target, no key is mapped twice', () => {
  const { m } = manager();
  const keys = new Set();
  for (const e of FLX2_PRESET.entries) {
    assert.ok(m.byId.has(e.target), `target ${e.target}`);
    assert.ok(!keys.has(e.key), `duplicate ${e.key}`); keys.add(e.key);
    assert.ok(e.verified || e.unverified, `${e.key} carries its provenance flag`);
  }
});

test('FLX2: chart-cited facts', () => {
  const by = new Map(FLX2_PRESET.entries.map((e) => [e.key, e]));
  const t = (key) => by.get(key)?.target;
  assert.equal(t('cc:0:7'), 'mixer1.eqHigh'); assert.equal(t('cc:0:11'), 'mixer1.eqMid'); assert.equal(t('cc:0:15'), 'mixer1.eqLow');
  assert.equal(t('cc:1:19'), 'mixer2.volume'); assert.equal(t('note:0:84'), 'mixer1.cue'); assert.equal(t('note:1:84'), 'mixer2.cue');
  assert.equal(t('cc:6:23'), 'mixer1.filter'); assert.equal(t('cc:6:24'), 'mixer2.filter'); assert.equal(t('cc:6:31'), 'mixer.crossfader');
  assert.equal(t('cc:6:8'), 'master.volume'); assert.equal(t('note:0:63'), 'global.shift'); assert.equal(t('note:1:63'), 'global.shift');
  assert.equal(t('cc:0:34'), 'deck1.jog'); assert.equal(t('cc:0:35'), 'deck1.jogRing'); assert.equal(t('cc:1:33'), 'deck2.jogRing'); assert.equal(t('cc:1:41'), 'deck2.jogSearch');
  assert.deepEqual(FLX2_PAD_BANKS, { hotcue: 0, padfx: 16, loop: 96, sampler: 48 });
  assert.deepEqual(FLX2_PAD_CH, { 1: [7, 8], 2: [9, 10] });
  assert.equal(t('note:7:0'), 'deck1.hotcue1'); assert.equal(t('note:8:0'), 'deck1.hotcueClear1');
  assert.equal(t('note:9:23'), 'deck2.padFx8'); assert.equal(t('note:10:23'), 'deck2.roll8');
  assert.equal(t('note:7:96'), 'deck1.loopPad1'); assert.equal(t('note:8:96'), 'deck1.beatjump1');
  assert.equal(t('note:9:48'), 'deck2.sampler1'); assert.equal(t('note:10:55'), 'deck2.samplerStop8');
});

test('FLX2: replayed messages drive decks, mixer, jog and shift layers', () => {
  const { m, calls, decks, channels, app } = manager();
  m.applyPreset(DEV.name, FLX2_PRESET.name);
  assert.equal(m.mappings[DEV.name].presetId, FLX2_PRESET.id);
  assert.equal(m.presetOf(DEV.name), FLX2_PRESET);
  const send = (b) => m.onMessage(DEV, Uint8Array.from(b));
  calls.length = 0;
  send([0x90, 0x0b, 0x7f]); send([0x90, 0x0b, 0x00]);
  assert.deepEqual(calls.filter((c) => c[0].startsWith('deck1.')).map((c) => c[0]), ['deck1.togglePlay']);
  calls.length = 0; send([0x91, 0x0c, 0x7f]); send([0x91, 0x0c, 0x00]);
  assert.deepEqual(calls.filter((c) => c[0].startsWith('deck2.')).map((c) => c[0]), ['deck2.cueDown', 'deck2.cueUp']);
  // 14-bit channel fader
  send([0xb0, 0x13, 0x7f]); send([0xb0, 0x33, 0x7f]);
  assert.ok(Math.abs(channels[0].state.volume - 1) < 1e-6);
  // crossfader centre
  send([0xb6, 0x1f, 0x40]); send([0xb6, 0x3f, 0x00]);
  assert.ok(Math.abs(app.engine.crossfader) < 0.001, 'crossfader centred');
  // jog touch + scratch, outer ring nudge, shift + jog search
  calls.length = 0;
  send([0x90, 0x36, 0x7f]); assert.equal(decks[0]._jogTouched, true);
  send([0xb0, 0x22, 0x42]);
  assert.ok(calls.some((c) => c[0] === 'deck1.jogScratch' && c[1] > 0), 'touched jog scratches');
  send([0x90, 0x36, 0x00]); assert.equal(decks[0]._jogTouched, false);
  calls.length = 0; send([0xb1, 0x21, 0x3e]);
  assert.ok(calls.some((c) => c[0] === 'deck2.jogNudge' && c[1] < 0), 'outer ring nudges backwards');
  calls.length = 0; send([0xb1, 0x29, 0x41]);
  assert.ok(calls.some((c) => c[0] === 'deck2.seek'), 'shift + jog searches');
  // SHIFT
  send([0x90, 0x3f, 0x7f]); assert.equal(app.shift, true); send([0x90, 0x3f, 0x00]); assert.equal(app.shift, false);
  // pads: normal and shift layer channels
  calls.length = 0; send([0x97, 0x02, 0x7f]); send([0x97, 0x02, 0x00]);
  assert.deepEqual(calls.filter((c) => c[0].startsWith('deck1.')).map((c) => c[0]), ['deck1.hotCueDown', 'deck1.hotCueUp']);
  calls.length = 0; send([0x98, 0x02, 0x7f]);
  assert.ok(calls.some((c) => c[0] === 'deck1.deleteHotCue' && c[1] === 2), 'SHIFT + pad deletes the hot cue');
  calls.length = 0; send([0x99, 0x10, 0x7f]); send([0x99, 0x10, 0x00]);
  assert.deepEqual(calls.filter((c) => c[0] === 'padFx').map((c) => c.slice(1)), [[1, 'brake', true], [1, 'brake', false]]);
  calls.length = 0; send([0x99, 0x34, 0x7f]);
  assert.ok(calls.some((c) => c[0] === 'sampler.trigger' && c[1] === 4));
  calls.length = 0; send([0x9a, 0x34, 0x7f]);
  assert.ok(calls.some((c) => c[0] === 'sampler.stop' && c[1] === 4));
  // pad mode button: selects the mode (LED state) and the deck UI's pad mode
  send([0x90, 0x22, 0x7f]);
  assert.equal(ctlState(app).padMode[1], 'sampler');
  // headphone cue toggles
  send([0x91, 0x54, 0x7f]); assert.equal(channels[1].state.cue, true);
});

test('FLX2: LEDs follow state for pads, transport, sync, pad modes and cue buttons', () => {
  const { m, decks, channels, app } = manager();
  m.applyPreset(DEV.name, FLX2_PRESET.name);
  const sent = [];
  m.access = { inputs: new Map(), outputs: new Map([['o', { id: 'o', name: 'DDJ-FLX2 MIDI 1', send: (msg) => sent.push(msg.join(',')) }]]) };
  decks[0].playing = true; decks[1].syncOn = true; channels[1].state.cue = true;
  setPadMode(app, 0, 'loop');
  m.updateLeds();
  const has = (s) => sent.includes(s);
  assert.ok(has('144,11,127'), 'deck 1 PLAY lit'); assert.ok(has('145,11,0'), 'deck 2 PLAY dark');
  assert.ok(has('145,88,127'), 'deck 2 SYNC lit'); assert.ok(has('145,84,127'), 'deck 2 headphone CUE lit');
  assert.ok(has('151,2,127'), 'hot cue pad C lit (cue set)'); assert.ok(has('151,0,0'), 'empty hot cue pad dark');
  assert.ok(has('144,109,127'), 'LOOP pad mode lit'); assert.ok(has('144,27,0'), 'HOT CUE pad mode dark');
});

test('Smart CFX and Smart Fader', () => {
  const { app, channels, engine, decks } = fakeApp();
  setSmartCfx(app, true, 2);
  assert.ok(channels.every((c) => c.state.colorFx === SMART_CFX[2].id));
  setSmartCfx(app, false);
  assert.ok(channels.every((c) => c.state.colorFx === 'filter'));
  decks[0].playing = true;
  setSmartFader(app, true);
  engine.setCrossfader(1); // fully on B: A's bass out, B's in, both at B's BPM
  assert.ok(channels[0].state.eqLow < -0.99 && Math.abs(channels[1].state.eqLow) < 0.01);
  assert.ok(Math.abs(decks[0].bpm * (1 + decks[0].tempo / 100) - decks[1].bpm) < 0.01);
  engine.setCrossfader(-1);
  assert.ok(channels[1].state.eqLow < -0.99 && Math.abs(channels[0].state.eqLow) < 0.01);
  setSmartFader(app, false);
  assert.ok(Math.abs(channels[0].state.eqLow) < 1e-9 && Math.abs(channels[1].state.eqLow) < 1e-9, 'EQs restored');
  // pad modes through padAction
  setPadMode(app, 0, 'keyshift');
  padAction(app, 0, 7, true);
});
