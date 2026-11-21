// Extra controller functions used by the bundled controller mappings (DDJ-FLX2) and OpenDJ's own mixer:
//   - pad modes with LED state (HOT CUE / PAD FX / LOOP / SAMPLER) and the per-mode pad functions (Pad FX, beat-loop
//     pads, sampler stop), SHIFT + PLAY / CUE functions, vinyl mode, master cue
//   - SMART FADER: the crossfader alone blends two tracks: both decks follow a BPM that morphs from the outgoing to the
//     incoming track, the basslines swap in the middle, and the levels follow the crossfader. SHIFT (or `smart.faderAuto`)
//     runs it automatically: the other deck starts on the next bar, beat-synced, and the crossfader moves over 16 beats.
//     The mixer's SMART button (next to the crossfader) uses the same functions.
//   - SMART CFX: the channels' filter knobs switch between the plain filter and the last Color FX picked (the mixer's
//     Color FX selector, or FX SELECT = mixer.colorFx.prev / next from mixer-targets.js)
//   - DECK SELECT layers: the two deck sides of a 2-deck controller switch to decks 3 / 4 (`deckSelect.left` /
//     `deckSelect.right`, or Settings → Controllers in 4-deck mode). midi.js routes deck1/mixer1 targets to deck3/mixer3
//     (and 2 to 4) while a layer is switched.
// State lives on app.ctl; changes fire a window 'opendj-ctl' event for the UI. Everything uses public engine / deck APIs.

/** Pad modes a controller can select. */
export const PAD_MODES = { hotcue: 'HOT CUE', padfx: 'PAD FX', loop: 'LOOP', sampler: 'SAMPLER' };
/** How each controller pad mode shows in the standard deck UI (deck.padMode). */
const UI_MODE = { hotcue: 'hotcue', padfx: 'fx', loop: 'roll', sampler: 'sampler' };
export const PAD_FX = ['brake', 'backspin', 'censor', 'echoOut', 'roll1', 'roll2', 'filterSweep', 'tapeStop'];
const PAD_FX_LABELS = ['Brake', 'Backspin', 'Censor', 'Echo out', 'Roll ¼', 'Roll ⅛', 'Filter sweep', 'Tape stop'];
export const LOOP_PADS = [1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];

const fmtBeats = (b) => (b >= 1 ? String(b) : `1/${Math.round(1 / b)}`);
const notify = () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event('opendj-ctl')); };

/** Controller state shared by mappings, the mixer and LEDs. */
export function ctlState(app) {
  if (!app.ctl) {
    app.ctl = {
      padMode: [null, 'hotcue', 'hotcue', 'hotcue', 'hotcue'], // by deck number
      held: [null, new Set(), new Set(), new Set(), new Set()], // Pad FX pads held (LEDs)
      smartFader: false, lastColorFx: 'space', masterCue: false, auto: null,
      layer: [0, 1], // DECK SELECT: deck index the left / right side of a 2-deck controller drives
    };
  }
  return app.ctl;
}

function loopToggle(deck, beats) {
  if (deck.loop?.active && Math.abs(deck.loopBeats - beats) < 1e-3) deck.exitLoop();
  else { deck._ctlLoopBeats = beats; deck.autoLoop(beats); }
}

/** Select a pad mode on deck index d (also shown in the standard deck UI). */
export function setPadMode(app, d, mode) {
  const st = ctlState(app);
  if (!PAD_MODES[mode]) return;
  st.padMode[d + 1] = mode;
  try { app.engine.decks[d].padMode?.(UI_MODE[mode]); } catch { /* deck UI not built (tests) */ }
  notify();
}

// ---------- DECK SELECT layers ----------
/** Switch a controller side (0 = left: decks 1/3, 1 = right: decks 2/4) to a deck index; 4-deck mode for 3 / 4. */
export function setDeckLayer(app, side, deckIndex) {
  const st = ctlState(app);
  const want = deckIndex ?? (st.layer[side] === side ? side + 2 : side);
  if (want > 1 && app.deckCount !== 4) app.setDeckCount?.(4);
  st.layer[side] = want;
  app.midi?.resetRuntime?.(); // LEDs re-sent for the new deck
  app.toast?.(`Controller ${side ? 'right' : 'left'} side: deck ${want + 1}`);
  notify();
}
/** Target id after DECK SELECT routing: deck1.* / mixer1.* → deck3.* / mixer3.* (and 2 → 4) while switched. */
export function routeTarget(app, id) {
  const st = app.ctl; if (!st || (st.layer[0] === 0 && st.layer[1] === 1)) return id;
  const m = /^(deck|mixer)([12])\.(.*)$/.exec(id); if (!m) return id;
  const to = st.layer[+m[2] - 1] + 1;
  return to === +m[2] ? id : `${m[1]}${to}.${m[3]}`;
}

// ---------- SMART FADER ----------
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** The two decks the crossfader blends: the first deck assigned to A and the first assigned to B. */
function xfDecks(app) {
  const eng = app.engine, n = app.deckCount || 2;
  const side = (s) => eng.channels.slice(0, n).findIndex((c) => c.state.xfAssign === s);
  const a = side('A'), b = side('B');
  return a >= 0 && b >= 0 ? [eng.decks[a], eng.decks[b], eng.channels[a], eng.channels[b]] : null;
}

/** Apply the smart fader at crossfader position x (-1 = A … 1 = B). */
function smartApply(app, x) {
  const st = ctlState(app), pair = xfDecks(app); if (!pair) return;
  const [A, B, chA, chB] = pair, t = (x + 1) / 2;
  const saved = st._saved || (st._saved = { lowA: chA.state.eqLow, lowB: chB.state.eqLow, chA, chB });
  // bass swap around the middle: the incoming bass comes in as the outgoing bass goes out
  const lowA = saved.lowA - (saved.lowA + 1) * smooth(0.42, 0.58, t);
  const lowB = saved.lowB - (saved.lowB + 1) * (1 - smooth(0.42, 0.58, t));
  if (Math.abs(chA.state.eqLow - lowA) > 0.002) chA.set('eqLow', lowA);
  if (Math.abs(chB.state.eqLow - lowB) > 0.002) chB.set('eqLow', lowB);
  // tempo morph: both decks run at a BPM between the two tracks' own BPMs
  if (A.bpm && B.bpm && A.track && B.track) {
    const target = A.bpm * (1 + (st._baseTempo?.a ?? 0) / 100) * (1 - t) + B.bpm * (1 + (st._baseTempo?.b ?? 0) / 100) * t;
    for (const d of [A, B]) {
      const pct = (target / d.bpm - 1) * 100;
      if (Math.abs(pct) <= Math.max(d.tempoRange, 16) && Math.abs(d.tempo - pct) > 0.01) d.setTempo(pct);
    }
  }
}

export function setSmartFader(app, on) {
  const st = ctlState(app), eng = app.engine;
  if (st.smartFader === !!on) return;
  st.smartFader = !!on;
  if (on) {
    const pair = xfDecks(app);
    if (pair) {
      const [A, B] = pair;
      st._baseTempo = { a: A.tempo, b: B.tempo };
      // the stopped deck follows the playing one's beat so the blend is in phase
      const playing = A.playing ? A : B.playing ? B : null, other = playing === A ? B : A;
      if (playing && other.track && other.bpm && !other.syncOn) try { other.sync(); } catch { /* not analysed */ }
    }
    st._off = eng.on('master', (key, v) => { if (key === 'crossfader' && st.smartFader) smartApply(app, v); });
    smartApply(app, eng.crossfader || 0);
  } else {
    st._off?.(); st._off = null;
    const s = st._saved; st._saved = null;
    if (s) { s.chA.set('eqLow', s.lowA); s.chB.set('eqLow', s.lowB); }
  }
  notify();
}

/** Automatic beat-synced transition to the other deck over `beats` beats (SHIFT + SMART FADER). */
export function smartAutoTransition(app, beats = 16) {
  const st = ctlState(app), eng = app.engine, pair = xfDecks(app);
  if (!pair || st.auto) { if (st.auto) { cancelAnimationFrame(st.auto.raf); clearTimeout(st.auto.timer); st.auto = null; notify(); } return false; }
  const [A, B] = pair;
  const from = A.playing && !B.playing ? A : B.playing && !A.playing ? B : (eng.crossfader || 0) <= 0 ? A : B;
  const to = from === A ? B : A;
  if (!to.track) { app.toast?.('Smart Fader: load a track on the other deck first'); return false; }
  const dir = to === B ? 1 : -1;
  const wasSmart = st.smartFader;
  if (!wasSmart) setSmartFader(app, true);
  const beatSec = (from.beatLen || 0.5) / (from.rate || 1);
  // start the incoming deck on the outgoing deck's next bar, in sync
  let wait = 0;
  if (from.playing && from.bpm) {
    const beatIdx = (from.position - (from.gridOffset || 0)) / from.beatLen;
    const toBar = 4 - (((beatIdx % 4) + 4) % 4);
    wait = (toBar < 0.05 ? toBar + 4 : toBar) * beatSec;
  }
  const startX = eng.crossfader || 0, endX = dir;
  st.auto = { from, to };
  st.auto.timer = setTimeout(() => {
    if (!st.auto) return;
    if (!to.playing) { if (to.bpm && from.bpm && !to.syncOn) try { to.sync(); } catch { /* */ } to.play(); }
    const t0 = performance.now(), dur = beats * beatSec * 1000;
    const step = (now) => {
      if (!st.auto) return;
      const k = Math.min(1, (now - t0) / dur);
      eng.setCrossfader(startX + (endX - startX) * k);
      if (k < 1) st.auto.raf = requestAnimationFrame(step);
      else { st.auto = null; if (from.playing) from.pause(); if (!wasSmart) setSmartFader(app, false); notify(); }
    };
    st.auto.raf = requestAnimationFrame(step);
  }, wait * 1000);
  notify();
  return true;
}

// ---------- SMART CFX ----------
/** Is a Color FX (not the plain filter) on the filter knobs? */
export const smartCfxOn = (app) => (app.engine.channels[0]?.state.colorFx || 'filter') !== 'filter';
/** SMART CFX: plain filter <-> the last Color FX used, on every channel (like the mixer's Color FX selector). */
export function setSmartCfx(app, on) {
  const st = ctlState(app), cur = app.engine.channels[0]?.state.colorFx || 'filter';
  if (cur !== 'filter') st.lastColorFx = cur;
  const id = on ? st.lastColorFx || 'space' : 'filter';
  for (const ch of app.engine.channels) if (ch.state.colorFx !== id) ch.set('colorFx', id);
  app.setSetting?.('colorFx', id);
  notify();
}

// ---------- MASTER cue ----------
export function setMasterCue(app, on) {
  const st = ctlState(app), eng = app.engine;
  if (st.masterCue === !!on) return;
  st.masterCue = !!on;
  if (typeof eng.setMasterCue === 'function') eng.setMasterCue(!!on); // mixer v2: a real CUE MST bus
  else if (on) { st._cueMix = eng.cueMix ?? 0; eng.setCueMix(1); } else eng.setCueMix(st._cueMix ?? 0);
  notify();
}

/** MIDI targets for midi.js buildTargets(). Same shape: { id, label, kind, handler, led?, get? }. */
export function controllerTargets(app, existing = new Set()) {
  const T = [], eng = app.engine, st = ctlState(app);
  const add = (id, label, kind, handler, led, get) => { if (!existing.has(id)) T.push({ id, label, kind, handler, led, get }); };
  for (let d = 0; d < 4; d++) {
    const deck = eng.decks[d], n = d + 1, P = `deck${n}`;
    for (const [m, label] of Object.entries(PAD_MODES)) add(`${P}.ctlPadMode.${m}`, `Deck ${n} Pad mode: ${label}`, 'button', (down) => down && setPadMode(app, d, m), () => st.padMode[n] === m);
    add(`${P}.ctlPadModeSelect`, `Deck ${n} Pad mode selection (SHIFT + BEAT SYNC on the controller)`, 'button', () => {});
    for (let p = 0; p < 8; p++) {
      add(`${P}.padFx${p + 1}`, `Deck ${n} Pad FX ${p + 1} (${PAD_FX_LABELS[p]})`, 'button', (down) => { if (down) st.held[n].add(p); else st.held[n].delete(p); app.padFx?.(deck, PAD_FX[p], down); }, () => st.held[n].has(p));
      add(`${P}.loopPad${p + 1}`, `Deck ${n} Beat loop pad ${fmtBeats(LOOP_PADS[p])}`, 'button', (down) => down && loopToggle(deck, LOOP_PADS[p]), () => !!deck.loop?.active && Math.abs(deck.loopBeats - LOOP_PADS[p]) < 1e-3);
      add(`${P}.samplerStop${p + 1}`, `Sampler ${p + 1} stop (deck ${n} pads)`, 'button', (down) => down && eng.sampler?.stop(p), () => !!eng.sampler?.slots?.[p]?.playing);
    }
    add(`${P}.ctlToStart`, `Deck ${n} Back to start`, 'button', (down) => down && deck.track && (deck.playing ? deck.seek(0) : (deck.seek(0), deck.cuePoint = 0)));
    add(`${P}.ctlStutter`, `Deck ${n} Stutter (play from cue)`, 'button', (down) => { if (!down || !deck.track) return; deck.seek(deck.cuePoint || 0); if (!deck.playing) deck.play(); }, () => deck.playing);
    add(`${P}.ctlVinyl`, `Deck ${n} Jog mode vinyl`, 'button', (down) => { if (down) { deck.vinylMode = !deck.vinylMode; deck.emit?.('state'); } }, () => deck.vinylMode);
  }
  add('deckSelect.left', 'Deck select: left controller side, deck 1 / 3', 'button', (down) => down && setDeckLayer(app, 0), () => st.layer[0] === 2);
  add('deckSelect.right', 'Deck select: right controller side, deck 2 / 4', 'button', (down) => down && setDeckLayer(app, 1), () => st.layer[1] === 3);
  add('master.cue', 'Master cue (hear the master in headphones)', 'button', (down) => down && setMasterCue(app, !st.masterCue), () => st.masterCue);
  add('smart.fader', 'Smart Fader on/off (crossfader blends BPM, bass and levels; SHIFT: auto transition)', 'button', (down) => down && (app.shift ? smartAutoTransition(app) : setSmartFader(app, !st.smartFader)), () => st.smartFader || !!st.auto);
  add('smart.faderAuto', 'Smart Fader: automatic 16-beat transition', 'button', (down) => down && smartAutoTransition(app), () => !!st.auto);
  add('smart.cfx', 'Smart CFX on/off (filter knobs: plain filter or the last Color FX)', 'button', (down) => down && setSmartCfx(app, !smartCfxOn(app)), () => smartCfxOn(app));
  return T;
}
