// Fake media servers for tests (unit + e2e): a Subsonic/Navidrome and a Jellyfin that serve a catalogue, playlists
// and real audio bytes for streaming. Not a test file itself (no .test.js suffix).
import http from 'node:http';
import { createHash } from 'node:crypto';

/** A small 16-bit stereo WAV: a kick on every beat plus a tone, `seconds` long. */
export function beatWav({ bpm = 124, seconds = 30, hz = 220, sr = 22050 } = {}) {
  const n = Math.round(sr * seconds), data = Buffer.alloc(44 + n * 4), beat = 60 / bpm;
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 4, 4); data.write('WAVE', 8); data.write('fmt ', 12);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(sr, 24);
  data.writeUInt32LE(sr * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr, tb = (t - 0.1) % beat;
    let v = 0.22 * Math.sin(2 * Math.PI * hz * t) + 0.1 * Math.sin(2 * Math.PI * hz * 1.5 * t);
    if (t > 0.1 && tb < 0.15) v += 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tb * 40)) * tb) * Math.exp(-tb * 18);
    const s = Math.max(-1, Math.min(1, v * 0.7)) * 32767;
    data.writeInt16LE(s | 0, 44 + i * 4); data.writeInt16LE(s | 0, 46 + i * 4);
  }
  return data;
}

function serve(handler) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const url = new URL(req.url, 'http://x');
    log.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
    // the mobile app's browser test mode (?local=1) talks to media servers straight from the page: allow CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    try {
      const out = (await handler(req, url, body)) || { status: 404, json: { error: 'not found' } };
      res.statusCode = out.status || 200;
      if (out.bytes) {
        const b = out.bytes, range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        res.setHeader('Content-Type', out.type || 'audio/wav'); res.setHeader('Accept-Ranges', 'bytes');
        if (range) {
          const s = Number(range[1] || 0), e = range[2] ? Math.min(Number(range[2]), b.length - 1) : b.length - 1;
          res.statusCode = 206; res.setHeader('Content-Range', `bytes ${s}-${e}/${b.length}`); res.setHeader('Content-Length', e - s + 1);
          return res.end(b.subarray(s, e + 1));
        }
        res.setHeader('Content-Length', b.length);
        return res.end(b);
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out.json ?? null));
    } catch (e) { res.statusCode = 500; res.end(String(e)); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, log, server, close: () => new Promise((r) => server.close(r)),
  })));
}

/**
 * Fake Subsonic (Navidrome). songs: [{ id, title, artist, genre, bpm, duration, wav? }], playlists: [{ id, name, songIds }].
 * Token auth with user `dj` / password `secret` (state.password can change it to simulate a refused login).
 */
export async function fakeSubsonic({ songs = [], playlists = [], user = 'dj', password = 'secret' } = {}) {
  const state = { password, refuse: false };
  const ok = (extra = {}) => ({ json: { 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.53.0', ...extra } } });
  const fail = (code, message) => ({ json: { 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code, message } } } });
  const song = (s) => ({ id: s.id, title: s.title, artist: s.artist, album: s.album || 'Album', genre: s.genre, bpm: s.bpm, duration: s.duration ?? 30, suffix: 'wav', size: s.wav?.length || 1000, coverArt: `al-${s.id}`, track: 1, year: 2025 });
  const srv = await serve((req, url) => {
    const q = url.searchParams;
    const expected = createHash('md5').update(state.password + (q.get('s') || '')).digest('hex');
    if (state.refuse || q.get('u') !== user || q.get('t') !== expected) return fail(40, 'Wrong username or password');
    const m = url.pathname.replace(/^\/rest\//, '').replace(/\.view$/, '');
    if (m === 'ping') return ok();
    if (m === 'getMusicFolders') return ok({ musicFolders: { musicFolder: [{ id: 1, name: 'Music' }] } });
    if (m === 'search3') { const off = Number(q.get('songOffset') || 0), n = Number(q.get('songCount') || 500); return ok({ searchResult3: { song: songs.slice(off, off + n).map(song) } }); }
    if (m === 'getPlaylists') return ok({ playlists: { playlist: playlists.map((p) => ({ id: p.id, name: p.name, songCount: p.songIds.length, duration: p.songIds.length * 30, owner: user })) } });
    if (m === 'getPlaylist') {
      const p = playlists.find((x) => x.id === q.get('id'));
      if (!p) return fail(70, 'Playlist not found');
      return ok({ playlist: { id: p.id, name: p.name, entry: p.songIds.map((id) => song(songs.find((s) => s.id === id))) } });
    }
    if (m === 'stream' || m === 'download') { const s = songs.find((x) => x.id === q.get('id')); return s ? { bytes: s.wav || beatWav({ seconds: 4 }) } : fail(70, 'not found'); }
    if (m === 'getCoverArt') return { status: 404, json: {} };
    return fail(0, `unknown method ${m}`);
  });
  return { ...srv, state };
}

/**
 * Fake Jellyfin. Token `TOK` for user `dj` / password `secret`; items: [{ Id, Name, Artists, Genres, RunTimeTicks }],
 * playlists: [{ Id, Name, itemIds }]. state.revoked = true makes every call answer HTTP 401.
 */
export async function fakeJellyfin({ items = [], playlists = [] } = {}) {
  const state = { revoked: false };
  const srv = await serve((req, url, body) => {
    const p = url.pathname, q = url.searchParams;
    if (p === '/Users/AuthenticateByName' && req.method === 'POST') {
      const b = JSON.parse(body || '{}');
      if (b.Username !== 'dj' || b.Pw !== 'secret') return { status: 401, json: {} };
      return { json: { AccessToken: 'TOK', User: { Id: 'U1' } } };
    }
    if (state.revoked || req.headers['x-emby-token'] !== 'TOK') return { status: 401, json: {} };
    if (p === '/System/Info') return { json: { ServerName: 'Fake Jellyfin', Version: '10.10.0' } };
    if (p === '/Users/U1/Items' && q.get('IncludeItemTypes') === 'Playlist') {
      return { json: { Items: playlists.map((x) => ({ Id: x.Id, Name: x.Name, MediaType: x.MediaType || 'Audio', ChildCount: x.itemIds.length, RunTimeTicks: x.itemIds.length * 3e8 })), TotalRecordCount: playlists.length } };
    }
    if (p === '/Users/U1/Items') {
      const s = Number(q.get('StartIndex') || 0), n = Number(q.get('Limit') || 500);
      return { json: { Items: items.slice(s, s + n), TotalRecordCount: items.length } };
    }
    const m = /^\/Playlists\/([^/]+)\/Items$/.exec(p);
    if (m) {
      const pl = playlists.find((x) => x.Id === decodeURIComponent(m[1]));
      if (!pl) return { status: 404, json: {} };
      const list = pl.itemIds.map((id) => items.find((i) => i.Id === id) || { Id: id, Type: 'Video', Name: 'clip' });
      const s = Number(q.get('StartIndex') || 0), n = Number(q.get('Limit') || 500);
      return { json: { Items: list.slice(s, s + n), TotalRecordCount: list.length } };
    }
    return undefined;
  });
  return { ...srv, state };
}
