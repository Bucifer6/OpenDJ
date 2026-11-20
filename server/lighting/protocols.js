// Packet encoders for Art-Net, sACN (E1.31), OSC and WLED realtime UDP. Pure functions, byte-exact.

// ---------------------------------------------------------------- Art-Net 4: ArtDmx (OpCode 0x5000)
export const ARTNET_PORT = 6454;
const ARTNET_ID = Buffer.from('Art-Net\0', 'ascii');

/** portAddress = net(7 bits) << 8 | subnet(4) << 4 | universe(4). sequence 1..255 (0 = disabled). */
export function encodeArtDmx(data, { portAddress = 0, sequence = 0, physical = 0 } = {}) {
  let len = Math.min(512, Math.max(2, data.length));
  if (len % 2) len++; // spec: even length 2..512
  const b = Buffer.alloc(18 + len);
  ARTNET_ID.copy(b, 0);
  b.writeUInt16LE(0x5000, 8); // OpCode, little endian
  b.writeUInt16BE(14, 10); // ProtVer hi/lo
  b[12] = sequence & 0xff;
  b[13] = physical & 0xff;
  b[14] = portAddress & 0xff; // SubUni
  b[15] = (portAddress >> 8) & 0x7f; // Net
  b.writeUInt16BE(len, 16); // Length hi/lo
  b.set(data.subarray(0, Math.min(len, data.length)), 18);
  return b;
}
export const artPortAddress = (net, subnet, universe) => ((net & 0x7f) << 8) | ((subnet & 0xf) << 4) | (universe & 0xf);
/** Art-Net sequence: 1..255 then wraps to 1 (0 means "sequencing disabled"). */
export const nextArtSeq = (s) => (s >= 255 ? 1 : s + 1);

// ---------------------------------------------------------------- sACN / ANSI E1.31-2018 data packet
export const SACN_PORT = 5568;
const ACN_ID = Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00]); // "ASC-E1.17\0\0\0"

export function sacnMulticastAddress(universe) { return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`; }

/** cid: 16-byte Buffer or 32-char hex string. sequence 0..255 wraps. */
export function encodeSacn(data, { universe = 1, sequence = 0, priority = 100, sourceName = 'OpenDJ', cid, options = 0 } = {}) {
  const slots = Math.min(512, data.length);
  const total = 126 + slots;
  const b = Buffer.alloc(total);
  // Root layer
  b.writeUInt16BE(0x0010, 0); // preamble size
  b.writeUInt16BE(0x0000, 2); // post-amble size
  ACN_ID.copy(b, 4);
  b.writeUInt16BE(0x7000 | (total - 16), 16);
  b.writeUInt32BE(0x00000004, 18); // VECTOR_ROOT_E131_DATA
  const cidBuf = Buffer.isBuffer(cid) ? cid : Buffer.from(String(cid || '').padEnd(32, '0').slice(0, 32), 'hex');
  cidBuf.copy(b, 22, 0, 16);
  // Framing layer
  b.writeUInt16BE(0x7000 | (total - 38), 38);
  b.writeUInt32BE(0x00000002, 40); // VECTOR_E131_DATA_PACKET
  b.write(String(sourceName).slice(0, 63), 44, 63, 'utf8'); // 64 bytes, null-terminated (rest stays 0)
  b[108] = priority & 0xff;
  b.writeUInt16BE(0, 109); // synchronization address
  b[111] = sequence & 0xff;
  b[112] = options & 0xff; // bit 7 preview, bit 6 stream terminated, bit 5 force sync
  b.writeUInt16BE(universe, 113);
  // DMP layer
  b.writeUInt16BE(0x7000 | (total - 115), 115);
  b[117] = 0x02; // VECTOR_DMP_SET_PROPERTY
  b[118] = 0xa1; // address type & data type
  b.writeUInt16BE(0x0000, 119); // first property address
  b.writeUInt16BE(0x0001, 121); // address increment
  b.writeUInt16BE(slots + 1, 123); // property value count (incl. start code)
  b[125] = 0x00; // DMX start code
  b.set(data.subarray(0, slots), 126);
  return b;
}
export const nextSacnSeq = (s) => (s + 1) & 0xff;

// ---------------------------------------------------------------- OSC 1.0
const oscString = (s) => {
  const raw = Buffer.from(String(s), 'utf8');
  const b = Buffer.alloc((Math.floor(raw.length / 4) + 1) * 4); // always at least one null, padded to 4
  raw.copy(b);
  return b;
};

/** args: numbers (integers -> 'i' unless wrapped {f: x}), {f}, {i}, strings, booleans. */
export function encodeOsc(address, args = []) {
  let tags = ',';
  const parts = [];
  for (const a of args) {
    if (typeof a === 'string') { tags += 's'; parts.push(oscString(a)); }
    else if (a === true || a === false) tags += a ? 'T' : 'F';
    else if (a && typeof a === 'object' && 'f' in a) { tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a.f); parts.push(b); }
    else if (a && typeof a === 'object' && 'i' in a) { tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a.i | 0); parts.push(b); }
    else if (Number.isInteger(a)) { tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a); parts.push(b); }
    else { tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(Number(a) || 0); parts.push(b); }
  }
  return Buffer.concat([oscString(address), oscString(tags), ...parts]);
}

/** Minimal decoder (used by tests and handy for debugging). */
export function decodeOsc(buf) {
  const str = (o) => { const end = buf.indexOf(0, o); return [buf.toString('utf8', o, end), (Math.floor((end - o) / 4) + 1) * 4 + o]; };
  let [address, o] = str(0);
  let tags; [tags, o] = str(o);
  const args = [];
  for (const t of tags.slice(1)) {
    if (t === 'i') { args.push(buf.readInt32BE(o)); o += 4; }
    else if (t === 'f') { args.push(buf.readFloatBE(o)); o += 4; }
    else if (t === 's') { let s; [s, o] = str(o); args.push(s); }
    else if (t === 'T' || t === 'F') args.push(t === 'T');
  }
  return { address, args };
}

// ---------------------------------------------------------------- WLED realtime UDP (port 21324)
export const WLED_PORT = 21324;
/**
 * pixels: Uint8Array of RGB triplets. Returns one or more packets:
 * DRGB (protocol 2) for up to 490 LEDs, otherwise DNRGB (protocol 4) chunks of 489 LEDs with a start index.
 * timeout: seconds WLED stays in realtime mode after the last packet (255 = until reboot).
 */
export function encodeWled(pixels, { timeout = 2 } = {}) {
  const count = Math.floor(pixels.length / 3);
  if (count <= 490) {
    const b = Buffer.alloc(2 + count * 3);
    b[0] = 2; b[1] = timeout & 0xff;
    b.set(pixels.subarray(0, count * 3), 2);
    return [b];
  }
  const out = [];
  for (let start = 0; start < count; start += 489) {
    const n = Math.min(489, count - start);
    const b = Buffer.alloc(4 + n * 3);
    b[0] = 4; b[1] = timeout & 0xff; b.writeUInt16BE(start, 2);
    b.set(pixels.subarray(start * 3, (start + n) * 3), 4);
    out.push(b);
  }
  return out;
}
