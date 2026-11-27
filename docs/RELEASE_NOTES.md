## OpenDJ — free, open-source DJ software

Mix on 2 or 4 decks with your own music from local folders, USB sticks, NAS shares and your Plex, Jellyfin, Emby, Subsonic/Navidrome or MediaMax server. OpenDJ runs as a desktop app on Windows, macOS and Linux, or as a self-hosted web app.

### Download
| System | File |
|---|---|
| Windows 10/11 (most PCs) | `OpenDJ-Setup-<version>-x64.exe`, or `OpenDJ-Portable-<version>.exe` (no install) |
| Windows on ARM | `OpenDJ-Setup-<version>-arm64.exe` |
| Windows, not sure which | `OpenDJ-Setup-<version>.exe` (works on both, larger download) |
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

### New in 0.6.1
- **Much lower CPU usage (up to 64–73 % lower idle audio CPU).** The stereo phase vocoder now packs L and R into a single 2-for-1 FFT (~3× faster key lock and key sync), `DeckProcessor` and `LimiterProcessor` bypass sample loops and IPC traffic when stopped/silent with zero per-sample audio-thread allocations, DSP Quick Stems and default Beat FX delay lines build lazily on first use, and unloaded Decks 3 & 4 disconnect from the audio graph in 2-deck mode.
- **Much lower RAM footprint and smoother UI.** Analysis and library-view Web Workers now spawn lazily and auto-terminate when idle (~75–100 MB RAM reclaimed), raw audio file buffers release immediately after decode, waveform tile caches use ~60 % less GPU/canvas memory and clear on eject, background analysis runs ~2.1× faster with 0 main-thread long tasks during playback, and idle UI/VU/lyrics/MIDI/suggestion loops throttle or pause when inactive or hidden.

### New in 0.6.0
- **Phase-vocoder key lock and audio-thread loop rolls.** Key Lock and Key Sync now run on a stereo phase vocoder with identity peak-locking (preserving stereo width), spectral-flux transient phase reset for crisp kicks and snares, formant preservation for vocals, and click-free mode crossfades. Automix loop-roll exits now execute sample-accurately on the audio thread.
- **Content-aware Automix v2.** Automix now schedules volume and isolator EQ curves directly on the Web Audio clock, runs synchronized two-deck tempo morphs, adapts EQ carving per bar from 4-band and chroma analysis (sub-vs-punch kick preview, dense-mid carving, local chroma clash avoidance, and fast DSP vocal detection even without AI stems), supports per-lane manual takeover when you touch a fader or EQ knob, adds Rekordbox-style Mix Point Link handoffs, uses Deck 3 for teases in 4-deck mode, and checks offline sandbox renders with real-PCM BS.1770 loudness, dead-air, and clipping inspection.
- **Elastic beatgrids, groove fingerprints, and waveform performance HUD.** Analysis now supports drifting live-drummed tracks with elastic `tempoMap` grids and manual warp anchors, 24-dim audio embeddings for smarter track selection, a top-edge vocal activity strip on the waveform, and a live bars-to-next-phrase countdown badge.
- **Built-in SQLite library, pro controller presets, tag write-back, and Gig Safe Mode.** The library now persists to Node's built-in SQLite (`node:sqlite`, WAL mode + FTS5 full-text search) with O(1) incremental writes and automatic corrupt-DB quarantine and backup recovery; adds opt-in non-destructive ID3v2.3/2.4 + Serato `GEOB` hot-cue tag write-back, FFmpeg chunked PCM slicing for ultra-long files, Gig Safe Mode with OS sleep prevention (`powerSaveBlocker`) and crash-recovery snapshots, audio health telemetry, COOP/COEP cross-origin isolation for multi-threaded WASM stems, and 6 new bundled pro controller presets (Pioneer/AlphaTheta DDJ-FLX10, DDJ-1000/800/FLX6, DDJ-SB3/REV1, Numark Mixtrack/Party Mix, Hercules Inpulse 500/300/200, and Denon MC4000 / Reloop Buddy & Ready).

### New in 0.5.18
- **Fixed: the Windows installer could install nothing but the uninstaller.** The ARM64 installer (for Windows on ARM) run on an ordinary Intel or AMD PC installed only the uninstaller to *C:\Program Files (x86)\OpenDJ*, with a desktop shortcut to a program that wasn't there. Each installer now checks the PC first: on the wrong one it says which file to download and installs nothing. If that happened to you: uninstall OpenDJ in *Settings → Apps*, then install `OpenDJ-Setup-<version>-x64.exe` (or `OpenDJ-Setup-<version>.exe`, which works on every PC).
- **Soft RGB is the default waveform colour scheme.** Installs still on the old default switch to it once; the old look is *3-band RGB (theme)* in *Settings → Appearance*.

### New in 0.5.17
- **Smoother waveforms and platters during mixes.** Under load, such as the next track loading during Automix, the audio clock runs in bursts, and the scrolling waveforms and spinning platters followed it with jumps of up to 60 ms. They now glide back into step instead, so the motion stays smooth. Track loading and Automix's beat-phase checks also do their work in smaller pieces, and Automix loads the next track a few seconds after a mix instead of straight away.
- **Waveform colour schemes and shapes.** *Settings → Appearance*: five gentler colour schemes (Soft RGB, Pastel, Amber, Ocean, Sunset) next to the existing ones, and a new *Waveform shape* setting: Bars (as before), Half (bars growing up from the bottom), Smooth (a filled outline) or Outline.

### New in 0.5.16
- **Tempo RESET glides.** On a playing deck, RESET (on screen or from a controller) now takes the tempo smoothly back to 0 % over 16 beats instead of jumping, so a track on air changes tempo without a bump; pressing it again during the glide jumps to 0 %. *Settings → Decks → Tempo RESET on a playing deck* sets 4, 8, 16 or 32 beats, or jumps at once as before. A stopped deck resets at once.
- **MIX NOW without Automix.** On deck 1 or 2, MIX NOW now also works with Automix off: it mixes the playing track into the one loaded on the other deck right away, then leaves the new track playing on its own. Its tooltip says what is missing when it can't (nothing playing, nothing loaded, the other deck already playing).
- **Smoother playback during mixes.** AI stems that OpenDJ prepares in the background in this window now pause while an Automix transition runs or a deck loads (and for 4 seconds after), then carry on; stems you ask for are never paused. Page stalls and, where the browser reports them, audio dropouts are written to the app log with what was going on, so a stutter can be traced (*Settings → About → Logs*).
- **Bass preview removed** (added in 0.5.14): it did not sound right in use.

### New in 0.5.15
- **Fixed: synced decks could seem a few milliseconds out of phase when they weren't.** Each deck's position was read up to several audio blocks (2.9 ms each) early, by a different amount per deck, so the beat-phase keeper sometimes saw phantom offsets of 3 to 13 ms and nudged the incoming track's pitch for nothing. Positions are now exact; in tests the measured offset between two synced decks holds steady instead of jumping.

### New in 0.5.14
- **Bass preview (optional).** *Settings → Automix → Bass preview*: in a long blend, the next track's bass comes in quietly (8 dB down) for the 8 bars before the bass swap, as in real DJ mixes, instead of staying cut. It is used only where it adds no noticeable low-end bump (under a quieter intro), never in a double drop, and is off by default.

### New in 0.5.13
- **Smaller desktop downloads.** Since 0.5.5 every desktop app also carried files only the project itself needs (documentation images, the phone app projects, tests and scripts), about 40 MB per app. They are no longer packaged.
- **The top bar fits a 1440 px laptop screen again.** The Automix ▾ menu had pushed it 10 px past the window edge; the buttons now sit a little closer together up to 1500 px.

### New in 0.5.12
- **A new air horn.** The Air Horn pad now plays a dancehall air horn recorded by the_mred on Freesound (CC0): a full 1.5-second blast with its natural fade, instead of the short pneumatic horn. *Air Horn ×3* is now made from the same recording (two short stabs, then the full blast) instead of a synthesised horn.
- **Ableton Link joins faster on a shaky network.** When lost packets cut a clock measurement short, OpenDJ now keeps the readings it already has, or tries again within half a second, instead of waiting 5 seconds before joining the session.

### New in 0.5.11
- **Automix blends like real DJ mixes.** Measured over about 20,000 transitions in real mixes, the typical blend is 16 bars (half are 8–26), and a track plays about 4 minutes before the next comes in (see `docs/automix-research/04-real-mixes.md`). House, techno and trance now prefer 16-bar blends and go to 32 at most; only a long outro over a long intro runs longer. A long club track now hands over after about 4–5 minutes instead of playing for 6 or more.
- **The bass changes hands as the next groove arrives**, on the incoming track's drop or main part when it starts inside the blend, else a little past the middle. The incoming hi-hats stay down until then and come in with its bass.
- **Teases of the next record redone** (still off unless you turn them on): 4 bars instead of 8, one transition in five at most and never two in a row, 8–16 bars before the mix, never over the current track's vocals. With AI stems it's the next track's vocal hook or drums; without stems its intro beat with the bass cut. The thin, filtered slice of the whole track is gone.

