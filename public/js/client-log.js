// Page errors into the app log (server/applog.js via POST /api/logs/client): uncaught errors, unhandled promise
// rejections and console.error / console.warn, batched every 2 s and de-duplicated, so the downloadable log
// (Settings → About → Logs) shows what went wrong in the page too. Not in the mobile app (no server, no file).
import { platform } from './platform.js';

const MAX_PER_BATCH = 5;

/** Text of console arguments / error objects, one line per report (stack for errors). */
export function describe(args) {
  return args.map((a) => (a instanceof Error ? (a.stack || `${a.name}: ${a.message}`) : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ').slice(0, 2000);
}

let sendLine = null;
/** A line for the app log from the page (not an error: e.g. "[stems] job … done on webgpu in 41 s"). */
export function appLog(text) { try { sendLine?.(`info: ${String(text).slice(0, 2000)}`); } catch { /* logging must not break anything */ } }

export function setupClientLog({ send = (lines) => fetch('/api/logs/client', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }), keepalive: true }).catch(() => {}), win = globalThis.window } = {}) {
  if (platform.local || !win || win.__odjClientLog) return null;
  win.__odjClientLog = true;
  let batch = [], timer = null;
  const seen = new Map(); // text -> last sent (ms): the same message at most once a minute
  const flush = () => { timer = null; const lines = batch.splice(0, MAX_PER_BATCH); batch = []; if (lines.length) send(lines); };
  const report = (level, text) => {
    const now = Date.now(), key = `${level} ${text}`;
    if (now - (seen.get(key) || 0) < 60e3) return;
    seen.set(key, now);
    if (seen.size > 200) seen.clear();
    batch.push(`${level}: ${text}`);
    timer ||= setTimeout(flush, 2000);
  };
  win.addEventListener('error', (e) => report('error', e.error ? describe([e.error]) : `${e.message} (${e.filename}:${e.lineno})`));
  win.addEventListener('unhandledrejection', (e) => report('unhandled rejection', describe([e.reason])));
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { orig(...args); try { report(level, describe(args)); } catch { /* never break logging */ } };
  }
  sendLine = (line) => { batch.push(line); timer ||= setTimeout(flush, 2000); };
  return { report, flush };
}
