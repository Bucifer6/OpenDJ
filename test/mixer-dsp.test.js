// Mixer v2 objective checks under Node (pure maths and the AudioWorklet processors): crossfader / fader curves,
// Center Lock, loudness meter against EBU Tech 3341 / BS.1770-4 reference signals, true peak, compressor, warmth,
// pitch shifter and the talkover follower. Whole-graph renders (EQ types, filters, booth, mic, sends) live in
// scripts/e2e-fx.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xfGain, LEGACY_XF, faderGain, rotaryGain, centerLock, xfSettings, isoKnobGain, classicKnobDb } from '../public/js/audio/curves.js';
import { eqKnobGain } from '../public/js/audio/engine.js';

const processors = {};
globalThis.sampleRate = 48000;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: () => {}, onmessage: null }; } };
globalThis.registerProcessor = (name, cls) => { processors[name] = cls; };
await import('../public/js/audio/fx-worklets.js');
const SR = 48000;
const dB = (x) => 20 * Math.log10(Math.max(1e-12, x));

/** Run a processor over stereo input [L, R] in 128-frame blocks; params: name -> value or (t) => value. */
function runProc(name, L, R = L, params = {}, { channels = 2, opts, onMsg } = {}) {
  const p = new processors[name](opts);
  if (onMsg) p.port.postMessage = onMsg;
  const n = L.length, oL = new Float32Array(n), oR = new Float32Array(n);
  for (let o = 0; o < n; o += 128) {
    const m = Math.min(128, n - o);
    const iL = new Float32Array(128), iR = new Float32Array(128); iL.set(L.subarray(o, o + m)); iR.set(R.subarray(o, o + m));
    const out = [new Float32Array(128), new Float32Array(128)];
    const P = {}; for (const [k, v] of Object.entries(params)) P[k] = [typeof v === 'function' ? v(o / SR) : v];
    p.process([channels === 1 ? [iL] : [iL, iR]], [out], P);
    oL.set(out[0].subarray(0, m), o); oR.set(out[1].subarray(0, m), o);
    globalThis.currentTime += 128 / SR;
  }
  return { p, L: oL, R: oR };
}
const sine = (secs, f, amp, ph = 0) => Float32Array.from({ length: Math.round(secs * SR) }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / SR + ph));
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
const goertzel = (x, f, a = 0, b = x.length) => { let re = 0, im = 0; for (let i = a; i < b; i++) { const w = 2 * Math.PI * f * i / SR; re += x[i] * Math.cos(w); im += x[i] * Math.sin(w); } return 2 * Math.hypot(re, im) / (b - a); };
function drums(secs, bpm = 120) {
  const n = Math.round(secs * SR), L = new Float32Array(n); let s = 7, hp0 = 0, hp1 = 0; const beat = 60 / bpm;
  const r = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296 * 2 - 1; };
  for (let i = 0; i < n; i++) {
    const t = i / SR, b = t / beat, tb = (b % 1) * beat, t8 = ((b * 2) % 1) * beat / 2, bar = Math.floor(b) % 4, w = r();
    const kick = Math.sin(2 * Math.PI * (45 * tb + 2.5 * (1 - Math.exp(-tb * 30)))) * Math.exp(-tb * 7) * 0.8;
    const snare = bar % 2 ? (w * 0.45 + Math.sin(2 * Math.PI * 185 * tb) * 0.25) * Math.exp(-tb * 16) : 0;
    hp0 = 0.6 * (hp0 + w - hp1); hp1 = w;
    L[i] = (kick + snare + hp0 * Math.exp(-t8 * 60) * 0.22 + 0.06 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t))) * 0.5;
  }
  return L;
}

// ---------------------------------------------------------------- M1 crossfader
test('M1: legacy crossfader curves migrate to identical gains (within 0.1 dB)', () => {
  const legacy = {
    smooth: (p) => Math.min(1, Math.cos(p * Math.PI / 2) / Math.cos(Math.PI / 4)),
    constant: (p) => Math.min(1, 2 * (1 - p)),
    sharp: (p) => (p < 0.92 ? 1 : (1 - p) / 0.08),
  };
  for (const [name, f] of Object.entries(legacy)) {
    for (let i = 0; i <= 200; i++) {
      const pos = -1 + i / 100;
      for (const side of ['A', 'B']) {
        const p = side === 'A' ? (pos + 1) / 2 : 1 - (pos + 1) / 2;
        const a = f(p), b = xfGain(pos, side, LEGACY_XF[name]);
        if (a > 1e-4) assert.ok(Math.abs(dB(a) - dB(b)) < 0.1, `${name} ${side} @${pos}: ${a} vs ${b}`); else assert.ok(b < 1e-3);
      }
    }
    assert.deepEqual(xfSettings({ crossfaderCurve: name }), { ...LEGACY_XF[name], reverse: false, cutTime: 5 });
  }
});

test('M1: curve shapes: linear, constant power at 0.5, fast cut with cut-in at 1, monotonic, reverse mirrors', () => {
  // curve 0: each side a straight line (second difference 0 away from the knee)
  for (let i = 2; i < 98; i++) { const g = (k) => xfGain(-1 + k / 50, 'A', { curve: 0 }); if (Math.abs(i - 50) > 1) assert.ok(Math.abs(g(i + 1) - 2 * g(i) + g(i - 1)) < 1e-9); }
  // curve 0.5: each side fades on the constant-power (sin/cos) law, normalised to unity at the centre (+3 dB):
  // g(p)²/2 + sin²(pπ/2) = 1 on its fading half (today's Smooth; the other side holds unity there)
  for (let i = 0; i <= 100; i++) {
    const p = 0.5 + i / 200, a = xfGain(2 * p - 1, 'A', { curve: 0.5 }), b = xfGain(1 - 2 * p, 'B', { curve: 0.5 });
    for (const g of [a, b]) assert.ok(Math.abs(g * g / 2 + Math.sin(p * Math.PI / 2) ** 2 - 1) < 0.01, `power at ${p}`);
  }
  // curve 1, cut-in 2 %: the far side is silent inside the dead zone and at unity 1 % after it
  const cut = { curve: 1, cutIn: 0.02 };
  for (const pos of [-1, -0.99, -0.97]) assert.ok(dB(xfGain(pos, 'B', cut)) <= -80, `B silent at ${pos}`);
  assert.equal(xfGain(-1 + 2 * 0.031, 'B', cut), 1, 'B at unity 3.1 % from the A end (cut-in 2 % + 1 %)');
  // monotonic for every curve value, cut-in, and reverse is an exact mirror
  for (let c = 0; c <= 1.0001; c += 0.05) for (const cutIn of [0, 0.05]) {
    let prev = 2;
    for (let i = 0; i <= 400; i++) {
      const pos = -1 + i / 200, g = xfGain(pos, 'A', { curve: c, cutIn });
      assert.ok(g <= prev + 1e-12, `curve ${c} not monotonic at ${pos}`); prev = g;
      assert.equal(xfGain(pos, 'A', { curve: c, cutIn, reverse: true }), xfGain(-pos, 'A', { curve: c, cutIn }));
      assert.equal(xfGain(pos, 'B', { curve: c, cutIn, reverse: true }), xfGain(pos, 'A', { curve: c, cutIn }));
    }
  }
  assert.equal(xfGain(0.3, 'THRU', cut), 1);
});

// ---------------------------------------------------------------- M2 / M17 fader laws
test('M2: channel-fader curve tables and the cut curve; M17 rotary taper', () => {
  const table = { log: [-Infinity, -12.04, -6.02, -2.5, 0], linear: [-Infinity, -12.04, -6.02, -2.5, 0], cut: [-Infinity, 0, 0, 0, 0] };
  table.linear = [-Infinity, dB(0.25), dB(0.5), dB(0.75), 0];
  table.smooth = [-Infinity, dB(0.25 ** 3), dB(0.125), dB(0.75 ** 3), 0];
  table.log = [-Infinity, dB(0.0625), dB(0.25), dB(0.5625), 0];
  for (const [curve, want] of Object.entries(table)) [0, 0.25, 0.5, 0.75, 1].forEach((v, i) => {
    const got = dB(faderGain(v, curve));
    if (want[i] === -Infinity) assert.ok(got <= -80); else assert.ok(Math.abs(got - want[i]) < 0.1, `${curve} @${v}: ${got} vs ${want[i]}`);
  });
  for (const v of [0, 0.01, 0.029]) assert.ok(dB(faderGain(v, 'cut')) <= -80);
  assert.equal(faderGain(0.2, 'log', true), faderGain(0.8, 'log'));
  for (const [v, want] of [[1, 6.02], [0.8, 0.21], [0.5, -12.04], [0.25, -30.1]]) assert.ok(Math.abs(dB(rotaryGain(v)) - want) < 0.1, `rotary @${v}`);
  assert.ok(dB(rotaryGain(0)) <= -80);
});

test('M3: EQ knob laws: isolator unchanged, classic -26 dB then kill', () => {
  for (let v = -1; v <= 1; v += 0.01) assert.equal(isoKnobGain(v), eqKnobGain(v));
  assert.ok(Math.abs(classicKnobDb(-0.9) + 26) < 1e-9 && classicKnobDb(-1) <= -50 && Math.abs(classicKnobDb(1, true) - 6) < 1e-9);
  assert.ok(Math.abs(classicKnobDb(-1, false) + 26) < 1e-9);
});

test('M4: Center Lock stops a drag at 12 o\'clock; MIDI unlocks back in the dead zone', () => {
  const lock = centerLock({ mode: 'drag' });
  const out = []; for (let v = -0.5; v <= 0.5001; v += 0.01) out.push(lock.filter(v));
  assert.ok(Math.abs(out.at(-1)) <= 0.03, `drag ended at ${out.at(-1)}`);
  assert.ok(Math.max(...out) <= 0.03);
  lock.reset(); assert.equal(lock.filter(0.4), 0.4, 'a second drag from the centre crosses');
  const m = centerLock({ mode: 'midi' });
  m.filter(-0.6); assert.equal(m.filter(0.5), 0); assert.equal(m.filter(0.7), 0, 'still clamped');
  m.filter(0.01); assert.equal(m.filter(0.6), 0.6, 'unlocked after the dead zone');
});

// ---------------------------------------------------------------- M14 metering (EBU Tech 3341, BS.1770-4)
function meter(L, R, ch = 2) { const posts = []; runProc('opendj-meter', L, R, {}, { channels: ch, onMsg: (m) => posts.push(m) }); return posts; }
const concat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0), o = new Float32Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
const dbfs = (d) => Math.pow(10, d / 20);
test('M14: EBU 3341 case 1/2: 1 kHz stereo sine at -23 / -33 dBFS reads -23.0 / -33.0 LUFS (M, S, I)', () => {
  for (const lvl of [-23, -33]) {
    const x = sine(20, 1000, dbfs(lvl)), p = meter(x, x).at(-1);
    for (const k of ['m', 's', 'i']) assert.ok(Math.abs(p[k] - lvl) <= 0.1, `${lvl} dBFS: ${k} = ${p[k].toFixed(3)}`);
    console.log(`# meter: 1 kHz ${lvl} dBFS -> M ${p.m.toFixed(2)}, S ${p.s.toFixed(2)}, I ${p.i.toFixed(2)} LUFS`);
  }
});
test('M14: EBU 3341 case 3/4: gating (-36/-23/-36 and -72/-36/-23/-36/-72 dBFS) integrates to -23.0 LUFS', () => {
  const a = concat(sine(10, 1000, dbfs(-36)), sine(60, 1000, dbfs(-23)), sine(10, 1000, dbfs(-36)));
  const i1 = meter(a, a).at(-1).i;
  const b = concat(sine(10, 1000, dbfs(-72)), sine(10, 1000, dbfs(-36)), sine(60, 1000, dbfs(-23)), sine(10, 1000, dbfs(-36)), sine(10, 1000, dbfs(-72)));
  const i2 = meter(b, b).at(-1).i;
  assert.ok(Math.abs(i1 + 23) <= 0.1, `case 3: ${i1}`); assert.ok(Math.abs(i2 + 23) <= 0.1, `case 4: ${i2}`);
  console.log(`# meter: gated integrated ${i1.toFixed(2)} / ${i2.toFixed(2)} LUFS (ref -23.0)`);
});
test('M14: true peak of inter-sample overs within ±0.3 dB; sample peak would under-read by 3 dB', () => {
  for (const [f, ph, amp] of [[12000, Math.PI / 4, 1], [SR / 6, Math.PI / 6, 0.5], [997, 0, dbfs(-6)]]) {
    const x = sine(2, f, amp, ph), p = meter(x, x);
    const tp = Math.max(...p.map((q) => q.tp)), ref = dB(amp), sp = dB(Math.max(...p.map((q) => q.peak[0])));
    assert.ok(Math.abs(tp - ref) <= 0.3, `${f} Hz: true peak ${tp.toFixed(2)} vs ${ref.toFixed(2)} dBTP`);
    console.log(`# true peak ${f.toFixed(0)} Hz: ${tp.toFixed(2)} dBTP (reference ${ref.toFixed(2)}, sample peak ${sp.toFixed(2)} dBFS)`);
  }
});

// ---------------------------------------------------------------- M11 compressor
test('M11: compressor: exact pass-through at 0; at max the crest factor drops >= 4 dB, loudness within ±1.5 LU', () => {
  let x = drums(8);
  const lu = (y) => meter(y.subarray(SR * 2), y.subarray(SR * 2)).at(-1).i;
  const k = Math.pow(10, (-14 - lu(x)) / 20); x = x.map((v) => v * k); // a -14 LUFS programme
  const off = runProc('opendj-comp', x, x, { amount: 0 });
  let d = 0; for (let i = 0; i < x.length; i++) d = Math.max(d, Math.abs(off.L[i] - x[i]));
  assert.equal(d, 0, 'bit-identical at 0 (never engaged)');
  const on = runProc('opendj-comp', x, x, { amount: 1 });
  const crest = (y) => { const a = SR * 2; let pk = 0; for (let i = a; i < y.length; i++) pk = Math.max(pk, Math.abs(y[i])); return dB(pk / rms(y, a)); };
  const dc = crest(x) - crest(on.L), dl = lu(on.L) - lu(x);
  console.log(`# compressor at max: crest ${crest(x).toFixed(1)} -> ${crest(on.L).toFixed(1)} dB (-${dc.toFixed(1)} dB), loudness ${dl >= 0 ? '+' : ''}${dl.toFixed(2)} LU (input -14 LUFS)`);
  assert.ok(dc >= 4, `crest factor reduction ${dc}`);
  assert.ok(Math.abs(dl) <= 1.5, `loudness change ${dl}`);
  // engaged then back to 0: the input delayed by exactly the 2 ms look-ahead
  const back = runProc('opendj-comp', x, x, { amount: (t) => (t < 1 ? 1 : 0) });
  const L = Math.round(0.002 * SR); let e = 0; for (let i = 3 * SR; i < x.length; i++) e = Math.max(e, Math.abs(back.L[i] - x[i - L]));
  assert.ok(dB(e) <= -90, `null after turning it back to 0: ${dB(e)} dB`);
});

// ---------------------------------------------------------------- M16 warmth
test('M16: warmth: null at 0; ~1 % THD at half drive on a -14 dBFS 1 kHz sine, H2 > H3; loudness change <= 0.5 LU', () => {
  const x = sine(3, 1000, dbfs(-14));
  const z = runProc('opendj-warmth', x, x, { drive: 0 });
  let d = 0; for (let i = 0; i < x.length; i++) d = Math.max(d, Math.abs(z.L[i] - x[i]));
  assert.equal(d, 0, 'null at 0');
  const w = runProc('opendj-warmth', x, x, { drive: 0.5 });
  const a = SR, b = 3 * SR, f1 = goertzel(w.L, 1000, a, b), h2 = goertzel(w.L, 2000, a, b), h3 = goertzel(w.L, 3000, a, b);
  const thd = Math.hypot(h2, h3) / f1 * 100;
  const dl = meter(w.L, w.R).at(-1).i - meter(x, x).at(-1).i;
  console.log(`# warmth 0.5: THD ${thd.toFixed(2)} % (H2 ${dB(h2 / f1).toFixed(1)} dB, H3 ${dB(h3 / f1).toFixed(1)} dB), loudness ${dl.toFixed(3)} LU`);
  assert.ok(thd >= 0.5 && thd <= 1.5, `THD ${thd}`); assert.ok(h2 > h3); assert.ok(Math.abs(dl) <= 0.5);
});

// ---------------------------------------------------------------- M5 pitch shift
test('M5: pitch shifter: ratio 2 gives 2x frequency ± 0.5 %', () => {
  const x = sine(2, 440, 0.5), y = runProc('opendj-pitch', x, x, { ratio: 2 }).L;
  let best = 0, bf = 0; for (let f = 840; f <= 920; f += 0.5) { const m = goertzel(y, f, SR / 2, 2 * SR); if (m > best) { best = m; bf = f; } }
  console.log(`# pitch shift x2 of 440 Hz -> ${bf} Hz (${((bf / 880 - 1) * 100).toFixed(2)} %)`);
  assert.ok(Math.abs(bf / 880 - 1) <= 0.005);
});

// ---------------------------------------------------------------- M8 auto talkover
test('M8: auto talkover reaches -depth ± 1 dB within 15 ms of a -20 dBFS voice burst and releases within 400 ms', () => {
  const n = SR * 2, v = new Float32Array(n);
  for (let i = SR / 2; i < SR; i++) v[i] = dbfs(-20) * Math.sin(2 * Math.PI * 180 * i / SR) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 5 * i / SR));
  const r = runProc('opendj-ducker', v, v, { threshold: -36, depth: -12, auto: 1, manual: 0, band: 0, hold: 0.12 });
  const g = (i) => 1 + r.L[i];
  let reach = -1; for (let i = SR / 2; i < n; i++) if (dB(g(i)) <= -11) { reach = (i - SR / 2) / SR; break; }
  let release = -1; for (let i = SR; i < n; i++) if (dB(g(i)) >= -1) { release = (i - SR) / SR; break; }
  const held = dB(g(Math.round(0.9 * SR)));
  console.log(`# auto talkover: -12 dB reached in ${(reach * 1e3).toFixed(1)} ms (held ${held.toFixed(2)} dB), released in ${(release * 1e3).toFixed(0)} ms`);
  assert.ok(reach >= 0 && reach <= 0.015 && Math.abs(held + 12) <= 1 && release > 0 && release <= 0.4);
  // band mode: the full-duck channel stays at 0, the voice-band channel carries the duck
  const b = runProc('opendj-ducker', v, v, { threshold: -36, depth: -12, auto: 1, manual: 0, band: 1, hold: 0.12 });
  assert.equal(Math.max(...b.L.map(Math.abs)), 0); assert.ok(Math.min(...b.R) < -0.7);
});

// ---------------------------------------------------------------- §5 personalities, settings migration
const { PERSONALITIES, personalityState, suggestPersonality } = await import('../public/js/audio/personalities.js');
const { normalizeMixer, MIXER_DEFAULTS } = await import('../public/js/audio/mixer-config.js');
const { sanitizeSetting } = await import('../public/js/shared/settings-schema.js');
test('§5: each personality maps to the plan table (snapshot)', () => {
  const pick = (id) => { const m = PERSONALITIES[id].mixer; return { eq: m.eqType, filter: m.filterMode, centerLock: m.centerLock, xf: [m.xfCurve, m.xfCutIn, m.xfCutTime, m.hideXfader], fader: m.rotary ? 'rotary' : m.faderCurve, iso: m.showMasterIso, booth: m.showBooth, comp: m.showComp, rev: m.revVisible, color: !m.colorHidden }; };
  assert.deepEqual(pick('club'), { eq: 'isolator', filter: 'oneKnob', centerLock: false, xf: [0.5, 0, 5, false], fader: 'log', iso: false, booth: false, comp: false, rev: false, color: true });
  assert.deepEqual(pick('classic'), { eq: 'classic', filter: 'oneKnob', centerLock: true, xf: [0.5, 0, 5, false], fader: 'log', iso: false, booth: true, comp: true, rev: false, color: true });
  assert.deepEqual(pick('rotary'), { eq: 'rotaryIso', filter: 'dual', centerLock: false, xf: [0.5, 0, 5, true], fader: 'rotary', iso: true, booth: false, comp: false, rev: false, color: false });
  assert.deepEqual(pick('battle'), { eq: 'battle', filter: 'oneKnob', centerLock: false, xf: [1, 0.02, 1, false], fader: 'cut', iso: false, booth: false, comp: false, rev: true, color: true });
  assert.equal(PERSONALITIES.rotary.knobs.warmth, 0.25);
  // the defaults are Club: a fresh install shows "Club", a changed curve "Custom (based on Club)"
  const fresh = normalizeMixer({});
  assert.equal(personalityState(fresh).label, 'Club');
  assert.equal(personalityState({ ...fresh, xfCurve: 0.8 }).label, 'Custom (based on Club)');
});
test('§5: suggestion chip: Rotary for a minimal queue, Battle for hip-hop, none for house; needs 70 % and 3 tracks', () => {
  const q = (...g) => g.map((genre, i) => ({ id: `t${i}`, genre }));
  assert.equal(suggestPersonality(q('Minimal', 'Rominimal', 'Minimal Techno', 'Micro House'))?.id, 'rotary');
  assert.equal(suggestPersonality(q('Hip-Hop', 'Hip Hop', 'Turntablism', 'House'))?.id, 'battle');
  assert.equal(suggestPersonality(q('House', 'Tech House', 'Techno')), null);
  assert.equal(suggestPersonality(q('Minimal', 'Minimal')), null, 'too few tracks');
  assert.equal(suggestPersonality(q('Minimal', 'Minimal', 'House', 'House')), null, 'below 70 %');
  assert.equal(suggestPersonality(q('Minimal', 'Minimal', 'Minimal'), 'rotary'), null, 'already active');
});
test('settings: crossfaderCurve migrates into the continuous crossfader; settings.mixer is validated', () => {
  assert.equal(normalizeMixer({ crossfaderCurve: 'sharp' }).xfCurve, 0.9);
  assert.equal(normalizeMixer({ crossfaderCurve: 'constant' }).xfCurve, 0);
  assert.equal(normalizeMixer({ crossfaderCurve: 'sharp', mixer: { xfCurve: 0.3 } }).xfCurve, 0.3, 'a stored continuous curve wins');
  assert.equal(normalizeMixer({}).eqType, MIXER_DEFAULTS.eqType);
  const r = sanitizeSetting('mixer', { eqType: 'rotaryIso', xfCutTime: 100, personality: 'battle', fx1: { assign: 'bogus', quantize: true } });
  assert.deepEqual(r.value, { eqType: 'rotaryIso', personality: 'battle', fx1: { quantize: true } });
  assert.equal(sanitizeSetting('theme', 'booth').ok, true);
});
