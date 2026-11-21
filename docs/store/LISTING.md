# Store listing draft (App Store and Google Play)

Draft copy for App Store Connect and the Play Console. Character limits are noted next to each field; counts were
checked when this was written. The copy avoids the names and trademarks of other DJ products and of hardware makers.

## Names

| Field | Store | Limit | Text | Length |
|---|---|---|---|---|
| App name | App Store | 30 | `OpenDJ – DJ Mixer` | 17 |
| App name | Google Play | 30 | `OpenDJ – DJ Mixer` | 17 |
| Subtitle | App Store | 30 | `Mix your own music, free` | 24 |
| Short description | Google Play | 80 | `Free, open-source DJ app: two decks, sync, effects, sampler and automix.` | 72 |

Alternative subtitles: `Free open-source DJ decks` (25), `Decks, sync, FX and automix` (27).

## App Store: promotional text (170, can change without a new version)

> Free and open source, with no account, ads or tracking. Load two decks, sync the beats, add effects and loops, or
> let automix play a set for you.

(145 characters)

## App Store: keywords (100, comma-separated, no spaces needed)

```
dj,mixer,decks,turntable,beatmatch,bpm,crossfader,automix,sampler,loop,cue,remix,party,music,offline
```

(100 characters.) Do not add other apps' or companies' names: Apple rejects keywords with trademarks of others
(App Review Guideline 2.3.7), and the copy stays free of them.

## Description (App Store 4,000; Google Play full description 4,000)

> OpenDJ is a free, open-source DJ app. Mix the music you already have on two or four decks, with the same tools
> you find on a club setup, and no account, ads, subscriptions or tracking.
>
> **Decks and mixing**
> • Two decks on phones (four on tablets), with scrolling waveforms, jog wheels and pitch faders
> • SYNC and beat-matched tempo, key lock, quantise
> • 3-band EQ, filter, gain and a smooth crossfader with selectable curves
> • Hot cues, auto-placed intro / drop / outro cues, beat loops, loop rolls and beat jumps
>
> **Effects and performance**
> • Echo, ping-pong, reverb, flanger, phaser, chorus, auto filter, transform, bit crusher, distortion and more
> • Pad modes: hot cue, roll, slicer, beat jump, pitch play, sampler
> • A sampler with CC0 one-shots and a step sequencer synced to the beat
>
> **Automix**
> • Let OpenDJ play a set: smart ordering by tempo, key and energy, beat-matched transitions at musical phrases
>
> **Your library**
> • Import MP3, AAC / M4A, WAV, AIFF and FLAC from the Files app, iCloud Drive, USB drives or cloud storage
> • Automatic BPM, key (Camelot), beat grid and waveform analysis on the device
> • Playlists, smart playlists, ratings, colours, history
> • Stream or download from your own media server: Plex, Jellyfin, Emby, Subsonic / Navidrome
> • Import playlists, cues and grids from rekordbox XML or M3U files exported on a computer
>
> **Record and share**
> • Record your mix and share it with the share sheet
>
> **Private by design**
> • No account and no login. Your music and library stay on your device.
> • Works fully offline. No ads, no analytics, no tracking.
>
> **Free and open source**
> OpenDJ is MIT-licensed and developed in the open. The desktop app (Windows, macOS, Linux) adds DJ controllers, a
> video mixer, lighting control and live streaming. Source code, issues and releases:
> https://github.com/Bucifer6/OpenDJ

Notes:
- *rekordbox* is a product name of AlphaTheta. It is used here only to name a file format the app imports; if a
  reviewer objects, replace it with "DJ library XML". Plex, Jellyfin, Emby and Subsonic are named for
  compatibility only (nominative use). Drop them if the store asks.
- "Four decks on tablets" matches docs/MOBILE.md (tablets use the 2/4-deck desktop layout).

## Category and rating

| | App Store | Google Play |
|---|---|---|
| Primary category | Music | Music & Audio |
| Secondary category (optional) | Entertainment | (none) |
| Age rating answers | None of the content descriptors apply (no violence, no sexual content, no profanity, no gambling, no drugs, no horror). Unrestricted web access: **No** (the app has no browser; it only links out). User-generated content shared with others: **No**. Result: **4+**. | IARC questionnaire: category "Music & Audio / Utility"; no violence, sexuality, language, controlled substances or gambling; **no** user-to-user communication or sharing between users; **no** location sharing; **no** purchases of digital goods. Expected rating: **Everyone / PEGI 3 / USK 0**. |

Hints: the app plays music the user imports, so the store asks nothing about lyrics content. Optional lyrics come
from LRCLIB only when the user turns them on; this does not change the questionnaire answers because the app does
not curate or supply music. Answer "no" to "Does the app contain or stream music from a catalogue?" if asked.

## URLs

| Field | URL |
|---|---|
| Support URL (required by Apple) | https://github.com/Bucifer6/OpenDJ/issues |
| Marketing URL (optional) | https://github.com/Bucifer6/OpenDJ |
| Privacy policy URL (required by both) | https://github.com/Bucifer6/OpenDJ/blob/main/docs/store/PRIVACY.md is suggested; a privacy policy page has to exist before submission (see *What the owner must do* in docs/store/README.md) |
| Google Play contact email | the maintainer's public project address (required by Play; it is shown publicly) |

## Privacy answers

Findings from the code (branch `review-work`, version 0.4.2). Everything below is about the **mobile apps**; desktop
differences are noted.

### Every network call the app can make

| What | Host | When | Data sent | Default |
|---|---|---|---|---|
| Update check | `api.github.com` (`GET /repos/Bucifer6/OpenDJ/releases/latest`) | At start-up and every 12 h (`public/js/shared/update-core.js`, `public/js/local/backend.js`) | No identifiers: user agent `OpenDJ/<version>` on native, `If-None-Match` ETag; the IP address reaches GitHub as with any request | **On**, opt-out in Settings → About (`updateCheck`) |
| "Update now" link | `apps.apple.com` / `play.google.com` / `github.com` | When the user taps it | Opens the store or release page outside the app | Store builds must be synced with `OPENDJ_UPDATE_CHANNEL=appstore` (iOS) or `play` (Android): the default `github` channel makes Android open the APK download, which Google Play does not allow for Play builds |
| Lyrics | `lrclib.net` | Only with *Online lookups (LRCLIB)* turned on, or *Find online* | Artist, title, album, duration of the track | **Off** (`LYRICS_DEFAULTS.online = false`) |
| Media servers | The user's own server; `plex.tv` for Plex sign-in | Only after the user adds a server | The user's credentials / token to that server only (kept in app storage, never in backups) | Off until added |
| CC0 sampler sounds | `raw.githubusercontent.com` (pinned Sonic Pi commit) | When the user picks a sound in *Browse CC0 sound library* | Nothing beyond the file request | On request |
| Skin catalogue | `raw.githubusercontent.com` (`public/skins/catalog.json`) | When the user taps *Check for skin updates* | Nothing beyond the file request (`credentials: 'omit'`, no referrer) | On request |
| Desktop only | `registry.npmjs.org` (stems model), `api.github.com` + `raw.githubusercontent.com` (controller mappings), `github.com` (desktop updater downloads), `youtube.com` / `googleapis.com` (video mixer, user's own API key), `discovery.meethue.com` (lighting), the user's streaming servers, local Ollama | On request / when configured | — | Not in the mobile apps (features hidden in `public/js/platform.js`) |

There is **no analytics, crash reporting, advertising SDK, account system or remote logging** anywhere in the code.

### Apple: App Privacy ("nutrition label")

- **Data collection: "No, we do not collect data from this app."**
  Rationale (Apple's definitions): "collect" means transmitting data off the device in a way that lets the developer
  or its partners access it beyond what is needed to serve the request in real time. OpenDJ sends nothing to the
  developer. The update check sends no data beyond a standard request to GitHub. LRCLIB lookups (off by default)
  send track metadata to a third-party service the user chooses to use, in real time, and are not linked to the user
  or stored by the developer. Media-server connections go to servers the user runs or chooses. Apple's guidance
  treats data sent only to a service the user chooses to connect to as not collected by the developer; if in doubt,
  the conservative alternative is to declare **"Other User Content → App Functionality, not linked, no tracking"**
  for the optional lyrics lookup.
- **Tracking:** No. The app does not use the App Tracking Transparency prompt and needs none.
- **Privacy manifest (`PrivacyInfo.xcprivacy`):** check the Xcode archive for required-reason APIs used by
  Capacitor and its plugins (UserDefaults / file timestamp APIs). Capacitor 8 plugins ship their own manifests;
  verify the app target's manifest declares `NSPrivacyTracking = false` and no collected data types.

### Google Play: Data safety

- **Does your app collect or share any of the required user data types?** **No.**
  Rationale (Play's definitions): data processed only on the device is not "collected"; data sent off the device
  only to fulfil a user's request in real time to a service they chose is generally exempt as ephemeral processing,
  and nothing reaches the developer. The update check sends no user data.
- **Is all of the user data collected by your app encrypted in transit?** Not applicable when nothing is collected;
  if the form insists: Yes for GitHub and LRCLIB (HTTPS); media servers on the local network may use plain HTTP at the
  user's choice (Android allows cleartext for them), which is why the conservative answer is to declare nothing
  collected rather than claim "all encrypted".
- **Do you provide a way for users to request that their data be deleted?** Not applicable (no data held by the
  developer). Users delete their data by removing the app or using Settings → Library.
- **Account creation:** the app has no accounts.

### Permissions to justify in the Play Console

- `FOREGROUND_SERVICE_MEDIA_PLAYBACK`: the Play Console asks for a declaration and a short video for foreground
  service types. Answer: *Media playback: continues the user's DJ mix with the screen off*. A screen recording of the
  notification while a mix plays with the screen locked satisfies it (record on a device).
- `POST_NOTIFICATIONS`: the media-playback notification.
- No sensitive permissions (no storage, location, contacts, camera or microphone).
