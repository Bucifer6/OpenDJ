// Hand a file the user exported (playlist, rekordbox XML, backup, setlist, recording) to them:
//   - in the app: the system share sheet (Save to Files, AirDrop, mail, Google Drive…) via @capacitor/share
//   - in a browser: the Web Share API on touch devices that support sharing files, else a normal download
import { keySafe } from './media.js';

let nativeShare = null; // set by index.js in the app: (blob, name) => Promise
export function setNativeShare(fn) { nativeShare = fn; }

export async function saveOrShare(blob, name) {
  name = String(name || 'export').replace(/[\\/]+/g, '_').slice(0, 180);
  if (nativeShare) return nativeShare(blob, name);
  const file = typeof File === 'function' ? new File([blob], name, { type: blob.type || 'application/octet-stream' }) : null;
  const touch = globalThis.matchMedia?.('(pointer: coarse)').matches;
  if (touch && file && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name, rel: 'noopener' });
  a.dataset.opendjExport = '1';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

/** Share through @capacitor/share: the file is written to exports/ in app storage first (the share sheet needs a file). */
export function makeNativeShare({ fs, Share }) {
  return async (blob, name) => {
    for (const f of await fs.list('exports')) await fs.delete(`exports/${f.name}`).catch(() => {});
    const dot = name.lastIndexOf('.');
    const path = `exports/${keySafe(dot > 0 ? name.slice(0, dot) : name, 120)}${dot > 0 ? '.' + keySafe(name.slice(dot + 1), 8) : ''}`;
    await fs.write(path, blob);
    try { await Share.share({ title: name, files: [fs.fileUri(path)], dialogTitle: `Export ${name}` }); return 'shared'; } catch (e) {
      if (/cancel/i.test(String(e?.message))) return 'cancelled';
      throw e;
    }
  };
}

/** File name from a Content-Disposition header. */
export function dispositionName(h) {
  if (!h) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(h);
  if (star) { try { return decodeURIComponent(star[1]); } catch { /* fall through */ } }
  const plain = /filename="([^"]+)"/i.exec(h);
  return plain ? plain[1] : null;
}
