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

### New in 0.6.6

- Fixed frozen waveforms, BPM displays and clocks on visible decks in desktop and compact landscape layouts.
- Cached tracks can play while optional analysis loads, and master selection stays with a ready deck.

### New in 0.6.5
- **Full-stack resource optimization (lower RAM, CPU, GPU/VRAM, disk I/O, and ~90 MB smaller installers).** Split heavy per-bar analysis (`barFeatures` / `tempoMap`) into an on-demand SQLite `track_analysis` table with slim `/api/tracks?slim=1` payloads, persistent SQLite prepared statements, gzip + `ETag`/`304` HTTP caching, bounded cover-art LRU caching, multiplexed SSE events, and 60 s throttled `library.json` mirroring. Native AI stem separation now streams FFmpeg PCM via temp files (~6 MB RAM instead of multi-GB on long mixes), skips redundant GPU warm-up checks, caches STFT inverse envelopes, disposes ONNX tensors promptly, and releases raw model buffers after load.
- **Zero-GC audio thread, demand-driven idle power savings, and smoother UI.** Eliminated audio-thread scratch allocations and trig/exp hotspots across `DeckProcessor`, FX worklets, phase vocoder, DVS timecode, and the PCM recorder; added FFT-based BPM autocorrelation, 10 s idle `AudioContext.suspend()`, and dynamic Electron background throttling tied to playback/Gig Mode. Fixed Scratch View platter VRAM leaks, dirty-checked 1080p karaoke overlay uploads, capped video/UI frame rates and paused them when hidden, reduced AutoMix queue planning from O(K²) to O(K) with targeted LibraryUI row patches and lazy loading for Video, Sampler Catalog, and CDJ Export, and trimmed unused `onnxruntime-web` bundles from desktop packages.

### New in 0.6.4
- **Drastically lower RAM, CPU, and network usage during Automix and large-library browsing.** Stopped auto-prefetching AI stems when stem transitions are disabled, lowered the ONNX stems child idle timeout from 10 minutes to 90 seconds, capped default ONNX CPU threads, and released raw decode/PCM buffers immediately. Capped Smart/Live Automix background pre-analysis batches (12 remote / 24 local), isolated background decodes on a short-lived `OfflineAudioContext` with >20 min / >100 MB auto-analysis guards, recycled the analysis worker every 8 tracks, reused `detectBpm()`'s low-band onset envelope in elastic grid detection, halved vocal-VAD FFT work, and bounded bar features to 96 blocks. Cached the projected 73k+ track dataset inside `library-view-worker.js` with zero-copy `Int32Array` index transfers, capped active UI repaints to 60 fps and VU meters to 30 fps, added an O(1) cache fast path to `AutoMix.nextTransition()`, and enabled 24-hour browser caching for proxied Plex/media-server artwork.
- **Fixed beat sync drift and half/double-time misalignment (e.g. 88 ↔ 176 BPM).** Made `Deck.alignPhase()`, `AutoMix` phase keeping (`phaseErrorSeconds`), Automix beat-offset/length math, and the deck phase meter half/double-time aware (`1×`, `2×`, `0.5×`); eliminated 3–15 ms worklet IPC lag on sync `play()`; added a continuous 4 Hz manual beat-phase & elastic `tempoMap` keeper in `Engine.tick()` that respects manual jog/bend nudges; and fixed `detectBpm()`'s `fold96` rightward BPM bias (+ parabolic sub-bin beatgrid offset interpolation) along with false-positive elastic grids on steady tracks with breakdowns.

### New in 0.6.3
- **Fixed desktop freezes (`Not Responding`) and Automix stalls on very large libraries (50,000+ tracks).** Fixed an ordering bug in `Library.updateTrack()` that triggered a full SQLite `replaceAll` instead of an incremental write on every analysed track, and keyed `tracks_fts` by `tracks.rowid` to replace O(N²) FTS5 table scans with O(log N) updates (a single track flush on 73k tracks drops from ~15 minutes to ~19 ms; existing `library.db` files migrate automatically on launch).
- **Incremental single-track sync instead of full-library reloads.** Track analysis, play-count updates, stem readiness, and downloads now push targeted single-track SSE updates merged in-place in O(1) rather than reloading the entire `/api/tracks` collection over HTTP.
- **Fast Smart Mix, Live Automix, and Suggestions at 70k+ scale.** Bounded candidate pools in `smartMix()` and `liveNext()`, added bounded top-K pre-selection to `suggestNext()`, throttled analysis-driven suggestion refreshes, cached banned-track lookups, and fixed `_startAutomix` to poll only the queued 60-track analysis batch.

### New in 0.6.2
- **Fixed audio-thread and long-session CPU spikes.** Replaced `MeterProcessor`'s unbounded loudness history with an O(1) LUFS histogram, added an exact Hölder-bound bypass for the 4× true-peak FIR filter and silent idle bypass, cached per-block effect worklet coefficients (`Reverb`, `Pitch`, `Comp`, `Ducker`, `ModDelay`, `Crush`, `Warmth`, `LFO`), and halved deck worklet IPC while stopping idle position traffic.
- **2× faster track analysis and zero idle polling.** Sparse onset folding (`detectBpm` 4.9× faster, `detectElasticGrid` 1.8× faster), 2-for-1 real-FFT packing across vocal/bar/key analysis, and a 3× faster main-thread `onsetCurve` cut full track analysis time in half; Ableton Link timers, server SSE ticks, `Engine` rAF loops, drive scans (now non-blocking on Windows), and drawer/deck DOM updates now stay idle when unused.
- **Reliability and layout polish.** Fixed a `NotSupportedError` race when Automix volume curves overlapped `setTargetAtTime`, fixed an undefined `modelMsg` reference in deck stem controls, and added CSS containment / memoization on the Loudness drawer and deck headers (4× fewer layouts with the Loudness drawer open).

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

