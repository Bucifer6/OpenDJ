// Contract every remote media-server client implements.
//
// config: { id, type: 'plex'|'jellyfin'|'emby'|'subsonic', name, url,
//           username?, password?, token?, userId?, libraryIds?: string[] }
//
// Normalised track shape returned by listTracks():
// { remoteId: string, title, artist, album, albumArtist, genre, year: number|null,
//   trackNumber: number|null, duration: seconds|null, bpm: number|null,
//   format: 'mp3'|'flac'|..., size: bytes|null, bitrate: kbps|null, coverUrl: string|null,
//   remotePath?: string|null }
//
// remotePath (optional): an opaque server-side locator some clients need to build a
// stream/download URL synchronously (e.g. Plex's Part key `/library/parts/123/456/file.flac`).
// Callers should persist it alongside remoteId and pass the stored track back as the
// optional second argument of streamRequest/downloadRequest/coverRequest:
//   client.streamRequest(remoteId, { remotePath })
// Clients that don't need it ignore the second argument.
//
// Normalised playlist shape returned by listPlaylists():
// { remoteId: string, name: string, trackRemoteIds: string[] }
// listPlaylists({ tracks: false }) returns summaries without fetching each playlist's items:
// { remoteId: string, name: string, trackCount: number|null, duration: seconds|null, smart?: boolean }
// playlistTracks(remoteId) returns one playlist's tracks, in order, in the listTracks() track shape.

const DEFAULT_TIMEOUT_MS = 30_000;

export class SourceClient {
  constructor(config, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.config = { ...config, url: (config.url || '').replace(/\/+$/, '') };
    this.fetch = fetchImpl === globalThis.fetch && timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
      ? (url, init) => fetchImpl(url, init?.signal ? init : { ...init, signal: AbortSignal.timeout(timeoutMs) })
      : fetchImpl;
  }
  /** Validate credentials; may populate this.config.token/userId. Returns { ok: true, serverName, version } or throws. */
  async connect() { throw new Error('not implemented'); }
  /** Returns partial config fields that should be persisted after connect() (e.g. token, userId). */
  persistable() { return {}; }
  async listLibraries() { return []; } // [{ id, name }]
  async listTracks(_opts = {}) { throw new Error('not implemented'); } // opts.onProgress(done,total)
  async listPlaylists(_opts = {}) { return []; }
  async playlistTracks(_remoteId) { return []; }
  /** { url, headers } to stream the original/transcoded audio (must support HTTP Range when server does). */
  streamRequest(_remoteId, _track) { throw new Error('not implemented'); }
  /** { url, headers, ext } to download the original file. */
  downloadRequest(_remoteId, _track) { throw new Error('not implemented'); }
  /** { url, headers } for cover art or null */
  coverRequest(_remoteId, _track) { return null; }
}
