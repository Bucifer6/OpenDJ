// Key-value storage for the on-device backend: library JSON, settings, history, recording config, lyrics.
// IndexedDB in the app (and in browsers); an in-memory map for tests. Values are structured-cloned.
// Everything stays inside the app's own storage (the WebView origin); nothing here is ever sent off the device.

export class MemoryKV {
  constructor(init = {}) { this.map = new Map(Object.entries(init)); }
  async get(key) { return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined; }
  async set(key, value) { this.map.set(key, structuredClone(value)); }
  async del(key) { this.map.delete(key); }
  async keys(prefix = '') { return [...this.map.keys()].filter((k) => k.startsWith(prefix)); }
}

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

export class IdbKV {
  constructor(dbName = 'opendj', store = 'kv') { this.dbName = dbName; this.store = store; this._db = null; }
  db() {
    if (!this._db) {
      this._db = new Promise((resolve, reject) => {
        const open = indexedDB.open(this.dbName, 1);
        open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(this.store)) open.result.createObjectStore(this.store); };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
        open.onblocked = () => reject(new Error('The app storage is in use by another tab'));
      });
    }
    return this._db;
  }
  async tx(mode, fn) {
    const db = await this.db();
    const t = db.transaction(this.store, mode);
    const out = fn(t.objectStore(this.store));
    await new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error || new Error('Storage transaction aborted')); });
    return out instanceof IDBRequest ? out.result : out;
  }
  async get(key) { const db = await this.db(); return req(db.transaction(this.store).objectStore(this.store).get(key)); }
  set(key, value) { return this.tx('readwrite', (s) => s.put(value, key)); }
  del(key) { return this.tx('readwrite', (s) => s.delete(key)); }
  async keys(prefix = '') {
    const db = await this.db();
    const all = await req(db.transaction(this.store).objectStore(this.store).getAllKeys());
    return all.map(String).filter((k) => k.startsWith(prefix));
  }
}
