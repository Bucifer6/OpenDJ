// Live broadcasting of the mix: Icecast2, Shoutcast v1/v2 and RTMP (Twitch / YouTube Live / Mixcloud Live…).
//
// The browser sends master-output PCM chunks (same protocol as recording: /api/broadcast/:id/chunk?seq=N). Each
// target gets its own FFmpeg encoder:
//   - Icecast / Shoutcast: FFmpeg encodes MP3 / AAC (ADTS) / Ogg Opus to stdout and this module speaks the source
//     protocol itself (HTTP PUT for Icecast 2.4+, the legacy SOURCE method for older servers, the Shoutcast
//     password handshake for Shoutcast v1 and v2-in-v1-mode), so it can report precise errors, reconnect with
//     backoff and keep "now playing" metadata (Icecast /admin/metadata, Shoutcast /admin.cgi) and listener counts.
//   - RTMP: FFmpeg muxes FLV (H.264 still image + AAC) and connects itself; restarted with backoff when it drops.
// Stream passwords / keys are kept in <dataDir>/secrets.json (mode 0600), never in settings.json, and never
// returned by the API (GET answers hasPassword / hasStreamKey).
//
// Registered from server/index.js: registerBroadcastRoutes({ route, library, emit, pathAllowed }).
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readJsonSafe, writeJsonAtomic } from './jsonstore.js';
import { ChunkReorderer, readRaw, configStore, httpError } from './recorder.js';

const VERSION = '0.1.0';
const DEFAULT_IMAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icon-512.png');

export const STREAM_FORMATS = {
  mp3: { label: 'MP3', contentType: 'audio/mpeg', muxer: 'mp3', codec: ['-c:a', 'libmp3lame'], bitrate: 128 },
  aac: { label: 'AAC', contentType: 'audio/aac', muxer: 'adts', codec: ['-c:a', 'aac'], bitrate: 128 },
  opus: { label: 'Ogg Opus', contentType: 'audio/ogg', muxer: 'ogg', codec: ['-c:a', 'libopus', '-application', 'audio'], bitrate: 128, sampleRate: 48000 },
};
export const TARGET_TYPES = ['icecast', 'shoutcast', 'rtmp'];

// ------------------------------------------------------------------ secrets

/** Credentials in <dataDir>/secrets.json (0600). Shape: { broadcast: { <targetId>: { password, streamKey } } } */
export class SecretStore {
  constructor(dataDir) { this.file = path.join(dataDir, 'secrets.json'); this.data = null; }
  load() {
    if (!this.data) { try { this.data = readJsonSafe(this.file).data || {}; } catch { this.data = {}; } }
    return this.data;
  }
  get(scope, id, key) { return this.load()[scope]?.[id]?.[key] || ''; }
  has(scope, id, key) { return !!this.get(scope, id, key); }
  set(scope, id, key, value) {
    const d = this.load();
    d[scope] ||= {}; d[scope][id] ||= {};
    if (value) d[scope][id][key] = String(value); else delete d[scope][id][key];
    this.save();
  }
  remove(scope, id) { const d = this.load(); if (d[scope]?.[id]) { delete d[scope][id]; this.save(); } }
  save() {
    writeJsonAtomic(this.file, this.data, { mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* windows */ }
  }
}

// ------------------------------------------------------------------ protocol helpers (pure)

const clean = (s, n = 200) => String(s ?? '').replace(/[\r\n\0]+/g, ' ').trim().slice(0, n);
const mountOf = (t) => { const m = clean(t.mount || '/stream', 200); return m.startsWith('/') ? m : '/' + m; };
const hostHeader = (t) => `${t.host.includes(':') ? `[${t.host}]` : t.host}:${t.port}`;
const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

/** Request head that opens an Icecast source connection. method: 'PUT' (Icecast 2.4+) or 'SOURCE' (older). */
export function icecastRequest(target, { password, method = 'PUT', contentType, bitrate, sampleRate = 44100, channels = 2 }) {
  const lines = [
    `${method} ${encodeURI(mountOf(target))} HTTP/${method === 'PUT' ? '1.1' : '1.0'}`,
    `Host: ${hostHeader(target)}`,
    `Authorization: ${basic(target.username || 'source', password)}`,
    `User-Agent: OpenDJ/${VERSION}`,
    `Content-Type: ${contentType}`,
    `Ice-Public: ${target.public ? 1 : 0}`,
    `Ice-Name: ${clean(target.stationName || 'OpenDJ live')}`,
    `Ice-Description: ${clean(target.description || 'Live DJ mix')}`,
  ];
  if (target.genre) lines.push(`Ice-Genre: ${clean(target.genre)}`);
  if (target.url) lines.push(`Ice-Url: ${clean(target.url)}`);
  lines.push(`Ice-Audio-Info: ice-samplerate=${sampleRate};ice-bitrate=${bitrate};ice-channels=${channels}`);
  if (method === 'PUT') lines.push('Expect: 100-continue');
  return lines.join('\r\n') + '\r\n\r\n';
}

/** Header block sent after a successful Shoutcast password handshake. */
export function shoutcastHeaders(target, { contentType, bitrate }) {
  const lines = [
    `content-type:${contentType}`,
    `icy-name:${clean(target.stationName || 'OpenDJ live')}`,
    `icy-genre:${clean(target.genre || 'DJ mix')}`,
    `icy-pub:${target.public ? 1 : 0}`,
    `icy-br:${bitrate}`,
  ];
  if (target.url) lines.push(`icy-url:${clean(target.url)}`);
  return lines.join('\r\n') + '\r\n\r\n';
}
/** Shoutcast password line: v2 servers accept the legacy protocol with "password:#sid". */
export const shoutcastPassword = (target, password) => (Number(target.shoutcastVersion) === 2 ? `${password}:#${Number(target.sid) || 1}` : password);

export const songTitle = ({ artist, title } = {}) => clean([artist, title].filter(Boolean).join(' - '), 400);

const baseUrl = (t) => `${t.tls ? 'https' : 'http'}://${hostHeader(t)}`;
/** "Now playing" update URL (+ headers). Icecast: admin metadata with source credentials; Shoutcast: admin.cgi. */
export function metadataRequest(target, song, password) {
  if (target.type === 'icecast') {
    const q = new URLSearchParams({ mount: mountOf(target), mode: 'updinfo', song, charset: 'UTF-8' });
    return { url: `${baseUrl(target)}/admin/metadata?${q}`, headers: { Authorization: basic(target.username || 'source', password), 'User-Agent': `OpenDJ/${VERSION}` } };
  }
  if (target.type === 'shoutcast') {
    const v2 = Number(target.shoutcastVersion) === 2;
    const q = new URLSearchParams({ ...(v2 ? { sid: String(Number(target.sid) || 1) } : {}), pass: password, mode: 'updinfo', song });
    // Shoutcast v1 rejects requests that do not look like a browser/encoder
    return { url: `${baseUrl(target)}/admin.cgi?${q}`, headers: { 'User-Agent': `Mozilla/5.0 (OpenDJ/${VERSION})` } };
  }
  return null;
}

/** Public listener statistics endpoint. */
export function statsUrl(target) {
  if (target.type === 'icecast') return `${baseUrl(target)}/status-json.xsl`;
  if (target.type === 'shoutcast') return Number(target.shoutcastVersion) === 2 ? `${baseUrl(target)}/stats?sid=${Number(target.sid) || 1}&json=1` : `${baseUrl(target)}/7.html`;
  return null;
}
/** Listener count from a statsUrl() response body (null when unknown). */
export function parseListeners(target, body) {
  try {
    if (target.type === 'icecast') {
      const src = JSON.parse(body)?.icestats?.source;
      const list = Array.isArray(src) ? src : src ? [src] : [];
      const mount = mountOf(target);
      const s = list.find((x) => { try { return new URL(x.listenurl).pathname === mount; } catch { return false; } }) || (list.length === 1 ? list[0] : null);
      return s ? Number(s.listeners) || 0 : null;
    }
    if (target.type === 'shoutcast') {
      if (Number(target.shoutcastVersion) === 2) { const j = JSON.parse(body); return Number(j.currentlisteners) || 0; }
      const m = /<body>([^<]*)<\/body>/i.exec(body) || [null, body];
      const n = Number(String(m[1]).split(',')[0]);
      return Number.isFinite(n) ? n : null;
    }
  } catch { /* unknown format */ }
  return null;
}

// ------------------------------------------------------------------ source connection

const readHead = (sock, { terminator = '\r\n\r\n', timeout = 10000, max = 16384 } = {}) => new Promise((resolve, reject) => {
  let buf = '';
  const done = (err, v) => { clearTimeout(t); sock.off('data', onData); sock.off('error', onErr); sock.off('close', onClose); err ? reject(err) : resolve(v); };
  const onData = (d) => {
    buf += d.toString('latin1');
    const i = buf.indexOf(terminator);
    if (i >= 0) done(null, buf.slice(0, i));
    else if (buf.length > max) done(new Error('Server sent an oversized answer'));
    else if (terminator === '\r\n\r\n' && /^HTTP\/1\.\d 100/.test(buf) && buf.includes('\r\n\r\n')) done(null, buf);
  };
  const onErr = (e) => done(e);
  const onClose = () => done(new Error(buf ? `Server closed the connection: ${buf.trim().split('\r\n')[0].slice(0, 120)}` : 'Server closed the connection'));
  const t = setTimeout(() => done(new Error('Server did not answer the source login in time')), timeout);
  sock.on('data', onData); sock.on('error', onErr); sock.on('close', onClose);
});

class SourceError extends Error { constructor(msg, { fatal = false, status } = {}) { super(msg); this.fatal = fatal; this.status = status; } }

/**
 * Connect + log in as a source. Resolves with the open socket, ready for encoded audio.
 * opts: { password, contentType, bitrate, sampleRate, timeout, connect (for tests) }
 */
export async function openSource(target, opts) {
  const port = target.type === 'shoutcast' && Number(target.shoutcastVersion) !== 2 ? Number(target.sourcePort) || Number(target.port) + 1 : Number(target.port);
  const dial = () => new Promise((resolve, reject) => {
    const o = { host: target.host, port, servername: net.isIP(target.host) ? undefined : target.host };
    const sock = target.tls ? tls.connect(o) : net.connect(o);
    const t = setTimeout(() => { sock.destroy(); reject(new SourceError(`Could not connect to ${target.host}:${port} (timeout)`)); }, opts.timeout || 10000);
    sock.once(target.tls ? 'secureConnect' : 'connect', () => { clearTimeout(t); sock.setNoDelay(true); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(t); reject(new SourceError(`Could not connect to ${target.host}:${port}: ${e.code || e.message}`)); });
  });
  if (target.type === 'shoutcast') {
    const sock = await dial();
    try {
      sock.write(shoutcastPassword(target, opts.password) + '\r\n');
      const line = (await readHead(sock, { terminator: '\n', timeout: opts.timeout })).trim();
      if (!/^OK2?\b/i.test(line)) throw new SourceError(/invalid|denied|password/i.test(line) ? 'Shoutcast rejected the password' : `Shoutcast refused the source: ${line.slice(0, 120)}`, { fatal: /invalid|password/i.test(line) });
      sock.write(shoutcastHeaders(target, opts));
      return sock;
    } catch (e) { sock.destroy(); throw e instanceof SourceError ? e : new SourceError(e.message); }
  }
  const methods = target.protocol === 'source' ? ['SOURCE'] : target.protocol === 'put' ? ['PUT'] : ['PUT', 'SOURCE'];
  let last;
  for (const method of methods) {
    const sock = await dial();
    try {
      sock.write(icecastRequest(target, { ...opts, method }));
      const head = await readHead(sock, { timeout: opts.timeout });
      const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(head)?.[1]) || 0;
      if (status === 100 || (status >= 200 && status < 300)) return sock;
      const reason = head.split('\r\n')[0].replace(/^HTTP\/\d\.\d \d{3} ?/, '').slice(0, 120);
      if ((status === 405 || status === 501 || status === 400 || !status) && method === 'PUT' && methods.length > 1) { last = new SourceError(`PUT refused (${status || 'no HTTP answer'})`); sock.destroy(); continue; }
      if (status === 401) throw new SourceError('Icecast rejected the user name or password', { fatal: true, status });
      if (status === 403) throw new SourceError(/in use|busy/i.test(reason) ? 'This mount point is already in use (another source is connected)' : `Icecast refused the source: ${reason || 'forbidden'}`, { status });
      if (status === 404) throw new SourceError('Mount point not found on the server', { fatal: true, status });
      throw new SourceError(`Icecast answered ${status} ${reason}`, { status });
    } catch (e) { sock.destroy(); if (e instanceof SourceError && (e.fatal || e.status)) throw e; last = e instanceof SourceError ? e : new SourceError(e.message); if (method === methods.at(-1)) throw last; }
  }
  throw last || new SourceError('Could not log in as a source');
}

// ------------------------------------------------------------------ target validation

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$|^\d{1,3}(?:\.\d{1,3}){3}$|^[0-9a-f:]+$/i;
export function normTarget(t, prev = {}) {
  const type = TARGET_TYPES.includes(t.type) ? t.type : prev.type || 'icecast';
  const out = {
    id: /^[\w-]{1,40}$/.test(String(t.id || prev.id || '')) ? String(t.id || prev.id) : crypto.randomBytes(6).toString('hex'),
    type, name: clean(t.name ?? prev.name ?? (type === 'rtmp' ? 'RTMP stream' : 'Radio stream'), 80), enabled: t.enabled ?? prev.enabled ?? true,
  };
  const str = (k, n = 200) => clean(t[k] ?? prev[k] ?? '', n);
  if (type === 'rtmp') {
    out.rtmpUrl = str('rtmpUrl', 500);
    if (out.rtmpUrl && !/^rtmps?:\/\/[^\s/]+/i.test(out.rtmpUrl)) throw httpError(400, 'The RTMP URL must start with rtmp:// or rtmps://');
    out.image = str('image', 1000);
    out.audioBitrate = Math.min(320, Math.max(64, Number(t.audioBitrate ?? prev.audioBitrate) || 160));
    out.videoBitrate = Math.min(4000, Math.max(100, Number(t.videoBitrate ?? prev.videoBitrate) || 400));
    out.resolution = /^\d{3,4}x\d{3,4}$/.test(String(t.resolution ?? prev.resolution)) ? String(t.resolution ?? prev.resolution) : '1280x720';
    return out;
  }
  out.host = str('host', 253).toLowerCase();
  if (out.host && !HOST_RE.test(out.host)) throw httpError(400, 'Enter a host name or IP address (no http://)');
  out.port = Math.round(Number(t.port ?? prev.port) || 8000);
  if (out.port < 1 || out.port > 65535) throw httpError(400, 'Bad port');
  out.tls = !!(t.tls ?? prev.tls);
  out.format = STREAM_FORMATS[t.format ?? prev.format] ? (t.format ?? prev.format) : 'mp3';
  out.bitrate = Math.min(320, Math.max(32, Number(t.bitrate ?? prev.bitrate) || 128));
  out.sampleRate = [44100, 48000].includes(Number(t.sampleRate ?? prev.sampleRate)) ? Number(t.sampleRate ?? prev.sampleRate) : 44100;
  for (const k of ['stationName', 'description', 'genre', 'url']) out[k] = str(k);
  out.public = !!(t.public ?? prev.public);
  if (type === 'icecast') {
    out.mount = str('mount') || '/live';
    if (!out.mount.startsWith('/')) out.mount = '/' + out.mount;
    out.username = str('username', 100) || 'source';
    out.protocol = ['auto', 'put', 'source'].includes(t.protocol ?? prev.protocol) ? (t.protocol ?? prev.protocol) : 'auto';
  } else {
    out.shoutcastVersion = Number(t.shoutcastVersion ?? prev.shoutcastVersion) === 2 ? 2 : 1;
    out.sid = Math.max(1, Math.round(Number(t.sid ?? prev.sid) || 1));
    out.sourcePort = Number(t.sourcePort ?? prev.sourcePort) || 0; // 0 = port + 1 (v1)
    if (out.format === 'opus') out.format = 'mp3'; // Shoutcast carries MP3 / AAC only
  }
  return out;
}

// ------------------------------------------------------------------ one output (target) of a broadcast

const backoff = (n) => Math.min(30000, 1000 * 2 ** Math.min(n, 5));

export class BroadcastOutput extends EventEmitter {
  /** o: { target, secret: (key) => string, ffmpegPath, ffmpegInfo, inFormat ('s16'|'f32'), inRate, fetch, log, image } */
  constructor(o) {
    super();
    Object.assign(this, o);
    this.fetch ||= globalThis.fetch;
    this.state = 'idle'; this.error = null; this.reconnects = 0; this.bytesOut = 0; this.droppedIn = 0;
    this.connectedAt = null; this.listeners = null; this.song = ''; this.window = []; this.running = false; this.attempt = 0;
  }
  get t() { return this.target; }
  setState(state, error) {
    if (this.state === state && (error ?? null) === this.error) return;
    this.state = state; if (error !== undefined) this.error = error;
    this.emit('change', this.status());
  }
  inputArgs() { return ['-f', this.inFormat === 'f32' ? 'f32le' : 's16le', '-ar', String(this.inRate), '-ac', '2', '-thread_queue_size', '1024', '-i', 'pipe:0']; }
  encoderArgs() {
    const t = this.t;
    if (t.type === 'rtmp') {
      const [w, h] = t.resolution.split('x').map(Number);
      const img = this.image && fs.existsSync(this.image) ? this.image : null;
      const video = img ? ['-re', '-loop', '1', '-framerate', '10', '-thread_queue_size', '64', '-i', img] : ['-re', '-f', 'lavfi', '-i', `color=c=0x101418:s=${w}x${h}:r=10`];
      const url = this.rtmpTarget();
      return ['-hide_banner', '-nostdin', '-loglevel', 'error', '-stats_period', '2', '-progress', 'pipe:2', ...this.inputArgs(), ...video,
        '-map', '1:v', '-map', '0:a',
        '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-r', '10', '-g', '20', '-keyint_min', '20', '-sc_threshold', '0',
        '-b:v', `${t.videoBitrate}k`, '-maxrate', `${t.videoBitrate}k`, '-bufsize', `${t.videoBitrate * 2}k`,
        '-c:a', 'aac', '-b:a', `${t.audioBitrate}k`, '-ar', '44100', '-ac', '2',
        '-flvflags', 'no_duration_filesize', '-f', 'flv', url];
    }
    const f = STREAM_FORMATS[t.format];
    return ['-hide_banner', '-nostdin', '-loglevel', 'error', ...this.inputArgs(), ...f.codec, '-b:a', `${t.bitrate}k`, '-ar', String(f.sampleRate || t.sampleRate), '-ac', '2',
      ...(t.format === 'mp3' ? ['-write_xing', '0', '-id3v2_version', '0'] : []), ...(t.format === 'opus' ? ['-page_duration', '200000'] : []), '-flush_packets', '1', '-f', f.muxer, 'pipe:1'];
  }
  rtmpTarget() {
    const key = this.secret('streamKey');
    const base = this.t.rtmpUrl.replace(/\/+$/, '');
    return key ? `${base}/${key}` : base;
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.statsTimer = setInterval(() => this.pollListeners(), 15000); this.statsTimer.unref?.();
    this.connect();
  }
  async connect() {
    if (!this.running) return;
    clearTimeout(this.retryTimer);
    this.setState(this.attempt ? 'reconnecting' : 'connecting');
    try {
      if (!this.ffmpegPath) throw new SourceError('Broadcasting needs FFmpeg, which is not installed', { fatal: true });
      if (this.t.type === 'rtmp') {
        if (!this.t.rtmpUrl) throw new SourceError('Enter the RTMP server URL', { fatal: true });
        if (this.ffmpegInfo?.encoders && this.ffmpegInfo.encoders.libx264 === false) throw new SourceError('RTMP needs an FFmpeg build with libx264 (H.264)', { fatal: true });
        this.spawnEncoder(null);
      } else {
        if (!this.t.host) throw new SourceError('Enter the server host name', { fatal: true });
        const password = this.secret('password');
        if (!password) throw new SourceError('Enter the source password', { fatal: true });
        const f = STREAM_FORMATS[this.t.format];
        const sock = await openSource(this.t, { password, contentType: f.contentType, bitrate: this.t.bitrate, sampleRate: f.sampleRate || this.t.sampleRate, timeout: 10000 });
        if (!this.running) { sock.destroy(); return; }
        this.sock = sock;
        sock.on('data', () => {}); // ignore anything the server sends while streaming
        sock.on('error', () => {});
        sock.on('close', () => { if (this.sock === sock) this.dropped('The server closed the connection'); });
        this.spawnEncoder(sock);
        this.markLive();
        if (this.song) this.sendMetadata(this.song).catch(() => {});
        setTimeout(() => this.pollListeners(), 2000).unref?.();
      }
    } catch (e) {
      this.log?.warn?.(`[opendj] broadcast ${this.t.name}: ${e.message}`);
      if (e.fatal) { this.setState('error', e.message); this.retry(60000); } else { this.setState('reconnecting', e.message); this.retry(); }
    }
  }
  markLive() { this.attempt = 0; this.connectedAt = Date.now(); this.setState('live', null); }
  retry(ms) {
    if (!this.running) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.reconnects++; this.connect(); }, ms ?? backoff(this.attempt++));
    this.retryTimer.unref?.();
  }
  spawnEncoder(sock) {
    const p = spawn(this.ffmpegPath, this.encoderArgs(), { stdio: ['pipe', sock ? 'pipe' : 'ignore', 'pipe'], windowsHide: true });
    this.proc = p;
    let err = '';
    p.stdin.on('error', () => {});
    p.stderr.on('data', (d) => {
      const s = d.toString();
      if (this.t.type === 'rtmp') {
        // -progress key=value lines: the connection is up once FFmpeg reports output progress
        const m = /total_size=(\d+)/.exec(s);
        if (m) { const n = Number(m[1]); if (n > this.bytesOut) this.count(n - this.bytesOut); if (this.state !== 'live' && n > 0) this.markLive(); }
        const rest = s.split('\n').filter((l) => l && !/^[a-z_0-9]+=/.test(l)).join('\n');
        if (rest && err.length < 4000) err += rest + '\n';
      } else if (err.length < 4000) err += s;
    });
    if (sock) {
      p.stdout.on('data', (d) => {
        if (this.sock !== sock || sock.destroyed) return;
        // live stream: if the network is too slow, drop audio instead of buffering minutes of it
        if (sock.writableLength > 2 * 1024 * 1024) { this.droppedOut = (this.droppedOut || 0) + d.length; return; }
        sock.write(d);
        this.count(d.length);
      });
    }
    p.on('error', (e) => { err += e.message; });
    p.on('close', (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      if (!this.running) return;
      const msg = err.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 200) || `encoder exited (${code})`;
      this.dropped(this.t.type === 'rtmp' ? `RTMP connection lost: ${msg}` : `Encoder stopped: ${msg}`);
    });
  }
  count(n) {
    this.bytesOut += n;
    const now = Date.now();
    this.window.push([now, n]);
    while (this.window.length && now - this.window[0][0] > 5000) this.window.shift();
  }
  kbps() {
    if (this.state !== 'live' || !this.window.length) return 0;
    const span = Math.max(1000, Math.min(5000, Date.now() - (this.connectedAt || Date.now())));
    return Math.round(this.window.reduce((s, [, n]) => s + n, 0) * 8 / span);
  }
  dropped(reason) {
    const sock = this.sock, p = this.proc;
    this.sock = null; this.proc = null;
    try { sock?.destroy(); } catch { /* */ }
    try { p?.stdin.end(); p?.kill('SIGKILL'); } catch { /* */ }
    this.connectedAt = null;
    if (!this.running) return;
    this.setState('reconnecting', reason);
    this.retry();
  }
  /** PCM from the browser. Never blocks: a stuck encoder drops audio rather than stalling the other outputs. */
  write(buf) {
    const p = this.proc;
    if (!p || this.state !== 'live' && this.t.type !== 'rtmp') { this.droppedIn += buf.length; return; }
    if (p.stdin.writableLength > 4 * 1024 * 1024) { this.droppedIn += buf.length; return; }
    p.stdin.write(buf);
  }
  async sendMetadata(song) {
    this.song = song;
    if (this.t.type === 'rtmp' || this.state !== 'live' || !song) return false;
    const req = metadataRequest(this.t, song, this.secret('password'));
    try {
      const r = await this.fetch(req.url, { headers: req.headers, signal: AbortSignal.timeout(8000) });
      this.metaOk = r.ok; this.metaError = r.ok ? null : `metadata update answered HTTP ${r.status}`;
      return r.ok;
    } catch (e) { this.metaOk = false; this.metaError = `metadata update failed: ${e.message}`; return false; }
  }
  async pollListeners() {
    if (this.state !== 'live') return;
    const url = statsUrl(this.t);
    if (!url) return;
    try {
      const r = await this.fetch(url, { headers: { 'User-Agent': `Mozilla/5.0 (OpenDJ/${VERSION})` }, signal: AbortSignal.timeout(8000) });
      if (r.ok) { const n = parseListeners(this.t, await r.text()); if (n != null && n !== this.listeners) { this.listeners = n; this.emit('change', this.status()); } }
    } catch { /* stats are optional */ }
  }
  async stop() {
    this.running = false;
    clearTimeout(this.retryTimer); clearInterval(this.statsTimer);
    const p = this.proc, sock = this.sock;
    this.proc = null; this.sock = null;
    if (p) {
      p.stdin.end();
      if (sock) {
        // let the encoder flush its tail to the server, then hang up
        await Promise.race([new Promise((r) => p.once('close', r)), new Promise((r) => setTimeout(r, 1500))]);
        p.stdout?.removeAllListeners('data');
      } else await Promise.race([new Promise((r) => p.once('close', r)), new Promise((r) => setTimeout(r, 3000))]);
      try { p.kill('SIGKILL'); } catch { /* exited */ }
    }
    if (sock) await new Promise((r) => { sock.end(r); setTimeout(r, 1000); }).finally(() => sock.destroy());
    this.setState('stopped');
  }
  status() {
    const t = this.t;
    return {
      id: t.id, name: t.name, type: t.type, state: this.state, error: this.error, listeners: this.listeners,
      kbps: this.kbps(), bytes: this.bytesOut, reconnects: this.reconnects, uptime: this.connectedAt ? (Date.now() - this.connectedAt) / 1000 : 0,
      song: this.song, metaError: this.metaError || null, dropped: this.droppedIn + (this.droppedOut || 0),
    };
  }
}

// ------------------------------------------------------------------ routes

export const BROADCAST_DEFAULTS = { targets: [], updateMetadata: true };

/**
 * @param {object} o  { route, library, emit, pathAllowed, ffmpeg (() => info), fetch, log }
 */
export function registerBroadcastRoutes({ route, library, emit = () => {}, pathAllowed = () => true, ffmpeg, fetch: f = globalThis.fetch, log = console }) {
  const store = configStore(library, 'broadcast', BROADCAST_DEFAULTS);
  const secrets = new SecretStore(library.dataDir);
  const ff = () => (ffmpeg ? ffmpeg() : library.media?.ffmpeg?.()) || null;
  const sessions = new Map();
  const SECRET_KEYS = ['password', 'streamKey'];

  const publicTarget = (t) => ({ ...t, hasPassword: secrets.has('broadcast', t.id, 'password'), hasStreamKey: secrets.has('broadcast', t.id, 'streamKey') });
  const publicConfig = () => { const c = store.get(); return { ...c, targets: (c.targets || []).map(publicTarget) }; };
  const status = () => ({ active: [...sessions.values()].map((s) => s.status()) });
  const push = () => emit('broadcast', status());

  route('GET', '/api/broadcast/config', async () => {
    await library.media?.ready;
    return { config: publicConfig(), formats: Object.entries(STREAM_FORMATS).map(([id, x]) => ({ id, label: x.label })), ffmpeg: !!ff(), rtmp: ff()?.encoders?.libx264 !== false };
  });
  route('PUT', '/api/broadcast/config', async ({ body }) => {
    const cur = store.get();
    const next = { ...cur };
    if ('updateMetadata' in body) next.updateMetadata = !!body.updateMetadata;
    if (Array.isArray(body.targets)) {
      if (body.targets.length > 10) throw httpError(400, 'At most 10 stream targets');
      const prev = new Map((cur.targets || []).map((t) => [t.id, t]));
      next.targets = body.targets.map((t) => {
        if (!t || typeof t !== 'object') throw httpError(400, 'Bad target');
        const n = normTarget(t, prev.get(t.id) || {});
        if (n.type === 'rtmp' && n.image && !pathAllowed(n.image)) throw httpError(403, 'The image is outside the allowed folders');
        return { n, t };
      }).map(({ n, t }) => {
        // secrets: a non-empty value replaces, `clearPassword` / `clearStreamKey` removes, anything else keeps
        for (const k of SECRET_KEYS) {
          if (typeof t[k] === 'string' && t[k] && t[k] !== '••••••') secrets.set('broadcast', n.id, k, t[k].slice(0, 500));
          if (t[`clear${k[0].toUpperCase()}${k.slice(1)}`]) secrets.set('broadcast', n.id, k, '');
        }
        return n;
      });
      for (const id of prev.keys()) if (!next.targets.some((t) => t.id === id)) secrets.remove('broadcast', id);
    }
    store.set(next);
    return { config: publicConfig() };
  });
  route('GET', '/api/broadcast/status', () => status());

  route('POST', '/api/broadcast/start', async ({ body }) => {
    await library.media?.ready;
    if (!ff()) throw httpError(415, 'Broadcasting needs FFmpeg, which is not installed on the server.', 'needs-ffmpeg');
    const cfg = store.get();
    const ids = Array.isArray(body.targetIds) && body.targetIds.length ? body.targetIds : (cfg.targets || []).filter((t) => t.enabled).map((t) => t.id);
    const targets = (cfg.targets || []).filter((t) => ids.includes(t.id));
    if (!targets.length) throw httpError(400, 'Add and enable a stream target first');
    if ([...sessions.values()].some((s) => s.outputs.some((o) => ids.includes(o.t.id)))) throw httpError(409, 'Already broadcasting to this target');
    const inRate = Math.round(Number(body.sampleRate));
    if (!(inRate >= 8000 && inRate <= 384000)) throw httpError(400, 'Bad sample rate');
    const inFormat = body.sampleFormat === 'f32' ? 'f32' : 's16';
    const chunkFrames = Math.min(inRate * 4, Math.max(128, Number(body.chunkFrames) || inRate / 2));
    const id = crypto.randomBytes(8).toString('hex');
    const outputs = targets.map((target) => {
      const o = new BroadcastOutput({
        target, secret: (k) => secrets.get('broadcast', target.id, k), ffmpegPath: ff().path, ffmpegInfo: ff(), inFormat, inRate, fetch: f, log,
        image: target.image && pathAllowed(target.image) ? target.image : DEFAULT_IMAGE,
      });
      o.on('change', push);
      return o;
    });
    const s = {
      id, outputs, startedAt: Date.now(), lastChunkAt: Date.now(), song: '',
      reorder: new ChunkReorderer({ sink: (buf) => { for (const o of outputs) o.write(buf); }, window: 60, gapBytes: 0 }),
      frameBytes: 2 * (inFormat === 'f32' ? 4 : 2), chunkFrames,
      status: () => ({ id, startedAt: s.startedAt, song: s.song, outputs: outputs.map((o) => o.status()) }),
    };
    sessions.set(id, s);
    for (const o of outputs) o.start();
    push();
    return s.status();
  });
  const sess = (id) => { const s = sessions.get(id); if (!s) throw httpError(404, 'This broadcast is not running'); return s; };
  route('POST', '/api/broadcast/:id/chunk', async ({ req, params, query }) => {
    const s = sess(params.id);
    const buf = await readRaw(req, Math.max(1 << 20, s.chunkFrames * s.frameBytes * 2));
    s.lastChunkAt = Date.now();
    const seq = Number(query.get('seq'));
    // live audio: a chunk that is too late is dropped instead of holding everything else back
    if (seq - s.reorder.expected >= s.reorder.window) { s.reorder.expected = seq; s.reorder.pending.clear(); }
    return s.reorder.push(seq, buf);
  }, { raw: true });
  route('POST', '/api/broadcast/:id/metadata', async ({ params, body }) => {
    const s = sess(params.id);
    const song = songTitle(body);
    s.song = song;
    if (store.get().updateMetadata === false) return { ok: false, song };
    const results = await Promise.all(s.outputs.map((o) => o.sendMetadata(song)));
    push();
    return { ok: results.some(Boolean), song };
  });
  route('POST', '/api/broadcast/:id/stop', async ({ params }) => {
    const s = sess(params.id);
    sessions.delete(s.id);
    await Promise.all(s.outputs.map((o) => o.stop()));
    push();
    return s.status();
  });

  const watchdog = setInterval(() => {
    for (const s of sessions.values()) if (Date.now() - s.lastChunkAt > 60000) { sessions.delete(s.id); Promise.all(s.outputs.map((o) => o.stop())).then(push); }
  }, 10000);
  watchdog.unref?.();

  return {
    sessions, secrets,
    async close() { clearInterval(watchdog); await Promise.all([...sessions.values()].flatMap((s) => s.outputs.map((o) => o.stop()))); sessions.clear(); },
  };
}
