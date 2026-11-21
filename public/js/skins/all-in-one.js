// "All-in-One 4-Channel" skin: the 4-deck view drawn as a standalone all-in-one DJ system: one wide matte-black unit
// with a left deck, a centre (tilted touch screen + 4-channel mixer, channels 3 · 1 · 2 · 4) and a right deck. Each
// deck panel controls two decks through DECK SELECT layers (left 1/3, right 2/4), like the real unit. Original
// artwork, no brand names. Every control drives a MIDI target (midi.js) so it behaves exactly like a mapped
// controller and follows hardware changes. Mixer v2 features (master isolator, booth, FX buses, Color FX parameter)
// are used when this OpenDJ has them (looked up by target id); otherwise the control is shown disabled with why.
import { el, fmtTime, clamp } from '../util.js';
import { SkinRuntime, button, knob, fader, jog, pad, meter, text, silk, svg } from './skin-kit.js';
import { ctlState, setPadMode } from '../midi/controller-extras.js';
import * as FX from '../audio/effects.js';
import { api } from '../api.js';

const NA_MIXER = 'Needs the new mixer (not in this version of OpenDJ yet)';
const NA_MIC2 = 'OpenDJ has one microphone input: use MIC 1';
const DECK_MODES = [['hotcue', 'gate'], ['loop', 'loop2'], ['slipLoop', 'keyshift'], ['jump', 'jump2']];
const DECK_MODE_LABELS = [['HOT CUE', 'GATE CUE'], ['BEAT LOOP', 'BEAT LOOP 2'], ['SLIP LOOP', 'KEY SHIFT'], ['BEAT JUMP', 'BEAT JUMP 2']];
const CFX_BUTTONS = [['SPACE', 'space'], ['DUB ECHO', 'dubecho'], ['CRUSH', 'crush'], ['SWEEP', 'sweep'], ['NOISE', 'noise'], ['FILTER', 'filter']];

export function mount(app, host) {
  const rt = new SkinRuntime(app, 'all-in-one');
  const st = ctlState(app), eng = app.engine;
  const has = (id) => rt.has(id);
  st.layer = st.layer || [0, 1]; // DECK SELECT: the deck index each panel controls
  const L = (side) => () => st.layer[side];
  const colorIds = (FX.COLOR_FX || []).map((c) => c[0]);
  const cfxId = (id) => (id === 'sweep' && !colorIds.includes('sweep') ? 'pitch' : id);
  const busMode = has('fx1.on');
  const fxSel = st.aioFx || (st.aioFx = { ch: 1, type: 0, beats: 4 }); // beat FX channel (0 = master), effect, division index

  // ---------- deck panel ----------
  function deckPanel(side) {
    const D = L(side), P = () => `deck${D() + 1}`, deck = () => eng.decks[D()];
    const T = (s) => () => `${P()}.${s}`;
    const pick = (a, b) => [a, b][side];
    const deckSel = el('div', { class: 'ai-decksel' }, silk('DECK SELECT', 'ai-sm'),
      el('div', { class: 'ai-row' }, ...pick([0, 2], [1, 3]).map((d) => button(rt, {
        label: String(d + 1), cls: 'ai-dsel', title: `Control deck ${d + 1}`, aria: `Deck select ${d + 1}`,
        press: (down) => { if (!down) return; if (d > 1 && app.deckCount !== 4) app.setDeckCount(4); st.layer[side] = d; },
        lit: () => st.layer[side] === d,
      }))));
    const loopRow = el('div', { class: 'ai-grp' },
      button(rt, { target: T('loopIn'), label: 'IN', sub: 'CUE', cls: 'ai-round ai-org', title: 'Loop in', lit: () => false }),
      button(rt, { target: T('loopOut'), label: 'OUT', cls: 'ai-round ai-org', title: 'Loop out', lit: () => !!deck().loop?.active }),
      button(rt, { target: T('reloop'), label: 'RELOOP', sub: 'EXIT', cls: 'ai-rect', title: 'Reloop / exit' }));
    const callRow = el('div', { class: 'ai-grp' }, silk('CUE/LOOP CALL', 'ai-sm'),
      button(rt, { target: T('ctlCueCallBack'), label: '◀', cls: 'ai-mini', aria: 'Cue call previous', lit: () => false }),
      button(rt, { target: T('ctlCueCall'), label: '▶', cls: 'ai-mini', aria: 'Cue call next', lit: () => false }),
      button(rt, { target: T('ctlMemoryDelete'), label: 'DELETE', cls: 'ai-rect', lit: () => false }),
      button(rt, { label: 'MEMORY', cls: 'ai-rect', press: (down) => down && deck().addMemoryCue?.(), lit: () => false, title: 'Store a memory cue' }));
    const beatRow = el('div', { class: 'ai-grp' }, silk('BEAT LOOP', 'ai-sm'),
      button(rt, { target: T('beatloop.4'), label: '4', cls: 'ai-mini' }),
      button(rt, { target: T('beatloop.8'), label: '8', cls: 'ai-mini' }),
      button(rt, { target: T('loopHalve'), label: '½X', cls: 'ai-mini', lit: () => false }),
      button(rt, { target: T('loopDouble'), label: '2X', cls: 'ai-mini', lit: () => false }));
    const jumpRow = el('div', { class: 'ai-grp' }, silk('BEAT JUMP', 'ai-sm'),
      button(rt, { target: T('jumpBack'), label: '◀', cls: 'ai-mini', aria: 'Beat jump back', lit: () => false }),
      button(rt, { target: T('jumpFwd'), label: '▶', cls: 'ai-mini', aria: 'Beat jump forward', lit: () => false }),
      button(rt, { target: T('slip'), label: 'SLIP', cls: 'ai-rect' }),
      button(rt, { target: T('censor'), label: 'SLIP REV', cls: 'ai-rect', title: 'Slip reverse (hold)', lit: () => !!deck().reverse && !!deck().slip }),
      button(rt, { target: T('reverse'), label: 'REV', cls: 'ai-rect', title: 'Reverse (hold)' }));
    // jog with a centre display: artwork, position ring, SYNC / MASTER and slip indicators
    const ring = svg('circle', { class: 'ai-jd-pos', cx: 50, cy: 50, r: 46, pathLength: 100 });
    const art = el('div', { class: 'ai-jd-art' });
    const jd = el('div', { class: 'ai-jd' },
      svg('svg', { class: 'ai-jd-ring', viewBox: '0 0 100 100', 'aria-hidden': 'true' }, svg('circle', { class: 'ai-jd-track', cx: 50, cy: 50, r: 46 }), ring),
      art,
      el('div', { class: 'ai-jd-info' },
        text(rt, 'ai-jd-deck', () => `DECK ${D() + 1}`),
        text(rt, 'ai-jd-bpm', () => (deck().effectiveBpm ? deck().effectiveBpm.toFixed(1) : '--.-')),
        el('div', { class: 'ai-jd-flags' }, text(rt, 'ai-jd-sync', () => (deck().syncOn ? 'SYNC' : '')), text(rt, 'ai-jd-master', () => (deck().isMaster ? 'MASTER' : '')), text(rt, 'ai-jd-slip', () => (deck().slip ? 'SLIP' : '')))));
    let lastPos = -1, lastArt = null;
    const jogEl = jog(rt, {
      deck: D, label: `${pick('Left', 'Right')} jog wheel`, cls: 'ai-jog', center: jd,
      render: (dk) => {
        const p = dk.track && dk.duration ? clamp(dk.position / dk.duration, 0, 1) : 0;
        if (Math.abs(p - lastPos) > 0.002) { lastPos = p; ring.style.strokeDasharray = `${(p * 100).toFixed(2)} 100`; }
        const id = dk.track?.id || null;
        if (id !== lastArt) { lastArt = id; art.style.backgroundImage = id && api.coverUrl ? `url(${api.coverUrl(id)})` : ''; }
      },
    });
    function trackSearch(dir) {
      if (deck().playing) { app.toast?.('Track search works while the deck is stopped'); return; }
      app.library.moveSelection(dir); app.library.loadSelected(D());
    }
    const sideA = el('div', { class: 'ai-jogside' },
      el('div', { class: 'ai-v' }, silk('TRACK SEARCH', 'ai-sm'), el('div', { class: 'ai-row' },
        button(rt, { label: '⏮', cls: 'ai-mini', aria: 'Previous track', press: (down) => down && trackSearch(-1), lit: () => false, title: 'Load the previous library track (deck stopped)' }),
        button(rt, { label: '⏭', cls: 'ai-mini', aria: 'Next track', press: (down) => down && trackSearch(1), lit: () => false, title: 'Load the next library track (deck stopped)' }))),
      el('div', { class: 'ai-v' }, silk('SEARCH', 'ai-sm'), el('div', { class: 'ai-row' },
        button(rt, { target: T('ctlSearchBack'), label: '◀◀', cls: 'ai-mini', aria: 'Search back' }),
        button(rt, { target: T('ctlSearchFwd'), label: '▶▶', cls: 'ai-mini', aria: 'Search forward' }))),
      knob(rt, { label: 'JOG FEEL', cls: 'ai-knob-s', disabled: 'Jog weight is a mechanical adjustment on hardware: nothing to set here', get: () => 0.5 }),
      button(rt, { target: 'global.shift', label: 'SHIFT', cls: 'ai-rect ai-shift', lit: () => !!app.shift }));
    const sideB = el('div', { class: 'ai-jogside' },
      button(rt, { target: T('ctlVinyl'), label: 'VINYL', sub: 'JOG MODE', cls: 'ai-rect ai-vinyl' }),
      knob(rt, { label: 'VINYL SPEED', cls: 'ai-knob-s', disabled: 'Vinyl start / stop speed is not adjustable in OpenDJ yet', get: () => 0.5 }),
      button(rt, { target: T('sync'), label: 'BEAT SYNC', cls: 'ai-rect ai-sync' }),
      button(rt, { target: T('master'), label: 'MASTER', cls: 'ai-rect' }),
      button(rt, { target: T('keySync'), label: 'KEY SYNC', cls: 'ai-rect' }));
    const tempo = el('div', { class: 'ai-tempo' },
      button(rt, { target: T('ctlTempoRange'), label: 'RANGE', cls: 'ai-mini2', lit: () => false, title: 'Tempo range' }),
      text(rt, 'ai-range', () => `±${deck().tempoRange}%`),
      button(rt, { target: T('keylock'), label: 'M.TEMPO', cls: 'ai-mini2', title: 'Master tempo (key lock)' }),
      fader(rt, { target: T('tempo'), orient: 'v', topMax: false, def: 0.5, marks: ['−', '', '0', '', '+'], label: 'Tempo', cls: 'ai-tempo-fader' }),
      button(rt, { target: T('tempoReset'), label: 'RESET', cls: 'ai-mini2', lit: () => false, title: 'Tempo reset' }));
    const modes = el('div', { class: 'ai-modes' }, ...DECK_MODES.map(([m, ms], i) => button(rt, {
      label: DECK_MODE_LABELS[i][0], sub: DECK_MODE_LABELS[i][1], cls: `ai-mode m-${m}`, title: `${DECK_MODE_LABELS[i][0]} (SHIFT: ${DECK_MODE_LABELS[i][1]})`,
      press: (down) => down && setPadMode(app, D(), app.shift ? ms : m),
      lit: () => [m, ms].includes(st.padMode[D() + 1]),
    })));
    const pads = el('div', { class: 'ai-pads' }, ...Array.from({ length: 8 }, (_, n) => pad(rt, { deck: D, n, cls: 'ai-pad' })));
    const transport = el('div', { class: 'ai-transport' },
      button(rt, { target: T('cue'), label: 'CUE', cls: 'ai-big ai-ring-amber' }),
      button(rt, { target: T('play'), label: '▶/❚❚', cls: 'ai-big ai-ring-green', aria: 'Play / pause' }));
    const panel = el('section', { class: `ai-deck s${side}`, 'aria-label': `${pick('Left', 'Right')} deck` },
      el('div', { class: 'ai-deck-top' }, el('div', { class: 'ai-col' }, loopRow, callRow), el('div', { class: 'ai-col' }, beatRow, jumpRow), deckSel),
      el('div', { class: 'ai-deck-mid' }, sideA, el('div', { class: 'ai-jogwrap' }, jogEl), sideB),
      el('div', { class: 'ai-deck-bot' }, transport, el('div', { class: 'ai-padblock' }, modes, pads)),
      tempo);
    panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('drop'); });
    panel.addEventListener('dragleave', () => panel.classList.remove('drop'));
    panel.addEventListener('drop', (e) => { e.preventDefault(); panel.classList.remove('drop'); const tid = e.dataTransfer.getData('text/x-opendj-track'); if (tid) app.loadTrack(D(), tid).catch(() => {}); });
    return panel;
  }

  // ---------- top strips ----------
  const micEq = (b) => (has(`mic.eq${b}`) ? { target: `mic.eq${b}` } : b === 'Mid' ? { disabled: NA_MIXER, get: () => 0.5 } : {
    get: () => (st._micEq?.[b] ?? 0.5), set: (v) => { (st._micEq ||= {})[b] = v; eng.setMicEq?.(b === 'High' ? 'high' : 'low', v * 2 - 1); },
  });
  const micStrip = el('section', { class: 'ai-strip ai-mic', 'aria-label': 'Microphones' },
    el('div', { class: 'ai-mic-ch' }, silk('MIC 1', 'ai-sm ai-title'),
      button(rt, { target: 'mic.on', label: 'ON', cls: 'ai-mini ai-micon' }),
      knob(rt, { target: 'mic.volume', label: 'LEVEL', def: 1, cls: 'ai-knob-xs' }),
      knob(rt, { ...micEq('High'), label: 'HI', cls: 'ai-knob-xs' }), knob(rt, { ...micEq('Mid'), label: 'MID', cls: 'ai-knob-xs' }), knob(rt, { ...micEq('Low'), label: 'LOW', cls: 'ai-knob-xs' })),
    el('div', { class: 'ai-mic-ch' }, silk('MIC 2', 'ai-sm ai-title'),
      button(rt, { label: 'ON', cls: 'ai-mini', disabled: NA_MIC2 }),
      ...['LEVEL', 'HI', 'MID', 'LOW'].map((l) => knob(rt, { label: l, cls: 'ai-knob-xs', disabled: NA_MIC2, get: () => 0.5 }))),
    button(rt, { target: 'mic.talkover', label: 'TALK', sub: 'OVER', cls: 'ai-rect' }),
    button(rt, { target: 'global.quantize', label: 'QUANTIZE', cls: 'ai-rect' }));
  const masterLevel = () => { try { const [l, r] = eng.masterLevels(); return Math.max(l, r); } catch { return 0; } };
  const iso = (b) => (has(`master.iso${b}`) ? { target: `master.iso${b}` } : { disabled: NA_MIXER, get: () => 0.5 });
  function ejectStopped(ds) { for (const d of ds) { const dk = eng.decks[d]; if (dk && !dk.playing && dk.track) dk.eject(); } }
  const masterStrip = el('section', { class: 'ai-strip ai-masterstrip', 'aria-label': 'Master' },
    el('div', { class: 'ai-mst' }, silk('MASTER', 'ai-sm ai-title'),
      el('div', { class: 'ai-mst-meter' }, meter(rt, { level: masterLevel, segs: 15, orient: 'h', cls: 'ai-hmeter' }), el('div', { class: 'ai-db' }, ...['-24', '-12', '-6', '0', '+3'].map((x) => el('span', {}, x))))),
    knob(rt, { target: 'master.volume', label: 'LEVEL', def: 0.8, cls: 'ai-knob-s' }),
    knob(rt, { ...iso('Low'), label: 'LOW', cls: 'ai-knob-xs' }), knob(rt, { ...iso('Mid'), label: 'MID', cls: 'ai-knob-xs' }), knob(rt, { ...iso('High'), label: 'HI', cls: 'ai-knob-xs' }),
    knob(rt, has('master.boothVolume') ? { target: 'master.boothVolume', label: 'BOOTH', def: 0.8, cls: 'ai-knob-xs' } : { label: 'BOOTH', cls: 'ai-knob-xs', disabled: NA_MIXER, get: () => 0.5 }),
    button(rt, { target: 'master.cue', label: 'CUE', cls: 'ai-mini ai-orgbtn', title: 'Master cue' }),
    el('div', { class: 'ai-usb' }, el('div', { class: 'ai-usb-slot', title: 'USB 1' }), button(rt, { label: 'USB STOP', cls: 'ai-mini2', press: (down) => down && ejectStopped([0, 2]), lit: () => false, title: 'Eject the stopped decks on the left' })),
    el('div', { class: 'ai-usb' }, el('div', { class: 'ai-usb-slot', title: 'USB 2' }), button(rt, { label: 'USB STOP', cls: 'ai-mini2', press: (down) => down && ejectStopped([1, 3]), lit: () => false, title: 'Eject the stopped decks on the right' })));

  // ---------- screen ----------
  const waveSlot = el('div', { class: 'ai-waves' });
  const infoRows = el('div', { class: 'ai-infos' }, ...[0, 1, 2, 3].map((d) => {
    const dk = eng.decks[d];
    return el('div', { class: `ai-info d${d + 1}`, style: { '--dc': `var(--deck${d + 1})` } },
      el('b', {}, String(d + 1)),
      text(rt, 'ai-info-title', () => (dk.track ? `${dk.track.title || 'Untitled'}${dk.track.artist ? ' · ' + dk.track.artist : ''}` : '—')),
      text(rt, 'ai-info-key', () => dk.playingCamelot || ''),
      text(rt, 'ai-info-bpm', () => (dk.effectiveBpm ? dk.effectiveBpm.toFixed(1) : '')),
      text(rt, 'ai-info-time', () => (dk.track ? fmtTime(dk.remaining, true).slice(0, 6) : '')));
  }));
  const FXN = FX.EFFECTS.length;
  const fxName = () => (busMode ? 'FX 1' : (FX.EFFECTS[fxSel.type]?.label || '').toUpperCase());
  const beatLbl = () => { const b = FX.BEAT_DIVISIONS[fxSel.beats]; return b >= 1 ? String(b) : `1/${Math.round(1 / b)}`; };
  const fxPanel = el('div', { class: 'ai-scr-fx' }, silk('BEAT FX', 'ai-sm'), text(rt, 'ai-scr-fxname', fxName), text(rt, 'ai-scr-fxbeat', () => `${beatLbl()} BEAT`), text(rt, 'ai-scr-fxch', () => (fxSel.ch ? `CH ${fxSel.ch}` : 'MASTER')));
  function libFocus(what) {
    const lib = app.library;
    document.documentElement.classList.remove('lib-collapsed');
    if (what === 'search') { lib.search?.focus(); return; }
    const root = lib.root;
    const target = what === 'rows' ? root?.querySelector('.lib-rows, .lib-table, .lib-list') : root?.querySelector('.lib-tree');
    target?.scrollIntoView?.({ block: 'nearest' });
    root?.classList.add('ai-flash'); setTimeout(() => root?.classList.remove('ai-flash'), 600);
  }
  const mb = (label, fn, title) => button(rt, { label, cls: 'ai-mbtn', press: (down) => down && fn(), lit: () => false, title });
  const menu = el('div', { class: 'ai-menu' },
    mb('SOURCE', () => libFocus('tree'), 'Library sources'), mb('BROWSE', () => libFocus('rows'), 'Browse the library'),
    mb('TAG LIST', () => app.toggleQueuePanel?.(), 'Automix queue (tagged tracks)'), mb('PLAYLIST', () => libFocus('tree'), 'Playlists'),
    mb('SEARCH', () => libFocus('search'), 'Search the library'), mb('MENU', () => app.dialogs.settings(), 'Settings'));
  const screen = el('div', { class: 'ai-screen-wrap' }, menu,
    el('div', { class: 'ai-bezel' }, el('div', { class: 'ai-screen' }, el('div', { class: 'ai-scr-main' }, infoRows, waveSlot), fxPanel)));
  const browse = el('div', { class: 'ai-browse' },
    knob(rt, { label: 'BROWSE', cls: 'ai-encoder', title: 'Turn to scroll the library', get: () => (st._enc ?? 0.5), set: (v) => { const prev = st._enc ?? 0.5; const steps = Math.trunc((v - prev) * 40); if (steps) { app.library.moveSelection(Math.sign(steps)); st._enc = v <= 0.02 || v >= 0.98 ? 0.5 : prev + steps / 40; } } }),
    el('div', { class: 'ai-row' },
      button(rt, { label: 'BACK', cls: 'ai-mini2', press: (down) => down && app.library.moveSelection(-1), lit: () => false }),
      button(rt, { label: 'TAG', sub: 'TRACK', cls: 'ai-mini2', press: (down) => { if (!down) return; const t = app.library.rows?.[app.library.cursor]; if (t) app.queueAdd?.([t]); }, lit: () => false, title: 'Add the selected track to the automix queue' })),
    el('div', { class: 'ai-loads' }, ...[2, 0, 1, 3].map((d) => button(rt, { label: `LOAD ${d + 1}`, cls: 'ai-mini2', lit: () => false, press: (down) => { if (!down) return; if (d > 1 && app.deckCount !== 4) app.setDeckCount(4); app.library.loadSelected(d); } }))),
    button(rt, { label: 'INST.', sub: 'DOUBLES', cls: 'ai-mini2', press: (down) => down && rt.fire(`deck${st.layer[1] + 1}.instantDouble`, 1), lit: () => false, title: 'Instant double: copy the left deck onto the right deck' }));

  // ---------- mixer ----------
  function strip(c) {
    const M = `mixer${c + 1}`, ch = eng.channels[c];
    return el('div', { class: `ai-ch c${c + 1}`, style: { '--dc': `var(--deck${c + 1})` } },
      el('div', { class: 'ai-trimrow' },
        knob(rt, { target: `${M}.trim`, label: 'TRIM', def: 0.5, cls: 'ai-knob-s' }),
        button(rt, has('mixer.eqType.next') ? { target: 'mixer.eqType.next', label: 'EQ', sub: 'ISO', cls: 'ai-sw', lit: () => false, title: 'EQ type (all channels)' } : { label: 'EQ', sub: 'ISO', cls: 'ai-sw', disabled: NA_MIXER })),
      el('div', { class: 'ai-eq' },
        el('div', { class: 'ai-eq-k' },
          knob(rt, { target: `${M}.eqHigh`, label: 'HI', def: 0.5, cls: 'ai-knob-s' }),
          knob(rt, { target: `${M}.eqMid`, label: 'MID', def: 0.5, cls: 'ai-knob-s' }),
          knob(rt, { target: `${M}.eqLow`, label: 'LOW', def: 0.5, cls: 'ai-knob-s' })),
        meter(rt, { level: () => { try { return ch.level(); } catch { return 0; } }, segs: 12, cls: 'ai-chmeter' })),
      knob(rt, { target: `${M}.filter`, label: 'COLOR', def: 0.5, cls: 'ai-knob-s ai-color' }),
      button(rt, { target: `${M}.cue`, label: 'CUE', cls: 'ai-cue' }),
      el('span', { class: 'ai-chnum' }, String(c + 1)),
      fader(rt, { target: `${M}.volume`, orient: 'v', def: 0.8, label: `Channel ${c + 1} fader`, cls: 'ai-chfader', marks: ['10', '8', '6', '4', '2', '0'] }));
  }
  const cfxParam = () => (has('mixer1.colorParam') ? { get: () => rt.value('mixer1.colorParam', 0.5), set: (v) => { for (let c = 1; c <= 4; c++) rt.fire(`mixer${c}.colorParam`, v); } } : { disabled: NA_MIXER, get: () => 0.5 });
  const leftSide = el('div', { class: 'ai-mxside' },
    button(rt, { label: 'MIXER', sub: 'SETTINGS', cls: 'ai-mini2', press: (down) => down && app.dialogs.settings('audio'), lit: () => false }),
    silk('SOUND COLOR FX', 'ai-sm'),
    el('div', { class: 'ai-cfx' }, ...CFX_BUTTONS.map(([lbl, id]) => button(rt, {
      label: lbl, cls: 'ai-cfxbtn', title: id === 'sweep' && !colorIds.includes('sweep') ? 'Sweep (Jet in this version of OpenDJ)' : `Sound Color FX: ${lbl}`,
      press: (down) => { if (!down) return; const want = cfxId(id); const cur = eng.channels[0].state.colorFx; const next = cur === want && want !== 'filter' ? 'filter' : want; for (const ch of eng.channels) ch.set('colorFx', next); app.setSetting?.('colorFx', next); },
      lit: () => eng.channels[0].state.colorFx === cfxId(id) && id !== 'filter',
    }))),
    knob(rt, { ...cfxParam(), label: 'PARAMETER', cls: 'ai-knob-s' }),
    silk('HEADPHONES', 'ai-sm'),
    button(rt, { label: 'LINK', sub: 'CUE', cls: 'ai-mini2', disabled: NA_MIXER }),
    el('div', { class: 'ai-row' }, knob(rt, { target: 'master.cueMix', label: 'MIX', def: 0.5, cls: 'ai-knob-xs' }), knob(rt, { target: 'master.hpVolume', label: 'LEVEL', def: 0.8, cls: 'ai-knob-xs' })));

  // beat FX: the FX buses of mixer v2 when present, else the channels' own FX units
  const fxChs = () => (fxSel.ch ? [fxSel.ch - 1] : [0, 1, 2, 3]);
  const fxApply = (k, v) => { for (const c of fxChs()) eng.channels[c].set(k, v); };
  const setBeats = (i) => { fxSel.beats = clamp(i, 0, 7); if (busMode) rt.fire('fx1.time', fxSel.beats / 7); else fxApply('fxBeats', FX.BEAT_DIVISIONS[fxSel.beats]); };
  function xpad() {
    // X-PAD touch strip: the beat division under the finger, FX on while touched
    const strip = el('div', { class: 'ai-xpad', role: 'slider', tabindex: 0, 'aria-label': 'Beat FX touch strip', title: 'Touch strip: hold to play the beat FX at the division under your finger' },
      ...['1/4', '1/2', '1', '2', '4'].map((x) => el('span', {}, x)));
    let on = false, saved = null;
    const busStrip = busMode && has('fx1.strip');
    const at = (e) => { const r = strip.getBoundingClientRect(); return clamp((e.clientX - r.left) / (r.width || 1), 0, 0.999); };
    const div = (e) => [0.25, 0.5, 1, 2, 4][Math.floor(at(e) * 5)];
    strip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); strip.setPointerCapture(e.pointerId); on = true; strip.classList.add('down');
      if (busStrip) { rt.fire('fx1.strip', at(e)); return; }
      saved = fxChs().map((c) => eng.channels[c].state.fxOn);
      fxApply('fxType', FX.EFFECTS[fxSel.type].id); fxApply('fxBeats', div(e)); fxApply('fxOn', true);
    });
    strip.addEventListener('pointermove', (e) => { if (!on) return; if (busStrip) rt.fire('fx1.strip', at(e)); else fxApply('fxBeats', div(e)); });
    const end = () => { if (!on) return; on = false; strip.classList.remove('down'); if (busStrip) rt.fire('fx1.strip', 0); else if (saved) { fxChs().forEach((c, i) => eng.channels[c].set('fxOn', saved[i])); saved = null; } };
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) strip.addEventListener(ev, end);
    return strip;
  }
  const rightSide = el('div', { class: 'ai-mxside ai-beatfx' },
    silk('BEAT FX', 'ai-sm ai-title'),
    el('div', { class: 'ai-row' },
      button(rt, { label: '◀', cls: 'ai-mini', aria: 'Beat down', lit: () => false, press: (down) => down && setBeats(fxSel.beats - 1) }),
      silk('BEAT', 'ai-sm'),
      button(rt, { label: '▶', cls: 'ai-mini', aria: 'Beat up', lit: () => false, press: (down) => down && setBeats(fxSel.beats + 1) })),
    el('div', { class: 'ai-row' },
      button(rt, { label: 'AUTO', sub: 'TAP', cls: 'ai-mini2', disabled: 'Beat FX follow the master deck BPM automatically' }),
      button(rt, has('fx1.quantize') ? { target: 'fx1.quantize', label: 'FX', sub: 'QUANTIZE', cls: 'ai-mini2' } : { label: 'FX', sub: 'QUANTIZE', cls: 'ai-mini2', disabled: NA_MIXER })),
    xpad(),
    silk('FX FREQUENCY', 'ai-sm'),
    el('div', { class: 'ai-row' }, ...['low', 'mid', 'high'].map((b) => button(rt, has(`fx1.band.${b}`) ? { target: `fx1.band.${b}`, label: b === 'high' ? 'HI' : b.toUpperCase(), cls: 'ai-mini' } : { label: b === 'high' ? 'HI' : b.toUpperCase(), cls: 'ai-mini', disabled: NA_MIXER }))),
    el('div', { class: 'ai-row ai-fxknobs' },
      knob(rt, { label: 'FX SELECT', cls: 'ai-knob-s', title: 'Effect', get: () => (busMode ? (st._fxStep ?? 0) : fxSel.type / Math.max(1, FXN - 1)), set: (v) => {
        if (busMode) { const prev = st._fxStep ?? 0; if (Math.abs(v - prev) > 0.08) { rt.fire('fx1.select', 1); rt.fire('fx1.select', 0); st._fxStep = v; } return; }
        const i = Math.round(v * (FXN - 1)); if (i !== fxSel.type) { fxSel.type = i; fxApply('fxType', FX.EFFECTS[i].id); }
      } }),
      knob(rt, { label: 'CH SELECT', cls: 'ai-knob-s', title: 'FX channel: 1-4, MIC, MASTER', get: () => [1, 2, 3, 4, 5, 0].indexOf(fxSel.ch) / 5, set: (v) => {
        const ch = [1, 2, 3, 4, 5, 0][Math.round(v * 5)];
        if (ch === 5 || ch === fxSel.ch) return; // MIC: the mic has its own FX (mixer v2)
        fxSel.ch = ch;
        if (busMode) rt.fire(ch ? `fx.unit1.assign.deck${ch}` : 'fx1.assign.master', 1);
      } })),
    el('div', { class: 'ai-row ai-fxknobs' },
      knob(rt, busMode ? { target: 'fx1.time', label: 'TIME', cls: 'ai-knob-s' } : { label: 'TIME', cls: 'ai-knob-s', get: () => fxSel.beats / 7, set: (v) => { const i = Math.round(v * 7); if (i !== fxSel.beats) setBeats(i); } }),
      knob(rt, busMode ? { target: 'fx1.param', label: 'LEVEL/DEPTH', cls: 'ai-knob-s' } : { label: 'LEVEL/DEPTH', cls: 'ai-knob-s', get: () => eng.channels[fxChs()[0]].state.fxMix ?? 0.5, set: (v) => fxApply('fxMix', v) })),
    button(rt, busMode ? { target: 'fx1.on', label: 'ON/OFF', cls: 'ai-fxon' } : { label: 'ON/OFF', cls: 'ai-fxon', press: (down) => { if (!down) return; const on = !eng.channels[fxChs()[0]].state.fxOn; if (on) { fxApply('fxType', FX.EFFECTS[fxSel.type].id); fxApply('fxBeats', FX.BEAT_DIVISIONS[fxSel.beats]); } fxApply('fxOn', on); }, lit: () => fxChs().some((c) => eng.channels[c].state.fxOn) }));
  const mixer = el('section', { class: 'ai-mixer', 'aria-label': 'Mixer' },
    leftSide,
    el('div', { class: 'ai-strips' }, ...[2, 0, 1, 3].map(strip)),
    rightSide,
    el('div', { class: 'ai-xf' }, fader(rt, { target: 'mixer.crossfader', orient: 'h', def: 0.5, label: 'Crossfader', cls: 'ai-xfader' })));

  const root = el('div', { class: 'sk-root sk-aio', 'data-skin': 'all-in-one' },
    el('div', { class: 'ai-body' },
      el('div', { class: 'ai-side s0' }, micStrip, deckPanel(0)),
      el('div', { class: 'ai-centre' }, el('div', { class: 'ai-top' }, screen, browse), mixer),
      el('div', { class: 'ai-side s1' }, masterStrip, deckPanel(1))));
  host.append(root);

  // the stacked waveforms move into the screen while the skin is shown (and back when it goes)
  const moved = [];
  for (const row of app.waves || []) { moved.push([row, row.parentNode, row.nextSibling]); waveSlot.append(row); }
  document.body.classList.add('ai-waves-moved');
  rt.start();
  return {
    root, rt,
    destroy() {
      rt.stop();
      for (const [row, parent, next] of moved.reverse()) parent.insertBefore(row, next && next.parentNode === parent ? next : parent.querySelector('.wave-zoom'));
      document.body.classList.remove('ai-waves-moved');
      root.remove();
    },
  };
}
