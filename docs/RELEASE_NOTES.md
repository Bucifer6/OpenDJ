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

### New in 0.5.10
- **Automix no longer adds effects of its own.** Tricks inside tracks (bass teases, filter builds, loop rolls, horns…), teases of the next track and transitions built from AI stems (stem swap, drum bridge, acapella) are now off, also on existing installs (once). Isolated AI stems can carry audible artefacts. Each can be turned back on in *Settings → Automix*. Normal blends and echo-outs are unchanged.
- **AI stems are never prepared twice at once.** The app window no longer takes a track the server is already preparing (the two runs could cancel each other and waste minutes of work).

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
