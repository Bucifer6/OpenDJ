# OpenDJ

**Free, open-source DJ software.** Two or four decks, a full mixer, beat-synced effects, a sampler, auto-mix and MIDI controller support. Your library can come from local folders, USB sticks, NAS shares, or your **Plex, Jellyfin, Emby, Subsonic/Navidrome and MediaMax** servers. Stream from them or download tracks for offline gigs.

Runs as a desktop app (Windows, macOS, Linux via Electron) or in Chrome/Edge.

## Features

### Decks
- 2 or 4 decks, sample-accurate AudioWorklet playback engine
- **Key lock** (master tempo), tempo ranges ±6/8/10/16/25/50/100 %, pitch bend, nudge
- **Sync** (tempo + phase, half/double-time aware) with master deck
- CDJ-style **cue** (set / return / hold-to-preview)
- 8 **hot cues** per deck (colour coded, saved with the track), memory cues
- **Loops**: auto beat loops (⅛ to 64 beats), loop in/out, reloop, halve/double, **loop roll**
- **Beat jump**, quantize, **slip mode**, reverse, censor
- Jog wheels: scratch (vinyl mode) or nudge (outer ring), with motor brake and **backspin**
- Scrolling 3-band colour waveforms with beat grid, cue and loop markers, plus a full-track overview
- **Beat grid editor**: tap tempo, ×2/÷2, shift grid, set downbeat, lock BPM

### Mixer
- Per channel: trim, 3-band isolator-style EQ (with full kill), one-knob low/high-pass filter, headphone cue, fader and VU meter
- Crossfader with A/THRU/B assign and smooth/linear/scratch curves
- Master volume with limiter, headphone cue/master blend and volume
- **Headphone cueing** three ways:
  - a separate sound card
  - channels 3-4 of a 4-channel controller interface
  - split cue on a single stereo jack
- Auto-gain level matching

### Effects & sampler
- Per-channel beat-synced FX: Echo, Ping Pong, Reverb, Flanger, Phaser, Auto Filter, Trans (gate), Bit Crusher, Distortion, Noise Sweep
- Pad FX: vinyl brake, tape stop, backspin, censor, echo out, filter sweep, loop rolls
- 8-slot sampler with synthesised built-in sounds (air horn, siren, riser…). Right-click a slot to load your own sample.
- **Mix recording** to WAV

### Library
- Folders on any drive. **USB sticks and NAS shares (SMB/NFS/AFP/SSHFS mounts) are detected automatically**: one click adds and scans them.
- **Media servers**:
  - Plex
  - Jellyfin
  - Emby
  - Subsonic-compatible (Navidrome, Airsonic, Gonic…)
  - **MediaMax**: also imports its DJ-mode BPM, key and energy analysis
- Remote playlists are imported; tracks stream through a local proxy with seeking support.
- **Download** any remote track, playlist or entire server to a local folder for offline use.
- Automatic analysis: BPM + beat grid, musical key (Camelot), energy, loudness, silence trimming. Results are cached.
- Playlists (with folders), drag & drop, ratings, play history, smart views:
  - recently added
  - most played
  - **tracks matching the master deck** (harmonic key + tempo)
- Search with filters: `bpm:120-128`, `key:8A`, `genre:house`
- Import **rekordbox XML** (cues, grids, playlists) and **M3U**
- Export to rekordbox XML and M3U8, or **export playlists to a USB stick**
- AIFF support (converted on the fly)

### Auto-mix
- Non-stop mixing of any playlist or library view on decks 1 & 2
- Beat-matched, phrase-aligned transitions: EQ bass-swap, crossfade, filter fade or echo-out
- Optional **smart ordering** by harmonic key, tempo and energy; skip-to-next; queue tracks from the browser

### Controllers
- Any class-compliant **MIDI controller** via Web MIDI
- **MIDI Learn** for every function, including:
  - 14-bit faders
  - relative jog wheels and encoders
  - **LED feedback**
  - a shift layer
- Mappings auto-load per device and can be exported and imported as JSON
- Includes a best-effort Pioneer DDJ-400 / DDJ-FLX4 preset. If a control doesn't respond, fix it with Learn.

## Getting started

Requires **Node.js 20+**.

```bash
npm install
```

Desktop app:

```bash
npm start
```

Browser mode: start the server below, then open http://localhost:7380 in Chrome or Edge.

```bash
npm run web
```

Build installers (Windows `.exe`, macOS `.dmg`, Linux AppImage/`.deb`):

```bash
npm run dist
```

### Adding music
- **Folders, USB and NAS**: in the browser's left panel, click a detected drive or use **+ Folder**. NAS shares must be mounted by your OS first:
  - Windows: map a network drive or use `\\nas\music`
  - macOS: Finder → Go → Connect to Server
  - Linux: an SMB/NFS mount
- **Media servers**: click **+ Media server** and pick the type.
  - Plex: server URL plus an X-Plex-Token, or your plex.tv login.
  - Jellyfin, Emby, Subsonic: URL, username and password.
  - MediaMax: URL plus username and password, or an API key (`mmk_…`).
  - Passwords are exchanged for a token where the server supports it.
- **rekordbox users**: in rekordbox, use *File → Export Collection in xml format*, then go to OpenDJ *Settings → Library → Import rekordbox XML*.

### Keyboard shortcuts
| Keys | Action |
|---|---|
| Space | Play/pause deck 1 |
| Z / X / C | Deck 1 cue / play / sync |
| M / , / . | Deck 2 cue / play / sync |
| 1–4, 7–0 | Hot cues A–D on deck 1 / deck 2 (hold Shift to delete) |
| Q / W, O / P | Loop 4 beats / exit, deck 1 / deck 2 |
| ← / → | Crossfader |
| ↑ / ↓ | Browse tracks |
| Shift + ← / → | Load to deck 1 / 2 |
| R | Record |
| A | Automix |
| Ctrl+F | Search |

## Architecture

```
electron/           desktop shell (starts the server, native folder picker, MIDI/audio permissions)
server/             Node backend, bound to 127.0.0.1 only
  index.js            HTTP API + static UI + server-sent events
  library.js          JSON library store (tracks, playlists, folders, sources, settings)
  scanner.js          folder scanning + tag reading (music-metadata)
  drives.js           USB / NAS / drive detection
  remote.js           media-server sync, streaming proxy, download manager
  sources/            Plex, Jellyfin, Emby, Subsonic, MediaMax clients
  rekordbox.js m3u.js aiff.js
public/             UI (vanilla ES modules, no build step)
  js/audio/           engine (mixer graph, routing, recorder), deck, AudioWorklets, effects, sampler, analysis
  js/ui/              deck, mixer, waveform, library, dialogs, controls
  js/midi/            MIDI learn/mapping engine + presets
  js/automix.js
```

Library data lives in your OS app-data folder (`%APPDATA%\OpenDJ`, `~/Library/Application Support/OpenDJ`, `~/.config/opendj`), or in `OPENDJ_DATA` if set.

## Tests

Unit tests (analysis, the media-server clients against mock servers, rekordbox round trip):

```bash
npm test
```

End-to-end check in headless Chromium (scan → load → analyse → play → sync → FX → record → automix):

```bash
npm run test:e2e
```

## Licence
MIT
