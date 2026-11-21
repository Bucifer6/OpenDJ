// Play history grouped into sessions, with setlist export (history.json in the data directory).
// The model and the exporters are public/js/shared/history-core.js, shared with the mobile app.
import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './jsonstore.js';
import { HistoryCore } from '../public/js/shared/history-core.js';

export { SESSION_GAP_MS, sessionTitle, exportSession } from '../public/js/shared/history-core.js';

export class History extends HistoryCore {
  constructor(dataDir) {
    super();
    this.file = path.join(dataDir, 'history.json');
    const r = readJsonSafe(this.file);
    if (r.error) { this.loadErrors.push(r.error); console.error('[opendj]', r.error); }
    this.adopt(r.data);
  }

  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      try { this.flush(); } catch (e) {
        console.error('[opendj] saving play history failed:', e.message);
        this.onError?.(e);
        this._t = setTimeout(() => this.save(), 5000);
      }
    }, 400);
  }
  flush() {
    clearTimeout(this._t);
    writeJsonAtomic(this.file, this.data);
  }
}
