// First-party OpenDJ mapping for a compact 2-channel controller: the AlphaTheta DDJ-FLX2.
// Mapping data: CC0-1.0. Written for OpenDJ from facts about which MIDI message each control sends. NOT derived from
// Mixxx (or any other app's) mapping files or scripts.
//
// Provenance (see docs/CONTROLLER_SUPPORT_PLAN.md §3):
//  - The manufacturer's "DDJ-FLX2 MIDI Message List" (DDJ-FLX2_MIDI_Message_List_E1.pdf, linked from AlphaTheta
//    support and hosted at https://assets.pioneerdjhub.com/DDJ-FLX2_MIDI_Message_List_E1.pdf) could not be downloaded
//    from the build sandbox (its hosts did not resolve). The values marked `verified: 'chart-cited'` were checked
//    against an independent open-source app (hacha/wavenerd PR #21) that quotes that chart for each number.
//  - Values without that mark follow the message layout of the same family's published chart (DDJ-FLX4 "List of MIDI
//    messages": PLAY = note 0x0B on channel 1/2, CUE 0x0C, 14-bit CC pairs with the LSB at CC+0x20) and are
//    UNVERIFIED on a real FLX2. Settings → Controllers → "Controller test" shows which of them have been seen, and a
//    capture from the owner's unit fixes any that are wrong.
//
// MIDI channels below are 0-based (status 0x90 = channel 0 = "MIDI channel 1" in the chart).
const k = (type, ch, num) => `${type}:${ch}:${num}`;

export const FLX2_ID = 'opendj-flx2';
export const FLX2_NAME = 'AlphaTheta DDJ-FLX2 (OpenDJ first-party)';
/** Port names the unit shows up as on Windows / macOS / Linux ("DDJ-FLX2", "DDJ-FLX2 MIDI 1", "DDJ FLX2 …"). */
export const FLX2_MATCH = /DDJ[-_ ]?FLX2/i;

/** Pad banks: note of pad 1 for each pad mode, pads 2-8 follow (chart-cited: 0x00, 0x10, 0x60, 0x30). */
export const FLX2_PAD_BANKS = { hotcue: 0x00, padfx: 0x10, loop: 0x60, sampler: 0x30 };
/** Pad channels per deck: normal / with SHIFT held (chart-cited: 7/8 deck 1, 9/10 deck 2). */
export const FLX2_PAD_CH = { 1: [7, 8], 2: [9, 10] };

// Per-deck controls on the deck's own channel (deck 1 = 0, deck 2 = 1).
const DECK_CONTROLS = [
  // [type, number, target suffix, extra, verified]
  ['note', 0x0b, 'play', {}, false], // PLAY/PAUSE
  ['note', 0x0c, 'cue', {}, false], // CUE
  ['note', 0x47, 'ctlStutter', {}, false], // SHIFT + PLAY/PAUSE: stutter from the cue
  ['note', 0x48, 'ctlToStart', {}, false], // SHIFT + CUE: back to the start of the track
  ['note', 0x58, 'sync', {}, false], // BEAT SYNC (SHIFT handled by the target: set as master)
  ['note', 0x5c, 'ctlPadModeNext', {}, false], // SHIFT + BEAT SYNC = PAD MODE (silkscreen under BEAT SYNC)
  ['note', 0x36, 'jogTouch', { noLed: true }, false], // jog top touch
  ['note', 0x67, 'jogTouch', { noLed: true }, false], // jog top touch with SHIFT held
  ['cc', 0x22, 'jog', { rel: 'offset' }, 'chart-cited'], // jog top, turned while touched (scratch / vinyl)
  ['cc', 0x23, 'jogRing', { rel: 'offset' }, 'chart-cited'], // jog top, turned untouched (vinyl off): nudge
  ['cc', 0x21, 'jogRing', { rel: 'offset' }, 'chart-cited'], // jog outer ring: nudge
  ['cc', 0x29, 'jogSearch', { rel: 'offset' }, 'chart-cited'], // SHIFT + jog: fast search
  ['note', 0x3f, null, { target: 'global.shift', noLed: true }, 'chart-cited'], // SHIFT
  ['note', 0x1b, 'ctlPadMode.hotcue', {}, false], // pad mode buttons
  ['note', 0x1e, 'ctlPadMode.padfx', {}, false],
  ['note', 0x6d, 'ctlPadMode.loop', {}, false],
  ['note', 0x22, 'ctlPadMode.sampler', {}, false],
  ['note', 0x28, 'ctlSearchBack', {}, false], // SEARCH ◀ (under the jog)
  ['note', 0x29, 'ctlSearchFwd', {}, false], // SEARCH ▶
];

/** Chart-cited mixer controls: [type, number, target suffix(es), lsb?] on the deck channel. */
const MIXER_CONTROLS = [
  ['cc', 0x07, 'eqHigh', 0x27, 'chart-cited'], ['cc', 0x0b, 'eqMid', 0x2b, 'chart-cited'], ['cc', 0x0f, 'eqLow', 0x2f, 'chart-cited'],
  ['cc', 0x13, 'volume', 0x33, 'chart-cited'], ['note', 0x54, 'cue', null, 'chart-cited'],
];

// Pad actions per bank, normal and SHIFT layers.
const PAD_TARGETS = {
  hotcue: [(P, p) => `${P}.hotcue${p}`, (P, p) => `${P}.hotcueClear${p}`],
  padfx: [(P, p) => `${P}.padFx${p}`, (P, p) => `${P}.roll${p}`],
  loop: [(P, p) => `${P}.loopPad${p}`, (P, p) => `${P}.beatjump${p}`],
  sampler: [(P, p) => `${P}.sampler${p}`, (P, p) => `${P}.samplerStop${p}`],
};

function entries() {
  const e = [];
  const mark = (entry, verified) => (verified ? { ...entry, verified } : { ...entry, unverified: true });
  for (const [deck, ch] of [[1, 0], [2, 1]]) {
    const P = `deck${deck}`, M = `mixer${deck}`;
    for (const [type, num, suffix, extra, ver] of DECK_CONTROLS) {
      const target = extra.target || `${P}.${suffix}`;
      const { target: _t, ...rest } = extra;
      e.push(mark({ key: k(type, ch, num), target, ...rest }, ver));
    }
    // TEMPO: 14-bit, minus at the top like the other units of the family (inverted)
    e.push(mark({ key: k('cc', ch, 0x00), lsbKey: k('cc', ch, 0x20), target: `${P}.tempo`, invert: true }, false));
    for (const [type, num, suffix, lsb, ver] of MIXER_CONTROLS) e.push(mark({ key: k(type, ch, num), ...(lsb ? { lsbKey: k(type, ch, lsb) } : {}), target: `${M}.${suffix}` }, ver));
    // CFX knob (chart-cited: CC 0x17 / 0x18 on channel 7, 14-bit LSB at +0x20 unverified)
    e.push(mark({ key: k('cc', 6, 0x16 + deck), lsbKey: k('cc', 6, 0x36 + deck), target: `${M}.filter` }, 'chart-cited'));
    // performance pads: 4 banks x 8 pads x (normal, SHIFT)
    const [padCh, padShiftCh] = FLX2_PAD_CH[deck];
    for (const [bank, base] of Object.entries(FLX2_PAD_BANKS)) {
      for (let p = 0; p < 8; p++) {
        e.push(mark({ key: k('note', padCh, base + p), target: PAD_TARGETS[bank][0](P, p + 1) }, 'chart-cited'));
        e.push(mark({ key: k('note', padShiftCh, base + p), target: PAD_TARGETS[bank][1](P, p + 1) }, 'chart-cited'));
      }
    }
  }
  // global section (channel 7 = index 6)
  e.push(
    mark({ key: k('cc', 6, 0x1f), lsbKey: k('cc', 6, 0x3f), target: 'mixer.crossfader' }, 'chart-cited'),
    mark({ key: k('cc', 6, 0x08), lsbKey: k('cc', 6, 0x28), target: 'master.volume' }, 'chart-cited'),
    mark({ key: k('note', 6, 0x63), target: 'master.cue' }, false), // MASTER (headphone cue)
    mark({ key: k('note', 6, 0x01), target: 'smart.fader' }, false), // SMART FADER
    mark({ key: k('note', 6, 0x02), target: 'smart.faderAuto' }, false), // SHIFT + SMART FADER
    mark({ key: k('note', 6, 0x03), target: 'smart.cfx' }, false), // SMART CFX
    mark({ key: k('note', 6, 0x04), target: 'smart.cfxPrev' }, false), // ◀ FX SELECT
    mark({ key: k('note', 6, 0x05), target: 'smart.cfxNext' }, false), // FX SELECT ▶
  );
  return e;
}

export const FLX2_PRESET = {
  id: FLX2_ID,
  name: FLX2_NAME,
  match: FLX2_MATCH,
  entries: entries(),
  licence: 'CC0-1.0',
  provenance: {
    method: 'chart (partial, cited) + family chart',
    chart: 'https://assets.pioneerdjhub.com/DDJ-FLX2_MIDI_Message_List_E1.pdf',
    crossCheck: 'https://github.com/hacha/wavenerd/pull/21',
    testedOnHardware: false,
    date: '2026-11-21',
  },
  // jog: the platter sends 0x40 + ticks since the last message. Ticks per revolution are not in the cited facts:
  // OpenDJ's default (≈720 per turn) is used until a capture from the unit measures it (Controller test → jog).
  jog: { ticksPerRev: 720, direction: 1 },
  // the unit has its own USB audio (MASTER and PHONES 3.5 mm jacks, class compliant, bus powered)
  audio: { builtIn: true, master: [1, 2], cue: [3, 4], deviceLabel: FLX2_MATCH, unverifiedChannels: true },
  // no init or keep-alive is documented in the facts we could check: none is sent (no SysEx permission is requested)
  init: [],
  skin: 'compact-controller',
};
