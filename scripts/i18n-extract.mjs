#!/usr/bin/env node
// Lists the user-visible English strings of the web UI that public/js/locales/<lang>.js does not translate yet.
//
//   node scripts/i18n-extract.mjs [lang] [--all] [--json]
//
// The UI is translated by public/js/i18n.js: t('English text') in code, and a DOM translator that replaces text
// nodes / title / placeholder / aria-label whose English text is a key of the dictionary. Keys are the English
// source text; template literals become patterns with {0}, {1}… for their ${…} parts.
// This scanner is a heuristic (string literals that look like prose), so it lists some strings that are never
// shown (log messages, ids): only add the ones that appear in the interface.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const lang = args.find((a) => !a.startsWith('--')) || 'ro';
const SKIP_DIRS = new Set(['vendor', 'locales', 'samples', 'skins', 'fonts', 'mappings']);
const SKIP_FILES = /sample-catalog\.js$|worklets\.js$|-dsp\.js$|i18n\.js$/;

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (!SKIP_DIRS.has(n)) walk(p, out); }
    else if (/\.(m?js|html)$/.test(n) && !SKIP_FILES.test(p)) out.push(p);
  }
  return out;
}

/** String and template literals of a JS source, with the text before them (to guess what they are for). */
export function scanJs(src) {
  const out = [];
  let i = 0, prev = ''; // prev: last significant char/word, to tell a regex literal from a division
  const regexOk = () => !prev || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /^(return|typeof|case|in|of|delete|void|throw|new|else|do)$/.test(prev);
  const readString = (q) => {
    let s = '', j = i + 1;
    for (; j < src.length && src[j] !== q; j++) {
      if (src[j] === '\\') { j++; const c = src[j]; s += c === 'n' ? '\n' : c === 't' ? '\t' : c === 'u' ? (src[j + 1] === '{' ? '' : String.fromCharCode(parseInt(src.slice(j + 1, j + 5), 16))) : c; if (c === 'u' && src[j + 1] !== '{') j += 4; }
      else if (src[j] === '\n') break;
      else s += src[j];
    }
    return [s, j + 1];
  };
  const readTemplate = () => { // returns [pattern, end]; nested ${…} expressions are scanned for their own strings
    let s = '', j = i + 1, n = 0;
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\') { s += src[j + 1] === 'n' ? '\n' : src[j + 1]; j += 2; continue; }
      if (src[j] === '$' && src[j + 1] === '{') {
        let depth = 1, k = j + 2;
        const start = k;
        while (k < src.length && depth) {
          const c = src[k];
          if (c === '{') depth++;
          else if (c === '}') depth--;
          else if (c === '\'' || c === '"') { const save = i; i = k; const [, e] = readString(c); i = save; k = e; continue; }
          else if (c === '`') { const save = i; i = k; const [, e] = readTemplate(); i = save; k = e; continue; }
          k++;
        }
        for (const x of scanJs(src.slice(start, k - 1))) out.push({ ...x, offset: (x.offset || 0) + start });
        s += `{${n++}}`; j = k; continue;
      }
      s += src[j++];
    }
    return [s, j + 1];
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
    if (c === '\'' || c === '"') { const [s, e] = readString(c); out.push({ text: s, offset: i, before: src.slice(Math.max(0, i - 40), i), after: src.slice(e, e + 3) }); i = e; prev = 'str'; continue; }
    if (c === '`') { const [s, e] = readTemplate(); out.push({ text: s, offset: i, before: src.slice(Math.max(0, i - 40), i), after: src.slice(e, e + 3), template: true }); i = e; prev = 'str'; continue; }
    if (c === '/' && regexOk()) { // regex literal
      let j = i + 1, cls = false;
      for (; j < src.length; j++) { const d = src[j]; if (d === '\\') { j++; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; else if (d === '\n') break; }
      i = j + 1; while (/[a-z]/.test(src[i] || '')) i++; prev = 're'; continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (/[\w$]/.test(src[j] || '')) j++; prev = src.slice(i, j); i = j; continue; }
    prev = c; i++;
  }
  return out;
}

const CODE_CONTEXT = /(class:\s*|className\s*=\s*|classList\.\w+\(\s*|querySelector(All)?\(\s*|closest\(\s*|addEventListener\(\s*|removeEventListener\(\s*|\.on\(\s*|\.off\(\s*|\.emit\(\s*|import\(\s*|from\s*|require\(\s*|getAttribute\(\s*|setAttribute\(\s*|dataset\.\w+\s*[=!]==?\s*|console\.\w+\(\s*|setProperty\(\s*|getPropertyValue\(\s*|createElement\(\s*|cssVar\(\s*|icon\(\s*|el\(\s*|fetch\(\s*|case\s*|[=!]==?\s*|typeof\s+\w+\s*[=!]==?\s*|new Error\(\s*|\.startsWith\(\s*|\.endsWith\(\s*|\.includes\(\s*|\.split\(\s*|\.join\(\s*|\.replace\(\s*|localStorage\.\w+\(\s*|postMessage\(\s*|\.set\(\s*|\.get\(\s*|\.has\(\s*|\.delete\(\s*)$/;

export function looksLikeUi(s) {
  const t = s.text.trim().replace(/\{\d+\}/g, '').trim(); // template placeholders are not code
  if (s.template && !/[A-Za-z]{3}/.test(t.replace(/(px|rem|em|ms|deg|rgba?|var|calc|translate\w*|scale|rotate)/g, ''))) return false;
  if (t.length < 2 || !/[A-Za-z]{2}/.test(t)) return false;
  if (CODE_CONTEXT.test(s.before)) return /\b(new Error\(|throw)/.test(s.before) && / /.test(t); // error messages may be shown
  if (/^\s*:/.test(s.after) && !/ /.test(t)) return false; // object key
  if (/^(https?:|\/|\.\/|\.\.\/|#|data:|blob:|mailto:)/.test(t) || /\.(js|css|json|html|png|svg|wav|mp3|xml)$/.test(t)) return false;
  if (/[<>]/.test(t) && /<\/?[a-z]/i.test(t)) return /[A-Z][a-z]+ [a-z]+/.test(t.replace(/<[^>]+>/g, '')); // html with prose
  if (/[{}]|=>|\(\)|\$\{/.test(t) ||(/;/.test(t) && !/[A-Za-z]{3,} [a-z]{2,}/.test(t))) return false; // code; prose may contain ";"
  if (/^[a-z0-9_.\-:/[\]]+$/.test(t)) return false; // ids, keys, single lowercase words
  if (/^[a-z][\w-]*( [a-z][\w-]*)*$/.test(t) && !/\b(the|a|an|to|of|and|or|in|on|for|is|no|not|with)\b/.test(t)) return false; // class lists
  if (/^[A-Z0-9_]+$/.test(t) && t.length <= 4) return false; // short constants (BPM, FX, A…)
  if (/^[\d\s.,:%+\-–×x/]*[a-z]{1,3}$/i.test(t) && t.length < 8) return false; // units: 12 ms, 4x
  return true;
}

async function main() {
  let dict = {};
  try { dict = (await import(pathToFileURL(join(root, 'public/js/locales', `${lang}.js`)).href)).default; } catch {}
  const seen = new Map();
  for (const f of walk(join(root, 'public'))) {
    const src = readFileSync(f, 'utf8');
    const rel = relative(root, f).replace(/\\/g, '/');
    const strings = f.endsWith('.html')
      ? [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].flatMap((m) => scanJs(m[1]).map((x) => ({ ...x, offset: x.offset + m.index })))
        .concat([...src.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/g, (m) => ' '.repeat(m.length)).matchAll(/>([^<>]*[A-Za-z]{2}[^<>]*)<|(?:title|placeholder|aria-label|alt)="([^"]+)"/g)]
          .map((m) => ({ text: (m[1] ?? m[2]).replace(/\s+/g, ' ').trim(), offset: m.index, before: '', after: '' })))
      : scanJs(src);
    for (const s of strings) {
      const text = s.text.replace(/\s+/g, ' ').trim();
      if (!looksLikeUi({ ...s, text })) continue;
      if (!args.includes('--all') && Object.hasOwn(dict, text)) continue;
      const line = src.slice(0, s.offset).split('\n').length;
      if (!seen.has(text)) seen.set(text, []);
      seen.get(text).push(`${rel}:${line}`);
    }
  }
  if (args.includes('--json')) { console.log(JSON.stringify(Object.fromEntries([...seen].map(([k]) => [k, ''])), null, 1)); return; }
  for (const [text, where] of seen) console.log(`${where[0]}${where.length > 1 ? ` (+${where.length - 1})` : ''}\t${JSON.stringify(text)}`);
  console.error(`${seen.size} strings${args.includes('--all') ? '' : ` not in locales/${lang}.js`}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
