# Contributing to OpenDJ

Thanks for helping! Bug reports, controller mappings, translations of docs, tests on real hardware and code are all welcome.

## Set up

Requires **Node.js 20+** (CI uses Node 22).

```bash
git clone https://github.com/Bucifer6/OpenDJ.git
cd OpenDJ
npm install
npm start        # desktop app (Electron)
npm run web      # browser mode on http://localhost:7380 (Chrome or Edge)
```

The UI in `public/` is plain ES modules with no build step: edit a file and reload the window.

## Tests

```bash
npm test             # unit tests (node:test), no browser needed
npm run test:e2e     # end-to-end checks in headless Chromium (needs Playwright's Chromium)
node scripts/e2e-smoke.mjs   # run a single end-to-end script
```

Please run `npm test` before opening a pull request, and the relevant `scripts/e2e-*.mjs` script when you touch the UI, the audio engine or a panel.

README screenshots are reproducible: `node scripts/demo/make-demo-library.mjs` synthesises a fictional demo library and `node scripts/demo/screenshots.mjs` captures `docs/images/`.

## Code style

- Vanilla JavaScript (ES modules) in the browser and Node; no frameworks, no transpiler.
- Two-space indentation, single quotes, semicolons; keep the existing compact style of the file you edit.
- No new runtime dependencies without a good reason; licences must be MIT-compatible (see `THIRD_PARTY_NOTICES.md`).
- Keep the server bound to `127.0.0.1` by default and validate anything that comes from the network.
- User-facing text: short, plain English.

## Pull requests

1. Fork, create a branch from `main` and keep the change focused.
2. Add or update tests for behaviour you change.
3. Describe what changed and how you tested it (OS, browser/desktop, controller or hardware if relevant).
4. CI (`.github/workflows/build.yml`) runs the unit tests, the Docker smoke test and the desktop builds on every PR.

Testing on real gear is especially valuable: DVS absolute mode with real timecode media, CDJ USB exports on Pioneer players, Ableton Link against Ableton Live, and controller mappings. Please open an issue with what you tried and what happened.

By contributing you agree that your contributions are licensed under the MIT licence.
