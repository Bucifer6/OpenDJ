// Update prompt: version compare, release-notes extraction, safe Markdown, asset selection, SHA256SUMS, snooze,
// the checker (ETag, rate limit, size cap, allow-list), GET /api/update/check (hosted login) and the Electron downloader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {
  parseVersion, compareVersions, isNewer, cleanVersion, normalizeRelease, notesSections, notesSince, sectionIsNewer, notesSummary,
  parseInline, parseMarkdown, renderMarkdown, safeLink, assetNamesFor, selectAsset, parseSha256Sums, promptState, snoozeFor, skipFor,
  UpdateChecker, isUpdateApiUrl, isReleaseDownloadUrl, isAllowedRedirect, isReleasePageUrl, chooseUpdateAction, UPDATE_URL, SNOOZE_MS, ASSET_NAME_RE,
} from '../public/js/shared/update-core.js';
import { testUpdateUrl, createUpdateChecker } from '../server/update.js';
import { installKind, updatePlan, installHint, downloadVerified, fetchReleaseFile, downloadDir } from '../electron/updater.js';
import { start } from '../server/index.js';
import { sanitizeSetting } from '../public/js/shared/settings-schema.js';

const NOTES = fs.readFileSync(new URL('../docs/RELEASE_NOTES.md', import.meta.url), 'utf8');
const DL = (v, n) => `https://github.com/Bucifer6/OpenDJ/releases/download/v${v}/${n}`;
const ALL_ASSETS = (v) => [`OpenDJ-Setup-${v}-x64.exe`, `OpenDJ-Setup-${v}-arm64.exe`, `OpenDJ-Setup-${v}.exe`, `OpenDJ-Portable-${v}.exe`, `OpenDJ-${v}-mac-arm64.dmg`, `OpenDJ-${v}-mac-arm64.zip`,
  `OpenDJ-${v}-mac-x64.dmg`, `OpenDJ-${v}-mac-x64.zip`, `OpenDJ-${v}-linux-x86_64.AppImage`, `OpenDJ-${v}-linux-arm64.AppImage`, `OpenDJ-${v}-linux-amd64.deb`, `OpenDJ-${v}-linux-arm64.deb`,
  `OpenDJ-${v}-linux-x86_64.rpm`, `OpenDJ-${v}-linux-x64.tar.gz`, `OpenDJ-${v}-linux-arm64.tar.gz`, `OpenDJ-${v}-android-debug-signed.apk`, 'SHA256SUMS.txt'];
const ghRelease = (v, extra = {}) => ({ tag_name: `v${v}`, name: `OpenDJ v${v}`, draft: false, prerelease: false, published_at: '2026-11-18T10:00:00Z', body: NOTES,
  assets: ALL_ASSETS(v).map((n) => ({ name: n, size: 1000, browser_download_url: DL(v, n) })), ...extra });

// ---------------------------------------------------------------- semver
test('semver: parse and compare, v-prefixed tags, pre-releases', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] });
  assert.deepEqual(parseVersion('1.0.0-beta.2+build.5').pre, ['beta', '2']);
  for (const bad of ['', '1.2', '1.2.3.4', 'x1.2.3', '01.2.3', null, undefined, 'v', '1.2.3-', 'latest']) assert.equal(parseVersion(bad), null, String(bad));
  assert.equal(cleanVersion('V0.5.0'), '0.5.0');
  assert.ok(isNewer('v0.5.0', '0.4.0'));
  assert.ok(isNewer('0.4.10', '0.4.9'), 'numeric, not lexical');
  assert.ok(isNewer('1.0.0', '0.99.99'));
  assert.equal(compareVersions('0.4.0', 'v0.4.0'), 0);
  assert.ok(!isNewer('0.3.9', '0.4.0'));
  // pre-release ordering from semver.org: 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 1; i < order.length; i++) assert.ok(isNewer(order[i], order[i - 1]), `${order[i]} > ${order[i - 1]}`);
  assert.ok(Number.isNaN(compareVersions('nope', '1.0.0')));
  assert.ok(!isNewer('garbage', '0.4.0'));
});

// ---------------------------------------------------------------- releases
test('normalizeRelease: drafts / pre-releases ignored, assets allow-listed, page URL built from the tag', () => {
  assert.equal(normalizeRelease({ ...ghRelease('0.5.0'), draft: true }), null);
  assert.equal(normalizeRelease({ ...ghRelease('0.5.0'), prerelease: true }), null);
  assert.equal(normalizeRelease(ghRelease('0.5.0-beta.1')), null, 'a pre-release version not flagged as one');
  assert.equal(normalizeRelease({ ...ghRelease('0.5.0'), tag_name: 'nightly' }), null);
  assert.equal(normalizeRelease(null), null);
  const r = normalizeRelease({ ...ghRelease('0.5.0'), html_url: 'https://evil.example/', assets: [
    ...ghRelease('0.5.0').assets,
    { name: 'evil.exe', browser_download_url: DL('0.5.0', 'evil.exe') },
    { name: 'OpenDJ-Setup-0.5.0-x64.exe', browser_download_url: 'https://evil.example/OpenDJ-Setup-0.5.0-x64.exe' },
    { name: 'OpenDJ-0.5.0-mac-x64.dmg', browser_download_url: 'https://github.com/someone/else/releases/download/v0.5.0/OpenDJ-0.5.0-mac-x64.dmg' },
    { name: 'OpenDJ-0.5.0-linux-amd64.deb', browser_download_url: DL('0.5.0', 'OpenDJ-0.5.0-linux-x86_64.AppImage') }, // name ≠ URL
    { name: '../../OpenDJ-0.5.0-linux-amd64.deb', browser_download_url: DL('0.5.0', '..%2F..%2FOpenDJ-0.5.0-linux-amd64.deb') },
  ] });
  assert.equal(r.version, '0.5.0');
  assert.equal(r.url, 'https://github.com/Bucifer6/OpenDJ/releases/tag/v0.5.0');
  assert.equal(r.assets.length, ALL_ASSETS('0.5.0').length, 'only the genuine assets');
  assert.ok(r.assets.every((a) => isReleaseDownloadUrl(a.url)));
});

test('URL allow-lists: update API, release downloads, redirect hosts, release pages', () => {
  assert.ok(isUpdateApiUrl(UPDATE_URL));
  for (const u of ['http://api.github.com/repos/x', 'https://api.github.com.evil.example/repos/x', 'https://user:pw@api.github.com/repos/x', 'https://api.github.com:444/repos/x', 'https://evil.example/repos/x', 'javascript:alert(1)'])
    assert.ok(!isUpdateApiUrl(u), u);
  assert.ok(isReleaseDownloadUrl(DL('0.5.0', 'OpenDJ-Setup-0.5.0-x64.exe')));
  for (const u of [DL('0.5.0', 'evil.exe'), 'http://github.com/Bucifer6/OpenDJ/releases/download/v0.5.0/OpenDJ-Setup-0.5.0-x64.exe',
    'https://github.com/Bucifer6/OpenDJ/releases/download/v0.5.0/x/OpenDJ-Setup-0.5.0-x64.exe', 'https://github.com/Other/OpenDJ/releases/download/v0.5.0/OpenDJ-Setup-0.5.0-x64.exe',
    `${DL('0.5.0', 'OpenDJ-Setup-0.5.0-x64.exe')}?x=1`, 'https://objects.githubusercontent.com/OpenDJ-Setup-0.5.0-x64.exe'])
    assert.ok(!isReleaseDownloadUrl(u), u);
  assert.ok(isAllowedRedirect('https://objects.githubusercontent.com/github-production-release-asset/abc?sig=1'));
  assert.ok(isAllowedRedirect('https://release-assets.githubusercontent.com/x'));
  assert.ok(!isAllowedRedirect('http://objects.githubusercontent.com/x') && !isAllowedRedirect('https://objects.githubusercontent.com.evil.example/x') && !isAllowedRedirect('https://evil.example/x'));
  assert.ok(isReleasePageUrl('https://github.com/Bucifer6/OpenDJ/releases/tag/v0.5.0') && !isReleasePageUrl('https://github.com/Bucifer6/OpenDJ-evil/releases'));
  for (const n of ALL_ASSETS('1.2.3').filter((x) => x !== 'SHA256SUMS.txt')) assert.ok(ASSET_NAME_RE.test(n), n);
  for (const n of ['OpenDJ-1.2.3-linux-x64.sh', 'OpenDJ-Setup-1.2.3-x64.exe.lnk', 'evil.exe', 'OpenDJ-1.2.3-../x.exe']) assert.ok(!ASSET_NAME_RE.test(n), n);
});

test('server: OPENDJ_UPDATE_URL is only honoured for loopback URLs (tests); production URL fixed', () => {
  assert.equal(testUpdateUrl(undefined), null);
  assert.equal(testUpdateUrl('https://evil.example/repos/x'), null);
  assert.equal(testUpdateUrl('http://user:pw@127.0.0.1/x'), null);
  assert.equal(testUpdateUrl('http://127.0.0.1:7840/x'), 'http://127.0.0.1:7840/x');
  assert.equal(createUpdateChecker({ version: '0.4.0', env: {} }).url, UPDATE_URL);
  assert.equal(createUpdateChecker({ version: '0.4.0', env: { OPENDJ_UPDATE_URL: 'https://evil.example/x' } }).url, UPDATE_URL);
});

// ---------------------------------------------------------------- release notes
test('release notes: only the "New in" sections newer than the running version, not the download table', () => {
  const body = NOTES.replace(/### New in 0\.(?:5|4\.2)\n[\s\S]*?(?=### New in 0\.4\n)/, '').replace('### New in 0.4', '### New in 0.5\n**Big**\n- one\n\n#### Detail\n- two\n\n### New in 0.4.1\n- fix\n\n### New in 0.4');
  const secs = notesSections(body);
  assert.deepEqual(secs.map((s) => s.version), ['0.5', '0.4.1', '0.4', '0.3', '0.2']);
  assert.ok(!secs.some((s) => /Windows 10\/11|SHA256SUMS/.test(s.markdown)), 'the download table is not a section');
  assert.ok(secs[0].markdown.includes('#### Detail'), 'sub-headings stay inside their section');
  assert.deepEqual(notesSince(body, '0.4.0').map((s) => s.title), ['New in 0.5', 'New in 0.4.1']);
  assert.deepEqual(notesSince(body, '0.4.1').map((s) => s.title), ['New in 0.5']);
  assert.deepEqual(notesSince(body, '0.3.2').map((s) => s.version), ['0.5', '0.4.1', '0.4']);
  assert.deepEqual(notesSince(body, '0.5.0'), []);
  assert.ok(sectionIsNewer('0.5', '0.4.9') && !sectionIsNewer('0.4', '0.4.0') && sectionIsNewer('0.4.1', '0.4.0') && sectionIsNewer('1', '0.9.0'));
  // GitHub's generated "What's Changed" (## heading) ends the last section
  const gen = '### New in 0.6\n- a\n\n## What\'s Changed\n* thing by @x in https://github.com/x/y/pull/1';
  assert.equal(notesSince(gen, '0.5.0')[0].markdown, '- a');
  assert.deepEqual(notesSummary(notesSince(body, '0.4.0')), ['Big']);
  assert.deepEqual(notesSummary([{ markdown: '- First point.\n- Second' }]), ['First point', 'Second']);
});

// ---------------------------------------------------------------- safe Markdown
/** A tiny DOM: enough for renderMarkdown, and it records every attribute that is set. */
function fakeDoc() {
  const attrs = [];
  class Node { constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; } appendChild(c) { this.children.push(c); return c; }
    setAttribute(k, v) { attrs.push([k, v]); this.attributes[k] = String(v); }
    get textContent() { return this.children.map((c) => (typeof c.text === 'string' ? c.text : c.textContent)).join(''); } }
  return { attrs, createElement: (t) => new Node(t), createTextNode: (text) => ({ text }) };
}
const walk = (n, fn) => { fn(n); for (const c of n.children || []) walk(c, fn); };

test('markdown: headings, bold, lists, inline code, links (http/https only)', () => {
  const blocks = parseMarkdown('### Title\n**Bold** line with `code`\n\n- one\n- two [link](https://example.com/a_(b))\n  continued\n\n1. first\n\n| A | B |\n|---|---|\n| x | y |');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'p', 'ul', 'ol', 'p', 'p']);
  assert.equal(blocks[2].items[1].c.find((t) => t.t === 'link').href, 'https://example.com/a_(b)');
  assert.ok(blocks[2].items[1].c.at(-1).v.includes('continued'));
  assert.deepEqual(parseInline('a **b** _c_ `d`').map((t) => t.t), ['text', 'strong', 'text', 'em', 'text', 'code']);
  const doc = fakeDoc();
  const root = renderMarkdown('### Title\n- **Bold** and [ok](https://example.com)', doc);
  const tags = []; walk(root, (n) => n.tagName && tags.push(n.tagName));
  assert.deepEqual(tags, ['div', 'h4', 'ul', 'li', 'strong', 'a']);
});

test('markdown: XSS attempts in release notes render inert', () => {
  const evil = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '![x](javascript:alert(1))', '![pixel](https://tracker.example/p.png)',
    '[click](javascript:alert(1))', '[c2](JaVaScRiPt:alert(1))', '[c3](data:text/html;base64,PHNjcmlwdD4=)', '[c4](vbscript:x)', '[c5](//evil.example/x)',
    '[c6](https://ok.example/" onmouseover="alert(1))', '<a href="javascript:alert(1)">x</a>', '<svg onload=alert(1)>', '<iframe src=https://evil.example>',
    '**<b onclick=alert(1)>bold</b>**', '`<script>`', '<https://ok.example/auto>', 'javascript:alert(1)', '[x](https://user:pw@evil.example/)',
  ].map((l) => `- ${l}`).join('\n');
  const doc = fakeDoc();
  const root = renderMarkdown(`### New in 9\n${evil}`, doc);
  const tags = new Set(); walk(root, (n) => n.tagName && tags.add(n.tagName));
  for (const t of tags) assert.ok(['div', 'h4', 'ul', 'li', 'strong', 'code', 'a'].includes(t), `unexpected element <${t}>`);
  for (const [k, v] of doc.attrs) {
    assert.ok(['class', 'href', 'target', 'rel'].includes(k), `unexpected attribute ${k}`);
    if (k === 'href') assert.match(v, /^https:\/\/ok\.example\/(auto)?$/, `only safe https links are links (got ${v})`);
  }
  assert.ok(root.textContent.includes('<script>alert(1)</script>'), 'HTML is shown as text');
  assert.ok(root.textContent.includes('<img src=x onerror=alert(1)>'));
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:x', 'data:text/html,x', '//evil.example', '/relative', 'https://u:p@x.example', 'https://x.example/"onload', ' ']) assert.equal(safeLink(bad), null, bad);
  assert.equal(safeLink('https://github.com/Bucifer6/OpenDJ'), 'https://github.com/Bucifer6/OpenDJ');
  // deep nesting / long input stays bounded
  assert.ok(renderMarkdown(`${'**'.repeat(200)}x${'**'.repeat(200)}`, fakeDoc()));
  assert.ok(parseInline('['.repeat(5000) + 'x').length >= 1);
});

// ---------------------------------------------------------------- assets
test('asset selection per platform and architecture', () => {
  const r = normalizeRelease(ghRelease('0.5.0'));
  const pick = (kind, arch) => selectAsset(r, { kind, arch })?.name || null;
  assert.equal(pick('nsis', 'x64'), 'OpenDJ-Setup-0.5.0-x64.exe');
  assert.equal(pick('nsis', 'arm64'), 'OpenDJ-Setup-0.5.0-arm64.exe');
  assert.equal(pick('portable', 'x64'), 'OpenDJ-Portable-0.5.0.exe');
  assert.equal(pick('dmg', 'arm64'), 'OpenDJ-0.5.0-mac-arm64.dmg');
  assert.equal(pick('dmg', 'x64'), 'OpenDJ-0.5.0-mac-x64.dmg');
  assert.equal(pick('appimage', 'x64'), 'OpenDJ-0.5.0-linux-x86_64.AppImage');
  assert.equal(pick('appimage', 'arm64'), 'OpenDJ-0.5.0-linux-arm64.AppImage');
  assert.equal(pick('deb', 'x64'), 'OpenDJ-0.5.0-linux-amd64.deb');
  assert.equal(pick('deb', 'arm64'), 'OpenDJ-0.5.0-linux-arm64.deb');
  assert.equal(pick('rpm', 'x64'), 'OpenDJ-0.5.0-linux-x86_64.rpm');
  assert.equal(pick('rpm', 'arm64'), null, 'no arm64 rpm is built');
  assert.equal(pick('targz', 'x64'), 'OpenDJ-0.5.0-linux-x64.tar.gz');
  assert.equal(pick('targz', 'arm64'), 'OpenDJ-0.5.0-linux-arm64.tar.gz');
  assert.equal(pick('apk'), 'OpenDJ-0.5.0-android-debug-signed.apk');
  assert.equal(pick('source'), null);
  // the combined NSIS installer when the per-arch one is missing; the release build preferred over debug-signed
  const r2 = { version: '0.5.0', assets: [{ name: 'OpenDJ-Setup-0.5.0.exe', url: DL('0.5.0', 'OpenDJ-Setup-0.5.0.exe') }, { name: 'OpenDJ-0.5.0-android-release.apk' }, { name: 'OpenDJ-0.5.0-android-debug-signed.apk' }] };
  assert.equal(selectAsset(r2, { kind: 'nsis', arch: 'arm64' }).name, 'OpenDJ-Setup-0.5.0.exe');
  assert.equal(selectAsset(r2, { kind: 'apk' }).name, 'OpenDJ-0.5.0-android-release.apk');
  assert.deepEqual(assetNamesFor('nope', { kind: 'nsis' }), []);
});

test('install kind detection (Electron)', () => {
  const k = (o) => installKind({ packaged: true, exists: () => false, env: {}, ...o });
  assert.equal(installKind({ packaged: false }), 'source');
  assert.equal(k({ platform: 'win32' }), 'nsis');
  assert.equal(k({ platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x\\OpenDJ.exe' } }), 'portable');
  assert.equal(k({ platform: 'darwin' }), 'dmg');
  assert.equal(k({ platform: 'linux', env: { APPIMAGE: '/home/u/OpenDJ.AppImage' } }), 'appimage');
  assert.equal(k({ platform: 'linux', execPath: '/opt/OpenDJ/opendj', exists: (p) => p === '/var/lib/dpkg/info/opendj.list' }), 'deb');
  assert.equal(k({ platform: 'linux', execPath: '/opt/OpenDJ/opendj', exists: (p) => p === '/usr/bin/rpm' }), 'rpm');
  assert.equal(k({ platform: 'linux', execPath: '/home/u/OpenDJ-0.4.0/opendj' }), 'targz');
  const r = normalizeRelease(ghRelease('0.5.0'));
  assert.equal(updatePlan(r, { kind: 'nsis', arch: 'x64' }).action, 'install');
  assert.equal(updatePlan(r, { kind: 'dmg', arch: 'arm64' }).asset.name, 'OpenDJ-0.5.0-mac-arm64.dmg');
  assert.equal(updatePlan(r, { kind: 'deb', arch: 'x64' }).action, 'open');
  assert.match(installHint('deb', 'OpenDJ-0.5.0-linux-amd64.deb').command, /^sudo apt install \.\/OpenDJ-0\.5\.0-linux-amd64\.deb$/);
  assert.match(installHint('rpm', 'x.rpm').command, /dnf install/);
  assert.equal(downloadDir('appimage', { env: { APPIMAGE: '/apps/OpenDJ.AppImage' }, downloads: '/dl', temp: '/tmp', writable: () => true }), '/apps');
  assert.equal(downloadDir('appimage', { env: { APPIMAGE: '/apps/OpenDJ.AppImage' }, downloads: '/dl', temp: '/tmp', writable: () => false }), '/dl');
  assert.equal(downloadDir('nsis', { downloads: '/dl', temp: '/tmp' }), path.join('/tmp', 'opendj-update'));
});

test('"Update now" per platform (page side)', () => {
  const r = normalizeRelease(ghRelease('0.5.0'));
  const cfg = { channel: 'github', playUrl: 'https://play.google.com/store/apps/details?id=io.github.bucifer6.opendj', appStoreUrl: '', testFlightUrl: '' };
  assert.deepEqual(chooseUpdateAction(r, { electron: true }, cfg), { type: 'electron' });
  assert.deepEqual(chooseUpdateAction(r, { hosted: true }, cfg), { type: 'instructions', kind: 'hosted', url: r.url });
  assert.equal(chooseUpdateAction(r, {}, cfg).kind, 'server');
  const apk = chooseUpdateAction(r, { local: true, native: true, os: 'android' }, cfg);
  assert.equal(apk.kind, 'apk'); assert.equal(apk.url, DL('0.5.0', 'OpenDJ-0.5.0-android-debug-signed.apk'));
  assert.equal(chooseUpdateAction(r, { local: true, native: true, os: 'android' }, { ...cfg, channel: 'play' }).url, cfg.playUrl);
  assert.equal(chooseUpdateAction({ ...r, assets: [] }, { local: true, native: true, os: 'android' }, cfg).kind, 'page');
  assert.equal(chooseUpdateAction(r, { local: true, native: true, os: 'ios' }, cfg).url, r.url, 'iOS without store links: the release page');
  assert.equal(chooseUpdateAction(r, { local: true, native: true, os: 'ios' }, { ...cfg, testFlightUrl: 'https://testflight.apple.com/join/abc' }).kind, 'testflight');
  assert.equal(chooseUpdateAction(r, { local: true, native: true, os: 'ios' }, { ...cfg, channel: 'appstore', appStoreUrl: 'https://apps.apple.com/app/id1', testFlightUrl: 'https://testflight.apple.com/join/abc' }).kind, 'appstore');
  assert.equal(chooseUpdateAction(r, { local: true, native: true, os: 'ios' }, { ...cfg, testFlightUrl: 'javascript:alert(1)' }).kind, 'page', 'bad config links are ignored');
  assert.equal(chooseUpdateAction(r, { local: true, native: false, os: 'web' }, cfg).url, r.url);
});

// ---------------------------------------------------------------- SHA256SUMS
test('SHA256SUMS.txt parsing', () => {
  const a = 'a'.repeat(64), b = 'B'.repeat(64), c = 'c'.repeat(64);
  const m = parseSha256Sums(`${a}  OpenDJ-Setup-0.5.0-x64.exe\r\n${b} *OpenDJ-0.5.0-mac-arm64.dmg\n# comment\nnot a line\n${c}  ./OpenDJ-0.5.0-linux-x86_64.AppImage\n${a}  dup.exe\n${c}  dup.exe\n  \n`);
  assert.equal(m.get('OpenDJ-Setup-0.5.0-x64.exe'), a);
  assert.equal(m.get('OpenDJ-0.5.0-mac-arm64.dmg'), b.toLowerCase(), 'binary-mode marker and upper case');
  assert.equal(m.get('OpenDJ-0.5.0-linux-x86_64.AppImage'), c);
  assert.equal(m.has('dup.exe'), false, 'conflicting entries are dropped');
  assert.equal(m.size, 3);
  assert.equal(parseSha256Sums('').size, 0);
});

// ---------------------------------------------------------------- snooze
test('snooze: Later = 3 days or until a newer version; Skip = until a newer version', () => {
  const now = 1_800_000_000_000;
  assert.equal(promptState({ latest: '0.5.0', current: '0.4.0', snooze: null, now }), 'prompt');
  assert.equal(promptState({ latest: '0.4.0', current: '0.4.0', snooze: null, now }), 'none');
  assert.equal(promptState({ latest: '0.3.0', current: '0.4.0', snooze: null, now }), 'none');
  const later = snoozeFor('v0.5.0', now);
  assert.deepEqual(later, { version: '0.5.0', until: now + SNOOZE_MS });
  assert.equal(promptState({ latest: '0.5.0', current: '0.4.0', snooze: later, now: now + SNOOZE_MS - 1 }), 'snoozed');
  assert.equal(promptState({ latest: '0.5.0', current: '0.4.0', snooze: later, now: now + SNOOZE_MS + 1 }), 'prompt', 'after 3 days');
  assert.equal(promptState({ latest: '0.5.1', current: '0.4.0', snooze: later, now: now + 1000 }), 'prompt', 'a newer version than the dismissed one');
  const skip = skipFor('0.5.0');
  assert.equal(promptState({ latest: '0.5.0', current: '0.4.0', snooze: skip, now: now + 365 * 86400e3 }), 'skipped');
  assert.equal(promptState({ latest: '0.6.0', current: '0.4.0', snooze: skip, now }), 'prompt');
  assert.equal(promptState({ latest: '0.5.0', current: '0.4.0', snooze: { version: 'junk', until: Infinity }, now }), 'prompt');
  // settings schema
  assert.deepEqual(sanitizeSetting('updateSnooze', later), { ok: true, value: later });
  assert.deepEqual(sanitizeSetting('updateSnooze', { version: '0.5.0', skip: true, extra: 1 }), { ok: true, value: { version: '0.5.0', skip: true } });
  assert.equal(sanitizeSetting('updateSnooze', { version: '<x>', until: 1 }).ok, false);
  assert.deepEqual(sanitizeSetting('updateSnooze', null), { ok: true, value: null });
  assert.equal(sanitizeSetting('updateCheck', 'yes').ok, false);
});

// ---------------------------------------------------------------- the checker
const res = (status, body, headers = {}) => new Response(status === 304 ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

test('checker: headers, ETag revalidation, caching, rate-limit back-off, offline', async () => {
  let t = 1_000_000;
  const calls = [];
  let reply = () => res(200, ghRelease('0.5.0'), { ETag: '"e1"' });
  const fetch = async (url, init) => { calls.push({ url, init }); return reply(); };
  const c = new UpdateChecker({ fetch, version: '0.4.0', now: () => t });
  const r1 = await c.check();
  assert.equal(r1.ok, true); assert.equal(r1.available, true); assert.equal(r1.latest.version, '0.5.0');
  assert.equal(calls[0].url, UPDATE_URL);
  assert.equal(calls[0].init.headers['User-Agent'], 'OpenDJ/0.4.0');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ['Accept', 'User-Agent', 'X-GitHub-Api-Version'], 'nothing about the user');
  assert.deepEqual(r1.latest.notes.map((section) => section.version), ['0.5', '0.4.2', '0.4.1'], 'show the release notes newer than 0.4.0');
  await c.check(); assert.equal(calls.length, 1, 'cached');
  t += 16 * 60e3;
  reply = () => res(304, null, { ETag: '"e1"' });
  const r2 = await c.check();
  assert.equal(calls[1].init.headers['If-None-Match'], '"e1"');
  assert.equal(r2.latest.version, '0.5.0', '304 keeps the release');
  t += 5e3; await c.check({ force: true }); assert.equal(calls.length, 2, 'a forced check within 30 s reuses the result');
  t += 31e3;
  reply = () => res(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-reset': String(Math.floor((t + 3600e3) / 1000)) });
  const r3 = await c.check({ force: true });
  assert.equal(r3.error, 'rate-limited'); assert.equal(r3.latest.version, '0.5.0', 'the last result is kept');
  t += 20 * 60e3; await c.check({ force: true }); assert.equal(calls.length, 3, 'no request while rate-limited');
  t += 50 * 60e3;
  reply = () => { throw new TypeError('fetch failed'); };
  const r4 = await c.check({ force: true });
  assert.equal(r4.error, 'offline'); assert.equal(r4.ok, false);
  // concurrent checks share one request
  const c2 = new UpdateChecker({ fetch: async () => { await new Promise((r) => setTimeout(r, 20)); return res(200, ghRelease('0.4.0')); }, version: '0.4.0' });
  const [a, b] = await Promise.all([c2.check(), c2.check()]);
  assert.equal(c2.requests, 1); assert.equal(a.available, false); assert.equal(b.available, false);
});

test('checker: size cap, bad JSON, no release, browser mode, allow-list, timeout', async () => {
  const big = new UpdateChecker({ fetch: async () => res(200, JSON.stringify({ ...ghRelease('0.5.0'), body: 'x'.repeat(2e6) })), version: '0.4.0' });
  assert.equal((await big.check()).error, 'too-large');
  const declared = new UpdateChecker({ fetch: async () => res(200, '{}', { 'content-length': String(5e6) }), version: '0.4.0' });
  assert.equal((await declared.check()).error, 'too-large');
  assert.equal((await new UpdateChecker({ fetch: async () => res(200, '<html>'), version: '0.4.0' }).check()).error, 'bad-response');
  const none = await new UpdateChecker({ fetch: async () => res(404, { message: 'Not Found' }), version: '0.4.0' }).check();
  assert.equal(none.ok, true); assert.equal(none.latest, null);
  const pre = await new UpdateChecker({ fetch: async () => res(200, { ...ghRelease('0.6.0'), prerelease: true }), version: '0.4.0' }).check();
  assert.equal(pre.available, false, 'pre-releases are ignored');
  let hdrs;
  await new UpdateChecker({ fetch: async (_u, i) => { hdrs = i.headers; return res(200, ghRelease('0.5.0'), { ETag: '"x"' }); }, version: '0.4.0', conditional: false, userAgent: false }).check();
  assert.deepEqual(Object.keys(hdrs), ['Accept'], 'browser mode: a CORS-simple request');
  let called = false;
  const blocked = await new UpdateChecker({ fetch: async () => { called = true; return res(200, {}); }, version: '0.4.0', url: 'https://evil.example/repos/x' }).check();
  assert.equal(blocked.error, 'blocked'); assert.equal(called, false, 'only api.github.com is ever requested');
  const slow = new UpdateChecker({ fetch: (_u, i) => new Promise((_r, rej) => i.signal.addEventListener('abort', () => rej(new Error('aborted')))), version: '0.4.0', timeoutMs: 30 });
  assert.equal((await slow.check()).error, 'timeout');
});

// ---------------------------------------------------------------- GET /api/update/check
async function withFakeGitHub(fn) {
  const hits = [];
  const gh = http.createServer((req, res2) => { hits.push(req.headers); res2.writeHead(200, { 'Content-Type': 'application/json', ETag: '"a"' }); res2.end(JSON.stringify(ghRelease('9.0.0'))); });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  const prev = process.env.OPENDJ_UPDATE_URL;
  process.env.OPENDJ_UPDATE_URL = `http://127.0.0.1:${gh.address().port}/repos/Bucifer6/OpenDJ/releases/latest`;
  try { await fn(hits); } finally { if (prev === undefined) delete process.env.OPENDJ_UPDATE_URL; else process.env.OPENDJ_UPDATE_URL = prev; gh.close(); }
}
const quiet = { log() {}, warn() {}, error() {} };

test('GET /api/update/check: hosted mode needs a signed-in user; the setting stops automatic checks', () => withFakeGitHub(async (hits) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-upd-'));
  const app = await start({ port: 0, dataDir: path.join(dir, 'h'), auth: true, password: 'correct horse', roots: [dir], ffmpeg: false, log: quiet });
  try {
    const anon = await fetch(`${app.url}api/update/check`);
    assert.equal(anon.status, 401);
    assert.equal(hits.length, 0, 'GitHub is not contacted for anonymous requests');
    const login = await fetch(`${app.url}api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const r = await (await fetch(`${app.url}api/update/check`, { headers: { Cookie: cookie } })).json();
    assert.equal(r.available, true); assert.equal(r.hosted, true); assert.equal(r.latest.version, '9.0.0');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]['user-agent'], `OpenDJ/${app.updates.version}`);
    assert.equal(hits[0].cookie, undefined, 'the user’s cookie is not forwarded');
    assert.ok(!hits[0].authorization);
  } finally { app.server.close(); app.shutdown(); }
  const desk = await start({ port: 0, dataDir: path.join(dir, 'd'), ffmpeg: false, log: quiet });
  try {
    desk.library.updateSettings({ updateCheck: false });
    const off = await (await fetch(`${desk.url}api/update/check`)).json();
    assert.equal(off.disabled, true); assert.equal(hits.length, 1, 'automatic checks off: no request');
    const forced = await (await fetch(`${desk.url}api/update/check?force=1`)).json();
    assert.equal(forced.available, true, '"Check now" still works'); assert.equal(forced.hosted, false);
    assert.equal(hits.length, 2);
    assert.equal((await fetch(`${desk.url}api/update/check`, { headers: { Origin: 'https://evil.example' } })).status, 403, 'cross-site pages cannot read it');
  } finally { desk.server.close(); desk.shutdown(); }
}));

// ---------------------------------------------------------------- Electron downloader
function fakeGitHubFetch(files, { redirectTo = 'https://objects.githubusercontent.com/store/' } = {}) {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push(url);
    const u = new URL(url);
    if (u.hostname === 'github.com') return new Response(null, { status: 302, headers: { Location: redirectTo + encodeURIComponent(path.basename(u.pathname)) } });
    const name = decodeURIComponent(path.basename(u.pathname));
    if (!(name in files)) return new Response('no', { status: 404 });
    assert.equal(init.redirect, 'manual');
    return new Response(files[name], { status: 200, headers: { 'content-length': String(files[name].length) } });
  };
  return { fetch, seen };
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('downloader: verified against SHA256SUMS.txt; mismatch, missing entry and foreign hosts refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-dl-'));
  const exe = crypto.randomBytes(200000);
  const name = 'OpenDJ-Setup-0.5.0-x64.exe';
  const release = (size = exe.length) => normalizeRelease({ ...ghRelease('0.5.0'), assets: [{ name, size, browser_download_url: DL('0.5.0', name) }, { name: 'SHA256SUMS.txt', size: 100, browser_download_url: DL('0.5.0', 'SHA256SUMS.txt') }] });
  // good
  let progress = 0;
  const ok = fakeGitHubFetch({ [name]: exe, 'SHA256SUMS.txt': Buffer.from(`${sha(exe)}  ${name}\n${'0'.repeat(64)}  other.exe\n`) });
  const out = await downloadVerified({ release: release(), assetName: name, dir, fetch: ok.fetch, onProgress: (p) => { progress = p.received; } });
  assert.equal(out.file, path.join(dir, name)); assert.equal(out.sha256, sha(exe));
  assert.deepEqual(fs.readFileSync(out.file), exe);
  assert.equal(progress, exe.length);
  assert.ok(ok.seen.every((u) => u.startsWith('https://github.com/Bucifer6/OpenDJ/releases/download/') || u.startsWith('https://objects.githubusercontent.com/')));
  fs.rmSync(out.file);
  // checksum mismatch: refused, nothing left behind
  const bad = fakeGitHubFetch({ [name]: exe, 'SHA256SUMS.txt': Buffer.from(`${'1'.repeat(64)}  ${name}\n`) });
  await assert.rejects(downloadVerified({ release: release(), assetName: name, dir, fetch: bad.fetch }), /Checksum mismatch/);
  // no entry for the file
  const missing = fakeGitHubFetch({ [name]: exe, 'SHA256SUMS.txt': Buffer.from(`${sha(exe)}  something-else.exe\n`) });
  await assert.rejects(downloadVerified({ release: release(), assetName: name, dir, fetch: missing.fetch }), /no entry/);
  // no SHA256SUMS.txt in the release at all
  const noSums = { ...release(), assets: release().assets.filter((a) => a.name !== 'SHA256SUMS.txt') };
  await assert.rejects(downloadVerified({ release: noSums, assetName: name, dir, fetch: ok.fetch }), /cannot be verified/);
  // bigger than the release says
  await assert.rejects(downloadVerified({ release: release(1000), assetName: name, dir, fetch: ok.fetch }), /larger than the release says/);
  // redirect to a foreign host
  const evil = fakeGitHubFetch({ [name]: exe, 'SHA256SUMS.txt': Buffer.from(`${sha(exe)}  ${name}\n`) }, { redirectTo: 'https://evil.example/' });
  await assert.rejects(downloadVerified({ release: release(), assetName: name, dir, fetch: evil.fetch }), /Refused redirect to evil\.example/);
  // names / URLs outside the allow-list
  await assert.rejects(downloadVerified({ release: release(), assetName: '../evil.exe', dir, fetch: ok.fetch }), /unexpected file name/);
  await assert.rejects(fetchReleaseFile('https://evil.example/OpenDJ-Setup-0.5.0-x64.exe', { fetch: ok.fetch }), /not an OpenDJ release download/);
  assert.deepEqual(fs.readdirSync(dir), [], 'failed downloads leave no files');
});
