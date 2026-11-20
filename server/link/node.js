// A Link peer: discovery, session membership, clock-offset measurement and the shared tempo / beat / phase timeline.
// Transport-agnostic: give it a UdpTransport (real LAN) or a MemoryNetwork transport (tests).
//
// Session rules (as described by the Link protocol):
// - every node starts as founder of its own session (session id = node id, ghost time 0 at founding);
// - on seeing a peer of another session, measure the clock offset to that peer (ping/pong); if that session's ghost
//   time is ahead of ours by more than 500 ms (= it is older) — or equal within 500 ms and its id is smaller — join it;
// - within a session the timeline with the larger beatOrigin wins; start/stop state with the newer timestamp wins;
// - the current session is re-measured every 30 s to follow clock drift.
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import {
  MSG, MEASURE, encodeDiscovery, decodeDiscovery, encodePing, encodePong, decodeMeasurement, randomNodeId, MAX_MESSAGE,
} from './protocol.js';
import {
  quantizeBpm, toBeats, fromBeats, phase, toPhaseEncodedBeats, fromPhaseEncodedBeats, closestPhaseMatch,
  updateClientFromSession, updateSessionFromClient, median,
} from './timeline.js';

/** Host clock in µs (monotonic, epoch-anchored so the browser can map it to performance.timeOrigin). */
export const hostMicros = () => (performance.timeOrigin + performance.now()) * 1000;

export const SESSION_EPS = 500000; // µs
const PING_TIMEOUT = 50, MAX_PING_TRIES = 5, DATA_POINTS = 100, REMEASURE_MS = 30000;

export class LinkNode extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.transport      { start(onMessage), stop(), endpoints(), sendMulticast(build), send(buf, to) }
   * @param {() => number} [o.clock]  host time in µs
   * @param {number} [o.bpm]
   * @param {number} [o.ttl]          seconds peers keep us without news
   * @param {number} [o.broadcastMs]  alive interval
   * @param {boolean} [o.startStopSync]
   */
  constructor({ transport, clock = hostMicros, bpm = 120, ttl = 5, broadcastMs = 250, startStopSync = false, nodeId, timers = globalThis } = {}) {
    super();
    this.transport = transport; this.clock = clock; this.ttl = ttl; this.broadcastMs = broadcastMs;
    this.startStopSync = startStopSync; this.timers = timers;
    this.nodeId = nodeId || randomNodeId();
    this.enabled = false;
    this.peers = new Map();        // nodeId -> { sessionId, timeline, startStop, endpoint, from, expires }
    this.otherSessions = new Map(); // sessionId -> { timeline, intercept, measuring, lastTry }
    this.measurements = new Map(); // "addr:port" -> pending measurement
    this._resetSession(quantizeBpm(bpm));
  }

  // ------------------------------------------------------------------ clocks
  hostToGhost(h) { return h + this.intercept; }
  ghostToHost(g) { return g - this.intercept; }

  _resetSession(bpm) {
    const now = this.clock();
    this.sessionId = this.nodeId;
    this.intercept = -Math.round(now); // ghost time starts at 0 when we found our session
    this.session = { bpm, beatOrigin: 0, timeOrigin: 0 };
    this.client = { bpm, beatOrigin: 0, timeOrigin: this.ghostToHost(0) };
    this.startStop = { isPlaying: false, beats: 0, timestamp: 0 };
  }

  // ------------------------------------------------------------------ lifecycle
  async enable() {
    if (this.enabled) return;
    this.enabled = true;
    // a fresh session each time Link is switched on, at the current tempo
    this._resetSession(this.session.bpm);
    this.peers.clear(); this.otherSessions.clear();
    await this.transport.start((buf, from) => this._onMessage(buf, from));
    this._broadcast();
    this._aliveT = this.timers.setInterval(() => { this._prune(); this._broadcast(); }, this.broadcastMs);
    this._remeasureT = this.timers.setInterval(() => this._remeasure(), REMEASURE_MS);
    this._aliveT.unref?.(); this._remeasureT.unref?.();
    this.emit('change', 'enabled');
  }

  async disable() {
    if (!this.enabled) return;
    try { this.transport.sendMulticast(() => encodeDiscovery({ type: MSG.BYEBYE, ttl: 0, nodeId: this.nodeId })); } catch { /* best effort */ }
    this.enabled = false;
    this.timers.clearInterval(this._aliveT); this.timers.clearInterval(this._remeasureT);
    for (const m of this.measurements.values()) m.finish(null);
    this.measurements.clear();
    await this.transport.stop();
    const had = this.numPeers();
    this.peers.clear(); this.otherSessions.clear();
    if (had) this.emit('change', 'peers');
    this.emit('change', 'enabled');
  }

  // ------------------------------------------------------------------ public timeline API
  numPeers() { let n = 0; for (const p of this.peers.values()) if (p.sessionId === this.sessionId) n++; return n; }
  get tempo() { return this.client.bpm; }
  beatAtTime(host, quantum = 4) { return toPhaseEncodedBeats(this.client, host, quantum); }
  phaseAtTime(host, quantum = 4) { return phase(this.beatAtTime(host, quantum), quantum); }
  timeAtBeat(beat, quantum = 4) { return fromPhaseEncodedBeats(this.client, beat, quantum); }

  /** Propose a new session tempo, effective at host time `at`. */
  setTempo(bpm, at = this.clock()) {
    bpm = quantizeBpm(bpm);
    if (Math.abs(bpm - this.client.bpm) < 1e-9) return false;
    const atBeat = toBeats(this.client, at);
    const temp = { bpm, beatOrigin: atBeat, timeOrigin: at };
    // keep the client beatOrigin; move timeOrigin so the beat at `at` stays continuous
    this.client = { bpm, beatOrigin: this.client.beatOrigin, timeOrigin: fromBeats(temp, this.client.beatOrigin) };
    this._commit(at);
    this.emit('change', 'tempo');
    return true;
  }

  /**
   * Ask for `beat` to fall on host time `at`. With other peers this only remaps our own beat numbers (phase is kept, as
   * it belongs to the session); alone it moves the session grid (forceBeatAtTime).
   */
  requestBeatAtTime(beat, at = this.clock(), quantum = 4) {
    if (this.numPeers() === 0) return this.forceBeatAtTime(beat, at, quantum);
    const cur = this.beatAtTime(at, quantum);
    const target = closestPhaseMatch(beat, cur, quantum);
    this.client = { ...this.client, beatOrigin: this.client.beatOrigin + (target - cur) };
    this.emit('change', 'beat');
    return true;
  }

  /** Move the session's grid so `beat` happens at `at` for everybody (use sparingly: it shifts other peers' phase). */
  forceBeatAtTime(beat, at = this.clock(), quantum = 4) {
    const sessBeat = toBeats(this.client, at) - this.client.beatOrigin;
    const newSess = closestPhaseMatch(sessBeat, beat, quantum);
    const timeOrigin = at - (newSess * 60e6) / this.client.bpm; // host time of (new) session beat 0
    this.client = { bpm: this.client.bpm, beatOrigin: beat - newSess, timeOrigin };
    this._commit(at);
    this.emit('change', 'beat');
    return true;
  }

  setIsPlaying(isPlaying, at = this.clock()) {
    this.startStop = { isPlaying: !!isPlaying, beats: toBeats(this.session, this.hostToGhost(at)), timestamp: Math.round(this.hostToGhost(at)) };
    if (this.enabled) this._broadcast();
    this.emit('change', 'playing');
  }
  get isPlaying() { return this.startStop.isPlaying; }

  snapshot(quantum = 4, at = this.clock()) {
    const beat = this.beatAtTime(at, quantum);
    return {
      enabled: this.enabled, peers: this.numPeers(), bpm: this.client.bpm, beat, phase: phase(beat, quantum), quantum,
      host: at, playing: this.startStop.isPlaying, startStopSync: this.startStopSync, sessionId: this.sessionId, nodeId: this.nodeId,
    };
  }

  // ------------------------------------------------------------------ internals
  _commit(at) {
    const next = updateSessionFromClient(this.session, this.client, at, (h) => this.hostToGhost(h));
    if (next !== this.session) { this.session = next; if (this.enabled) this._broadcast(); }
  }

  _state() { return { sessionId: this.sessionId, timeline: this.session, startStop: this.startStop }; }

  _broadcast() {
    if (!this.enabled) return;
    const state = this._state();
    try { this.transport.sendMulticast((endpoint) => encodeDiscovery({ type: MSG.ALIVE, ttl: this.ttl, nodeId: this.nodeId, state, endpoint })); }
    catch (e) { this.emit('error', e); }
  }

  _prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) if (p.expires < now) { this.peers.delete(id); changed = true; }
    if (changed) this.emit('change', 'peers');
  }

  _onMessage(buf, from) {
    if (!this.enabled || !Buffer.isBuffer(buf) || buf.length < 9) return;
    if (buf[1] === 0x61) { const m = decodeDiscovery(buf); if (m) this._onDiscovery(m, from); return; } // '_a'sdp
    const mm = decodeMeasurement(buf);
    if (!mm) return;
    if (mm.type === MEASURE.PING) this._onPing(mm, from);
    else this._onPong(mm, from);
  }

  _onDiscovery(m, from) {
    if (m.nodeId === this.nodeId || m.groupId !== 0) return; // our own multicast echo
    if (m.type === MSG.BYEBYE) {
      if (this.peers.delete(m.nodeId)) this.emit('change', 'peers');
      return;
    }
    if (!m.timeline || !m.sessionId) return;
    const before = this.numPeers();
    const isNew = !this.peers.has(m.nodeId);
    this.peers.set(m.nodeId, {
      sessionId: m.sessionId, timeline: m.timeline, startStop: m.startStop || null, endpoint: m.endpoint || null, from,
      expires: Date.now() + Math.max(1, m.ttl) * 1000,
    });
    // answer a new peer's alive directly so it learns about us without waiting for our next broadcast
    if (isNew && m.type === MSG.ALIVE && from?.address) {
      try {
        const endpoint = this.transport.endpointFor?.(from) || null;
        this.transport.send(encodeDiscovery({ type: MSG.RESPONSE, ttl: this.ttl, nodeId: this.nodeId, state: this._state(), endpoint }), from);
      } catch { /* best effort */ }
    }
    if (m.sessionId === this.sessionId) this._sawSessionState(m);
    else this._sawOtherSession(m.sessionId, m);
    if (this.numPeers() !== before) this.emit('change', 'peers');
  }

  _sawSessionState(m) {
    if (m.timeline.beatOrigin > this.session.beatOrigin) {
      const prevBpm = this.client.bpm;
      this.session = { ...m.timeline };
      this.client = updateClientFromSession(this.client, this.session, this.clock(), (g) => this.ghostToHost(g));
      this.emit('change', Math.abs(prevBpm - this.client.bpm) > 1e-9 ? 'tempo' : 'beat');
    }
    if (this.startStopSync && m.startStop && m.startStop.timestamp > this.startStop.timestamp) {
      const was = this.startStop.isPlaying;
      this.startStop = { ...m.startStop };
      if (was !== this.startStop.isPlaying) this.emit('change', 'playing');
    }
  }

  _sawOtherSession(sessionId, m) {
    let s = this.otherSessions.get(sessionId);
    if (!s) { s = { timeline: m.timeline, intercept: null, measuring: false, lastTry: 0 }; this.otherSessions.set(sessionId, s); }
    if (!s.timeline || m.timeline.beatOrigin > s.timeline.beatOrigin) s.timeline = m.timeline;
    if (s.measuring || !m.endpoint) return;
    const now = Date.now();
    if (s.lastTry && now - s.lastTry < (s.intercept == null ? 5000 : REMEASURE_MS)) return;
    s.measuring = true; s.lastTry = now;
    this._measure(m.endpoint, sessionId).then((intercept) => {
      s.measuring = false;
      if (intercept == null || !this.enabled) return;
      s.intercept = intercept;
      if (sessionId === this.sessionId) return; // joined meanwhile
      const ghostDiff = intercept - this.intercept;
      if (ghostDiff > SESSION_EPS || (Math.abs(ghostDiff) < SESSION_EPS && sessionId < this.sessionId)) this._join(sessionId, s);
    });
  }

  _join(sessionId, s) {
    const prevBpm = this.client.bpm;
    this.otherSessions.delete(sessionId);
    this.sessionId = sessionId;
    this.intercept = s.intercept;
    // the freshest timeline anybody of that session has told us about
    let tl = s.timeline;
    for (const p of this.peers.values()) if (p.sessionId === sessionId && p.timeline.beatOrigin > tl.beatOrigin) tl = p.timeline;
    this.session = { ...tl };
    this.client = updateClientFromSession(this.client, this.session, this.clock(), (g) => this.ghostToHost(g));
    let ss = null;
    for (const p of this.peers.values()) if (p.sessionId === sessionId && p.startStop && (!ss || p.startStop.timestamp > ss.timestamp)) ss = p.startStop;
    if (this.startStopSync && ss) this.startStop = { ...ss };
    this._broadcast();
    this.emit('change', 'session');
    if (Math.abs(prevBpm - this.client.bpm) > 1e-9) this.emit('change', 'tempo');
    this.emit('change', 'peers');
  }

  _remeasure() {
    if (!this.enabled) return;
    const peer = [...this.peers.values()].find((p) => p.sessionId === this.sessionId && p.endpoint);
    if (!peer) return;
    const sid = this.sessionId;
    this._measure(peer.endpoint, sid).then((intercept) => {
      if (intercept == null || sid !== this.sessionId || !this.enabled) return;
      this.intercept = intercept;
      this.client = updateClientFromSession(this.client, this.session, this.clock(), (g) => this.ghostToHost(g));
    });
  }

  /** Ping/pong clock-offset measurement against a peer endpoint → ghost-time intercept (µs) or null. */
  _measure(endpoint, sessionId) {
    const key = `${endpoint.address}:${endpoint.port}`;
    if (this.measurements.has(key)) return this.measurements.get(key).promise;
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const m = { sessionId, data: [], tries: 0, timer: null, promise, endpoint };
    const send = (prevGhost) => {
      this.timers.clearTimeout(m.timer);
      try { this.transport.send(encodePing(Math.round(this.clock()), prevGhost), endpoint); } catch { /* retried by timer */ }
      m.timer = this.timers.setTimeout(() => { if (++m.tries >= MAX_PING_TRIES) m.finish(null); else send(); }, PING_TIMEOUT);
      m.timer.unref?.();
    };
    m.finish = (v) => {
      if (m.done) return; m.done = true;
      this.timers.clearTimeout(m.timer); this.measurements.delete(key);
      resolve(v);
    };
    m.onPong = (p) => {
      if (p.sessionId !== m.sessionId) return m.finish(null); // the peer switched sessions meanwhile
      const now = this.clock();
      if (p.ghostTime && p.hostTime) {
        m.data.push(p.ghostTime - (now + p.hostTime) / 2);
        if (p.prevGhostTime) m.data.push((p.ghostTime + p.prevGhostTime) / 2 - p.hostTime);
      }
      if (m.data.length > DATA_POINTS) m.finish(Math.round(median(m.data)));
      else { m.tries = 0; send(p.ghostTime); }
    };
    this.measurements.set(key, m);
    send();
    return promise;
  }

  _onPing(mm, from) {
    if (!from?.address || mm.payload.length > 64) return;
    const pong = encodePong(this.sessionId, Math.round(this.hostToGhost(this.clock())), mm.payload);
    if (pong.length <= MAX_MESSAGE) { try { this.transport.send(pong, from); } catch { /* ignore */ } }
  }

  _onPong(mm, from) {
    const m = this.measurements.get(`${from?.address}:${from?.port}`);
    if (m) m.onPong(mm);
  }
}
