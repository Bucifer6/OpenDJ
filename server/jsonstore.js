// Crash-safe JSON files: fsync'd atomic writes with a rolling .bak, and corrupt files are kept aside instead of
// being silently replaced by an empty library on the next save.
import fs from 'node:fs';

/**
 * Read a JSON file. Missing file -> { data: null }. Unparseable file -> it is renamed to `<file>.corrupt-<ts>`
 * and the `.bak` copy is used instead (if it parses); `error` describes what happened so the UI can be told.
 */
export function readJsonSafe(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') {
      const bak = tryParse(file + '.bak');
      return bak ? { data: bak, error: `${file} was missing; restored from backup copy` } : { data: null };
    }
    throw e; // EACCES etc: refuse to start rather than overwrite
  }
  try { return { data: JSON.parse(raw) }; } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, aside); } catch { /* keep going */ }
    const bak = tryParse(file + '.bak');
    return { data: bak, error: `${file} was damaged (${e.message}); it was kept as ${aside}${bak ? ' and the backup copy was loaded' : ''}` };
  }
}

function tryParse(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

/** Atomic write: tmp + fsync + rename, keeping the previous good version as `<file>.bak`. */
export function writeJsonAtomic(file, obj, { mode } = {}) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w', mode);
  try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); } catch { /* best effort */ }
  fs.renameSync(tmp, file);
}
