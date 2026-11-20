// Formats in the mobile app. There is no FFmpeg on the phone (phase 1): only what the WebView decodes itself is
// accepted - MP3, AAC/M4A, WAV, FLAC, AIFF (converted to WAV in JS where the WebView can't decode it) and Ogg/Opus/WebM
// where the WebView supports them. Formats that need FFmpeg on the desktop (WMA, APE, ALAC on Android, DSD…) are
// refused at import with a clear message. `transcoder` is the hook for a later ffmpeg.wasm (see docs/MOBILE.md).

export const AUDIO_MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac',
  aif: 'audio/aiff', aiff: 'audio/aiff', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm',
  m4v: 'video/mp4', mov: 'video/mp4',
};
/** Always decodable by every WebView we target (iOS 15+ WKWebView, Android System WebView). */
const ALWAYS = new Set(['mp3', 'm4a', 'm4b', 'mp4', 'aac', 'wav', 'flac', 'aif', 'aiff', 'm4v', 'mov']);
/** Decodable where the WebView says so (canPlayType). */
const MAYBE = { ogg: 'audio/ogg; codecs="vorbis"', oga: 'audio/ogg; codecs="vorbis"', opus: 'audio/ogg; codecs="opus"', webm: 'audio/webm; codecs="opus"' };
/** Accepted by the desktop app (with FFmpeg) but not on the phone yet. */
export const DESKTOP_ONLY = new Set(['alac', 'wma', 'ape', 'wv', 'dsf', 'dff', 'ac3', 'eac3', 'ec3', 'dts', 'dtshd', 'mp2', 'mp1', 'mpa', 'amr', 'awb',
  'tta', 'mka', 'au', 'snd', 'caf', 'aifc', '3ga', 'mpc', 'spx', 'ra', 'tak', 'shn', 'w64', 'rf64', 'voc', 'thd', 'mlp',
  'mkv', 'avi', 'flv', 'wmv', 'asf', 'mpg', 'mpeg', 'ts', 'm2ts', 'mts', 'vob', 'ogv', '3gp', '3g2', 'rm', 'rmvb', 'divx']);

export const extOf = (name) => { const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };

const defaultCanPlay = (type) => { try { return !!globalThis.document && document.createElement('audio').canPlayType(type) !== ''; } catch { return false; } };

/**
 * Can this file be imported on this device?
 * @returns {{ ok: boolean, ext: string, mime?: string, reason?: string }}
 */
export function checkFormat(name, { canPlayType = defaultCanPlay, transcoder = null } = {}) {
  const ext = extOf(name);
  if (ALWAYS.has(ext)) return { ok: true, ext, mime: AUDIO_MIME[ext] };
  if (MAYBE[ext]) {
    if (canPlayType(MAYBE[ext])) return { ok: true, ext, mime: AUDIO_MIME[ext] };
    return { ok: false, ext, reason: `${ext.toUpperCase()} files can't be played on this device` };
  }
  if (DESKTOP_ONLY.has(ext)) {
    if (transcoder?.handles?.(ext)) return { ok: true, ext, mime: 'application/octet-stream', transcode: true };
    return { ok: false, ext, reason: `${ext.toUpperCase()} files need FFmpeg, which the mobile app doesn't have yet. Convert them to MP3, AAC, FLAC or WAV, or use the desktop app.` };
  }
  return { ok: false, ext, reason: ext ? `.${ext} is not an audio file OpenDJ can play` : 'Not an audio file' };
}

/** File extensions offered by the import picker. */
export const ACCEPT = Object.keys(AUDIO_MIME).map((e) => '.' + e);

/** Does this WebView need AIFF converted to WAV? (Apple's WebViews decode AIFF; Chromium-based ones don't.) */
export const needsAiffConversion = (canPlayType = defaultCanPlay) => !canPlayType('audio/aiff') && !canPlayType('audio/x-aiff');

const SAFE_IMAGE = /^image\/(jpeg|png|gif|webp|bmp|avif)$/;
export function safeImageType(type) {
  let t = String(type || '').split(';')[0].trim().toLowerCase();
  if (t === 'image/jpg' || t === 'image/pjpeg') t = 'image/jpeg';
  return SAFE_IMAGE.test(t) ? t : null;
}

export const PLACEHOLDER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#20252d"/><path d="M24 11v13.5a4 4 0 1 1-2-3.46V15l-6 1.5v10a4 4 0 1 1-2-3.46V13z" fill="#4a5361"/></svg>';
export const PLACEHOLDER_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(PLACEHOLDER_SVG)}`;

/** File-name-safe text for storage keys ([\w.-] only). */
export const keySafe = (s, max = 60) => String(s || '').normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, max) || 'file';
