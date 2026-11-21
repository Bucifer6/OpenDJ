## OpenDJ — free, open-source DJ software

Mix on 2 or 4 decks with your own music from local folders, USB sticks, NAS shares and your Plex, Jellyfin, Emby, Subsonic/Navidrome or MediaMax server. OpenDJ runs as a desktop app on Windows, macOS and Linux, or as a self-hosted web app.

### Download
| System | File |
|---|---|
| Windows 10/11 (most PCs) | `OpenDJ-Setup-<version>-x64.exe`, or `OpenDJ-Portable-<version>.exe` (no install) |
| Windows on ARM | `OpenDJ-Setup-<version>-arm64.exe` |
| macOS, Apple Silicon (M1–M4) | `OpenDJ-<version>-mac-arm64.dmg` |
| macOS, Intel | `OpenDJ-<version>-mac-x64.dmg` |
| Linux, any distro | `OpenDJ-<version>-linux-x86_64.AppImage` (or `-arm64.AppImage`) |
| Debian / Ubuntu / Mint | `OpenDJ-<version>-linux-amd64.deb` (or `-arm64.deb`) |
| Fedora / openSUSE | `OpenDJ-<version>-linux-x86_64.rpm` (when present) |
| Android phone / tablet | `OpenDJ-<version>-android-debug-signed.apk` (test build, see below) |
| NAS / server | Docker: see *Run as a web app* in the README |

**First launch:**
- The builds are not code-signed yet.
- **Windows:** choose *More info → Run anyway*.
- **macOS:** right-click the app → *Open*.
- **Linux AppImage:** `chmod +x` the file, then run it.

**Check your download:** `SHA256SUMS.txt` lists the checksum of every file (`sha256sum -c SHA256SUMS.txt --ignore-missing`). Security problems: please report them privately, see `SECURITY.md`.

### New in 0.4.1

- Smoother controls and waveforms under background load, including deferred waveform rendering and background library filtering.
- Smarter Automix start points, phrase-aware track selection, and transition profiles with per-mix EQ presets.
- Fixed the Windows portable app's one-click AI stems setup.
- Added in-app skin updates from Settings → Appearance, so new skins can be installed without a full app release.

### New in 0.4
**Phone and tablet app (preview)**
- OpenDJ now runs as a standalone app on Android and iOS: no computer or server needed.
- Import music from your files, then mix on 1–2 decks (phones) or 2–4 decks (tablets) with sync, hot cues, loops, effects, sampler and automix.
- Playlists, smart playlists, rekordbox XML / M3U, recording, and Plex / Jellyfin / Emby / Subsonic / MediaMax with offline downloads all work on the device.
- **Android:** install the attached `.apk`. It's a test build, so allow installing from your browser or file manager when asked. Store releases follow.
- **iPhone / iPad:** TestFlight and App Store builds follow once signing is set up.
- **Not on phones yet:** MIDI controllers, DVS, lighting, Ableton Link, broadcasting, CDJ USB export and AI stems.

**New look, inspired by djay Pro**
- **Calmer decks:** Cues / Loops / FX / Stems / Key panels, plus big pads.
- **Layout modes:** Classic, Perform, Waves and 4 Decks.
- **Waveforms:** larger and sharper, scrolling smoothly at 60 fps.
- **New controls:** knobs, faders, meters and platters, with real icons and fonts.
- **Library:** filter chips (key match, BPM ±6 %, genre), a "Next" suggestion strip, and an artwork view.
- **Smoother everywhere:** steady 60 fps for 2 and 4 decks, no freeze when loading a track, smooth scrolling through big libraries. Fits windows down to 1024 px, and tablets get their own layout.

**Pro-sounding effects**
- **Echo:** exact to the beat, with dub-style repeats.
- **New reverb.**
- **Stereo flanger / phaser / chorus,** locked to the beat.
- **Second effect knob (P2)** for each effect.
- **Tails ring out after the fader closes,** so echo-outs work.
- **Isolator EQ** with true kills.
- **Resonant filter.**
- **Clean limiter.**
- **Turntable-style brake and backspin.**
- **No clicks** on play, cue jumps, loops, nudges or key-lock tempo changes.

**Sampler**
- A new bank of 12 real DJ sounds, including a proper air horn and the classic "ba-ba-baaah".
- Pick a sound or load your own sample per pad.
- Pad volume and sync-to-beat.

**Automix and smart mix**
- **10 transition styles:** Smooth blend, Bass swap, Crossfade, Filter sweep, Echo out, Cut, Backspin, Vinyl brake, Loop out and Reverb wash.
- **Auto** picks one for each pair of tracks and shows why.
- **Smart mix** orders tracks by key, BPM, energy flow and genre, and explains each choice. Shuffle & mix is there too.
- **QUEUE panel** with a countdown and per-transition style overrides.
- **Loading tracks yourself** while automix runs now works: your pick plays next.

**Media-server playlists**
- Your Plex, Jellyfin, Emby, Subsonic and MediaMax playlists appear in the library.
- Open, automix, shuffle-mix, smart-mix, import or download them.

**Fixes**
- The tempo fader stays within its range.
- Automix no longer bends tempo across big BPM gaps.
- Loop ½ / ×2 work after exiting a loop.
- The Echo Out pad restores your effect.
- Load progress is shown for long tracks.
- Many smaller layout and touch fixes.

**Update prompt**
- OpenDJ tells you when a newer version is out, with *What's new* and **Update now** / **Later** (Later waits 3 days; never during a set). Windows and Linux AppImage download, verify (SHA-256) and install after "Restart to update"; macOS opens the verified disk image; phones, packages and servers get the right download or instructions. Settings → About: turn automatic checks off or *Check now*.

### New in 0.3
This release follows a full security audit, an in-depth QA pass and end-to-end testing with six kinds of users.

**New**
- **Automatic library analysis:** new tracks get BPM, beat grid, key, energy and waveforms in the background, with progress shown in the library ("Analysing 12 / 2,000", stoppable). `bpm:`/`key:` search and smart playlists work straight after adding music. Also *⋯ Library → Analyse all tracks*.
- **Playlists:** shown in their own order with a `#` column; drag rows to reorder.
- **Phones and tablets:** narrow screens show one deck at a time with deck tabs.
- **Automix** eases each track back to its original tempo after the transition (can be turned off).
- **First launch:** an empty library now explains how to add music.
- **Web app:** Sign out in the top bar; uploading the same file twice no longer duplicates it; rejected files are listed.

**Security** (please update if you run the web app)
- Backup restore can no longer reach files outside the allowed music folders.
- Login requests are size-limited, rate limiting can't be bypassed through proxy headers, and passwords are checked without blocking the server.
- Setting `OPENDJ_PASSWORD`, `OPENDJ_TRUST_PROXY` or `OPENDJ_ALLOWED_HOSTS` now always turns the login on, so the reverse-proxy setup in the README is password-protected.
- `OPENDJ_PASSWORD` must be at least 8 characters and not an example value; the Docker Compose file no longer ships a password.
- Saved media-server passwords, stream keys and the Hue key are only reused for the same server; pointing an entry somewhere else asks for the secret again.
- Album art and proxied media can no longer run script in the app; the app can't be embedded in other sites.
- The desktop app's built-in server now only answers its own window (per-launch key), and all its windows are locked down.
- Library files are private to your user account on disk; the bundled FFmpeg and Docker base image are checksum-pinned; release files come with SHA-256 checksums.
- Custom AI-stems model URLs need their SHA-256 checksum.

**Fixes**
- Loud tracks no longer distort with the memory-saving 16-bit decks.
- Imported rekordbox / Traktor / VirtualDJ beat grids are kept; re-importing no longer wipes your cues or ratings; import errors say what went wrong.
- Hot-cue pads and the FX unit fit on laptop screens; the 4-deck mixer is no longer clipped; right-click menus open in the right place at any interface size.
- One bad setting can no longer stop the app from starting (all settings are validated).
- The desktop app asks before quitting while decks are playing or a recording runs.
- No fake "Drop" cue at the start of every track; silence and steady tones no longer get a BPM.
- Unreadable files are marked ⚠ and keep their name when a load fails.
- Loop sizes, reverse inside loops, same-minute recordings, the LIVE/ON AIR state, key search, Most played order, Daylight theme contrast, MP3 lyrics written by FFmpeg, and many smaller fixes.

**Heads-up:** Node.js 22 or newer is now required to run from source. Subsonic servers that need the old password login have a new *Legacy password auth* checkbox.

### New in 0.2
- **AI stems:** right-click a track → *Prepare AI stems*. Decks get vocals/drums/bass/melody mute and level, acapella, instrumental and vocal echo. The model (HT-Demucs, ~98 MB) downloads on first use after you agree.
- **Recording straight to disk:** WAV, FLAC, MP3, AAC or Opus, with no memory limit. Auto-split option, plus `.cue`/`.txt` tracklists.
- **Live broadcasting:** stream to Icecast, Shoutcast or RTMP (Twitch, YouTube, Mixcloud) with now-playing titles.
- **Export to CDJ USB:** writes a rekordbox device library (beat grids, cues, loops, colours, waveforms) for Pioneer CDJ/XDJ players.
- **DVS:** control decks with Serato or Traktor timecode vinyl/CDs (*Settings → DVS*).
- **Ableton Link:** follow or lead the session tempo with bar-phase lock.
- **Lyrics & karaoke:** lyric line under each deck, karaoke mode, karaoke layer in the video output, sync editor.
- **Lower memory use:** loaded tracks use half the RAM. 32-bit audio is optional.
- **Fixes:** controller panel and settings polish; Link follow/lead race fixed.

**Please test on real gear:** DVS absolute mode, CDJ export on a player, and Link with Ableton Live haven't been verified on hardware yet. Feedback is very welcome.

### Highlights
- **Decks:**
  - key lock (WSOLA), key shift and Key Sync
  - sync with phase meter
  - CDJ-style cue, 8 hot cues, saved loops, loop roll, slicer, Pitch Play
  - beat jump, slip, reverse, censor, instant doubles
  - 3-band waveforms with phrase markers
- **Mixer:**
  - 3-band EQ with kill, filter
  - Color FX (Space, Dub Echo, Noise, Crush, Jet) and quick vocal/instrumental stems
  - 10 beat FX, with post-fader echo / reverb tails (echo-outs)
  - crossfader curves, master limiter
  - mic input with talkover
  - headphone cue via a second sound card, 4-channel interface or split mode
- **Library:**
  - automatic BPM, key (Camelot), energy and phrase analysis with auto cues
  - smart playlists, colours/tags, history and setlist export, duplicate finder, missing-file relocate
  - import from rekordbox, Traktor, Serato and VirtualDJ; export rekordbox XML, M3U or to USB
  - plays almost any format: native + FFmpeg conversion for ALAC, WMA, APE, WavPack, DSD, AC3/DTS and more
- **Media servers:** stream from or download for offline use from Plex, Jellyfin, Emby, Subsonic/Navidrome and MediaMax (including its DJ analysis).
- **Automix:**
  - phrase-aware, beat-matched transitions
  - energy-curve ordering
  - automatic key-clash fixing
- **Performance:**
  - 8-pad sampler with a 16-step sequencer synced to the master deck
  - mix recording
  - MIDI clock out
- **Controllers:**
  - MIDI Learn with 14-bit, relative and LED feedback
  - import of Mixxx community mappings (hundreds of controllers), with online search
  - guided mapping wizard, generic HID and gamepads
- **Lighting:** automatic beat- and phrase-synced shows over Art-Net, sACN, USB DMX, WLED, Philips Hue and OSC.
- **Video:**
  - music videos synced to the decks, visualizer, transitions and FX, overlays
  - projector / second-screen output
  - YouTube visuals via the official player
- **Web app:** password-protected hosted mode, browser uploads, installable PWA, Docker image.
- **Themes:** 9 themes including Daylight and High Contrast, plus an interface-size setting.

See `docs/GAP_ANALYSIS.md` for a feature-by-feature comparison with rekordbox, Serato, Traktor, VirtualDJ and djay Pro.
