// Outbound-fetch guard for URLs a user can type into settings (SSRF with read-back).
//
// Hosted mode only refuses loopback, link-local and unspecified addresses: LAN addresses stay allowed, because a
// NAS install legitimately fetches from the local network. Redirects are followed by hand and every hop is checked.
// Limitation: the name is resolved here and again by fetch(), so a DNS server that answers differently the second
// time (rebinding) is not caught; the stems model is also SHA-256 pinned, so nothing unverified is ever served back.
//
// Not used for media sources (Plex/Jellyfin/Subsonic…) or lighting (Art-Net, WLED, Hue): reaching LAN / local
// devices is their whole purpose, and only a signed-in user can configure them.
import dns from 'node:dns';
import net from 'node:net';

const v4 = (ip) => ip.split('.').map(Number);
/** Loopback, link-local or unspecified (IPv4, IPv6, IPv4-mapped IPv6). */
export function isBlockedAddress(addr) {
  let ip = String(addr || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const dotted = /^[0-9a-f:]*:(\d+\.\d+\.\d+\.\d+)$/.exec(ip); // ::ffff:127.0.0.1, ::127.0.0.1 (embedded IPv4)
  if (dotted && net.isIPv6(ip)) ip = dotted[1];
  if (net.isIPv4(ip)) {
    const [a, b] = v4(ip);
    return a === 127 || a === 0 || (a === 169 && b === 254);
  }
  if (net.isIPv6(ip)) {
    const full = expand6(ip);
    if (/^0{4}(:0{4}){6}:0{3}[01]$/.test(full)) return true; // :: and ::1
    const first = parseInt(full.slice(0, 4), 16);
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    const m = /^0{4}(:0{4}){4}:ffff:([0-9a-f]{4}):([0-9a-f]{4})$/.exec(full); // ::ffff:a.b.c.d in hex
    if (m) { const n = parseInt(m[2], 16), o = parseInt(m[3], 16); return isBlockedAddress(`${n >> 8}.${n & 255}.${o >> 8}.${o & 255}`); }
    return false;
  }
  return true; // not an address at all: refuse
}
function expand6(ip) {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const parts = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return parts.map((p) => p.padStart(4, '0')).join(':');
}

/** Throws (status 400) unless every address `url`'s host resolves to is allowed. */
export async function assertFetchable(url, { lookup = dns.promises.lookup } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw Object.assign(new Error('Only http(s) URLs can be fetched'), { status: 400 });
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) {
    throw Object.assign(new Error(`Refusing to fetch from ${u.hostname}: it points to this server or a link-local address`), { status: 400 });
  }
}

/**
 * fetch() that follows redirects itself (max `maxRedirects`), checking each hop with assertFetchable when
 * `check` is on. Returns the final Response.
 */
export async function guardedFetch(url, init = {}, { fetch: f = globalThis.fetch, check = true, lookup, maxRedirects = 5 } = {}) {
  let u = String(url);
  for (let hop = 0; ; hop++) {
    if (check) await assertFetchable(u, { lookup });
    const res = await f(u, { ...init, redirect: 'manual' });
    const loc = res.headers?.get?.('location');
    if (![301, 302, 303, 307, 308].includes(res.status) || !loc) return res;
    try { await res.body?.cancel?.(); } catch { /* ignore */ }
    if (hop >= maxRedirects) throw new Error('Too many redirects');
    u = new URL(loc, u).href;
  }
}
