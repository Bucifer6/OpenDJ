import { JellyfinClient } from './jellyfin.js';

/**
 * Emby client. Same API family as Jellyfin; differences handled here:
 *  - some installs only answer under the `/emby` path prefix: if connecting with the URL as
 *    given returns 404, retry once with `/emby` appended (persisted via persistable().pathPrefix);
 *  - auth header is `X-Emby-Authorization` (Authorization is still sent; harmless).
 */
export class EmbyClient extends JellyfinClient {
  get serverLabel() {
    return 'Emby';
  }

  _headers(extra = {}) {
    const h = super._headers(extra);
    // Emby's canonical header; some reverse proxies strip/override plain Authorization.
    h['X-Emby-Authorization'] = this._authValue();
    return h;
  }

  async connect() {
    if (!this.config.url) throw new Error('Emby server URL is required');
    try {
      return await this._connectOnce();
    } catch (err) {
      if (err.status === 404 && !this.prefix && !/\/emby$/i.test(this.config.url)) {
        this.prefix = '/emby';
        return this._connectOnce();
      }
      throw err;
    }
  }
}
