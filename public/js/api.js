// Thin client for the local OpenDJ server.
async function req(method, url, body, raw = false) {
  const opts = { method, headers: {} };
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) { opts.body = body; opts.headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, opts);
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
  events(handlers) {
    const es = new EventSource('/api/events');
    for (const [ev, fn] of Object.entries(handlers)) es.addEventListener(ev, (e) => fn(JSON.parse(e.data || '{}')));
    return es;
  },
};
