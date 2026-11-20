// Pure lighting show model: fixtures, config normalisation, beat clock and the frame renderer.
// Nothing in here touches the network or timers, so every frame is a deterministic function of
// (show, state, timeMs) and can be unit-tested.

export const PHRASES = ['intro', 'verse', 'buildup', 'drop', 'breakdown', 'outro'];
export const FIXTURE_TYPES = ['rgb', 'rgbw', 'dimmer', 'strobe', 'moving-head-basic', 'wled-strip', 'hue-light'];
export const GROUPS = ['all', 'left', 'right', 'center', 'back', 'floor'];
// Channel functions a DMX fixture's layout can use. "=N" is a fixed value (e.g. "=255" for a shutter-open channel).
export const CHANNEL_KINDS = ['dim', 'r', 'g', 'b', 'w', 'strobe', 'rate', 'pan', 'tilt', 'speed', 'mode', 'none'];

export const TEMPLATES = [
  { id: 'rgb3', name: 'Generic RGB par (3ch)', type: 'rgb', channels: ['r', 'g', 'b'] },
  { id: 'rgbw4', name: 'RGBW par (4ch)', type: 'rgbw', channels: ['r', 'g', 'b', 'w'] },
  { id: 'rgb5', name: 'RGB + dimmer + strobe (5ch)', type: 'rgb', channels: ['dim', 'r', 'g', 'b', 'strobe'] },
  { id: 'rgb7', name: 'RGB + dimmer + strobe (7ch)', type: 'rgb', channels: ['dim', 'r', 'g', 'b', 'strobe', 'mode', 'speed'] },
  { id: 'dim1', name: 'Dimmer (1ch)', type: 'dimmer', channels: ['dim'] },
  { id: 'strobe2', name: 'Strobe (2ch: dimmer, rate)', type: 'strobe', channels: ['dim', 'rate'] },
  { id: 'mh8', name: 'Moving head, basic (8ch)', type: 'moving-head-basic', channels: ['pan', 'tilt', 'speed', 'dim', 'strobe', 'r', 'g', 'b'] },
  { id: 'wled', name: 'WLED LED strip (network)', type: 'wled-strip', channels: [], pixels: 60 },
  { id: 'hue', name: 'Philips Hue light (network)', type: 'hue-light', channels: [] },
];

export const EFFECTS = {
  wash: 'Colour wash', pulse: 'Beat pulse', chase: 'Chase', pingpong: 'Left / right', build: 'Build-up',
  drop: 'Drop chase', fade: 'Slow fade', outro: 'Wash fade-out', rainbow: 'Rainbow', strobe: 'Strobe', static: 'Static colour',
};

export const DEFAULT_MAP = { intro: 'wash', verse: 'pulse', buildup: 'build', drop: 'drop', breakdown: 'fade', outro: 'outro' };

const num = (v, d, lo = -Infinity, hi = Infinity) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (v, d = '') => (v == null ? d : String(v).slice(0, 200));
const HEX = /^#[0-9a-f]{6}$/i;

export function randomCid() {
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export function defaultConfig() {
  return {
    enabled: false,
    fps: 40,
    fixtures: [],
    show: {
      auto: true, map: { ...DEFAULT_MAP }, manualEffect: 'wash', colorMode: 'key',
      palette: ['#ff2a6d', '#05d9e8', '#7a5cff', '#ffb020'], idle: 'dim', strobeAccents: true,
      master: 1, speed: 1, latencyMs: 0,
    },
    outputs: {
      artnet: { enabled: false, host: '255.255.255.255', port: 6454, net: 0, subnet: 0, universe: 0 },
      sacn: { enabled: false, multicast: true, host: '', port: 5568, universe: 1, priority: 100, sourceName: 'OpenDJ', cid: '' },
      wled: { enabled: false, port: 21324, timeout: 2 },
      hue: { enabled: false, bridge: '', username: '', rate: 10, transition: 2 },
      osc: { enabled: false, host: '127.0.0.1', port: 7000, prefix: '/opendj' },
      usbdmx: { enabled: false, universe: 1 },
      midi: { enabled: false, output: '', channel: 1, beatNote: 36, downbeatNote: 37, phraseNote: 48 },
    },
  };
}

export function normalizeFixture(f, i = 0) {
  const tpl = TEMPLATES.find((t) => t.type === f?.type) || TEMPLATES[0];
  const type = FIXTURE_TYPES.includes(f?.type) ? f.type : tpl.type;
  const network = type === 'wled-strip' || type === 'hue-light';
  const channels = network ? [] : (Array.isArray(f?.channels) ? f.channels : String(f?.channels || '').split(/[\s,]+/))
    .map((c) => String(c).trim().toLowerCase()).filter((c) => CHANNEL_KINDS.includes(c) || /^=\d{1,3}$/.test(c)).slice(0, 64);
  const out = {
    id: str(f?.id) || `fx${i + 1}`,
    name: str(f?.name, `Fixture ${i + 1}`),
    type,
    universe: Math.round(num(f?.universe, 1, 1, 63999)),
    address: Math.round(num(f?.address, 1, 1, 512)),
    channels: network ? [] : (channels.length ? channels : [...tpl.channels]),
    group: GROUPS.includes(f?.group) ? f.group : 'all',
  };
  if (type === 'wled-strip') { out.host = str(f?.host); out.pixels = Math.round(num(f?.pixels, 60, 1, 1500)); }
  if (type === 'hue-light') out.hueId = str(f?.hueId);
  return out;
}

/** Fill in defaults and clamp everything coming from the UI or settings.json. */
export function normalizeConfig(c) {
  const d = defaultConfig();
  c = c && typeof c === 'object' ? c : {};
  const s = { ...d.show, ...(c.show || {}) };
  const o = c.outputs || {};
  const out = {
    enabled: !!c.enabled,
    fps: Math.round(num(c.fps, 40, 10, 44)),
    fixtures: (Array.isArray(c.fixtures) ? c.fixtures : []).slice(0, 512).map(normalizeFixture),
    show: {
      auto: s.auto !== false,
      map: Object.fromEntries(PHRASES.map((p) => [p, EFFECTS[s.map?.[p]] ? s.map[p] : DEFAULT_MAP[p]])),
      manualEffect: EFFECTS[s.manualEffect] ? s.manualEffect : 'wash',
      colorMode: ['key', 'palette', 'energy'].includes(s.colorMode) ? s.colorMode : 'key',
      palette: (Array.isArray(s.palette) ? s.palette : []).filter((x) => HEX.test(x)).slice(0, 8),
      idle: ['dim', 'blackout', 'wash'].includes(s.idle) ? s.idle : 'dim',
      strobeAccents: s.strobeAccents !== false,
      master: num(s.master, 1, 0, 1),
      speed: [0.5, 1, 2].includes(Number(s.speed)) ? Number(s.speed) : 1,
      latencyMs: num(s.latencyMs, 0, -500, 500),
    },
    outputs: {},
  };
  if (!out.show.palette.length) out.show.palette = [...d.show.palette];
  const ids = new Set();
  for (const f of out.fixtures) { while (ids.has(f.id)) f.id += '_'; ids.add(f.id); }
  const merge = (k) => ({ ...d.outputs[k], ...(o[k] || {}), enabled: !!o[k]?.enabled });
  const a = merge('artnet');
  out.outputs.artnet = { ...a, host: str(a.host, '255.255.255.255') || '255.255.255.255', port: Math.round(num(a.port, 6454, 1, 65535)), net: Math.round(num(a.net, 0, 0, 127)), subnet: Math.round(num(a.subnet, 0, 0, 15)), universe: Math.round(num(a.universe, 0, 0, 15)) };
  const sa = merge('sacn');
  out.outputs.sacn = { ...sa, multicast: sa.multicast !== false, host: str(sa.host), port: Math.round(num(sa.port, 5568, 1, 65535)), universe: Math.round(num(sa.universe, 1, 1, 63999)), priority: Math.round(num(sa.priority, 100, 0, 200)), sourceName: str(sa.sourceName, 'OpenDJ').slice(0, 63) || 'OpenDJ', cid: /^[0-9a-f]{32}$/i.test(sa.cid) ? sa.cid.toLowerCase() : randomCid() };
  const w = merge('wled');
  out.outputs.wled = { enabled: w.enabled, port: Math.round(num(w.port, 21324, 1, 65535)), timeout: Math.round(num(w.timeout, 2, 1, 255)) };
  const h = merge('hue');
  out.outputs.hue = { enabled: h.enabled, bridge: str(h.bridge).replace(/^https?:\/\//, '').replace(/\/.*$/, ''), username: str(h.username), rate: num(h.rate, 10, 1, 10), transition: Math.round(num(h.transition, 2, 0, 20)) };
  const os = merge('osc');
  out.outputs.osc = { enabled: os.enabled, host: str(os.host, '127.0.0.1') || '127.0.0.1', port: Math.round(num(os.port, 7000, 1, 65535)), prefix: ('/' + str(os.prefix, '/opendj').replace(/^\/+|\/+$/g, '')).replace(/\s/g, '') };
  const u = merge('usbdmx');
  out.outputs.usbdmx = { enabled: u.enabled, universe: Math.round(num(u.universe, 1, 1, 63999)) };
  const m = merge('midi');
  out.outputs.midi = { enabled: m.enabled, output: str(m.output), channel: Math.round(num(m.channel, 1, 1, 16)), beatNote: Math.round(num(m.beatNote, 36, 0, 127)), downbeatNote: Math.round(num(m.downbeatNote, 37, 0, 127)), phraseNote: Math.round(num(m.phraseNote, 48, 0, 121)) };
  return out;
}

/** Next free DMX address for a fixture with `count` channels (fills universes in order). */
export function nextAddress(fixtures, count, universe = 1) {
  const used = fixtures.filter((f) => f.channels?.length);
  for (let u = universe; u < universe + 64; u++) {
    const end = used.filter((f) => f.universe === u).reduce((m, f) => Math.max(m, f.address + f.channels.length - 1), 0);
    if (end + count <= 512) return { universe: u, address: end + 1 };
  }
  return { universe, address: 1 };
}

export const LIVE_DEFAULTS = { blackout: false, strobe: false, full: false, freeze: false, color: null, test: 0 };

// ---------------------------------------------------------------- music clock

const frac = (x) => x - Math.floor(x);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Musical context at `timeMs`, extrapolated from the last state the renderer sent.
 * state: { playing, bpm, beat, at, barOffset, phrase, phraseBeat, phraseLen, phraseEnergy, level, key, energy }
 */
export function musicAt(state, timeMs, latencyMs = 0) {
  const s = state || {};
  const stale = !Number.isFinite(s.at) || timeMs - s.at > 3000;
  const playing = !!s.playing && !stale;
  const bpm = num(s.bpm, 0, 0, 400) || 120;
  const dt = playing ? (timeMs + latencyMs - s.at) / 1000 : 0;
  const db = dt * bpm / 60;
  const beat = num(s.beat, 0) + db;
  const phraseLen = num(s.phraseLen, 0, 0);
  const phraseBeat = num(s.phraseBeat, 0) + db;
  const barOffset = Math.round(num(s.barOffset, 0)) & 3;
  return {
    playing, bpm, beat,
    beatIndex: Math.floor(beat + 1e-9),
    barBeat: ((Math.floor(beat + 1e-9) - barOffset) % 4 + 4) % 4,
    phrase: PHRASES.includes(s.phrase) ? s.phrase : (playing ? 'verse' : null),
    phraseEnergy: num(s.phraseEnergy, 0.7, 0, 1),
    progress: phraseLen > 0 ? clamp01(phraseBeat / phraseLen) : 0,
    level: num(s.level, 0, 0, 1),
    key: typeof s.key === 'string' ? s.key : null,
    energy: num(s.energy, 5, 0, 10),
  };
}

// ---------------------------------------------------------------- colour

export function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n) => { const k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}
export const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

/** Camelot key -> hue: neighbouring keys on the wheel get neighbouring hues, so harmonic mixes drift smoothly. */
export function keyHue(camelot) {
  const m = /^(\d{1,2})([AB])$/i.exec(camelot || '');
  if (!m) return null;
  return ((Number(m[1]) - 1) * 30 + (m[2].toUpperCase() === 'B' ? 15 : 0)) % 360;
}

/** Palette (array of [r,g,b] 0..1) for the current music and colour mode. */
export function paletteFor(show, music, live = {}) {
  if (live.color && HEX.test(live.color)) { const c = hexToRgb(live.color); return [c, c, c, c]; }
  const mode = show.show?.colorMode || 'key';
  if (mode === 'palette') return (show.show.palette || defaultConfig().show.palette).map(hexToRgb);
  const e = music.phrase ? music.phraseEnergy : music.energy / 10;
  if (mode === 'energy' || keyHue(music.key) == null) {
    const h = 240 - 240 * clamp01(e); // calm blue -> hot red
    return [hsl(h, 1, 0.5), hsl(h + 25, 1, 0.5), hsl(h - 25, 0.9, 0.55), hsl(h + 180, 1, 0.5)];
  }
  const h = keyHue(music.key);
  const minor = /A$/i.test(music.key);
  const sat = 0.75 + 0.25 * clamp01(music.energy / 10);
  const l = minor ? 0.45 : 0.5;
  // low energy: analogous colours only; high energy adds the complementary accent
  return [hsl(h, sat, l), hsl(h + 40, sat, l), hsl(h - 40, sat, l), music.energy >= 6 ? hsl(h + 180, 1, 0.5) : hsl(h + 80, sat, l)];
}

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const pick = (pal, i) => pal[((i % pal.length) + pal.length) % pal.length];
const WHITE = [1, 1, 1];

// ---------------------------------------------------------------- effects
// Each effect returns a look { c:[r,g,b] 0..1, dim 0..1, strobe 0..1 (strobe-fixture rate), flash? } for one
// slot. pos is 0..1 along the rig, slot/slots is the chase step position, side is 'left'|'right'|null.

const strobeOn = (beat, perBeat) => frac(beat * perBeat) < 0.5;
const look = (c, dim, extra) => ({ c, dim: clamp01(dim), strobe: 0, ...extra });

const FX = {
  wash: (m, p, pal) => {
    const t = m.beat / 32 + p.pos * 0.35;
    const i = Math.floor(t);
    return look(mix(pick(pal, i), pick(pal, i + 1), frac(t)), (0.5 + 0.1 * Math.sin(2 * Math.PI * m.beat / 8)) * (0.6 + 0.4 * m.phraseEnergy));
  },
  pulse: (m, p, pal) => look(pick(pal, Math.floor(m.beatIndex / 4)), (0.3 + 0.7 * Math.exp(-frac(m.beat) * 4)) * (0.65 + 0.35 * m.phraseEnergy)),
  chase: (m, p, pal) => {
    const lit = p.slot === ((m.beatIndex % p.slots) + p.slots) % p.slots;
    return look(pick(pal, Math.floor(m.beatIndex / 4)), lit ? 1 : 0.06);
  },
  pingpong: (m, p, pal) => {
    const side = p.side || (p.pos < 0.5 ? 'left' : 'right');
    const on = (m.beatIndex % 2 === 0) === (side === 'left');
    return look(pick(pal, Math.floor(m.beatIndex / 2)), on ? 0.3 + 0.7 * Math.exp(-frac(m.beat) * 2) : 0.05);
  },
  build: (m, p, pal) => {
    const pr = m.progress;
    const perBeat = pr < 0.5 ? 1 : pr < 0.75 ? 2 : 4;
    const step = Math.floor(m.beat * perBeat);
    const lit = p.slot === ((step % p.slots) + p.slots) % p.slots;
    const c = mix(pick(pal, 0), WHITE, pr * 0.6);
    if (pr >= 0.875) return strobeOn(m.beat, 4) ? look(WHITE, 1, { strobe: 1, flash: true }) : look(c, 0, { strobe: 1 });
    return look(c, (lit ? 1 : 0.15) * (0.4 + 0.6 * pr), { strobe: pr > 0.75 ? 0.5 : 0 });
  },
  drop: (m, p, pal, show) => {
    if (show.show?.strobeAccents !== false && m.barBeat === 0 && frac(m.beat) < 0.15) return look(WHITE, 1, { strobe: 1, flash: true });
    const lit = p.slot === ((m.beatIndex % p.slots) + p.slots) % p.slots;
    return look(lit ? pick(pal, m.beatIndex + 1) : pick(pal, m.beatIndex), lit ? 1 : 0.75);
  },
  fade: (m, p, pal) => look(pick(pal, 2), 0.12 + 0.13 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (m.beat / 16 + p.pos)))),
  outro: (m, p, pal, show) => { const l = FX.wash(m, p, pal, show); l.dim *= 1 - 0.85 * m.progress; return l; },
  rainbow: (m, p) => look(hsl((m.beat / 16 + p.pos) * 360, 1, 0.5), 0.9),
  strobe: (m) => (strobeOn(m.beat, 4) ? look(WHITE, 1, { strobe: 1, flash: true }) : look(WHITE, 0, { strobe: 1 })),
  static: (m, p, pal) => look(pick(pal, 0), 1),
  idle: (m, p, pal, show, timeMs) => look(hsl(timeMs / 200 + p.pos * 60, 0.8, 0.5), show.show?.idle === 'wash' ? 0.5 : 0.15),
};

function chooseEffect(show, music, live) {
  if (live.test) return 'test';
  if (!music.playing) return show.show?.idle === 'blackout' ? 'blackout' : 'idle';
  if (show.show?.auto === false) return show.show.manualEffect || 'wash';
  return show.show?.map?.[music.phrase] || DEFAULT_MAP[music.phrase] || 'pulse';
}

function applyOverrides(l, live, music, timeMs) {
  if (live.blackout) return look([0, 0, 0], 0);
  if (live.strobe) return (music.playing ? strobeOn(music.beat, 4) : (timeMs % 100) < 50) ? look(WHITE, 1, { strobe: 1, flash: true }) : look(WHITE, 0, { strobe: 1 });
  if (live.full) return look(WHITE, 1);
  return l;
}

function rgbToHueState(c, dim) {
  const max = Math.max(...c), min = Math.min(...c), d = max - min;
  let h = 0;
  if (d > 0) h = max === c[0] ? ((c[1] - c[2]) / d) % 6 : max === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4;
  h = ((h * 60) + 360) % 360;
  const bri = Math.round(dim * max * 254);
  return { on: bri > 0, bri: Math.max(1, Math.min(254, bri)), hue: Math.round(h / 360 * 65535) % 65536, sat: Math.round((max ? d / max : 0) * 254) };
}

/**
 * Render one frame.
 * show: normalised config ({ fixtures, show, outputs }) plus optional `live` overrides.
 * Returns { universes: Map<universe, Uint8Array(512)>, pixels: Map<fixtureId, Uint8Array(n*3)>,
 *           hue: Map<fixtureId, {on,bri,hue,sat}>, looks: [[r,g,b] 0..255 per fixture], effect, music, color }
 */
export function renderFrame(show, state, timeMs) {
  const live = { ...LIVE_DEFAULTS, ...(show.live || {}) };
  const latency = show.show?.latencyMs || 0;
  const raw = musicAt(state, timeMs, latency);
  const speed = show.show?.speed || 1;
  // The speed control scales effect time (½× = half as many steps per beat); phrase and bar info stay musical.
  const m = speed === 1 ? raw : { ...raw, beat: raw.beat * speed, beatIndex: Math.floor(raw.beat * speed + 1e-9) };
  const master = clamp01(show.show?.master ?? 1);
  const pal = paletteFor(show, raw, live);
  const effect = chooseEffect(show, raw, live);
  const fixtures = show.fixtures || [];
  const chasers = fixtures.filter((f) => f.type !== 'hue-light' && f.type !== 'strobe' && f.type !== 'dimmer');
  const slots = Math.max(1, chasers.length);

  const lookAt = (p) => {
    let l;
    if (effect === 'test') l = look(WHITE, 1, { strobe: 1 });
    else if (effect === 'blackout') l = look([0, 0, 0], 0);
    else l = (FX[effect] || FX.wash)(m, p, pal, show, timeMs);
    l = applyOverrides(l, live, raw, timeMs);
    return { ...l, dim: l.dim * master };
  };

  const universes = new Map();
  const pixels = new Map();
  const hue = new Map();
  const looks = [];
  const uni = (u) => { let b = universes.get(u); if (!b) universes.set(u, (b = new Uint8Array(512))); return b; };
  let sum = [0, 0, 0], n = 0;

  fixtures.forEach((f, i) => {
    const ci = chasers.indexOf(f);
    const p = { pos: ci >= 0 ? (ci + 0.5) / slots : 0.5, slot: Math.max(0, ci), slots, side: f.group === 'left' || f.group === 'right' ? f.group : null };
    const l = lookAt(p);

    if (f.type === 'wled-strip') {
      const P = f.pixels || 1, px = new Uint8Array(P * 3);
      const segs = Math.min(P, Math.max(slots, 8));
      for (let k = 0; k < P; k++) {
        const pos = (k + 0.5) / P;
        const pl = lookAt({ pos, slot: Math.floor(pos * segs), slots: segs, side: pos < 0.5 ? 'left' : 'right' });
        px[k * 3] = Math.round(pl.c[0] * pl.dim * 255); px[k * 3 + 1] = Math.round(pl.c[1] * pl.dim * 255); px[k * 3 + 2] = Math.round(pl.c[2] * pl.dim * 255);
      }
      pixels.set(f.id, px);
    } else if (f.type === 'hue-light') {
      // Hue bulbs can't follow fast chases: colour changes on the beat, brightness follows energy.
      const flashing = live.blackout || live.full || live.strobe || effect === 'test' || effect === 'blackout';
      const c = flashing ? l.c : pick(pal, raw.playing ? raw.beatIndex : 0);
      const dim = flashing ? l.dim : master * (raw.playing ? 0.25 + 0.75 * (effect === 'fade' ? 0.2 : raw.phraseEnergy) : (show.show?.idle === 'blackout' ? 0 : 0.2));
      hue.set(f.id, rgbToHueState(c, live.strobe ? 1 : dim));
      looks.push(c.map((x) => Math.round(x * dim * 255)));
      return;
    }

    const rgb = l.c.map((x) => Math.round(x * l.dim * 255));
    looks.push(f.type === 'strobe' || f.type === 'dimmer' ? [Math.round(l.dim * 255), Math.round(l.dim * 255), Math.round(l.dim * 255)] : rgb);
    if (f.type !== 'strobe' && f.type !== 'dimmer') { sum = [sum[0] + rgb[0], sum[1] + rgb[1], sum[2] + rgb[2]]; n++; }
    if (!f.channels?.length) return;

    const buf = uni(f.universe);
    const hasDim = f.channels.includes('dim');
    const scale = hasDim ? 1 : l.dim;
    let [r, g, b] = l.c.map((x) => x * scale);
    let w = 0;
    if (f.channels.includes('w')) { w = Math.min(r, g, b); r -= w; g -= w; b -= w; }
    // Strobe fixtures only fire on strobe moments; dimmers follow intensity.
    const strobeFix = f.type === 'strobe';
    const sDim = strobeFix ? (l.strobe > 0 && l.dim > 0 ? 1 : 0) * master : l.dim;
    const t = m.beat / (effect === 'drop' ? 8 : 16) * 2 * Math.PI;
    for (let k = 0; k < f.channels.length; k++) {
      const idx = f.address - 1 + k;
      if (idx >= 512) break;
      const ch = f.channels[k];
      let v = 0;
      switch (ch) {
        case 'dim': v = (strobeFix ? sDim : (hasDim ? l.dim : 1)); break;
        case 'r': v = r; break;
        case 'g': v = g; break;
        case 'b': v = b; break;
        case 'w': v = w; break;
        case 'rate': v = strobeFix && sDim > 0 ? 0.5 + 0.5 * l.strobe : 0; break;
        case 'pan': v = 0.5 + 0.25 * Math.sin(t + i * 0.7); break;
        case 'tilt': v = 0.5 + 0.15 * Math.sin(2 * t + i); break;
        default: v = ch.startsWith('=') ? Number(ch.slice(1)) / 255 : 0; // strobe/speed/mode/none: open / fastest / off
      }
      buf[idx] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  });

  return {
    universes, pixels, hue, looks, effect, music: raw,
    color: n ? sum.map((x) => x / n / 255) : pick(pal, raw.beatIndex).map((x) => x * master),
  };
}
