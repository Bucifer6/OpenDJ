# OpenDJ gap analysis vs. commercial and open-source DJ software

_Last updated: November 2026_

This compares OpenDJ with the current versions of the main DJ apps:
- **rekordbox 7** (AlphaTheta/Pioneer DJ)
- **Serato DJ Pro 4**
- **Traktor Pro 4** (Native Instruments)
- **VirtualDJ 2025/26**
- **djay Pro 5** (Algoriddim)
- **Engine DJ** (Denon/inMusic)
- **Mixxx** (open source)

It lists what each offers, what OpenDJ had before this pass, what this pass added, and what is still missing and why.

**Legend:**
- ✅ = OpenDJ had it already
- 🆕 = added in this pass
- ◐ = partial or approximation
- ❌ = not bridged (reason given)

## 1. Decks & performance

| Feature | rekordbox | Serato | Traktor | VirtualDJ | djay | OpenDJ |
|---|---|---|---|---|---|---|
| 2/4 decks, sync, master deck, key lock | ✔ | ✔ | ✔ | ✔ | ✔ | ✅ |
| Phase-quantized hot cue jumps | ✔ | ✔ | ✔ | ✔ | ✔ | 🆕 jumps keep the beat phase when quantize is on |
| Hot cues, memory cues | ✔ (8 + memory) | ✔ (8) | ✔ (8) | ✔ | ✔ (16) | ✅ 8 + memory |
| Saved loops on hot cues / memory loops | ✔ | ✔ | ✔ | ✔ | ✔ (cue loops) | 🆕 hot cue pad with an active loop saves it; MEM stores loops |
| Loop roll, beat jump, slip, reverse/censor | ✔ | ✔ | ✔ | ✔ | ✔ | ✅ |
| **Key shift / Key Sync** | ✔ | ✔ (Pitch 'n Time) | ✔ | ✔ | ✔ | 🆕 ±12 semitones; Key Sync finds the smallest harmonic shift to the master deck |
| **Pitch Play / keyboard mode** | ✔ | ✔ | — | ✔ | ✔ | 🆕 PITCH pad mode (Shift+pad picks the cue) |
| **Slicer** | ✔ | ✔ | (Remix) | ✔ | ✔ | 🆕 SLICE pad mode with slip |
| Instant doubles | ✔ | ✔ | ✔ (duplicate) | ✔ | ✔ | 🆕 drag a deck header onto another deck |
| Phase meter | ✔ | ✔ | ✔ | ✔ | ✔ | 🆕 beat-in-bar + offset vs master |
| Key lock quality | Elastique-class | Pitch 'n Time | Elastique | ✔ | ✔ | 🆕 upgraded to WSOLA time-stretch (pitch accurate within 0.1%) |
| Beat grid editor, tap tempo | ✔ | ✔ | ✔ | ✔ | ✔ | ✅ |
| DVS (timecode vinyl/CDJ control) | ✔ | ✔ | ✔ | ✔ | ✔ | 🆕 v0.2: Serato CV02/CD and Traktor MK1/MK2 timecode, ABS/REL/INT modes, auto-calibrate. ◐ absolute-mode LFSR parameters not yet verified on real media |

## 2. Mixer & effects

| Feature | rekordbox | Serato | Traktor | VirtualDJ | djay | OpenDJ |
|---|---|---|---|---|---|---|
| 3-band EQ with kill, filter, cue, crossfader curves | ✔ | ✔ | ✔ | ✔ | ✔ | ✅ |
| **Color FX / Sound Color FX** (Space, Dub Echo, Noise, Crush…) | ✔ | ✔ (Fade FX) | ✔ (Filter FX) | ✔ | ✔ | 🆕 Filter, Space, Dub Echo, Noise, Crush, Jet on the filter knob |
| Beat FX (echo, reverb, flanger, phaser, trans, etc.) | ✔ | ✔ | ✔ | ✔ | ✔ | ✅ 10 effects + pad FX |
| **Stems** (vocal / instrumental / drums) | ✔ AI 3/4-stem | ✔ AI, Stem Slip | ✔ AI 4-stem | ✔ AI | ✔ Neural Mix | 🆕 v0.2: AI 4-stem separation (HT-Demucs, prepared per track and cached), per-stem mute/level, acapella/instrumental, vocal echo. DSP quick stems remain as fallback. ◐ CPU separation is slow (~2.5× track length single-threaded); faster with WebGPU |
| Sampler | ✔ | ✔ | ✔ | ✔ | ✔ | ✅ 8 slots |
| **Sampler sequencer** | ✔ | ✔ (Scratch Bank/Sampler) | (Remix decks) | ✔ | ✔ | 🆕 16-step sequencer locked to the master deck's beat grid, with swing |
| **Microphone / aux input + talkover** | ✔ | ✔ | ✔ | ✔ | ✔ | 🆕 mic channel with EQ, compressor and talkover ducking |
| Headphone cue (split / separate output / 4-ch) | ✔ | ✔ | ✔ | ✔ | ✔ | ✅ |
| Mix recording | ✔ | ✔ | ✔ | ✔ | ✔ | ✅ WAV |
| **MIDI clock out** | ✔ | — | ✔ | ✔ | — | 🆕 24 ppqn, phase-locked to the master deck |
| Ableton Link | ✔ | ✔ | ✔ | ✔ | ✔ | 🆕 v0.2: own protocol implementation (discovery, clock sync, tempo/phase, start/stop). ◐ not yet tested against Ableton Live |
| Latency control | ✔ (ASIO) | ✔ | ✔ | ✔ | ✔ | 🆕 latency setting. ◐ ASIO is not available; the browser audio stack uses WASAPI/CoreAudio/ALSA. |

## 3. Library & preparation

| Feature | rekordbox | Serato | Traktor | VirtualDJ | djay | OpenDJ |
|---|---|---|---|---|---|---|
| Analysis: BPM, grid, key, waveform | ✔ | ✔ | ✔ | ✔ | ✔ | ✅ |
| **Phrase analysis** (intro/verse/chorus/outro) | ✔ | — | — | ◐ | ◐ | 🆕 phrase bands on waveforms |
| **Automatic cue creation** (Smart Cue) | ✔ | — | — | ✔ | ✔ | 🆕 hot/memory cues at phrase starts for un-cued tracks |
| Playlists, folders, ratings, history | ✔ | ✔ | ✔ | ✔ | ✔ | ✅ |
| **Smart playlists** (Intelligent Playlist / Smart Crates) | ✔ | ✔ | ◐ | ✔ | ✔ | 🆕 rule builder (BPM, key compatibility, genre, tags, colour, rating, energy, date…) |
| **Track colours & custom tags** (My Tag) | ✔ | ✔ | ✔ | ✔ | — | 🆕 |
| **Track info editor** | ✔ | ✔ | ✔ | ✔ | ✔ | 🆕 single and multi-track editing |
| **History sessions & setlist export** | ✔ | ✔ | ✔ | ✔ | ✔ | 🆕 sessions by date; TXT/CSV/M3U export |
| **Missing file relocate** | ✔ | ✔ | ✔ | ✔ | — | 🆕 |
| **Duplicate finder** | ◐ | ◐ | ✔ | ✔ | — | 🆕 |
| Library backup / restore | ✔ | ✔ | ✔ | ✔ | — | 🆕 |
| Import from other DJ apps | rekordbox XML | rekordbox/Traktor | — | many | rekordbox/Serato | 🆕 rekordbox XML, **Traktor NML, Serato crates, VirtualDJ database**, M3U |
| Export rekordbox XML / M3U / USB folder | ✔ | — | — | ✔ | ✔ (OneLibrary) | ✅ |
| Export **CDJ-ready USB** (PDB/ANLZ device library) | ✔ | — | — | — | ◐ | 🆕 v0.2: export.pdb + ANLZ (grids, cues, loops, colours, waveforms, phrases), validated against rekordbox's own files and 3 independent parsers. ◐ not yet tested on a player |
| Media servers: Plex/Jellyfin/Emby/Subsonic/MediaMax + offline download | — | — | — | ◐ | ◐ | ✅ (a strength of OpenDJ) |
| Audio formats | ✔ | ✔ | ✔ | ✔ | ✔ | 🆕 everything browsers decode, plus FFmpeg conversion for ALAC, WMA, APE, WavPack, DSD, AC3/DTS, MP2, TTA and audio from video files |
| Web app / NAS hosting | — | — | — | — | — | 🆕 password-protected web mode, browser uploads, installable PWA, Docker image (a strength of OpenDJ) |
| Streaming services (Beatport, Beatsource, TIDAL, SoundCloud, Apple Music, Spotify) | ✔ | ✔ | ✔ | ✔ | ✔ | ❌ requires commercial partner agreements and DRM; not possible for a free open-source app without them |
| Cloud library sync | ✔ (Cloud Library Sync) | ◐ | — | ✔ | ✔ | ◐ your own media server works as the cloud; no OpenDJ-hosted sync |
| Tag writing to files (cues in ID3) | — | ✔ | ✔ | ✔ | — | ❌ OpenDJ keeps cues and analysis in its library to avoid touching files (planned: optional Serato-compatible GEOB tags) |

## 4. Automix

| Feature | rekordbox | Serato | Traktor | VirtualDJ | djay | OpenDJ |
|---|---|---|---|---|---|---|
| Automix playlist | ✔ | ✔ | ✔ | ✔ | ✔ Automix AI | ✅ |
| Beat-matched, phrase-aware transitions | ◐ | — | — | ✔ | ✔ | 🆕 mixes out at the outro and in at the intro, aligned to phrases |
| Smart ordering by key/tempo/energy curve | — | — | — | ◐ | ✔ | 🆕 harmonic / build / peak / wave |
| Key clash fixing during automix | — | — | — | ✔ | ✔ | 🆕 optional Key Sync on transitions |

## 5. Hardware & integration

| Feature | rekordbox | Serato | Traktor | VirtualDJ | djay | OpenDJ |
|---|---|---|---|---|---|---|
| MIDI controllers + learn + LED feedback | ✔ | ✔ | ✔ | ✔ | ✔ | ✅ (plus new targets: key shift/sync, slicer, stems, mic, sequencer) |
| Official plug-and-play mappings for hundreds of controllers | ✔ | ✔ | ✔ | ✔ | ✔ | ◐ 1 starter preset + MIDI Learn; community mapping import/export |
| HID controllers (Traktor Kontrol, Pioneer HID) | ✔ | ✔ | ✔ | ✔ | ✔ | ❌ device-specific protocols; WebHID is possible later per device |
| Pro DJ Link / CDJ network | ✔ | ◐ | — | ◐ | — | ❌ proprietary protocol |
| Video mixing | ✔ (video) | ✔ (Video) | — | ✔ | ✔ | 🆕 music videos synced to the decks, visualizer for audio tracks, transitions, video FX, overlays, projector / second-screen output |
| YouTube | — | — | — | ◐ | — | 🆕 official embedded player only, as visuals or a volume-faded jukebox. ◐ ToS forbids downloading or processing its audio, so there is no EQ/FX/sync |
| Karaoke / lyrics | — | — | — | ✔ | — | 🆕 v0.2: LRC files, embedded tags, media servers, opt-in LRCLIB; deck lyric line, karaoke mode, video karaoke layer, sync editor |
| Lighting (SoundSwitch / DMX) | ✔ | ✔ | — | ✔ | — | 🆕 automatic beat- and phrase-synced light shows over Art-Net, sACN/E1.31, USB DMX (Enttec Pro-compatible), WLED, Philips Hue, OSC and MIDI. ◐ no SoundSwitch/rekordbox lighting file import, no fixture library yet |
| Live broadcast (Icecast/Shoutcast) | — | — | ✔ | ✔ | ✔ | 🆕 v0.2: Icecast, Shoutcast and RTMP (Twitch/YouTube/Mixcloud) with now-playing; recording streamed to disk in WAV/FLAC/MP3/AAC/Opus with cue sheets |

## Summary
- **Bridged in this pass (24 features):**
  - key shift + Key Sync + Pitch Play, WSOLA key lock, phase-quantized hot cues, saved loops, slicer, instant doubles, phase meter
  - Color FX, quick stems, step sequencer, mic + talkover, MIDI clock out, latency setting
  - phrase analysis, auto cues, phrase-aware automix with energy-curve ordering and key fixing
  - smart playlists, colours/tags, track editor, history sessions/setlists, relocate missing, duplicate finder, backup/restore, Traktor/Serato/VirtualDJ import
- **Remaining gaps that are legally blocked:** commercial streaming services and proprietary hardware/network protocols (Pro DJ Link, vendor HID).
- **Bridged in v0.2:** AI stems, DVS, CDJ USB export, Ableton Link, live broadcasting, disk recording, lyrics/karaoke, lower deck memory use.
- **Remaining gaps that are technically feasible (roadmap):**
  1. Verify DVS absolute mode, CDJ export and Link on real hardware / apps
  2. More built-in controller presets
  3. Writing cues to file tags (Serato-compatible GEOB)
  4. Faster AI stems (multi-threaded WASM via cross-origin isolation in the desktop app)
