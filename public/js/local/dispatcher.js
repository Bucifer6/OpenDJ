// In-page request router for the on-device backend: the same `route(method, pattern, handler)` shape as
// server/index.js, but requests come from the fetch shim (public/js/local/shim.js) instead of a socket, so nothing
// listens on any port and nothing is reachable from outside the app.
//
// Handlers get { params, query, body, headers, method, signal } and return:
//   a plain value      -> 200 JSON
//   a Response         -> sent as is (audio, covers, exports…)
//   undefined          -> 204
// and throw HttpError(status, message) for errors (sent as { error } JSON like the server does).

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; if (code) this.code = code; }
}

export const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** Attachment response (exports): the shim saves / shares it instead of navigating. */
export function attachment(body, type, name) {
  const safe = String(name).replace(/[^\w.\- ]+/g, '_');
  return new Response(body, { headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}` } });
}

/** Parse a request body the way the server does: JSON (application/json), bytes (octet-stream / binary), or {}. */
export async function parseBody(body, contentType = '') {
  if (body == null || body === '') return {};
  const ct = String(contentType).split(';')[0].trim().toLowerCase();
  if (typeof body === 'string') {
    if (ct && ct !== 'application/json') return new TextEncoder().encode(body);
    try { const v = JSON.parse(body); return v && typeof v === 'object' ? v : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
  }
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body; // files (import / upload) stay Blobs: no copy
  if (typeof body === 'object') return body; // direct calls from tests / other modules
  throw new HttpError(415, 'Unsupported body');
}

export class Router {
  constructor({ log = console } = {}) { this.routes = []; this.log = log; }

  route(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, handler, ...opts });
  }

  /**
   * Handle one request. `url` is a path ("/api/tracks?x=1") or a full same-origin URL.
   * @returns {Promise<Response>}
   */
  async handle(method, url, { body, headers = {}, signal } = {}) {
    method = String(method || 'GET').toUpperCase();
    let u;
    try { u = new URL(url, 'http://local.invalid'); } catch { return json(400, { error: 'Bad URL' }); }
    const h = headers instanceof Headers ? Object.fromEntries(headers.entries()) : Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    try {
      for (const r of this.routes) {
        if (r.method !== method && !(r.method === 'GET' && method === 'HEAD')) continue;
        const m = r.re.exec(u.pathname);
        if (!m) continue;
        let params;
        try { params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); } catch { throw new HttpError(400, 'Bad URL'); }
        const parsed = ['POST', 'PUT', 'PATCH'].includes(method) && !r.raw ? await parseBody(body, h['content-type'] || (typeof body === 'string' ? 'application/json' : '')) : (r.raw ? body : {});
        const out = await r.handler({ params, query: u.searchParams, body: parsed, headers: h, method, signal });
        if (out instanceof Response) return out;
        if (out === undefined) return new Response(null, { status: 204 });
        return json(200, out);
      }
      throw new HttpError(404, 'No such endpoint');
    } catch (e) {
      if (!e.status) this.log.error?.('[opendj local]', e);
      return json(e.status || 500, { error: e.status ? e.message : (e.message || 'Internal error'), ...(e.code && typeof e.code === 'string' && e.status ? { code: e.code } : {}) });
    }
  }
}

/** Minimal event hub with the server's SSE event names (library, scan, sync, downloads, jobs, job-error, lyrics…). */
export class EventHub {
  constructor() { this.subs = new Set(); this.pending = []; }
  emit(type, payload) { for (const fn of this.subs) { try { fn(type, payload ?? {}); } catch (e) { console.error(e); } } }
  /** Subscribe; replays startup warnings once (like the server's 'hello' + pending job-error). */
  subscribe(fn) {
    this.subs.add(fn);
    queueMicrotask(() => { fn('hello', {}); while (this.pending.length) fn('job-error', { key: 'load', message: this.pending.shift() }); });
    return () => this.subs.delete(fn);
  }
}
