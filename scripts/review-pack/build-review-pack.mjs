// Builds the app-review media pack: dist/opendj-review-pack-<version>.zip with the demo tracks, CREDITS.md,
// REVIEWER_GUIDE.md (docs/APP_REVIEW.md) and checksums.txt. Attach the zip to a GitHub release or upload it as a
// store-review attachment. The audio is never committed: this script regenerates the original tracks and downloads
// the CC0 ones from their official Free Music Archive pages, re-checking the CC0 licence on each page first.
//
//   node scripts/review-pack/build-review-pack.mjs [options]
//
//   --cache=<dir>       where tracks are kept between runs (default: <os tmp>/opendj-review-pack-tracks)
//   --out=<dir>         where the zip goes (default: dist/)
//   --no-cc0            generated tracks only (no network)
//   --strict            fail when a CC0 track cannot be verified / downloaded or a hash does not match
//   --pin               record missing hashes in scripts/review-pack/manifest.json (and re-pin regenerated tracks)
//   --update-manifest   write the measured BPM / key into the manifest
//   --write-docs        regenerate docs/store/CREDITS.md from the manifest
//   --force             regenerate the generated tracks even when they are cached
//
// Needs ffmpeg (ffmpeg-static) and Playwright's Chromium (cover art of the generated tracks).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { ensureProxyEnv, prepareTracks, analyseFile, creditsMarkdown, checksumsText, writeZip, saveManifest, loadManifest, generatorKey, ROOT, VERSION, DEFAULT_CACHE, mmss } from './pack.mjs';

ensureProxyEnv();
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const log = (...a) => console.log('[review-pack]', ...a);

const cache = path.resolve(opt('cache', DEFAULT_CACHE));
const outDir = path.resolve(opt('out', path.join(ROOT, 'dist')));
const { tracks, problems } = await prepareTracks({ cache, cc0: !flag('no-cc0'), strict: flag('strict'), pin: flag('pin'), force: flag('force'), log: (s) => log(s) });

// measure BPM / key with OpenDJ's analysis
const manifest = loadManifest();
for (const p of tracks) {
  const m = analyseFile(p.file);
  const t = manifest.tracks.find((x) => x.id === p.track.id);
  t.measured = { bpm: m.bpm, key: m.key, camelot: m.camelot, duration: m.duration, by: 'OpenDJ analysis-core.js analyzeTrack()' };
  if (flag('pin') && p.sha256 && !t.sha256) { t.sha256 = p.sha256; t.bytes = p.bytes; }
  p.track = t;
  const target = t.kind === 'generated' ? ` (generated at ${t.generator.bpm} BPM, ${generatorKey(t)})` : '';
  log(`${t.file}: ${m.bpm} BPM, ${m.key} / ${m.camelot}, ${mmss(m.duration)}${target}`);
}
if (flag('update-manifest')) { saveManifest(manifest); log('manifest updated with the measured BPM / key'); }

const credits = creditsMarkdown(manifest, tracks);
if (flag('write-docs')) {
  const f = path.join(ROOT, 'docs/store/CREDITS.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, creditsMarkdown(manifest).replace('# OpenDJ review pack: credits and licences', '# Store media and review pack: credits and licences') +
    '\n## Screenshots and preview videos\n\nThe screenshots in `docs/store/screenshots/` and the preview videos in `docs/store/video/` are recorded from OpenDJ\'s own UI (MIT) by `scripts/review-pack/store-screenshots.mjs` and `scripts/review-pack/store-video.mjs`, playing the tracks above. The video soundtrack is OpenDJ\'s own master output mixing them. No third-party logos, artwork or personal data appear in them: the cover art of the generated tracks is generated too.\n');
  log(`wrote ${path.relative(ROOT, f)}`);
}

// the zip
const guideSrc = fs.readFileSync(path.join(ROOT, 'docs/APP_REVIEW.md'), 'utf8');
const guide = guideSrc.replace(/\]\((?!https?:|#)([^)]+)\)/g, (m, p) => `](https://github.com/Bucifer6/OpenDJ/blob/main/docs/${p})`);
const files = tracks.map((p) => ({ name: `tracks/${p.track.file}`, data: fs.readFileSync(p.file) }));
files.push({ name: 'CREDITS.md', data: Buffer.from(credits) });
files.push({ name: 'REVIEWER_GUIDE.md', data: Buffer.from(guide) });
const sums = files.map((f) => ({ name: f.name, sha256: crypto.createHash('sha256').update(f.data).digest('hex') }));
files.push({ name: 'checksums.txt', data: Buffer.from(checksumsText(sums)) });
const zip = path.join(outDir, `opendj-review-pack-${VERSION}.zip`);
writeZip(zip, files.map((f) => ({ ...f, name: `opendj-review-pack-${VERSION}/${f.name}` })));
log(`${path.relative(ROOT, zip)}: ${tracks.length} tracks, ${(fs.statSync(zip).size / 1048576).toFixed(1)} MB`);
if (problems.length) log(`WARNING, built without:\n  ${problems.join('\n  ')}`);
