// Mixer v2 MIDI targets (docs/MIXER_AND_TURNTABLES_PLAN.md §4, ids as the plan names them; compatible with the
// controller plan's fx1.* / fx2.* names). Existing ids in midi.js are never renamed. kind: button | abs (0..1) |
// rel; `takeover: 'pickup'` marks absolute knobs that should use soft takeover (controller plan v2).
import { EFFECTS, COLOR_FX, MIC_FX_LIST, SEND_FX } from '../audio/effects.js';
import { FADER_CURVES } from '../audio/curves.js';
import { EQ_TYPE_IDS } from '../audio/eq.js';
import { PERSONALITY_IDS, applyPersonality } from '../audio/personalities.js';
import { FxBus, STRIP_DIVISIONS } from '../audio/fx-bus.js';
import { updateMixer } from '../ui/mixer-state.js';
import { centerLock } from '../audio/curves.js';

const next = (list, cur, d = 1) => list[(Math.max(0, list.indexOf(cur)) + d + list.length) % list.length];

export function mixerMidiTargets(app) {
  const T = [], eng = app.engine;
  const add = (id, label, kind, handler, led, get, extra = {}) => T.push({ id, label, kind, handler, led, get, ...extra });
  const pick = { takeover: 'pickup' };
  const mx = () => eng.mx, set = (patch) => updateMixer(app, patch);
  // M1 / M2 crossfader and faders
  add('mixer.xfCurve', 'Crossfader curve (linear … fast cut)', 'abs', (v) => set({ xfCurve: Math.round(v * 100) / 100 }), null, () => mx().xfCurve, pick);
  add('mixer.xfReverse', 'Crossfader reverse (hamster)', 'button', (d) => d && set({ xfReverse: !mx().xfReverse }), () => mx().xfReverse);
  add('mixer.xfCutIn', 'Crossfader cut-in (0-10 %)', 'abs', (v) => set({ xfCutIn: Math.round(v * 100) / 1000 }), null, () => mx().xfCutIn * 10);
  add('mixer.faderCurve.next', 'Channel fader curve: next', 'button', (d) => d && set({ faderCurve: next(FADER_CURVES, mx().faderCurve) }));
  // M3 / M4 / M5
  add('mixer.eqType.next', 'EQ preset: next', 'button', (d) => d && set({ eqType: next(EQ_TYPE_IDS, mx().eqType) }));
  add('mixer.centerLock', 'Filter Center Lock', 'button', (d) => d && set({ centerLock: !mx().centerLock }), () => mx().centerLock);
  const colorIds = COLOR_FX.map(([id]) => id);
  const setColorAll = (id) => { for (const ch of eng.channels) ch.set('colorFx', id); app.setSetting('colorFx', id); };
  add('mixer.colorFx.next', 'Color FX: next', 'button', (d) => d && setColorAll(next(colorIds, eng.channels[0].state.colorFx)));
  add('mixer.colorFx.prev', 'Color FX: previous', 'button', (d) => d && setColorAll(next(colorIds, eng.channels[0].state.colorFx, -1)));
  add('mixer.personality.next', 'Mixer personality: next', 'button', (d) => d && applyPersonality(eng, next(PERSONALITY_IDS, mx().personality), { save: (m) => app.setSetting('mixer', m) }));
  for (let d = 0; d < 4; d++) {
    const ch = eng.channels[d], n = d + 1, M = `mixer${n}`, lock = centerLock({ mode: 'midi' });
    ch._midiLock = lock;
    const bi = (k) => () => (ch.state[k] + 1) / 2;
    add(`${M}.faderReverse`, `Channel ${n} fader reverse`, 'button', (x) => x && ch.set('faderReverse', !ch.state.faderReverse), () => ch.state.faderReverse);
    add(`${M}.eqMidHigh`, `Channel ${n} EQ Mid-High (4-band)`, 'abs', (v) => ch.set('eqMidHigh', v * 2 - 1), null, bi('eqMidHigh'), pick);
    add(`${M}.eqMidLow`, `Channel ${n} EQ Mid-Low (4-band)`, 'abs', (v) => ch.set('eqMidLow', v * 2 - 1), null, bi('eqMidLow'), pick);
    add(`${M}.eqFreq`, `Channel ${n} EQ frequency (Sculpt)`, 'abs', (v) => ch.set('eqFreq', v), null, () => ch.state.eqFreq, pick);
    add(`${M}.filterHp`, `Channel ${n} high-pass (dual filter)`, 'abs', (v) => ch.set('filterHp', v), null, () => ch.state.filterHp);
    add(`${M}.filterLp`, `Channel ${n} low-pass (dual filter)`, 'abs', (v) => ch.set('filterLp', v), null, () => ch.state.filterLp);
    add(`${M}.colorFx.next`, `Channel ${n} Color FX: next`, 'button', (x) => x && ch.set('colorFx', next(colorIds, ch.state.colorFx)));
    add(`${M}.colorParam`, `Channel ${n} Color FX parameter`, 'abs', (v) => ch.set('colorParam', v), null, () => ch.state.colorParam);
    add(`${M}.cue2`, `Channel ${n} headphone cue B`, 'button', (x) => { if (!x) return; eng.ensureHp2(); ch.set('cue2', !ch.state.cue2); }, () => ch.state.cue2);
    add(`${M}.cuePost`, `Channel ${n} post-fader cue`, 'button', (x) => x && ch.set('cuePost', !ch.state.cuePost), () => ch.state.cuePost);
    add(`${M}.send`, `Channel ${n} send`, 'abs', (v) => ch.set('send', v), null, () => ch.state.send);
    add(`${M}.comp`, `Channel ${n} compressor`, 'abs', (v) => ch.set('comp', v), null, () => ch.state.comp);
    for (const u of [1, 2]) add(`fx.unit${u}.assign.deck${n}`, `FX ${u} assign to channel ${n}`, 'button', (x) => x && toggleAssign(u - 1, `ch${n}`), () => eng.fxBuses[u - 1]?.assign === `ch${n}`);
  }
  // M6 booth, M7 headphones, M13 master extras, M12 master isolator, M16 warmth, M15 record
  add('master.boothVolume', 'Booth level', 'abs', (v) => { eng.ensureBooth(); eng.setBoothVolume(v); }, null, () => eng.boothVolume, pick);
  add('master.boothEqHigh', 'Booth EQ high', 'abs', (v) => { eng.ensureBooth(); eng.setBoothEq('high', v * 2 - 1); }, null, () => (eng.boothEq.high + 1) / 2, pick);
  add('master.boothEqLow', 'Booth EQ low', 'abs', (v) => { eng.ensureBooth(); eng.setBoothEq('low', v * 2 - 1); }, null, () => (eng.boothEq.low + 1) / 2, pick);
  add('master.cue', 'Master cue (CUE MST)', 'button', (d) => d && eng.setMasterCue(!eng.masterCue), () => eng.masterCue);
  add('sampler.cue', 'Sampler cue', 'button', (d) => d && eng.setSamplerCue(!eng.samplerCue), () => eng.samplerCue);
  add('master.hp2Volume', 'Headphones B level', 'abs', (v) => { eng.ensureHp2(); eng.setHp2Volume(v); }, null, () => eng.hp2Volume, pick);
  add('master.hp2CueMix', 'Headphones B cue/master mix', 'abs', (v) => { eng.ensureHp2(); eng.setHp2CueMix(v); }, null, () => eng.hp2CueMix, pick);
  add('master.balance', 'Master balance', 'abs', (v) => eng.setBalance(v * 2 - 1), null, () => (eng.balance + 1) / 2, pick);
  add('master.mono', 'Master mono', 'button', (d) => d && set({ mono: !mx().mono }), () => mx().mono);
  add('master.limiter', 'Master limiter on/off', 'button', (d) => { if (!d) return; const on = app.settings.limiter === false; app.setSetting('limiter', on); eng.setLimiter(on); }, () => app.settings.limiter !== false);
  for (const b of ['Low', 'Mid', 'High']) add(`master.iso${b}`, `Master isolator ${b.toLowerCase()}`, 'abs', (v) => eng.setMasterIso(b.toLowerCase(), v * 2 - 1), null, () => (eng.iso[b.toLowerCase()] + 1) / 2, pick);
  add('master.isoOn', 'Master isolator on/off', 'button', (d) => d && eng.setMasterIsoOn(!eng.isoOn), () => eng.isoOn);
  add('master.warmth', 'Master warmth', 'abs', (v) => eng.setWarmth(v), null, () => eng.warmth, pick);
  add('record.level', 'Record level (±12 dB)', 'abs', (v) => eng.setRecordLevel(v * 24 - 12), null, () => (eng.recLevelDb + 12) / 24, pick);
  add('master.returnLevel', 'Send/return: return level', 'abs', (v) => { eng.ensureSendFx(); eng.setReturnLevel(v); }, null, () => eng.returnLevel, pick);
  add('send.type.next', 'Send FX: next', 'button', (d) => d && set({ sendType: next(SEND_FX.map((f) => f.id), mx().sendType) }));
  add('send.on', 'Send/return on', 'button', (d) => { if (!d) return; eng.ensureSendFx(); eng.setSendOn(!eng.sendOn); }, () => eng.sendOn);
  // M8 mic
  for (const b of ['High', 'Mid', 'Low']) add(`mic.eq${b}`, `Mic EQ ${b.toLowerCase()}`, 'abs', (v) => eng.setMicEq(b.toLowerCase(), v * 2 - 1), null, () => (eng.micEq[b.toLowerCase()] + 1) / 2, pick);
  add('mic.fxOn', 'Mic FX on/off', 'button', (d) => d && eng.setMicFx(!eng.micFxOn), () => eng.micFxOn);
  add('mic.fxType.next', 'Mic FX: next', 'button', (d) => d && set({ micFx: next(MIC_FX_LIST.map((f) => f.id), mx().micFx) }));
  add('mic.fxLevel', 'Mic FX level', 'abs', (v) => eng.setMicFxLevel(v), null, () => eng.micFxLevel, pick);
  add('mic.talkoverMode.next', 'Talkover mode: next (manual / auto / voice band)', 'button', (d) => d && set({ talkoverMode: next(['manual', 'auto', 'advanced'], mx().talkoverMode) }));
  add('mic.talkoverDepth', 'Talkover depth (0 .. -40 dB)', 'abs', (v) => { app.setSetting('talkoverDb', Math.round(-40 * v)); eng.applyTalkoverDepth(); }, null, () => -(app.settings.talkoverDb ?? -12) / 40);
  add('mic.toBooth', 'Mic in booth', 'button', (d) => d && set({ micToBooth: !mx().micToBooth }), () => mx().micToBooth);
  add('mic.toRecord', 'Mic in recording', 'button', (d) => d && set({ micToRecord: !mx().micToRecord }), () => mx().micToRecord);
  // M9 global FX units fx1 / fx2 (controller plan names)
  const fxIds = EFFECTS.map((e) => e.id);
  function toggleAssign(u, target) { const k = `fx${u + 1}`, c = mx()[k]; set({ [k]: { ...c, assign: c.assign === target ? 'off' : target } }); }
  for (const u of [0, 1]) {
    const P = `fx${u + 1}`, bus = () => eng.fxBus(u), cfg = () => mx()[P];
    add(`${P}.on`, `FX ${u + 1} on/off`, 'button', (d) => { if (!d) return; if (cfg().assign === 'off') set({ [P]: { ...cfg(), assign: 'master' } }); bus().setOn(!bus().on); }, () => !!eng.fxBuses[u]?.on);
    add(`${P}.select`, `FX ${u + 1} effect: next`, 'button', (d) => d && set({ [P]: { ...cfg(), type: next(fxIds, cfg().type) } }));
    add(`${P}.param`, `FX ${u + 1} level / depth`, 'abs', (v) => bus().setMix(v), null, () => eng.fxBuses[u]?.unit.mix ?? 0.5, pick);
    add(`${P}.param2`, `FX ${u + 1} parameter`, 'abs', (v) => bus().setParam(v), null, () => eng.fxBuses[u]?.unit.param ?? 0.5, pick);
    add(`${P}.time`, `FX ${u + 1} beat division`, 'abs', (v) => bus().setBeats(FxBus.divisionFromValue(v)), null, null);
    add(`${P}.assign.master`, `FX ${u + 1} assign to master`, 'button', (d) => d && toggleAssign(u, 'master'), () => eng.fxBuses[u]?.assign === 'master');
    for (const b of ['low', 'mid', 'high']) add(`${P}.band.${b}`, `FX ${u + 1} frequency band ${b}`, 'button', (d) => { if (!d) return; const x = bus(); x.setBand(b, !x.bands[b]); }, () => eng.fxBuses[u]?.bands[b] !== false);
    add(`${P}.strip`, `FX ${u + 1} FX strip (touch: 0..1 = ${STRIP_DIVISIONS.length} beat divisions)`, 'abs', (v) => bus().strip(v <= 0.001 ? null : Math.min(0.999, v)), null, null);
    add(`${P}.quantize`, `FX ${u + 1} quantise`, 'button', (d) => d && set({ [P]: { ...cfg(), quantize: !cfg().quantize } }), () => cfg().quantize);
  }
  return T;
}

/** LED / VU states: master loudness (LUFS short-term 0..1 over -40..0) and true peak for controllers with VU LEDs. */
export function mixerMidiStates(app) {
  const eng = app.engine, S = new Map();
  S.set('master.lufs', () => { eng.ensureMeter?.(); const v = eng.loudness?.s; return Number.isFinite(v) ? Math.max(0, Math.min(1, (v + 40) / 40)) : 0; });
  S.set('master.truePeak', () => { const v = eng.loudness?.tp; return Number.isFinite(v) ? Math.max(0, Math.min(1, (v + 40) / 40)) : 0; });
  S.set('master.limiterActive', () => (eng.limiterGr?.() ?? 1) < 0.99);
  return S;
}
