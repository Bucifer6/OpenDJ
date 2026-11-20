// Prepares the mobile app's web assets: copies public/ (the same UI as the desktop and web app) to mobile/www, the
// Capacitor webDir, then runs `npx cap sync` (copies them into the Android / iOS projects and updates native plugins).
// The desktop app and the server keep serving public/ directly; mobile/www is generated (git-ignored).
// Usage: node scripts/mobile-sync.mjs [--no-cap] [android|ios]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'public');
const out = path.join(root, 'mobile', 'www');
// not used inside the app: the hosted-mode login page and the PWA service worker
const SKIP = new Set(['login.html', 'sw.js']);

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true, filter: (p) => !SKIP.has(path.relative(src, p)) && !p.endsWith('.map') });
let files = 0, bytes = 0;
(function count(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) count(p); else { files++; bytes += fs.statSync(p).size; } } })(out);
console.log(`mobile/www: ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);

if (!process.argv.includes('--no-cap')) {
  const platform = process.argv.slice(2).find((a) => a === 'android' || a === 'ios');
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['cap', 'sync', ...(platform ? [platform] : [])], { cwd: root, stdio: 'inherit' });
}
