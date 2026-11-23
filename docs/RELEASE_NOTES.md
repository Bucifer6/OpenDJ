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

### Unreleased
- **Automix starts with your decks.** Tracks you have loaded on deck 1 and/or deck 2 now play first when you press AUTOMIX: deck 1 starts (from your cue point if you set one), deck 2 plays next, then the rest of the mix. A deck that is already playing keeps playing.
- **Choose what Automix plays and for how long.** The new ▾ menu next to AUTOMIX mixes the whole library (shuffled or smart, endless), this view for an hour or endlessly, one playlist, or the genres you pick. The Automix dialog has the same *Mix* (view, whole library, a playlist, genres) and *Set length* (whole list, 30 minutes, 1 to 3 hours, endless) choices, and the ▾ menu sets what the one-click AUTOMIX button plays. Endless sets keep adding tracks, playing the whole pool before any track comes back; a playlist in *Play in this order* loops in order.
- **Fix AI stems that came out as noise on the graphics card.** The previous check only tested that the four stems add up to the track, but the GPU (DirectML) was returning noise spread across the stems that still added up exactly, so it passed. A GPU is now compared once with the CPU on real audio. If its stems differ, the track is redone on the CPU and the GPU is not used for stems again. Noisy GPU stems saved by 0.5.3–0.5.4 are deleted at start-up and prepared again. The browser engine checks WebGPU against WASM the same way.

### New in 0.5.4
- Ten additional audio-reactive visualisers: Aurora Ribbons, Cosmic Vortex, Fractal Mandala, Neon Terrain, Liquid Plasma, Warp Drive, Spectrum Skyline, Neon Waveform, Particle Orbit and Prism Tunnel. Choose and save a style per deck in VIDEO → Mix; works with the preview, projector output and Canvas2D fallback. No new dependencies or downloaded assets.
- Fix a browser startup syntax error in the stem backend fallback handler. CI now parses every browser JavaScript module and worker, including files not imported by unit tests.
- Stabilise absolute DVS position when audio capture begins partway through a carrier cycle, and reset bit thresholds on needle-lift reacquisition. A 48-case regression covers both timecode families, both directions and varying capture phases.
- Refresh the README, feature screenshots and demo animation from the working application using the fictional demo library.
- Includes the adaptive DJ improvements below and the stem-output validation fix. The 0.5.3 release candidate was stopped before publication after combined-branch QA detected the startup error.

### Adaptive DJ improvements (0.5.3 candidate)
- **Adaptive Auto DJ:** Auto style compares section handovers throughout both tracks, including interior entry points, using tempo, harmony, local energy and vocal overlap. Live selection also compares how well candidate tracks can actually transition.
- **Playback follows the plan:** selected cue points reach the real decks, late ticks catch up, and transition progress follows the audio clock. Uncertain beat grids avoid long synchronized overlaps; manually corrected grids are trusted.
- **More reliable beat analysis:** a bounded whole-track consistency search corrects tempo estimates when sustained tones overpower drum onsets, including 48 kHz playback devices.
- **Assistant tools:** transition planning reports adaptive cue positions; all 28 advertised tools have an authenticated real-app QA test using synthetic audio and a local broadcast fixture.
- **QA fixes:** refreshed library analysis takes priority over stale deck metadata, selected-window vocal protection is recalculated, queue lengths follow the active plan, and the tablet mixer keeps its master controls within the available width.
- **Deck transport:** sequence acknowledgements prevent old audio-thread feedback from undoing a newer cue or jog-search position.
- **Timecode vinyl:** switching modes preserves the acquired position when the timecode definition is unchanged.
- **Release downloads:** the checksum manifest now includes the Android APK uploaded after the desktop builds.
- **Server:** oversized requests reliably receive HTTP 413 instead of an intermittent connection reset; request-size limits remain enforced.
- No new production dependencies or models. Research sources, performance considerations, licensing and known limitations are documented in `docs/ADAPTIVE_DJ.md`.

### New in 0.5.2
- **Smarter Automix transitions.** The *Auto* style now plans every transition: it tries each style at 4 to 32 bars and keeps the one that fits the two tracks best: tempo gap, key, energy, genre, the outro and intro phrases, and where the vocals are. Two voices no longer clash: the incoming vocals wait until the bass swap. The queue shows why each transition was chosen. It runs on any device, with no graphics card needed.
- **Stem swap** transition style: with AI stems on both decks, the incoming drums come in first, then the bass, and the vocals last.
- **Automix learns your taste:** when you change a planned transition in the queue, Auto leans your way next time (Settings → Automix can forget it).
- **AI stems for your whole library, in the background** (Settings → AI stems, off by default): OpenDJ separates the tracks you play most first, once per track, up to a disk limit you set. Tracks you load or Automix needs always go first. A new *Faster* quality option separates about 15 % quicker.
- **Remote control (MCP) for AI assistants:** many new tools, so an assistant you connect can pick tracks by genre, BPM, key and energy, read a track's sections and vocals, plan transitions, mix (EQ, filter, FX, tempo, key, loops), build mashups with AI stems, and speak over the mix like an MC. OpenDJ itself contains no AI: it only offers the tools, with the same token, scopes and audit log as before.
- **4 decks:** the MASTER section is no longer hidden under decks 2 and 4.
- **Mixer:** the MC button is gone, giving MIC / TALK more room; the SMART row is no longer cut off. FX assign buttons show the right state.

### New in 0.5.1
- **AI stems prepared by OpenDJ itself, ahead of time.** The desktop app and the web server (Docker included) now separate stems natively in a background process, on the graphics card when there is one (DirectML on Windows, CoreML on Apple Silicon, CUDA on Linux) or on all CPU cores. Phones and browsers connected to it just ask, so the page no longer freezes while stems are prepared. Automix's next two tracks and every track you load on a deck are prepared automatically (Settings → AI stems). The browser engine remains as the fallback.
- **Romanian interface.** Settings → Appearance → Language: Auto, English or Română. The whole app is translated, including the login page, video output and Controller Mapper.
- **Automatic transition length** in Automix: *Auto (from the tracks)* picks 4 to 32 bars per transition from the outro and intro phrases, and the queue shows why.
- **Automix queue editing:** compact rows, Shuffle for the remaining tracks, drag & drop or Alt+Up/Down to reorder, and *Play next in automix* in the library menu.
- **Mixer:** two knob rows per channel and a taller MASTER meter with its buttons at the bottom.
- Dialogs and settings fit the window at every interface size; the settings tabs wrap instead of hiding the last ones.

### New in 0.5
**Turntables and decks** (docs/MIXER_AND_TURNTABLES_PLAN.md §6). Every new option defaults to the old behaviour.
- **Vinyl feel:** each deck's new *Vinyl* panel sets motor start and stop times (play, pause, reverse and the spin-up after you let go of the platter), jog weight, platter coast (a thrown record on a stopped deck), slip-mat, brake time, spin-back length and throw speed, 33 / 45 / 78 rpm (the scratch scale) and quartz lock. *Settings → Decks* has motor presets from instant (CDJ) to low torque.
- **Scratching that follows your hand:** touch and mouse scratching drive the record by position, using each input event's own time (and the extra samples browsers collect between frames), so the record stays where your hand puts it. A second finger on the platter holds the record still. Optional *flick to spin back*.
- **Platter styles** (*Settings → Decks*): Minimal (as before, the default, drawn in the skin's jog wheel style from 0.4.3), Vinyl (a spinning record with the cover art on its label, strobe dots that stand still at the right speed, a tonearm showing progress that you drag to drop the needle) and Player (a jog display: artwork, position ring, slip ghost, loop arc, hot-cue ticks, time left).
- **Waveform styles** *Player Blue* and *Player RGB*.
- **Scratch view** for phones and tablets: a big platter, a crossfader strip on your thumb side, a CUT button for transforms, scratch samples, the touch-to-sound latency, and haptic feedback (Off / Subtle / Full).
- **Scratch samples:** a SCR pad mode swaps the deck to a short sound and back (8 built-in OpenDJ-made sounds, CC0 vinyl one-shots to download, or drop your own file).
- **Deck tools:** tempo glide (hold RESET), ramped pitch bend, needle lock and needle snap, active loops, quantize divisions (1/8 beat to 1 bar), beat jump ½ to 64, loop in / out adjust with the jog (hold IN or OUT), SCALE pad mode (play a hot cue at scale steps by platter speed), deck lock, latching slip reverse (Shift + REV), slip brake, turntable start / stop.
- New MIDI targets for all of it (`deckN.vinylMode`, `deckN.motorStart`, `deckN.brake`, `deckN.activeLoop`, `deckN.quantizeDiv.next`, `deckN.loopInAdjust`, `deckN.needle`, `deckN.rpm45`…); existing mappings keep working.

#### Mixer
- **Full-width crossfader** with a continuous curve (linear … smooth … fast cut), hamster reverse, cut-in and a fast-cut ramp of 1 ms (Battle) or 5 ms (Club); the old 4 ms time constant took 28 ms to reach -60 dB. Channel strips now fill the mixer edge to edge; the setup dropdowns live in the MASTER column.
- **Channel-fader curves** (log, linear, smooth, cut) and per-channel fader reverse.
- **EQ presets** that behave like the common mixer types: Isolator (default), Club Classic, 4-Band, Rotary, Battle, Vintage Warm and Sculpt. The automix and MIDI maps keep working with every preset. The old "Flat EQ" menu is now "Tone".
- **Filters and Color FX:** a dual HP/LP filter mode, Center Lock, and three new Color FX (Sweep, Crunch, Pitch) with a PARAMETER control.
- **Booth output** with a 2-band booth EQ and its own level, on another sound card or on outputs 3-4 or 5-6. The mic stays out of the booth by default, to avoid feedback.
- **Headphones:** CUE MST, sampler cue, post-fader cue and a second headphone cue (B).
- **Mic:** 3-band EQ, mic FX (echo, reverb, megaphone, pitch), voice-activated auto talkover (with an option that ducks only the voice band so the bass keeps going), and a feedback reducer. A voice bus lets the MC / text-to-speech voice duck the music like the mic.
- **Beat FX units:** two global FX units, assignable to a channel, the master or a crossfader side, with FX frequency bands, quantise and a touch **FX strip**. Five new effects: Spiral, Helix, Triplet Filter, Low-Cut Echo and Shimmer.
- **Send / return** to built-in delays and reverb (returned to the master or a channel), a **one-knob compressor** per channel, a **master isolator**, **warmth**, master balance / mono, an adjustable limiter ceiling with a gain-reduction LED, and a record level, with the mic in or out of the recording.
- **Metering:** RMS bars with peak dots and an EBU R128 loudness card (momentary, short-term, integrated, true peak).
- **Mixer personalities** (optional): Club (today's mixer), Classic, Rotary and Battle. A dismissible chip can suggest one from the automix queue's genres; it is never applied automatically.
- An **Advanced mixer** drawer (⚙, closed by default; a bottom sheet on phones) holds everything above, and each control has a MIDI target.

#### Voice, dedications and remote control
- **MC voice in the mix:** spoken announcements now play through the master output, so they are heard, recorded and broadcast, with the music ducked underneath. OpenDJ uses your system's speech engine (Windows speech, macOS voices, or espeak-ng on Linux); nothing is downloaded.
- **Live dedications:** press **MC** in the mixer, write "For Ana and Mihai…", pick English or Română, and it is spoken over the mix at the next phrase. It can also appear on screen, on the video output and in your stream's "now playing". Without a Romanian voice, OpenDJ tells you how to add one and shows the text instead.
- **Local AI planning (desktop):** clearer messages when Ollama isn't running, the model isn't installed, or it answers badly; installed models are suggested; the spoken introduction goes into the mix.
- **Remote control for AI assistants (MCP):** off by default. Turn it on in **Settings → Remote control** to let an assistant such as Claude read OpenDJ's status, search your library, control decks, automix, crossfader, sampler and dedications, and start or stop your saved stream targets. It uses a token you copy once and permissions you choose, listens on this computer only unless you change it, and every action is logged. It never sees your files, folders or passwords.
- **One-click AUTOMIX:** AUTOMIX starts a smart mix of your queue or the view you're looking at straight away; Shift-click or right-click it for the options. The separate AUTOMIX NOW button is gone; each deck keeps **MIX NOW**.
- **Fixes:** sampler sounds, the sequencer pattern and other preferences now survive restarting the desktop app; a wider crossfader in the mixer; stopping automix while it loads no longer starts the track anyway.

#### Media servers
- **Plex user switching:** a Plex server in the sidebar has a **Switch Plex user** button (👥). Pick a member of your Plex Home (with their PIN if they have one) and OpenDJ browses and streams as them: their libraries, playlists and restrictions; the sidebar shows who is active, and the library syncs again. Cues, analysis and downloaded tracks stay put. The PIN is never stored, and the plex.tv account token stays out of the UI and of library backups.

#### Controllers
- **AlphaTheta DDJ-FLX2: plug and play.** A first-party mapping (CC0), written from AlphaTheta's published MIDI message list, loads as soon as the controller is plugged in: jogs (scratch, bend, SHIFT + jog search), tempo faders, SHIFT, BEAT SYNC (long press: master; SHIFT: pad mode selection), the HOT CUE / PAD FX / LOOP / SAMPLER pad modes with 8 pads per deck and their SHIFT layers, CUE and PLAY/PAUSE with their SHIFT functions, HI / MID / LOW and CFX, channel faders, crossfader, master and headphone levels, MASTER and headphone cues 1 / 2, with LED feedback, track-loaded lights and vinyl mode.
- **Smart Fader** (the SMART button next to the crossfader, or SMART FADER on the controller): the crossfader alone blends two tracks (both decks follow a BPM that morphs between the tracks, the basslines swap in the middle); Shift-click / SHIFT + SMART FADER runs a beat-synced 16-beat transition by itself. **SMART CFX** (SHIFT + MASTER): the CFX knobs play a Color FX preset (Space, Dub Echo, Crush, Noise, Jet), picked with FX SELECT (SHIFT + cue 1 / 2).
- **The controller's own sound card**: OpenDJ offers once to send the master to its outputs 1-2 and the headphone cue to 3-4 (or suggests split cue when the interface only has 2 channels).
- **Controller test** (Settings → Controllers): every incoming message live, which function it hits, a checklist of mapped controls, an LED check, and a capture recorder that saves a JSON file to attach to a bug report.
- **Deck select for 2-deck controllers**: in 4-deck mode, switch the left or right side of a controller to deck 3 or 4 (Settings → Controllers, or map a button to "Deck select").

### New in 0.4.3

- Added Silverline and Walnut Hi-Fi and refreshed Club Decks, Vinyl Booth and Pad Performance.
- Choose Brushed Metal, Digital Jog, Vinyl Turntable or OpenDJ Classic in Settings → Appearance. Each skin remembers its own jog wheel style.
- Vinyl Turntable adds a grooved record, spindle, strobe dots and a tonearm that moves during playback.

### New in 0.4.2
- MIX NOW on the active deck and wider crossfader travel.
- 111 downloadable samples and a bundled recorded air horn.
- Desktop Ollama set planning with optional English or Romanian spoken introduction.

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
