// Password login for hosted mode (server bound to a non-loopback address, e.g. on a NAS).
//
// - Password from OPENDJ_PASSWORD, or set once on the first-run setup page with a one-time code printed in the
//   server log (so nobody else on the network can claim a fresh install first). Stored as a scrypt hash.
// - Sessions: random 32-byte tokens in an HttpOnly, SameSite=Strict cookie. Only SHA-256 hashes of the tokens are
//   stored (auth.json in the data dir, mode 0600), with an expiry.
// - Login (and the setup code) is rate limited per client with exponential backoff, plus a global failure budget
//   that slows every attempt down when many addresses fail at once (no hard lockout). A browser that has signed in
//   before carries a signed "known device" cookie and is rate limited on its own, so someone failing from the same
//   address (shared NAT, the reverse proxy) cannot lock its owner out.
// - Client address: the socket peer; with OPENDJ_TRUST_PROXY=1 the right-most X-Forwarded-For hop (the one the
//   proxy added; anything left of it is client-controlled). OPENDJ_TRUST_PROXY=<ip,ip> only trusts X-Forwarded-*
//   when the request comes from one of those proxies, and skips them when reading X-Forwarded-For from the right.
// - scrypt runs off the event loop (crypto.scrypt) with a small concurrency cap.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const COOKIE = 'opendj_session';
export const DEVICE_COOKIE = 'opendj_device';
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const DEVICE_TTL = 365 * 24 * 3600 * 1000;
const FREE_ATTEMPTS = 5;
const MAX_LOCK = 15 * 60 * 1000;
const GLOBAL_WINDOW = 60 * 1000;
const GLOBAL_FREE = 20;          // failures per minute across all clients before attempts are slowed down
const GLOBAL_STEP = 250;         // ms added per failure above the budget
const GLOBAL_MAX_DELAY = 5000;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const SCRYPT_CONCURRENCY = 2;
const SCRYPT_QUEUE = 32;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpErr = (status, msg, extra = {}) => Object.assign(new Error(msg), { status, ...extra });

/** Passwords that are refused in OPENDJ_PASSWORD (README / compose examples and other obvious ones). */
export const WEAK_PASSWORD = /^(change-me|choose-a-password|password|opendj)$/i;
export const MIN_PASSWORD = 8;
/** Throws a clear error for a password given in OPENDJ_PASSWORD that is too short or a known placeholder. */
export function checkEnvPassword(pw) {
  const v = String(pw);
  if (v.length < MIN_PASSWORD || WEAK_PASSWORD.test(v.trim())) {
    throw new Error(`OPENDJ_PASSWORD is too weak: use at least ${MIN_PASSWORD} characters and not an example value like "change-me". `
      + 'Set a real password, or leave OPENDJ_PASSWORD unset to choose one on first visit (the setup code is printed in the log).');
  }
}

let scryptActive = 0;
const scryptWaiting = [];
/** crypto.scrypt with at most SCRYPT_CONCURRENCY running; a long queue is refused (503) instead of growing. */
async function scrypt(pw, salt, len, opts) {
  if (scryptActive >= SCRYPT_CONCURRENCY) {
    if (scryptWaiting.length >= SCRYPT_QUEUE) throw httpErr(503, 'The server is busy. Try again in a moment.', { retryAfter: 1 });
    await new Promise((r) => scryptWaiting.push(r));
  }
  scryptActive++;
  try {
    return await new Promise((resolve, reject) => crypto.scrypt(pw, salt, len, { ...opts, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));
  } finally {
    scryptActive--;
    scryptWaiting.shift()?.();
  }
}

function hashPasswordSync(pw, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(pw), salt, 64, SCRYPT);
  return { salt: salt.toString('hex'), hash: hash.toString('hex'), N: SCRYPT.N };
}
async function hashPassword(pw, salt = crypto.randomBytes(16)) {
  const hash = await scrypt(String(pw), salt, 64, SCRYPT);
  return { salt: salt.toString('hex'), hash: hash.toString('hex'), N: SCRYPT.N };
}
async function checkPassword(pw, rec) {
  if (!rec || typeof pw !== 'string') return false;
  const want = Buffer.from(rec.hash, 'hex');
  const got = await scrypt(pw, Buffer.from(rec.salt, 'hex'), want.length, { ...SCRYPT, N: rec.N || SCRYPT.N });
  return crypto.timingSafeEqual(want, got);
}

const normIp = (ip) => String(ip || '').trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '').replace(/^\[|\]$/g, '');
/** OPENDJ_TRUST_PROXY: true ('1': the peer is a proxy), a list of proxy addresses, or false. */
export function parseTrustProxy(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (Array.isArray(v)) { const l = v.map(normIp).filter(Boolean); return l.length ? l : false; }
  if (typeof v === 'string' && v.trim() && v.trim() !== '0' && v.trim() !== 'false') {
    const l = v.split(/[,\s]+/).map(normIp).filter(Boolean);
    return l.length ? l : false;
  }
  return false;
}

export function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const v = part.slice(i + 1).trim();
    try { out[part.slice(0, i).trim()] = decodeURIComponent(v); } catch { out[part.slice(0, i).trim()] = v; }
  }
  return out;
}

export class Auth {
  constructor({ dataDir, enabled, password = process.env.OPENDJ_PASSWORD, trustProxy = process.env.OPENDJ_TRUST_PROXY, secureCookie = process.env.OPENDJ_COOKIE_SECURE, log = console }) {
    this.enabled = !!enabled;
    this.file = path.join(dataDir, 'auth.json');
    this.trustProxy = parseTrustProxy(trustProxy);
    this.secureCookie = secureCookie;
    this.log = log;
    this.failures = new Map(); // client key (ip or dev:<id>) -> { n, until }
    this.globalFails = []; // timestamps of recent failures, all clients
    this.state = { password: null, sessions: {} };
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run */ }
    if (this.enabled && password) checkEnvPassword(password); // refuse to start with "change-me" & co.
    this.envPassword = password ? hashPasswordSync(password) : null;
    this.setupCode = null;
    if (this.enabled && !this.passwordRecord()) {
      this.setupCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      log.log?.(`[opendj] No password set. Open the app and use setup code ${this.setupCode} to choose one (or set OPENDJ_PASSWORD).`);
    }
    this.pruneSessions();
  }

  passwordRecord() { return this.envPassword || this.state.password; }
  get setupRequired() { return this.enabled && !this.passwordRecord(); }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  pruneSessions() {
    const now = Date.now();
    let changed = false;
    for (const [h, exp] of Object.entries(this.state.sessions)) if (exp < now) { delete this.state.sessions[h]; changed = true; }
    if (changed) this.save();
  }

  /** Did this request come through a proxy we trust (so X-Forwarded-* may be read)? */
  fromTrustedProxy(req) {
    if (this.trustProxy === true) return true;
    if (Array.isArray(this.trustProxy)) return this.trustProxy.includes(normIp(req.socket?.remoteAddress));
    return false;
  }
  /** Right-most value of a comma-separated X-Forwarded-* header (the one the trusted proxy set). */
  forwarded(req, name) {
    if (!this.fromTrustedProxy(req)) return '';
    const hops = String(req.headers[name] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (name === 'x-forwarded-for' && Array.isArray(this.trustProxy)) {
      while (hops.length > 1 && this.trustProxy.includes(normIp(hops.at(-1)))) hops.pop(); // chained trusted proxies
    }
    return hops.at(-1) || '';
  }

  clientIp(req) {
    return normIp(this.forwarded(req, 'x-forwarded-for')) || normIp(req.socket?.remoteAddress) || '?';
  }

  isSecure(req) {
    if (this.secureCookie === '1') return true;
    if (this.secureCookie === '0') return false;
    return !!req.socket?.encrypted || this.forwarded(req, 'x-forwarded-proto').toLowerCase() === 'https';
  }

  /** Is this request authenticated? (always true when auth is off) */
  check(req) {
    if (!this.enabled) return true;
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (!tok || tok.length > 128) return false;
    const exp = this.state.sessions[sha(tok)];
    if (!exp) return false;
    if (exp < Date.now()) { delete this.state.sessions[sha(tok)]; this.save(); return false; }
    return true;
  }

  // ---------------- rate limiting ----------------
  deviceSig(id) {
    if (!/^[0-9a-f]{64}$/.test(this.state.deviceSecret || '')) { this.state.deviceSecret = crypto.randomBytes(32).toString('hex'); this.save(); }
    return crypto.createHmac('sha256', this.state.deviceSecret).update('device:' + id).digest('base64url');
  }
  /** Id of a browser that signed in here before (signed cookie), or null. */
  knownDevice(req) {
    const v = parseCookies(req.headers.cookie)[DEVICE_COOKIE];
    const m = /^([\w-]{16,64})\.([\w-]{43})$/.exec(v || '');
    if (!m || !this.state.deviceSecret) return null;
    const a = Buffer.from(m[2]), b = Buffer.from(this.deviceSig(m[1]));
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? m[1] : null;
  }
  /** Rate-limit key: a known device is limited on its own, anything else by client address. */
  limitKey(req) { const d = this.knownDevice(req); return d ? 'dev:' + d : 'ip:' + this.clientIp(req); }

  /** Remaining lockout for this client in ms (0 = may try). */
  lockedFor(req) {
    const f = this.failures.get(this.limitKey(req));
    return f && f.until > Date.now() ? f.until - Date.now() : 0;
  }
  /** Delay every attempt gets while many clients are failing (global budget; slows, never locks out). */
  globalDelay() {
    const now = Date.now();
    while (this.globalFails.length && now - this.globalFails[0] > GLOBAL_WINDOW) this.globalFails.shift();
    const over = this.globalFails.length - GLOBAL_FREE;
    return over > 0 ? Math.min(GLOBAL_MAX_DELAY, over * GLOBAL_STEP) : 0;
  }

  fail(req, key = this.limitKey(req)) {
    const f = this.failures.get(key) || { n: 0, until: 0 };
    f.n++;
    if (f.n >= FREE_ATTEMPTS) f.until = Date.now() + Math.min(MAX_LOCK, 1000 * 2 ** (f.n - FREE_ATTEMPTS));
    this.failures.delete(key); this.failures.set(key, f); // most recent last (oldest evicted first)
    if (this.failures.size > 10000) this.failures.delete(this.failures.keys().next().value);
  }

  /**
   * Runs one credential check under the limits: refuses while locked (429), waits out the global delay, and counts
   * the attempt as a failure up front (so parallel guesses cannot all slip past the lock while scrypt runs).
   * `fn` resolves true when the credential is right; the provisional failure is then cleared.
   */
  async attempt(req, fn) {
    const key = this.limitKey(req);
    const wait = this.lockedFor(req);
    if (wait) throw httpErr(429, `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.`, { retryAfter: Math.ceil(wait / 1000) });
    const before = this.failures.get(key);
    const prev = before && { ...before };
    this.fail(req, key);
    const delay = this.globalDelay();
    if (delay) await sleep(delay);
    let ok = false;
    try { ok = !!(await fn()); } finally {
      if (ok) { if (prev) this.failures.set(key, prev); else this.failures.delete(key); } // a right answer does not count
      else this.globalFails.push(Date.now());
    }
    return ok;
  }

  issue(req, res) {
    const tok = crypto.randomBytes(32).toString('base64url');
    this.state.sessions[sha(tok)] = Date.now() + SESSION_TTL;
    this.save();
    this.failures.delete(this.limitKey(req));
    const dev = this.knownDevice(req) || crypto.randomBytes(16).toString('base64url');
    res.setHeader('Set-Cookie', [
      this.cookie(req, tok, SESSION_TTL / 1000),
      `${DEVICE_COOKIE}=${dev}.${this.deviceSig(dev)}; Path=/api/auth/; HttpOnly; SameSite=Strict; Max-Age=${DEVICE_TTL / 1000}${this.isSecure(req) ? '; Secure' : ''}`,
    ]);
  }

  cookie(req, value, maxAge) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge)}${this.isSecure(req) ? '; Secure' : ''}`;
  }

  /** Throws { status } errors; on success sets the session cookie. */
  async login(req, res, password) {
    if (this.setupRequired) throw httpErr(409, 'No password set yet');
    const ok = await this.attempt(req, async () => typeof password === 'string' && !!password && password.length <= 1024 && checkPassword(password, this.passwordRecord()));
    if (!ok) throw httpErr(401, 'Wrong password');
    this.issue(req, res);
  }

  /** First-run: set the password with the one-time setup code from the server log. */
  async setup(req, res, { code, password }) {
    if (!this.setupRequired) throw httpErr(409, 'A password is already set');
    const ok = await this.attempt(req, async () => {
      if (!this.setupCode) return false;
      const a = Buffer.from(String(code || '').trim().toUpperCase()), b = Buffer.from(this.setupCode);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
    if (!ok) throw httpErr(401, 'Wrong setup code (see the server log)');
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 1024) throw httpErr(400, `Use at least ${MIN_PASSWORD} characters`);
    const rec = await hashPassword(password);
    if (!this.setupRequired) throw httpErr(409, 'A password is already set'); // set by a parallel request meanwhile
    this.state.password = rec;
    this.setupCode = null;
    this.issue(req, res);
  }

  /** Change the stored password (when not fixed by OPENDJ_PASSWORD); signs out every other session. */
  async changePassword(req, res, { current, password }) {
    if (this.envPassword) throw httpErr(409, 'The password is set by OPENDJ_PASSWORD');
    const ok = await this.attempt(req, async () => typeof current === 'string' && current.length <= 1024 && checkPassword(current, this.state.password));
    if (!ok) throw httpErr(401, 'Wrong password');
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 1024) throw httpErr(400, `Use at least ${MIN_PASSWORD} characters`);
    this.state.password = await hashPassword(password);
    this.state.sessions = {};
    this.issue(req, res);
  }

  logout(req, res) {
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (tok && this.state.sessions[sha(tok)]) { delete this.state.sessions[sha(tok)]; this.save(); }
    res.setHeader('Set-Cookie', this.cookie(req, '', 0));
  }
}
