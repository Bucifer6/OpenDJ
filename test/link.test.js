import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkNode, MemoryNetwork, UdpTransport, hostMicros, registerLinkRoutes, protocol as P, timeline as T } from '../server/link/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} ≈ ${b} (±${eps})`);
/** phase difference wrapped to [-q/2, q/2) */
const dPhase = (a, b, q = 4) => { let d = (a - b) % q; if (d >= q / 2) d -= q; if (d < -q / 2) d += q; return d; };
async function until(fn, ms = 3000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return fn(); }

// ------------------------------------------------------------------ wire format
test('discovery message byte layout (header, ttl, node id, entries big-endian)', () => {
  const nodeId = '4142434445464748'; // "ABCDEFGH"
  const buf = P.encodeDiscovery({
    type: P.MSG.ALIVE, ttl: 5, nodeId,
    state: { sessionId: nodeId, timeline: { bpm: 120, beatOrigin: 2.5, timeOrigin: 1000000 }, startStop: { isPlaying: true, beats: 4, timestamp: 777 } },
    endpoint: { address: '192.168.1.20', port: 54321 },
  });
  assert.equal(buf.subarray(0, 8).toString('latin1'), '_asdp_v\x01');
  assert.equal(buf[8], 1); assert.equal(buf[9], 5); assert.equal(buf.readUInt16BE(10), 0);
  assert.equal(buf.subarray(12, 20).toString('latin1'), 'ABCDEFGH');
  // first entry: 'tmln', 24 bytes, 500000 µs/beat (120 BPM), 2.5 beats = 2500000 micro-beats, time origin 1 s
  assert.equal(buf.subarray(20, 24).toString('latin1'), 'tmln');
  assert.equal(buf.readUInt32BE(24), 24);
  assert.equal(buf.readBigInt64BE(28), 500000n);
  assert.equal(buf.readBigInt64BE(36), 2500000n);
  assert.equal(buf.readBigInt64BE(44), 1000000n);
  assert.equal(buf.subarray(52, 56).toString('latin1'), 'sess');
  assert.equal(buf.readUInt32BE(56), 8);
  assert.equal(buf.subarray(60, 68).toString('latin1'), 'ABCDEFGH');
  assert.equal(buf.subarray(68, 72).toString('latin1'), 'stst');
  assert.equal(buf.readUInt32BE(72), 17);
  assert.equal(buf[76], 1);
  assert.equal(buf.subarray(93, 97).toString('latin1'), 'mep4');
  assert.equal(buf.readUInt32BE(97), 6);
  assert.deepEqual([...buf.subarray(101, 105)], [192, 168, 1, 20]);
  assert.equal(buf.readUInt16BE(105), 54321);
  assert.equal(buf.length, 107);
  assert.ok(buf.length <= P.MAX_MESSAGE);

  const m = P.decodeDiscovery(buf);
  assert.equal(m.type, P.MSG.ALIVE); assert.equal(m.ttl, 5); assert.equal(m.nodeId, nodeId); assert.equal(m.sessionId, nodeId);
  assert.deepEqual(m.timeline, { bpm: 120, beatOrigin: 2.5, timeOrigin: 1000000 });
  assert.deepEqual(m.startStop, { isPlaying: true, beats: 4, timestamp: 777 });
  assert.deepEqual(m.endpoint, { address: '192.168.1.20', port: 54321 });
});

test('decoder skips unknown entries, rejects foreign packets, byebye has no payload', () => {
  const base = P.encodeDiscovery({ type: P.MSG.ALIVE, nodeId: '0102030405060708', state: { sessionId: '0102030405060708', timeline: { bpm: 128, beatOrigin: 0, timeOrigin: 0 } } });
  const unknown = Buffer.alloc(8 + 5); unknown.write('aep4', 0, 'latin1'); unknown.writeUInt32BE(5, 4);
  const withUnknown = Buffer.concat([base.subarray(0, 20), unknown, base.subarray(20)]);
  const m = P.decodeDiscovery(withUnknown);
  near(m.timeline.bpm, 128, 0.001); assert.equal(m.sessionId, '0102030405060708');
  assert.equal(P.decodeDiscovery(Buffer.from('hello world, not link at all')), null);
  assert.equal(P.decodeDiscovery(Buffer.concat([Buffer.from('_asdp_v\x02', 'latin1'), Buffer.alloc(20)])), null); // other version
  const bye = P.encodeDiscovery({ type: P.MSG.BYEBYE, ttl: 0, nodeId: '0102030405060708' });
  assert.equal(bye.length, 20);
  assert.equal(P.decodeDiscovery(bye).type, P.MSG.BYEBYE);
  // truncated entry is ignored instead of throwing
  assert.equal(P.decodeDiscovery(base.subarray(0, 30)).timeline, undefined);
});

test('measurement ping/pong encoding echoes the ping payload', () => {
  const ping = P.encodePing(123456789, 987654321);
  assert.equal(ping.subarray(0, 8).toString('latin1'), '_link_v\x01');
  assert.equal(ping[8], P.MEASURE.PING);
  const pm = P.decodeMeasurement(ping);
  assert.equal(pm.hostTime, 123456789); assert.equal(pm.prevGhostTime, 987654321);
  const pong = P.decodeMeasurement(P.encodePong('aabbccddeeff0011', 555, pm.payload));
  assert.equal(pong.type, P.MEASURE.PONG); assert.equal(pong.sessionId, 'aabbccddeeff0011');
  assert.equal(pong.ghostTime, 555); assert.equal(pong.hostTime, 123456789); assert.equal(pong.prevGhostTime, 987654321);
});

// ------------------------------------------------------------------ timeline math
test('phase helpers handle negative beats and quantum wrap', () => {
  assert.equal(T.phase(5, 4), 1); assert.equal(T.phase(-1, 4), 3); assert.equal(T.phase(-4, 4), 0);
  assert.equal(T.nextPhaseMatch(5, 2, 4), 6); assert.equal(T.nextPhaseMatch(5, 1, 4), 5);
  assert.equal(T.closestPhaseMatch(5.2, 3, 4), 7); assert.equal(T.closestPhaseMatch(4.8, 3, 4), 3); assert.equal(T.closestPhaseMatch(5.2, 6.5, 4), 6.5);
  const client = { bpm: 120, beatOrigin: 10.3, timeOrigin: 0 }; // session beat 0 at host 0, client counts from 10.3
  const b = T.toPhaseEncodedBeats(client, 1e6, 4); // 2 session beats later
  near(T.phase(b, 4), 2, 1e-9, 'phase follows session grid'); near(b, 12.3, 2, 'close to the client beat');
  near(T.fromPhaseEncodedBeats(client, b, 4), 1e6, 1e-3);
});

test('client tempo change keeps beat continuity and raises the session beatOrigin', () => {
  const session = { bpm: 120, beatOrigin: 0, timeOrigin: 0 };
  const ghost = (h) => h + 500; // intercept 500 µs
  let client = T.updateClientFromSession({ bpm: 120, beatOrigin: 0, timeOrigin: 0 }, session, 0, (g) => g - 500);
  const at = 10e6; // 10 s → 20 beats
  const before = T.toBeats(T.updateClientFromSession(client, session, at, (g) => g - 500), at);
  const temp = { bpm: 130, beatOrigin: T.toBeats(client, at), timeOrigin: at };
  client = { bpm: 130, beatOrigin: client.beatOrigin, timeOrigin: T.fromBeats(temp, client.beatOrigin) };
  const next = T.updateSessionFromClient(session, client, at, ghost);
  assert.ok(next.beatOrigin > session.beatOrigin);
  near(next.bpm, 130, 1e-9);
  near(T.toBeats(next, ghost(at)), T.toBeats(session, ghost(at)), 1e-4, 'session beat continuous at the change');
  near(T.toBeats(client, at), before, 1e-6);
  assert.equal(T.updateSessionFromClient(next, client, at, ghost), next, 'no change → same timeline');
});

// ------------------------------------------------------------------ two (three) nodes in-process
function pair({ latencyMs = 3, jitterMs = 4, loss = 0 } = {}) {
  const net = new MemoryNetwork({ latencyMs, jitterMs, loss });
  const offA = 0, offB = -7_654_321_000; // B's host clock is ~2 h behind A's
  const a = new LinkNode({ transport: net.transport(), clock: () => hostMicros() + offA, bpm: 124, broadcastMs: 100 });
  const b = new LinkNode({ transport: net.transport(), clock: () => hostMicros() + offB, bpm: 95, broadcastMs: 100 });
  return { net, a, b, offA, offB };
}

test('two Link nodes discover each other, join one session and agree on tempo and phase', async () => {
  const { a, b, offB } = pair();
  await a.enable();
  await sleep(700); // a's session is clearly older (> 500 ms)
  await b.enable();
  assert.ok(await until(() => a.numPeers() === 1 && b.numPeers() === 1 && a.sessionId === b.sessionId), 'peers + session');
  assert.equal(b.sessionId, a.nodeId, 'the younger node joins the older session');
  near(b.tempo, 124, 1e-3, 'joiner adopts the session tempo');
  for (let i = 0; i < 5; i++) {
    const t = hostMicros();
    const pa = a.phaseAtTime(t, 4), pb = b.phaseAtTime(t + offB, 4);
    near(dPhase(pa, pb), 0, 0.01, 'phase (beats)'); // 0.01 beat = 5 ms at 124 BPM
    near(a.timeAtBeat(Math.ceil(a.beatAtTime(t)) + 4) - t, b.timeAtBeat(Math.ceil(b.beatAtTime(t + offB)) + 4) - (t + offB), 10000, 'next downbeat time (µs)');
    await sleep(30);
  }
  // tempo changes propagate both ways
  b.setTempo(132.5);
  assert.ok(await until(() => Math.abs(a.tempo - 132.5) < 1e-3), 'b → a tempo');
  a.setTempo(100);
  assert.ok(await until(() => Math.abs(b.tempo - 100) < 1e-3), 'a → b tempo');
  await sleep(50);
  const t = hostMicros();
  near(dPhase(a.phaseAtTime(t), b.phaseAtTime(t + offB)), 0, 0.01, 'phase after tempo changes');
  // forcing the grid on one peer moves everybody
  a.forceBeatAtTime(0, hostMicros(), 4);
  assert.ok(await until(() => Math.abs(dPhase(a.phaseAtTime(hostMicros()), b.phaseAtTime(hostMicros() + offB))) < 0.01));
  near(a.phaseAtTime(hostMicros()), 0, 0.2, 'beat 0 is now');
  // start/stop sync
  a.startStopSync = b.startStopSync = true;
  a.setIsPlaying(true);
  assert.ok(await until(() => b.isPlaying === true), 'start/stop state shared');
  await a.disable();
  assert.ok(await until(() => b.numPeers() === 0), 'byebye removes the peer');
  await b.disable();
});

test('clock-offset measurement is accurate despite latency jitter and packet loss', async () => {
  const { a, b, offB } = pair({ latencyMs: 2, jitterMs: 6, loss: 0.1 });
  await a.enable(); await sleep(600); await b.enable();
  assert.ok(await until(() => b.sessionId === a.sessionId, 5000));
  // ghost(host) must agree: a.hostToGhost(tA) ≈ b.hostToGhost(tB) for the same instant
  const t = hostMicros();
  near(a.hostToGhost(t + 0), b.hostToGhost(t + offB), 3000, 'ghost time (µs)');
  await a.disable(); await b.disable();
});

test('a third node joins; requestBeatAtTime with peers keeps the shared phase', async () => {
  const net = new MemoryNetwork({ latencyMs: 1 });
  const nodes = [0, 1, 2].map((i) => new LinkNode({ transport: net.transport(), clock: () => hostMicros() + i * 1e9, bpm: 100 + i * 10, broadcastMs: 100 }));
  await nodes[0].enable(); await sleep(600);
  await nodes[1].enable(); await nodes[2].enable();
  assert.ok(await until(() => nodes.every((n) => n.numPeers() === 2 && n.sessionId === nodes[0].sessionId), 4000));
  for (const n of nodes) near(n.tempo, 100, 1e-3);
  const t = hostMicros();
  const ph = nodes.map((n, i) => n.phaseAtTime(t + i * 1e9));
  near(dPhase(ph[0], ph[1]), 0, 0.01); near(dPhase(ph[0], ph[2]), 0, 0.01);
  // requesting a beat with peers renumbers locally but never changes the phase
  nodes[1].requestBeatAtTime(17.25, t + 1e9, 4);
  near(nodes[1].phaseAtTime(t + 1e9), ph[1], 1e-6);
  near(nodes[1].beatAtTime(t + 1e9), 17.25, 2.01);
  for (const n of nodes) await n.disable();
});

test('alone, requestBeatAtTime moves the grid exactly', async () => {
  const net = new MemoryNetwork();
  const n = new LinkNode({ transport: net.transport(), bpm: 120 });
  await n.enable();
  const t = hostMicros() + 1e6;
  n.requestBeatAtTime(8, t, 4);
  near(n.beatAtTime(t, 4), 8, 1e-6);
  near(n.timeAtBeat(9, 4), t + 500000, 1);
  await n.disable();
});

// ------------------------------------------------------------------ real sockets (loopback multicast)
test('two nodes over real UDP multicast on loopback', async (t) => {
  const port = 21000 + Math.floor(Math.random() * 2000); // not 20808: never join a real Link session on this machine
  const mk = (bpm, off) => new LinkNode({ transport: new UdpTransport({ interfaces: ['127.0.0.1'], port }), clock: () => hostMicros() + off, bpm, broadcastMs: 100 });
  const a = mk(126, 0), b = mk(90, 5e9);
  try { await a.enable(); } catch (e) { t.skip(`UDP multicast unavailable: ${e.message}`); return; }
  await sleep(600);
  await b.enable();
  const ok = await until(() => a.numPeers() === 1 && b.sessionId === a.sessionId, 4000);
  if (!ok && !a.numPeers()) { await a.disable(); await b.disable(); t.skip('no multicast delivery on loopback here'); return; }
  assert.ok(ok);
  near(b.tempo, 126, 1e-3);
  const now = hostMicros();
  near(dPhase(a.phaseAtTime(now), b.phaseAtTime(now + 5e9)), 0, 0.01);
  await a.disable(); await b.disable();
});

// ------------------------------------------------------------------ HTTP routes
test('link routes: enable, propose tempo, beat, stream, settings persistence', async () => {
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });
  const call = (method, pattern, body = {}) => routes.find((r) => r.method === method && r.pattern === pattern).handler({ body, params: {}, query: new URLSearchParams() });
  const events = [];
  const settings = { link: { quantum: 4 } };
  const library = { settings, updateSettings(p) { Object.assign(settings, p); return settings; } };
  const net = new MemoryNetwork();
  const peer = new LinkNode({ transport: net.transport(), bpm: 140, broadcastMs: 100 });
  await peer.enable(); await sleep(600);
  const api = registerLinkRoutes({ route, library, emit: (type, p) => events.push([type, p]), transport: net.transport(), log: null });
  assert.equal((await call('GET', '/api/link')).enabled, false);
  const s = await call('PUT', '/api/link', { enabled: true, quantum: 8 });
  assert.equal(s.enabled, true); assert.equal(s.quantum, 8);
  assert.deepEqual(settings.link, { enabled: true, quantum: 8, startStopSync: false });
  assert.ok(await until(() => api.node.numPeers() === 1));
  near((await call('GET', '/api/link')).bpm, 140, 1e-3, 'adopted the peer session tempo');
  await call('POST', '/api/link/tempo', { bpm: 128 });
  assert.ok(await until(() => Math.abs(peer.tempo - 128) < 1e-3), 'proposal reaches the peer');
  await assert.rejects(call('POST', '/api/link/tempo', { bpm: 5 }), /Tempo/);
  const time = await call('GET', '/api/link/time');
  near(time.host, hostMicros(), 50000);
  // stream: SSE frames with the state
  const chunks = [];
  let closeCb;
  const res = { writeHead() {}, write: (c) => chunks.push(c), end() {} };
  const req = { on: (ev, cb) => { if (ev === 'close') closeCb = cb; } };
  routes.find((r) => r.pattern === '/api/link/stream').handler({ req, res });
  await sleep(160);
  closeCb();
  assert.ok(chunks.length >= 2, `stream frames: ${chunks.length}`);
  const st = JSON.parse(chunks.at(-1).split('data: ')[1]);
  assert.equal(st.peers, 1); near(st.bpm, 128, 1e-3); assert.ok(st.host > 0 && Number.isFinite(st.beat));
  await sleep(250);
  assert.ok(events.some(([type, p]) => type === 'link' && p.peers === 1), 'link status pushed on the event stream');
  await call('PUT', '/api/link', { enabled: false });
  assert.equal(api.node.enabled, false);
  await api.close(); await peer.disable();
});
