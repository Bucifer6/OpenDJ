import { el, uiZoom } from '../util.js';
import { knob, fader, button } from './controls.js';
import { DECK_COLORS } from './deck-ui.js';
import { cssVar } from './themes.js';

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
  c.draw = (peak, now = performance.now()) => {
    if (dirty) {
      dirty = false;
      const r = box || c.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      const W = Math.max(2, Math.round(r.width * dpr)), H = Math.max(10, Math.round(r.height * dpr));
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; sig = ''; }
    }
    const dt = Math.min(0.1, lastT ? (now - lastT) / 1000 : 0); lastT = now;
    const db = 20 * Math.log10(peak + 1e-9);
    const k = Math.max(0, Math.min(1, (db + 48) / 51)); // -48..+3 dB
    level = k >= level ? k : Math.max(k, level - dt * 24 / 51);
    if (level >= held) { held = level; heldT = now; } else if (now - heldT > 1000) held = Math.max(level, held - dt * 0.6);
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
  const EQ_PRESETS = [
    { id: 'flat', label: 'Flat EQ', values: [0, 0, 0] },
    { id: 'warm', label: 'Warm', values: [0.12, -0.04, -0.08] },
    { id: 'bright', label: 'Bright', values: [-0.08, 0.04, 0.16] },
    { id: 'vocal', label: 'Vocal focus', values: [-0.12, 0.16, 0.08] },
    { id: 'bass-light', label: 'Bass light', values: [-0.22, 0.05, 0.1] },
    { id: 'custom', label: 'Custom', values: null },
  ];
  const order = [2, 0, 1, 3]; // 4-deck layout: 3 1 2 4
  let mcBtn = null;
  const stripsWrap = el('div', { class: 'mixer-strips' });

  for (const i of order) {
    cur = byCh[i] = [];
    const ch = eng.channels[i];
    const S = (k) => ({ get: () => ch.state[k], set: (v) => ch.set(k, v) });
    const vu = vuMeter();
    const xf = el('div', { class: 'xf-assign' }, ...['A', 'THRU', 'B'].map((a) => {
      const b = button(a === 'THRU' ? 'T' : a, { cls: 'xs', click: () => ch.set('xfAssign', a), active: () => ch.state.xfAssign === a, title: `Crossfader assign: ${a}` });
      return R(b);
    }));
    const strip = el('div', { class: 'strip', 'data-ch': i, style: { '--deck-color': DECK_COLORS[i] } },
      el('div', { class: 'strip-num' }, String(i + 1)),
      R(knob({ label: 'TRIM', ...S('trim'), def: 0, size: 'sm', format: (v) => `${v >= 0 ? '+' : ''}${(v * 12).toFixed(1)}dB` })),
      R(knob({ label: 'HI', ...S('eqHigh'), def: 0, size: 'sm', title: 'High EQ (fully left = kill)' })),
      R(knob({ label: 'MID', ...S('eqMid'), def: 0, size: 'sm' })),
      R(knob({ label: 'LOW', ...S('eqLow'), def: 0, size: 'sm' })),
      R(knob({ label: 'FILTER', ...S('filter'), def: 0, size: 'md', title: 'Filter / Color FX amount. Left: low-pass, right: high-pass' })),
      el('div', { class: 'stem-knobs' },
        R(knob({ label: 'VOC', min: 0, max: 1, def: 1, bipolar: false, ...S('vocal'), size: 'xs', title: 'Quick stems: vocal level (DSP centre-channel estimate)' })),
        R(knob({ label: 'INST', min: 0, max: 1, def: 1, bipolar: false, ...S('inst'), size: 'xs', title: 'Quick stems: instrumental level' }))),
      R(button('CUE', { cls: 'btn-pfl', click: () => ch.set('cue', !ch.state.cue), active: () => ch.state.cue, title: 'Headphone cue (PFL)' })),
      el('div', { class: 'fader-row' }, R(fader({ ...S('volume'), def: 0.8, cls: 'ch-fader' })), vu),
      xf,
    );
    strip.vu = vu; strip.ch = ch; strip.idx = i;
    strips.push(strip); stripsWrap.append(strip);
    cur = null;
  }

  // master section
  const mvuL = vuMeter(), mvuR = vuMeter();
  const master = el('div', { class: 'mixer-master' },
    el('div', { class: 'strip-num' }, 'MASTER'),
    el('div', { class: 'master-vu' }, mvuL, mvuR),
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
  const xfader = R(fader({ min: -1, max: 1, def: 0, get: () => eng.crossfader, set: (v) => eng.setCrossfader(v), horizontal: true, cls: 'crossfader', title: 'Crossfader' }));
  let applyingEqPreset = false;
  const eqPreset = el('select', { class: 'sel tiny mixer-eq-preset', title: 'Apply a channel EQ preset to all decks', 'aria-label': 'Mixer EQ preset' },
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

  const curveSel = el('select', { class: 'sel tiny', title: 'Crossfader curve' },
    el('option', { value: 'smooth' }, 'Smooth'), el('option', { value: 'constant' }, 'Linear'), el('option', { value: 'sharp' }, 'Scratch'));
  curveSel.value = app.settings.crossfaderCurve;
  curveSel.addEventListener('change', () => { app.setSetting('crossfaderCurve', curveSel.value); eng.applyCrossfader(); });

  const colorSel = el('select', { class: 'sel tiny', title: 'Color FX: what the filter knobs do' },
    ...[['filter', 'Filter'], ['space', 'Space'], ['dubecho', 'Dub Echo'], ['noise', 'Noise'], ['crush', 'Crush'], ['pitch', 'Jet']].map(([v, l]) => el('option', { value: v }, l)));
  colorSel.value = app.settings.colorFx || 'filter';
  colorSel.addEventListener('change', () => { for (const ch of eng.channels) ch.set('colorFx', colorSel.value); app.setSetting('colorFx', colorSel.value); });
  const root = el('section', { class: 'mixer' },
    el('div', { class: 'mixer-top' }, stripsWrap, master),
    el('div', { class: 'xfader-row' },
      el('div', { class: 'xfader-options' }, eqPreset, colorSel, curveSel),
      el('div', { class: 'xfader-control' }, el('span', { class: 'xf-l' }, 'A'), xfader, el('span', { class: 'xf-l' }, 'B')),
    ),
  );

  // only an EQ change makes the preset "Custom" (not a volume / filter / FX move, nor automix's per-frame fades)
  const EQ_KEYS = new Set(['eqLow', 'eqMid', 'eqHigh']);
  eng.on('mixer', (i, key) => { for (const r of byCh[i] || renderers) r.render(); if (!applyingEqPreset && EQ_KEYS.has(key)) eqPreset.value = eqPresetFor(); });
  eng.on('master', () => { for (const r of renderers) r.render(); });
  app.dedications?.on('change', () => { mcBtn?.render?.(); mcBtn?.setAttribute('data-count', String(app.dedications.pending() || '')); });
  eng.on('mic', () => { for (const r of renderers) r.render(); });
  // compact strips when the layout leaves the mixer little height (.mx-short / .mx-400 / .mx-tiny in performance.css);
  // phones stack the mixer at its natural height, so only desktop / tablet grids use this
  const desk = matchMedia('(min-width: 700px) and (min-height: 561px)');
  const fit = (h) => { const on = desk.matches; root.classList.toggle('mx-short', on && h <= 470); root.classList.toggle('mx-400', on && h <= 400); root.classList.toggle('mx-tiny', on && h <= 330); };
  new ResizeObserver((ents) => fit(ents[0].contentBoxSize?.[0]?.blockSize ?? ents[0].contentRect.height)).observe(root);
  desk.addEventListener?.('change', () => fit(root.getBoundingClientRect().height / (parseFloat(document.documentElement.style.zoom) || 1)));
  root.setDeckCount = (n) => { for (const s of strips) s.style.display = s.idx < n ? '' : 'none'; };
  root.frame = () => {
    for (const s of strips) if (s.style.display !== 'none') s.vu.draw(s.ch.level());
    const [l, r] = eng.masterLevels(); mvuL.draw(l); mvuR.draw(r);
  };
  root.renderAll = () => { for (const r of renderers) r.render(); };
  return root;
}
