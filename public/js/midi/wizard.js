// Guided mapping: the core controls in a fixed order, plus detection of what kind of MIDI message a control sends.

/** Steps for the guided setup. Each: { target, kind, title, hint, section } */
export function wizardSteps(deckCount = 2) {
  const S = [];
  const add = (target, kind, title, hint, section) => S.push({ target, kind, title, hint, section });
  const side = (n) => (deckCount > 2 ? `deck ${n}` : n === 1 ? 'left deck' : 'right deck');
  for (let n = 1; n <= Math.min(deckCount, 4); n++) {
    const P = `deck${n}`, sec = `Deck ${n}`;
    add(`${P}.play`, 'button', 'Play / Pause', `Press PLAY on the ${side(n)}.`, sec);
    add(`${P}.cue`, 'button', 'Cue', `Press CUE on the ${side(n)}.`, sec);
    add(`${P}.sync`, 'button', 'Sync', `Press SYNC on the ${side(n)}.`, sec);
    add(`${P}.jogTouch`, 'button', 'Jog wheel touch', `Touch the top of the ${side(n)} jog wheel (and let go). Skip if it has no touch sensor.`, sec);
    add(`${P}.jog`, 'rel', 'Jog wheel', `Spin the ${side(n)} jog wheel a little, in either direction.`, sec);
    add(`${P}.tempo`, 'abs', 'Tempo fader', `Move the ${side(n)} tempo (pitch) fader from one end to the other.`, sec);
    for (let p = 1; p <= 8; p++) add(`${P}.pad${p}`, 'button', `Performance pad ${p}`, `Press pad ${p} on the ${side(n)} (top row left to right, then bottom row).`, sec);
  }
  for (let n = 1; n <= Math.min(deckCount, 4); n++) {
    const M = `mixer${n}`, sec = 'Mixer';
    add(`${M}.volume`, 'abs', `Channel ${n} fader`, `Move the channel ${n} volume fader up and down.`, sec);
    add(`${M}.eqHigh`, 'abs', `Channel ${n} EQ high`, `Turn the channel ${n} HIGH (treble) EQ knob.`, sec);
    add(`${M}.eqMid`, 'abs', `Channel ${n} EQ mid`, `Turn the channel ${n} MID EQ knob.`, sec);
    add(`${M}.eqLow`, 'abs', `Channel ${n} EQ low`, `Turn the channel ${n} LOW (bass) EQ knob.`, sec);
    add(`${M}.filter`, 'abs', `Channel ${n} filter`, `Turn the channel ${n} FILTER (or Color FX) knob.`, sec);
  }
  add('mixer.crossfader', 'abs', 'Crossfader', 'Move the crossfader from side to side.', 'Mixer');
  add('browser.scroll', 'rel', 'Browse encoder', 'Turn the BROWSE / track select knob a few clicks.', 'Browser');
  for (let n = 1; n <= Math.min(deckCount, 4); n++) add(`deck${n}.load`, 'button', `Load deck ${n}`, `Press the LOAD button for deck ${n}.`, 'Browser');
  add('global.shift', 'button', 'Shift', 'Press SHIFT (any one).', 'Global');
  return S;
}

/**
 * Decide how a run of CC (or pitch-bend) values should be read.
 * Returns { kind: 'abs' } or { kind: 'rel', rel: 'twos'|'offset'|'wrap' }.
 * Relative encoders repeat the same few values (1/127 or 63/65); faders and knobs sweep through many values.
 */
export function classifyCcValues(values, expected = null) {
  const v = values.filter((x) => x != null);
  if (!v.length) return { kind: expected === 'rel' ? 'rel' : 'abs', ...(expected === 'rel' ? { rel: 'offset' } : {}) };
  let repeats = 0;
  for (let i = 1; i < v.length; i++) if (v[i] === v[i - 1]) repeats++;
  const distinct = new Set(v).size;
  const twosLike = v.every((x) => (x >= 1 && x <= 20) || (x >= 108 && x <= 127));
  const offsetLike = v.every((x) => Math.abs(x - 64) <= 20) && !v.every((x) => x === 64);
  const encoderish = repeats > 0 || distinct <= 3;
  // a position counter that wraps 127 → 0 (or back): steady one-way movement with one big jump
  const steps = [];
  for (let i = 1; i < v.length; i++) { let d = v[i] - v[i - 1]; if (d > 64) d -= 128; if (d < -64) d += 128; steps.push(d); }
  const jumps = v.some((x, i) => i && Math.abs(x - v[i - 1]) > 64);
  if (jumps && distinct >= 4 && (steps.every((d) => d > 0) || steps.every((d) => d < 0))) return { kind: 'rel', rel: 'wrap' };
  if (twosLike && (encoderish || expected === 'rel')) return { kind: 'rel', rel: 'twos' };
  if (offsetLike && (encoderish || expected === 'rel')) return { kind: 'rel', rel: 'offset' };
  if (expected === 'rel') {
    return { kind: 'rel', rel: v.some((x) => x > 64) && v.some((x) => x < 64) && v.every((x) => Math.abs(x - 64) <= 40) ? 'offset' : 'twos' };
  }
  return { kind: 'abs' };
}

/**
 * Work out which control the user moved from the MIDI messages captured during one wizard step.
 * msgs: [{ key, type: 'note'|'cc'|'pitch', channel, number, value, isOff }]
 * opts.kind: what the step expects ('button'|'abs'|'rel'); opts.exclude: keys already assigned in this run.
 * Returns { key, lsbKey?, kind, rel?, type } or null.
 */
export function detectMidiControl(msgs, { kind = null, exclude = new Set() } = {}) {
  const usable = msgs.filter((m) => !exclude.has(m.key));
  if (!usable.length) return null;
  const by = new Map();
  for (const m of usable) { if (!by.has(m.key)) by.set(m.key, []); by.get(m.key).push(m); }
  const notes = [...by.keys()].filter((k) => k.startsWith('note:') && by.get(k).some((m) => !m.isOff));
  const ctls = [...by.keys()].filter((k) => !k.startsWith('note:'));

  if (kind === 'button' || (!kind && notes.length && !ctls.length)) {
    if (notes.length) return { key: notes[0], kind: 'button', type: 'note' };
    // CC buttons (127 on press, 0 on release)
    const cc = ctls.find((k) => by.get(k).some((m) => m.value > 0)) || ctls[0];
    return cc ? { key: cc, kind: 'button', type: by.get(cc)[0].type } : null;
  }
  if (!ctls.length) return notes.length ? { key: notes[0], kind: 'button', type: 'note' } : null;

  // pitch bend is already 14-bit
  const pitch = ctls.find((k) => k.startsWith('pitch:'));
  if (pitch && kind !== 'rel') return { key: pitch, kind: 'abs', type: 'pitch' };

  // 14-bit: MSB on CC n (0–31) and LSB on CC n+32, arriving together
  const ccNum = (k) => +k.split(':')[2], ccCh = (k) => +k.split(':')[1];
  const lsbOf = (k) => ctls.find((x) => x.startsWith('cc:') && ccCh(x) === ccCh(k) && ccNum(x) === ccNum(k) + 32);
  // choose the busiest controller, preferring an MSB over its LSB
  const ranked = ctls.slice().sort((a, b) => by.get(b).length - by.get(a).length);
  let main = ranked[0];
  const msbOfMain = ctls.find((x) => lsbOf(x) === main);
  if (msbOfMain) main = msbOfMain;
  const lsb = main.startsWith('cc:') && ccNum(main) < 32 ? lsbOf(main) : null;
  const values = by.get(main).map((m) => m.value);
  if (lsb && kind !== 'rel') return { key: main, lsbKey: lsb, kind: 'abs', type: 'cc' };
  const c = classifyCcValues(values, kind);
  return { key: main, kind: c.kind, ...(c.rel ? { rel: c.rel } : {}), type: by.get(main)[0].type };
}

/** Build the mapping entry for a detected control and the step's target. */
export function entryFor(det, step) {
  const e = { key: det.key, target: step.target };
  if (det.lsbKey) e.lsbKey = det.lsbKey;
  if (step.kind === 'rel') e.rel = det.rel || 'offset';
  else if (step.kind === 'abs' && det.kind === 'rel') e.rel = det.rel; // endless knob driving a fader target
  return e;
}
