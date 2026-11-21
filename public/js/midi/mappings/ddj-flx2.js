// First-party OpenDJ mapping for a compact 2-channel controller: the AlphaTheta DDJ-FLX2.
// Mapping data: CC0-1.0. Written for OpenDJ from the facts of the manufacturer's chart (which MIDI message each control
// sends and which LED messages it accepts). NOT derived from Mixxx (or any other app's) mapping files or scripts.
//
// Provenance: AlphaTheta, "DDJ-FLX2 List of MIDI Messages" (DDJ-FLX2_MIDI_Message_List_E1.pdf, edition E1,
// © 2024 AlphaTheta Corporation), https://assets.pioneerdjhub.com/DDJ-FLX2_MIDI_Message_List_E1.pdf. Every status /
// note / CC number below was checked against that chart (2026-11-21). Only the numbers are used; the chart's own
// text is not reproduced. Not covered by the chart (still to confirm with a capture from a real unit):
//  - which "Pad mode 1-4" is which: taken from the silkscreen order above pads 1-4 (HOT CUE · PAD FX · LOOP · SAMPLER)
//  - the SHIFT functions of MASTER cue and headphone cue 1 / 2: the chart only lists their messages; they are mapped to
//    SMART CFX and ◀ / ▶ FX SELECT (the mixer's Color FX previous / next) after the secondary silkscreen labels next to those buttons
//  - jog ticks per revolution (OpenDJ's default ≈ 720 is used) and the sound card's channel layout
//
// MIDI channels below are 0-based: chart channel 1 = 0 (deck 1), 2 = 1 (deck 2), 7 = 6 (global), 8-11 = 7-10
// (performance pads), 16 = 15 (MIDI-OUT only). Buttons send 0x7F pressed, 0x00 released; LEDs take the same message
// back with 0x7F on / 0x00 off. 14-bit controls send the MSB then the LSB (CC + 0x20). The jogs send 0x40 + the ticks
// turned since the last message (clockwise > 0x40). No SysEx or keep-alive is listed.
const k = (type, ch, num) => `${type}:${ch}:${num}`;

export const FLX2_ID = 'opendj-flx2';
export const FLX2_NAME = 'AlphaTheta DDJ-FLX2 (OpenDJ first-party)';
/** Port names the unit shows up as on Windows / macOS / Linux ("DDJ-FLX2", "DDJ-FLX2 MIDI 1", "DDJ FLX2 …"). */
export const FLX2_MATCH = /DDJ[-_ ]?FLX2/i;

/** Pad banks: note of pad 1 in each pad mode, pads 2-8 follow (chart: pad modes 1-4 = 0x00, 0x10, 0x60, 0x30). */
export const FLX2_PAD_BANKS = { hotcue: 0x00, padfx: 0x10, loop: 0x60, sampler: 0x30 };
/** Pad channels per deck: normal / with SHIFT held (chart channels 8 / 9 for deck 1, 10 / 11 for deck 2). */
export const FLX2_PAD_CH = { 1: [7, 8], 2: [9, 10] };
/** Pad mode selection (SHIFT + BEAT SYNC, then a pad): pads 1-4 send these notes on the deck channel. */
export const FLX2_PAD_MODE_SELECT = { hotcue: 0x00, padfx: 0x05, loop: 0x01, sampler: 0x03 };

// Per-deck controls on the deck's own channel (deck 1 = 0, deck 2 = 1): [type, number, target suffix, extra]
const DECK_CONTROLS = [
  ['note', 0x0b, 'play', {}], // PLAY/PAUSE
  ['note', 0x47, 'ctlStutter', {}], // SHIFT + PLAY/PAUSE
  ['note', 0x0c, 'cue', {}], // CUE
  ['note', 0x48, 'ctlToStart', {}], // SHIFT + CUE
  ['note', 0x58, 'sync', {}], // BEAT SYNC press
  ['note', 0x2a, 'master', { ledKey: 0x78 }], // BEAT SYNC long press (its LED answers on 0x78)
  ['note', 0x5c, 'ctlPadModeSelect', { noLed: true }], // SHIFT + BEAT SYNC: pad mode selection
  ['note', 0x36, 'jogTouch', { noLed: true }], // jog top touch
  ['note', 0x67, 'jogTouch', { noLed: true }], // jog top touch with SHIFT
  ['cc', 0x22, 'jog', { rel: 'offset' }], // jog top turned, vinyl mode on (scratch while touched)
  ['cc', 0x23, 'jogRing', { rel: 'offset' }], // jog top turned, vinyl mode off: bend
  ['cc', 0x21, 'jogRing', { rel: 'offset' }], // jog side (with or without SHIFT): bend
  ['cc', 0x29, 'jogSearch', { rel: 'offset' }], // SHIFT + jog top: search
  ['note', 0x3f, null, { target: 'global.shift', noLed: true }], // SHIFT
  ['note', FLX2_PAD_MODE_SELECT.hotcue, 'ctlPadMode.hotcue', {}], // pad mode select: pad 1
  ['note', FLX2_PAD_MODE_SELECT.padfx, 'ctlPadMode.padfx', {}], // pad 2
  ['note', FLX2_PAD_MODE_SELECT.loop, 'ctlPadMode.loop', {}], // pad 3
  ['note', FLX2_PAD_MODE_SELECT.sampler, 'ctlPadMode.sampler', {}], // pad 4
];

/** Mixer controls on the deck channel: [type, number, target suffix, lsb] */
const MIXER_CONTROLS = [
  ['cc', 0x07, 'eqHigh', 0x27], ['cc', 0x0b, 'eqMid', 0x2b], ['cc', 0x0f, 'eqLow', 0x2f],
  ['cc', 0x13, 'volume', 0x33], ['note', 0x54, 'cue', null],
];

// Pad actions per bank, normal and SHIFT layers.
const PAD_TARGETS = {
  hotcue: [(P, p) => `${P}.hotcue${p}`, (P, p) => `${P}.hotcueClear${p}`],
  padfx: [(P, p) => `${P}.padFx${p}`, (P, p) => `${P}.roll${p}`],
  loop: [(P, p) => `${P}.loopPad${p}`, (P, p) => `${P}.beatjump${p}`],
  sampler: [(P, p) => `${P}.sampler${p}`, (P, p) => `${P}.samplerStop${p}`],
};

/** Entries whose function (not number) is our interpretation: see the provenance note above. */
const INTERPRETED = new Set(['smart.cfx', 'mixer.colorFx.prev', 'mixer.colorFx.next']);

function entries() {
  const e = [];
  const mark = (entry, how = 'chart') => (INTERPRETED.has(entry.target) || how === 'silkscreen' ? { ...entry, verified: 'chart', interpreted: true } : { ...entry, verified: 'chart' });
  for (const [deck, ch] of [[1, 0], [2, 1]]) {
    const P = `deck${deck}`, M = `mixer${deck}`;
    for (const [type, num, suffix, extra] of DECK_CONTROLS) {
      const { target, ledKey, ...rest } = extra;
      e.push(mark({ key: k(type, ch, num), target: target || `${P}.${suffix}`, ...rest, ...(ledKey != null ? { ledKey: k('note', ch, ledKey) } : {}) }, suffix?.startsWith('ctlPadMode.') ? 'silkscreen' : 'chart'));
    }
    // TEMPO: 14-bit, 0x00 at the "−" end, 0x7F/0x7F at the "+" end (same with SHIFT)
    e.push(mark({ key: k('cc', ch, 0x00), lsbKey: k('cc', ch, 0x20), target: `${P}.tempo` }));
    for (const [type, num, suffix, lsb] of MIXER_CONTROLS) e.push(mark({ key: k(type, ch, num), ...(lsb ? { lsbKey: k(type, ch, lsb) } : {}), target: `${M}.${suffix}` }));
    // SHIFT + headphone cue: ◀ FX SELECT (CH 1) / FX SELECT ▶ (CH 2); its LED answers on 0x39
    e.push(mark({ key: k('note', ch, 0x08), target: deck === 1 ? 'mixer.colorFx.prev' : 'mixer.colorFx.next', ledKey: k('note', ch, 0x39) }));
    // CFX knob: channel 7, CC 0x17 / 0x18, LSB 0x37 / 0x38
    e.push(mark({ key: k('cc', 6, 0x16 + deck), lsbKey: k('cc', 6, 0x36 + deck), target: `${M}.filter` }));
    // performance pads: 4 banks x 8 pads x (normal, SHIFT)
    const [padCh, padShiftCh] = FLX2_PAD_CH[deck];
    for (const [bank, base] of Object.entries(FLX2_PAD_BANKS)) {
      for (let p = 0; p < 8; p++) {
        e.push(mark({ key: k('note', padCh, base + p), target: PAD_TARGETS[bank][0](P, p + 1) }));
        e.push(mark({ key: k('note', padShiftCh, base + p), target: PAD_TARGETS[bank][1](P, p + 1) }));
      }
    }
  }
  // global section (channel 7 = index 6)
  e.push(
    mark({ key: k('cc', 6, 0x1f), lsbKey: k('cc', 6, 0x3f), target: 'mixer.crossfader' }),
    mark({ key: k('cc', 6, 0x08), lsbKey: k('cc', 6, 0x28), target: 'master.volume' }), // MASTER LEVEL
    mark({ key: k('cc', 6, 0x0d), lsbKey: k('cc', 6, 0x2d), target: 'master.hpVolume' }), // HEADPHONES LEVEL
    mark({ key: k('note', 6, 0x63), target: 'master.cue' }), // HEADPHONE CUE (MASTER)
    mark({ key: k('note', 6, 0x00), target: 'smart.cfx' }), // SHIFT + HEADPHONE CUE (MASTER): SMART CFX
    mark({ key: k('note', 6, 0x01), target: 'smart.fader' }), // SMART FADER
    mark({ key: k('note', 6, 0x09), target: 'smart.faderAuto' }), // SHIFT + SMART FADER
  );
  return e;
}

export const FLX2_PRESET = {
  id: FLX2_ID,
  version: 3, // stored copies of an older version are refreshed on connect (midi.js bind)
  name: FLX2_NAME,
  match: FLX2_MATCH,
  entries: entries(),
  // output-only messages from the chart: track-loaded LEDs (channel 16) and vinyl mode on/off (set by the app)
  outputsExtra: [
    { state: 'deck1.loaded', status: 0x9f, midino: 0x00, on: 0x7f, off: 0x00 },
    { state: 'deck2.loaded', status: 0x9f, midino: 0x01, on: 0x7f, off: 0x00 },
    { state: 'deck1.ctlVinyl', status: 0x90, midino: 0x17, on: 0x7f, off: 0x00 },
    { state: 'deck2.ctlVinyl', status: 0x91, midino: 0x17, on: 0x7f, off: 0x00 },
  ],
  licence: 'CC0-1.0',
  provenance: {
    method: 'chart',
    chart: 'https://assets.pioneerdjhub.com/DDJ-FLX2_MIDI_Message_List_E1.pdf',
    chartTitle: 'DDJ-FLX2 List of MIDI Messages (E1)',
    testedOnHardware: false,
    date: '2026-11-21',
  },
  // jog: 0x40 ± ticks since the last message, clockwise positive (chart). Ticks per revolution are not in the chart:
  // OpenDJ's default (≈ 720 per turn) is used until a capture from the unit measures it (Controller test → jog).
  jog: { ticksPerRev: 720, direction: 1, ticksVerified: false },
  // the unit has its own USB audio (MASTER and PHONES 3.5 mm jacks, class compliant, bus powered); the channel layout
  // (master 1-2, headphones 3-4) is not in the chart
  audio: { builtIn: true, master: [1, 2], cue: [3, 4], deviceLabel: FLX2_MATCH, unverifiedChannels: true },
  init: [], // the chart lists no SysEx, init or keep-alive
};
