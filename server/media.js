// Media formats + FFmpeg discovery/probing.
//
// Chromium decodes mp3 / aac (m4a) / flac / wav / ogg (vorbis, opus, flac) / webm itself and AIFF is converted
// in-process (aiff.js). Everything else (ALAC, WMA, APE, WavPack, DSD, AC3, DTS, …, and the audio track of video
// files) is transcoded by FFmpeg (transcode.js). FFmpeg is looked up in this order:
//   1. OPENDJ_FFMPEG (or the `ffmpeg` option of createServer): a path, or "none" to disable;
//   2. the bundled `ffmpeg-static` binary (optionalDependency; app.asar -> app.asar.unpacked in packaged Electron);
//   3. `ffmpeg` on PATH.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { normCodec, mmVideoInfo } from '../public/js/shared/codec.js';

export { normCodec, mmVideoInfo };
const require = createRequire(import.meta.url);

/** Played by the browser as is (aiff/aif are converted to WAV in-process by aiff.js). */
export const BROWSER_AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.m4b', '.aac', '.mp4', '.ogg', '.oga', '.opus', '.webm', '.aif', '.aiff']);
/** Audio-only formats that need FFmpeg. */
export const TRANSCODE_AUDIO_EXT = new Set([
  '.alac', '.wma', '.ape', '.wv', '.dsf', '.dff', '.ac3', '.eac3', '.ec3', '.dts', '.dtshd', '.mp2', '.mp1', '.mpa', '.amr', '.awb',
  '.tta', '.mka', '.au', '.snd', '.caf', '.aifc', '.3ga', '.mpc', '.spx', '.ra', '.tak', '.shn', '.w64', '.rf64', '.voc', '.thd', '.mlp',
]);
/** Containers that may carry video. `.mp4`/`.webm`/`.3gp` are also common audio-only containers: probed, not assumed. */
export const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.flv', '.wmv', '.asf', '.mpg', '.mpeg', '.ts', '.m2ts', '.mts', '.vob', '.ogv', '.3gp', '.3g2', '.rm', '.rmvb', '.divx']);
/** Extensions that are video by convention (an audio-only file would use the audio twin: .mka, .m4a, .oga…). */
const VIDEO_BY_NAME = new Set(['.m4v', '.mov', '.mkv', '.avi', '.flv', '.wmv', '.mpg', '.mpeg', '.ts', '.m2ts', '.mts', '.vob', '.ogv', '.rmvb', '.divx']);
/** Video containers Chromium plays in a <video> element (when the codecs are h264/vp8/vp9/av1 + aac/mp3/opus/vorbis). */
export const BROWSER_VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov']);
const BROWSER_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_VIDEO_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', '']);
export const MEDIA_EXT = new Set([...BROWSER_AUDIO_EXT, ...TRANSCODE_AUDIO_EXT, ...VIDEO_EXT]);
export const DSD_EXT = new Set(['.dsf', '.dff']);

export const VIDEO_MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm' };


/** Does this file need FFmpeg to become browser-decodable audio? */
export function needsTranscode({ ext, codec = '', hasVideo = false } = {}) {
  ext = String(ext || '').toLowerCase();
  if (ext && !ext.startsWith('.')) ext = '.' + ext;
  const c = normCodec(codec);
  if (TRANSCODE_AUDIO_EXT.has(ext)) return true;
  if (hasVideo) return true; // extract the audio track (smaller + decodable, instead of the whole video file)
  if (VIDEO_EXT.has(ext) && !BROWSER_AUDIO_EXT.has(ext)) return true;
  if (c === 'alac') return true;
  if ((ext === '.wav' || ext === '.aif' || ext === '.aiff') && /adpcm|wma|speex|ac3|dts/.test(c)) return true;
  if ((ext === '.ogg' || ext === '.oga') && c === 'speex') return true;
  if ((ext === '.m4a' || ext === '.mp4' || ext === '.m4b') && /ac3|eac3|dts|mp2/.test(c)) return true;
  return false;
}

/** Remote tracks: the media server reports the container/extension in `format`. */
export function remoteBrowserDecodable(format) {
  const f = String(format || '').toLowerCase().replace(/^\./, '');
  if (!f) return true; // unknown: try as is
  return ['mp3', 'mpeg', 'flac', 'wav', 'wave', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'webm', 'vorbis'].includes(f);
}

export function isVideoByName(ext) { return VIDEO_BY_NAME.has(String(ext).toLowerCase()); }

/** Is the video playable directly in Chromium? (needs container + codec info) */
export function browserPlayableVideo(ext, videoCodec, audioCodec) {
  if (!BROWSER_VIDEO_EXT.has(ext)) return false;
  if (!videoCodec) return true; // unknown: let the browser try
  return BROWSER_VIDEO_CODECS.has(videoCodec) && BROWSER_VIDEO_AUDIO.has(audioCodec || '');
}

/** hasVideo from music-metadata's format (mp4 parser reports the avc1 track with type 2, so look at codec names too). */
// ---------------------------------------------------------------- ffmpeg discovery

function run(bin, args, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let p;
    try { p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return resolve({ code: -1, out, err: e.message }); }
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', (d) => { if (out.length < 1e6) out += d; });
    p.stderr.on('data', (d) => { if (err.length < 1e6) err += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** Path of the bundled ffmpeg-static binary, mapped out of app.asar in packaged Electron. */
export function bundledFfmpegPath() {
  try {
    let p = require('ffmpeg-static');
    if (!p) return null;
    p = p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    return fs.existsSync(p) ? p : null;
  } catch { return null; }
}

/**
 * Find a working ffmpeg. `explicit`: a path, false/"none" (disabled), or undefined (auto).
 * Returns { path, version, source, encoders: { libx264, aac } } or null.
 */
export async function findFfmpeg(explicit = process.env.OPENDJ_FFMPEG) {
  const cands = [];
  if (explicit === false || explicit === 'none' || explicit === '0') return null;
  if (explicit) cands.push({ path: String(explicit), source: 'config' });
  else {
    const b = bundledFfmpegPath();
    if (b) cands.push({ path: b, source: 'bundled' });
    cands.push({ path: process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg', source: 'path' });
  }
  for (const c of cands) {
    const r = await run(c.path, ['-hide_banner', '-version']);
    const m = /ffmpeg version (\S+)/.exec(r.out + r.err);
    if (r.code !== 0 || !m) continue;
    const enc = await run(c.path, ['-hide_banner', '-encoders']);
    return { ...c, version: m[1], encoders: { libx264: /\blibx264\b/.test(enc.out), aac: /\baac\b/.test(enc.out), flac: /\bflac\b/.test(enc.out) } };
  }
  return null;
}

/**
 * Probe a file with `ffmpeg -i` (no ffprobe needed): streams, codecs, duration, sample rate.
 * Cover art ("attached pic") is not counted as video.
 */
export async function probe(ffmpegPath, file, { timeout = 15000 } = {}) {
  const r = await run(ffmpegPath, ['-hide_banner', '-nostdin', '-i', file], { timeout });
  const txt = r.err;
  const info = { duration: null, hasVideo: false, videoCodec: '', audioCodec: '', sampleRate: null, channels: null, hasAudio: false, bitrate: null };
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(txt);
  if (d) info.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const br = /bitrate: (\d+) kb\/s/.exec(txt);
  if (br) info.bitrate = Number(br[1]);
  for (const line of txt.split('\n')) {
    const s = /Stream #\d+:\d+.*?: (Video|Audio): ([^\s,]+)(.*)/.exec(line);
    if (!s) continue;
    if (s[1] === 'Video') {
      if (/attached pic/.test(line) || /^(mjpeg|png|bmp|gif)$/.test(s[2])) continue;
      if (!info.hasVideo) { info.hasVideo = true; info.videoCodec = normCodec(s[2]); }
    } else if (!info.hasAudio) {
      info.hasAudio = true;
      info.audioCodec = normCodec(s[2]);
      const sr = /(\d+) Hz/.exec(s[3]); if (sr) info.sampleRate = Number(sr[1]);
      const ch = /Hz, ([^,]+)/.exec(s[3]);
      if (ch) {
        const l = ch[1].trim(), sum = /(\d+)\.(\d+)/.exec(l);
        info.channels = l.startsWith('mono') ? 1 : l.startsWith('stereo') ? 2 : sum ? Number(sum[1]) + Number(sum[2]) : (parseInt(l, 10) || null);
      }
    }
  }
  if (!info.hasAudio && !info.hasVideo && !d) return null;
  return info;
}

export function extOf(file) { return path.extname(String(file || '')).toLowerCase(); }

/** Formats list for /api/capabilities. */
export function formatList(ffmpeg) {
  const strip = (s) => [...s].map((e) => e.slice(1));
  return {
    native: strip(BROWSER_AUDIO_EXT),
    transcoded: ffmpeg ? strip(TRANSCODE_AUDIO_EXT) : [],
    video: ffmpeg ? strip(VIDEO_EXT) : strip(BROWSER_VIDEO_EXT),
    all: ffmpeg ? strip(MEDIA_EXT) : strip(new Set([...BROWSER_AUDIO_EXT, ...BROWSER_VIDEO_EXT])),
  };
}
