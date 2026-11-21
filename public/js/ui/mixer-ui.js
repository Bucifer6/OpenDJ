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

/**
 * Segmented LED meter. Meter ballistics like hardware: instant attack, ~24 dB/s release, a peak-hold segment that
 * stays 1 s then falls. Sized from a ResizeObserver (no layout reads per frame) and redrawn only when a lit
 * segment changes, so idle channels cost nothing.
 */
function vuMeter() {
  const c = el('canvas', { class: 'vu', width: 8, height: 120 });
  const g = c.getContext('2d');
  const SEGS = 20;
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
      const col = i >= SEGS - 2 ? cssVar('--meter-clip') : i >= SEGS - 6 ? cssVar('--meter-hot') : cssVar('--meter-ok');
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
  let mcBtn = null;
  const stripsWrap = el('div', { class: 'mixer-strips' });

  for (const i of order) {
    cur = byCh[i] = [];
    const ch = eng.channels[i];
    const S = (k) => ({ get: () => ch.state[k], set: (v) => ch.set(k, v) });
    const vu = vuMeter();
    // Center Lock (M4): a drag from one side stops at 12 o'clock; the next drag can cross
    const lock = centerLock({ mode: 'drag' });
    const filterKnob = R(knob({ label: 'FILTER', get: () => ch.state.filter, set: (x) => ch.controlSet('filter', x, lock), def: 0, size: 'md', title: 'Filter / Color FX amount. Left: low-pass, right: high-pass' }));
    filterKnob.addEventListener('pointerdown', () => lock.reset(), true);
    const xf = el('div', { class: 'xf-assign' }, ...['A', 'THRU', 'B'].map((a) => {
      const b = button(a === 'THRU' ? 'T' : a, { cls: 'xs', click: () => ch.set('xfAssign', a), active: () => ch.state.xfAssign === a, title: `Crossfader assign: ${a}` });
      return R(b);
    }));
    const strip = el('div', { class: 'strip', 'data-ch': i, style: { '--deck-color': DECK_COLORS[i] } },
      el('div', { class: 'strip-num' }, String(i + 1)),
      R(knob({ label: 'TRIM', ...S('trim'), def: 0, size: 'sm', format: (v) => `${v >= 0 ? '+' : ''}${(v * 12).toFixed(1)}dB` })),
      R(knob({ label: 'HI', ...S('eqHigh'), def: 0, size: 'sm', title: 'High EQ (fully left = kill)' })),
      v('v-mid', R(knob({ label: 'MID', ...S('eqMid'), def: 0, size: 'sm' }))),
      v('v-eq4', R(knob({ label: 'MID-HI', ...S('eqMidHigh'), def: 0, size: 'sm', title: '4-band EQ: mid-high' }))),
      v('v-eq4', R(knob({ label: 'MID-LO', ...S('eqMidLow'), def: 0, size: 'sm', title: '4-band EQ: mid-low' }))),
      v('v-sculpt', R(knob({ label: 'FREQ', min: 0, max: 1, def: 0.5, bipolar: false, ...S('eqFreq'), size: 'sm', title: 'Sculpt EQ frequency (70 Hz - 7 kHz)', format: (x) => { const f = 70 * Math.pow(100, x); return f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`; } }))),
      R(knob({ label: 'LOW', ...S('eqLow'), def: 0, size: 'sm' })),
      v('v-filter', filterKnob),
      v('v-dual', R(knob({ label: 'HP', min: 0, max: 1, def: 0, bipolar: false, ...S('filterHp'), size: 'sm', title: 'High-pass (cut only)' }))),
      v('v-dual', R(knob({ label: 'LP', min: 0, max: 1, def: 0, bipolar: false, ...S('filterLp'), size: 'sm', title: 'Low-pass (cut only)' }))),
      v('v-comp', R(knob({ label: 'COMP', min: 0, max: 1, def: 0, bipolar: false, ...S('comp'), size: 'sm', title: 'One-knob compressor' }))),
      el('div', { class: 'stem-knobs' },
        R(knob({ label: 'VOC', min: 0, max: 1, def: 1, bipolar: false, ...S('vocal'), size: 'xs', title: 'Quick stems: vocal level (DSP centre-channel estimate)' })),
        R(knob({ label: 'INST', min: 0, max: 1, def: 1, bipolar: false, ...S('inst'), size: 'xs', title: 'Quick stems: instrumental level' }))),
      R(button('CUE', { cls: 'btn-pfl', click: () => ch.set('cue', !ch.state.cue), active: () => ch.state.cue, title: 'Headphone cue (PFL)' })),
      el('div', { class: 'fader-row' }, v('v-fader', R(fader({ ...S('volume'), def: 0.8, cls: 'ch-fader' }))), v('v-rotary', R(knob({ label: 'LEVEL', min: 0, max: 1, def: 0.8, bipolar: false, ...S('volume'), size: 'lg', title: 'Channel level (rotary: -inf .. +6 dB)' }))), vu),
      xf,
    );
    strip.vu = vu; strip.ch = ch; strip.idx = i;
    strips.push(strip); stripsWrap.append(strip);
    cur = null;
  }

  // master section: RMS bar + peak dot meters, limiter gain-reduction LED
  const mvuL = vuMeter(), mvuR = vuMeter();
  const grLed = el('span', { class: 'gr-led', title: 'Limiter gain reduction' });
  const master = el('div', { class: 'mixer-master' },
    el('div', { class: 'strip-num' }, 'MASTER'),
    el('div', { class: 'master-vu' }, mvuL, mvuR, grLed),
    v('v-iso', el('div', { class: 'master-iso' },
      R(knob({ label: 'ISO LO', size: 'sm', title: 'Master isolator low', get: () => eng.iso.low, set: (x) => eng.setMasterIso('low', x) })),
      R(knob({ label: 'ISO MID', size: 'sm', title: 'Master isolator mid', get: () => eng.iso.mid, set: (x) => eng.setMasterIso('mid', x) })),
      R(knob({ label: 'ISO HI', size: 'sm', title: 'Master isolator high', get: () => eng.iso.high, set: (x) => eng.setMasterIso('high', x) })))),
    v('v-warm', R(knob({ label: 'WARMTH', min: 0, max: 1, def: 0, bipolar: false, size: 'sm', title: 'Warmth (2nd-harmonic saturation)', get: () => eng.warmth, set: (x) => eng.setWarmth(x) }))),
    v('v-booth', R(knob({ label: 'BOOTH', min: 0, max: 1, def: 0.8, bipolar: false, size: 'sm', title: 'Booth level', get: () => eng.boothVolume, set: (x) => { eng.ensureBooth(); eng.setBoothVolume(x); } }))),
    R(knob({ label: 'MASTER', min: 0, max: 1, def: 0.8, get: () => eng.masterVolume ?? 0.8, set: (v) => eng.setMasterVolume(v) })),
    R(knob({ label: 'CUE/MST', min: 0, max: 1, def: 0, bipolar: false, get: () => eng.cueMix ?? 0, set: (v) => eng.setCueMix(v), size: 'sm', title: 'Headphone mix: cue ↔ master' })),
    R(knob({ label: 'PHONES', min: 0, max: 1, def: 0.8, get: () => eng.hpVolume ?? 0.8, set: (v) => eng.setHeadphoneVolume(v), size: 'sm' })),
    R(knob({ label: 'SAMPLER', min: 0, max: 1, def: 0.8, get: () => eng.sampler.out.gain.value, set: (v) => eng.sampler.setVolume(v), size: 'sm' })),
    el('div', { class: 'mic-box' },
      R(button('MIC', { cls: 'xs mic-on', click: () => app.toggleMic(), active: () => eng.micOn, title: 'Microphone / aux input on/off' })),
      R(knob({ label: 'MIC', min: 0, max: 1, def: 0.7, bipolar: false, get: () => eng.micVolume ?? 0.7, set: (v) => eng.setMicVolume(v), size: 'sm' })),
      R(button('TALK', { cls: 'xs talk', click: () => eng.setTalkover(!eng.talkover), active: () => eng.talkover, title: 'Talkover: duck the music while you speak' })),
      (mcBtn = R(button('MC', { cls: 'xs mc-btn', click: () => app.dedications?.open(), active: () => !!app.dedications?.current, title: 'Dedication: a short message spoken over the mix at the next phrase (English or Romanian), with the music ducked' })))),
  );
  const xfader = R(fader({ min: -1, max: 1, def: 0, get: () => eng.crossfader, set: (x) => eng.setCrossfader(x), horizontal: true, cls: 'crossfader', title: 'Crossfader' }));
  // personality switches wait while a fast-cut crossfader is held mid-scratch
  xfader.addEventListener('pointerdown', () => { eng.xfTouched = true; });
  for (const ev of ['pointerup', 'pointercancel']) xfader.addEventListener(ev, () => { eng.xfTouched = false; });
  const revBtn = el('button', { class: 'btn xs xf-rev mxv v-rev', title: 'Crossfader reverse (hamster)', 'aria-pressed': 'false', onclick: () => updateMixer(app, { xfReverse: !eng.mx.xfReverse }) }, 'REV');
  revBtn.render = () => { revBtn.classList.toggle('active', !!eng.mx.xfReverse); revBtn.setAttribute('aria-pressed', String(!!eng.mx.xfReverse)); };
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

  // crossfader curve presets (the continuous curve, cut-in and cut time live in the advanced drawer)
  const CURVES = [['0', 'Linear', { xfCurve: 0, xfCutIn: 0 }], ['0.5', 'Smooth', { xfCurve: 0.5, xfCutIn: 0 }], ['0.9', 'Scratch', { xfCurve: 0.9, xfCutIn: 0 }], ['1', 'Fast cut', { xfCurve: 1, xfCutIn: 0.02 }]];
  const curveSel = el('select', { class: 'sel tiny mixer-curve', title: 'Crossfader curve', 'aria-label': 'Crossfader curve' },
    ...CURVES.map(([v, l]) => el('option', { value: v }, l)), el('option', { value: 'custom', disabled: true }, 'Custom'));
  const renderCurve = () => { const m = eng.mx, hit = CURVES.find(([, , p]) => Math.abs(p.xfCurve - m.xfCurve) < 1e-3 && Math.abs(p.xfCutIn - m.xfCutIn) < 1e-3); curveSel.value = hit ? hit[0] : 'custom'; };
  renderCurve();
  curveSel.addEventListener('change', () => { const c = CURVES.find(([v]) => v === curveSel.value); if (c) updateMixer(app, c[2]); });

  const colorSel = el('select', { class: 'sel tiny mixer-color', title: 'Color FX: what the filter knobs do', 'aria-label': 'Color FX' },
    ...COLOR_FX.map(([v, l]) => el('option', { value: v }, l)));
  colorSel.value = app.settings.colorFx || 'filter';
  colorSel.addEventListener('change', () => { for (const ch of eng.channels) ch.set('colorFx', colorSel.value); app.setSetting('colorFx', colorSel.value); });
  const advBtn = el('button', { class: 'btn xs mixer-adv-btn', title: 'Advanced mixer: EQ type, faders, booth, mic, FX units, loudness', 'aria-label': 'Advanced mixer', 'aria-expanded': 'false', onclick: () => root.toggleDrawer?.() }, '⚙');
  // setup dropdowns: in the MASTER column's free space, or (when it has none) a compact row above the crossfader
  // EQ preset: the EQ model (isolator / classic / 4-band / rotary / battle / vintage / sculpt), per personality by default
  const eqModel = el('select', { class: 'sel tiny mixer-eq-model', title: 'EQ preset: how the channel EQs behave (modelled on club, rotary and battle mixers)', 'aria-label': 'Mixer EQ preset' },
    ...EQ_MODEL_LIST.map((p) => el('option', { value: p.id }, `EQ: ${p.label}`)));
  eqModel.value = eng.mx.eqType;
  eqModel.addEventListener('change', () => updateMixer(app, { eqType: eqModel.value }));
  const tools = el('div', { class: 'mixer-tools' }, el('div', { class: 'mixer-tools-pair' }, eqModel, advBtn), el('div', { class: 'mixer-tools-pair' }, colorSel, curveSel, revBtn));
  master.append(tools);
  const toolsRow = el('div', { class: 'mixer-tools-row' });
  const root = el('section', { class: 'mixer' },
    el('div', { class: 'mixer-top' }, stripsWrap, master),
    toolsRow,
    el('div', { class: 'xfader-row' },
      el('div', { class: 'xfader-control' }, el('span', { class: 'xf-l' }, 'A'), xfader, el('span', { class: 'xf-l' }, 'B')),
    ),
  );
  // advanced drawer (closed by default) and the personality suggestion chip
  const drawer = buildDrawer(app, root);
  root.append(drawer.el);
  // the tone presets (EQ knob starting points for all decks) live in the drawer's Channel tab
  drawer.panes.channel.querySelector('.adv-sec').append(el('label', { class: 'adv-row' }, el('span', { class: 'adv-lbl' }, 'Tone (EQ knobs, all decks)'), eqPreset));
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
  app.dedications?.on('change', () => { mcBtn?.render?.(); mcBtn?.setAttribute('data-count', String(app.dedications.pending() || '')); });
  eng.on('mic', () => { for (const r of renderers) r.render(); });
  // compact strips when the layout leaves the mixer little height (.mx-short / .mx-400 / .mx-tiny in performance.css);
  // phones stack the mixer at its natural height, so only desktop / tablet grids use this
  const desk = matchMedia('(min-width: 700px) and (min-height: 561px)');
  let lastW = 0, lastH = 0;
  /** The setup dropdowns go where there is room: MASTER's free space first, else the row above the crossfader. */
  const placeTools = () => {
    const toRow = () => { if (tools.parentNode !== toolsRow) toolsRow.append(tools); root.classList.add('tools-row'); };
    const body = document.body.classList;
    if (document.documentElement.classList.contains('compact') || master.clientWidth < 104 || body.contains('four-decks')) return toRow();
    // try MASTER (only moves the node when it is elsewhere), fall back to the row when it overflows
    if (tools.parentNode !== master) { master.append(tools); root.classList.remove('tools-row'); }
    if (master.scrollHeight > master.clientHeight + 1) toRow();
  };
  const fit = (h, w = lastW, force = false) => {
    if (!force && Math.abs(h - lastH) < 0.5 && Math.abs(w - lastW) < 0.5) return; // (no re-layout loop from our own moves)
    const on = desk.matches;
    root.classList.toggle('mx-short', on && h <= 470); root.classList.toggle('mx-400', on && h <= 400); root.classList.toggle('mx-tiny', on && h <= 330);
    // strips flex to fill the width; larger knobs, meters and fader caps when a strip is wide
    const vis = strips.filter((x) => x.style.display !== 'none').length || 2;
    // (a fixed MASTER estimate and hysteresis: the classes change knob / meter sizes, which must not feed back here)
    const mw = document.documentElement.classList.contains('compact') ? 84 : 118;
    const sw = (w - 16 - mw - 6 * vis) / vis, has = (c) => root.classList.contains(c);
    root.classList.toggle('mx-w1', has('mx-w1') ? sw >= 80 : sw >= 88); root.classList.toggle('mx-w2', has('mx-w2') ? sw >= 118 : sw >= 128);
    lastW = w; lastH = h;
    placeTools();
  };
  new ResizeObserver((ents) => { const e = ents[0], b = e.contentBoxSize?.[0]; fit(b?.blockSize ?? e.contentRect.height, b?.inlineSize ?? e.contentRect.width); }).observe(root);
  desk.addEventListener?.('change', () => fit(root.getBoundingClientRect().height / (parseFloat(document.documentElement.style.zoom) || 1)));
  root.setDeckCount = (n) => { for (const s of strips) s.style.display = s.idx < n ? '' : 'none'; requestAnimationFrame(() => fit(lastH, lastW, true)); };
  root.frame = () => {
    for (const s of strips) if (s.style.display !== 'none') s.vu.draw(s.ch.level());
    const m = eng.masterMeter(); mvuL.draw(m.peak[0], undefined, m.rms[0]); mvuR.draw(m.peak[1], undefined, m.rms[1]);
    const gr = eng.limiterGr() < 0.98; if (gr !== grLed._on) { grLed._on = gr; grLed.classList.toggle('on', gr); }
  };
  root.renderAll = () => { for (const r of renderers) r.render(); };
  window.opendjMixer = { setPersonality: (id) => setPersonality(app, id), toggleDrawer: (on, tab) => drawer.toggle(on, tab), refreshChip };
  return root;
}
