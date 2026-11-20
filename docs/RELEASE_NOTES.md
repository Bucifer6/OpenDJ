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
| NAS / server | Docker: see *Run as a web app* in the README |

**First launch:**
- The builds are not code-signed yet.
- **Windows:** choose *More info → Run anyway*.
- **macOS:** right-click the app → *Open*.
- **Linux AppImage:** `chmod +x` the file, then run it.

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
  - 10 beat FX
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
