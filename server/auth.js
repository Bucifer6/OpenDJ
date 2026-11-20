// Password login for hosted mode (server bound to a non-loopback address, e.g. on a NAS).
//
// - Password from OPENDJ_PASSWORD, or set once on the first-run setup page with a one-time code printed in the
//   server log (so nobody else on the network can claim a fresh install first). Stored as a scrypt hash.
// - Sessions: random 32-byte tokens in an HttpOnly, SameSite=Strict cookie. Only SHA-256 hashes of the tokens are
//   stored (auth.json in the data dir, mode 0600), with an expiry.
// - Login is rate limited per client address with exponential backoff.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const COOKIE = 'opendj_session';
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const FREE_ATTEMPTS = 5;
const MAX_LOCK = 15 * 60 * 1000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('hex'), hash: hash.toString('hex'), N: 16384 };
}
function checkPassword(pw, rec) {
  if (!rec) return false;
  const want = Buffer.from(rec.hash, 'hex');
  const got = crypto.scryptSync(String(pw), Buffer.from(rec.salt, 'hex'), want.length, { N: rec.N || 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class Auth {
  constructor({ dataDir, enabled, password = process.env.OPENDJ_PASSWORD, trustProxy = process.env.OPENDJ_TRUST_PROXY === '1', secureCookie = process.env.OPENDJ_COOKIE_SECURE, log = console }) {
    this.enabled = !!enabled;
    this.file = path.join(dataDir, 'auth.json');
    this.trustProxy = trustProxy;
    this.secureCookie = secureCookie;
    this.log = log;
    this.failures = new Map(); // ip -> { n, until }
    this.state = { password: null, sessions: {} };
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* first run */ }
    this.envPassword = password ? hashPassword(password) : null;
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

  clientIp(req) {
    if (this.trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf;
    }
    return req.socket.remoteAddress || '?';
  }

  isSecure(req) {
    if (this.secureCookie === '1') return true;
    if (this.secureCookie === '0') return false;
    return !!req.socket.encrypted || (this.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
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

  /** Remaining lockout for this client in ms (0 = may try). */
  lockedFor(req) {
    const f = this.failures.get(this.clientIp(req));
    return f && f.until > Date.now() ? f.until - Date.now() : 0;
  }

  fail(req) {
    const ip = this.clientIp(req);
    const f = this.failures.get(ip) || { n: 0, until: 0 };
    f.n++;
    if (f.n >= FREE_ATTEMPTS) f.until = Date.now() + Math.min(MAX_LOCK, 1000 * 2 ** (f.n - FREE_ATTEMPTS));
    this.failures.set(ip, f);
    if (this.failures.size > 10000) this.failures.delete(this.failures.keys().next().value);
  }

  issue(req, res) {
    const tok = crypto.randomBytes(32).toString('base64url');
    this.state.sessions[sha(tok)] = Date.now() + SESSION_TTL;
    this.save();
    this.failures.delete(this.clientIp(req));
    res.setHeader('Set-Cookie', this.cookie(req, tok, SESSION_TTL / 1000));
  }

  cookie(req, value, maxAge) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge)}${this.isSecure(req) ? '; Secure' : ''}`;
  }

  /** Throws { status } errors; on success sets the session cookie. */
  login(req, res, password) {
    const wait = this.lockedFor(req);
    if (wait) throw Object.assign(new Error(`Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.`), { status: 429, retryAfter: Math.ceil(wait / 1000) });
    if (this.setupRequired) throw Object.assign(new Error('No password set yet'), { status: 409 });
    if (typeof password !== 'string' || !password || password.length > 1024 || !checkPassword(password, this.passwordRecord())) {
      this.fail(req);
      throw Object.assign(new Error('Wrong password'), { status: 401 });
    }
    this.issue(req, res);
  }

  /** First-run: set the password with the one-time setup code from the server log. */
  setup(req, res, { code, password }) {
    if (!this.setupRequired) throw Object.assign(new Error('A password is already set'), { status: 409 });
    const wait = this.lockedFor(req);
    if (wait) throw Object.assign(new Error(`Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.`), { status: 429, retryAfter: Math.ceil(wait / 1000) });
    const a = Buffer.from(String(code || '').trim().toUpperCase()), b = Buffer.from(this.setupCode);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { this.fail(req); throw Object.assign(new Error('Wrong setup code (see the server log)'), { status: 401 }); }
    if (typeof password !== 'string' || password.length < 8) throw Object.assign(new Error('Use at least 8 characters'), { status: 400 });
    this.state.password = hashPassword(password);
    this.setupCode = null;
    this.issue(req, res);
  }

  /** Change the stored password (when not fixed by OPENDJ_PASSWORD); signs out every other session. */
  changePassword(req, res, { current, password }) {
    if (this.envPassword) throw Object.assign(new Error('The password is set by OPENDJ_PASSWORD'), { status: 409 });
    if (!checkPassword(current, this.state.password)) { this.fail(req); throw Object.assign(new Error('Wrong password'), { status: 401 }); }
    if (typeof password !== 'string' || password.length < 8) throw Object.assign(new Error('Use at least 8 characters'), { status: 400 });
    this.state.password = hashPassword(password);
    this.state.sessions = {};
    this.issue(req, res);
  }

  logout(req, res) {
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (tok && this.state.sessions[sha(tok)]) { delete this.state.sessions[sha(tok)]; this.save(); }
    res.setHeader('Set-Cookie', this.cookie(req, '', 0));
  }
}
