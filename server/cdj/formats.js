// Which audio files CDJs / XDJs can play, and FFmpeg conversion of the rest.
//
// Profiles:
//   'nxs2'   CDJ-2000NXS2, CDJ-3000, XDJ-1000MK2, XDJ-XZ, XDJ-RX2/RX3, DJM-REC era:
//            MP3, AAC (M4A), WAV, AIFF, FLAC, ALAC; up to 96 kHz / 24 bit
//   'legacy' CDJ-2000NXS, CDJ-2000, CDJ-900NXS, XDJ-1000, XDJ-RX/RR: MP3, AAC (M4A), WAV, AIFF; up to 48 kHz / 24 bit
// Everything else is converted when FFmpeg is available (lossless -> AIFF, lossy -> MP3 320 or AAC 256), else skipped.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LOSSLESS_EXT = new Set(['.flac', '.alac', '.ape', '.wv', '.tta', '.tak', '.shn', '.dsf', '.dff', '.w64', '.rf64', '.caf', '.aifc', '.wav', '.aif', '.aiff', '.mlp', '.thd']);
const LOSSLESS_CODECS = new Set(['flac', 'alac', 'pcm', 'ape', 'wavpack', 'tta', 'dsd']);

export const PROFILES = {
  nxs2: { label: 'CDJ-3000 / CDJ-2000NXS2 / XDJ-XZ, RX2, RX3, 1000MK2', maxRate: 96000, flac: true, alac: true },
  legacy: { label: 'CDJ-2000NXS / CDJ-2000 / CDJ-900NXS / XDJ-1000, RX', maxRate: 48000, flac: false, alac: false },
};

/**
 * Decide what to do with a source file.
 * @returns {{ action: 'copy'|'convert'|'skip', to?: 'aiff'|'mp3'|'m4a', reason?: string, rate?: number, bits?: number, copyAudio?: boolean }}
 */
export function planFormat({ file, codec = '', sampleRate = 0, bitsPerSample = 0, hasVideo = false }, { profile = 'nxs2', ffmpeg = null } = {}) {
  const prof = PROFILES[profile] || PROFILES.nxs2;
  const ext = path.extname(String(file)).toLowerCase();
  const c = String(codec || '').toLowerCase();
  const tooFast = sampleRate > prof.maxRate;
  const tooDeep = bitsPerSample > 24;
  const lossless = LOSSLESS_EXT.has(ext) || LOSSLESS_CODECS.has(c);
  const convert = (why) => {
    if (!ffmpeg?.path) return { action: 'skip', reason: `${why}; install FFmpeg to convert it` };
    if (lossless) {
      const dsd = ext === '.dsf' || ext === '.dff';
      const family = dsd || !(sampleRate % 44100) ? 44100 : 48000;
      const rate = dsd || tooFast ? family * Math.max(1, Math.floor(prof.maxRate / family)) : 0;
      return { action: 'convert', to: 'aiff', reason: why, rate, bits: dsd || bitsPerSample > 16 ? 24 : 16 };
    }
    if (c === 'aac' && !hasVideo) return { action: 'convert', to: 'm4a', copyAudio: true, reason: why };
    if (ffmpeg.encoders?.libmp3lame) return { action: 'convert', to: 'mp3', reason: why };
    if (ffmpeg.encoders?.aac !== false) return { action: 'convert', to: 'm4a', reason: why };
    return { action: 'skip', reason: `${why}; FFmpeg has no MP3/AAC encoder` };
  };
  if (hasVideo) return convert('video file (players need audio only)');
  switch (ext) {
    case '.mp3': return c && c !== 'mp3' ? convert(`${c} audio in an .mp3 file`) : { action: 'copy' };
    case '.m4a': case '.mp4': case '.m4b':
      if (c === 'alac') return prof.alac && !tooFast && !tooDeep ? { action: 'copy' } : convert('ALAC is not supported by these players');
      return c && c !== 'aac' ? convert(`${c} in an MP4 container`) : { action: 'copy' };
    case '.aac': return convert('raw AAC streams need an M4A container');
    case '.wav': case '.aif': case '.aiff':
      if (tooFast) return convert(`${sampleRate / 1000} kHz is above the players' ${prof.maxRate / 1000} kHz`);
      if (tooDeep) return convert(`${bitsPerSample}-bit audio is not supported`);
      if (c && !c.startsWith('pcm')) return convert(`${c} inside ${ext}`);
      return { action: 'copy' };
    case '.flac':
      if (!prof.flac) return convert('FLAC needs a CDJ-2000NXS2 / CDJ-3000 class player');
      if (tooFast) return convert(`${sampleRate / 1000} kHz is above the players' ${prof.maxRate / 1000} kHz`);
      return { action: 'copy' };
    default: return convert(`${ext.slice(1).toUpperCase() || 'this'} files are not playable on CDJs`);
  }
}

/** Probe FFmpeg's encoders once (findFfmpeg() does not report libmp3lame). */
export async function ffmpegEncoders(ffPath) {
  if (!ffPath) return {};
  const out = await run(ffPath, ['-hide_banner', '-encoders'], { timeout: 15000 }).catch(() => ({ out: '' }));
  return { libmp3lame: /\blibmp3lame\b/.test(out.out), aac: /\baac\b/.test(out.out), pcm_s24be: /\bpcm_s24be\b/.test(out.out) };
}

function run(cmd, args, { timeout = 0, signal, stdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks = []; let err = '';
    p.stdout.on('data', (d) => (stdout ? chunks.push(d) : err.length < 1e5 && (err += d)));
    p.stderr.on('data', (d) => { if (err.length < 1e5) err += d; });
    const kill = () => p.kill('SIGKILL');
    const t = timeout ? setTimeout(kill, timeout) : null;
    signal?.addEventListener('abort', kill, { once: true });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t); signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      if (code === 0 || !stdout) resolve({ code, out: stdout ? Buffer.concat(chunks) : err, err });
      else reject(new Error(`ffmpeg exited with ${code}: ${err.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`));
    });
  });
}

/** Convert `src` to `dest` (written atomically). */
export async function convertAudio(ffPath, src, dest, plan, { signal } = {}) {
  const tmp = `${dest}.part`;
  const args = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-i', src, '-map', '0:a:0', '-vn', '-map_metadata', '0'];
  if (plan.to === 'aiff') {
    args.push('-c:a', plan.bits === 24 ? 'pcm_s24be' : 'pcm_s16be');
    if (plan.rate) args.push('-ar', String(plan.rate));
    args.push('-write_id3v2', '1', '-f', 'aiff');
  } else if (plan.to === 'mp3') args.push('-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3', '-f', 'mp3');
  else args.push('-c:a', plan.copyAudio ? 'copy' : 'aac', ...(plan.copyAudio ? [] : ['-b:a', '256k']), '-movflags', '+faststart', '-f', 'ipod');
  args.push(tmp);
  const r = await run(ffPath, args, { signal, timeout: 30 * 60 * 1000 });
  if (r.code !== 0) throw new Error(`conversion failed: ${String(r.err).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
  await fs.promises.rename(tmp, dest);
}

/** Decode to mono 22.05 kHz float samples (for waveform / BPM analysis of tracks OpenDJ has not analysed). */
export async function decodeMono(ffPath, src, { signal, maxSeconds = 1800 } = {}) {
  const r = await run(ffPath, ['-hide_banner', '-nostdin', '-v', 'error', '-i', src, '-t', String(maxSeconds), '-vn', '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], { signal, stdout: true, timeout: 10 * 60 * 1000 });
  const b = r.out;
  return { sr: 22050, mono: new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)) };
}

/** Album art scaled to a baseline JPEG of `size`×`size` (players expect 80×80 and 240×240). */
export async function scaleArt(ffPath, input, size, { signal } = {}) {
  const r = await new Promise((resolve, reject) => {
    const p = spawn(ffPath, ['-hide_banner', '-nostdin', '-v', 'error', '-i', 'pipe:0', '-vf', `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`, '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', () => {});
    p.stdin.on('error', () => {});
    const kill = () => p.kill('SIGKILL');
    signal?.addEventListener('abort', kill, { once: true });
    const t = setTimeout(kill, 30000);
    p.on('error', reject);
    p.on('close', (code) => { clearTimeout(t); signal?.removeEventListener('abort', kill); code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('artwork conversion failed')); });
    p.stdin.end(input);
  });
  if (r.length < 4 || r[0] !== 0xff || r[1] !== 0xd8) throw new Error('artwork conversion produced no JPEG');
  return r;
}
