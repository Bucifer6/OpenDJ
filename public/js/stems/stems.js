// AI stems manager (UI thread): model consent + download, a preparation queue, and attaching new stems to decks that
// have the track loaded. Two engines:
//  - server (preferred): the OpenDJ server separates natively in its own queue (server/stems-child.js); this page
//    only asks and mirrors the server's queue from its events, so phones and slow browsers never do the heavy work
//    and Automix's next tracks are prepared ahead of time;
//  - browser (fallback: no onnxruntime-node / FFmpeg on the server, or chosen in the settings): the separation worker
//    here, with the results uploaded to the server.
// Created once by the app: `app.stems = new StemsManager(app)` (see stems-ui.js setupStems()).
import { Emitter } from '../util.js';
import { STEMS, MODEL_RATE } from './stem-dsp.js';

const j = async (method, url, body) => {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof Uint8Array) { opts.body = body; opts.headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};
export const stemsApi = {
  status: () => j('GET', '/api/stems/status'),
  downloadModel: () => j('POST', '/api/stems/model/download'),
  cancelModel: () => j('POST', '/api/stems/model/cancel'),
  info: (id) => j('GET', `/api/stems/${encodeURIComponent(id)}`),
  begin: (id, body) => j('POST', `/api/stems/${encodeURIComponent(id)}/begin`, body),
  part: (id, token, stem, frame, data) => j('PUT', `/api/stems/${encodeURIComponent(id)}/part?token=${token}&stem=${stem}&frame=${frame}`, new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
  finish: (id, token) => j('POST', `/api/stems/${encodeURIComponent(id)}/finish?token=${token}`),
  remove: (id) => j('DELETE', `/api/stems/${encodeURIComponent(id)}`),
  queue: (ids, { force = false, front = false } = {}) => j('POST', '/api/stems/queue', { ids, force, front }),
  cancelQueued: (id) => j('POST', '/api/stems/queue/cancel', id ? { id } : { all: true }),
};

/** Human name of a separation backend. */
export const backendName = (b) => ({ dml: 'GPU · DirectML', coreml: 'GPU · CoreML', cuda: 'GPU · CUDA', cpu: 'CPU', webgpu: 'WebGPU', wasm: 'CPU (browser)', stub: 'test' }[b] || b || '');

const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

export class StemsManager extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.queue = [];          // track ids waiting
    this.current = null;      // { id, title, phase, done, total, started, backend }
    this.worker = null; this.workerReady = null;
    this.stub = null;         // tests: 'bands' runs a deterministic stand-in instead of the ONNX model
    this.lastRun = null;      // { id, ms, seconds, backend, threads, chunks } of the last finished separation
    this.confirmDownload = null; // async (modelStatus) => boolean, set by the UI
  }

  get settings() { return this.app.settings || {}; }
  hasStems(t) { return !!t?.stems?.ready; }
  get busy() { return !!this.current || this.queue.length > 0; }
  /** The server separates (onnxruntime-node there), unless the settings ask for the browser engine. */
  get serverEngine() { return !this.stub && !!this._status?.native?.installed && this.settings.stemsEngine !== 'browser'; }
  state() { return { current: this.current && { ...this.current }, queue: [...this.queue] }; }
  /** Test hook: use the band-splitting stub instead of the real model (no download). */
  useStub(kind = 'bands') { this.stub = kind; this.disposeWorker(); }

  async status() {
    this._status = await stemsApi.status();
    if (this.serverEngine && !this._pumping) this.serverState(this._status.native);
    return this._status;
  }

  // ---------------- server engine ----------------
  /** Mirror the server's queue ({ current, queue } from /api/stems/status or the 'stems-queue' event). */
  serverState(s) {
    if (!s || this._pumping) return; // the browser engine is running here
    const c = s.current;
    this.current = c ? { id: c.id, title: c.title, phase: c.phase, done: c.done, total: c.total, backend: c.backend, started: performance.now() - (c.separating || c.elapsed || 0), server: true } : null;
    this.queue = [...(s.queue || [])];
    this.emit('progress', this.current && { ...this.current }); this.emit('queue', this.state());
  }
  /** Server events: 'stems-queue', 'stems-done', 'stems-failed', 'stems' (wired in app.js). */
  serverEvent(type, e) {
    if (type === 'stems-queue') return this.serverEngine && this.serverState(e);
    if (type === 'stems') { if (e.ready && e.stems) this.updateTrack(e.id, e.stems); else if (e.ready === false) this.updateTrack(e.id, null); return; }
    const mine = this._asked.delete(e.id); // only the page that asked gets the toast (Automix's own prefetches stay quiet)
    if (type === 'stems-done') {
      this.lastRun = { id: e.id, ms: e.ms, seconds: e.seconds, backend: e.backend, threads: e.threads, chunks: e.chunks };
      if (mine) this.emit('finished', { id: e.id, title: e.title, ...this.lastRun });
    } else if (type === 'stems-failed' && mine) {
      if (e.cancelled) this.emit('cancelled', { id: e.id });
      else this.emit('failed', { id: e.id, title: e.title, message: e.message });
    }
  }
  _asked = new Set();

  /**
   * Prepare tracks ahead (Automix's next tracks, a track just loaded on a deck) on the server, quietly. Only with the
   * server engine: in the browser this would compete with playback.
   */
  async prefetch(ids, { front = false } = {}) {
    if (!this.serverEngine || this.settings.stemsAutoPrepare === false || !this._status?.native?.available) return 0;
    const lib = this.app.library;
    const list = [...new Set(ids)].filter((id) => { const t = lib?.track(id); return t && !this.hasStems(t) && (front || (this.current?.id !== id && !this.queue.includes(id))); });
    if (!list.length) return 0;
    try { const r = await stemsApi.queue(list, { front }); this.serverState(r); return r.added; } catch (e) { console.warn('[stems] prefetch', e.message); return 0; }
  }

  /** Make sure the model is on the server; asks for consent (size, licence) before the one-time download. */
  async ensureModel({ interactive = true } = {}) {
    if (this.stub) return true;
    let st = await this.status();
    if (!st.ort) throw new Error('The AI stems engine is missing from this OpenDJ build. Update or reinstall OpenDJ; no separate runtime installation is needed.');
    if (st.model.error && !st.model.downloading && !st.model.ready && st.model.error !== 'Download cancelled' && !interactive) throw new Error(st.model.error);
    if (st.model.ready) return true;
    if (!st.model.downloading) {
      if (!interactive) return false;
      const ok = this.confirmDownload ? await this.confirmDownload(st.model) : confirm(`Download the stems model (${Math.round((st.model.downloadBytes || st.model.bytes || 0) / 1048576)} MB)?`);
      if (!ok) return false;
      await stemsApi.downloadModel();
    }
    this.emit('model', { downloading: true, received: 0, total: st.model.downloadBytes || 0 });
    for (;;) {
      await new Promise((r) => setTimeout(r, 600));
      st = await this.status();
      if (st.model.ready) { this.emit('model', { ready: true }); return true; }
      if (!st.model.downloading) { this.emit('model', { error: st.model.error }); throw new Error(st.model.error || 'Model download failed'); }
      this.emit('model', { downloading: true, ...st.model.downloading });
    }
  }

  /** Queue tracks for separation (skips ones that already have stems unless force). */
  async enqueue(ids, { force = false, interactive = true } = {}) {
    const lib = this.app.library;
    const list = [...new Set(ids)].filter((id) => {
      const t = lib?.track(id);
      return t && (force || !this.hasStems(t)) && this.current?.id !== id && !this.queue.includes(id);
    });
    if (!list.length) return 0;
    if (!(await this.ensureModel({ interactive }))) return 0;
    if (this.serverEngine) {
      if (!this._status?.native?.available) await this.status();
      if (this._status?.native?.available) {
        for (const id of list) this._asked.add(id);
        const r = await stemsApi.queue(list, { force, front: list.length === 1 });
        this.serverState(r);
        return r.added || list.length;
      }
    }
    this.queue.push(...list);
    this.emit('queue', this.state());
    this.pump();
    return list.length;
  }

  cancel(id) {
    if (this.serverEngine && !this._pumping) {
      const target = id || this.current?.id;
      if (target) { this._asked.add(target); stemsApi.cancelQueued(target).then((s) => this.serverState(s)).catch((e) => console.warn('[stems] cancel', e.message)); }
      return;
    }
    if (id && this.current?.id !== id) { this.queue = this.queue.filter((x) => x !== id); this.emit('queue', this.state()); return; }
    if (!this.current) return;
    this._cancel = true;
    this.disposeWorker(); // stops the model mid-chunk; it is reloaded for the next track
    this._abort?.(abortError());
  }
  cancelAll() {
    if (this.serverEngine && !this._pumping) { stemsApi.cancelQueued(null).then((s) => this.serverState(s)).catch(() => {}); return; }
    this.queue = []; this.cancel(); this.emit('queue', this.state());
  }

  /** Delete a track's stems (server + decks). */
  async remove(id) {
    await stemsApi.remove(id);
    this.updateTrack(id, null);
  }

  async pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift();
        const t = this.app.library?.track(id);
        if (!t) continue;
        this._cancel = false;
        this.current = { id, title: t.title || 'Untitled', phase: 'decoding', done: 0, total: 0, started: performance.now() };
        this.emit('progress', { ...this.current }); this.emit('queue', this.state());
        try {
          await this.prepare(t);
          this.emit('finished', { id, title: this.current.title, ...this.lastRun });
        } catch (e) {
          if (e.name !== 'AbortError') { console.warn('[stems]', e); this.emit('failed', { id, title: this.current.title, message: e.message }); }
          else this.emit('cancelled', { id });
        } finally {
          this.current = null;
          this.emit('progress', null); this.emit('queue', this.state());
        }
      }
    } finally {
      this._pumping = false;
      this.disposeWorker(); // free the model's memory (hundreds of MB) while idle
    }
  }

  setPhase(phase, extra = {}) { Object.assign(this.current, { phase, ...extra }); this.emit('progress', { ...this.current }); }

  async getWorker() {
    if (this.workerReady) return this.workerReady;
    const w = new Worker(new URL('./stems-worker.js', import.meta.url), { type: 'module' });
    this.worker = w;
    this.workerReady = new Promise((resolve, reject) => {
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') { this.backend = m; resolve(w); }
        else if (m.type === 'model-progress') this.current && this.setPhase('loading model', { done: m.received, total: m.total });
        else if (m.type === 'error') reject(new Error(m.message));
      };
      w.onerror = (e) => reject(new Error(e.message || 'Stems worker failed to start'));
    });
    const st = this._status || (this.stub ? null : await this.status());
    const hc = navigator.hardwareConcurrency || 2;
    w.postMessage({
      type: 'init', stub: this.stub,
      ortBase: new URL('/api/stems/ort/', location.href).href,
      modelUrl: new URL(`/api/stems/model?sha=${st?.model?.sha256 || ''}`, location.href).href,
      threads: Math.max(1, Math.min(4, hc - 2)),
      backend: this.settings.stemsBackend || 'auto',
    });
    this.workerReady.catch(() => this.disposeWorker());
    return this.workerReady;
  }
  disposeWorker() { this.worker?.terminate(); this.worker = null; this.workerReady = null; }

  /** Decode at the model rate (44.1 kHz stereo); the browser resamples. */
  async decode(trackId) {
    const res = await fetch(`/api/tracks/${encodeURIComponent(trackId)}/stream`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    const ctx = new OfflineAudioContext(2, 1, MODEL_RATE);
    const buf = await ctx.decodeAudioData(ab);
    const left = new Float32Array(buf.getChannelData(0));
    const right = buf.numberOfChannels > 1 ? new Float32Array(buf.getChannelData(1)) : null;
    return { left, right, length: buf.length };
  }

  async prepare(t) {
    const check = () => { if (this._cancel) throw abortError(); };
    const audio = await this.decode(t.id);
    check();
    this.setPhase('loading model');
    const w = await this.getWorker();
    check();
    const model = this.stub ? `stub-${this.stub}` : (this._status?.model?.id || 'model');
    const { token } = await stemsApi.begin(t.id, { model, sampleRate: MODEL_RATE, frames: audio.length, backend: this.backend?.backend });
    let uploads = Promise.resolve(), uploadError = null;
    try {
      const result = await new Promise((resolve, reject) => {
        this._abort = reject;
        w.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'progress') this.setPhase('separating', { done: m.done, total: m.total, backend: this.backend?.backend });
          else if (m.type === 'block') {
            uploads = uploads.then(async () => {
              if (uploadError || this._cancel) return;
              for (let s = 0; s < STEMS.length; s++) await stemsApi.part(t.id, token, STEMS[s], m.frame, m.stems[s]);
            }).catch((err) => { uploadError = err; reject(err); });
          } else if (m.type === 'done') resolve(m);
          else if (m.type === 'error') reject(new Error(m.message));
        };
        const transfer = [audio.left.buffer, ...(audio.right ? [audio.right.buffer] : [])];
        w.postMessage({ type: 'separate', id: t.id, left: audio.left, right: audio.right, length: audio.length, overlap: Number(this.settings.stemsOverlap) || 0.25 }, transfer);
      });
      this.setPhase('saving');
      await uploads;
      if (uploadError) throw uploadError;
      check();
      const r = await stemsApi.finish(t.id, token);
      this.lastRun = { id: t.id, ms: result.ms, seconds: audio.length / MODEL_RATE, backend: result.backend, threads: result.threads, chunks: result.chunks };
      this.updateTrack(t.id, r.stems);
    } catch (e) {
      stemsApi.remove(t.id).catch(() => {}); // drop the partial upload
      throw e;
    } finally { this._abort = null; }
  }

  /** New/removed stems: update the library cache and any deck that has the track loaded. */
  updateTrack(id, stems) {
    const lib = this.app.library;
    const t = lib?.track(id);
    if (t) lib.updateTrack({ ...t, stems: stems || undefined });
    for (const d of this.app.engine.decks) {
      if (d.track?.id !== id) continue;
      if (stems?.ready && d.stemsReady && d.track.stems?.at === stems.at) continue; // same stems, already loaded (event + reply)
      d.track.stems = stems || undefined;
      if (stems?.ready) { if (d.stemsReady) d.unloadStems(); d.loadStems().catch((e) => console.warn('[stems] load', e)); }
      else d.unloadStems();
    }
    this.emit('track', { id, stems });
  }
}
