// Client side of mix recording: master-output PCM -> chunked uploads -> server writes WAV/FLAC/MP3/AAC/Opus to disk.
// Memory use stays flat (only the upload backlog is buffered), unlike the old in-RAM WAV recorder.
import { Emitter } from '../util.js';
import { tapFor, floatToInt16 } from './pcm-tap.js';
import { ChunkUploader } from './uploader.js';
import { TracklistTracker, watchTracklist } from './tracklist.js';
import { recApi } from './http.js';

export class MixRecorder extends Emitter {
  /** @param {object} engine  app.engine.  opts: { sampleFormat: 's16' | 'f32' } */
  constructor(engine, { sampleFormat } = {}) {
    super();
    this.engine = engine; this.tap = tapFor(engine);
    this.sampleFormat = sampleFormat || 's16';
    this.recording = false; this.session = null; this.frames = 0; this.startedAt = 0; this.peak = [0, 0]; this.server = null;
  }
  get elapsed() { return this.session ? this.frames / this.tap.sampleRate : 0; }
  /** opts override the saved config: { format, bitrate, splitMinutes, title, minTrackSeconds } */
  async start(opts = {}) {
    if (this.recording || this._starting) return this.session;
    this._starting = true;
    try {
      await this.engine.resume?.();
      await this.tap.init();
      const cfg = opts.minTrackSeconds == null ? await recApi.config().catch(() => null) : null;
      const s = await recApi.start({ ...opts, sampleRate: this.tap.sampleRate, sampleFormat: this.sampleFormat, chunkFrames: this.tap.chunkFrames });
      this.session = s; this.server = s; this.frames = 0; this.startedAt = Date.now(); this.recording = true; this.error = null;
      this.uploader = new ChunkUploader({
        url: (seq) => recApi.chunkUrl(s.id, seq),
        onFatal: (e) => { this.error = e.message; this.emit('error', e); this._finish(); },
        onWarn: (m) => this.emit('warning', m),
      });
      this.tracker = new TracklistTracker({ minSeconds: opts.minTrackSeconds ?? cfg?.config?.minTrackSeconds ?? 10, onTrack: (e) => this._track(e) });
      this.stopWatch = watchTracklist(this.engine, () => this.elapsed, this.tracker);
      this.unsub = await this.tap.subscribe((m) => this._chunk(m));
      this.poll = setInterval(() => this._poll(), 1000);
      this.engine.emit?.('recording', true);
      this.emit('state', true);
      return s;
    } finally { this._starting = false; }
  }
  _chunk(m) {
    if (!this.recording || !m.frames) return;
    const data = this.sampleFormat === 'f32' ? m.pcm : floatToInt16(m.pcm);
    this.uploader.push(data);
    this.frames += m.frames;
    this.peak = [m.peakL, m.peakR];
    this.emit('level', this.peak);
  }
  _track(e) {
    if (!this.session) return;
    recApi.track(this.session.id, e).catch(() => {});
    this.emit('track', e);
  }
  async _poll() {
    if (!this.session) return;
    try { const st = await recApi.status(); const mine = st.active.find((x) => x.id === this.session?.id); if (mine) { this.server = mine; this.emit('status', mine); } } catch { /* offline: keep going */ }
  }
  get bytes() { return this.server?.bytes || 0; }
  get backlog() { return this.uploader?.backlogBytes || 0; }
  /** Stop and finalize. Resolves with the server's summary ({ file, name, parts, tracks, seconds, bytes }). */
  async stop() {
    if (!this.recording) return null;
    await this.tap.cut(); // deliver the last partial chunk
    return this._finish();
  }
  async _finish() {
    if (!this.recording) return this._finishing;
    this.recording = false;
    this._finishing = (async () => {
      this.unsub?.(); this.stopWatch?.(); clearInterval(this.poll);
      const s = this.session;
      let result = null;
      if (!this.uploader.failed) {
        const ok = await this.uploader.drain(30000);
        if (!ok) this.emit('warning', 'Some audio could not be sent to the server before stopping');
      }
      try { result = await recApi.stop(s.id, this.uploader.lastSeq); } catch (e) { result = { error: e.message }; }
      this.uploader.abort();
      this.server = result; this.session = null;
      this.engine.emit?.('recording', false);
      this.emit('state', false);
      this.emit('stopped', result);
      return result;
    })();
    return this._finishing;
  }
  toggle(opts) { return this.recording ? this.stop() : this.start(opts); }
}
