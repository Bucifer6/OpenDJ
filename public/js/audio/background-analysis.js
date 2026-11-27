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
//
// Main-thread budget: decoding itself runs on the browser's decoder thread, but decodeAudioData hands the result
// over in one native task (allocating the AudioBuffer: ~50 ms for a 4-minute track). That task is the only
// unavoidable one — it can't move to the worker without giving up "same decoder as the deck" (AudioContext /
// OfflineAudioContext don't exist in workers, and a WebCodecs decode yields different samples: native rate instead
// of the context's resampled rate, different encoder-delay trimming), which would make results differ from a deck
// load. Everything after it is split up: the decode result is not touched in the same task, and the mono mix-down
// for the worker runs in slices of a few ms (`mixDown`), pausing while a deck loads. Before, the decode hand-over,
// two full-length channel copies and the transfer ran as one 120–150 ms task while a deck played.
import { Emitter } from '../util.js';
import { api } from '../api.js';
import { analysisPatch } from './analysis-core.js';
import { AnalysisQueue, needsAnalysis, isUndecodable } from './analysis-queue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP_IDLE = 400, GAP_PLAYING = 4000; // ms between tracks
const LAG_BUSY = 60; // ms of timer lag that counts as "the page is busy"
const SLICE_MS = 5; // main-thread budget per mix-down slice (one slice per frame)
const MAX_AUTO_DURATION = 20 * 60; // skip automatic background decode of >20 min mixes (would spike ~400+ MB PCM)
const MAX_AUTO_BYTES = 100 * 1024 * 1024; // 100 MB safety cap for automatic background fetch
const WORKER_RECYCLE_EVERY = 8; // periodically recycle analysis worker to keep heap bounded during long batches

export class BackgroundAnalyser extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.queue = new AnalysisQueue();
    this.running = false; this.current = null; this.paused = false;
    this.userStopped = false; // cancelled by the user: don't restart by itself until the next scan / explicit request
    this._failed = new Set(); // failed this session (network etc.): not retried automatically
    this._forced = new Set(); // "Analyse again": re-analysed even though the library (re-synced from the server) says analysed
    this._explicit = new Set(); // explicitly user-requested tracks (bypass automatic duration/size cap)
    this._workerRuns = 0;
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
  request(tracks, { force = false, auto = false } = {}) {
    this.userStopped = false;
    const ids = [];
    for (const t of tracks) {
      if (!t) continue;
      if (force && t.analyzed && !t.bpmLocked && !t.gridLocked) { t.analyzed = false; this._forced.add(t.id); }
      if (needsAnalysis(t, { explicit: true })) {
        this._failed.delete(t.id);
        if (!auto) this._explicit.add(t.id);
        ids.push(t.id);
      }
    }
    this.queue.add(ids, { front: true });
    if (this.queue.size) this.start();
    return ids.length;
  }

  cancel() {
    this.userStopped = true;
    this.queue.clear(); this._forced.clear(); this._explicit.clear();
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
      if (this._worker) { try { this._worker.terminate(); } catch { /* */ } this._worker = null; } // reclaim ~25-40 MB worker RAM when idle
      this.emit('progress', this.status()); this.emit('idle');
    });
    // one tab per browser analyses (others would only repeat the same work)
    if (navigator.locks?.request) navigator.locks.request('opendj-background-analysis', run);
    else run();
  }

  /** Still to analyse? (A forced track counts even after a library re-sync from the server marks it analysed.) */
  _wanted(t) { return !!t && (needsAnalysis(t, { explicit: true }) || (this._forced.has(t.id) && needsAnalysis({ ...t, analyzed: false }, { explicit: true }))); }

  async _loop() {
    const lib = this.app.library;
    for (;;) {
      const id = this.queue.next((x) => { const ok = this._wanted(lib.track(x)); if (!ok) this._forced.delete(x); return !ok; });
      if (!id) return;
      await this._waitQuiet();
      if (this.userStopped) return;
      const t = lib.track(id);
      if (!this._wanted(t)) { this._forced.delete(id); continue; }
      this.current = t;
      this.emit('progress', this.status());
      let ok = false;
      try { ok = await this.analyseTrack(t); } catch (e) { console.warn('analysis failed', t.title, e); }
      this._forced.delete(id);
      this._explicit.delete(id);
      this.queue.finished(ok);
      if (!ok) this._failed.add(id);
      if (ok && ++this._workerRuns >= WORKER_RECYCLE_EVERY && this._worker) {
        try { this._worker.terminate(); } catch { /* */ }
        this._worker = null; this._workerRuns = 0;
      }
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

  /** Resolves once no deck is loading (deck loads come first: they decode and analyse on the main thread too). */
  async _holdWhileLoading(signal) {
    while (this.engine.decks.some((d) => d.loading) && !signal?.aborted) {
      if (!this.paused) { this.paused = true; this.emit('progress', this.status()); }
      await sleep(200);
    }
    if (this.paused) { this.paused = false; this.emit('progress', this.status()); }
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

  /**
   * Mono mix of a decoded AudioBuffer for the analysis worker, sample for sample what Deck.load computes
   * ((L + R) * 0.5 in a Float32Array), one slice of ≤ SLICE_MS per frame so no main-thread task gets long and the
   * waveforms keep their frame rate; waits while a deck loads. Reads the AudioBuffer's channel views directly (no full-length copies). null when aborted.
   */
  async mixDown(buf, signal) {
    const c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const n = c0.length, mono = new Float32Array(n), STEP = 65536;
    let i = 0;
    while (i < n) {
      const t0 = performance.now();
      do {
        const end = Math.min(n, i + STEP);
        if (c1) for (let k = i; k < end; k++) mono[k] = (c0[k] + c1[k]) * 0.5; else mono.set(c0.subarray(i, end), i);
        i = end;
      } while (i < n && performance.now() - t0 < SLICE_MS);
      if (i < n) { await yieldFrame(); await this._holdWhileLoading(signal); }
      if (signal?.aborted) return null;
    }
    return mono;
  }

  /** Analyse one track like Deck.load does and save the result. Resolves true on success. */
  async analyseTrack(track) {
    const manual = this._explicit.has(track.id) || this._forced.has(track.id);
    if (!manual && Number(track.duration) > MAX_AUTO_DURATION) return false;
    const ac = new AbortController(); this._abort = ac;
    try {
      const res = await fetch(api.streamUrl(track.id), { signal: ac.signal, credentials: 'same-origin' });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`;
        // 415: the server can't play this format at all (e.g. no FFmpeg): treat like an undecodable file
        throw Object.assign(new Error(msg), { undecodable: res.status === 415 || res.status === 422 });
      }
      const len = Number(res.headers?.get?.('content-length') || 0);
      if (!manual && len > MAX_AUTO_BYTES) { ac.abort(); return false; }
      let ab = await res.arrayBuffer();
      if (!ab.byteLength) throw Object.assign(new Error('Empty file'), { undecodable: true });
      await this._holdWhileLoading(ac.signal); // the decode hand-over below is the one long task: not while a deck loads
      if (ac.signal.aborted) return false;
      let buf;
      // Decode on an isolated short-lived OfflineAudioContext when available so background decodes don't grow the live AudioContext heap
      const decCtx = typeof OfflineAudioContext === 'function' ? new OfflineAudioContext(1, 1, this.engine.ctx.sampleRate || 44100) : this.engine.ctx;
      try { buf = await decCtx.decodeAudioData(ab); } catch (e) { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { undecodable: true }); } finally { ab = null; }
      await yieldTask(); // don't add work to the decode hand-over task
      if (ac.signal.aborted) return false;
      const duration = buf.duration, sampleRate = buf.sampleRate;
      const mono = await this.mixDown(buf, ac.signal);
      buf = null;
      if (!mono) return false;
      const r = await this.analyseInWorker(mono, sampleRate, ac.signal);
      // the track may have been analysed on a deck meanwhile (or edited): use its latest state
      const cur = this.app.library.track(track.id) || track;
      if (cur.analyzed && !this._forced.has(track.id)) return true;
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

/** Let other tasks (frames, input) run: scheduler.yield() where available, else a 0 ms timer. */
function yieldTask() {
  return globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r, 0));
}

/** Wait for the next frame to be drawn, then a task later (hidden page: no frames, just a 0 ms timer). */
function yieldFrame() {
  if (document.hidden || typeof requestAnimationFrame !== 'function') return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

/** How late a 0 ms timer fires (ms): a cheap "is the page busy?" probe (hidden tabs: timers are throttled, so 0). */
function measureLag() {
  if (document.hidden) return Promise.resolve(0);
  return new Promise((resolve) => { const t0 = performance.now(); setTimeout(() => resolve(Math.max(0, performance.now() - t0 - 4)), 0); });
}
