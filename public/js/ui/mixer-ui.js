import { el, uiZoom } from '../util.js';
import { knob, fader, button } from './controls.js';
import { DECK_COLORS } from './deck-ui.js';
import { cssVar } from './themes.js';
import { COLOR_FX } from '../audio/effects.js';
import { EQ_PRESETS as EQ_MODEL_LIST } from '../audio/eq.js';
import { updateMixer } from './mixer-state.js';
import { buildDrawer, setPersonality } from './mixer-advanced.js';
import { centerLock } from '../audio/curves.js';
import { suggestPersonality, PERSONALITIES } from '../audio/personalities.js';
import { setSmartFader, smartAutoTransition } from '../midi/controller-extras.js';

/**
 * Segmented LED meter. Meter ballistics like hardware: instant attack, ~24 dB/s release, a peak-hold segment that
 * stays 1 s then falls. Sized from a ResizeObserver (no layout reads per frame) and redrawn only when a lit
 * segment changes, so idle channels cost nothing.
 */
function vuMeter(segPx = 0) { // segPx: one segment per ~segPx CSS px of height (more segments on a tall meter), else 20
  const c = el('canvas', { class: 'vu', width: 8, height: 120 });
  const g = c.getContext('2d');
  let SEGS = 20;
  let level = 0, held = 0, heldT = 0, lastT = 0, sig = '', dirty = true;
  let box = null;
  const ro = new ResizeObserver((es) => { const r = es.at(-1).contentRect, z = uiZoom(); box = { width: r.width * z, height: r.height * z }; dirty = true; });
  ro.observe(c);
  window.addEventListener('opendj-theme', () => { sig = ''; });
  c.draw = (peak, now = performance.now(), rms) => { // rms given: the bar shows RMS, the hold dot follows the peak
    if (dirty) {
      dirty = false;
      const r = box || c.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      const W = Math.max(2, Math.round(r.width * dpr)), H = Math.max(10, Math.round(r.height * dpr));
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; sig = ''; }
      if (segPx) SEGS = Math.max(16, Math.min(48, Math.round(H / dpr / segPx)));
    }
    const dt = Math.min(0.1, lastT ? (now - lastT) / 1000 : 0); lastT = now;
    const toK = (x) => Math.max(0, Math.min(1, (20 * Math.log10(x + 1e-9) + 48) / 51)); // -48..+3 dB
    const k = toK(rms ?? peak), kp = rms == null ? k : toK(peak);
    level = k >= level ? k : Math.max(k, level - dt * 24 / 51);
    if (kp >= held) { held = kp; heldT = now; } else if (now - heldT > 1000) held = Math.max(kp, held - dt * 0.6);
    const lit = Math.round(level * SEGS), pk = Math.min(SEGS - 1, Math.floor(held * SEGS - 1e-6));
    const s = `${lit}|${pk}|${c.width}x${c.height}`;
    if (s === sig) return;
    sig = s;
    const W = c.width, H = c.height, gap = Math.max(1, Math.round(H / SEGS * 0.22)), sh = (H - gap * (SEGS - 1)) / SEGS;
    g.clearRect(0, 0, W, H);
    for (let i = 0; i < SEGS; i++) {
      const top = (i + 1) / SEGS * 51 - 48; // the segment's top in dB: red over 0 dB, amber over -10.5 dB
      const col = top > 0 ? cssVar('--meter-clip') : top > -10.5 ? cssVar('--meter-hot') : cssVar('--meter-ok');
      const y = Math.round(H - (i + 1) * sh - i * gap);
      g.fillStyle = col;
      g.globalAlpha = i < lit ? 1 : i === pk && held > 0.02 ? 0.95 : 0.12;
      g.fillRect(0, y, W, Math.max(1, Math.round(sh)));
    }
    g.globalAlpha = 1;
  };
  return c;
}

export function buildMixer(app) {
  const eng = app.engine;
  const strips = [];
  const renderers = [];
  const byCh = []; let cur = null; // per-channel renderers so one change only re-renders its own strip
  const R = (c) => { renderers.push(c); if (cur) cur.push(c); return c; };
  // tone presets: set the EQ *knobs* of every deck (not the EQ model, which is the EQ preset selector above it)
  const EQ_PRESETS = [
  { id: 'flat', label: 'Tone: flat', values: [0, 0, 0] },
  { id: 'warm', label: 'Tone: warm', values: [0.12, -0.04, -0.08] },
  { id: 'bright', label: 'Tone: bright', values: [-0.08, 0.04, 0.16] },
  { id: 'vocal', label: 'Tone: vocal', values: [-0.12, 0.16, 0.08] },
  { id: 'bass-light', label: 'Tone: bass light', values: [-0.22, 0.05, 0.1] },
  { id: 'custom', label: 'Tone: custom', values: null },
];
const order = [2, 0, 1, 3]; // 4-deck layout: 3 1 2 4
  /** Strip / master variant element: shown by the root classes set from the mixer config (applyVariants). */
  const v = (cls, e) => { e.classList.add('mxv', cls); return e; };
  const stripsWrap = el('div', { class: 'mixer-strips' });

  for (const i of order) {
    cur = byCh[i] = [];
    const ch = eng.channels[i];
    const S = (k) => ({ get: () => ch.state[k], set: (v) => ch.set(k, v) });
    const vu = vuMeter();
    // Center Lock (M4): a drag from one side stops at 12 o'clock; the next drag can cross
    let cueBtn, faderRow, foot;
    const lock = centerLock({ mode: 'drag' });
    const filterKnob = R(knob({ label: 'FILTER', get: () => ch.state.filter, set: (x) => ch.controlSet('filter', x, lock), def: 0, size: 'md', title: 'Filter / Color FX amount. Left: low-pass, right: high-pass' }));
    filterKnob.addEventListener('pointerdown', () => lock.reset(), true);
    const xf = el('div', { class: 'xf-assign' }, ...['A', 'THRU', 'B'].map((a) => {
      const b = button(a === 'THRU' ? 'T' : a, { cls: 'xs', click: () => ch.set('xfAssign', a), active: () => ch.state.xfAssign === a, title: `Crossfader assign: ${a}` });
      return R(b);
    }));
    const strip = el('div', { class: 'strip', 'data-ch': i, style: { '--deck-color': DECK_COLORS[i] } },
      el('div', { class: 'strip-num' }, String(i + 1)),
      // two knob rows: TRIM and FILTER (gain and colour), then the EQ (HI / MID / LOW); labels under the knobs
      el('div', { class: 'kn-row kn-aux' },
        v('v-trim', R(knob({ label: 'TRIM', ...S('trim'), def: 0, size: 'sm', format: (v) => `${v >= 0 ? '+' : ''}${(v * 12).toFixed(1)}dB` }))),
        v('v-filter', filterKnob),
        v('v-dual', R(knob({ label: 'HP', min: 0, max: 1, def: 0, bipolar: false, ...S('filterHp'), size: 'sm', title: 'High-pass (cut only)' }))),
        v('v-dual', R(knob({ label: 'LP', min: 0, max: 1, def: 0, bipolar: false, ...S('filterLp'), size: 'sm', title: 'Low-pass (cut only)' }))),
        v('v-comp', R(knob({ label: 'COMP', min: 0, max: 1, def: 0, bipolar: false, ...S('comp'), size: 'sm', title: 'One-knob compressor' })))),
      el('div', { class: 'kn-row kn-eq' },
        R(knob({ label: 'HI', ...S('eqHigh'), def: 0, size: 'sm', title: 'High EQ (fully left = kill)' })),
        v('v-eq4', R(knob({ label: 'MID-HI', ...S('eqMidHigh'), def: 0, size: 'sm', title: '4-band EQ: mid-high' }))),
        v('v-mid', R(knob({ label: 'MID', ...S('eqMid'), def: 0, size: 'sm' }))),
        v('v-eq4', R(knob({ label: 'MID-LO', ...S('eqMidLow'), def: 0, size: 'sm', title: '4-band EQ: mid-low' }))),
        v('v-sculpt', R(knob({ label: 'FREQ', min: 0, max: 1, def: 0.5, bipolar: false, ...S('eqFreq'), size: 'sm', title: 'Sculpt EQ frequency (70 Hz - 7 kHz)', format: (x) => { const f = 70 * Math.pow(100, x); return f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`; } }))),
        R(knob({ label: 'LOW', ...S('eqLow'), def: 0, size: 'sm' }))),
      el('div', { class: 'stem-knobs' },
        R(knob({ label: 'VOC', min: 0, max: 1, def: 1, bipolar: false, ...S('vocal'), size: 'xs', title: 'Quick stems: vocal level (DSP centre-channel estimate)' })),
        R(knob({ label: 'INST', min: 0, max: 1, def: 1, bipolar: false, ...S('inst'), size: 'xs', title: 'Quick stems: instrumental level' }))),
      (cueBtn = R(button('CUE', { cls: 'btn-pfl', click: () => ch.set('cue', !ch.state.cue), active: () => ch.state.cue, title: 'Headphone cue (PFL)' }))),
      (faderRow = el('div', { class: 'fader-row' }, v('v-fader', R(fader({ ...S('volume'), def: 0.8, cls: 'ch-fader' }))), v('v-rotary', R(knob({ label: 'LEVEL', min: 0, max: 1, def: 0.8, bipolar: false, ...S('volume'), size: 'lg', title: 'Channel level (rotary: -inf .. +6 dB)' }))), vu)),
      (foot = el('div', { class: 'strip-foot' }, xf)),
    );
    strip.vu = vu; strip.ch = ch; strip.idx = i; strip.cueBtn = cueBtn; strip.faderRow = faderRow; strip.foot = foot;
    strips.push(strip); stripsWrap.append(strip);
    cur = null;
  }

  // Controller-style layout: a compact top bar (headphones, sampler, mic cluster, setup), identical channel columns
  // (TRIM / EQ / FILTER, CUE, long fader + meter, crossfader assign), a slim MASTER column (level, booth, stereo
  // meter) and the full-width crossfader at the bottom. Setup menus live behind the gear (advanced drawer).
  const mvuL = vuMeter(), mvuR = vuMeter(), mpkL = vuMeter(), mpkR = vuMeter(); // RMS (body) and peak columns per side
  const grLed = el('span', { class: 'gr-led', title: 'Limiter gain reduction' });
  // dB scale beside the master meter (the meter spans -48 .. +3 dB)
  const scale = el('div', { class: 'm-scale', 'aria-hidden': 'true' }, ...[0, -6, -12, -24, -48].map((db) => el('span', { style: { bottom: `${((db + 48) / 51) * 100}%` } }, String(db))));
  // MASTER column: title and level on top, the tall stereo meter in the middle, headphones / sampler / mic and the
  // buttons at the bottom (level with the channel faders and CUE buttons)
  const master = el('div', { class: 'mixer-master' },
    el('div', { class: 'strip-num m-title' }, 'MASTER'),
    el('div', { class: 'm-level' }, R(knob({ label: 'LEVEL', min: 0, max: 1, def: 0.8, size: 'sm', title: 'Master level', get: () => eng.masterVolume ?? 0.8, set: (x) => eng.setMasterVolume(x) }))),
    el('div', { class: 'm-meter' }, scale, el('div', { class: 'master-vu' }, el('div', { class: 'mv-side', title: 'Left: peak / RMS' }, mpkL, mvuL), el('div', { class: 'mv-side', title: 'Right: RMS / peak' }, mvuR, mpkR)), grLed),
    v('v-booth', el('div', { class: 'm-booth' }, R(knob({ label: 'BOOTH', min: 0, max: 1, def: 0.8, bipolar: false, size: 'xs', title: 'Booth level', get: () => eng.boothVolume, set: (x) => { eng.ensureBooth(); eng.setBoothVolume(x); } })))),
    el('div', { class: 'm-pair' },
      R(knob({ label: 'CUE/MST', min: 0, max: 1, def: 0, bipolar: false, size: 'xs', title: 'Headphones: cue ↔ master', get: () => eng.cueMix ?? 0, set: (x) => eng.setCueMix(x) })),
      R(knob({ label: 'PHONES', min: 0, max: 1, def: 0.8, size: 'xs', bipolar: false, title: 'Headphones level', get: () => eng.hpVolume ?? 0.8, set: (x) => eng.setHeadphoneVolume(x) }))),
    el('div', { class: 'm-pair' },
      R(knob({ label: 'SAMPLER', min: 0, max: 1, def: 0.8, size: 'xs', bipolar: false, title: 'Sampler level', get: () => eng.sampler.out.gain.value, set: (x) => eng.sampler.setVolume(x) })),
      R(knob({ label: 'MIC', min: 0, max: 1, def: 0.7, bipolar: false, get: () => eng.micVolume ?? 0.7, set: (x) => eng.setMicVolume(x), size: 'xs', title: 'Mic level' }))),
    el('div', { class: 'mic-box' },
      R(button('MIC', { cls: 'xs mic-on', click: () => app.toggleMic(), active: () => eng.micOn, title: 'Microphone / aux input on/off' })),
      R(button('TALK', { cls: 'xs talk', click: () => eng.setTalkover(!eng.talkover), active: () => eng.talkover, title: 'Talkover: duck the music while you speak' }))),
    el('div', { class: 'm-setup' }),
  );
  const xfader = R(fader({ min: -1, max: 1, def: 0, get: () => eng.crossfader, set: (x) => eng.setCrossfader(x), horizontal: true, cls: 'crossfader', title: 'Crossfader' }));
  // personality switches wait while a fast-cut crossfader is held mid-scratch
  xfader.addEventListener('pointerdown', () => { eng.xfTouched = true; });
  for (const ev of ['pointerup', 'pointercancel']) xfader.addEventListener(ev, () => { eng.xfTouched = false; });
  const revBtn = el('button', { class: 'btn xs xf-rev mxv v-rev', title: 'Crossfader reverse (hamster)', 'aria-pressed': 'false', onclick: () => updateMixer(app, { xfReverse: !eng.mx.xfReverse }) }, 'REV');
  revBtn.render = () => { revBtn.classList.toggle('active', !!eng.mx.xfReverse); revBtn.setAttribute('aria-pressed', String(!!eng.mx.xfReverse)); };
  // Smart Fader (midi/controller-extras.js): the crossfader alone blends BPM, bass and levels; Shift-click: 16-beat auto transition
  const smartXf = R(button('SMART', { cls: 'xs smart-xf', click: (e) => (e.shiftKey || app.shift ? smartAutoTransition(app) : setSmartFader(app, !app.ctl?.smartFader)), active: () => !!(app.ctl?.smartFader || app.ctl?.auto), title: 'Smart Fader: the crossfader alone blends the two decks (BPM morph and bass swap). Shift-click: automatic beat-synced 16-beat transition' }));
  window.addEventListener('opendj-ctl', () => smartXf.render());
  let applyingEqPreset = false;
  const eqPreset = el('select', { class: 'sel tiny mixer-eq-preset', title: 'Tone: set the EQ knobs of all decks to a starting point', 'aria-label': 'EQ knob tone preset (all decks)' },
    ...EQ_PRESETS.map((p) => el('option', { value: p.id }, p.label)));
  // the preset that matches every channel's EQ, else Custom
  const eqPresetFor = () => (EQ_PRESETS.find((p) => p.values && eng.channels.every((ch) => ['eqLow', 'eqMid', 'eqHigh'].every((k, j) => Math.abs((ch.state[k] || 0) - p.values[j]) < 1e-6)))?.id || 'custom');
  eqPreset.value = eqPresetFor();
  eqPreset.addEventListener('change', () => {
    const preset = EQ_PRESETS.find((p) => p.id === eqPreset.value);
    if (!preset?.values) return;
    applyingEqPreset = true;
    for (const channel of eng.channels) ['eqLow', 'eqMid', 'eqHigh'].forEach((key, i) => channel.set(key, preset.values[i]));
    applyingEqPreset = false;
    eqPreset.value = preset.id;
  });
  // crossfader curve presets (the continuous curve, cut-in and cut time are next to it in the drawer)
  const CURVES = [['0', 'Linear', { xfCurve: 0, xfCutIn: 0 }], ['0.5', 'Smooth', { xfCurve: 0.5, xfCutIn: 0 }], ['0.9', 'Scratch', { xfCurve: 0.9, xfCutIn: 0 }], ['1', 'Fast cut', { xfCurve: 1, xfCutIn: 0.02 }]];
  const curveSel = el('select', { class: 'sel tiny mixer-curve', title: 'Crossfader curve', 'aria-label': 'Crossfader curve' },
    ...CURVES.map(([x, l]) => el('option', { value: x }, l)), el('option', { value: 'custom', disabled: true }, 'Custom'));
  const renderCurve = () => { const m = eng.mx, hit = CURVES.find(([, , p]) => Math.abs(p.xfCurve - m.xfCurve) < 1e-3 && Math.abs(p.xfCutIn - m.xfCutIn) < 1e-3); curveSel.value = hit ? hit[0] : 'custom'; };
  renderCurve();
  curveSel.addEventListener('change', () => { const c = CURVES.find(([x]) => x === curveSel.value); if (c) updateMixer(app, c[2]); });
  const colorSel = el('select', { class: 'sel tiny mixer-color', title: 'Color FX: what the filter knobs do', 'aria-label': 'Color FX (all channels)' },
    ...COLOR_FX.map(([x, l]) => el('option', { value: x }, l)));
  colorSel.value = app.settings.colorFx || 'filter';
  colorSel.addEventListener('change', () => { for (const ch of eng.channels) ch.set('colorFx', colorSel.value); app.setSetting('colorFx', colorSel.value); });
  const eqModel = el('select', { class: 'sel tiny mixer-eq-model', title: 'EQ preset: how the channel EQs behave', 'aria-label': 'Mixer EQ preset' },
    ...EQ_MODEL_LIST.map((p) => el('option', { value: p.id }, p.label)));
  eqModel.value = eng.mx.eqType;
  eqModel.addEventListener('change', () => updateMixer(app, { eqType: eqModel.value }));
  const advBtn = el('button', { class: 'btn xs mixer-adv-btn', title: 'Mixer setup: EQ preset, Color FX, curves, booth, mic, FX units, loudness', 'aria-label': 'Mixer setup', 'aria-expanded': 'false', onclick: () => root.toggleDrawer?.() }, '⚙');
  master.querySelector('.m-setup').append(revBtn, smartXf, advBtn);
  // rotary personality: master isolator and warmth in a row at the bottom (where the crossfader it hides would be)
  const bar2 = el('div', { class: 'mixer-bar mixer-bar2 mxv v-iso' },
    R(knob({ label: 'ISO LO', size: 'xs', title: 'Master isolator low', get: () => eng.iso.low, set: (x) => eng.setMasterIso('low', x) })),
    R(knob({ label: 'ISO MID', size: 'xs', title: 'Master isolator mid', get: () => eng.iso.mid, set: (x) => eng.setMasterIso('mid', x) })),
    R(knob({ label: 'ISO HI', size: 'xs', title: 'Master isolator high', get: () => eng.iso.high, set: (x) => eng.setMasterIso('high', x) })),
    v('v-warm', R(knob({ label: 'WARMTH', min: 0, max: 1, def: 0, bipolar: false, size: 'xs', title: 'Warmth (2nd-harmonic saturation)', get: () => eng.warmth, set: (x) => eng.setWarmth(x) }))));
  const root = el('section', { class: 'mixer mx2' },
    el('div', { class: 'mixer-top' }, stripsWrap, master),
    bar2,
    el('div', { class: 'xfader-row' },
      el('div', { class: 'xfader-control' }, el('span', { class: 'xf-l' }, 'A'), xfader, el('span', { class: 'xf-l' }, 'B')),
    ),
  );
  // advanced drawer (closed by default) and the personality suggestion chip
  const drawer = buildDrawer(app, root);
  root.append(drawer.el);
  // setup menus behind the gear: EQ preset, Color FX and tone (Channel tab), crossfader curve (Faders tab)
  const eqSec = drawer.panes.channel.querySelector('.adv-sec'), row = (l, c) => el('label', { class: 'adv-row' }, el('span', { class: 'adv-lbl' }, l), c);
  eqSec.querySelector('.adv-row')?.replaceWith(row('EQ preset', eqModel));
  eqSec.append(row('Color FX (all channels)', colorSel), row('Tone (EQ knobs, all decks)', eqPreset));
  drawer.panes.faders.querySelector('.adv-sec').insertBefore(row('Curve preset', curveSel), drawer.panes.faders.querySelector('.adv-sec .adv-knobs'));
  root.toggleDrawer = (on, tab) => drawer.toggle(on, tab);
  const chip = el('div', { class: 'mixer-chip', hidden: true, role: 'status' });
  root.append(chip);
  let suggestion = null, undoTo = null;
  const dismissKey = () => `opendj-mixer-suggest-${app.automix?.playlistId || app.automix?.queue?.map((t) => t.id).slice(0, 3).join(',') || 'queue'}`;
  const refreshChip = () => {
    if (undoTo) return;
    const onAir = eng.decks.some((d, i) => d.playing && eng.channels[i].state.volume > 0.05);
    let dismissed = false; try { dismissed = !!localStorage.getItem(dismissKey()); } catch { /* */ }
    suggestion = !onAir && !dismissed ? suggestPersonality(app.automix?.queue || [], eng.mx.personality) : null;
    chip.hidden = !suggestion;
    if (suggestion) chip.replaceChildren(
      el('button', { class: 'btn xs chip-apply', title: 'Apply (tap again to undo)', onclick: () => { undoTo = eng.mx.personality; setPersonality(app, suggestion.id); chip.replaceChildren(el('span', {}, `${PERSONALITIES[suggestion.id].label} mixer on.`), el('button', { class: 'btn xs', onclick: () => { setPersonality(app, undoTo); undoTo = null; chip.hidden = true; } }, 'Undo'), el('button', { class: 'btn xs', 'aria-label': 'Close', onclick: () => { undoTo = null; chip.hidden = true; } }, '✕')); } }, suggestion.text),
      el('button', { class: 'btn xs', title: "Don't suggest for this playlist", 'aria-label': "Don't suggest for this playlist", onclick: () => { try { localStorage.setItem(dismissKey(), '1'); } catch { /* */ } chip.hidden = true; } }, '✕'));
  };
  app.automix?.on?.('state', () => {
    const drive = !!app.automix.enabled;
    if (eng.automixDriving !== drive) { eng.automixDriving = drive; for (const c of eng.channels) c.apply(); } // automix fades on the club fader law
    refreshChip();
  });
  /** Root classes for the personality / config variants (Club: none of them, today's look). */
  const applyVariants = () => {
    const m = eng.mx, t = m.eqType;
    const cls = { 'mx-rotary': m.rotary && !document.documentElement.classList.contains('compact'), 'mx-dual': m.filterMode === 'dual', 'mx-eq4': t === 'fourBand', 'mx-sculpt': t === 'sculpt', 'mx-comp': m.showComp, 'mx-noxf': m.hideXfader, 'mx-rev': m.revVisible || m.xfReverse, 'mx-iso': m.showMasterIso, 'mx-warm': m.showWarmth, 'mx-booth': m.showBooth, 'mx-nocolor': m.colorHidden, [`mx-p-${m.personality}`]: true };
    for (const c of [...root.classList]) if (/^mx-p-/.test(c)) root.classList.remove(c);
    for (const [c, on] of Object.entries(cls)) root.classList.toggle(c, !!on);
    revBtn.render();
  };
  eng.on('mixer-config', () => { applyVariants(); requestAnimationFrame(() => fit(lastH, lastW, true)); });
  applyVariants();
  eng.on('mixer-config', () => { renderCurve(); eqModel.value = eng.mx.eqType; });

  // only an EQ change makes the preset "Custom" (not a volume / filter / FX move, nor automix's per-frame fades)
  const EQ_KEYS = new Set(['eqLow', 'eqMid', 'eqHigh']);
  eng.on('mixer', (i, key) => { for (const r of byCh[i] || renderers) r.render(); if (!applyingEqPreset && EQ_KEYS.has(key)) eqPreset.value = eqPresetFor(); });
  eng.on('master', () => { for (const r of renderers) r.render(); });
  window.addEventListener('opendj-theme', () => requestAnimationFrame(() => fit(lastH, lastW, true)));
  eng.on('mic', () => { for (const r of renderers) r.render(); });
  let lastW = 0, lastH = 0;
  const shown = (e) => e.style.display !== 'none' && getComputedStyle(e).display !== 'none';
  /**
   * Knob size from the strip size: two knob rows (TRIM / FILTER, then the EQ) with labels under the knobs; the channel
   * fader keeps at least 50 % of the strip (including its cap), and a knob is never wider than its share of the row.
   * VOC / INST only show when there is room (also in the drawer).
   */
  const fitKnobs = () => {
    if (document.documentElement.classList.contains('compact')) { root.style.setProperty('--kn', '26px'); root.classList.remove('mx-nostems'); return; }
    const s = strips.find((x) => x.style.display !== 'none'); const H = s?.clientHeight, W = s?.clientWidth; if (!H) return;
    // very short strips: CUE shares the assign row and TRIM moves to the drawer (Channel tab)
    const tight = H < 360, tiny = H < 290, gap = tight ? 1 : 3, fixed = tiny ? 10 + 18 + 8 : tight ? 10 + 18 + 18 + 8 : 12 + 22 + 20 + 9;
    const four = document.body.classList.contains('four-decks'), LBL = 10;
    root.classList.toggle('mx-tight', tight); root.classList.toggle('mx-tiny2', tiny);
    const n = Math.max(1, ...[...s.querySelectorAll(':scope > .kn-row')].map((r) => [...r.children].filter(shown).length));
    const byW = (W - (four ? 8 : 16) - (n - 1) * (four ? 10 : 15)) / n; // the value ring is drawn 4 px outside each knob: 15 px apart leaves ~7 px between rings
    const per = (rows) => (H - fixed - 0.5 * H - (rows + 4) * gap) / rows - LBL;
    const stems = !four && per(3) >= 28, r = stems ? per(3) : per(2);
    const max = four ? 24 : 32;
    root.style.setProperty('--kn', `${Math.max(12, Math.min(max, Math.floor(Math.min(r, byW))))}px`);
    root.classList.toggle('mx-nostems', !stems);
    for (const st of strips) { // very short: CUE beside the crossfader assign under the fader
      if (tiny && st.cueBtn.parentNode !== st.foot) st.foot.prepend(st.cueBtn);
      else if (!tiny && st.cueBtn.parentNode === st.foot) st.faderRow.before(st.cueBtn);
    }
  };
  const fit = (h, w = lastW, force = false) => {
    if (!force && Math.abs(h - lastH) < 0.5 && Math.abs(w - lastW) < 0.5) return; // (no re-layout loop from our own moves)
    // wide strips: wider meters and fader caps
    const vis = strips.filter((x) => x.style.display !== 'none').length || 2;
    const sw = (w - 16 - 92 - 6 * vis) / vis, has = (c) => root.classList.contains(c);
    root.classList.toggle('mx-w1', has('mx-w1') ? sw >= 80 : sw >= 88); root.classList.toggle('mx-w2', has('mx-w2') ? sw >= 118 : sw >= 128);
    lastW = w; lastH = h;
    fitKnobs();
  };
  new ResizeObserver((ents) => { const e = ents[0], b = e.contentBoxSize?.[0]; fit(b?.blockSize ?? e.contentRect.height, b?.inlineSize ?? e.contentRect.width); }).observe(root);
  root.setDeckCount = (n) => { for (const s of strips) s.style.display = s.idx < n ? '' : 'none'; requestAnimationFrame(() => fit(lastH, lastW, true)); };
  let masterQuiet = 0;
  root.frame = () => {
    let anyActive = eng.micOn || !!eng.sampler?.playing || eng.decks.some((d) => d.playing || d.scratching);
    for (const s of strips) {
      if (s.style.display === 'none') continue;
      const d = eng.decks[s.idx];
      const chBusy = d?.playing || d?.scratching || s.ch.state.fxOn;
      if (!chBusy && s._vuQuiet > 30) continue; // VU already decayed to 0 on a stopped channel: skip AnalyserNode read & canvas draw
      const lvl = s.ch.level();
      s._vuQuiet = (!chBusy && lvl < 1e-4) ? (s._vuQuiet || 0) + 1 : 0;
      if (lvl >= 1e-4) anyActive = true;
      s.vu.draw(lvl);
    }
    if (anyActive || masterQuiet <= 30) {
      const m = eng.masterMeter();
      const silent = !anyActive && m.peak[0] < 1e-4 && m.peak[1] < 1e-4;
      masterQuiet = silent ? masterQuiet + 1 : 0;
      mvuL.draw(m.peak[0], undefined, m.rms[0]); mvuR.draw(m.peak[1], undefined, m.rms[1]); mpkL.draw(m.peak[0]); mpkR.draw(m.peak[1]);
    }
    const gr = eng.limiterGr() < 0.98; if (gr !== grLed._on) { grLed._on = gr; grLed.classList.toggle('on', gr); }
  };
  root.renderAll = () => { for (const r of renderers) r.render(); };
  window.opendjMixer = { setPersonality: (id) => setPersonality(app, id), toggleDrawer: (on, tab) => drawer.toggle(on, tab), refreshChip };
  return root;
}
