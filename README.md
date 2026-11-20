# OpenDJ

**Free, open-source DJ software.** Two or four decks, a full mixer, beat-synced effects, a sampler, auto-mix and MIDI controller support. Your library can come from local folders, USB sticks, NAS shares, or your **Plex, Jellyfin, Emby, Subsonic/Navidrome and MediaMax** servers. Stream from them or download tracks for offline gigs.

Runs as a desktop app (Windows, macOS, Linux via Electron) or in Chrome/Edge.

## Features

### Decks
- 2 or 4 decks, sample-accurate AudioWorklet playback engine
- **Key lock** (master tempo) using WSOLA time-stretching; tempo ranges ±6/8/10/16/25/50/100 %, pitch bend, nudge
- **Key shift** (±12 semitones) and **Key Sync**: shifts to the nearest harmonically compatible key of the master deck
- **Phase meter**, phase-locked (quantized) hot cue jumps, and **instant doubles** (drag a deck header onto another deck)
- **Sync** (tempo + phase, half/double-time aware) with master deck
- CDJ-style **cue** (set / return / hold-to-preview)
- 8 **hot cues** per deck (colour coded, saved with the track), memory cues, and **saved loops**: press an empty hot cue pad while a loop is active, or press MEM
- Pad modes: Hot Cue, Roll, **Slicer**, Beat Jump, **Pitch Play** (play a hot cue at different pitches), Sampler, Pad FX
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

### Effects, stems & sampler
- **Color FX** on the filter knob: Filter, Space, Dub Echo, Noise, Crush, Jet
- **Quick stems**: VOC / INST knobs per channel. This is DSP mid/side vocal isolation, not AI separation (see docs/GAP_ANALYSIS.md).
- **Step sequencer**: 16 steps × 8 sampler sounds, locked to the master deck's beat grid, with swing
- **Microphone / aux input** with EQ, compressor and **talkover** ducking
- **MIDI clock out**, phase-locked to the master deck (drives drum machines, lighting software and DAWs)
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

### Lighting
Lights follow the music automatically. The show changes with each phrase:
- **intro**: colour wash
- **build-up**: accelerating chase
- **drop**: full chase with strobe accents
- **breakdown**: dim fade

Colours come from the track's key or energy.

Outputs:
- **Art-Net** and **sACN (E1.31)** for DMX nodes and lighting desks
- **USB DMX** with Enttec DMX USB Pro-compatible widgets
- **WLED** LED strips
- **Philips Hue**
- **OSC** for QLC+, Resolume, TouchDesigner and similar
- **MIDI** notes and MIDI clock

You can patch fixtures from templates. Live pads cover blackout, strobe, full, freeze, colour, intensity and speed. Open the panel with **💡 LIGHTS** in the top bar.

### Themes
Nine themes in *Settings → Appearance*:
- Midnight, Graphite, Club Red, Neon, Ocean, Black & Gold, Forest
- **Daylight**, a light theme for outdoor gigs
- **High Contrast**

You can also set a custom accent colour and scale the interface from 80% to 150% for laptops or touchscreens.

### Controllers
- Any class-compliant **MIDI controller** via Web MIDI
- **MIDI Learn** for every function, including:
  - 14-bit faders
  - relative jog wheels and encoders
  - **LED feedback**
  - a shift layer
- Mappings auto-load per device and can be exported and imported as JSON
- Includes a best-effort Pioneer DDJ-400 / DDJ-FLX4 preset. If a control doesn't respond, fix it with Learn.

## How OpenDJ compares
See **[docs/GAP_ANALYSIS.md](docs/GAP_ANALYSIS.md)** for a feature-by-feature comparison with rekordbox, Serato, Traktor, VirtualDJ, djay Pro and Engine DJ. It also lists what is still missing and why.

## Download & install

| Platform | Files | Notes |
|---|---|---|
| **Windows 10/11** (x64, ARM64) | `OpenDJ-Setup-<version>-x64.exe` (installer), `OpenDJ-Portable-<version>.exe` (no install) | Unsigned build: on the SmartScreen prompt choose *More info → Run anyway* |
| **macOS 11+** (Apple Silicon & Intel) | `OpenDJ-<version>-mac-arm64.dmg` / `-x64.dmg` | Unsigned build: the first time, right-click the app → *Open* (or *System Settings → Privacy & Security → Open Anyway*) |
| **Linux** (x64, ARM64) | `.AppImage` (any distro), `.deb` (Debian/Ubuntu/Mint), `.rpm` (Fedora/openSUSE, x64), `.tar.gz` | AppImage: `chmod +x OpenDJ-*.AppImage` and run it |
| **ChromeOS / any OS with Chrome or Edge** | Browser mode | Run `npm run web` on a computer and open it in Chrome or Edge; you can install it as an app from the address bar |

Installers are built automatically by GitHub Actions (`.github/workflows/build.yml`) on Windows, macOS and Linux. Push a tag like `v0.2.0` to publish them as a GitHub Release. You can also download them from the run's *Artifacts* on any branch build.

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

Build installers for the computer you're on. Windows and macOS installers must be built on those systems; CI does that for you:

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

## Supported formats

| | Formats | Needs |
|---|---|---|
| **Played directly** | MP3, AAC/M4A, FLAC, WAV, Ogg Vorbis, Opus, WebM, AIFF (converted to WAV on the fly) | nothing |
| **Converted on the fly** | ALAC (Apple Lossless `.m4a`), WMA, APE (Monkey's Audio), WavPack (`.wv`), DSD (`.dsf`/`.dff`), AC3/E-AC3, DTS, MP2, AMR, TTA, TAK, Musepack, Speex, MKA, AU/SND, CAF, AIFF-C (compressed), W64/RF64, 3GP | FFmpeg |
| **Video files** (audio track for the decks, picture for video mixing) | MP4, M4V, MOV, WebM play as is; MKV, AVI, WMV, FLV, MPG, TS/M2TS, VOB, OGV are remuxed/converted to MP4 | FFmpeg for the second group |

Converted audio is lossless: it becomes FLAC at the original sample rate (up to 192 kHz; DSD becomes 24-bit / 88.2 kHz PCM). The first load streams while converting; the result is cached in the library data folder (`transcode-cache/`, 4 GB by default, least recently used files are removed first), so reloading and seeking are instant afterwards.

Where FFmpeg comes from:
- **Desktop app**: included (the `ffmpeg-static` build).
- **`npm run web`**: the `ffmpeg-static` binary installed by `npm install`, else `ffmpeg` on your `PATH`. Set `OPENDJ_FFMPEG=/path/to/ffmpeg` to choose one (or `none` to turn conversion off).
- **Docker**: included (Debian's FFmpeg).

Without FFmpeg those formats are still listed in the library, but loading one shows "Install FFmpeg or use the desktop app". Media-server tracks in such formats are converted by your Plex, Jellyfin, Emby or Subsonic server instead. `GET /api/capabilities` reports what the running server supports.

## Run as a web app / on a NAS

OpenDJ can run on a NAS or home server and be opened from any computer's browser. The server holds your library and streams the files; **the audio is mixed and played in the browser**, so plug your headphones and controller into the computer you browse from.

### Docker (recommended)

```bash
docker build -t opendj .
docker run -d --name opendj -p 7380:7380 \
  -v opendj-data:/data -v /path/to/music:/music:ro \
  -e OPENDJ_PASSWORD='choose-a-password' opendj
```

or edit and use [`docker-compose.yml`](docker-compose.yml) (`docker compose up -d`). Then open `http://<nas-address>:7380`.

- `/music` is your music (read-only is fine); `/data` holds the library, analysis, transcode cache and uploads.
- Without `OPENDJ_PASSWORD`, the first visit asks you to choose a password. It needs the one-time setup code printed in the log (`docker logs opendj`), so nobody else on the network can claim the server first.

### Without Docker

```bash
npm install
HOST=0.0.0.0 OPENDJ_PASSWORD='choose-a-password' OPENDJ_MUSIC_ROOTS=/srv/music npm run web
# or: node server/cli.js --host 0.0.0.0 --port 7380
```

| Variable | Meaning |
|---|---|
| `HOST` / `--host` | Address to listen on. Default `127.0.0.1` (this computer only, no password). Anything else turns on the login. |
| `PORT` / `--port` | Port, default 7380 |
| `OPENDJ_PASSWORD` | Login password (otherwise chosen on first visit and stored hashed) |
| `OPENDJ_MUSIC_ROOTS` | Folders the web UI may browse, add, import from and export to, separated by `:` (`;` on Windows). Default: `~/Music`, the uploads and downloads folders. Nothing outside them is ever shown. |
| `OPENDJ_DATA` | Library data folder |
| `OPENDJ_UPLOAD_DIR` | Where browser uploads go (default `<data>/Uploads`; it is added to the library as a folder) |
| `OPENDJ_TRUST_PROXY=1` | Behind a reverse proxy: use `X-Forwarded-For` for login rate limiting and `X-Forwarded-Proto` for secure cookies |
| `OPENDJ_ALLOWED_HOSTS` | Optional list of host names the server answers to (e.g. `dj.example.com`) |
| `OPENDJ_FFMPEG` | FFmpeg binary, or `none` |

### Desktop app vs web app

| | Desktop app | Web app (browser) |
|---|---|---|
| Adding music | any folder, USB stick or NAS mount on this computer | folders under the music roots on the server, or **upload**: drag audio/video files onto the library, or use **Upload…** |
| Audio output, headphone cue | yes | yes (Chrome/Edge; choosing an output device needs HTTPS or localhost) |
| MIDI controllers, HID, USB DMX | yes | Chrome or Edge, and only over **HTTPS** or on `localhost` (Web MIDI / WebHID / Web Serial are limited to secure pages) |
| Install as an app | n/a | yes, from the browser's address bar (PWA) |
| Password | none (only reachable from this computer) | required |

### HTTPS with a reverse proxy

Controllers need a secure page, so put a TLS reverse proxy in front when you use OpenDJ from another computer. With [Caddy](https://caddyserver.com) (automatic Let's Encrypt certificates):

```
dj.example.com {
    reverse_proxy 127.0.0.1:7380
}
```

On a home network without a public name, `tls internal` gives a local certificate (trust Caddy's root CA on your laptop once):

```
https://opendj.lan {
    tls internal
    reverse_proxy 127.0.0.1:7380
}
```

Then start OpenDJ with `OPENDJ_TRUST_PROXY=1`. Sessions use an HttpOnly, SameSite=Strict cookie (marked Secure over HTTPS); failed logins are slowed down per address.

## Architecture

```
electron/           desktop shell (starts the server, native folder picker, MIDI/audio permissions)
server/             Node backend (127.0.0.1 by default; password login when hosted on a network)
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

End-to-end checks in headless Chromium. The first covers scan → load → analyse → play → sync → FX → record → automix:

```bash
npm run test:e2e
```

The second measures pitch for key shift and key lock, and checks key sync, quantized cues, saved loops, slicer, instant doubles, stems, Color FX, mic/talkover and the sequencer:

```bash
node scripts/e2e-performance.mjs
```

## Licence
MIT
