#!/usr/bin/env node
// Builds public/controller-mapper.html from tools/controller-mapper/template.html: a single, self-contained page that maps a MIDI
// controller's buttons, knobs and faders to OpenDJ functions and saves an OpenDJ mapping (.opendj-midi.json).
//
// The page reuses OpenDJ's own code so it never drifts from the app:
//  - the list of mappable functions comes from buildTargets() (public/js/midi/midi.js)
//  - control detection (14-bit faders, relative encoders) and the guided steps come from public/js/midi/wizard.js
//
// The same file ships inside the app (Settings → Controllers → Controller Mapper, served from public/) and as a
// standalone download on the release page (OpenDJ-Controller-Mapper.html), which works when double-clicked.
//
// It also writes mappings/index.json, the controller list the page and the app sync from GitHub (every community
// mapping in mappings/ plus the wanted controllers in mappings/requested.json; a copy is embedded for offline use),
// and public/community-mappings.json, the community mappings built into the app.
//
// Usage: node scripts/build-controller-mapper.mjs           (writes both files)
//        node scripts/build-controller-mapper.mjs --check   (exits 1 if a committed file is out of date)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { buildTargets } from '../public/js/midi/midi.js';
import { slug } from './lib/mapping-schema.mjs';
import { hashEntries } from '../public/js/midi/community.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'tools', 'controller-mapper');
export const OUT = join(root, 'public', 'controller-mapper.html');
export const MAPPINGS = join(root, 'mappings');
export const INDEX = join(MAPPINGS, 'index.json');
/** Community mappings built into the app: the list plus the mapping files, up to BUNDLE_BUDGET bytes. */
export const BUNDLE = join(root, 'public', 'community-mappings.json');
export const BUNDLE_BUDGET = 2 * 1024 * 1024;

/** A do-nothing app: buildTargets only stores closures, so any property access just has to not throw. */
function stubApp() {
  const any = () => new Proxy(function () {}, { get: (t, p) => (p === Symbol.toPrimitive ? () => 0 : any()), apply: () => any() });
  const decks = [0, 1, 2, 3].map(() => any());
  const channels = [0, 1, 2, 3].map(() => ({ state: {}, set() {} }));
  return { engine: { decks, channels, sampler: any() }, library: any(), settings: {}, automix: {}, deckCount: 2 };
}

export function targetList() {
  return buildTargets(stubApp()).map(({ id, label, kind }) => ({ id, label, kind }));
}

export function mappingFiles(d = MAPPINGS) {
  if (!existsSync(d)) return [];
  return readdirSync(d).sort().flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? mappingFiles(p) : n.endsWith('.opendj-midi.json') ? [p] : [];
  });
}

/**
 * The controller list. status: 'verified' (a mapping confirmed by someone other than its author), 'needs-verification'
 * (a mapping nobody else has confirmed yet, or a built-in best-effort preset) or 'wanted' (no mapping yet).
 */
export function buildIndex() {
  const list = new Map();
  for (const file of mappingFiles()) {
    const m = JSON.parse(readFileSync(file, 'utf8'));
    const c = m.contributed || {};
    const verifiedBy = Array.isArray(c.verifiedBy) ? c.verifiedBy : [];
    list.set(slug(c.brand, c.model), {
      brand: c.brand, model: c.model, status: verifiedBy.length ? 'verified' : 'needs-verification',
      file: relative(MAPPINGS, file).split(sep).join('/'),
      midiNames: [...new Set([m.device, ...(c.midiNames || [])].filter(Boolean))],
      controls: m.entries.length, hash: hashEntries(m.entries), author: c.author, testedOn: c.testedOn, verifiedBy, note: c.notes,
    });
  }
  const req = existsSync(join(MAPPINGS, 'requested.json')) ? JSON.parse(readFileSync(join(MAPPINGS, 'requested.json'), 'utf8')).controllers : [];
  for (const r of req) {
    const k = slug(r.brand, r.model);
    if (list.has(k)) continue; // a community mapping replaces the request
    list.set(k, { brand: r.brand, model: r.model, status: r.status || 'wanted', midiNames: r.midiNames || [], note: r.note });
  }
  const controllers = [...list.values()].sort((a, b) => `${a.brand} ${a.model}`.localeCompare(`${b.brand} ${b.model}`));
  return JSON.stringify({ opendjControllerIndex: 1, controllers }, null, 2) + '\n';
}

/**
 * public/community-mappings.json: { opendjCommunityBundle: 1, index, mappings: { <file>: mapping } }. The app applies
 * these offline when a known controller is plugged in, and checks GitHub's index.json for newer versions (hash).
 * Mappings that don't fit the size budget are left out and downloaded when needed.
 */
export function buildBundle(index = buildIndex()) {
  const idx = JSON.parse(index), mappings = {};
  let size = index.length;
  for (const c of idx.controllers) {
    if (!c.file) continue;
    const m = JSON.parse(readFileSync(join(MAPPINGS, c.file), 'utf8'));
    const len = JSON.stringify(m).length;
    if (size + len > BUNDLE_BUDGET) continue;
    mappings[c.file] = m; size += len;
  }
  return JSON.stringify({ opendjCommunityBundle: 1, index: idx, mappings }) + '\n';
}

export function build(index = buildIndex()) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const tpl = readFileSync(join(dir, 'template.html'), 'utf8').replace(/\r\n/g, '\n');
  const plain = (f) => readFileSync(join(root, 'public', 'js', 'midi', f), 'utf8').replace(/\r\n/g, '\n').replace(/^export /gm, '');
  // wizard.js and community.js have no imports; the `export` keywords are dropped so they run as a plain script
  const wizard = plain('wizard.js'), community = plain('community.js');
  const parts = tpl.split(/(\/\*@@[A-Z]+@@\*\/|@@VERSION@@)/);
  // `<` escaped so a name like "</script>" in a contributed file can't end the script block
  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  const fill = { '/*@@TARGETS@@*/': json(targetList()), '/*@@INDEX@@*/': json(JSON.parse(index)), '/*@@WIZARD@@*/': wizard, '/*@@COMMUNITY@@*/': community, '@@VERSION@@': pkg.version };
  const html = parts.map((p) => (p in fill ? fill[p] : p)).join('');
  // strict CSP: only these exact inline scripts may run, and the page may only fetch from raw.githubusercontent.com
  const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  const csp = `default-src 'none'; script-src ${hashes.join(' ')}; style-src 'unsafe-inline'; font-src 'self'; img-src data:; connect-src 'self' https://raw.githubusercontent.com; base-uri 'none'; form-action 'none'`;
  return html.replace('@@CSP@@', csp);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const index = buildIndex();
  const html = build(index), bundle = buildBundle(index);
  const read = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
  if (process.argv.includes('--check')) {
    if (read(OUT) !== html || read(INDEX) !== index || read(BUNDLE) !== bundle) { console.error('public/controller-mapper.html or mappings/index.json is out of date: run node scripts/build-controller-mapper.mjs'); process.exit(1); }
    console.log('controller mapper is up to date');
  } else {
    writeFileSync(INDEX, index);
    writeFileSync(BUNDLE, bundle);
    writeFileSync(OUT, html);
    console.log(`wrote ${INDEX}\nwrote ${BUNDLE}\nwrote ${OUT} (${(html.length / 1024).toFixed(0)} KB)`);
  }
}
