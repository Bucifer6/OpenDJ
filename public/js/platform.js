// What this copy of the UI runs on, for showing / hiding features. Sync: safe to use while building the UI.
//   platform.local   no OpenDJ server: the on-device backend (the iOS / Android app, or ?local=1 in a browser)
//   platform.native  inside the Capacitor app
// Features that need the server process or raw network / USB / MIDI access are hidden in local mode, with the reason
// below (shown in Settings → Mobile and wherever a hidden feature would have been).
import { localMode, native, os } from './local/mode.js';

export const APP_VERSION = '0.5.7';
export const platform = { local: localMode, native, os };

export const MOBILE_UNAVAILABLE = {
  folders: 'Phones have no shared music folder an app may scan. Use Import to copy music into OpenDJ (from the Files app, Downloads, a USB stick or a cloud drive).',
  lighting: 'Lighting control (DMX over Art-Net / sACN, OSC) needs UDP networking, which the mobile app cannot use yet.',
  link: 'Ableton Link needs UDP multicast on the local network, which the mobile app cannot use yet.',
  dvs: 'DVS (timecode vinyl) needs a multichannel audio interface with line inputs; planned for a later version.',
  midi: 'MIDI controllers need Web MIDI, which the iOS and Android WebViews do not offer; a native MIDI plugin is planned.',
  cdj: 'CDJ USB export (rekordbox device library) writes straight to a USB drive: use the desktop app. rekordbox XML export works here.',
  usbExport: 'Copying playlists to a USB drive needs the desktop app. Export M3U / rekordbox XML with the share sheet instead.',
  broadcast: 'Live streaming (Icecast, Shoutcast, RTMP) needs the desktop app or the OpenDJ server.',
  stems: 'AI stems need a 174 MB model and desktop-class CPU and memory: use the desktop app.',
  otherImports: 'Traktor, Serato and VirtualDJ import need the desktop app (their files point at folders on your computer). rekordbox XML and M3U playlists work here: tracks are matched to music you imported by file name.',
  login: 'The mobile app has no server and no login: everything stays on this device.',
  video: 'The video mixer and projector output need a second screen: use the desktop app.',
};

/** Why `feature` is not available here, or null when it is. */
export const unavailable = (feature) => (localMode ? MOBILE_UNAVAILABLE[feature] || null : null);

if (typeof document !== 'undefined') {
  const c = document.documentElement.classList;
  c.toggle('odj-local', localMode);
  c.toggle('odj-native', native);
  if (native) c.add(`odj-${os}`);
}
