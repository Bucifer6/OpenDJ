// Interface translations. No dependencies, works in every page (app, login, video output, controller mapper frame).
//
// Keys are the English source text, so code stays readable and a missing translation simply shows the English:
//   t('Load to deck')                         -> 'Încarcă pe deck'
//   t('Deck {n} is playing', { n: 2 })        -> named parameters
// Dictionaries: public/js/locales/<lang>.js (`export default { 'English': 'Translation', … }`). A key with
// placeholders ({0}, {1}… or {name}) is a pattern: it also translates text that was built with a template literal,
// e.g. 'Imported {0} tracks' matches "Imported 12 tracks"; the captured parts are translated too when they are
// themselves keys.
//
// Most of the UI is built with el(…, 'English text') and never calls t(): translateDom() watches the document and
// replaces text nodes and title / placeholder / aria-label / alt attributes whose text is a key. Elements inside
// [translate="no"] (track titles, file names, user text) are left alone. Code that compares textContent with what
// it is about to write (to avoid DOM churn every frame) should write t(text), so the comparison still holds.
//
// The language is the `language` setting ('auto' | 'en' | 'ro'); 'auto' follows the browser (navigator.languages).
// It is mirrored in localStorage so pages that load before the settings (login, boot screen) use it too.

export const LANGUAGES = [['auto', 'Auto (browser language)'], ['en', 'English'], ['ro', 'Română']];
const SUPPORTED = ['en', 'ro'];
const STORE = 'opendj.language';
const LOADERS = { ro: () => import('./locales/ro.js') };

let lang = 'en';
let exact = new Map();     // English -> translation
let normal = new Map();    // whitespace-collapsed English -> translation (fallback)
let byWord = new Map();    // first word of a pattern -> [pattern]
let wild = [];             // patterns that start with a placeholder
let cache = new Map();     // memo of translateText (misses too): the DOM translator sees the same strings every frame

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const escRe = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
const PH = /\{(\w+)\}/g;

/** 'auto' (or anything unknown) -> the first supported browser language, else English. */
export function resolveLanguage(pref) {
  if (SUPPORTED.includes(pref)) return pref;
  const nav = (typeof navigator !== 'undefined' && (navigator.languages?.length ? navigator.languages : [navigator.language])) || [];
  for (const l of nav) { const base = String(l || '').toLowerCase().split('-')[0]; if (SUPPORTED.includes(base)) return base; }
  return 'en';
}

/** The stored preference ('auto' | 'en' | 'ro'), for pages that run before the settings are loaded. */
export function storedLanguage() { try { return localStorage.getItem(STORE) || 'auto'; } catch { return 'auto'; } }

/** Store the preference for the next page load without changing the language now. */
export function rememberLanguage(pref) { try { localStorage.setItem(STORE, pref || 'auto'); } catch {} }

export const currentLanguage = () => lang;

/** Install a dictionary (tests and pages without dynamic import can call this directly). */
export function setDictionary(code, dict) {
  lang = code; exact = new Map(); normal = new Map(); byWord = new Map(); wild = []; cache = new Map();
  for (const [k, v] of Object.entries(dict || {})) {
    if (typeof v !== 'string' || !v) continue;
    exact.set(k, v); normal.set(norm(k), v);
    if (!/\{\w+\}/.test(k)) continue;
    const names = [];
    const parts = norm(k).split(PH); // literal, name, literal, name, …
    let re = '^';
    // a placeholder right after a letter is an English plural suffix ("file{1}" -> "" | "s"): it may be empty
    parts.forEach((p, i) => {
      if (!(i % 2)) { re += escRe(p); return; }
      names.push(p);
      const q = /[A-Za-z]$/.test(parts[i - 1]) ? '*' : '+';
      re += i === parts.length - 2 ? `([\\s\\S]${q})` : `([\\s\\S]${q}?)`;
    });
    const literal = parts.filter((_, i) => !(i % 2)).join('');
    if (!/[A-Za-z]{2}/.test(literal)) continue; // "{0} {1}" would match anything
    const pat = { re: new RegExp(`${re}$`), names, to: v, longest: parts.filter((_, i) => !(i % 2)).sort((a, b) => b.length - a.length)[0] };
    const first = /^(\S+)\s/.exec(parts[0])?.[1]; // a whole first word (not glued to a placeholder: '({0} files')
    pat.weight = literal.length;
    if (first) { if (!byWord.has(first)) byWord.set(first, []); byWord.get(first).push(pat); } else wild.push(pat);
  }
  // most specific first: 'Deck {0} is playing: pause it first' before the generic 'Deck {0} {1}'
  for (const list of [...byWord.values(), wild]) list.sort((a, b) => b.weight - a.weight);
  if (typeof document !== 'undefined') document.documentElement.lang = code;
}

/**
 * Load the dictionary for `pref` and start translating the document. Returns the language in use.
 * Never throws: a missing / broken dictionary leaves the interface in English.
 */
export async function initI18n(pref = storedLanguage(), { dom = true } = {}) {
  rememberLanguage(pref);
  const code = resolveLanguage(pref);
  if (code === 'en' || !LOADERS[code]) { setDictionary('en', {}); return 'en'; }
  try { setDictionary(code, (await LOADERS[code]()).default); } catch (e) { console.warn('[i18n] could not load', code, e); setDictionary('en', {}); return 'en'; }
  if (dom && typeof document !== 'undefined') { translateDom(document); setCssTexts(); }
  return code;
}

/** Texts drawn by CSS (`content: var(--txt-…, 'English')`): set as custom properties on <html>. */
const CSS_TEXTS = {
  '--txt-drop-hint': 'Drag a track here from the library — or select one and press Shift + ← / →',
  '--txt-keep': 'KEEP',
  '--txt-no-rules': 'No rules: matches the whole collection.',
};
function setCssTexts() {
  for (const [k, v] of Object.entries(CSS_TEXTS)) document.documentElement.style.setProperty(k, JSON.stringify(t(v)));
}

function fill(s, params) {
  if (params == null) return s;
  return s.replace(PH, (m, k) => (Object.hasOwn(Object(params), k) ? String(params[k]) : m));
}

/** Translation of a whole string, or null when the dictionary has none (exact, collapsed-whitespace, pattern). */
function lookup(s, depth = 0) {
  let r = exact.get(s) ?? normal.get(norm(s));
  if (r != null) return r;
  if (depth > 3 || !/[A-Za-z]{2}/.test(s)) return null;
  const n = norm(s);
  const sp = n.indexOf(' ');
  const cands = byWord.get(sp < 0 ? n : n.slice(0, sp));
  for (const list of cands ? [cands, wild] : [wild]) {
    for (const p of list) {
      if (p.longest && !n.includes(p.longest)) continue;
      const m = p.re.exec(n);
      if (!m) continue;
      const vals = {};
      p.names.forEach((name, i) => { // captured parts keep their surrounding spaces: ' (3 files not found)'
        const v = m[i + 1], c = v.trim(), r = /[A-Za-z]{2}/.test(c) ? lookup(c, depth + 1) : null;
        vals[name] = r == null ? v : v.replace(c, r);
      });
      return fill(p.to, vals);
    }
  }
  return null;
}

/** Translate text that may carry surrounding whitespace (DOM text nodes: ' Quantize'). null = not translatable. */
export function translateText(s) {
  if (lang === 'en' || typeof s !== 'string' || s.length > 600 || !/[A-Za-z]{2}/.test(s)) return null;
  if (cache.has(s)) return cache.get(s);
  const core = s.trim();
  let out = null;
  const r = core ? lookup(core) : null;
  if (r != null && r !== core) { const lead = s.slice(0, s.indexOf(core)), trail = s.slice(s.indexOf(core) + core.length); out = lead + r + trail; }
  if (cache.size > 20000) cache.clear();
  cache.set(s, out);
  return out;
}

/**
 * Translate an English UI string. `params` fills {name} placeholders (after translation, so the dictionary key
 * keeps the placeholders: t('Deck {n} is locked', { n: 2 })).
 */
export function t(text, params) {
  const s = String(text ?? '');
  if (lang === 'en') return fill(s, params);
  const r = exact.get(s) ?? normal.get(norm(s)) ?? (params == null ? lookup(s) : null);
  return fill(r ?? s, params);
}

// ---------------------------------------------------------------- DOM translation ----
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-tip', 'label'];
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'KBD', 'svg', 'SVG', 'CANVAS', 'NOSCRIPT']);
const written = new WeakMap(); // node -> the text we wrote (so our own mutation is not processed again)
const observers = new WeakMap();

function skipped(elm) {
  for (let e = elm; e && e.nodeType === 1; e = e.parentNode) {
    if (SKIP_TAGS.has(e.tagName) || e.isContentEditable) return true;
    if (e.getAttribute('translate') === 'no' || e.hasAttribute('data-i18n-skip')) return true;
  }
  return false;
}

function doText(node) {
  // nodeValue of a Text node: plain text, never parsed as HTML
  const v = node.nodeValue;
  if (written.get(node) === v) return;
  const r = translateText(v);
  if (r != null && r !== v && !skipped(node.parentNode)) { written.set(node, r); node.nodeValue = r; }
}

function doAttrs(elm) {
  for (const a of ATTRS) {
    const v = elm.getAttribute(a);
    if (!v) continue;
    const r = translateText(v);
    if (r != null && r !== v) elm.setAttribute(a, r);
  }
  if (elm.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(elm.type) && elm.value) {
    const r = translateText(elm.value);
    if (r != null) elm.value = r;
  }
}

/** Translate `root` and everything below it once. */
export function translateTree(root) {
  if (lang === 'en' || !root) return;
  if (root.nodeType === 3) { doText(root); return; }
  const start = root.nodeType === 9 ? root.documentElement : root;
  if (!start || (start.nodeType === 1 && skipped(start))) return;
  if (root.nodeType === 9 && root.title) { const r = translateText(root.title); if (r) root.title = r; }
  const doc = start.ownerDocument || root;
  const w = doc.createTreeWalker(start, 5 /* SHOW_ELEMENT | SHOW_TEXT */, {
    acceptNode: (n) => (n.nodeType === 1 && (SKIP_TAGS.has(n.tagName) || n.getAttribute('translate') === 'no' || n.hasAttribute('data-i18n-skip') || n.isContentEditable) ? 2 /* REJECT */ : 1),
  });
  for (let n = start; n; n = w.nextNode()) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
}

/** Translate a document (or an element) now and keep translating what is added or changed later. */
export function translateDom(root = document) {
  if (lang === 'en' || !root) return;
  translateTree(root);
  const target = root.nodeType === 9 ? root.documentElement : root;
  if (!target || observers.has(target)) return;
  const MO = (root.defaultView || root.ownerDocument?.defaultView || globalThis).MutationObserver;
  const mo = new MO((list) => {
    for (const m of list) {
      if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') { if (m.target.nodeType === 1 && !skipped(m.target)) doAttrs(m.target); }
      else for (const n of m.addedNodes) if (n.isConnected) translateTree(n);
    }
  });
  mo.observe(target, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS, 'value'] });
  observers.set(target, mo);
}

/** A same-origin frame (Controller Mapper): translate its document now and after every (re)load. */
export function translateFrame(frame) {
  if (lang === 'en' || !frame) return;
  const go = () => { try { if (frame.contentDocument) translateDom(frame.contentDocument); } catch {} };
  frame.addEventListener('load', go);
  go();
}
