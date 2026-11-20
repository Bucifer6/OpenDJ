// Mix recording for the on-device backend: the same HTTP contract as server/recorder.js, so the recording UI and
// public/js/recording/recorder.js (master tap -> numbered PCM chunks) work unchanged.
//   WAV   always: PCM chunks are re-ordered and appended to app storage; the header is filled in on stop.
//   AAC / Opus (WebM or Ogg)  where the WebView's MediaRecorder can encode them: the master output is recorded with
//         MediaRecorder; the PCM chunks then only keep the clock (duration, tracklist timing).
// Files land in recordings/ in app storage and are exported with the share sheet (Recordings tab -> download).
import { buildCue, buildTracklistText, normTracklist } from '../shared/recording-core.js';
import { randomHex } from '../shared/hash.js';
import { HttpError, attachment } from './dispatcher.js';
import { keySafe } from './media.js';

export const WAV_HEADER_BYTES = 44;

/** 44-byte PCM WAV header. */
export function wavHeader({ sampleRate, channels = 2, bits = 16, dataBytes = 0 }) {
  const b = new Uint8Array(44), v = new DataView(b.buffer);
  const w = (o, s) => { for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i); };
  const block = channels * (bits / 8);
  const size = Math.min(0xffffffff, dataBytes);
  w(0, 'RIFF'); v.setUint32(4, Math.min(0xffffffff, 36 + size), true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * block, true); v.setUint16(32, block, true); v.setUint16(34, bits, true);
  w(36, 'data'); v.setUint32(40, size, true);
  return b;
}
export function parseWavHeader(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const s = (o) => String.fromCharCode(...u8.subarray(o, o + 4));
  return { riff: s(0), wave: s(8), channels: v.getUint16(22, true), sampleRate: v.getUint32(24, true), bits: v.getUint16(34, true), dataBytes: v.getUint32(40, true) };
}

/** f32le interleaved -> s16le bytes. */
function f32ToS16(u8) {
  const f = new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + (u8.byteLength & ~3)));
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) { const x = f[i]; out[i] = x >= 1 ? 32767 : x <= -1 ? -32768 : Math.round(x * 32767); }
  return new Uint8Array(out.buffer);
}

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;

/** Formats this WebView can record. */
export function recordingFormats(MR = globalThis.MediaRecorder) {
  const can = (t) => { try { return !!MR?.isTypeSupported?.(t); } catch { return false; } };
  const opusType = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus'].find(can);
  const aacType = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'].find(can);
  return [
    { id: 'wav', label: 'WAV (lossless)', ext: 'wav', lossless: true, bitrates: null, bitrate: null, available: true, mime: 'audio/wav' },
    { id: 'aac', label: 'AAC (.m4a)', ext: 'm4a', lossless: false, bitrates: [128, 192, 256], bitrate: 256, available: !!aacType, mime: aacType || 'audio/mp4', recorder: aacType },
    { id: 'opus', label: `Opus (.${opusType?.includes('ogg') ? 'opus' : 'webm'})`, ext: opusType?.includes('ogg') ? 'opus' : 'webm', lossless: false, bitrates: [96, 128, 160, 192], bitrate: 160, available: !!opusType, mime: opusType || 'audio/ogg', recorder: opusType },
    { id: 'flac', label: 'FLAC (desktop app only)', ext: 'flac', lossless: true, bitrates: null, bitrate: null, available: false },
    { id: 'mp3', label: 'MP3 (desktop app only)', ext: 'mp3', lossless: false, bitrates: [128, 192, 256, 320], bitrate: 320, available: false },
  ];
}
const MIME_BY_EXT = { wav: 'audio/wav', m4a: 'audio/mp4', opus: 'audio/ogg', webm: 'audio/webm', cue: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8' };
const AUDIO_EXTS = new Set(['wav', 'm4a', 'opus', 'webm']);
export const RECORDING_DEFAULTS = { format: 'wav', bitrate: 256, bits: 16, folder: '', splitMinutes: 0, cue: true, minTrackSeconds: 10, artist: '' };

class Session {
  constructor(o) {
    Object.assign(this, o);
    this.id = randomHex(8);
    this.frameBytes = 2 * (this.sampleFormat === 'f32' ? 4 : 2);
    this.expected = 0; this.pending = new Map(); this.chain = Promise.resolve();
    this.frames = 0; this.bytes = 0; this.tracks = []; this.state = 'recording'; this.error = null; this.startedAt = Date.now(); this.peak = [0, 0];
  }
  get ack() { return this.expected - 1; }
  async open() {
    if (this.format.id === 'wav') this.out = this.fs.appender(this.path, { headerBytes: WAV_HEADER_BYTES });
    else await this.startMediaRecorder();
  }
  async startMediaRecorder() {
    const engine = this.getEngine?.();
    if (!engine?.masterOut) throw new HttpError(500, 'The audio engine is not ready');
    const dest = engine.ctx.createMediaStreamDestination();
    engine.masterOut.connect(dest);
    this.mrDest = dest; this.mrEngine = engine;
    this.out = this.fs.appender(this.path);
    const mr = new MediaRecorder(dest.stream, { mimeType: this.format.recorder, audioBitsPerSecond: (Number(this.bitrate) || this.format.bitrate) * 1000 });
    this.mrDone = new Promise((resolve) => { mr.onstop = resolve; });
    mr.ondataavailable = (e) => { if (e.data?.size) this.chain = this.chain.then(async () => { const b = new Uint8Array(await e.data.arrayBuffer()); this.bytes += b.byteLength; await this.out.write(b); }); };
    mr.start(1000);
    this.mr = mr;
  }
  push(seq, bytes) {
    if (this.state !== 'recording') throw new HttpError(409, 'Recording already stopped');
    if (!Number.isSafeInteger(seq) || seq < 0) throw new HttpError(400, 'Bad sequence number');
    if (seq < this.expected || this.pending.has(seq)) return Promise.resolve({ duplicate: true, ack: this.ack });
    if (seq - this.expected >= 240) throw new HttpError(409, 'Chunk too far ahead; retry later');
    this.pending.set(seq, bytes);
    return this.drain().then(() => ({ ack: this.ack, queued: this.pending.size }));
  }
  drain() {
    this.chain = this.chain.then(async () => {
      while (!this.error && this.pending.has(this.expected)) {
        const b = this.pending.get(this.expected); this.pending.delete(this.expected); this.expected++;
        await this.write(b);
      }
    }).catch((e) => { this.error = e.message; });
    return this.chain.then(() => { if (this.error) throw new HttpError(500, `Recording stopped: ${this.error}`, 'recording-failed'); });
  }
  async write(b) {
    const n = Math.floor(b.byteLength / this.frameBytes);
    if (!n) return;
    this.frames += n;
    if (this.format.id !== 'wav') return; // MediaRecorder writes the audio; PCM only keeps time
    const pcm = this.sampleFormat === 'f32' ? f32ToS16(b.subarray(0, n * this.frameBytes)) : b.subarray(0, n * this.frameBytes);
    this.bytes += pcm.byteLength;
    await this.out.write(pcm);
  }
  addTrack(t) {
    if (!t || !Number.isFinite(Number(t.t))) return;
    this.tracks.push({ t: Number(t.t), artist: String(t.artist || '').slice(0, 300), title: String(t.title || 'Unknown').slice(0, 300), ...(t.trackId ? { trackId: String(t.trackId).slice(0, 64) } : {}) });
  }
  async stop(lastSeq) {
    if (this.state !== 'recording') return this.stopping || this.status();
    this.state = 'stopping';
    this.stopping = (async () => {
      const last = Math.max(Number.isSafeInteger(lastSeq) ? lastSeq : -1, ...this.pending.keys(), this.expected - 1);
      const deadline = Date.now() + 3000;
      while (this.expected <= last && Date.now() < deadline && !this.error) {
        if (this.pending.has(this.expected)) await this.drain().catch(() => {}); else await new Promise((r) => setTimeout(r, 50));
      }
      while (this.expected <= last && !this.error) { // missing chunks: silence keeps the timeline right
        if (!this.pending.has(this.expected)) this.pending.set(this.expected, new Uint8Array(this.chunkFrames * this.frameBytes));
        await this.drain().catch(() => {});
      }
      await this.chain.catch(() => {});
      try {
        if (this.mr) {
          if (this.mr.state !== 'inactive') { this.mr.stop(); await this.mrDone; }
          await this.chain;
          try { this.mrEngine.masterOut.disconnect(this.mrDest); } catch { /* already gone */ }
          await this.out.close();
        } else await this.out.close(wavHeader({ sampleRate: this.sampleRate, dataBytes: this.bytes }));
        if (this.cue) await this.writeSidecars();
      } catch (e) { this.error ||= e.message; }
      this.state = this.error ? 'error' : 'stopped';
      return this.status();
    })();
    return this.stopping;
  }
  async writeSidecars() {
    const tracks = normTracklist(this.tracks);
    if (!tracks.length) return;
    const stem = this.name.replace(/\.[^.]+$/, '');
    await this.fs.write(`recordings/${stem}.cue`, buildCue({ file: this.name, title: this.title, performer: this.artist, tracks, format: this.format.id === 'wav' ? 'wav' : 'mp3' }));
    await this.fs.write(`recordings/${stem}.txt`, buildTracklistText({ title: this.title, tracks, duration: this.frames / this.sampleRate }));
  }
  status() {
    return {
      id: this.id, state: this.state, error: this.error, format: this.format.id, bitrate: this.format.lossless ? null : this.bitrate,
      sampleRate: this.sampleRate, title: this.title, startedAt: this.startedAt, seconds: this.frames / this.sampleRate, bytes: this.bytes,
      peak: this.peak, ack: this.ack, gaps: 0, file: this.path, name: this.name, dir: 'recordings',
      parts: [{ file: this.path, name: this.name, done: this.state !== 'recording', seconds: this.frames / this.sampleRate }], tracks: this.tracks,
    };
  }
}

/** Register the recording routes on the in-page router. */
export function registerLocalRecording({ route, fs, kv, emit = () => {}, getEngine, library }) {
  let cfgCache = null;
  const config = async () => (cfgCache ||= { ...RECORDING_DEFAULTS, format: library?.settings?.recordFormat === 'wav' ? 'wav' : 'wav', ...((await kv.get('recording')) || {}) });
  const sessions = new Map(), finished = new Map();
  const fmt = (id) => recordingFormats().find((f) => f.id === id);
  const info = async () => ({ config: await config(), folder: 'App storage › Recordings', defaultFolder: 'App storage › Recordings', formats: recordingFormats().map(({ recorder, mime, ...f }) => f), ffmpeg: false, local: true });
  const sess = (id) => { const s = sessions.get(id); if (!s) throw new HttpError(404, 'No such recording (it was stopped or the app restarted)'); return s; };

  route('GET', '/api/recording/config', info);
  route('PUT', '/api/recording/config', async ({ body }) => {
    const cur = await config(), next = { ...cur };
    if ('format' in body) { if (!fmt(body.format)) throw new HttpError(400, 'Unknown format'); next.format = body.format; }
    if ('bitrate' in body) next.bitrate = Math.min(512, Math.max(32, Number(body.bitrate) || 256));
    if ('bits' in body) next.bits = 16;
    if ('cue' in body) next.cue = !!body.cue;
    if ('minTrackSeconds' in body) next.minTrackSeconds = Math.min(120, Math.max(0, Number(body.minTrackSeconds) || 0));
    if ('artist' in body) next.artist = String(body.artist || '').slice(0, 200);
    if ('splitMinutes' in body) next.splitMinutes = 0; // one file per recording on the phone
    if ('folder' in body && body.folder) throw new HttpError(400, 'Recordings are kept in the app; export them from the Recordings tab');
    cfgCache = next; await kv.set('recording', next);
    return { config: next, folder: 'App storage › Recordings' };
  });
  route('GET', '/api/recording/status', () => ({ active: [...sessions.values()].map((s) => s.status()), finished: [...finished.values()].slice(-5) }));
  route('POST', '/api/recording/start', async ({ body }) => {
    const cfg = { ...(await config()), ...Object.fromEntries(['format', 'bitrate', 'cue', 'artist'].filter((k) => k in body).map((k) => [k, body[k]])) };
    const f = fmt(cfg.format);
    if (!f) throw new HttpError(400, 'Unknown format');
    if (!f.available) throw new HttpError(415, `${f.label} recording is not available on this device. Record to WAV.`, 'needs-ffmpeg');
    const sampleRate = Math.round(Number(body.sampleRate));
    if (!(sampleRate >= 8000 && sampleRate <= 384000)) throw new HttpError(400, 'Bad sample rate');
    if (sessions.size >= 2) throw new HttpError(429, 'Too many recordings running');
    const title = body.title ? String(body.title).slice(0, 150) : `OpenDJ mix ${stamp().replace('_', ' ')}`;
    const existing = new Set((await fs.list('recordings')).map((x) => x.name));
    let name = `${keySafe(title, 100)}.${f.ext}`;
    for (let i = 2; existing.has(name); i++) name = `${keySafe(title, 100)}_${i}.${f.ext}`;
    const s = new Session({
      fs, format: f, bitrate: Number(cfg.bitrate) || f.bitrate, sampleRate, sampleFormat: body.sampleFormat === 'f32' ? 'f32' : 's16',
      chunkFrames: Math.min(sampleRate * 4, Math.max(128, Number(body.chunkFrames) || sampleRate / 2)),
      title, artist: cfg.artist, cue: cfg.cue !== false, name, path: `recordings/${name}`, getEngine,
    });
    await s.open();
    sessions.set(s.id, s);
    emit('recording', { what: 'started', id: s.id });
    return s.status();
  });
  route('POST', '/api/recording/:id/chunk', async ({ params, query, body }) => {
    const s = sess(params.id);
    const bytes = body instanceof Uint8Array ? body : body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : null;
    if (!bytes) throw new HttpError(400, 'Expected binary body');
    return s.push(Number(query.get('seq')), bytes);
  });
  route('POST', '/api/recording/:id/track', async ({ params, body }) => { const s = sess(params.id); s.addTrack(body); return { tracks: s.tracks.length }; });
  route('POST', '/api/recording/:id/stop', async ({ params, body }) => {
    const s = sess(params.id);
    const st = await s.stop(Number.isSafeInteger(body.lastSeq) ? body.lastSeq : undefined);
    sessions.delete(s.id); finished.set(s.id, st);
    emit('recording', { what: 'stopped', id: s.id });
    return st;
  });

  const fileIn = (name) => {
    const n = String(name || '');
    if (!/^[\w.-]+$/.test(n) || n.startsWith('.')) throw new HttpError(400, 'Bad file name');
    const ext = n.split('.').pop().toLowerCase();
    if (!AUDIO_EXTS.has(ext) && ext !== 'cue' && ext !== 'txt') throw new HttpError(400, 'Not a recording');
    return { path: `recordings/${n}`, ext, name: n };
  };
  route('GET', '/api/recordings', async () => {
    const files = await fs.list('recordings');
    const names = new Set(files.map((f) => f.name));
    const active = new Set([...sessions.values()].map((s) => s.name));
    const out = [];
    for (const f of files) {
      const ext = f.name.split('.').pop().toLowerCase();
      if (!AUDIO_EXTS.has(ext) || f.name.startsWith('.')) continue;
      let duration = null;
      if (ext === 'wav' && !active.has(f.name)) {
        try { const h = parseWavHeader(new Uint8Array(await (await fs.read(`recordings/${f.name}`)).slice(0, 44).arrayBuffer())); if (h.riff === 'RIFF') duration = h.dataBytes / (h.sampleRate * h.channels * h.bits / 8); } catch { /* unreadable */ }
      }
      const stem = f.name.replace(/\.[^.]+$/, '');
      out.push({ name: f.name, path: `recordings/${f.name}`, size: f.size, mtime: f.mtime, recording: active.has(f.name), duration, cue: names.has(`${stem}.cue`) ? `${stem}.cue` : null, txt: names.has(`${stem}.txt`) ? `${stem}.txt` : null });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return { folder: 'App storage › Recordings', recordings: out, local: true };
  });
  route('GET', '/api/recordings/file', async ({ query }) => {
    const f = fileIn(query.get('name'));
    const type = MIME_BY_EXT[f.ext] || 'application/octet-stream';
    if (query.get('download')) {
      const blob = await fs.read(f.path);
      if (!blob) throw new HttpError(404, 'Recording not found');
      return attachment(blob, type, f.name);
    }
    const r = await fs.response(f.path, type);
    if (!r) throw new HttpError(404, 'Recording not found');
    return r;
  });
  route('DELETE', '/api/recordings/file', async ({ query }) => {
    const f = fileIn(query.get('name'));
    if ([...sessions.values()].some((s) => s.name === f.name)) throw new HttpError(409, 'This file is still being recorded');
    if (!(await fs.stat(f.path))) throw new HttpError(404, 'Recording not found');
    const stem = f.name.replace(/\.[^.]+$/, '');
    const removed = [];
    for (const n of [f.name, ...(AUDIO_EXTS.has(f.ext) ? [`${stem}.cue`, `${stem}.txt`] : [])]) {
      if (await fs.stat(`recordings/${n}`)) { await fs.delete(`recordings/${n}`); removed.push(n); }
    }
    emit('recording', { what: 'deleted', removed });
    return { removed };
  });
  return { sessions, fileUrlFor: (name) => { try { return fileIn(name).path; } catch { return null; } } };
}
