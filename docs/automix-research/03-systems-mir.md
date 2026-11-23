# 03 — Automatic DJ Mixing Systems & the MIR Analysis They Need

Audience: engineers improving an automix engine in a browser DJ app (JS, Web Audio, offline analysis in a Web Worker; already has BPM, key, beatgrid, partial phrase detection, energy, optional stems).

> **Source caveat.** In this research session, direct page fetches to arXiv mirrors and Springer were blocked by the network sandbox (ar5iv.labs.arxiv.org and link.springer.com). Facts below come from search-engine extracts of the papers and vendor docs, plus established MIR knowledge. Items marked **[verify]** are from memory or a secondary summary and should be checked against the PDF before you hard-code a constant. Primary URLs are given for every item.

---

## 0. TL;DR for the engine team

1. **Phrase is everything.** Every serious system (Vande Veire 2018, Zehren 2020/22, CUE-DETR 2024, Mosaikbox 2024, DJustify 2026) snaps cues to **downbeats on 8/16/32-bar phrase boundaries**, at structural novelty peaks (intro end, breakdown start, drop). DJustify's ablation suggests **cue placement contributes most of the quality gap** over a naive crossfade.
2. **Real DJs barely touch tempo/key.** Kim et al. (ISMIR 2020, 1,557 mixes, 20,765 transitions): **86.1% of tracks played within ±5% of original BPM**, and key transposition is rare (master-tempo/keylock is on). So prefer *choosing* compatible next tracks over heavy stretching. Ishizaki 2009 formalized this as a "discomfort vs. tempo-change" cost.
3. **Transitions are sub-band, not broadband.** Kim/Yang/Nam (NIME 2021, DAFx 2022) show sub-band (3-band EQ) gain trajectories reconstruct real mixes much better than a linear crossfade. The canonical pattern is: incoming track enters with lows cut → mids/highs fade up → **bass swap on a downbeat (often a phrase boundary)** → outgoing highs/mids fade out.
4. **Decide whether to beatmatch at all.** Use beat-tracking confidence (tempo stability, onset-strength periodicity, downbeat consistency). Low confidence (live drums, rubato, tempo drift, beatless ambient) → short equal-power fade or a cut on silence, not a long beatmatched blend. VirtualDJ's "Smart" mode does exactly this: tempo blend if possible, otherwise a cut.
5. **Use stems to avoid clashes.** Vocal-over-vocal and bass-over-bass are the two big failure modes. Mosaikbox (ISMIR 2024) showed rule-based stem removal during transitions measurably improves listening ratings; djay's Neural Mix transitions are commercially the same idea.
6. **Evaluate with a cheap objective checker plus occasional listening tests.** Checks: loudness continuity (short-term LUFS dip/bump), low-band overlap energy, beat-phase error, key distance, vocal overlap. DJustify uses exactly such a "render → acoustic check → repair" loop.

---

## 1. Academic work

### 1.1 Kim, Choi, Sacks, Yang, Nam — "A Computational Analysis of Real-World DJ Mixes using Mix-To-Track Subsequence Alignment" (ISMIR 2020)
- Paper: https://arxiv.org/abs/2008.10267 · PDF: https://archives.ismir.net/ismir2020/paper/000352.pdf · Code: https://github.com/mir-aidj/djmix-analysis · Project: https://mir-aidj.github.io/djmix-analysis
- **Data:** 1,557 mixes from 1001Tracklists, 13,728 unique tracks, 20,765 transitions; mostly House/Trance.
- **Method:**
  1. Beat-track mix and track (madmom). Compute **beat-synchronous chroma + MFCC**.
  2. **Key-invariant subsequence DTW** of each track against the mix. Cost is the minimum over the 12 chroma rotations, which makes it robust to transposition. Beat-synchronous frames make it robust to tempo change.
  3. The warping path gives, per track, the mix-time region it occupies → **cue-in, cue-out, transition region = overlap of consecutive tracks**, plus tempo ratio (warp slope) and key shift.
  4. Refinement gives tight boundaries. The "transition length" analysis uses EQ-curve estimates (later papers).
- **Findings (verified from extracts):**
  - Tempo: **86.1% of tracks adjusted < 5%** from original BPM; distribution peaked at zero.
  - Key: DJs **rarely transpose**. Keylock is on, and harmony is managed by selection.
  - Hypotheses supported: DJs avoid tempo/key changes, and transitions respect track structure (cues on phrase/segment boundaries).
- **Findings [verify in PDF]:** transition-length histograms clustered at powers of two in bars (16, 32, 64 bars common; long House/Trance blends ≈ 32 bars ≈ 60 s at 128 BPM). Cue-in points show high agreement across DJs for the same track (they coincide with the end of the intro / first phrase boundary); cue-out points vary more.
- **Implementable takeaway:** the same subsequence-DTW tool can *learn your own cue statistics* from user mixes. In JS, beat-sync chroma + DTW is cheap (O(N·M) over beats, a few thousand × a few hundred).

### 1.2 Kim, Yang, Nam — "Reverse-Engineering the Transition Regions of Real-World DJ Mixes using Sub-band Analysis with Convex Optimization" (NIME 2021)
- https://nime.pubpub.org/pub/g7avj1a7 · Code + web demo: https://github.com/mir-aidj/transition-analysis
- Splits mix and both source tracks into sub-bands (3-band, like a DJ mixer: low/mid/high). Solves a **constrained convex problem**: find non-negative, smooth, time-varying gains g_prev,b(t), g_next,b(t) that minimize ‖mix_b − g_prev,b·prev_b − g_next,b·next_b‖. Uses 3,930 transition regions.
- Result: **sub-band gains (with scaling) reconstruct mixes better than linear crossfade or single-band gains**, which is quantitative evidence that DJs EQ during transitions. The web demo shows the typical shape: next track's low band stays near 0 until a sharp switch, while mids/highs ramp.
- **Formulation you can reuse to fit your own presets:**
  ```
  minimize Σ_t Σ_b (|M_b(t)| − a_b(t)|A_b(t)| − c_b(t)|B_b(t)|)^2 + λ Σ_t (Δa_b(t)^2 + Δc_b(t)^2)
  s.t. 0 ≤ a_b, c_b ≤ 1.2 ;  optionally a_b non-increasing, c_b non-decreasing
  ```
  (STFT magnitudes summed per band at frame rate. Solve with projected gradient. Easy in JS.)

### 1.3 Kim, Yang, Nam — "Joint Estimation of Fader and Equalizer Gains of DJ Mixers Using Convex Optimization" (DAFx 2022)
- https://mac.kaist.ac.kr/pubs/KimYangNam-dafx2022.pdf · Code/data: github.com/mir-aidj/djmixer-estimation
- 5,040 real mixes, **50,742 transitions**. Approximates each EQ filter as fixed-EQ-shape × gain + constant gain, which turns joint fader+EQ estimation into a convex problem. Beats prior methods and baselines on mix reconstruction.
- **Use:** this gives *learned EQ/fader curves* that can replace hand-designed automation. Cluster the estimated (fader, low, mid, high) trajectories into 4–8 prototype transitions and ship them as presets.

### 1.4 Raveform (TISMIR 2026) — Kim et al., KAIST/mir-aidj
- https://transactions.ismir.net/articles/10.5334/tismir.288 · https://mir-aidj.github.io/raveform
- 4,902 DJ-mix links, 56,873 track links, **1,423 EDM tracks with expert metrical + functional structure annotations**. Uses an EDM-specific vocabulary (intro/build-up/drop/breakdown/outro and similar). Analyzes DJ mixes by segment length, flow, and sub-band energy, and releases trained structure models.
- **Most relevant modern dataset/model** for EDM phrase + section labelling. It is a good teacher for distilling a small ONNX model you could run in the worker.

### 1.5 All-In-One structure analyzer (Kim & Nam, WASPAA 2023)
- https://arxiv.org/abs/2307.16425 · https://github.com/mir-aidj/all-in-one (pip `allin1`)
- Joint beat, downbeat, segment boundary, and functional label (intro/verse/chorus/bridge/outro…) prediction. Input is **Demucs-demixed** spectrograms (4 stems) with dilated neighborhood attention. Trained on Harmonix Set.
- Too heavy for real-time JS, but feasible **offline** via onnxruntime-web/WebGPU if you already run stem separation. At minimum, use it to generate training labels for a lighter model.

### 1.6 Schwarz & Fourer — DJ-mix reverse engineering / "unmixing"
- "Methods and Datasets for DJ-Mix Reverse Engineering" (CMMR 2019 / LNCS 2021): https://hal.archives-ouvertes.fr/hal-02172427 · UnmixDB: https://hal.archives-ouvertes.fr/hal-02010431 (data: https://doi.org/10.5281/zenodo.1422385) · Earlier: https://hal.archives-ouvertes.fr/hal-01671768
- Pipeline: (1) identify tracks in mix; (2) align by DTW / sample-level time-scale estimation; (3) estimate **cue points and fade curves in the time-frequency domain**, which is robust to interference from the other track. UnmixDB is synthetic beat-synced mixes (3 × ~40 s excerpts, 12 variants each, with different fade shapes and effects). The metric is fade-curve error in dB/s.
- Follow-up: André, Fourer, Schwarz 2024 "DJ Mix Transcription with Multi-Pass NMF": https://arxiv.org/abs/2410.04198. It does DTW alignment, then multi-pass NMF to estimate per-track gain curves.

### 1.7 Vande Veire & De Bie — "From raw audio to a seamless mix: creating an automated DJ system for Drum and Bass" (EURASIP JASMP 2018)
- Paper: https://asmp-eurasipjournals.springeropen.com/articles/10.1186/s13636-018-0134-8 · Code: https://github.com/lenvdv/dnb-autodj-3 · Blog: https://lenvdv.github.io/2018-03-20-autodj
- The first fully automatic, open-source, end-to-end DJ system. Evaluated with **18 DnB fans** in a listening test, which found mixes of "high quality". Its MIR stack fully annotated (tempo, beats, downbeats, structure) **91%** of 160 + 220 held-out DnB tracks.

**Pipeline (bottom-up, genre-constrained). Details marked [verify] are from my recollection of the paper:**
1. **Tempo/beat tracking.** Assumes **constant tempo** within a track and a DnB range (~160–190 BPM). Uses an onset-strength autocorrelation tempo estimate, then fits a single-phase beat grid (no tempo drift modelled). Constant-tempo assumption → robust, cheap grid.
2. **Downbeat tracking.** Per-beat features (onset strength/loudness in several frequency bands around each beat, timbral descriptors), then a **trained classifier (logistic regression / SVM) [verify]** gives P(beat is downbeat). Because DnB is strictly 4/4, they **aggregate over the whole track**: choose the phase k ∈ {0,1,2,3} maximizing Σ log P(downbeat) for beats i ≡ k mod 4. This "global phase vote" is extremely robust and trivial to port.
3. **Structural segmentation.** Self-similarity matrix on beat/downbeat-synchronous features, then a **Foote checkerboard novelty curve**. Boundaries are **constrained to downbeats at multiples of 8 bars [verify: phrase grid of 8 downbeats]** from the first downbeat. Genre rules refine Foote boundaries (a later Signals 2024 paper describes it as "refining Foote's boundaries with genre knowledge").
4. **Segment labelling ("high"/"low" energy).** Each segment gets **high** (drop/main section, full drums + bass) or **low** (intro, breakdown, build/outro) from loudness/bass-band energy relative to track statistics. Only "high" segments are considered the recognizable "core".
5. **"Singularity"/drop detection.** The key anchor is the **low→high boundary (the drop)**. Cue points are defined relative to drops: the incoming track's cue-in is placed so that its drop lands on a phrase boundary of the outgoing track.
6. **Song selection.** Candidates must be (a) **key-compatible** (same key, relative major/minor, ±1 fifth on the circle of fifths), (b) style/timbre-similar (feature vector from MFCC/spectral stats, compared against a slowly drifting "theme" centroid to keep set coherence), (c) consistent with the energy plan. All tracks are **time-stretched to a common tempo (~175 BPM) [verify]**.
7. **Transition types (three):**
   - **Double drop:** both tracks' drops coincide. The incoming build-up plays under the outgoing track's build-up/breakdown, and both drop together. The outgoing bass is cut at the drop and the incoming bass takes over. The outgoing track then fades within a phrase or two. High-energy, short.
   - **Rolling:** the incoming track's drop lands **while the outgoing track is still in a high section**. This keeps energy continuous ("rolling"). The bass swap happens exactly at the incoming drop, and the outgoing track exits at its next phrase boundary.
   - **Relaxed:** the outgoing track is in a **low** segment (breakdown/outro) and the incoming track enters in its intro. Longer, gentler volume/EQ fades, used to lower energy.
   - Type selection is driven by the current segment type of the outgoing track and a desired energy trajectory.
8. **EQ/volume automation.** Three-band style: incoming track starts **low-cut** (high-pass / bass killed). Mids/highs fade in over the build phrase. **Hard bass swap on the downbeat of the drop** (out-bass → 0, in-bass → 1, within one beat). The outgoing track's mids/highs fade over the remaining 1–2 phrases. Volume fades are typically linear-in-dB over whole phrases.
- **Reported weaknesses:** structure segmentation and segment pairing need improvement, and DnB-only.

**Port to JS (pseudocode):**
```js
// Downbeat phase vote (4/4)
const phaseScore = [0,0,0,0];
for (let i = 0; i < beats.length; i++) phaseScore[i % 4] += Math.log(pDown[i] + 1e-6);
const phase = argmax(phaseScore);              // first downbeat = beats[phase]
// Phrase grid
const bars = beats.filter((_, i) => (i - phase) % 4 === 0);
const phraseStarts = bars.filter((_, j) => j % 8 === 0);   // 8-bar phrases; also test 16/32
```

### 1.8 Zehren, Alunno, Bientinesi — cue/"switch" point detection (arXiv 2020; Computer Music Journal 46(3) 2022; thesis 2024)
- arXiv: https://arxiv.org/abs/2007.08411 · CMJ: https://direct.mit.edu/comj/article-pdf/46/3/67/2164818/comj_a_00652.pdf (also https://www.diva-portal.org/smash/get/diva2:1811100/FULLTEXT02.pdf) · Thesis: https://www.diva-portal.org/smash/get/diva2:1887409/FULLTEXT01.pdf · Follow-up: "Interpretability of Methods for Switch Point Detection in EDM", Signals 2024, https://www.mdpi.com/2624-6120/5/4/36
- Rules from **interviews with professional DJs**, implemented as features + novelty:
  1. Cues sit on **downbeats** that start a **period/phrase** (4-bar unit; candidates on 4-bar grid, preferring 8/16/32-bar alignment).
  2. Cues sit at **high-novelty** points: changes in energy/timbre/instrumentation (drums in/out, bass in/out, vocal entry).
  3. Prefer the **first strong structural change** (e.g. intro end) for cue-in, and the start of the last low-energy section for cue-out.
- Evaluation: **Hit rate**, where a candidate is a hit if within **±0.5 s** of an annotation. Precision is prioritized because you only need one good cue, not all of them. Listening ratings: **~96% of generated points "good for a DJ mix"** (arXiv), and **~90% on unseen tracks** (CMJ). Dataset M-DJCUE (annotator agreement on 185 switch points).
- **Implementation recipe:** novelty = Σ over features (RMS, low-band RMS, spectral flux, MFCC Foote novelty) at **bar resolution**, keep peaks on 4-bar grid, rank by novelty × phrase-alignment bonus (×1.0 at 32-bar, ×0.8 at 16, ×0.6 at 8, ×0.3 at 4).

### 1.9 Argüello, Lanzendörfer, Wattenhofer — "Cue Point Estimation using Object Detection" (ISMIR 2024, CUE-DETR)
- https://arxiv.org/abs/2407.06823 · https://github.com/ETH-DISCO/cue-detr
- Fine-tunes a **DETR object detector on mel-spectrogram "images"**, with cue points as boxes. **EDM-CUE dataset: 4,710 tracks, 21k expert cue points** (35× larger than prior). Snaps outputs to 8- or 16-bar phrasing.
- Beats Mixed In Key and a rule baseline on precision/recall/F1. Cosine similarity to GT: **CUE-DETR 0.851, MIK 0.371, "Automix" baseline 0.425**.
- Implication: learned cue placement now outperforms commercial heuristics. The model is a ViT-ish DETR, which you could run offline in onnxruntime-web, but is heavy (~40M params). A cheaper path is to use EDM-CUE to **tune your rule weights**.

### 1.10 Chen et al. — DJtransGAN: "Automatic DJ Transitions with Differentiable Audio Effects and Generative Adversarial Networks" (ICASSP 2022)
- https://arxiv.org/abs/2110.06525 · code: github.com/ChenPaulYu/DJtransGAN
- Generator does not output audio. It outputs **parameters of differentiable DJ effects**: per-track **3-band EQ gain curves (low/mid/high shelving/peaking) + fader curves**, parametrized as smooth monotone curves (sigmoid-like "fade" primitives with learned start/end/slope) over a fixed-length transition window (pre-aligned, beat-synced cue region). The discriminator compares rendered transitions with real DJ transition audio cut from mixes (livetracklist).
- Pairing via a "Music Puzzle Game" **mixability score** (a learned model predicting whether two segments are adjacent).
- Listening test: Preference and Smoothness (5-point), "Melodious" (3-point, for clashes). Competitive with baselines (linear crossfade, rule-based EQ crossfade, and others).
- **Takeaway:** the *search space* is small. A transition = {start time, length, per-band (start, end, steepness) for each deck}. You can parametrize your engine the same way and then tune presets or do a cheap search (§3).

### 1.11 Bittner et al. (Spotify) — "Automatic Playlist Sequencing and Transitions" (ISMIR 2017)
- https://archives.ismir.net/ismir2017/paper/000086.pdf · https://ir.webis.de/anthology/2017.ismir_conference-2017.55
- Authors include Bittner, Humphrey, Jehan, Montecchio (Spotify/Echo Nest lineage). Two parts: (a) **sequencing**, which orders a set of tracks by a pairwise transition-cost graph (tempo, key, energy, timbral distance), solved as a path/TSP-like problem; (b) **transitions**, which pick an overlap region near the end of A / start of B, beat-align, and crossfade, with timing chosen from beat/section analysis [verify specifics].
- Evaluation: **professional curators rated each full transition Good / OK / Bad**, and the paper reports the distribution. This is a practical and cheap rubric for your own QA.

### 1.12 Ishizaki, Hoashi, Takishima (KDDI) — "Full-Automatic DJ Mixing System with Optimal Tempo Adjustment based on Measurement Function of User Discomfort" (ISMIR 2009)
- https://zenodo.org/records/1418231 (PDF: https://zenodo.org/records/1418231/files/IshizakiHT09.pdf)
- Idea: rather than stretch track B to A's tempo, measure **listener discomfort as a function of tempo-change ratio** (listening experiments, comparing SOLA vs SoundTouch time-stretch). Then pick the **intermediate tempo** for the transition that minimizes total discomfort of both tracks: both are stretched partway.
- Formalization for your engine:
  ```
  D(r) = discomfort for stretch ratio r (convex, ~0 within ±2–3%, rising sharply past ~±6–8%) [shape; verify numbers]
  T* = argmin_T  D(T/T_A) + D(T/T_B)
  if min > threshold: don't beatmatch → use fade/cut or a tempo ramp over the transition
  ```
  This matches Kim 2020's empirical finding (86% within ±5%).

### 1.13 Sowula & Knees — "Mosaikbox: Improving Fully Automatic DJ Mixing Through Rule-based Stem Modification and Precise Beat-Grid Estimation" (ISMIR 2024)
- https://zenodo.org/records/14877463 · Paper PDF: https://repositum.tuwien.at/bitstream/20.500.12708/212628/1/Sowula-2024-Mosaikbox%20Improving%20Fully%20Automatic%20DJ%20Mixing%20Through%20Rule-ba...-vor.pdf · Thesis: https://repositum.tuwien.at/handle/20.500.12708/197485
- EDM-focused full system: song selection (key, tempo, energy, timbre) + **precise beat-grid estimation** + structure-aware cue choice + **rule-based stem removal** during overlap (e.g. mute incoming vocals while outgoing vocals play, keep only one bass). Listening test: **significantly better than baseline and prior state of the art (incl. Vande Veire-style system)**, and stem rules improved ratings.
- This is the closest academic analogue to your app. Treat its stem rules as the baseline to beat.

### 1.14 2024–2026 work
- **DJustify (arXiv 2610.33434, 2026)**, Hsu, Lin, Lai, Huang, Liu, Su, Yang: https://arxiv.org/abs/2610.33434. An **LLM planner** in a *reason → propose → verify → repair* loop. It jointly picks the next track, cue points, and mixing technique. An **external acoustic checker** scores the rendered transition and triggers repair. Blind tests: beats Mosaikbox, a re-implemented crossfade, and a cue-only baseline. **Most of the margin comes from cue placement.** Emotion-arc set ordering showed no measurable gap from a human DJ on story/transition ratings. *Architecture lesson:* keep deterministic DSP and checks, and let the "smart" layer only choose among verified candidates.
- **MixWeaver (ISMIR 2026 submission, per a public review):** search over **stem-wise gain trajectories** for intro/outro blends. Reviewers criticized missing calibration baselines. https://cseweb.ucsd.edu/~jmcauley/reviews/ismir26c.txt
- **"DJ AI" (Audio Mostly 2025, Sabancı):** playlist alignment + generative/embedding models. Scores transitions with **chroma cosine distance + DTW**, and blind tests beat plain crossfades. https://dl.acm.org/doi/10.1145/3771594.3771640 · https://research.sabanciuniv.edu/52373/1/AI_DJ_AM2025.pdf
- **Generative transitions (diffusion):** "Controllable Music Production with Diffusion Models and Guidance Gradients" (NeurIPS 2023 workshop) demonstrates **generating smooth transitions between two tracks** via inpainting/guidance: https://neurips.cc/virtual/2023/74842. Lund MSc thesis 2026 "Latent Space Interpolation for Music Transitions" evaluates with magnitude-squared coherence vs crossfade + A/B tests: https://lup.lub.lu.se/luur/download?func=downloadFile&recordOId=9225409&fileOId=9225410. **Not browser-feasible in real time.** It is also off-genre for DJs, who want the original audio preserved.
- **Zero-shot "DJ tool" retrieval** (speech activity + structure + CLAP), useful for finding acapella/instrumental-friendly regions: https://arxiv.org/abs/2411.12209

---

## 2. Analysis algorithms (implementable in a JS Web Worker)

Assume mono 22.05 or 44.1 kHz Float32Array, STFT (hop 441 @ 44.1k = 10 ms, or hop 512), and a JS FFT (e.g. fft.js / pffft-wasm). Complexity is per 6-minute track.

### 2.1 Onset strength / spectral flux
```
X = |STFT|, logX = log(1 + γ·X) (γ≈100), optionally mel/log-freq filterbank (~80 bands)
flux[t] = Σ_k max(0, logX[t,k] − logX[t−1,k])           // half-wave rectified
flux = flux − movingAverage(flux, ~0.5 s); clip at 0; normalize
```
Use **band-split flux** (low <150 Hz: kick; mid 150–2k: snare/claps; high >5k: hats) for downbeat and drum-presence features. Cost is O(N log N). Trivial in a worker (<1 s per track with wasm FFT).

### 2.2 Tempo
- **Autocorrelation / tempogram** of flux over 60–200 BPM, weighted by a log-normal prior centered ~120 BPM (Ellis) or a genre-specific prior. Resolve octave errors with a comb-filter score at T, 2T, T/2, 3T/2.
- **Tempo stability metric** (key for "safe to beatmatch"): compute a local tempogram (8 s windows, 1 s hop) and measure the **std of local BPM** and the **fraction of windows whose peak is within 1% of the global BPM**.

### 2.3 Beat tracking options
| Method | Quality on EDM | Quality on live/variable | JS feasibility |
|---|---|---|---|
| **Ellis 2007 DP beat tracker** | Good | Fair (assumes near-constant tempo) | Excellent: O(N·window), ~50 lines |
| **Constant-tempo grid fit** (Vande Veire / DJ software style) | Excellent (sample-accurate grid) | Poor | Excellent |
| madmom RNN + DBN (Böck 2016) | Very good | Good | Needs ONNX (~few MB) + JS DBN/HMM |
| BeatNet (Heydari 2021, CRNN + particle filter, online) | Good | Good | ONNX feasible; built for streaming |
| **Beat This! (Foscarin, Schlüter, Widmer, ISMIR 2024)**, conv+transformer, *no DBN*, SOTA F1 | Very good | Very good (trained on varied tempo/solo/classical) | ONNX feasible offline (small model, ~20M params [verify]); weaker continuity metrics, so add your own grid fit for EDM |

Paper/code: https://arxiv.org/abs/2407.21658 · https://pypi.org/project/beat-this/

**Ellis DP (pseudocode):**
```js
// onset env O[t], period τ (frames), α ≈ 100–680 (tightness)
for t in 0..N-1:
  best = -Inf; arg = -1
  for p in [t - 2τ, t - τ/2]:   // predecessor window
    pen = -α * (Math.log((t - p) / τ))**2
    if (C[p] + pen > best) { best = C[p] + pen; arg = p }
  C[t] = O[t] + max(0, best); P[t] = arg
// backtrack from argmax C over the last τ frames
```
**Recommended hybrid for a DJ app:** DP or Beat-This beats → **robust linear regression** (Huber/RANSAC) of beat time vs index → if residual RMS < 10–15 ms and slope stable across halves, **snap to a constant grid** (sample-accurate, what DJs expect). Otherwise keep a **dynamic grid** (piecewise-linear tempo map) and **flag "variable tempo"**.

### 2.4 Downbeat & bar
- Features per beat: low-band flux (kick), harmonic change (chroma novelty between beats: chords change on downbeats), mid-band flux, spectral centroid. Score each of 4 phases. For 4/4 EDM, **global phase vote** (§1.7). Then **local verification** in 32-bar windows to catch inserted 2/4 bars or edits (re-vote per window; if a window disagrees with strong margin, insert a phase shift at the nearest novelty peak).
- ML alternative: madmom DBN downbeat / Beat This (it also outputs downbeats) / All-In-One.

### 2.5 Phrase (8/16/32-bar) boundaries
1. Bar-synchronous features: RMS, low-band RMS (20–150 Hz), high-band RMS (hats), chroma (12), MFCC 1–13, drum-presence (band flux energy), vocal probability (§2.7).
2. **Self-similarity matrix** S[i,j] = cos(f_i, f_j) at bar resolution (≈ 200 bars → 40k cells, trivial).
3. **Foote novelty:** convolve the diagonal with a Gaussian-tapered checkerboard kernel of size 2L (L = 8 bars, plus L=4 and 16 for multi-scale).
   ```
   nov[i] = Σ_{a,b=-L..L-1} K[a,b] · S[i+a, i+b],  K = sign(a)·sign(b)·gauss
   ```
4. **Phrase-grid prior:** for each candidate phrase offset o ∈ {0..7} (in bars), score Σ nov[o + 8k]. Choose the offset with max score (EDM tracks sometimes start with a pickup bar or have a 1–2 bar intro offset). Boundaries = peaks of nov that lie within ±1 bar of the 8-bar grid; prefer 16/32 multiples.
5. Also add **energy-step detection**: |Δ low-band RMS| between consecutive 4-bar blocks. Drops/breakdowns are huge steps in low-band energy and drum presence.
6. **Repetition cue:** strong off-diagonal stripes in S at lag 16 or 32 bars → confirms phrase length.

Complexity is tiny once bar features exist. Raveform/All-In-One are the learned upgrade.

### 2.6 Section labelling (intro / build / drop / breakdown / outro)
Rule-based EDM labeller over phrase segments (works well, matches Vande Veire "high/low"):
```
for seg in segments:
  E  = mean RMS (dB rel. track LUFS), Lo = low-band ratio, D = drum presence (kick periodicity strength),
  dE = slope of RMS/high-band within seg, R = snare-roll/riser indicator (rising flux density + rising centroid)
label:
  first segs with D low or Lo low until first high seg      -> INTRO (DJ-friendly if D high & Lo low = "drum intro")
  high E & high Lo & D high                                  -> DROP / MAIN
  low Lo after a DROP, D low                                  -> BREAKDOWN
  seg before a DROP with dE>0 or R high                       -> BUILD
  trailing segs after last DROP with falling E or Lo low      -> OUTRO
```
Mark **"mix-friendly"** regions: intro/outro segments with *drums present, low bass or no bass, no vocals, low harmonic density*. These are ideal overlap zones and exactly the DJ-edit "intro/outro" convention (16/32 bars of beat-only).

### 2.7 Vocal activity detection
- **With stems (preferred):** vocal stem RMS per beat, gated at −40 dBFS relative to stem peak plus a spectral-flatness check (reject separation bleed). Smooth with median over 2 beats. Output `vocal[bar] ∈ [0,1]`.
- **Without stems:** cheap heuristics include harmonic energy 300 Hz–3.5 kHz with high spectral-flux variance in 1–4 kHz and **vibrato/pitch-contour** detection (YIN/pYIN on a mid-band, voiced frames with f0 300–1000 Hz and continuous contours). Better is a tiny CRNN VAD (e.g., ~100k params trained on MUSDB/Jamendo VAD) via ONNX.
- **Rule:** never overlap vocal bars of A with vocal bars of B (Mosaikbox, djay, DJustify all treat vocal clash as a hard penalty). If unavoidable and stems exist, **duck/mute vocals of the incoming track** until the outgoing vocals end.

### 2.8 Key detection
- Chroma (constant-Q or STFT-folded HPCP: harmonic peaks only, 4–8 harmonics weighted, 36 bins, tuning-corrected) → average over track (or only "high" segments) → correlate with 24 rotated profiles:
  - **Krumhansl–Kessler** (classic, biased to major), **Temperley** (better on pop), **Shaath** (used in KeyFinder), **EDMA/EDMM (Faraldo 2016/17)**, profiles derived from EDM corpora. EDMA is best on EDM but **tends to report major as minor**. Use the `useMajMin` variant or a multi-profile approach. Essentia Key docs: https://essentia.upf.edu/reference/std_Key.html · Faraldo code: https://github.com/angelfaraldo/edmkey · thesis: https://zenodo.org/records/1154586/files/Faraldo_PhDThesis.pdf
- **Confidence:** margin between best and second-best correlation. Low confidence (atonal techno, drums-only) → treat key as "unknown/compatible with all" rather than forcing Camelot rules.
- **Per-segment key** matters for long blends: compute key over the *overlap region* only.

### 2.9 Loudness and per-band energy
- **ITU-R BS.1770-4 / EBU R128:** K-weighting (high-shelf +4 dB @ ~1.5 kHz pre-filter, then RLB high-pass ~38 Hz), mean square over 400 ms blocks with 75% overlap, gating (absolute −70 LUFS, relative −10 LU) → integrated LUFS. **Short-term loudness** (3 s window) and **momentary** (400 ms) curves are what you need for transitions. Both are cheap biquads in JS (`OfflineAudioContext` + `BiquadFilterNode` or manual IIR).
- Normalize each deck's gain to a target (e.g. −9 to −8 LUFS integrated for club EDM, or match the outgoing track's *section* short-term loudness) **before** the transition.
- **Per-band energy at beat resolution** (Linkwitz–Riley 3-band split at ~200 Hz and ~2.5 kHz, matching DJ mixer isolators) gives the substrate for EQ planning and clash metrics.

### 2.10 Mixability metrics between segment A_out and B_in
```
harmonic:   H = cos(chromaA_seg, chromaB_seg)  (or key distance via Camelot: 0 same, 1 adjacent/relative, ≥2 penalize)
rhythmic:   R = cos(onset-pattern histograms over a bar, 16 or 48 bins per bar, per band)   // kick/snare/hat patterns
timbral:    T = 1 − dist(MFCC mean/cov) normalized
low-band:   L = overlap of bass energy profiles (want LOW during overlap → bass swap required)
vocal:      V = Σ_bars vocA·vocB   (want 0)
energy:     ΔE = |LUFS_short(A_end) − LUFS_short(B_start_of_main)|
tempo:      Dt = discomfort(|1 − BPM_B/BPM_A|)  (§1.12), allow half/double time
score = w·[H, R, T, −V, −ΔE, −Dt]   // learn w from user ratings / skips
```
Learned alternatives: DJtransGAN's "Music Puzzle Game" mixability (adjacency classifier), CLAP embedding cosine.

### 2.11 "Is beatmatching safe?" (beat confidence gate)
```
conf_tempo   = fraction of 8 s windows with local BPM within 1% of global
conf_grid    = 1 − clamp(residualRMS_ms / 30)              // from grid regression (§2.3)
conf_pulse   = normalized autocorr peak height of low-band flux at beat period
conf_down    = margin of downbeat phase vote / #bars
safe = min(conf_tempo, conf_grid) > 0.8 && conf_pulse > 0.3
if !safe for either track at its cue region:
   -> style = "fade" (equal-power, 2–8 s) or "cut on downbeat/silence" or "echo-out then start"
   -> never stretch > 3% ; no long overlap
```
Also gate per *region*. A track may be steady in the body but have a free-time intro. Use only the steady region for overlap. If the incoming intro is beatless (ambient pad), a "relaxed" fade-in under the outgoing outro is fine without beatmatching.

---

## 3. Transition planning: a concrete algorithm for the engine

```
inputs: track A (playing), candidate B; analyses (grid, phrases, sections, vocal[], bandEnergy[], key, LUFS, confidences)

1. Candidate cue-outs on A: phrase starts within last ~40% of A whose section ∈ {OUTRO, BREAKDOWN, last DROP end};
   score by Zehren-style novelty × phrase-level bonus (32>16>8) × mixFriendly(A, region).
2. Candidate cue-ins on B: phrase starts in first ~30%: intro start, first "drum intro" phrase, build start such that DROP lands on A's phrase.
3. For each (outA, inB, Lbars ∈ {8,16,32,64}), check:
      - alignment: B's [inB, inB+L] overlaps A's [outA, outA+L], both phrase-aligned
      - vocal overlap V == 0 (or resolvable by stem mute)
      - beat-safety gates; tempo discomfort (choose stretched or meet-in-middle tempo; Ishizaki)
      - key compatibility of overlap region
      - A doesn't end (or become silent) before overlap ends
   Template choice (Vande Veire-style):
      - A in OUTRO/BREAKDOWN & B in INTRO           -> "relaxed/long blend" (16–32 bars), bass swap at mid phrase boundary
      - B's DROP can land where A's DROP/BUILD end  -> "double drop" (8–16 bars) or "rolling" (B drop during A main)
      - low beat confidence / big tempo gap          -> "fade" (2–8 s) or "echo out + cut"
      - vocal clash unavoidable without stems        -> shorten L to the vocal-free window, or "cut" on phrase
4. Render automation (beat-quantized):
      in-track:  low = 0 until swapBar, then → 1 within 1 beat;
                 mid/high ramp 0→1 over first half (linear in dB, e.g. −24 dB→0);
                 fader → 1 by the swap
      out-track: low → 0 at swapBar (hard swap, same downbeat);
                 mid/high 1→0 over second half; fader → 0 by end
      swapBar = a phrase boundary inside the overlap (default middle; for double drop = drop)
      optionally: HPF sweep on out-track last phrase, echo/delay tail on final beat
5. Render offline (OfflineAudioContext) a short preview, run checker (§4), pick best-scoring plan; repair on fail
   (shift by ±1 phrase, change L, switch to stem-mute, fall back to fade).
```
Web Audio notes: use `setValueCurveAtTime` / `linearRampToValueAtTime` on `GainNode` and `BiquadFilterNode.gain` (lowshelf ~200 Hz, peaking ~1 kHz, highshelf ~3–5 kHz) or a true **Linkwitz–Riley 3-band isolator** (sum of LR4 crossovers, i.e. 2 cascaded Butterworth biquads per side) for full kills. Equal-power fades: g_out = cos(πx/2), g_in = sin(πx/2) for uncorrelated material. For beat-matched correlated material (both drums aligned), **linear-amplitude or −3 dB-crossover-adjusted** curves avoid a +3 dB bump in the low band.

---

## 4. Transition-quality evaluation

There is **no standardized benchmark metric**. The literature combines objective proxies with listening tests.

**Listening-test protocols used:**
- Vande Veire 2018: 18 DnB fans rated mixes/transitions (Likert). Most transitions rated good.
- Bittner 2017: curators rate each whole transition **Good/OK/Bad**.
- DJtransGAN 2022: Preference + Smoothness (5-pt) + "Melodious" (3-pt, clash detection), versus linear crossfade and rule-based EQ baselines.
- Zehren: cue usability rating (~90–96% usable). Objective hit rate within ±0.5 s.
- Mosaikbox 2024, DJustify 2026: blind comparative tests vs prior systems and crossfade.
- Lund 2026 thesis: A/B against crossfade + magnitude-squared coherence.

**Objective checker to implement (render the transition, then compute):**
| Check | Computation | Threshold (suggested starting point) |
|---|---|---|
| Loudness continuity | short-term LUFS (3 s) over [t0−8 s, t1+8 s]; max dip and max bump vs linear interpolation between pre/post levels | dip ≤ 3 LU, bump ≤ 2 LU |
| Low-band clash | per-beat energy < 150 Hz of A·B (product of normalized env), or sum exceeding single-track max by > 3 dB | ≤ 1 beat of overlap (bass swap) |
| Beat alignment | cross-correlate low-band onset envelopes of the two decks during overlap; peak lag | < 10 ms (EDM); flag > 20 ms |
| Phase / downbeat | B's downbeats coincide with A's downbeats | exact (bar index mod 4 equal) |
| Phrase alignment | B's cue on A's phrase boundary (8/16/32) | required for blends |
| Key consistency | Camelot distance of overlap-region keys, or chroma correlation | ≤ 1 step, or chroma cos > 0.6 |
| Vocal overlap | Σ vocA·vocB over overlap beats | 0 (or < 1 bar) |
| Spectral masking / clutter | spectral flatness or "roughness" of summed mids vs each alone; or the coherence measure | heuristic |
| Tempo change | stretch ratio for each track | ≤ ±3–5% (Kim 2020: 86% of real tracks < 5%) |
| Silence / dead air | RMS below −50 dBFS for > 250 ms within transition | none |

Combine into a weighted score and log it with user behaviour (skip within 30 s after a transition, manual override) to retune weights.

---

## 5. Commercial systems

### Algoriddim djay (Automix AI, Neural Mix, Crossfader Fusion)
- Docs: https://help.algoriddim.com/user-manual/djay-pro-mac/mixing-basics/using-automix · settings: https://help.algoriddim.com/user-manual/djay-pro-mac/settings/automix · Android settings: https://help.algoriddim.com/user-manual/djay-android/settings/automix
- **Automix AI** (since djay Pro 2, 2017; **rewritten 2021**) "identifies rhythmic patterns and the best intro and outro sections of songs, then calculates fade durations and adjusts EQs and filters" (2021 press coverage: https://9to5mac.com/2021/05/06/djay-pro-ios-update-taps-apple-neural-engine/, https://appleinsider.com/articles/21/05/06/music-production-app-djay-pro-ai-gets-major-update-to-ai-powered-mixing-tools). Model internals are not public.
- Transition styles: **Automatic, Fade, Filter, EQ, Echo, Dissolve, Riser, Neural Mix™ (stem-based)** and others. Settings for blend duration, tempo adjust, and **per-track user Automix start/end points** that override AI selection. **"Mix Now"** finds the earliest suitable blend point.
- Neural Mix transitions: during a transition, the two songs are separated into stems (drums/bass/vocals/harmonic) and each stem is crossfaded/effected independently, e.g. swap drums first, then bass, keep vocals of only one track.
- **Crossfader Fusion** (djay Pro 5): crossfader presets with "smart behaviours" and tuned automation curves combining stems + EQ/filters. **Fluid Beatgrid** handles variable-tempo tracks. https://www.engadget.com/ai-joins-you-in-the-dj-booth-with-algoriddims-djay-pro-5-150007224.html
- 2017 review: works well on 4/4 techno and struggles on complex orchestrated tracks. That fits the beat-confidence gating argument.

### rekordbox (AlphaTheta/Pioneer DJ)
- Has an Automix playlist mode. **MIX POINT LINK** lets the user set MIX OUT on the current track and MIX IN on the next (via hot/memory cues). When deck 1 reaches its mix-out point, deck 2 auto-starts from its mix-in point, optionally with BEAT SYNC. https://rekordbox.com/en/support/faq/mixpoint-link-7/ · https://rekordbox.com/en/support/faq/mixpoint-link-6
- **Phrase analysis** (rekordbox 6+, for EDM/House "mood" high/mid/low) labels Intro/Up/Down/Chorus/Outro, and Lighting mode uses it. Users rely on it for cueing. This is the de-facto commercial phrase labeller.
- **Design lesson:** expose explicit per-track "mix in / mix out" points in your UI and honour them over AI.

### Serato DJ Pro / Traktor Pro / Engine DJ
- Serato: Autoplay plays the playlist sequentially, with optional crossfade-like behaviour, and no structure-aware blending (per manuals). Traktor: "Autoplay"/cruise mode plays sequentially and, if a Fade-In/Fade-Out cue type is set on tracks, triggers the next deck at the Fade-Out cue. **Traktor's Fade-In/Fade-Out cue types** are the analogue of Mixxx intro/outro cues. Engine DJ: Auto DJ with configurable crossfade time, start/end skipping silence. No public detail on phrase-aware logic. (Vendor docs only. Third-party comparisons: https://www.digitaldjtips.com/best-dj-software/)

### VirtualDJ
- https://www.virtualdj.com/wiki/AutoMix.html · Automix editor: https://www.virtualdj.com/manuals/virtualdj/editors/automixeditor/
- Automix types: **Smart** (VDJ picks mix point from outro of current + intro of next. **Tempo-matched blend only if BPMs are close and a tempo-able region exists, else falls back to cut.** Sub-options Mix Fade / Mix Cut / Mix Tempo), **Fade (remove intro/outro)**, **Fade (remove silence)**, **Fade (remove nothing)**, **None (back-to-back)**. Automix length setting. **POI (points of interest)**: automix in/out points auto-detected and editable in the Automix Editor.
- The Smart-with-fallback logic is a good model for your beat-confidence gate.

### Mixxx (open source, so you can read the code)
- 2.3 release notes: https://mixxx.org/news/2020-07-09-intro-outro-sections · Manual: https://manual.mixxx.org/2.6/en/chapters/djing_with_mixxx · Code: `src/library/autodj/autodjprocessor.cpp` in https://github.com/mixxxdj/mixxx (PR #2103 introduced the modes)
- Per-track **Intro start / Intro end / Outro start / Outro end** cues, auto-placed by **silence detection** (first/last sound above threshold) if unset. User-adjustable.
- **Transition modes:**
  - **Full Intro + Outro:** align the *end* of the next track's intro with the *end* of the current outro, so both play fully. Transition length = min(intro, outro) when unequal [behaviour: the shorter section defines the overlap].
  - **Fade At Outro Start:** align *starts* of intro and outro. A longer outro is cut short.
  - **Full Track:** plays the full track, with the crossfade length set by the user "transition time" (negative values = gap of silence).
  - **Skip Silence:** like full track but trims leading/trailing silence. A later variant, "Skip Silence Start Full Volume", also exists.
- Optional beat sync, and the crossfader is moved linearly over the transition. No EQ automation, no phrase awareness beyond user cues. **This is the baseline your engine must comfortably beat.**

### Apple Music AutoMix (iOS 26, 2025)
- https://9to5mac.com/2025/06/16/automix-apple-music-ios-26/ · https://www.macrumors.com/2025/06/12/ios-26-automix-apple-music/ · Apple support: https://support.apple.com/guide/iphone/aside/iphcba31c44b/ios
- "Automatically selects the best transition depending on the music": **beatmatched blend with time-stretching** (reported) for compatible tracks, otherwise **remove silence / simple crossfade**. Works on playlists/stations, not albums. Not via AirPlay. Heise reports tempo/melody adaptation "not always successful": https://heise.de/-11139247. The mechanism is not published. Fallback behaviour is the same pattern as VirtualDJ Smart.

### Spotify
- **Crossfade** (0–12 s, linear-ish volume) and legacy **"Automix"** (playlist-curated smooth transitions, editorial playlists) are older playback settings.
- **Spotify Mix (beta, Aug 2025):** in user playlists, **Auto** or **Custom** transitions. Presets **Fade, Rise, Blend**, plus per-transition EQ, volume, timing and effects. Shows **BPM and key** per track. Transitions are *authored offline* and stored, not live. https://techcrunch.com/2025/08/19/spotifys-latest-feature-lets-you-add-your-own-transitions-to-playlists · https://newsroom.spotify.com/tag/transitions
- **Spotify AI DJ (2023)** is a recommender + LLM script + TTS voice (Sonantic). **No beatmatched transitions**: https://newsroom.spotify.com/2023-02-22/spotify-debuts-a-new-ai-dj-right-in-your-pocket/ · https://ra.co/news/78853
- Research lineage: Bittner et al. 2017 (§1.11).

---

## 6. Concrete numbers to seed the engine (with provenance)

| Parameter | Value | Source |
|---|---|---|
| Tempo change tolerance | 86.1% of real tracks within ±5% | Kim et al. 2020 (verified) |
| Key transposition | rare; keylock on | Kim et al. 2020 |
| Cue grid | downbeats; phrases of 4-bar "periods", prefer 8/16/32 | Zehren 2020/22; CUE-DETR 8/16-bar snapping |
| Cue tolerance | ±0.5 s hit window | Zehren |
| Typical blend length (House/Trance/Techno) | 16–32 bars (≈30–60 s at 128 BPM), long blends 64 | Kim 2020 histograms **[verify]**; practitioner consensus |
| DnB blend length | 8–16 bars, double drop 8 bars together then pull one out | Vande Veire 2018 **[verify]**; DnB guides |
| Bass handling | one bassline at a time; swap within 1 beat on a downbeat/phrase | NIME 2021 sub-band curves; Vande Veire |
| Sub-band model | 3 bands (~200 Hz / ~2.5 kHz split) beats single-band | Kim et al. NIME 2021 / DAFx 2022 |
| Fully-annotated rate of a rule-based EDM pipeline | 91% | Vande Veire 2018 |
| Cue usability of rule-based detector | ~90% (unseen) – 96% | Zehren CMJ 2022 / arXiv 2020 |
| Learned cue similarity to GT | 0.851 vs 0.371 (MIK) | CUE-DETR 2024 |

---

## 7. Prioritized recommendations for the browser engine

1. **Phrase grid hardening (high ROI):** global downbeat-phase vote + phrase-offset search + multi-scale Foote novelty at bar resolution + low-band energy steps. Output `phrases[]` with confidence, and `sections[]` with EDM labels and a `mixFriendly` flag.
2. **Beat-confidence gate** (§2.11) driving template choice (blend vs fade vs cut). Mirrors VirtualDJ Smart and Apple AutoMix fallbacks.
3. **Sub-band transition templates** (relaxed/long blend, rolling, double drop, quick cut, echo-out, filter sweep) parametrized as in DJtransGAN (per-band start/end/slope). Hard bass swap on a phrase downbeat.
4. **Stem rules** when stems are available (Mosaikbox/djay): one vocal, one bass at a time; bring drums in first; incoming vocals delayed to after outgoing vocals end.
5. **Candidate search + objective checker** (§3, §4): enumerate (cueOut, cueIn, L, template) → score → render 2–4 best offline → pick → log. This is the DJustify architecture without the LLM.
6. **Tempo strategy:** meet-in-the-middle or ramp over the transition (Ishizaki). Cap total stretch at ~±5% unless the user opts in. Handle half/double time.
7. **Key:** EDMA-style profiles + confidence, judged on the overlap region. Low confidence → don't penalize.
8. **Learn from users:** honour explicit mix-in/out cues (rekordbox MIX POINT LINK, Traktor fade cues, Mixxx intro/outro). Fit weights from overrides/skips. Optionally run Kim-style DTW alignment on uploaded DJ mixes to learn genre-specific cue/length statistics.
9. **Optional ML (offline, onnxruntime-web/WebGPU):** Beat This! for hard tracks; distilled Raveform/All-In-One for sections; small VAD CRNN when no stems.

## 8. Sources
- Kim et al. ISMIR 2020: https://arxiv.org/abs/2008.10267 · https://github.com/mir-aidj/djmix-analysis · https://mir-aidj.github.io/djmix-analysis
- Kim, Yang, Nam NIME 2021: https://nime.pubpub.org/pub/g7avj1a7 · https://github.com/mir-aidj/transition-analysis
- Kim, Yang, Nam DAFx 2022: https://mac.kaist.ac.kr/pubs/KimYangNam-dafx2022.pdf
- Raveform TISMIR 2026: https://transactions.ismir.net/articles/10.5334/tismir.288
- All-In-One WASPAA 2023: https://arxiv.org/abs/2307.16425 · https://github.com/mir-aidj/all-in-one
- KAIST AI DJ project: https://mac.kaist.ac.kr/ai_dj.html
- Schwarz & Fourer: https://hal.archives-ouvertes.fr/hal-02172427 · https://hal.archives-ouvertes.fr/hal-02010431 · https://hal.archives-ouvertes.fr/hal-01671768
- André, Fourer, Schwarz 2024: https://arxiv.org/abs/2410.04198
- Vande Veire & De Bie 2018: https://asmp-eurasipjournals.springeropen.com/articles/10.1186/s13636-018-0134-8 · https://github.com/lenvdv/dnb-autodj-3 · https://lenvdv.github.io/2018-03-20-autodj
- Zehren et al.: https://arxiv.org/abs/2007.08411 · https://direct.mit.edu/comj/article-pdf/46/3/67/2164818/comj_a_00652.pdf · https://www.mdpi.com/2624-6120/5/4/36 · https://www.diva-portal.org/smash/get/diva2:1887409/FULLTEXT01.pdf
- CUE-DETR: https://arxiv.org/abs/2407.06823 · https://github.com/ETH-DISCO/cue-detr
- DJtransGAN: https://arxiv.org/abs/2110.06525
- Bittner et al. 2017: https://archives.ismir.net/ismir2017/paper/000086.pdf
- Ishizaki et al. 2009: https://zenodo.org/records/1418231
- Mosaikbox 2024: https://zenodo.org/records/14877463 · https://repositum.tuwien.at/handle/20.500.12708/212628
- DJustify 2026: https://arxiv.org/abs/2610.33434
- DJ AI (AM 2025): https://dl.acm.org/doi/10.1145/3771594.3771640
- Diffusion transitions: https://neurips.cc/virtual/2023/74842 · Lund thesis: https://lup.lub.lu.se/luur/download?func=downloadFile&recordOId=9225409&fileOId=9225410
- Beat This!: https://arxiv.org/abs/2407.21658
- Faraldo EDM key: https://github.com/angelfaraldo/edmkey · https://essentia.upf.edu/reference/std_Key.html
- djay: https://help.algoriddim.com/user-manual/djay-pro-mac/mixing-basics/using-automix · https://help.algoriddim.com/user-manual/djay-android/settings/automix · https://musictech.net/news/gear/algoriddim-free-dj-software-djay-pro-ai-automix-and-neural-mix/ · https://www.engadget.com/ai-joins-you-in-the-dj-booth-with-algoriddims-djay-pro-5-150007224.html · https://cdm.link/djay-pro-2-brings-algorithms-machine-learning-djing/
- rekordbox MIX POINT LINK: https://rekordbox.com/en/support/faq/mixpoint-link-7/
- VirtualDJ: https://www.virtualdj.com/wiki/AutoMix.html · https://www.virtualdj.com/manuals/virtualdj/editors/automixeditor/
- Mixxx: https://mixxx.org/news/2020-07-09-intro-outro-sections · https://manual.mixxx.org/2.6/en/chapters/djing_with_mixxx · https://github.com/mixxxdj/mixxx/pull/2103
- Apple AutoMix: https://9to5mac.com/2025/06/16/automix-apple-music-ios-26/ · https://www.macrumors.com/2025/06/12/ios-26-automix-apple-music/ · https://heise.de/-11139247
- Spotify: https://techcrunch.com/2025/08/19/spotifys-latest-feature-lets-you-add-your-own-transitions-to-playlists · https://newsroom.spotify.com/2023-02-22/spotify-debuts-a-new-ai-dj-right-in-your-pocket/ · https://ra.co/news/78853
