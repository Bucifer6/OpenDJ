// The desktop app's local server port, kept stable across launches.
//
// The page's own storage (IndexedDB: downloaded and imported sampler sounds; localStorage: the step sequencer, video
// mixer, skins, lyrics and Link preferences, remembered HID controllers, the Ollama model name…) belongs to the page's
// origin, http://127.0.0.1:<port>. With a new random port at every launch all of it was silently lost on restart.
// The first launch picks a free port and remembers it in <userData>/server-port.json; later launches reuse it. When
// it is taken (another program, a second OpenDJ) this launch uses a random port and the remembered one is kept.
import fs from 'node:fs';
import net from 'node:net';

const valid = (p) => Number.isInteger(p) && p >= 1024 && p <= 65535;

/** Whether 127.0.0.1:port can be bound right now. */
export function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

export function savedPort(file) {
  try { const p = Number(JSON.parse(fs.readFileSync(file, 'utf8')).port); return valid(p) ? p : null; } catch { return null; }
}

/** start(port) -> server with .port. Returns { server, stable } (stable: the remembered port is in use). */
export async function startOnStablePort(start, file) {
  const saved = savedPort(file);
  if (saved && await portFree(saved)) {
    try { return { server: await start(saved), stable: true }; } catch (e) { if (e?.code !== 'EADDRINUSE' && e?.code !== 'EACCES') throw e; }
  }
  const server = await start(0);
  if (!saved && valid(server.port)) {
    try { fs.writeFileSync(file, JSON.stringify({ port: server.port }) + '\n', { mode: 0o600 }); } catch { /* read-only profile: random ports */ }
  }
  return { server, stable: !saved };
}
