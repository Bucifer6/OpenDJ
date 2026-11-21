# OpenDJ privacy policy (draft)

*Draft for the App Store and Google Play listings. The maintainer should review it, add a contact address and
publish it at a stable URL before submitting.*

**Summary: OpenDJ does not collect, store or share any personal data. It has no accounts, no analytics, no ads and
no tracking.**

## What stays on your device

Your music, library, playlists, cue points, analysis results, recordings, settings and any media-server credentials
are stored only on your device, inside the app's own storage. The developers never receive them. Removing the app
removes them.

## When OpenDJ goes online

OpenDJ works offline. It connects to the internet only for these features:

- **Update check** (on by default, can be turned off in Settings → About): the app asks GitHub
  (`api.github.com`) for the latest OpenDJ version at start-up and every 12 hours. The request contains no
  information about you, your music or your settings. GitHub's privacy statement applies to that request.
- **Online lyrics** (off by default): if you turn it on or tap *Find online*, the artist, title, album and duration
  of the track are sent to LRCLIB (`lrclib.net`) to find lyrics.
- **Media servers you add** (Plex, Jellyfin, Emby, Subsonic / Navidrome, MediaMax): the app talks to the servers you
  enter, with the credentials you enter, to browse and play your music. Signing in with a Plex account contacts
  `plex.tv`.
- **Downloads you ask for**: extra CC0 sampler sounds and skin updates are downloaded from GitHub
  (`raw.githubusercontent.com`) when you choose them.

## Permissions

- **Microphone** (iOS, only if you turn on the mixer's MIC channel): your voice is mixed into the music output.
  It is not stored or sent anywhere unless you record your own mix.
- **Local network** (iOS, only if you add a media server on your network).
- **Notifications** (Android): the playback notification while music plays in the background.

## Children

OpenDJ does not knowingly collect data from anyone, including children.

## Changes and contact

Changes to this policy are published in the OpenDJ repository: https://github.com/Bucifer6/OpenDJ. Questions:
open an issue at https://github.com/Bucifer6/OpenDJ/issues, or write to the address given on the store listing.
