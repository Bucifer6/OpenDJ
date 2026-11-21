// Routes the UI's server requests to the on-device backend, so the UI code stays the same as on the desktop.
// Installed by boot.js before anything talks to the server. Only same-origin /api/... requests are taken over;
// everything else (YouTube, GitHub mapping downloads, media servers in browsers…) goes to the real fetch.
//   fetch('/api/...')            -> backend.handle()  (a real Response comes back)
//   new EventSource('/api/events') -> backend events (same event names as the server's SSE)
//   <a href="/api/..." download>  -> the response is saved / shared (exports: playlists, backups, recordings…)
//   <audio>/<video>.src = '/api/...' -> a blob: / capacitor file URL of the same media
import { saveOrShare, dispositionName } from './share.js';

export function installShim(backendP, { win = globalThis } = {}) {
  let backend = null;
  backendP.then((b) => { backend = b; }, () => {});
  const origin = win.location.origin;
  const apiPath = (url) => {
    let u;
    try { u = new URL(url, win.location.href); } catch { return null; }
    return u.origin === origin && u.pathname.startsWith('/api/') ? u.pathname + u.search : null;
  };

  // ---- fetch ----
  const origFetch = win.fetch.bind(win);
  win.fetch = async function localFetch(input, init = {}) {
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    const path = apiPath(isReq ? input.url : String(input));
    if (!path) return origFetch(input, init);
    const method = String(init.method || (isReq ? input.method : 'GET')).toUpperCase();
    let body = init.body;
    if (body === undefined && isReq && !['GET', 'HEAD'].includes(method)) body = await input.arrayBuffer();
    const headers = new Headers(init.headers || (isReq ? input.headers : undefined));
    const signal = init.signal || (isReq ? input.signal : undefined);
    const b = await backendP;
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    return b.handle(method, path, { body, headers, signal });
  };

  // ---- EventSource ----
  const OrigES = win.EventSource;
  class LocalEventSource extends EventTarget {
    constructor(url, opts) {
      const path = apiPath(String(url));
      if (!path && OrigES) return new OrigES(url, opts);
      super();
      this.url = String(url); this.readyState = 0; this.withCredentials = false;
      this.onopen = this.onmessage = this.onerror = null;
      const fire = (ev) => { this.dispatchEvent(ev); const h = this[`on${ev.type}`]; if (typeof h === 'function') h.call(this, ev); };
      if (path === '/api/events') {
        backendP.then((b) => {
          if (this.readyState === 2) return;
          this.readyState = 1; fire(new Event('open'));
          this._off = b.subscribe((type, payload) => { if (this.readyState !== 2) fire(new MessageEvent(type, { data: JSON.stringify(payload ?? {}) })); });
        });
      } else {
        // streams of features the phone doesn't have (lighting, Link): closed, like a server without them
        queueMicrotask(() => { this.readyState = 2; fire(new Event('error')); });
      }
    }
    close() { this.readyState = 2; this._off?.(); }
  }
  LocalEventSource.CONNECTING = 0; LocalEventSource.OPEN = 1; LocalEventSource.CLOSED = 2;
  win.EventSource = LocalEventSource;

  // ---- downloads (<a href="/api/..." download>) ----
  win.document.addEventListener('click', async (e) => {
    const a = e.target?.closest?.('a[href]');
    if (!a || a.dataset.opendjExport) return;
    const path = apiPath(a.getAttribute('href'));
    if (!path) return;
    e.preventDefault();
    try {
      const res = await (await backendP).handle('GET', path);
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
      const name = dispositionName(res.headers.get('content-disposition')) || a.getAttribute('download') || decodeURIComponent(path.split('?')[0].split('/').pop());
      await saveOrShare(await res.blob(), name);
    } catch (err) { win.opendj?.toast?.(`⚠ Export failed: ${err.message}`); }
  }, true);

  // ---- <audio>/<video> src ----
  const proto = win.HTMLMediaElement?.prototype;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'src');
  if (desc?.set) {
    Object.defineProperty(proto, 'src', {
      configurable: true, enumerable: desc.enumerable, get: desc.get,
      set(v) {
        const path = typeof v === 'string' ? apiPath(v) : null;
        this._odjWant = path;
        if (!path) { this._odjPending = null; return desc.set.call(this, v); }
        const now = backend?.urlForSync(path);
        if (now) { this._odjPending = null; return desc.set.call(this, now); }
        const p = backendP.then((b) => b.urlFor(path)).then((real) => { if (this._odjWant === path && real) desc.set.call(this, real); }, () => {});
        this._odjPending = p;
        p.finally(() => { if (this._odjPending === p) this._odjPending = null; });
        return undefined;
      },
    });
    const play = proto.play, load = proto.load;
    proto.play = function () { return this._odjPending ? this._odjPending.then(() => play.call(this)) : play.call(this); };
    proto.load = function () { return this._odjPending ? void this._odjPending.then(() => load.call(this)) : load.call(this); };
  }
  return { get backend() { return backend; } };
}
