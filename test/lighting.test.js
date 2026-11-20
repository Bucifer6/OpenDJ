import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderFrame, normalizeConfig, nextAddress, keyHue, paletteFor, musicAt, TEMPLATES } from '../server/lighting/show.js';
import { encodeArtDmx, artPortAddress, nextArtSeq, encodeSacn, nextSacnSeq, sacnMulticastAddress, encodeOsc, decodeOsc, encodeWled } from '../server/lighting/protocols.js';
import { RateLimiter, HueOutput, ArtNetOutput } from '../server/lighting/outputs.js';
import { LightingEngine } from '../server/lighting/engine.js';
import { encodeEnttecDmx } from '../public/js/lighting/enttec.js';
import { start } from '../server/index.js';

// 4 RGB pars on universe 1 (addresses 1, 4, 7, 10), plus a 5-channel par with dimmer and a 2ch strobe.
const rig = (extra = {}) => {
  const cfg = normalizeConfig({
    enabled: true,
    fixtures: [
      ...[0, 1, 2, 3].map((i) => ({ id: `p${i}`, type: 'rgb', channels: ['r', 'g', 'b'], universe: 1, address: 1 + i * 3 })),
      { id: 'd5', type: 'rgb', channels: ['dim', 'r', 'g', 'b', 'strobe'], universe: 2, address: 1 },
      { id: 'st', type: 'strobe', channels: ['dim', 'rate'], universe: 2, address: 10 },
    ],
    show: { colorMode: 'palette', palette: ['#ff0000', '#00ff00', '#0000ff', '#ffffff'], strobeAccents: true, ...(extra.show || {}) },
  });
  return { ...cfg, live: extra.live || {} };
};
const T0 = 1_000_000;
const st = (o = {}) => ({ playing: true, bpm: 120, beat: 0, at: T0, barOffset: 0, phrase: 'verse', phraseBeat: 0, phraseLen: 64, phraseEnergy: 0.8, level: 0.5, key: '8A', energy: 7, ...o });
const sum = (u) => u.reduce((a, b) => a + b, 0);
const litPar = (frame) => [0, 1, 2, 3].map((i) => sum(frame.universes.get(1).subarray(i * 3, i * 3 + 3))).map((v, i, a) => (v === Math.max(...a) ? i : -1)).filter((i) => i >= 0);

test('musicAt extrapolates the beat clock between updates and goes idle when stale', () => {
  const m = musicAt(st({ beat: 10 }), T0 + 250); // 120 BPM = 2 beats/s
  assert.ok(Math.abs(m.beat - 10.5) < 1e-9);
  assert.equal(m.barBeat, 2);
  assert.equal(musicAt(st({ beat: 10 }), T0 + 250, 250).beatIndex, 11); // latency offset fires early
  assert.equal(musicAt(st(), T0 + 5000).playing, false);
  assert.equal(musicAt(st({ playing: false, beat: 3 }), T0 + 1000).beat, 3);
});

test('chase steps exactly on beat boundaries, extrapolated from the last state', () => {
  const show = rig({ show: { auto: false, manualEffect: 'chase' } });
  const s = st({ beat: 0.5 });
  // beat 0.5 at T0; beat 1.0 is reached at T0 + 250 ms
  assert.deepEqual(litPar(renderFrame(show, s, T0 + 240)), [0]);
  assert.deepEqual(litPar(renderFrame(show, s, T0 + 260)), [1]);
  assert.deepEqual(litPar(renderFrame(show, s, T0 + 760)), [2]);
  assert.deepEqual(litPar(renderFrame(show, s, T0 + 1260)), [3]);
  assert.deepEqual(litPar(renderFrame(show, s, T0 + 2260)), [0]); // wraps: 5 chase slots (the 5ch par is slot 4)
  // speed 2x doubles the step rate
  const fast = rig({ show: { auto: false, manualEffect: 'chase', speed: 2 } });
  assert.deepEqual(litPar(renderFrame(fast, st({ beat: 0 }), T0 + 10)), [0]);
  assert.deepEqual(litPar(renderFrame(fast, st({ beat: 0 }), T0 + 260)), [1]);
  // deterministic
  assert.deepEqual([...renderFrame(show, s, T0 + 777).universes.get(1)], [...renderFrame(show, s, T0 + 777).universes.get(1)]);
});

test('auto show: drop is much brighter than breakdown and strobes on the downbeat', () => {
  const show = rig();
  const total = (f) => sum(f.universes.get(1));
  const drop = renderFrame(show, st({ phrase: 'drop', beat: 1.5 }), T0);
  const brk = renderFrame(show, st({ phrase: 'breakdown', beat: 1.5 }), T0);
  assert.equal(drop.effect, 'drop');
  assert.equal(brk.effect, 'fade');
  assert.ok(total(drop) > total(brk) * 3, `drop ${total(drop)} vs breakdown ${total(brk)}`);
  // downbeat accent: all white, strobe fixture fires
  const accent = renderFrame(show, st({ phrase: 'drop', beat: 4.02 }), T0);
  assert.deepEqual([...accent.universes.get(1).subarray(0, 12)], new Array(12).fill(255));
  assert.equal(accent.universes.get(2)[9], 255, 'strobe dimmer');
  assert.ok(accent.universes.get(2)[10] > 0, 'strobe rate');
  // not on beat 2 of the bar
  const off = renderFrame(show, st({ phrase: 'drop', beat: 5.02 }), T0);
  assert.equal(off.universes.get(2)[9], 0);
  // bar offset shifts the downbeat
  assert.equal(renderFrame(show, st({ phrase: 'drop', beat: 5.02, barOffset: 1 }), T0).universes.get(2)[9], 255);
  // build-up gets brighter and faster through the phrase, ending in a strobe
  const b0 = renderFrame(show, st({ phrase: 'buildup', beat: 0.2, phraseBeat: 2, phraseLen: 64 }), T0);
  const b1 = renderFrame(show, st({ phrase: 'buildup', beat: 0.2, phraseBeat: 44, phraseLen: 64 }), T0);
  assert.equal(b0.effect, 'build');
  assert.ok(total(b1) > total(b0));
  const bEnd = renderFrame(show, st({ phrase: 'buildup', beat: 0.05, phraseBeat: 60, phraseLen: 64 }), T0);
  assert.equal(sum(bEnd.universes.get(1)), 12 * 255);
  // outro fades out with progress
  const o0 = renderFrame(show, st({ phrase: 'outro', phraseBeat: 0 }), T0), o1 = renderFrame(show, st({ phrase: 'outro', phraseBeat: 60 }), T0);
  assert.ok(total(o1) < total(o0) * 0.5);
});

test('overrides: blackout beats everything, strobe flashes white, full, master and colour pick', () => {
  const s = st({ phrase: 'drop', beat: 4.02 });
  const black = renderFrame(rig({ live: { blackout: true, strobe: true, full: true } }), s, T0);
  assert.equal(sum(black.universes.get(1)) + sum(black.universes.get(2)), 0);
  const strobeOn = renderFrame(rig({ live: { strobe: true } }), st({ beat: 0.05 }), T0);
  const strobeOff = renderFrame(rig({ live: { strobe: true } }), st({ beat: 0.2 }), T0);
  assert.equal(sum(strobeOn.universes.get(1)), 12 * 255);
  assert.equal(sum(strobeOff.universes.get(1)), 0);
  const full = renderFrame(rig({ live: { full: true } }), st({ phrase: 'breakdown' }), T0);
  assert.equal(sum(full.universes.get(1)), 12 * 255);
  assert.deepEqual([...full.universes.get(2).subarray(0, 5)], [255, 255, 255, 255, 0]); // dim, r, g, b, strobe open
  const half = renderFrame({ ...rig({ live: { full: true } }), show: { ...rig().show, master: 0.5 } }, s, T0);
  assert.equal(half.universes.get(1)[0], 128);
  const red = renderFrame(rig({ show: { auto: false, manualEffect: 'static' }, live: { color: '#ff0000' } }), s, T0);
  assert.deepEqual([...red.universes.get(1).subarray(0, 6)], [255, 0, 0, 255, 0, 0]);
  // idle when stopped: dim, and blackout if configured
  const idle = renderFrame(rig({ show: { idle: 'blackout' } }), st({ playing: false }), T0);
  assert.equal(idle.effect, 'blackout');
  assert.equal(sum(idle.universes.get(1)), 0);
});

test('key palette follows the Camelot wheel; RGBW, moving heads, strips and Hue render', () => {
  assert.equal(keyHue('1A'), 0); assert.equal(keyHue('2A'), 30); assert.equal(keyHue('8B'), 225); assert.equal(keyHue('x'), null);
  const p8 = paletteFor({ show: { colorMode: 'key' } }, musicAt(st({ key: '8A' }), T0));
  const p9 = paletteFor({ show: { colorMode: 'key' } }, musicAt(st({ key: '9A' }), T0));
  assert.notDeepEqual(p8[0], p9[0]);
  const cfg = normalizeConfig({
    fixtures: [
      { id: 'w', type: 'rgbw', channels: ['r', 'g', 'b', 'w'], address: 1 },
      { id: 'mh', type: 'moving-head-basic', channels: ['pan', 'tilt', 'speed', 'dim', 'strobe', 'r', 'g', 'b'], address: 5 },
      { id: 'strip', type: 'wled-strip', pixels: 30, host: '10.0.0.5' },
      { id: 'h', type: 'hue-light', hueId: '3' },
    ],
  });
  const f = renderFrame({ ...cfg, live: { full: true } }, st(), T0);
  assert.deepEqual([...f.universes.get(1).subarray(0, 4)], [0, 0, 0, 255], 'white goes to the W channel');
  const u = f.universes.get(1);
  assert.equal(u[7], 255, 'moving head dimmer'); assert.ok(u[4] > 0 && u[5] > 0, 'pan/tilt set');
  assert.equal(f.pixels.get('strip').length, 90);
  assert.ok(f.pixels.get('strip').every((v) => v === 255));
  assert.deepEqual(f.hue.get('h'), { on: true, bri: 254, hue: 0, sat: 0 });
  const chase = renderFrame({ ...cfg, show: { ...cfg.show, auto: false, manualEffect: 'chase' } }, st(), T0);
  const px = chase.pixels.get('strip');
  assert.ok(Math.max(...px) > Math.min(...px), 'strip shows a moving segment');
});

test('config normalisation and DMX auto-addressing', () => {
  const c = normalizeConfig({ fixtures: [{ type: 'bogus', address: 900, channels: 'r g x b' }], outputs: { artnet: { enabled: 1, net: 300 } }, show: { speed: 3, map: { drop: 'nope' } } });
  assert.equal(c.fixtures[0].type, 'rgb'); assert.equal(c.fixtures[0].address, 512); assert.deepEqual(c.fixtures[0].channels, ['r', 'g', 'b']);
  assert.equal(c.outputs.artnet.net, 127); assert.equal(c.outputs.artnet.enabled, true);
  assert.equal(c.show.speed, 1); assert.equal(c.show.map.drop, 'drop');
  assert.match(c.outputs.sacn.cid, /^[0-9a-f]{32}$/);
  const fx = [{ universe: 1, address: 1, channels: new Array(500).fill('dim') }];
  assert.deepEqual(nextAddress(fx, 7), { universe: 1, address: 501 });
  assert.deepEqual(nextAddress(fx, 20), { universe: 2, address: 1 });
  assert.ok(TEMPLATES.some((t) => t.channels.length === 7));
});

test('Art-Net ArtDmx packet is byte exact and sequence wraps 255 -> 1', () => {
  const data = new Uint8Array(512); data[0] = 11; data[511] = 99;
  const p = encodeArtDmx(data, { portAddress: artPortAddress(1, 2, 3), sequence: 7 });
  assert.equal(p.length, 530);
  assert.deepEqual([...p.subarray(0, 18)], [0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00, 0x00, 0x50, 0x00, 14, 7, 0, 0x23, 0x01, 0x02, 0x00]);
  assert.equal(p[18], 11); assert.equal(p[529], 99);
  assert.equal(encodeArtDmx(new Uint8Array(3)).readUInt16BE(16), 4, 'odd length padded to even');
  assert.equal(nextArtSeq(254), 255); assert.equal(nextArtSeq(255), 1); assert.equal(nextArtSeq(0), 1);
});

test('sACN E1.31 packet layers are byte exact; multicast address; sequence wraps', () => {
  const data = new Uint8Array(512).fill(0); data[0] = 200;
  const cid = ' 00112233445566778899aabbccddeeff'.trim();
  const p = encodeSacn(data, { universe: 258, sequence: 9, priority: 100, sourceName: 'OpenDJ', cid });
  assert.equal(p.length, 638);
  assert.deepEqual([...p.subarray(0, 22)], [0x00, 0x10, 0x00, 0x00, 0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00, 0x72, 0x6e, 0, 0, 0, 4]);
  assert.equal(p.subarray(22, 38).toString('hex'), cid);
  assert.deepEqual([...p.subarray(38, 44)], [0x72, 0x58, 0, 0, 0, 2]);
  assert.equal(p.toString('utf8', 44, 50), 'OpenDJ'); assert.equal(p[50], 0); assert.equal(p[107], 0);
  assert.deepEqual([...p.subarray(108, 115)], [100, 0, 0, 9, 0, 0x01, 0x02]);
  assert.deepEqual([...p.subarray(115, 126)], [0x72, 0x0b, 0x02, 0xa1, 0, 0, 0, 1, 0x02, 0x01, 0x00]);
  assert.equal(p[126], 200);
  assert.equal(sacnMulticastAddress(1), '239.255.0.1'); assert.equal(sacnMulticastAddress(258), '239.255.1.2');
  assert.equal(nextSacnSeq(255), 0); assert.equal(nextSacnSeq(3), 4);
});

test('OSC encoding matches the spec example and round-trips', () => {
  const p = encodeOsc('/oscillator/4/frequency', [{ f: 440 }]);
  assert.equal(p.toString('hex'), Buffer.concat([Buffer.from('/oscillator/4/frequency\0', 'ascii'), Buffer.from(',f\0\0', 'ascii'), Buffer.from([0x43, 0xdc, 0, 0])]).toString('hex'));
  const q = encodeOsc('/opendj/phrase', ['drop', { f: 0.5 }, 3, true]);
  assert.equal(q.length % 4, 0);
  assert.deepEqual(decodeOsc(q), { address: '/opendj/phrase', args: ['drop', 0.5, 3, true] });
  assert.equal(encodeOsc('/abc').length, 12); // "/abc" + 4 nulls, "," + 3 nulls
});

test('WLED realtime packets: DRGB up to 490 LEDs, DNRGB chunks above', () => {
  const px = new Uint8Array(3 * 10).map((_, i) => i);
  const [d] = encodeWled(px, { timeout: 2 });
  assert.deepEqual([...d.subarray(0, 5)], [2, 2, 0, 1, 2]);
  assert.equal(d.length, 32);
  const big = encodeWled(new Uint8Array(3 * 1000), { timeout: 5 });
  assert.equal(big.length, 3);
  assert.deepEqual([...big[1].subarray(0, 4)], [4, 5, 489 >> 8, 489 & 0xff]);
  assert.equal(big[0].length, 4 + 489 * 3); assert.equal(big[2].length, 4 + 22 * 3);
});

test('Enttec DMX USB Pro label 6 framing', () => {
  const d = new Uint8Array(512); d[0] = 1; d[511] = 2;
  const p = encodeEnttecDmx(d);
  assert.equal(p.length, 518);
  assert.deepEqual([...p.subarray(0, 6)], [0x7e, 6, 0x01, 0x02, 0x00, 1]);
  assert.equal(p[516], 2); assert.equal(p[517], 0xe7);
});

test('Hue output stays under the bridge rate limit', async () => {
  const rl = new RateLimiter(10, 2);
  let ok = 0; for (let t = 0; t <= 2000; t += 5) if (rl.take(t)) ok++;
  assert.ok(ok <= 22 && ok >= 19, `limiter allowed ${ok} in 2 s`);
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };
  const fixtures = [1, 2, 3, 4, 5].map((i) => ({ id: `h${i}`, type: 'hue-light', hueId: String(i) }));
  const out = new HueOutput({ bridge: '10.0.0.2', username: 'u', rate: 10, transition: 2 }, fixtures, { fetch: fakeFetch });
  for (let t = 0; t < 3000; t += 25) {
    const hue = new Map(fixtures.map((f, i) => [f.id, { on: true, bri: 100 + ((t / 25) % 2) * 100, hue: (t * 97 + i * 9000) % 65536, sat: 200 }]));
    out.send({ hue }, t);
    await Promise.resolve(); await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.length <= 32 && calls.length >= 25, `${calls.length} hue requests in 3 s`);
  assert.match(calls[0].url, /^http:\/\/10\.0\.0\.2\/api\/u\/lights\/\d\/state$/);
  assert.equal(calls[0].body.transitiontime, 2);
  assert.equal(new Set(calls.slice(0, 5).map((c) => c.url)).size, 5, 'round robin over lights');
});

// ---------------------------------------------------------------- real UDP to mock receivers on 127.0.0.1
function listen() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const packets = [];
    sock.on('message', (m) => packets.push(m));
    sock.bind(0, '127.0.0.1', () => resolve({ sock, packets, port: sock.address().port }));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('engine sends Art-Net, sACN (unicast), WLED and OSC to UDP receivers', async () => {
  const [art, sacn, wled, osc] = await Promise.all([listen(), listen(), listen(), listen()]);
  let now = T0;
  const engine = new LightingEngine({
    now: () => now,
    config: {
      enabled: true,
      fixtures: [
        { id: 'a', type: 'rgb', channels: ['r', 'g', 'b'], universe: 1, address: 1 },
        { id: 'b', type: 'rgb', channels: ['r', 'g', 'b'], universe: 1, address: 4 },
        { id: 's', type: 'wled-strip', host: '127.0.0.1', pixels: 20 },
      ],
      show: { auto: false, manualEffect: 'chase', colorMode: 'palette', palette: ['#ff0000'] },
      outputs: {
        artnet: { enabled: true, host: '127.0.0.1', port: art.port, net: 0, subnet: 1, universe: 2 },
        sacn: { enabled: true, multicast: false, host: '127.0.0.1', port: sacn.port, universe: 7 },
        wled: { enabled: true, port: wled.port },
        osc: { enabled: true, host: '127.0.0.1', port: osc.port, prefix: '/dj' },
      },
    },
  });
  try {
    engine.setState(st({ beat: 0.9, at: now, phrase: 'drop' }));
    for (let i = 0; i < 12; i++) { engine.tick(); now += 25; await wait(5); }
    await wait(80);
    assert.ok(art.packets.length >= 2, `art-net packets: ${art.packets.length}`);
    const a0 = art.packets[0];
    assert.equal(a0.toString('ascii', 0, 7), 'Art-Net'); assert.equal(a0[14], 0x12); assert.equal(a0[12], 1);
    assert.equal(art.packets[1][12], 2, 'sequence increments');
    assert.notDeepEqual([...a0.subarray(18, 24)], [...art.packets.at(-1).subarray(18, 24)], 'chase moved on the beat');
    assert.ok(sacn.packets.length >= 2); assert.equal(sacn.packets[0].readUInt16BE(113), 7);
    assert.ok(wled.packets.length >= 1); assert.equal(wled.packets[0][0], 2); assert.equal(wled.packets[0].length, 62);
    const msgs = osc.packets.map(decodeOsc);
    const addrs = msgs.map((m) => m.address);
    for (const a of ['/dj/beat', '/dj/downbeat', '/dj/bpm', '/dj/phrase', '/dj/level', '/dj/color']) assert.ok(addrs.includes(a), `${a} sent (${addrs})`);
    assert.deepEqual(msgs.find((m) => m.address === '/dj/phrase').args[0], 'drop');
    // unchanged frames are not resent every tick (keepalive once a second)
    const n = art.packets.length;
    engine.setLive({ freeze: true });
    for (let i = 0; i < 8; i++) { engine.tick(); now += 25; }
    await wait(50);
    assert.ok(art.packets.length - n <= 2, 'frozen frame not spammed');
  } finally {
    engine.close();
    for (const r of [art, sacn, wled, osc]) r.sock.close();
  }
});

test('ArtNetOutput maps show universes onto consecutive port-addresses', () => {
  const sent = [];
  const out = new ArtNetOutput({ host: 'h', port: 1, net: 0, subnet: 0, universe: 15 }, { send: (b) => sent.push(b) });
  out.send({ universes: new Map([[1, new Uint8Array(512)], [2, new Uint8Array(512)]]) }, 0);
  assert.deepEqual(sent.map((b) => b.readUInt16LE(14)), [15, 16]);
});

test('HTTP API: config persists, state feed drives the show, stream delivers USB DMX frames', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-light-'));
  const app = await start({ dataDir: dir });
  const base = app.url.replace(/\/$/, '');
  const j = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
  try {
    const g = await j('GET', '/api/lighting');
    assert.equal(g.config.enabled, false); assert.ok(g.meta.templates.length >= 5);
    const cfg = await j('PUT', '/api/lighting/config', { enabled: true, fixtures: [{ id: 'x', type: 'rgb', channels: ['r', 'g', 'b'] }], outputs: { usbdmx: { enabled: true, universe: 1 } }, show: { auto: false, manualEffect: 'static', colorMode: 'palette', palette: ['#00ff00'] } });
    assert.equal(cfg.fixtures.length, 1);
    assert.equal(app.library.settings.lighting.fixtures[0].id, 'x');
    const s = await j('GET', '/api/settings');
    assert.equal(s.lighting.enabled, true);
    await j('POST', '/api/lighting/state', st({ at: Date.now() }));
    const ctl = new AbortController();
    const r = await fetch(base + '/api/lighting/stream?dmx=1&preview=1', { signal: ctl.signal });
    const reader = r.body.getReader();
    let text = '';
    const t0 = Date.now();
    while (!/event: dmx\ndata: (\S+)/.test(text) || !/event: preview/.test(text)) { const { value } = await reader.read(); text += Buffer.from(value).toString(); if (Date.now() - t0 > 3000) break; }
    ctl.abort();
    const b64 = /event: dmx\ndata: (\S+)/.exec(text)?.[1];
    assert.ok(b64, 'got a dmx frame');
    const dmx = Buffer.from(b64, 'base64');
    assert.equal(dmx.length, 512); assert.deepEqual([...dmx.subarray(0, 3)], [0, 255, 0]);
    const lv = await j('POST', '/api/lighting/live', { blackout: true, master: 0.5 });
    assert.equal(lv.live.blackout, true); assert.equal(lv.show.master, 0.5);
    const st2 = await j('GET', '/api/lighting/status');
    assert.equal(st2.running, true);
    await j('PUT', '/api/lighting/config', { ...cfg, enabled: false });
  } finally {
    app.server.close(); app.shutdown();
  }
});
