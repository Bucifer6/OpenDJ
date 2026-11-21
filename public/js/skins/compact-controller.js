// "Compact Controller" skin: the 2-deck view drawn as a compact two-channel DJ controller (matte charcoal body,
// three panels: deck 1 · mixer · deck 2). Original artwork, no brand names. Every control drives the same MIDI target
// as the hardware (see midi/mappings/ddj-flx2.js) and mirrors it, so the on-screen unit moves when the real one is used.
// The waveforms (top) and the library (bottom) stay; this replaces the deck + mixer area only.
import { el, fmtTime } from '../util.js';
import { SkinRuntime, button, knob, fader, jog, pad, text, silk } from './skin-kit.js';
import { ctlState, setPadMode, PAD_MODES, SMART_CFX } from '../midi/controller-extras.js';

const MODES = ['hotcue', 'padfx', 'loop', 'sampler'];

export function mount(app, host) {
  const rt = new SkinRuntime(app, 'compact-controller');
  const st = ctlState(app);
  const eng = app.engine;

  // ---------- deck panel ----------
  function deckPanel(d) {
    const n = d + 1, P = `deck${n}`, deck = eng.decks[d];
    const info = el('div', { class: 'cc-info' },
      text(rt, 'cc-info-title', () => (deck.track ? deck.track.title || 'Untitled' : 'Drop a track here')),
      text(rt, 'cc-info-artist', () => deck.track?.artist || ''),
      text(rt, 'cc-info-bpm', () => (deck.effectiveBpm ? deck.effectiveBpm.toFixed(1) : '--.-')),
      text(rt, 'cc-info-key', () => deck.playingCamelot || ''),
      text(rt, 'cc-info-time', () => (deck.track ? fmtTime(deck.remaining, true).slice(0, 6) : '')));
    const tempo = el('div', { class: 'cc-tempo' },
      fader(rt, { target: `${P}.tempo`, orient: 'v', topMax: false, def: 0.5, marks: ['−', '0', '+'], label: `Deck ${n} tempo`, cls: 'cc-tempo-fader' }),
      silk('TEMPO', 'cc-tempo-lbl'),
      button(rt, { target: `${P}.tempoReset`, label: '0', cls: 'cc-mini cc-tempo-reset', title: 'Tempo reset', lit: () => Math.abs(deck.tempo) < 0.01 && !!deck.track }));
    const jogWrap = el('div', { class: 'cc-jogwrap' },
      el('span', { class: 'cc-decknum', 'aria-hidden': 'true' }, String(n)),
      jog(rt, { deck: d, label: `Deck ${n} jog wheel`, cls: 'cc-jog' }));
    const search = el('div', { class: 'cc-search' },
      button(rt, { target: `${P}.ctlSearchBack`, label: '◀', cls: 'cc-mini', title: 'Search back (hold)', aria: 'Search back' }),
      silk('SEARCH', 'cc-search-lbl'),
      button(rt, { target: `${P}.ctlSearchFwd`, label: '▶', cls: 'cc-mini', title: 'Search forward (hold)', aria: 'Search forward' }));
    const shift = button(rt, { target: 'global.shift', label: 'SHIFT', cls: 'cc-shift', lit: () => !!app.shift, title: 'Shift: hold for the second function of a control' });
    // BEAT SYNC; SHIFT + BEAT SYNC = PAD MODE (cycles the pad mode)
    const sync = button(rt, { target: `${P}.sync`, label: 'BEAT SYNC', sub: 'PAD MODE', cls: 'cc-round cc-ring-orange cc-sync', press: (down) => rt.fire(app.shift ? `${P}.ctlPadModeNext` : `${P}.sync`, down ? 1 : 0), lit: () => deck.syncOn, title: 'Beat sync (SHIFT: next pad mode)' });
    const cue = button(rt, { target: `${P}.cue`, label: 'CUE', cls: 'cc-round cc-big cc-ring-orange cc-cue', title: 'Cue' });
    const play = button(rt, { target: `${P}.play`, label: '▶/❚❚', cls: 'cc-round cc-big cc-ring-green cc-play', title: 'Play / pause', aria: 'Play / pause' });
    const modes = el('div', { class: 'cc-modes' }, ...MODES.map((m) => button(rt, { target: `${P}.ctlPadMode.${m}`, label: PAD_MODES[m].label, cls: `cc-mode m-${m}`, title: `Pad mode: ${PAD_MODES[m].label}` })));
    const grid = el('div', { class: 'cc-pads' }, ...Array.from({ length: 8 }, (_, p) => pad(rt, { deck: d, n: p, cls: 'cc-pad' })));
    const panel = el('section', { class: `cc-deck d${n}`, 'data-deck': d, 'aria-label': `Deck ${n}` },
      tempo,
      el('div', { class: 'cc-deck-main' },
        info, jogWrap,
        el('div', { class: 'cc-row' }, el('div', { class: 'cc-row-l' }, search, shift), sync),
        el('div', { class: 'cc-perf' },
          el('div', { class: 'cc-transport' }, cue, play),
          el('div', { class: 'cc-padblock' }, modes, grid, silk('PERFORMANCE PADS', 'cc-pads-lbl')))));
    // drop a library track (or another deck for an instant double) on the panel
    panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('drop'); });
    panel.addEventListener('dragleave', () => panel.classList.remove('drop'));
    panel.addEventListener('drop', (e) => {
      e.preventDefault(); panel.classList.remove('drop');
      const from = e.dataTransfer.getData('text/x-opendj-deck');
      if (from !== '' && Number(from) !== d) { deck.cloneFrom(eng.decks[Number(from)]).catch((err) => app.toast(err.message)); return; }
      const tid = e.dataTransfer.getData('text/x-opendj-track');
      if (tid) app.loadTrack(d, tid).catch(() => {});
    });
    return panel;
  }

  // ---------- mixer ----------
  function channel(c) {
    const M = `mixer${c + 1}`;
    return el('div', { class: `cc-ch ch${c + 1}` },
      knob(rt, { target: `${M}.eqHigh`, label: 'HI', def: 0.5, cls: 'cc-knob' }),
      knob(rt, { target: `${M}.eqMid`, label: 'MID', def: 0.5, cls: 'cc-knob' }),
      knob(rt, { target: `${M}.eqLow`, label: 'LOW', def: 0.5, cls: 'cc-knob' }),
      silk('EQ', 'cc-eq-lbl'),
      knob(rt, { target: `${M}.filter`, label: 'CFX', def: 0.5, cls: 'cc-knob cc-cfx', title: 'CFX: filter, or the Smart CFX preset when SMART CFX is on' }));
  }
  const display = el('div', { class: 'cc-display' },
    el('div', { class: 'cc-lcd', 'aria-live': 'off' },
      text(rt, 'cc-lcd-l1', () => (st.auto ? 'SMART FADER · AUTO' : st.smartFader ? 'SMART FADER ON' : 'MIX')),
      text(rt, 'cc-lcd-l2', () => (st.smartCfx ? SMART_CFX[st.cfxPreset].label : 'CFX: FILTER'))),
    el('div', { class: 'cc-master' },
      button(rt, { target: 'master.cue', label: 'MASTER', cls: 'cc-pill cc-ring-orange', title: 'Master cue: hear the master in your headphones' }),
      knob(rt, { target: 'master.volume', label: 'LEVEL', def: 0.8, cls: 'cc-knob cc-knob-s', title: 'Master level' }),
      knob(rt, { target: 'master.hpVolume', label: 'PHONES', def: 0.8, cls: 'cc-knob cc-knob-s', title: 'Headphones level' })),
    button(rt, { target: 'smart.cfx', label: 'SMART CFX', cls: 'cc-pill cc-smartcfx', title: 'Smart CFX: the CFX knobs play the selected Color FX preset' }),
    el('div', { class: 'cc-hp' }, silk('HEADPHONES', 'cc-hp-lbl'),
      el('div', { class: 'cc-hp-btns' },
        button(rt, { target: 'mixer1.cue', label: '1', cls: 'cc-pill cc-hpcue', title: 'Headphone cue channel 1', aria: 'Headphone cue 1' }),
        button(rt, { target: 'mixer2.cue', label: '2', cls: 'cc-pill cc-hpcue', title: 'Headphone cue channel 2', aria: 'Headphone cue 2' }))),
    el('div', { class: 'cc-fxsel' },
      button(rt, { target: 'smart.cfxPrev', label: '◀', cls: 'cc-mini', title: 'Previous Smart CFX preset', aria: 'FX select previous', lit: () => false }),
      silk('FX SELECT', 'cc-fxsel-lbl'),
      button(rt, { target: 'smart.cfxNext', label: '▶', cls: 'cc-mini', title: 'Next Smart CFX preset', aria: 'FX select next', lit: () => false })));
  const mixer = el('section', { class: 'cc-mixer', 'aria-label': 'Mixer' },
    el('div', { class: 'cc-mix-top' }, channel(0), display, channel(1)),
    el('div', { class: 'cc-mix-faders' },
      fader(rt, { target: 'mixer1.volume', orient: 'v', def: 0.8, label: 'Channel 1 fader', cls: 'cc-chfader', marks: ['10', '', '5', '', '0'] }),
      el('div', { class: 'cc-smartfader' }, button(rt, { target: 'smart.fader', label: 'SMART', sub: 'FADER', cls: 'cc-round cc-ring-orange cc-sf', title: 'Smart Fader: the crossfader blends BPM, bass and levels. SHIFT + SMART FADER: automatic beat-synced transition' })),
      fader(rt, { target: 'mixer2.volume', orient: 'v', def: 0.8, label: 'Channel 2 fader', cls: 'cc-chfader', marks: ['10', '', '5', '', '0'] })),
    el('div', { class: 'cc-xf' }, fader(rt, { target: 'mixer.crossfader', orient: 'h', def: 0.5, label: 'Crossfader', cls: 'cc-xfader' })));

  const root = el('div', { class: 'sk-root sk-compact', 'data-skin': 'compact-controller' },
    el('div', { class: 'cc-body' }, deckPanel(0), mixer, deckPanel(1)));
  host.append(root);
  // phones / portrait: one deck at a time (the deck tabs pick it)
  const syncDeckTab = () => root.dataset.mdeck = String(Math.min(1, app.mobileDeck || 0));
  syncDeckTab();
  const tabT = setInterval(syncDeckTab, 250);
  rt.start();
  return {
    root, rt,
    destroy() { rt.stop(); clearInterval(tabT); root.remove(); },
  };
}

/** For tests: the pad modes this skin shows. */
export const COMPACT_MODES = MODES;
export { setPadMode };
