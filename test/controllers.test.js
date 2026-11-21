// Controller support: Mixxx mapping conversion, online mapping search, HID learn classifier, guided-setup detection,
// and MidiManager playback of converted mappings (14-bit, relative, LEDs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertMixxx, mixxxTarget, scriptTarget, words } from '../public/js/midi/mixxx.js';
import { parseXml } from '../public/js/midi/xml.js';
import { matchMappings, listMixxxMappings, LIST_URL } from '../public/js/midi/mixxx-online.js';
import { classifyHid, noisyBytes, readHid, decodeHid, parseHidKey } from '../public/js/midi/hid.js';
import { detectMidiControl, classifyCcValues, wizardSteps, entryFor } from '../public/js/midi/wizard.js';
import { MidiManager, buildTargets, buildStates, relDelta, guessRel, portBase } from '../public/js/midi/midi.js';

const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<MixxxControllerPreset mixxxVersion="2.4" schemaVersion="1">
  <info>
    <name>Acme DJ-2 &amp; Friends</name>
    <author>Test Author</author>
    <description>Sample mapping for tests</description>
  </info>
  <controller id="ACME-DJ2">
    <scriptfiles><file filename="Acme-DJ2-scripts.js" functionprefix="AcmeDJ2"/></scriptfiles>
    <controls>
      <!-- transport -->
      <control><group>[Channel1]</group><key>play</key><status>0x90</status><midino>0x0B</midino><options><normal/></options></control>
      <control><group>[Channel1]</group><key>play</key><status>0x80</status><midino>0x0B</midino><options><normal/></options></control>
      <control><group>[Channel1]</group><key>cue_default</key><status>0x90</status><midino>0x0C</midino><options><Normal/></options></control>
      <control><group>[Channel2]</group><key>sync_enabled</key><status>0x91</status><midino>0x58</midino><options><normal/></options></control>
      <control><group>[Channel2]</group><key>keylock</key><status>0x91</status><midino>0x1A</midino></control>
      <!-- 14-bit tempo fader, inverted -->
      <control><group>[Channel1]</group><key>rate</key><status>0xB0</status><midino>0x00</midino><options><fourteen-bit-msb/><invert/></options></control>
      <control><group>[Channel1]</group><key>rate</key><status>0xB0</status><midino>0x20</midino><options><fourteen-bit-lsb/><invert/></options></control>
      <!-- mixer -->
      <control><group>[Channel1]</group><key>volume</key><status>0xB0</status><midino>0x13</midino></control>
      <control><group>[EqualizerRack1_[Channel1]_Effect1]</group><key>parameter1</key><status>0xB0</status><midino>0x0F</midino></control>
      <control><group>[EqualizerRack1_[Channel1]_Effect1]</group><key>parameter3</key><status>0xB0</status><midino>0x07</midino></control>
      <control><group>[QuickEffectRack1_[Channel2]]</group><key>super1</key><status>0xB6</status><midino>0x18</midino></control>
      <control><group>[Master]</group><key>crossfader</key><status>0xB6</status><midino>0x1F</midino></control>
      <control><group>[Master]</group><key>headGain</key><status>0xB6</status><midino>0x0D</midino></control>
      <control><group>[Library]</group><key>MoveVertical</key><status>0xB6</status><midino>0x40</midino><options><SelectKnob/></options></control>
      <control><group>[Channel2]</group><key>LoadSelectedTrack</key><status>0x96</status><midino>0x47</midino></control>
      <control><group>[Channel1]</group><key>jog</key><status>0xB0</status><midino>0x21</midino><options><rot64/></options></control>
      <control><group>[Channel1]</group><key>hotcue_3_activate</key><status>0x97</status><midino>0x02</midino></control>
      <control><group>[Channel1]</group><key>hotcue_3_clear</key><status>0x98</status><midino>0x02</midino></control>
      <control><group>[Channel1]</group><key>beatloop_0.5_toggle</key><status>0x97</status><midino>0x61</midino></control>
      <control><group>[Channel2]</group><key>beatjump_8_forward</key><status>0x99</status><midino>0x27</midino></control>
      <control><group>[Sampler3]</group><key>cue_gotoandplay</key><status>0x97</status><midino>0x32</midino></control>
      <control><group>[EffectRack1_EffectUnit2]</group><key>mix</key><status>0xB5</status><midino>0x02</midino></control>
      <control><group>[Skin]</group><key>show_waveforms</key><status>0x96</status><midino>0x70</midino></control>
      <control><group>[Channel1]</group><key>play</key><status>0xA0</status><midino>0x01</midino></control>
      <!-- scripted controls -->
      <control><description>JOG platter rotate</description><group>[Channel1]</group><key>AcmeDJ2.wheelTurn</key><status>0xB0</status><midino>0x22</midino><options><script-binding/></options></control>
      <control><group>[Channel1]</group><key>AcmeDJ2.wheelTouch</key><status>0x90</status><midino>0x36</midino><options><Script-Binding/></options></control>
      <control><group>[Channel1]</group><key>AcmeDJ2.wheelTouch</key><status>0x80</status><midino>0x36</midino><options><Script-Binding/></options></control>
      <control><group>[Channel2]</group><key>AcmeDJ2.shiftButton</key><status>0x91</status><midino>0x3F</midino><options><script-binding/></options></control>
      <control><group>[Channel2]</group><key>AcmeDJ2.tempoSliderMSB</key><status>0xB1</status><midino>0x00</midino><options><script-binding/></options></control>
      <control><group>[Channel2]</group><key>AcmeDJ2.tempoSliderLSB</key><status>0xB1</status><midino>0x20</midino><options><script-binding/></options></control>
      <control><group>[Channel2]</group><key>AcmeDJ2.padPressed</key><status>0x99</status><midino>0x11</midino><options><script-binding/></options></control>
      <control><group>[Channel2]</group><key>AcmeDJ2.padPressed</key><status>0x99</status><midino>0x10</midino><options><script-binding/></options></control>
      <control><group>[Channel2]</group><key>AcmeDJ2.toggleLoopAdjustIn</key><status>0x91</status><midino>0x4C</midino><options><script-binding/></options></control>
      <control><group>[Channel1]</group><key>AcmeDJ2.vuMeterThing</key><status>0x90</status><midino>0x7E</midino><options><script-binding/></options></control>
    </controls>
    <outputs>
      <output><group>[Channel1]</group><key>play_indicator</key><status>0x90</status><midino>0x0B</midino><on>0x7F</on><off>0x00</off><minimum>0.5</minimum></output>
      <output><group>[Channel1]</group><key>hotcue_3_enabled</key><status>0x97</status><midino>0x02</midino><on>0x2A</on><minimum>0.5</minimum></output>
      <output><group>[Channel1]</group><key>VuMeter</key><status>0xB0</status><midino>0x02</midino><on>0x7F</on><off>0x00</off><minimum>0.6</minimum><maximum>1</maximum></output>
      <output><group>[Channel2]</group><key>sync_enabled</key><status>0x91</status><midino>0x58</midino></output>
      <output><group>[Skin]</group><key>show_mixer</key><status>0x90</status><midino>0x01</midino></output>
    </outputs>
  </controller>
</MixxxControllerPreset>`;

const find = (conv, target) => conv.entries.filter((e) => e.target === target);

test('xml parser handles comments, entities, attributes and self-closing tags', () => {
  const doc = parseXml('<?xml version="1.0"?><!-- c --><a x="1" y=\'2 &amp; 3\'><b/>t&lt;x<c><![CDATA[<raw>]]></c></a>');
  const a = doc.children[0];
  assert.equal(a.name, 'a');
  assert.deepEqual(a.attrs, { x: '1', y: '2 & 3' });
  assert.equal(a.children[0].name, 'b');
  assert.equal(a.text, 't<x');
  assert.equal(a.children[1].text, '<raw>');
});

test('Mixxx: info and plain controls translate to OpenDJ targets', () => {
  const c = convertMixxx(SAMPLE);
  assert.equal(c.name, 'Acme DJ-2 & Friends');
  assert.equal(c.author, 'Test Author');
  assert.deepEqual(find(c, 'deck1.play'), [{ key: 'note:0:11', target: 'deck1.play' }], 'note-on/note-off pair deduped');
  assert.equal(find(c, 'deck1.cue')[0].key, 'note:0:12');
  assert.equal(find(c, 'deck2.sync')[0].key, 'note:1:88');
  assert.equal(find(c, 'deck2.keylock')[0].key, 'note:1:26');
  assert.equal(find(c, 'mixer1.volume')[0].key, 'cc:0:19');
  assert.equal(find(c, 'mixer1.eqLow')[0].key, 'cc:0:15', 'EQ parameter1 is the low band');
  assert.equal(find(c, 'mixer1.eqHigh')[0].key, 'cc:0:7', 'EQ parameter3 is the high band');
  assert.equal(find(c, 'mixer2.filter')[0].key, 'cc:6:24');
  assert.equal(find(c, 'mixer.crossfader')[0].key, 'cc:6:31');
  assert.equal(find(c, 'master.hpVolume')[0].key, 'cc:6:13');
  assert.equal(find(c, 'deck2.load')[0].key, 'note:6:71');
  assert.equal(find(c, 'deck1.hotcue3')[0].key, 'note:7:2');
  assert.equal(find(c, 'deck1.hotcueClear3')[0].key, 'note:8:2');
  assert.equal(find(c, 'deck1.beatloop.0.5')[0].key, 'note:7:97');
  assert.equal(find(c, 'deck2.jumpFwd.8')[0].key, 'note:9:39');
  assert.equal(find(c, 'deck1.sampler3')[0].key, 'note:7:50');
  assert.equal(find(c, 'mixer2.fxMix')[0].key, 'cc:5:2');
});

test('Mixxx: options → 14-bit pairs, invert, relative encodings', () => {
  const c = convertMixxx(SAMPLE);
  assert.deepEqual(find(c, 'deck1.tempo'), [{ key: 'cc:0:0', target: 'deck1.tempo', invert: true, lsbKey: 'cc:0:32' }]);
  assert.deepEqual(find(c, 'browser.scroll'), [{ key: 'cc:6:64', target: 'browser.scroll', rel: 'twos' }], 'SelectKnob is two\'s complement');
  assert.equal(find(c, 'deck1.jogRing').length + find(c, 'deck1.jog').filter((e) => e.key === 'cc:0:33').length, 1);
  assert.equal(c.entries.find((e) => e.key === 'cc:0:33').rel, 'offset', 'rot64 is offset-64');
});

test('Mixxx: script bindings are mapped by name heuristics', () => {
  const c = convertMixxx(SAMPLE);
  const jog = c.entries.find((e) => e.key === 'cc:0:34');
  assert.equal(jog.target, 'deck1.jog');
  assert.equal(jog.rel, 'auto', 'scripted jog decodes its encoding at runtime');
  assert.deepEqual(find(c, 'deck1.jogTouch'), [{ key: 'note:0:54', target: 'deck1.jogTouch' }]);
  assert.equal(find(c, 'global.shift')[0].key, 'note:1:63');
  assert.deepEqual(find(c, 'deck2.tempo'), [{ key: 'cc:1:0', target: 'deck2.tempo', lsbKey: 'cc:1:32' }], 'scripted MSB/LSB pair combined');
  // pads without a number are numbered by MIDI note order
  assert.equal(c.entries.find((e) => e.key === 'note:9:16').target, 'deck2.pad1');
  assert.equal(c.entries.find((e) => e.key === 'note:9:17').target, 'deck2.pad2');
  // "toggleLoopAdjustIn" must not be mistaken for a pad ("looP ADjust")
  assert.ok(!c.entries.some((e) => e.key === 'note:1:76'));
});

test('Mixxx: unmapped controls are reported, stats add up', () => {
  const c = convertMixxx(SAMPLE);
  const reasons = c.unmapped.map((u) => `${u.group} ${u.key}: ${u.reason}`);
  assert.ok(reasons.some((r) => r.startsWith('[Skin] show_waveforms: no OpenDJ equivalent')));
  assert.ok(reasons.some((r) => r.includes('unsupported message type')), 'aftertouch is not mappable');
  assert.ok(reasons.some((r) => r.includes('AcmeDJ2.toggleLoopAdjustIn: script function')));
  assert.ok(reasons.some((r) => r.includes('AcmeDJ2.vuMeterThing: script function')));
  assert.ok(reasons.some((r) => r.startsWith('[Skin] show_mixer: LED output')));
  assert.equal(c.stats.unmapped, c.unmapped.length);
  assert.equal(c.stats.scripted, 9, 'scripted controls counted once (note-off duplicate removed)');
  assert.ok(c.stats.scriptedMapped >= 7);
});

test('Mixxx: LED outputs keep status/midino/on/off/min/max', () => {
  const c = convertMixxx(SAMPLE);
  assert.deepEqual(c.outputs.find((o) => o.state === 'deck1.play'), { state: 'deck1.play', status: 0x90, midino: 0x0b, on: 0x7f, off: 0, min: 0.5 });
  assert.equal(c.outputs.find((o) => o.state === 'deck1.hotcue3').on, 0x2a);
  assert.deepEqual(c.outputs.find((o) => o.state === 'mixer1.vu'), { state: 'mixer1.vu', status: 0xb0, midino: 2, on: 127, off: 0, min: 0.6, max: 1 });
  assert.equal(c.outputs.find((o) => o.state === 'deck2.sync').on, 0x7f, 'default on value');
  assert.equal(c.stats.outputs, 5);
  assert.equal(c.stats.outputsMapped, 4);
});

test('Mixxx: rejects files that are not MIDI mappings', () => {
  assert.throws(() => convertMixxx('<foo/>'), /Not a Mixxx/);
  assert.throws(() => convertMixxx('<MixxxControllerPreset><info/></MixxxControllerPreset>'), /no <controller>/);
});

test('Mixxx: translation helpers', () => {
  assert.deepEqual(mixxxTarget('[Channel3]', 'pfl'), { target: 'mixer3.cue', kind: 'button' });
  assert.equal(mixxxTarget('[Channel2]', 'beatlooproll_0.25_activate').target, 'deck2.roll3');
  assert.equal(mixxxTarget('[EffectRack1_EffectUnit1]', 'group_[Channel2]_enable').target, 'mixer2.fxOn');
  assert.equal(mixxxTarget('[Playlist]', 'SelectNextTrack').target, 'browser.down');
  assert.equal(mixxxTarget('[Channel1]', 'nonsense'), null);
  assert.equal(words('PioneerDDJ400.tempoSliderMSB'.split('.').pop()), 'tempo slider msb');
  assert.equal(scriptTarget('[Channel2]', 'X.jogTouch', '', 'note', 1).target, 'deck2.jogTouch');
  assert.equal(scriptTarget('[Channel1]', 'X.jogTurn', 'JOG DIAL SIDE - rotate - Pitch bend', 'cc', 0).target, 'deck1.jogRing');
  assert.equal(scriptTarget('[Channel1]', 'X.jogSearch', '', 'cc', 0).target, 'deck1.jogSearch');
  assert.equal(scriptTarget('[Channel1]', 'X.hotcue4Pressed', '', 'note', 0).target, 'deck1.hotcue4');
  assert.equal(scriptTarget('[Channel1]', 'X.syncLongPressed', '', 'note', 0).target, 'deck1.master');
  assert.equal(scriptTarget('[Library]', 'X.browseEncoder', '', 'cc', 6).target, 'browser.scroll');
  assert.equal(scriptTarget('[Channel1]', 'X.cueLoopCallLeft', '', 'note', 0), null);
});

test('online search: fuzzy-matches device names against Mixxx file names', () => {
  const items = ['Pioneer-DDJ-400.midi.xml', 'Pioneer-DDJ-4000.midi.xml', 'Pioneer-DDJ-FLX4.midi.xml', 'Pioneer-DDJ-SB3.midi.xml', 'Numark-Mixtrack-Pro-3.midi.xml', 'Numark-Mixtrack-Platinum-FX.midi.xml', 'Hercules-DJControl-Inpulse-200.midi.xml', 'Hercules-DJControl-Inpulse-300.midi.xml', 'Behringer-CMD-MM-1.midi.xml', 'Traktor-Kontrol-S2-MK3.midi.xml']
    .map((file) => ({ file, name: file.replace('.midi.xml', '') }));
  const top = (n) => matchMappings(n, items)[0]?.file;
  assert.equal(top('DDJ-400'), 'Pioneer-DDJ-400.midi.xml');
  assert.equal(top('DDJ-400 MIDI 1'), 'Pioneer-DDJ-400.midi.xml');
  assert.equal(top('DDJ-FLX4'), 'Pioneer-DDJ-FLX4.midi.xml');
  assert.equal(top('MIDIIN2 (Mixtrack Pro 3)'), 'Numark-Mixtrack-Pro-3.midi.xml');
  assert.equal(top('DJControl Inpulse 300 MIDI'), 'Hercules-DJControl-Inpulse-300.midi.xml');
  assert.equal(top('CMD MM-1'), 'Behringer-CMD-MM-1.midi.xml');
  assert.deepEqual(matchMappings('Midi Through Port-0', items), []);
  assert.deepEqual(matchMappings('USB Audio Device', items), []);
});

function fakeStorage() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; }
const resp = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: (h) => headers[h.toLowerCase()] ?? null } });

test('online search: listing is cached for a day and survives rate limits', async () => {
  const storage = fakeStorage();
  let calls = 0;
  const listing = [{ type: 'file', name: 'Pioneer-DDJ-400.midi.xml' }, { type: 'file', name: 'Pioneer-DDJ-400-script.js' }, { type: 'file', name: 'Some-HID.hid.xml' }, { type: 'dir', name: 'common' }];
  const ok = async (url) => { calls++; assert.equal(url, LIST_URL); return resp(200, listing); };
  const items = await listMixxxMappings({ fetchFn: ok, storage, now: 1000 });
  assert.deepEqual(items, [{ file: 'Pioneer-DDJ-400.midi.xml', name: 'Pioneer DDJ 400' }]);
  await listMixxxMappings({ fetchFn: ok, storage, now: 1000 + 3600e3 });
  assert.equal(calls, 1, 'second call served from cache');
  const limited = async () => resp(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' });
  const stale = await listMixxxMappings({ fetchFn: limited, storage, now: 1000 + 2 * 86400e3 });
  assert.equal(stale.length, 1, 'stale cache used when rate-limited');
  await assert.rejects(listMixxxMappings({ fetchFn: limited, storage: fakeStorage() }), /limit/);
  await assert.rejects(listMixxxMappings({ fetchFn: async () => { throw new TypeError('Failed to fetch'); }, storage: fakeStorage() }), /Could not reach GitHub/);
});

// ---------- HID ----------
const frame = (len, set = {}) => { const f = new Uint8Array(len); for (const [o, v] of Object.entries(set)) f[o] = v; return f; };

test('HID classifier: single bit toggle → button', () => {
  const frames = [frame(8, { 2: 0b0001 }), frame(8, { 2: 0b0101 }), frame(8, { 2: 0b0001 })];
  assert.deepEqual(classifyHid(frames), { fmt: 'bit', offset: 2, bit: 2, mode: 'button' });
  assert.deepEqual(classifyHid(frames, { hint: 'button' }), { fmt: 'bit', offset: 2, bit: 2, mode: 'button' });
});

test('HID classifier: ignores noisy bytes (counters) seen while idle', () => {
  const idle = [0, 1, 2, 3].map((i) => frame(8, { 7: i }));
  const noise = noisyBytes(idle);
  assert.deepEqual([...noise], [7]);
  const frames = [frame(8, { 7: 4 }), frame(8, { 1: 0x10, 7: 5 }), frame(8, { 1: 0x00, 7: 6 }), frame(8, { 1: 0x10, 7: 7 })];
  assert.deepEqual(classifyHid(frames, { hint: 'button', noise }), { fmt: 'bit', offset: 1, bit: 4, mode: 'button' });
});

test('HID classifier: 8-bit sweep → absolute fader', () => {
  const frames = [0, 20, 60, 110, 160, 200, 255].map((v) => frame(6, { 3: v }));
  assert.deepEqual(classifyHid(frames), { fmt: 'u8', offset: 3, mode: 'abs', max: 255 });
});

test('HID classifier: 16-bit little-endian 12-bit fader', () => {
  const frames = [0, 300, 900, 1500, 2600, 3500, 4095].map((v) => frame(8, { 4: v & 0xff, 5: v >> 8 }));
  assert.deepEqual(classifyHid(frames, { hint: 'abs' }), { fmt: 'u16le', offset: 4, mode: 'abs', max: 4095 });
  assert.equal(readHid(frames[3], { fmt: 'u16le', offset: 4 }), 1500);
});

test('HID classifier: 16-bit big-endian word', () => {
  const vals = [100, 220, 250, 270, 300, 600, 800, 1000];
  const frames = vals.map((v) => frame(8, { 2: v >> 8, 3: v & 0xff }));
  assert.deepEqual(classifyHid(frames, { hint: 'abs' }), { fmt: 'u16be', offset: 2, mode: 'abs', max: 1023 });
});

test('HID classifier: wrapping counter → relative jog; decode handles wrap', () => {
  const vals = [250, 252, 254, 0, 2, 4, 6];
  const frames = vals.map((v) => frame(10, { 6: v }));
  const r = classifyHid(frames);
  assert.deepEqual(r, { fmt: 'u8', offset: 6, mode: 'rel', rel: 'counter' });
  assert.equal(decodeHid({ key: 'hid:1:u8:6', mode: 'rel', rel: 'counter' }, 2, 254), 4);
  assert.equal(decodeHid({ key: 'hid:1:u8:6', mode: 'rel', rel: 'counter' }, 250, 3), -9);
  // 16-bit counter going backwards across zero
  const v16 = [3, 1, 65535, 65533, 65530];
  const f16 = v16.map((v) => frame(8, { 0: v & 0xff, 1: v >> 8 }));
  assert.deepEqual(classifyHid(f16, { hint: 'rel' }), { fmt: 'u16le', offset: 0, mode: 'rel', rel: 'counter' });
});

test('HID classifier: delta encoder resting at 0 → relative delta', () => {
  const frames = [0, 1, 0, 1, 2, 0, 255, 254, 0].map((v) => frame(4, { 1: v }));
  assert.deepEqual(classifyHid(frames, { hint: 'rel' }), { fmt: 'u8', offset: 1, mode: 'rel', rel: 'delta' });
  assert.equal(decodeHid({ key: 'hid:0:u8:1', mode: 'rel', rel: 'delta' }, 254), -2);
  assert.deepEqual(parseHidKey('hid:3:bit:5:7'), { reportId: 3, fmt: 'bit', offset: 5, bit: 7 });
});

test('HID classifier: nothing changed → null', () => {
  assert.equal(classifyHid([frame(4), frame(4)]), null);
  assert.equal(classifyHid([frame(4)]), null);
});

// ---------- guided setup ----------
const note = (ch, n, v) => ({ key: `note:${ch}:${n}`, type: 'note', channel: ch, number: n, value: v, isOff: v === 0 });
const cc = (ch, n, v) => ({ key: `cc:${ch}:${n}`, type: 'cc', channel: ch, number: n, value: v, isOff: false });

test('wizard: classifies CC value runs', () => {
  assert.deepEqual(classifyCcValues([1, 1, 1, 2, 1]), { kind: 'rel', rel: 'twos' });
  assert.deepEqual(classifyCcValues([127, 127, 126, 127]), { kind: 'rel', rel: 'twos' });
  assert.deepEqual(classifyCcValues([65, 65, 66, 65]), { kind: 'rel', rel: 'offset' });
  assert.deepEqual(classifyCcValues([63, 63, 62]), { kind: 'rel', rel: 'offset' });
  assert.deepEqual(classifyCcValues([10, 14, 20, 31, 45, 60, 77]), { kind: 'abs' });
  assert.deepEqual(classifyCcValues([60, 61, 62, 63, 64, 65]), { kind: 'abs' }, 'a slow fader sweep through the middle is absolute');
  assert.deepEqual(classifyCcValues([120, 124, 127, 2, 5], 'rel'), { kind: 'rel', rel: 'wrap' });
});

test('wizard: detects buttons, 14-bit faders and relative encoders', () => {
  assert.deepEqual(detectMidiControl([note(0, 11, 127), note(0, 11, 0)], { kind: 'button' }), { key: 'note:0:11', kind: 'button', type: 'note' });
  // a late note-off from the previous step plus the real press
  assert.equal(detectMidiControl([note(0, 12, 127)], { kind: 'button', exclude: new Set(['note:0:11']) }).key, 'note:0:12');
  // 14-bit fader: MSB CC 0x13 + LSB CC 0x33 interleaved
  const fader = [];
  for (let v = 0; v < 20; v++) fader.push(cc(0, 0x13, v * 5), cc(0, 0x33, (v * 37) % 128));
  assert.deepEqual(detectMidiControl(fader, { kind: 'abs' }), { key: 'cc:0:19', lsbKey: 'cc:0:51', kind: 'abs', type: 'cc' });
  // plain 7-bit knob
  assert.deepEqual(detectMidiControl([10, 20, 30, 40].map((v) => cc(1, 7, v)), { kind: 'abs' }), { key: 'cc:1:7', kind: 'abs', type: 'cc' });
  // jog: touch note arrives too, but this step wants the relative CC
  const jog = [note(0, 0x36, 127), ...[65, 65, 66, 65, 65].map((v) => cc(0, 0x22, v))];
  assert.deepEqual(detectMidiControl(jog, { kind: 'rel' }), { key: 'cc:0:34', kind: 'rel', rel: 'offset', type: 'cc' });
  assert.deepEqual(detectMidiControl([1, 1, 1].map((v) => cc(6, 0x40, v)), { kind: 'rel' }), { key: 'cc:6:64', kind: 'rel', rel: 'twos', type: 'cc' });
  // endless EQ knob on a fader step → relative entry on an absolute target
  const det = detectMidiControl([1, 1, 2, 1].map((v) => cc(0, 7, v)), { kind: 'abs' });
  assert.deepEqual(entryFor(det, { target: 'mixer1.eqHigh', kind: 'abs' }), { key: 'cc:0:7', target: 'mixer1.eqHigh', rel: 'twos' });
  // pitch bend tempo fader
  assert.equal(detectMidiControl([{ key: 'pitch:0:0', type: 'pitch', value: 9000 }], { kind: 'abs' }).key, 'pitch:0:0');
  assert.equal(detectMidiControl([], { kind: 'abs' }), null);
});

test('wizard: step list covers the core controls', () => {
  const s = wizardSteps(2);
  const ids = s.map((x) => x.target);
  for (const t of ['deck1.play', 'deck1.cue', 'deck1.sync', 'deck1.jogTouch', 'deck1.jog', 'deck1.tempo', 'deck1.pad8', 'deck2.play', 'mixer1.volume', 'mixer2.eqLow', 'mixer1.filter', 'mixer.crossfader', 'browser.scroll', 'deck2.load', 'global.shift']) assert.ok(ids.includes(t), t);
  assert.equal(s.find((x) => x.target === 'deck1.jog').kind, 'rel');
  assert.ok(wizardSteps(4).length > s.length);
});

// ---------- MidiManager playback ----------
function fakeApp() {
  const calls = [];
  const rec = (name) => new Proxy({}, { get: (o, p) => (p in o ? o[p] : typeof p === 'string' ? (...a) => calls.push([`${name}.${p}`, ...a]) : undefined) });
  const decks = [0, 1, 2, 3].map((i) => Object.assign(rec(`deck${i + 1}`), { playing: false, tempo: 0, tempoRange: 8, keyShift: 0, syncOn: false, isMaster: false, keyLock: false, slip: false, quantize: false, reverse: false, cuePreview: false, _jogTouched: false, vinylMode: true, position: 0, cuePoint: 0, loopBeats: 0, track: i === 0 ? {} : null, hotCue: (n) => (n === 2 ? {} : null), loop: null }));
  const channels = [0, 1, 2, 3].map((i) => Object.assign(rec(`ch${i + 1}`), { state: { volume: 0.8, eqHigh: 0, eqMid: 0, eqLow: 0, filter: 0, trim: 0, fxMix: 0.5, fxParam: 0.5, cue: false, fxOn: false }, level: () => 0.7 }));
  for (const ch of channels) ch.set = (k, v) => { calls.push([`ch${channels.indexOf(ch) + 1}.set`, k, v]); ch.state[k] = v; };
  const engine = Object.assign(rec('engine'), { decks, channels, sampler: rec('sampler') });
  const app = { engine, settings: { midiMappings: {} }, library: rec('library'), automix: {}, deckCount: 2, toast: (m) => calls.push(['toast', m]), setSetting: (k, v) => { app.settings[k] = v; } };
  return { app, calls, decks };
}
function manager() {
  const f = fakeApp();
  const m = new MidiManager(f.app);
  m.targets = buildTargets(f.app); m.byId = new Map(m.targets.map((t) => [t.id, t])); m.states = buildStates(f.app);
  return { ...f, m };
}

test('MidiManager: converted Mixxx mapping drives targets (buttons, 14-bit, relative)', () => {
  const { m, calls } = manager();
  const dev = { name: 'Acme DJ-2' };
  const stored = m.applyMixxx(dev.name, SAMPLE, 'Acme.midi.xml');
  assert.equal(stored.importInfo.stats.mapped, convertMixxx(SAMPLE).stats.mapped);
  calls.length = 0;
  m.onMessage(dev, Uint8Array.from([0x90, 0x0b, 0x7f]));
  assert.deepEqual(calls.filter((c) => c[0].startsWith('deck1.')).map((c) => c[0]), ['deck1.togglePlay']);
  // 14-bit inverted tempo: MSB 0x40, LSB 0x00 → 8192/16383 → inverted ≈ 0.49997 → fader ≈ −0.00006
  calls.length = 0;
  m.onMessage(dev, Uint8Array.from([0xb0, 0x00, 0x40]));
  m.onMessage(dev, Uint8Array.from([0xb0, 0x20, 0x00]));
  const tempo = calls.filter((c) => c[0] === 'deck1.setTempoFader').map((c) => c[1]);
  assert.equal(tempo.length, 2);
  assert.ok(Math.abs(tempo[1]) < 0.001);
  // select knob (two's complement): 127 → one step up
  calls.length = 0;
  m.onMessage(dev, Uint8Array.from([0xb6, 0x40, 0x7f]));
  assert.deepEqual(calls.find((c) => c[0] === 'library.moveSelection'), ['library.moveSelection', -1]);
  // scripted jog with 'auto' encoding: first value 65 → offset mode, +1 tick
  calls.length = 0;
  m.onMessage(dev, Uint8Array.from([0xb0, 0x22, 65]));
  m.onMessage(dev, Uint8Array.from([0xb0, 0x22, 63]));
  const nudges = calls.filter((c) => c[0] === 'deck1.jogNudge').map((c) => Math.sign(c[1]));
  assert.deepEqual(nudges, [1, -1]);
  // EQ low (parameter1)
  calls.length = 0;
  m.onMessage(dev, Uint8Array.from([0xb0, 0x0f, 127]));
  assert.deepEqual(calls.find((c) => c[0] === 'ch1.set'), ['ch1.set', 'eqLow', 1]);
});

test('MidiManager: Mixxx LED outputs are sent to the matching output port', () => {
  const { m, decks } = manager();
  m.applyMixxx('Acme DJ-2 MIDI 1', SAMPLE);
  const sent = [];
  m.access = { inputs: new Map(), outputs: new Map([['o', { id: 'o', name: 'Acme DJ-2 MIDI 1', send: (msg) => sent.push(msg) }]]) };
  decks[0].playing = true;
  m.updateLeds();
  const find = (st, no) => sent.find((s) => s[0] === st && s[1] === no);
  assert.deepEqual(find(0x90, 0x0b), [0x90, 0x0b, 0x7f], 'play LED on');
  assert.deepEqual(find(0x97, 0x02), [0x97, 0x02, 0x2a], 'hot cue 3 LED uses its <on> value');
  assert.deepEqual(find(0xb0, 0x02), [0xb0, 0x02, 0x7f], 'VU 0.7 is within [0.6, 1]');
  assert.deepEqual(find(0x91, 0x58), [0x91, 0x58, 0], 'sync off');
  sent.length = 0;
  m.updateLeds();
  assert.equal(sent.length, 0, 'unchanged LEDs are not resent');
  decks[0].playing = false;
  m.updateLeds();
  assert.deepEqual(sent, [[0x90, 0x0b, 0]]);
  assert.equal(portBase('DDJ-400 MIDI 1'), portBase('DDJ-400'));
});

test('MidiManager: learn detects 14-bit LSB, relative modes; endless knobs nudge absolute targets', () => {
  const { m, calls } = manager();
  const dev = { name: 'Ctl' };
  m.learn('Ctl', 'mixer1.volume');
  m.onMessage(dev, Uint8Array.from([0xb0, 0x13, 0x40]));
  m.onMessage(dev, Uint8Array.from([0xb0, 0x33, 0x10]));
  assert.deepEqual(m.mappings.Ctl.entries, [{ key: 'cc:0:19', target: 'mixer1.volume', lsbKey: 'cc:0:51' }]);
  m.learn('Ctl', 'deck1.jog');
  m.onMessage(dev, Uint8Array.from([0xb0, 0x22, 0x01]));
  assert.equal(m.mappings.Ctl.entries.find((e) => e.target === 'deck1.jog').rel, 'twos');
  // endless knob on EQ: starts from the current value (0 dB = 0.5) and moves
  m.mappings.Ctl.entries.push({ key: 'cc:0:7', target: 'mixer1.eqHigh', rel: 'twos' });
  calls.length = 0;
  m.onMessage(dev, Uint8Array.from([0xb0, 0x07, 0x08]));
  const v = calls.find((c) => c[0] === 'ch1.set' && c[1] === 'eqHigh')[2];
  assert.ok(v > 0 && v < 0.5, `nudged up from centre (${v})`);
  assert.equal(relDelta('twos', 127), -1);
  assert.equal(relDelta('offset', 60), -4);
  assert.equal(relDelta('wrap', 2, 126), 4);
  assert.equal(guessRel(63), 'offset');
  assert.equal(guessRel(127), 'twos');
});

test('MidiManager: HID reports and gamepad snapshots dispatch through the same mappings', () => {
  const { m, calls } = manager();
  m.mappings['hid:1234:5678'] = { name: 'HID', entries: [
    { key: 'hid:1:bit:0:3', target: 'deck1.play', mode: 'button' },
    { key: 'hid:1:u16le:2', target: 'mixer1.volume', mode: 'abs', max: 4095 },
    { key: 'hid:1:u8:4', target: 'deck1.jogRing', mode: 'rel', rel: 'counter' },
  ] };
  m.hid.onReport('hid:1234:5678', 1, frame(6));
  calls.length = 0;
  m.hid.onReport('hid:1234:5678', 1, frame(6, { 0: 0b1000, 2: 0xff, 3: 0x0f, 4: 3 }));
  assert.ok(calls.some((c) => c[0] === 'deck1.togglePlay'));
  assert.deepEqual(calls.find((c) => c[0] === 'ch1.set'), ['ch1.set', 'volume', 1]);
  assert.ok(calls.find((c) => c[0] === 'deck1.jogNudge')[1] > 0);
  m.mappings['gamepad:Pad'] = { name: 'Pad', entries: [{ key: 'gp:btn:0', target: 'deck2.play' }, { key: 'gp:axis:1', target: 'mixer.crossfader' }] };
  m.gamepads.process('gamepad:Pad', [0, 0], [0, 0]);
  calls.length = 0;
  m.gamepads.process('gamepad:Pad', [1, 0], [0, 1]);
  assert.ok(calls.some((c) => c[0] === 'deck2.togglePlay'));
  assert.deepEqual(calls.find((c) => c[0] === 'engine.setCrossfader'), ['engine.setCrossfader', 1]);
  // gamepad learn
  m.learn('gamepad:Pad', 'deck1.cue');
  m.gamepads.process('gamepad:Pad', [0, 0, 1], [0, 1]);
  assert.deepEqual(m.mappings['gamepad:Pad'].entries.at(-1), { key: 'gp:btn:2', target: 'deck1.cue' });
});

// ---------- community mappings: built in, recognised on plug-in, updated from GitHub ----------
test('community: a built-in mapping is applied on plug-in and updated when GitHub has a newer version', async () => {
  const { m, calls } = manager();
  const { hashEntries } = await import('../public/js/midi/community.js');
  const v1 = [{ key: 'note:0:11', target: 'deck1.play' }], v2 = [...v1, { key: 'note:0:12', target: 'deck1.cue' }];
  const entry = (entries) => ({ brand: 'Acme', model: 'DJ-2', status: 'needs-verification', file: 'Acme/Acme-DJ-2.opendj-midi.json', midiNames: ['ACME DJ-2'], hash: hashEntries(entries) });
  m._bundleP = Promise.resolve({ opendjCommunityBundle: 1, index: { opendjControllerIndex: 1, controllers: [entry(v1)] }, mappings: { 'Acme/Acme-DJ-2.opendj-midi.json': { name: 'Acme DJ-2', entries: v1 } } });
  assert.equal(await m.applyBundled('Unknown Box'), false);
  assert.equal(await m.applyBundled('ACME DJ-2 MIDI 1'), true);
  const stored = m.mappings['ACME DJ-2 MIDI 1'];
  assert.equal(stored.source, 'community');
  assert.equal(stored.communityHash, hashEntries(v1));
  assert.ok(calls.some((c) => c[0] === 'toast' && /recognised Acme DJ-2/.test(c[1])));
  // a mapping the user made is never replaced
  m.mappings['Mine MIDI'] = { name: 'Mine', entries: v1 };
  assert.equal(await m.applyBundled('Mine MIDI'), false);

  const gh = (entries) => async (url) => ({ ok: true, json: async () => (url.endsWith('index.json') ? { opendjControllerIndex: 1, controllers: [entry(entries)] } : { name: 'Acme DJ-2', entries }) });
  assert.deepEqual(await m.checkCommunityUpdates({ fetchFn: gh(v1) }), []); // same version
  assert.deepEqual(await m.checkCommunityUpdates({ fetchFn: gh(v2) }), ['ACME DJ-2 MIDI 1']);
  assert.equal(m.mappings['ACME DJ-2 MIDI 1'].entries.length, 2);
  // changed by the user since: kept, and they are told once
  m.mappings['ACME DJ-2 MIDI 1'].entries.push({ key: 'note:0:13', target: 'deck1.sync' });
  const v3 = [...v2, { key: 'note:0:14', target: 'deck2.play' }];
  assert.deepEqual(await m.checkCommunityUpdates({ fetchFn: gh(v3) }), []);
  assert.equal(m.mappings['ACME DJ-2 MIDI 1'].entries.length, 3);
  assert.ok(calls.some((c) => c[0] === 'toast' && /You changed yours/.test(c[1])));
  // switched off: no network
  m.app.settings.controllerLookup = false;
  assert.deepEqual(await m.checkCommunityUpdates({ fetchFn: () => { throw new Error('no network expected'); } }), []);
  assert.deepEqual(await m.recognise('X', { fetchFn: () => { throw new Error('no'); } }), { community: null, mixxx: null, online: false });
});

test('community: recognition falls back to the Mixxx library and reports offline', async () => {
  const { m } = manager();
  m._bundleP = Promise.resolve(null);
  const fail = async () => { throw new Error('offline'); };
  assert.deepEqual(await m.recognise('Nothing MIDI 1', { fetchFn: fail }), { community: null, mixxx: null, online: false });
});

test('community: Controller Mapper messages can\'t pollute Object.prototype', () => {
  const { m } = manager();
  const win = { postMessage() {} };
  m._mapperWin = win;
  globalThis.location ??= { origin: 'http://x' };
  for (const device of ['__proto__', 'constructor', 'prototype']) {
    m.onMapperMessage({ origin: location.origin, source: win, data: { type: 'opendj-mapper:apply', device, mapping: { entries: [{ key: 'note:0:1', target: 'deck1.play' }] }, community: { file: 'x' } } });
  }
  assert.equal(({}).source, undefined);
  assert.equal(({}).entries, undefined);
  assert.ok(!Object.hasOwn(m.mappings, 'constructor'));
});

// ---------- proven Mixxx mappings: certain matches are applied automatically ----------
test('Mixxx: confidentMatch only accepts the file that is certainly this controller', async () => {
  const { confidentMatch, cleanPortName } = await import('../public/js/midi/mixxx-online.js');
  const items = ['Pioneer-DDJ-400.midi.xml', 'Pioneer-DDJ-400-Pro.midi.xml', 'Vestax VCI-400.midi.xml', 'Pioneer-DDJ-FLX4.midi.xml', 'Numark Mixtrack Pro.midi.xml',
    'Numark Mixtrack Pro FX.midi.xml', 'Numark Mixtrack Platinum FX.midi.xml', 'Hercules_DJControl_Inpulse_200.midi.xml', 'Hercules_DJControl_Inpulse_300.midi.xml',
    'Hercules_DJControl_Inpulse_500.midi.xml', 'Traktor Kontrol X1.midi.xml', 'Reloop-Mixage.midi.xml', 'Numark-Party-Mix.midi.xml'].map((file) => ({ file }));
  const pick = (n) => confidentMatch(n, items)?.file || null;
  assert.equal(cleanPortName('DDJ-400 MIDI 1'), 'DDJ-400');
  assert.equal(cleanPortName('DJControl Inpulse 200'), 'DJControl Inpulse 200'); // a model number is not a port index
  assert.equal(cleanPortName('MIDIIN2 (Mixtrack Pro FX)'), 'Mixtrack Pro FX');
  assert.equal(pick('DDJ-400 MIDI 1'), 'Pioneer-DDJ-400.midi.xml');
  assert.equal(pick('DDJ-FLX4'), 'Pioneer-DDJ-FLX4.midi.xml');
  assert.equal(pick('Mixtrack Pro FX'), 'Numark Mixtrack Pro FX.midi.xml');
  assert.equal(pick('Numark Mixtrack Pro'), 'Numark Mixtrack Pro.midi.xml'); // not "Pro FX": nothing extra wins
  assert.equal(pick('DJControl Inpulse 200'), 'Hercules_DJControl_Inpulse_200.midi.xml');
  assert.equal(pick('DJControl Inpulse 500 MIDI 1'), 'Hercules_DJControl_Inpulse_500.midi.xml');
  for (const n of ['Traktor Kontrol S2 MK3', 'Reloop Mixon 4', 'Party Mix MKII', 'USB MIDI Device', 'Akai APC40']) assert.equal(pick(n), null, n);
});

test('Mixxx: Components-style script bindings are converted', async () => {
  const { scriptTarget } = await import('../public/js/midi/mixxx.js');
  const t = (g, fn, type = 'note') => scriptTarget(g, fn, '', type, 0);
  assert.equal(t('[Channel1]', 'DJCi500.deckA.playButton.input').target, 'deck1.play');
  assert.equal(t('[Channel2]', 'DJCi500.deckB.cueButton.input').target, 'deck2.cue');
  assert.equal(t('[Channel1]', 'DJCi500.deckA.pflButton.input').target, 'mixer1.cue');
  assert.equal(t('[EqualizerRack1_[Channel2]_Effect1]', 'MixtrackProFX.deck[1].treble.input', 'cc').target, 'mixer2.eqHigh');
  assert.equal(t('[EqualizerRack1_[Channel1]_Effect1]', 'MixtrackProFX.deck[0].bass.input', 'cc').target, 'mixer1.eqLow');
  const tempo = t('[Channel1]', 'MixtrackProFX.deck[0].pitch.inputMSB', 'cc');
  assert.equal(tempo.target, 'deck1.tempo'); assert.equal(tempo.part, 'msb');
  assert.equal(t('[Channel1]', 'DJ2GO2Touch.leftDeck.hotcueButtons[2].input').target, 'deck1.hotcue2');
  assert.equal(t('[Channel1]', 'DJ2GO2Touch.leftDeck.reLoopStop.input').target, 'deck1.reloop');
  assert.equal(t('[QuickEffectRack1_[Channel2]]', 'DDJ200.super1', 'cc').target, 'mixer2.filter');
  // the deck can come from the path when the group doesn't say
  assert.equal(scriptTarget('[Master]', 'X.deckB.syncButton.input', '', 'note', 9).target, 'deck2.sync');
});

test('Mixxx: an automatic proven mapping is only applied when usable, and can be undone', async () => {
  const { m } = manager();
  const xml = (controls) => `<?xml version="1.0"?><MixxxControllerPreset><info><name>T</name></info><controller id="t"><controls>${controls}</controls></controller></MixxxControllerPreset>`;
  const ctl = (key, n) => `<control><group>[Channel1]</group><key>${key}</key><status>0x90</status><midino>${n}</midino></control>`;
  const rich = xml(['play', 'cue_default', 'sync_enabled', 'keylock', 'pfl', 'quantize', 'slip_enabled', 'reverse', 'beatloop_4_activate'].map((k, i) => ctl(k, i + 1)).join(''));
  const poor = xml(ctl('keylock', 1));
  const fetchFn = (body) => async () => ({ ok: true, status: 200, text: async () => body });
  m.mappings['Dev'] = { name: 'Mine', entries: [{ key: 'note:0:99', target: 'deck1.play' }] };
  assert.equal(await m.useMixxxMapping('Dev', 'Poor.midi.xml', { fetchFn: fetchFn(poor), requireUsable: true }), null);
  assert.equal(m.mappings['Dev'].name, 'Mine');
  const applied = await m.useMixxxMapping('Dev', 'Rich.midi.xml', { fetchFn: fetchFn(rich), requireUsable: true });
  assert.ok(applied.entries.length >= 8);
  assert.equal(m.mappings['Dev'].source, 'mixxx');
  assert.equal(m.undoMapping('Dev'), true);
  assert.equal(m.mappings['Dev'].name, 'Mine');
});
