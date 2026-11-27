// Detect mounted drives: USB sticks, external disks and network shares (NAS via SMB/NFS/AFP/SSHFS).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NETWORK_FS = new Set(['cifs', 'smb3', 'smbfs', 'nfs', 'nfs4', 'afpfs', 'fuse.sshfs', 'fuse.rclone', 'davfs', 'fuse.gvfsd-fuse', '9p']);

function linuxDrives() {
  let mounts = '';
  try { mounts = fs.readFileSync('/proc/mounts', 'utf8'); } catch { return []; }
  const out = [];
  for (const line of mounts.split('\n')) {
    const [dev, mnt, type] = line.split(' ');
    if (!mnt) continue;
    const mountPoint = mnt.replace(/\\040/g, ' ');
    const isNet = NETWORK_FS.has(type);
    const isRemovable = /^\/(media|run\/media|mnt)\//.test(mountPoint);
    if (!isNet && !isRemovable) continue;
    if (!isNet && (!dev.startsWith('/dev/') || ['squashfs', 'tmpfs', 'overlay', 'proc', 'sysfs'].includes(type))) continue;
    out.push({ path: mountPoint, name: path.basename(mountPoint), kind: isNet ? 'network' : 'usb', fs: type, device: dev });
  }
  return out;
}

function macDrives() {
  try {
    return fs.readdirSync('/Volumes').filter((n) => !n.startsWith('.')).map((n) => {
      const p = path.join('/Volumes', n);
      let kind = 'usb';
      try { if (fs.realpathSync(p) === '/') kind = 'system'; } catch { /* ignore */ }
      return { path: p, name: n, kind };
    }).filter((d) => d.kind !== 'system');
  } catch { return []; }
}

function windowsDrives() {
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const p = `${letter}:\\`;
    try { fs.accessSync(p); out.push({ path: p, name: `${letter}:`, kind: letter === 'C' ? 'system' : 'drive' }); } catch { /* none */ }
  }
  return out;
}

async function windowsDrivesAsync() {
  const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  const res = await Promise.all(letters.map(async (letter) => {
    const p = `${letter}:\\`;
    try { await fs.promises.access(p); return { path: p, name: `${letter}:`, kind: letter === 'C' ? 'system' : 'drive' }; }
    catch { return null; }
  }));
  return res.filter(Boolean);
}

export function listDrives() {
  const plat = os.platform();
  const drives = plat === 'win32' ? windowsDrives() : plat === 'darwin' ? macDrives() : linuxDrives();
  const home = os.homedir();
  const music = [path.join(home, 'Music'), path.join(home, 'Downloads')].filter((p) => fs.existsSync(p))
    .map((p) => ({ path: p, name: path.basename(p), kind: 'home' }));
  return [...music, ...drives];
}

/** Non-blocking drive enumeration (prevents sleeping/disconnected Windows drives from stalling the event loop). */
export async function listDrivesAsync() {
  const plat = os.platform();
  const drives = plat === 'win32' ? await windowsDrivesAsync() : plat === 'darwin' ? macDrives() : linuxDrives();
  const home = os.homedir();
  const candidates = [path.join(home, 'Music'), path.join(home, 'Downloads')];
  const music = (await Promise.all(candidates.map(async (p) => {
    try { await fs.promises.access(p); return { path: p, name: path.basename(p), kind: 'home' }; } catch { return null; }
  }))).filter(Boolean);
  return [...music, ...drives];
}

/** Directory listing for the in-app folder picker (used when no native dialog is available). */
export function browseDir(dir) {
  const target = dir ? path.resolve(dir) : os.homedir();
  const entries = fs.readdirSync(target, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return { path: target, parent: parent !== target ? parent : null, entries };
}
