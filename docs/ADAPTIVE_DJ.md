# Adaptive autonomous DJ

Choose **Live** smart selection and **Auto** transition style. Choose automatic transition length to let the planner choose the overlap as well. Analyse the library first; correct inaccurate beat grids before relying on long blends. Fixed queue order and explicit transition overrides remain available.

The engine chooses music and transition windows independently. Live selection scores the library for harmonic relation, half/double-time tempo distance, genre, energy trajectory, artist repetition and play history. It then reranks the best six candidates by the quality of an executable section transition. It excludes tracks already played in the set. A queued user selection takes priority.

## Musical decisions

`public/js/adaptive-dj.js` searches outgoing section endings and incoming section starts throughout the tracks, including breakdowns and other interior sections. These are musical candidate points, not a fixed number of seconds before a file ends. It compares up to eight exits and eight entries, retaining a fallback near the outgoing end. With many sections, this bounded search is intentionally not exhaustive.

For each pair, the existing transition planner compares tempo, harmonic compatibility, vocal presence, local section energy and available overlap. Measured per-second vocal maps take priority; section labels provide an explicitly estimated fallback. Candidate lengths include whole-bar section lengths alongside the existing 4/8/16/32-bar options, within the style's maximum overlap. Blends finish on the selected outgoing section boundary. The chosen incoming cue and timing are carried through to playback; a late tick advances the incoming cue by elapsed track time.

Auto style uses the existing mixer as its performance instrument: phrase blends, bass EQ swaps, filter sweeps, staged stem swaps, echo/reverb exits, cuts, loops, brake and backspin. Stem swaps require stems actually loaded on both decks. Quick vocal EQ is an approximation, so overlapping voices still carry a cost. The adaptive planner conservatively scores key compatibility without assuming a requested key shift will succeed.

There is a minimum listening interval of 32 seconds or 16 bars from the incoming entry, whichever is longer, and two bars of preparation beyond the current playhead. Short or exhausted tracks use the existing outro/fallback planner. Known beat confidence below 0.35, or disabled tempo sync, restricts automatic choices to echo, cut or reverb. This threshold is an engineering heuristic, not a calibrated probability. Old analysed tracks without confidence retain their existing grid behavior; reanalysis stores confidence. User-locked grids are trusted.

## Research and implementation choices

These sources inform the heuristics; their software, diagrams and proprietary detection algorithms were not copied.

| Professional practice | Engine behavior | Primary source |
| --- | --- | --- |
| Match tempo and beat phase using a correct grid | Existing deck sync, bounded tempo changes; uncertain grids avoid long overlaps | [Mixxx: DJing with Mixxx](https://manual.mixxx.org/2.5/en/chapters/djing_with_mixxx.html) |
| Align musical phrases | Section endings/entries become candidate handovers, rather than only file endpoints | [Pioneer DJ: Phrase Sync](https://www.pioneerdj.com/en/news/2019/ddj-200-smart-dj-controller/), [Native Instruments: phrase mixing](https://www.native-instruments.com/blogs/blog/phrase-mixing) |
| Use compatible harmonic relationships | Existing circle-of-fifths scoring plus a cost for sustained clashing overlap | [Mixed In Key: harmonic mixing](https://mixedinkey.com/integration/harmonic-mixing-101/) |
| Vary technique with material; phrase-time bass swaps and avoid crowded arrangements | Local vocal/energy scoring, EQ handover, effects exits and loaded-stem swaps | [Pioneer DJ: mixing techniques by genre](https://blog.pioneerdj.com/djtips/we-uncover-the-mixing-techniques-behind-every-major-genre/) |
| Drive audio behavior from the audio timeline | Transition and tempo-recovery progress use AudioContext time; existing mixer smooths control changes | [Web Audio specification](https://webaudio.github.io/web-audio-api/) |

## Audio architecture and performance

PCM decode and analysis already run through OpenDJ's decoder and analysis worker. Deck AudioWorklets render playback, key lock and stem mixing. Channels apply gain, EQ, filters and effects through the existing graph, then master limiting and output routing. This change adds no PCM copies, external service calls, model inference or new audio nodes to planning. Tracks are preloaded using the existing error/skip handling.

Plans are cached while playback advances. Changes to analysis, grid, rate, stems, settings, learning or overrides invalidate them; backward seeks and seeks beyond the planned window trigger reconsideration. The planner is pure and bounded to 64 window pairs; live mode evaluates at most six detailed plans after library scoring. Complexity still depends on phrase and vocal-map length. Large libraries still incur the existing library-wide compatibility scan.

Progress uses the audio clock, so suspending the AudioContext also suspends fades and tempo recovery. Playback initiation and control updates still use OpenDJ's UI/hidden-page tick and worklet messages. They are **not a new sample-accurate lookahead scheduler**; a stalled UI can delay a handover, and a long stall during a fade can cause an abrupt catch-up. Device performance and listening tests remain necessary before unattended public playback.

## Licensing and limits

New planner code is original code under OpenDJ's MIT license. No new production dependency, model, recording, or sample is introduced. Existing FFmpeg binary and optional stem-model conditions remain documented in [third-party notices](../THIRD_PARTY_NOTICES.md) and [resources and licensing](RESOURCES_AND_LICENSING.md). The planner works without downloading stems, and does not change stem-model consent or download behavior. Musical technique references do not grant rights to recordings or third-party trademarks.

This is a deterministic musical decision engine, not a trained model or a promise to reproduce every professional technique. Track-level keys cannot describe every modulation. A single static beat grid cannot reliably follow all live drums or tempo changes; vocal maps and phrase/energy labels may be wrong. There is no audience feedback, semantic lyric analysis or automatic scratch choreography. Plans explain their section choices so a DJ can inspect them and override them.

## Validation

Run `npm test` for the full suite. `node --test test/adaptive-dj.test.js` covers interior windows, boundary alignment, uncertain grids, exhausted tracks, bounded live reranking, actual transport cue consumption, late ticks, cache invalidation and confidence persistence. Existing planner, analysis and mixer tests cover the underlying techniques and DSP.

With Playwright and Chromium installed locally, `node scripts/e2e-automix.mjs` exercises actual browser playback, master-output levels/clipping/click checks, queue handoffs, remote sources and user overrides. These synthetic fixtures test transport and DSP; they do not establish subjective quality across commercial music genres.
