# OpenDJ 0.5.4 release QA

23 November 2026. This patch follows the [adaptive DJ implementation and fine-grained QA](QA_0.5.3.md), which exercised all 22 browser/desktop suites, 573 interface checks, 187 controller mappings and all 28 advertised MCP tools.

## Combined-branch startup regression

After the adaptive DJ PR passed its checks, an independent stem-output validation change reached main. Testing the combined main commit caught an extra closing brace in the browser stem worker message handler: the entire application failed to parse. The 0.5.3 release jobs were cancelled before publication. Its existing tag is retained for traceability; 0.5.4 carries the correction.

The fix preserves stem-output validation and the WebGPU-to-WASM fallback. A new test parses all 153 JavaScript files under `public/js`, including browser-only modules and AudioWorklets that Node unit tests do not import. These checks run in the existing required CI test job.

## Verification

- Full local unit/API/security/DSP suite after the fixes: **708 tests, 701 passed, seven existing platform/optional skips, zero failures**.
- Browser stem preparation, cached stem loading, mute/gain, key lock, tempo, loop, reverse, scratch, echo, instant doubles and deletion: passed with the synthetic band-separation model; no page errors.
- All **28 MCP tools**: passed through the authenticated relay and the real browser app.
- The complete browser/desktop suite is repeated before release; exact results are attached to the patch PR. Publication requires all required checks on the final PR commit, followed by successful release builds and asset checksum verification.
- README screenshots and animation are regenerated from the working application using fictional locally synthesised music. The Automix image shows live selection with automatic style and length. Screenshot capture now exits with failure on page errors or a failed capture.

## Absolute-timecode defect found in the repeated suite

The first repeated DVS run intermittently lost ABS position lock while reporting clean carrier speed. Diagnostic repeats confirmed the failure. A deterministic unit fixture then reproduced it when capture began partway through a carrier cycle: integrating phase differences from zero put amplitude-bit windows on the wrong cycle boundaries. The decoder now unwraps the measured carrier phase directly. The new fixture also exposed stale high/low bit thresholds after a noisy needle lift; reacquisition now resets those thresholds along with its envelope.

The regression covers **48 combinations** of Serato/Traktor definitions, forward/reverse playback and 12 initial carrier phases, verifying stable position before and after needle lift. All 19 DVS unit tests pass, including speed, scratch latency, calibration and absolute position. Real-browser DVS tests are repeated after the correction; original failures are retained in the local QA evidence rather than discarded.

Physical controllers, multichannel audio hardware, actual mobile devices and third-party pretrained separation weights are outside automated acceptance coverage. See the earlier QA record and [adaptive DJ guide](ADAPTIVE_DJ.md) for detailed coverage, licensing and timing/performance limits. No claim of exhaustive freedom from bugs is made.
