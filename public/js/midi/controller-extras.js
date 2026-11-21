// Extra controller functions used by the bundled controller mappings and by the controller skins
// (Compact Controller, All-in-One): pad modes with LED state, a generic "pad N in the current pad mode", Pad FX,
// beat-loop pads, sampler stop, track search, master cue, and the two "smart" functions of compact controllers:
//   - SMART FADER: the crossfader alone blends two tracks: both decks follow a BPM that morphs from the outgoing to the
//     incoming track, the basslines swap in the middle, and the levels follow the crossfader. SHIFT (or `smart.faderAuto`)
//     runs it automatically: the other deck starts on the next bar, beat-synced, and the crossfader moves over 16 beats.
//   - SMART CFX: the CFX (filter) knob of each channel plays a Color FX preset instead of the plain filter;
//     FX SELECT ◀ ▶ picks the preset.
// State lives on app.ctl so skins and LEDs read one source of truth. All of it goes through public engine / deck APIs.

/** Pad modes a skin or controller can select. Labels are the silkscreen names. */
export const PAD_MODES = {
  hotcue: { label: 'HOT CUE', color: '#ff8a2a' },
  padfx: { label: 'PAD FX', color: '#e0457b' },
  loop: { label: 'LOOP', color: '#3fbf6f' },
  sampler: { label: 'SAMPLER', color: '#3f8cff' },
  slipLoop: { label: 'SLIP LOOP', color: '#2ed4c6' },
  jump: { label: 'BEAT JUMP', color: '#8a7dff' },
  gate: { label: 'GATE CUE', color: '#ffb02a' },
  loop2: { label: 'BEAT LOOP 2', color: '#7ad44a' },
  keyshift: { label: 'KEY SHIFT', color: '#ff5ec8' },
  jump2: { label: 'BEAT JUMP 2', color: '#b07dff' },
};
/** How each controller pad mode shows in the standard deck UI (deck.padMode). */
const UI_MODE = { hotcue: 'hotcue', padfx: 'fx', loop: 'roll', sampler: 'sampler', slipLoop: 'roll', jump: 'jump', gate: 'hotcue', loop2: 'roll', keyshift: 'pitch', jump2: 'jump' };
export const PAD_FX = ['brake', 'backspin', 'censor', 'echoOut', 'roll1', 'roll2', 'filterSweep', 'tapeStop'];
export const PAD_FX_LABELS = ['BRAKE', 'BACKSPIN', 'CENSOR', 'ECHO OUT', 'ROLL ¼', 'ROLL ⅛', 'SWEEP', 'TAPE STOP'];
export const LOOP_PADS = [1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
export const LOOP2_PADS = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4];
export const SLIP_ROLLS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8];
export const KEY_STEPS = [-5, -3, -2, -1, 1, 2, 3, 5];
export const JUMP_PADS = [-1, -2, -4, -8, 1, 2, 4, 8];
export const JUMP2_PADS = [-16, -32, -64, -0.5, 16, 32, 64, 0.5];
/** Smart CFX presets: Color FX ids from audio/effects.js (filter = the plain filter). */
export const SMART_CFX = [
  { id: 'filter', label: 'FILTER' }, { id: 'space', label: 'SPACE + FILTER' }, { id: 'dubecho', label: 'DUB ECHO' },
  { id: 'crush', label: 'CRUSH' }, { id: 'noise', label: 'NOISE' }, { id: 'pitch', label: 'JET' },
];

const fmtBeats = (b) => (b >= 1 ? String(b) : `1/${Math.round(1 / b)}`);

/** Controller state shared by mappings, skins and LEDs. */
export function ctlState(app) {
  if (!app.ctl) {
    app.ctl = {
      padMode: [null, 'hotcue', 'hotcue', 'hotcue', 'hotcue'], // by deck number
      held: [null, new Set(), new Set(), new Set(), new Set()], // pads held (for LEDs / skins)
      smartFader: false, smartCfx: false, cfxPreset: 1, masterCue: false, auto: null,
    };
  }
  return app.ctl;
}

/** Text and colour of pad n (0-7) on deck index d in the current mode, for skins. */
export function padInfo(app, d, n) {
  const st = ctlState(app), deck = app.engine.decks[d], mode = st.padMode[d + 1];
  const shift = !!app.shift, c = PAD_MODES[mode]?.color || '#ff8a2a';
  switch (mode) {
    case 'hotcue': case 'gate': {
      const cue = deck.hotCue(n);
      return { text: cue ? (cue.name || String.fromCharCode(65 + n)) : String.fromCharCode(65 + n), color: cue ? (cue.color || c) : null, lit: !!cue };
    }
    case 'padfx': return { text: shift ? `ROLL ${fmtBeats([1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8][n])}` : PAD_FX_LABELS[n], color: c, lit: st.held[d + 1].has(n) };
    case 'loop': return shift ? { text: `${n < 4 ? '◀' : '▶'}${[1, 2, 4, 8][n % 4]}`, color: c, lit: false } : { text: fmtBeats(LOOP_PADS[n]), color: c, lit: !!deck.loop?.active && Math.abs(deck.loopBeats - LOOP_PADS[n]) < 1e-3 };
    case 'loop2': return { text: fmtBeats(LOOP2_PADS[n]), color: c, lit: !!deck.loop?.active && Math.abs(deck.loopBeats - LOOP2_PADS[n]) < 1e-3 };
    case 'slipLoop': return { text: fmtBeats(SLIP_ROLLS[n]), color: c, lit: st.held[d + 1].has(n) };
    case 'sampler': { const s = app.engine.sampler?.slots?.[n]; return { text: (s?.name || `S${n + 1}`).slice(0, 10), color: s?.buffer || s?.builtin ? c : null, lit: !!s?.playing }; }
    case 'jump': return { text: `${JUMP_PADS[n] < 0 ? '◀' : '▶'}${Math.abs(JUMP_PADS[n])}`, color: c, lit: st.held[d + 1].has(n) };
    case 'jump2': return { text: `${JUMP2_PADS[n] < 0 ? '◀' : '▶'}${fmtBeats(Math.abs(JUMP2_PADS[n]))}`, color: c, lit: st.held[d + 1].has(n) };
    case 'keyshift': return { text: `${KEY_STEPS[n] > 0 ? '+' : ''}${KEY_STEPS[n]}`, color: c, lit: deck.keyShift === KEY_STEPS[n] };
    default: return { text: '', color: null, lit: false };
  }
}

/** Press / release pad n (0-7) of deck index d in the current pad mode. */
export function padAction(app, d, n, down) {
  const st = ctlState(app), deck = app.engine.decks[d], eng = app.engine, mode = st.padMode[d + 1];
  const held = st.held[d + 1];
  if (down) { held.add(n); eng.resume?.(); } else if (!held.delete(n)) return; // release without press: ignore
  const shift = !!app.shift;
  switch (mode) {
    case 'hotcue':
      if (down) { if (shift) deck.deleteHotCue(n); else deck.hotCueDown(n); } else deck.hotCueUp(n);
      break;
    case 'gate': // plays from the hot cue while held, back to it on release
      if (down) { if (!deck.hotCue(n)) { deck.hotCueDown(n); return; } deck._gate = n; deck.seek(deck.hotCue(n).position); if (!deck.playing) deck.play(); }
      else if (deck._gate === n) { deck._gate = null; deck.pause(); deck.seek(deck.hotCue(n).position); }
      break;
    case 'padfx':
      if (shift) { if (down) deck.rollOn([1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8][n]); else deck.rollOff(); }
      else app.padFx?.(deck, PAD_FX[n], down);
      break;
    case 'loop':
      if (!down) break;
      if (shift) deck.beatJump([1, 2, 4, 8][n % 4] * (n < 4 ? -1 : 1));
      else loopToggle(deck, LOOP_PADS[n]);
      break;
    case 'loop2': if (down) loopToggle(deck, LOOP2_PADS[n]); break;
    case 'slipLoop': if (down) deck.rollOn(SLIP_ROLLS[n]); else deck.rollOff(); break;
    case 'sampler': if (down) { if (shift) eng.sampler.stop(n); else eng.sampler.trigger(n); } break;
    case 'jump': if (down) deck.beatJump(JUMP_PADS[n]); break;
    case 'jump2': if (down) deck.beatJump(JUMP2_PADS[n]); break;
    case 'keyshift': if (down) deck.setKeyShift(shift ? 0 : KEY_STEPS[n]); break;
    default: break;
  }
}

function loopToggle(deck, beats) {
  if (deck.loop?.active && Math.abs(deck.loopBeats - beats) < 1e-3) deck.exitLoop();
  else { deck._ctlLoopBeats = beats; deck.autoLoop(beats); }
}

/** Select a pad mode on deck index d (also shown in the standard deck UI). */
export function setPadMode(app, d, mode) {
  const st = ctlState(app);
  if (!PAD_MODES[mode]) return;
  for (const n of [...st.held[d + 1]]) padAction(app, d, n, false);
  st.padMode[d + 1] = mode;
  try { app.engine.decks[d].padMode?.(UI_MODE[mode]); } catch { /* deck UI not built (tests) */ }
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
  app.emitCtl?.();
}

/** Automatic beat-synced transition to the other deck over `beats` beats (SHIFT + SMART FADER). */
export function smartAutoTransition(app, beats = 16) {
  const st = ctlState(app), eng = app.engine, pair = xfDecks(app);
  if (!pair || st.auto) { if (st.auto) { cancelAnimationFrame(st.auto.raf); clearTimeout(st.auto.timer); st.auto = null; } return false; }
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
    const pos = from.position, beatIdx = (pos - (from.gridOffset || 0)) / from.beatLen;
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
      else { st.auto = null; if (from.playing) from.pause(); if (!wasSmart) setSmartFader(app, false); app.emitCtl?.(); }
    };
    st.auto.raf = requestAnimationFrame(step);
  }, wait * 1000);
  app.emitCtl?.();
  return true;
}

// ---------- SMART CFX ----------
export function setSmartCfx(app, on, preset) {
  const st = ctlState(app);
  if (preset != null) st.cfxPreset = ((preset % SMART_CFX.length) + SMART_CFX.length) % SMART_CFX.length;
  st.smartCfx = !!on;
  const id = st.smartCfx ? SMART_CFX[st.cfxPreset].id : 'filter';
  for (const ch of app.engine.channels) if (ch.state.colorFx !== id) ch.set('colorFx', id);
  app.emitCtl?.();
}

// ---------- MASTER cue ----------
export function setMasterCue(app, on) {
  const st = ctlState(app), eng = app.engine;
  if (st.masterCue === !!on) return;
  st.masterCue = !!on;
  if (typeof eng.setMasterCue === 'function') eng.setMasterCue(!!on); // mixer v2: a real CUE MST bus
  else if (on) { st._cueMix = eng.cueMix ?? 0; eng.setCueMix(1); } else eng.setCueMix(st._cueMix ?? 0);
  app.emitCtl?.();
}

// ---------- held search (SEARCH ◀ ▶) ----------
function searchHold(deck, dir, down) {
  clearInterval(deck._ctlSearch);
  if (!down) return;
  const tick = () => deck.track && deck.seek(Math.max(0, Math.min(deck.duration - 0.1, deck.position + dir * 0.5)));
  tick();
  deck._ctlSearch = setInterval(tick, 50); // ≈ 10x speed while held
}

/** MIDI targets for midi.js buildTargets(). Same shape: { id, label, kind, handler, led?, get? }. */
export function controllerTargets(app, existing = new Set()) {
  const T = [], eng = app.engine, st = ctlState(app);
  const add = (id, label, kind, handler, led, get) => { if (!existing.has(id)) T.push({ id, label, kind, handler, led, get }); };
  for (let d = 0; d < 4; d++) {
    const deck = eng.decks[d], n = d + 1, P = `deck${n}`;
    for (const m of Object.keys(PAD_MODES)) add(`${P}.ctlPadMode.${m}`, `Deck ${n} Pad mode: ${PAD_MODES[m].label}`, 'button', (down) => down && setPadMode(app, d, m), () => st.padMode[n] === m);
    const CYCLE = ['hotcue', 'padfx', 'loop', 'sampler'];
    add(`${P}.ctlPadModeNext`, `Deck ${n} Pad mode: next (HOT CUE → PAD FX → LOOP → SAMPLER)`, 'button', (down) => down && setPadMode(app, d, CYCLE[(CYCLE.indexOf(st.padMode[n]) + 1) % CYCLE.length]));
    for (let p = 0; p < 8; p++) {
      add(`${P}.ctlPad${p + 1}`, `Deck ${n} Performance pad ${p + 1} (controller pad mode)`, 'button', (down) => padAction(app, d, p, down), () => padInfo(app, d, p).lit);
      add(`${P}.padFx${p + 1}`, `Deck ${n} Pad FX ${p + 1} (${PAD_FX_LABELS[p]})`, 'button', (down) => { if (down) st.held[n].add(p); else st.held[n].delete(p); app.padFx?.(deck, PAD_FX[p], down); }, () => st.held[n].has(p));
      add(`${P}.loopPad${p + 1}`, `Deck ${n} Beat loop pad ${fmtBeats(LOOP_PADS[p])}`, 'button', (down) => down && loopToggle(deck, LOOP_PADS[p]), () => !!deck.loop?.active && Math.abs(deck.loopBeats - LOOP_PADS[p]) < 1e-3);
      add(`${P}.samplerStop${p + 1}`, `Sampler ${p + 1} stop (deck ${n} pads)`, 'button', (down) => down && eng.sampler?.stop(p), () => !!eng.sampler?.slots?.[p]?.playing);
    }
    add(`${P}.ctlSearchFwd`, `Deck ${n} Search forward (hold)`, 'button', (down) => searchHold(deck, 1, down));
    add(`${P}.ctlSearchBack`, `Deck ${n} Search back (hold)`, 'button', (down) => searchHold(deck, -1, down));
    add(`${P}.ctlToStart`, `Deck ${n} Back to start`, 'button', (down) => down && deck.track && (deck.playing ? deck.seek(0) : (deck.seek(0), deck.cuePoint = 0)));
    add(`${P}.ctlStutter`, `Deck ${n} Stutter (play from cue)`, 'button', (down) => { if (!down || !deck.track) return; deck.seek(deck.cuePoint || 0); if (!deck.playing) deck.play(); }, () => deck.playing);
    add(`${P}.ctlCueCall`, `Deck ${n} Cue/loop call next`, 'button', (down) => down && cueCall(deck, 1));
    add(`${P}.ctlCueCallBack`, `Deck ${n} Cue/loop call previous`, 'button', (down) => down && cueCall(deck, -1));
    add(`${P}.ctlMemoryDelete`, `Deck ${n} Delete memory cue here`, 'button', (down) => down && memoryDelete(deck));
    add(`${P}.ctlVinyl`, `Deck ${n} Jog mode vinyl`, 'button', (down) => { if (down) { deck.vinylMode = !deck.vinylMode; deck.emit?.('state'); } }, () => deck.vinylMode);
    add(`${P}.ctlTempoRange`, `Deck ${n} Tempo range`, 'button', (down) => {
      if (!down) return;
      const R = [6, 10, 16, 100], i = R.indexOf(deck.tempoRange);
      deck.setTempoRange(R[(i + 1) % R.length]);
    });
  }
  add('master.cue', 'Master cue (hear the master in headphones)', 'button', (down) => down && setMasterCue(app, !st.masterCue), () => st.masterCue);
  add('smart.fader', 'Smart Fader on/off (crossfader blends BPM, bass and levels)', 'button', (down) => down && (app.shift ? smartAutoTransition(app) : setSmartFader(app, !st.smartFader)), () => st.smartFader || !!st.auto);
  add('smart.faderAuto', 'Smart Fader: automatic 16-beat transition', 'button', (down) => down && smartAutoTransition(app), () => !!st.auto);
  add('smart.cfx', 'Smart CFX on/off (CFX knobs play a Color FX preset)', 'button', (down) => down && setSmartCfx(app, !st.smartCfx), () => st.smartCfx);
  add('smart.cfxNext', 'Smart CFX: next preset (FX SELECT ▶)', 'button', (down) => down && setSmartCfx(app, true, st.cfxPreset + 1), () => st.smartCfx);
  add('smart.cfxPrev', 'Smart CFX: previous preset (◀ FX SELECT)', 'button', (down) => down && setSmartCfx(app, true, st.cfxPreset - 1), () => st.smartCfx);
  add('global.quantize', 'Quantize (all decks)', 'button', (down) => { if (!down) return; const on = !eng.decks[0].quantize; for (const d of eng.decks) d.setQuantize(on); }, () => !!eng.decks[0]?.quantize);
  return T;
}

function cueCall(deck, dir) {
  if (!deck.track) return;
  const pts = (deck.track.cues || []).map((c) => c.position).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const pos = deck.position;
  const next = dir > 0 ? pts.find((x) => x > pos + 0.05) : [...pts].reverse().find((x) => x < pos - 0.05);
  if (next != null) { deck.seek(next); if (!deck.playing) deck.cuePoint = next; }
}
function memoryDelete(deck) {
  if (!deck.track) return;
  const pos = deck.position, cues = deck.track.cues || [];
  const i = cues.findIndex((c) => !(c.index >= 0) && Math.abs(c.position - pos) < 0.25);
  if (i >= 0) { cues.splice(i, 1); deck.saveCues?.(); }
}

