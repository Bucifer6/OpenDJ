import { PlexClient } from './plex.js';
import { JellyfinClient } from './jellyfin.js';
import { EmbyClient } from './emby.js';
import { SubsonicClient } from './subsonic.js';
import { MediaMaxClient } from './mediamax.js';

export { PlexClient, JellyfinClient, EmbyClient, SubsonicClient, MediaMaxClient };

const URL_FIELD = { name: 'url', label: 'Server URL', type: 'url', required: true };
const USER_FIELD = (required) => ({ name: 'username', label: 'Username', type: 'text', required });
const PASS_FIELD = (required) => ({ name: 'password', label: 'Password', type: 'password', required });

/** Describes each source type and the config fields its connection form needs. */
export const SOURCE_TYPES = [
  {
    type: 'plex',
    label: 'Plex',
    fields: [
      { ...URL_FIELD, placeholder: 'http://192.168.1.10:32400' },
      { name: 'token', label: 'X-Plex-Token', type: 'password', required: false, help: 'Or sign in with your plex.tv username and password.' },
      USER_FIELD(false),
      PASS_FIELD(false),
    ],
  },
  {
    type: 'jellyfin',
    label: 'Jellyfin',
    fields: [{ ...URL_FIELD, placeholder: 'http://192.168.1.10:8096' }, USER_FIELD(true), PASS_FIELD(false)],
  },
  {
    type: 'emby',
    label: 'Emby',
    fields: [{ ...URL_FIELD, placeholder: 'http://192.168.1.10:8096' }, USER_FIELD(true), PASS_FIELD(false)],
  },
  {
    type: 'subsonic',
    label: 'Subsonic / Navidrome / Airsonic',
    fields: [
      { ...URL_FIELD, placeholder: 'http://192.168.1.10:4533' }, USER_FIELD(true), PASS_FIELD(true),
      {
        name: 'legacyAuth',
        label: 'Legacy password auth',
        type: 'checkbox',
        required: false,
        help: 'Only for servers that refuse token auth (error 41, e.g. LDAP users): sends the password itself (hex-encoded, not encrypted) with every request. Use HTTPS.',
      },
    ],
  },
  {
    type: 'mediamax',
    label: 'MediaMax',
    fields: [
      { ...URL_FIELD, placeholder: 'http://192.168.1.10:8484' },
      USER_FIELD(false),
      PASS_FIELD(false),
      {
        name: 'token',
        label: 'API key',
        type: 'password',
        required: false,
        help: 'Optional: a MediaMax API key (mmk_…, from your account’s API keys). Or sign in with username and password; only the session token is kept. BPM, key and energy come from MediaMax DJ-mode analysis.',
      },
    ],
  },
];

const CLASSES = { plex: PlexClient, jellyfin: JellyfinClient, emby: EmbyClient, subsonic: SubsonicClient, navidrome: SubsonicClient, airsonic: SubsonicClient, mediamax: MediaMaxClient };

/** createClient(config, { fetchImpl }) -> SourceClient */
export function createClient(config, opts = {}) {
  const Cls = CLASSES[String(config?.type || '').toLowerCase()];
  if (!Cls) throw new Error(`Unknown source type: ${config?.type}`);
  return new Cls(config, opts);
}

/** Media-server types whose connection form has a token / API key field the user types in. */
export const USER_TOKEN_TYPES = new Set(['plex', 'mediamax']);
const SUBSONIC_TYPES = new Set(['subsonic', 'navidrome', 'airsonic']);
/** Fields that only the server sets (from connect()/sync): never taken from a request body. */
export const SERVER_SOURCE_FIELDS = ['token', 'accountToken', 'plexUser', 'userId', 'legacyAuth', 'pathPrefix', 'deviceId', 'serverName', 'lastSync', 'trackCount', 'addedAt', 'hasPassword', 'hasToken'];
export const SOURCE_SECRETS = ['password', 'token', 'accountToken'];
/** Server state tied to one endpoint / account (dropped with the secrets when the endpoint changes). */
const ENDPOINT_STATE = ['token', 'userId', 'pathPrefix', 'plexUser'];

const normUrl = (u) => {
  const v = String(u || '').trim();
  try { const x = new URL(v); return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, '')}`.toLowerCase(); } catch { return v.replace(/\/+$/, '').toLowerCase(); }
};
/** What a stored secret is bound to: type, server URL, user name and (Subsonic) auth mode. */
export function sourceEndpoint(cfg = {}) {
  const type = String(cfg.type || '').toLowerCase();
  return JSON.stringify([SUBSONIC_TYPES.has(type) ? 'subsonic' : type, normUrl(cfg.url), String(cfg.username || '').trim(), SUBSONIC_TYPES.has(type) ? !!cfg.legacyAuth : false]);
}

/**
 * Config to connect with when the UI adds or edits a media server (`body` = the form, `prev` = the stored source).
 * Stored secrets (password, token) and account state are only reused while the endpoint is unchanged; a changed
 * URL / type / user / auth mode needs the password (or token) again, so it is never sent to a different host.
 * Server-only fields are ignored; `token` only where the form has a token field, `legacyAuth` only as the
 * Subsonic checkbox (part of the endpoint, so switching it on also needs the password again).
 */
export function sourceConfigFromForm(body, prev = null) {
  const type = String(body.type || prev?.type || '').toLowerCase();
  const input = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (SERVER_SOURCE_FIELDS.includes(k) || k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    input[k] = v;
  }
  if (USER_TOKEN_TYPES.has(type) && typeof body.token === 'string' && body.token.trim()) input.token = body.token.trim();
  if (SUBSONIC_TYPES.has(type)) input.legacyAuth = body.legacyAuth === true || body.legacyAuth === 'true' || body.legacyAuth === 'on';
  if (typeof input.password !== 'string' || !input.password) delete input.password;
  if (!prev) return { ...input, type };
  const base = Object.fromEntries(Object.entries(prev).filter(([k]) => !SOURCE_SECRETS.includes(k) && !ENDPOINT_STATE.includes(k) && k !== 'legacyAuth'));
  const cfg = { ...base, ...input, type, id: prev.id };
  if (!SUBSONIC_TYPES.has(type)) delete cfg.legacyAuth;
  const same = sourceEndpoint(prev) === sourceEndpoint(cfg);
  const newSecret = !!(input.password || input.token);
  if (same && !newSecret) {
    for (const k of [...SOURCE_SECRETS, ...ENDPOINT_STATE]) if (prev[k] !== undefined) cfg[k] = prev[k];
  } else if (same) {
    if (prev.pathPrefix) cfg.pathPrefix = prev.pathPrefix; // new credentials, same server: sign in again
  }
  return cfg;
}
