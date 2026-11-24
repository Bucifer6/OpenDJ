# OpenDJ 0.5.12 QA record

24 November 2026. This covers the released 0.5.12 (main at `effa514`), the first full pass since [0.5.4](QA_0.5.4.md).

**Environment:**
- Linux container, Node 22, Playwright Chromium (headless) and Electron 45 under Xvfb.
- Synthetic music and loopback services only: no personal library, physical controller, audio interface, phone or GPU.
- GitHub separately builds every platform and runs the unit suite.

## Results

| Check | Result |
| --- | --- |
| Unit / API / security / DSP suite | **842 tests: 838 passed, 4 skipped** (existing platform / optional cases), 0 failed |
| Browser and desktop suites | **23 of 23 pass** after the fixes below |
| Interface sweep | **573 checks pass** |
| Assistant (MCP) tools | **all 28 pass** through the authenticated relay and the real app |
| Extra QA script `scripts/e2e-qa-0512.mjs` (new) | **19 checks pass** |
| `npm audit` (all and production only) | 0 vulnerabilities |
| Vendor bundle and Controller Mapper checks | up to date |
| Release assets | `SHA256SUMS.txt` matches GitHub's own digest for all 17 assets |

The extra QA script covers what 0.5.5-0.5.12 added without browser coverage:
- **App log:** the version header; page errors with a `[page]` mark; media-server tokens redacted; Settings → About → *Download log* saving `opendj-0.5.12-log.txt`; the 2 KB line cap and the per-minute cap.
- **Hosted mode:** `/api/logs`, `/api/logs/client`, `/api/stems/engine/warm`, `/api/stems/gpu/retry`, `/api/info` and `/api/settings` refuse requests without a login.
- **Automix effects:** off on a new install; switched off once on an older install, keeping its other settings; turned back on by the user, they stay on after a restart.

**Release assets checked in detail:**
- **APK:** its checksum matches; it holds version 0.5.12 and the new air horn.
- **Controller Mapper:** byte-identical to `public/controller-mapper.html`.
- **Linux x64 tarball and macOS arm64 zip:** each app package holds version 0.5.12, and the new sampler, Link and Automix code is identical to the repository.

| Suite | Result |
| --- | --- |
| smoke, fx, performance, regressions, decks, controllers, flx2, lighting, video, webapp, dvs, link-lyrics, recording, stems, analysis, mobile, sampler, automix, update, mcp, pro-automix | Pass on the first run |
| ui-sweep | Failed at first (defect 2); passes after the fix |
| desktop | Failed at first (defect 3); passes after the fix |

## Defects found and fixed

1. **Every desktop app shipped the whole repository** (0.5.5 to 0.5.12, all platforms).
   - **Cause:** each platform's `files` list in `package.json` held only exclusions (the other systems' ONNX runtime binaries). electron-builder reads such a list as "everything except these", which overrode the top-level list of what to package.
   - **Effect:** the Linux and macOS packages checked (Windows uses the same configuration) carried `docs/` (37 MB of images), `mobile/`, `test/`, `scripts/`, `tools/`, the Dockerfile and similar files, about 40 MB per app. No secrets were included, and the platform exclusions themselves worked.
   - **Fix:** each platform list now repeats the top-level includes. A local `electron-builder --linux dir` build holds only `electron/`, `server/`, `public/`, `package.json`, `THIRD_PARTY_NOTICES.md` and production dependencies, still with only the Linux runtime binaries. `app.asar` goes from 169 MB to 129 MB.
   - **Test:** `test/packaging.test.js` fails on the old configuration.
2. **Top bar clipped by 10 px on a 1440×900 window at 100 %**, in all four layouts.
   - **Cause:** the Automix ▾ source menu (0.5.5) widened the bar, but the buttons only fold into "More" at 1400 px and below.
   - **Fix:** the gap between top-bar buttons drops from 8 to 6 px at 1500 px and below. The full bar fits at 1440 px with 20 px to spare.
3. **Desktop suite still expected the old air horn.** The app was correct; the test's limit was stale. It expected under 1 s, while the 0.5.12 recording is 2.63 s. The suite doesn't run in CI, which is why the release missed it. The limits now follow the new recording.

A defect found in 0.5.12 itself is recorded in its release: a Link timing test failed at random in CI. The fix shipped in 0.5.12: a clock measurement cut short keeps its readings, a failed one is retried within 0.5-2 s, and the test is seeded.

## Not covered

- **Stems on a GPU:** WebGPU in the page and DirectML / CUDA in the engine need a real GPU. This container has none, so stems ran on the suite's stub model (CPU path). The routing logic is unit-tested.
- **Windows build, Docker image, real phones and physical controllers:** not built or run here. CI builds Windows and Docker.
- **Listening:** the measured checks don't replace listening on real tracks.
- **Completeness:** automated tests cannot show the absence of every bug.
