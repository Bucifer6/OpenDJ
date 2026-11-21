# OpenDJ Intelligent Automix and Auto-Mashup Plan

*Suggested path: `docs/INTELLIGENT_AUTOMIX_PLAN.md`. Status: proposal. Based on reading `public/js/automix.js`, `smartmix.js`, `audio/analysis-core.js`, `audio/deck.js`, `audio/worklets.js`, `audio/engine.js`, `stems/*`, `server/stems.js`, `shared/settings-schema.js`, `docs/GAP_ANALYSIS.md` and `docs/MOBILE.md` (v0.4.0).*

*Flagged items re-checked against primary sources on 2026-11-21; see the verification log in §15. The most important result: **the HT-Demucs weights are not MIT-licensed** (the author says their licence "is not clear" and research-only data went into them), so the plan now treats Open-Unmix UMX-HQ as the default stems model and HT-Demucs as an opt-in personal-use download (§1.3, §14).*

**Core requirement (owner):** *"It should all be smart, based on playlist, library or play queue."* Nobody has to pick a genre or crowd mode. The automix infers the right behaviour from what it is given: the pool or queue, the library or search results, the tracks' tags and audio, the track playing now and recent history. It keeps adapting at every transition and every part of the set. Manual overrides exist but are never required.

---

## 1. Research summary

### 1.1 How skilled DJs mix

**Phrasing.** Dance and pop music is built in 16- and 32-beat phrases, and producers add or remove elements on phrase boundaries. DJs therefore start tracks and make EQ moves on those boundaries ([DJ TechTools](https://djtechtools.com/2014/11/16/how-to-dj-101-why-you-must-understand-phrasing/), [Mixed In Key](https://mixedinkey.com/Book/Control-The-Energy-Level-Of-Your-DJ-Sets), [Native Instruments](https://www.native-instruments.com/blogs/blog/phrase-mixing)). The standard teaching: match gain with the EQ flat, cut the incoming low, start on phrase 1, swap the bass on the next phrase line (for example bar 9 of 16, or halfway through an 8-bar mix), then take the outgoing highs and mids out before its fader ([Digital DJ Pool](https://digitaldjpool.com/blog/dj-eq-mixing-for-beginners/), [Cursa EQ blends](https://cursa.app/en/page/dj-mixing-foundations-eq-use-for-smooth-blends), [Digital DJ Tips: five transitions](https://www.digitaldjtips.com/the-only-five-dj-transitions-youll-ever-need/)).

**Three-band handoff.** Lows are handed over on a phrase line. Mids are handed over slowly, because they hold vocals and harmony. Highs can overlap for a long time. Two basslines at once, or two vocals at once, cause mud ([Digital DJ Tips: muddy mixes](https://www.digitaldjtips.com/?p=2799689)). With stems, DJs now switch off the incoming bass stem instead of cutting its EQ ([Digital DJ Tips](https://www.digitaldjtips.com/?p=2799660)).

**Filter and echo transitions** hide busy or clashing material. The echo-out on the last beat, followed by the new track on the 1, is the standard reset for tempo or genre changes ([NI DJ transitions](https://www.native-instruments.com/blogs/blog/dj-transitions), [Crossfader: 12 transitions](https://wearecrossfader.co.uk/blog/12-high-energy-dj-transitions/)).

**Tempo across genres:**
- echo-out, then drop in at the new tempo;
- halftime and double-time bridges (87 ↔ 174);
- 3:4 loop tricks (130 is three-quarters of 173);
- gradual tempo creep across a set;
- tempo-fader ramps during long blends.

Sources: [MusicRadar](https://www.musicradar.com/news/5-ways-to-change-tempo-in-your-dj-set), [Digital DJ Tips](https://www.digitaldjtips.com/7-insider-tips-making-exciting-tempo-changes-djing/), [Long & McQuade](https://www.long-mcquade.com/blog/996/DJing-With-Tempo-Changes-and-Metric-Modulation.htm).

**Harmonic mixing.** These moves work:
- same key, ±1 or relative;
- +2 "energy boost", used sparingly ([Mixed In Key](https://mixedinkey.com/workflows/change-energy-with-camelot-wheel/), [Advanced](https://mixedinkey.com/Book/Use-Advanced-Harmonic-Mixing-Techniques/));
- +7 (equivalently −5), which is a semitone up ([DJ TechTools](https://djtechtools.com/2013/12/20/advanced-key-mixing-techniques-for-djs/)).

**Energy and set arcs.** Warm-up, build, peak, cool-down; no sudden jumps or energy holes.

**Genre notes:**
- **Drum & bass.** Double drops (two drops hit together; needs exact phrase alignment and bass management). Short blends ("cut after 8 bars if it isn't working"). 174 BPM is often detected as 87 ([Crossfader DnB](https://wearecrossfader.co.uk/blog/howtomixdnb/), [NI DnB](https://www.native-instruments.com/blogs/blog/drum-and-bass)).
- **Hip-hop and open format.** Quick cuts on the 1, short blends, acapella over instrumental (compatible key, within about 5 BPM), sample and wordplay links ([Crossfader hip-hop](https://wearecrossfader.co.uk/blog/how-to-mix-hip-hop/), [Digital DJ Tips acapellas](https://www.digitaldjtips.com/how-to-dj-with-acapellas/)).
- **Latin.** Reggaeton bridges hip-hop, dancehall and moombahton ([Bonedo](https://www.bonedo.de/?p=615804)). Salsa and bachata are often played in genre blocks, and bar counting is harder ([Digital DJ Tips forum](https://www.digitaldjtips.com/over-to-you-struggling-to-mix-latin-music)).

**What sounds bad:**
- vocal on vocal; bass on bass;
- mid-range key clash;
- an off-phrase entry or a vocal cut mid-sentence;
- an energy hole; a loudness jump;
- key-lock artefacts beyond about ±5–6 %, which vocals show first ([Digital DJ Tips](https://www.digitaldjtips.com/?p=2183461), [DJ.Studio](https://help.dj.studio/en/articles/14653141-pitch-modes-presets-and-formant-correction)).

### 1.2 Commercial automix and AI DJ features

| Product | Publicly documented | Notes |
|---|---|---|
| **djay (Algoriddim)** | Automix AI with automatic or manual start and end points. Transitions include Filter, Echo, Tremolo, Riser, Dissolve and Neural Mix. **Neural Mix crossfades pairs of stems separately so vocals and harmonies don't clash** ([MusicTech](https://musictech.net/news/gear/algoriddim-free-dj-software-djay-pro-ai-automix-and-neural-mix/), [DJ Mag](https://djmag.com/news/new-djay-ai-ios-adds-improved-ai-mixing), [VentureBeat](https://venturebeat.com/business/algoriddims-djay-pro-ai-can-transfer-vocals-and-rhythms-between-songs)). Core ML / Neural Engine ([9to5Mac](https://9to5mac.com/2021/05/06/djay-pro-ios-update-taps-apple-neural-engine/)). **Official manual:** "Powered by AI, Automix analyzes tracks and selects smooth transition points"; settings are Transition (an "Automatic" option picks a type at random, like a shuffle), Duration (bars, seconds or Automatic), Tempo adjust (Off, Sync, Sync + Tempo Blend, or Automatic, which matches BPM only when the difference is noticeable and otherwise holds the playing track's BPM), and Song range (automatic or manual start/end points, honour existing track markers, maximum play time per song). "Mix Now" finds "the earliest suitable blend point"; "Matching Songs" suggests the next track ([Using Automix](https://help.algoriddim.com/user-manual/djay-pro-mac/mixing-basics/using-automix), [Android settings](https://help.algoriddim.com/user-manual/djay-android/settings/automix)). Neural Mix crossfaders "blend or swap individual stems" between decks, and you choose how many stems to crossfade; the stems are drums, harmonics and vocals (bass as well for FX routing); a Neural Mix EQ mode maps Low/Mid/High to Drums/Harmonics/Vocals; Mute FX adds a 1, ¾ or ½-beat echo tail when a stem is muted ([overview](https://help.algoriddim.com/user-manual/djay-pro-mac/neural-mix/overview), [crossfaders](https://help.algoriddim.com/user-manual/djay-pro-mac/neural-mix/crossfaders)). The automated FX transition is now called **Crossfader FX** (Echo, Filter, Tremolo, Sweep, Riser, Neural Mix; length in bars) ([Crossfader FX](https://help.algoriddim.com/user-manual/djay-pro-mac/dj-tools/effects/crossfader-fx)). | ⚠ *How* the AI picks points is still not documented; the manual only says it "analyzes tracks". |
| **rekordbox** | Phrase analysis; **Mix Point Link** (6.7.0) ([FAQ](https://rekordbox.com/en/support/faq/mixpoint-link-6)); **Vocal Position Detection** (deep learning with Qosmo, 6.0.1; can be fooled by vocal-like sounds) ([MusicRadar](https://www.musicradar.com/news/pioneer-djs-new-rekordbox-update-makes-it-easy-avoid-vocal-clashes-in-your-mixes), [Qosmo](https://qosmo.jp/en/r-and-d/pioneer-dj-rekordbox)). | Vocal maps avoid clashes without stems. |
| **Serato** | Real-time Stems ([MusicRadar](https://www.musicradar.com/news/serato-dj-stems-audio-separation)). **Auto Play** loads and plays the next track in the selected crate when the current one ends, with no crossfade ([Serato support](https://support.serato.com/hc/en-us/articles/224859147-Software-Overview-DJ-Pro-3-0)). | No automix that blends tracks. Source seen through search results only; support.serato.com was not reachable. |
| **VirtualDJ** | Automix "Smart" type; Automix Editor per pair; single or dual deck ([manual](https://virtualdj.com/wiki/Automix.html)); real-time stems ([VirtualDJ](https://virtualdj.com/products/virtualdj/)). **Sandbox** is a "test" mode for rehearsing the upcoming mix in the headphones while the audience keeps hearing the playing track; it needs a Master + Headphones setup and does not work in the middle of a mix ([manual](https://virtualdj.com/manuals/virtualdj/interface/topsection/appcontrols/sandbox.html)). | Sandbox confirmed from the official manual page (seen through search results; virtualdj.com was not reachable). |
| **Traktor Pro 4** | Background stem generation ([comparison](https://thedjmixtape.com/virtualdj-stems-vs-serato-stems-vs-rekordbox-stems/)). Its automix is **Cruise Mode**: it plays through a playlist, with Auto Crossfade Time set in Preferences > Mixer (0–100 s) and optional fade-in/out markers ([NI support](https://support.native-instruments.com/support/solutions/articles/69000879534-traktor-using-the-traktor-cruise-mode-for-automatic-playback-of-your-tracks)). | Corrected: the feature is "Cruise Mode", not "Autoplay". Source seen through search results; native-instruments.com was not reachable. |
| **Mixed In Key Mashup 2** | Harmonic sorting from a seed track; grids; vocal stretch ([Digital DJ Tips](https://www.digitaldjtips.com/mixed-key-mashup-2-0-makes-dj-re-edits-easier-ever/), [ask.audio](https://ask.audio/articles/review-mashup-2-by-mixed-in-key)). | A finder, not an automatic maker. |
| **Spotify Mix** | Beta August 2025: automatic or custom fade, rise and blend; EQ and FX; key and BPM shown ([TechCrunch](https://techcrunch.com/2025/08/19/spotifys-latest-feature-lets-you-add-your-own-transitions-to-playlists), [Android Authority](https://www.androidauthority.com/spotify-playlists-custom-transitions-3588565/)). | Spotify's newsroom still calls it a beta; rollout to eligible Premium users on desktop was announced in May 2026 ([Spotify newsroom](https://newsroom.spotify.com/tag/playlist-mixing)). Seen through search results only. |
| **Apple Music AutoMix** | iOS 26 time-stretch and beat-match; trims silence; AirPlay from 26.1. **Albums and some genres are left untransitioned**, a simple form of context inference ([MacRumors](https://www.macrumors.com/2025/06/12/ios-26-automix-apple-music/), [9to5Mac](https://9to5mac.com/2025/06/16/automix-apple-music-ios-26/)). | |
| **Pacemaker** | Early AI DJ (Spotify from 2014). Acquired by Tuned Global 2023; app closed June 2023 ([DJ.Studio](https://dj.studio/blog/pacemaker-app-alternative), [CMU](https://archive.completemusicupdate.com/article/pacemaker-dj-app-to-directly-license-music-after-spotify-drops-api-access/)). | |
| **2025–26** | No vendor ships a generative AI DJ that makes mashups. The state of the art is rule-based automix plus stems and phrase or vocal maps ([DJ.Studio](https://dj.studio/blog/ai-mixing-apps)). | DJ.Studio is a competitor. |

**Takeaway:** nobody publicly combines phrase and vocal maps, stem-pair crossfades, clash scoring, explanations, **automatic context inference** and live mashups. That combination is the opportunity for OpenDJ.

### 1.3 Research literature

**Automatic DJ systems:**
- **Vande Veire & De Bie 2018**, drum & bass automatic DJ ([EURASIP](https://link.springer.com/article/10.1186/s13636-018-0134-8), [code](https://github.com/lenvdv/dnb-autodj-3), [blog](https://lenvdv.github.io/2018-03-20-autodj)). Beats, then downbeats, then structure; cue points; style-based selection; EQ. **Three transition types, named in the code: "double drop", "rolling" and "relaxed"**. Fade lengths are 16 bars in and 16 out, except a 32-bar fade-out for double drops. The next type is drawn from fixed probabilities: after relaxed, 0.7 rolling and 0.3 double drop; after rolling or double drop, 0.8 rolling and 0.2 relaxed. The code also includes a simple vocal-clash predicate ([`tracklister.py`](https://github.com/lenvdv/dnb-autodj-3/blob/master/src/autodj/dj/tracklister.py)). The code is **AGPL-3.0** (`COPYING.txt`), so take ideas only and never copy it. 91 % fully correct annotations; rated high quality by 18 fans (⚠ these two figures still come from the abstract as quoted in search results: link.springer.com, the SpringerOpen mirror and the blog were all unreachable, and there is no arXiv copy).
- **Mosaikbox** (Sowula & Knees, ISMIR 2024): precise beat grids, segmentation, multi-faceted similarity, rule-based stem removal that significantly improves perceived quality ([poster](https://ismir2024program.ismir.net/poster_261.html), [thesis](https://repositum.tuwien.at/handle/20.500.12708/212628)). **Vocal rule (verified in the paper PDF):** vocal segments come from the HT-Demucs vocal stem, split at "silent" stretches of at least 1 s below −40 dBFS, with segments shorter than 400 ms dropped. Two excerpts clash if their vocals overlap for more than 2 s during the transition; the playing song's vocals are then attenuated. The drum stem is modified when rhythmic compatibility is below 0.95 ([paper PDF](https://repositum.tuwien.at/bitstream/20.500.12708/212628/1/Sowula-2024-Mosaikbox%20Improving%20Fully%20Automatic%20DJ%20Mixing%20Through%20Rule-ba...-vor.pdf), §3.4). These are good starting values for OpenDJ's T2 vocal gate.
- **DJtransGAN** (ICASSP 2022): differentiable EQ and fader trained with a GAN ([arXiv 2110.06525](https://arxiv.org/abs/2110.06525)).

**Real DJ mixes:**
- Kim et al., ISMIR 2020: 1,557 mixes and 20,765 transitions; cue points, lengths, tempo changes ([arXiv 2008.10267](https://arxiv.org/abs/2008.10267), [code](https://github.com/mir-aidj/djmix-analysis)).
- Kim, Yang & Nam, DAFx 2022: fader and EQ estimation; 5,040 mixes and 50,742 transitions ([PDF](https://mac.kaist.ac.kr/pubs/KimYangNam-dafx2022.pdf)).
- UnmixDB ([Zenodo](https://zenodo.org/records/1422385), [HAL](https://hal.archives-ouvertes.fr/hal-02172427)).
- These supply default priors; no dataset ships.

**Mashups:**
- **AutoMashUpper** (Davies et al., TASLP 2014): *local* section-level mashability combining harmonic, rhythmic and spectral fit after key and tempo adjustment ([PDF](https://staff.aist.go.jp/m.goto/PAPER/IEEETASLP201412davies.pdf)).
- Lee et al., ISMIR 2015 ([PDF](https://www.ismir2015.uma.es/articles/302_Paper.pdf)); Huang et al., AAAI 2021 stem compatibility ([arXiv 2103.14208](https://arxiv.org/abs/2103.14208)); **COCOLA** (ICASSP 2025) ([arXiv 2404.16969](https://arxiv.org/abs/2404.16969)). COCOLA's code is MIT ([repo](https://github.com/gladia-research-group/cocola)). Its checkpoint is a Google Drive link with no separate licence, and the models were trained on MUSDB18-HQ, MoisesDB, Slakh2100 and CocoChorales, whose terms include research-only data. Use it for offline evaluation only.
- **AutoMashup 2025**: compatibility is asymmetric; CLAP and MERT fail to reproduce coherence; pairwise scoring is O(n²) ([arXiv 2508.06516](https://arxiv.org/abs/2508.06516)).

**Beats and structure:**
- **Beat This!** (ISMIR 2024, MIT code and weights; main model about 78 MB per checkpoint, small about 8.1 MB per checkpoint; parameter counts of about 20 M and 2 M not re-checked) ([README](https://github.com/CPJKU/beat_this#license), [PyPI](https://pypi.org/project/beat-this/)). The README warns that "some of the training files are fully copyrighted or under limited Creative Commons licenses". Runs in onnxruntime-web on WebGPU ([musetric/beat-this-onnx](https://huggingface.co/musetric/beat-this-onnx), tagged MIT).
- **All-In-One** (WASPAA 2023; needs demixed input) ([arXiv 2307.16425](https://arxiv.org/abs/2307.16425)). Code is MIT; the author's weight repo [`taejunkim/allinone`](https://huggingface.co/taejunkim/allinone) is tagged `license: mit`, with no other text. It was trained on Harmonix Set, and its pipeline runs **HT-Demucs** first (`demucs_model: 'htdemucs'` in `config.py`). In practice it inherits the HT-Demucs weight problem (§1.3 Separation), so it stays an evaluation reference.
- **LinkSeg** ([poster](https://ismir2024program.ismir.net/poster_405.html), [ONNX](https://huggingface.co/elicwhite/linkseg-7c-onnx)). The ONNX port declares the weights **CC BY 4.0** (attribution required) and its glue code MIT. The upstream repo [morgan76/LinkSeg](https://github.com/morgan76/LinkSeg) has **no licence file**, so the CC BY claim is the porter's (it probably comes from the ISMIR paper's CC BY licence). ⚠ Treat it as unclear until the authors confirm; evaluation only.
- madmom models are CC BY-NC-SA, so excluded ([README](https://raw.githubusercontent.com/CPJKU/madmom/main/README.rst)).
- Odd meters: *Tracking the "odd"* (ISMIR 2014) ([PDF](https://archives.ismir.net/ismir2014/paper/000265.pdf)); beat datasets are biased to 4/4 ([arXiv 2502.12972](https://www.arxiv.org/pdf/2502.12972)).

**Key:** CNN key estimation ([arXiv 1706.02921](https://arxiv.org/abs/1706.02921), [ISMIR 2018](https://ir.webis.de/anthology/2018.ismir_conference-2018.35)). ⚠ No MIT weights found.

**Vocal activity:** Schlüter CNN (~1.4 M params; distilled students much smaller) ([arXiv 2011.04297](https://arxiv.org/pdf/2011.04297)); 800 ms median smoothing ([arXiv 1806.01180](https://arxiv.org/pdf/1806.01180)).

**Separation:**
- HT-Demucs is what OpenDJ ships. **Corrected: its code is MIT, but the weights are not.** The author's own README says: "The license of the weights is not clear: MusDB contains some data that were only usable for research purpose… The 6 source variant of htdemucs was trained only on Meta internal dataset, which likely means CC-NC-BY license is applicable" (added 2026-10-26) ([adefossez/demucs README](https://github.com/adefossez/demucs#license)). In 2022 he wrote that "the model weights are not covered by the MIT license, and are provided only for scientific purposes" ([facebookresearch/demucs#327](https://github.com/facebookresearch/demucs/issues/327)). The npm `demucs@1.0.0` package OpenDJ downloads says "personal and research use only". The `license: mit` tag on [adefossez/HTDemucs](https://huggingface.co/adefossez/HTDemucs) was removed on 2026-08-31, and the [discussion asking about it](https://huggingface.co/adefossez/HTDemucs/discussions/1) has no reply from the author. WebGPU builds exist ([htdemucs-6s-webgpu](https://huggingface.co/kramp/htdemucs-6s-webgpu-onnx), [demucs-web](https://github.com/timcsy/demucs-web)), but their MIT tags cover the export code, not Meta's weights.
- **Default instead: Open-Unmix UMX-HQ.** sigsep's README licenses the project MIT and carves out only UMX-L as "non-commercial use (CC BY-NC-SA 4.0)" ([open-unmix-pytorch](https://github.com/sigsep/open-unmix-pytorch#license)). An ONNX export of the vocals stem, 17 MB and tagged MIT, exists ([edgetools/umx-hq](https://huggingface.co/edgetools/umx-hq)); export the other three stems from the same weights. Caveat: it was trained on MUSDB18-HQ, the same dataset Défossez flags, so the risk is lower than HT-Demucs but not zero. Quality is clearly lower than HT-Demucs (UMX-HQ vocals SDR 6.25 dB per its README), which is fine for vocal-activity maps and gates. Spleeter is weaker: its README says only "the code" is MIT, and the weights question ([deezer/spleeter#898](https://github.com/deezer/spleeter/issues/898)) is still open with no maintainer answer.
- Light candidates: Band-SCNet (2.59 M params, 7.79 dB SDR) ([Interspeech 2025](https://www.isca-archive.org/interspeech_2025/yang25d_interspeech.html)), RT-STT ([arXiv 2511.13146](https://arxiv.org/abs/2511.13146)). ⚠ Code and licence still not checked (no time this pass).

**Embeddings:**
- CLAP audio tower via transformers.js (~118 MB) ([Xenova](https://huggingface.co/Xenova/clap-htsat-unfused)). Both `laion/clap-htsat-fused` and **`laion/clap-htsat-unfused` are Apache-2.0** on their model cards ([fused](https://huggingface.co/laion/clap-htsat-fused), [unfused](https://huggingface.co/laion/clap-htsat-unfused)). The Xenova ONNX conversion carries no licence tag but says it is a conversion of `laion/clap-htsat-unfused`, so Apache-2.0 applies; keep the notice. The music-tuned `laion/larger_clap_music` is also Apache-2.0 ([card](https://huggingface.co/laion/larger_clap_music)) and is worth testing for the niche-genre problem in §5.
- **MERT CC BY-NC 4.0** (confirmed on the card; [HF](https://huggingface.co/m-a-p/MERT-v1-95M)) and **Essentia models CC BY-NC-SA** ([Essentia](https://essentia.upf.edu/models.html); ⚠ essentia.upf.edu was not reachable for re-checking) are excluded.

**Stretching:** **Signalsmith Stretch** MIT with WASM ([npm](https://npmjs.com/package/signalsmith-stretch)). Confirmed: Rubber Band is GPL-2.0-or-later or commercial, and its README says it "may not legally distribute through any Apple App Store" without a commercial licence ([README](https://github.com/breakfastquay/rubberband#licence)). essentia.js is AGPL-3.0 ([LICENSE](https://github.com/MTG/essentia.js/blob/master/LICENSE), npm `license: AGPL-3.0`). Both are excluded.

**Feasibility:**

| Item | Desktop | Phone (Capacitor) |
|---|---|---|
| DSP analysis, style features, inference | Worker: fine | Worker: fine |
| Beat This! small | WASM or WebGPU | WASM opt-in while charging ⚠ speed unmeasured |
| Stems (UMX-HQ default; HT-Demucs opt-in) | Yes | No; use stems synced from desktop or a future small model |
| CLAP | Optional | No |
| WebGPU | Chrome / Electron | Android Chrome 121+ ([web.dev](https://web.dev/blog/webgpu-supported-major-browsers)); Safari on iOS 26 has WebGPU on by default and `navigator.gpu` needs iOS 26 or later ([WebKit bug 299237](https://bugs.webkit.org/show_bug.cgi?id=299237)). An Apple forum answer says WKWebView gets it once it is on by default ([Apple forum](https://developer.apple.com/forums/thread/770862)), and there is one report of a GPU-process crash in WKWebView on iOS 26.4 ([forum](https://developer.apple.com/forums/thread/822200)). ⚠ No official WKWebView statement; test on a device. Sources seen through search results; Apple and WebKit hosts were not reachable. |

### 1.4 Mashup rules of thumb
- **Key:** same, relative or ±1 with no shift; otherwise shift the vocal by at most ±2 semitones (±3 hard limit).
- **Tempo:** vocal stretch at most about ±6 % live (WSOLA), about ±10–12 % offline with a phase vocoder. Half and double time allowed.
- **Structure:** a vocal phrase over an equal-or-longer instrumental phrase, downbeat-aligned, with the pickup handled. Hook over drop or chorus; verse over instrumental verse; never vocal over vocal.
- **Mix:** high-pass the acapella at about 120–150 Hz; carve 300 Hz–4 kHz on the instrumental by −2 to −4 dB, or sidechain-duck it 1–3 dB; vocal about 0 to +2 LU over the instrumental.
- **Legal:** mashups of copyrighted recordings are personal use only; no sharing or redistribution.

---

## 2. Today's OpenDJ and the gaps

**Already in place:**
- `automix.js`: 10 styles plus Auto (`pickStyle`), `planMixOut`, `incomingStart`, `phraseSwapPoint`, `mixLevels`, drop styles on wall-clock timing, tempo jumps over 8 % fall back to echo or cut, tempo restore, overrides, live and smart queue, `userLoad`.
- `smartmix.js`: weighted scoring, beam search, `liveNext`, `explain()`, **manual** set shapes and slider presets.
- `analysis-core.js`: ACF/fold constant BPM grid, Krumhansl key (confidence not stored), RMS "loudness", energy 1–10, waveform-only phrases with 4/4 assumed, mixIn and mixOut, auto cues.
- Stems: HT-Demucs per track, desktop only; per-stem worklet gains. (The weights are not MIT, and `server/stems.js` `DEFAULT_MODEL.licence` wrongly says they are; see §1.3 and §14.)
- Engine: LR8 isolator EQ, filter, beat FX with post-fader tails, WSOLA key lock, brake and backspin, loops, `keySyncTo` up to ±6 semitones; BS.1770 `integratedLoudness` exists in `sampler.js`.

| # | Gap | Where |
|---|---|---|
| G1 | Transitions run on the UI clock (rAF plus 50 ms interval, `performance.now()`, per-frame `ch.set`); drops start with a main-thread `inn.play()`. | automix.js, deck.js |
| G2 | Automix re-applies its levels every tick, so the user can't take over mid-transition. | `stepTransition` |
| G3 | Only the outgoing side is planned; the incoming track always starts at its first downbeat. | `planTransition`, `incomingStart` |
| G4 | No vocal awareness; stems never used by automix. | automix.js |
| G5 | Coarse waveform-only sections; constant grid; 4/4 assumed. | analysis-core.js |
| G6 | `camelotCompatible` (Key Sync, `keysClash`) disagrees with `camelotRelation`; semitone-down missing; key confidence not saved; one global key. | analysis-core.js, smartmix.js |
| G7 | Approximate loudness; fixed fader level. | `loudness()` |
| G8 | Hard-coded curves; no plan model, preview, scoring or rehearsal. | automix.js |
| G9 | No tempo bridges or ramps across the blend. | automix.js |
| G10 | Selection ignores sections, vocals, groove and learning. | smartmix.js |
| G11 | No vocal map on phones. | MOBILE.md |
| G12 | No rendered-mix quality metrics. | test/, scripts/ |
| G13 | No handling of meter or tempo drift (Romanian folk, live bands, aksak, doina). | analysis-core.js |
| **G14** | **Behaviour is set by hand.** The user picks style, shape and slider preset (`settings.automix.style/shape/preset`). Nothing infers context from the playlist or queue, and nothing adapts technique per genre pair beyond `pickStyle`'s tempo, key and energy rules. | automix.js, smartmix.js, settings-schema.js |

---

## 3. Vision and principles

1. **Smart by default.** The automix *infers* the event, the crowd intent and the style of each block and each track from what it is given, and adapts per transition. No mode picking.
2. **Sounds like a skilled human DJ.** Phrase-correct, three-band or stem handoffs, technique matched to the styles on both sides.
3. **Never embarrassing.** Hard gates: no vocal-on-vocal, bass-on-bass, off-phrase entry, mid key clash, energy hole or loudness jump. When nothing safe exists, fall back to a clean echo-out or cut.
4. **Explainable**, both about what was inferred ("Detected: Romanian wedding set (0.82): hora block next, quick cuts") and about each transition.
5. **Overridable, never required.** One-tap correction of any inference; optional manual style override; instant per-control manual takeover.
6. **Offline and private.** All analysis, inference and learning on the device; playlist names and history never leave it.
7. **Runs everywhere and degrades gracefully:**
   - **T0**: DSP only;
   - **T1**: plus small ONNX models;
   - **T2**: plus stems;
   - **T3**: plus offline render.
8. **Open licences only** (MIT, BSD, Apache or equivalent) for code and weights.

---

## 4. Analysis upgrades (P0)

All features go into a compact **beat-synchronous feature track** (binary `ODJF` blob, versioned). It is stored through a new `PUT/GET /api/tracks/:id/features` route on the server and the local backend on mobile. Size is about 2–8 KB per track.

| Feature | Method | Model / DSP | Cost (5-min track) | Where | Accuracy target |
|---|---|---|---|---|---|
| **Beats and downbeats v2** | Current DSP grid by default; optional **Beat This! small** beat array; `tempoMap` when drifting (beat-interval CV over 1.5 %); **meter** estimate (2, 3 or 4 beats per bar, plus an aksak flag). | DSP / ONNX (MIT, ~10 MB) | DSP 0.3 s; NN ⚠ est. 2–6 s WASM, ~1 s WebGPU | analysis worker / ORT worker (reuse the stems ORT loader) | F ≥0.90 beats, ≥0.75 downbeats; drift-flag precision ≥0.9 |
| **Sections v2** (intro, verse, chorus/hook, build, drop, breakdown, bridge, outro) | Novelty on a multi-feature matrix (3-band energy, chroma, timbre-lite, vocal probability, bass presence) plus chroma repetition; snap to 4/8/16-bar lines (meter-aware); label rules. Optional LinkSeg later. | DSP | 0.5–1 s | worker | boundaries ±1 bar ≥0.75; label agreement ≥70 % |
| **Vocal activity per beat** | T2: vocal-stem RMS with hysteresis and median smoothing. T0/T1: tiny VAD CNN (⚠ open training data needed) or a harmonic mid-band heuristic with confidence. | stems / ONNX / DSP | 50 ms / 1 s | worker | stems F ≥0.9; heuristic ≥0.75 |
| **Section energy and spectrum** | Per bar: 4-band energy matching the isolator crossovers (200 / 2500 Hz), onset density, kick presence, **bass presence**. | DSP | 0.3 s | worker | — |
| **Loudness** | Move BS.1770 `integratedLoudness` from `sampler.js` to `audio/loudness.js`: integrated, short-term per bar, LRA, true-peak estimate; trim target −14 LUFS. | DSP | 0.4 s | worker | ±0.5 LU |
| **Key confidence and changes** | Store `keyConfidence`; key every 16 bars → modulation flags; tuning estimate; bass-weighted chroma. | DSP | 0.3 s | worker | weighted ≥0.70 ⚠ baseline unmeasured |
| **Groove fingerprint** | 16-step onset pattern × 3 bands (kick, snare/clap, hats) plus swing and ternary-feel score. | DSP | 0.2 s | worker | — |
| **Style features** (for §5) | ~40-d vector: BPM, meter flags, groove, swing, ternary feel, energy mean and variance, vocal density, bass presence, spectral centroid and contrast, section contrast, LUFS, LRA, key confidence, duration, intro and outro lengths. | DSP | ~10 ms (derived) | worker | — |
| **Mixable and loopable regions** | Derived: ≥8 bars of stable beat with no vocal (low bass for blend-in); loopable 4/8-bar spans with high self-similarity. | derived | 10 ms | worker | — |
| **Embeddings (optional, T2)** | CLAP-fused (Apache-2.0) 512-d mean, used for similarity and zero-shot style hints, **not** for mashability. | ONNX ~118 MB | ⚠ 1–3 s WebGPU | ORT worker | ≥ tag baseline |

**Pipeline:**
- `analysis-worker.js` runs `analyzeTrack` then `analyzeFeatures`.
- `background-analysis.js` adds a second stage (NN passes, vocal map when stems finish).
- On T2, automix asks for stems for the **next 2 queued tracks** (opt-in).

---

## 5. Context inference: the "smart" layer (P2 core, refined in P3)

### 5.1 Inputs
- **Pool:** the queue, playlist, library view or search results passed to automix. Also its **source metadata**, used only on the device as a weak hint: playlist name ("Nuntă Ana & Mihai", "Techno Friday"), smart-playlist rule, media-server playlist name.
- **Tracks:**
  - tags: genre, grouping, comment, year, label, language; Romanian diacritics in titles or artists as a language hint; lyrics language if the lyrics module has them;
  - analysis: BPM, meter flags, style features, sections, vocal density, groove, energy, LUFS;
  - optional embeddings.
- **Live context:** the track playing now, recent history (`history.js` sessions), time into the set, the user's corrections.
- **User model:** learned style labels and preferences (§11).

### 5.2 Track style classification
Output a **probability distribution over style clusters, plus a confidence**, for every track. Seed taxonomy (extendable; the user can rename or merge):

> house · tech-house · techno · minimal/rominimal · deep/organic house · EDM/big-room · drum & bass · dubstep/bass · hip-hop · trap · R&B/soul · pop · dance-pop/popcorn · Eurodance/90s · disco/funk/80s · reggaeton/Latin urban · salsa/bachata/merengue · manele · Romanian folk/lăutărească (hora, sârba) · Balkan brass/čoček · rock/indie · ballad/slow · ambient/downtempo · unknown

The style comes from three sources, fused:
1. **Tag lexicon.** Multilingual synonyms mapped to clusters, e.g. "manele", "muzică de petrecere", "populară", "hora", "sârbă", "lăutărească", "minimal", "rominimal", "deep tech", "urbano", "bachata". Gives a prior with confidence depending on the tag's specificity.
2. **Audio classifier** on the style-feature vector, in two layers:
   - **(a) Built-in rule layer**, interpretable and shipped:
     - aksak flag or ternary feel with high tempo → folk/Balkan;
     - 165–180 BPM with a break pattern → DnB;
     - 118–130 BPM, four-on-the-floor kick, low vocal density, low energy variance, long tracks → minimal/tech-house;
     - 85–105 BPM with swung hats and high vocal density → hip-hop;
     - syncopated darbuka-like groove at 95–130 BPM → manele;
     - dembow groove pattern → reggaeton.
   - **(b) On-device learner:** k-NN or logistic regression trained on **the user's own tagged tracks**, so a tagged library labels its untagged tracks and the system adapts to the user's taxonomy.
   - We ship no model trained on third-party labelled data until its licensing is cleared. ⚠ Thresholds are design defaults to tune on a dev set.
3. **Embeddings (T2, optional):** CLAP zero-shot text prompts per cluster and nearest neighbours in the library. ⚠ Zero-shot quality on niche genres (manele, hora) is unverified; give it low weight until measured.

Fusion is a weighted log-linear combination, with weights learned per user from corrections (§11). A track below 0.5 confidence counts as **"unknown/mixed"**, and the planner uses the pair's *measured* features (BPM, meter, vocals, groove) instead of style rules.

### 5.3 Pool profile and event detection
1. **Pool statistics:** style histogram (soft counts), BPM histogram and modes, meter-flag share, energy mean and variance, slow-song share, vocal density, era spread (year tags), language mix, median duration, intro and outro lengths.
2. **Clustering into blocks:** agglomerative clustering on (style posterior, BPM in log space with half and double folding, groove, energy). k is chosen by silhouette with a minimum cluster size of 3. Clusters become **candidate blocks**, labelled by majority style.
3. **Inferred profiles** (formerly "modes"; nothing to pick). Each profile is a scored signature over the pool statistics, with typical behaviour attached:

| Inferred profile | Signature (soft rules, ⚠ thresholds to tune) | Behaviour it implies |
|---|---|---|
| **Club house/techno** | ≥70 % house, tech-house or techno; BPM mode 120–130 with narrow spread; low vocal density | 16–32 bar EQ or stem blends, bass swap on phrase, harmonic weight high |
| **Rominimal / minimal** | ≥60 % minimal or tech-house; median duration ≥6.5 min; low energy variance; low vocal density; low key confidence common | 32–128 bar groove-locked blends, groove weight ≫ key, Δenergy ≤1 (§10) |
| **Open-format party** | ≥3 styles each ≥10 %; wide BPM spread; mostly vocal hits | genre blocks, 4–8 bar blends, cuts, echo-outs, tempo creep |
| **Wedding (generic)** | open format plus ≥5 % ballads or slow songs plus era spread ≥3 decades | blocks, slow-dance moments, familiarity weight, safe techniques |
| **Romanian wedding (nuntă)** | wedding signature plus folk/hora/sârba and/or manele each ≥8 %, or Romanian-language share ≥40 % | hora, sârba, manele and pop blocks; quick cuts; folk gets no-overlap techniques; tradition-moment suggestions (§10) |
| **Romanian pop/dance** | ≥50 % dance-pop/popcorn or Romanian pop; BPM 120–130; vocal-heavy | 8–16 bar blends, drop swaps on chorus, acapella-in mashups |
| **Hip-hop / R&B night** | ≥60 % hip-hop, trap or R&B; BPM 80–105 plus halftime trap | cuts on the 1, short blends, acapella-in, halftime bridges |
| **Drum & bass** | ≥60 % at 165–180 BPM | drop swaps, double drops, short blends |
| **Latin night** | ≥60 % reggaeton, salsa, bachata or merengue | style blocks (2–4 tracks), short blends, cuts |
| **Lounge / dinner** | low energy mean; low LUFS; ambient, downtempo or soul | long crossfades, filter, no cuts |
| **Workout** | BPM rising or high (≥125) with high energy; "workout/gym/run" in playlist name | steady BPM ramp, quick bass swaps |

   Profile posterior = softmax over signature scores, combined with the playlist-name hint (low weight) and the user's past corrections for this playlist.
4. **Ambiguity:**
   - If the top profile is below 0.5, or two profiles are within 0.1, run as **"Mixed: adaptive"**. There is no set-level prior, so each transition is decided purely from the pair styles (§7.1), with safe-leaning weights. The UI shows the top two ("Club house / open format?") for a one-tap pick.
   - Profiles may also be **mixtures**: e.g. a house block, then a hip-hop block, then a house block, with the profile stated per block.
   - The inference is re-run when the queue changes, after each transition (live adaptation: if the user keeps adding hip-hop, the profile shifts), and on corrections.

### 5.4 Decision hierarchy
1. **Set level:** profile, giving priors for arc, block policy, technique and length.
2. **Block level:** block style, giving that style's mixing profile.
3. **Pair level:** (style of A, style of B), giving the same-style profile or a cross-genre **bridge strategy** (§7.2).
4. **Section level:** A's out section and B's in section types, plus vocals, bass and meter. The planner scores candidates under these priors (§7.3).

Priors are soft. **Safety gates are never overridden by any profile.**

---

## 6. Track selection and set planning from the pool (P3)

1. **Default: the pool is the set.** Automix orders and blocks **only what it was given** (queue, playlist, view). Library-wide suggestions are used **only to fill a detected gap** (a missing bridge between clusters, or a too-short arc), and **only when the user allows it**: "Allow suggestions from the library", default off for explicit playlists and queues, asked once. Suggested tracks are badged "added by AI DJ".
2. **Block planning** (when the profile or clusters call for blocks: wedding, open format, Latin, mixed pools):
   - **Block sizes** come from pool proportions and the inferred profile (e.g. wedding blocks of 3–6 tracks, ⚠ to tune; hora and sârba sets kept together).
   - **Block order** follows the energy arc and the profile's conventions: slow-dance blocks at inferred moments, peak blocks in the middle, a cool-down to finish.
   - **Within a block:** beam search with the pair score.
   - **Between blocks:** pick the boundary pair with the best bridge score, optionally inserting a bridge track *from the pool*. Library bridges are only used if allowed.
3. **Energy arc from what is available.** The arc's range and length come from the pool's energy distribution and total duration (time-based). There is no shape to pick. Profile priors give the curve: club = warm-up, peak, release; wedding = waves with tradition moments; lounge = flat. The existing `SET_SHAPES` stay as optional overrides.
4. **Pair score is section-aware.** The best transition plan between A and B (§7), plus track terms:
   - harmony (one shared `camelotRelation` with semitone-down and confidence weighting, fixing G6);
   - tempo with half and double;
   - groove similarity;
   - vocal/instrumental pairing;
   - style continuity, or bridge quality across a style change;
   - variety and artist spacing;
   - familiarity (play count and rating), weighted by profile.

   For cost, precompute ≤4 out options and ≤4 in options per track, and rescore only the top 20 candidates fully.
5. **Live mode** (`liveNext`) uses the same profile and blocks, and re-plans after every transition from current history, so the set keeps adapting.
6. **Explanations:** "Next: hora block (4 tracks) — your wedding playlist alternates hora / manele / pop; this hora shares tempo 0.9 with the current sârba."

---

## 7. Transition planner (P2)

### 7.1 Technique choice from the inferred styles
Each style cluster has a **mixing profile**: preferred lengths, techniques, tempo tolerance, harmonic and groove weights, vocal handling, and whether cuts are allowed. A same-style pair uses that profile. A cross-style pair uses the **bridge table**.

| Style | Lengths (bars) | Preferred techniques | Tempo handling |
|---|---|---|---|
| house / tech-house / techno | 16–32 | three-band EQ blend, bass swap, stem blend | sync ±4 %, ramps |
| minimal / rominimal | 32–128 | slow EQ blend with mid scoop, percussion-first stem blend, loop-extend | sync ±2 % |
| EDM / big-room | 8–16 | drop swap, bass swap, filter, echo | sync, drop-aligned |
| drum & bass | 8–16 | drop swap, double drop, quick bass swap | sync; halftime bridges |
| hip-hop / trap / R&B | 1–8 | cut on the 1, acapella-in, short blend, spinback (rare) | own tempo, cuts; halftime links |
| pop / dance-pop / popcorn | 8–16 | vocal-safe blend, drop swap on chorus, acapella-in | sync ±5 % |
| reggaeton / Latin urban | 4–8 | short blend, cut, acapella-in | sync ±5 % |
| salsa / bachata / merengue | 0–4 | cut at phrase end, short crossfade | own tempo |
| manele | 2–8 | short blend or cut on phrase, echo-out | sync ±5 % if the groove matches, else own tempo |
| Romanian folk (hora / sârba / aksak) | 0–2 | cut at phrase end, echo-out, short crossfade over the final bar | **no beat-matched overlap** (meter, drift) |
| ballad / slow | fade | let the ending play, crossfade over the tail | own tempo |

### 7.2 Cross-genre bridge strategies
Chosen by the (A style, B style) pair, then scored:

| A → B | Strategy |
|---|---|
| house → hip-hop | Echo-out on A's phrase end, B drops on its first downbeat at its own tempo. Alternative: halftime bridge (124 ↔ 62 feel) with A filtered for 4 bars, then cut. |
| hip-hop → house | B's intro under A's last 4 bars only if tempo is within 6 %. Otherwise cut into B's first drop or hook, or acapella-in (A's vocal over B's intro) when mashable. |
| manele → pop (and back) | Within 6 % tempo and a compatible key: 4–8 bar vocal-safe blend into B's chorus. Otherwise echo-out and drop on the 1. |
| folk (7/8, 2/4, drifting) → 4/4 | No overlap: let A finish its phrase (or the tune), 1-beat echo or short tail, B starts on its downbeat. Optional crowd-cheer or air-horn from the sampler. |
| 4/4 → folk | Echo-out or fade A on the phrase; start B at its first stable downbeat, skipping a free-time doina intro when the inferred block is "dance". |
| rominimal ↔ house | Long blend allowed (both 4/4, close tempos), with a groove-matching check. |
| DnB ↔ dubstep / trap | Halftime bridge (174 ↔ 87). |
| reggaeton ↔ hip-hop | Short blend at 90–100 BPM; acapella-in common. |
| any → ballad | Echo or fade to B's intro; never a bass swap into a ballad. |
| ballad → any | Let the ballad's ending play, start B on its downbeat. |
| big jump, no rule | Existing echo, cut or reverb fallback. |

**Bridge tracks:** the set planner may insert a track whose style and BPM lie between the clusters (e.g. moombahton between reggaeton and house), from the pool, or from the library only if allowed.

### 7.3 Candidates and scoring
- **Out points:** section boundaries in A's last 40 %, plus earlier ones for quick-cut styles.
- **In points:** B's first downbeat, intro, verse, breakdown, drop, chorus; a folk tune's first stable downbeat.
- **Lengths:** 1–64 bars (128 for minimal).
- **Alignment:** 16, 8 or 4-bar lines, meter-aware.
- **Tempo:** sync, ramp, halftime or double bridge, reset, loop-bridge.
- **Key:** none, or a shift of ±1–2.
- **Techniques:**
  1. three-band EQ blend;
  2. bass swap;
  3. Neural-Mix-style stem blend;
  4. drums of A under vocals of B;
  5. acapella-in;
  6. instrumental-out;
  7. loop-extend;
  8. filter;
  9. echo or reverb out;
  10. halftime or double bridge;
  11. tempo-ramp blend;
  12. drop swap;
  13. double drop;
  14. quick cut;
  15. spinback, brake or loop-roll;
  16. scratch-style cut-in (later).

  Stem techniques are T2-gated. Overlap techniques are excluded for meter- or drift-flagged tracks.
- **Clash scoring** on per-beat arrays after lane gains:
  - vocal-on-vocal: hard reject over 1 beat;
  - bass-on-bass: hard reject over 2 beats;
  - chroma dissonance in the mids;
  - energy dip over 3 LU unless intentional;
  - loudness jump over 1.5 LU;
  - phrase misalignment;
  - stretch and shift cost;
  - groove-match bonus.
- **Technique prior** = (profile prior) × (pair-style table) × (learned user preference) × (variety). `planScore` = weighted sum. The top 3 are kept for "do it differently". Target ≤30 ms in a worker.
- **The UI shows the inference behind the plan:** "manele → pop: 4-bar blend into the chorus (tempo 3 % apart, 8A→9A, no vocal overlap)".

---

## 8. Execution engine (P1)

1. **Transition data model** (`automix/transition-model.js`): JSON with anchors, beat grid, tempo strategy, key shift, **lanes** (`a.vol`, `a.eq.low`, `b.stem.vocals`, `a.filter`, `a.fx`), events (`playAt`, `loop`, `brake`), technique, score, reasons and **inferred context** (styles and profile), so explanations and learning can see why.
2. **Audio-clock scheduler** (`automix/scheduler.js`):
   - look-ahead of about 100 ms, refilled every 25 ms;
   - beats are converted to `ctx.currentTime` through `deck.positionAt()`;
   - `linearRampToValueAtTime` / `setValueCurveAtTime` through new `Channel.automate` / `cancelAutomation` in `engine.js`;
   - worklet messages `playAt`, `stemRamp`, `rateRamp`, `loopAt` (sample-accurate);
   - FX automation in `effects.js` (fixes G1).
3. **Gain structure:** LUFS trim to −14 LUFS, fader unity 0.8, crossfade law per technique, limiter as backstop.
4. **Rehearsal:** a feature-array dry run, plus an optional `OfflineAudioContext` render of the next transition on desktop (worklets, spectral-flux, clipping and loudness checks). A failure falls back to the next plan.
5. **Takeover and recovery (fixes G2):**
   - touching any lane's control cancels that lane only, and the UI shows "You took over the EQ";
   - stopping a deck or moving both faders ends the transition gracefully;
   - if stems fail, each stem lane falls back to its EQ equivalent;
   - scheduled params keep running in background tabs.
6. **Port the existing 10 styles** to lane generators first, with no audible change (regression via `test/automix.test.js`).

---

## 9. Automatic mashups (P4–P5)

### 9.1 Mashability
For vocal section V (vocal ≥0.6 over ≥8 bars) and instrumental section I (vocal ≤0.15, stable beat):
- tempo ≤6 % live, ≤10 % offline;
- key shift ≤2 to reach same, ±1 or relative;
- bar-wise chroma consonance with the AutoMashUpper-style sliding offset;
- rhythm (vocal onset density against groove);
- section-pair table (hook→drop 1.0, verse→instrumental verse 0.8, …);
- spectral room on I;
- asymmetric scoring.

Prefilter to the top 50 per track; cache in the feature store.

### 9.2 Eligibility comes from the inferred context
- **Encouraged:** pop, dance-pop/popcorn, hip-hop, R&B, reggaeton, open-format blocks.
- **Occasional:** house and EDM (hook over drop).
- **Rare and subtle:** minimal or rominimal (short vocal snippets or percussion layers only).
- **Off:** folk, aksak, free-tempo, drifting tracks; ballads; inferred tradition moments (hora miresei, first dance); low-confidence styles.

The "Mashups" slider (off / sometimes / often) scales this. Its default comes from the profile (e.g. "sometimes" for open format and Romanian pop, "off" for lounge).

### 9.3 Rendering
Align V's phrase (pickup included) to I's downbeat. Stretch and shift V only. High-pass V at 120 Hz. Carve or duck I (1–3 dB). V +1 LU over I. Fade at phrase edges.

### 9.4 Modes
1. **Live mashup in automix (P4, T2):** the "acapella in" technique (B's vocal stem over A's instrumental for 1–2 phrases, then the handover). Chosen automatically when §9.2 allows it and the gates pass.
2. **Mashup suggestions (P4, T0+):** a panel ranked within the current pool, with cue points and stem presets; works on phones through vocal maps synced from desktop.
3. **Mashup builder (P5, T3):** offline Signalsmith Stretch render to a sampler pad or a personal-use file; no share or upload; licence notice.

### 9.5 Quality gates
Reject on any of: stretch or shift beyond limits; more than 25 % dissonant bars; residual vocal in I above 0.2; inconsistent stem energy; clipping or flux spikes over 3σ at the edits. Then show "Not confident".

### 9.6 Phones
A **desktop prep pack** (feature blobs, a few KB per track, plus optional stem FLACs for tracks marked performance-ready, ⚠ ~25–40 MB per track estimated). A small on-device separator is P5 research.

---

## 10. Romanian music and DJ styles

### 10.1 Genres, rhythm, DJs and scenes

**Rominimal.**
- **Who:** the [a:rpia:r] collective, Rhadoo, Petre Inspirescu and Raresh (RPR Soundsystem) ([Electronic Beats](https://www.electronicbeats.net/guide-to-rominimal-underground-tech-house), [RA](https://ra.co/dj/rprsoundsystem), [fabric](https://fabriclondon.com/posts/in-profile-a-potted-history-of-petre-inspirescu)). Cezar co-founded the OurOwn vinyl platform with Rhadoo (2009) ([Mixmag](https://mixmag.net/feature/cezar-dj-romania-minimal-techno-rominimal-untold-festival-interview)). Also Priku, Barac, Dan Andrei, Cosmjn, Herodot, Suciu, Cristi Cons, Livio & Roby, Iuly.B ([XLR8R](https://xlr8r.com/features/romania-exquisitely-elusive/), [XLR8R 025](https://xlr8rplus.bandcamp.com/album/xlr8r-025-amorf-priku-sublee-cosmjn-dan-andrei-orli), [RA.493](https://ra.co/podcast/493)). **Sepp** (Teo Bajdachi, from Constanța; co-runs UVAR Records with Nu Zau and runs Catren Records) and **Arapu** (Ionuț Arapu, Bucharest; founded the Liniar label in 2015) are both Romanian minimal DJs and producers ([MEOKO interview with Sepp](https://meoko.net/interviews/an-exclusive-interview-with-sepp), [fabric: Arapu](https://www.fabriclondon.com/posts/audio-arapu-wys-mix), [Live Cinema Festival](https://livecinemafestival.com/en/editions/2025-rome/program/detail/arapu/)). ⚠ This comes from search results; those pages were not opened, and one profile gives a different name for Arapu.
- **Sound:** smoky, stripped-back, late-hour; jazz, ambient and classical touches; a swung, skipping kick emphasis ([XLR8R](https://xlr8r.com/?p=129419)).
- **Mixing:** very long sets (warm-up, main, after-hours; 7-hour recordings) and **7–8-minute tracks built for long layered mixes**, vinyl-centric ([XLR8R](https://xlr8r.com/features/romania-exquisitely-elusive/), [Priku](https://xlr8r.com/news/hear-a-new-mix-from-priku/)).

**Romanian pop/dance ("popcorn").**
- Inna ("Hot"), Edward Maya & Vika Jigulina ("Stereo Love"), Alexandra Stan ("Mr. Saxobeat") and Akcent went international. The sound is house and trance rhythms with plucky synth or sax hooks with Balkan and Mediterranean turns ([Wikipedia](https://en.wikipedia.org/wiki/Popcorn_(Romanian_music_style)), [Stereo Love](https://en.wikipedia.org/wiki/Stereo_Love)).
- Global Records and Kiss FM Romania shaped commercial dance ([Global Records](https://www.wikiwand.com/en/articles/Global_Records), [Kiss FM](https://en.wikipedia.org/wiki/Kiss_FM_(Romania))).
- ⚠ DJ Project, Matteo, Morandi, Andra and Smiley are still not covered: Wikipedia and Romanian sites were not reachable on 2026-11-21. Several are singers or producers rather than DJs. Nothing in the plan depends on them.

**Manele.** Mostly 4/4 at about 95–130 BPM; syncopation; roots in čoček/kyuchek; darbuka, tarabana and accordion ([RomArchive](https://www.romarchive.eu/en/music/balkan/manele/), [The Attic](https://theatticmag.com/features/2492/a-century-of-manele-a-sonic-excavation-of-romanias-most-popular-genre.html), [Melodigging](https://www.melodigging.com/genre/manele)). ⚠ Still approximate: the only tempo source found is Melodigging (about 95–120 BPM for slower songs, up to about 130 for dance tracks), which gives no sourcing. No ethnomusicological source for manele, hora or sârba BPM ranges was found, and stock-library tags contradict each other. The plan never hard-codes these ranges: meter and tempo are measured per track (§10.2). Played in blocks between pop and folk at parties ([Brig.ro](https://brig.ro/dj-nunta/oradea)).

**Folk / lăutărească and weddings.**
- The **hora** is near-universal; the **sârba** is the faster circle dance; **hora miresei** is a key moment. Lăutari bands, with the DJ alternating or replacing them; parties often run until morning ([Romania Insider](https://www.romania-insider.com/index%2ephp/romanian-wedding-guide), [Remitly](https://www.remitly.com/blog/lifestyle-culture/wedding-traditions-in-romania/), [The Knot](https://www.theknot.com/content/cultural-traditions-romania)).
- Crowds fill the floor for horas; guests request village-specific songs ([Vice RO](https://www.vice.com/ro/article/piese-ciudate-la-nunti-in-romania/)); DJs learn regional repertoire ([Softpedia](https://forum.softpedia.com/topic/406637-punatori-de-muzica-la-nunti/page__st__540)); live sax or violin for key moments ([Brig.ro](https://brig.ro/dj-nunta/focsani)).
- **Moments:** entrance, first dance, hora miresei, bride kidnapping (furatul miresei), cake, bouquet, gift moment (darul), last dance. **Unveiling (dezgătitul miresei):** around midnight the godmother (nașa) takes off the bride's veil and replaces it with a headscarf (basma or batic), marking her change to married status. Timing and form vary by region, and some sources put it at the evening party rather than at midnight ([BZI](https://www.bzi.ro/ce-trebuie-sa-cumpere-nasa-la-nunta-iata-care-sunt-obiceiurile-pe-care-este-bine-sa-le-respecte-5204317), [Spotmedia](https://spotmedia.ro/stiri/timp-liber/cele-mai-intalnite-obiceiuri-si-traditii-de-nunta)). ⚠ Seen through search results; the Romanian sites were not reachable. Treat it as one more optional moment (a slow or traditional song on request), never an automatic trigger.

**Rhythm.**
- Aksak **geampara**, 7/16 or 7/8 counted 2+2+3, and other Dobrogean 7/8 dances ([eliznik](https://eliznik.org.uk/traditions-in-romania/traditional-dance/chain-dances/danubian-asymmetric-rhythm-dances/), [Folk Dance Footnotes](https://folkdancefootnotes.org/dance/dance-information/romanian-dance-rhythms-uneven/), [Aksak](https://www.wikipedia.org/wiki/Aksak)).
- **Sârba:** brisk 2/4 with a triplet-grouped melody ([Sârba](https://en.wikipedia.com/wiki/S%C3%A2rba), [JMRC](https://jewish-music.huji.ac.il/he/node/22407)).
- **Doina:** free rhythm (parlando rubato) ([Doina](https://en.wikipedia.org/wiki/Doina)).
- Live-band recordings drift. 4/4-trained trackers do poorly on odd meters ([Tracking the "odd"](https://archives.ismir.net/ismir2014/paper/000265.pdf)).

**Festivals and scenes:**
- **Sunwaves** (Mamaia since 2007): the rominimal festival; Romanian chapter ended after 18 years, May 2025 ([Mixmag](https://mixmag.net/read/romania-sunwaves-festival-end-18-years-mamaia-nord-minimal-news)).
- **Untold** (Cluj; 427,000 attendance in 2024) ([Wikipedia](https://EN.wikipedia.com/wiki/Untold_Festival)).
- **Neversea** (Constanța beach; first edition 7–9 July 2017, from the Untold organisers, with about 153,000 attendees; later editions reported over 210,000 in 2018 and over 240,000 in 2019) ([Romania Insider 2017](https://www.romania-insider.com/romania-neversea-2017/), [2018](https://www.romania-insider.com/life/neversea-210000-public-romania-2018), [2019](https://www.romania-insider.com/life/public-neversea-2019), [Romania Insider 2023](https://www.romania-insider.com/life/neversea-opens-summer-festival-season-romania-2023)). Seen through search results; the host was not reachable.
- **Electric Castle** (Bonțida) ([Wikiwand](https://www.wikiwand.com/en/articles/Electric_Castle_Festival)).

### 10.2 What OpenDJ infers and does (no presets)

**Analysis (P0):** `audio/meter.js`:
- beats per bar 2, 3 or 4;
- **aksak flag** (2:2:3 or 2:3 interval clustering);
- **ternary feel** (sârba);
- **free-tempo** intro detection (doina);
- **drift** plus `tempoMap`;
- meter-aware phrase lengths.

These flags feed the style features (§4), so folk, sârba and aksak tracks classify themselves.

**Inferred "Rominimal" profile:** triggered by a minimal-dominant pool with long tracks, low energy variance and low vocal density (§5.3). It produces:
- 32–128 bar blends (raise the 40 %-of-duration cap to 60 % for this profile);
- slow mid-scoop EQ moves;
- percussion-first stem blends (B drums → B other → bass swap on a 32-bar line);
- loop-extend for short tails;
- selection with groove weight ×3, ΔBPM ≤2 %, Δenergy ≤1, key weighted by confidence;
- no cuts or spinbacks;
- optional 3-deck layering (P5).

**Inferred "Romanian wedding (nuntă)" profile:** triggered by a wedding signature plus a hora/sârba and/or manele share or a Romanian-language share. It produces:
- **automatic blocks** (hora/sârba, manele, Romanian pop, international, slow) from the clusters, kept together the way DJs would;
- block order from the arc;
- quick cuts and short blends inside blocks, echo or cut resets between blocks;
- folk tracks always get no-overlap techniques;
- familiarity weighted high.

**Tradition moments are suggestions, never required.** Slow songs are detected as first-dance candidates, and a "hora miresei" candidate is a hora with a bride-related title or tag. The UI offers one-tap "Hora now", "Sârba block", "Manele block" and "Slow". "Pause for live band" fades out and resumes with a fresh block. Talkover ducking is available for the MC.

**Inferred "Romanian pop/dance" profile:**
- 8–16 bar vocal-safe blends;
- drop swaps on the chorus;
- harmonic weight high;
- acapella-in mashups on hooks (popcorn hooks often share tempo, ⚠ unmeasured);
- decade blocks.

**Mixed pools adapt per transition.** For example a wedding queue: hora → hora uses a cut at phrase end; hora → manele uses folk → 4/4 (no overlap); manele → pop uses a 4-bar blend into the chorus (§7.2).

**Colaj / medley:** when a block of short-attention material is detected (hora, manele, popcorn classics) in a high-energy part of the arc, the planner may play 16–32-bar excerpts (hook sections) chained with phrase cuts. ⚠ Still partly inference. "Colaj" is clearly an established format in Romanian party music: radio playlists list releases such as "Colaj muzica populara de petrecere", "Colaj de SARBE" and a DJ-credited "DJ Tyger – Colaj Maramures Remixuri". Most of these are pre-made medleys by bands or singers, though. No source was found describing wedding DJs building colaje live, so keep the feature opt-in and conservative ([Vice RO](https://www.vice.com/ro/article/piese-ciudate-la-nunti-in-romania/), [onlineradiobox playlists](https://onlineradiobox.com/ro/romance21etno/playlist/3)).

---

## 11. Learning and evaluation

### 11.1 On-device learning (P3)
- **Playlists as labels.** Tracks that share a user playlist share context. This trains style-similarity metric learning (a small linear projection of style features) and the user-tag k-NN classifier. Playlist names are weak event labels ("nuntă", "wedding", "techno").
- **Corrections.** "Not a wedding, it's a club set" updates the profile posterior and is remembered for that playlist. "This is manele, not pop" writes a user style label (`odj:style` tag) that retrains the k-NN.
- **Manual mixes** (opt-in): record channel automation while the user mixes decks 1 and 2. Classify technique, length and out/in section types, and update technique priors **per style pair**.
- **Skips and overrides.** A skip within 60 s or a style override is negative feedback for that (style pair, technique, length) bucket; Thompson sampling chooses among techniques. Loads by hand during automix are positive for the pick.
- **Storage.** A few KB in `settings.automix.learned`; local only; export, reset and delete supported.

### 11.2 Metrics
- **Mix quality:**
  - beat-phase error: median ≤5 ms, p95 ≤15 ms;
  - phrase-alignment rate;
  - stem-based clash beats: vocal and bass, target 0;
  - chroma dissonance;
  - loudness continuity: |ΔLUFS| ≤1.5;
  - spectral-flux z-score at the edits;
  - energy-dip depth.
- **Inference quality:**
  - style top-1 accuracy (≥0.80 on tagged dev tracks; ≥0.70 untagged, audio-only);
  - event-profile accuracy on a fixture set of 30 playlists (club, rominimal, Romanian wedding, open format, hip-hop, lounge, mixed), target ≥0.85 top-1 or a correct "ambiguous";
  - block-coherence score;
  - on-device correction rate, which should fall over time (local only).

### 11.3 Harness
- `scripts/mix-render-harness.mjs` renders 30-minute mixes in headless Electron or Chromium (`OfflineAudioContext` with the real worklets) from **CC0 / CC BY** tracks whose licences were confirmed on their pages on 2026-11-21: HoliznaCC0 *Winter Lofi*, Loyalty Freak Music "Summer Pride" (both CC0), and Kevin MacLeod "Raving Energy" (122 BPM) and "Brain Dance" (124 BPM) (CC BY 4.0; see `docs/RESOURCES_AND_LICENSING.md` §3.2). Re-check any track you add. Plus synthetic signals (2/4, 3/4, 4/4 and 7/8 click and bass patterns, formant "vocals").
- **Metadata-only playlist fixtures** test the inference with no audio needed.
- CI fails on regression.

### 11.4 Listening tests
- MUSHRA-lite comparing current automix, the new planner (EQ only), the new planner with stems and inference, and a human DJ reference.
- 10+ listeners, including a Romanian panel for rominimal and wedding sets.
- Target: better than current with p<0.05, and within 10 points of the human reference.

---

## 12. UX

**AI DJ panel** (smart by default):
- **"Detected" chip**, for example "Romanian wedding set · 82 % — next: hora block, quick cuts". Tap it to see:
  - the evidence ("14 hora/sârba, 22 manele, 30 pop, 6 slow · 80–140 BPM · 68 % Romanian-language titles");
  - the alternatives (top 3 profiles plus "Mixed: adaptive");
  - one-tap correction.
- **Per-transition chip:** "manele → pop · 4-bar blend into chorus · no vocal overlap". Tap for the timeline.
- **Timeline:** A and B waveforms on a shared grid; lanes for volume, EQ L/M/H, filter, stems V/D/B/O, FX, mashup; buttons Do it differently, Longer, Shorter, Technique, Mix now, Lock.
- **Set view:** inferred blocks (colour by style), energy and BPM arc, suggested moments. Blocks can be dragged; the AI re-plans around them.
- **Tuning sliders** (optional; defaults come from the inferred profile): Safe ↔ Adventurous, Quick cuts ↔ Long blends, Harmonic ↔ Energy ↔ Variety, Mashups off / sometimes / often, "Allow library suggestions".
- **Advanced drawer:** manual profile or style override, per-track style correction, reset learning. Never needed for normal use.
- **Takeover indicator:** grabbed lanes show "manual".
- **Phone:** a compact card (Detected chip, reason, three buttons), big moment buttons when a wedding is inferred, stem lanes hidden without stems, NN analysis only while charging.

---

## 13. Phased roadmap

### P0 – Foundations: analysis v2, feature store, style features (L)
- **Scope:**
  - feature track (bands, chroma, timbre-lite, groove, swing and ternary feel, per-bar LUFS);
  - BS.1770 loudness; sections v2;
  - vocal map (stems plus heuristic);
  - key confidence and segments;
  - **meter, aksak, free-tempo and drift flags (§10.2)**;
  - mixable and loopable regions;
  - style-feature vector;
  - shared `camelotRelation` (G6).
- **Files:**
  - new: `audio/features.js`, `audio/loudness.js` (from sampler.js), `audio/sections.js`, `audio/vocals.js`, `audio/meter.js`, `audio/feature-store.js`, `shared/camelot.js`, `server/features.js`;
  - changed: `analysis-core.js` (`analysisPatch` stores keyConfidence, LUFS, flags), `analysis-worker.js`, `background-analysis.js`, `stems/stems.js`, `server/index.js`, `public/js/local/storage`, `shared/settings-schema.js`. CDJ export keeps `phrases`.
- **Dependencies:** none (DSP).
- **Budget:** desktop ≤1.5 s per track in the worker; phone ≤4 s; no main-thread task over 16 ms; ≤8 KB per track.
- **Tests:** BS.1770 reference signals; synthetic 2/4, 3/4, 4/4, 7/8 and drifting click tracks; synthetic structured tracks; stub-separator vocal maps; blob round-trip; `e2e-analysis.mjs`.
- **Acceptance:** §4 targets on a 50-track CC dev set.
- **Risks:** annotation effort; migration (versioned blobs, lazy re-analysis).

### P1 – Execution engine and transition data model (M)
- **Scope:** data model, audio-clock scheduler, `Channel.automate`, worklet `playAt` / `stemRamp` / `rateRamp` / `loopAt`, FX automation, per-lane takeover (G1, G2), port of the 10 styles, LUFS gain staging.
- **Files:**
  - new: `automix/transition-model.js`, `automix/scheduler.js`, `automix/techniques.js`;
  - changed: `audio/engine.js`, `audio/deck.js`, `audio/worklets.js`, `audio/effects.js`, `automix.js`.
- **Budget:** ≤0.3 ms per tick.
- **Tests:** old-versus-new lane equivalence; phase error ≤5 ms median under injected 100 ms main-thread stalls; takeover tests.
- **Risks:** conflicts with `apply()` smoothing (use `cancelScheduledValues` and an automated flag).

### P2 – Context inference v1, transition planner and stem transitions (L+)
- **Scope:**
  - **track style classifier** (tag lexicon including Romanian terms, rule layer, user-tag k-NN);
  - **pool profile and event detection** with ambiguity handling (§5.3);
  - decision hierarchy;
  - per-style mixing profiles and the **bridge table** (§7.1–7.2);
  - candidate generation, the 16-technique library, clash scoring, top-3 plans;
  - "Detected" chip, transition timeline, correction and override;
  - optional offline rehearsal;
  - meter-flag safety rules.
- **Files:**
  - new: `automix/context.js` (classification, pool stats, profiles), `automix/style-lexicon.js`, `automix/profiles.js` (signatures and mixing profiles; data, not presets), `automix/bridges.js`, `automix/planner.js`, `automix/clash.js`, `automix/explain.js`, `ui/aidj-panel.js`, `ui/transition-timeline.js`;
  - changed: `automix.js` (`nextTransition` returns plan plus context; `pickStyle` becomes the fallback), `smartmix.js` (styles in pair scoring), `ui/dialogs.js`, `app.js`, settings schema (deprecate the manual `style`, `shape` and `preset` as defaults; keep them as overrides).
- **Stems model (licence fix, added 2026-11-21):** stem transitions must not depend on HT-Demucs. Add a UMX-HQ graph type to `stems-model.js` and make UMX-HQ the default download. Keep HT-Demucs as an opt-in "High quality (personal / non-commercial use)" download, and correct the licence text in `server/stems.js` and `THIRD_PARTY_NOTICES.md` (§14).
- **Budget:** pool inference ≤50 ms for 500 tracks and ≤300 ms for a 10k library view (worker); plan ≤30 ms desktop, ≤80 ms phone.
- **Tests:**
  - the 30-playlist inference fixtures (wedding queues alternating hora, manele and pop are blocked correctly; rominimal pools get long blends with no setting changed; mixed queues switch technique at genre changes);
  - synthetic clash tests: zero vocal and bass clash beats;
  - meter-flagged tracks never get beat-matched overlaps;
  - harness baseline.
- **Acceptance:** §11.2 inference targets; listening test beats current automix; no hard-gate violations in 30-minute renders.
- **Risks:** misclassification (confidence gating, "Mixed: adaptive", one-tap correction); EDM bias (Romanian panel, per-style profiles); stems not ready (pre-queue, EQ fallback).

### P3 – Set planning from the pool and learning (M)
- **Scope:** automatic block planning, energy arc from the pool (time-based), bridge-track insertion from the pool, opt-in library gap-filling, live re-planning, tradition-moment suggestions (§10.2), colaj/medley excerpts, on-device learning (playlists, corrections, manual mixes, skips), optional CLAP similarity and zero-shot hints (T2).
- **Files:**
  - new: `automix/setplanner.js`, `automix/blocks.js`, `automix/learning.js`, `automix/moments.js`;
  - changed: `smartmix.js`, `automix.js` (`fillLive` uses the set planner), `history.js` integration, settings schema (`automix.learned`, `allowLibrarySuggestions`).
- **Dependencies:** CLAP-fused (Apache-2.0) optional download.
- **Budget:** next pick ≤50 ms for a 5k pool; full set plan ≤500 ms for 200 tracks.
- **Tests:** blocks never split a detected hora or sârba run; arcs hit targets ±1; library tracks never added without permission; learning converges on synthetic preference streams; reset works.
- **Risks:** cold start (literature priors); privacy (local only).

### P4 – Live mashups and suggestions (M)
- **Scope:** mashability index, context-based eligibility (§9.2), live "acapella in", quality gates, suggestions panel, desktop prep pack for phones.
- **Files:**
  - new: `automix/mashup.js`, `ui/mashup-suggest.js`;
  - changed: `automix/techniques.js`, `automix/planner.js`, backup and export code.
- **Budget:** ≤100 ms per track to index.
- **Tests:** the gates reject out-of-limit cases; no mashups in folk, ballad or tradition-moment contexts; 10 rendered mashups with metrics.
- **Acceptance:** ≥70 % of accepted mashups rated good.
- **Risks:** WSOLA vocal artefacts (tight live limits).

### P5 – Mashup builder and advanced engines (L)
- **Scope:** Signalsmith Stretch offline renderer (EQ carving, sidechain), export to sampler or a personal file, optional Signalsmith key lock A/B.
- **Research:** tempo-map following for live-band and folk recordings, same-meter aksak blends, small on-device separator, 3-deck rominimal layering.
- **Files:** `automix/mashup-render.js`, `vendor/signalsmith-stretch` (with `THIRD_PARTY_NOTICES.md`), `worklets.js`, `audio/sampler.js`.
- **Tests:** null test at ratio 1; artefact metrics; licence notice.
- **Risks:** WASM in AudioWorklet on low-end devices (offline first).

| Phase | Effort | Depends on |
|---|---|---|
| P0 | L | — |
| P1 | M | P0 loudness |
| P2 | L+ | P0, P1 |
| P3 | M | P2 |
| P4 | M | P2, P0 vocal maps |
| P5 | L | P4 |

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Wrong inference** (e.g. a club set treated as a wedding) | Confidence gating, a "Mixed: adaptive" fallback, evidence shown, one-tap correction remembered per playlist, safety gates independent of the profile. |
| **Sparse or messy tags** | Audio rule layer plus user-tag k-NN; the profile is computed from soft counts; no single tag decides. |
| **Phone compute and battery** | DSP and inference only by default; NN opt-in while charging; desktop prep pack. |
| **Model sizes** | Optional, consented, SHA-pinned downloads; small Beat This!. |
| **Licensing** | Allow-list: Open-Unmix UMX-HQ (MIT per sigsep; trained on MUSDB18-HQ), Beat This! (MIT), CLAP fused / unfused / larger_clap_music (Apache-2.0), Signalsmith (MIT), Silero VAD (MIT, confirmed in its LICENSE file) for mic speech only. **HT-Demucs weights are not MIT**: the author says the licence "is not clear" (MusDB research-only data; the 6-stem model likely CC BY-NC), and the npm package says "personal and research use only". So **default to UMX-HQ** and offer HT-Demucs only as an opt-in download with a "personal / non-commercial use" consent; never bundle it, never default to it in store builds, and fix the wrong "MIT" wording in `server/stems.js` `DEFAULT_MODEL.licence`. Excluded: madmom models and Essentia (NC-SA), MERT (CC BY-NC 4.0, confirmed), Rubber Band (GPL / commercial, confirmed), essentia.js (AGPL-3.0, confirmed), Vande Veire's code (AGPL-3.0; ideas only). Evaluation only: All-In-One (weights tagged MIT, but its pipeline runs HT-Demucs), LinkSeg (no upstream licence; the port claims CC BY 4.0), COCOLA (no checkpoint licence; research-only training data). Key weights: none found. No classifier trained on third-party labels ships until its data licence is cleared. |
| **Mashup copyright** | Personal use only, no share or upload; live mashups are ephemeral. |
| **Timing** | Audio-clock scheduling and worklet events (P1). |
| **Stems** | Pre-queue; EQ fallback; residual-vocal gate. |
| **Non-4/4 and live music** | Meter and drift flags force safe techniques; profiles never override this. |
| **Privacy** of playlist names and history | Processed only on the device; never sent; deletable. |

---

## 15. Verification log (2026-11-21)

These items were flagged ⚠ when the plan was written, because several sites were blocked. On 2026-11-21 they were checked against primary sources where those were reachable. **Status key:** *confirmed* means the text was right; *corrected* means the text was changed; *still unverified* gives the reason. "Search only" means the source was seen through search-result excerpts, because its host was still unreachable from this session.

| Item | Status | Source |
|---|---|---|
| **HT-Demucs weights licence** | **Corrected**: not MIT. The author says the licence "is not clear" (MusDB research-only data; the 6-stem model likely CC BY-NC); the npm package says "personal and research use only"; the HF `license: mit` tag was removed on 2026-08-31. The default is now UMX-HQ (§1.3, §14). | [adefossez/demucs README](https://github.com/adefossez/demucs#license), [facebookresearch/demucs#327](https://github.com/facebookresearch/demucs/issues/327), [HF HTDemucs commits](https://huggingface.co/adefossez/HTDemucs/commits/main), [HF discussion 1](https://huggingface.co/adefossez/HTDemucs/discussions/1), npm `demucs@1.0.0` `LICENSE.md` |
| Open-Unmix UMX-HQ weights | Confirmed MIT (only UMX-L is NC). Caveat: trained on MUSDB18-HQ. The ONNX export covers the vocals stem only. The Zenodo record was not reachable. | [open-unmix-pytorch README](https://github.com/sigsep/open-unmix-pytorch#license), [edgetools/umx-hq](https://huggingface.co/edgetools/umx-hq) |
| Spleeter weights | Still unverified: the README says only "the code" is MIT; issue #898 is open with no maintainer answer. | [README](https://github.com/deezer/spleeter#license), [#898](https://github.com/deezer/spleeter/issues/898) |
| Silero VAD | Confirmed MIT. The "CC BY-NC" text is a stale badge alt-text; the badge image and the LICENSE file say MIT. | [LICENSE](https://github.com/snakers4/silero-vad/blob/master/LICENSE) |
| djay Automix AI / Neural Mix | Confirmed and expanded (§1.2). How the AI picks points is still not documented. | [help.algoriddim.com: Using Automix](https://help.algoriddim.com/user-manual/djay-pro-mac/mixing-basics/using-automix), [Neural Mix](https://help.algoriddim.com/user-manual/djay-pro-mac/neural-mix/overview), [Crossfader FX](https://help.algoriddim.com/user-manual/djay-pro-mac/dj-tools/effects/crossfader-fx) |
| Serato automix | Confirmed: there is none. Auto Play only plays the next track (search only). | [Serato support](https://support.serato.com/hc/en-us/articles/224859147-Software-Overview-DJ-Pro-3-0) |
| VirtualDJ Sandbox | Confirmed (search only). | [VirtualDJ manual](https://virtualdj.com/manuals/virtualdj/interface/topsection/appcontrols/sandbox.html) |
| Traktor "Autoplay" | Corrected to **Cruise Mode** (search only). | [NI support](https://support.native-instruments.com/support/solutions/articles/69000879534-traktor-using-the-traktor-cruise-mode-for-automatic-playback-of-your-tracks) |
| Spotify Mix status | Still labelled beta; desktop rollout May 2026 (search only). | [Spotify newsroom](https://newsroom.spotify.com/tag/playlist-mixing) |
| Vande Veire transition types | Confirmed from the code: "double drop", "rolling", "relaxed" (lengths and probabilities in §1.3). The code is AGPL-3.0. | [`tracklister.py`](https://github.com/lenvdv/dnb-autodj-3/blob/master/src/autodj/dj/tracklister.py) |
| Vande Veire "91 %" and "18 fans" | Still unverified: Springer, SpringerOpen and the author's blog are unreachable, and there is no arXiv copy. | — |
| Mosaikbox vocal rule | Confirmed from the paper (−40 dBFS, ≥1 s silences, <400 ms dropped, >2 s overlap means a clash). | [paper PDF](https://repositum.tuwien.at/bitstream/20.500.12708/212628/1/Sowula-2024-Mosaikbox%20Improving%20Fully%20Automatic%20DJ%20Mixing%20Through%20Rule-ba...-vor.pdf) |
| Kim et al. 2020 dataset size | Confirmed: 1,557 mixes, 13,728 tracks, 20,765 transitions. | [arXiv 2008.10267](https://arxiv.org/abs/2008.10267) |
| AutoMashup 2025 findings | Confirmed (asymmetry; CLAP and MERT fail). "O(n²)" is my reading, not in the abstract. | [arXiv 2508.06516](https://arxiv.org/abs/2508.06516) |
| Beat This! sizes | Corrected to about 78 MB (main) and 8.1 MB (small) per checkpoint; parameter counts not re-checked. | [README](https://github.com/CPJKU/beat_this) |
| All-In-One licence | Corrected: weights tagged MIT by the author, but the pipeline runs HT-Demucs. Evaluation only. | [taejunkim/allinone](https://huggingface.co/taejunkim/allinone), [config.py](https://github.com/mir-aidj/all-in-one/blob/main/src/allin1/config.py) |
| LinkSeg licence | Still unverified: the upstream repo has no licence file; the ONNX port claims CC BY 4.0. | [morgan76/LinkSeg](https://github.com/morgan76/LinkSeg), [elicwhite/linkseg-7c-onnx](https://huggingface.co/elicwhite/linkseg-7c-onnx) |
| COCOLA licence | Code MIT; checkpoint licence not stated; trained partly on research-only data. Evaluation only. | [repo](https://github.com/gladia-research-group/cocola), [arXiv 2404.16969](https://arxiv.org/abs/2404.16969) |
| CLAP unfused | Confirmed Apache-2.0 (also `larger_clap_music`). | [laion/clap-htsat-unfused](https://huggingface.co/laion/clap-htsat-unfused) |
| MERT | Confirmed CC BY-NC 4.0. | [m-a-p/MERT-v1-95M](https://huggingface.co/m-a-p/MERT-v1-95M) |
| Rubber Band, essentia.js | Confirmed: GPL-2.0+ or commercial (App Store needs a commercial licence); AGPL-3.0. | [Rubber Band README](https://github.com/breakfastquay/rubberband), [essentia.js LICENSE](https://github.com/MTG/essentia.js/blob/master/LICENSE) |
| WebGPU in iOS WKWebView | Still unverified: Safari 26 has it; there is no official WKWebView statement (search only). Test on a device. | [WebKit bug 299237](https://bugs.webkit.org/show_bug.cgi?id=299237), [Apple forum](https://developer.apple.com/forums/thread/770862) |
| Band-SCNet code and licence | Still unverified (not reached in this pass). | — |
| CLAP zero-shot quality on manele / hora | Still unverified; needs measurement. | — |
| Beat This! small browser speed | Still unverified; needs measurement. | — |
| Sepp and Arapu | Confirmed as Romanian minimal DJs and producers (search only). | [MEOKO](https://meoko.net/interviews/an-exclusive-interview-with-sepp), [fabric](https://www.fabriclondon.com/posts/audio-arapu-wys-mix) |
| DJ Project, Matteo, Morandi, Andra, Smiley | Still unverified: Wikipedia and Romanian hosts are unreachable. | — |
| Neversea history | Confirmed: first edition 2017, about 153k attendees (search only). | [Romania Insider](https://www.romania-insider.com/romania-neversea-2017/) |
| Veil / midnight ritual | Confirmed as a common but regional custom: the nașa swaps the veil for a headscarf (search only). | [BZI](https://www.bzi.ro/ce-trebuie-sa-cumpere-nasa-la-nunta-iata-care-sunt-obiceiurile-pe-care-este-bine-sa-le-respecte-5204317) |
| Colaj as a DJ practice | Still partly inference: colaj medleys are common, but mostly by bands; no source on DJs building them live. | [Vice RO](https://www.vice.com/ro/article/piese-ciudate-la-nunti-in-romania/) |
| Manele, hora, sârba and popcorn BPM ranges | Still unverified: no reliable source; the plan measures tempo per track instead. | [Melodigging](https://www.melodigging.com/genre/manele) (unsourced) |
| Numbers (profile thresholds, wedding block sizes, accuracy, latency, storage) | Not facts to verify: these are design targets to tune and measure. | — |
