# OpenDJ: resources, samples, tools and licensing

*Checked 2026-11-21. Licences change, so check each item again before shipping. This document is research, not legal advice.*

**How I checked.** I read the OpenDJ repo without changing anything: `package.json`, `THIRD_PARTY_NOTICES.md`, `public/js/audio/sampler.js`, `analysis-core.js`, `public/js/stems/*`, `server/stems.js`, `public/js/midi/mixxx*.js`, `public/js/dvs/timecode-defs.js`, `server/link/*`, `server/cdj/*` and `public/js/shared/lyrics-core.js`.

For outside sources, GitHub pages and the npm registry could be fetched directly, so their licences are checked against the source (npm licence fields come from `npm view`). These hosts were blocked by this session's network: **freesound.org, huggingface.co, kenney.nl, lrclib.net, freemusicarchive.org and incompetech.com**. What I say about them comes from search-result snippets and needs a direct check (see §8).

**Update 2026-11-21.** These hosts became reachable, and the flagged items were re-checked against primary sources: freesound.org, huggingface.co, help.algoriddim.com, incompetech.com, freemusicarchive.org, lrclib.net, arxiv.org and kenney.nl (with a browser User-Agent). Results are in the **verification log (§8)**, with corrections made in place. opengameart.org, link.springer.com, zenodo.org, Wikipedia and most news and vendor sites were still unreachable; items that depend on them remain marked.

---

## 0. What the repo check turned up (act on these first)

1. **The default stems model's weights are not MIT-licensed (verified 2026-11-21).** The tarball OpenDJ downloads (`https://registry.npmjs.org/demucs/-/demucs-1.0.0.tgz`) contains a `LICENSE.md` that says: *"this package also include a weights file ("htdemucs.onnx"), which is not covered by this license. It is derived from a weights file provided by Meta, which is made available for personal and research use only."* (re-read from the tarball, confirmed).
   - **The author settles the question.** Alexandre Défossez's maintained repo says: *"Demucs code is released under the MIT license… The license of the weights is not clear: MusDB contains some data that were only usable for research purpose. I sadly cannot help granting a license… The 6 source variant of htdemucs was trained only on Meta internal dataset, which likely means CC-NC-BY license is applicable, as it was the case for all models released by FAIR. Do not write me to ask about it"* (added 2026-10-26) ([adefossez/demucs README](https://github.com/adefossez/demucs#license)). In 2022 he wrote: *"The model weights are not covered by the MIT license, and are provided only for scientific purposes"* ([facebookresearch/demucs#327](https://github.com/facebookresearch/demucs/issues/327)).
   - The Meta repo ([facebookresearch/demucs](https://github.com/facebookresearch/demucs), archived) still only says "Demucs is released under the MIT license". The author's HF repo [adefossez/HTDemucs](https://huggingface.co/adefossez/HTDemucs) was published with `license: mit` on 2026-07-11, but a commit titled *"Remove license from model card"* dropped it on 2026-08-31. The card now names no licence, and the [discussion](https://huggingface.co/adefossez/HTDemucs/discussions/1) asking about it has seven developer questions and no reply. [HRSadeghi/demucs-onnx](https://huggingface.co/HRSadeghi/demucs-onnx) is tagged MIT for its runtime, but its card says the v3/v4 weights are "non-commercial (CC BY-NC 4.0)" (confirmed).
   - `server/stems.js` `DEFAULT_MODEL.licence` says the weights were "released under the MIT licence". **That wording is wrong**; correct it when code work starts. `THIRD_PARTY_NOTICES.md` should quote the author's statement.
   - **What the app should default to:** **Open-Unmix UMX-HQ** (MIT per sigsep), downloaded on demand, on every platform. Keep HT-Demucs as an opt-in "High quality: personal and non-commercial use only" download behind an explicit consent. Never bundle it, never make it the default in app-store builds, and tell commercial forks to bring their own licensed model through `stemsModelUrl`. See §2.4 and §5.5.
2. **The UI calls the feature "Ableton Link"** (`public/js/ui/dialogs.js:446`). The protocol code is a clean-room MIT implementation (`server/link/index.js`). Ableton licenses the *name* together with its SDK and has [trademark guidelines](https://ableton.com/ja/legal/branding-trademark-guidelines). Consider wording such as "Link-compatible tempo sync (not affiliated with Ableton)", or ask link-devs@ableton.com.
3. **DVS timecode parameters.** `timecode-defs.js` uses "community parameters published for xwax-compatible decoders". Numeric facts such as LFSR seeds and taps are low risk. Keep it that way: do not port code from xwax, which is GPL-2.0.
4. **The Freesound API is free only for non-commercial use** (confirmed: "You can use the Freesound API for free only for non-commercial purposes. To use the Freesound API for commercial purposes, please contact us…" ([API docs: terms](https://freesound.org/docs/api/terms_of_use.html))). The full terms ([tos_api](https://freesound.org/help/tos_api/)) **do not define "commercial"**. The only definition of commercialising is in §4(c): Content may not be "commercialize[d] (that is, sell, rent, trade or lease)" in breach of its licences. The claim that a search-and-download app counts as "commercial" comes from a [freesound-api group thread](https://groups.google.com/g/freesound-api/c/R_shemawHsE) that was not re-read (Google Groups was unreachable). Two clauses decide the design:
   - **A shared project key is not allowed in an open-source client.** The terms give "one Access Key per Application", say keys "may be revoked if you share them with any third party", and say credentials "must be kept secret and confidential and under no circumstances be exposed to the public". A key in an MIT repo or app bundle is public by definition.
   - **Bring-your-own-key is consistent with the terms, though not mentioned explicitly.** Each user applies at freesound.org/apiv2/apply and becomes the "API User" for their own use; the terms only forbid "multiple API keys to circumvent request limitations". Originals need OAuth2 with the user logged in, which also satisfies §4(d) (no "service bureau" for users without a live Freesound session).
   - **There is no "powered by" or logo requirement.** The rule is to "Credit Freesound and sound creators in accordance with the sounds' licenses".
   - So **ship bring-your-own-key** and credit "Freesound" plus each sound's author and licence. A built-in project key needs MTG's written agreement (contact form: https://freesound.org/contact/). See §5.3.
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
   - Tricks & Traps "free rhythm game music pack 1" (CC0, with BPMs labelled, e.g. "Ascend" 130 BPM and "Starting Over" 122 BPM) ([OGA](https://opengameart.org/content/free-rhythm-game-music-pack-1); ⚠ opengameart.org still unreachable, and search excerpts show a single "License(s): CC0" for the submission)
   - HoliznaCC0 (CC0, confirmed on the album page) ([FMA](https://freemusicarchive.org/music/holiznacc0/winter-lofi))
   - Kevin MacLeod (CC BY 4.0, confirmed): "Raving Energy" (122 BPM) and "Brain Dance" (124 BPM)
6. **Open-Unmix UMX-HQ** (code and weights MIT per sigsep's README, which carves out only UMX-L as non-commercial; confirmed) as the **default** download-on-demand stems model, replacing HT-Demucs as the default (§0.1) ([open-unmix](https://github.com/sigsep/open-unmix-pytorch), [docs](https://sigsep.github.io/open-unmix), [ONNX export](https://huggingface.co/edgetools/umx-hq)).
7. **prolink-connect** (MIT, TypeScript) for Pro DJ Link status and metadata from Pioneer CDJs. Desktop / Docker only ([repo](https://github.com/evanpurkhiser/prolink-connect)).
8. **YAMNet** (Apache-2.0) for an on-device "what is in this track" tagger, plus **Silero VAD** (MIT, confirmed in its LICENSE file) for automatic mic talk-over ducking ([silero-vad](https://github.com/snakers4/silero-vad)).
9. **MusicBrainz + Cover Art Archive** for tagging and artwork. Core data is CC0, the API allows 1 request/s and needs an identifying User-Agent ([data licence](https://musicbrainz.org/doc/About/Data_License), [rate limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting)).
10. **An in-app Credits screen and `public/samples/CREDITS.json`**, generated into `THIRD_PARTY_NOTICES.md` (see §5.6).

### Top 5 to consider later
1. A **Freesound CC0 sample browser**, once MTG confirms the terms or as bring-your-own-key.
2. **@eugabrielsilva/capacitor-midi-device** (MIT), or a small in-house CoreMIDI / Android MIDI bridge, for MIDI controllers on mobile. WKWebView has no Web MIDI.
3. **PANNs or OpenL3 embeddings** (CC BY 4.0 weights) for "similar track" and energy features in smart mix.
4. **Spleeter 2-stem** (code MIT; weights unclear: the README says only "the code" is MIT and [issue #898](https://github.com/deezer/spleeter/issues/898) is open with no maintainer reply) as a light vocal/instrumental model for phones. UMX-HQ is the safer choice.
5. **CLAP** (LAION code CC0; the `lukewys/laion_clap` checkpoints are tagged CC0; `laion/clap-htsat-fused`, `clap-htsat-unfused` and the music-tuned `larger_clap_music` are Apache-2.0, all confirmed on their HF cards) for text search such as "dark rolling techno". It is too big to bundle, so download on demand.

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
| Kenney.nl audio packs | Game UI / impact / sci-fi SFX | CC0, confirmed: Impact Sounds, Interface Sounds and Sci-fi Sounds each show "License: Creative Commons CC0", and the support page says "all game assets on the asset pages are public domain licensed (CC0)… even in commercial projects" ([Impact Sounds](https://kenney.nl/assets/impact-sounds), [support](https://kenney.nl/support)) | **B** | Few DJ-specific sounds. Lasers, impacts and UI clicks are useful. |
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
| All-In-One (mir-aidj) | MIT ([repo](https://github.com/mir-aidj/all-in-one)) | Corrected: the author's weight repo [`taejunkim/allinone`](https://huggingface.co/taejunkim/allinone) is tagged **MIT** (bare tag, no text). Trained on Harmonix Set | **X in practice** | PyTorch + NATTEN, hard to port; **its pipeline runs HT-Demucs first** (`demucs_model: 'htdemucs'`), so it inherits §0.1 | Treat it as an evaluation reference only. Keep OpenDJ's own `detectPhrases`. |
| essentia / essentia.js | **AGPL-3.0** ([repo](https://github.com/MTG/essentia.js), [licensing](https://essentia.upf.edu/licensing_information.html)) | Models are non-commercial / proprietary per model (⚠ essentia.upf.edu unreachable on 2026-11-21, so still unverified) | **X** | | |
| aubio | GPL-3.0 | | **X** | | |
| libKeyFinder | GPL-3.0 | | **X** | | |
| Deezer skey (key) | MIT | **Non-commercial research only** ([repo](https://github.com/deezer/skey)) | **X** | | |
| librosa | ISC | | Reference only | Python | Fine for offline tools and evaluation scripts, not in the app. |

**Key detection, permissive route.** Keep `detectKey` in `analysis-core.js` and improve it from published papers rather than copying code. For example, use EDM-tuned key profiles (Faraldo et al.), a tuning-offset estimate and beat-synchronous chroma. The numeric profiles are facts; just do not copy essentia's code.

### 2.4 Stem separation

| Model | Licence | Class | Platform fit | Notes |
|---|---|---|---|---|
| HT-Demucs v4 (current, via npm `demucs@1.0.0`) | Code MIT; **weights not MIT**: the package says "personal and research use only", and the author says the licence "is not clear" (MusDB research data; the 6-stem model likely CC BY-NC) ([README](https://github.com/adefossez/demucs#license)) | **D, opt-in only** (consent: personal and non-commercial use) | About 98 MB download, 174 MB ONNX; slow on phones | See §0.1. No longer the default. |
| **Open-Unmix UMX-HQ** | Code and weights MIT: the README's licence is MIT and only UMX-L is carved out as CC BY-NC-SA ([README](https://github.com/sigsep/open-unmix-pytorch#license)); trained on MUSDB18-HQ (Zenodo record 3370489 not reachable). The ONNX export [edgetools/umx-hq](https://huggingface.co/edgetools/umx-hq) is tagged MIT and has the **vocals stem only** (17 MB); export drums, bass and other from the same weights | **D** (could be **B**) | Spectrogram LSTM, ONNX-friendly, lighter than HT-Demucs; STFT and ISTFT stay outside the graph | **Recommended default.** Lower quality than Demucs (vocals SDR 6.25 dB). Residual risk: MUSDB18-HQ is the dataset Défossez flags, but sigsep license their weights MIT explicitly. |
| Open-Unmix UMX-L | **CC BY-NC-SA 4.0** | **X** | | |
| Spleeter 2/4/5-stem | Code MIT. Weights: the [JOSS paper](https://joss.theoj.org/papers/10.21105/joss.02154.pdf) says the models are MIT, but the README says only "The code of **Spleeter** is MIT-licensed". [Issue #898](https://github.com/deezer/spleeter/issues/898) is open with no maintainer answer (checked 2026-11-21). The ONNX mirror is tagged Apache-2.0 | **D** (second choice) | Light; good for 2-stem vocal/instrumental on phones | Older and lower quality, but fast. Trained on Deezer's own catalogue. |
| BS-RoFormer / Mel-RoFormer (ZFTurbo, viperx, Kim) | Training code MIT ([repo](https://github.com/ZFTurbo/Music-Source-Separation-Training)); **weights only "MIT" according to re-uploaders** ([mirror](https://huggingface.co/AEmotionStudio/roformer-models/blob/main/README.md)) | **X / L** (user-supplied URL only) | Large; state of the art | Users can point `stemsModelUrl` at these themselves. Do not ship or default to them. |
| MDX-Net / UVR models | Licences vary per model, often unstated | **L** | | Same approach: user-supplied URL. |
| MERT / MusicGen-family anything | NC | **X** | | |

### 2.5 VAD and audio embeddings

| Model | Licence | Class | Size / ONNX | Use |
|---|---|---|---|---|
| **YAMNet** | Apache-2.0 (TF Models) | **B** | About 15 MB; TFLite/ONNX conversions exist | Genre / instrument / vocal tags, crowd and speech detection. |
| **Silero VAD** | MIT, confirmed: the LICENSE file is MIT ("Copyright (c) 2020-present Silero Team"). The "CC BY-NC 4.0" text is only the stale alt-text of a badge whose image says MIT ([LICENSE](https://github.com/snakers4/silero-vad/blob/master/LICENSE), [onnx-community/silero-vad](https://huggingface.co/onnx-community/silero-vad) tagged MIT) | **B** | About 2 MB; 8 / 16 kHz; speech only | Mic talk-over auto-ducking. **For singing in tracks, use the energy of the separated vocal stem instead.** |
| PANNs (CNN14 etc.) | Weights **CC BY 4.0**, confirmed on the LiteRT card, which cites Zenodo 3987831. The same card gives the code licence as Apache-2.0, not MIT; the upstream LICENSE file could not be fetched ([LiteRT card](https://huggingface.co/litert-community/PANNs-CNN14-AudioSet-LiteRT), [Zenodo 3987831](https://zenodo.org/record/3987831)) | **D** (attribution) | CNN14 is large (over 300 MB fp32); MobileNet variants are smaller | Similarity / energy. |
| OpenL3 | Code MIT; **weights CC BY 4.0** ([repo](https://github.com/marl/openl3)) | **B / D** with attribution | Tens of MB | Track-similarity embeddings for smart mix. |
| MusiCNN | ISC (repo; model licence not separately stated) ([repo](https://github.com/jordipons/musicnn)) | **B** (verify) | Small | Mood / genre tags. |
| CLAP (LAION) | Code CC0 ([repo](https://github.com/LAION-AI/CLAP)); `lukewys/laion_clap` tagged CC0 (about 1.86 GB checkpoints); `laion/clap-htsat-fused`, `laion/clap-htsat-unfused` and `laion/larger_clap_music` Apache-2.0 (all confirmed on HF); `Xenova/clap-htsat-unfused` has no tag but is a conversion of the Apache-2.0 unfused model | **D** | Big; quantised ONNX needed | Text-to-track search. Later. |
| MERT | **CC BY-NC 4.0**, confirmed on the v1-95M and v1-330M cards; the README was edited on 2023-06-02, consistent with the change from MIT ([HF](https://huggingface.co/m-a-p/MERT-v1-95M)) | **X** | | |

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
| LRCLIB | Confirmed free with no API key: "No API key is required, and anonymous API access remains available". Clients must identify themselves with a `User-Agent` (app name, version, homepage). Rate limits are approximate: ~45 req/min per IP for generic clients, ~90 for identified ones, ~180 for registered client-side apps (`Lrclib-App-Id`, safe to ship). Clients must honour `Retry-After` on 429/503. Optional registration also gives an "API authorization document (useful when submitting to app review)". The docs state no licence for the lyrics or the dump ([API docs](https://lrclib.net/docs.txt), [llms.txt](https://lrclib.net/llms.txt)); the terms page needs JavaScript and could not be read | **L** | Already opt-in (`online: false`) with a good User-Agent. Consider registering a client-side App ID before the store release. Do not bundle the dump. Fetch on demand, cache locally, and never redistribute lyrics files. |
| MusicBrainz | Core data CC0; supplementary data and live feed CC BY-NC-SA ([licence](https://musicbrainz.org/doc/About/Data_License)) | **L** | 1 request/s, User-Agent with contact details. |
| Cover Art Archive | API free; images remain the uploaders' / labels' copyright ([API](https://wiki.musicbrainz.org/Cover_Art_Archive/API)) | **L** | Display only; cache per user. |
| AcoustID | Free for **non-commercial** apps; commercial use through AcoustID OÜ ([site](https://acoustid.org)) | **L** (confirm OpenDJ qualifies) | Chromaprint is MIT, but the whole is LGPL-2.1 because of bundled FFmpeg code ([Debian copyright](https://sources.debian.org/src/chromaprint/1.6.0-2/debian/copyright)). Use the fpcalc binary on desktop only, or a permissive JS port. |
| Discogs API | Commercial use at Discogs' discretion; "Restricted Data" may not be used commercially; about 60 requests/min authenticated; monthly dumps are CC0 ([API ToU](https://support.discogs.com/hc/en-us/articles/360009334593)) | **L** | Prefer MusicBrainz. Use Discogs for genre/style only, with a user token. |

### 2.8 Royalty-free / CC music

| Source | Licence | Class | Notes |
|---|---|---|---|
| OpenGameArt CC0 music | CC0 per item | **B** | The Tricks & Traps pack has BPMs labelled. |
| HoliznaCC0 (FMA) | CC0, confirmed: *Winter Lofi* and *Orphaned Media* link CC0 1.0 ([Winter Lofi](https://freemusicarchive.org/music/holiznacc0/winter-lofi), [Orphaned Media](https://freemusicarchive.org/music/holiznacc0/orphaned-media)) | **B** | Avoid the *HoliznaPatreon* account, which is not CC0. Lofi, chiptune, synthwave. *Orphaned Media* "samples old forgotten songs in the public domain", and old recordings are not public domain everywhere, so prefer *Winter Lofi* for the crate. |
| Loyalty Freak Music (FMA) | CC0, confirmed per track: "Summer Pride by Loyalty Freak Music is licensed under a CC0 1.0 Universal License" ([track](https://freemusicarchive.org/music/Loyalty_Freak_Music/INSTRUMENTAL_RB_BEATS_TO_SING_OR_RAP_ON/Loyalty_Freak_Music_-_INSTRUMENTAL_RB_BEATS_TO_SING_OR_RAP_ON_-_17_Summer_Pride)) | **B** | Utility / beat tracks. |
| Komiku (FMA / OGA) | CC0 per track | **B with caution** | A user reported YouTube Content ID claims through "The Sound Project" ([FMA comment](https://freemusicarchive.org/music/Komiku/Captain_Glouglous_Incredible_Week_Soundtrack/mall_1328)). Avoid for store videos. |
| Kevin MacLeod / Incompetech | CC BY 4.0, confirmed ([FAQ](https://incompetech.com/music/royalty-free/faq.html)); the "some tracks 3.0" note is not on the current FAQ | **B** + attribution | Exact credit from the FAQ, on three lines with the real title in place of *Title*: `Title Kevin MacLeod (incompetech.com)` / `Licensed under Creative Commons: By Attribution 4.0` / `https://creativecommons.org/licenses/by/4.0/`. The credit must be easy to find; for games the FAQ names "a 'Credits' screen found in the settings menu", which fits OpenDJ's Settings → About. |
| Free Music Archive | Per track (many NC / ND) | **B** only for CC0 / BY / BY-SA tracks | |
| ccMixter | Per track; many BY-NC | **B** only for BY / BY-SA | |
| Jamendo | Mostly NC / ND for free use; commercial use through Jamendo Licensing | **X** (in practice) | |
| YouTube Audio Library | Standard licence covers YouTube videos only; some tracks are CC BY ([summary](https://licenseorg.com/guide/music-audio/youtube-audio-library)) | **X** to bundle | Fine for your own YouTube tutorial videos. |
| Pixabay Music | No standalone distribution | **X** | |
| Bensound | Free licence requires attribution and bans redistribution (⚠ still not verified: bensound.com was not on the reachable list) | **X** | |
| NCS | Use in your own content with credit; no redistribution | **X** | |

---

## 3. Shortlists

### 3.1 Sampler: recorded default bank (all CC0, from Sonic Pi; original Freesound IDs from its README)

*Checked 2026-11-21: every Freesound page listed below except `misc_cineboom` loads and shows the CC0 1.0 licence (vinyl_rewind, vinyl_backspin, vinyl_scratch, vinyl_hiss, bd_808, bd_haus, bd_klub, drum_heavy_kick, bass_drop_c, bass_hard_c, bass_trance_c, bass_dnb_f, sn_dub, sn_generic, hat_snap, hat_zap, hat_raw, loop_compus, loop_industrial, loop_garzul, loop_mika).*

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
| Impact | ~~`misc_cineboom`~~ → use a Kenney *Impact Sounds* file (CC0, confirmed) or keep the synthesised impact | Northern_Monkey 177242 now returns **404 on Freesound** (checked 2026-11-21), and `bass_hit_c` (oceanictrancer 211614) is also 404. Their only licence evidence is Sonic Pi's blanket CC0 statement, so **swap both out** rather than ship them |
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
| "Ascend" (130 BPM) | Tricks & Traps, [rhythm game pack 1](https://opengameart.org/content/free-rhythm-game-music-pack-1) | CC0 (⚠ OGA still unreachable; search excerpts show one CC0 licence for the whole submission and ten tracks at about 122–190 BPM) | Trance / techno |
| "Starting Over" (122 BPM) | Tricks & Traps (same pack) | CC0 | House tempo; the pack has more tracks with stated BPMs (DnB, house) |
| One electronic track from ["Electronic" by Alex McCulloch](https://opengameart.org/content/electronic) | Alex McCulloch | CC0 | Techno |
| One track from [Winter Lofi](https://freemusicarchive.org/music/holiznacc0/winter-lofi), e.g. "Winter Blues" or "Snow Drift" | HoliznaCC0 | CC0 (confirmed) | 70–90 BPM hip-hop / lofi, to show a tempo-range transition |
| One "R&B beats" track, e.g. ["Summer Pride"](https://freemusicarchive.org/music/Loyalty_Freak_Music/INSTRUMENTAL_RB_BEATS_TO_SING_OR_RAP_ON/Loyalty_Freak_Music_-_INSTRUMENTAL_RB_BEATS_TO_SING_OR_RAP_ON_-_17_Summer_Pride) | Loyalty Freak Music | CC0 (confirmed on the track page) | Vocal-free beat for stems demos |
| **"Raving Energy"** (122 BPM, 4:28; ISRC USUAN1900013) and **"Brain Dance"** (124 BPM, 3:35; ISRC USUAN2300006) | Kevin MacLeod | CC BY 4.0 | House-tempo electronic tracks that sit next to "Starting Over" (122) for a beatmatch demo; credit line in §2.8. BPMs from incompetech's own catalogue data ([pieces.json](https://incompetech.com/music/royalty-free/pieces.json)); measure them with OpenDJ anyway. Corrected: "Pamgaea" is 94 BPM and relaxed, so it is not a dance pick. A faster alternative is "Raving Energy (faster)" at 134 BPM. |

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
| BS/Mel-RoFormer and UVR weights | Licence not stated by the original authors; user-supplied URL only |
| All-In-One weights | Tagged MIT by the author, but the pipeline depends on HT-Demucs separation (§0.1); evaluation only |
| HT-Demucs weights **as a bundled file or store-build default** | Author: licence "not clear", research-only data; npm package: "personal and research use only". Opt-in download only (§0.1) |
| Vande Veire / dnb-autodj code | AGPL-3.0 (`COPYING.txt` in [lenvdv/dnb-autodj-3](https://github.com/lenvdv/dnb-autodj-3)); ideas only |
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
- **Key handling:** an open-source app cannot hide a key, and the API terms require keys to be kept secret and not shared with third parties (§0.4). Ship **bring-your-own-key only** (the user applies at freesound.org/apiv2/apply). Add a project key only if MTG agrees in writing.
- **Records and filters:** save `{id, username, license, url}` with every imported sample, and show it in Credits, together with a "Sounds from Freesound" credit (the terms ask you to "Credit Freesound and sound creators in accordance with the sounds' licenses"; there is no logo or "powered by" requirement). Allow CC-BY behind a toggle with auto-attribution. Always hide NC.
- **Limits (confirmed):** standard calls are limited to 60 requests per minute and 2,000 per day. Original-quality downloads, uploads, comments, ratings and bookmarks are limited to 30 per minute and 500 per day. Throttled requests get `429` ([API overview: Throttling](https://freesound.org/docs/api/overview.html#throttling)). With bring-your-own-key these limits apply per user. Do not register several keys to get around them. The UI should be "user downloads to their own library", never re-hosting.

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
- **Separation (changed 2026-11-21):** default to **UMX-HQ** on demand **on every platform**, not only phones, because the HT-Demucs weights are not MIT (§0.1). Keep HT-Demucs as an opt-in "High quality (personal and non-commercial use only)" download with corrected consent text, and never make it the default in store builds. Spleeter 2-stem is a second choice while its weight licence is unanswered. Set the model through the existing `stemsModelUrl` + SHA-256 mechanism; `stems-model.js` needs a "UMX" graph type (STFT and ISTFT outside the graph, as in the edgetools export), and the drums, bass and other stems must be exported, since edgetools publishes vocals only.

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
| Mixotic set / UnmixDB | 10 CC netlabel mixes plus their CC source tracks ([UnmixDB, Zenodo, CC BY 4.0](https://zenodo.org/record/1422385), [archive](https://archive.org/details/mixotic.net_202209)) | CC (variant unverified; zenodo.org unreachable on 2026-11-21) | Best candidate for redistributable test fixtures once the variant is confirmed |
| Ballroom, GTZAN, MUSDB18 | Classic benchmarks | Research only / unclear | Evaluation only |
| FMA dataset (Defferrard) | 106k CC tracks plus metadata | Metadata CC BY 4.0; audio per track | Development, and mining CC0 / BY demo tracks |

---

## 7. Feature ideas (inspiration only, no code taken)

- **Mixed In Key-style energy levels (1–10)** from the loudness, onset density and spectral centroid OpenDJ already computes, shown in the library and used by smart mix.
- **Practice / sandbox mode** (Serato Practice, VirtualDJ Sandbox): headphone-only pre-listen of the next transition while the master plays.
- **rekordbox Phrase colours** on the waveform, already supported by `PHRASE_TYPES`, plus **Track Separation**-style stem fader modes.
- **djay-style Neural Mix pads** (one tap: acapella, instrumental, drums only), **Crossfader FX** (formerly "Fade FX": an automated crossfade with Echo, Filter, Tremolo, Sweep, Riser or Neural Mix over a set number of bars ([djay manual](https://help.algoriddim.com/user-manual/djay-pro-mac/dj-tools/effects/crossfader-fx))) and a **Looper** that records 4/8/16-beat stem-aware loops into sampler pads.
- **Performance pad modes:** hot cue, loop roll, slicer, sampler, stems, beat jump and key change. Pad mode switching is already supported for MIDI.
- **Learn-to-DJ mode:** an interactive tutorial driven by the demo crate (beatmatch, phrase-align, EQ swap), with automix showing "ghost" fader moves.
- **Controller mappings:** the Mixxx repo (runtime fetch, as now) and community-shared OpenDJ presets under CC0.
- **DVS testing:** generate timecode with OpenDJ; use the vendors' control CDs locally only.

---

## 8. Verification log (2026-11-21)

Items that were flagged "not verified" were re-checked against primary sources once the hosts became reachable. **Status key:** *confirmed* means the text was right; *corrected* means the text was changed; *still unverified* gives the reason. "Search only" means the source was seen through search-result excerpts because its host was still unreachable.

| Item | Status | Source |
|---|---|---|
| **HT-Demucs weights licence (§0.1)** | **Corrected: not MIT.** The author says the licence "is not clear" (MusDB research-only data; the 6-stem model likely CC BY-NC). The npm `LICENSE.md` says "personal and research use only" (re-read). The HF `license: mit` tag was removed on 2026-08-31. **Recommendation changed:** UMX-HQ is the default; HT-Demucs is opt-in only; fix `server/stems.js` wording. | [adefossez/demucs README](https://github.com/adefossez/demucs#license), [demucs#327](https://github.com/facebookresearch/demucs/issues/327), [HF commits](https://huggingface.co/adefossez/HTDemucs/commits/main), [HF discussion 1](https://huggingface.co/adefossez/HTDemucs/discussions/1), npm `demucs@1.0.0` tarball |
| HRSadeghi/demucs-onnx | Confirmed: the card says the weights are CC BY-NC 4.0 (repo tagged MIT for code). | [card](https://huggingface.co/HRSadeghi/demucs-onnx) |
| UMX-HQ weights | Confirmed MIT (only UMX-L is NC). The ONNX export has vocals only. The Zenodo record was unreachable. | [README](https://github.com/sigsep/open-unmix-pytorch#license), [edgetools/umx-hq](https://huggingface.co/edgetools/umx-hq) |
| Spleeter weights | Still unverified: the README says only the code is MIT; issue #898 is open with no maintainer reply. | [README](https://github.com/deezer/spleeter#license), [#898](https://github.com/deezer/spleeter/issues/898) |
| Silero VAD | Confirmed MIT (LICENSE file); the CC BY-NC text is a stale badge alt-text. | [LICENSE](https://github.com/snakers4/silero-vad/blob/master/LICENSE) |
| PANNs weights | Confirmed CC BY 4.0; code licence corrected to Apache-2.0 per the LiteRT card (upstream file not fetched). | [LiteRT card](https://huggingface.co/litert-community/PANNs-CNN14-AudioSet-LiteRT) |
| MERT | Confirmed CC BY-NC 4.0. | [HF](https://huggingface.co/m-a-p/MERT-v1-95M) |
| CLAP checkpoints | Confirmed: `lukewys/laion_clap` CC0; fused, unfused and `larger_clap_music` Apache-2.0. | [HF fused](https://huggingface.co/laion/clap-htsat-fused), [unfused](https://huggingface.co/laion/clap-htsat-unfused), [lukewys](https://huggingface.co/lukewys/laion_clap) |
| All-In-One weights | Corrected: tagged MIT by the author, but the pipeline runs HT-Demucs. Evaluation only. | [taejunkim/allinone](https://huggingface.co/taejunkim/allinone) |
| LinkSeg | Still unverified: no upstream licence file; the ONNX port claims CC BY 4.0. | [repo](https://github.com/morgan76/LinkSeg), [port](https://huggingface.co/elicwhite/linkseg-7c-onnx) |
| COCOLA | Code MIT; checkpoint licence not stated; research-only training data. | [repo](https://github.com/gladia-research-group/cocola) |
| RoFormer mirrors | Unchanged: the mirror is tagged MIT; the original authors state nothing. | [AEmotionStudio](https://huggingface.co/AEmotionStudio/roformer-models) |
| BeatNet weights | Still unverified (not re-checked this pass). | — |
| Rubber Band, essentia.js | Confirmed: GPL-2.0+ or commercial; AGPL-3.0. Essentia *models*: still unverified (host unreachable). | [Rubber Band](https://github.com/breakfastquay/rubberband), [essentia.js](https://github.com/MTG/essentia.js/blob/master/LICENSE) |
| **Freesound API terms** | Corrected and expanded (§0.4, §5.3): non-commercial only; "commercial" is **not defined**; keys must not be shared or exposed (so no project key in an open-source app); bring-your-own-key fits the terms; credit Freesound and authors, with no "powered by" logo required; limits 60/min and 2,000/day, originals 30/min and 500/day. The developer's "commercial" remark (Google Groups) was not re-read. | [API terms](https://freesound.org/docs/api/terms_of_use.html), [tos_api](https://freesound.org/help/tos_api/), [throttling](https://freesound.org/docs/api/overview.html#throttling) |
| Sonic Pi samples | Confirmed CC0 on the Freesound pages for all shortlisted files; corrected: `misc_cineboom` and `bass_hit_c` pages return 404, so swap them out. | [Sonic Pi credits](https://github.com/sonic-pi-net/sonic-pi/blob/dev/etc/samples/README.md), Freesound pages in §3.1 |
| Kenney audio | Confirmed CC0. | [kenney.nl/support](https://kenney.nl/support) |
| Kevin MacLeod credit text | Confirmed, with exact wording in §2.8. "Some tracks 3.0" is not on the current FAQ. | [FAQ](https://incompetech.com/music/royalty-free/faq.html) |
| Kevin MacLeod titles and BPMs | Confirmed: "Raving Energy" 122 BPM, "Brain Dance" 124 BPM. Corrected: "Pamgaea" is 94 BPM. | [pieces.json](https://incompetech.com/music/royalty-free/pieces.json) |
| Tricks & Traps pack all CC0 | Still unverified: opengameart.org unreachable; search excerpts show one CC0 licence for the submission. | [OGA](https://opengameart.org/content/free-rhythm-game-music-pack-1) |
| HoliznaCC0 | Confirmed CC0 (*Winter Lofi*, *Orphaned Media*); note that *Orphaned Media* samples old public-domain songs. | [FMA](https://freemusicarchive.org/music/holiznacc0/winter-lofi) |
| Loyalty Freak Music | Confirmed CC0 ("Summer Pride"). | [FMA track](https://freemusicarchive.org/music/Loyalty_Freak_Music/INSTRUMENTAL_RB_BEATS_TO_SING_OR_RAP_ON/Loyalty_Freak_Music_-_INSTRUMENTAL_RB_BEATS_TO_SING_OR_RAP_ON_-_17_Summer_Pride) |
| Komiku Content ID status | Still unverified (not re-checked). | — |
| Mixotic / UnmixDB CC variant | Still unverified: zenodo.org unreachable. | — |
| LRCLIB | Confirmed: free, no key, User-Agent required, approximate rate limits, optional app registration. No licence stated for lyrics or dumps; the terms page needs JavaScript. | [docs.txt](https://lrclib.net/docs.txt) |
| djay features (§7) | Confirmed: Neural Mix stem controls and crossfaders; the manual has a Looper page (contents not re-read). Corrected: "Fade FX" is now called **Crossfader FX**. | [help.algoriddim.com](https://help.algoriddim.com/user-manual/djay-pro-mac/dj-tools/effects/crossfader-fx) |
| VirtualDJ Sandbox (§7) | Confirmed (search only). | [manual](https://virtualdj.com/manuals/virtualdj/interface/topsection/appcontrols/sandbox.html) |
| Bensound, Sonniss, Mixkit terms | Still unverified, from secondary summaries; all excluded anyway. | — |
| capacitor-midi-device maturity; signalsmith vs Bungee listening test | Still open: these need hands-on testing, not a source check. | — |
| Ableton name licensing | Unchanged: secondary sources plus Ableton's trademark page. | [guidelines](https://ableton.com/ja/legal/branding-trademark-guidelines) |
| Sizes marked "about" | Approximate by design. | — |
