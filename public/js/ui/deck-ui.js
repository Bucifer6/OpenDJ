import { el, fmtTime } from '../util.js';
import { knob, fader, button, jogWheel } from './controls.js';
import { OverviewWaveform } from './waveform.js';
import { EFFECTS, BEAT_DIVISIONS } from '../audio/effects.js';
import { api } from '../api.js';
import { cssVar } from './themes.js';
import { HOTCUE_COLORS } from '../audio/deck.js';
import { camelotCompatible, toCamelot } from '../audio/analysis-core.js';

export const DECK_COLORS = ['var(--deck1)', 'var(--deck2)', 'var(--deck3)', 'var(--deck4)'];
const LOOP_SIZES = [1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
const fmtBeats = (b) => (b >= 1 ? String(b) : b === 0.5 ? '½' : b === 0.25 ? '¼' : b === 0.125 ? '⅛' : b === 0.75 ? '¾' : b.toFixed(2));

export function buildDeck(app, deck) {
  const i = deck.index, ch = app.engine.channels[i];
  const renderers = [];
  const R = (c) => { if (c?.render) renderers.push(c); return c; };
  const shift = () => app.shift;

  // ---------- header ----------
  const cover = el('div', { class: 'deck-cover' });
  const title = el('div', { class: 'deck-title' }, 'Drop a track here');
  const artist = el('div', { class: 'deck-artist' }, '');
  const keyBadge = el('span', { class: 'key-badge' });
  const bpmBig = el('div', { class: 'deck-bpm' }, '--');
  const bpmSub = el('div', { class: 'deck-bpm-sub' }, '');
  const elapsed = el('div', { class: 'deck-time' }, '00:00.0');
  const remain = el('div', { class: 'deck-time remain' }, '-00:00.0');
  const masterBadge = el('span', { class: 'badge master-badge' }, 'MASTER');
  const header = el('div', { class: 'deck-header' },
    el('div', { class: 'deck-num' }, String(i + 1)),
    cover,
    el('div', { class: 'deck-meta' }, title, el('div', { class: 'deck-sub' }, artist, keyBadge, masterBadge)),
    el('div', { class: 'deck-times' }, elapsed, remain),
    el('div', { class: 'deck-bpmbox' }, bpmBig, bpmSub),
  );
  const overview = new OverviewWaveform(deck, () => app.settings);

  // ---------- transport ----------
  const cueBtn = R(button('CUE', { cls: 'btn-cue big', down: () => deck.cueDown(), up: () => deck.cueUp(), active: () => deck.cuePreview || (!deck.playing && deck.track && Math.abs(deck.position - deck.cuePoint) < 0.02) }));
  const playBtn = R(button('▶❚❚', { cls: 'btn-play big', down: () => { app.engine.resume(); deck.togglePlay(); }, active: () => deck.playing }));
  const syncBtn = R(button('SYNC', { cls: 'btn-sync', click: () => deck.sync(), active: () => deck.syncOn }));
  const masterBtn = R(button('MASTER', { cls: 'btn-master', click: () => deck.setMaster(), active: () => deck.isMaster }));
  const toggles = el('div', { class: 'deck-toggles' },
    R(button('KEY LOCK', { cls: 'sm', click: () => deck.setKeyLock(!deck.keyLock), active: () => deck.keyLock, title: 'Master tempo: change tempo without changing pitch' })),
    R(button('QUANT', { cls: 'sm', click: () => deck.setQuantize(!deck.quantize), active: () => deck.quantize, title: 'Snap cues, loops and jumps to the beat grid' })),
    R(button('SLIP', { cls: 'sm', click: () => deck.setSlip(!deck.slip), active: () => deck.slip, title: 'Slip mode: track continues silently under loops, scratches and reverse' })),
    R(button('REV', { cls: 'sm', click: () => deck.setReverse(!deck.reverse), active: () => deck.reverse })),
    R(button('VINYL', { cls: 'sm', click: () => { deck.vinylMode = !deck.vinylMode; }, active: () => deck.vinylMode, title: 'Vinyl mode: touching the platter scratches' })),
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
  const jog = jogWheel(deck);
  jog.style.setProperty('--deck-color', DECK_COLORS[i]);

  // ---------- tempo ----------
  const rangeSel = el('select', { class: 'sel tiny', title: 'Tempo range' }, ...[6, 8, 10, 16, 25, 50, 100].map((r) => el('option', { value: r }, `±${r}%`)));
  rangeSel.value = String(deck.tempoRange);
  rangeSel.addEventListener('change', () => { deck.setTempoRange(Number(rangeSel.value)); tempoFader.render(); });
  const tempoFader = R(fader({ min: -1, max: 1, def: 0, get: () => deck.tempo / deck.tempoRange, set: (v) => deck.setTempoFader(v), invert: true, cls: 'tempo-fader', title: 'Tempo (double-click to reset)' }));
  const tempoVal = el('div', { class: 'tempo-val' }, '0.00%');
  const bendBtns = el('div', { class: 'bend' },
    button('−', { cls: 'sm', down: () => deck.setBend(-0.04), up: () => deck.setBend(0), title: 'Pitch bend down (nudge)' }),
    button('+', { cls: 'sm', down: () => deck.setBend(0.04), up: () => deck.setBend(0), title: 'Pitch bend up (nudge)' }),
  );
  const tempo = el('div', { class: 'deck-tempo' }, rangeSel, tempoFader, tempoVal, bendBtns,
    button('RESET', { cls: 'sm', click: () => { deck.resetTempo(); tempoFader.render(); } }));

  // ---------- loops ----------
  const loopSize = el('div', { class: 'loop-size' }, '4');
  let autoLoopBeats = 4;
  const loopRow = el('div', { class: 'loop-row' },
    R(button('IN', { cls: 'sm', click: () => deck.loopInPress(), active: () => deck.loopIn != null && !deck.loop?.active })),
    R(button('OUT', { cls: 'sm', click: () => deck.loopOutPress() })),
    R(button('RELOOP', { cls: 'sm', click: () => deck.reloop(), active: () => deck.loop?.active })),
    button('½', { cls: 'sm', click: () => { if (deck.loop) deck.loopHalve(); else { autoLoopBeats = Math.max(1 / 8, autoLoopBeats / 2); } } }),
    R(button(loopSize, { cls: 'sm loop-btn', click: () => deck.autoLoop(autoLoopBeats), active: () => deck.loop?.active, title: 'Auto beat loop' })),
    button('×2', { cls: 'sm', click: () => { if (deck.loop) deck.loopDouble(); else { autoLoopBeats = Math.min(64, autoLoopBeats * 2); } } }),
  );
  let jumpBeats = 4;
  const jumpLabel = el('span', {}, '4');
  const jumpRow = el('div', { class: 'loop-row' },
    button('◀◀', { cls: 'sm', click: () => deck.beatJump(-jumpBeats), title: 'Beat jump back' }),
    button(el('span', {}, 'JUMP ', jumpLabel), { cls: 'sm', click: () => { jumpBeats = jumpBeats >= 32 ? 1 : jumpBeats * 2; jumpLabel.textContent = jumpBeats; } }),
    button('▶▶', { cls: 'sm', click: () => deck.beatJump(jumpBeats), title: 'Beat jump forward' }),
    button('MEM', { cls: 'sm', click: () => deck.addMemoryCue(), title: 'Add memory cue' }),
    button('GRID', { cls: 'sm', click: () => app.dialogs.gridEditor(deck), title: 'Edit beat grid' }),
    button('⏏', { cls: 'sm', click: () => deck.eject(), title: 'Eject' }),
  );

  // ---------- performance pads ----------
  let padMode = 'hotcue';
  const padModes = ['hotcue', 'roll', 'slicer', 'jump', 'pitch', 'sampler', 'fx'];
  const modeLabels = { hotcue: 'CUE', roll: 'ROLL', slicer: 'SLICE', jump: 'JUMP', pitch: 'PITCH', sampler: 'SMPL', fx: 'FX' };
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
    } else if (padMode === 'fx') {
      const fx = ['brake', 'backspin', 'censor', 'echoOut', 'roll1', 'roll2', 'filterSweep', 'tapeStop'][n];
      app.padFx(deck, fx, down);
    }
  };
  for (let n = 0; n < 8; n++) {
    const p = el('button', { class: 'pad' }, el('span', { class: 'pad-label' }));
    p.addEventListener('pointerdown', (e) => { e.preventDefault(); app.engine.resume(); padAction(n, true); p.classList.add('pressed'); });
    const up = () => { if (p.classList.contains('pressed')) { p.classList.remove('pressed'); padAction(n, false); } };
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) p.addEventListener(ev, up);
    p.addEventListener('contextmenu', (e) => { e.preventDefault(); if (padMode === 'hotcue') deck.deleteHotCue(n); });
    pads.push(p); padGrid.append(p);
  }
  const setPadMode = (m) => { padMode = m; for (const b of modeBar.children) b.classList.toggle('active', b.dataset.mode === m); renderPads(); };
  for (const m of padModes) modeBar.append(el('button', { class: 'pad-mode', 'data-mode': m, onclick: () => setPadMode(m) }, modeLabels[m]));
  const renderPads = () => {
    pads.forEach((p, n) => {
      const lbl = p.firstChild; let txt = '', color = '';
      if (padMode === 'hotcue') { const c = deck.hotCue(n); txt = c ? (c.name || String.fromCharCode(65 + n)) : String.fromCharCode(65 + n); color = c ? (c.color || HOTCUE_COLORS[n]) : ''; }
      else if (padMode === 'roll') { txt = fmtBeats(LOOP_SIZES[n] / 2); color = '#2ed47a'; }
      else if (padMode === 'jump') { const b = [1, 2, 4, 8][n % 4]; txt = (n < 4 ? '−' : '+') + b; color = '#3ea6ff'; }
      else if (padMode === 'slicer') { txt = `Slice ${n + 1}`; color = '#ff5ea8'; }
      else if (padMode === 'pitch') { const st = PITCH_STEPS[n]; txt = `${st > 0 ? '+' : ''}${st} ${String.fromCharCode(65 + pitchCue)}`; color = deck.keyShift === st ? '#ffffff' : '#ffb020'; }
      else if (padMode === 'sampler') { txt = app.engine.sampler.slots[n]?.name || '—'; color = '#c06cff'; }
      else { txt = ['Brake', 'Backspin', 'Censor', 'Echo Out', 'Roll ¼', 'Roll ⅛', 'Filter Sweep', 'Tape Stop'][n]; color = '#ff8a3d'; }
      lbl.textContent = txt;
      p.style.setProperty('--pad-color', color || 'transparent');
      p.classList.toggle('lit', !!color);
    });
  };
  deck.padMode = (m) => setPadMode(m);
  deck.padPress = (n, down) => padAction(n, down);
  setPadMode('hotcue');

  // ---------- FX unit ----------
  const fxSel = el('select', { class: 'sel' }, ...EFFECTS.map((e) => el('option', { value: e.id }, e.label)));
  fxSel.value = ch.state.fxType;
  fxSel.addEventListener('change', () => ch.set('fxType', fxSel.value));
  const beatSel = el('select', { class: 'sel tiny' }, ...BEAT_DIVISIONS.map((b) => el('option', { value: b }, `${fmtBeats(b)} beat`)));
  beatSel.value = String(ch.state.fxBeats);
  beatSel.addEventListener('change', () => ch.set('fxBeats', Number(beatSel.value)));
  const fxOn = R(button('FX ON', { cls: 'sm fx-on', click: () => ch.set('fxOn', !ch.state.fxOn), active: () => ch.state.fxOn }));
  const fxMix = R(knob({ label: 'MIX', min: 0, max: 1, def: 0.5, get: () => ch.state.fxMix, set: (v) => ch.set('fxMix', v), size: 'sm' }));
  const fxParam = R(knob({ label: 'PARAM', min: 0, max: 1, def: 0.5, get: () => ch.state.fxParam, set: (v) => ch.set('fxParam', v), size: 'sm' }));
  ch.on('change', (k) => { if (k === 'fxType') fxSel.value = ch.state.fxType; if (k === 'fxBeats') beatSel.value = String(ch.state.fxBeats); });
  const fxUnit = el('div', { class: 'fx-unit' }, el('div', { class: 'fx-col' }, fxSel, beatSel), fxMix, fxParam, fxOn);

  // ---------- phase meter (beat position in the bar + offset vs master) ----------
  const phase = el('canvas', { class: 'phase-meter', height: 12 });
  const drawPhase = () => {
    const dpr = devicePixelRatio || 1, W = Math.round(phase.clientWidth * dpr) || 1, H = Math.round(12 * dpr);
    if (phase.width !== W) { phase.width = W; phase.height = H; }
    const g = phase.getContext('2d'); g.clearRect(0, 0, W, H);
    if (!deck.bpm || !deck.track) return;
    const beat = ((deck.beatIndex() % 4) + 4) % 4, seg = W / 4;
    for (let k = 0; k < 4; k++) { g.fillStyle = k === beat && deck.playing ? cssVar(`--deck${i + 1}`) : k === beat ? cssVar('--line-2') : cssVar('--panel-3'); g.fillRect(k * seg + 1, 0, seg - 2, H * 0.45); }
    const m = app.engine.masterDeck(deck);
    if (m && m.bpm && m.playing && deck.playing) {
      let d = deck.beatPhase() - m.beatPhase(); if (d > 0.5) d -= 1; if (d < -0.5) d += 1;
      const x = W / 2 + d * W / 2; const ok = Math.abs(d) < 0.03;
      g.fillStyle = '#2a313b'; g.fillRect(W / 2 - dpr / 2, H * 0.55, dpr, H * 0.45);
      g.fillStyle = ok ? '#2ed47a' : Math.abs(d) < 0.1 ? '#ffb020' : '#ff3b4d';
      g.fillRect(Math.min(x, W / 2), H * 0.6, Math.max(2 * dpr, Math.abs(x - W / 2)), H * 0.35);
    }
  };

  // ---------- assemble ----------
  const root = el('section', { class: 'deck', 'data-deck': i, style: { '--deck-color': DECK_COLORS[i] } },
    header,
    el('div', { class: 'overview-wrap' }, overview.canvas),
    phase,
    el('div', { class: 'deck-body' },
      el('div', { class: 'deck-left' },
        jog,
        el('div', { class: 'transport' }, cueBtn, playBtn),
      ),
      el('div', { class: 'deck-mid' },
        el('div', { class: 'sync-row' }, syncBtn, masterBtn),
        toggles, keyRow,
        loopRow, jumpRow,
        modeBar, padGrid,
        fxUnit,
      ),
      tempo,
    ),
  );

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

  header.draggable = true;
  header.title = 'Drag onto another deck for an instant double';
  header.addEventListener('dragstart', (e) => { if (!deck.track) return e.preventDefault(); e.dataTransfer.setData('text/x-opendj-deck', String(i)); });

  // ---------- updates ----------
  const updateMeta = () => {
    const t = deck.track;
    title.textContent = t ? t.title || 'Untitled' : (deck.error ? `⚠ ${deck.error}` : 'Drop a track here');
    title.title = t ? `${t.title || ''}${t.artist ? ' — ' + t.artist : ''}` : '';
    artist.textContent = t ? t.artist || '' : '';
    cover.style.backgroundImage = t ? `url(${api.coverUrl(t.id)})` : '';
    const cam = toCamelot(t?.key);
    const playing = deck.playingCamelot || cam;
    const sh = Math.round(deck.pitchSemis);
    keyBadge.textContent = t?.key ? `${playing || ''}${sh ? ` (${sh > 0 ? '+' : ''}${sh})` : ''} ${t.key !== cam ? t.key : ''}`.trim() : '';
    keyBadge.className = 'key-badge' + (playing ? ` cam-${playing.replace(/\D/g, '')}` : '');
    renderPads();
  };
  deck.on('key', () => { keyVal.textContent = `${deck.keyShift > 0 ? '+' : ''}${deck.keyShift}`; updateMeta(); renderPads(); });
  deck.on('load', updateMeta); deck.on('loaded', updateMeta); deck.on('error', updateMeta); deck.on('cues', renderPads);
  const renderState = () => { for (const r of renderers) r.render(); masterBadge.style.display = deck.isMaster ? '' : 'none'; };
  deck.on('state', renderState); deck.on('loop', () => { loopSize.textContent = deck.loop?.active ? fmtBeats(deck.loopBeats) : fmtBeats(autoLoopBeats); });
  deck.on('tempo', () => tempoFader.render());

  let lastFrame = 0;
  root.frame = (now) => {
    jog.draw(); overview.draw(); drawPhase();
    if (now - lastFrame < 50) return; lastFrame = now;
    const pos = deck.position;
    elapsed.textContent = fmtTime(pos);
    remain.textContent = fmtTime(deck.duration - pos, true);
    remain.classList.toggle('warn', deck.duration > 0 && deck.duration - pos < 30 && deck.playing);
    bpmBig.textContent = deck.effectiveBpm ? deck.effectiveBpm.toFixed(2) : '--';
    bpmSub.textContent = deck.bpm ? `${deck.tempo >= 0 ? '+' : ''}${deck.tempo.toFixed(2)}%  ·  ${deck.bpm.toFixed(2)}` : '';
    tempoVal.textContent = `${deck.tempo >= 0 ? '+' : ''}${deck.tempo.toFixed(2)}%`;
    if (!deck.loop?.active) loopSize.textContent = fmtBeats(autoLoopBeats);
    // harmonic hint vs. master deck
    const m = app.engine.masterDeck(deck);
    keyBadge.classList.toggle('compatible', !!(m && deck.playingCamelot && m.playingCamelot && camelotCompatible(deck.playingCamelot, m.playingCamelot)));
    if (!deck.keyLock && deck.tempo !== deck._lastKeyTempo) { deck._lastKeyTempo = deck.tempo; updateMeta(); }
    renderState();
  };
  return root;
}
