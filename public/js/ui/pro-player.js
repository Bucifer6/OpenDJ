// "Pro Media Player" deck look: the deck laid out like a club media player (an original design; no maker's names or
// trade dress). Top: menu buttons, source column (deck panels), a colour screen (title bar, Player Blue detail
// waveform, big time digits, tempo / BPM boxes, overview with needle; deck panels open on the screen), a browse
// encoder with BACK. Then a needle-search strip, the loop row, and the body: 8 hot-cue pads, direction switch, track
// search / search and the big CUE / PLAY keys on the left; a big lit jog with a centre display; vinyl speed adjust,
// jog mode / adjust, sync / master, tempo range, master tempo, reset and a long tempo slider on the right.
// Every control calls the same deck functions as the standard deck (and the MIDI targets).
import { el, fmtTime } from '../util.js';
import { knob, fader, button, jogWheel } from './controls.js';
import { DetailWaveform, OverviewWaveform } from './waveform.js';
import { HOTCUE_COLORS } from '../audio/deck.js';
import { icon } from './icons.js';
import { haptics } from './haptics.js';
import { setDeckVinyl, needleLocked } from '../midi/deck-targets.js';
import { VINYL_RANGES } from '../audio/vinyl.js';
import { api } from '../api.js';

const TEMPO_STEPS = [6, 10, 16, 100]; // ±6 / ±10 / ±16 / WIDE

/**
 * Build the media-player face for `deck`. ctx: { R (render registry), shift(), panels (the deck's panel container),
 * panelTabs, showPanel(id), deckColor }. Returns { root, frame(now), mountPanels(on) }.
 */
export function buildProPlayer(app, deck, ctx) {
  const { R, shift } = ctx, i = deck.index;
  const lbl = (t, cls = '') => el('span', { class: `pmp-silk ${cls}` }, t);
  const btn = (label, o) => R(button(label, { ...o, cls: `pmp-btn ${o.cls || ''}` }));

  // ---------------------------------------------------------------- screen
  let screenMode = 'wave';
  const detail = new DetailWaveform(deck, () => app.settings, { style: 'player-blue' });
  const overview = new OverviewWaveform(deck, () => app.settings, { style: 'player-blue', needleLocked: () => needleLocked(app), needleHint: () => app.toast('Needle lock is on: hold a moment to drop the needle on a playing deck') });
  const sTitle = el('div', { class: 'pmp-title' }), sArtist = el('div', { class: 'pmp-artist' });
  const sMaster = el('span', { class: 'pmp-badge master' }, 'MASTER'), sSync = el('span', { class: 'pmp-badge sync' }, 'SYNC');
  const tElapsed = el('div', { class: 'pmp-digits' }), tRemain = el('div', { class: 'pmp-digits remain' });
  const tTempo = el('div', { class: 'pmp-box-val' }), tRange = el('div', { class: 'pmp-box-sub' }), tBpm = el('div', { class: 'pmp-box-val bpm' }), tKey = el('div', { class: 'pmp-box-sub' });
  const panelHost = el('div', { class: 'pmp-panel-host' });
  const waveView = el('div', { class: 'pmp-wave' }, detail.canvas);
  const screen = el('div', { class: 'pmp-screen', 'data-mode': 'wave' },
    el('div', { class: 'pmp-titlebar' }, el('span', { class: 'pmp-badge num' }, String(i + 1)), el('div', { class: 'pmp-meta' }, sTitle, sArtist), sSync, sMaster),
    waveView, panelHost,
    el('div', { class: 'pmp-info' },
      el('div', { class: 'pmp-timebox' }, lbl('TIME'), tElapsed, lbl('REMAIN'), tRemain),
      el('div', { class: 'pmp-box' }, lbl('TEMPO'), tTempo, tRange),
      el('div', { class: 'pmp-box' }, lbl('BPM'), tBpm, tKey)),
    el('div', { class: 'pmp-ov' }, overview.canvas),
  );
  const setScreen = (mode) => {
    screenMode = mode === screenMode && mode !== 'wave' ? 'wave' : mode;
    screen.dataset.mode = screenMode === 'wave' ? 'wave' : 'panel';
    if (screenMode !== 'wave') ctx.showPanel(screenMode);
    for (const b of srcCol.children) b.classList.toggle('active', b.dataset.panel === screenMode);
  };
  // source column (left of the screen): the deck panels
  const SOURCES = [['cues', 'PADS'], ['loops', 'LOOPS'], ['fx', 'FX'], ['stems', 'STEMS'], ['key', 'KEY'], ['platter', 'PLATTER']];
  const srcCol = el('div', { class: 'pmp-src' }, ...SOURCES.map(([id, t]) => el('button', { class: 'pmp-src-btn', 'data-panel': id, title: `Show the ${t.toLowerCase()} panel on the screen`, onclick: () => setScreen(id) }, t)));
  // menu buttons above the screen
  const menu = el('div', { class: 'pmp-menu' },
    el('button', { class: 'pmp-menu-btn c1', title: 'Library: focus the search box', onclick: () => app.library?.search?.focus() }, 'BROWSE'),
    el('button', { class: 'pmp-menu-btn c2', title: 'Add a memory cue here', onclick: () => deck.addMemoryCue() }, 'TAG'),
    el('button', { class: 'pmp-menu-btn c3', title: 'Back to the waveform', onclick: () => setScreen('wave') }, 'WAVE'),
    el('button', { class: 'pmp-menu-btn c4', title: 'Settings', onclick: () => app.dialogs.settings() }, 'MENU'),
  );
  // browse encoder (right of the screen): turn = move the library selection, press = load it here; BACK
  const enc = el('div', { class: 'pmp-encoder', role: 'slider', tabindex: 0, 'aria-label': 'Browse: turn to move through the library, press to load' }, el('div', { class: 'pmp-encoder-ind' }));
  let encA = 0, encY = null;
  const turn = (d) => { encA += d * 18; enc.firstChild.style.transform = `rotate(${encA}deg)`; app.library?.moveSelection(d); };
  enc.addEventListener('wheel', (e) => { e.preventDefault(); turn(Math.sign(e.deltaY)); }, { passive: false });
  enc.addEventListener('pointerdown', (e) => { encY = e.clientY; enc.setPointerCapture(e.pointerId); enc._moved = false; });
  enc.addEventListener('pointermove', (e) => { if (encY == null) return; const d = Math.trunc((e.clientY - encY) / 14); if (d) { encY += d * 14; enc._moved = true; turn(Math.sign(d)); } });
  enc.addEventListener('pointerup', () => { if (encY != null && !enc._moved) app.library?.loadSelected(i); encY = null; });
  enc.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') turn(1); else if (e.key === 'ArrowUp') turn(-1); else if (e.key === 'Enter') app.library?.loadSelected(i); });
  const browse = el('div', { class: 'pmp-browse' }, enc, lbl('BROWSE'), el('button', { class: 'pmp-btn sm', title: 'Back to the waveform', onclick: () => setScreen('wave') }, 'BACK'));

  // ---------------------------------------------------------------- needle search strip
  const stripPos = el('div', { class: 'pmp-strip-pos' });
  const strip = el('div', { class: 'pmp-strip', title: 'Needle search: touch to drop the needle (hold on a playing deck when needle lock is on)' }, stripPos, lbl('NEEDLE SEARCH', 'pmp-strip-lbl'));
  { let rect = null, armed = false, t = 0, frac = 0;
    const fr = (e) => Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    strip.addEventListener('pointerdown', (e) => { rect = strip.getBoundingClientRect(); strip.setPointerCapture(e.pointerId); frac = fr(e); armed = !(deck.playing && needleLocked(app)); if (armed) deck.needleDrop(frac); else { strip.classList.add('hold'); t = setTimeout(() => { armed = true; strip.classList.remove('hold'); deck.needleDrop(frac); }, 400); } });
    strip.addEventListener('pointermove', (e) => { if (!rect) return; frac = fr(e); if (armed) deck.needleDrop(frac); });
    for (const ev of ['pointerup', 'pointercancel']) strip.addEventListener(ev, () => { clearTimeout(t); strip.classList.remove('hold'); rect = null; armed = false; });
  }

  // ---------------------------------------------------------------- loop row + cue / loop call, delete, memory
  const memCues = () => (deck.track?.cues || []).filter((c) => c.index < 0).sort((a, b) => a.position - b.position);
  const call = (dir) => {
    const list = [...memCues(), ...deck.hotCues].map((c) => c.position).sort((a, b) => a - b);
    const p = deck.position, t = dir > 0 ? list.find((x) => x > p + 0.05) : [...list].reverse().find((x) => x < p - 0.05);
    if (t != null) { deck.seek(t); if (!deck.playing) deck.cuePoint = t; deck.emit('cues'); }
  };
  const loopRow = el('div', { class: 'pmp-looprow' },
    el('div', { class: 'pmp-group' }, lbl('LOOP'),
      btn('IN', { cls: 'round orange', click: () => deck.loopInPress(), active: () => deck.loopIn != null && !deck.loop?.active, title: 'Loop in' }),
      btn('OUT', { cls: 'round orange', click: () => deck.loopOutPress(), active: () => !!deck.loop?.active, title: 'Loop out' }),
      btn('RELOOP/EXIT', { cls: 'wide', click: () => deck.reloop(), active: () => !!deck.loop?.active }),
      btn('½', { cls: 'sq', click: () => (deck.loop ? deck.loopHalve() : deck.autoLoop(2)), title: 'Halve the loop' }),
      btn('×2', { cls: 'sq', click: () => (deck.loop ? deck.loopDouble() : deck.autoLoop(8)), title: 'Double the loop' })),
    el('div', { class: 'pmp-group' }, lbl('CUE/LOOP CALL'),
      btn(icon('rewind'), { cls: 'sq', click: () => call(-1), title: 'Previous cue / loop' }),
      btn(icon('fast-forward'), { cls: 'sq', click: () => call(1), title: 'Next cue / loop' }),
      btn('DELETE', { click: () => { const p = deck.position, m = memCues().find((c) => Math.abs(c.position - p) < 0.1); if (m) { deck.track.cues = deck.track.cues.filter((c) => c !== m); deck.saveCues(); } else app.toast('Call a memory cue first, then DELETE removes it'); }, title: 'Delete the memory cue at the play head' }),
      btn('MEMORY', { click: () => deck.addMemoryCue(), title: 'Store a memory cue (or the active loop)' })),
  );

  // ---------------------------------------------------------------- left column
  const pads = el('div', { class: 'pmp-pads' });
  const padEls = [];
  for (let n = 0; n < 8; n++) {
    const p = el('button', { class: 'pmp-pad', title: `Hot cue ${String.fromCharCode(65 + n)} (Shift: delete)` }, String.fromCharCode(65 + n));
    p.addEventListener('pointerdown', (e) => { e.preventDefault(); app.engine.resume(); if (shift()) deck.deleteHotCue(n); else deck.hotCueDown(n); p.classList.add('pressed'); });
    const up = () => { if (p.classList.contains('pressed')) { p.classList.remove('pressed'); deck.hotCueUp(n); } };
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) p.addEventListener(ev, up);
    p.addEventListener('contextmenu', (e) => { e.preventDefault(); deck.deleteHotCue(n); });
    padEls.push(p); pads.append(p);
  }
  const renderPads = () => padEls.forEach((p, n) => { const c = deck.hotCue(n); p.style.setProperty('--pad-color', c ? (c.color || HOTCUE_COLORS[n]) : 'transparent'); p.classList.toggle('lit', !!c); });
  let seekT = 0;
  const holdSeek = (dir) => ({ down: () => { clearInterval(seekT); seekT = setInterval(() => deck.seek(deck.position + dir * 0.5), 50); }, up: () => clearInterval(seekT) });
  const left = el('div', { class: 'pmp-left' },
    el('div', { class: 'pmp-group col pmp-padcol' }, lbl('HOT CUE'), pads),
    el('div', { class: 'pmp-leftctl' },
    el('div', { class: 'pmp-group' }, lbl('DIRECTION'),
      btn('FWD', { cls: 'xs', click: () => deck.setReverse(false), active: () => !deck.reverse }),
      btn('REV', { cls: 'xs', click: () => deck.setReverse(true), active: () => deck.reverse })),
    el('div', { class: 'pmp-group pmp-opt' }, lbl('TRACK SEARCH'),
      btn(el('span', { class: 'ico-flip' }, icon('next')), { cls: 'sq', click: () => (deck.position > 2 ? deck.seek(0) : app.library?.moveSelection(-1)), title: 'Back to the track start (at the start: previous track in the library)' }),
      btn(icon('next'), { cls: 'sq', click: () => { if (deck.playing) return app.toast('Pause this deck to load the next track'); app.library?.moveSelection(1); app.library?.loadSelected(i); }, title: 'Load the next track of the library list' })),
    el('div', { class: 'pmp-group pmp-opt' }, lbl('SEARCH'),
      btn(icon('rewind'), { cls: 'sq', ...holdSeek(-1), title: 'Search backwards (hold)' }),
      btn(icon('fast-forward'), { cls: 'sq', ...holdSeek(1), title: 'Search forwards (hold)' })),
    el('div', { class: 'pmp-transport' },
      R(button('CUE', { cls: 'pmp-key cue', down: () => deck.cueDown(), up: () => deck.cueUp(), active: () => deck.cuePreview || (!deck.playing && deck.track && Math.abs(deck.position - deck.cuePoint) < 0.02) })),
      R(button(el('span', { class: 'play-glyph' }, icon('play'), icon('pause')), { cls: 'pmp-key play', title: 'Play / pause', down: () => { app.engine.resume(); deck.togglePlay(); }, active: () => deck.playing })))),
  );

  // ---------------------------------------------------------------- centre: jog
  const jog = jogWheel(deck, { skin: () => 'projog', haptics });
  jog.classList.add('pmp-jog');

  // ---------------------------------------------------------------- right column
  const vk = (label, k, title, fmt = (x) => `${x.toFixed(1)}s`) => {
    const [lo, hi] = VINYL_RANGES[k];
    return R(knob({ label, min: lo, max: hi, def: k === 'jogWeight' ? 0.5 : 0, get: () => deck.vinyl[k], set: (x) => setDeckVinyl(app, deck, { [k]: Math.round(x * 100) / 100 }), size: 'sm', title, format: fmt }));
  };
  const tempoFader = R(fader({ min: -1, max: 1, def: 0, get: () => deck.tempo / deck.tempoRange, set: (v) => deck.setTempoFader(v), invert: true, cls: 'pmp-tempo-fader', title: 'Tempo (double-click to reset)' }));
  const tempoLed = el('div', { class: 'pmp-tempo-led' });
  const right = el('div', { class: 'pmp-right' }, el('div', { class: 'pmp-rctl' },
    el('div', { class: 'pmp-group pmp-opt' },
      btn('LOAD', { cls: 'xs', click: () => app.library?.loadSelected(i), title: 'Load the selected library track' }),
      btn(icon('eject'), { cls: 'xs', click: () => deck.eject(), title: 'Eject' })),
    el('div', { class: 'pmp-group col pmp-opt' }, lbl('VINYL SPEED ADJ.'), el('div', { class: 'pmp-knobs' },
      vk('TOUCH/BRAKE', 'stop', 'Stop time: how fast the deck brakes on pause'),
      vk('RELEASE/START', 'start', 'Start time: how fast the deck reaches speed (and after you let go of the jog)'))),
    el('div', { class: 'pmp-group col' }, lbl('JOG MODE'), el('div', { class: 'pmp-row' },
      btn('VINYL', { cls: 'xs', click: () => { deck.vinylMode = true; deck.emit('state'); }, active: () => deck.vinylMode, title: 'Vinyl: the jog top scratches' }),
      btn('CDJ', { cls: 'xs', click: () => { deck.vinylMode = false; deck.emit('state'); }, active: () => !deck.vinylMode, title: 'The whole jog bends the tempo' })),
    el('div', { class: 'pmp-opt pmp-jogadj' }, vk('JOG ADJUST', 'jogWeight', 'Jog weight: light to heavy', (x) => x.toFixed(2)))),
    el('div', { class: 'pmp-row' },
      btn('SYNC', { cls: 'xs', title: 'Beat sync', click: () => deck.sync(), active: () => deck.syncOn }),
      btn('MASTER', { cls: 'xs', click: () => deck.setMaster(), active: () => deck.isMaster })),
    el('div', { class: 'pmp-row' },
      btn('RANGE', { cls: 'xs', click: () => { const k = TEMPO_STEPS.indexOf(deck.tempoRange); deck.setTempoRange(TEMPO_STEPS[(k + 1) % TEMPO_STEPS.length]); tempoFader.render(); }, title: 'Tempo range: ±6 / ±10 / ±16 / WIDE' }),
      btn('M.TEMPO', { cls: 'xs led', click: () => deck.setKeyLock(!deck.keyLock), active: () => deck.keyLock, title: 'Key lock' })),
    btn('TEMPO RESET', { cls: 'xs', click: () => { deck.resetTempo(); tempoFader.render(); }, active: () => deck.tempo !== 0 }),
    tempoLed),
    el('div', { class: 'pmp-tempo' }, el('div', { class: 'pmp-scale' }, ...['+', '', '', '', '0', '', '', '', '−'].map((t) => el('span', {}, t))), tempoFader),
  );

  const root = el('div', { class: 'pmp' },
    el('div', { class: 'pmp-top' }, srcCol, el('div', { class: 'pmp-screen-wrap' }, menu, screen), browse),
    strip, loopRow,
    el('div', { class: 'pmp-body' }, left, el('div', { class: 'pmp-center' }, jog), right),
  );

  // ---------------------------------------------------------------- updates
  const setText = (n, t) => { if (n._t !== t) { n._t = t; n.textContent = t; } };
  const updateMeta = () => {
    const t = deck.track;
    setText(sTitle, t ? t.title || 'Untitled' : 'No track'); setText(sArtist, t ? t.artist || '' : 'Load a track: BROWSE, then press the encoder');
    renderPads();
  };
  deck.on('load', updateMeta); deck.on('loaded', updateMeta); deck.on('sample', updateMeta); deck.on('cues', renderPads);
  deck.on('tempo', () => tempoFader.render()); deck.on('tempo-range', () => tempoFader.render());
  updateMeta();
  let lastText = 0;
  return {
    root,
    setScreen,
    /** The deck panels live on the screen while this look is shown. */
    mountPanels(on) { if (on) { panelHost.append(ctx.panelTabs, ctx.panels); } },
    frame(now) {
      jog.draw(now); detail.draw(now); overview.draw(now);
      if (now - lastText < 50) return; lastText = now;
      const pos = deck.position;
      setText(tElapsed, fmtTime(pos)); setText(tRemain, deck.track && deck.duration ? fmtTime(deck.duration - pos, true) : '-00:00.0');
      tRemain.classList.toggle('warn', deck.duration > 0 && deck.duration - pos < 30 && deck.playing);
      const tp = `${deck.tempo >= 0 ? '+' : ''}${deck.tempo.toFixed(2)}%`;
      setText(tTempo, tp); setText(tempoLed, tp); setText(tRange, deck.tempoRange >= 100 ? 'WIDE' : `±${deck.tempoRange}`);
      setText(tBpm, deck.effectiveBpm ? deck.effectiveBpm.toFixed(1) : '--.-'); setText(tKey, deck.playingCamelot || deck.camelot || '');
      sMaster.hidden = !deck.isMaster; sSync.hidden = !deck.syncOn;
      stripPos.style.left = `${deck.duration ? (pos / deck.duration) * 100 : 0}%`;
    },
  };
}
