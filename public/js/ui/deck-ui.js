import { el, fmtTime, uiZoom } from '../util.js';
import { knob, fader, button, jogWheel } from './controls.js';
import { OverviewWaveform } from './waveform.js';
import { EFFECTS, BEAT_DIVISIONS, effectParams, effectBeats } from '../audio/effects.js';
import { api } from '../api.js';
import { cssVar } from './themes.js';
import { icon } from './icons.js';
import { dvsModeIndicator } from '../dvs/dvs-ui.js';
import { buildStemControls } from '../stems/stems-ui.js';
import { HOTCUE_COLORS, TEMPO_RANGES } from '../audio/deck.js';
import { camelotCompatible, toCamelot } from '../audio/analysis-core.js';
import { syncBeatRatio, beatPhaseDelta } from '../audio/beat-phase.js';
import { smoothTime } from './clock.js';
import { t as tr } from '../i18n.js';
import { vinylFor, deckOptions, VINYL_RANGES, fmtDiv, JUMP_SIZES, SCALES, GLIDE_BEATS } from '../audio/vinyl.js';
import { ScratchSamples, SCRATCH_SOUNDS, SCRATCH_DOWNLOADS } from '../audio/scratch-samples.js';
import { setDeckVinyl, needleLocked } from '../midi/deck-targets.js';
import { haptics, setHapticsLevel } from './haptics.js';
import { openScratchView } from './scratch-view.js';

export const DECK_COLORS = ['var(--deck1)', 'var(--deck2)', 'var(--deck3)', 'var(--deck4)'];
const LOOP_SIZES = [1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
/** A small popup menu anchored to `anchor`: items [[label, fn, active?]]; closes on pick / outside press / Escape. */
export function popupMenu(anchor, items, title) {
  document.querySelector('.deck-popup')?.remove();
  const menu = el('div', { class: 'deck-popup', role: 'menu' }, title ? el('div', { class: 'deck-popup-title' }, title) : null,
    ...items.map(([label, fn, on]) => el('button', { class: `btn sm${on ? ' active' : ''}`, role: 'menuitem', onclick: () => { close(); fn(); } }, label)));
  const close = () => { menu.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc, true); };
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.body.append(menu);
  const r = anchor.getBoundingClientRect(), m = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(innerWidth - m.width - 8, r.left + r.width / 2 - m.width / 2))}px`;
  menu.style.top = `${r.top - m.height - 6 > 8 ? r.top - m.height - 6 : Math.min(innerHeight - m.height - 8, r.bottom + 6)}px`;
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', esc, true); });
  menu.querySelector('button')?.focus({ preventScroll: true });
  return menu;
}
/** Long press (450 ms) on `b` runs onLong and swallows the click that follows. */
function longPress(b, onLong, ms = 450) {
  let t = 0, fired = false;
  b.addEventListener('pointerdown', (e) => { if (e.button > 0) return; fired = false; clearTimeout(t); t = setTimeout(() => { fired = true; onLong(e); }, ms); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(t));
  b.addEventListener('click', (e) => { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; } }, true);
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); clearTimeout(t); fired = true; onLong(e); });
}
const fmtBeats = (b) => (b = Math.round(b * 1000) / 1000, b >= 1 ? String(b) : b === 0.5 ? '½' : b === 0.25 ? '¼' : b === 0.125 ? '⅛' : b === 0.75 ? '¾' : b.toFixed(2));

export function buildDeck(app, deck) {
  const i = deck.index, ch = app.engine.channels[i];
  // labels with a short form for narrow decks (KEY LOCK -> KEY ...): the deck switches to them only when a full
  // label would be clipped (checked when the control column resizes or the panel changes), so wide decks keep words
  const dual = (full, short) => el('span', { class: 'lbl-dual' }, el('span', { class: 'lf' }, full), el('span', { class: 'ls' }, short));
  const renderers = [];
  const R = (c) => { if (c?.render) renderers.push(c); return c; };
  const shift = () => app.shift;

  // ---------- header ----------
  const cover = el('div', { class: 'deck-cover' });
  // track title / artist are user data: never run through the DOM translator (the UI texts here use tr())
  const title = el('div', { class: 'deck-title', translate: 'no' }, tr('Drop a track here'));
  const artist = el('div', { class: 'deck-artist', translate: 'no' }, '');
  const artistNote = el('span', { class: 'deck-load-note', 'aria-live': 'polite' }); // load progress: Loading 42 % / Decoding… / Analysing…
  const keyBadge = el('span', { class: 'key-badge' });
  const bpmBig = el('div', { class: 'deck-bpm' }, '--');
  const bpmSub = el('div', { class: 'deck-bpm-sub' }, '');
  const elapsed = el('div', { class: 'deck-time' }, '00:00.0');
  const remain = el('div', { class: 'deck-time remain' }, '00:00.0');
  const masterBadge = el('span', { class: 'badge master-badge' }, 'MASTER');
  const sampleBadge = el('span', { class: 'badge sample-badge', hidden: true }, 'SAMPLE');
  const scratchBtn = el('button', { class: 'btn xs scratch-view-btn', title: 'Scratch view: a big platter with a crossfader strip and scratch samples', 'aria-label': `Deck ${i + 1} scratch view`, onclick: (e) => { e.stopPropagation(); openScratchView(app, deck); } }, 'SCRATCH');
  const header = el('div', { class: 'deck-header' },
    el('div', { class: 'deck-num' }, String(i + 1)),
    cover,
    el('div', { class: 'deck-meta' }, title, el('div', { class: 'deck-sub' }, artist, artistNote, keyBadge, masterBadge, sampleBadge, scratchBtn, dvsModeIndicator(app, i))),
    el('div', { class: 'deck-times' }, elapsed, remain),
    el('div', { class: 'deck-bpmbox' }, bpmBig, bpmSub),
  );
  const overview = new OverviewWaveform(deck, () => app.settings, { needleLocked: () => needleLocked(app), needleHint: () => app.toast('Needle lock is on: hold a moment to drop the needle on a playing deck') });

  // ---------- transport ----------
  const cueBtn = R(button('CUE', { cls: 'btn-cue big', down: () => deck.cueDown(), up: () => deck.cueUp(), active: () => deck.cuePreview || (!deck.playing && deck.track && Math.abs(deck.position - deck.cuePoint) < 0.02) }));
  const playBtn = R(button(el('span', { class: 'play-glyph' }, icon('play'), icon('pause')), { cls: 'btn-play big', title: 'Play / pause', down: () => { app.engine.resume(); deck.togglePlay(); }, active: () => deck.playing }));
  const mixNowBtn = R(button('MIX NOW', {
    cls: 'sm deck-mix-now',
    title: 'Mix from this deck into the next track now (the queued Automix transition, or the track loaded on the other deck)',
    click: () => app.mixNow(i),
    disabled: () => !app.mixNowState?.(i)?.available,
  }));
  const syncBtn = R(button('SYNC', { cls: 'btn-sync', click: () => deck.sync(), active: () => deck.syncOn }));
  const masterBtn = R(button('MASTER', { cls: 'btn-master', click: () => deck.setMaster(), active: () => deck.isMaster }));
  const toggles = el('div', { class: 'deck-toggles' },
    R(button(dual('KEY LOCK', 'KEY'), { cls: 'sm', click: () => deck.setKeyLock(!deck.keyLock), active: () => deck.keyLock, title: 'Master tempo: change tempo without changing pitch' })),
    (() => { const q = R(button(dual('QUANT', 'QNT'), { cls: 'sm', click: () => deck.setQuantize(!deck.quantize), active: () => deck.quantize, title: 'Snap cues, loops and jumps to the beat grid (hold: quantize division)' })); longPress(q, () => popupMenu(q, [0.125, 0.25, 0.5, 1, 4].map((v) => [fmtDiv(v), () => deck.setQuantizeDiv(v), deck.quantizeDiv === v]), 'Quantize to')); return q; })(),
    R(button('SLIP', { cls: 'sm', click: () => deck.setSlip(!deck.slip), active: () => deck.slip, title: 'Slip mode: track continues silently under loops, scratches and reverse' })),
    R(button('REV', { cls: 'sm', click: () => (shift() || deck.slipReverse ? deck.toggleSlipReverse() : deck.setReverse(!deck.reverse)), active: () => deck.reverse, title: 'Reverse (Shift-click: latching slip reverse, the track carries on underneath)' })),
    R(button('VINYL', { cls: 'sm', click: () => { deck.vinylMode = !deck.vinylMode; deck.emit('state'); }, active: () => deck.vinylMode, title: 'Jog mode. On (vinyl): touching the platter top scratches, the outer ring bends. Off (CDJ): the whole platter bends' })),
  );

  // ---------- key shift / key sync ----------
  const keyVal = el('span', { class: 'key-val' }, '0');
  const keyRow = el('div', { class: 'key-row' },
    el('span', { class: 'key-lbl' }, 'KEY'),
    button('−', { cls: 'xs', click: () => deck.setKeyShift(deck.keyShift - 1), title: 'Key down a semitone' }),
    keyVal,
    button('+', { cls: 'xs', click: () => deck.setKeyShift(deck.keyShift + 1), title: 'Key up a semitone' }),
    R(button('KEY SYNC', { cls: 'xs', click: () => (shift() ? deck.setKeyShift(0) : (deck.keySyncTo() || app.toast('No harmonic match found (or key unknown)'))), active: () => deck.keyShift !== 0, title: 'Shift key to match the master deck (Shift-click to reset)' })),
    button('0', { cls: 'xs', click: () => deck.setKeyShift(0), title: 'Reset key' }),
  );

  // ---------- jog ----------
  const opts = () => deckOptions(app.settings);
  setHapticsLevel(opts().haptics);
  const jog = jogWheel(deck, { skin: () => opts().platterSkin, haptics });
  jog.style.setProperty('--deck-color', DECK_COLORS[i]);
  deck.applyVinyl(vinylFor(app.settings, i));

  // ---------- tempo ----------
  const rangeSel = el('select', { class: 'sel tiny', title: 'Tempo range' }, ...TEMPO_RANGES.map((r) => el('option', { value: r }, `±${r}%`)));
  rangeSel.value = String(deck.tempoRange);
  rangeSel.addEventListener('change', () => { deck.setTempoRange(Number(rangeSel.value)); tempoFader.render(); });
  const tempoFader = R(fader({ min: -1, max: 1, def: 0, get: () => deck.tempo / deck.tempoRange, set: (v) => deck.setTempoFader(v), invert: true, cls: 'tempo-fader', title: 'Tempo (double-click to reset)' }));
  const tempoVal = el('div', { class: 'tempo-val' }, '0.00%');
  const bendBtns = el('div', { class: 'bend' },
    button('−', { cls: 'sm', down: () => deck.bendStart(-1), up: () => deck.bendStop(), title: 'Pitch bend down (nudge; hold to bend more)' }),
    button('+', { cls: 'sm', down: () => deck.bendStart(1), up: () => deck.bendStop(), title: 'Pitch bend up (nudge; hold to bend more)' }),
  );
  const resetBtn = R(button('RESET', { cls: 'sm', click: () => { deck.resetTempoGlide(); tempoFader.render(); }, active: () => deck.gliding, title: 'Tempo reset: a playing track glides back to 0 % (Settings → Decks sets how fast; press again to jump there). Hold: glide to 0 % or to the master tempo over 1-64 beats' }));
  longPress(resetBtn, () => popupMenu(resetBtn, [
    ...GLIDE_BEATS.map((b) => [`→ 0 % in ${b}`, () => deck.tempoGlide(0, b)]),
    ...GLIDE_BEATS.map((b) => [`→ MASTER in ${b}`, () => deck.glideToMaster(b) || app.toast('No master tempo to glide to')]),
  ], 'Tempo glide (beats)'));
  const tempo = el('div', { class: 'deck-tempo' }, rangeSel, tempoFader, tempoVal, bendBtns, resetBtn);

  // ---------- loops ----------
  const loopSize = el('div', { class: 'loop-size' }, '4');
  let autoLoopBeats = 4;
  // IN / OUT: click as before; hold on an active loop = loop in / out adjust (turn the platter to move the point)
  const adjBtn = (label, which, press) => {
    const b = R(button(label, { cls: 'sm', click: () => press(), active: () => deck.loopAdjust === which || (which === 'in' && deck.loopIn != null && !deck.loop?.active), title: `Loop ${which} (hold on an active loop and turn the platter to move it)` }));
    let t = 0, held = false;
    b.addEventListener('pointerdown', (e) => { if (e.button > 0 || !deck.loop?.active) return; held = false; t = setTimeout(() => { held = true; deck.setLoopAdjust(which); }, 300); });
    const up = () => { clearTimeout(t); if (deck.loopAdjust === which) deck.setLoopAdjust(null); };
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, up);
    b.addEventListener('click', (e) => { if (held) { held = false; e.stopImmediatePropagation(); } }, true);
    return b;
  };
  const loopRow = el('div', { class: 'loop-row' },
    adjBtn('IN', 'in', () => deck.loopInPress()),
    adjBtn('OUT', 'out', () => deck.loopOutPress()),
    (() => { const rl = R(button(dual('RELOOP', icon('repeat')), { cls: 'sm', click: () => deck.reloop(), active: () => deck.loop?.active, title: 'Reloop / exit loop (hold: flag the loop as an active loop)' })); longPress(rl, () => { deck.toggleActiveLoop(); app.toast(deck.loopIsActiveLoop ? 'Active loop: it engages whenever the track reaches it' : 'Active loop cleared'); }); return rl; })(),
    button('½', { cls: 'sm', click: () => { if (deck.loop?.active) deck.loopHalve(); else { autoLoopBeats = Math.max(1 / 8, autoLoopBeats / 2); loopSize._t = loopSize.textContent = fmtBeats(autoLoopBeats); } } }),
    R(button(loopSize, { cls: 'sm loop-btn', click: () => deck.autoLoop(autoLoopBeats), active: () => deck.loop?.active, title: 'Auto beat loop' })),
    button('×2', { cls: 'sm', click: () => { if (deck.loop?.active) deck.loopDouble(); else { autoLoopBeats = Math.min(64, autoLoopBeats * 2); loopSize._t = loopSize.textContent = fmtBeats(autoLoopBeats); } } }),
  );
  const jumpLabel = el('span', {}, '4');
  const jumpRow = el('div', { class: 'loop-row jump-row' },
    button(icon('rewind'), { cls: 'sm', click: () => deck.jumpBySize(-1), title: 'Beat jump back' }),
    button(el('span', {}, dual('JUMP ', 'J'), jumpLabel), { cls: 'sm', title: 'Beat jump size: ½ to 64 beats (Shift-click: smaller)', click: () => { const k = JUMP_SIZES.indexOf(deck.jumpSize); deck.setJumpSize(JUMP_SIZES[(k + (shift() ? JUMP_SIZES.length - 1 : 1)) % JUMP_SIZES.length]); } }),
    button(icon('fast-forward'), { cls: 'sm', click: () => deck.jumpBySize(1), title: 'Beat jump forward' }),
    button('MEM', { cls: 'sm', click: () => deck.addMemoryCue(), title: 'Add memory cue' }),
    button('GRID', { cls: 'sm', click: () => app.dialogs.gridEditor(deck), title: 'Edit beat grid' }),
    button(icon('eject'), { cls: 'sm', click: () => deck.eject(), title: 'Eject' }),
  );
  const qDivLabel = el('span', {}, '1');
  const loopExtra = el('div', { class: 'loop-row loop-extra' },
    R(button('ACTIVE', { cls: 'sm', click: () => (deck.loop || deck.activeLoops.length ? deck.toggleActiveLoop() : app.toast('Set a loop first, then flag it as an active loop')), active: () => deck.loopIsActiveLoop, title: 'Active loop: flag the current loop so it engages by itself whenever the track reaches it' })),
    R(button(el('span', {}, 'Q ', qDivLabel), { cls: 'sm', click: () => deck.cycleQuantizeDiv(), active: () => deck.quantize, title: 'Quantize division: what cues, loop in / out and snapped needle drops snap to (1/8 beat to 1 bar)' })),
  );

  // ---------- performance pads ----------
  let padMode = 'hotcue';
  const padModes = ['hotcue', 'roll', 'slicer', 'jump', 'pitch', 'scale', 'scratch', 'sampler', 'fx'];
  const modeLabels = { hotcue: 'CUE', roll: 'ROLL', slicer: 'SLICE', jump: 'JUMP', pitch: 'PITCH', scale: 'SCALE', scratch: 'SCR', sampler: 'SMPL', fx: 'FX' };
  const modeTitles = { scale: 'Scale play: pads play the hot cue at scale steps by changing the platter speed (key lock off while held). Shift-press a pad: pick the hot cue', scratch: 'Scratch samples: a pad swaps this deck to a short sound to scratch; press it again to go back to the track. Shift-press or right-click: choose the sound, or drop an audio file on a pad' };
  let scaleName = 'major';
  app.scratchSamples ??= new ScratchSamples(app.engine);
  const bank = app.scratchSamples;
  const slotMenu = (n, anchor) => popupMenu(anchor, [
    ...SCRATCH_SOUNDS.map((x) => [x.name, () => bank.setBuiltin(n, x.id), bank.slots[n].id === x.id]),
    ...SCRATCH_DOWNLOADS.map((x) => [`${x.name} (CC0, download)`, () => bank.loadDownload(n, x).catch((e) => app.toast(`⚠ ${e.message}`))]),
  ], `Scratch slot ${n + 1}`);
  const PITCH_STEPS = [-5, -3, -2, -1, 0, 2, 3, 5];
  let pitchCue = 0;
  const modeBar = el('div', { class: 'pad-modes' });
  const padGrid = el('div', { class: 'pads' });
  const pads = [];
  const padAction = (n, down) => {
    if (padMode === 'hotcue') {
      if (down) { if (shift()) deck.deleteHotCue(n); else deck.hotCueDown(n); } else deck.hotCueUp(n);
    } else if (padMode === 'roll') {
      if (down) deck.rollOn(LOOP_SIZES[n] / 2); else deck.rollOff();
    } else if (padMode === 'jump') {
      if (down) { const b = [1, 2, 4, 8][n % 4] * (n < 4 ? -1 : 1); deck.beatJump(b); }
    } else if (padMode === 'sampler') {
      if (down) { if (shift()) app.engine.sampler.stop(n); else app.engine.sampler.trigger(n); }
    } else if (padMode === 'slicer') {
      if (down) deck.sliceDown(n); else deck.sliceUp();
    } else if (padMode === 'pitch') {
      // Pitch Play: shift-press picks the hot cue, pads play it at different pitches (keyboard mode)
      if (shift()) { if (down && deck.hotCue(n)) { pitchCue = n; renderPads(); } return; }
      if (down) { deck.setKeyShift(PITCH_STEPS[n]); if (deck.hotCue(pitchCue)) deck.hotCueDown(pitchCue); }
      else if (deck.hotCue(pitchCue)) deck.hotCueUp(pitchCue);
    } else if (padMode === 'scale') {
      // scale play: pads change the platter speed (semitone rates, key lock off while held) from the chosen hot cue
      if (shift()) { if (down && deck.hotCue(n)) { pitchCue = n; renderPads(); } return; }
      if (down) { scaleHeld = n; deck.setRateStep(SCALES[scaleName][n]); if (deck.hotCue(pitchCue)) deck.hotCueDown(pitchCue); renderPads(); }
      else if (scaleHeld === n) { scaleHeld = null; deck.setRateStep(null); if (deck.hotCue(pitchCue)) deck.hotCueUp(pitchCue); renderPads(); }
    } else if (padMode === 'scratch') {
      if (!down) return;
      if (shift()) { slotMenu(n, pads[n]); return; }
      if (!deck.track && !deck.scratchSample) { app.toast('Load a track first: scratch samples swap in for it and back'); return; }
      bank.toggle(deck, n); renderPads();
    } else if (padMode === 'fx') {
      const fx = ['brake', 'backspin', 'censor', 'echoOut', 'roll1', 'roll2', 'filterSweep', 'tapeStop'][n];
      app.padFx(deck, fx, down);
    }
  };
  let scaleHeld = null;
  for (let n = 0; n < 8; n++) {
    const p = el('button', { class: 'pad' }, el('span', { class: 'pad-label' }));
    p.addEventListener('pointerdown', (e) => { e.preventDefault(); app.engine.resume(); padAction(n, true); p.classList.add('pressed'); });
    const up = () => { if (p.classList.contains('pressed')) { p.classList.remove('pressed'); padAction(n, false); } };
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) p.addEventListener(ev, up);
    p.addEventListener('contextmenu', (e) => { e.preventDefault(); if (padMode === 'hotcue') deck.deleteHotCue(n); else if (padMode === 'scratch') slotMenu(n, p); });
    p.addEventListener('dragover', (e) => { if (padMode === 'scratch' && e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); e.stopPropagation(); } });
    p.addEventListener('drop', (e) => {
      if (padMode !== 'scratch' || !e.dataTransfer?.files?.length) return;
      e.preventDefault(); e.stopPropagation();
      bank.loadFile(n, e.dataTransfer.files[0]).then(() => app.toast(`Scratch slot ${n + 1}: ${bank.slots[n].name}`)).catch((err) => app.toast(`⚠ ${err.message}`));
    });
    pads.push(p); padGrid.append(p);
  }
  const setPadMode = (m) => { if (padMode === 'scale' && m !== 'scale' && deck.rateMul !== 1) deck.setRateStep(null); padMode = m; for (const b of modeBar.children) b.classList.toggle('active', b.dataset.mode === m); renderPads(); };
  for (const m of padModes) modeBar.append(el('button', { class: 'pad-mode', 'data-mode': m, title: modeTitles[m] || '', onclick: () => (m === 'scale' && padMode === 'scale' ? popupMenu(modeBar.querySelector('[data-mode="scale"]'), Object.keys(SCALES).map((k) => [k[0].toUpperCase() + k.slice(1), () => { scaleName = k; renderPads(); }, k === scaleName]), 'Scale') : setPadMode(m)) }, modeLabels[m]));
  bank.onChange = () => { if (padMode === 'scratch') renderPads(); };
  const renderPads = () => {
    pads.forEach((p, n) => {
      const lbl = p.firstChild; let txt = '', color = '';
      if (padMode === 'hotcue') { const c = deck.hotCue(n); txt = c ? (c.name || String.fromCharCode(65 + n)) : String.fromCharCode(65 + n); color = c ? (c.color || HOTCUE_COLORS[n]) : ''; }
      else if (padMode === 'roll') { txt = fmtBeats(LOOP_SIZES[n] / 2); color = '#2ed47a'; }
      else if (padMode === 'jump') { const b = [1, 2, 4, 8][n % 4]; txt = (n < 4 ? '−' : '+') + b; color = '#3ea6ff'; }
      else if (padMode === 'slicer') { txt = `Slice ${n + 1}`; color = '#ff5ea8'; }
      else if (padMode === 'pitch') { const st = PITCH_STEPS[n]; txt = `${st > 0 ? '+' : ''}${st} ${String.fromCharCode(65 + pitchCue)}`; color = deck.keyShift === st ? '#ffffff' : '#ffb020'; }
      else if (padMode === 'sampler') { txt = app.engine.sampler.slots[n]?.name || '—'; color = '#c06cff'; }
      else if (padMode === 'scale') { const st = SCALES[scaleName][n]; txt = `${st ? '+' + st : '0'} ${String.fromCharCode(65 + pitchCue)}`; color = scaleHeld === n ? '#ffffff' : '#ffd166'; }
      else if (padMode === 'scratch') { txt = bank.slots[n]?.name || '—'; color = deck.scratchSample?.slot === n ? '#ffffff' : '#22d3ee'; }
      else { txt = ['Brake', 'Backspin', 'Censor', 'Echo Out', 'Roll ¼', 'Roll ⅛', 'Filter Sweep', 'Tape Stop'][n]; color = '#ff8a3d'; }
      lbl.textContent = txt;
      p.style.setProperty('--pad-color', color || 'transparent');
      p.classList.toggle('lit', !!color);
    });
  };
  deck.padMode = (m) => { setPadMode(m); deck.showPanel?.('cues'); };
  deck.padPress = (n, down) => padAction(n, down);
  setPadMode('hotcue');

  // ---------- FX unit ----------
  const fxSel = el('select', { class: 'sel' }, ...EFFECTS.map((e) => el('option', { value: e.id }, e.label)));
  fxSel.value = ch.state.fxType;
  fxSel.addEventListener('change', () => ch.set('fxType', fxSel.value));
  // beat division: the echo time, or the LFO cycle for modulation effects (labels show what it means for the effect)
  const beatSel = el('select', { class: 'sel tiny', title: 'Beat division: echo time / LFO cycle' }, ...BEAT_DIVISIONS.map((b) => el('option', { value: b }, `${fmtBeats(b)} beat`)));
  beatSel.value = String(ch.state.fxBeats);
  beatSel.addEventListener('change', () => ch.set('fxBeats', Number(beatSel.value)));
  const fxOn = R(button('FX ON', { cls: 'sm fx-on', click: () => ch.set('fxOn', !ch.state.fxOn), active: () => ch.state.fxOn }));
  const fxMix = R(knob({ label: 'MIX', min: 0, max: 1, def: 0.5, get: () => ch.state.fxMix, set: (v) => ch.set('fxMix', v), size: 'sm', title: 'FX wet/dry' }));
  const fxParam = R(knob({ label: 'PARAM', min: 0, max: 1, def: 0.5, get: () => ch.state.fxParam, set: (v) => ch.set('fxParam', v), size: 'sm' }));
  const fxParam2 = R(knob({ label: 'P2', min: 0, max: 1, def: 0.5, get: () => ch.state.fxParam2 ?? 0.5, set: (v) => ch.set('fxParam2', v), size: 'sm' }));
  fxParam2.classList.add('fx-p2');
  const fxLabels = () => {
    const [p1, p2] = effectParams(ch.state.fxType);
    fxParam.querySelector('.knob')?.setAttribute('title', `FX parameter: ${p1}`);
    fxParam2.querySelector('.knob')?.setAttribute('title', `FX parameter 2: ${p2}`);
    const l2 = fxParam2.querySelector('.knob-label'); if (l2) l2.textContent = p2.slice(0, 5).toUpperCase();
    beatSel.querySelectorAll('option').forEach((o) => { const b = Number(o.value), e = effectBeats(ch.state.fxType, b); o.textContent = `${fmtBeats(e)} beat${e > 1 ? 's' : ''}`; });
  };
  fxLabels();
  ch.on('change', (k) => { if (k === 'fxType') { fxSel.value = ch.state.fxType; fxLabels(); } if (k === 'fxBeats') beatSel.value = String(ch.state.fxBeats); fxOn.render(); fxMix.render(); fxParam.render(); fxParam2.render(); });
  const fxUnit = el('div', { class: 'fx-unit' }, el('div', { class: 'fx-col' }, fxSel, beatSel), fxMix, fxParam, fxParam2, fxOn);

  // ---------- phase meter (beat position in the bar + offset vs master) ----------
  const phase = el('canvas', { class: 'phase-meter', height: 12 });
  let phaseW = 0, phaseObserved = false, phaseSig = '';
  new ResizeObserver((es) => { phaseObserved = true; phaseW = es.at(-1).contentRect.width * uiZoom(); }).observe(phase);
  window.addEventListener('opendj-theme', () => { phaseSig = ''; });
  const drawPhase = (now) => {
    if (phaseObserved && phaseW <= 0) return; // hidden (display:none in Waveform / 4-Deck layouts)
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (!phaseW) { phaseW = phase.getBoundingClientRect().width; if (phaseW <= 0) return; }
    const W = Math.round(phaseW * dpr) || 1, H = Math.round(12 * dpr);
    if (phase.width !== W || phase.height !== H) { phase.width = W; phase.height = H; phaseSig = ''; }
    const m0 = app.engine.masterDeck(deck);
    const t = now != null ? smoothTime(deck.ctx, now) : deck.ctx?.currentTime;
    const pos = Number.isFinite(t) ? deck.positionAt(t) : deck.position;
    const beat0 = deck.bpm && deck.track ? ((deck.beatIndex(pos) % 4) + 4) % 4 : -1;
    let d0 = 0, showDiff = false;
    if (m0 && m0.bpm && m0.playing && deck.playing && beat0 >= 0) {
      const mult = syncBeatRatio(m0.effectiveBpm || m0.bpm, deck.effectiveBpm || deck.bpm);
      if (mult) {
        const mPos = Number.isFinite(t) ? m0.positionAt(t) : m0.position;
        d0 = -beatPhaseDelta(m0.beatPhase(mPos), deck.beatPhase(pos), mult);
        showDiff = true;
      }
    }
    const sigNow = `${W}|${beat0}|${deck.playing}|${showDiff ? Math.round(d0 * 200) : 'x'}`;
    if (sigNow === phaseSig) return;
    phaseSig = sigNow;
    const g = phase.getContext('2d'); g.clearRect(0, 0, W, H);
    if (!deck.bpm || !deck.track) return;
    const beat = beat0, seg = W / 4;
    for (let k = 0; k < 4; k++) { g.fillStyle = k === beat && deck.playing ? cssVar(`--deck${i + 1}`) : k === beat ? cssVar('--line-2') : cssVar('--panel-3'); g.fillRect(Math.round(k * seg + dpr), 0, Math.round(seg - 2 * dpr), Math.round(H * 0.42)); }
    if (showDiff) {
      const x = W / 2 + d0 * W / 2; const ok = Math.abs(d0) < 0.03;
      g.fillStyle = cssVar('--line-2'); g.fillRect(Math.round(W / 2 - dpr / 2), H * 0.55, Math.max(1, Math.round(dpr)), H * 0.45);
      g.fillStyle = ok ? cssVar('--green') : Math.abs(d0) < 0.1 ? cssVar('--amber') : cssVar('--red');
      g.fillRect(Math.min(x, W / 2), H * 0.6, Math.max(2 * dpr, Math.abs(x - W / 2)), H * 0.35);
    }
  };

  // ---------- secondary controls: switchable panels ----------
  // Only what matters stays on the deck face (platter, transport, sync, tempo, hot cues). Loops, FX, stems and key
  // live in panels picked with a segmented control; the Performance layout shows cues and loops side by side.
  // Panels keep their own class names (.loop-row, .fx-unit, .deck-stems, .key-row…) as mount points.
  // ---------- platter panel (T1-T4, T6): motor, weight, slip-mat, spin-back, rpm, quartz, deck lock ----------
  const vset = (patch) => setDeckVinyl(app, deck, patch);
  const vk = (label, k, title, fmt = (x) => `${x.toFixed(2)}s`) => {
    const [lo, hi] = VINYL_RANGES[k];
    return R(knob({ label, min: lo, max: hi, def: { start: 0, stop: 0, inertia: 0, slipmat: 0, jogWeight: 0.5, brakeTime: 1.2, spinTime: 1, spinSpeed: 4.5 }[k], get: () => deck.vinyl[k], set: (x) => vset({ [k]: Math.round(x * 100) / 100 }), size: 'sm', title, format: fmt }));
  };
  const rpmBtn = (r) => R(button(r === 33 ? '33' : String(r), { cls: 'xs rpm-btn', click: () => vset({ rpm: r }), active: () => deck.vinyl.rpm === r, title: `${r === 33 ? '33⅓' : r} rpm: one platter turn = ${(r === 33 ? 1.8 : 60 / r).toFixed(2)} s of audio (scratch scale; playback speed is the tempo fader)` }));
  const platterPanel = el('div', { class: 'platter-panel' },
    el('div', { class: 'platter-knobs' },
      vk('START', 'start', 'Motor start time: 0 to full speed (0 = instant, like a CDJ)'),
      vk('STOP', 'stop', 'Motor stop time on pause and reverse (0 = instant)'),
      vk('WEIGHT', 'jogWeight', 'Jog weight: light (0) to heavy (1)', (x) => x.toFixed(2)),
      vk('COAST', 'inertia', 'Platter inertia: a thrown record on a stopped deck coasts this long'),
      vk('SLIP', 'slipmat', 'Slip-mat: sticky (0) to slick (1): the record creeps under a still hand and spins up faster', (x) => x.toFixed(2)),
      vk('BRAKE', 'brakeTime', 'Brake time (Brake pad, MIDI brake; Tape Stop is 2.5x)'),
      vk('SPIN', 'spinTime', 'Spin-back length'),
      vk('THROW', 'spinSpeed', 'Spin-back throw speed', (x) => `${x.toFixed(1)}x`),
    ),
    el('div', { class: 'platter-row' },
      el('span', { class: 'key-lbl' }, 'RPM'), rpmBtn(33), rpmBtn(45), rpmBtn(78),
    ),
    el('div', { class: 'platter-row' },
      R(button('QUARTZ', { cls: 'xs', click: () => vset({ quartz: !deck.vinyl.quartz }), active: () => deck.vinyl.quartz, title: 'Quartz lock: tempo pinned at 0 % (the fader is ignored)' })),
      R(button('LOCK', { cls: 'xs', click: () => { deck.hardLock = !deck.hardLock; deck.emit('state'); }, active: () => deck.hardLock, title: 'Deck lock: while this deck plays, loads onto it are refused' })),
      R(button('START/STOP', { cls: 'xs', click: () => { app.engine.resume(); deck.startStop(); }, active: () => deck.playing, title: 'Turntable start / stop: always with motor ramps' })),
    ),
  );

  const PANELS = [['cues', 'Cues'], ['loops', 'Loops'], ['fx', 'FX'], ['stems', 'Stems'], ['key', 'Key'], ['platter', 'Vinyl']];
  const panelBodies = {
    cues: el('div', { class: 'deck-panel', 'data-panel': 'cues', role: 'tabpanel' }, modeBar, padGrid),
    loops: el('div', { class: 'deck-panel', 'data-panel': 'loops', role: 'tabpanel' }, loopRow, jumpRow, loopExtra),
    fx: el('div', { class: 'deck-panel', 'data-panel': 'fx', role: 'tabpanel' }, fxUnit),
    stems: el('div', { class: 'deck-panel', 'data-panel': 'stems', role: 'tabpanel' }, buildStemControls(app, deck)),
    key: el('div', { class: 'deck-panel', 'data-panel': 'key', role: 'tabpanel' }, keyRow),
    platter: el('div', { class: 'deck-panel', 'data-panel': 'platter', role: 'tabpanel' }, platterPanel),
  };
  const panelTabs = el('div', { class: 'panel-tabs', role: 'tablist', 'aria-label': `Deck ${i + 1} panels` },
    ...PANELS.map(([id, label]) => el('button', { class: 'panel-tab', role: 'tab', 'data-panel': id, onclick: () => showPanel(id) }, label)));
  const showPanel = (id) => {
    root.dataset.panel = id;
    for (const b of panelTabs.children) { const on = b.dataset.panel === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); }
    for (const [k, p] of Object.entries(panelBodies)) p.classList.toggle('shown', k === id);
  };
  deck.showPanel = showPanel;
  const fitLabels = () => {
    root.classList.remove('short-labels');
    const over = [...root.querySelectorAll('.lbl-dual')].some((x) => { const b = x.closest('.btn'); return b && b.offsetParent && b.scrollWidth > b.clientWidth + 1; });
    root.classList.toggle('short-labels', over);
  };
  let fitRaf = 0; const fitSoon = () => { if (!fitRaf) fitRaf = requestAnimationFrame(() => { fitRaf = 0; fitLabels(); }); };

  // ---------- assemble ----------
  const root = el('section', { class: 'deck empty', 'data-deck': i, style: { '--deck-color': DECK_COLORS[i] } },
    header,
    el('div', { class: 'overview-wrap' }, overview.canvas),
    phase,
    el('div', { class: 'deck-body' },
      el('div', { class: 'deck-left' },
        jog,
        el('div', { class: 'transport' }, cueBtn, playBtn, mixNowBtn),
      ),
      el('div', { class: 'deck-mid' },
        el('div', { class: 'sync-row' }, syncBtn, masterBtn),
        toggles,
        panelTabs,
        el('div', { class: 'deck-panels' }, ...Object.values(panelBodies)),
      ),
      tempo,
    ),
  );
  showPanel('cues');
  { const mid = root.querySelector('.deck-mid'); new ResizeObserver(fitSoon).observe(mid); for (const t of panelTabs.children) t.addEventListener('click', fitSoon); window.addEventListener('opendj-theme', () => requestAnimationFrame(fitSoon)); }

  // drag & drop tracks onto a deck
  root.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('drop'); });
  root.addEventListener('dragleave', () => root.classList.remove('drop'));
  root.addEventListener('drop', async (e) => {
    e.preventDefault(); root.classList.remove('drop');
    const fromDeck = e.dataTransfer.getData('text/x-opendj-deck');
    if (fromDeck !== '' && Number(fromDeck) !== i) return deck.cloneFrom(app.engine.decks[Number(fromDeck)]).catch((err) => app.toast(err.message));
    const tid = e.dataTransfer.getData('text/x-opendj-track');
    if (tid) return app.loadTrack(i, tid).catch(() => {}); // errors are shown as toasts
    const files = [...e.dataTransfer.files];
    const paths = files.map((f) => window.opendjNative?.pathForFile(f)).filter(Boolean);
    if (paths.length) { const r = await api.addFiles(paths); await app.library.refresh(); if (r.added[0]) app.loadTrack(i, r.added[0]).catch(() => {}); }
    else if (files.length) app.toast('Drag files from your library, or add their folder in the Library (browser mode cannot read file paths).');
  });

  // touch screens: a double-tap on the deck header opens the scratch view
  let lastTap = 0;
  header.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') return; if (e.timeStamp - lastTap < 320) { lastTap = 0; openScratchView(app, deck); } else lastTap = e.timeStamp; });
  header.draggable = true;
  header.title = 'Drag onto another deck for an instant double';
  header.addEventListener('dragstart', (e) => { if (!deck.track) return e.preventDefault(); e.dataTransfer.setData('text/x-opendj-deck', String(i)); });

  // ---------- updates ----------
  const updateMeta = () => {
    const t = deck.track;
    const f = !t && deck.error ? deck.failedTrack : null; // failed load: keep the track's name, show the error under it
    title.textContent = t ? t.title || tr('Untitled') : f ? `⚠ ${f.title || tr('Untitled')}` : (deck.error ? `⚠ ${tr(deck.error)}` : tr('Drop a track here'));
    const lp = deck.loading && deck.loadPhase;
    artistNote.textContent = lp ? `${lp.name}${lp.pct != null ? ` ${lp.pct} %` : '…'}` : '';
    title.title = t ? `${t.title || ''}${t.artist ? ' — ' + t.artist : ''}` : f ? tr('Could not load {0}: {1}', { 0: f.path || f.title, 1: tr(deck.error) }) : '';
    artist.textContent = t ? t.artist || '' : f ? tr('Could not load: {0}', { 0: tr(deck.error) }) : '';
    cover.style.backgroundImage = t && !t.scratchSample ? `url(${api.coverUrl(t.id)})` : '';
    sampleBadge.hidden = !deck.scratchSample;
    const cam = toCamelot(t?.key);
    const playing = deck.playingCamelot || cam;
    const sh = Math.round(deck.pitchSemis);
    keyBadge.textContent = t?.key ? `${playing || ''}${sh ? ` (${sh > 0 ? '+' : ''}${sh})` : ''} ${t.key !== cam ? t.key : ''}`.trim() : '';
    keyBadge.className = 'key-badge' + (playing ? ` cam-${playing.replace(/\D/g, '')}` : ''); keyBadge._ccompatible = undefined;
    root.classList.toggle('empty', !t && !deck.loading);
    root.classList.toggle('loading', !!deck.loading);
    root.classList.toggle('failed', !t && !!deck.error);
    renderPads();
  };
  deck.on('key', () => { keyVal.textContent = `${deck.keyShift > 0 ? '+' : ''}${deck.keyShift}`; updateMeta(); renderPads(); renderState(); });
  deck.on('load-progress', () => { const lp = deck.loadPhase; artistNote.textContent = lp ? `${lp.name}${lp.pct != null ? ` ${lp.pct} %` : '…'}` : ''; });
  deck.on('load', updateMeta); deck.on('loaded', () => { updateMeta(); renderState(); }); deck.on('error', updateMeta); deck.on('cues', renderPads); deck.on('sample', updateMeta);
  deck.on('vinyl', () => { renderState(); tempoFader.render(); });
  deck.on('glide', () => renderState());
  const renderState = () => { for (const r of renderers) r.render(); if (masterBadge.hidden === !!deck.isMaster) masterBadge.hidden = !deck.isMaster; };
  // MIX NOW with Automix off depends on the other deck too (loaded, playing)
  const refreshMixNow = () => { mixNowBtn.render(); const st = app.mixNowState?.(i); if (st) mixNowBtn.title = st.title; };
  for (const d of app.engine.decks) for (const ev of ['state', 'load', 'loaded']) d.on(ev, refreshMixNow);
  app.automix?.on('state', refreshMixNow);
  app.engine.on('master-deck', renderState);
  deck.on('state', renderState); deck.on('loop', () => { loopSize._t = loopSize.textContent = deck.loop?.active ? fmtBeats(deck.loopBeats) : fmtBeats(autoLoopBeats); renderState(); });
  deck.on('tempo', () => tempoFader.render());
  deck.on('tempo-range', () => { rangeSel.value = String(deck.tempoRange); tempoFader.render(); });

  let lastFrame = 0, lastIdleSig = '';
  const setText = (node, txt) => { if (node._t !== txt) { node._t = txt; node.textContent = txt; } };
  const setClass = (node, cls, on) => { on = !!on; if (node['_c' + cls] !== on) { node['_c' + cls] = on; node.classList.toggle(cls, on); } };
  root.frame = (now) => {
    jog.draw(now); overview.draw(now); drawPhase(now);
    if (now - lastFrame < 50) return; lastFrame = now;
    const pos = deck.positionAt(smoothTime(deck.ctx, now));
    const m = app.engine.masterDeck(deck);
    if (!deck.playing && !deck.loading && !deck.scratching) {
      const idleSig = `${pos.toFixed(2)}|${deck.tempo}|${deck.bpm}|${deck.track?.id || ''}|${deck.loop?.active ? 1 : 0}|${deck.jumpSize}|${deck.quantizeDiv}|${deck.vinyl.quartz ? 1 : 0}|${deck.loopAdjust || ''}|${m?.playingCamelot || ''}`;
      if (idleSig === lastIdleSig) return;
      lastIdleSig = idleSig;
    } else {
      lastIdleSig = '';
    }
    setText(elapsed, fmtTime(pos));
    setText(remain, deck.track && deck.duration > 0 ? fmtTime(deck.duration - pos, true) : '00:00.0'); // no "-00:00.0" on empty decks
    setClass(remain, 'warn', deck.duration > 0 && deck.duration - pos < 30 && deck.playing);
    setText(bpmBig, deck.effectiveBpm ? deck.effectiveBpm.toFixed(2) : '--');
    setText(bpmSub, deck.bpm ? `${deck.tempo >= 0 ? '+' : ''}${deck.tempo.toFixed(2)}%  ·  ${deck.bpm.toFixed(2)}` : '');
    setText(tempoVal, `${deck.tempo >= 0 ? '+' : ''}${deck.tempo.toFixed(2)}%`);
    if (!deck.loop?.active) setText(loopSize, fmtBeats(autoLoopBeats));
    setText(jumpLabel, fmtBeats(deck.jumpSize)); setText(qDivLabel, fmtDiv(deck.quantizeDiv));
    setClass(root, 'quartz', deck.vinyl.quartz); setClass(root, 'loop-adjust', !!deck.loopAdjust);
    // harmonic hint vs. master deck
    setClass(keyBadge, 'compatible', m && deck.playingCamelot && m.playingCamelot && camelotCompatible(deck.playingCamelot, m.playingCamelot));
    if (!deck.keyLock && deck.tempo !== deck._lastKeyTempo) { deck._lastKeyTempo = deck.tempo; updateMeta(); }
    // All other buttons/faders update via deck events; only cueBtn depends on live playhead proximity to cuePoint
    cueBtn.render();
  };
  return root;
}
