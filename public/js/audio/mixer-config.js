// Mixer configuration (settings.mixer) with defaults and the legacy migration. Pure: also used by the settings schema
// and the tests. Only configuration is stored (types, curves, routes, toggles); knob positions (booth level, master
// isolator, warmth, ...) live in the engine like the master volume does.
import { xfSettings } from './curves.js';

export const MIXER_DEFAULTS = Object.freeze({
  personality: 'club',
  // M1 / M2 crossfader and faders (xfCurve / xfCutIn fall back to the legacy settings.crossfaderCurve)
  xfReverse: false, xfCutTime: 5, faderCurve: 'log', rotary: false, hideXfader: false,
  // M3 / M4 / M5 EQ, filter, Color FX
  eqType: 'isolator', eqXover: [200, 2500], classicKill: true, filterMode: 'oneKnob', centerLock: false, colorPerChannel: false, colorHidden: false,
  // M12 / M13 / M16 master
  masterIsoXover: [300, 4000], masterIsoBoost: 6, showMasterIso: false, showWarmth: false, limiterCeiling: -1, mono: false,
  // M6 booth, M7 headphones
  boothRoute: 'off', boothDeviceId: '', micToBooth: false, showBooth: false, cuePost: false, hp2Route: 'off', hp2DeviceId: '',
  // M8 mic, M15 record
  talkoverMode: 'manual', talkoverThreshold: -36, micFx: 'echo', micToRecord: true, feedbackReducer: false,
  // M10 send / return, M11 compressor
  sendType: 'reverb', returnTo: 'master', sendRoute: 'internal', returnDeviceId: '', showComp: false, showSend: false,
  // M9 FX units
  fx1: { type: 'echo', assign: 'off', quantize: false }, fx2: { type: 'reverb', assign: 'off', quantize: false },
  fxBusCollapsed: false,
});

/** settings -> full mixer options (defaults filled in, legacy crossfaderCurve migrated). */
export function normalizeMixer(settings = {}) {
  const m = settings.mixer && typeof settings.mixer === 'object' ? settings.mixer : {};
  const xf = xfSettings(settings);
  return { ...MIXER_DEFAULTS, ...m, fx1: { ...MIXER_DEFAULTS.fx1, ...(m.fx1 || {}) }, fx2: { ...MIXER_DEFAULTS.fx2, ...(m.fx2 || {}) }, xfCurve: xf.curve, xfCutIn: xf.cutIn, xfReverse: xf.reverse, xfCutTime: xf.cutTime };
}
