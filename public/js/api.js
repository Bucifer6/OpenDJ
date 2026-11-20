// Thin client for the local OpenDJ server.
// Hosted mode (password login): a 401 means the session ended, so go to the login page and come back afterwards.
export function toLogin() {
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
export const api = {
  tracks: () => req('GET', '/api/tracks'),
  updateTrack: (id, patch) => req('PATCH', `/api/tracks/${id}`, patch),
  deleteTracks: (ids) => req('POST', '/api/tracks/delete', { ids }),
  played: (id) => req('POST', '/api/tracks/played', { id }),
  streamUrl: (id) => `/api/tracks/${id}/stream`,
  /** Video of a track (track.hasVideo): original file when the browser can play it, else an MP4 made by FFmpeg. */
  videoUrl: (id) => `/api/tracks/${id}/video`,
  coverUrl: (id) => `/api/tracks/${id}/cover`,
  async waveform(id) { try { const r = await req('GET', `/api/tracks/${id}/waveform`, undefined, true); return await r.arrayBuffer(); } catch { return null; } },
  saveWaveform: (id, bytes) => req('PUT', `/api/tracks/${id}/waveform`, bytes),
  addFiles: (paths) => req('POST', '/api/files', { paths }),
  playlists: () => req('GET', '/api/playlists'),
  createPlaylist: (name, trackIds = [], folder) => req('POST', '/api/playlists', { name, trackIds, folder }),
  updatePlaylist: (id, patch) => req('PATCH', `/api/playlists/${id}`, patch),
  deletePlaylist: (id) => req('DELETE', `/api/playlists/${id}`),
  addToPlaylist: (id, trackIds) => req('POST', `/api/playlists/${id}/add`, { trackIds }),
  m3uUrl: (id) => `/api/playlists/${id}/m3u`,
  importM3U: (body) => req('POST', '/api/import/m3u', body),
  importRekordbox: (body) => req('POST', '/api/import/rekordbox', body),
  rekordboxExportUrl: () => '/api/export/rekordbox',
  exportUsb: (playlistIds, targetDir) => req('POST', '/api/export/usb', { playlistIds, targetDir }),
  folders: () => req('GET', '/api/folders'),
  addFolder: (path, name) => req('POST', '/api/folders', { path, name }),
  rescanFolder: (id) => req('POST', `/api/folders/${id}/scan`),
  removeFolder: (id) => req('DELETE', `/api/folders/${id}`),
  drives: () => req('GET', '/api/drives'),
  browse: (path) => req('GET', `/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  sourceTypes: () => req('GET', '/api/source-types'),
  sources: () => req('GET', '/api/sources'),
  addSource: (cfg) => req('POST', '/api/sources', cfg),
  syncSource: (id) => req('POST', `/api/sources/${id}/sync`),
  removeSource: (id) => req('DELETE', `/api/sources/${id}`),
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
  historySession: (id) => req('GET', `/api/history/${id}`),
  renameHistory: (id, name) => req('PATCH', `/api/history/${id}`, { name }),
  deleteHistory: (id) => req('DELETE', `/api/history/${id}`),
  historyExportUrl: (id, format) => `/api/history/${id}/export?format=${format}`,
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
  events(handlers) {
    const es = new EventSource('/api/events');
    for (const [ev, fn] of Object.entries(handlers)) es.addEventListener(ev, (e) => fn(JSON.parse(e.data || '{}')));
    return es;
  },
};
