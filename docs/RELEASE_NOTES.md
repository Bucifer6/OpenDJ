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

### New in 0.5.9
- **Longer blends, like a club DJ.** In house, techno and trance, Automix now layers compatible records (matching keys and genre, close tempo) for 32 bars and up to 64 when their intros and outros allow it, letting the incoming intro run under the outgoing track's last part. Disco and drum & bass blend a little longer too; open format stays quick.
- **Teases of the next record.** Sometimes (about one transition in three, every other one in party mode) Automix brings a bit of the next track in a phrase or two before the real mix and takes it out again: its vocal over an instrumental part or its drums with AI stems, otherwise its top end. *Settings → Automix → Sometimes tease the next track* turns it off.
- **Fixed: beats drifting out of phase during blends** (in 0.5.8). On tracks with soft or busy kicks the by-ear beat check gave jumpy readings, and following them pulled the two tracks up to ~30 ms apart. It now only follows the kicks when its readings are clear and steady, and uses the beat grids otherwise: the kicks land within about 3 ms again.

### New in 0.5.8
- **Never goes silent.** If the music stops, stalls or the on-air fader is left down, Automix restores the level, finishes a stuck transition or starts the next track on the beat.
- **Same loudness for every track.** Tracks are measured in LUFS (their loudest main section) and Automix sets each one's level before it is heard; a cut onto a much louder drop is eased in.
- **Mixes like a club DJ.** Long EQ blends with the bass swapped in one move on the phrase line (exactly on time, scheduled on the audio clock), never two basslines at once, the incoming drop landing where the outgoing track changes section, each track eased back to its own tempo slowly enough that nobody hears it, technique per genre (long blends for house and techno, cuts and short blends for hip-hop, pop and Latin, double drops in drum & bass), effects used sparingly.
- **Picks the music for the room.** A *Party* set shape follows the clock (background early, peak around midnight to 2 am, deeper late), looks a few tracks ahead, mixes familiar and new tracks, alternates vocals, keeps artists 8 tracks apart, weighs keys by how sure their detection is, and learns from skips.
- **Tricks.** Bass-cut teases, filter builds, loop-roll builds, pause drops, echo freezes, horns and rewinds, timed to land on the drop, never over vocals, and rationed (Settings → Automix → Tricks: off, subtle, party).
- **Preview.** The Automix queue shows the next transition as a timeline with a quality check, buttons to move it a phrase or change its length, and a *Preview ♪* button that plays it in the headphones before the crowd hears it. Party controls: energy −/+, keep this vibe, never play this track.
- **Plan a night.** *End the set at* a clock time (the energy winds down and the last track fades out in a reverb wash), *Clean versions only*, and *Export set (WAV)* renders the planned upcoming set to a file you can listen to the day before.
- **More ways to mix.** With AI stems on both decks: drum bridge (only the drums overlap, so keys and genres never clash), acapella carry and acapella in. Ping-pong chops for open-format sets, a looped last phrase when a radio edit ends too soon, per-section beat checks so live-drummed or beatless passages never get a long beat-matched blend, scratch fills (with a scratch sound on a sampler pad) and light cues on tricks.
- **Safer on shaky networks.** The track after next is fetched while the current one plays; a file that can't be read is dropped a track early instead of stopping the music.
- **AI stems use the graphics card from the first track.** When DirectML cannot separate correctly on a computer (an RTX 3070 here), the tracks you ask for are now sent to the graphics card in the app window (WebGPU) from the start: OpenDJ checks the graphics card first instead of queueing tracks on the CPU, and tracks already waiting on the CPU move to the graphics card. Before, the first tracks (and a whole Automix set prepared ahead) stayed on the CPU.
- The log now shows stems prepared in the app window, with the time each took.
- Automix research and design notes: `docs/PRO_DJ_AUTOMIX_RESEARCH.md`.

### New in 0.5.7
- **Faster AI stems on graphics cards where DirectML gets it wrong.** OpenDJ now tries DirectML at simpler model optimisation levels too, and checks each against the CPU. If none is right (seen on an RTX 3070), the tracks you ask for are separated in the app window on the graphics card through WebGPU, which is checked against the CPU first. The server's CPU keeps preparing the background tracks. Anything that does not match the CPU is never used, so stems stay correct. *Settings → AI stems → Where* can force the server.
- **Prepare stems ahead:** the Automix dialog can prepare AI stems for the whole set when it starts (in play order), and OpenDJ tells you once when stems run on the CPU, with the time per track and how to prepare playlists ahead.
- **Beat sync by ear:** during transitions OpenDJ now listens to where both tracks' kicks actually land and keeps them together (to about a millisecond), instead of trusting the beat grids alone, which can be slightly off. Grids are still used when there are no clear kicks.
- **Recommended Automix settings are the default for new installs:** Auto transition style and length, varied styles.

### New in 0.5.6
- **Automix mixes like a DJ.** With the *Auto* transition style, each track now plays most of its length before the next one comes in: OpenDJ mixes out over the outro and brings the next track in on its intro (or early in it, to keep two vocals apart). Before, it could mix out after only half a minute, or start the next track deep inside it, so some songs played for only a few seconds.
- **Tighter beat sync in transitions.** The incoming track now starts exactly on the beat even when the computer is busy (for example while AI stems are being prepared), without the turntable motor spin-up, and during the blend OpenDJ keeps both tracks in phase with small pitch nudges, the way a DJ rides the jog wheel.
- **AI stems no longer fail when the graphics card crashes.** If the stems engine crashes on the graphics card (seen on Windows as "The stems engine stopped (exit …)"), the track is now separated again on the CPU instead of failing, and the graphics card is not used for stems from then on. After a driver update, *Settings → AI stems → Try the graphics card again* turns it back on.
- **The graphics-card check is lighter and runs once.** OpenDJ now compares the graphics card with the CPU once, when the stems model loads, using a short built-in test sound. The CPU result is saved, so the CPU and graphics-card copies of the model are never in memory at the same time.
- **Logs for troubleshooting.** OpenDJ now keeps a log of what it did: server messages, the AI stems engine, and errors from the app window, with times. *Settings → About → Logs* has **Download log** and, in the desktop app, **Open logs folder**. Attach the log when you report a problem. Passwords and media-server tokens are removed from it. The file is kept small (5 MB, 3 older copies).
- **Clearer errors:** Windows crash codes are shown in hex (for example `0xC0000005`), and Electron's crash-reporter messages no longer hide the real cause.
- **Security:** fixed four code-scanning findings in the translation code (none could be exploited in practice).

### New in 0.5.5
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
