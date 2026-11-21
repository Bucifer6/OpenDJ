import { camelotCompatible, toCamelot } from '../audio/analysis-core.js';

const upper = (v) => (v.includes('.') ? +v : +v + 0.999);
function filterQuery(items, query, masterBpm, masterKey) {
  const tests = [];
  let q = query;
  q = q.replace(/bpm:(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?/g, (_, a, b) => {
    const lo = +a, hi = upper(b ?? a); tests.push((t) => t.bpm >= lo && t.bpm <= hi); return '';
  });
  q = q.replace(/bpm:near/g, () => {
    tests.push((t) => !masterBpm || (t.bpm > 0 && [1, 2, 0.5].some((f) => Math.abs(t.bpm * f / masterBpm - 1) < 0.06))); return '';
  });
  q = q.replace(/key:compat/g, () => {
    tests.push((t) => !masterKey || camelotCompatible(masterKey, t.keyCamelot)); return '';
  });
  q = q.replace(/key:(\S*)/g, (_, k) => {
    const key = toCamelot(k); tests.push(key ? (t) => t.keyCamelot === key : () => false); return '';
  });
  q = q.replace(/genre:(\S+)/g, (_, g) => { tests.push((t) => t.genre.toLowerCase().includes(g)); return ''; });
  q = q.replace(/tag:(\S+)/g, (_, g) => { tests.push((t) => t.tags.some((x) => x.includes(g))); return ''; });
  const words = q.split(/\s+/).filter(Boolean);
  return items.filter((t) => {
    if (!tests.every((f) => f(t))) return false;
    const hay = `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.key} ${t.keyCamelot} ${t.comment} ${t.tags.join(' ')} ${t.colorText}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
self.addEventListener('message', ({ data }) => {
  const { seq, items, query, sort, masterBpm, masterKey } = data;
  let list = filterQuery(items, query, masterBpm, masterKey);
  const { col, dir, kind } = sort;
  if (col === '#') { if (dir < 0) list = [...list].reverse(); }
  else if (col && kind !== 'duplicates') {
    const val = (t) => (col === 'key' ? (t.keyCamelot ? t.keyCamelot.padStart(3, '0') : '')
      : col === 'source' ? (t.sourceKind || 'local')
      : col === 'tags' ? t.tags.join(', ')
      : col === 'addedAt' && kind === 'session' ? t.playedAt : t[col]);
    list = [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null || x === '') return 1; if (y == null || y === '') return -1;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir;
    });
  }
  self.postMessage({ seq, indices: list.map((t) => t.i) });
});
