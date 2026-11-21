// Desktop "Update now": everything that downloads or starts an installer runs here, in the main process, never in
// the page. The page can only ask (through validated IPC, see main.js) for: info, download, install, cancel.
//
//   Windows installer (NSIS)  download OpenDJ-Setup-<v>-<arch>.exe, verify, then on "Restart to update" start it
//                             and quit (the builds are unsigned, so there is no silent self-update; the familiar
//                             installer runs and keeps the install folder)
//   Windows portable          download OpenDJ-Portable-<v>.exe, verify, show it in its folder
//   Linux AppImage            download next to the running AppImage, verify, then on "Restart to update" replace it
//                             (same path, so launchers keep working) and restart
//   macOS                     download the .dmg for the architecture, verify, open it ("drag OpenDJ to Applications");
//                             Squirrel auto-update needs code signing, which the builds do not have
//   .deb / .rpm / .tar.gz     open the package download in the browser and show the install command (the package
//                             manager needs administrator rights, which OpenDJ should not ask for)
//   running from source       open the release page
//
// Every download is checked against the release's SHA256SUMS.txt: a missing entry or a different hash deletes the
// file and refuses to go on. Only https://github.com/Bucifer6/OpenDJ/releases/download/... URLs are fetched, redirects
// are followed by hand and only to GitHub's release storage hosts, file names must match the asset allow-list, and
// the size is capped by what the release says.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { selectAsset, assetNamesFor, parseSha256Sums, isReleaseDownloadUrl, isAllowedRedirect, isAssetName, SUMS_NAME, RELEASES_URL } from '../public/js/shared/update-core.js';

const MAX_INSTALLER = 1536 * 1024 * 1024;
const MAX_SUMS = 256 * 1024;

/**
 * How this copy of OpenDJ was installed: 'nsis' | 'portable' | 'dmg' | 'appimage' | 'deb' | 'rpm' | 'targz' | 'source'.
 * @param o.platform process.platform  @param o.env process.env  @param o.execPath  @param o.packaged app.isPackaged
 * @param o.exists (path) => boolean
 */
export function installKind({ platform = process.platform, env = process.env, execPath = process.execPath, packaged = true, exists = fs.existsSync } = {}) {
  if (!packaged) return 'source';
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'nsis';
  if (platform === 'darwin') return 'dmg';
  if (platform === 'linux') {
    if (env.APPIMAGE) return 'appimage';
    // electron-builder's deb / rpm install to /opt/OpenDJ; a tar.gz runs from wherever it was unpacked
    if (/^\/opt\/OpenDJ\//.test(execPath)) {
      if (exists('/var/lib/dpkg/info/opendj.list')) return 'deb';
      if (exists('/usr/bin/rpm') && !exists('/usr/bin/dpkg')) return 'rpm';
      return exists('/usr/bin/dpkg') ? 'deb' : 'rpm';
    }
    return 'targz';
  }
  return 'source';
}
export const normArch = (a = process.arch) => (a === 'arm64' ? 'arm64' : 'x64');

/** Install command / instructions shown for the package kinds the app does not install itself. */
export function installHint(kind, file) {
  const f = file || '<file>';
  if (kind === 'deb') return { text: 'When the download finishes, install it with:', command: `sudo apt install ./${f}` };
  if (kind === 'rpm') return { text: 'When the download finishes, install it with:', command: `sudo dnf install ./${f}` };
  if (kind === 'targz') return { text: 'When the download finishes, unpack it and replace your OpenDJ folder with the new one:', command: `tar -xzf ${f}` };
  if (kind === 'source') return { text: 'Running from source: update your checkout.', command: 'git pull && npm ci' };
  return null;
}

/** What "Update now" does for this install (no network). */
export function updatePlan(release, { kind, arch }) {
  const asset = release ? selectAsset(release, { kind, arch }) : null;
  const action = kind === 'nsis' || kind === 'appimage' ? 'install' : kind === 'dmg' || kind === 'portable' ? 'download' : 'open';
  return { kind, arch, action, asset: asset ? { name: asset.name, size: asset.size } : null, expected: release ? assetNamesFor(release.version, { kind, arch })[0] || null : null };
}

function timeoutSignal(ms, outer) {
  const ctrl = new AbortController();
  let t = setTimeout(() => ctrl.abort(new Error('Download timed out')), ms);
  const onAbort = () => ctrl.abort(outer.reason || new Error('Cancelled'));
  outer?.addEventListener?.('abort', onAbort, { once: true });
  if (outer?.aborted) onAbort();
  return { signal: ctrl.signal, bump: () => { clearTimeout(t); t = setTimeout(() => ctrl.abort(new Error('Download stalled')), ms); }, done: () => { clearTimeout(t); outer?.removeEventListener?.('abort', onAbort); } };
}

/**
 * GET an asset URL, following redirects by hand: the first URL must be a release download of this repository, every
 * later hop one of GitHub's release storage hosts. Returns the final 200 Response.
 */
export async function fetchReleaseFile(url, { fetch = globalThis.fetch, signal, userAgent = 'OpenDJ', maxRedirects = 5 } = {}) {
  if (!isReleaseDownloadUrl(url)) throw new Error('Refused: not an OpenDJ release download');
  let u = url;
  for (let hop = 0; ; hop++) {
    const res = await fetch(u, { headers: { 'User-Agent': userAgent, Accept: 'application/octet-stream' }, redirect: 'manual', signal, credentials: 'omit' });
    const loc = res.headers?.get?.('location');
    if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      if (hop >= maxRedirects) throw new Error('Too many redirects');
      const next = new URL(loc, u).href;
      if (!isAllowedRedirect(next) && !isReleaseDownloadUrl(next)) throw new Error(`Refused redirect to ${new URL(next).hostname}`);
      u = next;
      continue;
    }
    if (res.status !== 200 || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
    return res;
  }
}

/**
 * Download `assetName` of `release` into `dir`, verified against the release's SHA256SUMS.txt.
 * Resolves { file, sha256 }; on any problem the partial file is deleted and the promise rejects.
 */
export async function downloadVerified({ release, assetName, dir, fetch = globalThis.fetch, onProgress, signal, userAgent, stallMs = 60000, fsp = fs.promises }) {
  if (!isAssetName(assetName) || assetName === SUMS_NAME || path.basename(assetName) !== assetName) throw new Error('Refused: unexpected file name');
  const asset = release?.assets?.find((a) => a.name === assetName);
  if (!asset) throw new Error(`${assetName} is not part of this release`);
  const sumsAsset = release.assets.find((a) => a.name === SUMS_NAME);
  if (!sumsAsset) throw new Error('This release has no SHA256SUMS.txt, so the download cannot be verified');
  const t = timeoutSignal(stallMs, signal);
  const part = path.join(dir, `.${assetName}.${crypto.randomBytes(4).toString('hex')}.part`);
  try {
    // 1. the checksum list
    const sres = await fetchReleaseFile(sumsAsset.url, { fetch, signal: t.signal, userAgent });
    const stext = await readLimited(sres, MAX_SUMS, t);
    const expected = parseSha256Sums(stext).get(assetName);
    if (!expected) throw new Error(`SHA256SUMS.txt has no entry for ${assetName}: not installing an unverified file`);
    // 2. the file, hashed while it streams to disk
    const res = await fetchReleaseFile(asset.url, { fetch, signal: t.signal, userAgent });
    const max = asset.size > 0 ? asset.size : MAX_INSTALLER;
    const total = Number(res.headers?.get?.('content-length')) || asset.size || 0;
    if (total > max) throw new Error('The download is larger than the release says');
    await fsp.mkdir(dir, { recursive: true });
    const out = await fsp.open(part, 'w', 0o644);
    const hash = crypto.createHash('sha256');
    let n = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        t.bump();
        n += value.byteLength;
        if (n > max) { reader.cancel().catch(() => {}); throw new Error('The download is larger than the release says'); }
        hash.update(value);
        await out.write(value);
        onProgress?.({ received: n, total });
      }
    } finally { await out.close(); }
    if (asset.size > 0 && n !== asset.size) throw new Error('The download is incomplete');
    const got = hash.digest('hex');
    if (got !== expected) throw new Error(`Checksum mismatch for ${assetName}: the file was deleted`);
    const final = path.join(dir, assetName);
    await fsp.rm(final, { force: true });
    await fsp.rename(part, final);
    return { file: final, sha256: got };
  } catch (e) {
    await fsp.rm(part, { force: true }).catch(() => {});
    throw e;
  } finally { t.done(); }
}

async function readLimited(res, max, t) {
  const reader = res.body.getReader();
  const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    t?.bump();
    n += value.byteLength;
    if (n > max) { reader.cancel().catch(() => {}); throw new Error('SHA256SUMS.txt is too large'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** SHA-256 of a file on disk (re-checked right before an installer is started). */
export async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file)) h.update(c);
  return h.digest('hex');
}

/** Replace the running AppImage with a verified download (same file system: an atomic rename). */
export async function replaceAppImage(downloaded, target, fsp = fs.promises) {
  await fsp.chmod(downloaded, 0o755);
  await fsp.rename(downloaded, target);
  return target;
}

/** Where downloads go: next to the AppImage when that folder is writable, else Downloads (or the temp folder). */
export function downloadDir(kind, { env = process.env, downloads, temp, writable = (d) => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } } } = {}) {
  if (kind === 'appimage' && env.APPIMAGE && writable(path.dirname(env.APPIMAGE))) return path.dirname(env.APPIMAGE);
  if (kind === 'nsis') return path.join(temp, 'opendj-update');
  return downloads || path.join(temp, 'opendj-update');
}

export { RELEASES_URL };
