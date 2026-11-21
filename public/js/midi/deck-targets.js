// MIDI / HID targets for the turntable and deck features of docs/MIXER_AND_TURNTABLES_PLAN.md §6 (T1-T11). Ids follow
// the plan and docs/CONTROLLER_SUPPORT_PLAN.md (§4.9 deckN.jumpSize.*, deckN.jumpBySize±, deckN.needle); existing ids in
// midi.js buildTargets are never renamed. kind: button | abs (0..1).
import { vinylFor, deckOptions, VINYL_RANGES } from '../audio/vinyl.js';
import { isPhone } from '../ui/haptics.js';

/** Persist one deck's vinyl option change (settings.vinylDecks[i]) and apply it. */
export function setDeckVinyl(app, deck, patch) {
  const arr = Array.isArray(app.settings.vinylDecks) ? [...app.settings.vinylDecks] : [];
  while (arr.length <= deck.index) arr.push(null);
  arr[deck.index] = { ...(arr[deck.index] || {}), ...patch };
  app.settings.vinylDecks = arr;
  deck.applyVinyl(vinylFor(app.settings, deck.index));
  clearTimeout(setDeckVinyl._t); // knob drags: save once the hand stops
  setDeckVinyl._t = setTimeout(() => app.setSetting?.('vinylDecks', app.settings.vinylDecks), 250);
}
/** Is needle lock in effect (a playing deck needs a long press / refuses MIDI needle drops)? */
export const needleLocked = (app) => { const o = deckOptions(app.settings).needleLock; return o === 'on' || (o === 'auto' && isPhone()); };

export function deckMidiTargets(app) {
  const T = [];
  const add = (id, label, kind, handler, led, get) => T.push({ id, label, kind, handler, led, get });
  const eng = app.engine;
  for (let d = 0; d < 4; d++) {
    const deck = eng.decks[d], n = d + 1, P = `deck${n}`;
    const v = (k) => deck.vinyl?.[k] ?? 0;
    const absVinyl = (k, label) => {
      const [lo, hi] = VINYL_RANGES[k];
      add(`${P}.${k === 'start' ? 'motorStart' : k === 'stop' ? 'motorStop' : k}`, `Deck ${n} ${label}`, 'abs', (x) => setDeckVinyl(app, deck, { [k]: Math.round((lo + x * (hi - lo)) * 100) / 100 }), null, () => (v(k) - lo) / (hi - lo));
    };
    add(`${P}.vinylMode`, `Deck ${n} Vinyl mode (jog top scratches)`, 'button', (down) => { if (down) { deck.vinylMode = !deck.vinylMode; deck.emit('state'); } }, () => deck.vinylMode);
    absVinyl('start', 'Motor start time');
    absVinyl('stop', 'Motor stop time');
    absVinyl('slipmat', 'Slip-mat');
    absVinyl('jogWeight', 'Jog weight');
    absVinyl('inertia', 'Platter inertia (coast time)');
    absVinyl('brakeTime', 'Brake time');
    absVinyl('spinTime', 'Spin-back length');
    absVinyl('spinSpeed', 'Spin-back throw speed');
    add(`${P}.brake`, `Deck ${n} Brake`, 'button', (down) => down && deck.brake());
    add(`${P}.backspin`, `Deck ${n} Spin back`, 'button', (down) => down && deck.backspin());
    add(`${P}.slipBrake`, `Deck ${n} Slip brake (resumes where it would be)`, 'button', (down) => down && deck.slipBrake());
    add(`${P}.slipBackspin`, `Deck ${n} Slip spin back`, 'button', (down) => down && deck.slipBackspin());
    add(`${P}.startStop`, `Deck ${n} Start / stop with motor ramps`, 'button', (down) => down && (eng.resume(), deck.startStop()), () => deck.playing);
    add(`${P}.quartz`, `Deck ${n} Quartz lock (tempo 0 %)`, 'button', (down) => down && setDeckVinyl(app, deck, { quartz: !deck.vinyl.quartz }), () => !!deck.vinyl.quartz);
    for (const r of [33, 45, 78]) add(`${P}.rpm${r}`, `Deck ${n} ${r === 33 ? '33⅓' : r} rpm (scratch scale)`, 'button', (down) => down && setDeckVinyl(app, deck, { rpm: r }), () => deck.vinyl.rpm === r);
    add(`${P}.tempoGlideReset`, `Deck ${n} Tempo glide to 0 %`, 'button', (down) => down && deck.tempoGlide(0, 16), () => deck.gliding);
    add(`${P}.tempoGlideSync`, `Deck ${n} Tempo glide to the master tempo`, 'button', (down) => down && deck.glideToMaster(16), () => deck.gliding);
    add(`${P}.tempoRange.next`, `Deck ${n} Next tempo range`, 'button', (down) => { if (!down) return; const R = [6, 8, 10, 16, 25, 50, 100]; deck.setTempoRange(R[(R.indexOf(deck.tempoRange) + 1) % R.length] || 8); });
    add(`${P}.needle`, `Deck ${n} Needle drop (strip / knob)`, 'abs', (x) => { if (deck.playing && needleLocked(app)) return; deck.needleDrop(x); }, null, () => (deck.duration ? deck.position / deck.duration : 0));
    add(`${P}.needleLock`, `Deck ${n} Needle lock while playing`, 'button', (down) => { if (!down) return; app.setSetting?.('deckOptions', { ...deckOptions(app.settings), needleLock: needleLocked(app) ? 'off' : 'on' }); }, () => needleLocked(app));
    add(`${P}.activeLoop`, `Deck ${n} Active loop (flag the current loop)`, 'button', (down) => down && deck.toggleActiveLoop(), () => deck.loopIsActiveLoop);
    add(`${P}.quantizeDiv.next`, `Deck ${n} Next quantize division`, 'button', (down) => down && deck.cycleQuantizeDiv());
    add(`${P}.jumpSize.up`, `Deck ${n} Beat jump size up`, 'button', (down) => down && deck.jumpSizeStep(1));
    add(`${P}.jumpSize.down`, `Deck ${n} Beat jump size down`, 'button', (down) => down && deck.jumpSizeStep(-1));
    add(`${P}.jumpBySize+`, `Deck ${n} Beat jump forward (selected size)`, 'button', (down) => down && deck.jumpBySize(1));
    add(`${P}.jumpBySize-`, `Deck ${n} Beat jump back (selected size)`, 'button', (down) => down && deck.jumpBySize(-1));
    add(`${P}.loopInAdjust`, `Deck ${n} Loop in adjust (hold, turn the jog)`, 'button', (down) => deck.setLoopAdjust(down ? 'in' : null), () => deck.loopAdjust === 'in');
    add(`${P}.loopOutAdjust`, `Deck ${n} Loop out adjust (hold, turn the jog)`, 'button', (down) => deck.setLoopAdjust(down ? 'out' : null), () => deck.loopAdjust === 'out');
    add(`${P}.padMode.scratch`, `Deck ${n} Pad mode: scratch samples`, 'button', (down) => down && deck.padMode?.('scratch'));
    add(`${P}.padMode.platterPlay`, `Deck ${n} Pad mode: scale play (platter speed)`, 'button', (down) => down && deck.padMode?.('scale'));
    for (let s = 0; s < 8; s++) add(`${P}.scratchSlot${s + 1}`, `Deck ${n} Scratch sample ${s + 1}`, 'button', (down) => down && app.scratchSamples?.toggle(deck, s), () => deck.scratchSample?.slot === s);
    add(`${P}.scratchReturn`, `Deck ${n} Scratch samples: back to the track`, 'button', (down) => down && deck.scratchSampleReturn(), () => !!deck.scratchSample);
    add(`${P}.lock`, `Deck ${n} Deck lock (refuse loads while playing)`, 'button', (down) => { if (down) { deck.hardLock = !deck.hardLock; deck.emit('state'); } }, () => deck.hardLock);
    add(`${P}.slipReverse`, `Deck ${n} Slip reverse (latching)`, 'button', (down) => down && deck.toggleSlipReverse(), () => deck.slipReverse);
  }
  return T;
}
