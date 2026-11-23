// Genre families and how pros mix them (docs/PRO_DJ_AUTOMIX_RESEARCH.md P2.1, docs/automix-research/01-transitions.md
// §1.2, §4.3, §6). A family sets the technique preferences, blend lengths, effect budget and echo timing the planner
// uses for a pair of tracks. Pure data + lookups: no audio, no DOM.

/** Family table. prior: added to the planner's per-style prior; maxBars / bestBars: blend lengths (long overlaps like
 * a club DJ: house / techno / trance 32 bars, up to 64; open format stays quick, 4 to 8); fxBudget: largest
 * share of effect transitions (echo, reverb, spins, brakes, loops) in recent transitions; echoBeats: echo-out delay. */
export const FAMILIES = {
  house: { label: 'house', maxBars: 64, bestBars: [32], fxBudget: 0.2, echoBeats: 0.75,
    prior: { blend: 1, bassswap: 0.5, stemswap: 0.5, echo: -0.5, cut: -2, backspin: -3, brake: -3, loop: -0.5 } },
  techno: { label: 'techno', maxBars: 64, bestBars: [32, 64], fxBudget: 0.15, echoBeats: 0.5,
    prior: { blend: 1.5, filter: 0.5, crossfade: -1, echo: -1, reverb: -0.5, cut: -3, backspin: -4, brake: -4 } },
  trance: { label: 'trance / progressive', maxBars: 64, bestBars: [32], fxBudget: 0.25, echoBeats: 0.75,
    prior: { blend: 0.5, reverb: 1.5, filter: 0.5, cut: -2, backspin: -3, brake: -3 } },
  bass: { label: 'drum & bass / dubstep', maxBars: 32, bestBars: [16], fxBudget: 0.3, echoBeats: 0.5,
    prior: { bassswap: 1.5, cut: 1, blend: -0.5, echo: 0.5, backspin: 0, crossfade: -1.5 } },
  open: { label: 'open format', maxBars: 8, bestBars: [4, 8], fxBudget: 0.4, echoBeats: 1,
    prior: { cut: 3, echo: 1.5, bassswap: 1, backspin: 0.5, brake: 0, blend: -2, crossfade: -1, filter: -0.5 } },
  disco: { label: 'disco / funk', maxBars: 32, bestBars: [16], fxBudget: 0.2, echoBeats: 1,
    prior: { crossfade: 1, filter: 0.5, cut: -1, backspin: -2, brake: -2 } },
  lounge: { label: 'lounge / downtempo', maxBars: 32, bestBars: [32], fxBudget: 0.1, echoBeats: 1,
    prior: { crossfade: 2, filter: 1, reverb: 0.5, cut: -3, backspin: -5, brake: -5, loop: -2 } },
};

/** Effect transitions (counted against the family's effect budget). */
export const EFFECT_STYLES = new Set(['echo', 'reverb', 'backspin', 'brake', 'loop', 'pingpong']);

const WORDS = [
  ['bass', /\b(drum ?(and|&|n) ?bass|dnb|d&b|jungle|liquid|neuro(funk)?|dubstep|riddim|brostep|bass ?music|halftime|footwork|juke|breakbeat|breaks|uk ?garage|garage|grime)\b/],
  ['techno', /\b(techno|minimal|rominimal|acid|industrial|hard ?techno|schranz|hypnotic)\b/],
  ['trance', /\b(trance|progressive|psy|psytrance|goa|uplifting|melodic ?techno)\b/],
  ['open', /\b(hip ?hop|rap|trap|r ?& ?b|rnb|pop|reggaeton|latin|urbano|dembow|moombahton|dancehall|afrobeats?|amapiano|kpop|k-pop|soca|baile|funk carioca|manele|top ?40|dance ?pop|edm|big ?room|electro ?pop|rock|indie|country|schlager)\b/],
  ['disco', /\b(disco|nu ?disco|funk|soul|boogie|motown|italo|80s|70s)\b/],
  ['lounge', /\b(lounge|chill ?out|chill|ambient|downtempo|lo ?fi|lofi|jazz|bossa|acoustic|ballad|classical|easy listening|trip ?hop)\b/],
  ['house', /\b(house|tech ?house|deep ?house|afro ?house|garage house|disco house|electro ?house|bass ?house|organic|tribal|soulful)\b/],
];

/** Family of one track from its genre / tags, else a guess from its tempo; null when nothing is known. */
export function styleFamily(t) {
  if (!t) return null;
  const text = [t.genre, ...(Array.isArray(t.tags) ? t.tags : [])].filter(Boolean).join(' ').toLowerCase().replace(/[-_/]+/g, ' ');
  if (text) for (const [fam, re] of WORDS) if (re.test(text)) return fam;
  const bpm = Number(t.bpm) || 0;
  if (!bpm) return null;
  if (bpm >= 160 && bpm <= 185) return 'bass';
  if (bpm >= 135 && bpm < 150) return 'techno';
  if (bpm >= 115 && bpm < 135) return 'house';
  if (bpm < 105 && bpm >= 70) return 'open';
  return null;
}

/**
 * Family that governs a transition: the shared family, else the "looser" one (open format beats club, since a cut
 * or short blend is the safe way between two worlds), else whichever is known.
 */
export function pairFamily(a, b) {
  const fa = styleFamily(a), fb = styleFamily(b);
  if (fa && fa === fb) return fa;
  if (fa === 'open' || fb === 'open') return 'open';
  if (fa === 'lounge' || fb === 'lounge') return 'lounge';
  return fb || fa || null;
}

/** Share of effect transitions among recent styles (0..1). */
export function effectShare(recent = []) {
  const r = recent.filter(Boolean);
  return r.length ? r.filter((s) => EFFECT_STYLES.has(s)).length / r.length : 0;
}

/** Transitions the effect budget is counted over. */
export const BUDGET_WINDOW = 6;
/** Would one more effect transition exceed the budget (share of the last BUDGET_WINDOW transitions, at least one)? */
export function effectsOverBudget(recent = [], budget = 0.3) {
  const r = (recent || []).filter(Boolean).slice(-(BUDGET_WINDOW - 1));
  const used = r.filter((s) => EFFECT_STYLES.has(s)).length;
  return used + 1 > Math.max(1, Math.round(budget * BUDGET_WINDOW));
}

/** Echo-out delay (beats) for a pair; slow tracks (< 100 BPM) of the open family use a full beat. */
export function echoBeatsFor(out, inn) {
  const fam = FAMILIES[pairFamily(out, inn)];
  return fam ? fam.echoBeats : 1;
}
