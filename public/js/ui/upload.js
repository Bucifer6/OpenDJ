// Browser upload: drag audio/video files onto the library (or use the "Upload…" button) to copy them into the
// server's uploads folder. Needed when OpenDJ runs on a NAS/server and the browser can't hand over local paths.
//
//   import { setupUpload, uploadButton } from './ui/upload.js';
//   app.upload = setupUpload(app);            // drag & drop on the library + progress panel
//   toolbar.append(uploadButton(app));        // optional button (hidden in desktop mode unless { always: true })
import { api } from '../api.js';
import { el } from '../util.js';

const CONCURRENCY = 2;
let shared = null; // one uploader (queue + panel) per page

function ensureCss() {
  if (document.querySelector('link[data-upload-css]')) return;
  document.head.append(el('link', { rel: 'stylesheet', href: 'css/upload.css', 'data-upload-css': '' }));
}

const fmtMB = (n) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

class Uploader {
  constructor(app) {
    this.app = app;
    this.queue = [];
    this.active = 0;
    this.caps = null;
    this.capsP = api.capabilities().then((c) => (this.caps = c)).catch(() => null);
    this.list = el('div', { class: 'upl-list' });
    this.title = el('span', { class: 'upl-title' }, 'Uploads');
    this.panel = el('section', { class: 'upl-panel', hidden: true, role: 'status', 'aria-live': 'polite' },
      el('header', {}, this.title, el('button', { class: 'upl-close', title: 'Hide', 'aria-label': 'Hide uploads', onclick: () => { this.panel.hidden = true; } }, '×')),
      this.list);
    document.body.append(this.panel);
  }

  accept() { return this.caps?.upload?.accept || ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.aif', '.aiff', '.mp4', '.webm']; }
  allowed(file) {
    const ext = (/\.[^.]+$/.exec(file.name || '') || [''])[0].toLowerCase();
    return this.accept().includes(ext);
  }

  /** Queue files (FileList / File[]); resolves with the new track ids. */
  async add(files) {
    await this.capsP;
    files = [...files];
    const skipped = files.filter((f) => !this.allowed(f));
    const ok = files.filter((f) => this.allowed(f));
    if (skipped.length) this.app.toast?.(`Skipped ${skipped.length} file(s) that are not audio/video: ${skipped.slice(0, 3).map((f) => f.name).join(', ')}`);
    const maxMB = this.caps?.upload?.maxMB;
    const jobs = ok.map((file) => new Promise((resolve) => {
      if (maxMB && file.size > maxMB * 1048576) { this.app.toast?.(`${file.name} is larger than the ${maxMB} MB upload limit`); return resolve(null); }
      const job = { file, resolve, ctrl: new AbortController() };
      job.row = this.row(job);
      this.queue.push(job);
    }));
    if (ok.length) { this.panel.hidden = false; this.pump(); }
    const ids = (await Promise.all(jobs)).filter(Boolean);
    if (ids.length) this.app.toast?.(`Uploaded ${ids.length} file(s) to the library`);
    return ids;
  }

  row(job) {
    const bar = el('div', { class: 'upl-bar' }, el('i'));
    const info = el('span', { class: 'upl-info' }, 'Waiting…');
    const cancel = el('button', { class: 'upl-cancel', title: 'Cancel', 'aria-label': `Cancel ${job.file.name}`, onclick: () => job.ctrl.abort() }, '×');
    const row = el('div', { class: 'upl-row' }, el('span', { class: 'upl-name', title: job.file.name }, job.file.name), info, cancel, bar);
    this.list.prepend(row);
    job.ui = { bar: bar.firstChild, info, cancel, row };
    job.ctrl.signal.addEventListener('abort', () => { const i = this.queue.indexOf(job); if (i >= 0) { this.queue.splice(i, 1); this.finish(job, null, 'Cancelled'); } }, { once: true });
    return row;
  }

  pump() {
    while (this.active < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      job.ui.info.textContent = 'Starting…';
      api.upload(job.file, {
        signal: job.ctrl.signal,
        onProgress: (loaded, total) => {
          const f = total ? loaded / total : 0;
          job.ui.bar.style.width = `${(f * 100).toFixed(1)}%`;
          job.ui.info.textContent = f >= 1 ? 'Reading tags…' : `${fmtMB(loaded)} / ${fmtMB(total)}`;
        },
      }).then((r) => this.finish(job, r.id, 'Done'), (e) => this.finish(job, null, e.name === 'AbortError' ? 'Cancelled' : e.message))
        .finally(() => { this.active--; this.pump(); });
    }
    this.updateTitle();
  }

  finish(job, id, msg) {
    job.ui.info.textContent = msg;
    job.ui.cancel.remove();
    job.ui.row.classList.add(id ? 'done' : 'failed');
    if (id) job.ui.bar.style.width = '100%';
    job.resolve(id);
    this.updateTitle();
    if (id) setTimeout(() => job.ui.row.remove(), 8000);
  }

  updateTitle() {
    const n = this.active + this.queue.length;
    this.title.textContent = n ? `Uploading ${n} file(s)…` : 'Uploads';
  }

  /** Open the file picker. */
  pick() {
    const input = el('input', { type: 'file', multiple: true, accept: [...this.accept(), 'audio/*', 'video/*'].join(','), hidden: true });
    input.addEventListener('change', () => { if (input.files.length) this.add(input.files); input.remove(); });
    document.body.append(input);
    input.click();
  }
}

function uploader(app) {
  ensureCss();
  if (!shared) shared = new Uploader(app);
  if (app && !shared.app?.toast) shared.app = app;
  return shared;
}

/**
 * Drag & drop of audio/video files anywhere on the library (`app.library.root`, else the whole page) + progress panel.
 * Internal track drags (rows -> playlists/decks) are left alone: only drags that carry files are handled.
 * Returns { upload(files) -> Promise<trackIds>, pick(), button(opts) }.
 */
export function setupUpload(app, { target } = {}) {
  const u = uploader(app);
  const zone = target || app?.library?.root || document.body;
  const overlay = el('div', { class: 'upl-drop', hidden: true }, el('div', {}, 'Drop audio or video files to upload them to the library'));
  zone.classList.add('upl-zone');
  zone.append(overlay);
  let depth = 0;
  zone.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; overlay.hidden = false; });
  zone.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  zone.addEventListener('drop', (e) => {
    if (!hasFiles(e) || !e.dataTransfer.files.length) return;
    e.preventDefault();
    depth = 0; overlay.hidden = true;
    u.add(e.dataTransfer.files);
  });
  return { upload: (files) => u.add(files), pick: () => u.pick(), button: (opts) => uploadButton(app, opts) };
}

/**
 * "Upload…" button for the library toolbar. By default it only shows when the server runs hosted (web app / NAS),
 * where "+ Folder" can't reach the user's own disk; pass { always: true } to show it everywhere.
 */
export function uploadButton(app, { always = false, label = '⇪ Upload…' } = {}) {
  const b = el('button', { class: 'btn sm upl-btn', title: 'Upload audio or video files from this computer to the server library', onclick: () => uploader(app).pick() }, label);
  if (!always) {
    b.hidden = true;
    api.capabilities().then((c) => { b.hidden = !c.hosted; }).catch(() => {});
  }
  return b;
}
