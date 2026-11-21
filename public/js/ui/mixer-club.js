// "Club Booth" mixer faceplate (theme `booth`, body.skin-club-booth): the sections a 4-channel club mixer has around
// its channel strips. Original layout and art (no vendor names or logos):
//   left:   COLOR FX select buttons + PARAMETER, HEADPHONES (mixing, level, CUE MST, post-fader cue, split), MIC
//   right:  BALANCE, BOOTH level + 2-band booth EQ, BEAT FX unit (display, effect / beat ◀▶, channel select,
//           LEVEL/DEPTH, ON/OFF), RETURN
//   bottom: crossfader curve knob + channel-fader curve next to the full-width crossfader
// The elements are always built (cheap DOM) and only shown in the booth skin; every control drives the same engine
// functions and settings as the regular mixer and the advanced drawer, so MIDI targets stay the same.
import { el } from '../util.js';
import { knob, button } from './controls.js';
import { COLOR_FX, EFFECTS, BEAT_DIVISIONS } from '../audio/effects.js';
import { FADER_CURVES } from '../audio/curves.js';
import { updateMixer } from './mixer-state.js';

const CLUB_COLOR = ['space', 'dubecho', 'sweep', 'noise', 'crush', 'filter'];
const ASSIGNS = [['ch1', '1'], ['ch2', '2'], ['ch3', '3'], ['ch4', '4'], ['master', 'MST'], ['xfA', 'A'], ['xfB', 'B']];
const fmtDiv = (b) => (b < 1 ? `1/${Math.round(1 / b)}` : b === 0.75 ? '3/4' : String(b));

export function buildClubSections(app, R) {
  const eng = app.engine, S = app.settings;
  const lbl = (t) => el('div', { class: 'club-title' }, t);
  // ---------- left column ----------
  const colorBtns = CLUB_COLOR.map((id) => R(button(COLOR_FX.find(([v]) => v === id)?.[1] || id, {
    cls: 'xs club-color-btn', title: `Color FX: ${id}`,
    click: () => { for (const ch of eng.channels) ch.set('colorFx', id); app.setSetting('colorFx', id); app.mixer?.renderAll?.(); },
    active: () => (eng.channels[0]?.state.colorFx || S.colorFx) === id,
  })));
  const param = R(knob({ label: 'PARAMETER', min: 0, max: 1, def: 0.5, bipolar: false, size: 'sm', title: 'Color FX parameter (all channels)', get: () => eng.channels[0]?.state.colorParam ?? 0.5, set: (v) => { for (const ch of eng.channels) ch.set('colorParam', v); } }));
  const split = R(button('SPLIT', { cls: 'xs', title: 'Split cue: master mono left, cue mono right', click: async () => { await app.setSetting('cueMode', app.settings.cueMode === 'split' ? 'device' : 'split'); eng.applyOutputs(); }, active: () => app.settings.cueMode === 'split' }));
  const left = el('div', { class: 'club-col club-left mx-club' },
    lbl('COLOR FX'), el('div', { class: 'club-color-grid' }, ...colorBtns), param,
    lbl('HEADPHONES'),
    el('div', { class: 'club-pair club-hp' },
      R(knob({ label: 'MIXING', min: 0, max: 1, def: 0, bipolar: false, size: 'sm', title: 'Headphones: cue ↔ master', get: () => eng.cueMix ?? 0, set: (v) => eng.setCueMix(v) })),
      R(knob({ label: 'LEVEL', min: 0, max: 1, def: 0.8, bipolar: false, size: 'sm', title: 'Headphones level', get: () => eng.hpVolume ?? 0.8, set: (v) => eng.setHeadphoneVolume(v) }))),
    el('div', { class: 'club-btns' },
      R(button('CUE MST', { cls: 'xs', title: 'Master into the headphone cue', click: () => eng.setMasterCue(!eng.masterCue), active: () => eng.masterCue })),
      R(button('POST', { cls: 'xs', title: 'Post-fader cue', click: () => updateMixer(app, { cuePost: !eng.mx.cuePost }), active: () => !!eng.mx.cuePost })),
      split),
    el('div', { class: 'club-title club-mic' }, 'MIC'),
    el('div', { class: 'club-pair club-mic' },
      R(knob({ label: 'HI', size: 'sm', title: 'Mic EQ high', get: () => eng.micEq.high, set: (v) => eng.setMicEq('high', v) })),
      R(knob({ label: 'LOW', size: 'sm', title: 'Mic EQ low', get: () => eng.micEq.low, set: (v) => eng.setMicEq('low', v) }))),
    el('div', { class: 'club-btns club-mic' },
      R(button('FX', { cls: 'xs', title: 'Mic FX on/off', click: () => eng.setMicFx(!eng.micFxOn), active: () => eng.micFxOn })),
      R(button('AUTO', { cls: 'xs', title: 'Voice-activated talkover', click: () => updateMixer(app, { talkoverMode: eng.mx.talkoverMode === 'manual' ? 'auto' : 'manual' }), active: () => eng.mx.talkoverMode !== 'manual' }))),
  );
  // ---------- right: master extras + beat FX unit ----------
  const masterExtra = el('div', { class: 'club-master-extra mx-club' },
    el('div', { class: 'club-pair' },
      R(knob({ label: 'BALANCE', size: 'sm', title: 'Master balance', get: () => eng.balance, set: (v) => eng.setBalance(v) })),
      R(knob({ label: 'BOOTH', min: 0, max: 1, def: 0.8, bipolar: false, size: 'sm', title: 'Booth level (route it in the advanced drawer or Settings → Audio)', get: () => eng.boothVolume, set: (v) => { eng.ensureBooth(); eng.setBoothVolume(v); } }))),
    el('div', { class: 'club-pair club-bootheq' },
      R(knob({ label: 'BTH HI', size: 'xs', title: 'Booth EQ high (±12 dB)', get: () => eng.boothEq.high, set: (v) => { eng.ensureBooth(); eng.setBoothEq('high', v); } })),
      R(knob({ label: 'BTH LO', size: 'xs', title: 'Booth EQ low (±12 dB)', get: () => eng.boothEq.low, set: (v) => { eng.ensureBooth(); eng.setBoothEq('low', v); } }))),
  );
  const bus = () => eng.fxBus(0);
  const fxCfg = () => eng.mx.fx1;
  const step = (list, cur, d) => list[(list.indexOf(cur) + d + list.length) % list.length];
  const display = el('div', { class: 'club-fx-display', role: 'status', 'aria-live': 'off' });
  const fxIds = EFFECTS.map((e) => e.id);
  const setFx = (patch) => updateMixer(app, { fx1: { ...fxCfg(), ...patch } });
  const onBtn = R(button('ON / OFF', { cls: 'club-fx-on', title: 'Beat FX on/off', click: () => { if (fxCfg().assign === 'off') setFx({ assign: 'master' }); bus().setOn(!bus().on); renderFx(); }, active: () => !!eng.fxBuses[0]?.on }));
  const fx = el('div', { class: 'club-col club-fx mx-club' },
    lbl('BEAT FX'), display,
    el('div', { class: 'club-btns' },
      R(button('◀', { cls: 'xs', title: 'Previous effect', click: () => setFx({ type: step(fxIds, fxCfg().type, -1) }) })),
      el('span', { class: 'club-mini' }, 'FX'),
      R(button('▶', { cls: 'xs', title: 'Next effect', click: () => setFx({ type: step(fxIds, fxCfg().type, 1) }) }))),
    el('div', { class: 'club-btns' },
      R(button('◀', { cls: 'xs', title: 'Shorter beat division', click: () => { bus().setBeats(step(BEAT_DIVISIONS, bus().unit.beats, -1)); renderFx(); } })),
      el('span', { class: 'club-mini' }, 'BEAT'),
      R(button('▶', { cls: 'xs', title: 'Longer beat division', click: () => { bus().setBeats(step(BEAT_DIVISIONS, bus().unit.beats, 1)); renderFx(); } }))),
    R(button('CH', { cls: 'xs club-fx-ch', title: 'Beat FX channel select (1-4, master, crossfader A / B)', click: () => { const ids = ASSIGNS.map(([v]) => v); setFx({ assign: step(ids, fxCfg().assign === 'off' ? 'master' : fxCfg().assign, 1) }); } })),
    R(knob({ label: 'LEVEL/DEPTH', min: 0, max: 1, def: 0.5, bipolar: false, size: 'sm', title: 'Beat FX level / depth', get: () => eng.fxBuses[0]?.unit.mix ?? 0.5, set: (v) => bus().setMix(v) })),
    onBtn,
    R(knob({ label: 'RETURN', min: 0, max: 1, def: 0.7, bipolar: false, size: 'xs', title: 'Send / return level', get: () => eng.returnLevel, set: (v) => { eng.ensureSendFx(); eng.setReturnLevel(v); } })),
  );
  function renderFx() {
    const c = fxCfg(), b = eng.fxBuses[0], label = EFFECTS.find((e) => e.id === c.type)?.label || c.type;
    const ch = ASSIGNS.find(([v]) => v === c.assign)?.[1] || '—';
    const bpm = Math.round(60 / (eng._beatSec || 0.5));
    display.textContent = `${label}\n${fmtDiv(b?.unit.beats ?? 0.5)} · CH ${ch} · ${bpm}`;
    onBtn.render();
  }
  renderFx();
  // ---------- crossfader / fader curve controls next to the crossfader ----------
  const xfCurve = R(knob({ label: 'X-CURVE', min: 0, max: 1, def: 0.5, bipolar: false, size: 'xs', title: 'Crossfader curve: linear … smooth … fast cut', get: () => eng.mx.xfCurve, set: (v) => updateMixer(app, { xfCurve: Math.round(v * 100) / 100 }) }));
  const fCurve = el('select', { class: 'sel tiny club-fader-curve', title: 'Channel fader curve', 'aria-label': 'Channel fader curve' }, ...FADER_CURVES.map((c) => el('option', { value: c }, c.toUpperCase())));
  fCurve.value = eng.mx.faderCurve; fCurve.addEventListener('change', () => updateMixer(app, { faderCurve: fCurve.value }));
  const curves = el('div', { class: 'club-curves mx-club' }, xfCurve, el('label', { class: 'club-mini' }, 'CH CURVE', fCurve));
  eng.on('mixer-config', () => { fCurve.value = eng.mx.faderCurve; renderFx(); });
  eng.on('fx-assign', renderFx);
  return { left, masterExtra, fx, curves, renderFx };
}
