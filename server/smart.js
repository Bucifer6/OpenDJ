// Smart playlists (rekordbox "Intelligent Playlists" / Serato "Smart Crates"): saved rule sets evaluated on the server.
// A smart playlist is a normal playlist with `smart: { match: 'all'|'any', rules: [{ field, op, value, value2? }], limit? }`.

export const NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

/** Camelot code for tag-style keys ("Am", "A minor", "8A", "F#m", "Gbmaj"). Mirrors public/js/audio/analysis-core.js. */
export function toCamelot(k) {
  if (!k) return null;
  const s = String(k).trim();
  if (/^(1[0-2]|[1-9])[AB]$/i.test(s)) return s.toUpperCase();
  const m = /^([A-G])\s*([#b♯♭]?)\s*(m|min|minor|maj|major)?/i.exec(s);
  if (!m) return null;
  const enh = { 'C#': 'Db', 'D#': 'Eb', 'G#': 'Ab', 'A#': 'Bb', Gb: 'F#', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' };
  let name = m[1].toUpperCase() + (m[2] || '').replace('♯', '#').replace('♭', 'b');
  name = enh[name] || name;
  const idx = NOTE_NAMES.indexOf(name);
  if (idx < 0) return null;
  const minor = m[3] && /^m(in(or)?)?$/i.test(m[3]) && m[3] !== 'M';
  return minor ? CAMELOT_MINOR[idx] : CAMELOT_MAJOR[idx];
}

/** Same key, ±1 on the wheel, or relative major/minor. */
export function camelotCompatible(a, b) {
  const pa = /^(\d+)([AB])$/.exec(a || ''), pb = /^(\d+)([AB])$/.exec(b || '');
  if (!pa || !pb) return false;
  const na = +pa[1], nb = +pb[1];
  const d = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
  if (pa[2] === pb[2]) return d <= 1;
  return d === 0;
}

// rekordbox's 8 track colour labels (stored on tracks as the hex value).
export const TRACK_COLORS = [
  { id: 'pink', label: 'Pink', hex: '#ff007f', rb: '0xFF007F' },
  { id: 'red', label: 'Red', hex: '#ff0000', rb: '0xFF0000' },
  { id: 'orange', label: 'Orange', hex: '#ffa500', rb: '0xFFA500' },
  { id: 'yellow', label: 'Yellow', hex: '#ffff00', rb: '0xFFFF00' },
  { id: 'green', label: 'Green', hex: '#00ff00', rb: '0x00FF00' },
  { id: 'aqua', label: 'Aqua', hex: '#25fde9', rb: '0x25FDE9' },
  { id: 'blue', label: 'Blue', hex: '#0000ff', rb: '0x0000FF' },
  { id: 'purple', label: 'Purple', hex: '#660099', rb: '0x660099' },
];

const TEXT_OPS = ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'empty', 'not_empty'];
const NUM_OPS = ['is', 'is_not', 'gt', 'lt', 'between'];
const DATE_OPS = ['in_last', 'not_in_last'];

export const SMART_FIELDS = [
  { id: 'bpm', label: 'BPM', type: 'number', ops: NUM_OPS },
  { id: 'key', label: 'Key', type: 'key', ops: ['is', 'is_not', 'compatible'] },
  { id: 'genre', label: 'Genre', type: 'text', ops: TEXT_OPS },
  { id: 'artist', label: 'Artist', type: 'text', ops: TEXT_OPS },
  { id: 'title', label: 'Title', type: 'text', ops: TEXT_OPS },
  { id: 'album', label: 'Album', type: 'text', ops: TEXT_OPS },
  { id: 'comment', label: 'Comment', type: 'text', ops: TEXT_OPS },
  { id: 'rating', label: 'Rating', type: 'number', ops: NUM_OPS },
  { id: 'color', label: 'Colour', type: 'color', ops: ['is', 'is_not', 'empty', 'not_empty'] },
  { id: 'tags', label: 'My Tags', type: 'tags', ops: ['contains', 'not_contains', 'empty', 'not_empty'] },
  { id: 'energy', label: 'Energy', type: 'number', ops: NUM_OPS },
  { id: 'year', label: 'Year', type: 'number', ops: NUM_OPS },
  { id: 'addedAt', label: 'Date added', type: 'date', ops: DATE_OPS },
  { id: 'lastPlayed', label: 'Last played', type: 'date', ops: [...DATE_OPS, 'never'] },
  { id: 'playCount', label: 'Play count', type: 'number', ops: NUM_OPS },
  { id: 'source', label: 'Source', type: 'source', ops: ['is', 'is_not'] },
  { id: 'duration', label: 'Length (min)', type: 'number', unit: 60, ops: NUM_OPS },
];
export const SMART_OPS = {
  contains: 'contains', not_contains: 'does not contain', is: 'is', is_not: 'is not', starts_with: 'starts with',
  empty: 'is empty', not_empty: 'is not empty', gt: 'is greater than', lt: 'is less than', between: 'is between',
  in_last: 'in the last (days)', not_in_last: 'not in the last (days)', never: 'never', compatible: 'is compatible with',
};
export const SOURCE_VALUES = [['local', 'Local file'], ['remote', 'Streaming (media server)'], ['downloaded', 'Downloaded']];

const FIELD = new Map(SMART_FIELDS.map((f) => [f.id, f]));
const lc = (v) => String(v ?? '').toLowerCase().trim();
const sourceOf = (t) => (t.sourceType === 'remote' ? (t.localPath ? 'downloaded' : 'remote') : 'local');

function compileRule(r, now) {
  const f = FIELD.get(r.field);
  if (!f) return () => true; // unknown field: ignore rule
  const op = r.op;
  if (f.type === 'text') {
    const v = lc(r.value);
    const get = (t) => lc(t[r.field]);
    switch (op) {
      case 'contains': return (t) => get(t).includes(v);
      case 'not_contains': return (t) => !get(t).includes(v);
      case 'is': return (t) => get(t) === v;
      case 'is_not': return (t) => get(t) !== v;
      case 'starts_with': return (t) => get(t).startsWith(v);
      case 'empty': return (t) => !get(t);
      case 'not_empty': return (t) => !!get(t);
      default: return () => true;
    }
  }
  if (f.type === 'number') {
    const unit = f.unit || 1;
    const a = Number(r.value) * unit, b = Number(r.value2) * unit;
    const get = (t) => { const x = Number(t[r.field]); return Number.isFinite(x) ? x : (r.field === 'rating' || r.field === 'playCount' ? 0 : NaN); };
    // "is" on BPM / length compares rounded values (a 127.96 BPM track "is" 128).
    const eq = (x) => (f.id === 'bpm' || f.unit ? Math.abs(x - a) < 0.5 * unit : x === a);
    switch (op) {
      case 'is': return (t) => eq(get(t));
      case 'is_not': return (t) => !eq(get(t));
      case 'gt': return (t) => get(t) > a;
      case 'lt': return (t) => get(t) < a;
      case 'between': { const lo = Math.min(a, b), hi = Math.max(a, b); return (t) => { const x = get(t); return x >= lo && x <= hi; }; }
      default: return () => true;
    }
  }
  if (f.type === 'key') {
    const want = String(r.value || '').split(/[,\s]+/).map(toCamelot).filter(Boolean);
    const cam = (t) => toCamelot(t.key);
    switch (op) {
      case 'is': return (t) => want.includes(cam(t));
      case 'is_not': return (t) => !want.includes(cam(t));
      case 'compatible': return (t) => { const c = cam(t); return !!c && want.some((w) => camelotCompatible(w, c)); };
      default: return () => true;
    }
  }
  if (f.type === 'color') {
    const v = lc(r.value);
    const get = (t) => lc(t.color);
    switch (op) {
      case 'is': return (t) => get(t) === v;
      case 'is_not': return (t) => get(t) !== v;
      case 'empty': return (t) => !get(t);
      case 'not_empty': return (t) => !!get(t);
      default: return () => true;
    }
  }
  if (f.type === 'tags') {
    const want = String(r.value || '').split(',').map(lc).filter(Boolean);
    const has = (t) => { const tags = (t.tags || []).map(lc); return want.every((w) => tags.includes(w)); };
    switch (op) {
      case 'contains': return has;
      case 'not_contains': return (t) => !(t.tags || []).map(lc).some((x) => want.includes(x));
      case 'empty': return (t) => !(t.tags || []).length;
      case 'not_empty': return (t) => !!(t.tags || []).length;
      default: return () => true;
    }
  }
  if (f.type === 'date') {
    const since = now - Number(r.value || 0) * 864e5;
    const get = (t) => Number(t[r.field]) || 0;
    switch (op) {
      case 'in_last': return (t) => get(t) >= since;
      case 'not_in_last': return (t) => get(t) < since;
      case 'never': return (t) => !get(t);
      default: return () => true;
    }
  }
  if (f.type === 'source') {
    const v = lc(r.value);
    return op === 'is_not' ? (t) => sourceOf(t) !== v : (t) => sourceOf(t) === v;
  }
  return () => true;
}

/** Compile a smart definition into a predicate. */
export function compileSmart(smart, { now = Date.now() } = {}) {
  const rules = (smart?.rules || []).filter((r) => r && r.field).map((r) => compileRule(r, now));
  if (!rules.length) return () => true;
  return smart.match === 'any' ? (t) => rules.some((f) => f(t)) : (t) => rules.every((f) => f(t));
}

/** Track ids matching a smart playlist, in "date added, newest first" order, honouring `limit`. */
export function evaluateSmart(smart, tracks, opts) {
  const pred = compileSmart(smart, opts);
  let out = tracks.filter(pred);
  out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  const limit = Number(smart?.limit) || 0;
  if (limit > 0) out = out.slice(0, limit);
  return out.map((t) => t.id);
}

/** Validate / normalise a smart definition coming from the API. */
export function normSmart(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    match: s.match === 'any' ? 'any' : 'all',
    rules: (Array.isArray(s.rules) ? s.rules : []).filter((r) => r && FIELD.has(r.field)).slice(0, 50)
      .map((r) => ({ field: r.field, op: String(r.op || ''), value: r.value ?? '', ...(r.value2 != null && r.value2 !== '' ? { value2: r.value2 } : {}) })),
    ...(Number(s.limit) > 0 ? { limit: Math.floor(Number(s.limit)) } : {}),
  };
}
