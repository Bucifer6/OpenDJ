// Community controller mappings (mappings/ in the OpenDJ repository): the controller list, recognising a plugged-in
// controller from its MIDI name, and downloading its mapping. Used by the app (MidiManager.offerMapping) and inlined
// into the Controller Mapper page by scripts/build-controller-mapper.mjs, so this file must not import anything.

export const COMMUNITY_REPO = 'Bucifer6/OpenDJ';
export const COMMUNITY_RAW = `https://raw.githubusercontent.com/${COMMUNITY_REPO}/main/mappings/`;

/** Short content hash of a mapping's entries (FNV-1a), the "version" used to spot updated community mappings. */
export function hashEntries(entries) {
  const str = JSON.stringify(entries || []);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export const normName = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const controllerName = (c) => `${c.brand} ${c.model}`;

/**
 * The list entry for a MIDI port name: the entry whose `midiNames` has the longest match inside the port name
 * ("DDJ-FLX4" matches "DDJ-FLX4 MIDI 1"). Returns null when nothing matches.
 */
export function matchController(controllers, portName) {
  const dn = normName(portName);
  if (!dn) return null;
  let best = null, bestLen = 0;
  for (const c of controllers || []) {
    for (const m of c.midiNames || []) {
      const n = normName(m);
      if (n.length >= 3 && dn.includes(n) && n.length > bestLen) { best = c; bestLen = n.length; }
    }
  }
  return best;
}

/** Brand guesses from words in MIDI port names, to prefill "which controller is this?" for unknown devices. */
export const BRAND_HINTS = [
  [/\b(ddj|xdj|djm|cdj)\b|ddj-|pioneer/i, 'Pioneer DJ'], [/mixtrack|party ?mix|numark|\bns\d|dj2go|\bidj/i, 'Numark'],
  [/djcontrol|inpulse|hercules|\bdjc\b/i, 'Hercules'], [/\bmc\d{3,4}|denon|\bprime\b|\bsc\d{4}/i, 'Denon DJ'],
  [/traktor|kontrol/i, 'Native Instruments'], [/mixon|reloop|beatmix|beatpad|\bbuddy\b|terminal mix/i, 'Reloop'],
  [/roland|\bdj-\d{3}/i, 'Roland'], [/behringer|\bcmd\b/i, 'Behringer'], [/novation|launch(pad|control|key)|twitch/i, 'Novation'],
  [/akai|\bapc|\bmpk|\bamx\b|\bafx\b/i, 'Akai Professional'], [/xone|allen/i, 'Allen & Heath'], [/\brane\b|\bseventy/i, 'Rane'],
  [/gemini/i, 'Gemini'], [/\bvestax|\bvci/i, 'Vestax'], [/korg|kaoss/i, 'Korg'], [/\bstanton|\bscs\b/i, 'Stanton'],
];
export function guessController(portName) {
  const brand = BRAND_HINTS.find(([re]) => re.test(portName))?.[1] || '';
  let model = String(portName || '').replace(/\b(midi|usb|audio|in|out|input|output|port|controller)\b/gi, ' ').replace(/\d+:\d+/g, ' ')
    .replace(/(\s+\d+)+\s*$/, '').replace(/\s+/g, ' ').trim();
  for (const w of brand.split(' ')) if (w) model = model.replace(new RegExp(`^${w.replace(/[^\w]/g, '\\$&')}\\b\\s*`, 'i'), '');
  return { brand, model: model.trim() };
}

async function getJson(url, fetchImpl, timeout) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), timeout) : 0;
  try {
    const r = await fetchImpl(url, { cache: 'no-store', ...(ctl ? { signal: ctl.signal } : {}) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** The controller list ({ opendjControllerIndex: 1, controllers: [...] }) from GitHub. Throws when unreachable. */
export async function fetchControllerIndex(fetchImpl = fetch, timeout = 8000) {
  const j = await getJson(COMMUNITY_RAW + 'index.json', fetchImpl, timeout);
  if (j?.opendjControllerIndex !== 1 || !Array.isArray(j.controllers)) throw new Error('not a controller list');
  return j;
}

/** One community mapping file (path relative to mappings/, as in the list's `file`). */
export async function fetchCommunityMapping(file, fetchImpl = fetch, timeout = 15000) {
  const m = await getJson(COMMUNITY_RAW + String(file).split('/').map(encodeURIComponent).join('/'), fetchImpl, timeout);
  if (!Array.isArray(m?.entries)) throw new Error('not a mapping');
  return m;
}
