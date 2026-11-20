// electron-builder beforePack hook: make sure the bundled ffmpeg-static binary matches the architecture being
// packaged (e.g. arm64 builds made on an x64 runner). ffmpeg-static only downloads the build machine's binary.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'arm', 3: 'arm64' };

// SHA-256 of the (gunzipped) ffmpeg binaries ffmpeg-static downloads, per release tag and target. Taken from the
// actual GitHub release assets (github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1); the linux-x64 value also
// matches the binary `npm install` fetched. A new ffmpeg-static release needs new values here (the build fails
// rather than bundling an unverified binary). b6.1.1 has no win32-arm64 build: that package uses a system ffmpeg.
const FFMPEG_SHA256 = {
  'b6.1.1': {
    'linux-x64': 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99',
    'linux-arm64': '6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce',
    'darwin-x64': 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894',
    'darwin-arm64': 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
    'win32-x64': '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
  },
};

/** Environment for ffmpeg-static's install.js: the download location / release / output path can't be redirected. */
function installEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ['FFMPEG_BINARIES_URL', 'FFMPEG_BINARY_RELEASE', 'FFMPEG_BIN']) delete env[k];
  return env;
}

/** Throws (after removing the binary) unless the downloaded ffmpeg matches the pinned hash for this target. */
function verifyFfmpeg(dir, target) {
  const tag = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))['ffmpeg-static']?.['binary-release-tag'];
  const want = FFMPEG_SHA256[tag]?.[target];
  const bin = ['ffmpeg', 'ffmpeg.exe'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!bin) return false;
  const got = crypto.createHash('sha256').update(fs.readFileSync(bin)).digest('hex');
  if (got !== want) {
    fs.rmSync(bin, { force: true });
    throw new Error(`ffmpeg ${tag} ${target}: SHA-256 ${got} does not match the pinned ${want || '(none: add it to build/before-pack.cjs)'}`);
  }
  return true;
}

exports.default = async function beforePack(context) {
  const install = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'install.js');
  if (!fs.existsSync(install)) return; // optional dependency not installed: app falls back to system ffmpeg
  const arch = ARCH[context.arch];
  const platform = context.electronPlatformName;
  if (!arch) return;
  const marker = path.join(path.dirname(install), '.opendj-target');
  const want = `${platform}-${arch}`;
  console.log(`  • fetching ffmpeg for ${want}`);
  const dir = path.dirname(install);
  for (const f of ['ffmpeg', 'ffmpeg.exe']) fs.rmSync(path.join(dir, f), { force: true }); // install.js skips if present
  try {
    execFileSync(process.execPath, [install], { stdio: 'inherit', env: installEnv({ npm_config_arch: arch, npm_config_platform: platform }) });
  } catch (e) {
    for (const f of ['ffmpeg', 'ffmpeg.exe']) fs.rmSync(path.join(dir, f), { force: true });
    console.warn(`  • could not fetch ffmpeg for ${want} (${e.message}); the app will use a system ffmpeg if present`);
    return;
  }
  verifyFfmpeg(dir, want); // a wrong binary fails the build
  fs.writeFileSync(marker, want);
};

/** Put the build machine's own binary back after packaging (used as afterAllArtifactBuild). */
exports.restoreHost = function restoreHost() {
  const install = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'install.js');
  if (!fs.existsSync(install)) return [];
  const dir = path.dirname(install), marker = path.join(dir, '.opendj-target');
  const host = `${process.platform}-${process.arch}`;
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') !== host) {
    for (const f of ['ffmpeg', 'ffmpeg.exe']) fs.rmSync(path.join(dir, f), { force: true });
    try { execFileSync(process.execPath, [install], { stdio: 'inherit', env: installEnv() }); verifyFfmpeg(dir, host); fs.writeFileSync(marker, host); } catch (e) { console.warn(`  • ${e.message}`); }
  }
  return [];
};

exports.verifyFfmpeg = verifyFfmpeg;
exports.installEnv = installEnv;
