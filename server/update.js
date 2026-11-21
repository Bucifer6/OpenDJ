// GET /api/update/check: is a newer OpenDJ release out? The server asks GitHub (not the page), so the page's CSP
// can stay connect-src 'self' for this and nothing about the user goes anywhere: the request carries no cookies, no
// library data and no settings, only "User-Agent: OpenDJ/<version>". Only api.github.com is ever contacted (fixed URL,
// no redirects followed), with a timeout, a 1 MB response cap, ETag revalidation and rate-limit back-off.
//
// Hosted mode: the route needs a signed-in user like every other API route (so only they get the prompt).
// Tests point it at a fake GitHub with OPENDJ_UPDATE_URL, which is only honoured for a loopback http(s) URL.
import { UpdateChecker, UPDATE_URL, isUpdateApiUrl } from '../public/js/shared/update-core.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** OPENDJ_UPDATE_URL (tests only): accepted for http(s)://127.0.0.1|localhost|[::1] URLs, ignored otherwise. */
export function testUpdateUrl(v = process.env.OPENDJ_UPDATE_URL) {
  if (!v) return null;
  try { const u = new URL(v); return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname) && !u.username && !u.password ? u.href : null; } catch { return null; }
}

export function createUpdateChecker({ version, fetch = globalThis.fetch, env = process.env } = {}) {
  const test = testUpdateUrl(env.OPENDJ_UPDATE_URL);
  return new UpdateChecker({
    fetch, version, url: test || UPDATE_URL,
    allowUrl: test ? (u) => u === test : isUpdateApiUrl,
    minIntervalMs: 15 * 60e3,
  });
}

/** Registers GET /api/update/check. Returns the checker (the Electron main process downloads from its result). */
export function registerUpdateRoutes({ route, library, version, hosted, checker = createUpdateChecker({ version }) }) {
  route('GET', '/api/update/check', async ({ query }) => {
    const force = query.get('force') === '1';
    const base = { hosted: !!hosted, auto: library.settings.updateCheck !== false };
    // automatic checks switched off in Settings: no request at all (a manual "Check now" is forced)
    if (!force && library.settings.updateCheck === false) return { ...base, ok: true, disabled: true, current: checker.version, available: false, latest: null };
    return { ...base, ...(await checker.check({ force })) };
  });
  return checker;
}
