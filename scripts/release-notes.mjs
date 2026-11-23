#!/usr/bin/env node
// The GitHub release description for one version, from docs/RELEASE_NOTES.md: the introduction (what OpenDJ is,
// which file to download, first launch, checksums) and that version's "### New in <version>" section only, so a
// release page shows what changed in that release instead of the whole history.
//
// Usage: node scripts/release-notes.mjs <version or tag> [notes file]   (e.g. v0.5.8; prints to stdout)
//        Fails when the notes have no section for that version (a release must say what changed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** { intro, sections: [{ heading, version, body }] } of a release notes file ("### …" headings). */
export function parseNotes(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((l) => /^### (New in |Unreleased)/.test(l));
  const intro = (first < 0 ? lines : lines.slice(0, first)).join('\n').trimEnd();
  const sections = [];
  let cur = null;
  for (const l of first < 0 ? [] : lines.slice(first)) {
    if (/^### /.test(l)) {
      const m = /^### New in (\d+(?:\.\d+)*)\b/.exec(l);
      cur = { heading: l, version: m ? m[1] : null, body: [] };
      sections.push(cur);
    } else cur?.body.push(l);
  }
  for (const s of sections) s.body = s.body.join('\n').trim();
  return { intro, sections };
}

/** Release description for `version` (a tag like "v0.5.8" works too). Throws when there is no such section. */
export function releaseBody(text, version) {
  const v = String(version).replace(/^v/, '');
  const { intro, sections } = parseNotes(text);
  const s = sections.find((x) => x.version === v);
  if (!s) throw new Error(`docs/RELEASE_NOTES.md has no "### New in ${v}" section`);
  return `${intro}\n\n${s.heading}\n${s.body}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [version, file = path.join(root, 'docs', 'RELEASE_NOTES.md')] = process.argv.slice(2);
  if (!version) { console.error('Usage: node scripts/release-notes.mjs <version> [notes file]'); process.exit(2); }
  try { process.stdout.write(releaseBody(fs.readFileSync(file, 'utf8'), version)); }
  catch (e) { console.error(e.message); process.exit(1); }
}
