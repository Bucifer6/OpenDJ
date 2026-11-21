# Third-party notices

OpenDJ itself is MIT licensed (see the licence in README.md). The desktop builds and the npm install also
include the following third-party software.

## FFmpeg (via `ffmpeg-static`)

- What: a separate `ffmpeg` executable that OpenDJ runs as a child process to convert audio/video formats the
  browser engine cannot decode (ALAC, WMA, APE, WavPack, DSD, AC3, DTS, video containers…). OpenDJ does not link
  against FFmpeg; the binary is shipped alongside the app (mere aggregation) and can be replaced with any other
  FFmpeg build through the `OPENDJ_FFMPEG` environment variable.
- Packaged by: [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static) (GPL-3.0-or-later; release `b6.1.1`
  binaries, FFmpeg 6.1.x / 7.0.x depending on platform).
- Licence: the bundled builds include GPL components (e.g. libx264), so the FFmpeg binary is distributed under the
  **GNU General Public License version 3**. The licence text ships next to the binary
  (`node_modules/ffmpeg-static/ffmpeg.LICENSE`, inside `app.asar.unpacked` in the desktop app).
- Source code: FFmpeg <https://ffmpeg.org/download.html> (git: <https://git.ffmpeg.org/ffmpeg.git>).
  Build scripts and configuration for the static binaries:
  Linux <https://johnvansickle.com/ffmpeg/> · macOS <https://evermeet.cx/ffmpeg/> ·
  Windows <https://www.gyan.dev/ffmpeg/builds/> · packaging <https://github.com/eugeneware/ffmpeg-static>.
  On request we will also provide the corresponding source for any binary we distribute.
- The Docker image uses Debian's `ffmpeg` package instead (source: <https://packages.debian.org/source/stable/ffmpeg>).

## Other npm packages

- [music-metadata](https://github.com/borewit/music-metadata) — MIT
- [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) — MIT
- [Electron](https://github.com/electron/electron) — MIT (includes Chromium, whose licences are listed in the app's
  `LICENSES.chromium.html`)

## Mobile app (iOS / Android)

- [Capacitor](https://github.com/ionic-team/capacitor) (`@capacitor/core`, `cli`, `android`, `ios`) — MIT
- Capacitor plugins: `@capacitor/filesystem`, `@capacitor/share`, `@capacitor/app`, `@capacitor/file-transfer` — MIT;
  [`@capawesome/capacitor-file-picker`](https://github.com/capawesome-team/capacitor-plugins) — MIT;
  [`@capacitor-community/keep-awake`](https://github.com/capacitor-community/keep-awake) — MIT
- `public/vendor/opendj-vendor.js` bundles music-metadata (and its dependencies), fast-xml-parser and
  `@capacitor/core` (all MIT) for the browser.

## ONNX Runtime Web (onnxruntime-web)
Used to run the AI stem-separation model in the app. MIT License, © Microsoft Corporation. https://github.com/microsoft/onnxruntime

## HT-Demucs model (downloaded on first use, not bundled)
Stem separation model from Meta's Demucs (https://github.com/facebookresearch/demucs). The Demucs **code** is MIT-licensed; the pretrained **weights are not covered by the MIT licence**: their author says their licence is unclear (trained partly on research-only data), and the ONNX export OpenDJ downloads (npm package `demucs@1.0.0`, only after you agree in the app) says personal and research use only. Use them for personal, research or other non-commercial use only, or point *stemsModelUrl* at a model whose licence suits you. See `docs/RESOURCES_AND_LICENSING.md` §0.1.

## Sampler sounds
- **Air horn** (`public/samples/air-horn.mp3`, bundled): "Pneumatic horn, simple #1", recorded by Joseph SARDIN, BigSoundBank, CC0 1.0 (https://bigsoundbank.com/pneumatic-horn-simple-1-s1827.html). Credits in `public/samples/CREDITS.txt`.
- **CC0 sound library** (downloaded only when you pick a sound, not bundled): 111 one-shots from Sonic Pi's sample collection, pinned to commit `ed4b23ccb77f0845cbad2b8d911cd36a455ec597`. The collection's README places them under CC0 1.0 and lists the original Freesound creator of each file; OpenDJ keeps the creator and source with each pad (`public/js/audio/sample-catalog.js`, `docs/SOUND_EFFECTS.md`). Loops (including the Amen break recordings) are left out.

## Fonts (bundled in `public/fonts/`)
- **Inter** (variable, Latin and Latin Extended subsets) — © 2016 The Inter Project Authors
  (<https://github.com/rsms/inter>). SIL Open Font License 1.1; full text in `public/fonts/Inter-OFL.txt`.
  Files taken from the [`@fontsource-variable/inter`](https://fontsource.org/fonts/inter) 5.3.0 package.
- **JetBrains Mono** (variable, Latin subset) — © 2020 The JetBrains Mono Project Authors
  (<https://github.com/JetBrains/JetBrainsMono>). SIL Open Font License 1.1; full text in
  `public/fonts/JetBrainsMono-OFL.txt`. Files taken from the
  [`@fontsource-variable/jetbrains-mono`](https://fontsource.org/fonts/jetbrains-mono) 5.3.0 package.

The fonts are used unmodified (the woff2 subsets as published by Fontsource) and are served locally; no font is
loaded from a CDN.

## Lucide icons (subset, inlined in `public/js/ui/icons.js`)
SVG path data for about 70 icons from [Lucide](https://lucide.dev) (`lucide-static` 1.77.0).
ISC License — Copyright (c) 2026 Lucide Icons and Contributors; icons derived from Feather are MIT,
Copyright (c) 2013-present Cole Bemis. The full licence text ships as `public/js/ui/icons.LICENSE.txt`.

> Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby
> granted, provided that the above copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL
> IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
> INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN
> AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
> PERFORMANCE OF THIS SOFTWARE.
