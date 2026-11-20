// Uploads: recognise a file that is already in the library (same size + same SHA-256), so uploading the same
// file twice returns the existing track instead of creating "name (2).ext" and a duplicate library entry.
import fs from 'node:fs';
import crypto from 'node:crypto';

export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * The library track whose local file is byte-identical to `file` (size `size`, SHA-256 `hash`), or null.
 * Only tracks with the same size are hashed, so this stays cheap for big libraries.
 */
export async function findIdenticalTrack(library, { size, hash }) {
  for (const t of library.allTracks()) {
    const p = t.sourceType === 'local' ? t.path : t.localPath;
    if (!p || Number(t.size) !== size) continue;
    const st = await fs.promises.stat(p).catch(() => null);
    if (!st?.isFile() || st.size !== size) continue;
    if ((await hashFile(p).catch(() => null)) === hash) return t;
  }
  return null;
}
