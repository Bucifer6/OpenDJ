// Validation for settings.json values. Settings come from the web UI (PUT /api/settings), from settings.json on
// disk (which users and older versions edit) and from backups; one bad value must never stop the UI from starting
// (e.g. an unknown AudioContext latencyHint throws). Invalid values are coerced when the intent is clear ("4" -> 4)
// and otherwise dropped, so the caller keeps the previous / default value.
//
//   sanitizeSetting(key, value) -> { ok: true, value } | { ok: false }
//   sanitizeSettings(obj, defaults) -> a copy with every known key valid (invalid ones replaced by the default)

export const THEME_IDS = ['midnight', 'graphite', 'club', 'neon', 'ocean', 'gold', 'forest', 'light', 'contrast', 'cdj', 'vinyl', 'performance', 'studio', 'remote-silverline', 'remote-walnut'];
export const JOG_STYLE_IDS = ['brushed', 'digital', 'vinyl', 'classic'];
export const isThemeId = (v) => typeof v === 'string' && (THEME_IDS.includes(v) || /^remote-[a-z0-9]+(?:-[a-z0-9]+){0,5}$/.test(v));

const bool = () => (v) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);
const str = (max = 4096) => (v) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : undefined);
const oneOf = (...vals) => (v) => (vals.includes(v) ? v : vals.find((x) => String(x) === String(v)));
const num = (lo, hi) => (v) => { if (v === '' || v === null || typeof v === 'boolean') return undefined; const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : undefined; };
const obj = () => (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
const objOrNull = () => (v) => (v === null || (v && typeof v === 'object' && !Array.isArray(v)) ? v : undefined);
/** Object settings with known sub-keys: invalid sub-values are dropped (the merge keeps the old / default one). */
const shape = (fields) => (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (!Object.hasOwn(fields, k)) { out[k] = x; continue; }
    const c = fields[k](x);
    if (c !== undefined) out[k] = c;
  }
  return out;
};

const VINYL_SHAPE = {
  start: num(0, 3), stop: num(0, 3), inertia: num(0, 4), slipmat: num(0, 1), jogWeight: num(0, 1), rpm: oneOf(33, 45, 78),
  brakeTime: num(0.2, 6), spinTime: num(0.4, 4), spinSpeed: num(2, 8), quartz: bool(),
};

const SCHEMA = {
  deckCount: oneOf(2, 4),
  theme: (v) => isThemeId(v) ? v : undefined,
  jogStyles: (v) => {
    if (!obj()(v)) return undefined;
    return Object.fromEntries(Object.entries(v).filter(([id, style]) =>
      isThemeId(id) && (style === 'theme' || JOG_STYLE_IDS.includes(style))));
  },
  accentColor: (v) => (v === '' || v == null ? '' : typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined),
  uiScale: num(50, 200),
  language: oneOf('auto', 'en', 'ro'), // interface language (public/js/i18n.js); 'auto' = the browser's
  layoutMode: oneOf('classic', 'performance', 'waveform'),
  libraryRows: oneOf('compact', 'art'),
  masterDeviceId: str(512), cueDeviceId: str(512), micDeviceId: str(512), midiClockOutput: str(512),
  cueMode: oneOf('device', 'split', 'channels34'),
  crossfaderCurve: oneOf('smooth', 'sharp', 'constant'),
  tempoRange: oneOf(6, 8, 10, 16, 25, 50, 100),
  keyLockDefault: bool(), quantize: bool(), autoGain: bool(), limiter: bool(), fxPostFader: bool(), autoCues: bool(), stemsAutoLoad: bool(), highPrecisionAudio: bool(),
  syncMode: oneOf('beat', 'tempo'),
  waveformColors: oneOf('rgb', 'blue', 'mono', 'player-blue', 'player-rgb'),
  downloadDir: str(), uploadDir: str(),
  automix: shape({
    transitionBeats: num(1, 256), lengthMode: oneOf('fixed', 'auto'), smartStart: bool(), profile: oneOf('club', 'harmonic', 'peak', 'open', 'quick', 'custom'),
    style: oneOf('auto', 'blend', 'bassswap', 'stemswap', 'crossfade', 'filter', 'echo', 'cut', 'backspin', 'brake', 'loop', 'reverb', 'phrase', 'eqswap'),
    keepSync: bool(), skipSilence: bool(), shuffle: bool(), keySync: bool(), order: oneOf('harmonic', 'build', 'peak', 'wave'),
    varyStyles: bool(), onAirLoad: oneOf('ask', 'queue', 'stop'), shape: oneOf('warmup', 'rising', 'steady', 'peak', 'wave', 'party'),
    // party mode (docs/PRO_DJ_AUTOMIX_RESEARCH.md): safety net, level matching, tempo morph, double drops, tricks,
    // and the no-skill party controls
    watchdog: bool(), levelMatch: bool(), tempoMorph: bool(), doubleDrops: bool(), tricks: oneOf('off', 'subtle', 'party'),
    energyBias: num(-2, 2), vibeLock: bool(), cleanOnly: bool(), finale: bool(),
    endAt: (v) => (v === '' || v == null ? '' : typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v) ? v : undefined),
    banned: (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || Number.isFinite(x)).slice(0, 5000).map(String) : undefined),
    preset: oneOf('balanced', 'harmonic', 'energy', 'variety', 'custom'), liveSetLength: num(2, 1000),
    setLength: oneOf('all', '30', '60', '120', '180', 'endless'),
    sliders: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(['harmonic', 'energy', 'variety'].map((k) => [k, num(0, 1)(v[k]) ?? 0.5])) : undefined),
  }),
  midiMappings: obj(),
  recordFormat: oneOf('wav', 'flac', 'mp3', 'aac', 'opus'),
  // AudioContext latencyHint: a category or a number of milliseconds (the UI stores '10' / '20')
  latencyHint: (v) => (['interactive', 'balanced', 'playback'].includes(v) ? v : num(1, 1000)(v) !== undefined ? String(Number(v)) : undefined),
  talkoverDb: num(-60, 0),
  voiceDuckDb: num(-40, 0), voiceVolume: num(0, 2), dedicationLang: oneOf('en', 'ro'),
  colorFx: oneOf('filter', 'space', 'dubecho', 'noise', 'crush', 'pitch', 'sweep', 'crunch', 'pitchshift'),
  // mixer v2 configuration (public/js/audio/mixer-config.js has the defaults; knob positions are not stored)
  mixer: shape({
    personality: oneOf('club', 'classic', 'rotary', 'battle'),
    xfCurve: num(0, 1), xfCutIn: num(0, 0.1), xfCutTime: num(0.5, 30), xfReverse: bool(),
    faderCurve: oneOf('log', 'linear', 'smooth', 'cut'), rotary: bool(), hideXfader: bool(), revVisible: bool(),
    eqType: oneOf('isolator', 'classic', 'fourBand', 'rotaryIso', 'battle', 'vintage', 'sculpt'), classicKill: bool(),
    eqXover: (v) => (Array.isArray(v) && v.length === 2 && v.every((x) => Number.isFinite(x) && x >= 50 && x <= 12000) && v[0] < v[1] ? v.map(Number) : undefined),
    masterIsoXover: (v) => (Array.isArray(v) && v.length === 2 && v.every((x) => Number.isFinite(x) && x >= 50 && x <= 12000) && v[0] < v[1] ? v.map(Number) : undefined),
    filterMode: oneOf('oneKnob', 'dual'), centerLock: bool(), colorHidden: bool(),
    masterIsoBoost: oneOf(6, 12), showMasterIso: bool(), showWarmth: bool(), limiterCeiling: num(-3, -0.3), mono: bool(),
    boothRoute: oneOf('off', 'device', 'channels34', 'channels56'), boothDeviceId: str(512), micToBooth: bool(), showBooth: bool(),
    cuePost: bool(), hp2Route: oneOf('off', 'device', 'channels56', 'channels78'), hp2DeviceId: str(512),
    talkoverMode: oneOf('manual', 'auto', 'advanced'), talkoverThreshold: num(-80, 0), micFx: oneOf('echo', 'reverb', 'megaphone', 'pitch'),
    micToRecord: bool(), feedbackReducer: bool(),
    sendType: oneOf('shortDelay', 'longDelay', 'dubEcho', 'reverb'), returnTo: oneOf('master', 'ch1', 'ch2', 'ch3', 'ch4'),
    showComp: bool(),
    fx1: shape({ type: str(32), assign: oneOf('off', 'ch1', 'ch2', 'ch3', 'ch4', 'master', 'xfA', 'xfB'), quantize: bool() }),
    fx2: shape({ type: str(32), assign: oneOf('off', 'ch1', 'ch2', 'ch3', 'ch4', 'master', 'xfA', 'xfB'), quantize: bool() }),
  }),
  sequencer: objOrNull(),
  sampler: (v) => {
    if (v === null) return null;
    if (!v || typeof v !== 'object' || !Array.isArray(v.pads)) return undefined;
    return { pads: v.pads.slice(0, 8).map((p) => ({
      sound: typeof p?.sound === 'string' && /^[a-z0-9]{1,32}$/.test(p.sound) ? p.sound : null,
      volume: num(0, 1.5)(p?.volume) ?? 1,
      sync: p?.sync === true,
    })) };
  },
  link: shape({ enabled: bool(), quantum: num(1, 16), startStopSync: bool() }),
  lyrics: shape({ online: bool(), writeLrc: bool() }),
  stemsModelUrl: str(), stemsModelSha256: str(128), stemsBackend: oneOf('auto', 'wasm'), stemsEngine: oneOf('auto', 'browser'), stemsAutoPrepare: bool(), stemsOverlap: num(0, 0.75), stemsBackground: bool(), stemsCacheGB: num(1, 4000),
  mixLearning: (v) => (v && typeof v === 'object' && !Array.isArray(v) ? { n: num(0, 1e9)(v.n) ?? 0, bias: Object.fromEntries(Object.entries(v.bias && typeof v.bias === 'object' ? v.bias : {}).filter(([k]) => /^[a-z]{1,16}$/.test(k)).slice(0, 20).map(([k, x]) => [k, num(-5, 5)(x) ?? 0])) } : undefined),
  recording: objOrNull(), broadcast: objOrNull(), lighting: objOrNull(),
  transcodeCacheGB: num(0, 10000),
  uploadMaxMB: num(0.001, 1024 * 1024),
  allowedRoots: (v) => (v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string')) ? v : undefined),
  youtubeApiKey: str(512),
  updateCheck: bool(),
  vinyl: shape(VINYL_SHAPE),
  vinylDecks: (v) => (Array.isArray(v) ? v.slice(0, 4).map((d) => (d && typeof d === 'object' && !Array.isArray(d) ? shape(VINYL_SHAPE)(d) : null)) : undefined),
  deckOptions: shape({
    platterSkin: oneOf('minimal', 'vinyl', 'player'), haptics: oneOf('auto', 'off', 'subtle', 'full'), needleLock: oneOf('auto', 'on', 'off'),
    needleSnap: oneOf('off', 'beat', 'bar'), flickSpinback: bool(), bendMode: oneOf('ramp', 'fixed'), fineStep: oneOf(0.02, 0.05, 0.5),
    hardLock: bool(), scratchHand: oneOf('right', 'left'),
  }),
  updateSnooze: (v) => {
    if (v === null) return null;
    if (!v || typeof v !== 'object' || typeof v.version !== 'string' || !/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(v.version)) return undefined;
    return v.skip === true ? { version: v.version, skip: true } : Number.isFinite(Number(v.until)) ? { version: v.version, until: Number(v.until) } : undefined;
  },
};

/** Validate one setting. Keys without a schema are accepted unchanged. */
export function sanitizeSetting(key, value) {
  const f = SCHEMA[key];
  if (!f) return { ok: true, value };
  const v = f(value);
  return v === undefined ? { ok: false } : { ok: true, value: v };
}

/** Every key of `obj` that `defaults` knows, validated; invalid values fall back to the default. */
export function sanitizeSettings(obj, defaults) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (!Object.hasOwn(defaults, k)) continue;
    const r = sanitizeSetting(k, v);
    if (r.ok) out[k] = r.value;
    else console.warn(`[opendj] settings.json: invalid ${k} (${JSON.stringify(v)?.slice(0, 80)}), using the default`);
  }
  return out;
}
