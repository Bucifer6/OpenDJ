# OpenDJ: guide for app reviewers

OpenDJ is a free, open-source (MIT) DJ app: two or four decks, a mixer with EQ, filter and effects, sync, cues,
loops, a sampler, automix and a music library. It mixes **music the user already has**: it sells nothing, streams
nothing and has no catalogue of its own. This guide walks through the main features in about ten minutes with the
**OpenDJ review pack**, six tracks that anyone may use freely.

- **No account, login, sign-up or network connection is needed.** Everything below works in airplane mode once the
  tracks are on the device. There are no ads, no in-app purchases, no subscriptions and no tracking.
- **The review pack** is `opendj-review-pack-<version>.zip`, attached to the GitHub release
  (<https://github.com/Bucifer6/OpenDJ/releases>) and to the store submission. It holds six MP3 files, `CREDITS.md`,
  this guide and `checksums.txt`. Every track is free of third-party rights: three original tracks made by the
  OpenDJ project (released as CC0) and three tracks whose Free Music Archive pages show **CC0 1.0** (public domain).
  See `CREDITS.md`.

| # | Track | Artist | BPM / key | Use it for |
|---|---|---|---|---|
| 1 | Open Circuit | OpenDJ Demo | 124, A minor (8A) | deck 1 |
| 2 | Iron Lattice | OpenDJ Demo | 128, E minor (9A) | deck 2: SYNC pulls it to 124 |
| 3 | Paper Lanterns | OpenDJ Demo | 100, C minor (5A) | a tempo change |
| 4 | After Party | Loyalty Freak Music | 120 | automix |
| 5 | Roller Fever | Loyalty Freak Music | about 114 | automix |
| 6 | Fire Place | HoliznaCC0 | about 110 | automix |

## 1. Install and import the tracks

### iOS / iPadOS

1. Install the build under review (TestFlight or App Review).
2. Put the six MP3 files on the device: open the zip in the **Files** app (tap it once to unzip it), AirDrop the
   MP3s, or save them to *iCloud Drive* or *On My iPhone*.
3. Open OpenDJ. The empty library shows **Import music**: tap it (or **+ Import** above the track list).
4. The **Files** picker opens. Go to the unzipped `tracks` folder, tap **Select**, select all six files and tap
   **Open**.
5. OpenDJ copies the files into its own storage and analyses them in the background (BPM, key, beat grid,
   waveform), a few seconds per track. The library then shows BPM and key for each track.

### Android

1. Install the build under review (Play internal testing, or the APK).
2. Copy the zip to the device (USB, a download, a cloud drive) and unzip it with *Files by Google* or any file
   manager. *Downloads* is fine.
3. Open OpenDJ and tap **Import music** (or **+ Import**). The system document picker opens. Go to the folder with
   the MP3s, long-press one file, select the other five, then tap **Select**.
4. OpenDJ copies them into app storage and analyses them. **No storage permission is requested**: the system picker
   gives access to the chosen files only.

### Desktop (Windows, macOS, Linux) and the web app

1. Install from <https://github.com/Bucifer6/OpenDJ/releases>, or run the web app (`npm run web`).
2. Unzip the pack. In OpenDJ, click **+ Folder** and pick the `tracks` folder, or drag the MP3s onto the library.
   Each track is analysed when it is first loaded.

## 2. A ten-minute tour

The steps are the same on every platform. On a **phone in portrait**, one deck is shown at a time: the **DECK 1 /
DECK 2** tabs above the deck switch between them, and both keep playing. Scroll down for the mixer, the sampler and
the library. Phones in landscape and tablets show both decks around the mixer.

1. **Load two decks.** In the library, double-tap **Open Circuit**: it loads on deck 1. Double-tap **Iron Lattice**:
   it loads on deck 2. (On the desktop you can also drag a track onto a deck, or right-click → *Load to deck 1*.)
2. **Play.** Press the green **play** button on deck 1. The waveforms scroll and the meters move.
3. **Sync.** Start deck 2, then press **SYNC** on deck 2. Its tempo goes from 128 to 124 BPM and its beats line up
   with deck 1: the beat grids of the two waveforms at the top line up.
4. **Mix with the crossfader.** In the mixer, drag the horizontal **crossfader** from the left (deck 1) to the right
   (deck 2). For a smoother blend, first turn deck 2's **LOW** EQ knob down, then swap the bass halfway through.
5. **Set a cue.** On deck 1, open the **CUES** panel and tap an empty pad (E–H). A hot cue is stored at the current
   position; tap the pad again to jump back to it. The analysis has already placed *Intro / Breakdown / Drop /
   Outro* cues on the first pads.
6. **Loop.** Open the **LOOPS** panel and tap the loop-size button (it shows **4**): the deck loops four beats in
   time with the music. **½** and **×2** change the length; **RELOOP** leaves the loop.
7. **Effects.** Open the **FX** panel, choose *Echo* (or *Reverb*, *Flanger*, *Phaser*, *Auto Filter*…) and tap
   **FX ON**. The **MIX** knob sets how much of the effect is heard.
8. **Sampler.** The purple **SAMPLER** pads (*Air Horn, Siren, Laser, Kick, Clap…*) play one-shot sounds over the
   mix; all of them are CC0 sounds bundled with the app. **SEQ** opens a step sequencer that plays the pads in time
   with the master deck.
9. **Automix.** Above the track list, tap **Automix view** (or the **AUTOMIX** button in the top bar). Choose an
   order (*Smart mix* orders by tempo and key) and tap **Start automix**. OpenDJ then mixes the tracks one into the
   next, with beat-matched transitions, on its own.
10. **Video / visualiser (desktop app only).** Click **VIDEO** in the top bar. The video panel shows an
    audio-reactive visualiser with each deck's cover art, mixed with the crossfader. The phone and tablet apps do
    not have the video mixer (it needs a second screen); there, the waveforms, meters and platters are the visuals.
11. **Record (optional).** **REC** records the master output to a file on the device. Recordings can be shared from
    the Recordings tab.
12. **Settings** (gear icon): themes and skins, audio output, deck options, automix defaults and the library. On
    mobile, the **Mobile** page explains which desktop features are not in the phone app, and why.

## 3. Permissions and why they are asked

| Permission | Platform | When it is asked | What it is for |
|---|---|---|---|
| Microphone | iOS (`NSMicrophoneUsageDescription`) | Only when the user turns on the **MIC** channel in the mixer (to talk over the mix as an MC) | The microphone is mixed into the master output. It is not stored or sent anywhere, unless the user records their own mix. Reviewers do not need it. |
| Local network | iOS (`NSLocalNetworkUsageDescription`) | Only when the user adds a media server on their home network (Plex, Jellyfin, Emby, Subsonic) | Browsing and streaming the user's own music server. Not needed for the review. |
| Notifications | Android 13+ (`POST_NOTIFICATIONS`) | When playback continues in the background | Android shows the media-playback notification of the foreground service that keeps the music playing with the screen off. |
| Foreground service (media playback), wake lock | Android | No prompt | Background playback while the screen is locked. |
| Internet | Android | No prompt | Only for the optional features under *Network use* below. |
| Files / storage | iOS and Android | Never | Music is imported through the system file picker, which gives access to the picked files only. |

The Android app does not declare the microphone permission (`RECORD_AUDIO`), so the MIC channel does not work there
and Android never asks for it.

## 4. Network use (none is required)

OpenDJ works fully offline. It goes online only for these optional features:

- **Update check:** at start-up and every 12 hours, the app asks GitHub (`api.github.com`) for the version of the
  latest OpenDJ release. The request carries no identifiers (only the user agent "OpenDJ/<version>"). It can be
  turned off in Settings → About.
- **Lyrics (off by default):** when the user turns on online lyrics or taps *Find online*, the artist, title, album
  and duration of that track are sent to LRCLIB (`lrclib.net`).
- **Media servers the user adds:** Plex (including the `plex.tv` sign-in, if the user signs in with a Plex account),
  Jellyfin, Emby, Subsonic / Navidrome and MediaMax. Credentials stay on the device.
- **Extra sampler sounds (on request):** choosing a sound in *Browse CC0 sound library* downloads that one CC0 file
  from `raw.githubusercontent.com`.
- **Skin updates (on request):** *Check for skin updates* fetches a small colour catalogue from
  `raw.githubusercontent.com`.

The desktop app also offers on-request downloads (an AI stems model, controller mappings) and connections that the
user sets up (streaming to their own Icecast / RTMP server, DMX lighting, Ableton Link, YouTube with the user's own
API key). None of these are in the mobile apps.

## 5. Text for the store forms

### App Store Connect: App Review Information → Notes

> OpenDJ is a free, open-source (MIT) DJ app for mixing music the user already owns. It has no account, no login,
> no in-app purchases, no ads and no tracking, and it works fully offline, so no demo account is needed.
>
> To test it, please use our review pack: six royalty-free tracks (three original tracks by the OpenDJ project and
> three CC0 tracks from the Free Music Archive), attached to this submission and also at
> https://github.com/Bucifer6/OpenDJ/releases (opendj-review-pack-VERSION.zip).
> 1. Unzip it in the Files app. 2. In OpenDJ, tap "Import music" and select the six MP3s in the Files picker.
> 3. Double-tap "Open Circuit" (it loads on deck 1) and "Iron Lattice" (deck 2), press play on both, press SYNC on
> deck 2 and move the crossfader. Cues, loops, effects (FX panel), the sampler pads and Automix are described step
> by step in REVIEWER_GUIDE.md inside the zip.
>
> Permissions: the microphone is only requested if you turn on the MIC channel (to talk over the mix), and local
> network access only if you add a home media server (Plex, Jellyfin, Emby, Subsonic). Neither is needed for the
> review. Background audio keeps a mix playing with the screen locked.
>
> The app only imports files the user picks in the system Files picker. It does not access the Apple Music library
> and does not stream from any music service.

### Google Play Console: App content → App access

Choose **"All functionality in my app is available without any access restrictions"**: that is true for OpenDJ. If
an instructions field is shown anyway (for example under *Testing instructions* for a closed test), paste:

> No login, account, subscription or payment is needed: every feature is available straight away. To try the DJ
> features you need some music on the device. Download our review pack (six royalty-free CC0 tracks) from
> https://github.com/Bucifer6/OpenDJ/releases (opendj-review-pack-VERSION.zip) and unzip it in Files / Downloads.
> In OpenDJ, tap "Import music" and select the MP3s in the system picker. Double-tap "Open Circuit" (deck 1) and
> "Iron Lattice" (deck 2), play both, press SYNC on deck 2 and move the crossfader. REVIEWER_GUIDE.md in the zip
> covers cues, loops, effects, the sampler and automix. No storage permission is requested; the notification
> permission is only used for the background-playback notification.

Replace `VERSION` with the release version (for example `0.4.2`).

## 6. About the review media

The screenshots and preview videos in `docs/store/` are recorded from OpenDJ's own UI playing the review-pack
tracks, and the video soundtrack is OpenDJ's own master output. Regenerate them with
`node scripts/review-pack/store-screenshots.mjs` and `node scripts/review-pack/store-video.mjs`, and the pack itself
with `node scripts/review-pack/build-review-pack.mjs`. Store sizes and their sources are in
[store/README.md](store/README.md); the listing text and privacy answers are in [store/LISTING.md](store/LISTING.md).
