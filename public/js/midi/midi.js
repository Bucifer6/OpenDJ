// Controller support: Web MIDI input, MIDI-learn mappings, 14-bit faders, relative jog/encoders, LED feedback,
// MIDI clock out. HID (WebHID) and gamepads (Gamepad API) share the same mapping store and targets (see hid.js,
// gamepad.js). Mappings live in settings.midiMappings keyed by device: MIDI input name, `hid:VID:PID` or `gamepad:<id>`.
//
// Mapping object: { name, entries: [{ key, target, invert?, rel?, lsbKey?, noLed? }], outputs?: [{ state, status,
//   midino, on, off, min?, max? }], source?, importInfo? }
//  - rel: 'twos' (1 = +1, 127 = −1) | 'offset' (64 = 0) | 'wrap' (absolute counter that wraps) | 'auto' (detected on
//    the first message). A rel entry on an absolute target nudges the value instead of setting it (endless knobs).
//  - outputs: explicit LED messages (from Mixxx mappings). When present they replace the automatic per-entry LEDs.
import { Emitter, clamp } from '../util.js';
import { linkMidiTargets } from '../link/link.js';
import { lyricsMidiTargets } from '../lyrics/lyrics.js';
import { PRESETS } from './presets.js';
import { BEATLOOPS, BEATJUMPS, ROLLS, convertMixxx, toStoredMapping } from './mixxx.js';
import { HidManager, describeHidKey } from './hid.js';
import { GamepadManager, describeGamepadKey } from './gamepad.js';

const fmtBeats = (b) => (b < 1 ? `1/${Math.round(1 / b)}` : String(b));

/** All mappable functions. kind: button | abs (0..1) | rel (relative delta). led(): state for LEDs; get(): current 0..1 */
export function buildTargets(app) {
  const T = [];
  const add = (id, label, kind, handler, led, get) => T.push({ id, label, kind, handler, led, get });
  const eng = app.engine;
  for (let d = 0; d < 4; d++) {
    const deck = eng.decks[d], ch = eng.channels[d], n = d + 1;
    const P = `deck${n}`, M = `mixer${n}`;
    const bi = (k) => () => (ch.state[k] + 1) / 2; // bipolar state → 0..1
    add(`${P}.play`, `Deck ${n} Play/Pause`, 'button', (down) => down && (eng.resume(), deck.togglePlay()), () => deck.playing);
    add(`${P}.cue`, `Deck ${n} Cue`, 'button', (down) => (down ? deck.cueDown() : deck.cueUp()), () => deck.cuePreview || (!deck.playing && deck.track && Math.abs(deck.position - deck.cuePoint) < 0.02));
    add(`${P}.sync`, `Deck ${n} Sync`, 'button', (down) => down && (app.shift ? deck.setMaster() : deck.sync()), () => deck.syncOn);
    add(`${P}.master`, `Deck ${n} Set Master`, 'button', (down) => down && deck.setMaster(), () => deck.isMaster);
    add(`${P}.keylock`, `Deck ${n} Key Lock`, 'button', (down) => down && deck.setKeyLock(!deck.keyLock), () => deck.keyLock);
    add(`${P}.slip`, `Deck ${n} Slip`, 'button', (down) => down && deck.setSlip(!deck.slip), () => deck.slip);
    add(`${P}.quantize`, `Deck ${n} Quantize`, 'button', (down) => down && deck.setQuantize(!deck.quantize), () => deck.quantize);
    add(`${P}.censor`, `Deck ${n} Censor (hold)`, 'button', (down) => (down ? deck.censorOn() : deck.censorOff()));
    add(`${P}.reverse`, `Deck ${n} Reverse (hold)`, 'button', (down) => deck.setReverse(down), () => deck.reverse);
    add(`${P}.eject`, `Deck ${n} Eject`, 'button', (down) => down && deck.eject());
    add(`${P}.tempo`, `Deck ${n} Tempo fader`, 'abs', (v) => deck.setTempoFader(v * 2 - 1), null, () => (deck.tempo / deck.tempoRange + 1) / 2);
    add(`${P}.tempoReset`, `Deck ${n} Tempo reset`, 'button', (down) => down && deck.resetTempo());
    add(`${P}.tempoUp`, `Deck ${n} Tempo +0.5 %`, 'button', (down) => down && deck.setTempo(deck.tempo + 0.5));
    add(`${P}.tempoDown`, `Deck ${n} Tempo −0.5 %`, 'button', (down) => down && deck.setTempo(deck.tempo - 0.5));
    add(`${P}.bendUp`, `Deck ${n} Pitch bend +`, 'button', (down) => deck.setBend(down ? 0.04 : 0));
    add(`${P}.bendDown`, `Deck ${n} Pitch bend −`, 'button', (down) => deck.setBend(down ? -0.04 : 0));
    add(`${P}.jogTouch`, `Deck ${n} Jog touch`, 'button', (down) => { deck._jogTouched = down; if (!down) deck.jogRelease(); });
    add(`${P}.jog`, `Deck ${n} Jog platter (scratch when touched)`, 'rel', (delta) => {
      const now = performance.now(), dt = (now - (deck._jogT || now)) / 1000 || 0.01; deck._jogT = now;
      const rot = delta / 720; // ~720 ticks per revolution on most controllers
      if (deck._jogTouched && deck.vinylMode) deck.jogScratch(rot, Math.max(dt, 0.004)); else deck.jogNudge(rot * 3);
    });
    add(`${P}.jogRing`, `Deck ${n} Jog outer ring (nudge)`, 'rel', (delta) => deck.jogNudge(delta / 720 * 3));
    add(`${P}.jogSearch`, `Deck ${n} Jog search (fast seek)`, 'rel', (delta) => deck.seek(deck.position + delta * 0.1));
    add(`${P}.loopIn`, `Deck ${n} Loop in`, 'button', (down) => down && deck.loopInPress());
    add(`${P}.loopOut`, `Deck ${n} Loop out`, 'button', (down) => down && deck.loopOutPress());
    add(`${P}.reloop`, `Deck ${n} Reloop/Exit`, 'button', (down) => down && deck.reloop(), () => deck.loop?.active);
    add(`${P}.loop4`, `Deck ${n} Auto loop 4 beats`, 'button', (down) => down && deck.autoLoop(4), () => deck.loop?.active);
    add(`${P}.loopActivate`, `Deck ${n} Auto loop (last size)`, 'button', (down) => down && deck.autoLoop(deck._ctlLoopBeats || 4), () => deck.loop?.active);
    add(`${P}.loopHalve`, `Deck ${n} Loop ½`, 'button', (down) => down && deck.loopHalve());
    add(`${P}.loopDouble`, `Deck ${n} Loop ×2`, 'button', (down) => down && deck.loopDouble());
    for (const b of BEATLOOPS) add(`${P}.beatloop.${b}`, `Deck ${n} Auto loop ${fmtBeats(b)} beat${b > 1 ? 's' : ''}`, 'button', (down) => { if (down) { deck._ctlLoopBeats = b; deck.autoLoop(b); } }, () => deck.loop?.active && Math.abs(deck.loopBeats - b) < 1e-3);
    add(`${P}.jumpBack`, `Deck ${n} Beat jump −4`, 'button', (down) => down && deck.beatJump(-4));
    add(`${P}.jumpFwd`, `Deck ${n} Beat jump +4`, 'button', (down) => down && deck.beatJump(4));
    for (const b of BEATJUMPS) {
      add(`${P}.jumpBack.${b}`, `Deck ${n} Beat jump −${fmtBeats(b)}`, 'button', (down) => down && deck.beatJump(-b));
      add(`${P}.jumpFwd.${b}`, `Deck ${n} Beat jump +${fmtBeats(b)}`, 'button', (down) => down && deck.beatJump(b));
    }
    add(`${P}.load`, `Deck ${n} Load selected track`, 'button', (down) => down && app.library.loadSelected(d));
    for (let p = 0; p < 8; p++) {
      add(`${P}.pad${p + 1}`, `Deck ${n} Pad ${p + 1} (current pad mode)`, 'button', (down) => deck.padPress?.(p, down), () => !!deck.hotCue(p));
      add(`${P}.hotcue${p + 1}`, `Deck ${n} Hot cue ${String.fromCharCode(65 + p)}`, 'button', (down) => (down ? (app.shift ? deck.deleteHotCue(p) : deck.hotCueDown(p)) : deck.hotCueUp(p)), () => !!deck.hotCue(p));
      add(`${P}.hotcueClear${p + 1}`, `Deck ${n} Delete hot cue ${String.fromCharCode(65 + p)}`, 'button', (down) => down && deck.deleteHotCue(p), () => !!deck.hotCue(p));
      add(`${P}.roll${p + 1}`, `Deck ${n} Loop roll ${fmtBeats(ROLLS[p])}`, 'button', (down) => (down ? deck.rollOn(ROLLS[p]) : deck.rollOff()));
      add(`${P}.sampler${p + 1}`, `Sampler ${p + 1} (deck ${n} pads)`, 'button', (down) => down && eng.sampler.trigger(p), () => !!eng.sampler.slots?.[p]?.playing);
      add(`${P}.beatjump${p + 1}`, `Deck ${n} Beat jump pad ${p + 1}`, 'button', (down) => down && deck.beatJump([1, 2, 4, 8][p % 4] * (p < 4 ? -1 : 1)));
    }
    for (const m of ['hotcue', 'roll', 'jump', 'sampler', 'fx']) add(`${P}.padMode.${m}`, `Deck ${n} Pad mode: ${m}`, 'button', (down) => down && deck.padMode?.(m));
    add(`${P}.keySync`, `Deck ${n} Key sync`, 'button', (down) => down && (app.shift ? deck.setKeyShift(0) : deck.keySyncTo()), () => deck.keyShift !== 0);
    add(`${P}.keyUp`, `Deck ${n} Key +1 semitone`, 'button', (down) => down && deck.setKeyShift(deck.keyShift + 1));
    add(`${P}.keyDown`, `Deck ${n} Key −1 semitone`, 'button', (down) => down && deck.setKeyShift(deck.keyShift - 1));
    add(`${P}.keyReset`, `Deck ${n} Key reset`, 'button', (down) => down && deck.setKeyShift(0));
    add(`${P}.keyKnob`, `Deck ${n} Key knob (±12 semitones)`, 'abs', (v) => { const s = Math.round(v * 24 - 12); if (s !== deck.keyShift) deck.setKeyShift(s); }, null, () => ((deck.keyShift || 0) + 12) / 24);
    for (let p = 0; p < 8; p++) add(`${P}.slice${p + 1}`, `Deck ${n} Slicer pad ${p + 1}`, 'button', (down) => (down ? deck.sliceDown(p) : deck.sliceUp()));
    add(`${P}.instantDouble`, `Deck ${n} Instant double from other deck`, 'button', (down) => down && deck.cloneFrom(eng.decks[d % 2 === 0 ? d + 1 : d - 1]));
    add(`${M}.vocal`, `Channel ${n} Vocal level (quick stems)`, 'abs', (v) => ch.set('vocal', v), null, () => ch.state.vocal);
    add(`${M}.inst`, `Channel ${n} Instrumental level (quick stems)`, 'abs', (v) => ch.set('inst', v), null, () => ch.state.inst);
    add(`${M}.volume`, `Channel ${n} Fader`, 'abs', (v) => ch.set('volume', v), null, () => ch.state.volume);
    add(`${M}.trim`, `Channel ${n} Trim`, 'abs', (v) => ch.set('trim', v * 2 - 1), null, bi('trim'));
    add(`${M}.eqHigh`, `Channel ${n} EQ High`, 'abs', (v) => ch.set('eqHigh', v * 2 - 1), null, bi('eqHigh'));
    add(`${M}.eqMid`, `Channel ${n} EQ Mid`, 'abs', (v) => ch.set('eqMid', v * 2 - 1), null, bi('eqMid'));
    add(`${M}.eqLow`, `Channel ${n} EQ Low`, 'abs', (v) => ch.set('eqLow', v * 2 - 1), null, bi('eqLow'));
    add(`${M}.filter`, `Channel ${n} Filter`, 'abs', (v) => ch.set('filter', v * 2 - 1), null, bi('filter'));
    add(`${M}.cue`, `Channel ${n} Headphone cue`, 'button', (down) => down && ch.set('cue', !ch.state.cue), () => ch.state.cue);
    add(`${M}.fxOn`, `Channel ${n} FX on`, 'button', (down) => down && ch.set('fxOn', !ch.state.fxOn), () => ch.state.fxOn);
    add(`${M}.fxMix`, `Channel ${n} FX mix`, 'abs', (v) => ch.set('fxMix', v), null, () => ch.state.fxMix);
    add(`${M}.fxParam`, `Channel ${n} FX parameter`, 'abs', (v) => ch.set('fxParam', v), null, () => ch.state.fxParam);
  }
  add('mixer.crossfader', 'Crossfader', 'abs', (v) => eng.setCrossfader(v * 2 - 1), null, () => ((eng.crossfader || 0) + 1) / 2);
  add('master.volume', 'Master volume', 'abs', (v) => eng.setMasterVolume(v), null, () => eng.masterVolume ?? 0.8);
  add('master.cueMix', 'Headphone cue/master mix', 'abs', (v) => eng.setCueMix(v), null, () => eng.cueMix ?? 0.5);
  add('master.hpVolume', 'Headphone volume', 'abs', (v) => eng.setHeadphoneVolume(v), null, () => eng.hpVolume ?? 0.8);
  add('global.shift', 'Shift', 'button', (down) => { app.shift = down; });
  add('mic.on', 'Microphone on/off', 'button', (down) => down && app.toggleMic(), () => eng.micOn);
  add('mic.talkover', 'Talkover (duck music)', 'button', (down) => down && eng.setTalkover(!eng.talkover), () => eng.talkover);
  add('mic.volume', 'Microphone level', 'abs', (v) => eng.setMicVolume(v), null, () => eng.micVolume ?? 1);
  add('sequencer.toggle', 'Sequencer start/stop', 'button', (down) => down && (app.sequencer.running ? app.sequencer.stop() : app.sequencer.start()), () => app.sequencer?.running);
  add('browser.scroll', 'Browser: scroll tracks', 'rel', (delta) => app.library.moveSelection(Math.sign(delta)));
  add('browser.up', 'Browser: previous track', 'button', (down) => down && app.library.moveSelection(-1));
  add('browser.down', 'Browser: next track', 'button', (down) => down && app.library.moveSelection(1));
  add('browser.loadFirstStopped', 'Browser: load into first stopped deck', 'button', (down) => {
    if (!down) return;
    const n = app.deckCount || 2;
    const i = eng.decks.slice(0, n).findIndex((x) => !x.playing);
    if (i >= 0) app.library.loadSelected(i);
  });
  add('automix.toggle', 'Automix on/off', 'button', (down) => down && app.toggleAutomix(), () => app.automix.enabled);
  add('record.toggle', 'Record mix on/off', 'button', (down) => down && app.toggleRecord(), () => app.engine.recording);
  T.push(...linkMidiTargets(app), ...lyricsMidiTargets(app));
  return T;
}

/** Extra LED states (not functions) that Mixxx outputs can follow: track loaded, VU meters, clip, sampler slots. */
export function buildStates(app) {
  const eng = app.engine, S = new Map();
  const lvl = (ch) => { try { return ch.level() || 0; } catch { return 0; } };
  for (let d = 0; d < 4; d++) {
    const deck = eng.decks[d], ch = eng.channels[d];
    S.set(`deck${d + 1}.loaded`, () => !!deck?.track);
    S.set(`mixer${d + 1}.vu`, () => (ch ? lvl(ch) : 0));
    S.set(`mixer${d + 1}.clip`, () => (ch ? lvl(ch) > 0.97 : false));
  }
  S.set('master.vu', () => Math.max(0, ...eng.channels.map(lvl)));
  for (let i = 0; i < 8; i++) S.set(`sampler${i + 1}.loaded`, () => !!eng.sampler?.slots?.[i]?.buffer);
  return S;
}

const hex = (n) => '0x' + n.toString(16).padStart(2, '0').toUpperCase();
export const msgKey = (type, channel, number) => `${type}:${channel}:${number}`;
export const describeKey = (k) => {
  if (k.startsWith('hid:')) return describeHidKey(k);
  if (k.startsWith('gp:')) return describeGamepadKey(k);
  const [t, c, n] = k.split(':');
  return `${t === 'note' ? 'Note' : t === 'cc' ? 'CC' : 'Pitch'} ${hex(+n)} ch${+c + 1}`;
};
/** Normalise a MIDI port name so input and output ports of one controller compare equal across OSes. */
export const portBase = (name) => String(name || '').toLowerCase()
  .replace(/\bmidi ?(in|out)?\d*\b/g, ' ').replace(/\b(in|out|input|output|port)\b/g, ' ')
  .replace(/(\s+\d+(:\d+)?)+\s*$/, '').replace(/[^a-z0-9]+/g, '');
/** Ports that are never DJ controllers: don't offer to find a mapping for them. */
const NOT_A_CONTROLLER = /through|wavetable|\biac\b|loopmidi|virtual|rtpmidi|network|session \d|microsoft gs|fluid|timidity|sunvox/i;

/** Relative value decoding shared by MIDI learn and playback. */
export function relDelta(mode, value, last, range = 128) {
  if (mode === 'twos') return value < range / 2 ? value : value - range;
  if (mode === 'offset') return value - range / 2;
  if (mode === 'wrap') { if (last == null) return 0; let dlt = value - last; if (dlt > range / 2) dlt -= range; if (dlt < -range / 2) dlt += range; return dlt; }
  return 0;
}
/** Guess the relative encoding from one value: values near the centre mean offset-64, near 0/127 mean two's complement. */
export const guessRel = (value, range = 128) => (Math.abs(value - range / 2) <= range / 4 ? 'offset' : 'twos');

export class MidiManager extends Emitter {
  constructor(app) {
    super();
    this.app = app; this.access = null; this.targets = []; this.byId = new Map(); this.states = new Map();
    this.mappings = {}; // deviceKey -> { name, entries: [...], outputs? }
    this.learning = null; this.msb = new Map(); this.ledState = new Map();
    this.activity = 0; this.deviceActivity = new Map();
    this.autoRel = new WeakMap(); this.lastVal = new WeakMap(); this.absVal = new WeakMap();
    this.suppress = null; // device whose messages are captured (guided setup) instead of dispatched
    this._offered = new Set();
    this.hid = new HidManager(this);
    this.gamepads = new GamepadManager(this);
  }
  async init() {
    this.targets = buildTargets(this.app);
    this.byId = new Map(this.targets.map((t) => [t.id, t]));
    this.states = buildStates(this.app);
    this.mappings = structuredClone(this.app.settings.midiMappings || {});
    this.hid.init().catch((e) => console.warn('HID:', e));
    this.gamepads.init();
    setInterval(() => this.updateLeds(), 80);
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) { this.unsupported = true; return; }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => this.bind();
      this.bind();
    } catch (e) { this.error = e.message; }
  }
  inputs() { return this.access ? [...this.access.inputs.values()] : []; }
  outputs() { return this.access ? [...this.access.outputs.values()] : []; }
  bind() {
    for (const inp of this.inputs()) {
      inp.onmidimessage = (e) => this.onMessage(inp, e.data);
      if (this.hasMapping(inp.name)) continue;
      // auto-apply a preset the first time a known controller shows up
      const preset = PRESETS.find((p) => p.match.test(inp.name));
      if (preset) { this.mappings[inp.name] = { name: preset.name, entries: structuredClone(preset.entries) }; this.save(); this.app.toast(`MIDI: loaded "${preset.name}" mapping for ${inp.name}`); }
      else if (inp.state !== 'disconnected') this.offerMapping(inp.name);
    }
    this.emit('devices');
  }
  hasMapping(name) { return !!this.mappings[name]?.entries?.length; }

  /**
   * A controller without a mapping connected: offer to search the Mixxx library or run guided setup.
   * Set `midi.onUnmappedDevice = (name) => …` to replace the built-in toast.
   */
  offerMapping(name) {
    if (!name || NOT_A_CONTROLLER.test(name) || this._offered.has(name)) return;
    this._offered.add(name);
    let dismissed = [];
    try { dismissed = JSON.parse(localStorage.getItem('opendj.ctlOfferDismissed') || '[]'); } catch { /* storage blocked */ }
    if (dismissed.includes(name)) return;
    this.emit('unmapped', name);
    if (this.onUnmappedDevice) return this.onUnmappedDevice(name);
    const open = (mode) => { this.pendingAction = { device: name, mode }; close(); this.app.dialogs?.settings?.('controllers'); };
    const dismiss = () => { try { localStorage.setItem('opendj.ctlOfferDismissed', JSON.stringify([...dismissed, name].slice(-50))); } catch { /* ignore */ } close(); };
    const host = this.app.toasts;
    if (!host || typeof document === 'undefined') { this.app.toast?.(`New controller "${name}": open Settings → Controllers to find a mapping`); return; }
    const mk = (tag, cls, text, onclick) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; if (onclick) e.addEventListener('click', onclick); return e; };
    const box = mk('div', 'toast ctl-offer');
    box.append(mk('div', 'ctl-offer-title', `New controller: ${name}`), mk('div', 'ctl-offer-text', 'Find a ready-made mapping (from the Mixxx community library) or set it up step by step.'));
    const row = mk('div', 'ctl-offer-actions');
    row.append(mk('button', 'btn sm primary', 'Find mapping', () => open('search')), mk('button', 'btn sm', 'Guided setup', () => open('wizard')), mk('button', 'btn sm', "Don't ask again", dismiss));
    box.append(row);
    const close = () => { box.classList.add('out'); setTimeout(() => box.remove(), 400); };
    host.append(box);
    setTimeout(close, 20000);
  }

  mappingFor(name) { if (!this.mappings[name]) this.mappings[name] = { name: 'Custom', entries: [] }; return this.mappings[name]; }
  save() { this.app.setSetting('midiMappings', this.mappings); this.emit('mappings'); }

  learn(deviceName, targetId) { this.learning = { deviceName, targetId }; this._lsbWatch = null; this.emit('learning', this.learning); }
  cancelLearn() { this.learning = null; this.emit('learning', null); }
  /** Store a learned entry (any device type), replacing what was mapped to that target or control before. */
  completeLearn(deviceName, entry, { toast = true } = {}) {
    const t = this.byId.get(entry.target);
    const map = this.mappingFor(deviceName);
    map.entries = map.entries.filter((e) => e.target !== entry.target && e.key !== entry.key);
    map.entries.push(entry);
    this.learning = null; this.save(); this.emit('learning', null);
    if (toast && !this.quietLearn) this.app.toast(`Mapped ${describeKey(entry.key)}${entry.lsbKey ? ' (14-bit)' : ''} → ${t?.label || entry.target}`);
    return entry;
  }
  touch(deviceName) { const now = performance.now(); this.activity = now; this.deviceActivity.set(deviceName, now); }

  onMessage(input, data) {
    const [status, d1, d2 = 0] = data;
    const cmd = status & 0xf0, channel = status & 0x0f;
    let type, number = d1, value = d2;
    if (cmd === 0x90 || cmd === 0x80) type = 'note';
    else if (cmd === 0xb0) type = 'cc';
    else if (cmd === 0xe0) { type = 'pitch'; number = 0; value = (d2 << 7) | d1; }
    else return;
    const isOff = cmd === 0x80 || (cmd === 0x90 && d2 === 0);
    const key = msgKey(type, channel, number);
    const now = performance.now();
    this.touch(input.name);
    this.emit('message', { device: input.name, key, value, type, isOff, channel, number, t: now });
    if (this.suppress === input.name) return;

    // a 14-bit fader just learned: its LSB (CC n+32) arrives right after the MSB
    const w = this._lsbWatch;
    if (w && w.device === input.name && now < w.until && key === w.key) { w.entry.lsbKey = key; this._lsbWatch = null; this.save(); this.emit('learning', null); return; }

    if (this.learning && this.learning.deviceName === input.name && !isOff) {
      const t = this.byId.get(this.learning.targetId);
      if (!t) return this.cancelLearn();
      const entry = { key, target: t.id };
      if (t.kind === 'rel') entry.rel = type === 'pitch' ? 'offset' : guessRel(value);
      const stored = this.completeLearn(input.name, entry);
      if (t.kind === 'abs' && type === 'cc' && number < 32) this._lsbWatch = { device: input.name, entry: stored, key: msgKey('cc', channel, number + 32), until: now + 400 };
      return;
    }
    const map = this.mappings[input.name];
    if (!map) return;
    for (const e of map.entries) {
      if (e.lsbKey === key) { // LSB of a 14-bit control
        const msb = this.msb.get(e.key) ?? 0;
        this.dispatch(e, ((msb << 7) | value) / 16383);
        continue;
      }
      if (e.key !== key) continue;
      const t = this.byId.get(e.target); if (!t) continue;
      if (t.kind === 'button') { this.dispatch(e, isOff || (type !== 'note' && value === 0) ? 0 : 1); continue; }
      const range = type === 'pitch' ? 16384 : 128;
      if (t.kind === 'rel' || e.rel) {
        let mode = e.rel || 'offset';
        if (mode === 'auto') { mode = this.autoRel.get(e); if (!mode) { mode = guessRel(value, range); this.autoRel.set(e, mode); } }
        const delta = relDelta(mode, value, this.lastVal.get(e), range);
        this.lastVal.set(e, value);
        if (t.kind === 'rel') this.dispatch(e, delta);
        else this.nudge(e, t, delta / (range / 2));
        continue;
      }
      if (type === 'pitch') { this.dispatch(e, value / 16383); continue; }
      if (e.lsbKey) { this.msb.set(e.key, value); this.dispatch(e, (value << 7) / 16383); } else this.dispatch(e, value / 127);
    }
  }

  /** Relative control on an absolute target (endless EQ knob…): move from the current value. `step` ≈ fraction of travel. */
  nudge(entry, t, step) {
    let cur = this.absVal.get(entry);
    if (cur == null) { try { cur = t.get ? t.get() : 0.5; } catch { cur = 0.5; } if (entry.invert) cur = 1 - cur; }
    cur = clamp(cur + step, 0, 1);
    this.absVal.set(entry, cur);
    this.dispatch(entry, cur);
  }

  dispatch(entry, v) {
    const t = this.byId.get(entry.target); if (!t) return;
    try {
      if (t.kind === 'button') t.handler(v > 0);
      else if (t.kind === 'rel') t.handler(entry.invert ? -v : v);
      else t.handler(clamp(entry.invert ? 1 - v : v, 0, 1));
    } catch (e) { console.warn('controller target', entry.target, e); }
  }

  /** Current value of an LED state id (target LED or extra state). Booleans become 0/1. */
  stateValue(id) {
    const f = this.byId.get(id)?.led || this.states.get(id);
    if (!f) return 0;
    try { const v = f(); return typeof v === 'number' ? v : v ? 1 : 0; } catch { return 0; }
  }
  /** Mapping that drives a MIDI output port: same name as an input, or the same controller under another port name. */
  mappingForOutput(out) {
    if (this.mappings[out.name]) return this.mappings[out.name];
    const b = portBase(out.name);
    if (!b) return null;
    const inName = Object.keys(this.mappings).find((n) => !n.includes(':') && portBase(n) === b);
    return inName ? this.mappings[inName] : null;
  }

  /** Light controller LEDs: explicit outputs (Mixxx) or note-on 127/0 echoes for mapped buttons that have state. */
  updateLeds() {
    for (const out of this.outputs()) {
      const map = this.mappingForOutput(out); if (!map) continue;
      const send = (k, msg) => {
        const sig = msg.join(',');
        if (this.ledState.get(k) === sig) return;
        this.ledState.set(k, sig);
        try { out.send(msg); } catch { /* port closed */ }
      };
      if (Array.isArray(map.outputs) && map.outputs.length) {
        for (const o of map.outputs) {
          const v = this.stateValue(o.state);
          const on = o.min == null && o.max == null ? v > 0 : v >= (o.min > 0 ? o.min : Number.MIN_VALUE) && v <= (o.max ?? Infinity);
          send(`${out.id}|${o.status}|${o.midino}|${o.state}`, [o.status & 0xff, o.midino & 0x7f, (on ? o.on : o.off) & 0x7f]);
        }
        continue;
      }
      for (const e of map.entries) {
        const t = this.byId.get(e.target);
        if (!t?.led || e.noLed || e.key.includes('hid') || e.key.startsWith('gp:')) continue;
        const [type, ch, num] = e.key.split(':').map((x, i) => (i ? +x : x));
        if (type !== 'note' && type !== 'cc') continue;
        const on = !!t.led();
        send(out.id + e.key, [(type === 'cc' ? 0xb0 : 0x90) | ch, num, on ? 127 : 0]);
      }
    }
  }

  // ---------- MIDI clock out (24 ppqn) following the master deck, for drum machines / lights / Ableton ----------
  setClockOutput(name) {
    this.clockOut = name || '';
    clearInterval(this._clockTimer); this._clockTick = null;
    if (!this.clockOut) return;
    this._clockTimer = setInterval(() => this.clockSchedule(), 20);
  }
  clockSchedule() {
    const out = this.outputs().find((o) => o.name === this.clockOut);
    const eng = this.app.engine, m = eng.masterDeck();
    if (!out) return;
    const running = !!(m?.playing && m.bpm);
    if (running !== this._clockRunning) {
      this._clockRunning = running; this._clockTick = null;
      try { out.send([running ? 0xfa : 0xfc]); } catch { /* port closed */ }
    }
    // map audio-clock time to performance.now() for timestamped sends
    const ts = eng.ctx.getOutputTimestamp?.() || {};
    const ctxNow = ts.contextTime ?? eng.ctx.currentTime, perfNow = ts.performanceTime ?? performance.now();
    const bpm = running ? m.effectiveBpm : (this.app.sequencer?.bpm || 120);
    const tickSec = 60 / bpm / 24;
    let tickPos; // ticks since grid start, at ctxNow
    if (running) tickPos = ((m.position - m.gridOffset) / m.beatLen) * 24;
    else { if (!this._freeT0) this._freeT0 = ctxNow; tickPos = (ctxNow - this._freeT0) / tickSec; }
    if (this._clockTick == null || this._clockTick < Math.floor(tickPos) - 2 || this._clockTick > tickPos + 30) this._clockTick = Math.ceil(tickPos);
    const horizon = 0.1;
    while ((this._clockTick - tickPos) * tickSec < horizon) {
      const when = perfNow + (this._clockTick - tickPos) * tickSec * 1000;
      try { out.send([0xf8], Math.max(performance.now(), when)); } catch { return; }
      this._clockTick++;
    }
  }

  exportMapping(name) {
    const m = this.mappings[name] || { name: 'Custom', entries: [] };
    return JSON.stringify({ opendjMidiMapping: 1, device: name, name: m.name, entries: m.entries, ...(m.outputs ? { outputs: m.outputs } : {}) }, null, 2);
  }
  /** Import an OpenDJ .json mapping or a Mixxx .midi.xml mapping (converted). Returns the stored mapping. */
  importMapping(name, text, file = '') {
    const s = String(text).trimStart();
    if (s.startsWith('<')) return this.applyMixxx(name, s, file);
    const m = JSON.parse(s);
    if (!Array.isArray(m.entries)) throw new Error('Not an OpenDJ mapping file');
    this.mappings[name] = { name: m.name || 'Imported', entries: m.entries, ...(Array.isArray(m.outputs) ? { outputs: m.outputs } : {}) };
    this.resetRuntime(); this.save();
    return this.mappings[name];
  }
  /** Convert and apply a Mixxx mapping. Returns the stored mapping (with importInfo.stats). */
  applyMixxx(name, xml, file = '') {
    const conv = convertMixxx(xml);
    this.mappings[name] = toStoredMapping(conv, file);
    this.resetRuntime(); this.save();
    return this.mappings[name];
  }
  clearMapping(name) { delete this.mappings[name]; this.resetRuntime(); this.save(); }
  resetRuntime() { this.ledState.clear(); this.msb.clear(); this.autoRel = new WeakMap(); this.lastVal = new WeakMap(); this.absVal = new WeakMap(); }
  applyPreset(name, presetName) {
    const p = PRESETS.find((x) => x.name === presetName); if (!p) return;
    this.mappings[name] = { name: p.name, entries: structuredClone(p.entries) }; this.resetRuntime(); this.save();
  }

  /** Every connected controller across MIDI, HID and gamepads: [{ key, name, kind, hasOut, connected }]. */
  devices() {
    const list = [];
    const outs = this.outputs();
    for (const i of this.inputs()) list.push({ key: i.name, name: i.name, kind: 'midi', connected: i.state !== 'disconnected', hasOut: outs.some((o) => o.name === i.name || portBase(o.name) === portBase(i.name)) });
    for (const o of outs) if (!list.some((d) => d.kind === 'midi' && (d.name === o.name || portBase(d.name) === portBase(o.name)))) list.push({ key: o.name, name: o.name, kind: 'midi-out', connected: true, hasOut: true });
    for (const h of this.hid.list()) list.push({ key: h.key, name: h.name, kind: 'hid', connected: true });
    for (const g of this.gamepads.list()) list.push({ key: g.key, name: g.name, kind: 'gamepad', connected: true });
    return list;
  }
}
