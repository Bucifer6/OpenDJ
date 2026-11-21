// Advanced mixer drawer (plan M18): closed by default, opened from the ⚙ button in the mixer. A panel over the
// mixer on desktop / tablet, a bottom sheet on phones. Tabs: Channel, Faders, Master, Mic, FX, Loudness, plus the
// personality selector in its header. Every control drives the engine / settings.mixer the same way the MIDI
// targets in midi/mixer-targets.js do. Keyboard: Escape closes, tabs are buttons with aria-selected.
import { el } from '../util.js';
import { knob, button } from './controls.js';
import { COLOR_FX, EFFECTS, BEAT_DIVISIONS, MIC_FX_LIST, SEND_FX } from '../audio/effects.js';
import { EQ_PRESETS } from '../audio/eq.js';
import { FADER_CURVES, FADER_CURVE_LABELS, xfGain } from '../audio/curves.js';
import { PERSONALITIES, PERSONALITY_IDS, applyPersonality, personalityState } from '../audio/personalities.js';
import { STRIP_DIVISIONS } from '../audio/fx-bus.js';
import { updateMixer } from './mixer-state.js';

const TABS = [['channel', 'Channel'], ['faders', 'Faders'], ['master', 'Master'], ['mic', 'Mic'], ['fx', 'FX'], ['loudness', 'Loudness']];
const fmtDb = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const fmtDiv = (b) => (b < 1 ? (b === 0.75 ? '3/4' : `1/${Math.round(1 / b)}`) : String(b));

export function setPersonality(app, id) {
  return applyPersonality(app.engine, id, { save: (m) => { app.setSetting('mixer', m); app.engine.settings.mixer = m; } });
}

export function buildDrawer(app, mixerRoot) {
  const eng = app.engine, renderers = [];
  const R = (c) => { renderers.push(c); return c; };
  const mx = () => eng.mx, set = (patch) => updateMixer(app, patch);
  const row = (label, ...ctl) => el('label', { class: 'adv-row' }, el('span', { class: 'adv-lbl' }, label), ...ctl);
  const select = (opts, get, onChange, title) => {
    const s = el('select', { class: 'sel tiny', 'aria-label': title, title }, ...opts.map(([v, l]) => el('option', { value: String(v) }, l)));
    s.render = () => { const v = String(get()); if (s.value !== v) s.value = v; };
    s.addEventListener('change', () => onChange(s.value)); s.render(); return R(s);
  };
  const toggle = (label, get, onClick, title) => R(button(label, { cls: 'xs adv-tgl', title: title || label, click: onClick, active: get }));
  const kn = (o) => R(knob({ size: 'sm', ...o }));
  const sec = (title, ...kids) => el('div', { class: 'adv-sec' }, el('div', { class: 'adv-sec-t' }, title), ...kids);
  const pane = {};

  // ---------- Channel ----------
  const chRows = eng.channels.map((ch, i) => el('div', { class: 'adv-ch', 'data-ch': i },
    el('span', { class: 'adv-chn' }, String(i + 1)),
    select(COLOR_FX, () => ch.state.colorFx, (v) => ch.set('colorFx', v), `Channel ${i + 1} Color FX`),
    kn({ label: 'COMP', min: 0, max: 1, def: 0, bipolar: false, size: 'xs', title: `Channel ${i + 1} one-knob compressor`, get: () => ch.state.comp, set: (v) => ch.set('comp', v) }),
    kn({ label: 'SEND', min: 0, max: 1, def: 0, bipolar: false, size: 'xs', title: `Channel ${i + 1} send to the send / return FX`, get: () => ch.state.send, set: (v) => ch.set('send', v) }),
    toggle('POST', () => ch.state.cuePost, () => ch.set('cuePost', !ch.state.cuePost), 'Post-fader cue'),
    toggle('CUE B', () => ch.state.cue2, () => { eng.ensureHp2(); ch.set('cue2', !ch.state.cue2); }, 'Headphones B cue'),
    toggle('REV', () => ch.state.faderReverse, () => ch.set('faderReverse', !ch.state.faderReverse), 'Channel fader reverse'),
    el('canvas', { class: 'adv-bands', width: 60, height: 24, title: 'Band levels: low / mid / high' }),
  ));
  pane.channel = el('div', { class: 'adv-pane' },
    sec('EQ',
      row('EQ preset', select(EQ_PRESETS.map((p) => [p.id, p.label]), () => mx().eqType, (v) => set({ eqType: v }), 'EQ preset')),
      row('Kill at the end', toggle('KILL', () => mx().classicKill !== false, () => set({ classicKill: mx().classicKill === false }), 'Classic / vintage EQ: the last tenth of the knob kills the band'))),
    sec('Filter',
      row('Filter mode', select([['oneKnob', 'One knob (resonant) + Color FX'], ['dual', 'Dual HP / LP (no resonance)']], () => mx().filterMode, (v) => set({ filterMode: v }), 'Filter mode')),
      row('Center Lock', toggle('LOCK', () => mx().centerLock, () => set({ centerLock: !mx().centerLock }), 'A filter / Color FX knob cannot cross 12 o\'clock in one move'))),
    sec('Channels', ...chRows),
  );
  // ---------- Faders ----------
  const glyph = el('canvas', { class: 'adv-glyph', width: 96, height: 40, title: 'Crossfader curve preview (A blue, B orange)' });
  const drawGlyph = () => {
    const g = glyph.getContext('2d'), W = glyph.width, H = glyph.height; g.clearRect(0, 0, W, H);
    for (const [side, col] of [['A', '#3ea6ff'], ['B', '#ff8a3d']]) { g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); for (let x = 0; x <= W; x++) { const y = H - 2 - xfGain(x / W * 2 - 1, side, mx()) * (H - 4); x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); }
  };
  glyph.render = drawGlyph; R(glyph);
  pane.faders = el('div', { class: 'adv-pane' },
    sec('Crossfader',
      el('div', { class: 'adv-knobs' },
        kn({ label: 'CURVE', min: 0, max: 1, def: 0.5, bipolar: false, title: 'Crossfader curve: linear (left), smooth (noon), fast cut (right)', get: () => mx().xfCurve, set: (v) => set({ xfCurve: Math.round(v * 100) / 100 }) }),
        kn({ label: 'CUT-IN', min: 0, max: 0.1, def: 0, bipolar: false, title: 'Dead zone at each end (0-10 % of travel)', get: () => mx().xfCutIn, set: (v) => set({ xfCutIn: Math.round(v * 1000) / 1000 }) }),
        glyph),
      row('Cut time (fast-cut fader)', select([[1, '1 ms (battle)'], [2, '2 ms'], [3, '3 ms'], [5, '5 ms (club)'], [10, '10 ms']], () => mx().xfCutTime, (v) => set({ xfCutTime: Number(v) }), 'Crossfader cut time')),
      row('Reverse (hamster)', toggle('REV', () => mx().xfReverse, () => set({ xfReverse: !mx().xfReverse }), 'Swap the crossfader sides')),
      row('Show crossfader', toggle('SHOW', () => !mx().hideXfader, () => set({ hideXfader: !mx().hideXfader }), 'Rotary mixers have no crossfader; you can bring it back'))),
    sec('Channel faders',
      row('Fader curve', select(FADER_CURVES.map((c) => [c, FADER_CURVE_LABELS[c]]), () => mx().faderCurve, (v) => set({ faderCurve: v }), 'Channel fader curve')),
      row('Rotary channel levels', toggle('ROTARY', () => mx().rotary, () => set({ rotary: !mx().rotary }), 'Channel levels as big rotary knobs (-inf .. +6 dB, 30 ms smoothing)'))),
  );
  // ---------- Master ----------
  const outputs = [['', 'Choose output…']];
  const devSel = (key) => { const s = select(outputs, () => mx()[key] || '', (v) => set({ [key]: v }), 'Output device'); s.addEventListener('focus', () => refreshOutputs(s)); return s; };
  async function refreshOutputs(s) { const list = await eng.listOutputs(); const cur = s.value; s.replaceChildren(el('option', { value: '' }, 'Choose output…'), ...list.map((d) => el('option', { value: d.id }, d.label))); s.value = cur; }
  pane.master = el('div', { class: 'adv-pane' },
    sec('Master isolator',
      el('div', { class: 'adv-knobs' },
        kn({ label: 'LOW', title: 'Master isolator low', get: () => eng.iso.low, set: (v) => eng.setMasterIso('low', v) }),
        kn({ label: 'MID', title: 'Master isolator mid', get: () => eng.iso.mid, set: (v) => eng.setMasterIso('mid', v) }),
        kn({ label: 'HIGH', title: 'Master isolator high', get: () => eng.iso.high, set: (v) => eng.setMasterIso('high', v) }),
        toggle('ON', () => eng.isoOn, () => eng.setMasterIsoOn(!eng.isoOn), 'Master isolator on')),
      row('Crossovers', select([['300,4000', '300 Hz / 4 kHz'], ['200,2500', '200 Hz / 2.5 kHz'], ['150,5000', '150 Hz / 5 kHz']], () => String(mx().masterIsoXover), (v) => set({ masterIsoXover: v.split(',').map(Number) }), 'Master isolator crossovers')),
      row('Boost', select([[6, '+6 dB'], [12, '+12 dB (rotary)']], () => mx().masterIsoBoost, (v) => set({ masterIsoBoost: Number(v) }), 'Master isolator boost'))),
    sec('Master',
      el('div', { class: 'adv-knobs' },
        kn({ label: 'WARMTH', min: 0, max: 1, def: 0, bipolar: false, title: 'Warmth: 2nd-harmonic saturation', get: () => eng.warmth, set: (v) => eng.setWarmth(v) }),
        kn({ label: 'BALANCE', title: 'Master balance', get: () => eng.balance, set: (v) => eng.setBalance(v) }),
        toggle('MONO', () => mx().mono, () => set({ mono: !mx().mono }), 'Mono master (club PA)')),
      row('Limiter ceiling', select([[-0.3, '-0.3 dBFS'], [-1, '-1 dBFS'], [-2, '-2 dBFS'], [-3, '-3 dBFS']], () => mx().limiterCeiling, (v) => set({ limiterCeiling: Number(v) }), 'Limiter ceiling'))),
    sec('Booth',
      el('div', { class: 'adv-knobs' },
        kn({ label: 'BOOTH', min: 0, max: 1, def: 0.8, bipolar: false, title: 'Booth level', get: () => eng.boothVolume, set: (v) => { eng.ensureBooth(); eng.setBoothVolume(v); } }),
        kn({ label: 'HI', title: 'Booth EQ high ±12 dB', get: () => eng.boothEq.high, set: (v) => { eng.ensureBooth(); eng.setBoothEq('high', v); } }),
        kn({ label: 'LO', title: 'Booth EQ low ±12 dB', get: () => eng.boothEq.low, set: (v) => { eng.ensureBooth(); eng.setBoothEq('low', v); } }),
        toggle('MIC', () => mx().micToBooth, () => set({ micToBooth: !mx().micToBooth }), 'Mic in booth (off by default: feedback-safe)')),
      row('Booth output', select([['off', 'Off'], ['device', 'Another sound card'], ['channels34', 'Channels 3-4'], ['channels56', 'Channels 5-6']], () => mx().boothRoute, (v) => set({ boothRoute: v }), 'Booth output')),
      row('Booth device', devSel('boothDeviceId'))),
    sec('Headphones',
      el('div', { class: 'adv-knobs' },
        toggle('CUE MST', () => eng.masterCue, () => eng.setMasterCue(!eng.masterCue), 'Master into the cue'),
        toggle('SAMPLER', () => eng.samplerCue, () => eng.setSamplerCue(!eng.samplerCue), 'Sampler cue'),
        kn({ label: 'B LEVEL', min: 0, max: 1, def: 0.8, bipolar: false, title: 'Headphones B level', get: () => eng.hp2Volume, set: (v) => { eng.ensureHp2(); eng.setHp2Volume(v); } }),
        kn({ label: 'B MIX', min: 0, max: 1, def: 0, bipolar: false, title: 'Headphones B cue ↔ master', get: () => eng.hp2CueMix, set: (v) => { eng.ensureHp2(); eng.setHp2CueMix(v); } })),
      row('Headphones B', select([['off', 'Off'], ['device', 'Another sound card'], ['channels56', 'Channels 5-6'], ['channels78', 'Channels 7-8']], () => mx().hp2Route, (v) => set({ hp2Route: v }), 'Headphones B output')),
      row('Headphones B device', devSel('hp2DeviceId'))),
    sec('Record',
      el('div', { class: 'adv-knobs' },
        kn({ label: 'REC LVL', min: -12, max: 12, def: 0, title: 'Record level ±12 dB', format: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}dB`, get: () => eng.recLevelDb, set: (v) => eng.setRecordLevel(v) }),
        toggle('MIC', () => mx().micToRecord, () => set({ micToRecord: !mx().micToRecord }), 'Mic (and voice) in the recording'))),
  );
  // ---------- Mic ----------
  const notchInfo = R(el('div', { class: 'adv-note' })); notchInfo.render = () => { const f = eng.mic?.notchFreqs || []; notchInfo.textContent = mx().feedbackReducer ? (f.length ? `Notches: ${f.map((x) => `${Math.round(x)} Hz`).join(', ')}` : 'Listening for feedback…') : ''; };
  pane.mic = el('div', { class: 'adv-pane' },
    sec('Mic EQ',
      el('div', { class: 'adv-knobs' }, ...['high', 'mid', 'low'].map((b) => kn({ label: b.toUpperCase(), title: `Mic EQ ${b} ±12 dB`, get: () => eng.micEq[b], set: (v) => eng.setMicEq(b, v) })))),
    sec('Mic FX',
      el('div', { class: 'adv-knobs' },
        toggle('FX', () => eng.micFxOn, () => eng.setMicFx(!eng.micFxOn), 'Mic FX on'),
        kn({ label: 'LEVEL', min: 0, max: 1, def: 0.5, bipolar: false, title: 'Mic FX level', get: () => eng.micFxLevel, set: (v) => eng.setMicFxLevel(v) })),
      row('Effect', select(MIC_FX_LIST.map((f) => [f.id, f.label]), () => mx().micFx, (v) => set({ micFx: v }), 'Mic FX'))),
    sec('Talkover',
      row('Mode', select([['manual', 'Manual (TALK button)'], ['auto', 'Auto: voice ducks the music'], ['advanced', 'Auto, voice band only (bass stays)']], () => mx().talkoverMode, (v) => set({ talkoverMode: v }), 'Talkover mode')),
      row('Depth', select([[-6, '-6 dB'], [-12, '-12 dB'], [-18, '-18 dB'], [-24, '-24 dB'], [-40, '-40 dB']], () => app.settings.talkoverDb ?? -12, async (v) => { await app.setSetting('talkoverDb', Number(v)); eng.applyTalkoverDepth(); }, 'Talkover depth')),
      row('Voice threshold', select([[-48, '-48 dB (sensitive)'], [-36, '-36 dB'], [-28, '-28 dB'], [-20, '-20 dB (loud voice only)']], () => mx().talkoverThreshold, (v) => set({ talkoverThreshold: Number(v) }), 'Auto talkover threshold'))),
    sec('Feedback',
      row('Feedback reducer', toggle('ON', () => mx().feedbackReducer, () => set({ feedbackReducer: !mx().feedbackReducer }), 'Notch narrow ringing peaks (up to 4)')), notchInfo),
  );
  // ---------- FX units + send / return ----------
  const fxUnit = (u) => {
    const P = `fx${u + 1}`, cfg = () => mx()[P], bus = () => eng.fxBus(u), setU = (patch) => set({ [P]: { ...cfg(), ...patch } });
    const strip = el('div', { class: 'fx-strip', role: 'slider', 'aria-label': `FX ${u + 1} strip`, tabindex: 0, title: 'FX strip: touch a beat division to engage the effect, slide to change it, lift to release' },
      ...STRIP_DIVISIONS.map((d) => el('span', {}, fmtDiv(d))));
    let held = false;
    const at = (e) => { const r = strip.getBoundingClientRect(); return Math.min(0.999, Math.max(0, (e.clientX - r.left) / r.width)); };
    strip.addEventListener('pointerdown', (e) => { held = true; strip.setPointerCapture(e.pointerId); if (cfg().assign === 'off') setU({ assign: 'master' }); bus().strip(at(e)); strip.classList.add('held'); });
    strip.addEventListener('pointermove', (e) => { if (held) bus().strip(at(e)); });
    const up = () => { if (!held) return; held = false; bus().strip(null); strip.classList.remove('held'); };
    strip.addEventListener('pointerup', up); strip.addEventListener('pointercancel', up);
    return sec(`FX ${u + 1}`,
      row('Effect', select(EFFECTS.map((e) => [e.id, e.label]), () => cfg().type, (v) => setU({ type: v }), `FX ${u + 1} effect`)),
      row('Assign', select([['off', 'Off'], ['ch1', 'Channel 1'], ['ch2', 'Channel 2'], ['ch3', 'Channel 3'], ['ch4', 'Channel 4'], ['master', 'Master'], ['xfA', 'Crossfader A'], ['xfB', 'Crossfader B']], () => cfg().assign, (v) => setU({ assign: v }), `FX ${u + 1} assign`)),
      el('div', { class: 'adv-knobs' },
        toggle('ON', () => !!eng.fxBuses[u]?.on, () => { if (cfg().assign === 'off') setU({ assign: 'master' }); bus().setOn(!bus().on); }, `FX ${u + 1} on`),
        kn({ label: 'LEVEL', min: 0, max: 1, def: 0.5, bipolar: false, title: 'Level / depth', get: () => eng.fxBuses[u]?.unit.mix ?? 0.5, set: (v) => bus().setMix(v) }),
        kn({ label: 'PARAM', min: 0, max: 1, def: 0.5, bipolar: false, title: 'Parameter', get: () => eng.fxBuses[u]?.unit.param ?? 0.5, set: (v) => bus().setParam(v) }),
        select(BEAT_DIVISIONS.map((b) => [b, `${fmtDiv(b)} beat`]), () => eng.fxBuses[u]?.unit.beats ?? 0.5, (v) => bus().setBeats(Number(v)), 'Beat division'),
        toggle('Q', () => cfg().quantize, () => setU({ quantize: !cfg().quantize }), 'Quantise: on / off land on the next beat division')),
      el('div', { class: 'adv-knobs' }, el('span', { class: 'adv-lbl' }, 'FX frequency'),
        ...['low', 'mid', 'high'].map((b) => toggle(b.toUpperCase(), () => eng.fxBuses[u]?.bands[b] !== false, () => bus().setBand(b, !bus().bands[b]), `Apply the effect to the ${b} band`))),
      strip);
  };
  pane.fx = el('div', { class: 'adv-pane' }, fxUnit(0), fxUnit(1),
    sec('Send / return',
      el('div', { class: 'adv-knobs' },
        toggle('ON', () => eng.sendOn, () => { eng.ensureSendFx(); eng.setSendOn(!eng.sendOn); }, 'Send / return on'),
        kn({ label: 'RETURN', min: 0, max: 1, def: 0.7, bipolar: false, title: 'Return level', get: () => eng.returnLevel, set: (v) => { eng.ensureSendFx(); eng.setReturnLevel(v); } })),
      row('Send FX', select(SEND_FX.map((f) => [f.id, f.label]), () => mx().sendType, (v) => set({ sendType: v }), 'Send FX')),
      row('Return to', select([['master', 'Master'], ['ch1', 'Channel 1'], ['ch2', 'Channel 2'], ['ch3', 'Channel 3'], ['ch4', 'Channel 4']], () => mx().returnTo, (v) => set({ returnTo: v }), 'Return to')),
    ),
  );
  // ---------- Loudness ----------
  const L = {};
  const cell = (k, label, unit) => el('div', { class: 'loud-cell' }, el('div', { class: 'loud-k' }, label), L[k] = el('div', { class: 'loud-v' }, '—'), el('div', { class: 'loud-u' }, unit));
  pane.loudness = el('div', { class: 'adv-pane' },
    el('div', { class: 'loud-grid' }, cell('m', 'M', 'LUFS'), cell('s', 'S', 'LUFS'), cell('i', 'I', 'LUFS'), cell('tp', 'TP max', 'dBTP'), cell('gr', 'GR', 'dB')),
    el('div', { class: 'adv-note' }, 'EBU R128 / BS.1770-4: momentary 400 ms, short-term 3 s, gated integrated since reset; true peak 4x oversampled.'),
    R(button('Reset', { cls: 'xs', click: () => eng.resetLoudness() })));
  const renderLoud = () => {
    const d = eng.loudness;
    if (d) { L.m.textContent = fmtDb(d.m); L.s.textContent = fmtDb(d.s); L.i.textContent = fmtDb(d.i); L.tp.textContent = fmtDb(d.tpMax); }
    L.gr.textContent = fmtDb(20 * Math.log10(eng.limiterGr()), 1);
  };

  // ---------- shell ----------
  const pState = el('span', { class: 'adv-pstate' });
  const persSel = el('select', { class: 'sel tiny adv-pers', 'aria-label': 'Mixer personality', title: 'Mixer personality: a preset of the settings below (Club is today\'s mixer)' },
    ...PERSONALITY_IDS.map((id) => el('option', { value: id }, PERSONALITIES[id].label)));
  persSel.addEventListener('change', () => { if (!setPersonality(app, persSel.value)) app.toast?.('Release the crossfader first'); });
  const tabBtns = TABS.map(([id, label]) => el('button', { class: 'btn xs adv-tab', role: 'tab', 'data-tab': id, onclick: () => show(id) }, label));
  const body = el('div', { class: 'adv-body' });
  const drawer = el('div', { class: 'mixer-drawer', role: 'dialog', 'aria-label': 'Advanced mixer', hidden: true },
    el('div', { class: 'adv-head' }, el('span', { class: 'adv-title' }, 'Advanced mixer'), persSel, pState,
      el('button', { class: 'btn xs adv-close', 'aria-label': 'Close the advanced mixer', title: 'Close (Esc)', onclick: () => api.toggle(false) }, '✕')),
    el('div', { class: 'adv-tabs', role: 'tablist' }, ...tabBtns), body);
  let tab = 'channel', raf = 0;
  function show(id) {
    tab = id; // every pane stays in the DOM (hidden), so their controls are always reachable by selectors
    for (const [k, p] of Object.entries(pane)) { if (p.parentNode !== body) body.append(p); p.hidden = k !== id; }
    for (const b of tabBtns) { const on = b.dataset.tab === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); }
    if (id === 'loudness') eng.ensureMeter();
    if (id !== 'channel') eng.channels.forEach((c) => c.bandLevels(false));
    render();
  }
  function render() {
    for (const r of renderers) r.render?.();
    const st = personalityState(mx()); persSel.value = st.id; pState.textContent = st.custom ? st.label : '';
  }
  const frame = () => {
    raf = 0;
    if (drawer.hidden) return;
    if (tab === 'loudness') renderLoud();
    if (tab === 'channel') chRows.forEach((r, i) => {
      if (eng.channels[i] && r.offsetParent) {
        const lv = eng.channels[i].bandLevels(true), c = r.querySelector('canvas'), g = c.getContext('2d');
        g.clearRect(0, 0, c.width, c.height);
        lv.forEach((v, k) => { const h = Math.max(1, Math.min(1, (20 * Math.log10(v + 1e-6) + 60) / 60) * c.height); g.fillStyle = ['#ff5964', '#55d98a', '#4da8ff'][k]; g.fillRect(k * 20 + 2, c.height - h, 16, h); });
      }
    });
    if (tab === 'mic') notchInfo.render();
    raf = requestAnimationFrame(frame);
  };
  const api = {
    el: drawer, panes: pane,
    get open() { return !drawer.hidden; },
    toggle(on = drawer.hidden, toTab) {
      drawer.hidden = !on;
      mixerRoot.classList.toggle('drawer-open', on);
      mixerRoot.querySelector('.mixer-adv-btn')?.setAttribute('aria-expanded', String(on));
      if (on) { show(toTab || tab); if (!raf) raf = requestAnimationFrame(frame); drawer.querySelector('.adv-tab.active')?.focus({ preventScroll: true }); }
      else { eng.channels.forEach((c) => c.bandLevels(false)); }
    },
    render,
  };
  drawer.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); api.toggle(false); mixerRoot.querySelector('.mixer-adv-btn')?.focus(); } });
  eng.on('mixer-config', () => { if (!drawer.hidden) render(); });
  eng.on('master', () => { if (!drawer.hidden) render(); });
  eng.on('mixer', () => { if (!drawer.hidden && tab === 'channel') render(); });
  show(tab);
  return api;
}
