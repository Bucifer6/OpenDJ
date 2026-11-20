// Mix recording that streams to disk.
//
// The browser taps the master output with an AudioWorklet and POSTs ~0.5 s PCM chunks (s16le or f32le, interleaved
// stereo) with sequence numbers to /api/recording/:id/chunk. Chunks are re-ordered here (retries and parallel
// uploads can arrive out of order), then written:
//   - WAV natively (no FFmpeg needed). The header is rewritten every few seconds so a crash leaves a playable file;
//     past 4 GB the file switches to RF64 (a JUNK chunk is reserved up front for the ds64 chunk).
//   - FLAC / MP3 / AAC (.m4a) / Ogg Opus through FFmpeg (PCM on stdin, with backpressure).
// Optional auto-split every N minutes. A tracklist (deck play events from the browser) is written beside each file
// as a .cue sheet and a .txt with timestamps, and kept up to date while recording.
//
// Registered from server/index.js: registerRecordingRoutes({ route, library, emit, pathAllowed, allowedRoots }).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseFile } from 'music-metadata';
import { DEFAULT_SETTINGS } from './library.js';
import { readJsonSafe, writeJsonAtomic } from './jsonstore.js';
import { safe, uniqueName } from './remote.js';

export const httpError = (status, msg, code) => Object.assign(new Error(msg), { status, ...(code ? { code } : {}) });

// ------------------------------------------------------------------ formats

export const REC_FORMATS = {
  wav: { label: 'WAV (lossless, no FFmpeg needed)', ext: 'wav', lossless: true, native: true, mime: 'audio/wav' },
  flac: { label: 'FLAC (lossless)', ext: 'flac', lossless: true, mime: 'audio/flac' },
  mp3: { label: 'MP3', ext: 'mp3', bitrates: [128, 192, 256, 320], bitrate: 320, mime: 'audio/mpeg' },
  aac: { label: 'AAC (.m4a)', ext: 'm4a', bitrates: [128, 192, 256, 320], bitrate: 256, mime: 'audio/mp4' },
  opus: { label: 'Ogg Opus', ext: 'opus', bitrates: [96, 128, 160, 192, 256], bitrate: 192, mime: 'audio/ogg' },
};
const AUDIO_EXTS = new Set(Object.values(REC_FORMATS).map((f) => '.' + f.ext));
const MIME_BY_EXT = { ...Object.fromEntries(Object.values(REC_FORMATS).map((f) => ['.' + f.ext, f.mime])), '.cue': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

/** FFmpeg output arguments (after the PCM input) for a recording format. */
export function encoderArgs(format, { bitrate, bits = 16, title, artist } = {}) {
  const f = REC_FORMATS[format];
  if (!f || f.native) throw new Error(`No encoder for ${format}`);
  const br = `${Math.round(Math.min(512, Math.max(32, Number(bitrate) || f.bitrate || 192)))}k`;
  const meta = [];
  if (title) meta.push('-metadata', `title=${title}`);
  if (artist) meta.push('-metadata', `artist=${artist}`);
  meta.push('-metadata', 'comment=Recorded with OpenDJ');
  switch (format) {
    case 'flac': return ['-c:a', 'flac', '-compression_level', '5', ...(bits === 24 ? ['-sample_fmt', 's32', '-bits_per_raw_sample', '24'] : ['-sample_fmt', 's16']), ...meta, '-f', 'flac'];
    case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', br, '-id3v2_version', '3', ...meta, '-f', 'mp3'];
    case 'aac': return ['-c:a', 'aac', '-b:a', br, '-movflags', '+faststart', ...meta, '-f', 'mp4'];
    case 'opus': return ['-c:a', 'libopus', '-b:a', br, '-vbr', 'on', '-ar', '48000', ...meta, '-f', 'ogg'];
    default: throw new Error(`No encoder for ${format}`);
  }
}

// ------------------------------------------------------------------ WAV / RF64

export const WAV_HEADER_BYTES = 80;
const U32_MAX = 0xFFFFFFFF;

/**
 * 80-byte WAV header: RIFF + JUNK(28) + fmt(16) + data, or RF64 + ds64(28) + fmt + data once the file needs more
 * than 32-bit sizes (EBU Tech 3306). The JUNK chunk reserves the space so a file can switch to RF64 in place.
 */
export function wavHeader({ sampleRate, channels = 2, bits = 16, dataBytes = 0, forceRf64 = false }) {
  const b = Buffer.alloc(WAV_HEADER_BYTES);
  const riffSize = dataBytes + WAV_HEADER_BYTES - 8;
  const rf64 = forceRf64 || riffSize > U32_MAX;
  const block = channels * (bits / 8);
  b.write(rf64 ? 'RF64' : 'RIFF', 0, 'ascii');
  b.writeUInt32LE(rf64 ? U32_MAX : riffSize, 4);
  b.write('WAVE', 8, 'ascii');
  b.write(rf64 ? 'ds64' : 'JUNK', 12, 'ascii');
  b.writeUInt32LE(28, 16);
  if (rf64) {
    b.writeBigUInt64LE(BigInt(riffSize), 20);
    b.writeBigUInt64LE(BigInt(dataBytes), 28);
    b.writeBigUInt64LE(BigInt(Math.floor(dataBytes / block)), 36);
    b.writeUInt32LE(0, 44); // no table entries
  }
  b.write('fmt ', 48, 'ascii');
  b.writeUInt32LE(16, 52);
  b.writeUInt16LE(1, 56); // PCM
  b.writeUInt16LE(channels, 58);
  b.writeUInt32LE(sampleRate, 60);
  b.writeUInt32LE(sampleRate * block, 64);
  b.writeUInt16LE(block, 68);
  b.writeUInt16LE(bits, 70);
  b.write('data', 72, 'ascii');
  b.writeUInt32LE(rf64 ? U32_MAX : dataBytes, 76);
  return b;
}

/** Read back the header written by wavHeader() (for tests / repair). */
export function parseWavHeader(b) {
  const kind = b.toString('ascii', 0, 4);
  const rf64 = kind === 'RF64';
  return {
    kind, rf64,
    channels: b.readUInt16LE(58), sampleRate: b.readUInt32LE(60), bits: b.readUInt16LE(70),
    dataBytes: rf64 ? Number(b.readBigUInt64LE(28)) : b.readUInt32LE(76),
    riffSize: rf64 ? Number(b.readBigUInt64LE(20)) : b.readUInt32LE(4),
  };
}

/** Convert interleaved PCM to the WAV sample format. s16 -> 16-bit is a pass-through. */
export function convertPcm(buf, inFmt, outBits) {
  if (inFmt === 's16' && outBits === 16) return buf;
  const n = inFmt === 'f32' ? buf.length >> 2 : buf.length >> 1;
  const read = inFmt === 'f32' ? (i) => buf.readFloatLE(i * 4) : (i) => buf.readInt16LE(i * 2) / 32768;
  const out = Buffer.allocUnsafe(n * (outBits / 8));
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, read(i)));
    if (outBits === 16) out.writeInt16LE(Math.round(v * 32767), i * 2);
    else out.writeIntLE(Math.round(v * 8388607), i * 3, 3);
  }
  return out;
}

export class WavWriter {
  constructor(file, { sampleRate, channels = 2, bits = 16, inFormat = 's16', headerEveryMs = 5000 }) {
    Object.assign(this, { file, sampleRate, channels, bits, inFormat, headerEveryMs });
    this.dataBytes = 0; this.fh = null; this.lastHeader = 0;
  }
  async open() {
    this.fh = await fs.promises.open(this.file, 'wx');
    await this.fh.write(wavHeader(this), 0, WAV_HEADER_BYTES, 0);
    this.lastHeader = Date.now();
  }
  get bytes() { return WAV_HEADER_BYTES + this.dataBytes; }
  async write(buf) {
    const out = convertPcm(buf, this.inFormat, this.bits);
    await this.fh.write(out, 0, out.length, WAV_HEADER_BYTES + this.dataBytes);
    this.dataBytes += out.length;
    if (Date.now() - this.lastHeader > this.headerEveryMs) await this.writeHeader();
  }
  async writeHeader() {
    this.lastHeader = Date.now();
    await this.fh.write(wavHeader(this), 0, WAV_HEADER_BYTES, 0);
  }
  async close() {
    if (!this.fh) return;
    await this.writeHeader();
    await this.fh.close();
    this.fh = null;
  }
  async abort() { try { await this.close(); } catch { /* already closed */ } }
}

/** Encodes through FFmpeg: PCM on stdin (with backpressure), the encoded file written by FFmpeg. */
export class FfmpegWriter {
  constructor(file, { ffmpegPath, sampleRate, channels = 2, inFormat = 's16', format, bitrate, bits, title, artist }) {
    Object.assign(this, { file, ffmpegPath, sampleRate, channels, inFormat, format });
    this.args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', inFormat === 'f32' ? 'f32le' : 's16le', '-ar', String(sampleRate), '-ac', String(channels), '-i', 'pipe:0',
      ...encoderArgs(format, { bitrate, bits, title, artist }), '-y', file];
    this.err = ''; this.exited = null; this._bytes = 0; this._statAt = 0;
  }
  async open() {
    // FFmpeg's -y would overwrite: claim the name first so two recordings never share a file
    await (await fs.promises.open(this.file, 'wx')).close();
    this.proc = spawn(this.ffmpegPath, this.args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    this.proc.stderr.on('data', (d) => { if (this.err.length < 8000) this.err += d; });
    this.done = new Promise((resolve) => {
      this.proc.on('error', (e) => { this.err += e.message; this.exited = -1; resolve(-1); });
      this.proc.on('close', (code) => { this.exited = code; resolve(code); });
    });
    this.proc.stdin.on('error', () => { /* reported through exit code */ });
  }
  get bytes() {
    if (Date.now() - this._statAt > 1000) { this._statAt = Date.now(); try { this._bytes = fs.statSync(this.file).size; } catch { /* not yet */ } }
    return this._bytes;
  }
  failure() { return httpError(500, `FFmpeg stopped while recording: ${this.err.trim().split('\n').slice(-2).join(' ') || `exit code ${this.exited}`}`); }
  async write(buf) {
    if (this.exited !== null) throw this.failure();
    if (!this.proc.stdin.write(buf)) {
      await Promise.race([once(this.proc.stdin, 'drain'), this.done]);
      if (this.exited !== null) throw this.failure();
    }
  }
  async close() {
    if (!this.proc) return;
    this.proc.stdin.end();
    const code = await Promise.race([this.done, new Promise((r) => setTimeout(() => r('timeout'), 60000))]);
    if (code === 'timeout') { this.proc.kill('SIGKILL'); throw httpError(500, 'FFmpeg did not finish the recording in time'); }
    this._statAt = 0;
    if (code !== 0) throw this.failure();
  }
  async abort() { try { this.proc?.stdin.end(); await Promise.race([this.done, new Promise((r) => setTimeout(r, 5000))]); } catch { /* */ } if (this.exited === null) this.proc?.kill('SIGKILL'); }
}

// ------------------------------------------------------------------ cue sheet / tracklist

/** CD-frame time (75 frames/s) used by cue sheets: MM:SS:FF, minutes not capped at 99. */
export function cueTime(sec) {
  const f = Math.max(0, Math.round(sec * 75));
  const m = Math.floor(f / 4500), s = Math.floor((f % 4500) / 75), fr = f % 75;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
}
/** hh:mm:ss (or mm:ss below an hour). */
export function clockTime(sec, long = false) {
  const t = Math.max(0, Math.floor(sec)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h || long ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
const cueStr = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, "'").trim().slice(0, 200);

/** Normalise tracklist entries: sorted, de-duplicated consecutive repeats, numbers only. */
export function normTracklist(tracks) {
  const out = [];
  for (const t of [...(tracks || [])].filter((x) => x && Number.isFinite(Number(x.t))).sort((a, b) => a.t - b.t)) {
    const e = { t: Math.max(0, Number(t.t)), artist: String(t.artist || '').slice(0, 300), title: String(t.title || 'Unknown').slice(0, 300), ...(t.trackId ? { trackId: String(t.trackId).slice(0, 64) } : {}) };
    const prev = out.at(-1);
    if (prev && prev.title === e.title && prev.artist === e.artist) continue;
    out.push(e);
  }
  return out;
}

/**
 * Cue sheet for one audio file. `tracks`: [{ t (s), artist, title }] relative to the file start.
 * The first track always starts at 00:00:00 (required by most cue readers).
 */
export function buildCue({ file, title = 'OpenDJ mix', performer = '', tracks = [], format = 'wav' }) {
  const list = normTracklist(tracks);
  const type = format === 'mp3' ? 'MP3' : format === 'aiff' ? 'AIFF' : 'WAVE';
  const lines = ['REM COMMENT "Recorded with OpenDJ"', `REM DATE ${new Date().getFullYear()}`];
  if (performer) lines.push(`PERFORMER "${cueStr(performer)}"`);
  lines.push(`TITLE "${cueStr(title)}"`, `FILE "${cueStr(path.basename(file))}" ${type}`);
  list.forEach((t, i) => {
    lines.push(`  TRACK ${String(i + 1).padStart(2, '0')} AUDIO`, `    TITLE "${cueStr(t.title)}"`);
    if (t.artist) lines.push(`    PERFORMER "${cueStr(t.artist)}"`);
    lines.push(`    INDEX 01 ${cueTime(i === 0 ? 0 : t.t)}`);
  });
  return lines.join('\r\n') + '\r\n';
}

/** Plain-text tracklist: "00:00 Artist - Title" per line. */
export function buildTracklistText({ title = 'OpenDJ mix', tracks = [], duration = 0 }) {
  const list = normTracklist(tracks);
  const long = duration >= 3600 || list.some((t) => t.t >= 3600);
  const lines = [title, ''];
  list.forEach((t, i) => lines.push(`${String(i + 1).padStart(2, '0')}. [${clockTime(t.t, long)}] ${t.artist ? `${t.artist} - ` : ''}${t.title}`));
  if (!list.length) lines.push('(no tracks detected)');
  return lines.join('\n') + '\n';
}

/** Tracks of a part [start, end) of a recording, shifted to the part start (the track playing at the cut starts it). */
export function tracksForPart(tracks, start, end = Infinity) {
  const list = normTracklist(tracks);
  const before = list.filter((t) => t.t <= start).at(-1);
  const inside = list.filter((t) => t.t > start && t.t < end).map((t) => ({ ...t, t: t.t - start }));
  return before ? [{ ...before, t: 0 }, ...inside] : inside;
}

// ------------------------------------------------------------------ chunk sequencing

/**
 * Delivers chunks to `sink` strictly in sequence order. Duplicates (retries) are ignored, early chunks wait in a
 * bounded window. finish() closes the stream, waiting briefly for stragglers and filling lost chunks with silence
 * so timing (and the tracklist) stays right.
 */
export class ChunkReorderer {
  constructor({ sink, window = 240, gapBytes = 0 }) {
    this.sink = sink; this.window = window; this.gapBytes = gapBytes;
    this.expected = 0; this.pending = new Map(); this.chain = Promise.resolve(); this.error = null;
    this.duplicates = 0; this.gaps = 0; this.closed = false;
  }
  get ack() { return this.expected - 1; }
  push(seq, buf) {
    if (this.error) throw this.error;
    if (this.closed) throw httpError(409, 'Stream already finished');
    if (!Number.isSafeInteger(seq) || seq < 0) throw httpError(400, 'Bad sequence number');
    if (seq < this.expected || this.pending.has(seq)) { this.duplicates++; return Promise.resolve({ duplicate: true, ack: this.ack }); }
    if (seq - this.expected >= this.window) throw Object.assign(httpError(409, 'Chunk too far ahead; retry later'), { retryAfter: 1 });
    this.pending.set(seq, buf);
    return this._drain().then(() => ({ ack: this.ack, queued: this.pending.size }));
  }
  _drain() {
    this.chain = this.chain.then(async () => {
      while (!this.error && this.pending.has(this.expected)) {
        const b = this.pending.get(this.expected);
        this.pending.delete(this.expected);
        const seq = this.expected++;
        try { await this.sink(b, seq); } catch (e) { this.error = e; }
      }
    });
    return this.chain.then(() => { if (this.error) throw this.error; });
  }
  /** Deliver everything up to lastSeq (inclusive). Missing chunks are waited for up to graceMs, then filled with silence. */
  async finish(lastSeq = this.expected - 1 + this.pending.size, { graceMs = 3000 } = {}) {
    const last = Math.max(lastSeq, ...this.pending.keys(), this.expected - 1);
    const deadline = Date.now() + graceMs;
    while (this.expected <= last && Date.now() < deadline && !this.error) {
      if (this.pending.has(this.expected)) await this._drain().catch(() => {});
      else await new Promise((r) => setTimeout(r, 50));
    }
    this.closed = true;
    while (this.expected <= last && !this.error) {
      if (!this.pending.has(this.expected)) { this.pending.set(this.expected, Buffer.alloc(this.gapBytes)); this.gaps++; }
      await this._drain().catch(() => {});
    }
    await this.chain;
    if (this.error) throw this.error;
  }
}

/** Read a raw request body into one Buffer (with a size cap). */
export async function readRaw(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw httpError(413, 'Chunk too large');
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw httpError(413, 'Chunk too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ config storage

/**
 * Settings object `key`: kept in settings.json when DEFAULT_SETTINGS has the key (library.updateSettings), else in
 * `<dataDir>/<key>.json`, so the module works before the key is added to DEFAULT_SETTINGS.
 */
export function configStore(library, key, defaults) {
  const inSettings = Object.hasOwn(DEFAULT_SETTINGS, key);
  const file = path.join(library.dataDir, `${key}.json`);
  let cached = null;
  const read = () => {
    if (inSettings) return library.settings[key] && typeof library.settings[key] === 'object' ? library.settings[key] : {};
    if (!cached) { try { cached = readJsonSafe(file).data || {}; } catch { cached = {}; } }
    return cached;
  };
  return {
    get: () => ({ ...structuredClone(defaults), ...structuredClone(read()) }),
    set(value) {
      if (inSettings) library.updateSettings({ [key]: value });
      else { cached = value; writeJsonAtomic(file, value); }
      return this.get();
    },
  };
}

// ------------------------------------------------------------------ recording session

const nowStamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`; };

export class RecordingSession {
  /**
   * @param {object} o  { dir, format, bitrate, bits, sampleRate, channels, sampleFormat ('s16'|'f32'), chunkFrames,
   *                      splitMinutes, title, artist, ffmpegPath, cue (write .cue/.txt), onChange }
   */
  constructor(o) {
    this.id = crypto.randomBytes(8).toString('hex');
    this.dir = o.dir; this.format = o.format; this.bitrate = o.bitrate; this.bits = o.bits === 24 ? 24 : 16;
    this.sampleRate = o.sampleRate; this.channels = o.channels || 2; this.sampleFormat = o.sampleFormat === 'f32' ? 'f32' : 's16';
    this.frameBytes = this.channels * (this.sampleFormat === 'f32' ? 4 : 2);
    this.chunkFrames = o.chunkFrames || Math.round(this.sampleRate / 2);
    this.splitFrames = o.splitMinutes > 0 ? Math.round(o.splitMinutes * 60 * this.sampleRate) : 0;
    this.title = o.title || `OpenDJ mix ${nowStamp()}`; this.artist = o.artist || '';
    this.ffmpegPath = o.ffmpegPath; this.cue = o.cue !== false; this.onChange = o.onChange || (() => {});
    this.frames = 0; this.partStart = 0; this.parts = []; this.tracks = []; this.writer = null;
    this.startedAt = Date.now(); this.lastChunkAt = Date.now(); this.state = 'recording'; this.error = null;
    this.peak = [0, 0];
    this.reorder = new ChunkReorderer({ sink: (b) => this._write(b), gapBytes: this.chunkFrames * this.frameBytes });
  }
  get stem() { return safe(this.title).slice(0, 150); }
  async open() {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await this._openPart();
  }
  async _openPart() {
    const n = this.parts.length + 1;
    const ext = REC_FORMATS[this.format].ext;
    const file = await uniqueName(this.dir, this.splitFrames ? `${this.stem} - part ${n}` : this.stem, ext);
    const o = { sampleRate: this.sampleRate, channels: this.channels, inFormat: this.sampleFormat, bits: this.bits };
    const w = this.format === 'wav' ? new WavWriter(file, o)
      : new FfmpegWriter(file, { ...o, ffmpegPath: this.ffmpegPath, format: this.format, bitrate: this.bitrate, title: this.splitFrames ? `${this.title} (part ${n})` : this.title, artist: this.artist });
    await w.open();
    this.writer = w;
    this.partStart = this.frames;
    this.parts.push({ file, startFrame: this.frames, frames: 0, bytes: 0, done: false });
    this.writeSidecars();
    this.onChange('part');
  }
  async _closePart() {
    const part = this.parts.at(-1), w = this.writer;
    if (!w) return;
    this.writer = null;
    await w.close();
    part.frames = this.frames - part.startFrame; part.bytes = w.bytes; part.done = true;
    this.writeSidecars(part);
  }
  async _write(buf) {
    if (buf.length % this.frameBytes) buf = buf.subarray(0, buf.length - (buf.length % this.frameBytes));
    this._meter(buf);
    while (buf.length) {
      let n = buf.length / this.frameBytes;
      if (this.splitFrames && this.frames - this.partStart + n > this.splitFrames) n = this.splitFrames - (this.frames - this.partStart);
      if (n > 0) {
        await this.writer.write(buf.subarray(0, n * this.frameBytes));
        this.frames += n;
        buf = buf.subarray(n * this.frameBytes);
      }
      // the part is full and audio remains: start the next part (split lazily, so there is never an empty last part)
      if (buf.length) { await this._closePart(); await this._openPart(); }
    }
  }
  _meter(buf) {
    const f32 = this.sampleFormat === 'f32';
    let l = 0, r = 0;
    const step = this.frameBytes * 8; // every 8th frame is plenty for a meter
    for (let o = 0; o + this.frameBytes <= buf.length; o += step) {
      const a = Math.abs(f32 ? buf.readFloatLE(o) : buf.readInt16LE(o) / 32768), b = Math.abs(f32 ? buf.readFloatLE(o + 4) : buf.readInt16LE(o + 2) / 32768);
      if (a > l) l = a; if (b > r) r = b;
    }
    this.peak = [l, r];
  }
  push(seq, buf) {
    if (this.state !== 'recording') throw httpError(409, 'Recording already stopped');
    this.lastChunkAt = Date.now();
    return this.reorder.push(seq, buf);
  }
  addTrack(t) {
    const entry = normTracklist([{ ...t, t: Number.isFinite(Number(t?.t)) ? Number(t.t) : this.frames / this.sampleRate }])[0];
    if (!entry) return;
    const last = this.tracks.at(-1);
    if (last && last.title === entry.title && last.artist === entry.artist) return;
    this.tracks.push(entry);
    if (this.tracks.length > 5000) this.tracks.shift();
    this.tracks.sort((a, b) => a.t - b.t);
    // the track may have started before the last split (it is logged once it was audible for a while)
    for (const p of this.parts) if (!p.done || (p.startFrame + p.frames) / this.sampleRate > entry.t) this.writeSidecars(p);
  }
  /** .cue + .txt beside a part's audio file (current part by default). Sync and small: safe to call often. */
  writeSidecars(part = this.parts.at(-1)) {
    if (!this.cue || !part) return;
    const start = part.startFrame / this.sampleRate;
    const end = part.done ? (part.startFrame + part.frames) / this.sampleRate : Infinity;
    const tracks = tracksForPart(this.tracks, start, end);
    const stem = part.file.slice(0, -path.extname(part.file).length);
    const title = this.parts.length > 1 || this.splitFrames ? `${this.title} (part ${this.parts.indexOf(part) + 1})` : this.title;
    try {
      fs.writeFileSync(stem + '.cue', buildCue({ file: part.file, title, performer: this.artist, tracks, format: this.format }));
      fs.writeFileSync(stem + '.txt', buildTracklistText({ title, tracks, duration: part.done ? part.frames / this.sampleRate : this.frames / this.sampleRate - start }));
    } catch { /* tracklist is best effort */ }
  }
  async stop(lastSeq, { graceMs } = {}) {
    if (this.state !== 'recording') return this.stopping || this.status();
    this.state = 'stopping';
    this.stopping = (async () => {
      try { await this.reorder.finish(lastSeq, { graceMs }); } catch (e) { this.error = e.message; }
      try { await this._closePart(); } catch (e) { this.error ||= e.message; }
      this.state = this.error ? 'error' : 'stopped';
      this.onChange('stopped');
      return this.status();
    })();
    return this.stopping;
  }
  async abort(reason) {
    this.error = reason; this.state = 'error';
    await this.writer?.abort();
    this.writer = null;
    this.onChange('error');
  }
  status() {
    const cur = this.parts.at(-1);
    const bytes = this.parts.reduce((s, p) => s + (p.done ? p.bytes : 0), 0) + (this.writer ? this.writer.bytes : 0);
    return {
      id: this.id, state: this.state, error: this.error, format: this.format, bitrate: REC_FORMATS[this.format].lossless ? null : this.bitrate,
      sampleRate: this.sampleRate, title: this.title, startedAt: this.startedAt,
      seconds: this.frames / this.sampleRate, bytes, peak: this.peak, ack: this.reorder.ack, gaps: this.reorder.gaps,
      file: cur?.file || null, name: cur ? path.basename(cur.file) : null, dir: this.dir,
      parts: this.parts.map((p) => ({ file: p.file, name: path.basename(p.file), done: p.done, seconds: (p.done ? p.frames : this.frames - p.startFrame) / this.sampleRate })),
      tracks: this.tracks,
    };
  }
}

// ------------------------------------------------------------------ routes

export const RECORDING_DEFAULTS = { format: 'wav', bitrate: 320, bits: 16, folder: '', splitMinutes: 0, cue: true, minTrackSeconds: 10, artist: '' };

/**
 * @param {object} o
 * @param {Function} o.route         server router: route(method, pattern, handler, opts)
 * @param {object}   o.library       Library (settings, dataDir, media.ffmpeg())
 * @param {Function} [o.emit]        server-sent events
 * @param {Function} [o.pathAllowed] (path) => boolean, hosted-mode folder restriction. Default: only the default folder.
 * @param {Function} [o.allowedRoots] () => string[], used to pick the default folder in hosted mode
 * @param {Function} [o.ffmpeg]      () => ffmpeg info ({ path }) — defaults to library.media.ffmpeg()
 */
export function registerRecordingRoutes({ route, library, emit = () => {}, pathAllowed, allowedRoots, ffmpeg, idleMs = 90000 }) {
  const store = configStore(library, 'recording', { ...RECORDING_DEFAULTS, format: library.settings.recordFormat || 'wav' });
  const ff = () => (ffmpeg ? ffmpeg() : library.media?.ffmpeg?.()) || null;
  const homeDefault = path.join(os.homedir(), 'Music', 'OpenDJ Recordings');
  const defaultFolder = () => {
    if (!pathAllowed || pathAllowed(homeDefault)) return homeDefault;
    const roots = allowedRoots?.() || [];
    return roots.length ? path.join(roots[0], 'OpenDJ Recordings') : homeDefault;
  };
  const allowed = (p) => (pathAllowed ? pathAllowed(p) : path.resolve(p) === path.resolve(defaultFolder()));
  const folder = () => {
    const f = store.get().folder;
    return f && allowed(f) ? path.resolve(f) : defaultFolder();
  };
  const sessions = new Map();
  const finished = new Map(); // id -> last status (for the UI after stop)
  const publish = (s, what) => emit('recording', { what, ...s.status(), tracks: undefined });

  const formats = () => Object.entries(REC_FORMATS).map(([id, f]) => {
    const enc = ff()?.encoders;
    const available = f.native || (!!ff() && (id !== 'flac' || enc?.flac !== false) && (id !== 'aac' || enc?.aac !== false));
    return { id, label: f.label, ext: f.ext, lossless: !!f.lossless, bitrates: f.bitrates || null, bitrate: f.bitrate || null, available };
  });
  const sess = (id) => { const s = sessions.get(id); if (!s) throw httpError(404, 'No such recording (it was stopped or the server restarted)'); return s; };

  route('GET', '/api/recording/config', async () => {
    await library.media?.ready;
    return { config: store.get(), folder: folder(), defaultFolder: defaultFolder(), formats: formats(), ffmpeg: !!ff() };
  });
  route('PUT', '/api/recording/config', async ({ body }) => {
    const cur = store.get(), next = { ...cur };
    if ('format' in body) { if (!REC_FORMATS[body.format]) throw httpError(400, 'Unknown format'); next.format = body.format; }
    if ('bitrate' in body) next.bitrate = Math.min(512, Math.max(32, Number(body.bitrate) || 320));
    if ('bits' in body) next.bits = Number(body.bits) === 24 ? 24 : 16;
    if ('splitMinutes' in body) next.splitMinutes = Math.min(24 * 60, Math.max(0, Number(body.splitMinutes) || 0));
    if ('cue' in body) next.cue = !!body.cue;
    if ('minTrackSeconds' in body) next.minTrackSeconds = Math.min(120, Math.max(0, Number(body.minTrackSeconds) || 0));
    if ('artist' in body) next.artist = String(body.artist || '').slice(0, 200);
    if ('folder' in body) {
      const f = String(body.folder || '').trim();
      if (f && !path.isAbsolute(f)) throw httpError(400, 'Enter a full folder path');
      if (f && !allowed(f)) throw httpError(403, 'This folder is outside the allowed music folders');
      next.folder = f;
    }
    if (next.format !== cur.format && Object.hasOwn(DEFAULT_SETTINGS, 'recordFormat')) library.updateSettings({ recordFormat: next.format });
    return { config: store.set(next), folder: folder() };
  });
  route('GET', '/api/recording/status', () => ({ active: [...sessions.values()].map((s) => s.status()), finished: [...finished.values()].slice(-5) }));

  route('POST', '/api/recording/start', async ({ body }) => {
    await library.media?.ready;
    const cfg = { ...store.get(), ...Object.fromEntries(['format', 'bitrate', 'bits', 'splitMinutes', 'cue', 'artist'].filter((k) => k in body).map((k) => [k, body[k]])) };
    if (!REC_FORMATS[cfg.format]) throw httpError(400, 'Unknown format');
    const fmt = formats().find((f) => f.id === cfg.format);
    if (!fmt.available) throw httpError(415, `${REC_FORMATS[cfg.format].label} recording needs FFmpeg, which is not installed. Record to WAV or install FFmpeg.`, 'needs-ffmpeg');
    const sampleRate = Math.round(Number(body.sampleRate));
    if (!(sampleRate >= 8000 && sampleRate <= 384000)) throw httpError(400, 'Bad sample rate');
    if (sessions.size >= 4) throw httpError(429, 'Too many recordings running');
    const s = new RecordingSession({
      dir: folder(), format: cfg.format, bitrate: Number(cfg.bitrate) || REC_FORMATS[cfg.format].bitrate, bits: Number(cfg.bits),
      sampleRate, channels: 2, sampleFormat: body.sampleFormat, chunkFrames: Math.min(sampleRate * 4, Math.max(128, Number(body.chunkFrames) || sampleRate / 2)),
      splitMinutes: Number(cfg.splitMinutes) || 0, cue: cfg.cue !== false, artist: cfg.artist,
      title: body.title ? String(body.title).slice(0, 150) : undefined, ffmpegPath: ff()?.path,
      onChange: (what) => publish(s, what),
    });
    try { await s.open(); } catch (e) {
      if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') throw httpError(403, `Cannot write to ${s.dir}: ${e.code}`);
      if (e.code === 'ENOSPC') throw httpError(507, 'The disk is full');
      throw e;
    }
    sessions.set(s.id, s);
    publish(s, 'started');
    return s.status();
  });
  route('POST', '/api/recording/:id/chunk', async ({ req, params, query }) => {
    const s = sess(params.id);
    const buf = await readRaw(req, Math.max(1 << 20, s.chunkFrames * s.frameBytes * 2));
    try { return await s.push(Number(query.get('seq')), buf); } catch (e) {
      if (!s.reorder.error) throw e; // bad / early chunk: the client may retry
      // writing failed (disk full, FFmpeg crashed…): end the session, keep what was written
      const msg = e.code === 'ENOSPC' ? 'The disk is full' : e.message;
      await s.abort(msg);
      sessions.delete(s.id); finished.set(s.id, s.status());
      throw httpError(e.code === 'ENOSPC' ? 507 : 500, `Recording stopped: ${msg}`, 'recording-failed');
    }
  }, { raw: true });
  route('POST', '/api/recording/:id/track', async ({ params, body }) => { const s = sess(params.id); s.addTrack(body); return { tracks: s.tracks.length }; });
  route('POST', '/api/recording/:id/stop', async ({ params, body }) => {
    const s = sess(params.id);
    const lastSeq = Number.isSafeInteger(body.lastSeq) ? body.lastSeq : undefined;
    const st = await s.stop(lastSeq);
    sessions.delete(s.id);
    finished.set(s.id, st); if (finished.size > 20) finished.delete(finished.keys().next().value);
    return st;
  });

  // ---- recordings list / files (names only: never arbitrary paths) ----
  const durCache = new Map();
  const duration = async (file, st) => {
    const key = `${file}|${st.mtimeMs}|${st.size}`;
    if (durCache.has(key)) return durCache.get(key);
    let d = null;
    try {
      if (file.endsWith('.wav')) {
        const fh = await fs.promises.open(file, 'r');
        try { const b = Buffer.alloc(WAV_HEADER_BYTES); await fh.read(b, 0, WAV_HEADER_BYTES, 0); const h = parseWavHeader(b); if (h.kind === 'RIFF' || h.rf64) d = (st.size - WAV_HEADER_BYTES) / (h.sampleRate * h.channels * h.bits / 8); } finally { await fh.close(); }
      }
      if (d == null) d = (await parseFile(file, { duration: true, skipCovers: true })).format.duration ?? null;
    } catch { d = null; }
    if (durCache.size > 500) durCache.clear();
    durCache.set(key, d);
    return d;
  };
  const fileIn = (name) => {
    const n = String(name || '');
    if (!n || n !== path.basename(n) || n.startsWith('.')) throw httpError(400, 'Bad file name');
    const ext = path.extname(n).toLowerCase();
    if (!AUDIO_EXTS.has(ext) && ext !== '.cue' && ext !== '.txt') throw httpError(400, 'Not a recording');
    return path.join(folder(), n);
  };
  route('GET', '/api/recordings', async () => {
    const dir = folder();
    const names = await fs.promises.readdir(dir).catch(() => []);
    const active = new Set([...sessions.values()].map((s) => s.writer && s.parts.at(-1)?.file).filter(Boolean));
    const out = [];
    for (const n of names) {
      if (!AUDIO_EXTS.has(path.extname(n).toLowerCase()) || n.startsWith('.')) continue;
      const f = path.join(dir, n);
      const st = await fs.promises.stat(f).catch(() => null);
      if (!st?.isFile()) continue;
      const stem = n.slice(0, -path.extname(n).length);
      out.push({
        name: n, path: f, size: st.size, mtime: st.mtimeMs, recording: active.has(f),
        duration: active.has(f) ? null : await duration(f, st),
        cue: names.includes(stem + '.cue') ? stem + '.cue' : null, txt: names.includes(stem + '.txt') ? stem + '.txt' : null,
      });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return { folder: dir, recordings: out };
  });
  route('GET', '/api/recordings/file', async ({ req, res, query }) => {
    const file = fileIn(query.get('name'));
    const st = await fs.promises.stat(file).catch(() => null);
    if (!st?.isFile()) throw httpError(404, 'Recording not found');
    const name = path.basename(file);
    const headers = { 'Content-Type': MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    if (query.get('download')) headers['Content-Disposition'] = `attachment; filename="${name.replace(/[^\w.\- ]+/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    let start = 0, end = st.size - 1, status = 200;
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); } else start = Math.max(0, st.size - Number(m[2]));
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = st.size ? end - start + 1 : 0;
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !st.size) return res.end();
    const rs = fs.createReadStream(file, { start, end });
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    rs.pipe(res);
    return undefined;
  });
  route('DELETE', '/api/recordings/file', async ({ query }) => {
    const file = fileIn(query.get('name'));
    if ([...sessions.values()].some((s) => s.parts.some((p) => p.file === file && !p.done))) throw httpError(409, 'This file is still being recorded');
    const stem = file.slice(0, -path.extname(file).length);
    const removed = [];
    for (const f of [file, ...(AUDIO_EXTS.has(path.extname(file).toLowerCase()) ? [stem + '.cue', stem + '.txt'] : [])]) {
      try { await fs.promises.unlink(f); removed.push(path.basename(f)); } catch (e) { if (f === file && e.code !== 'ENOENT') throw e; }
    }
    if (!removed.length) throw httpError(404, 'Recording not found');
    emit('recording', { what: 'deleted', removed });
    return { removed };
  });

  // tab closed / crashed mid-recording: finish the file instead of leaving it open forever
  const watchdog = setInterval(() => {
    for (const s of sessions.values()) {
      if (s.state === 'recording' && Date.now() - s.lastChunkAt > idleMs) {
        s.stop(undefined, { graceMs: 0 }).then((st) => { sessions.delete(s.id); finished.set(s.id, { ...st, error: st.error || 'No audio received for a while (browser closed?); the recording was finished' }); publish(s, 'abandoned'); });
      }
    }
  }, Math.min(10000, idleMs / 3));
  watchdog.unref?.();

  return {
    sessions,
    folder,
    async close() {
      clearInterval(watchdog);
      await Promise.all([...sessions.values()].map((s) => s.stop(undefined, { graceMs: 0 }).catch(() => {})));
      sessions.clear();
    },
  };
}
