// Codec names from music-metadata / ffmpeg, shared by the desktop server (server/media.js) and the mobile app.

/** Normalise a codec name from music-metadata or ffmpeg ("MPEG4/ISO/AVC", "<avc1>", "h264 (High)") to a short id. */
export function normCodec(name) {
  const s = String(name || '').toLowerCase();
  if (!s) return '';
  if (/avc|h\.?264/.test(s)) return 'h264';
  if (/hevc|hvc1|hev1|h\.?265/.test(s)) return 'hevc';
  if (/vp0?9/.test(s)) return 'vp9';
  if (/vp0?8/.test(s)) return 'vp8';
  if (/av01|\bav1\b/.test(s)) return 'av1';
  if (/mp4v|mpeg-?4 ?(video|part ?2)|xvid|divx/.test(s)) return 'mpeg4';
  if (/mpeg-?[12]video|mpeg1video|mpeg2video/.test(s)) return 'mpeg2';
  if (/wmv|vc-?1/.test(s)) return 'wmv';
  if (/theora/.test(s)) return 'theora';
  if (/mjpeg|jpeg|png/.test(s)) return 'image';
  if (/alac|apple lossless/.test(s)) return 'alac';
  if (/aac/.test(s)) return 'aac';
  if (/mp3|mpeg.*layer ?(3|iii)|mpeg 1 layer 3/.test(s)) return 'mp3';
  if (/mp2|layer ?(2|ii)/.test(s)) return 'mp2';
  if (/opus/.test(s)) return 'opus';
  if (/vorbis/.test(s)) return 'vorbis';
  if (/flac/.test(s)) return 'flac';
  if (/e-?ac-?3|eac3/.test(s)) return 'eac3';
  if (/ac-?3|dolby/.test(s)) return 'ac3';
  if (/dts/.test(s)) return 'dts';
  if (/wma|windows media/.test(s)) return 'wma';
  if (/speex/.test(s)) return 'speex';
  if (/adpcm|gsm|g\.?72\d|ima4|qdm|mace/.test(s)) return 'adpcm';
  if (/dsd/.test(s)) return 'dsd';
  if (/pcm|twos|sowt|lpcm|none/.test(s)) return 'pcm';
  return s.replace(/[^a-z0-9]+/g, '').slice(0, 16);
}

export const VIDEO_CODEC_IDS = new Set(['h264', 'hevc', 'vp9', 'vp8', 'av1', 'mpeg4', 'mpeg2', 'wmv', 'theora']);

/** Video stream info from a music-metadata `format` (its trackInfo). */
export function mmVideoInfo(format) {
  for (const t of format?.trackInfo || []) {
    const c = normCodec(t.codecName);
    if (t.type === 1 || t.video || VIDEO_CODEC_IDS.has(c)) return { hasVideo: c !== 'image', videoCodec: c };
  }
  return { hasVideo: false, videoCodec: '' };
}
