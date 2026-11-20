// One video layer per deck: a muted <video> that follows deck.position / deck.rate, or an audio-reactive
// visualizer for tracks without a picture. Audio always comes from the deck's own audio engine.
import { isVideoCandidate, syncDecision } from './video-core.js';
import { Visualizer } from './visualizer.js';

export const videoUrl = (id) => `/api/tracks/${encodeURIComponent(id)}/video`;
export const streamUrl = (id) => `/api/tracks/${encodeURIComponent(id)}/stream`;

export class VideoDeckLayer {
  /** @param {HTMLElement} host hidden on-screen container that keeps the <video> elements decoding */
  constructor(app, deck, host) {
    this.app = app; this.deck = deck; this.index = deck.index; this.host = host;
    this.mode = 'auto'; // auto | visual | off
    this.kind = 'none'; // none | video | visual
    this.video = null; this.visual = null; this.track = null;
    this.seekLatency = 0.05; this._seekAt = 0; this.lastDecision = null; this.drift = 0;
    this._uploadedTime = -1;
    this.offLoad = deck.on('load', (t) => this.setTrack(t));
    this.offError = deck.on('error', () => this.setTrack(null));
    if (deck.track) this.setTrack(deck.track);
  }

  setMode(m) { this.mode = m; this.setTrack(this.deck.track, true); }

  setTrack(track, force = false) {
    if (!force && track === this.track) return;
    this.track = track || null;
    this.dropVideo();
    if (!track || this.mode === 'off') { this.kind = 'none'; return; }
    if (this.mode === 'auto' && isVideoCandidate(track)) this.makeVideo(track);
    else this.useVisual();
  }

  useVisual() {
    this.kind = 'visual';
    if (!this.visual) this.visual = new Visualizer(this.app, this.index);
    this.visual.setTrack(this.track);
  }

  makeVideo(track) {
    const v = document.createElement('video');
    v.muted = true; v.defaultMuted = true; v.playsInline = true; v.preload = 'auto'; v.disablePictureInPicture = true;
    v.setAttribute('muted', ''); v.className = 'vid-src';
    v.dataset.deck = String(this.index);
    let triedStream = !track.hasVideo; // without hasVideo we probe the audio stream URL directly
    v.src = track.hasVideo ? videoUrl(track.id) : streamUrl(track.id);
    v.addEventListener('error', () => {
      if (this.video !== v) return;
      if (!triedStream) { triedStream = true; v.src = streamUrl(track.id); v.load(); return; } // /video not available yet
      this.dropVideo(); this.useVisual();
    });
    v.addEventListener('loadedmetadata', () => {
      if (this.video !== v) return;
      if (!v.videoWidth) { this.dropVideo(); this.useVisual(); } // audio-only container
    });
    v.addEventListener('seeked', () => {
      if (this._seekAt) { const dt = (performance.now() - this._seekAt) / 1000; this.seekLatency = this.seekLatency * 0.7 + Math.min(0.5, dt) * 0.3; this._seekAt = 0; }
    });
    this.host.append(v);
    this.video = v; this.kind = 'video';
    this.visual?.setTrack(track); // keep the cover ready in case we fall back
  }

  dropVideo() {
    if (!this.video) return;
    const v = this.video; this.video = null;
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* */ }
    v.remove();
  }

  /** Deck rate as heard (signed; worklet-reported while playing so brakes/reverse are followed). */
  deckRate() {
    const d = this.deck;
    if (!d.playing) return 0;
    return Number.isFinite(d._rate) && d._rate !== 0 ? d._rate : d.rate;
  }

  /** Keep the video on the deck's timeline. Called every frame while the mixer runs. */
  sync(active) {
    const v = this.video;
    if (!v) return;
    if (!active) { if (!v.paused) v.pause(); return; }
    if (v.readyState < 1) return;
    const d = this.deck;
    const dec = syncDecision({
      videoTime: v.currentTime, target: d.position, rate: this.deckRate(), playing: d.playing && !d.loading,
      videoPaused: v.paused, seeking: v.seeking, scratching: !!d.scratching, duration: v.duration, seekLatency: this.seekLatency,
    });
    this.lastDecision = dec; this.drift = dec.drift;
    switch (dec.action) {
      case 'seek':
        this._seekAt = performance.now();
        if (dec.playbackRate) this.setRate(dec.playbackRate);
        v.currentTime = dec.time;
        if (dec.mode !== 'frame' && v.paused) v.play().catch(() => {});
        break;
      case 'rate': this.setRate(dec.playbackRate); break;
      case 'play': this.setRate(dec.playbackRate); v.play().catch(() => {}); break;
      case 'pause': v.pause(); break;
    }
  }

  setRate(r) {
    const v = this.video;
    if (v && Number.isFinite(r) && r > 0 && Math.abs(v.playbackRate - r) > 1e-4) {
      try { v.playbackRate = Math.max(0.0625, Math.min(16, r)); } catch { /* */ }
    }
  }

  /** Drawable for the mixer, or null. Visualizer canvases are (re)drawn here only when visible. */
  source(now, visible) {
    if (this.kind === 'video') {
      const v = this.video;
      if (!v || v.readyState < 2 || !v.videoWidth) return null;
      // skip re-uploading an unchanged paused frame
      const fresh = !(v.paused && !v.seeking && v.currentTime === this._uploadedTime);
      if (visible) this._uploadedTime = v.currentTime;
      return { el: v, w: v.videoWidth, h: v.videoHeight, fresh };
    }
    if (this.kind === 'visual' && this.visual) {
      if (visible) this.visual.draw(this.deck, now);
      return { el: this.visual.canvas, w: this.visual.width, h: this.visual.height, fresh: visible };
    }
    return null;
  }

  dispose() { this.offLoad(); this.offError(); this.dropVideo(); this.visual?.dispose(); }
}
