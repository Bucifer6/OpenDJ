// Shared helpers for test/recording*.test.js and scripts/e2e-recording.mjs (not a test file itself).
import http from 'node:http';
import net from 'node:net';

/** Minimal stand-in for server/index.js's router (JSON bodies, raw routes, error statuses). */
export function miniServer(register) {
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$'), keys, handler, ...opts });
  };
  const ctx = register(route);
  const server = http.createServer((req, res) => dispatch(routes, req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end('{}'); } }));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, ctx, routes, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

/** Run a request through routes registered with route(); resolves false when no route matched. */
export async function dispatch(routes, req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    for (const r of routes) {
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const m = r.re.exec(url.pathname); if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      let body = {};
      if (!r.raw && ['POST', 'PUT', 'PATCH'].includes(req.method)) { const c = []; for await (const x of req) c.push(x); const raw = Buffer.concat(c); body = raw.length ? JSON.parse(raw) : {}; }
      const out = await r.handler({ req, res, params, body, query: url.searchParams });
      if (!res.headersSent && out !== undefined) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); }
      return true;
    }
    return false;
  } catch (e) {
    if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
    if (!res.headersSent) { res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message, code: e.code })); } else res.end();
    return true;
  }
}

export const fakeLibrary = (dataDir, ff = null) => ({ dataDir, settings: {}, updateSettings() {}, media: { ffmpeg: () => ff, ready: Promise.resolve(ff) } });

/**
 * Mock Icecast 2 server on one port: source logins (PUT with 100-continue, or SOURCE), /admin/metadata and
 * /status-json.xsl. opts: { password, put: false (answer 405 to PUT, like Icecast < 2.4) }.
 */
export function mockIcecast({ password = 'hackme', user = 'source', put = true } = {}) {
  const st = { sources: [], metadata: [], bytes: 0, chunks: [], sockets: new Set(), heads: [] };
  const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  const server = net.createServer((sock) => {
    st.sockets.add(sock); sock.on('close', () => st.sockets.delete(sock)); sock.on('error', () => {});
    let buf = Buffer.alloc(0), streaming = null;
    sock.on('data', (d) => {
      if (streaming) { streaming.bytes += d.length; st.bytes += d.length; if (st.chunks.length < 64) st.chunks.push(d); return; }
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const head = buf.subarray(0, i).toString('latin1'), rest = buf.subarray(i + 4);
      st.heads.push(head);
      const [method, target] = head.split('\r\n')[0].split(' ');
      const hdr = Object.fromEntries(head.split('\r\n').slice(1).map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
      if (method === 'PUT' || method === 'SOURCE') {
        if (method === 'PUT' && !put) { sock.end('HTTP/1.0 405 Method Not Allowed\r\n\r\n'); return; }
        if (hdr.authorization !== auth) { sock.end('HTTP/1.0 401 Authentication Required\r\n\r\n'); return; }
        streaming = { method, mount: target, headers: hdr, bytes: 0 };
        st.sources.push(streaming);
        sock.write(method === 'PUT' && /100-continue/i.test(hdr.expect || '') ? 'HTTP/1.1 100 Continue\r\n\r\n' : 'HTTP/1.0 200 OK\r\n\r\n');
        if (rest.length) { streaming.bytes += rest.length; st.bytes += rest.length; }
        return;
      }
      const u = new URL(target, 'http://x');
      if (u.pathname === '/admin/metadata') {
        const ok = hdr.authorization === auth;
        if (ok) st.metadata.push(Object.fromEntries(u.searchParams));
        sock.end(ok ? 'HTTP/1.0 200 OK\r\nContent-Type: text/xml\r\n\r\n<iceresponse><message>Metadata update successful</message><return>1</return></iceresponse>' : 'HTTP/1.0 401 Unauthorized\r\n\r\n');
      } else if (u.pathname === '/status-json.xsl') {
        const port = server.address().port;
        const body = JSON.stringify({ icestats: { source: st.sources.filter((s) => s.bytes >= 0).map((s) => ({ listenurl: `http://127.0.0.1:${port}${s.mount}`, listeners: 7 })) } });
        sock.end(`HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      } else sock.end('HTTP/1.0 404 Not Found\r\n\r\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    ...st, state: st, port: server.address().port,
    dropSources() { for (const s of st.sockets) s.destroy(); },
    close: () => new Promise((r) => { for (const s of st.sockets) s.destroy(); server.close(r); }),
  })));
}
