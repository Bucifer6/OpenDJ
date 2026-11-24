// Playback smoothness watch: page stalls (long tasks) and audio dropouts, where the browser reports them
// (AudioContext.playbackStats / playoutStats), go into the app log with what was going on at the time: a mix
// transition, a deck loading, AI stems being prepared. A stutter on someone's machine can then be traced from their
// log (Settings → About → Logs). At most one line per 10 s, and only when something happened.
import { appLog } from './client-log.js';

/** Dropout count of an AudioContext, where the browser reports one (null otherwise). */
export function dropoutCount(ctx) {
  const s = ctx?.playbackStats || ctx?.playoutStats;
  if (!s) return null;
  const j = typeof s.toJSON === 'function' ? s.toJSON() : s;
  const n = Number(j.underrunEvents ?? j.fallbackFramesEvents ?? j.glitchEvents);
  return Number.isFinite(n) ? n : null;
}

/** What the app is doing right now, for a log line. */
export function perfContext(app) {
  const decks = app.engine?.decks || [];
  const parts = [`${decks.filter((d) => d.playing).length} deck(s) playing`];
  const tr = app.automix?.transition;
  if (tr) parts.push(`Automix ${tr.style} transition`);
  const loading = decks.filter((d) => d.loading).map((d) => d.index + 1);
  if (loading.length) parts.push(`deck ${loading.join(', ')} loading`);
  const st = app.stems?.current;
  if (st) parts.push(st.server ? `stems ${st.phase || 'preparing'} on the server (${st.backend || 'engine'})` : `stems ${st.phase || 'preparing'} in this window${app.stems?.backend?.backend ? ` (${app.stems.backend.backend})` : ''}`);
  return parts.join(', ');
}

export function startPerfWatch(app, { minStallMs = 120, every = 10000, win = globalThis, log = appLog } = {}) {
  let stalls = [], last = null, ctxAt = '';
  try {
    new win.PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration >= minStallMs) { stalls.push(Math.round(e.duration)); ctxAt = perfContext(app); }
    }).observe({ type: 'longtask', buffered: false });
  } catch { /* no long-task timing here */ }
  return setInterval(() => {
    const n = dropoutCount(app.engine?.ctx);
    const dropped = n != null && last != null ? n - last : 0;
    if (n != null) last = n;
    if (!stalls.length && !(dropped > 0)) return;
    const what = [];
    if (stalls.length) what.push(`page busy ${stalls.length}x (longest ${Math.max(...stalls)} ms)`);
    if (dropped > 0) what.push(`audio dropouts ${dropped}x`);
    log(`[perf] ${what.join(', ')} while ${dropped > 0 ? perfContext(app) : ctxAt}`);
    stalls = [];
  }, every);
}
