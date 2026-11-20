// Small JSON helper for the recording / broadcast endpoints (same conventions as ../api.js).
export async function call(method, url, body) {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (r.status === 401 && !location.pathname.endsWith('/login.html')) { location.href = `/login.html?next=${encodeURIComponent(location.pathname)}`; throw new Error('Login required'); }
  let j = null; try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw Object.assign(new Error(j?.error || r.statusText), { status: r.status, code: j?.code });
  return j;
}
export const recApi = {
  config: () => call('GET', '/api/recording/config'),
  saveConfig: (patch) => call('PUT', '/api/recording/config', patch),
  status: () => call('GET', '/api/recording/status'),
  start: (o) => call('POST', '/api/recording/start', o),
  track: (id, t) => call('POST', `/api/recording/${id}/track`, t),
  stop: (id, lastSeq) => call('POST', `/api/recording/${id}/stop`, { lastSeq }),
  list: () => call('GET', '/api/recordings'),
  remove: (name) => call('DELETE', `/api/recordings/file?name=${encodeURIComponent(name)}`),
  fileUrl: (name, download) => `/api/recordings/file?name=${encodeURIComponent(name)}${download ? '&download=1' : ''}`,
  chunkUrl: (id, seq) => `/api/recording/${id}/chunk?seq=${seq}`,
};
export const castApi = {
  config: () => call('GET', '/api/broadcast/config'),
  saveConfig: (patch) => call('PUT', '/api/broadcast/config', patch),
  status: () => call('GET', '/api/broadcast/status'),
  start: (o) => call('POST', '/api/broadcast/start', o),
  metadata: (id, m) => call('POST', `/api/broadcast/${id}/metadata`, m),
  stop: (id) => call('POST', `/api/broadcast/${id}/stop`),
  chunkUrl: (id, seq) => `/api/broadcast/${id}/chunk?seq=${seq}`,
};
