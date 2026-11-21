# OpenDJ handover for Claude

Target Windows portable first. PRs 11–16 cover smart Automix, portable stems setup, in-app skins, deck MIX NOW, crossfader layout and the 111-sample browser. PR 17 adds the recorded air horn and local Ollama planning. Transition length is set in bars in the Automix dialog.

Verify startup and library download frame pacing with real audio, EQ dragging and crossfader travel in narrow mixers on wide windows. Exercise repeated MIX NOW presses, queue edits and stopping during preload. Check recorded airhorn and sample persistence after restart.

Desktop planning uses electron/main.js, electron/preload.cjs and public/js/ui/dialogs.js. Ollama runs on loopback port 11434. A named installed model ranks the first 60 tracks. Test real model failures and Romanian voice availability. System speech currently plays outside the master mix.

Outstanding: route MC voice into master audio and broadcasts, add live dedications, implement authenticated web MCP control of playback and existing broadcast targets. Inspect public/js/recording/broadcaster.js and server/broadcast.js. Test in a private stream. Verify controller and vinyl skin layouts on Windows. Do not infer interactive performance from packaging CI.

## Response from Claude

Worked in the `handover-work` branch (on top of main's v0.4.1 / v0.4.2). All numbers below come from this Linux
container (headless Chromium 157 with software rendering, and Electron 45.4.1 under Xvfb), not from a real Windows
laptop: treat them as a regression baseline only. Packaging CI says nothing about interactive performance, as the
notes say, and neither does a container.

### Review of PRs 11–17 (what was wrong)
- **Desktop storage was lost on every restart.** The desktop server took a new random port per launch, so the page's
  origin changed and IndexedDB / localStorage started empty each time: downloaded and imported sampler sounds, the
  sequencer, video mixer, skin cache, lyrics / Link prefs, remembered HID controllers, the Ollama model name. Verified
  in Electron; fixed with a remembered port (`electron/stable-port.js`).
- **Automix:** stopping while the first track loaded still started it (and could report "None of the tracks could be
  loaded"); a late preload muted a deck the DJ might own; repeated AUTOMIX NOW presses during the analysis wait
  started several runs; AUTOMIX NOW smart-ordered a whole big library on the main thread. All fixed and tested.
- **Mixer:** the v0.4.2 crossfader row left a 150 px crossfader next to three squashed selects in the (always ~340 px)
  mixer; the 28 px thumb ran 2 px past its track (e2e-regressions was failing on main); the EQ preset flipped to
  "Custom" on any volume / filter / automix move. The top bar overflowed with AUTOMIX NOW (e2e-ui-sweep: 23 failures
  on main), and the deck MIX NOW pushed CUE / PLAY into the pads in 4-deck mode at 80 %.
- **Ollama IPC:** sender check and loopback URL were right, but errors were raw ("fetch failed", 404, SyntaxError,
  wrapped in "Error invoking remote method"), the response size was unbounded, one bad index rejected the plan, the
  intro was spoken verbatim and through speechSynthesis (outside the mix; Romanian silently became English or
  nothing). Rewritten as `electron/local-planner.js`.
- **Downloads:** `loadCatalogSample()` fetched any URL it was given; now only catalogue ids from the pinned commit,
  no credentials / redirects, size and time limits. Skin catalogue: added redirect refusal, a size cap and a contrast
  check (an unreadable skin could lock you out of Settings). The colour validation itself was good.
- **Licences:** `server/stems.js` called the HT-Demucs weights MIT (corrected: code MIT, weights unclear, personal /
  research / non-commercial use only). The bundled air horn (BigSoundBank, CC0) and the CC0 library were missing from
  `THIRD_PARTY_NOTICES.md`. All 111 catalogue URLs answer 200 and every creator / source matches the pinned Sonic Pi
  README; loops (Amen break) are correctly excluded. I could not open bigsoundbank.com from here (proxy), so the air
  horn's CC0 status rests on its credit line: confirm it once in a browser.
- **e2e-automix was failing on main** (it expected a synthesised air horn longer than 1 s).
- **CI (not changed, please decide):** `.github/workflows/build.yml` and `mobile.yml` now also release whenever a push
  to main has a commit message starting "Publish OpenDJ v0.4.2 (#", with `v0.4.2` hard-coded as the tag. That was a
  one-off way to publish 0.4.2; it should be removed before the next release.

### Verified (numbers)
- Frame pacing with real demo audio (`scripts/perf/pacing.mjs`, 2,012-track library). Headless Chromium: startup p50
  16.7 ms / p95 16.8 / max 217 ms (the long frames are the deck's decode hand-over), library download ×3 p95 16.8 ms,
  EQ drag p95 16.8 ms (one 100 ms frame), crossfader drag p95 16.7 ms at 1280–3440 px wide with 2 and 4 decks, full
  −1…+1 travel. Electron under Xvfb (2,012 tracks): 2.5 s to ready, then startup p95 66.6 ms with a 733 ms worst frame (deck
  load + first waveform paint: the one phase over the script's 50 ms limit), library download ×3 p95 16.8 ms, EQ drag
  p95 16.8 ms, crossfader drag p95 33–50 ms (worst at 3440x1440). Xvfb software GL is far slower than a real GPU;
  rerun the script on Windows before drawing conclusions.
- Crossfader track: 150 → 284 px in the mixer at every window width.
- MIX NOW pressed 7 times → exactly one transition; queue edits mid-transition; MIX NOW while the next deck loads;
  stop while it waits; stop during the first load; repeated starts (e2e-automix).
- Recorded air horn (0.47 s, now mastered to −1 dBFS; the file peaks at 0 dBFS) and a downloaded CC0 sound persist
  after restarting server + browser (e2e-sampler) and the desktop app (e2e-desktop).
- Ollama failure modes against a fake server: not running, model missing, slow, malformed / prose-wrapped JSON,
  HTTP 500, 25 MB answer, prompt injection in titles, hostile answer with extra fields (unit tests and the real dialog
  in Electron).
- Romanian voices: `speechSynthesis.getVoices()` returns **0 voices** in Electron 45 and headless Chromium on Linux.
  With espeak-ng installed the server engine reports English and Romanian.
- Private stream (mock Icecast, `Ice-Public: 0`): a Romanian dedication decoded back from the MP3 stream is +43 dB in
  the speech band over the music-only level, the music is ducked 11.7 dB under it, and the metadata shows
  "Dedicație - Pentru Ana și Mihai…".

### Implemented
- **MC voice into master and broadcasts:** the server renders speech with the OS engine (Windows SAPI via
  PowerShell, macOS `say`, espeak-ng on Linux) into WAV (`server/tts.js`, `POST /api/tts`); the page plays it
  through Web Audio into `engine.voiceInput()` with music ducking (`public/js/audio/voice.js`). Chosen over capture
  (not possible for speechSynthesis output) and bundled Piper voices (mixed voice licences, no clearly redistributable
  Romanian voice, 20–60 MB each). Fallbacks: speechSynthesis (heard locally only, said so), else text.
  **Coordination with the mixer agent:** `engine.voiceInput()` (3 lines in `engine.js`) returns `engine.voiceBus` if
  the new mic / voice bus sets one, else the master bus. VoiceBus ducks through `engine.duck`, like talkover.
  The mixer worktree (`/home/user/OpenDJ-mixer`) already has its own `engine.voiceInput()` (voice bus into the mic bus,
  with auto talkover, mic FX and "mic in recording" routing) and keeps `engine.duck`. On merge, keep the mixer's
  `voiceInput()` and drop this branch's 3-line version: `voice.js` calls `engine.voiceInput()` and needs no change.
  If the mixer's auto talkover ducks on the voice bus, call `VoiceBus.play(buffer, { duck: false })` to avoid ducking
  twice.
- **Live dedications** (`public/js/dedications.js`, MC button in the mixer): English or Romanian, next 32-beat
  phrase, ducking, on-screen banner, video lower third, stream metadata held while it plays.
- **Authenticated MCP remote control** (`server/mcp.js`, `public/js/remote-control.js`, Settings → Remote control),
  all tools requested, security model in `SECURITY.md`. A hand-written Streamable HTTP implementation rather than the
  SDK (express and ~a dozen packages vs. this project's three dependencies).
- **AUTOMIX NOW removed** at the user's request: AUTOMIX starts a smart mix of the queue / view in one click,
  Shift- or right-click opens the dialog, deck MIX NOW stays.

### Still needs a real Windows machine
1. Windows portable build: first start, SmartScreen, the one-click stems install, and that `server-port.json` is
   written next to the portable app's profile (it uses `app.getPath('userData')`).
2. SAPI speech: `/api/tts/voices` with and without the Romanian voice (Settings → Time & language → Speech → Add
   voices → Romanian), PowerShell execution policy on locked-down machines, Windows Defender not blocking the
   PowerShell child process, a dedication in a recording.
3. Controller and vinyl skin layouts with real Windows font rendering at 100 / 125 / 150 % (checked here only as
   Chromium/Electron on Linux at those CSS sizes and pixel ratios: all pass e2e-ui-sweep section 6).
4. Frame pacing on real GPUs: `node scripts/perf/pacing.mjs --electron` (and `--dpr=1.25`) while playing music,
   plus EQ / crossfader by hand on a narrow mixer in a wide window.
5. Ollama on Windows with a real model (cold model load times close to the 90 s limit), and the MCP endpoint used
   from a real client (Claude Desktop) with the Windows firewall prompt when exposed beyond 127.0.0.1.
6. macOS `say -o` voice names (Ioana) were not testable here either.
