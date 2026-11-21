// Real facts for the radio host, so it talks about the song / band / period without inventing them.
// Wikipedia (Romanian first, then English) summary of the artist and, when there is one, of the song.
// Only the artist name and song title leave this computer. Gentle with the API: one request at a time, a pause
// between them, direct page lookups before searching, a 10-minute pause after HTTP 429, results cached.

const cache = new Map();
const UA = { 'User-Agent': 'AI-MC/1.0 (OpenDJ add-on; https://github.com/Bucifer6/OpenDJ)', Accept: 'application/json' };
const MUSIC = /band|group|singer|musician|rapper|duo|trio|\bdj\b|composer|songwriter|vocalist|orchestra|formație|formatie|cântăreț|cantaret|cântăreață|muzician|trupă|trupa|grup|interpret|compozitor|lăutar|manele/i;
const SONG = /song|single|cântec|cantec|piesă|piesa|melodie|hit/i;
const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

let chain = Promise.resolve(), pausedUntil = 0;
class Transient extends Error {}
/** One request at a time, 400 ms apart; 429 pauses all lookups for 10 minutes. */
function getJson(url) {
  const run = async () => {
    if (Date.now() < pausedUntil) throw new Transient('paused');
    await new Promise((r) => setTimeout(r, 400));
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(5000) }).catch((e) => { throw new Transient(e.message); });
    if (r.status === 429) { pausedUntil = Date.now() + 10 * 60e3; throw new Transient('429'); }
    if (r.status === 404) return null;
    if (!r.ok) throw new Transient(String(r.status));
    return r.json();
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

function accept(sum, want, must) {
  if (!sum?.extract || sum.type === 'disambiguation') return '';
  const text = norm(`${sum.title} ${sum.extract}`);
  if (must.some((w) => w && !text.includes(norm(w)))) return '';
  return want.test(`${sum.description || ''} ${sum.extract.slice(0, 300)}`) ? sum.extract.replace(/\s+/g, ' ').slice(0, 700) : '';
}

/** Tries the page titles directly (1 request each), then a search; `must` words must appear (no namesakes). */
async function lookup(lang, titles, query, want, must = []) {
  const base = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/`;
  for (const title of titles) {
    const hit = accept(await getJson(base + encodeURIComponent(title.replace(/ /g, '_'))), want, must);
    if (hit) return hit;
  }
  const s = await getJson(`https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=3`);
  for (const p of (s?.pages || []).slice(0, 2)) {
    const hit = accept(await getJson(base + encodeURIComponent(p.key)), want, must);
    if (hit) return hit;
  }
  return '';
}

/** Caches answers, including "nothing found"; temporary failures (network, 429) are not cached. */
async function cached(key, fn) {
  if (cache.has(key)) return cache.get(key);
  try {
    const v = await fn();
    cache.set(key, v);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return v;
  } catch { return ''; }
}

/**
 * Free search the radio host asks for itself ("Uptown Girl Billy Joel 1983", "muzica anilor 80 în România").
 * Returns up to 3 short summaries [{ title, text, lang }] from English and Romanian Wikipedia.
 */
export async function wikiSearch(query) {
  const q = String(query || '').slice(0, 120).trim();
  if (!q) return [];
  return cached(`q:${norm(q)}`, async () => {
    const out = [];
    for (const lang of ['en', 'ro']) {
      const s = await getJson(`https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=2`);
      for (const p of (s?.pages || []).slice(0, lang === 'en' ? 2 : 1)) {
        const sum = await getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(p.key)}`);
        if (sum?.extract && sum.type !== 'disambiguation') out.push({ title: sum.title, lang, text: sum.extract.replace(/\s+/g, ' ').slice(0, 600) });
      }
    }
    return out;
  });
}

// ------------------------------------------------------------------ weather and headlines for the radio host
const WMO = { 0: 'senin', 1: 'mai mult senin', 2: 'parțial noros', 3: 'înnorat', 45: 'ceață', 48: 'ceață cu chiciură', 51: 'burniță ușoară', 53: 'burniță', 55: 'burniță deasă',
  61: 'ploaie slabă', 63: 'ploaie', 65: 'ploaie puternică', 66: 'ploaie înghețată', 67: 'ploaie înghețată puternică', 71: 'ninsoare slabă', 73: 'ninsoare', 75: 'ninsoare abundentă',
  77: 'fulguieli', 80: 'averse slabe', 81: 'averse', 82: 'averse puternice', 85: 'averse de ninsoare', 86: 'averse de ninsoare puternice', 95: 'furtună', 96: 'furtună cu grindină', 99: 'furtună cu grindină' };
const plain = async (url, ms = 6000) => { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(String(r.status)); return r; };
const shortCache = new Map(); // weather / news: 20 minutes
async function fresh(key, fn) {
  const hit = shortCache.get(key);
  if (hit && Date.now() - hit.at < 20 * 60e3) return hit.v;
  const v = await fn();
  shortCache.set(key, { at: Date.now(), v });
  return v;
}

/** "Cluj-Napoca: acum 4°C, înnorat; azi între 1°C și 7°C, șanse de precipitații 60%" (Open-Meteo, no key). */
export async function weatherNow(city) {
  if (!city) return 'Orașul nu e setat în panou.';
  return fresh(`w:${norm(city)}`, async () => {
    const g = await (await plain(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ro`)).json();
    const p = g.results?.[0];
    if (!p) return `Nu găsesc orașul „${city}”.`;
    const w = await (await plain(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=2`)).json();
    const c = w.current, d = w.daily;
    return `${p.name}: acum ${Math.round(c.temperature_2m)}°C, ${WMO[c.weather_code] || 'vreme schimbătoare'}, vânt ${Math.round(c.wind_speed_10m)} km/h; `
      + `azi între ${Math.round(d.temperature_2m_min[0])}°C și ${Math.round(d.temperature_2m_max[0])}°C (precipitații ${d.precipitation_probability_max[0] ?? 0}%); `
      + `mâine ${WMO[d.weather_code[1]] || ''}, ${Math.round(d.temperature_2m_min[1])}…${Math.round(d.temperature_2m_max[1])}°C.`;
  });
}

/** Up to 6 Romanian headlines (Google News RSS): topic "sport" = the sports section, anything else = a search. */
export async function headlines(topic = 'sport') {
  const q = String(topic || 'sport').trim().slice(0, 60);
  return fresh(`n:${norm(q)}`, async () => {
    const url = /^sport(uri)?$/i.test(q)
      ? 'https://news.google.com/rss/headlines/section/topic/SPORTS?hl=ro&gl=RO&ceid=RO:ro'
      : `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ro&gl=RO&ceid=RO:ro`;
    const xml = await (await plain(url)).text();
    const dec = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?(?:<pubDate>([\s\S]*?)<\/pubDate>)?/g)]
      .slice(0, 6).map((m) => dec(m[1]).trim());
  });
}

/** { artist: '...', song: '...' } with whatever Wikipedia knows ('' when nothing reliable was found). */
export async function factsFor(artist, title) {
  // main artist only ("A feat. B", "A, B"); "&" stays, it is part of names like "Kool & The Gang"
  const a = String(artist || '').split(/\s*(?:,|;|\bfeat\.?|\bft\.?|\bvs\.?|\sx\s)\s*/i)[0].trim();
  // "Title (Radio Edit)" / "Title - 2010 Remaster" → "Title"
  const t = String(title || '').replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/\s+-\s+.*$/, '').trim();
  if (!a) return { artist: '', song: '' };
  // the most distinctive word of the artist's name must appear in the page ("Guță", "Kool", "O-Zone")
  const key = a.split(/\s+/).filter((w) => !/^(the|and|&|de|la|din|si|și)$/i.test(w)).sort((x, y) => y.length - x.length)[0] || a;
  const artistFacts = await cached(`a:${norm(a)}`, async () =>
    (await lookup('ro', [a], a, MUSIC, [key])) || lookup('en', [a, `${a} (band)`, `${a} (singer)`], `${a} music`, MUSIC, [key]));
  const songFacts = t ? await cached(`s:${norm(a)}|${norm(t)}`, async () =>
    (await lookup('en', [`${t} (${a} song)`, `${t} (song)`, t], `${t} ${a} song`, SONG, [key, t])) || lookup('ro', [t], `${t} ${a}`, SONG, [key, t])) : '';
  return { artist: artistFacts, song: songFacts };
}
