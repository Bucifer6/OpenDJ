// The library and play history of the on-device backend, persisted in the key-value store (IndexedDB).
// Same model as the desktop server (public/js/shared/library-core.js, history-core.js).
import { LibraryCore, DEFAULT_SETTINGS, onceMigrations } from '../shared/library-core.js';
import { HistoryCore } from '../shared/history-core.js';
import { sanitizeSettings } from '../shared/settings-schema.js';

/** Settings that make no sense on a phone (folders on the server, transcode cache…) are not offered there. */
export const MOBILE_SETTINGS = { downloadDir: 'downloads', uploadDir: '' };

export class LocalLibrary extends LibraryCore {
  constructor(kv) { super(); this.kv = kv; this.settings.downloadDir = MOBILE_SETTINGS.downloadDir; }
  async load() {
    try {
      this.adoptData(await this.kv.get('library'));
      const s = await this.kv.get('settings');
      const clean = sanitizeSettings(s && typeof s === 'object' ? s : {}, DEFAULT_SETTINGS);
      this.settings = { ...this.settings, ...clean, automix: { ...this.settings.automix, ...(clean.automix || {}) }, ...MOBILE_SETTINGS };
      onceMigrations(this.settings, clean);
    } catch (e) {
      this.loadErrors.push(`The library could not be read from app storage (${e.message}); starting empty.`);
    }
    return this;
  }
  async flush() {
    clearTimeout(this._t);
    await this.kv.set('library', this.data);
    await this.kv.set('settings', this.settings);
  }
  onTracksRemoved(ids) { this.onRemoved?.(ids); }
}

export class LocalHistory extends HistoryCore {
  constructor(kv) { super(); this.kv = kv; }
  async load() { try { this.adopt(await this.kv.get('history')); } catch (e) { this.loadErrors.push(`Play history could not be read (${e.message})`); } return this; }
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush().catch((e) => this.onError?.(e)), 400);
  }
  async flush() { clearTimeout(this._t); await this.kv.set('history', this.data); }
}
