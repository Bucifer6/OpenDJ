// HTTP API for Ableton Link. Registered from server/index.js with registerLinkRoutes({ route, library, emit }).
//   GET  /api/link            status
//   PUT  /api/link            { enabled?, quantum?, startStopSync? }  (saved in settings.link)
//   POST /api/link/tempo      { bpm }                     propose a session tempo
//   POST /api/link/beat       { beat, at?, quantum?, force? }  map a beat to host time `at` (µs); force moves the session grid
//   POST /api/link/playing    { playing }                 start/stop state (shared when startStopSync is on)
//   GET  /api/link/time       { host }                    server host clock (µs), for the renderer's clock-offset estimate
//   GET  /api/link/stream     SSE "state" events at ~20 Hz (1 Hz while Link is off)
import { LinkNode, hostMicros } from './node.js';
import { UdpTransport } from './udp.js';

export const LINK_DEFAULTS = { enabled: false, quantum: 4, startStopSync: false };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

export function registerLinkRoutes({ route, library, emit = () => {}, transport, clock = hostMicros, log = console, rateHz = 20 } = {}) {
  let local = {}; // used when settings.link is not a known settings key yet
  const cfg = () => ({ ...LINK_DEFAULTS, ...(library?.settings?.link || {}), ...local });
  const saveCfg = (patch) => {
    local = { ...local, ...patch };
    try { library?.updateSettings?.({ link: { ...(library.settings?.link || {}), ...cfg() } }); } catch { /* read-only settings */ }
  };
  // OPENDJ_LINK_PORT: another multicast port, to test without joining real Link sessions on the network
  const port = Number(process.env.OPENDJ_LINK_PORT) || undefined;
  const node = new LinkNode({ transport: transport || new UdpTransport({ log, port }), clock, startStopSync: !!cfg().startStopSync });
  let lastError = null;
  node.on('error', (e) => { lastError = e.message; });

  const status = () => {
    const c = cfg();
    return { ...node.snapshot(c.quantum), quantum: c.quantum, error: lastError, transportErrors: node.transport.errors?.slice(-5) || [], endpoints: node.enabled ? node.transport.endpoints() : [] };
  };

  // small status pushes on the main event stream (peers / tempo / on-off), throttled
  let pushT = null;
  const pushSoon = () => {
    if (pushT) return;
    pushT = setTimeout(() => { pushT = null; const s = status(); emit('link', { enabled: s.enabled, peers: s.peers, bpm: s.bpm, playing: s.playing }); }, 200);
    pushT.unref?.();
  };
  node.on('change', (what) => { pushSoon(); if (what === 'peers' || what === 'tempo' || what === 'enabled') sendAll(); });

  const setEnabled = async (on) => {
    lastError = null;
    try { on ? await node.enable() : await node.disable(); } catch (e) {
      lastError = `Link could not start: ${e.message}`;
      try { await node.disable(); } catch { /* */ }
      throw bad(lastError, 500);
    }
  };

  // ---- live stream (20 Hz while Link is enabled; completely idle / event-driven while off)
  const streams = new Set();
  let streamT = null;
  const frame = () => `event: state\ndata: ${JSON.stringify(status())}\n\n`;
  const syncStreamTimer = () => {
    if (node.enabled && streams.size > 0) {
      if (!streamT) { streamT = setInterval(tick, 1000 / rateHz); streamT.unref?.(); }
    } else if (streamT) {
      clearInterval(streamT); streamT = null;
    }
  };
  function sendAll() {
    if (!streams.size) return;
    const f = frame();
    for (const r of streams) {
      if (r.destroyed || r.writableEnded || r.writableLength > 262144) { streams.delete(r); try { r.destroy(); } catch { /* */ } continue; }
      r.write(f);
    }
  }
  const tick = () => {
    if (!streams.size || !node.enabled) { syncStreamTimer(); return; }
    sendAll();
  };

  route('GET', '/api/link', () => status());
  route('PUT', '/api/link', async ({ body }) => {
    const patch = {};
    if ('quantum' in body) { const q = Number(body.quantum); if (!(q >= 1 && q <= 16)) throw bad('Quantum must be 1–16 beats'); patch.quantum = q; }
    if ('startStopSync' in body) { patch.startStopSync = !!body.startStopSync; node.startStopSync = patch.startStopSync; }
    if ('enabled' in body) { await setEnabled(!!body.enabled); patch.enabled = !!body.enabled; }
    saveCfg(patch);
    syncStreamTimer();
    sendAll(); pushSoon();
    return status();
  });
  route('POST', '/api/link/tempo', async ({ body }) => {
    const bpm = Number(body?.bpm);
    if (!(bpm >= 20 && bpm <= 999)) throw bad('Tempo must be 20–999 BPM');
    node.setTempo(bpm, Number(body.at) || clock());
    sendAll();
    return { bpm: node.tempo };
  });
  route('POST', '/api/link/beat', async ({ body }) => {
    const beat = Number(body?.beat), at = Number(body?.at) || clock(), q = Number(body?.quantum) || cfg().quantum;
    if (!Number.isFinite(beat)) throw bad('beat required');
    if (body.force) node.forceBeatAtTime(beat, at, q); else node.requestBeatAtTime(beat, at, q);
    sendAll();
    return { beat: node.beatAtTime(clock(), q) };
  });
  route('POST', '/api/link/playing', async ({ body }) => { node.setIsPlaying(!!body?.playing, Number(body?.at) || clock()); sendAll(); return { playing: node.isPlaying }; });
  route('GET', '/api/link/time', () => ({ host: clock() }));
  route('GET', '/api/link/stream', ({ req, res }) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(frame());
    streams.add(res);
    syncStreamTimer();
    req.on('close', () => { streams.delete(res); syncStreamTimer(); });
    return undefined;
  });

  if (cfg().enabled) setEnabled(true).catch((e) => log?.warn?.(`[link] ${e.message}`));

  return {
    node, status,
    async close() { clearInterval(streamT); for (const r of streams) r.end(); streams.clear(); await node.disable().catch(() => {}); },
  };
}
