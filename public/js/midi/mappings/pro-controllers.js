// Bundled first-party / standard MIDI mappings for popular working-DJ controllers.
// Covers Pioneer/AlphaTheta (DDJ-FLX6, DDJ-FLX10, DDJ-1000/800, DDJ-SB3/REV1), Numark (Mixtrack Platinum/Pro FX,
// Party Mix), Hercules (DJControl Inpulse 500/300), Denon DJ (MC4000), and Reloop (Buddy/Ready).

const k = (type, ch, num) => `${type}:${ch}:${num}`;

/** Pioneer 4-deck layout (DDJ-1000, DDJ-800, DDJ-FLX6, DDJ-FLX10): channels 0..3 -> decks 1..4, channel 6 -> mixer/browse. */
function pioneerFourDeck({ stems = false } = {}) {
  const e = [];
  for (let i = 0; i < 4; i++) {
    const deck = i + 1, ch = i, P = `deck${deck}`, M = `mixer${deck}`;
    e.push(
      { key: k('note', ch, 0x0b), target: `${P}.play` },
      { key: k('note', ch, 0x0c), target: `${P}.cue` },
      { key: k('note', ch, 0x58), target: `${P}.sync` },
      { key: k('note', ch, 0x1a), target: `${P}.keyLock` },
      { key: k('note', ch, 0x36), target: `${P}.jogTouch`, noLed: true },
      { key: k('cc', ch, 0x22), target: `${P}.jog`, rel: 'offset' },
      { key: k('cc', ch, 0x21), target: `${P}.jogRing`, rel: 'offset' },
      { key: k('cc', ch, 0x00), lsbKey: k('cc', ch, 0x20), target: `${P}.tempo`, invert: true },
      { key: k('note', ch, 0x10), target: `${P}.loopIn` },
      { key: k('note', ch, 0x11), target: `${P}.loopOut` },
      { key: k('note', ch, 0x4d), target: `${P}.reloop` },
      { key: k('note', ch, 0x12), target: `${P}.loopHalve` },
      { key: k('note', ch, 0x13), target: `${P}.loopDouble` },
      { key: k('note', ch, 0x54), target: `${M}.cue` },
      { key: k('cc', ch, 0x04), lsbKey: k('cc', ch, 0x24), target: `${M}.trim` },
      { key: k('cc', ch, 0x07), lsbKey: k('cc', ch, 0x27), target: `${M}.eqHigh` },
      { key: k('cc', ch, 0x0b), lsbKey: k('cc', ch, 0x2b), target: `${M}.eqMid` },
      { key: k('cc', ch, 0x0f), lsbKey: k('cc', ch, 0x2f), target: `${M}.eqLow` },
      { key: k('cc', ch, 0x13), lsbKey: k('cc', ch, 0x33), target: `${M}.volume` },
      { key: k('cc', 6, 0x17 + i), lsbKey: k('cc', 6, 0x37 + i), target: `${M}.filter` },
      { key: k('note', 6, 0x46 + i), target: `${P}.load` },
      { key: k('note', ch, 0x3f), target: 'global.shift', noLed: true },
    );
    const padCh = [7, 9, 11, 13][i];
    for (let p = 0; p < 8; p++) {
      e.push({ key: k('note', padCh, 0x00 + p), target: `${P}.hotcue${p + 1}` });
      e.push({ key: k('note', padCh, 0x20 + p), target: `${P}.beatjump${p + 1}` });
      e.push({ key: k('note', padCh, 0x30 + p), target: `${P}.sampler${p + 1}` });
      e.push({ key: k('note', padCh, 0x60 + p), target: `${P}.roll${p + 1}` });
    }
    if (stems) {
      e.push(
        { key: k('note', ch, 0x68), target: `${P}.stemVocals` },
        { key: k('note', ch, 0x69), target: `${P}.stemDrums` },
        { key: k('note', ch, 0x6a), target: `${P}.stemBass` },
        { key: k('note', ch, 0x6b), target: `${P}.stemOther` },
      );
    }
  }
  e.push(
    { key: k('cc', 6, 0x1f), lsbKey: k('cc', 6, 0x3f), target: 'mixer.crossfader' },
    { key: k('cc', 6, 0x40), target: 'browser.scroll', rel: 'twos' },
    { key: k('cc', 6, 0x08), target: 'mixer.masterVolume' },
    { key: k('cc', 6, 0x0c), target: 'mixer.cueMix' },
    { key: k('cc', 6, 0x0d), target: 'mixer.hpVolume' },
  );
  return e;
}

/** Pioneer 2-deck Serato-style layout (DDJ-SB3, DDJ-REV1). */
function pioneerSerato2Deck() {
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
      { key: k('cc', ch, 0x00), lsbKey: k('cc', ch, 0x20), target: `${P}.tempo`, invert: true },
      { key: k('note', ch, 0x54), target: `${M}.cue` },
      { key: k('cc', ch, 0x04), target: `${M}.trim` },
      { key: k('cc', ch, 0x07), target: `${M}.eqHigh` },
      { key: k('cc', ch, 0x0b), target: `${M}.eqMid` },
      { key: k('cc', ch, 0x0f), target: `${M}.eqLow` },
      { key: k('cc', ch, 0x13), target: `${M}.volume` },
      { key: k('cc', 6, 0x16 + deck), target: `${M}.filter` },
      { key: k('note', 6, 0x45 + deck), target: `${P}.load` },
      { key: k('note', ch, 0x3f), target: 'global.shift', noLed: true },
    );
    const padCh = deck === 1 ? 7 : 9;
    for (let p = 0; p < 8; p++) e.push({ key: k('note', padCh, 0x00 + p), target: `${P}.hotcue${p + 1}` });
  }
  e.push({ key: k('cc', 6, 0x1f), target: 'mixer.crossfader' }, { key: k('cc', 6, 0x40), target: 'browser.scroll', rel: 'twos' });
  return e;
}

/** Numark Mixtrack Platinum FX / Mixtrack Pro FX / Party Mix MIDI chart. */
function numarkMixtrackFx() {
  const e = [];
  for (const [deck, ch] of [[1, 0], [2, 1]]) {
    const P = `deck${deck}`, M = `mixer${deck}`;
    e.push(
      { key: k('note', ch, 0x00), target: `${P}.play` },
      { key: k('note', ch, 0x01), target: `${P}.cue` },
      { key: k('note', ch, 0x02), target: `${P}.sync` },
      { key: k('note', ch, 0x06), target: `${P}.jogTouch`, noLed: true },
      { key: k('cc', ch, 0x06), target: `${P}.jog`, rel: 'twos' },
      { key: k('cc', ch, 0x09), lsbKey: k('cc', ch, 0x29), target: `${P}.tempo`, invert: true },
      { key: k('note', ch, 0x1b), target: `${M}.cue` },
      { key: k('cc', ch, 0x1c), target: `${M}.volume` },
      { key: k('cc', ch, 0x17), target: `${M}.eqHigh` },
      { key: k('cc', ch, 0x18), target: `${M}.eqMid` },
      { key: k('cc', ch, 0x19), target: `${M}.eqLow` },
      { key: k('cc', ch, 0x1a), target: `${M}.filter` },
      { key: k('note', 15, deck === 1 ? 0x02 : 0x03), target: `${P}.load` },
      { key: k('note', ch, 0x20), target: 'global.shift', noLed: true },
    );
    const padCh = deck === 1 ? 4 : 5;
    for (let p = 0; p < 8; p++) {
      e.push({ key: k('note', padCh, 0x14 + p), target: `${P}.hotcue${p + 1}` });
      e.push({ key: k('note', padCh, 0x20 + p), target: `${P}.sampler${p + 1}` });
    }
  }
  e.push(
    { key: k('cc', 15, 0x08), target: 'mixer.crossfader' },
    { key: k('cc', 15, 0x00), target: 'browser.scroll', rel: 'twos' },
    { key: k('cc', 15, 0x0a), target: 'mixer.masterVolume' },
    { key: k('cc', 15, 0x0b), target: 'mixer.cueMix' },
    { key: k('cc', 15, 0x0c), target: 'mixer.hpVolume' },
  );
  return e;
}

/** Hercules DJControl Inpulse 500 / 300 / 200 MIDI chart. */
function herculesInpulse() {
  const e = [];
  for (const [deck, ch] of [[1, 1], [2, 2]]) {
    const P = `deck${deck}`, M = `mixer${deck}`;
    e.push(
      { key: k('note', ch, 0x07), target: `${P}.play` },
      { key: k('note', ch, 0x06), target: `${P}.cue` },
      { key: k('note', ch, 0x05), target: `${P}.sync` },
      { key: k('note', ch, 0x08), target: `${P}.jogTouch`, noLed: true },
      { key: k('cc', ch, 0x0a), target: `${P}.jog`, rel: 'twos' },
      { key: k('cc', ch, 0x09), target: `${P}.jogRing`, rel: 'twos' },
      { key: k('cc', ch, 0x08), lsbKey: k('cc', ch, 0x28), target: `${P}.tempo`, invert: true },
      { key: k('note', ch, 0x0c), target: `${M}.cue` },
      { key: k('cc', ch, 0x00), target: `${M}.volume` },
      { key: k('cc', ch, 0x05), target: `${M}.trim` },
      { key: k('cc', ch, 0x04), target: `${M}.eqHigh` },
      { key: k('cc', ch, 0x03), target: `${M}.eqMid` },
      { key: k('cc', ch, 0x02), target: `${M}.eqLow` },
      { key: k('cc', ch, 0x01), target: `${M}.filter` },
      { key: k('note', ch, 0x0d), target: `${P}.load` },
      { key: k('note', ch, 0x04), target: 'global.shift', noLed: true },
    );
    const padCh = deck === 1 ? 6 : 7;
    for (let p = 0; p < 8; p++) e.push({ key: k('note', padCh, 0x00 + p), target: `${P}.hotcue${p + 1}` });
  }
  e.push(
    { key: k('cc', 0, 0x00), target: 'mixer.crossfader' },
    { key: k('cc', 0, 0x01), target: 'browser.scroll', rel: 'twos' },
    { key: k('cc', 0, 0x03), target: 'mixer.masterVolume' },
    { key: k('cc', 0, 0x04), target: 'mixer.hpVolume' },
    { key: k('cc', 0, 0x05), target: 'mixer.cueMix' },
  );
  return e;
}

/** Denon DJ MC4000 / MC6000MK2 / Reloop Buddy standard 2-deck mapping. */
function denonReloopTwoDeck() {
  const e = [];
  for (const [deck, ch] of [[1, 0], [2, 1]]) {
    const P = `deck${deck}`, M = `mixer${deck}`;
    e.push(
      { key: k('note', ch, 0x00), target: `${P}.play` },
      { key: k('note', ch, 0x01), target: `${P}.cue` },
      { key: k('note', ch, 0x02), target: `${P}.sync` },
      { key: k('note', ch, 0x10), target: `${P}.jogTouch`, noLed: true },
      { key: k('cc', ch, 0x08), target: `${P}.jog`, rel: 'twos' },
      { key: k('cc', ch, 0x00), lsbKey: k('cc', ch, 0x20), target: `${P}.tempo`, invert: true },
      { key: k('note', ch, 0x1b), target: `${M}.cue` },
      { key: k('cc', ch, 0x01), target: `${M}.trim` },
      { key: k('cc', ch, 0x02), target: `${M}.eqHigh` },
      { key: k('cc', ch, 0x03), target: `${M}.eqMid` },
      { key: k('cc', ch, 0x04), target: `${M}.eqLow` },
      { key: k('cc', ch, 0x05), target: `${M}.filter` },
      { key: k('cc', ch, 0x06), target: `${M}.volume` },
    );
    for (let p = 0; p < 8; p++) e.push({ key: k('note', ch + 4, 0x00 + p), target: `${P}.hotcue${p + 1}` });
  }
  e.push({ key: k('cc', 0, 0x07), target: 'mixer.crossfader' }, { key: k('cc', 0, 0x09), target: 'browser.scroll', rel: 'twos' });
  return e;
}

export const PRO_CONTROLLER_PRESETS = [
  { name: 'AlphaTheta / Pioneer DDJ-FLX10 (4-deck + Stems)', match: /DDJ-?FLX10/i, entries: pioneerFourDeck({ stems: true }) },
  { name: 'Pioneer DDJ-1000 / DDJ-800 / DDJ-FLX6 (4-deck)', match: /DDJ-?(1000|800|FLX6)/i, entries: pioneerFourDeck({ stems: false }) },
  { name: 'Pioneer DDJ-SB3 / DDJ-REV1', match: /DDJ-?(SB[23]|REV1)/i, entries: pioneerSerato2Deck() },
  { name: 'Numark Mixtrack Platinum FX / Pro FX / Party Mix', match: /Mixtrack|Party ?Mix/i, entries: numarkMixtrackFx() },
  { name: 'Hercules DJControl Inpulse 500 / 300 / 200', match: /Inpulse ?(500|300|200)/i, entries: herculesInpulse() },
  { name: 'Denon DJ MC4000 / Reloop Buddy & Ready', match: /MC4000|Reloop ?(Buddy|Ready)/i, entries: denonReloopTwoDeck() },
];
