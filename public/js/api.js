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
  events(handlers) {
    const es = new EventSource('/api/events');
    for (const [ev, fn] of Object.entries(handlers)) es.addEventListener(ev, (e) => fn(JSON.parse(e.data || '{}')));
    return es;
  },
};
