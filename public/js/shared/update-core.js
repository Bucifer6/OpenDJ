// Update checks, shared by the server (desktop and web app), the on-device backend (mobile app), the UI and the
// Electron main process. No DOM and no Node APIs here (renderMarkdown takes the document to build with).
//
//   - versions:       parseVersion / compareVersions / isNewer (semver; tags written as "vX.Y.Z" are fine)
//   - releases:       normalizeRelease (GitHub "latest release" JSON -> the few fields OpenDJ uses, URLs checked)
//   - release notes:  notesSince (the "### New in X.Y" sections newer than the running version) and a summary
//   - Markdown:       parseMarkdown / renderMarkdown (a small safe subset, built as DOM nodes, never innerHTML)
//   - assets:         assetNamesFor / selectAsset (the installer for an OS / architecture / install kind)
//   - checksums:      parseSha256Sums (SHA256SUMS.txt of a release)
//   - prompting:      promptState / snoozeFor / skipFor ("Later" = 3 days or until a newer version)
//   - UpdateChecker:  the GitHub request itself (timeout, size cap, ETag / If-None-Match, rate-limit back-off)

export const REPO = 'Bucifer6/OpenDJ';
/** The only update source. Fixed: tests point the server elsewhere with OPENDJ_UPDATE_URL (loopback only). */
export const UPDATE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;
export const CHECK_INTERVAL_MS = 12 * 3600e3;
export const SNOOZE_MS = 3 * 86400e3;
/** Release JSON larger than this is refused (a release with ~40 assets and long notes is well under 200 KB). */
export const MAX_RELEASE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------- versions
const SEMVER = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9a-z-]+(?:\.[0-9a-z-]+)*))?(?:\+[0-9a-z.-]+)?$/i;

/** "v1.2.3-beta.1" -> { major, minor, patch, pre: ['beta', '1'] }, or null when it is not a version. */
export function parseVersion(v) {
  const m = SEMVER.exec(String(v ?? '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] } : null;
}
/** The version without "v" / build metadata ("v0.5.0" -> "0.5.0"), or null. */
export function cleanVersion(v) {
  const p = parseVersion(v);
  return p ? `${p.major}.${p.minor}.${p.patch}${p.pre.length ? `-${p.pre.join('.')}` : ''}` : null;
}
/** Semver order: <0 when a is older than b, 0 when equal, >0 when newer; NaN when either is not a version. */
export function compareVersions(a, b) {
  const x = typeof a === 'object' && a ? a : parseVersion(a), y = typeof b === 'object' && b ? b : parseVersion(b);
  if (!x || !y) return NaN;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // a release is newer than its pre-releases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { if (+p !== +q) return +p - +q; continue; }
    if (pn !== qn) return pn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
export const isNewer = (a, b) => compareVersions(a, b) > 0;

// ---------------------------------------------------------------- URLs and asset names
const DOWNLOAD_PREFIX = `/${REPO}/releases/download/`;
/** Hosts GitHub redirects release downloads to. */
export const REDIRECT_HOSTS = new Set(['objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']);
/** The only asset file names OpenDJ downloads or links to (plus SHA256SUMS.txt). */
export const ASSET_NAME_RE = /^OpenDJ-(?:Setup-|Portable-)?\d{1,9}\.\d{1,9}\.\d{1,9}(?:-(?:x64|arm64|ia32|mac-x64|mac-arm64|mac-universal|linux-x86_64|linux-arm64|linux-amd64|linux-aarch64|linux-x64|android-release|android-debug-signed))?\.(?:exe|dmg|zip|AppImage|deb|rpm|tar\.gz|apk)$/;
export const SUMS_NAME = 'SHA256SUMS.txt';
export const isAssetName = (n) => typeof n === 'string' && (ASSET_NAME_RE.test(n) || n === SUMS_NAME);

const url = (u) => { try { return new URL(String(u)); } catch { return null; } };
const plainHttps = (u) => u && u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443');
/** https://api.github.com/repos/... (the update API; nothing else is ever requested by the checker). */
export function isUpdateApiUrl(s) { const u = url(s); return !!plainHttps(u) && u.hostname === 'api.github.com' && u.pathname.startsWith('/repos/'); }
/** A download of one of OpenDJ's release assets: https://github.com/Bucifer6/OpenDJ/releases/download/<tag>/<asset>. */
export function isReleaseDownloadUrl(s) {
  const u = url(s);
  if (!plainHttps(u) || u.hostname !== 'github.com' || !u.pathname.startsWith(DOWNLOAD_PREFIX) || u.search || u.hash) return false;
  const rest = u.pathname.slice(DOWNLOAD_PREFIX.length).split('/');
  if (rest.length !== 2) return false;
  let name; try { name = decodeURIComponent(rest[1]); } catch { return false; }
  return /^[\w.+-]{1,64}$/.test(decodeURIComponent(rest[0])) && isAssetName(name);
}
/** A hop GitHub may redirect a release download to (signed storage URLs). */
export function isAllowedRedirect(s) { const u = url(s); return !!plainHttps(u) && REDIRECT_HOSTS.has(u.hostname); }
/** OpenDJ's release pages: https://github.com/Bucifer6/OpenDJ/releases[/...]. */
export function isReleasePageUrl(s) { const u = url(s); return !!plainHttps(u) && u.hostname === 'github.com' && (u.pathname === `/${REPO}/releases` || u.pathname.startsWith(`/${REPO}/releases/`)); }
/** Asset name of a download URL, or null. */
export function assetNameOf(s) {
  if (!isReleaseDownloadUrl(s)) return null;
  return decodeURIComponent(new URL(s).pathname.split('/').pop());
}

// ---------------------------------------------------------------- releases
/**
 * GitHub's release JSON -> { version, tag, name, url, body, publishedAt, assets: [{ name, url, size }] }, or null for
 * drafts, pre-releases (flagged or by version) and anything that is not a release. Only asset names on the allow-list
 * with download URLs of this repository are kept; the release page URL is built from the tag, not taken from the JSON.
 */
export function normalizeRelease(r) {
  if (!r || typeof r !== 'object' || r.draft || r.prerelease) return null;
  const tag = typeof r.tag_name === 'string' ? r.tag_name.trim() : '';
  const p = parseVersion(tag);
  if (!p || p.pre.length) return null;
  const version = cleanVersion(tag);
  const assets = [];
  for (const a of (Array.isArray(r.assets) ? r.assets : []).slice(0, 300)) {
    const name = typeof a?.name === 'string' ? a.name : '';
    const u = typeof a?.browser_download_url === 'string' ? a.browser_download_url : '';
    if (!isAssetName(name) || !isReleaseDownloadUrl(u) || assetNameOf(u) !== name) continue;
    assets.push({ name, url: u, size: Number.isSafeInteger(a.size) && a.size > 0 ? a.size : 0 });
  }
  const published = typeof r.published_at === 'string' && !Number.isNaN(Date.parse(r.published_at)) ? new Date(r.published_at).toISOString() : null;
  return {
    version, tag,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 200) : `OpenDJ ${version}`,
    url: `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`,
    body: typeof r.body === 'string' ? r.body.slice(0, 200000) : '',
    publishedAt: published,
    assets,
  };
}

// ---------------------------------------------------------------- release notes
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const NEW_IN = /^(?:what'?s\s+)?new\s+in\s+(?:opendj\s+)?v?(\d{1,9}(?:\.\d{1,9}){0,2})\b/i;

/** The "New in X.Y" sections of a release body: [{ version, title, markdown }] (the download table is not one). */
export function notesSections(body) {
  const out = [];
  let cur = null, fence = false;
  const close = () => { if (cur) { out.push({ version: cur.version, title: cur.title, markdown: cur.lines.join('\n').trim() }); cur = null; } };
  for (const line of String(body || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      if (cur && level > cur.level) { cur.lines.push(line); continue; } // a sub-heading inside the section
      close();
      const m = NEW_IN.exec(h[2]);
      if (m) cur = { version: m[1], title: h[2].replace(/[*_`]/g, '').trim(), level, lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  close();
  return out;
}

/**
 * Is a section for `sectionVersion` ("0.5", "0.4.1") newer than the running `current` version? Compared at the
 * section's precision: "New in 0.4" is not new for 0.4.0, "New in 0.4.1" is.
 */
export function sectionIsNewer(sectionVersion, current) {
  const parts = String(sectionVersion).split('.').map(Number);
  const c = parseVersion(current);
  if (!c || parts.some((n) => !Number.isFinite(n))) return false;
  const cv = [c.major, c.minor, c.patch];
  for (let i = 0; i < parts.length; i++) if (parts[i] !== cv[i]) return parts[i] > cv[i];
  return false;
}

/** The sections of `body` that are newer than `current`, newest first as written. */
export const notesSince = (body, current) => notesSections(body).filter((s) => sectionIsNewer(s.version, current));

const stripInline = (s) => String(s).replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
/** Highlights of some sections: their bold headline lines ("**New look**"), else their first bullet points. */
export function notesSummary(sections, max = 4) {
  const heads = [], bullets = [];
  for (const s of sections) {
    for (const line of s.markdown.split('\n')) {
      const h = /^\s*\*\*(.+?)\*\*\s*$/.exec(line);
      if (h) heads.push(stripInline(h[1]));
      const b = /^\s*[-*+]\s+(.+)$/.exec(line);
      if (b && bullets.length < max) bullets.push(stripInline(b[1]).replace(/[.:]$/, ''));
    }
  }
  const list = (heads.length ? heads : bullets).filter(Boolean);
  return list.slice(0, max).map((x) => (x.length > 90 ? `${x.slice(0, 88)}…` : x));
}

// ---------------------------------------------------------------- safe Markdown subset
/** http(s) URLs only (absolute, no credentials): anything else (javascript:, data:, relative…) is not a link. */
export function safeLink(href) {
  const s = String(href || '').trim();
  if (!s || /[\s\u0000-\u001f\u007f<>"'`\\]/.test(s)) return null;
  const u = url(s);
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
  return u.href;
}

/** Inline Markdown -> tokens: { t: 'text' | 'strong' | 'em' | 'code' | 'link', v?, href?, c? }. HTML stays literal text. */
export function parseInline(src, depth = 0) {
  const s = String(src ?? '');
  const out = [];
  let text = '';
  const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = ''; } };
  let i = 0;
  while (i < s.length) {
    const ch = s[i], rest = s.slice(i);
    let m;
    if (ch === '\\' && /[\\`*_[\]()#+\-.!<>]/.test(s[i + 1] || '')) { text += s[i + 1]; i += 2; continue; }
    if (ch === '`' && (m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) { flush(); out.push({ t: 'code', v: m[2].trim() }); i += m[0].length; continue; }
    if (ch === '!' && (m = /^!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\)/.exec(rest))) { text += m[1]; i += m[0].length; continue; } // images: alt text only, never loaded
    if (ch === '[' && (m = /^\[((?:[^\][]|\[[^\]]*\])*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"]*")?\)/.exec(rest))) {
      const href = safeLink(m[2]);
      flush();
      const c = depth < 4 ? parseInline(m[1], depth + 1).filter((x) => x.t !== 'link') : [{ t: 'text', v: m[1] }];
      if (href) out.push({ t: 'link', href, c }); else out.push(...c);
      i += m[0].length; continue;
    }
    if (ch === '<' && (m = /^<(https?:\/\/[^\s<>]+)>/.exec(rest))) { const href = safeLink(m[1]); flush(); out.push(href ? { t: 'link', href, c: [{ t: 'text', v: m[1] }] } : { t: 'text', v: m[0] }); i += m[0].length; continue; }
    if ((ch === 'h') && /[\s(]$|^$/.test(s.slice(Math.max(0, i - 1), i)) && (m = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/.exec(rest))) {
      const href = safeLink(m[0]); flush(); out.push(href ? { t: 'link', href, c: [{ t: 'text', v: m[0] }] } : { t: 'text', v: m[0] }); i += m[0].length; continue;
    }
    if ((ch === '*' || (ch === '_' && !/\w/.test(s[i - 1] || ''))) && s[i + 1] === ch && (m = (ch === '*' ? /^\*\*(?=\S)([\s\S]*?\S)\*\*/ : /^__(?=\S)((?:(?!__)[\s\S])*?\S)__(?!\w)/).exec(rest))) {
      flush(); out.push({ t: 'strong', c: depth < 4 ? parseInline(m[1], depth + 1) : [{ t: 'text', v: m[1] }] }); i += m[0].length; continue;
    }
    if ((ch === '*' || (ch === '_' && !/\w/.test(s[i - 1] || ''))) && (m = (ch === '*' ? /^\*(?=[^\s*])([^*]*?[^\s*])\*/ : /^_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/).exec(rest))) {
      flush(); out.push({ t: 'em', c: depth < 4 ? parseInline(m[1], depth + 1) : [{ t: 'text', v: m[1] }] }); i += m[0].length; continue;
    }
    text += ch; i++;
  }
  flush();
  return out;
}

/**
 * Block Markdown -> [{ type: 'heading', level, c } | { type: 'p', c } | { type: 'ul' | 'ol', items: [{ c, depth }] }
 * | { type: 'code', v } | { type: 'hr' }]. Tables become plain lines (cells joined with " · "); HTML is text.
 */
export function parseMarkdown(md) {
  const blocks = [];
  let para = null, list = null, code = null;
  const end = () => {
    if (para) { blocks.push({ type: 'p', c: parseInline(para.join(' ')) }); para = null; }
    if (list) { blocks.push({ type: list.type, items: list.items.map((x) => ({ depth: x.depth, c: parseInline(x.text) })) }); list = null; }
  };
  for (const raw of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (code) { if (/^\s*(```|~~~)/.test(raw)) { blocks.push({ type: 'code', v: code.join('\n') }); code = null; } else code.push(raw); continue; }
    if (/^\s*(```|~~~)/.test(raw)) { end(); code = []; continue; }
    const line = raw.replace(/\t/g, '    ');
    if (!line.trim()) { end(); continue; }
    let m;
    if ((m = HEADING.exec(line.trim()))) { end(); blocks.push({ type: 'heading', level: m[1].length, c: parseInline(m[2]) }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { end(); blocks.push({ type: 'hr' }); continue; }
    if ((m = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line))) {
      const type = /\d/.test(m[2]) ? 'ol' : 'ul';
      if (para) end();
      if (list && list.type !== type && m[1].length < 2) end();
      list ||= { type, items: [] };
      list.items.push({ depth: Math.min(3, Math.floor(m[1].length / 2)), text: m[3] });
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) continue; // |---|---| separator row
      end(); blocks.push({ type: 'p', c: parseInline(line.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim()).filter(Boolean).join(' · ')) });
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items.at(-1).text += ` ${line.trim()}`; continue; } // continuation of a list item
    if (list) end();
    (para ||= []).push(line.trim().replace(/^>\s?/, ''));
  }
  if (code) blocks.push({ type: 'code', v: code.join('\n') });
  end();
  return blocks;
}

/**
 * Render Markdown into DOM nodes with `doc` (document): only createElement / createTextNode / setAttribute, and the
 * only attributes ever set are class and an http(s) href (+ target / rel). Returns a <div class="md">.
 * Headings start at `headingBase` (### -> h4 by default) so they sit under the dialog title.
 */
export function renderMarkdown(md, doc, { headingBase = 1 } = {}) {
  const make = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.setAttribute('class', cls); return e; };
  const inline = (parent, toks) => {
    for (const t of toks) {
      if (t.t === 'text') parent.appendChild(doc.createTextNode(t.v));
      else if (t.t === 'code') { const e = make('code'); e.appendChild(doc.createTextNode(t.v)); parent.appendChild(e); }
      else if (t.t === 'strong' || t.t === 'em') { const e = make(t.t); inline(e, t.c); parent.appendChild(e); }
      else if (t.t === 'link') {
        const href = safeLink(t.href);
        if (!href) { inline(parent, t.c); continue; }
        const a = make('a', 'md-link');
        a.setAttribute('href', href); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer');
        inline(a, t.c); parent.appendChild(a);
      }
    }
    return parent;
  };
  const root = make('div', 'md');
  for (const b of parseMarkdown(md)) {
    if (b.type === 'heading') root.appendChild(inline(make(`h${Math.min(6, Math.max(3, b.level + headingBase))}`), b.c));
    else if (b.type === 'p') root.appendChild(inline(make('p'), b.c));
    else if (b.type === 'hr') root.appendChild(make('hr'));
    else if (b.type === 'code') { const pre = make('pre'); const c = make('code'); c.appendChild(doc.createTextNode(b.v)); pre.appendChild(c); root.appendChild(pre); }
    else if (b.type === 'ul' || b.type === 'ol') {
      const l = make(b.type);
      for (const it of b.items) l.appendChild(inline(make('li', it.depth ? `d${it.depth}` : ''), it.c));
      root.appendChild(l);
    }
  }
  return root;
}

// ---------------------------------------------------------------- assets
/**
 * File names of the installer for an install kind, best first.
 * kind: 'nsis' | 'portable' | 'dmg' | 'appimage' | 'deb' | 'rpm' | 'targz' | 'apk'; arch: 'x64' | 'arm64'.
 */
export function assetNamesFor(version, { kind, arch = 'x64' } = {}) {
  const v = cleanVersion(version);
  if (!v) return [];
  const arm = arch === 'arm64';
  switch (kind) {
    case 'nsis': return [`OpenDJ-Setup-${v}-${arm ? 'arm64' : 'x64'}.exe`, `OpenDJ-Setup-${v}.exe`];
    case 'portable': return [`OpenDJ-Portable-${v}.exe`];
    case 'dmg': return [`OpenDJ-${v}-mac-${arm ? 'arm64' : 'x64'}.dmg`];
    case 'appimage': return [`OpenDJ-${v}-linux-${arm ? 'arm64' : 'x86_64'}.AppImage`];
    case 'deb': return [`OpenDJ-${v}-linux-${arm ? 'arm64' : 'amd64'}.deb`];
    case 'rpm': return [`OpenDJ-${v}-linux-${arm ? 'aarch64' : 'x86_64'}.rpm`];
    case 'targz': return [`OpenDJ-${v}-linux-${arm ? 'arm64' : 'x64'}.tar.gz`];
    case 'apk': return [`OpenDJ-${v}-android-release.apk`, `OpenDJ-${v}-android-debug-signed.apk`];
    default: return [];
  }
}
/** The release asset for `target` ({ kind, arch }), or null. */
export function selectAsset(release, target) {
  if (!release?.assets?.length) return null;
  for (const n of assetNamesFor(release.version, target)) {
    const a = release.assets.find((x) => x.name === n);
    if (a) return a;
  }
  return null;
}

/** SHA256SUMS.txt -> Map(file name -> lowercase hex). Names listed twice with different sums are left out. */
export function parseSha256Sums(text) {
  const out = new Map(), bad = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([0-9a-f]{64})\s+\*?(?:\.\/)?(\S(?:.*\S)?)\s*$/i.exec(line);
    if (!m) continue;
    const name = m[2], sum = m[1].toLowerCase();
    if (out.has(name) && out.get(name) !== sum) bad.add(name);
    out.set(name, sum);
  }
  for (const n of bad) out.delete(n);
  return out;
}

// ---------------------------------------------------------------- prompting ("Later" / "Skip this version")
/**
 * Should the prompt be shown for `latest`?  -> 'prompt' | 'snoozed' | 'skipped' | 'none'
 * snooze: { version, until } after "Later" (3 days, or until a newer version than the one dismissed appears);
 *         { version, skip: true } after "Skip this version" (until a newer version appears).
 */
export function promptState({ latest, current, snooze, now = Date.now() }) {
  if (!isNewer(latest, current)) return 'none';
  if (snooze && typeof snooze === 'object' && parseVersion(snooze.version) && !isNewer(latest, snooze.version)) {
    if (snooze.skip) return 'skipped';
    if (Number(snooze.until) > now) return 'snoozed';
  }
  return 'prompt';
}
export const snoozeFor = (version, now = Date.now(), ms = SNOOZE_MS) => ({ version: cleanVersion(version), until: now + ms });
export const skipFor = (version) => ({ version: cleanVersion(version), skip: true });

// ---------------------------------------------------------------- the check
/** Response body as text, refusing more than `max` bytes (streamed when possible). */
async function readCapped(res, max) {
  const len = Number(res.headers?.get?.('content-length'));
  if (len > max) throw Object.assign(new Error('Response too large'), { code: 'too-large' });
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const chunks = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) { reader.cancel().catch(() => {}); throw Object.assign(new Error('Response too large'), { code: 'too-large' }); }
      chunks.push(value);
    }
    const all = new Uint8Array(n); let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.byteLength; }
    return new TextDecoder().decode(all);
  }
  const t = await res.text();
  if (t.length > max) throw Object.assign(new Error('Response too large'), { code: 'too-large' });
  return t;
}

/** What the UI needs about a release (notes newer than `current`, summary, page, assets). */
export function releaseInfo(release, current) {
  if (!release) return null;
  const notes = notesSince(release.body, current);
  return {
    version: release.version, tag: release.tag, name: release.name, url: release.url, publishedAt: release.publishedAt,
    notes, summary: notesSummary(notes), assets: release.assets,
  };
}

/**
 * Checks GitHub's latest release. Never throws: failures (offline, rate limit, bad data) are reported in `error`.
 *   fetch          fetch-compatible function (Node fetch on the server, CapacitorHttp / window.fetch on phones)
 *   version        the running version
 *   conditional    send If-None-Match / API headers ourselves (server, native app). Plain browsers leave the ETag
 *                  revalidation to their HTTP cache and send no extra headers, so no CORS preflight is needed.
 *   userAgent      send "User-Agent: OpenDJ/<version>" (browsers do not allow setting it)
 *   allowUrl       (url) => boolean; the request is refused otherwise (default: api.github.com only)
 *   minIntervalMs  results are reused for this long (a forced check: at least 30 s)
 */
export class UpdateChecker {
  constructor({ fetch, version, url: u = UPDATE_URL, conditional = true, userAgent = true, allowUrl = isUpdateApiUrl, timeoutMs = 10000,
    maxBytes = MAX_RELEASE_BYTES, minIntervalMs = 15 * 60e3, now = () => Date.now() } = {}) {
    Object.assign(this, { fetchFn: fetch, version: cleanVersion(version) || '0.0.0', url: u, conditional, userAgent, allowUrl, timeoutMs, maxBytes, minIntervalMs, now });
    this.release = null; this.etag = null; this.checkedAt = 0; this.error = null; this.blockedUntil = 0; this.pending = null; this.requests = 0;
  }

  /** The last normalized release (or null). */
  latest() { return this.release; }

  result() {
    const r = this.release;
    return {
      ok: !this.error, error: this.error, checkedAt: this.checkedAt || null, current: this.version,
      available: !!(r && isNewer(r.version, this.version)), latest: releaseInfo(r, this.version),
    };
  }

  async check({ force = false } = {}) {
    if (this.pending) return this.pending;
    const age = this.now() - this.checkedAt;
    if (this.checkedAt && age < (force ? Math.min(30e3, this.minIntervalMs) : this.minIntervalMs)) return this.result();
    if (this.blockedUntil > this.now()) return this.result();
    this.pending = this.fetchLatest().finally(() => { this.pending = null; });
    return this.pending;
  }

  async fetchLatest() {
    if (!this.allowUrl(this.url)) { this.error = 'blocked'; return this.result(); }
    const headers = { Accept: 'application/vnd.github+json' };
    if (this.conditional) { headers['X-GitHub-Api-Version'] = '2022-11-28'; if (this.etag) headers['If-None-Match'] = this.etag; }
    if (this.userAgent) headers['User-Agent'] = `OpenDJ/${this.version}`;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), this.timeoutMs);
    this.requests++;
    try {
      const res = await this.fetchFn(this.url, { method: 'GET', headers, signal: ctrl?.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
      this.checkedAt = this.now();
      if (res.status === 304) { this.error = null; return this.result(); }
      if (res.status === 403 || res.status === 429) {
        const reset = Number(res.headers?.get?.('x-ratelimit-reset')) * 1000, retry = Number(res.headers?.get?.('retry-after')) * 1000;
        const until = retry > 0 ? this.now() + retry : reset > this.now() ? reset : this.now() + 30 * 60e3;
        this.blockedUntil = Math.min(until, this.now() + 6 * 3600e3);
        this.error = 'rate-limited';
        return this.result();
      }
      if (res.status === 404) { this.release = null; this.etag = null; this.error = null; return this.result(); } // no release yet
      if (!res.ok) { this.error = `http-${res.status}`; return this.result(); }
      const text = await readCapped(res, this.maxBytes);
      let json;
      try { json = JSON.parse(text); } catch { this.error = 'bad-response'; return this.result(); }
      this.release = normalizeRelease(json);
      this.etag = (this.conditional && res.headers?.get?.('etag')) || null;
      this.error = null;
      return this.result();
    } catch (e) {
      this.checkedAt = this.now();
      this.error = e?.code === 'too-large' ? 'too-large' : ctrl?.signal.aborted ? 'timeout' : 'offline';
      return this.result();
    } finally { clearTimeout(timer); }
  }
}

// ---------------------------------------------------------------- "Update now" per platform (the page's side)
const httpsOnly = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) && safeLink(u)) || '';
/**
 * What "Update now" does here.
 *   env: { electron, local, native, os ('android' | 'ios' | 'web'), hosted }
 *   config: UPDATE_CONFIG (channel, playUrl, appStoreUrl, testFlightUrl)
 * -> { type: 'electron' }                       desktop app: the main process downloads / installs (IPC)
 *  | { type: 'instructions', kind: 'hosted' | 'server', url }   self-hosted web app: how to update the server
 *  | { type: 'open', url, kind: 'apk' | 'play' | 'appstore' | 'testflight' | 'page' }
 */
export function chooseUpdateAction(release, env = {}, config = {}) {
  const page = release?.url && isReleasePageUrl(release.url) ? release.url : LATEST_RELEASE_URL;
  if (env.electron) return { type: 'electron' };
  if (!env.local) return { type: 'instructions', kind: env.hosted ? 'hosted' : 'server', url: page };
  if (env.native && env.os === 'android') {
    if (config.channel === 'play' && httpsOnly(config.playUrl)) return { type: 'open', kind: 'play', url: httpsOnly(config.playUrl) };
    const apk = selectAsset(release, { kind: 'apk' });
    return apk ? { type: 'open', kind: 'apk', url: apk.url, name: apk.name } : { type: 'open', kind: 'page', url: page };
  }
  if (env.native && env.os === 'ios') {
    if (config.channel === 'appstore' && httpsOnly(config.appStoreUrl)) return { type: 'open', kind: 'appstore', url: httpsOnly(config.appStoreUrl) };
    if (httpsOnly(config.testFlightUrl)) return { type: 'open', kind: 'testflight', url: httpsOnly(config.testFlightUrl) };
    if (httpsOnly(config.appStoreUrl)) return { type: 'open', kind: 'appstore', url: httpsOnly(config.appStoreUrl) };
  }
  return { type: 'open', kind: 'page', url: page };
}
