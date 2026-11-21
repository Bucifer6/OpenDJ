// Thin client for the local OpenDJ server.
// Hosted mode (password login): a 401 means the session ended, so go to the login page and come back afterwards.
// Mobile app / ?local=1: the same requests are answered in the page by the on-device backend (local/boot.js
// installs a fetch shim before anything here runs), so this file barely changes.
import { local } from './local/boot.js';
import { PLACEHOLDER_URL } from './local/media.js';

export function toLogin() {
  if (local.enabled) return; // no server, no login
  if (location.pathname.endsWith('/login.html')) return;
  location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
}
async function req(method, url, body, raw = false) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) { opts.body = body; opts.headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, opts);
  if (r.status === 401 && !url.startsWith('/api/auth/')) { toLogin(); throw new Error('Login required'); }
  if (!r.ok) {
    let msg = r.statusText; try { msg = (await r.json()).error || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return raw ? r : r.json();
}
// Ids go into URLs (and coverUrl into an html template / CSS url()): always encode them, quotes and parens too.
const enc = (id) => encodeURIComponent(String(id)).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export const api = {
  tracks: () => req('GET', '/api/tracks'),
  updateTrack: (id, patch) => req('PATCH', `/api/tracks/${enc(id)}`, patch),
  deleteTracks: (ids) => req('POST', '/api/tracks/delete', { ids }),
  played: (id) => req('POST', '/api/tracks/played', { id }),
  streamUrl: (id) => `/api/tracks/${enc(id)}/stream`,
  /** Video of a track (track.hasVideo): original file when the browser can play it, else an MP4 made by FFmpeg. */
  videoUrl: (id) => `/api/tracks/${enc(id)}/video`,
  coverUrl: (id) => {
    const u = `/api/tracks/${enc(id)}/cover`;
    if (!local.enabled) return u;
    // <img>/CSS need a URL now: app file URL / cached blob URL, else the placeholder (remote covers load in the background)
    const now = local.backend?.urlForSync(u);
    if (!now && local.backend) local.backend.urlFor(u).catch(() => {});
    return now || PLACEHOLDER_URL;
  },
  async waveform(id) { try { const r = await req('GET', `/api/tracks/${enc(id)}/waveform`, undefined, true); return await r.arrayBuffer(); } catch { return null; } },
  saveWaveform: (id, bytes) => req('PUT', `/api/tracks/${enc(id)}/waveform`, bytes),
  addFiles: (paths) => req('POST', '/api/files', { paths }),
  playlists: () => req('GET', '/api/playlists'),
  createPlaylist: (name, trackIds = [], folder) => req('POST', '/api/playlists', { name, trackIds, folder }),
  updatePlaylist: (id, patch) => req('PATCH', `/api/playlists/${enc(id)}`, patch),
  deletePlaylist: (id) => req('DELETE', `/api/playlists/${enc(id)}`),
  addToPlaylist: (id, trackIds) => req('POST', `/api/playlists/${enc(id)}/add`, { trackIds }),
  m3uUrl: (id) => `/api/playlists/${enc(id)}/m3u`,
  importM3U: (body) => req('POST', '/api/import/m3u', body),
  importRekordbox: (body) => req('POST', '/api/import/rekordbox', body),
  rekordboxExportUrl: () => '/api/export/rekordbox',
  exportUsb: (playlistIds, targetDir) => req('POST', '/api/export/usb', { playlistIds, targetDir }),
  folders: () => req('GET', '/api/folders'),
  addFolder: (path, name) => req('POST', '/api/folders', { path, name }),
  rescanFolder: (id) => req('POST', `/api/folders/${enc(id)}/scan`),
  removeFolder: (id) => req('DELETE', `/api/folders/${enc(id)}`),
  drives: () => req('GET', '/api/drives'),
  browse: (path) => req('GET', `/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  sourceTypes: () => req('GET', '/api/source-types'),
  sources: () => req('GET', '/api/sources'),
  addSource: (cfg) => req('POST', '/api/sources', cfg),
  syncSource: (id) => req('POST', `/api/sources/${enc(id)}/sync`),
  /** Live playlists of a media server: [{ remoteId, name, trackCount, duration, smart, playlistId }] */
  sourcePlaylists: (id) => req('GET', `/api/sources/${enc(id)}/playlists`),
  /** Open a media-server playlist: { playlist (library mirror), tracks (remote library tracks, in order) } */
  sourcePlaylist: (id, pid, name) => req('GET', `/api/sources/${enc(id)}/playlists/${enc(pid)}${name ? `?name=${encodeURIComponent(name)}` : ''}`),
  removeSource: (id) => req('DELETE', `/api/sources/${enc(id)}`),
  plexUsers: (id) => req('GET', `/api/sources/${enc(id)}/users`),
  switchPlexUser: (id, userId, pin) => req('POST', `/api/sources/${enc(id)}/user`, { userId, ...(pin ? { pin } : {}) }),
  downloads: () => req('GET', '/api/downloads'),
  download: (trackIds) => req('POST', '/api/downloads', { trackIds }),
  cancelDownload: (trackId) => req('POST', '/api/downloads/cancel', { trackId }),
  settings: () => req('GET', '/api/settings'),
  saveSettings: (patch) => req('PUT', '/api/settings', patch),
  info: () => req('GET', '/api/info'),
  /** { ffmpeg, version, formats: ['mp3', 'wma', …], hosted, auth, upload: { maxMB, accept } } */
  capabilities: () => req('GET', '/api/capabilities'),
  authStatus: () => req('GET', '/api/auth/status'),
  async logout() { await req('POST', '/api/auth/logout'); toLogin(); },
  changePassword: (current, password) => req('POST', '/api/auth/password', { current, password }),
  /**
   * Upload a File/Blob into the uploads library folder. Resolves { id, track }.
   * onProgress(loaded, total); pass an AbortSignal to cancel. Uses XHR because fetch has no upload progress.
   */
  upload(file, { onProgress, signal } = {}) {
    if (local.enabled) return localImport(file, { onProgress, signal });
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', '/api/upload');
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'upload'));
      x.upload.onprogress = (e) => onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size);
      x.onload = () => {
        let j = {}; try { j = JSON.parse(x.responseText || '{}'); } catch { /* not json */ }
        if (x.status === 401) { toLogin(); return reject(new Error('Login required')); }
        if (x.status >= 200 && x.status < 300) resolve(j); else reject(new Error(j.error || `Upload failed (HTTP ${x.status})`));
      };
      x.onerror = () => reject(new Error('Upload failed (network error)'));
      x.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }));
      signal?.addEventListener('abort', () => x.abort(), { once: true });
      x.send(file);
    });
  },
  // ---- library & prep ----
  updateTracks: (ids, patch) => req('POST', '/api/tracks/update', { ids, patch }),
  missingTracks: () => req('GET', '/api/tracks/missing'),
  relocate: (folder, ids) => req('POST', '/api/tracks/relocate', { folder, ids }),
  duplicates: () => req('GET', '/api/tracks/duplicates'),
  dedupe: (groups) => req('POST', '/api/tracks/dedupe', { groups }),
  smartFields: () => req('GET', '/api/smart/fields'),
  smartPreview: (smart) => req('POST', '/api/smart/preview', { smart }),
  createSmartPlaylist: (name, smart, folder) => req('POST', '/api/playlists', { name, smart, folder }),
  history: () => req('GET', '/api/history'),
  historySession: (id) => req('GET', `/api/history/${enc(id)}`),
  renameHistory: (id, name) => req('PATCH', `/api/history/${enc(id)}`, { name }),
  deleteHistory: (id) => req('DELETE', `/api/history/${enc(id)}`),
  historyExportUrl: (id, format) => `/api/history/${enc(id)}/export?format=${encodeURIComponent(format)}`,
  backupUrl: () => '/api/backup',
  restore: (backup) => req('POST', '/api/restore', backup),
  importTraktor: (body) => req('POST', '/api/import/traktor', body),
  importSerato: (body) => req('POST', '/api/import/serato', body),
  importVirtualDJ: (body) => req('POST', '/api/import/virtualdj', body),
  // ---- lighting ----
  lighting: () => req('GET', '/api/lighting'),
  saveLightingConfig: (config) => req('PUT', '/api/lighting/config', config),
  lightingState: (state) => req('POST', '/api/lighting/state', state),
  lightingLive: (patch) => req('POST', '/api/lighting/live', patch),
  lightingTest: (ms) => req('POST', '/api/lighting/test', { ms }),
  lightingStatus: () => req('GET', '/api/lighting/status'),
  lightingStreamUrl: ({ preview = false, dmx = 0 } = {}) => `/api/lighting/stream?preview=${preview ? 1 : 0}&dmx=${dmx}`,
  hueDiscover: () => req('GET', '/api/lighting/hue/discover'),
  huePair: (bridge) => req('POST', '/api/lighting/hue/pair', { bridge }),
  hueLights: () => req('GET', '/api/lighting/hue/lights'),
  /** Mobile app / ?local=1 only: the on-device backend (null on the desktop and web app). */
  get local() { return local.enabled ? local : null; },
  events(handlers) {
    const es = new EventSource('/api/events');
    for (const [ev, fn] of Object.entries(handlers)) es.addEventListener(ev, (e) => fn(JSON.parse(e.data || '{}')));
    return es;
  },
};

/**
 * Import into the on-device library (mobile app / ?local=1): a File / Blob from a file input or drag & drop, or a file
 * picked with the native picker ({ name, size, path, webPath }), which the plugin copies without passing it through JS.
 */
async function localImport(file, { onProgress, signal } = {}) {
  const b = await local.ready;
  if (signal?.aborted) throw Object.assign(new Error('Upload cancelled'), { name: 'AbortError' });
  onProgress?.(0, file.size || 0);
  let r;
  if (file instanceof Blob) {
    const res = await b.handle('POST', '/api/upload', { body: file, headers: { 'X-Filename': encodeURIComponent(file.name || 'upload') }, signal });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `Import failed (HTTP ${res.status})`);
    r = j;
  } else r = await b.importPicked(file, b.nativeImport || {});
  onProgress?.(file.size || 1, file.size || 1);
  return r;
}
