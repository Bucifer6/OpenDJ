// Client side of live broadcasting: master-output PCM -> server -> FFmpeg -> Icecast / Shoutcast / RTMP,
// with "now playing" updates from the decks.
import { Emitter } from '../util.js';
import { tapFor, floatToInt16 } from './pcm-tap.js';
import { ChunkUploader } from './uploader.js';
import { TracklistTracker, deckSnapshot } from './tracklist.js';
import { castApi } from './http.js';

export class Broadcaster extends Emitter {
  constructor(engine) {
    super();
    this.engine = engine; this.tap = tapFor(engine);
    this.live = false; this.session = null; this.status = null; this.song = '';
  }
  async start(targetIds) {
    if (this.live || this._starting) return this.session;
    this._starting = true;
    try {
      await this.engine.resume?.();
      await this.tap.init();
      const s = await castApi.start({ targetIds, sampleRate: this.tap.sampleRate, sampleFormat: 's16', chunkFrames: this.tap.chunkFrames });
      this.session = s; this.status = s; this.live = true; this.startedAt = Date.now(); this.song = '';
      this.uploader = new ChunkUploader({ url: (seq) => castApi.chunkUrl(s.id, seq), live: true, maxInFlight: 2, maxQueueBytes: 8 * 1024 * 1024, onFatal: (e) => { this.emit('error', e); this.stop(); }, onWarn: (m) => this.emit('warning', m) });
      this.unsub = await this.tap.subscribe((m) => { if (this.live && m.frames) this.uploader.push(floatToInt16(m.pcm)); });
      this.meta = setInterval(() => this._nowPlaying(), 1000);
      this.poll = setInterval(() => this._poll(), 2000);
      this._nowPlaying();
      this.emit('state', true);
      return s;
    } finally { this._starting = false; }
  }
  /** Metadata follows the loudest audible deck once it has been on air for a few seconds. */
  _nowPlaying() {
    if (this._holdUntil && Date.now() < this._holdUntil) return; // a dedication is on air
    if (this._holdUntil) { this._holdUntil = 0; this.song = ''; } // resend the track's title afterwards
    const np = TracklistTracker.nowPlaying(deckSnapshot(this.engine));
    const song = np ? [np.artist, np.title].filter(Boolean).join(' - ') : '';
    if (!song) { this._pending = null; return; }
    if (song === this.song) { this._pending = null; return; }
    if (!this._pending || this._pending.song !== song) { this._pending = { song, since: Date.now(), np }; return; }
    if (Date.now() - this._pending.since >= (this.metadataDelayMs ?? 3000)) { this.song = song; this.setMetadata(this._pending.np); this._pending = null; }
  }
  /** Show this as "now playing" for `ms` (a dedication), then go back to the track's title. */
  holdMetadata({ artist = '', title = '' }, ms = 10000) {
    if (!this.session) return Promise.resolve(null);
    this._holdUntil = Date.now() + Math.max(1000, Math.min(120000, ms)); this._pending = null;
    return this.setMetadata({ artist, title });
  }
  setMetadata({ artist = '', title = '' }) {
    if (!this.session) return Promise.resolve(null);
    this.song = [artist, title].filter(Boolean).join(' - ');
    return castApi.metadata(this.session.id, { artist, title }).catch(() => null);
  }
  async _poll() {
    try { const st = await castApi.status(); const mine = st.active.find((x) => x.id === this.session?.id); if (mine) { this.status = mine; this.emit('status', mine); } } catch { /* */ }
  }
  async stop() {
    if (!this.live) return null;
    this.live = false;
    this.unsub?.(); clearInterval(this.meta); clearInterval(this.poll);
    this.uploader?.abort();
    const s = this.session; this.session = null;
    let r = null;
    try { r = await castApi.stop(s.id); } catch { /* already gone */ }
    this.status = r;
    this.emit('state', false);
    return r;
  }
}
