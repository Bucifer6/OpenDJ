// Settings → Decks: platter skin, haptics, needle drop, flick spin-back, bend, tempo step, deck lock and the default
// vinyl model for every deck (each deck's Platter panel can change its own copy).
import { el } from '../util.js';
import { deckOptions, vinylFor, VINYL_DEFAULTS } from '../audio/vinyl.js';
import { PLATTER_SKINS } from './platter-skins.js';
import { setHapticsLevel } from './haptics.js';
import { platform } from '../platform.js';

export function deckSettingsFields(app, { field, sel, chk }) {
  const o = deckOptions(app.settings);
  const setOpt = (patch) => { const v = { ...deckOptions(app.settings), ...patch }; app.setSetting('deckOptions', v); if (patch.haptics) setHapticsLevel(patch.haptics); };
  const v = { ...VINYL_DEFAULTS, ...(app.settings.vinyl || {}) };
  const setVinyl = (patch) => { app.setSetting('vinyl', { ...(app.settings.vinyl || {}), ...patch }); for (const d of app.engine.decks) d.applyVinyl(vinylFor(app.settings, d.index)); };
  const motorPreset = (start, stop) => [start, stop];
  const MOTOR = [['cdj', 'Instant (CDJ)', motorPreset(0, 0)], ['high', 'Turntable, high torque', motorPreset(0.2, 0.3)], ['mid', 'Turntable, medium torque', motorPreset(0.5, 0.8)], ['low', 'Turntable, low torque (vintage)', motorPreset(1, 1.6)]];
  const motorNow = MOTOR.find(([, , [a, b]]) => a === v.start && b === v.stop)?.[0] || 'custom';
  return [
    el('h3', {}, 'Platter'),
    field('Deck look', sel(o.deckLook || 'auto', [['auto', 'Follow the theme'], ['standard', 'Standard decks'], ['turntable', 'Direct-drive turntables'], ['player', 'Pro media players']], (x) => setOpt({ deckLook: x })), 'Themes such as Direct-Drive Turntable, Pro Media Player and Club Booth pick a look; each deck\'s Platter panel can override it. Phones and 4-deck layouts show a simplified version.'),
    field('Platter look', sel(o.platterSkin, PLATTER_SKINS, (x) => setOpt({ platterSkin: x })), 'Vinyl: rotating cover art, strobe and a tonearm you can drag to drop the needle. Jog display: artwork, position ring, loop and slip markers.'),
    field('Motor (every deck)', sel(motorNow, [...MOTOR.map(([id, l]) => [id, l]), ...(motorNow === 'custom' ? [['custom', 'Custom (set in the decks\' Platter panels)']] : [])], (x) => { const m = MOTOR.find(([id]) => id === x); if (m) { setVinyl({ start: m[2][0], stop: m[2][1] }); app.setSetting('vinylDecks', (app.settings.vinylDecks || []).map((d) => (d ? (({ start, stop, ...rest }) => rest)(d) : d))); for (const d of app.engine.decks) d.applyVinyl(vinylFor(app.settings, d.index)); } }),
      'Start and stop times of play / pause and of the platter after you let go. Each deck\'s Platter panel has the full set (weight, slip-mat, coast, spin-back, 33 / 45 / 78).'),
    field('Haptic feedback', sel(o.haptics, [['auto', platform.native ? 'Subtle on phones' : 'Automatic (phones only)'], ['off', 'Off'], ['subtle', 'Subtle'], ['full', 'Full (beats and fader cuts too)']], (x) => setOpt({ haptics: x }))),
    el('label', { class: 'check', title: 'A fast backwards throw of a playing platter (faster than 3x) spins the record back with the deck\'s spin-back settings.' }, chk(o.flickSpinback, (x) => setOpt({ flickSpinback: x })), ' Flick to spin back'),
    el('h3', {}, 'Needle drop and tempo'),
    field('Needle lock while playing', sel(o.needleLock, [['auto', 'On for phones'], ['on', 'On'], ['off', 'Off']], (x) => setOpt({ needleLock: x })), 'With the lock on, a playing deck needs a short press-and-hold on the overview waveform before the needle drops.'),
    field('Needle drop snaps to', sel(o.needleSnap, [['off', 'Nowhere (exact)'], ['beat', 'The nearest beat'], ['bar', 'The nearest bar']], (x) => setOpt({ needleSnap: x })), 'While playing the drop keeps the beat phase, so the mix stays in time.'),
    field('Pitch bend buttons', sel(o.bendMode, [['ramp', 'Ramp: 1 % growing to 8 % while held'], ['fixed', 'Fixed ±4 %']], (x) => setOpt({ bendMode: x }))),
    field('Tempo +/− step (MIDI and keys)', sel(o.fineStep, [[0.02, '0.02 %'], [0.05, '0.05 %'], [0.5, '0.5 %']], (x) => setOpt({ fineStep: Number(x) }))),
    el('label', { class: 'check' }, chk(o.hardLock, (x) => setOpt({ hardLock: x })), ' Deck lock: refuse loads onto a playing deck (instead of asking)'),
    field('Scratch view crossfader', sel(o.scratchHand, [['right', 'On the right (right-handed)'], ['left', 'On the left (left-handed)']], (x) => setOpt({ scratchHand: x }))),
  ];
}
