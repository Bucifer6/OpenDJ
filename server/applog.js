// App log: everything OpenDJ prints (server, stems engine, FFmpeg errors, page errors the browser reports) also goes to
// <data>/logs/opendj.log with a timestamp per line, so a problem on someone's machine can be looked at afterwards.
// The file is rotated at MAX_BYTES (opendj.log -> opendj.1.log -> … opendj.<KEEP>.log), so it never grows without limit.
// Installed once per process by the real entry points (server/cli.js, electron/main.js via start({ logs: true })),
// never by tests. Settings → General offers it for download (GET /api/logs) and, in the desktop app, opens the folder.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_BYTES = 5 * 1024 * 1024;
export const KEEP = 3;
/** Longer lines are cut (a dumped buffer must not fill the log). */
export const MAX_LINE = 8192;
let state = null; // { dir, file, fd, size, maxBytes, keep, partial: { out, err } }

/** Directory and current file of the app log, or null when it is not installed. */
export const appLog = () => (state ? { dir: state.dir, file: state.file } : null);

/**
 * Secrets that can end up in a log line: media-server tokens and passwords in URLs (Plex X-Plex-Token, Jellyfin /
 * Emby api_key, Subsonic u/p/t/s), Authorization headers and the like.
 */
export function redact(text) {
  return String(text)
    .replace(/([?&;](?:x-plex-token|[\w-]*token|api[_-]?key|apikey|access_token|password|pass|p|t|s|u)=)[^&\s"'<>]+/gi, '$1***')
    .replace(/((?:authorization|x-emby-token|x-mediabrowser-token|x-plex-token|cookie)\s*:\s*)(?:(?:bearer|basic|mediabrowser)\s+)?[^\s,"']+/gi, '$1***')
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***:***@');
}

/** "2026-11-23T12:46:12.102Z [err] text" for every complete line; a trailing partial line waits for the rest. */
export function stampLines(text, stream, partial = '', now = new Date()) {
  const all = partial + text;
  const lines = all.split('\n');
  const rest = lines.pop();
  const ts = now.toISOString();
  const cap = (l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}… (${l.length - MAX_LINE} more characters)` : l);
  return { out: lines.map((l) => `${ts} [${stream}] ${redact(cap(l.replace(/\r$/, '')))}\n`).join(''), rest: rest.length > MAX_LINE ? '' : rest };
}

function rotate() {
  const { dir, keep } = state;
  try { fs.closeSync(state.fd); } catch { /* already closed */ }
  for (let i = keep - 1; i >= 1; i--) {
    const from = path.join(dir, `opendj.${i}.log`);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, `opendj.${i + 1}.log`));
  }
  fs.renameSync(state.file, path.join(dir, 'opendj.1.log'));
  state.fd = fs.openSync(state.file, 'a'); state.size = 0;
}

/** Append raw text (already stamped) to the log file; never throws (logging must not break the app). */
function append(text) {
  if (!state || !text) return;
  try {
    if (state.size + Buffer.byteLength(text) > state.maxBytes) rotate();
    fs.writeSync(state.fd, text);
    state.size += Buffer.byteLength(text);
  } catch { /* disk full / removed: keep running without the file */ }
}

/** Write a line to the log (and to stderr), e.g. events that should be in the file but not on the console. */
export function logLine(text, stream = 'app') {
  if (!state) return;
  append(stampLines(`${text}\n`, stream).out);
}

/**
 * Start logging to <dir>/opendj.log: process.stdout / process.stderr writes (console.* and the stems engine's output,
 * which server/stems.js forwards to stderr) are copied into the file. Returns { dir, file }.
 */
export function installAppLog(dir, { maxBytes = MAX_BYTES, keep = KEEP, header = '' } = {}) {
  if (state) return appLog();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'opendj.log');
  const fd = fs.openSync(file, 'a');
  state = { dir, file, fd, size: fs.fstatSync(fd).size, maxBytes, keep, partial: { out: '', err: '' } };
  for (const [stream, key] of [[process.stdout, 'out'], [process.stderr, 'err']]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, encoding, cb) => {
      try {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8');
        const r = stampLines(text, key, state.partial[key]);
        state.partial[key] = r.rest; append(r.out);
      } catch { /* never break the console */ }
      return write(chunk, encoding, cb);
    };
  }
  logLine(`---- OpenDJ started${header ? `: ${header}` : ''} (pid ${process.pid}, ${process.platform}-${process.arch}, node ${process.versions.node}${process.versions.electron ? `, electron ${process.versions.electron}` : ''})`);
  process.on('uncaughtExceptionMonitor', (e, origin) => logLine(`${origin}: ${e?.stack || e}`, 'fatal'));
  process.on('unhandledRejection', (e) => logLine(`unhandled rejection: ${e?.stack || e}`, 'err'));
  return appLog();
}

/** The last `maxBytes` of the log, older rotated file first (for download / bug reports). */
export function readAppLog(maxBytes = 2 * 1024 * 1024) {
  if (!state) return '';
  const files = [path.join(state.dir, 'opendj.1.log'), state.file].filter((f) => fs.existsSync(f));
  let text = files.map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('');
  if (text.length > maxBytes) text = text.slice(text.length - maxBytes).replace(/^[^\n]*\n/, '');
  return text;
}

