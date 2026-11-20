// Sends numbered PCM chunks to the server with chunked HTTP POSTs.
// (Chromium only streams request bodies — fetch(..., { duplex: 'half' }) — over HTTP/2, and the OpenDJ server is
// plain HTTP/1.1, so chunks it is.) Up to `maxInFlight` requests run at once; the server re-orders them. Failed
// chunks are retried with backoff; the server answers each POST after the chunk was written, so a slow disk or
// encoder slows the uploads down (backpressure) and the queue here grows until `maxQueueBytes`, after which the
// oldest queued audio is dropped (the server fills the gap with silence so the timeline stays right).
export class ChunkUploader {
  /**
   * @param {object} o
   * @param {(seq: number) => string} o.url
   * @param {number} [o.maxInFlight=3]
   * @param {number} [o.maxQueueBytes=96 MB]
   * @param {boolean} [o.live=false]     live streams give up on a chunk after 2 retries instead of insisting
   * @param {(err: Error) => void} [o.onFatal]  the server refused the stream (stopped, gone, disk full…)
   * @param {(msg: string) => void} [o.onWarn]
   * @param {Function} [o.fetch]
   */
  constructor({ url, maxInFlight = 3, maxQueueBytes = 96 * 1024 * 1024, live = false, onFatal = () => {}, onWarn = () => {}, fetch: f }) {
    Object.assign(this, { url, maxInFlight, maxQueueBytes, live, onFatal, onWarn });
    this.fetch = f || ((...a) => globalThis.fetch(...a));
    this.seq = 0; this.queue = []; this.queuedBytes = 0; this.inFlight = 0;
    this.sent = 0; this.sentBytes = 0; this.retries = 0; this.dropped = 0; this.failed = null; this.lastAck = -1;
    this._idle = []; this._warned = 0;
  }
  /** Queue a chunk; returns its sequence number. */
  push(data) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const seq = this.seq++;
    if (this.failed) return seq;
    this.queue.push({ seq, bytes, tries: 0, notBefore: 0 });
    this.queuedBytes += bytes.byteLength;
    while (this.queuedBytes > this.maxQueueBytes && this.queue.length > 1) {
      const old = this.queue.shift(); this.queuedBytes -= old.bytes.byteLength; this.dropped++;
      if (Date.now() - this._warned > 10000) { this._warned = Date.now(); this.onWarn('The server is not keeping up; some audio was dropped'); }
    }
    this._pump();
    return seq;
  }
  get lastSeq() { return this.seq - 1; }
  get backlogBytes() { return this.queuedBytes; }
  _pump() {
    if (this.failed) return;
    const now = Date.now();
    while (this.inFlight < this.maxInFlight) {
      const i = this.queue.findIndex((c) => c.notBefore <= now);
      if (i < 0) break;
      const [c] = this.queue.splice(i, 1);
      this.queuedBytes -= c.bytes.byteLength;
      this._send(c);
    }
    const wait = this.queue.length && this.inFlight < this.maxInFlight ? Math.max(20, Math.min(...this.queue.map((c) => c.notBefore)) - now) : 0;
    if (wait) { clearTimeout(this._timer); this._timer = setTimeout(() => this._pump(), wait); }
    if (!this.queue.length && !this.inFlight) { const w = this._idle; this._idle = []; w.forEach((r) => r()); }
  }
  async _send(c) {
    this.inFlight++;
    let retry = false, fatal = null;
    try {
      const r = await this.fetch(this.url(c.seq), { method: 'POST', body: c.bytes, headers: { 'Content-Type': 'application/octet-stream' }, credentials: 'same-origin', cache: 'no-store' });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        if (Number.isFinite(j.ack)) this.lastAck = Math.max(this.lastAck, j.ack);
        this.sent++; this.sentBytes += c.bytes.byteLength;
      } else {
        let body = {}; try { body = await r.json(); } catch { /* not json */ }
        const msg = body.error || `HTTP ${r.status}`;
        if (r.status === 401) { fatal = new Error('Login required'); }
        else if (body.code === 'recording-failed' || [400, 404, 410, 413, 415, 507].includes(r.status)) fatal = Object.assign(new Error(msg), { status: r.status });
        else retry = true; // 409 (too early), 429, 5xx
      }
    } catch { retry = true; } // network error: server restarting, Wi-Fi hiccup…
    this.inFlight--;
    if (fatal) { this.failed = fatal; this.queue = []; this.queuedBytes = 0; this.onFatal(fatal); }
    else if (retry) {
      c.tries++; this.retries++;
      if (this.live && c.tries > 2) this.dropped++;
      else { c.notBefore = Date.now() + Math.min(5000, 250 * 2 ** Math.min(c.tries, 5)); this.queue.unshift(c); this.queuedBytes += c.bytes.byteLength; }
    }
    this._pump();
  }
  /** Resolves when everything queued was sent (or timeoutMs passed). */
  drain(timeoutMs = 20000) {
    if (this.failed || (!this.queue.length && !this.inFlight)) return Promise.resolve(!this.failed);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this._idle.push(() => { clearTimeout(t); resolve(!this.failed); });
    });
  }
  abort() { this.failed ||= new Error('aborted'); this.queue = []; this.queuedBytes = 0; clearTimeout(this._timer); }
}
