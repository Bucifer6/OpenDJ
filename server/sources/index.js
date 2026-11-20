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
    fields: [{ ...URL_FIELD, placeholder: 'http://192.168.1.10:4533' }, USER_FIELD(true), PASS_FIELD(true)],
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
