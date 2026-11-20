// Tiny, dependency-free XML parser (enough for Mixxx controller mapping files). Works in browsers and Node.
// Returns a tree of { name, attrs, children, text } nodes. Comments, processing instructions and DOCTYPEs are skipped.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});

export function parseXml(src) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) { top.text += decode(src.slice(i)); break; }
    if (lt > i) top.text += decode(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); top.text += src.slice(lt + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (src.startsWith('<!', lt)) { const e = src.indexOf('>', lt + 2); i = e < 0 ? n : e + 1; continue; }
    // find tag end, respecting quoted attribute values
    let j = lt + 1, q = null;
    for (; j < n; j++) { const c = src[j]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
    const raw = src.slice(lt + 1, j);
    i = j + 1;
    if (raw[0] === '/') { // closing tag: pop to the matching element (tolerates sloppy nesting)
      const name = raw.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      continue;
    }
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) continue;
    const node = { name: m[1], attrs: {}, children: [], text: '' };
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = re.exec(body.slice(m[1].length)))) node.attrs[a[1]] = decode(a[3] ?? a[4] ?? '');
    top.children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

/** Helpers for walking the tree (case-insensitive tag names). */
export const kids = (node, name) => (node?.children || []).filter((c) => !name || c.name.toLowerCase() === name.toLowerCase());
export const kid = (node, name) => kids(node, name)[0] || null;
export const textOf = (node, name) => { const k = name ? kid(node, name) : node; return k ? k.text.trim() : null; };
export function find(node, name) {
  if (!node) return null;
  for (const c of node.children) { if (c.name.toLowerCase() === name.toLowerCase()) return c; const r = find(c, name); if (r) return r; }
  return null;
}
