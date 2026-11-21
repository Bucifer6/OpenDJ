// AI MC bridge: reports what is playing to the AI MC add-on (ai-mc/server.js, through /api/aimc on this server),
// plays its announcements on the master (music ducked underneath, so they go out on the broadcast and recording too)
// and queues the songs listeners request. Does nothing while AI MC is not running.
import { scoreTransition, explain } from './smartmix.js';
import { renderSound } from './audio/sampler.js';
import { musicMatch, filterActive } from './ai-mc-music.js';

const POLL_MS = 1500;
const DUCK_DB = -18; // music level under the AI voice
const VOICE_GAIN = 1.0; // the voice file is already loudness-normalised: more gain only clips on the master limiter
// Recorded effects from AI MC (ai-mc/sfx/<role>.mp3); OpenDJ's own air horn when there is none.
let sfxRoles = new Set(), sfxVersion = '';
const sfxCache = new Map();
function sfxBuffer(ctx, id) {
  if (!sfxCache.has(id)) {
    const url = sfxRoles.has(id) ? `/api/aimc/sfx/${id}?v=${encodeURIComponent(sfxVersion)}` : id === 'airhorn' ? 'samples/air-horn.mp3' : null;
    const p = url ? fetch(url, { credentials: 'same-origin' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then((b) => ctx.decodeAudioData(b)) : renderSound(id, ctx.sampleRate);
    sfxCache.set(id, p.catch(() => { sfxCache.delete(id); return null; }));
  }
  return sfxCache.get(id);
}
const hornBuffer = (ctx) => sfxBuffer(ctx, 'airhorn');

/** Puts the recorded effects on OpenDJ's sampler pads (pad 1 = air horn …), asked for from the AI MC panel. */
async function loadSamplerPads() {
  const a = app(), sampler = a.engine?.sampler;
  if (!sampler?.loadFile) return;
  let i = 0;
  for (const role of ['airhorn', 'siren', 'riser', 'impact', 'rewind', 'scratch', 'laser', 'drop']) {
    if (!sfxRoles.has(role) || i >= (sampler.slots?.length || 8)) continue;
    try {
      const blob = await (await fetch(`/api/aimc/sfx/${role}?v=${Date.now()}`, { credentials: 'same-origin' })).blob();
      await sampler.loadFile(i++, new File([blob], `${role}.mp3`, { type: 'audio/mpeg' }));
    } catch (e) { console.warn('[ai-mc] sampler pad', role, e); }
  }
  a.toast?.(`AI MC: ${i} efecte puse pe pad-urile sampler-ului`);
}
let playing = false;
const queue = [];
let offlineSince = 0;

const app = () => window.opendj;
const meta = (t) => (t ? { id: t.id, title: t.title || '', artist: t.artist || '' } : null);

function snapshot() {
  const a = app(); if (!a?.engine) return null;
  const am = a.automix;
  const decks = a.engine.decks.slice(0, 2);
  let cur = am?.enabled ? am.current : null;
  if (!cur?.playing) cur = decks.filter((d) => d.playing && d.track).sort((x, y) => (y.remaining || 0) - (x.remaining || 0))[0] || null;
  return {
    current: cur?.track ? { ...meta(cur.track), remaining: Math.round(cur.remaining || 0) } : null,
    next: am?.enabled ? meta(am.nextTrack?.()) : null,
    automix: !!am?.enabled,
  };
}

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// ------------------------------------------------------------------ DJ director
// Once per playing track: the smart-mix score (tempo, Camelot key, energy, genre, variety) shortlists candidates from
// the whole library; the AI picks one plus the transition style and FX; this page executes the plan on the beat.
let directorOn = false;
let music = null, musicKey = '';   // what the organiser allows (set in the AI MC panel)
const requested = new Set();   // tracks listeners asked for: the DJ never replaces them
const played = [];             // recent tracks (history for the AI and for variety)
let lastCurId = null, pendingDirector = null;
let dj = null;                 // { nextId, fx: [{sound, when}], startDone, dropDone }

const num = (v) => (Number.isFinite(+v) && +v > 0 ? +v : 0);
const looksLikeId = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f]{16,}$/i.test(String(s || ''));
const fileTitle = (t) => String(t.fileName || t.path || t.localPath || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
/** "Artist - Title"; tracks without tags (title = an id) fall back to the file name. */
const label = (t) => {
  const title = looksLikeId(t.title) ? '' : t.title;
  return [t.artist, title].filter(Boolean).join(' - ') || fileTitle(t) || 'piesă fără nume';
};
const info = (t) => ({ id: t.id, label: label(t), bpm: num(t.bpm), key: t.key ? String(t.key) : '', energy: Number.isFinite(+t.energy) ? +t.energy : null, genre: t.genre || '' });
// ±4 %: beyond that the beat-matched song is audibly slower / faster than the original (and off-pitch without key lock)
const tempoOk = (a, b) => { if (!a || !b) return true; const r = b / a; return Math.abs(r - 1) < 0.04 || Math.abs(r - 2) < 0.08 || Math.abs(r - 0.5) < 0.02; };
const artistOf = (t) => String(t.artist || '').toLowerCase().split(/\s*(?:,|&|feat\.?|ft\.?|vs\.?|x)\s+/)[0].trim();

function buildDirector(cur) {
  const a = app(), am = a.automix;
  const curT = a.library?.track?.(cur.id) || cur;
  const next = am.nextTrack?.();
  const base = { forTrack: cur.id, filterKey: musicKey, current: info(curT), history: played.slice(-5).map(label) };
  if (next && requested.has(next.id)) return { ...base, locked: true, candidates: [info(next)] };
  const playedIds = new Set([...played.map((t) => t.id), ...am.queue.slice(0, am.idx).map((t) => t.id), cur.id]);
  const recentArtists = [...played.slice(-4), curT].map(artistOf).filter(Boolean);
  // the organiser's music filter (genres, languages, words) first, then tempo: ±4 %, wider if too few fit
  const allowed = [];
  for (const t of a.library.tracks.values()) {
    if (playedIds.has(t.id) || t.missing || t.unreadable || !num(t.bpm)) continue;
    if (filterActive(music) && !musicMatch(t, music)) continue;
    allowed.push(t);
  }
  const bpm = num(curT.bpm);
  let pool = allowed.filter((t) => tempoOk(bpm, num(t.bpm)));
  if (pool.length < 6) pool = allowed.filter((t) => !bpm || Math.abs(num(t.bpm) / bpm - 1) < 0.08);
  if (pool.length < 6) pool = allowed; // a genre / language switch can need a bigger tempo jump (automix eases it back)
  if (pool.length > 8000) pool = pool.sort(() => Math.random() - 0.5).slice(0, 8000); // keep it fast on huge libraries
  const scored = pool.map((t) => ({ t, s: scoreTransition(curT, t, { recentArtists, playedIds }).score })).sort((x, y) => y.s - x.s);
  const out = [], artists = new Set();
  for (const { t } of scored) {
    const ak = artistOf(t);
    if (ak && artists.has(ak)) continue;
    artists.add(ak); out.push({ ...info(t), why: explain(curT, t) });
    if (out.length >= 14) break;
  }
  return out.length ? { ...base, locked: false, candidates: out } : null;
}

function applyPlan(p) {
  const a = app(), am = a.automix;
  if (!am?.enabled || !am.current?.track || am.current.track.id !== p.forTrack) return; // stale plan
  if (am.transition || (am.current.remaining || 0) < 20) return; // too late to change this transition
  const t = a.library?.track?.(p.nextId);
  if (!t) return;
  const nx = am.nextTrack();
  if (p.viaMcp) {
    // AI MC already queued the track, the style and the mix-out point through OpenDJ's MCP server: only the FX are ours
    dj = { nextId: nx?.id, fx: p.fx || [], startDone: false, dropDone: false };
    return;
  }
  if (!p.locked && !(nx && requested.has(nx.id)) && nx?.id !== t.id) {
    // a newer plan (e.g. the music filter changed) replaces the DJ's previous pick instead of stacking up
    if (dj?.nextId && nx?.id === dj.nextId && !dj.startDone) am.remove(am.idx);
    am.insertNext([t]);
    // the pick may also sit later in the automix playlist: don't play it twice
    for (let i = am.queue.length - 1; i > am.idx; i--) if (am.queue[i].id === t.id) am.remove(i);
  }
  am.setOverride(am.idx, p.style);
  dj = { nextId: am.nextTrack()?.id, fx: p.fx || [], startDone: false, dropDone: false };
  a.toast?.(`🎛️ DJ: urmează ${p.label} · ${p.style}${dj.fx.length ? ' · ' + dj.fx.map((f) => f.sound).join(' + ') : ''}`);
}

/** Next beat of a deck in AudioContext time (FX land on the beat, not "whenever the poll ran"). */
function onBeat(deck) {
  const ctx = app().engine.ctx, now = ctx.currentTime + 0.03;
  if (!deck?.bpm || !deck.playing) return now;
  const len = deck.beatLen / (deck.rate || 1);
  const left = (1 - deck.beatPhase()) * len;
  return now + (left < 0.04 ? left + len : left);
}
async function playSound(id, when) {
  const eng = app().engine;
  try {
    const buf = await sfxBuffer(eng.ctx, id);
    if (!buf) return;
    const s = eng.ctx.createBufferSource(); s.buffer = buf;
    const g = eng.ctx.createGain(); g.gain.value = 0.8;
    s.connect(g); g.connect(eng.masterBus);
    s.start(Math.max(when, eng.ctx.currentTime));
    s.onended = () => g.disconnect();
  } catch (e) { console.warn('[ai-mc] FX', id, e); }
}
function fireFx(when, deck) {
  if (!dj) return;
  const list = dj.fx.filter((f) => f.when === when);
  if (!list.length) return;
  const at = onBeat(deck);
  list.forEach((f, i) => playSound(f.sound, at + i * 0.05));
}
function watchTransitions() {
  const am = app().automix;
  am.on('transition', () => {
    // the transition into the DJ's pick started: "start" FX on the outgoing deck's beat
    const inc = am.other(am.current);
    if (dj && !dj.startDone && inc?.track?.id === dj.nextId) { dj.startDone = true; fireFx('start', am.current); }
  });
  setInterval(() => {
    // the DJ's pick became the playing track: "drop" FX on its beat
    const cur = am.current;
    if (dj && !dj.dropDone && am.enabled && cur?.track?.id === dj.nextId && cur.playing) { dj.dropDone = true; fireFx('drop', cur); }
  }, 100);
}

function trackChanged(cur) {
  const a = app();
  if (lastCurId) { const prev = a.library?.track?.(lastCurId); if (prev) played.push(prev); if (played.length > 30) played.shift(); }
  lastCurId = cur?.id || null;
  if (cur?.id) requested.delete(cur.id);
  if (directorOn && cur && a.automix?.enabled) {
    try { pendingDirector = buildDirector(cur); } catch (e) { console.warn('[ai-mc] director', e); pendingDirector = null; }
  }
}

function queueTracks(ids) {
  const a = app();
  for (const id of ids) {
    const t = a.library?.track?.(id);
    if (!t) continue;
    requested.add(id);
    if (a.automix?.enabled) { a.automix.insertNext([t]); a.toast?.(`AI MC: cerere „${t.title}” – urmează`); }
    else {
      const idle = a.engine.decks.slice(0, 2).findIndex((d) => !d.playing);
      if (idle >= 0) a.loadTrack(idle, id).catch(() => {});
      a.toast?.(`AI MC: cerere „${t.title}”${idle >= 0 ? ` încărcată pe deck ${idle + 1}` : ''}`);
    }
  }
}

async function playNext() {
  if (playing || !queue.length) return;
  playing = true;
  const item = queue.shift();
  const a = app(), eng = a.engine;
  try {
    if (!item.audio) { a.toast?.(`🎤 ${item.text.slice(0, 200)}`); return; }
    const buf = await (await fetch(item.audio, { credentials: 'same-origin' })).arrayBuffer();
    const audio = await eng.ctx.decodeAudioData(buf);
    await eng.resume?.();
    const src = eng.ctx.createBufferSource(); src.buffer = audio;
    const g = eng.ctx.createGain(); g.gain.value = VOICE_GAIN;
    src.connect(g); g.connect(eng.masterBus);
    const t = eng.ctx.currentTime;
    if (!eng.talkover) eng.duck.gain.setTargetAtTime(Math.pow(10, DUCK_DB / 20), t, 0.08);
    // MC entrance: air horn first, the voice comes in on its tail
    let voiceAt = t + 0.3;
    const horn = item.fx === 'airhorn' ? await hornBuffer(eng.ctx) : null;
    if (horn) {
      const h = eng.ctx.createBufferSource(); h.buffer = horn;
      const hg = eng.ctx.createGain(); hg.gain.value = 0.9;
      h.connect(hg); hg.connect(eng.masterBus); h.start(t + 0.05);
      h.onended = () => hg.disconnect();
      voiceAt = t + 0.05 + Math.min(horn.duration * 0.8, 2.2);
    }
    a.toast?.(`🎤 ${item.text.slice(0, 140)}${item.text.length > 140 ? '…' : ''}`);
    await new Promise((res) => { src.onended = res; src.start(voiceAt); });
    if (!eng.talkover) eng.duck.gain.setTargetAtTime(1, eng.ctx.currentTime, 0.5);
    g.disconnect();
  } catch (e) {
    console.warn('[ai-mc] announcement failed', e);
  } finally {
    post('/api/aimc/done', { id: item.id }).catch(() => {});
    playing = false;
    setTimeout(playNext, 1200);
  }
}

async function tick() {
  const s = snapshot();
  if (s) {
    try {
      if ((s.current?.id || null) !== lastCurId) trackChanged(s.current);
      if (pendingDirector) { s.director = pendingDirector; pendingDirector = null; }
      const r = await post('/api/aimc/state', s);
      if (r.offline) offlineSince ||= Date.now(); else offlineSince = 0;
      const mk = JSON.stringify(r.music || null);
      const musicChanged = r.music !== undefined && mk !== musicKey;
      if (musicChanged) { music = r.music || null; musicKey = mk; }
      if (r.director !== undefined && r.director !== directorOn) {
        directorOn = !!r.director;
        if (directorOn && s.current) { lastCurId = null; trackChanged(s.current); } // plan the current track right away
      } else if (musicChanged && directorOn && s.current && app().automix?.enabled) {
        // the organiser changed the music: re-plan the next track for the one playing now
        try { pendingDirector = buildDirector(s.current); } catch (e) { console.warn('[ai-mc] director', e); }
      }
      if (Array.isArray(r.sfx)) {
        const v = r.sfx.join(',') + '|' + (r.sfxStamp || '');
        if (v !== sfxVersion) { sfxRoles = new Set(r.sfx); sfxVersion = v; sfxCache.clear(); }
      }
      if (r.loadSampler) loadSamplerPads();
      if (r.queue?.length) queueTracks(r.queue);
      for (const p of r.plans || []) applyPlan(p);
      if (r.play?.length) { queue.push(...r.play); playNext(); }
    } catch { /* OpenDJ server busy / logged out */ }
  }
  // poll slower while AI MC is not running
  setTimeout(tick, offlineSince && Date.now() - offlineSince > 30000 ? 10000 : POLL_MS);
}

(function wait() { if (app()?.engine && app()?.automix) { watchTransitions(); tick(); } else setTimeout(wait, 1000); })();
