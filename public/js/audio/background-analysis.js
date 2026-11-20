// Background analysis of the library: BPM / grid, key, energy, phrases, auto cues and waveform for every
// track that has not been analysed yet, so search (bpm:, key:), smart playlists and "Matching" work right
// after adding a folder, not only for tracks that were loaded on a deck.
//
// It runs in the browser with exactly the deck's analysis: the file comes from the same stream endpoint
// (which transcodes exotic formats with FFmpeg), is decoded by the same AudioContext, analysed by
// analysis-core.js in a Web Worker and saved with the same patch + waveform as a deck load
// (analysisPatch / PUT waveform), so a later deck load finds the waveform and skips analysis.
// (The server-side FFmpeg analyser of the CDJ export only does waveform + BPM, no key/phrases/cues.)
//
// Low priority: one track at a time, an idle gap between tracks (longer while a deck plays), and it waits
// while a deck is loading or the page is busy (main thread lagging). Works the same in hosted mode.
import { Emitter } from '../util.js';
import { api } from '../api.js';
import { encodeWaveform, analysisPatch } from './analysis-core.js';
import { AnalysisQueue, needsAnalysis, isUndecodable } from './analysis-queue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP_IDLE = 150, GAP_PLAYING = 2500; // ms between tracks
const LAG_BUSY = 60; // ms of timer lag that counts as "the page is busy"

export class BackgroundAnalyser extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.queue = new AnalysisQueue();
    this.running = false; this.current = null; this.paused = false;
    this.userStopped = false; // cancelled by the user: don't restart by itself until the next scan / explicit request
    this._failed = new Set(); // failed this session (network etc.): not retried automatically
    this._abort = null;
  }

  get enabled() { return this.app.settings.autoAnalyse !== false; }
  get engine() { return this.app.engine; }

  /** Queue every track that needs analysis (automatic: after a scan, at start-up, when tracks arrive). */
  autoQueue({ afterScan = false } = {}) {
    if (afterScan) this.userStopped = false;
    if (!this.enabled || this.userStopped) return 0;
    const ids = [...this.app.library.tracks.values()].filter((t) => needsAnalysis(t) && !this._failed.has(t.id)).map((t) => t.id);
    const n = this.queue.add(ids);
    if (this.queue.size) this.start();
    return n;
  }

  /** "Analyse selected" / "Analyse all": explicit, so it also re-tries unreadable and includes streaming tracks. */
  request(tracks, { force = false } = {}) {
    this.userStopped = false;
    const ids = [];
    for (const t of tracks) {
      if (!t) continue;
      if (force && t.analyzed && !t.bpmLocked && !t.gridLocked) { t.analyzed = false; }
      if (needsAnalysis(t, { explicit: true })) { this._failed.delete(t.id); ids.push(t.id); }
    }
    this.queue.add(ids, { front: true });
    if (this.queue.size) this.start();
    return ids.length;
  }

  cancel() {
    this.userStopped = true;
    this.queue.clear();
    this._abort?.abort();
    this.emit('progress', this.status());
  }

  status() {
    return { running: this.running && (this.queue.size > 0 || !!this.current), remaining: this.queue.size + (this.current ? 1 : 0), label: this.queue.total ? this.queue.label() : '', paused: this.paused };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const run = () => this._loop().catch((e) => console.warn('background analysis', e)).finally(() => {
      this.running = false; this.current = null; this.queue.reset();
      this.emit('progress', this.status()); this.emit('idle');
    });
    // one tab per browser analyses (others would only repeat the same work)
    if (navigator.locks?.request) navigator.locks.request('opendj-background-analysis', run);
    else run();
  }

  async _loop() {
    const lib = this.app.library;
    for (;;) {
      const id = this.queue.next((x) => { const t = lib.track(x); return !t || !needsAnalysis(t, { explicit: true }); });
      if (!id) return;
      await this._waitQuiet();
      if (this.userStopped) return;
      const t = lib.track(id);
      if (!t || !needsAnalysis(t, { explicit: true })) continue;
      this.current = t;
      this.emit('progress', this.status());
      let ok = false;
      try { ok = await this.analyseTrack(t); } catch (e) { console.warn('analysis failed', t.title, e); }
      this.queue.finished(ok);
      if (!ok) this._failed.add(id);
      this.current = null;
      this.emit('progress', this.status());
      if (this.userStopped) return;
      await sleep(this.engine.decks.some((d) => d.playing) ? GAP_PLAYING : GAP_IDLE);
    }
  }

  /** Wait while a deck is loading, the user is preparing a track or the main thread is lagging. */
  async _waitQuiet() {
    for (let i = 0; i < 600 && !this.userStopped; i++) {
      const loading = this.engine.decks.some((d) => d.loading);
      const lag = await measureLag();
      const busy = loading || lag > LAG_BUSY;
      if (busy !== this.paused) { this.paused = busy; this.emit('progress', this.status()); }
      if (!busy) return;
      await sleep(500);
    }
  }

  worker() {
    if (!this._worker) {
      this._worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
      this._wid = 0;
    }
    return this._worker;
  }

  analyseInWorker(mono, sampleRate, signal) {
    const w = this.worker();
    return new Promise((resolve, reject) => {
      const id = ++this._wid;
      const onMsg = (e) => { if (e.data.id !== id) return; cleanup(); e.data.error ? reject(new Error(e.data.error)) : resolve(e.data); };
      const onAbort = () => { cleanup(); this._worker?.terminate(); this._worker = null; reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })); };
      const cleanup = () => { w.removeEventListener('message', onMsg); signal?.removeEventListener('abort', onAbort); };
      w.addEventListener('message', onMsg);
      signal?.addEventListener('abort', onAbort, { once: true });
      w.postMessage({ id, mono, sampleRate }, [mono.buffer]);
    });
  }

  /** Analyse one track like Deck.load does and save the result. Resolves true on success. */
  async analyseTrack(track) {
    const ac = new AbortController(); this._abort = ac;
    try {
      const res = await fetch(api.streamUrl(track.id), { signal: ac.signal, credentials: 'same-origin' });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`;
        // 415: the server can't play this format at all (e.g. no FFmpeg): treat like an undecodable file
        throw Object.assign(new Error(msg), { undecodable: res.status === 415 || res.status === 422 });
      }
      const ab = await res.arrayBuffer();
      if (!ab.byteLength) throw Object.assign(new Error('Empty file'), { undecodable: true });
      let buf;
      try { buf = await this.engine.ctx.decodeAudioData(ab); } catch (e) { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { undecodable: true }); }
      if (ac.signal.aborted) return false;
      const c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
      const mono = new Float32Array(c0.length);
      if (c1) for (let i = 0; i < mono.length; i++) mono[i] = (c0[i] + c1[i]) * 0.5; else mono.set(c0);
      const duration = buf.duration, sampleRate = buf.sampleRate; buf = null;
      const r = await this.analyseInWorker(mono, sampleRate, ac.signal);
      // the track may have been analysed on a deck meanwhile (or edited): use its latest state
      const cur = this.app.library.track(track.id) || track;
      if (cur.analyzed) return true;
      const patch = analysisPatch(cur, r.result, { duration, autoCues: this.app.settings.autoCues });
      await api.saveWaveform(track.id, r.wave);
      const saved = await api.updateTrack(track.id, patch);
      this.app.library.updateTrack(saved || { id: track.id, ...patch });
      this.emit('analysed', saved);
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      if (isUndecodable(e)) {
        const saved = await api.updateTrack(track.id, { unreadable: true }).catch(() => null);
        this.app.library.updateTrack(saved || { id: track.id, unreadable: true });
        this.emit('unreadable', track, e);
      }
      throw e;
    } finally { if (this._abort === ac) this._abort = null; }
  }
}

/** How late a 0 ms timer fires (ms): a cheap "is the page busy?" probe (hidden tabs: timers are throttled, so 0). */
function measureLag() {
  if (document.hidden) return Promise.resolve(0);
  return new Promise((resolve) => { const t0 = performance.now(); setTimeout(() => resolve(Math.max(0, performance.now() - t0 - 4)), 0); });
}
