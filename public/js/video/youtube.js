// YouTube as a VIDEO SOURCE via the official IFrame Player API (youtube-nocookie.com host).
// Nothing is downloaded and YouTube audio never enters the Web Audio mixer (YouTube ToS).
// - Visual layer: the player iframe is composited with CSS over the mixer canvas, its opacity following the mix.
// - Jukebox: the player's own audio plays, its volume following the crossfader side it is assigned to.
//   No EQ / FX / sync: YouTube audio can't be processed.
import { Emitter } from '../util.js';
import { youTubeSearchUrl, mapYouTubeSearch, jukeboxVolume } from './video-core.js';

let apiPromise = null;
/** Load https://www.youtube.com/iframe_api once (works in the main window and the pop-out). */
export function loadYouTubeApi(win = window) {
  if (win.YT?.Player) return Promise.resolve(win.YT);
  if (win === window && apiPromise) return apiPromise;
  const p = new Promise((resolve, reject) => {
    const prev = win.onYouTubeIframeAPIReady;
    win.onYouTubeIframeAPIReady = () => { try { prev?.(); } catch { /* */ } resolve(win.YT); };
    const s = win.document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api'; s.async = true;
    s.onerror = () => reject(new Error('Could not load the YouTube player (offline or blocked)'));
    win.document.head.append(s);
    setTimeout(() => reject(new Error('YouTube player API timed out')), 20000);
  });
  if (win === window) apiPromise = p.catch((e) => { apiPromise = null; throw e; });
  return p;
}

export async function searchYouTube(q, key, opts) {
  if (!key) throw new Error('Add your YouTube Data API key first');
  const r = await fetch(youTubeSearchUrl(q, key, opts));
  let json; try { json = await r.json(); } catch { throw new Error(`YouTube search failed (HTTP ${r.status})`); }
  return mapYouTubeSearch(json);
}

export const ERRORS = { 2: 'Invalid video ID', 5: 'This video can’t be played in an HTML5 player', 100: 'Video not found or private', 101: 'The owner doesn’t allow embedding', 150: 'The owner doesn’t allow embedding', 153: 'Player configuration error (missing referrer)' };

export class YouTubeSource extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.player = null; this.videoId = null; this.meta = { title: '', channel: '' };
    this.showInMix = true; this.jukebox = false; this.xfAssign = 'THRU'; this.volume = 1;
    this.state = -1; this.weight = 0; this._lastVol = -1; this.mount = null;
  }

  /** Mixer "extra layer" interface. */
  get active() { return !!this.player && this.showInMix && (this.state === 1 || this.state === 3 || this.state === 2); }
  key() { return this.videoId; }
  title() { return this.meta.title ? (this.meta.channel ? `${this.meta.channel} – ${this.meta.title}` : this.meta.title) : ''; }
  setWeight(w) {
    this.weight = w;
    if (this.frame) {
      const op = this.showInMix ? w : 0;
      if (Math.abs((this._op ?? -1) - op) > 0.004) { this.frame.style.opacity = op.toFixed(3); this._op = op; }
    }
  }

  /** The element the iframe lives in. It must never be re-parented (that reloads the iframe). */
  attach(container) { this.mount = container; }

  async load(videoId, { start = 0, title = '', channel = '' } = {}) {
    if (!this.mount) throw new Error('Video panel is not open');
    const YT = await loadYouTubeApi();
    this.videoId = videoId; this.meta = { title, channel }; this.start = start;
    if (this.player?.loadVideoById) {
      this.player.loadVideoById({ videoId, startSeconds: start });
    } else {
      const div = document.createElement('div');
      this.mount.replaceChildren(div);
      await new Promise((resolve, reject) => {
        this.player = new YT.Player(div, {
          host: 'https://www.youtube-nocookie.com', videoId, width: '100%', height: '100%',
          playerVars: { autoplay: 1, playsinline: 1, controls: 1, rel: 0, start: Math.floor(start), origin: location.origin, enablejsapi: 1 },
          events: {
            onReady: () => { this.frame = this.player.getIframe(); this.frame.classList.add('vid-yt-frame'); this.applyAudio(true); this.player.playVideo(); resolve(); },
            onStateChange: (e) => { this.state = e.data; this.readMeta(); this.emit('state', e.data); },
            onError: (e) => { const m = ERRORS[e.data] || `YouTube error ${e.data}`; this.emit('error', m); reject(new Error(m)); },
          },
        });
      });
    }
    this.emit('load', videoId);
  }

  readMeta() {
    try { const d = this.player.getVideoData?.(); if (d?.title) { this.meta = { title: d.title, channel: d.author || this.meta.channel }; this.emit('meta', this.meta); } } catch { /* */ }
  }

  play() { this.player?.playVideo?.(); }
  pause() { this.player?.pauseVideo?.(); }
  get playing() { return this.state === 1; }
  currentTime() { try { return this.player?.getCurrentTime?.() || 0; } catch { return 0; } }
  playbackRate() { try { return this.player?.getPlaybackRate?.() || 1; } catch { return 1; } }

  setJukebox(on) { this.jukebox = !!on; this.applyAudio(true); this.emit('mode'); }
  setShowInMix(on) { this.showInMix = !!on; this.emit('mode'); }
  setSide(s) { this.xfAssign = s; this.applyAudio(); this.emit('mode'); }
  setVolume(v) { this.volume = v; this.applyAudio(); this.emit('mode'); }

  /** Jukebox: YouTube's own audio, volume = level² × crossfader side × master. Otherwise muted. */
  applyAudio(force = false) {
    const p = this.player;
    if (!p?.mute) return;
    if (!this.jukebox) { if (force || this._lastVol !== -1) { p.mute(); this._lastVol = -1; } return; }
    const E = this.app.engine;
    const mv = E.masterVolume ?? 0.8;
    const vol = jukeboxVolume({ level: this.volume, side: this.xfAssign, crossfader: E.crossfader, curve: E.settings.crossfaderCurve, master: Math.min(1, mv * mv * 1.25) });
    if (force || vol !== this._lastVol) {
      if (this._lastVol === -1 || force) p.unMute();
      p.setVolume(vol); this._lastVol = vol;
    }
  }

  /** State sent to the pop-out window so its own (muted) player follows this one. */
  snapshot() {
    return { videoId: this.videoId, start: this.start || 0, time: this.currentTime(), rate: this.playbackRate(), playing: this.playing, opacity: this.showInMix ? this.weight : 0, at: Date.now() };
  }

  stop() {
    try { this.player?.destroy?.(); } catch { /* */ }
    this.player = null; this.frame = null; this.videoId = null; this.state = -1; this._op = null;
    this.mount?.replaceChildren();
    this.emit('load', null);
  }
}
