import { el } from '../util.js';
import { knob, fader, button } from './controls.js';
import { DECK_COLORS } from './deck-ui.js';

function vuMeter() {
  const c = el('canvas', { class: 'vu', width: 8, height: 120 });
  const g = c.getContext('2d');
  let held = 0, heldT = 0;
  c.draw = (peak) => {
    const H = c.height, W = c.width;
    const db = 20 * Math.log10(peak + 1e-9);
    const k = Math.max(0, Math.min(1, (db + 48) / 51)); // -48..+3 dB
    if (k > held || performance.now() - heldT > 900) { held = k; heldT = performance.now(); }
    g.fillStyle = '#0a0c0f'; g.fillRect(0, 0, W, H);
    const segs = 24;
    for (let s = 0; s < segs; s++) {
      const on = s / segs < k;
      const y = H - (s + 1) * (H / segs);
      const col = s >= segs - 2 ? '#ff3b4d' : s >= segs - 6 ? '#ffb020' : '#2ed47a';
      g.fillStyle = on ? col : 'rgba(255,255,255,0.05)';
      g.fillRect(0, y + 1, W, H / segs - 1.5);
    }
    g.fillStyle = '#fff'; g.fillRect(0, H - held * H, W, 1.5);
  };
  return c;
}

export function buildMixer(app) {
  const eng = app.engine;
  const strips = [];
  const renderers = [];
  const R = (c) => { renderers.push(c); return c; };
  const order = [2, 0, 1, 3]; // 4-deck layout: 3 1 2 4
  const stripsWrap = el('div', { class: 'mixer-strips' });

  for (const i of order) {
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
      R(knob({ label: 'FILTER', ...S('filter'), def: 0, size: 'md', title: 'Left: low-pass, right: high-pass' })),
      R(button('CUE', { cls: 'btn-pfl', click: () => ch.set('cue', !ch.state.cue), active: () => ch.state.cue, title: 'Headphone cue (PFL)' })),
      el('div', { class: 'fader-row' }, R(fader({ ...S('volume'), def: 0.8, cls: 'ch-fader' })), vu),
      xf,
    );
    strip.vu = vu; strip.ch = ch; strip.idx = i;
    strips.push(strip); stripsWrap.append(strip);
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
  );
  const xfader = R(fader({ min: -1, max: 1, def: 0, get: () => eng.crossfader, set: (v) => eng.setCrossfader(v), horizontal: true, cls: 'crossfader', title: 'Crossfader' }));
  const curveSel = el('select', { class: 'sel tiny', title: 'Crossfader curve' },
    el('option', { value: 'smooth' }, 'Smooth'), el('option', { value: 'constant' }, 'Linear'), el('option', { value: 'sharp' }, 'Scratch'));
  curveSel.value = app.settings.crossfaderCurve;
  curveSel.addEventListener('change', () => { app.setSetting('crossfaderCurve', curveSel.value); eng.applyCrossfader(); });

  const root = el('section', { class: 'mixer' },
    el('div', { class: 'mixer-top' }, stripsWrap, master),
    el('div', { class: 'xfader-row' }, el('span', { class: 'xf-l' }, 'A'), xfader, el('span', { class: 'xf-l' }, 'B'), curveSel),
  );

  eng.on('mixer', () => { for (const r of renderers) r.render(); });
  eng.on('master', () => { for (const r of renderers) r.render(); });
  root.setDeckCount = (n) => { for (const s of strips) s.style.display = s.idx < n ? '' : 'none'; };
  root.frame = () => {
    for (const s of strips) if (s.style.display !== 'none') s.vu.draw(s.ch.level());
    const [l, r] = eng.masterLevels(); mvuL.draw(l); mvuR.draw(r);
  };
  root.renderAll = () => { for (const r of renderers) r.render(); };
  return root;
}
