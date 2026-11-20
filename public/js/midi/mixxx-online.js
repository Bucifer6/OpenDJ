// Find a controller's Mixxx mapping online (github.com/mixxxdj/mixxx, res/controllers) and download it on request.
// Mixxx mappings are GPL-licensed community work: OpenDJ only fetches and converts them when the user asks.

const REPO = 'mixxxdj/mixxx', BRANCH = 'main', DIR = 'res/controllers';
export const LIST_URL = `https://api.github.com/repos/${REPO}/contents/${DIR}?ref=${BRANCH}`;
export const TREE_URL = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}:${DIR}`;
export const rawUrl = (file) => `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${DIR}/${encodeURIComponent(file)}`;
const CACHE_KEY = 'opendj.mixxxControllerIndex.v1';
const DAY = 24 * 3600 * 1000;

const safeStorage = () => { try { return globalThis.localStorage || null; } catch { return null; } };

function readCache(storage) {
  try { const c = JSON.parse(storage?.getItem(CACHE_KEY) || 'null'); return c && Array.isArray(c.items) ? c : null; } catch { return null; }
}

async function rateLimitError(res) {
  const reset = Number(res.headers?.get?.('x-ratelimit-reset')) * 1000;
  const when = reset ? new Date(reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'a while';
  return new Error(`GitHub's limit for anonymous requests was reached. Try again after ${when}, or download the .midi.xml from github.com/mixxxdj/mixxx and use "Import mapping file…".`);
}

/**
 * List all Mixxx MIDI mappings: [{ name, file }]. Cached for a day; stale cache is used when GitHub is unreachable
 * or rate-limited. opts: { fetchFn, storage, force, now }
 */
export async function listMixxxMappings({ fetchFn = globalThis.fetch, storage = safeStorage(), force = false, now = Date.now() } = {}) {
  const cached = readCache(storage);
  if (cached && !force && now - cached.t < DAY) return cached.items;
  try {
    const res = await fetchFn(LIST_URL, { headers: { Accept: 'application/vnd.github+json' } });
    if (res.status === 403 || res.status === 429) throw await rateLimitError(res);
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    let files = (await res.json()).filter((x) => x.type === 'file').map((x) => x.name);
    if (files.length >= 1000) { // the contents API stops at 1000 entries: fall back to the git tree
      const t = await fetchFn(TREE_URL, { headers: { Accept: 'application/vnd.github+json' } });
      if (t.ok) files = (await t.json()).tree.filter((x) => x.type === 'blob').map((x) => x.path);
    }
    const items = files.filter((f) => /\.midi\.xml$/i.test(f)).map((file) => ({ file, name: mappingTitle(file) }));
    try { storage?.setItem(CACHE_KEY, JSON.stringify({ t: now, items })); } catch { /* quota */ }
    return items;
  } catch (e) {
    if (cached) return cached.items;
    throw e.message?.startsWith('GitHub') || e.message?.startsWith("GitHub's") ? e : new Error(`Could not reach GitHub (${e.message}). Check your internet connection or import a mapping file instead.`);
  }
}

export async function downloadMixxxMapping(file, { fetchFn = globalThis.fetch } = {}) {
  const res = await fetchFn(rawUrl(file));
  if (res.status === 403 || res.status === 429) throw await rateLimitError(res);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return res.text();
}

/** "Pioneer-DDJ-400.midi.xml" → "Pioneer DDJ 400" */
export const mappingTitle = (file) => file.replace(/\.midi\.xml$/i, '').replace(/[-_]+/g, ' ').trim();

const STOP = new Set(['midi', 'usb', 'in', 'out', 'port', 'input', 'output', 'controller', 'audio', 'device', 'dj', 'hid', 'mixxx', 'the', 'and', 'for', 'mapping']);
const tokens = (s) => String(s).toLowerCase().replace(/\.midi\.xml$/, '')
  .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
  .split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t) && !(t.length === 1 && /\d/.test(t) === false));
const compact = (s) => String(s).toLowerCase().replace(/\.midi\.xml$/, '').replace(/[^a-z0-9]+/g, '');

/**
 * Rank mapping files for a device name. Exact token matches (brand, model, model number) count most; a token found
 * inside the file name counts less. Returns [{ file, name, score }] best first, only plausible matches.
 */
export function matchMappings(deviceName, items, limit = 8) {
  // ALSA/Windows decorate port names: "DDJ-400 MIDI 1", "2- DDJ-FLX4", "MIDIIN2 (Mixtrack Pro FX)"
  const clean = String(deviceName).replace(/\bMIDI(IN|OUT)?\d*\b/gi, ' ').replace(/^\s*\d+\s*-\s*/, '').replace(/\s+\d+$/, '');
  const dt = [...new Set(tokens(clean))].filter((t) => !/^\d$/.test(t));
  const dc = compact(clean);
  if (!dt.length) return [];
  const out = [];
  for (const it of items) {
    const ft = new Set(tokens(it.file)), fc = compact(it.file);
    let score = 0, modelHit = false;
    for (const t of dt) {
      const w = /\d/.test(t) ? 1.6 : 1; // model numbers are the most telling
      if (ft.has(t)) { score += t.length * 2 * w; if (/\d/.test(t) || t.length >= 4) modelHit = true; } else if (t.length >= 3 && fc.includes(t)) score += t.length * w * 0.8;
    }
    if (dc.length >= 4 && fc.includes(dc)) { score += 8; modelHit = true; }
    if (!modelHit || score < 5) continue;
    score -= Math.abs(fc.length - dc.length) * 0.08; // prefer the closest-length name (DDJ-400 over DDJ-400-Pro)
    out.push({ ...it, score: Math.round(score * 10) / 10 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
