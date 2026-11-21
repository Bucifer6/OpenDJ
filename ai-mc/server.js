// AI MC for OpenDJ: listeners' page (live stream + chat + requests/dedications), a local-LLM MC/DJ/lăutar persona
// and the bridge OpenDJ uses to put the AI voice on air and queue requested songs.
//
//   OpenDJ  --Icecast source (PUT /live)-->  AI MC  --/live (MP3)-->  friends' browsers
//   OpenDJ page <--/api/aimc/* proxy--> AI MC /bridge/*   (announcement audio, songs to queue, now playing)
//   AI MC --> Ollama (/api/chat), Piper TTS + FFmpeg voice FX
//
// Run: node ai-mc/server.js   (no npm dependencies)
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA, loadConfig, saveConfig, listPersonas, savePersona, loadMemory, saveMemory } from './lib/store.js';
import { generate, listModels, buildMessages, TASK_TYPES, direct, SOUNDS, modeOf, radioTalk, musicFromPrompt } from './lib/llm.js';
import { speak, ttsStatus, cleanupAudio, xttsHealth, makeReference, makeSfx } from './lib/tts.js';
import { findTracks, label } from './lib/match.js';
import { wikiSearch, weatherNow, headlines } from './lib/facts.js';
import { McpClient } from './lib/mcp-client.js';
import { musicMatch, describe as describeMusic, genresOf, languageOf } from '../public/js/ai-mc-music.js';

const LANGS = ['ro', 'en', 'es', 'other'];
/** Sanitised music filter (what the AI DJ may play). */
function cleanMusic(m = {}) {
  return {
    genres: (Array.isArray(m.genres) ? m.genres : []).map((g) => str(g, 40)).filter(Boolean).slice(0, 30),
    romanian: !!m.romanian,
    languages: (Array.isArray(m.languages) ? m.languages : LANGS).filter((l) => LANGS.includes(l)),
    include: str(m.include, 200), exclude: str(m.exclude, 200),
  };
}

let config = loadConfig();
if (!config.sourcePassword) config.sourcePassword = crypto.randomBytes(9).toString('base64url');
if (!config.adminPassword) config.adminPassword = crypto.randomBytes(6).toString('base64url');
saveConfig(config);

const PUBLIC = path.join(ROOT, 'public');
// OpenDJ's remote-control (MCP) server: the token comes from OpenDJ → Settings → Remote control (scopes read + playback)
let mcp = new McpClient(config.mcp || {});
const VOICES = path.join(ROOT, 'voices');
// Recorded sound effects (ai-mc/sfx/<role>.mp3). Kept out of git: their licences (e.g. Pixabay) allow use, not redistribution.
const SFX = path.join(ROOT, 'sfx');
const SFX_ROLES = ['airhorn', 'siren', 'riser', 'impact', 'rewind', 'scratch', 'laser', 'drop'];
const sfxAvailable = () => SFX_ROLES.filter((r) => fs.existsSync(path.join(SFX, r + '.mp3')));
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const uid = () => crypto.randomBytes(6).toString('hex');
const now = () => Date.now();
const str = (v, n = 300) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

// ------------------------------------------------------------------ state
const state = {
  source: null, sourceType: 'audio/mpeg', burst: [], burstBytes: 0,
  listeners: new Set(), sse: new Set(),
  chat: [], streamTitle: '',
  current: null, next: null, automix: false, bridgeAt: 0,
  trackChanges: 0, lastNextId: null,
  jobs: [], busy: false, lastError: '',
  ann: new Map(), toQueue: [], pending: [], outputs: [], plans: [], directed: new Set(), radioRecent: [],
  tracks: { at: 0, list: [] },
};
const HORN_TASKS = new Set(['dedicatie', 'versuri', 'cerere']);
const persona = () => listPersonas()[config.persona] || Object.values(listPersonas())[0];
const nowLabel = () => (state.current ? label(state.current) : state.streamTitle || '');

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of state.sse) r.write(msg);
}
function publicState() {
  const p = persona();
  return { station: config.stationName, onAir: !!state.source, nowPlaying: nowLabel(), next: state.next ? label(state.next) : '', listeners: state.listeners.size, persona: p?.name || '' };
}
let stateTimer = null;
const pushState = () => { clearTimeout(stateTimer); stateTimer = setTimeout(() => broadcast('state', publicState()), 150); };

function postChat(kind, name, text, extra = {}) {
  const m = { id: uid(), at: now(), kind, name: str(name, 40), text: str(text, 1200), ...extra };
  state.chat.push(m); if (state.chat.length > 150) state.chat.shift();
  broadcast('chat', m);
  return m;
}

async function libraryTracks() {
  if (now() - state.tracks.at < 60000 && state.tracks.list.length) return state.tracks.list;
  try {
    const r = await fetch(config.opendjUrl.replace(/\/+$/, '') + '/api/tracks', { signal: AbortSignal.timeout(8000) });
    if (r.ok) state.tracks = { at: now(), list: (await r.json()).map((t) => ({ id: t.id, title: t.title, artist: t.artist, genre: t.genre, album: t.album, year: t.year, path: t.path || t.localPath || t.fileName, bpm: t.bpm, missing: t.missing, unreadable: t.unreadable })) };
  } catch { /* OpenDJ not running */ }
  return state.tracks.list;
}

// ------------------------------------------------------------------ AI job queue (one at a time: the LLM is slow)
/** job: { task, vars, onAir, chat, trigger: {type:'now'} | {type:'track', trackId}, from } */
function enqueue(job) {
  if (state.jobs.length >= (config.auto.maxQueue || 20)) return false;
  state.jobs.push({ id: uid(), at: now(), ...job });
  work();
  return true;
}
async function work() {
  if (state.busy) return;
  const job = state.jobs.shift();
  if (!job) return;
  state.busy = true;
  try {
    const p = persona();
    if (job.task === 'director') { await runDirector(p, job.vars); return; }
    if (job.task === 'radio') { await runRadio(p, job); return; }
    const text = await generate(config, p, job.task, job.vars);
    if (!text) throw new Error('Modelul nu a răspuns nimic');
    state.lastError = '';
    const out = { id: uid(), at: now(), persona: p.id, type: job.task, text, prompt: job.vars };
    state.outputs.unshift(out); state.outputs.length = Math.min(state.outputs.length, 60);
    if (job.chat) postChat('ai', p.name, text);
    if (job.onAir) {
      let audio = null;
      try { audio = await speak(config, text, p.voice, p); } catch (e) { state.lastError = 'TTS: ' + e.message; console.error('[ai-mc] TTS', e.message); }
      state.ann.set(out.id, { id: out.id, text, audioId: audio?.id || null, trigger: job.trigger || { type: 'now' }, at: now(), status: 'ready', task: job.task, fx: HORN_TASKS.has(job.task) ? 'airhorn' : null });
      if (!job.chat) postChat('ai', p.name, text, { onAir: true });
    }
  } catch (e) {
    state.lastError = e.message;
    console.error('[ai-mc]', job.task, e.message);
    if (job.from) postChat('system', 'Radio', `DJ-ul AI nu e disponibil acum (${e.message.slice(0, 80)}).`);
  } finally {
    state.busy = false;
    setImmediate(work);
  }
}

// ------------------------------------------------------------------ DJ director (Gemma picks the next track, the transition and the FX)
const directorOn = () => config.auto.director !== false;
// How much the DJ shows off. Enforced here, not only asked for in the prompt (models overdo effects and tricks).
const INTENSITY = {
  subtle: { fxGap: 4, fxMax: 1, shoutGap: 3, trickGap: 5 },
  normal: { fxGap: 2, fxMax: 2, shoutGap: 2, trickGap: 3 },
  hype: { fxGap: 0, fxMax: 2, shoutGap: 0, trickGap: 0 },
};
const TRICKS = new Set(['backspin', 'brake', 'cut', 'loop']);
const djCount = { n: 0, lastFx: -99, lastShout: -99, lastTrick: -99 };
function tame(plan, locked, persona) {
  const radio = modeOf(persona) === 'radio';
  const base = INTENSITY[config.auto.djIntensity] || INTENSITY.subtle;
  // a radio host: no tricks, no sound effects, talks only every few tracks
  const L = radio ? { ...base, fxGap: Infinity, trickGap: Infinity, shoutGap: Math.max(3, base.shoutGap) } : base;
  // 'Anunță fiecare a N-a piesă' in the panel is also how often the DJ may talk (0 = never)
  const every = Number(config.auto.introEvery);
  const shoutGap = every === 0 ? Infinity : Math.max(L.shoutGap, every || 0);
  const n = ++djCount.n;
  if (TRICKS.has(plan.style)) {
    if (n - djCount.lastTrick < L.trickGap) plan.style = 'blend'; else djCount.lastTrick = n;
  }
  if (plan.fx.length) {
    if (n - djCount.lastFx < L.fxGap) plan.fx = []; else { plan.fx = plan.fx.slice(0, L.fxMax); djCount.lastFx = n; }
  }
  // a requested track already gets its own spoken announcement: no second voice on top of it
  if (radio) {
    // a radio host doesn't shout over transitions: every few tracks it researches and talks over the next intro
    plan.shout = '';
    plan.talk = !locked && n - djCount.lastShout >= shoutGap;
    if (plan.talk) djCount.lastShout = n;
  } else if (plan.shout && (locked || n - djCount.lastShout < shoutGap)) plan.shout = ''; else if (plan.shout) djCount.lastShout = n;
  return plan;
}

// ------------------------------------------------------------------ radio host segments (research, then talk)
function enqueueRadio(trackId, prevLabel) {
  if (!trackId || state.jobs.some((j) => j.task === 'radio' && j.vars.trackId === trackId)) return;
  enqueue({ task: 'radio', vars: { trackId, prev: prevLabel || '' }, onAir: true, trigger: { type: 'track', trackId } });
}
async function runRadio(p, job) {
  const t0 = now();
  const t = (await libraryTracks()).find((x) => x.id === job.vars.trackId);
  if (!t) return;
  const info = { label: label(t), artist: t.artist, title: t.title, year: t.year, album: t.album, genre: t.genre };
  const { text, searched } = await radioTalk(config, p, info, { prev: job.vars.prev, recent: state.radioRecent.slice(-6), topics: config.auto.radioTopics !== false },
    { search: wikiSearch, weather: () => weatherNow(config.city), news: headlines });
  console.log(`[ai-mc] Radio (${((now() - t0) / 1000).toFixed(0)}s${searched.length ? ', a căutat: ' + searched.join(' | ') : ''}): ${text || '(tace)'}`);
  state.outputs.unshift({ id: uid(), at: now(), persona: p.id, type: 'radio', text: text ? `${text}${searched.length ? `\n(a căutat: ${searched.join(' | ')})` : ''}` : `(a ales să nu spună nimic la ${info.label})`, prompt: info });
  if (!text) return;
  state.radioRecent.push(text); if (state.radioRecent.length > 12) state.radioRecent.shift();
  let audio = null;
  try { audio = await speak(config, text, p.voice, p); } catch (e) { state.lastError = 'TTS: ' + e.message; }
  const id = uid();
  state.ann.set(id, { id, text, audioId: audio?.id || null, trigger: job.trigger, at: now(), status: 'ready', task: 'radio', fx: null });
  postChat('ai', p.name, text, { onAir: true });
}
async function runDirector(p, d) {
  const t0 = now();
  // through OpenDJ's MCP server (when set up): the playing track's sections, so the DJ also picks WHEN to mix out
  if (mcp.configured) {
    try {
      const s = await mcp.call('get_track_structure');
      if (s?.sections?.length) d.structure = s;
      state.mcpOk = true;
    } catch (e) { state.mcpOk = false; state.mcpError = e.message; }
  }
  d.mood = str(config.musicMood, 300);
  const plan = await direct(config, p, d, state.chat.filter((m) => m.kind === 'user').slice(-6), sfxAvailable());
  if (!plan.nextId) throw new Error('DJ: nicio piesă aleasă');
  tame(plan, d.locked, p);
  state.lastError = '';
  // execute through MCP: next track, transition style, mix-out point; the page bridge only does voice and beat-synced FX
  let viaMcp = false;
  if (mcp.configured && state.mcpOk) {
    try {
      if (!d.locked) await mcp.call('automix_queue_next', { track_id: plan.nextId });
      await mcp.call('automix_set_transition', { style: plan.style });
      if (plan.mixOut != null) await mcp.call('automix_set_mix_out', { position: plan.mixOut });
      viaMcp = true;
    } catch (e) { state.mcpError = e.message; console.error('[ai-mc] MCP:', e.message, '(folosesc bridge-ul)'); }
  }
  const fxTxt = plan.fx.map((f) => `${SOUNDS[f.sound]} la ${f.when === 'start' ? 'început' : 'drop'}`).join(', ');
  const outTxt = plan.mixOut != null ? ` · iese la ${Math.round(plan.mixOut)} s (${plan.mixOutSection})` : '';
  console.log(`[ai-mc] DJ (${((now() - t0) / 1000).toFixed(0)}s${viaMcp ? ', MCP' : ''}): ${plan.next?.label} · ${plan.style}${outTxt}${fxTxt ? ' · ' + fxTxt : ''} · ${plan.why}`);
  state.outputs.unshift({ id: uid(), at: now(), persona: p.id, type: 'dj', text: `Urmează: ${plan.next?.label}\nTrecere: ${plan.style}${outTxt}${fxTxt ? ' + ' + fxTxt : ''}${viaMcp ? ' (prin MCP)' : ''}\nDe ce: ${plan.why}${plan.shout ? '\nStrigă: ' + plan.shout : ''}`, prompt: {} });
  state.plans.push({ forTrack: d.forTrack, nextId: plan.nextId, style: plan.style, fx: plan.fx, locked: !!d.locked, label: plan.next?.label, viaMcp });
  if (!d.locked) postChat('system', 'DJ', `🎛️ Urmează ${plan.next?.label}${plan.why ? ' – ' + plan.why : ''}`);
  if (plan.talk) enqueueRadio(plan.nextId, d.current?.label);
  if (plan.shout) {
    let audio = null;
    try { audio = await speak(config, plan.shout, p.voice, p); } catch (e) { state.lastError = 'TTS: ' + e.message; }
    const id = uid();
    state.ann.set(id, { id, text: plan.shout, audioId: audio?.id || null, trigger: { type: 'track', trackId: plan.nextId }, at: now(), status: 'ready', task: 'dj', fx: null });
  }
}

// ------------------------------------------------------------------ requests from listeners
const rate = new Map();
function limited(ip, key, ms) {
  const k = ip + key, t = rate.get(k) || 0;
  if (now() - t < ms) return true;
  rate.set(k, now()); return false;
}

async function handleRequest(r) {
  const vars = { from: r.name, to: r.to, message: r.message };
  if (r.kind === 'piesa') {
    let t = r.trackId ? (await libraryTracks()).find((x) => x.id === r.trackId) : null;
    if (!t && r.song) t = findTracks(await libraryTracks(), r.song, 1)[0]?.track;
    if (!t) { postChat('system', 'Radio', `Nu am găsit „${r.song}” în colecție. Încearcă alt titlu.`); return; }
    state.toQueue.push(t.id);
    postChat('system', 'Radio', `${r.name} a cerut ${label(t)}${r.to ? ` pentru ${r.to}` : ''}. Intră la rând!`);
    enqueue({ task: 'cerere', vars: { ...vars, song: label(t) }, onAir: true, trigger: { type: 'track', trackId: t.id }, from: r.name });
  } else if (r.kind === 'versuri') {
    enqueue({ task: 'versuri', vars, onAir: true, from: r.name });
  } else {
    enqueue({ task: 'dedicatie', vars: { ...vars, song: nowLabel() }, onAir: true, from: r.name });
  }
}

// ------------------------------------------------------------------ bridge (OpenDJ page, through its /api/aimc proxy)
function onBridgeState(b) {
  state.bridgeAt = now();
  const cur = b.current?.id ? { id: str(b.current.id, 100), title: str(b.current.title), artist: str(b.current.artist) } : null;
  const nxt = b.next?.id ? { id: str(b.next.id, 100), title: str(b.next.title), artist: str(b.next.artist) } : null;
  const changed = cur?.id !== state.current?.id;
  // the OpenDJ page sends the best-matching candidates once per playing track: let the DJ decide
  // one decision per playing track and music filter (changing the filter re-plans the current track)
  const dkey = b.director ? `${b.director.forTrack}|${str(b.director.filterKey, 600)}` : '';
  if (directorOn() && b.director?.forTrack && Array.isArray(b.director.candidates) && b.director.candidates.length && !state.directed.has(dkey)) {
    state.directed.add(dkey);
    if (state.directed.size > 500) state.directed = new Set([...state.directed].slice(-200));
    const c = (x) => ({ id: str(x?.id, 100), label: str(x?.label, 200), bpm: Number(x?.bpm) || 0, key: str(x?.key, 8), energy: Number.isFinite(+x?.energy) ? Math.round(+x.energy) : null, genre: str(x?.genre, 60), why: str(x?.why, 120) });
    const d = { forTrack: str(b.director.forTrack, 100), current: c(b.director.current), candidates: b.director.candidates.slice(0, 16).map(c).filter((x) => x.id), history: (b.director.history || []).slice(-5).map((h) => str(h, 120)), locked: !!b.director.locked, music: describeMusic(config.music) };
    state.jobs.unshift({ id: uid(), at: now(), task: 'director', vars: d });
    work();
  }
  state.automix = !!b.automix;
  if (changed) {
    const prev = state.current;
    state.current = cur;
    if (cur) state.trackChanges++;
    pushState();
    // no pre-generated intro for this track? announce it now (every N tracks)
    const n = Number(config.auto.introEvery) || 0;
    const hasAnn = [...state.ann.values()].some((a) => a.trigger.type === 'track' && a.trigger.trackId === cur?.id);
    if (cur && n && !directorOn() && state.trackChanges % n === 0 && !hasAnn && !state.lastNextId) {
      enqueue({ task: 'intro', vars: { song: label(cur), prev: prev ? label(prev) : '' }, onAir: true });
    }
  }
  if (nxt?.id !== state.next?.id) { state.next = nxt; pushState(); }
  // pre-generate the intro of the next track while this one plays
  if (nxt && nxt.id !== state.lastNextId) {
    state.lastNextId = nxt.id;
    const n = Number(config.auto.introEvery) || 0;
    const requested = [...state.ann.values(), ...state.jobs].some((a) => (a.trigger?.trackId) === nxt.id);
    if (n && !directorOn() && (state.trackChanges + 1) % n === 0 && !requested) {
      if (modeOf(persona()) === 'radio') enqueueRadio(nxt.id, cur ? label(cur) : '');
      else enqueue({ task: 'intro', vars: { song: label(nxt), prev: cur ? label(cur) : '' }, onAir: true, trigger: { type: 'track', trackId: nxt.id } });
    }
  }
  if (!nxt) state.lastNextId = null;
}

function bridgePoll() {
  const play = [];
  for (const a of state.ann.values()) {
    if (a.status !== 'ready') continue;
    if (now() - a.at > 30 * 60e3) { state.ann.delete(a.id); continue; }
    const due = a.trigger.type === 'now' || (a.trigger.type === 'track' && state.current?.id === a.trigger.trackId);
    if (due) { a.status = 'sent'; play.push({ id: a.id, text: a.text, fx: config.auto.horn === false ? null : a.fx || null, audio: a.audioId ? `/api/aimc/audio/${a.audioId}` : null }); }
  }
  const queue = state.toQueue.splice(0);
  const plans = state.plans.splice(0);
  const loadSampler = state.loadSampler; state.loadSampler = false;
  return { play, queue, plans, director: directorOn(), music: config.music, sfx: sfxAvailable(), sfxStamp: sfxAvailable().map((r) => Math.round(fs.statSync(path.join(SFX, r + '.mp3')).mtimeMs)).join('.'), loadSampler, persona: persona()?.name };
}

// ------------------------------------------------------------------ Icecast-compatible source + listeners
function checkBasic(req, user, pass) {
  const m = /^Basic (.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const [u, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
  const a = Buffer.from(`${u}:${rest.join(':')}`), b = Buffer.from(`${user}:${pass}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Icecast sources send the audio straight after the request head (no Content-Length, no chunking), which Node's HTTP
// parser can't take, so source connections are picked off the raw socket before HTTP sees them.
function rawSource(sock, first) {
  let buf = first;
  const onHead = (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length > 16384) return sock.destroy();
    tryHead();
  };
  const tryHead = () => {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    sock.off('data', onHead);
    const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
    const headers = {};
    for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
    const http10 = /HTTP\/1\.0$/.test(lines[0]);
    const reply = (code, msg) => sock.end(`HTTP/1.${http10 ? 0 : 1} ${code} ${msg}\r\nContent-Length: 0\r\n\r\n`);
    if (!checkBasic({ headers }, 'source', config.sourcePassword)) return reply(401, 'Unauthorized');
    if (state.source) return reply(403, 'Mountpoint in use');
    sock.write(headers.expect === '100-continue' ? 'HTTP/1.1 100 Continue\r\n\r\n' : `HTTP/1.${http10 ? 0 : 1} 200 OK\r\n\r\n`);
    sock.setTimeout(0); sock.setNoDelay(true);
    acceptSource(sock, headers, buf.subarray(end + 4));
  };
  sock.on('data', onHead);
  sock.on('error', () => {});
  tryHead();
}

function acceptSource(sock, headers, rest) {
  state.source = sock; state.sourceType = str(headers['content-type'], 60) || 'audio/mpeg';
  state.burst = []; state.burstBytes = 0;
  console.log('[ai-mc] OpenDJ e în emisie (' + state.sourceType + ')');
  pushState();
  const req = sock;
  const onData = (chunk) => {
    state.burst.push(chunk); state.burstBytes += chunk.length;
    while (state.burstBytes > 96 * 1024 && state.burst.length > 1) state.burstBytes -= state.burst.shift().length;
    for (const l of state.listeners) {
      if (l.writableLength > 2 * 1024 * 1024) { l.destroy(); state.listeners.delete(l); continue; }
      l.write(chunk);
    }
  };
  if (rest.length) onData(rest);
  req.on('data', onData);
  const end = () => { if (state.source === req) { state.source = null; console.log('[ai-mc] Emisia s-a oprit'); pushState(); } };
  req.on('end', end); req.on('close', end); req.on('error', end);
}

function serveListener(req, res) {
  res.writeHead(200, { 'Content-Type': state.sourceType, 'Cache-Control': 'no-cache, no-store', 'icy-name': config.stationName, 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  for (const c of state.burst) res.write(c);
  state.listeners.add(res); pushState();
  const done = () => { state.listeners.delete(res); pushState(); };
  res.on('close', done); res.on('error', done);
}

// ------------------------------------------------------------------ HTTP plumbing
function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}
async function body(req, limit = 64 * 1024) {
  let size = 0; const parts = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Prea mare'), { status: 413 }); parts.push(c); }
  if (!parts.length) return {};
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw Object.assign(new Error('JSON invalid'), { status: 400 }); }
}
const PAGE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; media-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
function page(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Security-Policy': PAGE_CSP, 'X-Frame-Options': 'DENY' });
  fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
}
function isAdmin(req) {
  const k = Buffer.from(String(req.headers['x-admin-key'] || '')), p = Buffer.from(config.adminPassword);
  return k.length === p.length && crypto.timingSafeEqual(k, p);
}
const ipOf = (req) => req.socket.remoteAddress || '';
// Behind a reverse proxy listed in config.trustedProxies (e.g. Caddy), the visitor's address comes in X-Real-IP.
const clientIp = (req) => {
  const peer = ipOf(req).replace(/^::ffff:/, '');
  const real = String(req.headers['x-real-ip'] || '').trim();
  return real && (config.trustedProxies || []).includes(peer) ? real.slice(0, 64) : peer;
};

async function mcpStatus() {
  if (!mcp.configured) return { configured: false };
  try { const tools = await mcp.tools(); state.mcpOk = true; return { configured: true, ok: true, tools: tools.length, djTools: ['automix_queue_next', 'automix_set_transition', 'automix_set_mix_out', 'get_track_structure'].every((t) => tools.includes(t)) }; }
  catch (e) { state.mcpOk = false; return { configured: true, ok: false, why: e.message.slice(0, 160) }; }
}
async function status() {
  let ollama = { ok: false };
  try { const models = await listModels(config); ollama = { ok: true, models, hasModel: models.includes(config.model) || models.includes(config.model + ':latest') }; } catch (e) { ollama = { ok: false, why: e.message }; }
  return {
    ...publicState(), ollama, tts: ttsStatus(config), xtts: await xttsHealth(config), mcp: await mcpStatus(), bridge: now() - state.bridgeAt < 5000, automix: state.automix,
    jobs: state.jobs.length + (state.busy ? 1 : 0), lastError: state.lastError, pending: state.pending, tracks: (await libraryTracks()).length,
  };
}

function modelfile(p) {
  const q = (s) => String(s).replace(/"""/g, '"');
  const sys = buildMessages(p, 'liber', { message: '' }, config)[0].content;
  const ex = [...(p.examples || []), ...loadMemory().liked.filter((e) => e.persona === p.id)];
  const ask = { dedicatie: 'Fă o dedicație.', versuri: 'Compune niște versuri.', intro: 'Anunță piesa următoare.', chat: 'Salut, DJ!', cerere: 'Anunță o piesă cerută.' };
  return [`FROM ${config.model}`, `PARAMETER temperature ${config.temperature || 0.9}`, `SYSTEM """${q(sys)}"""`,
    ...ex.slice(0, 30).flatMap((e) => [`MESSAGE user """${q(ask[e.type] || 'Spune ceva la microfon.')}"""`, `MESSAGE assistant """${q(e.text)}"""`])].join('\n') + '\n';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // Icecast source connections (PUT/SOURCE /live) never get here: see rawSource()
    if (p === '/admin/metadata') {
      if (!checkBasic(req, 'source', config.sourcePassword)) { res.writeHead(401); return res.end(); }
      state.streamTitle = str(url.searchParams.get('song'), 300); pushState();
      return send(res, 200, '<?xml version="1.0"?><iceresponse><message>Metadata update successful</message><return>1</return></iceresponse>', 'text/xml');
    }
    if (p === '/status-json.xsl') return send(res, 200, { icestats: { source: { listeners: state.listeners.size, listenurl: '/live', title: nowLabel() } } });

    // listeners
    if (p === '/' && req.method === 'GET') return page(res, 'listen.html');
    if (p === '/admin' && req.method === 'GET') return page(res, 'admin.html');
    if (p === '/live' && (req.method === 'GET' || req.method === 'HEAD')) return serveListener(req, res);
    if (p === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
      res.write(`event: history\ndata: ${JSON.stringify(state.chat.slice(-60))}\n\n`);
      state.sse.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      return res.on('close', () => { clearInterval(ping); state.sse.delete(res); });
    }
    if (p === '/api/state') return send(res, 200, publicState());
    if (p === '/api/search') {
      const q = str(url.searchParams.get('q'), 100);
      return send(res, 200, q.length < 2 ? [] : findTracks(await libraryTracks(), q, 8).map(({ track: t }) => ({ id: t.id, label: label(t) })));
    }
    if (p === '/api/chat' && req.method === 'POST') {
      const b = await body(req, 8 * 1024);
      const name = str(b.name, 30) || 'Anonim', text = str(b.text, 300);
      if (!text) return send(res, 400, { error: 'Mesaj gol' });
      if (limited(clientIp(req), 'chat', 3000)) return send(res, 429, { error: 'Mai încet, câte un mesaj la 3 secunde' });
      postChat('user', name, text);
      // the AI answers when the queue is not busy with dedications (it is slow on CPU)
      const chatJobs = state.jobs.filter((j) => j.task === 'chat').length;
      if (chatJobs < 2) enqueue({ task: 'chat', vars: { from: name, message: text, song: nowLabel() }, chat: true, onAir: !!config.auto.speakChat, from: name });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/request' && req.method === 'POST') {
      const b = await body(req, 8 * 1024);
      const r = { id: uid(), at: now(), kind: ['piesa', 'dedicatie', 'versuri'].includes(b.kind) ? b.kind : 'dedicatie',
        name: str(b.name, 30) || 'Anonim', to: str(b.to, 40), message: str(b.message, 300), song: str(b.song, 120), trackId: str(b.trackId, 100) };
      if (r.kind === 'piesa' && !r.song && !r.trackId) return send(res, 400, { error: 'Ce piesă vrei?' });
      if (limited(clientIp(req), 'req', 20000)) return send(res, 429, { error: 'Așteaptă puțin înainte de următoarea cerere' });
      if (config.auto.moderation === 'manual') {
        state.pending.push(r);
        postChat('system', 'Radio', `${r.name} a trimis o cerere. DJ-ul o aprobă imediat.`);
        return send(res, 200, { ok: true, pending: true });
      }
      await handleRequest(r);
      return send(res, 200, { ok: true });
    }

    // bridge: only the OpenDJ server on this PC (its /api/aimc proxy)
    if (p.startsWith('/bridge/')) {
      if (!LOOPBACK.has(ipOf(req))) return send(res, 403, { error: 'local only' });
      if (p === '/bridge/state' && req.method === 'POST') { onBridgeState(await body(req)); return send(res, 200, bridgePoll()); }
      const m = /^\/bridge\/audio\/([a-f0-9]{16})$/.exec(p);
      if (m) {
        const f = path.join(DATA, 'audio', m[1] + '.wav');
        if (!fs.existsSync(f)) return send(res, 404, { error: 'no audio' });
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
        return fs.createReadStream(f).pipe(res);
      }
      const sm = /^\/bridge\/sfx\/([a-z0-9]+)$/.exec(p);
      if (sm) {
        const f = path.join(SFX, sm[1] + '.mp3');
        if (!SFX_ROLES.includes(sm[1]) || !fs.existsSync(f)) return send(res, 404, { error: 'no sfx' });
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache' });
        return fs.createReadStream(f).pipe(res);
      }
      if (p === '/bridge/done' && req.method === 'POST') { const b = await body(req); state.ann.delete(str(b.id, 40)); return send(res, 200, { ok: true }); }
      return send(res, 404, { error: 'no such bridge endpoint' });
    }

    // admin
    if (p.startsWith('/admin/api/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Parolă greșită' });
      const a = p.slice('/admin/api/'.length);
      if (a === 'status') return send(res, 200, await status());
      if (a === 'config' && req.method === 'GET') { const { adminPassword, ...c } = config; return send(res, 200, { ...c, mcp: { url: config.mcp?.url || '', hasToken: !!config.mcp?.token } }); }
      if (a === 'config' && req.method === 'PUT') {
        const b = await body(req);
        const pick = ['stationName', 'ollamaUrl', 'model', 'temperature', 'persona', 'opendjUrl', 'city'];
        for (const k of pick) if (b[k] !== undefined) config[k] = typeof config[k] === 'number' ? Number(b[k]) : str(b[k], 300);
        if (b.music) config.music = cleanMusic(b.music);
        if (typeof b.musicMood === 'string') config.musicMood = str(b.musicMood, 300);
        if (b.mcp) {
          const url = str(b.mcp.url, 200) || 'http://127.0.0.1:47800/mcp';
          if (!/^https?:\/\/[^\s/]+\/mcp$/.test(url)) return send(res, 400, { error: 'Adresa MCP trebuie să fie de forma http://127.0.0.1:47800/mcp' });
          config.mcp = { url, token: typeof b.mcp.token === 'string' ? str(b.mcp.token, 200) : (config.mcp?.token || '') };
          mcp = new McpClient(config.mcp); state.mcpOk = null; state.mcpError = '';
        }
        if (b.auto) config.auto = { ...config.auto, introEvery: Math.max(0, Number(b.auto.introEvery) || 0), speakChat: !!b.auto.speakChat, horn: b.auto.horn !== false, radioTopics: b.auto.radioTopics !== false, director: b.auto.director !== false, djIntensity: ['subtle', 'normal', 'hype'].includes(b.auto.djIntensity) ? b.auto.djIntensity : (config.auto.djIntensity || 'subtle'), moderation: b.auto.moderation === 'manual' ? 'manual' : 'auto' };
        if (b.tts) config.tts = { ...config.tts, ...Object.fromEntries(['engine', 'piperPath', 'voice', 'edgeVoice', 'edgeRate', 'edgePitch', 'python', 'xttsUrl', 'xttsVoice', 'xttsSpeed'].filter((k) => b.tts[k] !== undefined).map((k) => [k, str(b.tts[k], 400)])), lengthScale: Number(b.tts.lengthScale) || config.tts.lengthScale };
        saveConfig(config); pushState();
        const { adminPassword, ...c } = config; return send(res, 200, { ...c, mcp: { url: config.mcp?.url || '', hasToken: !!config.mcp?.token } });
      }
      if (a === 'personas' && req.method === 'GET') return send(res, 200, listPersonas());
      if (a === 'personas' && req.method === 'PUT') {
        const b = await body(req, 256 * 1024);
        const saved = savePersona({ id: b.id, name: str(b.name, 80), voice: str(b.voice, 20) || 'radio', mode: b.mode === 'radio' ? 'radio' : 'party', edgeVoice: /^ro-RO-\w+Neural$/.test(b.edgeVoice) ? b.edgeVoice : 'ro-RO-EmilNeural', edgeRate: /^[+-]\d{1,2}%$/.test(b.edgeRate) ? b.edgeRate : '+10%', edgePitch: /^[+-]\d{1,2}Hz$/.test(b.edgePitch) ? b.edgePitch : '+0Hz', description: str(b.description, 300), system: String(b.system || '').slice(0, 6000),
          examples: (Array.isArray(b.examples) ? b.examples : []).slice(0, 200).map((e) => ({ type: TASK_TYPES.includes(e.type) ? e.type : '', text: String(e.text || '').slice(0, 1500) })).filter((e) => e.text) });
        return send(res, 200, saved);
      }
      if (a === 'memory' && req.method === 'GET') return send(res, 200, loadMemory());
      if (a === 'memory' && req.method === 'PUT') { const b = await body(req, 512 * 1024); const m = loadMemory(); if (typeof b.friends === 'string') m.friends = b.friends.slice(0, 8000); if (Array.isArray(b.liked)) m.liked = b.liked.slice(0, 500); saveMemory(m); return send(res, 200, m); }
      if (a === 'outputs') return send(res, 200, state.outputs);
      // ---- recorded sound effects: list, listen, replace, put them on OpenDJ's sampler pads
      if (a === 'sfx') return send(res, 200, SFX_ROLES.map((r) => ({ role: r, ok: fs.existsSync(path.join(SFX, r + '.mp3')) })));
      if (a === 'sfx-to-sampler' && req.method === 'POST') { state.loadSampler = true; return send(res, 200, { ok: true }); }
      const fm = /^sfx\/([a-z0-9]+)$/.exec(a);
      if (fm && SFX_ROLES.includes(fm[1]) && req.method === 'GET') {
        const f = path.join(SFX, fm[1] + '.mp3');
        if (!fs.existsSync(f)) return send(res, 404, { error: 'Nu există' });
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
        return fs.createReadStream(f).pipe(res);
      }
      if (fm && SFX_ROLES.includes(fm[1]) && req.method === 'POST') {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 20 * 1024 * 1024) return send(res, 413, { error: 'Prea mare (max 20 MB)' }); chunks.push(c); }
        if (size < 500) return send(res, 400, { error: 'Fișier gol' });
        fs.mkdirSync(SFX, { recursive: true });
        const src = path.join(DATA, 'audio', `sfx-${uid()}`);
        fs.writeFileSync(src, Buffer.concat(chunks));
        const max = { riser: 8, siren: 5, impact: 4 }[fm[1]] || 3;
        try { await makeSfx(config, src, path.join(SFX, fm[1] + '.mp3'), max); }
        catch (e) { return send(res, 400, { error: 'Nu pot citi fișierul: ' + e.message.slice(0, 200) }); }
        finally { fs.rm(src, { force: true }, () => {}); }
        return send(res, 200, { ok: true });
      }
      // ---- what the AI DJ may play: genres in the library, and a preview of a filter
      if (a === 'genres') {
        const counts = new Map();
        for (const t of await libraryTracks()) for (const g of genresOf(t)) counts.set(g, (counts.get(g) || 0) + 1);
        return send(res, 200, [...counts].sort((x, y) => y[1] - x[1]).slice(0, 80).map(([genre, count]) => ({ genre, count })));
      }
      if (a === 'music-prompt' && req.method === 'POST') {
        const text = str((await body(req)).text, 300);
        if (!text) return send(res, 400, { error: 'Scrie ce muzică vrei' });
        const counts = new Map();
        for (const t of await libraryTracks()) for (const g of genresOf(t)) counts.set(g, (counts.get(g) || 0) + 1);
        const genres = [...counts].sort((x, y) => y[1] - x[1]).map(([g]) => g);
        return send(res, 200, { music: await musicFromPrompt(config, text, genres), mood: text });
      }
      if (a === 'music-preview' && req.method === 'POST') {
        const f = cleanMusic((await body(req)).music);
        const all = (await libraryTracks()).filter((t) => !t.missing && !t.unreadable);
        const hits = all.filter((t) => musicMatch(t, f));
        const langs = { ro: 0, en: 0, es: 0, other: 0 };
        for (const t of hits.length > 20000 ? hits.slice(0, 20000) : hits) langs[languageOf(t)]++;
        const sample = [...hits].sort(() => Math.random() - 0.5).slice(0, 12).map(label);
        return send(res, 200, { count: hits.length, total: all.length, langs, sample, describe: describeMusic(f) });
      }
      // reference recordings for the cloned voice (ai-mc/voices/<name>.wav, read by the XTTS server)
      if (a === 'voices') return send(res, 200, fs.existsSync(VOICES) ? fs.readdirSync(VOICES).filter((f) => f.endsWith('.wav')).map((f) => f.slice(0, -4)) : []);
      const vm = /^voice\/([\w-]{1,40})$/.exec(a);
      if (vm && req.method === 'GET') {
        const f = path.join(VOICES, vm[1] + '.wav');
        if (!fs.existsSync(f)) return send(res, 404, { error: 'Nu există' });
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
        return fs.createReadStream(f).pipe(res);
      }
      if (vm && req.method === 'POST') {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > 25 * 1024 * 1024) return send(res, 413, { error: 'Înregistrarea e prea mare (max 25 MB)' }); chunks.push(c); }
        if (size < 2000) return send(res, 400, { error: 'Înregistrare goală' });
        fs.mkdirSync(VOICES, { recursive: true });
        const src = path.join(DATA, 'audio', `upload-${uid()}`);
        fs.writeFileSync(src, Buffer.concat(chunks));
        try { await makeReference(config, src, path.join(VOICES, vm[1] + '.wav')); }
        catch (e) { return send(res, 400, { error: 'Nu pot citi înregistrarea: ' + e.message.slice(0, 200) }); }
        finally { fs.rm(src, { force: true }, () => {}); }
        return send(res, 200, { ok: true, name: vm[1] });
      }
      if (a === 'like' && req.method === 'POST') {
        const b = await body(req); const m = loadMemory();
        const o = state.outputs.find((x) => x.id === b.id);
        const text = String(b.text || o?.text || '').slice(0, 1500);
        if (text) m.liked.push({ persona: b.persona || o?.persona || config.persona, type: TASK_TYPES.includes(b.type) ? b.type : (o?.type || ''), text, at: now() });
        saveMemory(m); return send(res, 200, { ok: true, liked: m.liked.length });
      }
      if (a === 'test' && req.method === 'POST') {
        const b = await body(req);
        const p2 = listPersonas()[b.persona] || persona();
        const text = await generate(config, p2, TASK_TYPES.includes(b.task) ? b.task : 'dedicatie', { from: str(b.from, 40), to: str(b.to, 40), message: str(b.message, 600), song: str(b.song, 120) || nowLabel() });
        const out = { id: uid(), at: now(), persona: p2.id, type: b.task, text };
        state.outputs.unshift(out);
        if (b.onAir) {
          const audio = await speak(config, text, p2.voice, p2).catch((e) => { state.lastError = 'TTS: ' + e.message; return null; });
          state.ann.set(out.id, { id: out.id, text, audioId: audio?.id || null, trigger: { type: 'now' }, at: now(), status: 'ready', fx: 'airhorn' });
          postChat('ai', p2.name, text, { onAir: true });
        }
        return send(res, 200, out);
      }
      if (a === 'say' && req.method === 'POST') {
        const b = await body(req); const text = str(b.text, 1200); const p2 = persona();
        const audio = await speak(config, text, p2.voice, p2).catch((e) => { state.lastError = 'TTS: ' + e.message; return null; });
        const id = uid();
        state.ann.set(id, { id, text, audioId: audio?.id || null, trigger: { type: 'now' }, at: now(), status: 'ready', fx: 'airhorn' });
        postChat('ai', p2.name, text, { onAir: true });
        return send(res, 200, { ok: true, audio: !!audio });
      }
      if (a === 'pending' && req.method === 'POST') {
        const b = await body(req);
        const i = state.pending.findIndex((r) => r.id === b.id);
        if (i < 0) return send(res, 404, { error: 'Nu mai există' });
        const [r] = state.pending.splice(i, 1);
        if (b.approve) await handleRequest(r);
        return send(res, 200, { ok: true });
      }
      if (a === 'chat-clear' && req.method === 'POST') { state.chat = []; broadcast('history', []); return send(res, 200, { ok: true }); }
      if (a === 'modelfile') { const p2 = listPersonas()[url.searchParams.get('persona')] || persona(); return send(res, 200, modelfile(p2), 'text/plain; charset=utf-8'); }
      if (a === 'training.jsonl') {
        const ps = listPersonas();
        const lines = loadMemory().liked.filter((e) => ps[e.persona]).map((e) => JSON.stringify({ messages: [...buildMessages(ps[e.persona], e.type || 'liber', { message: 'Spune ceva la microfon.' }, config), { role: 'assistant', content: e.text }] }));
        return send(res, 200, lines.join('\n') + '\n', 'application/x-ndjson; charset=utf-8');
      }
      return send(res, 404, { error: 'Necunoscut' });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    else res.destroy();
  }
});
server.requestTimeout = 0; // the source upload and the listeners' streams are endless
server.headersTimeout = 30000;
server.keepAliveTimeout = 65000;

setInterval(cleanupAudio, 3600e3).unref();
const front = net.createServer((sock) => {
  sock.once('data', (d) => {
    if (/^(PUT|SOURCE) \/live[ ?]/.test(d.subarray(0, 24).toString('latin1'))) return rawSource(sock, d);
    sock.pause(); sock.unshift(d);
    server.emit('connection', sock);
    sock.resume();
  });
  sock.on('error', () => {});
});
front.listen(config.port, config.host, () => {
  console.log(`\n  AI MC pornit pe portul ${config.port}`);
  console.log(`  Pagina pentru prieteni:  http://<IP-ul acestui PC>:${config.port}/`);
  console.log(`  Panou de control (DJ):   http://127.0.0.1:${config.port}/admin   parola: ${config.adminPassword}`);
  console.log(`  OpenDJ -> Broadcast -> Icecast: server 127.0.0.1, port ${config.port}, mount /live, user source, parola: ${config.sourcePassword}`);
  console.log(`  Ollama: ${config.ollamaUrl} (model ${config.model})   Voce: ${ttsStatus(config).ok ? ({ xtts: `clonată (${config.tts.xttsVoice || 'mc'})`, edge: `Microsoft ${config.tts.edgeVoice || ''}`, piper: 'Piper' }[config.tts.engine] || 'OK') : ttsStatus(config).why}\n`);
});
