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
