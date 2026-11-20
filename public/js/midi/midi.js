// MIDI controller support: Web MIDI input, MIDI-learn mappings, 14-bit faders, relative jog/encoders, LED feedback.
import { Emitter, clamp } from '../util.js';
import { PRESETS } from './presets.js';

/** All mappable functions. kind: button | abs (0..1) | rel (relative delta) */
export function buildTargets(app) {
  const T = [];
  const add = (id, label, kind, handler, led) => T.push({ id, label, kind, handler, led });
  const eng = app.engine;
  for (let d = 0; d < 4; d++) {
    const deck = eng.decks[d], ch = eng.channels[d], n = d + 1;
    const P = `deck${n}`, M = `mixer${n}`;
    add(`${P}.play`, `Deck ${n} Play/Pause`, 'button', (down) => down && (eng.resume(), deck.togglePlay()), () => deck.playing);
    add(`${P}.cue`, `Deck ${n} Cue`, 'button', (down) => (down ? deck.cueDown() : deck.cueUp()), () => deck.cuePreview || (!deck.playing && deck.track && Math.abs(deck.position - deck.cuePoint) < 0.02));
    add(`${P}.sync`, `Deck ${n} Sync`, 'button', (down) => down && (app.shift ? deck.setMaster() : deck.sync()), () => deck.syncOn);
    add(`${P}.master`, `Deck ${n} Set Master`, 'button', (down) => down && deck.setMaster(), () => deck.isMaster);
    add(`${P}.keylock`, `Deck ${n} Key Lock`, 'button', (down) => down && deck.setKeyLock(!deck.keyLock), () => deck.keyLock);
    add(`${P}.slip`, `Deck ${n} Slip`, 'button', (down) => down && deck.setSlip(!deck.slip), () => deck.slip);
    add(`${P}.censor`, `Deck ${n} Censor (hold)`, 'button', (down) => (down ? deck.censorOn() : deck.censorOff()));
    add(`${P}.tempo`, `Deck ${n} Tempo fader`, 'abs', (v) => deck.setTempoFader(v * 2 - 1));
    add(`${P}.tempoReset`, `Deck ${n} Tempo reset`, 'button', (down) => down && deck.resetTempo());
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
    add(`${P}.loopHalve`, `Deck ${n} Loop ½`, 'button', (down) => down && deck.loopHalve());
    add(`${P}.loopDouble`, `Deck ${n} Loop ×2`, 'button', (down) => down && deck.loopDouble());
    add(`${P}.jumpBack`, `Deck ${n} Beat jump −4`, 'button', (down) => down && deck.beatJump(-4));
    add(`${P}.jumpFwd`, `Deck ${n} Beat jump +4`, 'button', (down) => down && deck.beatJump(4));
    add(`${P}.load`, `Deck ${n} Load selected track`, 'button', (down) => down && app.library.loadSelected(d));
    for (let p = 0; p < 8; p++) {
      add(`${P}.pad${p + 1}`, `Deck ${n} Pad ${p + 1} (current pad mode)`, 'button', (down) => deck.padPress?.(p, down), () => !!deck.hotCue(p));
      add(`${P}.hotcue${p + 1}`, `Deck ${n} Hot cue ${String.fromCharCode(65 + p)}`, 'button', (down) => (down ? (app.shift ? deck.deleteHotCue(p) : deck.hotCueDown(p)) : deck.hotCueUp(p)), () => !!deck.hotCue(p));
      add(`${P}.roll${p + 1}`, `Deck ${n} Loop roll ${[1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8][p]}`, 'button', (down) => (down ? deck.rollOn([1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8][p]) : deck.rollOff()));
      add(`${P}.sampler${p + 1}`, `Sampler ${p + 1} (deck ${n} pads)`, 'button', (down) => down && eng.sampler.trigger(p));
      add(`${P}.beatjump${p + 1}`, `Deck ${n} Beat jump pad ${p + 1}`, 'button', (down) => down && deck.beatJump([1, 2, 4, 8][p % 4] * (p < 4 ? -1 : 1)));
    }
    for (const m of ['hotcue', 'roll', 'jump', 'sampler', 'fx']) add(`${P}.padMode.${m}`, `Deck ${n} Pad mode: ${m}`, 'button', (down) => down && deck.padMode?.(m));
    add(`${P}.keySync`, `Deck ${n} Key sync`, 'button', (down) => down && (app.shift ? deck.setKeyShift(0) : deck.keySyncTo()), () => deck.keyShift !== 0);
    add(`${P}.keyUp`, `Deck ${n} Key +1 semitone`, 'button', (down) => down && deck.setKeyShift(deck.keyShift + 1));
    add(`${P}.keyDown`, `Deck ${n} Key −1 semitone`, 'button', (down) => down && deck.setKeyShift(deck.keyShift - 1));
    add(`${P}.keyReset`, `Deck ${n} Key reset`, 'button', (down) => down && deck.setKeyShift(0));
    for (let p = 0; p < 8; p++) add(`${P}.slice${p + 1}`, `Deck ${n} Slicer pad ${p + 1}`, 'button', (down) => (down ? deck.sliceDown(p) : deck.sliceUp()));
    add(`${P}.instantDouble`, `Deck ${n} Instant double from other deck`, 'button', (down) => down && deck.cloneFrom(eng.decks[d % 2 === 0 ? d + 1 : d - 1]));
    add(`${M}.vocal`, `Channel ${n} Vocal level (quick stems)`, 'abs', (v) => ch.set('vocal', v));
    add(`${M}.inst`, `Channel ${n} Instrumental level (quick stems)`, 'abs', (v) => ch.set('inst', v));
    add(`${M}.volume`, `Channel ${n} Fader`, 'abs', (v) => ch.set('volume', v));
    add(`${M}.trim`, `Channel ${n} Trim`, 'abs', (v) => ch.set('trim', v * 2 - 1));
    add(`${M}.eqHigh`, `Channel ${n} EQ High`, 'abs', (v) => ch.set('eqHigh', v * 2 - 1));
    add(`${M}.eqMid`, `Channel ${n} EQ Mid`, 'abs', (v) => ch.set('eqMid', v * 2 - 1));
    add(`${M}.eqLow`, `Channel ${n} EQ Low`, 'abs', (v) => ch.set('eqLow', v * 2 - 1));
    add(`${M}.filter`, `Channel ${n} Filter`, 'abs', (v) => ch.set('filter', v * 2 - 1));
    add(`${M}.cue`, `Channel ${n} Headphone cue`, 'button', (down) => down && ch.set('cue', !ch.state.cue), () => ch.state.cue);
    add(`${M}.fxOn`, `Channel ${n} FX on`, 'button', (down) => down && ch.set('fxOn', !ch.state.fxOn), () => ch.state.fxOn);
    add(`${M}.fxMix`, `Channel ${n} FX mix`, 'abs', (v) => ch.set('fxMix', v));
    add(`${M}.fxParam`, `Channel ${n} FX parameter`, 'abs', (v) => ch.set('fxParam', v));
  }
  add('mixer.crossfader', 'Crossfader', 'abs', (v) => eng.setCrossfader(v * 2 - 1));
  add('master.volume', 'Master volume', 'abs', (v) => eng.setMasterVolume(v));
  add('master.cueMix', 'Headphone cue/master mix', 'abs', (v) => eng.setCueMix(v));
  add('master.hpVolume', 'Headphone volume', 'abs', (v) => eng.setHeadphoneVolume(v));
  add('global.shift', 'Shift', 'button', (down) => { app.shift = down; });
  add('mic.on', 'Microphone on/off', 'button', (down) => down && app.toggleMic(), () => eng.micOn);
  add('mic.talkover', 'Talkover (duck music)', 'button', (down) => down && eng.setTalkover(!eng.talkover), () => eng.talkover);
  add('mic.volume', 'Microphone level', 'abs', (v) => eng.setMicVolume(v));
  add('sequencer.toggle', 'Sequencer start/stop', 'button', (down) => down && (app.sequencer.running ? app.sequencer.stop() : app.sequencer.start()), () => app.sequencer?.running);
  add('browser.scroll', 'Browser: scroll tracks', 'rel', (delta) => app.library.moveSelection(Math.sign(delta)));
  add('browser.up', 'Browser: previous track', 'button', (down) => down && app.library.moveSelection(-1));
  add('browser.down', 'Browser: next track', 'button', (down) => down && app.library.moveSelection(1));
  add('automix.toggle', 'Automix on/off', 'button', (down) => down && app.toggleAutomix(), () => app.automix.enabled);
  add('record.toggle', 'Record mix on/off', 'button', (down) => down && app.toggleRecord(), () => app.engine.recording);
  return T;
}

const hex = (n) => '0x' + n.toString(16).padStart(2, '0').toUpperCase();
export const msgKey = (type, channel, number) => `${type}:${channel}:${number}`;
export const describeKey = (k) => { const [t, c, n] = k.split(':'); return `${t === 'note' ? 'Note' : t === 'cc' ? 'CC' : 'Pitch'} ${hex(+n)} ch${+c + 1}`; };

export class MidiManager extends Emitter {
  constructor(app) {
    super();
    this.app = app; this.access = null; this.targets = []; this.byId = new Map();
    this.mappings = {}; // deviceName -> { name, entries: [{ key, target, invert, rel, lsb }] }
    this.learning = null; this.msb = new Map(); this.ledState = new Map();
    this.activity = 0;
  }
  async init() {
    this.targets = buildTargets(this.app);
    this.byId = new Map(this.targets.map((t) => [t.id, t]));
    this.mappings = structuredClone(this.app.settings.midiMappings || {});
    if (!navigator.requestMIDIAccess) { this.unsupported = true; return; }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => this.bind();
      this.bind();
      setInterval(() => this.updateLeds(), 80);
    } catch (e) { this.error = e.message; }
  }
  inputs() { return this.access ? [...this.access.inputs.values()] : []; }
  outputs() { return this.access ? [...this.access.outputs.values()] : []; }
  bind() {
    for (const inp of this.inputs()) {
      inp.onmidimessage = (e) => this.onMessage(inp, e.data);
      // auto-apply a preset the first time a known controller shows up
      if (!this.mappings[inp.name]) {
        const preset = PRESETS.find((p) => p.match.test(inp.name));
        if (preset) { this.mappings[inp.name] = { name: preset.name, entries: structuredClone(preset.entries) }; this.save(); this.app.toast(`MIDI: loaded "${preset.name}" mapping for ${inp.name}`); }
      }
    }
    this.emit('devices');
  }
  mappingFor(name) { if (!this.mappings[name]) this.mappings[name] = { name: 'Custom', entries: [] }; return this.mappings[name]; }
  save() { this.app.setSetting('midiMappings', this.mappings); this.emit('mappings'); }

  learn(deviceName, targetId) { this.learning = { deviceName, targetId }; this.emit('learning', this.learning); }
  cancelLearn() { this.learning = null; this.emit('learning', null); }

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
    this.activity = performance.now();
    this.emit('message', { device: input.name, key, value, type });

    if (this.learning && this.learning.deviceName === input.name && !isOff) {
      const t = this.byId.get(this.learning.targetId);
      const map = this.mappingFor(input.name);
      map.entries = map.entries.filter((e) => e.target !== t.id && e.key !== key);
      const entry = { key, target: t.id };
      if (t.kind === 'rel') entry.rel = value === 1 || value === 127 || value < 64 && value > 0 ? 'twos' : 'offset';
      map.entries.push(entry);
      this.learning = null; this.save(); this.emit('learning', null);
      this.app.toast(`Mapped ${describeKey(key)} → ${t.label}`);
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
      if (t.kind === 'button') { this.dispatch(e, isOff || (type === 'cc' && value === 0) ? 0 : 1); }
      else if (t.kind === 'rel') {
        let delta;
        if (e.rel === 'twos') delta = value < 64 ? value : value - 128;
        else delta = value - 64;
        this.dispatch(e, delta);
      } else {
        if (type === 'pitch') { this.dispatch(e, value / 16383); continue; }
        if (e.lsbKey) { this.msb.set(e.key, value); this.dispatch(e, (value << 7) / 16383); } else this.dispatch(e, value / 127);
      }
    }
  }

  dispatch(entry, v) {
    const t = this.byId.get(entry.target); if (!t) return;
    if (t.kind === 'button') t.handler(v > 0);
    else if (t.kind === 'rel') t.handler(entry.invert ? -v : v);
    else t.handler(clamp(entry.invert ? 1 - v : v, 0, 1));
  }

  /** Light controller LEDs (note-on with velocity 127/0) for mapped buttons that have state. */
  updateLeds() {
    for (const out of this.outputs()) {
      const map = this.mappings[out.name]; if (!map) continue;
      for (const e of map.entries) {
        const t = this.byId.get(e.target);
        if (!t?.led || e.noLed) continue;
        const on = !!t.led();
        const k = out.id + e.key;
        if (this.ledState.get(k) === on) continue;
        this.ledState.set(k, on);
        const [type, ch, num] = e.key.split(':').map((x, i) => (i ? +x : x));
        try { out.send([(type === 'cc' ? 0xb0 : 0x90) | ch, num, on ? 127 : 0]); } catch { /* port closed */ }
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

  exportMapping(name) { return JSON.stringify({ opendjMidiMapping: 1, device: name, ...this.mappings[name] }, null, 2); }
  importMapping(name, json) {
    const m = JSON.parse(json);
    if (!Array.isArray(m.entries)) throw new Error('Not an OpenDJ mapping file');
    this.mappings[name] = { name: m.name || 'Imported', entries: m.entries };
    this.save();
  }
  applyPreset(name, presetName) {
    const p = PRESETS.find((x) => x.name === presetName); if (!p) return;
    this.mappings[name] = { name: p.name, entries: structuredClone(p.entries) }; this.save();
  }
}
