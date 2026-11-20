// DVS timecode decoder tests on synthetic timecode signals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMECODES, lfsrFwd, lfsrRev, buildPositionTable, cycleBits } from '../public/js/dvs/timecode-defs.js';
import { TimecodeDecoder, VERIFY_BITS } from '../public/js/dvs/timecode-core.js';
import { generateTimecode } from '../public/js/dvs/timecode-gen.js';
import { DvsDeck, setExternalSpeed, dvsDefaults } from '../public/js/dvs/dvs.js';

const SR = 48000;
const tables = {};
const tableFor = (def) => (tables[def.id] ||= buildPositionTable(def));

/** Run a decoder over a generated signal; returns per-block log rows. */
function run(sig, opts) {
  const d = new TimecodeDecoder({ sampleRate: SR, ...opts });
  const log = [];
  for (let i = 0; i < sig.L.length; i += 128) {
    d.process(sig.L.subarray(i, i + 128), sig.R.subarray(i, i + 128), (x) => log.push({ t: x.blocks * x.blockDur, speed: x.speed, v: x.velocity, q: x.quality, sig: x.signal, pos: x.position, lock: x.lock }));
  }
  return { d, log };
}
const between = (log, a, b) => log.filter((r) => r.t >= a && r.t < b);

test('LFSR: reverse step inverts forward step; position table is unique over the record', () => {
  for (const id of ['serato_2a', 'serato_2b', 'serato_cd', 'traktor_a', 'traktor_b']) {
    const def = TIMECODES[id];
    let s = def.seed;
    for (let i = 0; i < 5000; i++) { const n = lfsrFwd(s, def); assert.equal(lfsrRev(n, def), s, `${id} step ${i}`); s = n; }
  }
  const def = TIMECODES.serato_2a, t = tableFor(def);
  let count = 0; for (let i = 0; i < t.length; i++) if (t[i] >= 0) count++;
  assert.equal(count, def.length, 'every state on the record appears exactly once');
  const bits = cycleBits(def, 64);
  assert.ok(bits.some((b) => b) && bits.some((b) => !b));
});

for (const id of ['serato_2a', 'traktor_a']) {
  const def = TIMECODES[id];
  test(`${id}: steady speed decoded within ±0.5% (incl. reverse, slow, fast, light noise)`, () => {
    for (const sp of [1, 0.92, 1.08, 0.5, 2, 1.35, -1, -0.7]) {
      const sig = generateTimecode({ def, sampleRate: SR, seconds: 0.6, speed: () => sp, startCycle: 50000, noise: 0.02, seed: 7 });
      const { log } = run(sig, { def });
      const steady = between(log, 0.1, 0.6);
      const worst = Math.max(...steady.map((r) => Math.abs(r.speed / sp - 1)));
      assert.ok(worst < 0.005, `${id} speed ${sp}: worst error ${(worst * 100).toFixed(3)}%`);
    }
  });

  test(`${id}: direction change detected within 10 ms`, () => {
    for (const [a, b] of [[1, -1], [-1, 1], [0.5, -0.5], [2, -2]]) {
      const sig = generateTimecode({ def, sampleRate: SR, seconds: 0.5, speed: (t) => (t < 0.3 ? a : b), startCycle: 80000, noise: 0.02 });
      const { log } = run(sig, { def });
      const flip = log.find((r) => r.t > 0.3 && Math.sign(r.speed) === Math.sign(b) && Math.abs(r.speed) > 0.05);
      assert.ok(flip, `${a}→${b}: no reversal seen`);
      const latency = flip.t - 0.3;
      assert.ok(latency < 0.01, `${a}→${b}: reversal after ${(latency * 1000).toFixed(1)} ms`);
      const settled = log.find((r) => r.t > 0.3 && Math.abs(r.speed - b) < 0.02 * Math.abs(b));
      assert.ok(settled && settled.t - 0.3 < 0.012, `${a}→${b}: settles to the new speed within 12 ms (${settled && ((settled.t - 0.3) * 1000).toFixed(1)} ms)`);
    }
  });

  test(`${id}: quality metric drops with noise`, () => {
    const qs = [0, 0.1, 0.3, 0.8].map((noise) => {
      const sig = generateTimecode({ def, sampleRate: SR, seconds: 0.4, speed: () => 1, noise, seed: 3 });
      const { log } = run(sig, { def });
      const rows = between(log, 0.2, 0.4);
      return rows.reduce((s, r) => s + r.q, 0) / rows.length;
    });
    assert.ok(qs[0] > 0.97, `clean signal quality ${qs[0]}`);
    for (let i = 1; i < qs.length; i++) assert.ok(qs[i] < qs[i - 1], `quality decreases with noise: ${qs.map((q) => q.toFixed(3)).join(' > ')}`);
    assert.ok(qs[3] < 0.6, `very noisy signal has low quality (${qs[3].toFixed(3)})`);
  });

  test(`${id}: needle lift stops the deck, signal returns cleanly`, () => {
    const sig = generateTimecode({ def, sampleRate: SR, seconds: 0.8, speed: () => 1, dropout: (t) => t >= 0.3 && t < 0.5, noise: 0.002 });
    const { log } = run(sig, { def });
    const stopped = log.find((r) => r.t > 0.3 && Math.abs(r.speed) < 0.01 && !r.sig);
    assert.ok(stopped && stopped.t - 0.3 < 0.012, `stopped ${stopped && ((stopped.t - 0.3) * 1000).toFixed(1)} ms after the lift`);
    assert.ok(between(log, 0.32, 0.5).every((r) => !r.sig && r.speed === 0), 'no signal / no motion while lifted');
    const back = log.find((r) => r.t > 0.5 && Math.abs(r.speed - 1) < 0.005);
    assert.ok(back && back.t - 0.5 < 0.015, 'speed back after the needle drop');
  });

  test(`${id}: absolute position locks, follows forward/reverse play and needle drops`, () => {
    const start = 123456, table = tableFor(def), c = def.carrier;
    // forward 0.25 s, reverse 0.15 s, then a needle drop to a far position, forward again
    const sig = generateTimecode({
      def, sampleRate: SR, seconds: 0.8, startCycle: start, noise: 0.03,
      speed: (t) => (t < 0.25 ? 1 : t < 0.4 ? -1 : 1), jumps: [{ t: 0.5, cycle: 400000 }],
    });
    const { log } = run(sig, { def, table });
    const lockAt = log.find((r) => r.lock);
    const maxLock = (def.bits + VERIFY_BITS + 12) / c; // window + verification + level learning
    assert.ok(lockAt && lockAt.t < maxLock + 0.005, `locked after ${lockAt && (lockAt.t * 1000).toFixed(1)} ms (≤ ${(maxLock * 1000).toFixed(1)})`);
    const expect = (t) => (t < 0.25 ? start + t * c : t < 0.4 ? start + 0.25 * c - (t - 0.25) * c : t < 0.5 ? start + 0.1 * c + (t - 0.4) * c : 400000 + (t - 0.5) * c);
    for (const t of [0.2, 0.3, 0.39, 0.45, 0.7]) {
      const r = log.find((x) => x.t >= t);
      assert.ok(r.lock, `locked at ${t}s`);
      assert.ok(Math.abs(r.pos - expect(r.t)) < 1.5, `position at ${t}s: ${r.pos.toFixed(1)} vs ${expect(r.t).toFixed(1)} cycles`);
    }
    const relock = log.find((r) => r.t > 0.5 && r.lock && Math.abs(r.pos - expect(r.t)) < 1.5);
    assert.ok(relock && relock.t - 0.5 < maxLock + 0.01, `re-locked ${relock && ((relock.t - 0.5) * 1000).toFixed(1)} ms after the needle drop`);
  });
}

test('auto-calibration fixes channel imbalance, quadrature error and reversed wiring; detects 45 rpm', () => {
  const def = TIMECODES.serato_2a;
  const sig = generateTimecode({ def, sampleRate: SR, seconds: 2.5, speed: () => -1.35, rightGain: 0.6, phaseError: 25, noise: 0.01 });
  const d = new TimecodeDecoder({ sampleRate: SR, def });
  d.startCalibration(1.5);
  const rows = [];
  for (let i = 0; i < sig.L.length; i += 128) d.process(sig.L.subarray(i, i + 128), sig.R.subarray(i, i + 128), (x) => rows.push({ t: x.blocks * x.blockDur, v: x.velocity, q: x.quality }));
  const c = d.calibration;
  assert.ok(c?.ok, 'calibrated');
  assert.equal(c.flippedDirection, true, 'reversed wiring detected');
  assert.equal(c.rpm, 45, '45 rpm detected');
  assert.ok(Math.abs(c.gainRight - 1 / 0.6) < 0.05, `right gain ${c.gainRight}`);
  assert.ok(Math.abs(Math.abs(c.phaseErrorDeg) - 25) < 2, `phase error ${c.phaseErrorDeg}`);
  const after = rows.filter((r) => r.t > 2);
  const worst = Math.max(...after.map((r) => Math.abs(r.v - 1)));
  assert.ok(worst < 0.005, `after calibration deck velocity is 1.0 (worst ${worst})`);
});

test('relative-only timecode decodes speed without a position table', () => {
  const def = TIMECODES.generic_2k;
  const sig = generateTimecode({ def, sampleRate: 44100, seconds: 0.4, speed: () => 1.04 });
  const d = new TimecodeDecoder({ sampleRate: 44100, def });
  for (let i = 0; i < sig.L.length; i += 128) d.process(sig.L.subarray(i, i + 128), sig.R.subarray(i, i + 128));
  assert.ok(Math.abs(d.speed - 1.04) < 0.002);
  assert.equal(d.position, -1);
});

// ---------- deck controller (fake deck / engine) ----------
function fakeRig(mode) {
  const msgs = [], seeks = [];
  const engine = { onDeckPlay() {}, emit() {} };
  const deck = {
    track: { id: 't' }, loading: false, duration: 300, playing: false, tempo: 0, _pos: 10,
    ctx: { currentTime: 1 }, engine,
    get position() { return this._pos; },
    post(type, extra) { msgs.push({ type, ...extra }); },
    emit() {}, seek(t) { seeks.push(t); this._pos = t; }, setTempo(p) { this.tempo = p; }, play() { this.playing = true; }, pause() { this.playing = false; },
  };
  engine.decks = [deck];
  const settings = dvsDefaults(); settings.decks[0].mode = mode; settings.decks[0].timecode = 'serato_2a';
  const mgr = { settings, engine, app: { deckCount: 2 }, running: true, table: () => null };
  const dd = new DvsDeck(mgr, 0);
  return { dd, deck, msgs, seeks };
}

test('controller REL: deck follows record speed via the scratch path; lift stops the deck', () => {
  const { dd, deck, msgs } = fakeRig('rel');
  dd.onSpeed({ v: 1.02, speed: 1.02, sig: true, pos: -1, lock: false, t: 1 });
  assert.equal(deck.playing, true);
  assert.deepEqual(msgs.filter((m) => m.type === 'scratch').at(-1).value, { velocity: 1.02 });
  dd.onSpeed({ v: -0.8, speed: -0.8, sig: true, pos: 5000, lock: true, t: 1 });
  assert.deepEqual(msgs.filter((m) => m.type === 'scratch').at(-1).value, { velocity: -0.8 });
  dd.onSpeed({ v: 0, speed: 0, sig: false, pos: -1, lock: false, t: 1 });
  assert.equal(deck.playing, false, 'no signal → deck stops');
  assert.equal(deck._pos, 10, 'REL ignores the record position');
});

test('controller ABS: needle drop seeks, lead-in holds at the start, INT hands over at record speed', () => {
  const { dd, deck, seeks } = fakeRig('abs');
  dd.onSpeed({ v: 1, speed: 1, sig: true, pos: 60000, lock: true, t: 1 }); // 60 s into the record
  assert.ok(Math.abs(seeks.at(-1) - 60) < 0.01, `needle drop seeks to 60 s (${seeks.at(-1)})`);
  deck.ctx.currentTime = 1.5; deck._pos = 60.49;
  dd.onSpeed({ v: 1, speed: 1, sig: true, pos: 60500, lock: true, t: 1.5 });
  assert.equal(seeks.length, 1, 'small error is trimmed, not seeked');
  assert.ok(dd.trim > 1, 'deck pulled forward slightly');
  // with a -2 s offset the first 2 s of the record are lead-in: the deck holds at 0
  dd.settings.offset = -2; deck.ctx.currentTime = 2;
  dd.onSpeed({ v: 1, speed: 1, sig: true, pos: 1000, lock: true, t: 2 });
  assert.equal(dd.leadIn, true);
  assert.equal(seeks.at(-1), 0, 'held at the track start');
  assert.equal(dd.trim, 0, 'no motion in the lead-in');
  deck.ctx.currentTime = 3;
  dd.onSpeed({ v: 0, speed: 1, sig: true, pos: 3000, lock: true, t: 3 });
  assert.equal(dd.leadIn, false);
  assert.ok(Math.abs(seeks.at(-1) - 1) < 0.01, 'leaves the lead-in at track time 1 s');
  const deck2 = fakeRig('rel');
  deck2.dd.onSpeed({ v: 1.03, speed: 1.03, sig: true, pos: -1, lock: false, t: 1 });
  deck2.dd.mgr.settings.decks[0].mode = 'int';
  deck2.dd.release(true);
  assert.ok(Math.abs(deck2.deck.tempo - 3) < 0.01 && deck2.deck.playing, 'INT continues playing at the record pitch');
});

test('setExternalSpeed prefers the deck API when present', () => {
  const calls = [];
  setExternalSpeed({ setExternalSpeed: (v, p) => calls.push([v, p]) }, 1.1, true);
  assert.deepEqual(calls, [[1.1, true]]);
});

test('scratching: decoded speed tracks a fast back-and-forth hand movement with < 4 ms lag', () => {
  const def = TIMECODES.serato_2a;
  const f = 3, A = 4; // 3 Hz scratch, ±4× peak speed
  const true_ = (t) => A * Math.sin(2 * Math.PI * f * t);
  const sig = generateTimecode({ def, sampleRate: SR, seconds: 1.2, speed: true_, startCycle: 200000, noise: 0.02 });
  const { log } = run(sig, { def });
  const rows = between(log, 0.2, 1.2);
  let best = { lag: 0, rms: Infinity };
  for (let lag = 0; lag <= 0.008; lag += 0.0005) {
    const rms = Math.sqrt(rows.reduce((s, r) => s + (r.speed - true_(r.t - lag)) ** 2, 0) / rows.length);
    if (rms < best.rms) best = { lag, rms };
  }
  assert.ok(best.lag < 0.004, `lag ${(best.lag * 1000).toFixed(1)} ms`);
  assert.ok(best.rms < 0.05 * A, `rms tracking error ${best.rms.toFixed(3)} (×)`);
});
