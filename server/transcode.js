// On-the-fly FFmpeg transcoding with an on-disk LRU cache.
//
// Audio: anything the browser can't decode -> FLAC (lossless, compression level 0, sample rate kept up to 192 kHz,
// DSD -> 24-bit / 88.2 kHz PCM). The first request is streamed live while the same ffmpeg process writes the
// cache file; later requests (and seeks / Range requests) are served from `transcode-cache/<trackId>.flac`.
// Video: containers the browser can't play -> MP4 (H.264/AAC, +faststart), remuxed with `-c copy` when possible.
// At most `concurrency` ffmpeg processes run at once; a job is killed when every client waiting on it went away.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FFMPEG_THREADS = String(Math.min(4, Math.max(1, Math.floor((os.cpus()?.length || 2) / 2))));

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  acquire(signal) {
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.n--;
        let released = false;
        resolve(() => { if (released) return; released = true; this.n++; this.next(); });
      };
      if (signal?.aborted) return reject(new Error('aborted'));
      if (this.n > 0) return grant();
      const item = { grant };
      this.q.push(item);
      signal?.addEventListener('abort', () => {
        const i = this.q.indexOf(item);
        if (i >= 0) { this.q.splice(i, 1); reject(new Error('aborted')); }
      }, { once: true });
    });
  }
  next() { if (this.n > 0 && this.q.length) this.q.shift().grant(); }
}

const rangeStart = (req) => {
  const m = req.headers.range && /bytes=(\d*)-/.exec(req.headers.range);
  return m && m[1] ? Number(m[1]) : 0;
};
const safeKey = (k) => String(k).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
const lastLine = (s) => String(s).trim().split('\n').slice(-2).join(' ').slice(0, 300);

export class Transcoder {
  /**
   * @param {object} o
   * @param {string} o.dir             cache directory
   * @param {() => object|null} o.ffmpeg  returns the ffmpeg info from findFfmpeg() (or null)
   * @param {() => number} o.maxBytes  cache size cap
   * @param {(req, res, file, mime) => void} o.sendFile  Range-capable file sender
   */
  constructor({ dir, ffmpeg, maxBytes = () => 4 * 2 ** 30, concurrency = 2, sendFile, log = console }) {
    this.dir = dir;
    this.ffmpeg = ffmpeg;
    this.maxBytes = maxBytes;
    this.sendFile = sendFile;
    this.log = log;
    this.sem = new Semaphore(concurrency);
    this.jobs = new Map(); // final cache path -> job
    this.started = 0; // ffmpeg processes spawned (for tests / stats)
    fs.mkdirSync(dir, { recursive: true });
    // leftovers of an interrupted run
    for (const f of fs.readdirSync(dir)) if (/\.(part|src)$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  }

  file(key, ext) { return path.join(this.dir, `${safeKey(key)}.${ext}`); }

  async fresh(file, srcMtime) {
    const st = await fs.promises.stat(file).catch(() => null);
    return !!st && st.size > 0 && (!srcMtime || st.mtimeMs >= srcMtime);
  }
  touch(file) { const now = new Date(); fs.utimes(file, now, now, () => {}); }

  /** Remove a track's cached transcodes (e.g. when the track is deleted). */
  async evict(key) {
    for (const ext of ['flac', 'mp4', 'wav']) await fs.promises.rm(this.file(key, ext), { force: true });
  }

  /** Cancel all in-flight FFmpeg transcode jobs (called on server shutdown so no orphan ffmpeg.exe remains). */
  close() {
    for (const job of this.jobs.values()) job.cancel();
    this.jobs.clear();
  }

  async statsAsync() {
    let bytes = 0, files = 0;
    try {
      const names = await fs.promises.readdir(this.dir);
      for (const f of names) {
        if (/\.(part|src)$/.test(f)) continue;
        const st = await fs.promises.stat(path.join(this.dir, f)).catch(() => null);
        if (st?.isFile()) { bytes += st.size; files++; }
      }
    } catch { /* empty */ }
    return { bytes, files, maxBytes: this.maxBytes(), running: [...this.jobs.values()].filter((j) => j.proc).length, queued: this.sem.q.length };
  }

  stats() {
    let bytes = 0, files = 0;
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (/\.(part|src)$/.test(f)) continue;
        bytes += fs.statSync(path.join(this.dir, f)).size; files++;
      }
    } catch { /* empty */ }
    return { bytes, files, maxBytes: this.maxBytes(), running: [...this.jobs.values()].filter((j) => j.proc).length, queued: this.sem.q.length };
  }

  /** LRU: delete least recently used cache files until the cache fits the cap (never the file just produced). */
  async prune(keep) {
    const max = this.maxBytes();
    if (!max || max <= 0) return;
    const items = [];
    for (const f of await fs.promises.readdir(this.dir)) {
      if (/\.(part|src)$/.test(f)) continue;
      const p = path.join(this.dir, f);
      const st = await fs.promises.stat(p).catch(() => null);
      if (st?.isFile()) items.push({ p, size: st.size, t: st.mtimeMs });
    }
    let total = items.reduce((a, b) => a + b.size, 0);
    items.sort((a, b) => a.t - b.t);
    for (const it of items) {
      if (total <= max) break;
      if (it.p === keep || this.jobs.has(it.p)) continue;
      await fs.promises.rm(it.p, { force: true });
      total -= it.size;
    }
  }

  audioOutputArgs({ sampleRate, dsd }, target) {
    const rate = dsd ? ['-ar', '88200', '-sample_fmt', 's32', '-bits_per_raw_sample', '24']
      : sampleRate > 192000 ? ['-ar', '192000'] : [];
    return ['-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'flac', '-compression_level', '0', ...rate, '-ac', '2', '-f', 'flac', target];
  }

  /**
   * Serve browser-decodable FLAC for `input` (a path, or `async (signal) => path` for remote downloads).
   * opts: { key, input, srcMtime, sampleRate, dsd }
   */
  async serveAudio(req, res, opts) {
    const final = this.file(opts.key, 'flac');
    if (!this.jobs.has(final) && await this.fresh(final, opts.srcMtime)) {
      this.touch(final);
      return this.sendFile(req, res, final, 'audio/flac');
    }
    let job = this.jobs.get(final);
    const live = !job && rangeStart(req) === 0 && req.method !== 'HEAD';
    if (!job) {
      job = this._start(final, opts.input, (input, part) => [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', FFMPEG_THREADS, '-y', '-i', input,
        ...(live ? this.audioOutputArgs(opts, 'pipe:1') : []),
        ...this.audioOutputArgs(opts, part),
      ], { live: live ? res : null });
    }
    return this._consume(job, req, res, { live, mime: 'audio/flac' });
  }

  /** Serve an MP4 (H.264/AAC) of a video file. opts: { key, input, srcMtime, videoCodec, audioCodec } */
  async serveVideo(req, res, opts) {
    const final = this.file(opts.key, 'mp4');
    if (!this.jobs.has(final) && await this.fresh(final, opts.srcMtime)) {
      this.touch(final);
      return this.sendFile(req, res, final, 'video/mp4');
    }
    const ff = this.ffmpeg();
    const copyV = opts.videoCodec === 'h264';
    if (!copyV && !ff?.encoders?.libx264) {
      const e = new Error('This FFmpeg build has no H.264 encoder (libx264), so this video cannot be converted'); e.status = 415; throw e;
    }
    const copyA = ['aac', 'mp3'].includes(opts.audioCodec);
    const args = (copy) => (input, part) => [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', FFMPEG_THREADS, '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
      ...(copy && copyV ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']),
      ...(copy && copyA ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']),
      '-movflags', '+faststart', '-f', 'mp4', part,
    ];
    let job = this.jobs.get(final);
    if (!job) job = this._start(final, opts.input, args(true), { retryArgs: (copyV || copyA) && ff?.encoders?.libx264 ? args(false) : null });
    return this._consume(job, req, res, { live: false, mime: 'video/mp4' });
  }

  _start(final, inputSpec, makeArgs, { live = null, retryArgs = null } = {}) {
    const part = final + '.part';
    const job = { refs: 0, done: false, killed: false, proc: null, ctrl: new AbortController(), live };
    job.cancel = () => {
      if (job.done) return;
      job.killed = true;
      job.ctrl.abort();
      job.proc?.kill('SIGKILL');
    };
    const runOnce = (input, argsFn) => new Promise((resolve, reject) => {
      const ff = this.ffmpeg();
      if (!ff) return reject(Object.assign(new Error('FFmpeg is not available'), { status: 415 }));
      if (job.killed) return reject(new Error('aborted'));
      const p = spawn(ff.path, argsFn(input, part), { stdio: ['ignore', job.live ? 'pipe' : 'ignore', 'pipe'], windowsHide: true });
      if (p.pid) { try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* ignore */ } }
      this.started++;
      job.proc = p;
      let err = '';
      p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
      if (job.live) {
        const res = job.live;
        // Headers go out with the first decoded bytes, so an immediate failure can still answer with a JSON error.
        p.stdout.once('data', (chunk) => {
          if (job.live !== res || res.destroyed) { p.stdout.resume(); return; }
          res.writeHead(200, { 'Content-Type': 'audio/flac', 'Cache-Control': 'no-cache', 'X-OpenDJ-Transcode': 'live' });
          res.write(chunk);
          p.stdout.pipe(res);
        });
        job.detachLive = () => { p.stdout.unpipe(res); p.stdout.resume(); job.live = null; };
      }
      p.on('error', (e) => reject(e));
      p.on('close', (code, sig) => {
        job.proc = null;
        if (code === 0) resolve();
        else reject(new Error(job.killed ? 'aborted' : `FFmpeg failed (${code ?? sig}): ${lastLine(err)}`));
      });
    });
    let srcTmp = null;
    job.promise = (async () => {
      let release = null;
      try {
        release = await this.sem.acquire(job.ctrl.signal);
        let input = inputSpec;
        if (typeof inputSpec === 'function') { input = await inputSpec(job.ctrl.signal, final + '.src'); srcTmp = input; }
        try { await runOnce(input, makeArgs); }
        catch (e) {
          if (!retryArgs || job.killed) throw e;
          this.log.warn?.('[opendj] remux failed, re-encoding:', e.message);
          await runOnce(input, retryArgs);
        }
        await fs.promises.rename(part, final);
        this.prune(final).catch(() => {});
        return final;
      } catch (e) {
        await fs.promises.rm(part, { force: true }).catch(() => {});
        throw e;
      } finally {
        job.done = true;
        release?.();
        this.jobs.delete(final);
        if (srcTmp && srcTmp.endsWith('.src')) fs.promises.rm(srcTmp, { force: true }).catch(() => {});
      }
    })();
    job.promise.catch(() => {});
    this.jobs.set(final, job);
    return job;
  }

  async _consume(job, req, res, { live, mime }) {
    job.refs++;
    let left = false;
    const leave = () => {
      if (left) return; left = true;
      if (live && job.live === res) { if (job.detachLive) job.detachLive(); else job.live = null; }
      if (--job.refs <= 0) job.cancel();
    };
    res.on('close', () => { if (!res.writableFinished) leave(); });
    try {
      const final = await job.promise;
      if (live) { left = true; job.refs--; return; } // response was streamed live and ended with ffmpeg's stdout
      left = true; job.refs--;
      if (res.destroyed) return;
      this.touch(final);
      return this.sendFile(req, res, final, mime);
    } catch (e) {
      left = true; job.refs = Math.max(0, job.refs - 1);
      if (res.destroyed || e.message === 'aborted') { if (!res.destroyed) res.destroy(); return; }
      if (res.headersSent) { res.destroy(); return; }
      if (!e.status) e.status = 500;
      throw e;
    }
  }
}
