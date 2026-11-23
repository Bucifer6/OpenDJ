// Pure video helpers (no DOM): layer weights from the mixer state, A/B video transitions,
// the video-to-deck drift controller, YouTube URL parsing and Data API mapping.
// Everything here is unit-tested in test/video-core.test.js.

export const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm']);
export const VISUAL_STYLES = [
  { id: 'ring', name: 'Cover spectrum ring' },
  { id: 'bars', name: 'Spectrum skyline' },
  { id: 'scope', name: 'Neon waveform' },
  { id: 'orbit', name: 'Particle orbit' },
  { id: 'tunnel', name: 'Prism tunnel' },
];
export const visualStyle = id => VISUAL_STYLES.some(s => s.id === id) ? id : 'ring';
export const TRANSITIONS = [
  { id: 'crossfade', name: 'Crossfade (follow audio)' },
  { id: 'cut', name: 'Cut' },
  { id: 'black', name: 'Dissolve to black' },
  { id: 'wipeleft', name: 'Wipe left' },
  { id: 'wiperight', name: 'Wipe right' },
  { id: 'zoom', name: 'Zoom' },
];
export const FX = [
  { id: 'pulse', name: 'Beat pulse' },
  { id: 'strobe', name: 'Strobe' },
  { id: 'mirror', name: 'Mirror' },
  { id: 'invert', name: 'Invert' },
  { id: 'blur', name: 'Blur' },
  { id: 'rgb', name: 'RGB shift', gl: true },
  { id: 'kaleido', name: 'Kaleidoscope', gl: true },
];

/** Does this track carry (or probably carry) a picture? Server sets hasVideo; native containers are probed. */
export function isVideoCandidate(track) {
  if (!track) return false;
  if (track.hasVideo) return true;
  if (track.hasVideo === false) return false;
  return VIDEO_EXT.has(String(track.format || '').toLowerCase());
}

/**
 * Crossfader gain for one side, the same curves as Engine.applyCrossfader().
 * @param {'A'|'B'|'THRU'} side
 * @param {number} crossfader -1 (A) .. 1 (B)
 * @param {string} curve 'smooth' (default) | 'sharp' | 'constant'
 */
export function crossfaderGain(side, crossfader, curve) {
  if (side !== 'A' && side !== 'B') return 1;
  const x = (Math.max(-1, Math.min(1, crossfader || 0)) + 1) / 2;
  const p = side === 'A' ? x : 1 - x; // 0 = fully this side
  if (curve === 'sharp') return p < 0.92 ? 1 : (1 - p) / 0.08;
  if (curve === 'constant') return Math.min(1, 2 * (1 - p));
  return Math.min(1, Math.cos(p * Math.PI / 2) / Math.cos(Math.PI / 4));
}

/** Audible level of a channel: fader volume² (as Channel.apply) × crossfader gain. */
export function channelLevel(volume, xfAssign, crossfader, curve) {
  const v = Math.max(0, Math.min(1, volume ?? 0));
  return v * v * crossfaderGain(xfAssign, crossfader, curve);
}

const ease = (t) => t * t * (3 - 2 * t);

/**
 * Compute how each layer is drawn.
 * @param {object} s
 * @param {Array<{volume:number, xfAssign:string, active:boolean}>} s.layers  one per source (decks, YouTube…)
 * @param {number} s.crossfader -1..1
 * @param {string} [s.curve]
 * @param {string} [s.transition] one of TRANSITIONS ids
 * @returns {Array<{alpha:number, scale:number, clip:[number, number]}>} alpha 0..1 (additive weight),
 *   scale (zoom around centre, 1 = fit), clip = visible horizontal range in 0..1 output space
 */
export function computeLayers({ layers, crossfader = 0, curve = 'smooth', transition = 'crossfade' }) {
  const x = (Math.max(-1, Math.min(1, crossfader)) + 1) / 2; // 0 = A .. 1 = B
  const out = layers.map(() => ({ alpha: 0, scale: 1, clip: [0, 1] }));
  if (transition === 'crossfade' || !TRANSITIONS.some((t) => t.id === transition)) {
    const g = layers.map((l) => (l.active ? channelLevel(l.volume, l.xfAssign, crossfader, curve) : 0));
    const sum = g.reduce((a, b) => a + b, 0);
    const norm = Math.max(1, sum); // two full layers blend 50/50; a lone layer fades to black with its fader
    g.forEach((v, i) => { out[i].alpha = v / norm; });
    return out;
  }
  // A/B transitions: the crossfader moves between side A and side B; THRU layers always count.
  // Within a side, layers share by fader level² (normalised so a single full layer is opaque).
  const fader = layers.map((l) => (l.active ? Math.max(0, Math.min(1, l.volume ?? 0)) ** 2 : 0));
  const sideSum = { A: 0, B: 0, THRU: 0 };
  layers.forEach((l, i) => { sideSum[sideOf(l)] += fader[i]; });
  const total = sideSum.A + sideSum.B + sideSum.THRU;
  const share = (i) => fader[i] / Math.max(1, sideOf(layers[i]) === 'THRU' ? total : sideSum[sideOf(layers[i])] + sideSum.THRU);
  let wA = 0, wB = 0, scaleA = 1, scaleB = 1, clipA = [0, 1], clipB = [0, 1];
  switch (transition) {
    case 'cut': wA = x < 0.5 ? 1 : 0; wB = 1 - wA; break;
    case 'black': wA = ease(Math.max(0, 1 - 2 * x)); wB = ease(Math.max(0, 2 * x - 1)); break;
    case 'wipeleft': wA = 1; wB = 1; clipA = [0, 1 - x]; clipB = [1 - x, 1]; break; // B enters from the right edge moving left
    case 'wiperight': wA = 1; wB = 1; clipA = [x, 1]; clipB = [0, x]; break;
    case 'zoom': wA = ease(1 - x); wB = ease(x); scaleA = 1 + 0.6 * x; scaleB = 0.4 + 0.6 * x; break;
  }
  // A side empty -> B fills, and vice versa (don't wipe to black when nothing is on the other side)
  if (sideSum.A === 0 && sideSum.B > 0) { wB = 1; scaleB = 1; clipB = [0, 1]; }
  if (sideSum.B === 0 && sideSum.A > 0) { wA = 1; scaleA = 1; clipA = [0, 1]; }
  layers.forEach((l, i) => {
    const side = sideOf(l);
    if (side === 'THRU') { out[i].alpha = share(i); return; }
    const o = out[i];
    o.alpha = share(i) * (side === 'A' ? wA : wB);
    o.scale = side === 'A' ? scaleA : scaleB;
    o.clip = side === 'A' ? clipA : clipB;
    if (o.clip[1] - o.clip[0] <= 1e-4) o.alpha = 0;
  });
  return out;
}
const sideOf = (l) => (l.xfAssign === 'A' || l.xfAssign === 'B' ? l.xfAssign : 'THRU');

/** Index of the most visible layer (alpha ≥ min), or -1. */
export function dominantLayer(weights, min = 0.5) {
  let best = -1, a = min;
  weights.forEach((w, i) => { if (w.alpha * (w.clip[1] - w.clip[0]) >= a) { a = w.alpha * (w.clip[1] - w.clip[0]); best = i; } });
  return best;
}

// ---------------------------------------------------------------- drift controller
export const SYNC = { seekThreshold: 0.08, nudgeThreshold: 0.015, nudge: 0.03, minRate: 0.25, maxRate: 4 };

/**
 * Decide what a <video> should do to follow its deck. Called every frame; returns a command.
 * @param {object} p
 * @param {number} p.videoTime   video.currentTime
 * @param {number} p.target      deck.position (seconds)
 * @param {number} p.rate        deck playback rate (signed; 0 when paused)
 * @param {boolean} p.playing    deck.playing
 * @param {boolean} p.videoPaused video.paused
 * @param {boolean} p.seeking    video.seeking (a seek is still in flight)
 * @param {boolean} [p.scratching] deck under jog / scratch control
 * @param {number} [p.duration]  video duration
 * @param {number} [p.seekLatency] measured seconds a seek takes (lead the target by it when playing)
 * @returns {{action:'none'|'seek'|'rate'|'pause'|'play', time?:number, playbackRate?:number, drift:number, mode:string}}
 */
export function syncDecision(p) {
  const dur = p.duration > 0 ? p.duration : Infinity;
  const target = Math.max(0, Math.min(p.target, dur - 0.05));
  const drift = p.videoTime - target; // + = video ahead
  const rate = p.playing ? p.rate : 0;
  const free = p.playing && !p.scratching && rate >= SYNC.minRate && rate <= SYNC.maxRate;
  if (!free) {
    // paused, scratching, reverse, brake, very slow: freeze the video and seek it frame by frame
    if (!p.videoPaused) return { action: 'pause', drift, mode: 'frame' };
    if (p.seeking) return { action: 'none', drift, mode: 'frame' };
    if (Math.abs(drift) > 1 / 60) return { action: 'seek', time: target, drift, mode: 'frame' };
    return { action: 'none', drift, mode: 'frame' };
  }
  if (p.seeking) return { action: 'none', drift, mode: 'seeking' };
  if (Math.abs(drift) > SYNC.seekThreshold) {
    const lead = Math.min(0.5, Math.max(0, p.seekLatency || 0)) * rate; // land where the deck will be when the seek completes
    return { action: 'seek', time: Math.min(target + lead, dur - 0.05), drift, mode: 'seek', playbackRate: rate };
  }
  if (p.videoPaused) return { action: 'play', drift, mode: 'play', playbackRate: rate };
  let pr = rate;
  if (Math.abs(drift) > SYNC.nudgeThreshold) pr = rate * (drift > 0 ? 1 - SYNC.nudge : 1 + SYNC.nudge);
  return { action: 'rate', playbackRate: pr, drift, mode: Math.abs(drift) > SYNC.nudgeThreshold ? 'nudge' : 'locked' };
}

// ---------------------------------------------------------------- YouTube
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** Parse "1h2m3s", "90", "90s" → seconds. */
export function parseYouTubeTime(t) {
  if (t == null || t === '') return 0;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(t));
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
}

/**
 * Accepts any common YouTube URL form or a bare 11-character ID.
 * @returns {{id:string, start:number}|null}
 */
export function parseYouTube(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (YT_ID.test(s)) return { id: s, start: 0 };
  let u;
  try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(?:embed|shorts|live|v|e)\/([^/?#]+)/.exec(u.pathname);
      if (m) id = m[1];
    }
  }
  if (!id || !YT_ID.test(id)) return null;
  const start = parseYouTubeTime(u.searchParams.get('t') || u.searchParams.get('start') || (u.hash.match(/t=([\dhms.]+)/) || [])[1]);
  return { id, start };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
export const decodeEntities = (s) => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
  if (ENT[e.toLowerCase()] != null) return ENT[e.toLowerCase()];
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return m;
});

/** Build a YouTube Data API v3 search URL (the user's own key). */
export function youTubeSearchUrl(q, key, { max = 15, pageToken } = {}) {
  const p = new URLSearchParams({ part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: String(max), q, key });
  if (pageToken) p.set('pageToken', pageToken);
  return `https://www.googleapis.com/youtube/v3/search?${p}`;
}

/** Map a search.list response to plain result rows. Throws a readable error for API errors. */
export function mapYouTubeSearch(json) {
  if (json?.error) {
    const reason = json.error.errors?.[0]?.reason;
    const msg = reason === 'quotaExceeded' ? 'YouTube API quota exceeded for this key'
      : reason === 'keyInvalid' || /API key not valid/i.test(json.error.message || '') ? 'YouTube API key is not valid'
      : json.error.message || 'YouTube search failed';
    throw new Error(msg);
  }
  const items = (json?.items || []).filter((it) => it?.id?.videoId && YT_ID.test(it.id.videoId));
  return {
    next: json?.nextPageToken || null,
    items: items.map((it) => {
      const sn = it.snippet || {}, th = sn.thumbnails || {};
      return {
        id: it.id.videoId,
        title: decodeEntities(sn.title || ''),
        channel: decodeEntities(sn.channelTitle || ''),
        thumb: (th.medium || th.default || th.high || {}).url || `https://i.ytimg.com/vi/${it.id.videoId}/mqdefault.jpg`,
        published: sn.publishedAt || '',
        live: sn.liveBroadcastContent === 'live',
      };
    }),
  };
}

/** YouTube player volume (0..100) for jukebox mode: level² × crossfader side gain × master. */
export function jukeboxVolume({ level = 1, side = 'THRU', crossfader = 0, curve, master = 1 }) {
  return Math.round(100 * Math.max(0, Math.min(1, channelLevel(level, side, crossfader, curve) * master)));
}

/** "Artist – Title" for the lower third. */
export function nowPlayingText(track) {
  if (!track) return '';
  const title = (track.title || '').trim(), artist = (track.artist || '').trim();
  return artist && title ? `${artist} – ${title}` : title || artist;
}

/** Lower-third opacity over its lifetime (fade in 0.6 s, hold, fade out 0.8 s). */
export function lowerThirdAlpha(t, hold = 8) {
  if (t < 0) return 0;
  if (t < 0.6) return t / 0.6;
  if (t < 0.6 + hold) return 1;
  return Math.max(0, 1 - (t - 0.6 - hold) / 0.8);
}

/** Fit a source of (sw × sh) into (dw × dh) "cover"-style: returns the UV scale for the centre crop. */
export function coverUv(sw, sh, dw, dh) {
  if (!sw || !sh || !dw || !dh) return [1, 1];
  const s = sw / sh, d = dw / dh;
  return s > d ? [d / s, 1] : [1, s / d];
}
