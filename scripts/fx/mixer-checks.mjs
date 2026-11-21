// Mixer v2 objective checks (plan §4 acceptance criteria), rendered offline in Chromium through scripts/fx/fxlab.mjs:
// crossfader cut lag / curves, fader curves, EQ preset responses, dual filter, Color FX, booth routing on a 6-channel
// device, cue A/B / post-fader cue / sampler cue, mic FX latency, auto / voice-band talkover, feedback reducer,
// voice bus, FX units (master insert, frequency bands, strip, quantise), send / return, master isolator, balance /
// mono / ceiling, record mix, warmth, rotary smoothing, personality switching, whole-mixer CPU.
import { rms, peak, maxJump, onsets, bandLevel, db } from './fxlab.mjs';
import { xfGain } from '../../public/js/audio/curves.js';

const SR = 48000, Q = 128 / SR;
const cplx = (x, f, t0, t1) => { const a = Math.round(t0 * SR), b = Math.round(t1 * SR); let re = 0, im = 0; for (let i = a; i < b; i++) { const w = 2 * Math.PI * f * i / SR; re += x[i] * Math.cos(w); im += x[i] * Math.sin(w); } return [2 * re / (b - a), 2 * im / (b - a)]; };
const qt = (t) => Math.round(t / Q) * Q; // event times land on render quanta
// RBJ / Web Audio biquad magnitude (for the shelving EQ presets' target curves)
function bqMag(type, f0, G, Qv, f) {
  const A = 10 ** (G / 40), w = 2 * Math.PI * f0 / SR, c = Math.cos(w), s = Math.sin(w); let b0, b1, b2, a0, a1, a2;
  if (type === 'lowshelf') { const r = 2 * Math.sqrt(A) * s / 2 * Math.SQRT2; b0 = A * ((A + 1) - (A - 1) * c + r); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - r); a0 = (A + 1) + (A - 1) * c + r; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - r; }
  else if (type === 'highshelf') { const r = 2 * Math.sqrt(A) * s / 2 * Math.SQRT2; b0 = A * ((A + 1) + (A - 1) * c + r); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - r); a0 = (A + 1) - (A - 1) * c + r; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - r; }
  else { const al = s / (2 * Qv); b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A; }
  const W = 2 * Math.PI * f / SR, cr = (p0, p1, p2) => [p0 + p1 * Math.cos(W) + p2 * Math.cos(2 * W), -p1 * Math.sin(W) - p2 * Math.sin(2 * W)];
  const [nr, ni] = cr(b0, b1, b2), [dr, di] = cr(a0, a1, a2);
  return 20 * Math.log10(Math.hypot(nr, ni) / Math.hypot(dr, di));
}

export async function mixerChecks(lab, check, f, M = {}) {
  const set = (k, v, on) => (on ? { on, call: 'set', args: [k, v] } : { call: 'set', args: [k, v] });
  const lv = (r, fq, t0, t1, ch = r.L) => db(bandLevel(ch, r.sr, fq, t0, t1));

  // ---------------------------------------------------------------- M1 crossfader: fast cut lag, click, curves
  for (const ms of [1, 5]) {
    const r = await lab.render({ chain: 'channel', settings: { mixer: { xfCutTime: ms } }, signal: 'sine', signalOpts: { f: 1000, amp: 0.5 }, secs: 1.3, events: [{ t: 1, call: 'setXfGain', args: [0] }] });
    const ref = peak(r.L, r.sr, 0.5, 0.99), thr = ref * 1e-3, t0 = qt(1);
    let last = 0; for (let i = r.L.length - 1; i > 0; i--) if (Math.abs(r.L[i]) > thr) { last = i; break; }
    const lag = (last + 1) / r.sr - t0, step = maxJump(r.L, r.sr, t0 - 0.002, t0 + 0.02) / maxJump(r.L, r.sr, 0.5, 0.99);
    M[`xfCut${ms}`] = { lagMs: lag * 1e3, step };
    check(lag <= ms / 1000 + Q + 1e-4 && step <= 1.05, `crossfader cut time ${ms} ms: -60 dB after ${f(lag * 1e3)} ms (limit ${f(ms + Q * 1e3)} ms; the old 4 ms time constant took 27.6 ms), largest step ${f(step, 3)}x the clean 1 kHz signal's`);
  }
  {
    // curves through the engine: channel 2 (B side) level at crossfader positions vs the curve maths
    const pos = [-1, -0.97, -1 + 2 * 0.031, -0.5, 0, 0.5, 1];
    const run = (mixer) => lab.render({ chain: 'engine', settings: { mixer }, sources: [{ signal: 'sine', signalOpts: { f: 440, amp: 0.1 }, to: 'ch1' }], tap: 'music', secs: 0.15 * pos.length + 0.1, events: pos.map((p, i) => ({ t: 0.05 + 0.15 * i, call: 'setCrossfader', args: [p] })) });
    for (let [name, mixer, want] of [['smooth (club)', { xfCurve: 0.5 }, null], ['fast cut, 2 % cut-in (battle)', { xfCurve: 1, xfCutIn: 0.02, xfCutTime: 1 }, [0, 0, 1, 1, 1, 1, 1]], ['fast cut + reverse (hamster)', { xfCurve: 1, xfCutIn: 0.02, xfCutTime: 1, xfReverse: true }, [1, 1, 1, 1, 1, 1, 0]]]) {
      const r = await run(mixer);
      want ||= pos.map((p) => xfGain(p, 'B', mixer)); // smooth: √2·cos law
      const got = pos.map((_, i) => bandLevel(r.L, r.sr, 440, 0.11 + 0.15 * i, 0.19 + 0.15 * i) / (0.1 * 0.64));
      const ok = got.every((g, i) => (want[i] < 1e-6 ? db(g) <= -80 : Math.abs(db(g) - db(want[i])) < 0.1));
      check(ok, `crossfader ${name}: B level at ${pos.map((p) => f(p, 2)).join(' / ')} = ${got.map((g) => (g < 1e-4 ? '-inf' : f(db(g), 1))).join(' / ')} dB`);
    }
  }

  // ---------------------------------------------------------------- M2 channel-fader curves
  {
    const vols = [1, 0.75, 0.5, 0.25, 0.02];
    for (const curve of ['log', 'linear', 'smooth', 'cut']) {
      const r = await lab.render({ chain: 'channel', settings: { mixer: { faderCurve: curve } }, signal: 'sine', signalOpts: { f: 440, amp: 0.1 }, secs: 0.2 * vols.length + 0.1, events: vols.map((v, i) => ({ t: 0.05 + 0.2 * i, ...set('volume', v) })).concat([{ t: 0.2 * vols.length + 0.05, probe: 'fader.gain.value' }, { t: 0.2 * vols.length + 0.05, probe: 'postFader.gain.value' }]) });
      const want = vols.map((v) => ({ log: v * v, linear: v, smooth: v ** 3, cut: v >= 0.03 ? 1 : 0 }[curve]));
      const got = vols.map((_, i) => bandLevel(r.L, r.sr, 440, 0.12 + 0.2 * i, 0.24 + 0.2 * i) / 0.1);
      const ok = got.every((g, i) => (want[i] < 1e-3 ? (want[i] === 0 ? db(g) <= -80 : true) : Math.abs(db(g) - db(want[i])) < 0.1));
      const post = r.probe['postFader.gain.value'], dry = r.probe['fader.gain.value'];
      check(ok && Math.abs(db(post + 1e-9) - db(dry + 1e-9)) < 0.1, `fader curve ${curve}: ${got.map((g) => (g < 1e-4 ? '-inf' : f(db(g), 1))).join(' / ')} dB at ${vols.join(' / ')}; post-fader FX send = dry fader gain`);
    }
  }

  // ---------------------------------------------------------------- M3 EQ presets (frequency response)
  const freqs = [40, 60, 100, 300, 500, 700, 800, 1000, 2000, 4000, 8000, 12000];
  const eqResp = async (eqType, st = {}, mixer = {}) => {
    const r = await lab.render({ chain: 'channel', settings: { mixer: { eqType, ...mixer } }, signal: 'multitone', signalOpts: { freqs, amp: 0.02 }, secs: 2.0, init: Object.entries(st).map(([k, x]) => set(k, x)) });
    return Object.fromEntries(freqs.map((q) => [q, db(bandLevel(r.L, r.sr, q, 1.0, 2.0) / 0.02 / 0.64)]));
  };
  M.eq = {};
  for (const [type, tol] of [['isolator', 0.1], ['classic', 0.1], ['fourBand', 0.2], ['rotaryIso', 0.15], ['battle', 0.1], ['vintage', 0.15], ['sculpt', 0.1]]) {
    const flat = await eqResp(type), dev = Math.max(...Object.values(flat).map(Math.abs));
    const bass = await eqResp(type, { eqLow: -1 });
    M.eq[type] = { flatDev: dev, bassKill60: -bass[60] };
    check(dev <= tol && -bass[60] >= 30, `EQ ${type}: flat at noon (±${f(dev, 3)} dB, limit ${tol}), automix bass swap (LOW -1) removes ${f(-bass[60], 1)} dB at 60 Hz (>= 30)`);
  }
  {
    // shelving presets vs their target curves (RBJ formulas of the preset definition), and the -26 dB / kill points
    for (const [type, fr, qv, boost, cut] of [['classic', [70, 1000, 13000], 0.7, 6, 26], ['vintage', [100, 800, 8000], 0.5, 10, 20]]) {
      const lo = await eqResp(type, { eqLow: -0.9 }), mid = await eqResp(type, { eqMid: -0.9 }), hi = await eqResp(type, { eqHigh: 1 });
      const err = Math.max(...freqs.map((q) => Math.max(Math.abs(lo[q] - bqMag('lowshelf', fr[0], -cut, 0, q)), Math.abs(mid[q] - bqMag('peaking', fr[1], -cut, qv, q)), Math.abs(hi[q] - bqMag('highshelf', fr[2], boost, 0, q)))));
      M.eq[type].targetErr = err;
      check(err < 0.3 && Math.abs(mid[fr[1]] + cut) < 0.3, `EQ ${type} matches its target curve within ${f(err, 2)} dB (low shelf ${fr[0]} Hz / mid ${fr[1]} Hz Q ${qv} at -${cut} dB: ${f(mid[fr[1]], 2)} dB; high shelf ${fr[2]} Hz +${boost} dB)`);
    }
    const iso = await eqResp('isolator', { eqLow: -1 }), isoM = await eqResp('isolator', { eqMid: -1 }), isoH = await eqResp('isolator', { eqHigh: -1 });
    check(Math.min(-iso[40], -iso[60], -iso[100], -isoM[500], -isoM[1000], -isoH[8000], -isoH[12000]) > 40, `EQ Club Isolator kills > 40 dB in band (low ${f(-iso[60], 0)}, mid ${f(-isoM[1000], 0)}, high ${f(-isoH[12000], 0)} dB)`);
    const fb = await eqResp('fourBand', { eqHigh: -1, eqLow: -1 }), fmh = await eqResp('fourBand', { eqMidHigh: -1 });
    check(Math.min(-fb[40], -fb[60], -fb[12000]) > 40 && fmh[2000] <= -24, `EQ 4-Band Club: Hi / Low kills > 40 dB (${f(-fb[60], 0)} / ${f(-fb[12000], 0)} dB), Mid-Hi at min ${f(fmh[2000], 1)} dB at 2 kHz (<= -24)`);
    const rb = await eqResp('rotaryIso', { eqMid: 1 }), bt = await eqResp('battle', { eqMid: -0.67 }), btc = await eqResp('isolator', { eqMid: -0.67 });
    check(Math.abs(rb[1000] - 12) < 0.5 && bt[1000] <= -60 && btc[1000] > -25, `EQ Rotary Isolator boosts +${f(rb[1000], 1)} dB (target +12); Battle mid at 9 o'clock ${f(bt[1000], 1)} dB (killed) vs club ${f(btc[1000], 1)} dB`);
    const sMax = await eqResp('sculpt', { eqMid: 1 }), sMin = await eqResp('sculpt', { eqMid: -1 });
    check(Math.abs(sMax[700] - 8) <= 0.5 && Math.abs(sMin[700] + 20) <= 0.5, `EQ Sculpt at 700 Hz: +${f(sMax[700], 2)} dB max, ${f(sMin[700], 2)} dB min (targets +8 / -20 ±0.5)`);
    // type switch: click-free, level at noon matches
    const sw = await lab.render({ chain: 'channel', signal: 'sine', signalOpts: { f: 220, amp: 0.5 }, secs: 4, events: ['classic', 'fourBand', 'rotaryIso', 'vintage', 'battle', 'sculpt', 'isolator'].map((t, i) => ({ t: 0.5 + 0.5 * i, call: 'setEqType', args: [t] })) });
    const clean = maxJump(sw.L, sw.sr, 0.1, 0.45), worst = maxJump(sw.L, sw.sr, 0.45, 3.9) / clean;
    const levels = [0, 1, 2, 3, 4, 5, 6].map((i) => db(rms(sw.L, sw.sr, 0.7 + 0.5 * i, 0.95 + 0.5 * i) / rms(sw.L, sw.sr, 0.1, 0.45)));
    M.eq.switchStep = worst;
    check(worst <= 1.05 && Math.max(...levels.map(Math.abs)) <= 0.2, `EQ preset switches (7 types) are click-free (largest step ${f(worst, 3)}x clean) and keep the level at noon (${levels.map((x) => f(x, 2)).join(' / ')} dB)`);
  }

  // ---------------------------------------------------------------- M4 dual filter
  {
    const dfreqs = [30, 100, 150, 200, 300, 1000, 3000, 5000, 15000];
    const resp = async (st) => { const r = await lab.render({ chain: 'channel', settings: { mixer: { filterMode: 'dual' } }, signal: 'multitone', signalOpts: { freqs: dfreqs, amp: 0.02 }, secs: 1.6, init: Object.entries(st).map(([k, x]) => set(k, x)) }); return Object.fromEntries(dfreqs.map((q) => [q, db(bandLevel(r.L, r.sr, q, 0.8, 1.6) / 0.02 / 0.64)])); };
    const rest = await resp({}), hp = await resp({ filterHp: 1 }), lp = await resp({ filterLp: 1 }), hpMid = await resp({ filterHp: 0.5 }), auto = await resp({ filter: 0.6 });
    const restDev = Math.max(...Object.values(rest).map(Math.abs)), bump = Math.max(...Object.values(hpMid));
    M.dual = { restDev, hp100: -hp[100], lp5k: -lp[5000], peak: bump };
    check(restDev <= 0.01 && -hp[100] >= 24 && -lp[5000] >= 24 && bump <= 0.5 && auto[30] < -10, `dual filter: flat at rest (±${f(restDev, 3)} dB); HP max ${f(hp[100], 1)} dB at 100 Hz, LP max ${f(lp[5000], 1)} dB at 5 kHz; no resonant peak (max +${f(bump, 2)} dB); automix 'filter' drives the HP (${f(auto[30], 1)} dB at 30 Hz)`);
  }

  // ---------------------------------------------------------------- M5 new Color FX
  {
    // null inside one render: channel 1 with the Color FX at noon minus channel 2 with the plain filter. Chromium's
    // offline renderer leaves up to ~4e-4 (-68 dBFS) between two *identical* channels at random (measured below), so
    // that is the floor of this null test.
    const floorR = await lab.render({ chain: 'engine', tap: 'diff01', sources: [{ signal: 'drums', to: 'ch0' }, { signal: 'drums', to: 'ch1' }], secs: 1.5 });
    const floor = Math.max(5e-4, 1.5 * Math.max(peak(floorR.L, floorR.sr, 0.05), peak(floorR.R, floorR.sr, 0.05)));
    for (const id of ['sweep', 'crunch', 'pitchshift']) {
      const r = await lab.render({ chain: 'engine', tap: 'diff01', sources: [{ signal: 'drums', to: 'ch0' }, { signal: 'drums', to: 'ch1' }], secs: 1.5, init: [set('colorFx', id, 'channels.0'), set('colorFx', 'filter', 'channels.1')] });
      const d = Math.max(peak(r.L, r.sr, 0.05), peak(r.R, r.sr, 0.05));
      check(db(d) <= -90 || d <= floor, `Color FX ${id}: transparent at 12 o'clock (null vs the plain filter ${d ? f(db(d), 1) : '-inf'} dBFS; renderer floor between identical channels ${f(db(floor / 1.5), 1)} dBFS)`);
    }
    const thd = [];
    for (const k of [0.2, 0.5, 0.8]) {
      const r = await lab.render({ chain: 'channel', settings: { colorFx: 'crunch' }, signal: 'sine', signalOpts: { f: 500, amp: 0.3 }, secs: 1.2, init: [set('filter', k)] });
      const h1 = bandLevel(r.L, r.sr, 500, 0.6, 1.2), hs = [1500, 2500, 3500].map((q) => bandLevel(r.L, r.sr, q, 0.6, 1.2));
      thd.push(Math.hypot(...hs) / h1 * 100);
    }
    const ps = await lab.render({ chain: 'channel', settings: { colorFx: 'pitchshift' }, signal: 'sine', signalOpts: { f: 440, amp: 0.3 }, secs: 1.5, init: [set('filter', 1)] });
    let best = 0, bf = 0; for (let q = 840; q <= 920; q += 0.5) { const m = bandLevel(ps.L, ps.sr, q, 0.6, 1.5); if (m > best) { best = m; bf = q; } }
    M.color = { crunchThd: thd, pitchHz: bf };
    check(thd[0] < thd[1] && thd[1] < thd[2], `Crunch THD rises with the knob (${thd.map((x) => f(x, 1)).join(' → ')} %)`);
    check(Math.abs(bf / 880 - 1) <= 0.005, `Pitch Color FX at max: 440 Hz -> ${bf} Hz (2x ± 0.5 %)`);
  }

  // ---------------------------------------------------------------- M6 booth
  {
    const r = await lab.render({ chain: 'engine', channels: 6, tap: 'outputs', settings: { cueMode: 'channels34', mixer: { boothRoute: 'channels56' } }, sources: [{ signal: 'sine', signalOpts: { f: 440, amp: 0.2 }, to: 'ch0' }, { signal: 'sine', signalOpts: { f: 1235, amp: 0.2 }, to: 'booth' }], secs: 1.2 });
    const boothL = lv(r, 1235, 0.4, 1.2, r.all[4]), cross = Math.max(...[0, 1, 2, 3].map((c) => lv(r, 1235, 0.4, 1.2, r.all[c]))) - boothL;
    const masterOn12 = lv(r, 440, 0.4, 1.2, r.all[0]);
    M.booth = { crosstalk: cross };
    check(boothL > -30 && lv(r, 1235, 0.4, 1.2, r.all[5]) > -30 && cross <= -90 && masterOn12 > -30, `booth on outputs 5/6 of a 6-channel device: booth-only tone on 5/6 (${f(boothL, 1)} dB), crosstalk into 1-4 ${f(cross, 1)} dB (<= -90), master on 1/2`);
    const eqr = async (st) => { const x = await lab.render({ chain: 'engine', tap: 'booth', sources: [{ signal: 'multitone', signalOpts: { freqs: [50, 1000, 12000], amp: 0.01 }, to: 'booth' }], secs: 1, init: st }); return [50, 1000, 12000].map((q) => lv(x, q, 0.4, 1)); };
    const f0 = await eqr([]), up = await eqr([{ call: 'setBoothEq', args: ['low', 1] }, { call: 'setBoothEq', args: ['high', 1] }]), dn = await eqr([{ call: 'setBoothEq', args: ['low', -1] }, { call: 'setBoothEq', args: ['high', -1] }]);
    const g = [up[0] - f0[0], up[2] - f0[2], dn[0] - f0[0], dn[2] - f0[2]];
    M.booth.eq = g;
    check(Math.abs(g[0] - 12) <= 0.5 && Math.abs(g[1] - 12) <= 0.5 && Math.abs(g[2] + 12) <= 0.5 && Math.abs(g[3] + 12) <= 0.5, `booth EQ ±12 dB: ${g.map((x) => f(x, 2)).join(' / ')} dB at 50 Hz / 12 kHz (±0.5)`);
    const src = [{ signal: 'sine', signalOpts: { f: 440, amp: 0.2 }, to: 'ch0' }, { signal: 'sine', signalOpts: { f: 700, amp: 0.2 }, to: 'mic' }];
    const b0 = await lab.render({ chain: 'engine', tap: 'booth', sources: src, secs: 1 }), m0 = await lab.render({ chain: 'engine', tap: 'master', sources: src, secs: 1 });
    const micB = lv(b0, 700, 0.4, 1) - lv(m0, 700, 0.4, 1);
    const b1 = await lab.render({ chain: 'engine', tap: 'booth', settings: { mixer: { micToBooth: true } }, sources: src, secs: 1 });
    check(micB <= -90 && lv(m0, 700, 0.4, 1) > -40 && lv(b1, 700, 0.4, 1) > -40 && lv(b0, 440, 0.4, 1) > -40, `"mic in booth" off (default): mic ${f(micB, 1)} dB in the booth vs master, present in master; on: present in the booth`);
    const mA = await lab.render({ chain: 'engine', tap: 'master', sources: src, secs: 1, init: [{ call: 'ensureBooth' }, { call: 'setBoothVolume', args: [0] }] });
    const mB = await lab.render({ chain: 'engine', tap: 'master', sources: src, secs: 1, init: [{ call: 'ensureBooth' }, { call: 'setBoothVolume', args: [1] }] });
    const rA = await lab.render({ chain: 'engine', tap: 'rec', sources: src, secs: 1, init: [{ call: 'ensureBooth' }, { call: 'setBoothVolume', args: [0] }] });
    const lvls = [mA, mB, rA].map((x) => [lv(x, 440, 0.4, 1), lv(x, 700, 0.4, 1)]), dl = Math.max(...lvls.flatMap((x) => x.map((y, k) => Math.abs(y - lvls[0][k]))));
    check(dl < 0.01, `booth level 0 vs 1 leaves the master and the recording unchanged (level difference ${f(dl, 4)} dB)`);
  }

  // ---------------------------------------------------------------- M7 headphones
  {
    const one = [{ signal: 'sine', signalOpts: { f: 440, amp: 0.2 }, to: 'ch0' }];
    const a = await lab.render({ chain: 'engine', tap: 'hp', sources: one, secs: 1, init: [{ call: 'ensureHp2' }, set('cue2', true, 'channels.0')] });
    const b = await lab.render({ chain: 'engine', tap: 'hp2', sources: one, secs: 1, init: [set('cue2', true, 'channels.0')] });
    const iso = lv(a, 440, 0.4, 1) - lv(b, 440, 0.4, 1);
    check(lv(b, 440, 0.4, 1) > -40 && iso <= -90, `cue B: channel in headphones B (${f(lv(b, 440, 0.4, 1), 1)} dB), isolation from headphones A ${f(iso, 1)} dB (<= -90)`);
    const pre = await lab.render({ chain: 'engine', tap: 'cue', sources: one, secs: 1, init: [set('cue', true, 'channels.0'), set('volume', 0.5, 'channels.0')] });
    const post = await lab.render({ chain: 'engine', tap: 'cue', sources: one, secs: 1, init: [set('cue', true, 'channels.0'), set('volume', 0.5, 'channels.0'), set('cuePost', true, 'channels.0')] });
    const d = lv(post, 440, 0.4, 1) - lv(pre, 440, 0.4, 1) - db(0.25);
    check(Math.abs(d) <= 0.1, `post-fader cue tracks the fader (${f(d, 3)} dB off the fader gain at 0.5)`);
    const smp = [{ signal: 'sine', signalOpts: { f: 900, amp: 0.2 }, to: 'sampler' }], init = [{ call: 'setSamplerCue', args: [true] }, { on: 'sampler', call: 'setVolume', args: [0] }];
    const sh = await lab.render({ chain: 'engine', tap: 'hp', sources: smp, secs: 1, init }), sm = await lab.render({ chain: 'engine', tap: 'master', sources: smp, secs: 1, init });
    check(lv(sh, 900, 0.4, 1) > -40 && lv(sm, 900, 0.4, 1) <= -90, `sampler cue at sampler volume 0: in the headphones (${f(lv(sh, 900, 0.4, 1), 1)} dB), not in the master (${f(lv(sm, 900, 0.4, 1), 0)} dB)`);
  }

  // ---------------------------------------------------------------- M8 mic: FX latency, talkover, feedback reducer, voice bus
  {
    const imp = [{ signal: 'impulse', signalOpts: { at: 0.1, amp: 0.5 }, to: 'mic' }];
    const pos = (r) => { let k = 0, m = 0; for (let i = Math.round(0.09 * SR); i < Math.round(0.2 * SR); i++) { const a = Math.abs(r.L[i]); if (a > m) { m = a; k = i; } } return k; };
    const dry = pos(await lab.render({ chain: 'engine', tap: 'master', sources: imp, secs: 0.4 }));
    const lat = {};
    for (const fx of ['echo', 'reverb', 'megaphone']) lat[fx] = pos(await lab.render({ chain: 'engine', tap: 'master', settings: { mixer: { micFx: fx } }, sources: imp, secs: 0.4, init: [{ call: 'setMicFx', args: [true] }] })) - dry;
    M.micFxLatency = lat;
    check(Object.values(lat).every((x) => Math.abs(x) <= 128), `mic FX add <= 1 render quantum to the dry mic path (${Object.entries(lat).map(([k, x]) => `${k} ${x} samples`).join(', ')})`);
    const burst = { signal: 'sine', signalOpts: { f: 180, amp: 0.1, from: 1, until: 2 }, to: 'mic' };
    const music = { signal: 'sine', signalOpts: { f: 1000, amp: 0.1 }, to: 'ch0' };
    const t = await lab.render({ chain: 'engine', tap: 'master', settings: { talkoverDb: -12, mixer: { talkoverMode: 'auto' } }, sources: [music, burst], secs: 2.8 });
    const ref = lv(t, 1000, 0.5, 0.95), dIn = lv(t, 1000, 1.02, 1.04) - ref, dHold = lv(t, 1000, 1.4, 1.9) - ref;
    let rel = null; for (let x = 2.0; x < 2.8; x += 0.01) if (lv(t, 1000, x, x + 0.01) - ref > -1) { rel = x - 2; break; }
    M.talkover = { at20ms: dIn, hold: dHold, releaseMs: rel * 1e3 };
    check(Math.abs(dHold + 12) <= 1 && dIn <= -10 && rel != null && rel <= 0.4, `auto talkover (engine): music ${f(dIn, 1)} dB 20-40 ms into the voice, ${f(dHold, 1)} dB held (depth -12), back within 1 dB after ${f(rel * 1e3, 0)} ms`);
    const adv = await lab.render({ chain: 'engine', tap: 'master', settings: { talkoverDb: -12, mixer: { talkoverMode: 'advanced' } }, sources: [{ signal: 'multitone', signalOpts: { freqs: [60, 1000], amp: 0.08 }, to: 'ch0' }, burst], secs: 2.2 });
    const a60 = lv(adv, 60, 1.3, 1.9) - lv(adv, 60, 0.4, 0.9), a1k = lv(adv, 1000, 1.3, 1.9) - lv(adv, 1000, 0.4, 0.9);
    check(a60 >= -1 && Math.abs(a1k + 12) <= 1, `voice-band talkover: 60 Hz ${f(a60, 2)} dB (>= -1), 1 kHz ${f(a1k, 2)} dB (-12 ± 1)`);
    const steps = []; for (let x = 0.1; x < 1.6; x += 0.05) steps.push({ t: x, on: 'mic', call: 'feedbackStep', args: [0.05] });
    const fb = await lab.render({ chain: 'engine', tap: 'master', settings: { mixer: { feedbackReducer: true } }, sources: [{ signal: 'sine', signalOpts: { f: 2500, amp: 0.3 }, to: 'mic' }], secs: 1.6, events: steps });
    const red = lv(fb, 2500, 0.15, 0.3) - lv(fb, 2500, 1.3, 1.6);
    const pk = await lab.render({ chain: 'engine', tap: 'master', settings: { mixer: { feedbackReducer: true } }, sources: [{ signal: 'pink', signalOpts: { rms: 0.1 }, to: 'mic' }], secs: 1.6, events: [...steps, { t: 1.58, probe: 'mic.notchFreqs', as: 'notches' }] });
    M.feedback = { reductionDb: red, pinkNotches: pk.probe.notches.length };
    check(red >= 15 && pk.probe.notches.length === 0, `feedback reducer: 2.5 kHz howl reduced ${f(red, 1)} dB within 1 s (>= 15); pink noise at the same level gets no notch (${pk.probe.notches.length})`);
    const vsrc = [music, { signal: 'sine', signalOpts: { f: 300, amp: 0.1 }, to: 'voice' }];
    const vm = await lab.render({ chain: 'engine', tap: 'master', sources: vsrc, secs: 1 }), vr = await lab.render({ chain: 'engine', tap: 'rec', settings: { mixer: { micToRecord: false } }, sources: vsrc, secs: 1 });
    const va = await lab.render({ chain: 'engine', tap: 'master', settings: { talkoverDb: -12, mixer: { talkoverMode: 'auto' } }, sources: [music, { ...vsrc[1], signalOpts: { f: 300, amp: 0.1, from: 0.5 } }], secs: 1.2 });
    check(lv(vm, 300, 0.4, 1) > -40 && lv(vr, 300, 0.4, 1) <= -90 && lv(vr, 1000, 0.4, 1) > -40 && lv(va, 1000, 0.8, 1.2) - lv(va, 1000, 0.1, 0.45) < -10, 'voice bus: in the master, out of the recording with "mic in recording" off, and it triggers auto talkover');
  }

  // ---------------------------------------------------------------- M9 FX units
  {
    const dr = [{ signal: 'drums', to: 'ch0' }];
    const plain = await lab.render({ chain: 'engine', tap: 'program', sources: dr, secs: 1.5 });
    const ins = await lab.render({ chain: 'engine', tap: 'program', sources: dr, secs: 1.5, init: [{ call: 'setFxAssign', args: [0, 'master'] }] });
    let d = 0; for (let i = Math.round(0.1 * SR); i < plain.L.length; i++) d = Math.max(d, Math.abs(plain.L[i] - ins.L[i]));
    const dl = db(rms(ins.L, SR, 0.1, 1.5) / rms(plain.L, SR, 0.1, 1.5));
    check(Math.abs(dl) <= 0.1 && db(d) <= -60, `FX unit on the master, FX off: dry path unchanged (level ${f(dl, 3)} dB, null ${d ? f(db(d), 1) : '-inf'} dB)`);
    const mt = [{ signal: 'multitone', signalOpts: { freqs: [100, 8000], amp: 0.1 }, to: 'ch0' }];
    const bands = [{ call: 'setFxAssign', args: [0, 'master'] }, { on: 'fxBuses.0', call: 'setType', args: ['bitcrush'] }, { on: 'fxBuses.0', call: 'setMix', args: [1] }, { on: 'fxBuses.0', call: 'setParam', args: [1] }, { on: 'fxBuses.0', call: 'setBand', args: ['low', false] }, { on: 'fxBuses.0', call: 'setBand', args: ['mid', false] }];
    const off = await lab.render({ chain: 'engine', tap: 'program', sources: mt, secs: 1.2, init: bands });
    const on = await lab.render({ chain: 'engine', tap: 'program', sources: mt, secs: 1.2, init: [...bands, { on: 'fxBuses.0', call: 'setOn', args: [true] }] });
    const c = (r, q) => cplx(r.L, q, 0.5, 1.2), n100 = (() => { const [a, b] = c(off, 100), [x, y] = c(on, 100); return db(Math.hypot(a - x, b - y) / Math.hypot(a, b)); })();
    const n8k = (() => { const [a, b] = c(off, 8000), [x, y] = c(on, 8000); return db(Math.hypot(a - x, b - y) / Math.hypot(a, b)); })();
    check(n100 <= -60 && n8k > -20, `FX frequency "High" only: 100 Hz untouched (null ${f(n100, 1)} dB), 8 kHz processed (${f(n8k, 1)} dB)`);
    const strip = await lab.render({ chain: 'engine', tap: 'master', sources: [{ signal: 'burst', signalOpts: { at: 0.5 }, to: 'ch0' }], secs: 1.8, init: [{ call: 'setFxAssign', args: [0, 'master'] }, { on: 'fxBuses.0', call: 'setBeatSec', args: [0.5] }, { on: 'fxBuses.0', call: 'setMix', args: [1] }, { on: 'fxBuses.0', call: 'setParam', args: [0.4] }], events: [{ t: 0.3, on: 'fxBuses.0', call: 'strip', args: [0.2] }] });
    const o = onsets(strip.L.map((x, i) => x + strip.R[i]), strip.sr, 0.01, 0.1, 0.45), gaps = o.slice(1, 4).map((x, i) => x - o[i]);
    const err = gaps.length >= 2 ? Math.max(...gaps.map((g) => Math.abs(g - 0.25))) : Infinity;
    M.fxStrip = { gapsMs: gaps.map((g) => g * 1e3) };
    check(err < 0.001, `FX strip at ½ beat (120 BPM): echo period ${gaps.map((g) => f(g * 1e3, 2)).join(' / ')} ms vs 250 ms (error ${f(err * 1e3, 3)} ms)`);
    const qInit = [{ call: 'setFxAssign', args: [0, 'master'] }, { on: 'fxBuses.0', call: 'setType', args: ['bitcrush'] }, { on: 'fxBuses.0', call: 'setMix', args: [1] }, { on: 'fxBuses.0', call: 'setBeats', args: [0.25] }, { on: 'fxBuses.0', call: 'setQuantize', args: [true] }, { on: 'fxBuses.0', call: 'setClock', args: [0, 0, 0.5] }];
    const si = [{ signal: 'sine', signalOpts: { f: 440, amp: 0.3 }, to: 'ch0' }];
    const q0 = await lab.render({ chain: 'engine', tap: 'program', sources: si, secs: 1.5, init: qInit });
    const q1 = await lab.render({ chain: 'engine', tap: 'program', sources: si, secs: 1.5, init: qInit, events: [{ t: 1.03, on: 'fxBuses.0', call: 'setOn', args: [true] }] });
    let first = null; for (let i = Math.round(1 * SR); i < q0.L.length; i++) if (Math.abs(q0.L[i] - q1.L[i]) > 2e-3) { first = i / SR; break; }
    M.fxQuantize = { onsetMs: first * 1e3, gridMs: 1125 };
    check(first != null && Math.abs(first - 1.125) <= Q, `quantised FX on (pressed at 1.03 s): starts at ${f(first * 1e3, 2)} ms, the next 1/4-beat line is 1125 ms (± 1 render quantum)`);
  }

  // ---------------------------------------------------------------- M10 send / return
  {
    const dr = [{ signal: 'drums', signalOpts: { until: 1 }, to: 'ch0' }, { signal: 'sine', signalOpts: { f: 60, amp: 0.0001 }, to: 'ch1' }];
    const plain = await lab.render({ chain: 'engine', tap: 'program', sources: dr, secs: 1.6 });
    const zero = await lab.render({ chain: 'engine', tap: 'program', sources: dr, secs: 1.6, init: [set('send', 0.5, 'channels.0'), set('send', 0, 'channels.0')] });
    const plain2 = await lab.render({ chain: 'engine', tap: 'program', sources: dr, secs: 1.6 });
    let fl = 0; for (let i = 0; i < plain.L.length; i++) fl = Math.max(fl, Math.abs(plain.L[i] - plain2.L[i]));
    let d = 0; for (let i = 0; i < plain.L.length; i++) d = Math.max(d, Math.abs(plain.L[i] - zero.L[i]));
    const wet = await lab.render({ chain: 'engine', tap: 'master', sources: dr, secs: 1.6, init: [set('send', 1, 'channels.0')] });
    const toCh = await lab.render({ chain: 'engine', tap: 'master', settings: { mixer: { returnTo: 'ch2' } }, sources: dr, secs: 1.6, init: [set('send', 1, 'channels.0'), set('volume', 0, 'channels.1')] });
    const toChUp = await lab.render({ chain: 'engine', tap: 'master', settings: { mixer: { returnTo: 'ch2' } }, sources: dr, secs: 1.6, init: [set('send', 1, 'channels.0')] });
    const tail = (r) => db(rms(r.L, r.sr, 1.1, 1.5) + 1e-12);
    check(d <= Math.max(fl * 1.5, 5e-4) && tail(wet) > tail(plain) + 30 && tail(toCh) < tail(toChUp) - 40, `send / return: send 0 = no send (diff ${d.toExponential(1)}, render floor ${fl.toExponential(1)}); reverb return to the master adds a tail (${f(tail(wet), 1)} vs ${f(tail(plain), 1)} dB); returned into channel 2 it follows that channel's fader (${f(tail(toCh), 1)} vs ${f(tail(toChUp), 1)} dB)`);
  }

  // ---------------------------------------------------------------- M12 master isolator, M13 master extras
  {
    const mf = [60, 100, 700, 1500, 8000, 12000], mt = [{ signal: 'multitone', signalOpts: { freqs: mf, amp: 0.01 }, to: 'program' }];
    const resp = async (init, mixer = {}) => { const r = await lab.render({ chain: 'engine', tap: 'program', settings: { mixer }, sources: mt, secs: 1.2, init }); return Object.fromEntries(mf.map((q) => [q, lv(r, q, 0.5, 1.2) - db(0.01)])); };
    const flat = await resp([{ call: 'setMasterIso', args: ['low', -0.5] }, { call: 'setMasterIso', args: ['low', 0] }]);
    const lo = await resp([{ call: 'setMasterIso', args: ['low', -1] }]), mid = await resp([{ call: 'setMasterIso', args: ['mid', -1] }]), hi = await resp([{ call: 'setMasterIso', args: ['high', -1] }]);
    const kills = [-lo[60], -lo[100], -mid[700], -mid[1500], -hi[8000], -hi[12000]];
    check(Math.max(...Object.values(flat).map(Math.abs)) <= 0.1 && Math.min(...kills) > 40, `master isolator: flat at noon (bypassed), kills ${kills.map((k) => f(k, 0)).join(' / ')} dB in band (> 40)`);
    const sw = await lab.render({ chain: 'engine', tap: 'program', sources: [{ signal: 'sine', signalOpts: { f: 220, amp: 0.3 }, to: 'program' }], secs: 2.5, events: [{ t: 1, call: 'setMasterIso', args: ['mid', -0.5] }, { t: 2, call: 'setMasterIso', args: ['mid', 0] }] });
    const st = maxJump(sw.L, sw.sr, 0.9, 2.4) / maxJump(sw.L, sw.sr, 0.2, 0.8);
    const hot = await lab.render({ chain: 'engine', tap: 'master', settings: { mixer: { masterIsoBoost: 12 } }, sources: [{ signal: 'drums', to: 'ch0' }], secs: 2, init: ['low', 'mid', 'high'].map((b) => ({ call: 'setMasterIso', args: [b, 1] })) });
    const pk = Math.max(peak(hot.L, hot.sr), peak(hot.R, hot.sr));
    check(st <= 1.05 && pk <= 10 ** (-1 / 20) + 1e-6, `master isolator bypass toggling click-free (step ${f(st, 3)}x); +12 dB boosts on every band: limiter holds ${f(db(pk), 2)} dBFS`);
    const dr = [{ signal: 'drums', to: 'ch0' }];
    const mono = await lab.render({ chain: 'engine', tap: 'master', settings: { mixer: { mono: true } }, sources: dr, secs: 1 });
    let md = 0; for (let i = Math.round(0.1 * SR); i < mono.L.length; i++) md = Math.max(md, Math.abs(mono.L[i] - mono.R[i]));
    const bal = await lab.render({ chain: 'engine', tap: 'master', sources: dr, secs: 1, init: [{ call: 'setBalance', args: [1] }] });
    const ceil = await lab.render({ chain: 'engine', tap: 'master', settings: { mixer: { limiterCeiling: -3 } }, sources: [{ signal: 'drums', signalOpts: { gain: 3 }, to: 'ch0' }], secs: 1.5 });
    const quiet = await lab.render({ chain: 'engine', tap: 'master', sources: [{ signal: 'drums', signalOpts: { gain: 0.2 }, to: 'ch0' }], secs: 1.5, events: [{ t: 1.45, probe: 'limiter.gainReduction', as: 'gr' }] });
    const cp = Math.max(peak(ceil.L, ceil.sr), peak(ceil.R, ceil.sr));
    check(md < 1e-6 && db(rms(bal.L, bal.sr, 0.1, 1) + 1e-12) - db(rms(bal.R, bal.sr, 0.1, 1)) <= -80 && cp <= 10 ** (-3 / 20) + 1e-6 && quiet.probe.gr === 1, `master: mono L = R (max diff ${md.toExponential(1)}), balance hard right leaves L <= -80 dB, ceiling -3 dBFS holds (${f(db(cp), 2)}), no gain reduction below the ceiling (GR ${quiet.probe.gr})`);
  }

  // ---------------------------------------------------------------- M15 record section, M16 warmth
  {
    const src = [{ signal: 'sine', signalOpts: { f: 440, amp: 0.02 }, to: 'ch0' }, { signal: 'sine', signalOpts: { f: 700, amp: 0.1 }, to: 'mic' }];
    const rec = await lab.render({ chain: 'engine', tap: 'rec', settings: { mixer: { micToRecord: false } }, sources: src, secs: 1 }), mas = await lab.render({ chain: 'engine', tap: 'master', settings: { mixer: { micToRecord: false } }, sources: src, secs: 1 });
    const base = await lab.render({ chain: 'engine', tap: 'rec', sources: src, secs: 1 });
    const up = await lab.render({ chain: 'engine', tap: 'rec', sources: src, secs: 1, init: [{ call: 'setRecordLevel', args: [12] }] }), dn = await lab.render({ chain: 'engine', tap: 'rec', sources: src, secs: 1, init: [{ call: 'setRecordLevel', args: [-12] }] });
    const gUp = lv(up, 440, 0.4, 1) - lv(base, 440, 0.4, 1), gDn = lv(dn, 440, 0.4, 1) - lv(base, 440, 0.4, 1), micR = lv(rec, 700, 0.4, 1) - lv(mas, 700, 0.4, 1);
    check(micR <= -90 && lv(mas, 700, 0.4, 1) > -40 && Math.abs(gUp - 12) <= 0.1 && Math.abs(gDn + 12) <= 0.1, `record: mic excluded ${f(micR, 1)} dB in the recording, present in the master; record level ${f(gUp, 2)} / ${f(gDn, 2)} dB (±12 ± 0.1)`);
    const w = await lab.render({ chain: 'engine', tap: 'program', sources: [{ signal: 'sine', signalOpts: { f: 1000, amp: 10 ** (-14 / 20) }, to: 'program' }], secs: 1.5, init: [{ call: 'setWarmth', args: [0.5] }] });
    const h1 = bandLevel(w.L, w.sr, 1000, 0.6, 1.5), h2 = bandLevel(w.L, w.sr, 2000, 0.6, 1.5), h3 = bandLevel(w.L, w.sr, 3000, 0.6, 1.5), thd = Math.hypot(h2, h3) / h1 * 100;
    M.warmthThd = thd;
    check(thd >= 0.5 && thd <= 1.5 && h2 > h3, `warmth 0.5 on the master: THD ${f(thd, 2)} % on a -14 dBFS 1 kHz sine, H2 > H3`);
  }

  // ---------------------------------------------------------------- M17 rotary smoothing, personalities
  {
    const r = await lab.render({ chain: 'channel', settings: { mixer: { rotary: true } }, signal: 'sine', signalOpts: { f: 2000, amp: 0.2 }, secs: 1.5, init: [set('volume', 0)], events: [{ t: 1, ...set('volume', 0.8) }] });
    const fin = peak(r.L, r.sr, 1.35, 1.45), t0 = qt(1); let t63 = null;
    for (let x = t0; x < 1.3; x += 0.001) if (peak(r.L, r.sr, x, x + 0.001) >= fin * 0.632) { t63 = x - t0; break; }
    M.rotaryTcMs = t63 * 1e3;
    check(Math.abs(t63 - 0.03) <= 0.005, `rotary level knob smoothing time constant ${f(t63 * 1e3, 1)} ms (30 ± 5)`);
    const src = [{ signal: 'drums', to: 'ch0' }, { signal: 'drums', signalOpts: { gain: 0.7 }, to: 'ch1' }];
    const order = ['rotary', 'battle', 'classic', 'club'];
    const ev = order.map((id, i) => ({ t: 2 + 2 * i, call: 'applyPersonality', args: [id] }));
    const ps = await lab.render({ chain: 'engine', tap: 'program', sources: [{ signal: 'sine', signalOpts: { f: 220, amp: 0.3 }, to: 'ch0' }, { signal: 'sine', signalOpts: { f: 330, amp: 0.2 }, to: 'ch1' }], secs: 9, events: ev });
    const res = order.map((id, i) => {
      const t = qt(2 + 2 * i), L = (q, a, b) => db(bandLevel(ps.L, ps.sr, q, a, b));
      const W = 8 / 110; // whole cycles of both tones (no leakage between them)
      const lvl = Math.max(...[220, 330].map((q) => Math.abs(L(q, t + 0.025, t + 0.025 + W) - L(q, t - 0.005 - W, t - 0.005))));
      const st = maxJump(ps.L, ps.sr, t - 0.01, t + 0.1) / maxJump(ps.L, ps.sr, t - 0.5, t - 0.05);
      return { id, lvl, st };
    });
    M.personalitySwitch = res;
    check(res.every((x) => Math.abs(x.lvl) <= 0.5 && x.st <= 1.05), `personality switches with two decks playing: ${res.map((x) => `${x.id} ${f(x.lvl, 2)} dB / step ${f(x.st, 3)}x`).join(', ')} (level within 0.5 dB, no step above 1.05x)`);
  }

  // ---------------------------------------------------------------- CPU: whole mixer v2
  {
    const heavy = [];
    // the e2e-fx busy mixer (reverb / flanger / phaser / trans + Space / Jet / Dub Echo / Crush) plus every v2 feature
    [['reverb', 'space', -0.4], ['flanger', 'pitch', 0.35], ['phaser', 'dubecho', -0.5], ['trans', 'crush', 0.3]].forEach(([fx, color, filt], i) => heavy.push(set('comp', 0.5, `channels.${i}`), set('fxType', fx, `channels.${i}`), set('fxOn', true, `channels.${i}`), set('colorFx', color, `channels.${i}`), set('filter', filt, `channels.${i}`)));
    heavy.push({ call: 'setMasterIso', args: ['low', -0.3] }, { call: 'setWarmth', args: [0.3] }, { call: 'ensureBooth' }, { call: 'ensureMeter' }, { call: 'setFxAssign', args: [0, 'master'] }, { on: 'fxBuses.0', call: 'setOn', args: [true] });
    const sources = [0, 1, 2, 3].map((i) => ({ signal: 'drums', signalOpts: { gain: 0.4 }, to: `ch${i}` }));
    const best = async (spec) => { const a = await lab.render(spec), b = await lab.render(spec); return a.ms < b.ms ? a : b; }; // (first renders include JIT warm-up)
    const plain = await best({ chain: 'engine', tap: 'master', sources, secs: 10 });
    const busy = await best({ chain: 'engine', tap: 'master', settings: { mixer: { eqType: 'fourBand' } }, sources, secs: 10, init: heavy });
    M.cpu = { plain: plain.ms / 100, busy: busy.ms / 100 };
    console.log(`# whole mixer v2 offline (4 channels, master chain, booth): ${f(plain.ms / 100, 1)} % of one core idle, ${f(busy.ms / 100, 1)} % with 4-band EQ + compressor + beat FX + Color FX on all channels, master isolator, warmth, booth, loudness meter and a master FX unit`);
    // (absolute timings depend on the machine's load, so the budget is relative to the reference 4-channel mixer render
    // of e2e-fx in the same run: same FX load on channel strips + limiter only)
    const ref = await best({ chain: 'mixer4', signal: 'drums', signalOpts: { gain: 0.4 }, secs: 10, init: [['reverb', 'space', -0.4], ['flanger', 'pitch', 0.35], ['phaser', 'dubecho', -0.5], ['trans', 'crush', 0.3]].flatMap(([fx, color, filt], i) => [set('fxType', fx, String(i)), set('fxOn', true, String(i)), set('colorFx', color, String(i)), set('filter', filt, String(i))]) });
    const fxOnly = await best({ chain: 'engine', tap: 'master', sources, secs: 10, init: heavy.filter((op) => op.args?.[0] !== 'comp' && op.on?.startsWith?.('channels')) });
    M.cpu.fxOnly = fxOnly.ms / 100; M.cpu.reference = ref.ms / 100;
    console.log(`# same FX load: reference channel-strip mixer ${f(ref.ms / 100, 1)} %, whole mixer v2 engine (master chain, cue, sampler, record tap) ${f(fxOnly.ms / 100, 1)} %`);
    check(fxOnly.ms <= ref.ms * 1.35, `whole mixer v2 engine costs ${f(fxOnly.ms / ref.ms, 2)}x the reference mixer render with the same FX load (budget 1.35x)`);
    check(busy.ms <= ref.ms * 2.5 && busy.ms / 10000 < 1, `stress, every v2 feature on at once: ${f(busy.ms / ref.ms, 2)}x the reference, ${f(10000 / busy.ms, 1)}x faster than real time`);
  }
  return M;
}
