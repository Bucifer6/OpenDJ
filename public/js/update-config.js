// Where "Update now" sends the mobile app, set at build time (scripts/mobile-sync.mjs rewrites this file in mobile/www
// from OPENDJ_UPDATE_CHANNEL / OPENDJ_PLAY_URL / OPENDJ_APPSTORE_URL / OPENDJ_TESTFLIGHT_URL).
//   channel 'github'    Android: open the APK of the new release (the system downloads it and offers to install it)
//           'play'      Android: open the Google Play listing
//           'appstore'  iOS: open the App Store listing
// iOS opens the App Store or TestFlight link when one is set, else the release page.
export const UPDATE_CONFIG = {
  channel: 'github',
  playUrl: 'https://play.google.com/store/apps/details?id=io.github.bucifer6.opendj',
  appStoreUrl: '',
  testFlightUrl: '',
};
