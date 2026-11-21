// File storage for the on-device backend: imported audio, cover art, waveforms, recordings, downloads.
//
//   MemoryFS  tests (node --test) and a last resort
//   OpfsFS    plain browsers (Origin Private File System) - the ?local=1 test mode
//   IdbFS     browsers without OPFS writes (Blobs in IndexedDB)
//   NativeFS  the iOS / Android app (@capacitor/filesystem, app data directory); media is read through the WebView's
//             own file server (Capacitor.convertFileSrc), so big files are streamed, not copied through the JS bridge.
//
// Paths are relative keys like "music/ab12cd.mp3": letters, digits, '.', '_', '-' and '/' only, no '..'.
// Interface (all async unless noted):
//   write(path, data)          data: Blob | Uint8Array | ArrayBuffer | string (replaces the file)
//   appender(path, { headerBytes }) -> { write(bytes), close(header?) }: sequential appends (recordings), committed on
//                              close(); `headerBytes` reserves room at the start that close(header) fills in (WAV sizes)
//   read(path)                 -> Blob | null
//   response(path, type)       -> Response | null (for the fetch shim; streams where the platform can)
//   stat(path)                 -> { size, mtime } | null
//   delete(path), list(dir)    -> [{ name, size }]
//   url(path)                  -> URL the page can use in <audio>/<img>/fetch (blob: or capacitor file URL) | null
//   urlSync(path)              -> the same when known without waiting (always on native; cached in browsers) | null

const SEG = /^[\w.-]+$/;
export function checkPath(p) {
  const s = String(p || '');
  const parts = s.split('/');
  if (!s || s.length > 400 || parts.some((x) => !x || x === '.' || x === '..' || !SEG.test(x))) throw new Error(`Bad storage path: ${s.slice(0, 80)}`);
  return parts;
}
const dirOf = (p) => p.split('/').slice(0, -1).join('/');
const toBlob = (data, type = '') => (data instanceof Blob ? data : new Blob([data], { type }));
const toBytes = async (data) => (data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data)
  : typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(await data.arrayBuffer()));

class UrlCache {
  constructor() { this.map = new Map(); }
  get(p) { return this.map.get(p) || null; }
  set(p, blob) { this.drop(p); const u = URL.createObjectURL(blob); this.map.set(p, u); return u; }
  drop(p) { const u = this.map.get(p); if (u) { URL.revokeObjectURL(u); this.map.delete(p); } }
}

// ------------------------------------------------------------------ memory
export class MemoryFS {
  constructor() { this.files = new Map(); this.urls = new UrlCache(); this.kind = 'memory'; }
  async write(p, data) { checkPath(p); this.urls.drop(p); this.files.set(p, { blob: toBlob(data), mtime: Date.now() }); }
  appender(p, { headerBytes = 0 } = {}) {
    checkPath(p);
    const parts = [new Uint8Array(headerBytes)];
    this.files.set(p, { blob: new Blob(parts), mtime: Date.now() });
    return {
      write: async (bytes) => { parts.push(bytes.slice()); this.files.set(p, { blob: new Blob(parts), mtime: Date.now() }); },
      close: async (header) => { if (header && headerBytes) { parts[0] = header.slice(0, headerBytes); this.files.set(p, { blob: new Blob(parts), mtime: Date.now() }); } },
    };
  }
  async read(p) { checkPath(p); return this.files.get(p)?.blob || null; }
  async response(p, type) { const b = await this.read(p); return b ? new Response(b, { headers: { 'Content-Type': type || 'application/octet-stream', 'Content-Length': String(b.size) } }) : null; }
  async stat(p) { checkPath(p); const f = this.files.get(p); return f ? { size: f.blob.size, mtime: f.mtime } : null; }
  async delete(p) { checkPath(p); this.urls.drop(p); this.files.delete(p); }
  async list(dir) {
    const pre = dir ? `${dir}/` : '';
    return [...this.files.entries()].filter(([k]) => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map(([k, f]) => ({ name: k.slice(pre.length), size: f.blob.size, mtime: f.mtime }));
  }
  async url(p) { const b = await this.read(p); return b ? this.urls.get(p) || this.urls.set(p, b) : null; }
  urlSync(p) { return this.urls.get(p); }
  async usage() { let used = 0; for (const f of this.files.values()) used += f.blob.size; return { used, quota: null }; }
}

// ------------------------------------------------------------------ OPFS
export class OpfsFS {
  static supported() { return !!(globalThis.navigator?.storage?.getDirectory && globalThis.FileSystemFileHandle?.prototype?.createWritable); }
  constructor(rootName = 'opendj') { this.rootName = rootName; this.urls = new UrlCache(); this.kind = 'opfs'; this._root = null; }
  root() { return (this._root ||= navigator.storage.getDirectory().then((r) => r.getDirectoryHandle(this.rootName, { create: true }))); }
  async dir(path, create) {
    let d = await this.root();
    for (const seg of path ? path.split('/') : []) d = await d.getDirectoryHandle(seg, { create });
    return d;
  }
  async handle(p, create = false) {
    const parts = checkPath(p);
    try { const d = await this.dir(parts.slice(0, -1).join('/'), create); return await d.getFileHandle(parts.at(-1), { create }); } catch (e) {
      if (!create && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return null;
      throw e;
    }
  }
  async write(p, data) {
    this.urls.drop(p);
    const w = await (await this.handle(p, true)).createWritable();
    try { await w.write(data instanceof Blob ? data : await toBytes(data)); await w.close(); } catch (e) { await w.abort?.().catch(() => {}); throw e; }
  }
  appender(p, { headerBytes = 0 } = {}) {
    this.urls.drop(p);
    const ready = this.handle(p, true).then(async (h) => { const w = await h.createWritable(); if (headerBytes) await w.write(new Uint8Array(headerBytes)); return w; });
    let chain = ready;
    return {
      write: (bytes) => (chain = chain.then(async () => { const w = await ready; await w.write(bytes); })),
      close: async (header) => {
        await chain;
        const w = await ready;
        if (header && headerBytes) await w.write({ type: 'write', position: 0, data: header.slice(0, headerBytes) });
        await w.close();
      },
    };
  }
  async read(p) { const h = await this.handle(p); return h ? h.getFile() : null; }
  async response(p, type) { const f = await this.read(p); return f ? new Response(f, { headers: { 'Content-Type': type || 'application/octet-stream', 'Content-Length': String(f.size) } }) : null; }
  async stat(p) { const f = await this.read(p); return f ? { size: f.size, mtime: f.lastModified } : null; }
  async delete(p) {
    const parts = checkPath(p);
    this.urls.drop(p);
    try { await (await this.dir(parts.slice(0, -1).join('/'), false)).removeEntry(parts.at(-1)); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
  }
  async list(dir) {
    if (dir) checkPath(dir);
    let d;
    try { d = await this.dir(dir || '', false); } catch { return []; }
    const out = [];
    for await (const [name, h] of d.entries()) if (h.kind === 'file') { const f = await h.getFile(); out.push({ name, size: f.size, mtime: f.lastModified }); }
    return out;
  }
  async url(p) { const hit = this.urls.get(p); if (hit) return hit; const f = await this.read(p); return f ? this.urls.set(p, f) : null; }
  urlSync(p) { return this.urls.get(p); }
  async usage() { const e = await navigator.storage.estimate?.(); return { used: e?.usage ?? null, quota: e?.quota ?? null }; }
}

// ------------------------------------------------------------------ IndexedDB blobs
export class IdbFS {
  constructor(dbName = 'opendj-files') { this.dbName = dbName; this.urls = new UrlCache(); this.kind = 'idb'; this._db = null; }
  db() {
    return (this._db ||= new Promise((resolve, reject) => {
      const o = indexedDB.open(this.dbName, 1);
      o.onupgradeneeded = () => o.result.createObjectStore('files');
      o.onsuccess = () => resolve(o.result); o.onerror = () => reject(o.error);
    }));
  }
  async op(mode, fn) {
    const t = (await this.db()).transaction('files', mode);
    const r = fn(t.objectStore('files'));
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
    return r?.result;
  }
  async write(p, data) { checkPath(p); this.urls.drop(p); const blob = toBlob(data); await this.op('readwrite', (s) => s.put({ blob, mtime: Date.now() }, p)); }
  appender(p, { headerBytes = 0 } = {}) {
    checkPath(p);
    const parts = [new Blob([new Uint8Array(headerBytes)])]; let chain = Promise.resolve();
    // IndexedDB has no appends: chunks are kept as Blobs (spooled to disk by the browser) and stored on close
    return {
      write: (bytes) => (chain = chain.then(() => { parts.push(new Blob([bytes])); })),
      close: async (header) => { await chain; if (header && headerBytes) parts[0] = new Blob([header.slice(0, headerBytes)]); await this.write(p, new Blob(parts)); },
    };
  }
  async rec(p) { checkPath(p); return this.op('readonly', (s) => s.get(p)); }
  async read(p) { return (await this.rec(p))?.blob || null; }
  async response(p, type) { const b = await this.read(p); return b ? new Response(b, { headers: { 'Content-Type': type || 'application/octet-stream', 'Content-Length': String(b.size) } }) : null; }
  async stat(p) { const r = await this.rec(p); return r ? { size: r.blob.size, mtime: r.mtime } : null; }
  async delete(p) { checkPath(p); this.urls.drop(p); await this.op('readwrite', (s) => s.delete(p)); }
  async list(dir) {
    const pre = dir ? `${dir}/` : '';
    const keys = (await this.op('readonly', (s) => s.getAllKeys())) || [];
    const out = [];
    for (const k of keys.map(String)) if (k.startsWith(pre) && !k.slice(pre.length).includes('/')) { const st = await this.stat(k); out.push({ name: k.slice(pre.length), ...st }); }
    return out;
  }
  async url(p) { const hit = this.urls.get(p); if (hit) return hit; const b = await this.read(p); return b ? this.urls.set(p, b) : null; }
  urlSync(p) { return this.urls.get(p); }
  async usage() { const e = await navigator.storage?.estimate?.(); return { used: e?.usage ?? null, quota: e?.quota ?? null }; }
}

// ------------------------------------------------------------------ Capacitor (iOS / Android)
const CHUNK = 3 * 1024 * 1024; // multiple of 3: base64 chunks never need padding in the middle
export const bytesToBase64 = (bytes) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(bytes instanceof Blob ? bytes : new Blob([bytes]));
});

export class NativeFS {
  /** @param {object} o  { Filesystem: plugin proxy, convertFileSrc(fileUri) => url, directory = 'DATA' } */
  constructor({ Filesystem, convertFileSrc, directory = 'DATA' }) {
    this.F = Filesystem; this.convert = convertFileSrc; this.directory = directory; this.kind = 'native'; this.base = null;
  }
  async init() {
    const { uri } = await this.F.getUri({ path: '', directory: this.directory });
    this.base = String(uri).replace(/\/+$/, '');
    return this;
  }
  /** Absolute file:// URI of a storage path (for plugins that take full paths). */
  fileUri(p) { checkPath(p); return `${this.base}/${p}`; }
  opts(p) { checkPath(p); return { path: p, directory: this.directory }; }
  async write(p, data) {
    const blob = toBlob(data);
    if (!blob.size) { await this.F.writeFile({ ...this.opts(p), data: '', recursive: true }); return; }
    for (let off = 0; off < blob.size; off += CHUNK) {
      const data64 = await bytesToBase64(blob.slice(off, off + CHUNK));
      if (off === 0) await this.F.writeFile({ ...this.opts(p), data: data64, recursive: true });
      else await this.F.appendFile({ ...this.opts(p), data: data64 });
    }
  }
  appender(p, { headerBytes = 0 } = {}) {
    // No random access through the plugin: with a header, the audio goes to "<path>.pcm" and close(header) writes the
    // final file (header + audio, streamed back in chunks) and removes the temporary one.
    const target = headerBytes ? `${p}.pcm` : p;
    let chain = this.F.writeFile({ ...this.opts(target), data: '', recursive: true });
    let pending = [], size = 0;
    const flush = () => {
      if (!pending.length) return chain;
      const blob = new Blob(pending); pending = []; size = 0;
      return (chain = chain.then(async () => this.F.appendFile({ ...this.opts(target), data: await bytesToBase64(blob) })));
    };
    return {
      // batch small chunks (~1 MB) so the JS bridge sees few, larger calls
      write: (bytes) => { pending.push(bytes.slice()); size += bytes.byteLength; return size >= 1 << 20 ? flush() : chain; },
      close: async (header) => {
        await flush(); await chain;
        if (!headerBytes) return;
        await this.F.writeFile({ ...this.opts(p), data: await bytesToBase64((header || new Uint8Array(headerBytes)).slice(0, headerBytes)), recursive: true });
        const r = await fetch(this.urlSync(target));
        const reader = r.body.getReader();
        let buf = [], n = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (value) { buf.push(value); n += value.byteLength; }
          if ((done && n) || n >= CHUNK) { await this.F.appendFile({ ...this.opts(p), data: await bytesToBase64(new Blob(buf)) }); buf = []; n = 0; }
          if (done) break;
        }
        await this.delete(target);
      },
    };
  }
  async response(p, type) {
    if (!(await this.stat(p))) return null;
    const r = await fetch(this.urlSync(p));
    if (!r.ok) return null;
    return type ? new Response(r.body, { headers: { 'Content-Type': type, ...(r.headers.get('content-length') ? { 'Content-Length': r.headers.get('content-length') } : {}) } }) : r;
  }
  async read(p) { const r = await this.response(p); return r ? r.blob() : null; }
  async stat(p) {
    try { const s = await this.F.stat(this.opts(p)); return s.type === 'directory' ? null : { size: Number(s.size) || 0, mtime: Number(s.mtime) || 0 }; } catch { return null; }
  }
  async delete(p) { try { await this.F.deleteFile(this.opts(p)); } catch { /* already gone */ } }
  async list(dir) {
    try {
      const r = await this.F.readdir({ path: dir || '', directory: this.directory });
      return (r.files || []).filter((f) => f.type !== 'directory').map((f) => ({ name: f.name, size: Number(f.size) || 0, mtime: Number(f.mtime) || 0 }));
    } catch { return []; }
  }
  urlSync(p) { return this.convert(this.fileUri(p)); }
  async url(p) { return (await this.stat(p)) ? this.urlSync(p) : null; }
  async usage() { return { used: null, quota: null }; }
}

/** The best file storage for this page. */
export async function createFileStore({ native } = {}) {
  if (native) return new NativeFS(native).init();
  if (OpfsFS.supported()) {
    try { const f = new OpfsFS(); await f.root(); return f; } catch { /* private mode etc. */ }
  }
  if (globalThis.indexedDB) return new IdbFS();
  return new MemoryFS();
}

export { dirOf };
