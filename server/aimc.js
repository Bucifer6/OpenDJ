// Bridge to the AI MC add-on (ai-mc/server.js). The OpenDJ page may only talk to its own origin (CSP), so these
// routes forward to the AI MC server on this computer. Off unless AI MC runs; AIMC_URL overrides the address.
import { Readable } from 'node:stream';

export function registerAimcRoutes({ route }) {
  const base = (process.env.AIMC_URL || 'http://127.0.0.1:7381').replace(/\/+$/, '');
  const fwd = async (path, init) => {
    try { return await fetch(base + path, { ...init, signal: AbortSignal.timeout(10000) }); }
    catch { return null; }
  };
  route('POST', '/api/aimc/state', async ({ body }) => {
    const r = await fwd('/bridge/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (!r?.ok) return { offline: true, play: [], queue: [] };
    return r.json();
  });
  route('POST', '/api/aimc/done', async ({ body }) => {
    await fwd('/bridge/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: String(body?.id || '') }) });
    return { ok: true };
  });
  route('GET', '/api/aimc/audio/:id', async ({ params, res }) => {
    if (!/^[a-f0-9]{16}$/.test(params.id)) { res.writeHead(400); return res.end(); }
    const r = await fwd('/bridge/audio/' + params.id);
    if (!r?.ok || !r.body) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
    Readable.fromWeb(r.body).pipe(res);
  });
}
