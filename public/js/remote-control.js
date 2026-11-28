// Page side of the AI-assistant remote control (server/mcp.js). The server checks the token, scopes, schemas and
// rate limits, then relays each action here over the app's event stream; this page re-checks the arguments, runs
// the action on the live app, shows a notice, and answers through POST /api/mcp/result. Only metadata goes back:
// no file paths, no source URLs, no stream credentials.
import { platform } from './platform.js';
import { planBestTransition } from './mix-planner.js';
import { planAdaptiveTransition } from './adaptive-dj.js';

const pageId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const post = (url, body) => fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const deckOf = (app, n) => { const i = Number(n) - 1; if (!Number.isInteger(i) || i < 0 || i >= (app.deckCount || 2) || i > 3) throw new Error(`Deck ${n} is not shown (OpenDJ has ${app.deckCount || 2} decks)`); return app.engine.decks[i]; };
const LABEL = { set_mixer: 'change the mixer', set_stems: 'change stem levels', prepare_stems: 'prepare AI stems', set_tempo: 'change the tempo', set_key: 'change the key', set_loop: 'set a loop', seek: 'move a deck', set_fx: 'change an effect', automix_queue_next: 'queue tracks next', set_transition: 'choose the next transition', play: 'play', pause: 'pause', cue: 'cue', load_track: 'load a track', automix_start: 'start automix', automix_stop: 'stop automix', automix_skip: 'mix to the next track', set_crossfader: 'move the crossfader', trigger_sample: 'fire a sampler pad', queue_dedication: 'queue a dedication', broadcast_start: 'start a broadcast', broadcast_stop: 'stop a broadcast' };

/** Status snapshot for get_status (metadata only). */
export async function remoteStatus(app) {
  const E = app.engine, a = app.automix;
  const decks = E.decks.slice(0, app.deckCount || 2).map((d, i) => ({
    deck: i + 1, loaded: !!d.track, title: d.track?.title || null, artist: d.track?.artist || null, bpm: d.track ? +(d.effectiveBpm || d.bpm || 0).toFixed(1) || null : null,
    key: d.track?.key || null, position: +(d.position || 0).toFixed(1), duration: +(d.duration || 0).toFixed(1), playing: !!d.playing, volume: +(E.channels[i].state.volume).toFixed(2),
  }));
  let targets = [];
  try {
    const cfg = await (await fetch('/api/broadcast/config', { credentials: 'same-origin' })).json();
    const st = await (await fetch('/api/broadcast/status', { credentials: 'same-origin' })).json();
    const live = new Map(st.active.flatMap((s) => s.outputs.map((o) => [o.id, o])));
    targets = (cfg.config?.targets || []).map((t) => ({ id: t.id, name: t.name, type: t.type, enabled: !!t.enabled, state: live.get(t.id)?.state || 'off', listeners: live.get(t.id)?.listeners ?? null }));
  } catch { /* broadcasting not available here */ }
  const next = a.nextTrack();
  return {
    decks, crossfader: +E.crossfader.toFixed(2),
    automix: { enabled: a.enabled, transition: a.transition ? a.transition.style : null, next: next ? { id: next.id, title: next.title, artist: next.artist } : null, queued: Math.max(0, a.queue.length - a.idx) },
    broadcast: { live: !!app.recording?.broadcaster?.live, targets },
    dedications: { queued: app.dedications?.pending() || 0 },
    sampler: app.engine.sampler.slots.map((s, i) => ({ pad: i + 1, name: s.name })),
  };
}

/** Run one relayed action. Throws Error(message) for a friendly failure. */
export async function runRemote(app, tool, args = {}) {
  const E = app.engine;
  switch (tool) {
    case 'get_status': return remoteStatus(app);
    case 'get_deck': {
      const d = deckOf(app, args.deck), ch = E.channels[d.index].state, r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
      return {
        deck: args.deck, loaded: !!d.track, track: d.track ? { id: d.track.id, title: d.track.title || null, artist: d.track.artist || null } : null,
        playing: !!d.playing, position: r2(d.position || 0), duration: r2(d.duration || 0), bpm: r2(d.bpm), playing_bpm: r2(d.effectiveBpm || d.bpm), tempo_percent: r2(d.tempo || 0),
        key: d.track?.key || null, playing_key: d.playingCamelot || null, key_shift: r2(d.keyShift || 0), sync: !!d.syncOn, master: !!d.isMaster,
        loop: d.loop?.active ? { start: r2(d.loop.start), end: r2(d.loop.end) } : null,
        hot_cues: (d.hotCues || []).slice(0, 8).map((c) => ({ cue: c.index + 1, position: r2(c.position), name: c.name || null })),
        stems: { loaded: !!d.stemsReady, loading: !!d.stemsLoading, prepared: !!d.track?.stems?.ready, levels: Object.fromEntries(['vocals', 'drums', 'bass', 'other'].map((n, i) => [n, r2(d.stemLevels?.[i] ?? 1)])) },
        mixer: { volume: r2(ch.volume), eq_low: r2(ch.eqLow), eq_mid: r2(ch.eqMid), eq_high: r2(ch.eqHigh), filter: r2(ch.filter), vocal: r2(ch.vocal), instrumental: r2(ch.inst), fx: { on: !!ch.fxOn, type: ch.fxType, mix: r2(ch.fxMix), param: r2(ch.fxParam) } },
      };
    }
    case 'plan_transition': {
      const a = app.automix, lib = app.library;
      if (args.from_track_id || args.to_track_id) {
        const from = lib.track(String(args.from_track_id || '')), to = lib.track(String(args.to_track_id || ''));
        if (!from || !to) throw new Error('Give both from_track_id and to_track_id (ids from search_library)');
        const auto = app.engine.settings?.stemsAutoLoad !== false;
        const p = planAdaptiveTransition(from, to, { keepSync: a.opts.keepSync, learning: app.settings.mixLearning })
          || planBestTransition(from, to, { stemsOut: auto && !!from.stems?.ready, stemsIn: auto && !!to.stems?.ready, keySync: !!a.opts.keySync, learning: app.settings.mixLearning });
        return { from: from.title, to: to.title, ...p };
      }
      if (!a.enabled) throw new Error('Automix is not running: give from_track_id and to_track_id');
      const n = a.nextTransition();
      if (!n) throw new Error('Nothing queued after the playing track');
      const planned = a.upcoming?.adaptive || a.plans.get(a.nextTrack());
      return { style: n.style, why: n.why, override: !!n.override, bars: n.length?.bars ?? null, begins_in_seconds: Math.round(n.beginsIn), outgoing_seconds: n.begin, incoming_seconds: a.upcoming?.adaptive?.inStart ?? null, vocals: planned?.style === n.style ? planned.vocals : null, options: planned?.options || [] };
    }
    case 'automix_queue_next': {
      if (!app.automix.enabled) throw new Error('Automix is not running (automix_start first)');
      const tracks = args.track_ids.map((id) => app.library.track(String(id))).filter(Boolean);
      if (!tracks.length) throw new Error('None of those track ids are in the library');
      app.automix.insertNext(tracks);
      return { queued_next: tracks.map((t) => t.title) };
    }
    case 'set_transition': {
      const a = app.automix;
      if (!a.enabled || !a.nextTrack()) throw new Error('Automix has no next transition');
      if (a.transition) throw new Error('A transition is already running; this sets the next one after it');
      a.setOverride(a.idx, args.style, { learn: false }); // the DJ's learned taste is theirs, not the assistant's
      const n = a.nextTransition();
      return { style: n?.style, why: n?.why, bars: n?.length?.bars ?? null };
    }
    case 'set_mixer': {
      const d = deckOf(app, args.deck), ch = E.channels[d.index];
      const map = { volume: 'volume', eq_low: 'eqLow', eq_mid: 'eqMid', eq_high: 'eqHigh', filter: 'filter', vocal: 'vocal', instrumental: 'inst' };
      const done = {};
      for (const [k, key] of Object.entries(map)) if (args[k] != null) { ch.set(key, args[k]); done[k] = ch.state[key]; }
      if (!Object.keys(done).length) throw new Error('Nothing to change: give volume, eq_low, eq_mid, eq_high, filter, vocal or instrumental');
      return { deck: args.deck, ...done, ai_stems: !!d.stemsReady };
    }
    case 'set_stems': {
      const d = deckOf(app, args.deck);
      if (!d.track) throw new Error(`Deck ${args.deck} is empty`);
      if (!d.stemsReady) {
        if (d.track.stems?.ready && !d.stemsLoading) d.loadStems().catch(() => {});
        throw new Error(d.track.stems?.ready ? 'AI stems are loading on this deck: try again in a few seconds' : 'No AI stems for this track yet: prepare_stems first (or use set_mixer vocal / instrumental)');
      }
      ['vocals', 'drums', 'bass', 'other'].forEach((n, i) => { if (args[n] != null) { d.setStemMute?.(i, false); d.setStemLevel(i, args[n]); } });
      return { deck: args.deck, levels: Object.fromEntries(['vocals', 'drums', 'bass', 'other'].map((n, i) => [n, d.stemLevels[i]])) };
    }
    case 'prepare_stems': {
      if (!app.stems) throw new Error('AI stems are not available here');
      const ids = args.track_ids.filter((id) => app.library.track(String(id)));
      if (!ids.length) throw new Error('None of those track ids are in the library');
      const n = await app.stems.enqueue(ids, { interactive: false });
      const prepared = ids.filter((id) => app.library.track(id)?.stems?.ready).length;
      let note;
      if (!n && prepared < ids.length) {
        const st = await app.stems.status().catch(() => null);
        note = !st?.model?.ready ? 'The AI stems model is not downloaded yet: the user can install it in OpenDJ (Settings > AI stems)' : 'Already queued or being prepared';
      }
      return { queued: n || 0, already_prepared: prepared, ...(note ? { note } : {}) };
    }
    case 'set_tempo': {
      const d = deckOf(app, args.deck);
      if (!d.track) throw new Error(`Deck ${args.deck} is empty`);
      const given = ['bpm', 'percent', 'sync'].filter((k) => args[k] != null);
      if (given.length !== 1) throw new Error('Give exactly one of bpm, percent, sync');
      if (args.sync) { if (!d.matchTempo()) throw new Error('No master deck with a BPM to sync to'); d.syncOn = true; }
      else if (args.sync === false) d.syncOn = false;
      else if (args.bpm != null) { if (!d.bpm) throw new Error('This track has no BPM'); d.syncOn = false; d.setTempo((args.bpm / d.bpm - 1) * 100); }
      else { d.syncOn = false; d.setTempo(args.percent); }
      d.emit?.('state');
      return { deck: args.deck, playing_bpm: Math.round((d.effectiveBpm || d.bpm || 0) * 100) / 100, tempo_percent: Math.round((d.tempo || 0) * 100) / 100, sync: !!d.syncOn };
    }
    case 'set_key': {
      const d = deckOf(app, args.deck);
      if (!d.track) throw new Error(`Deck ${args.deck} is empty`);
      if (args.match) { if (!d.keySyncTo()) throw new Error('No key to match (both tracks need a key)'); }
      else if (args.semitones != null) { if (!d.keyLock) d.setKeyLock(true); d.setKeyShift(args.semitones); }
      else throw new Error('Give semitones or match: true');
      return { deck: args.deck, key_shift: d.keyShift, playing_key: d.playingCamelot || null };
    }
    case 'set_loop': {
      const d = deckOf(app, args.deck);
      if (!d.track) throw new Error(`Deck ${args.deck} is empty`);
      if (!args.beats) { d.exitLoop(); return { deck: args.deck, loop: null }; }
      if (!d.bpm) throw new Error('This track has no beat grid');
      const s = d.floorBeat ? d.floorBeat(d.position) : d.position;
      d.setLoop(s, s + args.beats * d.beatLen);
      return { deck: args.deck, loop: { start: Math.round(s * 100) / 100, beats: args.beats } };
    }
    case 'seek': {
      const d = deckOf(app, args.deck);
      if (!d.track) throw new Error(`Deck ${args.deck} is empty`);
      const onAir = d.playing && E.channels[d.index].state.volume > 0.05;
      if (onAir && !args.force) throw new Error(`Deck ${args.deck} is playing on air: give force: true to jump anyway`);
      let to = null;
      if (args.seconds != null) to = args.seconds;
      else if (args.hot_cue != null) { const c = d.hotCue(args.hot_cue - 1); if (!c) throw new Error(`No hot cue ${args.hot_cue} on this track`); to = c.position; }
      else if (args.section != null) { const p = app.library.track(d.track.id)?.phrases?.[args.section]; if (!p) throw new Error('No such section (see get_track_details)'); to = p.start; }
      else throw new Error('Give seconds, hot_cue or section');
      d.seek(Math.min(to, Math.max(0, (d.duration || to) - 0.5)));
      return { deck: args.deck, position: Math.round((d.position || 0) * 100) / 100 };
    }
    case 'set_fx': {
      const d = deckOf(app, args.deck), ch = E.channels[d.index];
      if (args.type != null) ch.set('fxType', args.type);
      if (args.mix != null) ch.set('fxMix', args.mix);
      if (args.param != null) ch.set('fxParam', args.param);
      if (args.beats != null) ch.set('fxBeats', args.beats);
      if (args.on != null) ch.set('fxOn', args.on);
      return { deck: args.deck, on: !!ch.state.fxOn, type: ch.state.fxType, mix: ch.state.fxMix, param: ch.state.fxParam, beats: ch.state.fxBeats };
    }
    case 'play': { const d = deckOf(app, args.deck); if (!d.track) throw new Error(`Deck ${args.deck} is empty`); await E.resume(); if (!d.playing) d.play(); return { deck: args.deck, playing: true }; }
    case 'pause': { const d = deckOf(app, args.deck); if (d.playing) d.pause(); return { deck: args.deck, playing: false }; }
    case 'cue': { const d = deckOf(app, args.deck); if (!d.track) throw new Error(`Deck ${args.deck} is empty`); if (d.playing) d.pause(); d.seek(d.cuePoint || 0); return { deck: args.deck, position: +(d.position || 0).toFixed(2) }; }
    case 'load_track': {
      const d = deckOf(app, args.deck), t = app.library.track(String(args.track_id));
      if (!t) throw new Error('No track with that id (use search_library)');
      if (d.playing && E.channels[d.index].state.volume > 0.05 && !app.automix.enabled) throw new Error(`Deck ${args.deck} is playing: pause it first`);
      await app.loadTrack(d.index, t.id);
      return { deck: args.deck, title: t.title, artist: t.artist };
    }
    case 'automix_start': {
      if (app.automix.enabled) return { enabled: true, note: 'automix was already running' };
      let tracks;
      if (args.track_ids?.length) { tracks = args.track_ids.map((id) => app.library.track(String(id))).filter(Boolean); if (!tracks.length) throw new Error('None of those track ids are in the library'); }
      else tracks = app.automixSource().tracks;
      if (!tracks.length) throw new Error('No tracks to mix: give track_ids or open a playlist in OpenDJ');
      const opts = app.settings.automix || {};
      await app.startAutomix(tracks, { mode: args.mode || 'smart', shape: opts.shape, sliders: opts.sliders, limit: tracks.length > 200 ? 40 : undefined });
      return { enabled: app.automix.enabled, queued: app.automix.queue.length };
    }
    case 'automix_stop': app.automix.stop(); return { enabled: false };
    case 'automix_skip': {
      if (!app.automix.enabled) throw new Error('Automix is not running');
      const r = app.automix.skip();
      if (!r) throw new Error(app.automix.transition ? 'A transition is already in progress' : 'No upcoming track queued');
      return { result: r };
    }
    case 'set_crossfader': { const v = Number(args.position); if (!(v >= -1 && v <= 1)) throw new Error('position must be -1..1'); E.setCrossfader(v); return { crossfader: E.crossfader }; }
    case 'trigger_sample': { const i = Number(args.pad) - 1; if (!(i >= 0 && i < 8)) throw new Error('pad must be 1-8'); await E.resume(); E.sampler.trigger(i); return { pad: args.pad, name: E.sampler.slots[i]?.name }; }
    case 'queue_dedication': {
      const d = app.queueDedication(String(args.text || ''), { lang: args.language === 'ro' ? 'ro' : 'en', when: args.when === 'now' ? 'now' : 'phrase', overlay: args.show_on_screen !== false, meta: args.stream_metadata !== false, from: 'mcp' });
      return { queued: true, text: d.text, language: d.lang, when: d.when };
    }
    case 'broadcast_start': case 'broadcast_stop': {
      const b = app.recording?.broadcaster; if (!b) throw new Error('Broadcasting is not available here');
      const id = String(args.target_id);
      if (tool === 'broadcast_start') { if (b.live) throw new Error('A broadcast is already running: stop it first'); await b.start([id]); return { live: true, target_id: id }; }
      const mine = b.session?.outputs?.some((o) => o.id === id) || b.status?.outputs?.some((o) => o.id === id);
      if (!b.live || !mine) throw new Error('That target is not broadcasting');
      await b.stop(); return { live: false, target_id: id };
    }
    default: throw new Error('Unknown action');
  }
}

/** Claim this window as the one that runs remote actions, and listen for them (only when remote control is on). */
export async function setupRemoteControl(app, api) {
  if (platform.local) return null; // mobile app: no server
  let cfg;
  try { cfg = await (await fetch('/api/mcp/config', { credentials: 'same-origin' })).json(); } catch { return null; }
  if (!cfg?.enabled) return { pageId, es: null, enabled: false };
  const claim = () => post('/api/mcp/claim', { page: pageId }).catch(() => {});
  await claim();
  const es = api.events({
    hello: claim, // the event stream reconnected (server restarted)
    'mcp-command': async ({ id, page, tool, args }) => {
      if (page !== pageId || typeof id !== 'string') return;
      try {
        const result = await runRemote(app, tool, args || {});
        if (!['get_status', 'get_deck', 'plan_transition'].includes(tool)) app.toast?.(`AI assistant: ${LABEL[tool] || tool}`);
        await post('/api/mcp/result', { id, result });
      } catch (e) { await post('/api/mcp/result', { id, error: String(e?.message || e).slice(0, 300) }); }
    },
  });
  return { pageId, es, enabled: true };
}
