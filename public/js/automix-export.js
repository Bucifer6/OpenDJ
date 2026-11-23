// "Render this set" (docs/PRO_DJ_AUTOMIX_RESEARCH.md P6.5): export the automix's planned upcoming set to a WAV file
// offline, so a host can check a party set the day before.
//
// The set is: the current track from where it is → transition → the next track from where that transition left it →
// … Each transition is planned with the same section search as the live automix (planAdaptiveTransition, on the
// library copies) and rendered with renderTransition() (EQ, faders, filters, echo tails, the master limiter); the
// plain stretches between transitions go through the same graph (a 'cut' plan without its incoming deck), so level
// matching and the limiter sound the same everywhere. Output is written incrementally as 16-bit PCM Blob parts:
// renders are at most ~30 s plus the transitions, and decoding goes through automix-preview's two-track cache, so at
// most two tracks are decoded at a time.
// Approximations (on top of renderTransition's): tracks after the first play at their native tempo outside the
// overlaps (no tempo morph / ride-back), no tricks, no stems, no key lock.
import { planAdaptiveTransition } from './adaptive-dj.js';
import { planTransition, incomingStart, DROP_STYLES, SWAP_STYLES, phraseSwapPoint } from './automix.js';
import { renderTransition } from './automix-preview.js';
import { echoBeatsFor } from './dj-styles.js';

/** Bars of the incoming track rendered with each transition after it ends (holds echo / reverb tails). */
export const POST_BARS = 2;
/** Longest plain render (seconds of output) — bounds the float memory of one render. */
const CHUNK_SECONDS = 30;
/** Seconds rendered (and dropped) before each render so the limiter has settled at the seam. */
const PREROLL = 1;

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const endOf = (t) => Math.min(Number(t.duration) || 0, finite(t.endTime) && t.endTime > 0 ? t.endTime : Number(t.duration) || 0);
const nearestRatio = (raw) => [raw, raw * 2, raw / 2].reduce((a, b) => (Math.abs(Math.log(b)) < Math.abs(Math.log(a)) ? b : a));

/** Wall seconds of a planned transition (begin → handover / drop) and of its POST_BARS tail. */
export function transitionSpan(plan, postBars = POST_BARS) {
  const drop = plan.drop != null, outRate = plan.outRate || 1;
  const span = drop ? (plan.drop - plan.begin) / outRate : plan.len / outRate;
  const post = postBars * 4 * (plan.beatLen || 0.5);
  // where the incoming track is when the rendered transition (with its tail) ends
  const inTo = plan.inStart + (drop ? post : (span + post) * (plan.innRate || 1));
  return { span, post, seconds: span + post, outTo: drop ? plan.drop : plan.begin + plan.len, inTo };
}

/**
 * A render plan (the shape AutoMix.previewPlan() returns, as renderTransition reads it) from a section-search
 * result. out / inn: structure info (library copies); outRate: the outgoing track's playback rate.
 */
export function planFromAdaptive(out, inn, adaptive, outRate = 1) {
  const style = adaptive.style, drop = DROP_STYLES.has(style), timing = adaptive.timing;
  const outBpm = Number(out.bpm) || 0, inBpm = Number(inn.bpm) || 0;
  const innRate = drop || !outBpm || !inBpm ? 1 : nearestRatio(outBpm * outRate / inBpm);
  const inStart = adaptive.inStart ?? incomingStart(inn);
  const len = drop ? 0 : timing.len, lenIn = len * innRate / outRate;
  const swapAt = drop ? null : adaptive.swapIn ?? (SWAP_STYLES.has(style) ? phraseSwapPoint(inn, inStart, lenIn) : null);
  const kSwap = swapAt != null && lenIn > 0 ? clamp01((swapAt - inStart) / lenIn) : style === 'bassswap' ? 0.5 : null;
  return {
    style, why: adaptive.why, begin: timing.begin, len, drop: drop ? timing.drop : null, end: drop ? timing.drop : timing.begin + len,
    inStart, kSwap, outRate, innRate, beatLen: outBpm ? 60 / outBpm : 0.5, echoBeats: echoBeatsFor(out, inn),
    gains: { out: Number(out.gain) || 0, inn: Number(inn.gain) || 0 },
    outTrack: { id: out.id, title: out.title }, inTrack: { id: inn.id, title: inn.title },
  };
}

/**
 * Plan the transitions of a set: tracks (structure info, e.g. library copies) in play order; the first plays from
 * `start` (entered at `entry`) at `rate`, the others at their native tempo. firstPlan: an already planned first
 * transition (the live preview plan) to use when it fits. Returns one render plan per transition; the list stops
 * early when a pair cannot be planned after the previous transition.
 */
export function planSet(tracks, { start = 0, entry = start, rate = 1, firstPlan = null, keepSync, doubleDrops } = {}) {
  const plans = [];
  let position = start, enteredAt = entry;
  for (let i = 0; i + 1 < tracks.length; i++) {
    const out = tracks[i], inn = tracks[i + 1], outRate = i === 0 ? rate : 1;
    let plan = null;
    if (i === 0 && firstPlan && String(firstPlan.outTrack?.id) === String(out.id) && String(firstPlan.inTrack?.id) === String(inn.id)
      && firstPlan.begin >= position - 1e-6) plan = firstPlan;
    if (!plan) {
      const a = planAdaptiveTransition(out, inn, { position, entry: enteredAt, rate: outRate, keepSync, doubleDrops });
      if (a) plan = planFromAdaptive(out, inn, a, outRate);
    }
    if (!plan) {
      // no usable section plan (e.g. no beat grid): a cut on the outgoing track's mix-out point
      const t = planTransition(out, 'cut', { transitionBeats: 32, skipSilence: true });
      if (finite(t.drop) && t.begin >= position) plan = planFromAdaptive(out, inn, { style: 'cut', timing: t, inStart: incomingStart(inn), why: 'fallback cut' }, outRate);
    }
    if (!plan || plan.begin < position - 1e-6) break;
    plans.push(plan);
    enteredAt = plan.inStart;
    position = Math.max(plan.inStart, transitionSpan(plan).inTo);
  }
  return plans;
}

/**
 * Segment list of a set: [{ kind: 'track' | 'transition', trackId, from, to, at, seconds, … }]. Track segments play
 * trackId from `from` to `to` (track seconds) at `rate`; transition segments mix trackId (from → to) into inTrackId
 * (inFrom → inTo) with plans[plan]. `at` / `seconds` are set (output) time; segments are contiguous. tracks: [{ id,
 * duration, endTime? }]; plans[i]: the render plan of tracks[i] → tracks[i + 1] (fewer plans end the set early).
 * The set never runs past maxSeconds: a transition that would not fit ends the set where it would begin; the last
 * track is cut at the limit. cut: true when the limit shortened the set.
 */
export function setTimeline(tracks, plans, { start = 0, rate = 1, maxSeconds = Infinity, postBars = POST_BARS } = {}) {
  const segments = [];
  let t = 0, pos = start, cut = false;
  const plain = (track, from, to, r) => {
    let seconds = (to - from) / r;
    if (t + seconds > maxSeconds + 1e-9) { seconds = Math.max(0, maxSeconds - t); to = from + seconds * r; cut = true; }
    if (seconds > 1e-6) { segments.push({ kind: 'track', trackId: track.id, from, to, rate: r, at: t, seconds }); t += seconds; }
    return !cut;
  };
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i], r = i === 0 ? (plans[0]?.outRate || rate) : 1, plan = i + 1 < tracks.length ? plans[i] : null;
    if (!plan || plan.begin < pos - 1e-6) { plain(track, pos, Math.max(pos, endOf(track)), r); break; }
    if (!plain(track, pos, plan.begin, r)) break;
    const s = transitionSpan(plan, postBars);
    if (t + s.seconds > maxSeconds + 1e-9) { cut = true; break; }
    segments.push({ kind: 'transition', trackId: track.id, inTrackId: tracks[i + 1].id, plan: i, style: plan.style,
      from: plan.begin, to: s.outTo, inFrom: plan.inStart, inTo: s.inTo, at: t, seconds: s.seconds });
    t += s.seconds;
    pos = s.inTo;
  }
  return { segments, seconds: t, cut };
}

/** 44-byte WAV header for 16-bit PCM. */
export function wavHeader(frames, sampleRate, channels = 2) {
  const b = new DataView(new ArrayBuffer(44)), bytes = frames * channels * 2;
  const str = (o, s) => { for (let i = 0; i < s.length; i++) b.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); b.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, channels, true); b.setUint32(24, sampleRate, true);
  b.setUint32(28, sampleRate * channels * 2, true); b.setUint16(32, channels * 2, true); b.setUint16(34, 16, true);
  str(36, 'data'); b.setUint32(40, bytes, true);
  return b.buffer;
}

const aborted = () => (typeof DOMException === 'function' ? new DOMException('Export cancelled', 'AbortError') : Object.assign(new Error('Export cancelled'), { name: 'AbortError' }));

/** The automix's upcoming set: { tracks (library copies), start, entry, rate, firstPlan }. */
function upcomingSet(app, maxTracks) {
  const a = app.automix, lib = app.library;
  const fresh = (t) => (t && { ...t, ...(lib?.track?.(t.id) || {}) }) || null;
  const cur = a?.enabled && a.current?.track ? a.current : null;
  const queued = (a?.queue || []).slice(cur ? a.idx : Math.max(0, (a?.idx || 0) - 1)); // stopped: from the last track it played
  const live = (a?.livePlan || []).filter((t) => !queued.some((q) => String(q.id) === String(t.id)));
  const list = [...(cur ? [cur.track] : []), ...queued, ...live].slice(0, Math.max(1, maxTracks)).map(fresh).filter(Boolean);
  if (!list.length) return null;
  if (cur) {
    // the playing deck's grid (it may have been edited) over the library copy
    list[0] = { ...list[0], bpm: cur.bpm || list[0].bpm, gridOffset: cur.gridOffset ?? list[0].gridOffset, duration: cur.duration || list[0].duration };
  }
  const start = cur ? Math.max(0, cur.position || 0) : incomingStart(list[0]);
  let firstPlan = null;
  try { firstPlan = cur && !a.transition ? a.previewPlan() : null; } catch { firstPlan = null; }
  return { tracks: list, start, entry: cur ? cur._autoMixEntry ?? start : start, rate: cur?.rate || 1, firstPlan, keepSync: a?.opts?.keepSync, doubleDrops: a?.opts?.doubleDrops === false ? false : undefined };
}

/**
 * Render the automix's planned upcoming set to a WAV Blob (16-bit stereo at the AudioContext's sample rate).
 * onProgress({ track, tracks, done (0..1), seconds, timeline }) is called before each render.
 * @returns {Promise<Blob>}
 */
export async function exportSet(app, { maxTracks = 6, maxMinutes = 30, onProgress, signal } = {}) {
  const ctx = app.engine.ctx, sr = ctx.sampleRate;
  const set = upcomingSet(app, maxTracks);
  if (!set) throw new Error('Nothing planned to export');
  const plans = planSet(set.tracks, set);
  const timeline = setTimeline(set.tracks, plans, { start: set.start, rate: set.rate, maxSeconds: maxMinutes * 60 });
  if (!timeline.segments.length) throw new Error('Nothing to export');
  const byId = new Map(set.tracks.map((t) => [String(t.id), t]));
  const levelMatch = app.automix?.opts?.levelMatch !== false;
  const gainOf = (t) => (levelMatch ? Number(t?.gain) || 0 : 0);
  const totalFrames = Math.round(timeline.seconds * sr);
  const fadeIn = Math.round(0.05 * sr), fadeOut = Math.round((timeline.cut ? 3 : 0.05) * sr);
  const blobs = [], parts = [];
  let written = 0;
  const write = (buffer, offset, frames) => {
    const L = buffer.getChannelData(0), R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    const out = new Int16Array(frames * 2);
    for (let i = 0; i < frames; i++) {
      const j = offset + i, n = written + i;
      let g = 1;
      if (n < fadeIn) g = n / fadeIn;
      if (n >= totalFrames - fadeOut) g = Math.min(g, Math.max(0, (totalFrames - n) / fadeOut));
      const l = j < L.length ? L[j] * g : 0, r = j < R.length ? R[j] * g : 0;
      out[2 * i] = Math.max(-32768, Math.min(32767, Math.round(l * 32767)));
      out[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(r * 32767)));
    }
    parts.push(out); written += frames;
    // fold the parts into Blobs as we go, so the browser may keep them out of the JS heap
    if (parts.length >= 8) blobs.push(new Blob(parts.splice(0)));
  };
  const trackNo = (seg) => set.tracks.findIndex((t) => String(t.id) === String(seg.kind === 'transition' ? seg.inTrackId : seg.trackId)) + 1;
  const tracksInSet = new Set(timeline.segments.flatMap((s) => [s.trackId, s.inTrackId].filter((x) => x != null).map(String))).size;
  const progress = (seg) => onProgress?.({ track: Math.max(1, trackNo(seg)), tracks: tracksInSet, done: totalFrames ? written / totalFrames : 1, seconds: timeline.seconds, timeline });
  for (let k = 0; k < timeline.segments.length; k++) {
    const seg = timeline.segments[k];
    const endFrame = Math.round((seg.at + seg.seconds) * sr);
    if (seg.kind === 'transition') {
      if (signal?.aborted) throw aborted();
      progress(seg);
      const plan = plans[seg.plan], bar = 4 * (plan.beatLen || 0.5);
      const preBars = Math.min(PREROLL, plan.begin / (plan.outRate || 1)) / bar;
      const buf = await renderTransition(ctx, plan, { preBars, postBars: POST_BARS, gains: levelMatch ? { out: gainOf(byId.get(String(seg.trackId))), inn: gainOf(byId.get(String(seg.inTrackId))) } : {} });
      write(buf, Math.round(preBars * bar * sr), endFrame - written);
      continue;
    }
    // a plain stretch: rendered in chunks through the same graph (a cut plan whose drop lies past the chunk)
    const track = byId.get(String(seg.trackId)), idx = set.tracks.indexOf(track);
    // decode the pair together when the set starts, else the track is already cached from its transition
    const partner = idx === 0 && set.tracks[1] && timeline.segments.some((s) => s.kind === 'transition') ? set.tracks[1] : track;
    for (let w0 = 0; w0 < seg.seconds - 1e-9; w0 += CHUNK_SECONDS) {
      if (signal?.aborted) throw aborted();
      progress(seg);
      const w1 = Math.min(seg.seconds, w0 + CHUNK_SECONDS);
      const from = seg.from + w0 * seg.rate, to = seg.from + w1 * seg.rate;
      const pre = Math.min(PREROLL, from / seg.rate), beatLen = 0.5;
      const plan = { style: 'cut', begin: from, drop: to + 0.05 * seg.rate, len: 0, inStart: 0, outRate: seg.rate, innRate: 1, beatLen,
        outTrack: { id: track.id }, inTrack: { id: partner.id } };
      const buf = await renderTransition(ctx, plan, { preBars: pre / (4 * beatLen), postBars: 0, gains: { out: gainOf(track), inn: 0 } });
      const chunkEnd = w1 >= seg.seconds - 1e-9 ? endFrame : Math.round((seg.at + w1) * sr);
      write(buf, Math.round(pre * sr), chunkEnd - written);
    }
  }
  onProgress?.({ track: tracksInSet, tracks: tracksInSet, done: 1, seconds: timeline.seconds, timeline });
  if (parts.length) blobs.push(new Blob(parts.splice(0)));
  return new Blob([wavHeader(written, sr), ...blobs], { type: 'audio/wav' });
}

/** Download file name: "OpenDJ set YYYY-MM-DD HHmm.wav" (local time). */
export function exportFileName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `OpenDJ set ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}.wav`;
}
