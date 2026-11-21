// Built-in controller presets. These are best-effort community mappings: if a control doesn't respond,
// use MIDI Learn in Settings → Controllers to fix it, then export and share the mapping.
import { FLX2_PRESET } from './mappings/ddj-flx2.js';

const k = (type, ch, num) => `${type}:${ch}:${num}`;

function pioneerDdj400() {
  const e = [];
  for (const [deck, ch] of [[1, 0], [2, 1]]) {
    const P = `deck${deck}`, M = `mixer${deck}`;
    e.push(
      { key: k('note', ch, 0x0b), target: `${P}.play` },
      { key: k('note', ch, 0x0c), target: `${P}.cue` },
      { key: k('note', ch, 0x58), target: `${P}.sync` },
      { key: k('note', ch, 0x36), target: `${P}.jogTouch`, noLed: true },
      { key: k('cc', ch, 0x22), target: `${P}.jog`, rel: 'offset' },
      { key: k('cc', ch, 0x21), target: `${P}.jogRing`, rel: 'offset' },
      { key: k('cc', ch, 0x23), target: `${P}.jogSearch`, rel: 'offset' },
      { key: k('cc', ch, 0x00), lsbKey: k('cc', ch, 0x20), target: `${P}.tempo`, invert: true },
      { key: k('note', ch, 0x10), target: `${P}.loopIn` },
      { key: k('note', ch, 0x11), target: `${P}.loopOut` },
      { key: k('note', ch, 0x4d), target: `${P}.reloop` },
      { key: k('note', ch, 0x54), target: `${M}.cue` },
      { key: k('cc', ch, 0x04), lsbKey: k('cc', ch, 0x24), target: `${M}.trim` },
      { key: k('cc', ch, 0x07), lsbKey: k('cc', ch, 0x27), target: `${M}.eqHigh` },
      { key: k('cc', ch, 0x0b), lsbKey: k('cc', ch, 0x2b), target: `${M}.eqMid` },
      { key: k('cc', ch, 0x0f), lsbKey: k('cc', ch, 0x2f), target: `${M}.eqLow` },
      { key: k('cc', ch, 0x13), lsbKey: k('cc', ch, 0x33), target: `${M}.volume` },
      { key: k('cc', 6, 0x16 + deck), lsbKey: k('cc', 6, 0x36 + deck), target: `${M}.filter` },
      { key: k('note', 6, 0x45 + deck), target: `${P}.load` },
    );
    const padCh = deck === 1 ? 7 : 9;
    for (let p = 0; p < 8; p++) {
      e.push({ key: k('note', padCh, 0x00 + p), target: `${P}.hotcue${p + 1}` });
      e.push({ key: k('note', padCh, 0x60 + p), target: `${P}.roll${p + 1}` });
      e.push({ key: k('note', padCh, 0x20 + p), target: `${P}.beatjump${p + 1}` });
      e.push({ key: k('note', padCh, 0x30 + p), target: `${P}.sampler${p + 1}` });
    }
  }
  e.push(
    { key: k('cc', 6, 0x1f), lsbKey: k('cc', 6, 0x3f), target: 'mixer.crossfader' },
    { key: k('cc', 6, 0x40), target: 'browser.scroll', rel: 'twos' },
    { key: k('note', 0, 0x3f), target: 'global.shift', noLed: true },
    { key: k('note', 1, 0x3f), target: 'global.shift', noLed: true },
  );
  return e;
}

/** Generic layout used by many small 2-deck controllers that let you pick a "generic MIDI" mode. */
function genericTwoDeck() {
  const e = [];
  for (const [deck, ch] of [[1, 0], [2, 1]]) {
    const P = `deck${deck}`, M = `mixer${deck}`;
    e.push(
      { key: k('note', ch, 0x01), target: `${P}.play` }, { key: k('note', ch, 0x02), target: `${P}.cue` },
      { key: k('note', ch, 0x03), target: `${P}.sync` }, { key: k('cc', ch, 0x01), target: `${M}.volume` },
      { key: k('cc', ch, 0x02), target: `${M}.eqHigh` }, { key: k('cc', ch, 0x03), target: `${M}.eqMid` },
      { key: k('cc', ch, 0x04), target: `${M}.eqLow` }, { key: k('cc', ch, 0x05), target: `${M}.filter` },
      { key: k('cc', ch, 0x06), target: `${P}.tempo` }, { key: k('cc', ch, 0x07), target: `${P}.jog`, rel: 'offset' },
    );
  }
  e.push({ key: k('cc', 2, 0x01), target: 'mixer.crossfader' });
  return e;
}

export const PRESETS = [
  FLX2_PRESET, // first-party, CC0 (mappings/ddj-flx2.js)
  { name: 'Pioneer DDJ-400 / DDJ-FLX4 (best-effort)', match: /DDJ-?(400|FLX4)/i, entries: pioneerDdj400() },
  { name: 'Generic 2-deck (OpenDJ layout)', match: /^$/, entries: genericTwoDeck() },
];
