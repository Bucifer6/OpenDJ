// Mixer personalities (plan §5): named presets of the mixer settings, never a separate engine. Club is the default
// and is today's mixer. Switching glides channel levels to the new fader law (never an abrupt level change), EQ and
// filter type changes cross-fade, and everything can be changed afterwards ("Custom (based on Club)").
// The automix keeps writing logical controls (volume, eqLow, filter); the channel translates them for the active
// personality, and while the automix drives the faders it uses the club fader law.

export const PERSONALITIES = Object.freeze({
  club: {
    label: 'Club', blurb: "Today's mixer: isolator EQ, one-knob filter with Color FX, smooth crossfader",
    mixer: { eqType: 'isolator', eqXover: [200, 2500], classicKill: true, filterMode: 'oneKnob', centerLock: false, xfCurve: 0.5, xfCutIn: 0, xfCutTime: 5, xfReverse: false, faderCurve: 'log', rotary: false, hideXfader: false, colorHidden: false, revVisible: false, showBooth: false, showComp: false, showMasterIso: false, showWarmth: false },
    knobs: { warmth: 0 },
  },
  classic: {
    label: 'Classic', blurb: 'Shelving / peaking EQ with a full kill at the end, Center Lock on the filter, booth and channel compressor shown',
    mixer: { eqType: 'classic', eqXover: [200, 2500], classicKill: true, filterMode: 'oneKnob', centerLock: true, xfCurve: 0.5, xfCutIn: 0, xfCutTime: 5, xfReverse: false, faderCurve: 'log', rotary: false, hideXfader: false, colorHidden: false, revVisible: false, showBooth: true, showComp: true, showMasterIso: false, showWarmth: false },
    knobs: { warmth: 0 },
  },
  rotary: {
    label: 'Rotary', blurb: 'Rotary channel levels, wide-range rotary isolator EQ (300 Hz / 4 kHz), gentle HP / LP filters, master isolator and warmth',
    mixer: { eqType: 'rotaryIso', eqXover: [200, 2500], classicKill: true, filterMode: 'dual', centerLock: false, xfCurve: 0.5, xfCutIn: 0, xfCutTime: 5, xfReverse: false, faderCurve: 'smooth', rotary: true, hideXfader: true, colorHidden: true, revVisible: false, showBooth: false, showComp: false, showMasterIso: true, showWarmth: true },
    knobs: { warmth: 0.25 },
  },
  battle: {
    label: 'Battle', blurb: 'Fast-cut crossfader (1 ms, 2 % cut-in), cut upfaders, steep-kill EQ, hamster switch up front',
    mixer: { eqType: 'battle', eqXover: [200, 2500], classicKill: true, filterMode: 'oneKnob', centerLock: false, xfCurve: 1, xfCutIn: 0.02, xfCutTime: 1, xfReverse: false, faderCurve: 'cut', rotary: false, hideXfader: false, colorHidden: false, revVisible: true, showBooth: false, showComp: false, showMasterIso: false, showWarmth: false },
    knobs: { warmth: 0 },
  },
});
export const PERSONALITY_IDS = Object.keys(PERSONALITIES);

/** The personality a mixer config is based on, and whether it has been changed since ("Custom (based on Club)"). */
export function personalityState(mx) {
  const id = PERSONALITIES[mx?.personality] ? mx.personality : 'club', p = PERSONALITIES[id].mixer;
  const custom = Object.keys(p).some((k) => JSON.stringify(mx?.[k] ?? null) !== JSON.stringify(p[k]));
  return { id, custom, label: custom ? `Custom (based on ${PERSONALITIES[id].label})` : PERSONALITIES[id].label };
}

/**
 * Apply a personality to an engine. `save(mixer)` stores the new settings.mixer (the app persists it; it must set
 * engine.settings.mixer before returning). Blocked (returns false) while a crossfader cut is held mid-scratch.
 */
export function applyPersonality(engine, id, { save } = {}) {
  const p = PERSONALITIES[id];
  if (!p) return false;
  if (engine.xfTouched && engine.mx.xfCurve >= 0.9) return false;
  const next = { ...(engine.settings.mixer || {}), ...p.mixer, personality: id };
  if (save) save(next); else engine.settings.mixer = next;
  engine._holdFader = true;
  try { engine.applyMixerConfig(); } finally { engine._holdFader = false; }
  for (const ch of engine.channels) ch.glideFader(2.5);
  engine.setWarmth(p.knobs.warmth ?? 0);
  return true;
}

// ---------------------------------------------------------------- smart suggestion (never forced)
const STYLE = [
  { id: 'rotary', re: /\b(minimal|rominimal|romanian|micro ?house|deep ?tech|dub ?techno|lo-?fi house)\b/i, text: 'Long blends ahead. Try the Rotary mixer?' },
  { id: 'battle', re: /\b(hip ?-?hop|rap|turntablism|turntablist|scratch|boom ?bap|breaks|breakbeat|battle)\b/i, text: 'Battle mixer?' },
];
/**
 * Infer a mixer style from the tracks' genre / tags (on the device; nothing leaves it). Returns { id, confidence,
 * text } when at least 70 % of the tagged tracks (and at least 3) point to a personality other than `current`.
 */
export function suggestPersonality(tracks = [], current = 'club') {
  const tagged = tracks.filter((t) => t && (t.genre || t.tags?.length));
  if (tagged.length < 3) return null;
  for (const s of STYLE) {
    const n = tagged.filter((t) => s.re.test([t.genre || '', ...(t.tags || [])].join(' '))).length, confidence = n / tagged.length;
    if (confidence >= 0.7) return s.id === current ? null : { id: s.id, confidence, text: s.text };
  }
  return null;
}
