// Page side of the AI-assistant remote control (server/mcp.js). The server checks the token, scopes, schemas and
// rate limits, then relays each action here over the app's event stream; this page re-checks the arguments, runs
// the action on the live app, shows a notice, and answers through POST /api/mcp/result. Only metadata goes back:
// no file paths, no source URLs, no stream credentials.
import { platform } from './platform.js';

const pageId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const post = (url, body) => fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const deckOf = (app, n) => { const i = Number(n) - 1; if (!Number.isInteger(i) || i < 0 || i >= (app.deckCount || 2) || i > 3) throw new Error(`Deck ${n} is not shown (OpenDJ has ${app.deckCount || 2} decks)`); return app.engine.decks[i]; };
const LABEL = { play: 'play', pause: 'pause', cue: 'cue', load_track: 'load a track', automix_start: 'start automix', automix_stop: 'stop automix', automix_skip: 'mix to the next track', automix_queue_next: 'choose the next track', automix_set_transition: 'choose the next transition', automix_set_mix_out: 'choose when to mix out', set_crossfader: 'move the crossfader', trigger_sample: 'fire a sampler pad', queue_dedication: 'queue a dedication', broadcast_start: 'start a broadcast', broadcast_stop: 'stop a broadcast' };

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
    case 'get_track_structure': {
      const am = app.automix, d = am.current || E.decks.slice(0, 2).find((x) => x.playing);
      if (!d?.track) throw new Error('Nothing is playing');
      const info = am.info(d), nt = am.enabled ? am.nextTransition() : null, r1 = (x) => (Number.isFinite(+x) ? +(+x).toFixed(1) : null);
      return {
        title: d.track.title || null, artist: d.track.artist || null, position: r1(d.position), duration: r1(d.duration), bpm: r1(d.effectiveBpm || d.bpm),
        sections: (info.phrases || []).slice(0, 60).map((p) => ({ type: p.type, start: r1(p.start), end: r1(p.end) })),
        mix_out: r1(info.mixOut), chosen_mix_out: am.mixOutAt?.trackId === d.track.id ? r1(am.mixOutAt.at) : null,
        next_transition: nt ? { style: nt.style, begins_at: r1(nt.begin), begins_in: r1(nt.beginsIn) } : null,
      };
    }
    case 'automix_queue_next': {
      const am = app.automix, t = app.library.track(args.track_id);
      if (!t) throw new Error('No track with that id (use search_library)');
      if (!am.enabled) throw new Error('Automix is not running (use automix_start)');
      if (am.transition) throw new Error('A transition is in progress: try again in a few seconds');
      if (am.nextTrack()?.id !== t.id) {
        am.insertNext([t]);
        for (let i = am.queue.length - 1; i > am.idx; i--) if (am.queue[i].id === t.id) am.remove(i);
      }
      return { next: { id: t.id, title: t.title, artist: t.artist } };
    }
    case 'automix_set_transition': {
      const am = app.automix;
      if (!am.enabled || !am.nextTrack()) throw new Error('No upcoming track in automix');
      am.setOverride(am.idx, args.style);
      return { style: args.style, next: am.nextTrack()?.title || null };
    }
    case 'automix_set_mix_out': {
      const am = app.automix;
      if (!am.enabled || !am.current?.track) throw new Error('Automix is not playing a track');
      if (am.transition) throw new Error('A transition is already in progress');
      const r = am.setMixOut(args.automatic || args.position == null ? null : args.position);
      const nt = am.nextTransition();
      return { mix_out: r ? +r.at.toFixed(1) : 'automatic', next_transition_begins_at: nt ? +nt.begin.toFixed(1) : null };
    }
    case 'automix_skip': {
      if (!app.automix.enabled) throw new Error('Automix is not running');
      const r = app.automix.skip();
      if (!r) throw new Error(app.automix.transition ? 'A transition is already in progress' : 'No upcoming track queued');
      return { result: r };
    }
    case 'set_crossfader': { const v = Number(args.position); if (!(v >= -1 && v <= 1)) throw new Error('position must be -1..1'); E.setCrossfader(v); return { crossfader: E.crossfader }; }
    case 'trigger_sample': { const i = Number(args.pad) - 1; if (!(i >= 0 && i < 8)) throw new Error('pad must be 1-8'); await E.resume(); E.sampler.trigger(i); return { pad: args.pad, name: E.sampler.slots[i]?.name }; }
    case 'queue_dedication': {
      const d = app.queueDedication(String(args.text || ''), { lang: args.language === 'ro' ? 'ro' : 'en', overlay: args.show_on_screen !== false, meta: args.stream_metadata !== false, from: 'mcp' });
      return { queued: true, text: d.text, language: d.lang };
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
  const claim = () => post('/api/mcp/claim', { page: pageId }).catch(() => {});
  await claim();
  const es = api.events({
    hello: claim, // the event stream reconnected (server restarted)
    'mcp-command': async ({ id, page, tool, args }) => {
      if (page !== pageId || typeof id !== 'string') return;
      try {
        const result = await runRemote(app, tool, args || {});
        if (tool !== 'get_status') app.toast?.(`AI assistant: ${LABEL[tool] || tool}`);
        await post('/api/mcp/result', { id, result });
      } catch (e) { await post('/api/mcp/result', { id, error: String(e?.message || e).slice(0, 300) }); }
    },
  });
  return { pageId, es, enabled: !!cfg?.enabled };
}
