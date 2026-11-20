// ANLZ reader / validator (DAT, EXT, 2EX), written from rekordbox_anlz.ksy and the Deep Symmetry analysis,
// independently of anlz-writer.js. Used by the tests and to sanity-check exports.

const MASK = Buffer.from('cbe1eefae5eeadeee9d2e9ebe1e9f3e8e9f4e1', 'hex');

function utf16be(buf) {
  const le = Buffer.from(buf);
  for (let i = 0; i + 1 < le.length; i += 2) { const x = le[i]; le[i] = le[i + 1]; le[i + 1] = x; }
  return le.toString('utf16le').replace(/\u0000+$/, '');
}

function cuePCPT(b, o) {
  if (b.toString('latin1', o, o + 4) !== 'PCPT') throw new Error(`PCPT magic missing at ${o}`);
  const lenEntry = b.readUInt32BE(o + 8);
  return {
    size: lenEntry,
    cue: {
      hotCue: b.readUInt32BE(o + 0x0c), status: b.readUInt32BE(o + 0x10), orderFirst: b.readUInt16BE(o + 0x18), orderLast: b.readUInt16BE(o + 0x1a),
      type: b[o + 0x1c], time: b.readUInt32BE(o + 0x20), loopTime: b.readUInt32BE(o + 0x24),
    },
  };
}

function cuePCP2(b, o) {
  if (b.toString('latin1', o, o + 4) !== 'PCP2') throw new Error(`PCP2 magic missing at ${o}`);
  const lenEntry = b.readUInt32BE(o + 8);
  const cue = {
    hotCue: b.readUInt32BE(o + 0x0c), type: b[o + 0x10], time: b.readUInt32BE(o + 0x14), loopTime: b.readUInt32BE(o + 0x18),
    colorId: b[o + 0x1c], loopNumerator: b.readUInt16BE(o + 0x24), loopDenominator: b.readUInt16BE(o + 0x26), comment: '',
  };
  if (lenEntry > 43) {
    const lc = b.readUInt32BE(o + 0x28);
    cue.comment = utf16be(b.subarray(o + 0x2c, o + 0x2c + lc));
    if (lenEntry - lc > 47) {
      const c = o + 0x2c + lc;
      cue.colorCode = b[c]; cue.rgb = [b[c + 1], b[c + 2], b[c + 3]];
    }
  }
  return { size: lenEntry, cue };
}

const TAGS = {
  PPTH: (b, h) => ({ path: utf16be(b.subarray(h, h + b.readUInt32BE(12))) }),
  PVBR: (b, h, end) => ({ index: Array.from({ length: Math.min(400, (end - h) / 4) }, (_, i) => b.readUInt32BE(h + i * 4)), tail: end - h >= 1604 ? b.readUInt32BE(h + 1600) : null }),
  PQTZ(b, h) {
    const n = b.readUInt32BE(20);
    if (b.readUInt32BE(16) !== 0x00080000) throw new Error('PQTZ constant 0x80000 missing');
    return { beats: Array.from({ length: n }, (_, i) => ({ beat: b.readUInt16BE(h + i * 8), tempo: b.readUInt16BE(h + i * 8 + 2), time: b.readUInt32BE(h + i * 8 + 4) })) };
  },
  PCOB(b, h) {
    const listType = b.readUInt32BE(12); const n = b.readUInt16BE(18);
    const cues = []; let o = h;
    for (let i = 0; i < n; i++) { const r = cuePCPT(b, o); cues.push(r.cue); o += r.size; }
    return { listType, memoryCount: b.readInt32BE(20), cues };
  },
  PCO2(b, h) {
    const listType = b.readUInt32BE(12); const n = b.readUInt16BE(16);
    const cues = []; let o = h;
    for (let i = 0; i < n; i++) { const r = cuePCP2(b, o); cues.push(r.cue); o += r.size; }
    return { listType, cues };
  },
  PWAV: (b, h) => ({ data: b.subarray(h, h + b.readUInt32BE(12)) }),
  PWV2: (b, h) => ({ data: b.subarray(h, h + b.readUInt32BE(12)) }),
  PWV3: (b, h) => ({ entryBytes: b.readUInt32BE(12), data: b.subarray(h, h + b.readUInt32BE(16) * b.readUInt32BE(12)), unknown: b.readUInt32BE(20) }),
  PWV4: (b, h) => ({ entryBytes: b.readUInt32BE(12), entries: b.readUInt32BE(16), data: b.subarray(h, h + b.readUInt32BE(16) * b.readUInt32BE(12)) }),
  PWV5(b, h) {
    const n = b.readUInt32BE(16);
    return { entryBytes: b.readUInt32BE(12), unknown: b.readUInt32BE(20), data: Uint16Array.from({ length: n }, (_, i) => b.readUInt16BE(h + 2 * i)) };
  },
  PWV6: (b, h) => ({ entryBytes: b.readUInt32BE(12), entries: b.readUInt32BE(16), data: b.subarray(h, h + 3 * b.readUInt32BE(16)) }),
  PWV7: (b, h) => ({ entryBytes: b.readUInt32BE(12), entries: b.readUInt32BE(16), data: b.subarray(h, h + 3 * b.readUInt32BE(16)) }),
  PWVC: (b, h, end) => ({ values: Array.from({ length: (end - h) / 2 }, (_, i) => b.readUInt16BE(h + 2 * i)) }),
  PSSI(b) {
    const entryBytes = b.readUInt32BE(12); const n = b.readUInt16BE(16);
    const body = Buffer.from(b.subarray(18));
    const rawMood = body.readUInt16BE(0);
    const masked = rawMood > 20;
    if (masked) for (let i = 0; i < body.length; i++) body[i] ^= (MASK[i % MASK.length] + n) & 0xff;
    const entries = Array.from({ length: n }, (_, i) => {
      const o = 14 + i * entryBytes;
      return { index: body.readUInt16BE(o), beat: body.readUInt16BE(o + 2), kind: body.readUInt16BE(o + 4), k1: body[o + 7], k2: body[o + 9], k3: body[o + 19], fill: body[o + 21], beatFill: body.readUInt16BE(o + 22) };
    });
    return { masked, mood: body.readUInt16BE(0), endBeat: body.readUInt16BE(8), bank: body[12], entries };
  },
};

/**
 * Parse an ANLZ file. Returns { lenHeader, lenFile, sections: [{ fourcc, lenHeader, lenTag, ...parsed }], byTag }.
 * Throws when lengths do not add up.
 */
export function readAnlz(buf) {
  if (buf.toString('latin1', 0, 4) !== 'PMAI') throw new Error('not an ANLZ file (PMAI missing)');
  const lenHeader = buf.readUInt32BE(4); const lenFile = buf.readUInt32BE(8);
  if (lenFile !== buf.length) throw new Error(`len_file ${lenFile} != actual ${buf.length}`);
  const sections = []; const byTag = {};
  let o = lenHeader;
  while (o < buf.length) {
    if (o + 12 > buf.length) throw new Error(`truncated section header at ${o}`);
    const fourcc = buf.toString('latin1', o, o + 4);
    const lh = buf.readUInt32BE(o + 4); const lt = buf.readUInt32BE(o + 8);
    if (lt < 12 || lh < 12 || lh > lt || o + lt > buf.length) throw new Error(`${fourcc}: bad lengths header=${lh} tag=${lt} at ${o}`);
    const tag = buf.subarray(o, o + lt);
    const parsed = TAGS[fourcc] ? TAGS[fourcc](tag, lh, lt) : {};
    const s = { fourcc, lenHeader: lh, lenTag: lt, ...parsed };
    sections.push(s); (byTag[fourcc] ||= []).push(s);
    o += lt;
  }
  return { lenHeader, lenFile, header: [12, 16, 20, 24].map((x) => buf.readUInt32BE(x)), sections, byTag };
}
