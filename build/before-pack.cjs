// electron-builder beforePack hook: make sure the bundled ffmpeg-static binary matches the architecture being
// packaged (e.g. arm64 builds made on an x64 runner). ffmpeg-static only downloads the build machine's binary.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'arm', 3: 'arm64' };

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
    execFileSync(process.execPath, [install], { stdio: 'inherit', env: { ...process.env, npm_config_arch: arch, npm_config_platform: platform } });
    fs.writeFileSync(marker, want);
  } catch (e) {
    console.warn(`  • could not fetch ffmpeg for ${want} (${e.message}); the app will use a system ffmpeg if present`);
  }
};

/** Put the build machine's own binary back after packaging (used as afterAllArtifactBuild). */
exports.restoreHost = function restoreHost() {
  const install = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'install.js');
  if (!fs.existsSync(install)) return [];
  const dir = path.dirname(install), marker = path.join(dir, '.opendj-target');
  const host = `${process.platform}-${process.arch}`;
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') !== host) {
    for (const f of ['ffmpeg', 'ffmpeg.exe']) fs.rmSync(path.join(dir, f), { force: true });
    try { execFileSync(process.execPath, [install], { stdio: 'inherit' }); fs.writeFileSync(marker, host); } catch { /* best effort */ }
  }
  return [];
};
