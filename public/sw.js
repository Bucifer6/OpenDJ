// OpenDJ service worker: lets the app shell load fast and be installed as an app (PWA).
// - /api/*            network only (never cached: library data, audio, auth)
// - /js /css icons    cache first, refreshed in the background (so an update shows up on the next load)
// - page navigations  network first, falling back to the cached shell when the server is unreachable
const CACHE = 'opendj-shell-v18';
const SHELL = ['/', '/index.html', '/login.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  // Best effort: assets behind the login are cached once the user has signed in.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => fetch(u, { credentials: 'same-origin' })
    .then((r) => (r.ok && !r.redirected ? c.put(u, r) : null)).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const cacheable = (r) => r && r.ok && r.status === 200 && !r.redirected && r.type === 'basic';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return; // network only

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => {
      if (cacheable(r)) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(url.pathname === '/' ? '/index.html' : url.pathname, copy)); }
      return r;
    }).catch(async () => (await caches.match(url.pathname === '/' ? '/index.html' : url.pathname)) || (await caches.match('/index.html')) || Response.error()));
    return;
  }

  if (/^\/(js|css)\//.test(url.pathname) || /\.(png|svg|ico|webmanifest|woff2)$/.test(url.pathname)) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const refresh = fetch(req).then((r) => { if (cacheable(r)) c.put(req, r.clone()); return r; });
      if (hit) { e.waitUntil(refresh.catch(() => {})); return hit; }
      return refresh;
    }));
  }
});
