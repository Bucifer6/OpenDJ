import { randomBytes } from 'node:crypto';
// Ableton Link wire format (clean-room implementation from public protocol descriptions; no Link source code used).
//
// Discovery ("_asdp_v" + version 1), UDP multicast 224.76.78.75:20808, all integers big-endian:
//   [0..7]   protocol header  '_asdp_v' 0x01
//   [8]      message type      1 = alive, 2 = response, 3 = byebye
//   [9]      ttl (seconds)     how long the receiver may keep this peer without hearing from it again
//   [10..11] group id          always 0
//   [12..19] node id           8 bytes, random per node
//   [20..]   payload           entries: uint32 key (four-char code), uint32 size, <size> bytes value
//
// Measurement ("_link_v" + version 1), UDP unicast to a peer's advertised measurement endpoint:
//   [0..7]   protocol header  '_link_v' 0x01
//   [8]      message type      1 = ping, 2 = pong
//   [9..]    payload           same entry encoding
//
// Payload entries used:
//   'tmln'  Timeline            int64 micros per beat, int64 beat origin (micro-beats), int64 time origin (ghost µs)
//   'sess'  SessionMembership   8-byte session id (node id of the session's founder)
//   'stst'  StartStopState      uint8 isPlaying, int64 beats (micro-beats), int64 timestamp (ghost µs)
//   'mep4'  MeasurementEndpointV4  uint32 IPv4 address, uint16 port
//   'mep6'  MeasurementEndpointV6  16-byte IPv6 address, uint16 port (parsed, not advertised)
//   '__ht'  HostTime            int64 µs (ping send time on the initiator's host clock)
//   '__gt'  GHostTime           int64 µs (responder's ghost time when answering)
//   '_pgt'  PrevGHostTime       int64 µs (ghost time from the previous pong, echoed by the initiator)
// Unknown entries are skipped by size, so newer peers (e.g. Link Audio entries) stay compatible.

export const MULTICAST_ADDR = '224.76.78.75';
export const MULTICAST_PORT = 20808;
export const MAX_MESSAGE = 512;

export const DISCOVERY_HEADER = Buffer.from([0x5f, 0x61, 0x73, 0x64, 0x70, 0x5f, 0x76, 0x01]); // _asdp_v\x01
export const MEASURE_HEADER = Buffer.from([0x5f, 0x6c, 0x69, 0x6e, 0x6b, 0x5f, 0x76, 0x01]); // _link_v\x01
export const MSG = { ALIVE: 1, RESPONSE: 2, BYEBYE: 3 };
export const MEASURE = { PING: 1, PONG: 2 };

const fourcc = (s) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
export const KEY = {
  timeline: fourcc('tmln'), session: fourcc('sess'), startStop: fourcc('stst'),
  mep4: fourcc('mep4'), mep6: fourcc('mep6'),
  hostTime: fourcc('__ht'), ghostTime: fourcc('__gt'), prevGhostTime: fourcc('_pgt'),
};

const i64 = (v) => BigInt(Math.round(Number(v) || 0));
const toNum = (b) => Number(b);

/** One payload entry: key, value buffer. */
function entry(key, value) {
  const h = Buffer.alloc(8);
  h.writeUInt32BE(key, 0); h.writeUInt32BE(value.length, 4);
  return Buffer.concat([h, value]);
}

export function encodeTimeline({ bpm, beatOrigin, timeOrigin }) {
  const b = Buffer.alloc(24);
  b.writeBigInt64BE(i64(60e6 / bpm), 0);
  b.writeBigInt64BE(i64(beatOrigin * 1e6), 8);
  b.writeBigInt64BE(i64(timeOrigin), 16);
  return entry(KEY.timeline, b);
}
export function encodeSession(idHex) { return entry(KEY.session, Buffer.from(idHex, 'hex')); }
export function encodeStartStop({ isPlaying, beats, timestamp }) {
  const b = Buffer.alloc(17);
  b.writeUInt8(isPlaying ? 1 : 0, 0);
  b.writeBigInt64BE(i64(beats * 1e6), 1);
  b.writeBigInt64BE(i64(timestamp), 9);
  return entry(KEY.startStop, b);
}
export function encodeEndpoint4({ address, port }) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) return Buffer.alloc(0);
  const b = Buffer.alloc(6);
  b.writeUInt8(parts[0], 0); b.writeUInt8(parts[1], 1); b.writeUInt8(parts[2], 2); b.writeUInt8(parts[3], 3);
  b.writeUInt16BE(port, 4);
  return entry(KEY.mep4, b);
}
export function encodeTime(key, micros) { const b = Buffer.alloc(8); b.writeBigInt64BE(i64(micros), 0); return entry(key, b); }

/** Parse payload entries. Returns a plain object with the known fields; ignores unknown / truncated ones. */
export function decodePayload(buf, start = 0) {
  const out = {};
  let o = start;
  while (o + 8 <= buf.length) {
    const key = buf.readUInt32BE(o), size = buf.readUInt32BE(o + 4);
    o += 8;
    if (o + size > buf.length) break; // truncated
    const v = buf.subarray(o, o + size);
    o += size;
    try {
      switch (key) {
        case KEY.timeline:
          if (size >= 24) {
            const mpb = toNum(v.readBigInt64BE(0));
            if (mpb > 0) out.timeline = { bpm: 60e6 / mpb, beatOrigin: toNum(v.readBigInt64BE(8)) / 1e6, timeOrigin: toNum(v.readBigInt64BE(16)) };
          }
          break;
        case KEY.session: if (size === 8) out.sessionId = v.toString('hex'); break;
        case KEY.startStop:
          if (size >= 17) out.startStop = { isPlaying: v.readUInt8(0) !== 0, beats: toNum(v.readBigInt64BE(1)) / 1e6, timestamp: toNum(v.readBigInt64BE(9)) };
          break;
        case KEY.mep4: if (size >= 6) out.endpoint = { address: `${v[0]}.${v[1]}.${v[2]}.${v[3]}`, port: v.readUInt16BE(4) }; break;
        case KEY.mep6:
          if (size >= 18) {
            const groups = []; for (let i = 0; i < 16; i += 2) groups.push(v.readUInt16BE(i).toString(16));
            out.endpoint6 = { address: groups.join(':'), port: v.readUInt16BE(16) };
          }
          break;
        case KEY.hostTime: if (size >= 8) out.hostTime = toNum(v.readBigInt64BE(0)); break;
        case KEY.ghostTime: if (size >= 8) out.ghostTime = toNum(v.readBigInt64BE(0)); break;
        case KEY.prevGhostTime: if (size >= 8) out.prevGhostTime = toNum(v.readBigInt64BE(0)); break;
        default: break;
      }
    } catch { /* malformed entry: skip */ }
  }
  return out;
}

/**
 * Discovery message.
 * @param {{type:number, ttl:number, nodeId:string, state?:{sessionId,timeline,startStop}, endpoint?:{address,port}}} m
 */
export function encodeDiscovery({ type, ttl = 5, nodeId, state, endpoint }) {
  const h = Buffer.alloc(12);
  h.writeUInt8(type, 0); h.writeUInt8(Math.max(0, Math.min(255, ttl | 0)), 1); h.writeUInt16BE(0, 2);
  Buffer.from(nodeId, 'hex').copy(h, 4, 0, 8);
  const parts = [DISCOVERY_HEADER, h];
  if (type !== MSG.BYEBYE && state) {
    parts.push(encodeTimeline(state.timeline), encodeSession(state.sessionId));
    if (state.startStop) parts.push(encodeStartStop(state.startStop));
    if (endpoint) parts.push(encodeEndpoint4(endpoint));
  }
  return Buffer.concat(parts);
}

/** → { type, ttl, groupId, nodeId, ...payload } or null if this is not a Link discovery message. */
export function decodeDiscovery(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20 || buf.length > 4096 || !buf.subarray(0, 8).equals(DISCOVERY_HEADER)) return null;
  const type = buf.readUInt8(8);
  if (type < 1 || type > 3) return null;
  return { type, ttl: buf.readUInt8(9), groupId: buf.readUInt16BE(10), nodeId: buf.subarray(12, 20).toString('hex'), ...decodePayload(buf, 20) };
}

/** Ping: HostTime (+ PrevGHostTime from the last pong). */
export function encodePing(hostTime, prevGhostTime) {
  const parts = [MEASURE_HEADER, Buffer.from([MEASURE.PING]), encodeTime(KEY.hostTime, hostTime)];
  if (prevGhostTime) parts.push(encodeTime(KEY.prevGhostTime, prevGhostTime));
  return Buffer.concat(parts);
}
/** Pong: SessionMembership + GHostTime, followed by the ping's payload echoed back verbatim. */
export function encodePong(sessionId, ghostTime, pingPayload) {
  return Buffer.concat([MEASURE_HEADER, Buffer.from([MEASURE.PONG]), encodeSession(sessionId), encodeTime(KEY.ghostTime, ghostTime), pingPayload || Buffer.alloc(0)]);
}
/** → { type, payload (raw Buffer after the type byte), ...decoded } or null. */
export function decodeMeasurement(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 9 || buf.length > MAX_MESSAGE || !buf.subarray(0, 8).equals(MEASURE_HEADER)) return null;
  const type = buf.readUInt8(8);
  if (type !== MEASURE.PING && type !== MEASURE.PONG) return null;
  const payload = buf.subarray(9);
  return { type, payload, ...decodePayload(buf, 9) };
}

/** 8 random bytes as hex. Link uses printable characters; any bytes are valid on the wire. */
export function randomNodeId(randomByte = () => randomBytes(1)[0]) {
  let s = '';
  for (let i = 0; i < 8; i++) s += (33 + (randomByte() % 94)).toString(16).padStart(2, '0');
  return s;
}
