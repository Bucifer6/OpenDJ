// Effects quality checks: renders the real FX unit / mixer channel / limiter / deck worklet offline in Chromium
// (scripts/fx/fxlab.mjs) and measures clicks, levels, tempo sync, EQ kills, limiter ceiling and tails.
// Usage: node scripts/e2e-fx.mjs [--render=<dir>]   (--render also writes WAVs + spectrograms of the renders)
import path from 'node:path';
import { openLab, rms, peak, maxJump, maxCurv, stepRatio, onsets, bandLevel, db, writeWav, spectrogram } from './fx/fxlab.mjs';

const argv = process.argv.slice(2);
const OUT = argv.find((a) => a.startsWith('--render='))?.slice(9);
const lab = await openLab();
let failed = false;
const check = (c, msg) => { console.log(`${c ? 'ok' : 'FAIL'} - ${msg}`); if (!c) failed = true; };
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
const save = (name, r) => { if (!OUT) return; const w = path.join(OUT, `${name}.wav`); writeWav(w, r.L, r.R, r.sr); spectrogram(w, path.join(OUT, `${name}.png`)); };
const sweep = (t0, t1, a, b, mk, step = 0.016) => { const ev = []; for (let t = t0; t <= t1 + 1e-9; t += step) ev.push({ t, ...mk(a + (b - a) * (t - t0) / (t1 - t0)) }); return ev; };
const SINE = { signal: 'sine', signalOpts: { f: 220, amp: 0.5 } };
const SINE_JUMP = 2 * Math.PI * 220 * 0.5 / 48000; // largest sample step of the clean test sine
const SINE_RATIO = 2 * Math.PI * 220 / 48000; // stepRatio() of a clean 220 Hz sine at any level
let cpuMs = 0, cpuSec = 0;

try {
  // ---------------------------------------------------------------- beat FX: clicks, zipper, level
  const NOISY = new Set(['bitcrush', 'noise', 'distortion']); // these make steps / noise by design: compare to their own steady state
  for (const { id, label, kind } of lab.effects) {
    const init = [{ call: 'setBeatSec', args: [0.5] }, { call: 'setType', args: [id] }, { call: 'setMix', args: [0.5] }, { call: 'setParam', args: [0.5] }, { call: 'setParam2', args: [0.5] }, { call: 'setBeats', args: [0.5] }, { call: 'setClock', args: [0, 0, 0.5] }];
    const s = await lab.render({ chain: 'fx', ...SINE, secs: 3, init, events: [{ t: 1, call: 'setOn', args: [true] }, { t: 2, call: 'setOn', args: [false] }] });
    cpuMs += s.ms; cpuSec += 3;
    const steady = maxJump(s.L, s.sr, 1.5, 1.95), ref = NOISY.has(id) ? steady : Math.max(steady, SINE_JUMP);
    const jOn = maxJump(s.L, s.sr, 0.995, 1.2), jOff = maxJump(s.L, s.sr, 1.995, 2.2);
    check(jOn <= ref * 1.3 + 1e-3 && jOff <= Math.max(ref, maxJump(s.L, s.sr, 2.4, 2.9)) * 1.3 + 1e-3, `${label}: no click at on/off (max step on ${f(jOn * 1e3)}, off ${f(jOff * 1e3)}, steady ${f(ref * 1e3)} ×1e-3)`);
    // knob sweeps while on: no zipper
    const z = await lab.render({ chain: 'fx', ...SINE, secs: 3, init: [...init, { call: 'setOn', args: [true] }], events: [...sweep(0.8, 1.6, 0, 1, (v) => ({ call: 'setParam', args: [v] })), ...sweep(1.6, 2.4, 0, 1, (v) => ({ call: 'setParam2', args: [v] })), ...sweep(2.4, 2.9, 1, 0, (v) => ({ call: 'setMix', args: [v] }))] });
    const zj = stepRatio(z.L, z.sr, 0.8, 3), zref = NOISY.has(id) ? 2 : Math.max(stepRatio(z.L, z.sr, 0.3, 0.75), SINE_RATIO) * (id === 'trans' ? 2.5 : 1.6); // Trans: gate edges
    check(zj <= zref, `${label}: no zipper noise sweeping PARAM / P2 / MIX (step ratio ${f(zj, 3)} ≤ ${f(zref, 3)})`);
    // loudness on music: within ±1.5 dB of dry for insert effects at mix 0.5 (send effects add their wet on top)
    const m = await lab.render({ chain: 'fx', signal: 'drums', secs: 4, init, events: [{ t: 2, call: 'setOn', args: [true] }] });
    const dLvl = db(rms(m.L, m.sr, 2.3, 4) / rms(m.L, m.sr, 0.3, 2));
    if (kind === 'insert') check(Math.abs(dLvl) <= 1.5, `${label}: level within ±1.5 dB of dry when on (${f(dLvl)} dB)`);
    else check(dLvl > -1.5 && dLvl < 3, `${label}: dry kept, wet added (${f(dLvl)} dB)`);
    save(`beatfx-${id}`, m);
  }

  // ---------------------------------------------------------------- echo: tempo sync and echo-out tail
  for (const [beats, bpm] of [[1, 128], [0.75, 128], [0.5, 174], [1 / 8, 90], [2, 124]]) {
    const sec = 60 / bpm, exp = sec * beats;
    for (const type of ['echo', 'pingpong']) {
      const init = [{ call: 'setBeatSec', args: [sec] }, { call: 'setType', args: [type] }, { call: 'setMix', args: [1] }, { call: 'setParam', args: [0.4] }, { call: 'setBeats', args: [beats] }, { call: 'setOn', args: [true] }];
      const r = await lab.render({ chain: 'fx', signal: 'burst', signalOpts: { at: 0.5 }, secs: Math.min(6, 0.6 + exp * 5), init });
      const mono = r.L.map((v, i) => v + r.R[i]);
      const o = onsets(mono, r.sr, 0.01, Math.min(0.05, exp * 0.5), 0.45);
      const gaps = o.slice(1, 5).map((t, i) => t - o[i]);
      const err = gaps.length >= 3 ? Math.max(...gaps.map((g) => Math.abs(g - exp))) : Infinity;
      check(err < 0.001, `${type} ${beats} beat @ ${bpm} BPM: echo period ${gaps.map((g) => f(g * 1e3)).join('/')} ms vs ${f(exp * 1e3)} ms (max error ${f(err * 1e3, 3)} ms)`);
    }
  }
  for (const type of ['echo', 'reverb', 'pingpong']) {
    const init = [{ call: 'setBeatSec', args: [0.5] }, { call: 'setType', args: [type] }, { call: 'setMix', args: [0.7] }, { call: 'setParam', args: [0.6] }, { call: 'setBeats', args: [0.75] }];
    const r = await lab.render({ chain: 'fx', signal: 'drums', signalOpts: { until: 2.0 }, secs: 9, init, events: [{ t: 1, call: 'setOn', args: [true] }, { t: 1.6, call: 'setOn', args: [false] }] });
    const tail = rms(r.L, r.sr, 2.1, 2.6), late = rms(r.L, r.sr, 8.5, 9), dry = rms(r.L, r.sr, 0.3, 1);
    check(db(tail / dry) > -24 && db(late / dry) < -60, `${type}: tail rings on after FX off + deck stop and decays (${f(db(tail / dry))} dB at +0.1 s, ${f(db(late / dry))} dB at +6.5 s)`);
    save(`tail-${type}`, r);
  }

  // ---------------------------------------------------------------- full-mix loudness of insert effects (QA p3)
  for (const id of ['autofilter', 'flanger', 'phaser']) {
    const init = [{ call: 'setBeatSec', args: [0.5] }, { call: 'setType', args: [id] }, { call: 'setMix', args: [1] }, { call: 'setParam', args: [0.5] }, { call: 'setParam2', args: [0.5] }];
    const m = await lab.render({ chain: 'fx', signal: 'drums', secs: 4, init, events: [{ t: 2, call: 'setOn', args: [true] }] });
    const dLvl = db(rms(m.L, m.sr, 2.3, 4) / rms(m.L, m.sr, 0.3, 2));
    check(Math.abs(dLvl) <= 2, `${id} at full mix: level within ±2 dB of dry on music (${f(dLvl)} dB)`);
  }

  // ---------------------------------------------------------------- post-fader FX tails (echo-outs)
  {
    // a whole mixer channel playing drums with an echo / reverb on; at 2.0 s the channel fader (or the crossfader)
    // closes while the music keeps playing. Post-fader (default): the dry signal is gone at once, the tail rings on
    // and decays. Pre-fader (setting off): the fader cuts the tail too.
    const fxInit = (type) => [{ call: 'setBeatSec', args: [0.5] }, { call: 'set', args: ['fxType', type] }, { call: 'set', args: ['fxMix', 0.7] }, { call: 'set', args: ['fxParam', 0.6] }, { call: 'set', args: ['fxBeats', 0.75] }, { call: 'set', args: ['fxOn', true] }];
    const close = { fader: { t: 2, call: 'set', args: ['volume', 0] }, crossfader: { t: 2, call: 'setXfGain', args: [0] } };
    const dryRef = await lab.render({ chain: 'channel', signal: 'drums', secs: 4, events: [close.fader] });
    const dry0 = rms(dryRef.L, dryRef.sr, 0.3, 1.9), dryAfter = rms(dryRef.L, dryRef.sr, 2.1, 4);
    check(db(dryAfter / dry0) < -80, `fader down without FX: the channel is silent (${f(db(dryAfter / dry0))} dB)`);
    for (const type of ['echo', 'reverb']) for (const how of ['fader', 'crossfader']) {
      const r = await lab.render({ chain: 'channel', signal: 'drums', secs: 10, init: fxInit(type), events: [close[how]] });
      const ref = rms(r.L, r.sr, 0.3, 1.9);
      const w = [[2.05, 2.55], [3.5, 4], [5.5, 6], [9.4, 9.9]].map(([a, b]) => db(rms(r.L, r.sr, a, b) / ref));
      const decays = w[0] > -24 && w[1] < w[0] && w[2] < w[1] && w[3] < -60;
      // the track keeps playing into the closed fader: if any dry signal got through, the last window would stay near 0 dB
      check(decays, `post-fader ${type}, ${how} closed during the effect: tail present and decaying (${w.map((x) => f(x, 1)).join(' → ')} dB), dry signal gone`);
      if (how === 'fader') save(`postfader-${type}`, r);
    }
    // pre-fader setting: the fader cuts the tail as before
    const pre = await lab.render({ chain: 'channel', settings: { fxPostFader: false }, signal: 'drums', secs: 4, init: fxInit('echo'), events: [close.fader] });
    const preTail = db(rms(pre.L, pre.sr, 2.1, 4) / rms(pre.L, pre.sr, 0.3, 1.9));
    check(preTail < -80, `pre-fader setting: the fader cuts the echo tail (${f(preTail)} dB)`);
    // (offline renders of the worklet effects differ run to run by ~4e-4 peak, -60 dB: compare with that margin)
    const same = (a, b) => { let d = 0, e = 0, r0 = 0; for (let i = 0; i < a.L.length; i++) { const x = a.L[i] - b.L[i]; d = Math.max(d, Math.abs(x)); e += x * x; r0 += a.L[i] * a.L[i]; } return { d, rel: db(Math.sqrt(e / (r0 || 1))) }; };
    // nothing doubles, neutral levels unchanged: with the fader up, post- and pre-fader renders are the same signal
    for (const type of ['echo', 'reverb', 'flanger', 'distortion']) {
      const init = [...fxInit(type), { call: 'set', args: ['volume', 1] }];
      const a = await lab.render({ chain: 'channel', signal: 'drums', secs: 3, init });
      const b = await lab.render({ chain: 'channel', settings: { fxPostFader: false }, signal: 'drums', secs: 3, init });
      const { d, rel } = same(a, b);
      const lv = db(rms(a.L, a.sr, 0.5, 3) / rms(b.L, b.sr, 0.5, 3));
      check(d < 3e-3 && rel < -50 && Math.abs(lv) < 0.05, `${type} with the fader open: post-fader and pre-fader routing give the same signal (difference ${f(rel, 0)} dB, level ${f(lv, 3)} dB)`);
    }
    {
      const off = await lab.render({ chain: 'channel', signal: 'drums', secs: 3 });
      const offPre = await lab.render({ chain: 'channel', settings: { fxPostFader: false }, signal: 'drums', secs: 3 });
      const { rel } = same(off, offPre), lv = db(rms(off.L, off.sr, 0.5, 1.9) / rms(dryRef.L, dryRef.sr, 0.5, 1.9));
      check(rel < -50 && Math.abs(lv) < 0.05, `FX off: the channel output is unchanged by the routing (difference ${f(rel, 0)} dB, level ${f(lv, 3)} dB)`);
    }
    // switching the setting while an echo rings: no click, no level jump
    const sw = await lab.render({ chain: 'channel', ...SINE, secs: 3, init: fxInit('echo'), events: [{ t: 1, call: 'setFxPostFader', args: [false] }, { t: 2, call: 'setFxPostFader', args: [true] }] });
    const swRef = maxJump(sw.L, sw.sr, 0.4, 0.95);
    check(maxJump(sw.L, sw.sr, 0.95, 2.3) <= swRef * 1.3 + 1e-3, `switching pre-/post-fader while the echo rings is click-free (max step ${f(maxJump(sw.L, sw.sr, 0.95, 2.3) * 1e3)} vs ${f(swRef * 1e3)} ×1e-3)`);
  }

  // ---------------------------------------------------------------- beat-locked LFO (Trans) follows the grid
  {
    const init = [{ call: 'setBeatSec', args: [0.5] }, { call: 'setType', args: ['trans'] }, { call: 'setMix', args: [1] }, { call: 'setParam', args: [1] }, { call: 'setParam2', args: [0.5] }, { call: 'setBeats', args: [0.5] }, { call: 'setClock', args: [0, 0, 0.5] }, { call: 'setOn', args: [true] }];
    const r = await lab.render({ chain: 'fx', signal: 'sine', signalOpts: { f: 3000, amp: 0.5 }, secs: 3, init });
    const edges = []; let prev = 0;
    for (let i = 0, w = 48; i + w < r.L.length; i += 12) { const on = peak(r.L, r.sr, i / r.sr, (i + w) / r.sr) > 0.25; if (on && !prev && i / r.sr > 0.5) edges.push(i / r.sr); prev = on; }
    const err = Math.max(...edges.slice(0, 6).map((t) => Math.abs(((t + 0.125) % 0.25) - 0.125)));
    check(edges.length >= 6 && err < 0.004, `Trans gate opens on the 1/8-note grid (edges ${edges.slice(0, 4).map((t) => f(t, 3)).join(', ')} s, max off-grid ${f(err * 1e3)} ms)`);
  }

  // ---------------------------------------------------------------- EQ
  const freqs = [40, 60, 100, 300, 500, 700, 1000, 1500, 4000, 6000, 8000, 12000];
  const eq = async (set) => {
    const r = await lab.render({ chain: 'channel', signal: 'multitone', signalOpts: { freqs, amp: 0.03 }, secs: 2.2, init: Object.entries(set).map(([k, v]) => ({ call: 'set', args: [k, v] })) });
    return Object.fromEntries(freqs.map((q) => [q, db(bandLevel(r.L, r.sr, q, 1.2, 2.2) / 0.03 / 0.64)])); // fader 0.8 -> 0.64
  };
  const flat = await eq({});
  const dev = Math.max(...Object.values(flat).map(Math.abs));
  check(dev < 0.1, `EQ flat at 12 o'clock (max deviation ${f(dev, 3)} dB over ${freqs[0]} Hz–${freqs.at(-1) / 1000} kHz)`);
  for (const [band, key, qs] of [['low', 'eqLow', [40, 60, 100]], ['mid', 'eqMid', [500, 700, 1000]], ['high', 'eqHigh', [6000, 8000, 12000]]]) {
    const k = await eq({ [key]: -1 });
    const att = Math.min(...qs.map((q) => -k[q]));
    check(att > 40, `${band} kill attenuates > 40 dB in band (${qs.map((q) => `${q} Hz ${f(k[q], 1)}`).join(', ')} dB)`);
  }
  {
    const b = await lab.render({ chain: 'eq2', signal: 'multitone', signalOpts: { freqs, amp: 0.02 }, secs: 2.2, init: [{ on: 'b', call: 'set', args: ['eqMid', -0.2] }] });
    const lo = db(bandLevel(b.L, b.sr, 60, 1.2, 2.2) / 0.02 / 0.64);
    check(Math.abs(lo - 6.02) < 0.2, `two decks blended at neutral bass sum coherently (+${f(lo)} dB at 60 Hz, ideal +6.02)`);
    const k = await lab.render({ chain: 'channel', signal: 'sine', signalOpts: { f: 80, amp: 0.5 }, secs: 3, events: [{ t: 1, call: 'set', args: ['eqLow', -1] }, { t: 2, call: 'set', args: ['eqLow', 0] }] });
    check(maxJump(k.L, k.sr, 0.9, 2.5) <= maxJump(k.L, k.sr, 0.2, 0.8) * 1.05 + 1e-4, 'EQ kill on/off is click-free');
  }

  // ---------------------------------------------------------------- filter + Color FX
  for (const color of ['filter', 'space', 'dubecho', 'noise', 'crush', 'pitch']) {
    const p = await lab.render({ chain: 'channel', settings: { colorFx: color }, signal: 'multitone', signalOpts: { freqs: [30, 100, 1000, 5000, 12000, 18000], amp: 0.05 }, secs: 1.5 });
    const lv0 = [30, 100, 1000, 5000, 12000, 18000].map((q) => db(bandLevel(p.L, p.sr, q, 0.5, 1.5) / 0.05 / 0.64));
    check(Math.max(...lv0.map(Math.abs)) < 0.05, `${color}: knob at 12 o'clock leaves the sound untouched (30 Hz–18 kHz within ${f(Math.max(...lv0.map(Math.abs)), 3)} dB)`);
    const ev = [...sweep(0.8, 1.8, 0, -1, (v) => ({ call: 'set', args: ['filter', v] })), ...sweep(1.8, 2.2, -1, 0, (v) => ({ call: 'set', args: ['filter', v] })), ...sweep(2.2, 3.2, 0, 1, (v) => ({ call: 'set', args: ['filter', v] })), ...sweep(3.2, 3.6, 1, 0, (v) => ({ call: 'set', args: ['filter', v] }))];
    const s = await lab.render({ chain: 'channel', settings: { colorFx: color }, ...SINE, secs: 4, events: ev });
    const j = stepRatio(s.L, s.sr, 0.8, 3.9);
    const lim = color === 'crush' || color === 'noise' ? 2 : SINE_RATIO * 1.6;
    check(j <= lim, `${color}: knob sweep without clicks / zipper (step ratio ${f(j, 3)} ≤ ${f(lim, 3)})`);
    const m = await lab.render({ chain: 'channel', settings: { colorFx: color }, signal: 'drums', secs: 6, events: sweep(1, 2.5, 0, -0.7, (v) => ({ call: 'set', args: ['filter', v] })).concat(sweep(2.5, 3.5, -0.7, 0.7, (v) => ({ call: 'set', args: ['filter', v] }))) });
    const lv = db(rms(m.L, m.sr, 2.5, 3.5) / rms(m.L, m.sr, 0.2, 1));
    check(lv > -12 && lv < 4, `${color}: loudness stays sensible across the knob (${f(lv)} dB)`);
    save(`color-${color}`, m);
  }

  // ---------------------------------------------------------------- master limiter
  {
    const quiet = await lab.render({ chain: 'limiter', signal: 'drums', signalOpts: { gain: 0.5 }, secs: 3, returnDry: true });
    const lat = Math.round(0.003 * 48000);
    let maxDiff = 0; for (let i = lat; i < quiet.L.length; i++) maxDiff = Math.max(maxDiff, Math.abs(quiet.L[i] - quiet.dry[0][i - lat]));
    check(maxDiff < 1e-6, `limiter is bit-transparent below the ceiling (max difference ${maxDiff.toExponential(1)})`);
    for (const g of [2, 4, 8]) {
      const r = await lab.render({ chain: 'limiter', signal: 'drums', signalOpts: { gain: g }, secs: 4 });
      const pk = Math.max(peak(r.L, r.sr), peak(r.R, r.sr));
      const ceil = Math.pow(10, -1 / 20);
      check(pk <= ceil + 1e-6, `limiter holds -1 dBFS with +${f(db(g), 0)} dB of drive (peak ${f(db(pk))} dBFS)`);
      // pumping: level of the pad between kicks should not swing much
      if (g === 2) save('limiter-drums-x2', r);
    }
  }

  // ---------------------------------------------------------------- deck worklet: transport / performance FX
  {
    const play = [{ msg: { type: 'rate', value: 1 } }, { msg: { type: 'play', value: true } }];
    const base = SINE_JUMP * 1.02;
    const t = await lab.render({ chain: 'deck', ...SINE, secs: 4, init: play, events: [
      { t: 0.6, msg: { type: 'play', value: false } }, { t: 0.9, msg: { type: 'play', value: true } },
      { t: 1.3, msg: { type: 'seek', frame: 48000 * 0.3127 } },
      { t: 1.6, msg: { type: 'loop', value: { start: 48000 * 0.95, end: 48000 * (0.95 + 0.0937) } } }, { t: 2.2, msg: { type: 'loop', value: null } },
      { t: 2.5, msg: { type: 'slip', value: true } }, { t: 2.5, msg: { type: 'reverse', value: true } }, { t: 3.0, msg: { type: 'reverse', value: false } }, { t: 3.0, msg: { type: 'slip', value: false } },
    ] });
    // a step or kink shows up in the 2nd difference; the clean sine's is A·ω² = 0.41e-3, a 4 ms fade adds little
    const curv = maxCurv(t.L, t.sr, 0.1, 4), cl = 0.5 * SINE_RATIO ** 2 * 4;
    check(maxJump(t.L, t.sr, 0.1, 4) <= base * 1.3 && curv <= cl, `deck pause / play / hot-cue jump / loop roll / censor are click-free (2nd difference ${f(curv * 1e3, 3)} ≤ ${f(cl * 1e3, 3)} ×1e-3)`);
    const b = await lab.render({ chain: 'deck', ...SINE, secs: 3, init: play, events: [{ t: 0.5, msg: { type: 'brake', value: 1 / (1.2 * 48000) } }] });
    const stopAt = (() => { for (let i = b.L.length - 1; i > 0; i--) if (Math.abs(b.L[i]) > 1e-4) return i / b.sr; return 0; })();
    check(maxJump(b.L, b.sr, 0.1, 3) <= base && Math.abs(stopAt - 1.7) < 0.08, `brake: smooth spin-down, silent stop after 1.2 s (stopped at ${f(stopAt - 0.5)} s, max step ${f(maxJump(b.L, b.sr, 0.1, 3) * 1e3)})`);
    save('deck-brake', b);
    const s = await lab.render({ chain: 'deck', signal: 'drums', secs: 3, init: play, events: [{ t: 0.8, msg: { type: 'backspin', seconds: 1, speed: 4.5 } }] });
    const after = rms(s.L, s.sr, 2.2, 3);
    check(after < 1e-5 && rms(s.L, s.sr, 0.9, 1.3) > 0.01, `backspin: spins back, then stops (rms after ${after.toExponential(1)})`);
    save('deck-backspin', s);
  }
  // ---------------------------------------------------------------- CPU: the whole 4-channel mixer, every channel busy
  {
    const heavy = [];
    [['reverb', 'space', -0.4], ['flanger', 'pitch', 0.35], ['phaser', 'dubecho', -0.5], ['trans', 'crush', 0.3]].forEach(([fx, color, filt], i) => {
      heavy.push({ on: String(i), call: 'set', args: ['fxType', fx] }, { on: String(i), call: 'set', args: ['fxOn', true] }, { on: String(i), call: 'set', args: ['colorFx', color] }, { on: String(i), call: 'set', args: ['filter', filt] }, { on: String(i), call: 'set', args: ['eqLow', -0.3] });
    });
    const plain = await lab.render({ chain: 'mixer4', signal: 'drums', signalOpts: { gain: 0.4 }, secs: 10 });
    const busy = await lab.render({ chain: 'mixer4', signal: 'drums', signalOpts: { gain: 0.4 }, secs: 10, init: heavy });
    const load = busy.ms / 10000;
    console.log(`# 4-channel mixer + limiter offline: ${f(plain.ms / 100, 1)} % of one core with FX off, ${f(load * 100, 1)} % with reverb/flanger/phaser/trans + Space/Jet/Dub Echo/Crush on all four channels`);
    check(load < 0.35, `whole mixer with every effect busy renders ${f(1 / load, 1)}x faster than real time (no dropouts)`);
    check(Math.max(peak(busy.L, busy.sr), peak(busy.R, busy.sr)) <= Math.pow(10, -1 / 20) + 1e-6, 'and the master stays under the limiter ceiling');
  }
  console.log(`# offline render cost of the beat FX: ${f(cpuMs / cpuSec / 10, 2)} % of one core per FX unit (incl. test signal)`);
} catch (e) {
  console.error(e); failed = true;
} finally {
  if (lab.errors.length) { console.log('page errors:', lab.errors); failed = true; }
  await lab.close();
}
process.exit(failed ? 1 : 0);
