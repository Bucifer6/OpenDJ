// Previews (docs/PRO_DJ_AUTOMIX_RESEARCH.md P6): hear the next transition in the headphones before the crowd does,
// and draw it. renderTransition() rebuilds the planned mix offline (OfflineAudioContext): both tracks at their
// transition tempo, the same isolator EQ, channel filters, fader automation from mixLevels and the echo tail of drop
// styles; playPreview() plays the result on the headphone cue bus (or the master when nothing is playing there).
// Approximations: no key lock (pitch follows the tempo change of at most a few percent), no AI stems, no tricks.
import { api } from './api.js';
import { mixLevels, dynamicMixLevels, DROP_STYLES } from './automix.js';
import { createEq } from './audio/eq.js';
import { faderGain, dbToGain } from './audio/curves.js';
import { StereoPhaseVocoder } from './audio/phase-vocoder.js';

/**
 * Time-stretch a slice of an AudioBuffer with key lock (StereoPhaseVocoder) so offline previews & exports
 * match the live deck's exact pitch and transient alignment.
 */
export function stretchSlice(ctx, buf, startSec, outSeconds, rate, pitch = 1) {
  const sr = buf.sampleRate;
  const outFrames = Math.max(1, Math.ceil(outSeconds * sr));
  const outBuf = ctx.createBuffer(2, outFrames, sr);
  const srcL = buf.getChannelData(0), srcR = buf.numberOfChannels > 1 ? buf.getChannelData(1) : srcL;
  const dstL = outBuf.getChannelData(0), dstR = outBuf.getChannelData(1);
  const startFrame = Math.max(0, startSec * sr), len = srcL.length;
  const read = (x, o2) => {
    const i = Math.floor(x), f = x - i;
    if (i < 0 || i + 1 >= len) { o2[0] = o2[1] = 0; return; }
    o2[0] = srcL[i] + (srcL[i + 1] - srcL[i]) * f;
    o2[1] = srcR[i] + (srcR[i + 1] - srcR[i]) * f;
  };
  const pv = new StereoPhaseVocoder(), pair = new Float32Array(2);
  for (let n = 0; n < outFrames; n++) {
    pv.nextSample(read, startFrame + n * rate, rate, pitch, pitch, pair);
    dstL[n] = pair[0]; dstR[n] = pair[1];
  }
  return outBuf;
}

const FULL = faderGain(0.8, 'log');

/** Fader / EQ / filter lanes of a blend plan: [{ k, inVol, outVol, inLow, outLow, … }] at `steps` + 1 points. */
export function planLanes(style, kSwap = null, steps = 64) {
  if (DROP_STYLES.has(style)) return null;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const k = i / steps;
    return { k, ...mixLevels(style, k, kSwap != null && k >= kSwap ? kSwap : null) };
  });
}

/** Channel filter knob (-1 low-pass .. 1 high-pass) → [low-pass Hz, high-pass Hz]. */
export function filterHz(v) {
  v = Math.max(-1, Math.min(1, Number(v) || 0));
  return [v < 0 ? 20000 * Math.pow(0.012, -v) : 20000, v > 0 ? 20 * Math.pow(250, v) : 10];
}

const decoded = new Map(); // track id -> AudioBuffer (the last two previewed tracks)
async function decode(ctx, track) {
  if (decoded.has(track.id)) return decoded.get(track.id);
  const res = await fetch(api.streamUrl(track.id));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await ctx.decodeAudioData(await res.arrayBuffer());
  decoded.set(track.id, buf);
  while (decoded.size > 2) decoded.delete(decoded.keys().next().value);
  return buf;
}

/**
 * Render the planned transition (AutoMix.previewPlan()) with `preBars` of the outgoing track before it and
 * `postBars` of the incoming track after it. ctx: the live AudioContext (for decoding and the sample rate).
 * @returns {Promise<AudioBuffer>}
 */
export async function renderTransition(ctx, plan, { preBars = 4, postBars = 4, gains = {}, keyLock = true } = {}) {
  const [outBuf, inBuf] = await Promise.all([decode(ctx, plan.outTrack), decode(ctx, plan.inTrack)]);
  const bar = plan.beatLen * 4, outRate = plan.outRate || 1, innRate = plan.innRate || 1;
  const drop = plan.drop != null;
  const pre = preBars * bar, post = postBars * bar;
  const span = drop ? (plan.drop - plan.begin) / outRate : plan.len / outRate; // wall seconds of the transition
  const total = pre + span + post + (drop ? 0 : 0.1);
  const sr = ctx.sampleRate, oc = new OfflineAudioContext(2, Math.ceil(total * sr), sr);
  // the master limiter (-1 dBFS ceiling), as on the live output
  const limiter = oc.createDynamicsCompressor();
  limiter.threshold.value = -6; limiter.knee.value = 4; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.12;
  const ceiling = oc.createGain(); ceiling.gain.value = 0.89;
  limiter.connect(ceiling); ceiling.connect(oc.destination);
  const dest = limiter;
  const deckChain = (buf, rate, gainDb, startOffsetSec = 0, playDurSec = 0) => {
    const src = oc.createBufferSource();
    // Apply phase-vocoder key-lock when rate deviates >0.2% from unity so preview/export preserves pitch
    if (keyLock && Math.abs(rate - 1) > 0.002 && playDurSec > 0 && typeof oc.createBuffer === 'function') {
      src.buffer = stretchSlice(oc, buf, startOffsetSec, playDurSec + 0.1, rate, 1);
      src.playbackRate.value = 1;
      src._preStretched = true;
    } else {
      src.buffer = buf; src.playbackRate.value = rate;
    }
    const eq = createEq(oc, 'isolator');
    const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 20000; lp.Q.value = 0.9;
    const hp = oc.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 10; hp.Q.value = 0.9;
    const fader = oc.createGain(); fader.gain.value = 0;
    const trim = oc.createGain(); trim.gain.value = dbToGain(gainDb || 0);
    src.connect(trim); trim.connect(eq.input); eq.output.connect(lp); lp.connect(hp); hp.connect(fader); fader.connect(dest);
    return { src, eq, lp, hp, fader, hpOut: hp };
  };
  const outStart = Math.max(0, plan.begin - pre * outRate);
  const inStart = Math.max(0, plan.inStart);
  const o = deckChain(outBuf, outRate, gains.out, outStart, pre + span + 0.1);
  const n = deckChain(inBuf, drop ? 1 : innRate, gains.inn, inStart, (drop ? 0 : span) + post + 0.1);
  const set = (d, t, L, side) => {
    const vol = L[side + 'Vol'];
    if (vol != null) d.fader.gain.setTargetAtTime(faderGain(vol, 'log') / FULL, t, 0.01);
    d.eq.set({ eqLow: L[side + 'Low'] ?? 0, eqMid: L[side + 'Mid'] ?? 0, eqHigh: L[side + 'High'] ?? 0 }, t, 0.008);
    const f = L[side + 'Filter'];
    if (f != null) { const [l, h] = filterHz(f); d.lp.frequency.setTargetAtTime(l, t, 0.02); d.hp.frequency.setTargetAtTime(h, t, 0.02); }
  };
  o.src.start(0, o.src._preStretched ? 0 : outStart);
  o.fader.gain.setValueAtTime(1, 0);
  if (!drop) {
    const lanes = plan.lanes || planLanes(plan.style, plan.kSwap);
    n.src.start(pre, n.src._preStretched ? 0 : inStart);
    for (const L of lanes) {
      const t = pre + L.k * span;
      const eff = plan.outTrack?.barFeatures && plan.inTrack?.barFeatures
        ? dynamicMixLevels(plan.style, L.k, plan.kSwap != null && L.k >= plan.kSwap ? plan.kSwap : null, { out: plan.outTrack, inn: plan.inTrack, outPos: plan.begin + L.k * span * outRate, inPos: inStart + L.k * span * innRate })
        : L;
      set(o, t, eff, 'out'); set(n, t, eff, 'in');
    }
    o.src.stop(pre + span + 0.05);
    n.fader.gain.setTargetAtTime(1, pre + span, 0.01);
  } else {
    // drop styles: the outgoing effect, then the incoming track drops in on the bar line at its own tempo
    const tDrop = pre + span;
    if (plan.style === 'echo' || plan.style === 'reverb') {
      const delay = oc.createDelay(4); delay.delayTime.value = Math.min(3.9, plan.beatLen * (plan.echoBeats || 0.75) / outRate);
      const fb = oc.createGain(); fb.gain.value = plan.style === 'reverb' ? 0.7 : 0.5;
      const send = oc.createGain(); send.gain.setValueAtTime(0, 0); send.gain.linearRampToValueAtTime(0.7, tDrop);
      const tailHp = oc.createBiquadFilter(); tailHp.type = 'highpass'; tailHp.frequency.value = 300;
      o.hpOut.connect(send); send.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(tailHp); tailHp.connect(dest);
      send.gain.setValueAtTime(0, tDrop + 0.01);
    }
    o.fader.gain.setValueAtTime(1, tDrop - 0.005); o.fader.gain.linearRampToValueAtTime(0, tDrop);
    o.src.stop(tDrop + 0.05);
    n.src.start(tDrop, n.src._preStretched ? 0 : inStart);
    n.fader.gain.setValueAtTime(1, tDrop);
  }
  return oc.startRendering();
}

/**
 * Play a rendered preview: on the headphone cue bus when the engine has one (the crowd keeps hearing the master),
 * else on the master. @returns {{ stop(): void, done: Promise<void>, where: 'headphones' | 'master' }}
 */
export function playPreview(engine, buffer, { toMaster = false } = {}) {
  const ctx = engine.ctx, src = ctx.createBufferSource(), g = ctx.createGain();
  src.buffer = buffer; g.gain.value = 0.9;
  const where = !toMaster && engine.cueBus ? 'headphones' : 'master';
  src.connect(g); g.connect(where === 'headphones' ? engine.cueBus : (engine.musicBus || engine.masterBus || ctx.destination));
  const done = new Promise((resolve) => { src.onended = () => { try { g.disconnect(); } catch { /* */ } resolve(); }; });
  src.start();
  return { stop: () => { try { src.stop(); } catch { /* ended */ } }, done, where };
}
