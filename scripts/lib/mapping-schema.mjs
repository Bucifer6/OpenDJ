// Validation for community controller mappings (mappings/*.opendj-midi.json). Shared by the unit tests and by the
// GitHub Action that turns Controller Mapper submissions into pull requests (scripts/mapping-intake.mjs), which reads
// untrusted input: keep it strict and copy only known fields.

export const KEY_RE = /^(note|cc):(\d|1[0-5]):(\d|[1-9]\d|1[01]\d|12[0-7])$|^pitch:(\d|1[0-5]):0$/;
export const REL = ['twos', 'offset', 'wrap', 'auto'];
export const NAME_RE = /^[\p{L}\p{N} .&+'()/_-]{1,60}$/u;
export const MAX_ENTRIES = 2000;

/** Errors (strings) for a mapping object; [] when it is valid. `ids`: Set of OpenDJ target ids. */
export function mappingErrors(m, ids, { requireContributed = true } = {}) {
  const errs = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['not a JSON object'];
  if (m.opendjMidiMapping !== 1) errs.push('opendjMidiMapping must be 1');
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 120) errs.push('needs a name (up to 120 characters)');
  if (!Array.isArray(m.entries) || !m.entries.length) errs.push('needs a non-empty entries list');
  else if (m.entries.length > MAX_ENTRIES) errs.push(`too many entries (max ${MAX_ENTRIES})`);
  else m.entries.forEach((e, i) => {
    const at = `entry ${i + 1}`;
    if (!e || typeof e !== 'object') { errs.push(`${at}: not an object`); return; }
    if (typeof e.key !== 'string' || !KEY_RE.test(e.key)) errs.push(`${at}: bad key ${JSON.stringify(e.key)}`);
    if (e.lsbKey != null && (typeof e.lsbKey !== 'string' || !KEY_RE.test(e.lsbKey))) errs.push(`${at}: bad lsbKey ${JSON.stringify(e.lsbKey)}`);
    if (typeof e.target !== 'string' || !ids.has(e.target)) errs.push(`${at}: unknown function ${JSON.stringify(e.target)}`);
    if (e.rel != null && !REL.includes(e.rel)) errs.push(`${at}: bad rel ${JSON.stringify(e.rel)}`);
    for (const b of ['invert', 'noLed']) if (e[b] != null && typeof e[b] !== 'boolean') errs.push(`${at}: ${b} must be true or false`);
  });
  if (m.device != null && (typeof m.device !== 'string' || m.device.length > 120)) errs.push('device must be a string');
  if (requireContributed) {
    const c = m.contributed;
    if (!c || typeof c !== 'object') errs.push('needs a contributed block');
    else {
      if (c.license !== 'CC0-1.0') errs.push('contributed.license must be "CC0-1.0"');
      if (typeof c.brand !== 'string' || !NAME_RE.test(c.brand)) errs.push('contributed.brand is missing or has unusual characters');
      if (typeof c.model !== 'string' || !NAME_RE.test(c.model)) errs.push('contributed.model is missing or has unusual characters');
    }
  }
  return errs;
}

/** Only the known entry fields, in a fixed order. */
export function cleanEntries(entries) {
  return entries.map((e) => {
    const o = { key: e.key };
    if (e.lsbKey) o.lsbKey = e.lsbKey;
    o.target = e.target;
    if (e.invert === true) o.invert = true;
    if (e.rel) o.rel = e.rel;
    if (e.noLed === true) o.noLed = true;
    return o;
  });
}

const str = (v, n = 500) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
/** A clean `contributed` block (strings only, bounded). */
export function cleanContributed(c = {}) {
  const list = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => str(x, 80)).filter(Boolean))].slice(0, 50) : []);
  const out = { brand: str(c.brand, 60), model: str(c.model, 60), author: str(c.author, 80), testedOn: str(c.testedOn, 200),
    notes: str(c.notes, 2000), midiNames: list(c.midiNames), changedBy: list(c.changedBy), verifiedBy: list(c.verifiedBy), license: 'CC0-1.0' };
  for (const k of Object.keys(out)) if (out[k] === undefined || (Array.isArray(out[k]) && !out[k].length && k !== 'verifiedBy')) delete out[k];
  return out;
}

/** mappings/<Brand>/<Brand>-<Model>.opendj-midi.json, safe on every OS. */
export function mappingPath(brand, model) {
  const safe = (s) => (/[\p{L}\p{N}]/u.test(s) ? s : '').replace(/[^\p{L}\p{N} .&+()-]+/gu, '_').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 60) || 'Unknown';
  const fileSafe = (s) => safe(s).replace(/ /g, '_');
  return `${safe(brand)}/${fileSafe(brand)}-${fileSafe(model)}.opendj-midi.json`;
}

export const slug = (brand, model) => `${brand} ${model}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
