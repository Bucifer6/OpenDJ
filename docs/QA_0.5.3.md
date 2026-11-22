# OpenDJ 0.5.3 QA record

Date: 22 November 2026. Local environment: Windows, Node 24.19, Playwright Chromium, Electron, local synthetic music and loopback service fixtures. GitHub separately tests Node 22 and builds all supported platforms. No personal music library or external broadcast service was used.

## Results

- Full unit/API/security/DSP suite: **552 tests, 545 passed, seven skipped, zero failures**. Skips are existing platform/optional-component cases.
- All **22 available browser/desktop suites** passed, including corrected reruns of failures found during QA.
- Full interface sweep: **573 checks passed**, covering layouts, themes, zoom, viewport sizes, DPI scaling, panels, dialogs, keyboard actions, control overlap/visibility and fader bounds/travel.
- All **28 advertised MCP tools** exercised through authenticated HTTP, the event relay and the real browser app; the transport was not replaced by a fake page handler.
- Dependency audit: zero reported vulnerabilities. Controller Mapper generation check passed. Mobile vendor bundle checked against a separate clean install of the exact lockfile and passed.
- Browser QA uses the pinned Playwright development dependency; the README documents its one-time Chromium installation. It is not a production dependency or bundled model.

| Suite | Coverage | Result |
| --- | --- | --- |
| smoke | Scan, analyse, load, playback, sync, cues, loops, effects, recording and automix | Pass |
| fx | Effects DSP, channel/master graph, output levels, personalities, switching, stress and render cost | Pass |
| performance | Measured key shift/lock, key sync, phase-aligned cues, loops, slicer, instant doubles, quick stems, mic/ducking and sequencer | Pass |
| regressions | Fader/knob limits, layouts, mixer controls, queue and prior product regressions | Pass |
| decks | Motor, scratch, jog, slip, tempo glide, needle, lock, multitouch, active loops, quantization and playback jank | Pass |
| controllers | MIDI/HID detection, learning, relative encoders, mappings and controller wizard | Pass |
| flx2 | All 187 mapped messages, 14-bit controls, pads, shift layers, LEDs, device audio offer and deck selection; 52 checks including repeated jog searches | Pass |
| lighting | Lighting controls and fixture/output behavior against local fixtures | Pass |
| video | Video playback, mixer and projector controls | Pass |
| webapp | Hosted behavior, authentication and browser workflows | Pass |
| dvs | Generated timecode capture, REL/ABS, record position, reverse, pitch, needle lift and INT handoff | Pass |
| link-lyrics | Link and lyric controls, timing and display | Pass |
| recording | WAV/MP3 recording and real encoded audio sent to a loopback Icecast server | Pass |
| stems | Stub model preparation/cache, per-stem playback, gains/mutes, tempo/loop/scratch and deletion | Pass |
| analysis | Background/deck parity, 48 kHz tempo accuracy, cache, corrupt/empty files, search, reanalysis, load priority and phone/tablet layout | Pass |
| mobile | On-device import/storage, touch controls, scratch, playlists and exports | Pass |
| sampler | Bank playback, levels, controls and generated audio | Pass |
| automix | Interior cue consumption, all ten main mixing styles measured for clipping/clicks/levels/dropouts, queue edits, repeated MIX NOW, user loads and streamed sources | Pass |
| ui-sweep | 573 geometry, interaction, dialog, panel, keyboard, zoom and DPI checks | Pass |
| update | Same/older/newer versions, notes sanitization, snooze/skip, playback deferral, installer handoff, hosted/mobile modes and real Electron updater | Pass |
| desktop | Actual Electron startup/restart, persistent storage, sampler asset persistence, local planner responses and speech integration | Pass |
| mcp | Every advertised assistant tool through the authenticated real-app relay, including guards and local broadcast start/stop | Pass |

## Fine-grained assistant-tool coverage

| Group | Tools exercised |
| --- | --- |
| Library | `search_library`, `list_genres`, `get_track_details` |
| State and planning | `get_status`, `get_deck`, `plan_transition` (explicit pair and running queue) |
| Deck transport | `load_track`, `play`, `pause`, `cue`, `seek`, `set_tempo`, `set_key`, `set_loop` |
| Mixer | `set_mixer`, `set_fx`, `set_crossfader` |
| Stems | `prepare_stems` with the consent gate intact; `set_stems` rejects unavailable stems. Successful per-stem audio behavior is covered by the separate stems suite. |
| Automix | `automix_start`, `automix_stop`, `automix_skip`, `automix_queue_next`, `set_transition` |
| Sampler and voice | `trigger_sample`, `queue_dedication` |
| Broadcast | `broadcast_start`, `broadcast_stop`, targeting a local test server |

The unit MCP suite additionally covers disabled-by-default behavior, tokens/sessions, scopes, hostile arguments, bounds, rate limits, Origin/Host checks, hosted authentication, secret redaction and audit behavior. Real-app tests confirm that on-air seek/load guards reject unsafe state changes.

## Defects found and corrected

1. **Interior transition execution:** retain selected timing/cues through transport; account for late ticks and actual half/double-time playback ratios.
2. **Analysis freshness:** updated library metadata now replaces stale deck metadata in planning; manual grid locks override older low-confidence detector results.
3. **Vocal protection:** derive vocal hold behavior from the final selected window, not an earlier candidate window.
4. **Dense arrangements:** bounded candidates cover the full arrangement, including late interior sections; measured vocal maps decode once per search.
5. **Warm-up ordering:** future harmonic matches can no longer override the requested opening energy.
6. **48 kHz beat analysis:** sustained tones could mislead autocorrelation (124 BPM reported as 132.85 BPM). Weak estimates now compare bounded whole-track consistency before refinement. Twelve regression fixtures cover 122/124/128 BPM at 22.05/44.1/48/96 kHz; existing offbeat-bass and grid tests still pass.
7. **Seek feedback race:** sequence acknowledgements prevent an older worklet position report with the same timestamp from undoing a newer seek. Both main-thread and worklet tests cover it; controller searches are repeated after feedback arrives.
8. **Timecode reconfiguration:** structured-cloned equivalent definitions preserve acquired absolute position; changed bit polarity reacquires it.
9. **Tablet mixer:** channel strips can shrink within their available width; master controls remain visible. Short mixer layouts reserve enough height for meaningful fader travel.
10. **Test portability:** Windows import fixtures use correct volume/file-URL encoding; mobile QA falls back when the optional FFmpeg binary is absent; updater fixtures use future versions instead of a version already older than the application.
11. **Release checksum coverage:** Android publishing adds/replaces its APK checksum in the desktop manifest and waits for that manifest to exist.

The adaptive planner also passed 100 deterministic randomized section-layout cases for finite, bounded, non-mutating plans. A local seven-minute vocal-map fixture benchmark measured 1.51 ms median / 3.61 ms p95 over 150 searches before the later QA fixes; this is a workload-specific measurement, not a scheduling guarantee.

## Scope and release gate

Automated synthetic and simulated-device tests cannot establish absence of every bug. Physical controllers, multichannel audio interfaces, actual iOS/Android devices, app-store signing/distribution and third-party pretrained separation weights require their own acceptance tests. The pretrained model was not downloaded; source separation uses the suite's licensed stub model. The existing tick-driven transport is not a new sample-accurate lookahead scheduler; musical and performance limitations are described in [the adaptive DJ guide](ADAPTIVE_DJ.md).

Merge requires green checks on the exact final PR commit, including desktop/mobile/container builds and security analysis. After merge, release automation must build the merged commit, publish the expected assets and supply matching SHA-256 checksums, including Android. Publication results are recorded on the pull request and release.
