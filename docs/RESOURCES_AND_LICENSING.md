# OpenDJ: resources, samples, tools and licensing

*Checked 2026-11-21. Licences change, so check each item again before shipping. This document is research, not legal advice.*

**How I checked.** I read the OpenDJ repo without changing anything: `package.json`, `THIRD_PARTY_NOTICES.md`, `public/js/audio/sampler.js`, `analysis-core.js`, `public/js/stems/*`, `server/stems.js`, `public/js/midi/mixxx*.js`, `public/js/dvs/timecode-defs.js`, `server/link/*`, `server/cdj/*` and `public/js/shared/lyrics-core.js`.

For outside sources, GitHub pages and the npm registry could be fetched directly, so their licences are checked against the source (npm licence fields come from `npm view`). These hosts were blocked by this session's network: **freesound.org, huggingface.co, kenney.nl, lrclib.net, freemusicarchive.org and incompetech.com**. What I say about them comes from search-result snippets and needs a direct check (see §7).

---

## 0. What the repo check turned up (act on these first)

1. **The default stems model's own licence file says the weights are for personal and research use only.** The tarball OpenDJ downloads (`https://registry.npmjs.org/demucs/-/demucs-1.0.0.tgz`) contains a `LICENSE.md` that says: *"this package also include a weights file ("htdemucs.onnx"), which is not covered by this license. It is derived from a weights file provided by Meta, which is made available for personal and research use only."*
   - Meta's repo only says "Demucs is released under the MIT license" and never addresses the weights. The repo has been archived since 2025-01-01 ([facebookresearch/demucs](https://github.com/facebookresearch/demucs)). Other sources disagree: an [HF discussion](https://huggingface.co/adefossez/HTDemucs/discussions/1) questions the MIT label, and [HRSadeghi/demucs-onnx](https://huggingface.co/HRSadeghi/demucs-onnx) calls the weights CC BY-NC.
   - Download-on-demand with consent, which OpenDJ does now, is the right model. `THIRD_PARTY_NOTICES.md` already discloses the restriction.
   - For app-store builds and commercial forks, offer a model whose licence is clearly permissive as an alternative, or ask Meta / the packager for clarification. See §5.5.
2. **The UI calls the feature "Ableton Link"** (`public/js/ui/dialogs.js:446`). The protocol code is a clean-room MIT implementation (`server/link/index.js`). Ableton licenses the *name* together with its SDK and has [trademark guidelines](https://ableton.com/ja/legal/branding-trademark-guidelines). Consider wording such as "Link-compatible tempo sync (not affiliated with Ableton)", or ask link-devs@ableton.com.
3. **DVS timecode parameters.** `timecode-defs.js` uses "community parameters published for xwax-compatible decoders". Numeric facts such as LFSR seeds and taps are low risk. Keep it that way: do not port code from xwax, which is GPL-2.0.
4. **The Freesound API is free only for non-commercial use.** A Freesound developer has said that an app letting users search and download sounds counts as "commercial" ([API terms](https://freesound.org/docs/api/terms_of_use.html), [freesound-api group thread](https://groups.google.com/g/freesound-api/c/R_shemawHsE)). Get written permission from MTG-UPF (mtg@upf.edu) before shipping the browser with a project key, or make it bring-your-own-key. See §5.3.
5. **An open-source repo is itself redistribution.** Any sample committed to the MIT repo can be downloaded as a raw file by anyone. That rules out every "OK when embedded in your product, no standalone redistribution" licence: Sonniss, Pixabay, Mixkit, ZapSplat, 99Sounds, BPB and similar. Only CC0, public domain, CC-BY or CC-BY-SA material (or your own recordings) belongs in the repo or the installers.
6. **Things already in good shape.**
   - Mixxx mappings are fetched only when the user asks, and are not bundled (`mixxx-online.js` says so). Reading GPL *data files* at runtime as user content is fine. Do not copy Mixxx JS or XML into the repo.
   - The CDJ export (`server/cdj/*`) was written from Deep Symmetry's documentation and the Kaitai specs, not from their code. Keep it that way, or use the specs under their MPL-2.0 secondary licence (see §2.8).
   - ffmpeg-static (GPL) ships only as a separate executable in the desktop builds (mere aggregation). Make sure it never ends up in the iOS build.

---

## 1. Executive summary

### Top 10 to adopt now (bundle-safe)
1. **Sonic Pi's CC0 sample set as the recorded sampler bank.** It is CC0 with per-file Freesound credits ([credits README](https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md)). The vinyl backspin, rewind, scratch and hiss, the 808 and house kicks, the bass drops and the hats are exactly what the synthesised bank lacks.
2. **signalsmith-stretch** (MIT, npm 1.3.2, about 230 KB unpacked, official WASM + AudioWorklet build) as a high-quality key-lock / time-stretch mode beside WSOLA, for mashups ([repo](https://github.com/Signalsmith-Audio/signalsmith-stretch)).
3. **Beat This! small model** for beats and downbeats. Code *and* weights are MIT; the small checkpoints are about 8.1 MB ([CPJKU/beat_this](https://github.com/CPJKU/beat_this)). It needs an ONNX export so it can run on the onnxruntime-web dependency OpenDJ already has.
4. **Open Fixture Library** (MIT) as an import source for DMX fixture definitions ([repo](https://github.com/OpenLightingProject/open-fixture-library), [LICENSE](https://github.com/OpenLightingProject/open-fixture-library/blob/master/LICENSE)).
5. **A demo crate from CC0 / CC-BY music:**
   - Tricks & Traps "free rhythm game music pack 1" (CC0, with BPMs labelled, e.g. "Ascend" 130 BPM and "Starting Over" 122 BPM) ([OGA](https://opengameart.org/content/free-rhythm-game-music-pack-1))
   - HoliznaCC0 (CC0) ([FMA](https://freemusicarchive.org/music/holiznacc0/winter-lofi))
   - Kevin MacLeod (CC BY 4.0)
6. **Open-Unmix UMX-HQ** (code MIT; weights reported as MIT) as a download-on-demand stems model with a permissive licence, as an alternative to HT-Demucs ([open-unmix](https://github.com/sigsep/open-unmix-pytorch), [docs](https://sigsep.github.io/open-unmix), [ONNX export](https://huggingface.co/edgetools/umx-hq)).
7. **prolink-connect** (MIT, TypeScript) for Pro DJ Link status and metadata from Pioneer CDJs. Desktop / Docker only ([repo](https://github.com/evanpurkhiser/prolink-connect)).
8. **YAMNet** (Apache-2.0) for an on-device "what is in this track" tagger, plus **Silero VAD** (MIT) for automatic mic talk-over ducking ([silero-vad](https://github.com/snakers4/silero-vad)).
9. **MusicBrainz + Cover Art Archive** for tagging and artwork. Core data is CC0, the API allows 1 request/s and needs an identifying User-Agent ([data licence](https://musicbrainz.org/doc/About/Data_License), [rate limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting)).
10. **An in-app Credits screen and `public/samples/CREDITS.json`**, generated into `THIRD_PARTY_NOTICES.md` (see §5.6).

### Top 5 to consider later
1. A **Freesound CC0 sample browser**, once MTG confirms the terms or as bring-your-own-key.
2. **@eugabrielsilva/capacitor-midi-device** (MIT), or a small in-house CoreMIDI / Android MIDI bridge, for MIDI controllers on mobile. WKWebView has no Web MIDI.
3. **PANNs or OpenL3 embeddings** (CC BY 4.0 weights) for "similar track" and energy features in smart mix.
4. **Spleeter 2-stem** (MIT, though the weights are disputed) as a light vocal/instrumental model for phones.
5. **CLAP** (LAION code CC0; the `lukewys/laion_clap` checkpoints are tagged CC0) for text search such as "dark rolling techno". It is too big to bundle, so download on demand.

---

## 2. Tables per category

Key: **B** = bundle-safe, **D** = download-on-demand only, **L** = link / integrate only, **X** = not usable. Platform: Dsk = desktop, Web, Mob = mobile.

### 2.1 Sample and SFX sources

| Source | What | Licence | Class | Notes and attribution |
|---|---|---|---|---|
| Sonic Pi `etc/samples` | About 200 trimmed one-shots and loops, from Freesound plus donations by Arovane and The Black Dog | CC0 1.0 ([credits](https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md)) | **B** | Best immediate fit. **Exclude** `loop_amen`, `loop_amen_full` and `loop_breakbeat`: a CC0 upload of the Amen break cannot clear The Winstons' recording. Credit is optional; keep the per-file credit list anyway. |
| Freesound, CC0 filter | Huge per-file library | Per file: CC0 / CC-BY / CC-BY-NC ([FAQ](https://www.freesound.org/help/faq)) | **B** for CC0 / CC-BY files you curate; the API browser is **L** | Check each file page. NC files are not usable. The API browser needs permission (§5.3). |
| OpenGameArt | Game SFX and music | Per item ([example CC0 applause "Well done"](https://opengameart.org/content/well-done)) | **B** (CC0 / CC-BY items) | Licences are mixed. "Well done" switched to CC0 on 2024-10-05 but its filename still says CCBY3, so check. |
| meadowlark-factory-library | Community CC0 factory library | CC0 ([repo](https://github.com/BillyDM/meadowlark-factory-library)) | **B** | At present only kicks are visibly populated. |
| danigb/samples, oramics/sampled | Sample collections | Per folder: CC0 / PD / CC-BY 3.0 ([danigb](https://github.com/danigb/samples), [oramics](https://github.com/oramics/sampled)) | **B** (per folder) | Drum-machine folders have no stated licence, so use them only after checking `SOURCES.md`. |
| Kenney.nl audio packs | Game UI / impact / sci-fi SFX | CC0 (well known; host blocked here) | **B** | Few DJ-specific sounds. Lasers, impacts and UI clicks are useful. |
| Wikimedia Commons | Per-file audio | PD / CC0 / CC-BY / CC-BY-SA | **B** with care | BY-SA stays on the file and does not reach the app; attribute. |
| NASA audio | Launches, mission audio | US-government public domain (17 U.S.C. §105) | **B** | Do not imply NASA endorsement, and watch for third-party content inside the clips. |
| Internet Archive | Per item | Varies | **B** only for items clearly PD / CC0 | Many uploads have unclear rights. |
| Sonniss #GameAudioGDC | Big free SFX bundles | Royalty-free EULA. Reportedly no standalone redistribution; 2024+ also bans AI training ([summary](https://licenseorg.com/guide/music-audio/sonniss), [GFS](https://gamefromscratch.com/sonniss-27-5gb-sound-effect-giveaway-at-gdc-2024/)) | **X** | An open repo / sampler counts as standalone redistribution. |
| Pixabay SFX / music | Stock | Pixabay Content License: no "Standalone" distribution ([terms](https://pixabay.com/service/terms/)) | **X** | |
| Mixkit | Stock SFX / music | Mixkit licence: no redistribution on its own or making items available to third parties ([terms](https://mixkit.co/terms/)) | **X** | |
| ZapSplat | Stock SFX | Licence explicitly bans redistribution in apps ([licence](https://www.zapsplat.com/license-agreement)) | **X** | |
| 99Sounds, Signature Samples, BPB free packs, MusicRadar SampleRadar, Looperman, SampleSwap | Free producer packs and loops | Royalty-free *for use in your music*; redistribution as samples is banned (e.g. BPB Cassette 808: ["re-distributing any part … strictly prohibited"](https://bedroomproducersblog.com/2016/10/26/free-808-samples/)) | **X** | Fine for users to load themselves; never bundle. |
| BBC Sound Effects | Archive | RemArc licence: personal, educational and research use only | **X** | |
| LANDR / Splice free | Subscriber samples | Service terms; no redistribution ([Splice terms](https://splice.com/terms)) | **X** | |
| BigSoundBank | SFX | Reportedly CC0 ([example](https://bigsoundbank.com/horn-3-s3506.html)) | **B** (verify) | Has horns and crowds; worth a look. |

### 2.2 Time-stretch / pitch-shift

| Library | Licence | Class | Platform | Size | Recommendation |
|---|---|---|---|---|---|
| **signalsmith-stretch** | MIT ([repo](https://github.com/Signalsmith-Audio/signalsmith-stretch), npm `signalsmith-stretch` 1.3.2) | **B** | Dsk / Web / Mob (WASM + AudioWorklet) | About 232 KB unpacked | **Adopt.** Polyphonic and multi-octave; best at 0.75x to 1.5x. Use it as an "HQ key lock" mode, and for mashup key shifts of ±1 to 2 semitones. Attribution: MIT notice. |
| Bungee (open edition) | MPL-2.0 ([repo](https://github.com/bungee-audio-stretch/bungee)) | **B** (file-level copyleft: publish the source of the MPL files you change) | C++; the open edition has no official WASM (the Pro edition has one) | n/a | Optional. You would need your own Emscripten build. Its [comparison page](https://bungee.parabolaresearch.com/compare) is useful for listening tests. |
| SoundTouchJS / `@soundtouchjs/audio-worklet` | **MPL-2.0** (moved off LGPL) ([repo](https://github.com/cutterbl/SoundTouchJS)) | **B** (MPL) | Web / Mob, AudioWorklet | About 296 KB | A credible WSOLA-family alternative. It brings little over the WSOLA OpenDJ already has. |
| SoundTouch C++ | LGPL-2.1 | **X** for the iOS bundle (static WASM linking makes relinking obligations awkward) | | | Skip. |
| Rubber Band (incl. rubberband-wasm) | GPL-2.0+ or commercial ([npm](https://www.jsdelivr.com/package/npm/rubberband-wasm)) | **X** | | | Commercial licence only. |
| Elastique (zplane) | Commercial | **X** | | | |

**Which is best for mashups?** Keep WSOLA for scratching, nudging and low-CPU use. Add signalsmith-stretch for sustained key lock and pitch shifting, which is the mashup case: it is a phase-vocoder style method, so it smears transients less on tonal material and handles pitch shift without formant chipmunking at small intervals.

### 2.3 Beat / downbeat / structure / key

| Tool | Code licence | Weights licence | Class | Platform | Recommendation |
|---|---|---|---|---|---|
| **Beat This!** (CPJKU) | MIT | **MIT** (README); some training data has limited CC licences ([repo](https://github.com/CPJKU/beat_this)) | **B** / **D** | Needs ONNX export → onnxruntime-web | **Adopt** the small model (8.1 MB) for beats and downbeats; the full models are about 78 MB. |
| madmom | BSD | **CC BY-NC-SA 4.0** for all model and data files ([LICENSE](https://github.com/CPJKU/madmom/blob/main/LICENSE)) | **X** (models) | Python | Do not use its models. |
| BeatNet | CC BY 4.0 (repo) ([repo](https://github.com/mjhydri/BeatNet)) | Assumed CC BY 4.0 | **B** with attribution (verify) | Python / PyTorch | Offline mode depends on madmom's DBN code (BSD, fine). Beat This! is better. |
| All-In-One (mir-aidj) | MIT ([repo](https://github.com/mir-aidj/all-in-one)) | **Not stated** | **X until clarified** | PyTorch + NATTEN, hard to port | Treat it as an evaluation reference only. Keep OpenDJ's own `detectPhrases`. |
| essentia / essentia.js | **AGPL-3.0** ([repo](https://github.com/MTG/essentia.js), [licensing](https://essentia.upf.edu/licensing_information.html)) | Models are non-commercial / proprietary per model (unverified) | **X** | | |
| aubio | GPL-3.0 | | **X** | | |
| libKeyFinder | GPL-3.0 | | **X** | | |
| Deezer skey (key) | MIT | **Non-commercial research only** ([repo](https://github.com/deezer/skey)) | **X** | | |
| librosa | ISC | | Reference only | Python | Fine for offline tools and evaluation scripts, not in the app. |

**Key detection, permissive route.** Keep `detectKey` in `analysis-core.js` and improve it from published papers rather than copying code. For example, use EDM-tuned key profiles (Faraldo et al.), a tuning-offset estimate and beat-synchronous chroma. The numeric profiles are facts; just do not copy essentia's code.

### 2.4 Stem separation

| Model | Licence | Class | Platform fit | Notes |
|---|---|---|---|---|
| HT-Demucs v4 (current, via npm `demucs@1.0.0`) | Code MIT; **the package states the weights are "personal and research use only"** | **D** (keep consent and disclosure) | About 98 MB download, 174 MB ONNX; slow on phones | See §0.1. |
| **Open-Unmix UMX-HQ** | Code MIT; weights reported MIT ([docs](https://sigsep.github.io/open-unmix), [ONNX](https://huggingface.co/edgetools/umx-hq)); trained on MUSDB18-HQ | **D** (could be **B**) | Spectrogram LSTM, ONNX-friendly, lighter than HT-Demucs | **Recommended alternative with a permissive licence.** Lower quality than Demucs. |
| Open-Unmix UMX-L | **CC BY-NC-SA 4.0** | **X** | | |
| Spleeter 2/4/5-stem | MIT (code and models per the [JOSS paper](https://joss.theoj.org/papers/10.21105/joss.02154.pdf)); [ONNX notes](https://huggingface.co/Best-Practice/spleeter-4stems-onnx) mention open issue #898 on the weights | **D** | Light; good for 2-stem vocal/instrumental on phones | Older and lower quality, but fast. Trained on Deezer's own catalogue. |
| BS-RoFormer / Mel-RoFormer (ZFTurbo, viperx, Kim) | Training code MIT ([repo](https://github.com/ZFTurbo/Music-Source-Separation-Training)); **weights only "MIT" according to re-uploaders** ([mirror](https://huggingface.co/AEmotionStudio/roformer-models/blob/main/README.md)) | **X / L** (user-supplied URL only) | Large; state of the art | Users can point `stemsModelUrl` at these themselves. Do not ship or default to them. |
| MDX-Net / UVR models | Licences vary per model, often unstated | **L** | | Same approach: user-supplied URL. |
| MERT / MusicGen-family anything | NC | **X** | | |

### 2.5 VAD and audio embeddings

| Model | Licence | Class | Size / ONNX | Use |
|---|---|---|---|---|
| **YAMNet** | Apache-2.0 (TF Models) | **B** | About 15 MB; TFLite/ONNX conversions exist | Genre / instrument / vocal tags, crowd and speech detection. |
| **Silero VAD** | MIT ([repo](https://github.com/snakers4/silero-vad); one badge says CC BY-NC, so confirm the LICENSE file) | **B** | About 2 MB; 8 / 16 kHz; speech only | Mic talk-over auto-ducking. **For singing in tracks, use the energy of the separated vocal stem instead.** |
| PANNs (CNN14 etc.) | Code MIT; weights **CC BY 4.0** per secondary sources ([Zenodo 3987831](https://zenodo.org/record/3987831), [LiteRT card](https://huggingface.co/litert-community/PANNs-CNN14-AudioSet-LiteRT)) | **D** (attribution) | CNN14 is large (over 300 MB fp32); MobileNet variants are smaller | Similarity / energy. |
| OpenL3 | Code MIT; **weights CC BY 4.0** ([repo](https://github.com/marl/openl3)) | **B / D** with attribution | Tens of MB | Track-similarity embeddings for smart mix. |
| MusiCNN | ISC (repo; model licence not separately stated) ([repo](https://github.com/jordipons/musicnn)) | **B** (verify) | Small | Mood / genre tags. |
| CLAP (LAION) | Code CC0 ([repo](https://github.com/LAION-AI/CLAP)); `lukewys/laion_clap` tagged CC0 (about 1.86 GB checkpoints); `laion/clap-htsat-fused` Apache-2.0 | **D** | Big; quantised ONNX needed | Text-to-track search. Later. |
| MERT | **CC BY-NC 4.0** (changed from MIT on 2023-06-02) ([HF](https://huggingface.co/m-a-p/MERT-v1-95M)) | **X** | | |

### 2.6 Loudness, audio and web libraries

| Library | Licence | Class | Notes |
|---|---|---|---|
| libebur128 | MIT | **B** | OpenDJ already implements BS.1770 / LUFS itself (sampler and `loudness()`), so not needed. |
| Tone.js | MIT (npm 15.1.22) | **B** | Not needed; OpenDJ's engine is already custom. |
| wavesurfer.js | BSD-3-Clause (npm 8.1.0) | **B** | Only if replacing the waveform UI. |
| peaks.js | **LGPL-3.0** ([repo](https://github.com/bbc/peaks.js)) | **X** for bundling | |
| `@ffmpeg/ffmpeg` wrapper | MIT | — | |
| `@ffmpeg/core` | **GPL-2.0-or-later** (npm), about 65 MB | **X** | Use WebCodecs / `decodeAudioData` on mobile. |
| lamejs / @breezystack/lamejs | **LGPL-3.0** | **X** for iOS | |
| wasm-media-encoders | MIT wrapper, but contains LAME (LGPL) | **X** for MP3 on iOS | Its Ogg Vorbis encoder is BSD-licensed and usable. |
| opus-recorder | MIT (libopus BSD) | **B** | For recordings and broadcast. WebCodecs `AudioEncoder` (Opus) is the native alternative in Chromium. |
| libflacjs | MIT (libFLAC BSD) | **B** | Lossless recording export. |
| WEBMIDI.js | Apache-2.0 (npm 3.3.1) | **B** | Optional; OpenDJ already uses raw `requestMIDIAccess`. |
| @eugabrielsilva/capacitor-midi-device | MIT (8.0.1, Capacitor 8) ([repo](https://github.com/eugabrielsilva/capacitor-midi-device)) | **B** | Immature (0 stars, fork). Assess it, or write a thin CoreMIDI / android.media.midi bridge exposing a Web-MIDI-shaped shim. Prior art: [MIDIWebView](https://swiftpackageregistry.com/bloxidge/MIDIWebView), [cordova-plugin-webmidi](https://cdn.jsdelivr.net/npm/cordova-plugin-webmidi@1.0.1/README.md). |
| osc.js | MIT **or** GPL-2.0 (choose MIT) ([repo](https://github.com/colinbdclark/osc.js)) | **B** | Lighting / OSC out. Browser transport is WebSocket only; UDP needs Node. |

### 2.7 DJ data, protocols and services

| Item | Licence / terms | Class | Notes |
|---|---|---|---|
| Mixxx controller mappings | GPL-2.0+ | **L** (user-triggered runtime fetch, as now) | Do not bundle presets that were converted from them. |
| Open Fixture Library | MIT | **B** | Add an OFL JSON import in `public/js/lighting/panel.js`. Credit OFL. |
| crate-digger / dysentery / Kaitai specs (Deep Symmetry) | EPL-2.0, secondary MPL-2.0 / LGPL-3 ([repo](https://github.com/Deep-Symmetry/crate-digger)) | Docs: reference. Specs: **B** under MPL-2.0 if used. Java code: **X** | The `server/cdj` writers already follow the docs. |
| beat-link (Java) | EPL-2.0 | **X** (Java) | Use prolink-connect instead. |
| **prolink-connect** | MIT, TypeScript | **B** (desktop / Docker; needs UDP on the LAN) | Live CDJ status, metadata and "now playing". |
| Serato / Traktor formats | Community docs | Reference | Implement from docs. |
| Ableton Link SDK | GPL-2.0+ / proprietary; LinkKit notes the GPL is App Store–incompatible ([Debian copyright file](https://tracker.debian.org/media/packages/a/ableton-link/copyright-3.1.2dfsg-1)) | **X** (SDK) | The clean-room code is fine; watch the trademark (§0.2). |
| xwax | GPL-2.0 | **X** | Facts only. |
| LRCLIB | Free, no key (per a quoted beta doc); lyrics stay the rights-holders' copyright; a 19 GB DB dump exists with no stated licence ([summary](https://github.com/osdlyrics/osdlyrics/issues/146)) | **L** | Already opt-in (`online: false`) with a good User-Agent. Do not bundle the dump. Fetch on demand, cache locally, and never redistribute lyrics files. |
| MusicBrainz | Core data CC0; supplementary data and live feed CC BY-NC-SA ([licence](https://musicbrainz.org/doc/About/Data_License)) | **L** | 1 request/s, User-Agent with contact details. |
| Cover Art Archive | API free; images remain the uploaders' / labels' copyright ([API](https://wiki.musicbrainz.org/Cover_Art_Archive/API)) | **L** | Display only; cache per user. |
| AcoustID | Free for **non-commercial** apps; commercial use through AcoustID OÜ ([site](https://acoustid.org)) | **L** (confirm OpenDJ qualifies) | Chromaprint is MIT, but the whole is LGPL-2.1 because of bundled FFmpeg code ([Debian copyright](https://sources.debian.org/src/chromaprint/1.6.0-2/debian/copyright)). Use the fpcalc binary on desktop only, or a permissive JS port. |
| Discogs API | Commercial use at Discogs' discretion; "Restricted Data" may not be used commercially; about 60 requests/min authenticated; monthly dumps are CC0 ([API ToU](https://support.discogs.com/hc/en-us/articles/360009334593)) | **L** | Prefer MusicBrainz. Use Discogs for genre/style only, with a user token. |

### 2.8 Royalty-free / CC music

| Source | Licence | Class | Notes |
|---|---|---|---|
| OpenGameArt CC0 music | CC0 per item | **B** | The Tricks & Traps pack has BPMs labelled. |
| HoliznaCC0 (FMA) | CC0 per track ([example](https://freemusicarchive.org/music/holiznacc0/orphaned-media)) | **B** | Avoid the *HoliznaPatreon* account, which is not CC0. Lofi, chiptune, synthwave. |
| Loyalty Freak Music (FMA) | CC0 per track ([artist](https://freemusicarchive.org/music/Loyalty_Freak_Music)) | **B** | Utility / beat tracks. |
| Komiku (FMA / OGA) | CC0 per track | **B with caution** | A user reported YouTube Content ID claims through "The Sound Project" ([FMA comment](https://freemusicarchive.org/music/Komiku/Captain_Glouglous_Incredible_Week_Soundtrack/mall_1328)). Avoid for store videos. |
| Kevin MacLeod / Incompetech | CC BY 4.0 (some tracks 3.0) ([FAQ](https://incompetech.com/music/royalty-free/faq.html)) | **B** + attribution | Credit: `"Title" Kevin MacLeod (incompetech.com) Licensed under Creative Commons: By Attribution 4.0 https://creativecommons.org/licenses/by/4.0/` |
| Free Music Archive | Per track (many NC / ND) | **B** only for CC0 / BY / BY-SA tracks | |
| ccMixter | Per track; many BY-NC | **B** only for BY / BY-SA | |
| Jamendo | Mostly NC / ND for free use; commercial use through Jamendo Licensing | **X** (in practice) | |
| YouTube Audio Library | Standard licence covers YouTube videos only; some tracks are CC BY ([summary](https://licenseorg.com/guide/music-audio/youtube-audio-library)) | **X** to bundle | Fine for your own YouTube tutorial videos. |
| Pixabay Music | No standalone distribution | **X** | |
| Bensound | Free licence requires attribution and bans redistribution (not verified this session) | **X** | |
| NCS | Use in your own content with credit; no redistribution | **X** | |

---

## 3. Shortlists

### 3.1 Sampler: recorded default bank (all CC0, from Sonic Pi; original Freesound IDs from its README)

Use Sonic Pi's trimmed FLACs from `github.com/sonic-pi-net/sonic-pi/tree/dev/etc/samples`, re-master them with the sampler's existing LUFS and limiter pipeline, and store them as Ogg/Opus.

| Pad (keep ids) | File | Original |
|---|---|---|
| Rewind | `vinyl_rewind` | freesound.org/people/TasmanianPower/sounds/162493 |
| Spinback (new) | `vinyl_backspin` | freesound.org/people/il112/sounds/182316 |
| Scratch (new) | `vinyl_scratch` | freesound.org/people/hello_flowers/sounds/28681 |
| Vinyl crackle (new, loop) | `vinyl_hiss` | freesound.org/people/veezay/sounds/130393 |
| Kick | `bd_808` / `bd_haus` / `bd_klub` | EKVelika 208447 / Rodrigo The Mad 137722 / zgump 83262 |
| Heavy kick | `drum_heavy_kick` | Zajo 4832 |
| 808 bass drop (new) | `bass_drop_c` | ani_music 165320 |
| Bass hits | `bass_hard_c`, `bass_trance_c`, `bass_dnb_f` | ani_music 165309 / 165329; Exsomniel 206134 |
| Snare / clap | `sn_dub`, `sn_generic` | Adriak909 173142; hullum 415582 |
| Hats | `hat_snap`, `hat_zap`, `hat_raw` | TheEndOfACycle 674294 / 674295; cabled_mess 339278 |
| Impact | `misc_cineboom` | Northern_Monkey 177242 (link deprecated: rely on Sonic Pi's CC0 statement or swap it out) |
| Glitch FX | `glitch_robot_1/2`, `glitch_perc_*` | hullum 4155xx |
| Loops (sync mode) | `loop_compus`, `loop_industrial`, `loop_garzul`, `loop_mika`, `arovane_beat_*`, `tbd_fxbed_loop` | godspine, Garzul, mika55; Arovane / The Black Dog donations |

**Exclude:** `loop_amen`, `loop_amen_full` and `loop_breakbeat`.

**Keep synthesised:** air horn, siren, laser, riser, downlifter and noise sweep. The synths are good, and there is no verified CC0 air horn or siren yet.

**Fill later from Freesound / OGA after checking each file page:**
- air horn, siren, crowd cheer (start with OGA ["Well done"](https://opengameart.org/content/well-done))
- reggae/dancehall gunshot-style "pull up" FX
- risers / impacts (Kenney's impact pack)

**DJ vocal drops and "ahh" / "fresh" scratch vocals:** do not bundle any unless they are self-recorded or explicitly CC0 *and* original. Classic scratch vocals come from copyrighted records (e.g. Fab Five Freddy's "Change the Beat"), and Freesound uploads of them are not clean. Commission or record your own "OpenDJ" tags and release them CC0.

### 3.2 Demo crate (verify each track page and measure BPM/key with OpenDJ's analysis)

| Track | Artist | Licence | Why |
|---|---|---|---|
| "Ascend" (130 BPM) | Tricks & Traps, [rhythm game pack 1](https://opengameart.org/content/free-rhythm-game-music-pack-1) | CC0 | Trance / techno |
| "Starting Over" (122 BPM) | Tricks & Traps (same pack) | CC0 | House tempo; the pack has more tracks with stated BPMs (DnB, house) |
| One electronic track from ["Electronic" by Alex McCulloch](https://opengameart.org/content/electronic) | Alex McCulloch | CC0 | Techno |
| One track from [Winter Lofi](https://freemusicarchive.org/music/holiznacc0/winter-lofi) | HoliznaCC0 | CC0 | 70–90 BPM hip-hop / lofi, to show a tempo-range transition |
| One "R&B beats" track, e.g. ["Summer Pride"](https://freemusicarchive.org/music/Loyalty_Freak_Music/INSTRUMENTAL_RB_BEATS_TO_SING_OR_RAP_ON/Loyalty_Freak_Music_-_INSTRUMENTAL_RB_BEATS_TO_SING_OR_RAP_ON_-_17_Summer_Pride) | Loyalty Freak Music | CC0 | Vocal-free beat for stems demos |
| One or two dance-leaning tracks, e.g. "Pamgaea" or "Raving Energy" (titles to confirm on incompetech) | Kevin MacLeod | CC BY 4.0 | Recognisable quality; needs the credit line |

Aim for 5 or 6 tracks across 3 to 4 Camelot keys. Ship them as a release-asset download (§5.4), not inside the store binaries.

---

## 4. Do-not-use list

| Item | Reason |
|---|---|
| Rubber Band, rubberband-wasm | GPL-2.0+ (or commercial) |
| SoundTouch C++ (LGPL) in WASM | Relinking obligations; use SoundTouchJS (MPL) or signalsmith instead |
| essentia, essentia.js and their models | AGPL-3.0 code; non-commercial models |
| aubio, libKeyFinder, xwax, Mixxx code, Ableton Link SDK | GPL |
| madmom models, UMX-L, MERT, Deezer skey weights | Non-commercial (BY-NC / BY-NC-SA / research only) |
| All-In-One weights, BS/Mel-RoFormer and UVR weights | Licence not stated by the original authors; user-supplied URL only |
| peaks.js, lamejs, `@ffmpeg/core` | LGPL / LGPL / GPL, incompatible with iOS bundling |
| Sonniss, Pixabay, Mixkit, ZapSplat, 99Sounds, Signature Samples, BPB, SampleRadar, Looperman, SampleSwap, Splice, LANDR | No redistribution of samples as samples; an open repo is redistribution |
| BBC Sound Effects | RemArc, non-commercial |
| Jamendo free tracks, YouTube Audio Library standard licence, NCS, Bensound, Pixabay Music | NC / platform-limited / no redistribution |
| Amen break and other famous breaks, classic scratch vocals, DJ drops ripped from records | Underlying recordings are copyrighted, whatever the uploader's tag |
| Serato / Traktor control-CD WAVs | Vendor copyright. Use only locally for DVS testing; OpenDJ already generates timecode in `timecode-gen.js` |
| Datasets' audio (Harmonix via YouTube, GiantSteps via Beatport, MUSDB18, Ballroom, GTZAN, djmix) | Development and evaluation only; never ship |

---

## 5. Integration plan

### 5.1 Default bank (`public/js/audio/sampler.js`)
- Add a `src` field to the `BUILTIN` defs, for example `{ id: 'rewind', name: 'Rewind', src: 'samples/default/vinyl_rewind.ogg', render: rewind }`. Load `src` if it is there, and fall back to `render()` when the fetch fails. This keeps pad ids and MIDI maps stable.
- New pads go after pad 12 (Spinback, Scratch, Crackle, 808 Drop, Heavy Kick), or into a second bank page.
- Files live in `public/samples/default/`, about 1.5 MB total as Opus. Add `public/samples/CREDITS.json` with one entry per file: `{file, title, author, source_url, licence, licence_url, modified: true}`.
- Pre-master the files offline with the same −14 LUFS / −1 dBFS chain. Optionally add a `scripts/build-samples.mjs` with the Freesound IDs, so the bank can be rebuilt reproducibly.

### 5.2 Optional "expansion pack" (release asset)
- Build `opendj-samples-v1.zip` (CC0 / CC-BY only) with a `manifest.json` (files, SHA-256, licence per file) and attach it to a GitHub release.
- Download it with the same pinned-URL + SHA-256 pattern as `server/stems.js` (`DEFAULT_MODEL`). On mobile, use the existing `@capacitor/file-transfer`. Store it in IndexedDB / the filesystem, as user samples already are.
- Contents: sample categories such as more kicks (meadowlark, Sonic Pi), Arovane / Black Dog loops, Kenney impacts, curated Freesound CC0 horns, sirens, crowds and dancehall FX.

### 5.3 Freesound CC0 browser (after MTG confirms)
- **Search:** `GET https://freesound.org/apiv2/search/text/?query=…&filter=license:"Creative Commons 0"&fields=id,name,username,license,previews,duration` with `token=<API key>`. Previews (HQ MP3/OGG) work with token auth.
- **Originals:** these need OAuth2 (authorization-code flow). In Electron, use a loopback redirect; in Capacitor, a custom URL scheme via `@capacitor/app`.
- **Key handling:** an open-source app cannot hide a key. Ship with **bring-your-own-key by default** (the user applies at freesound.org/apiv2/apply), plus an optional project key only if MTG grants written permission.
- **Records and filters:** save `{id, username, license, url}` with every imported sample, and show it in Credits. Allow CC-BY behind a toggle with auto-attribution. Always hide NC.
- **Limits:** respect the rate limits (the informal figure is about 500 full-quality downloads a day; this needs checking). The UI should be "user downloads to their own library", never re-hosting.

### 5.4 Demo crate
- Ship it as `opendj-demo-crate-v1.zip`, a release asset of about 30–40 MB with MP3/Opus files and a `credits.json`.
- Offer it at first run: "Try mixing now: download 6 free tracks". Import it as a crate/playlist through the existing library import, with analysis precomputed (BPM, key, phrases, cues) in a sidecar JSON so automix works immediately.
- For store screenshots and videos, use only the CC0 tracks, or CC-BY with an on-screen or description credit. Avoid Komiku because of the Content ID report.

### 5.5 Libraries and models for automix and mashups
- **Time-stretch:** add `signalsmith-stretch` as an AudioWorklet path in `public/js/audio/worklets.js` with a "Key lock quality: Standard (WSOLA) / High" setting. Use High by default for the mashup mode and Key Sync shifts.
- **Beats:** export Beat This! small to ONNX (opset 17), quantise it, and run it in `analysis-worker.js` through onnxruntime-web, which is already a dependency. Keep `detectBpm` as the fast fallback. The model is only about 8 MB, so it can be bundled (MIT) or downloaded on demand.
- **Structure:** keep `detectPhrases` / `analyzeStructure`. Feed it Beat This! downbeats to snap phrases to bars. Use Harmonix Set annotations (repo MIT, audio not included) only to *evaluate* phrase accuracy offline.
- **VAD:** for vocal clash avoidance in automix, take vocal-presence curves from the stems vocal output (no new model). If stems are not prepared, use YAMNet's "Singing/Speech" classes as a cheap proxy. Use Silero VAD for mic talk-over ducking in the mic module.
- **Embeddings:** add OpenL3 or PANNs (CC BY 4.0 weights, credited) on demand for "similar next track" and energy curves in `smartmix.js`. Add CLAP later for text search.
- **Separation on mobile:** default to a light model (UMX-HQ or Spleeter 2-stem, on demand) on phones. Keep HT-Demucs as an opt-in "high quality" download with the existing disclosure. Set the model through the existing `stemsModelUrl` + SHA-256 mechanism; `stems-model.js` would need a "UMX" graph type.

### 5.6 Recording attributions
- **`THIRD_PARTY_NOTICES.md`:** add sections for "Bundled samples" (point to `public/samples/CREDITS.json` and summarise it as CC0 Sonic Pi samples with Freesound credits), "Libraries" (signalsmith-stretch MIT text, Open Fixture Library MIT, etc.), "Models downloaded on demand" (each with its licence and a link) and "Demo crate (download)".
- **Generation:** add `scripts/build-credits.mjs` to merge `CREDITS.json`, model metadata (`DEFAULT_MODEL.licence`) and the npm licences into the notices file and into `public/credits.json`. Fail CI if any bundled audio lacks a `licence` field or uses NC / ND.
- **In-app Credits screen:** in Settings → About (`public/js/ui/dialogs.js`), group credits as Software, Fonts & icons, Samples, Models and Demo music. Show the full licence text for MIT / ISC / OFL / Apache, and render CC-BY credits in the "Title — Author — Licence (link)" format. User-imported Freesound samples appear under "Your samples".

---

## 6. Datasets for automix research (development and evaluation only, never shipped)

| Dataset | What | Licence | Use |
|---|---|---|---|
| Harmonix Set | Beats, downbeats and segments for 912 pop tracks; YouTube links and mel spectrograms only ([repo](https://github.com/urinieto/harmonixset)) | Repo MIT; spectrograms under their own licence | Evaluating beats and structure |
| GiantSteps Tempo / Key | 664 Beatport two-minute previews with tempo, genre and key ([repo](https://github.com/GiantSteps/giantsteps-tempo-dataset)) | No licence stated in the repo; audio is Beatport's | Evaluating EDM tempo and key |
| djmix-dataset (Kim, Yang, Nam, DAFx 2022) | Real DJ mixes plus their tracklists; a downloader fetches audio ([repo](https://github.com/mir-aidj/djmix-dataset), [analysis](https://mir-aidj.github.io/djmix-analysis)) | Not stated | Studying transition lengths, cue points and EQ habits |
| Mixotic set / UnmixDB | 10 CC netlabel mixes plus their CC source tracks ([UnmixDB, Zenodo, CC BY 4.0](https://zenodo.org/record/1422385), [archive](https://archive.org/details/mixotic.net_202209)) | CC (variant unverified) | Best candidate for redistributable test fixtures once the variant is confirmed |
| Ballroom, GTZAN, MUSDB18 | Classic benchmarks | Research only / unclear | Evaluation only |
| FMA dataset (Defferrard) | 106k CC tracks plus metadata | Metadata CC BY 4.0; audio per track | Development, and mining CC0 / BY demo tracks |

---

## 7. Feature ideas (inspiration only, no code taken)

- **Mixed In Key-style energy levels (1–10)** from the loudness, onset density and spectral centroid OpenDJ already computes, shown in the library and used by smart mix.
- **Practice / sandbox mode** (Serato Practice, VirtualDJ Sandbox): headphone-only pre-listen of the next transition while the master plays.
- **rekordbox Phrase colours** on the waveform, already supported by `PHRASE_TYPES`, plus **Track Separation**-style stem fader modes.
- **djay-style Neural Mix pads** (one tap: acapella, instrumental, drums only), **Fade FX** (automated crossfade with an FX tail) and a **Looper** that records 4/8/16-beat stem-aware loops into sampler pads.
- **Performance pad modes:** hot cue, loop roll, slicer, sampler, stems, beat jump and key change. Pad mode switching is already supported for MIDI.
- **Learn-to-DJ mode:** an interactive tutorial driven by the demo crate (beatmatch, phrase-align, EQ swap), with automix showing "ghost" fader moves.
- **Controller mappings:** the Mixxx repo (runtime fetch, as now) and community-shared OpenDJ presets under CC0.
- **DVS testing:** generate timecode with OpenDJ; use the vendors' control CDs locally only.

---

## 8. Not verified (date: 2026-11-21)

- **Hosts blocked from this session**, so their pages were not read directly: freesound.org (API terms, rate limits, individual CC0 files), huggingface.co (MERT, CLAP, UMX-HQ ONNX, Silero model cards), kenney.nl, lrclib.net, freemusicarchive.org and incompetech.com. Figures for these come from search snippets. Allow these hosts or check them manually.
- **HT-Demucs weight licence:** the conflict described in §0.1 is unresolved.
- **Other weight licences:** UMX-HQ and Spleeter are MIT according to secondary sources; Spleeter issue #898 is still open. PANNs CC BY 4.0 comes from secondary sources. BeatNet's weight licence is assumed from the repo badge. All-In-One and RoFormer weights have no licence stated by their authors.
- **Freesound:** whether a free, ad-free, MIT app counts as "non-commercial" needs MTG's written answer. Any attribution or "powered by" requirement in the API terms was not confirmed.
- **Sonic Pi samples:** the CC0 statement is Sonic Pi's. `misc_cineboom` and `bass_hit_c` source links are marked "deprecated". Spot-check the Freesound pages of the files you ship.
- **Music:**
  - Kevin MacLeod: specific titles and BPMs.
  - Tricks & Traps: whether every track in the pack is CC0.
  - Komiku: Content ID status.
  - Mixotic: exact CC variant.
- **Libraries and services:**
  - capacitor-midi-device: maturity and iOS backend.
  - signalsmith vs Bungee: no measured listening test; run one using Bungee's comparison set.
  - Size figures marked "about" are approximate.
  - Sonniss and Mixkit: terms are from secondary summaries, but both are excluded anyway because of the open-repo redistribution issue.
  - Ableton: the name-licensing requirement comes from secondary sources plus Ableton's trademark page.
