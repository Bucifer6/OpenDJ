# 02 — Track Selection & Set Programming for an Automix Engine

Research notes for encoding professional DJ track selection into a "pick next track / plan whole set" engine.
Inputs assumed available per track: BPM (+ beatgrid), key (+ confidence), energy/loudness, genre tags, vocal presence (ideally time-resolved), structure sections (intro/verse/build/drop/break/outro), play history.

**Evidence labels used below:**
- **[M]** = measured or empirical (a study or dataset).
- **[V]** = vendor or practitioner convention.
- **[D]** = derived here from music theory or arithmetic.
- **[R]** = our recommendation for the engine (a tunable default, not a published fact).

**Source access:** the session's network blocked direct fetches of arxiv.org, ismir.net, springeropen, utexas.edu, algoriddim help and native-instruments.com. Claims from those sources come from search-engine extracts of the pages, so verify them before quoting exact figures externally.

---

## 0. TL;DR for engineers

1. **Hard filters first.** Drop a candidate if its tempo can't be reached within the genre's tempo tolerance (directly, or at half or double time), if it's in the no-repeat window, or if it's an artist repeat within N tracks. Rank the survivors by a weighted score.
2. **Real DJs rarely stretch tracks far.** In 1,557 real mixes from 1001Tracklists, 86.1% of tracks were tempo-adjusted by less than 5%, 94.5% by less than 10% and 98.6% by less than 20%. Only 2.5% of tracks were transposed, and 94.3% of those by just 1 semitone. Key lock ("master tempo") is left on almost always. [M] (Kim et al., ISMIR 2020, https://arxiv.org/abs/2008.10267, code https://github.com/mir-aidj/djmix-analysis)
3. **Transitions are phrase-quantised.** Transition lengths peak at multiples of 32 beats (8 bars). Cue points chosen by different DJs agree to within 1 bar 40.4% of the time and within 8 bars 73.6% of the time. [M] (same paper)
4. **Key is a soft constraint.** Its weight should scale with how melodic the overlapping sections are and with key-detection confidence. Commercial key detectors score only about 69–77% correct. [M/V] (https://www.digitaldjtips.com/best-dj-key-detection-2020/)
5. **Energy follows a planned arc,** with a peak shortly before the end, a dip of about 10–15% for 2–3 tracks before a second peak, and steps of ±1 on a 1–10 scale. [V] (https://mixgraph.io/learn/dj-set-planning-guide, https://mixedinkey.com/workflows/use-energy-level-detection/)
6. **Plan ahead, don't just pick greedily.** Sequence-aware planning (MDP plus Monte Carlo planning, as in DJ-MC) beat greedy next-song choice in user studies. Track order matters: real DJ orderings differ significantly from shuffled ones. [M] (https://arxiv.org/abs/1401.1880; https://archives.ismir.net/ismir2013/paper/000210.pdf)

---

## 1. Harmonic mixing

### 1.1 Camelot / Open Key basics
- 24 keys sit on a 12-position wheel. In Camelot, **A = minor and B = major**, and 8B = C major, 8A = A minor. Open Key uses the same idea with different labels: m = minor, d = major, offset so that 1d = C major (Open Key = Camelot − 7, mod 12).
- Moving **+1 on the wheel is up a perfect fifth** (7 semitones). Moving **−1 is up a fourth**, i.e. down a fifth. **A ↔ B at the same number** switches between relative minor and major, which use the same 7 notes. [D]
- **Semitone change for a same-letter Camelot move of `d`:** `Δsemitones = (7·d) mod 12`. [D]
  - +1 → +7 (a fifth)
  - +2 → +2 (a whole tone, the "Energy Boost")
  - +7 → +1 (one semitone up)
  - −5 is the same as +7
  - +5 → +11, i.e. −1 semitone
  - ±6 → tritone
- **Notes shared between two diatonic scales `k` fifths apart:** [D]

| k (Camelot steps) | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| shared notes (of 7) | 7 | 6 | 5 | 4 | 3 | 2 | 2 |

This overlap is the theoretical basis for ranking moves. Neighbours share 6 of 7 notes [V] (https://www.mixgraph.io/learn/camelot-wheel-guide).

### 1.2 Compatible moves, ranked (suggested key score `S_key ∈ [0,1]`)

| Rank | Move (Camelot) | Example | Theory | Use / feel | S_key [R] |
|---|---|---|---|---|---|
| 1 | Same key | 8A→8A | 7/7 notes | Safest. Too many in a row "feels static" [V] (https://www.mixgraph.io/learn/camelot-wheel-guide) | 1.00 |
| 2 | ±1, same letter | 8A→9A / 7A | 6/7 notes (dominant / subdominant) | Standard "smooth" move. +1 lifts slightly, −1 relaxes | 0.90 |
| 3 | Relative (letter swap) | 8A↔8B | 7/7 notes, mood change | Minor→major brightens, major→minor darkens | 0.85 |
| 4 | Diagonal: A→B with +1, B→A with −1 | 8A→9B (Am→G), 8B→7A (C→Dm) | 6/7 notes | Common advanced move. Mood plus slight shift | 0.75 |
| 5 | +2 "Energy Boost" (same letter) | 8A→10A | +2 semitones, 5/7 notes | Mixed In Key: "move +2 numbers… use it sparingly… overuse can make a set feel forced" [V] (https://mixedinkey.com/?p=188) | 0.60 (only when energy is rising; cap at 1 per ~6 tracks) |
| 6 | +7 (= +1 semitone) | 8A→3A (Am→B♭m) | 2/7 notes, but every note moves up a semitone | Classic pop "truck-driver key change" lift. Called an energy boost on forums, and "Jaws" in Mixed In Key's material (not formally defined) [V] (https://forum.djtechtools.com/t/tricks-to-using-the-camelot-wheel-please-read/65155, https://mixedinkey.com/djs-checklist/) | 0.40, and **only** with a hard cut, a drums-only overlap or a short blend |
| 7 | Parallel (same root, mode swap) | 8A→5B (Am→A) | 4/7 notes, same tonic | Works for short blends because the tonic is shared | 0.40 |
| 8 | −2 (same letter) | 8A→6A | −2 semitones | Energy "drop". Rarely used | 0.40 |
| 9 | ±3 | — | 4/7 notes | "Stretchy" [V] (https://dev.to/birrings/camelot-wheel-for-developers-harmonic-mixing-without-the-music-theory-phd-21i8) | 0.20 |
| 10 | ±4 … ±6 | — | ≤3 notes, tritone at 6 | "Clash territory" [V] | 0.00–0.05 |

**Alternative formula** for the key score [R]: `S_key = shared_notes(k)/7` for same-mode pairs, with bonuses for relative (+0.15), diagonal (+0.1), and +2 or +7 when an energy boost is wanted. Fit these numbers against your own transition data if possible.

### 1.3 How strict to be, by genre and overlap content

Key clashes are audible in **sustained harmonic content**: pads, chords, basslines, vocals. They are much less audible in drums. "A lot of club-ready tracks might have intros/endings of solely percussion so you do not have to think about harmony" [V]. Minimal and techno melodies are often "a single note playing repeatedly", so clashes are rare [V] (https://www.native-instruments.com/en/blogs/blog/harmonic-mixing-rules-and-how-to-break-them, https://mixedinkey.com/Book/Use-Advanced-Harmonic-Mixing-Techniques/).

**Implementation [R]:**

```
harmonicity_overlap = max(harm(outgoing_outro_section), harm(incoming_intro_section))   # 0 = drums only, 1 = full chords/vocal
key_weight_effective = w_key * genre_key_strictness * (0.25 + 0.75*harmonicity_overlap) * key_confidence_pair
```

Use a short overlap (≤4 bars) or a cut/echo-out transition to make a key clash nearly irrelevant. When the key score is below 0.4, force that transition type.

| Genre family | genre_key_strictness [R] | Rationale |
|---|---|---|
| Trance, progressive house, melodic techno / "melodic house & techno", deep house, liquid DnB, chill / downtempo | 1.0 | Long melodic blends, pads, breakdowns |
| House (vocal / soulful / disco), nu-disco, future bass, pop / EDM | 0.8 | Vocals and chords, but blends are shorter |
| Tech house, garage / UKG, afro house | 0.6 | Bass-led; harmonic bass can still clash |
| Techno (peak / hard / minimal), hardstyle kicks, jungle | 0.3–0.4 | Percussive; distorted-kick hardstyle is the exception, since kick pitch matters |
| Hip-hop, R&B, open format, mash-up style | 0.4 | Short blends and cuts dominate; vocals are always present, so avoid vocal overlap instead |
| Drum & bass (neurofunk), dubstep | 0.5 | Bass-key clashes are audible on double drops |

### 1.4 Key shifting and the tempo→pitch relation

- **Without key lock,** pitch follows tempo: `semitones = 12·log2(1 + p/100)`. +6% ≈ +1.01 semitones, which gives the rule of thumb "each 6% ≈ 1 semitone" [D/V] (https://www.mixgraph.io/tools/pitch-tempo, https://www.digitaldjtips.com/keylocking-dj-beginners/).

| Tempo change | 1% | 2% | 3% | 4% | 5% | 6% | 8% | 10% |
|---|---|---|---|---|---|---|---|---|
| Semitones (no key lock) | 0.17 | 0.34 | 0.51 | 0.68 | 0.84 | 1.01 | 1.33 | 1.65 |

  At about 2–4% you're left **between keys** (detuned by a quarter to two-thirds of a semitone), which sounds worse than being a clean semitone apart. **Engine rule [R]:** if key lock is off, compute the effective key as `key + 12·log2(target/orig)`. If the fractional part is more than 0.25 semitones from an integer, treat melodic overlap as clashing (S_key ≈ 0.1). Otherwise snap to the nearest key and score normally. The simplest policy is to keep **key lock on by default**, as real DJs do. [M] (Kim et al.)
- **Key lock and time-stretch quality:** degradation is noticeable beyond about ±5% [V] (https://www.mixgraph.io/tools/pitch-tempo), and key lock "works best within roughly ±6%" [V] (https://www.digitaldjtips.com/keylocking-dj-beginners/). Default fader ranges: CDJ ±6%; Traktor and Serato ±8%. [V]
- **Deliberate transposition** (key shift with key lock): pros use it rarely. Only 2.5% of tracks in real mixes were transposed, 94.3% of those by ±1 semitone [M]. Traktor's key knob steps in 1 semitone increments [V] (https://djtechtools.com/2013/05/15/mixing-in-key-when-and-how-to-change-track-key-in-dj-software/). **Engine rule [R]:** allow pitch-shifting the incoming track by ±1 semitone only, only when it raises S_key from ≤0.2 to ≥0.85, and add a quality penalty of −0.1. A shift of ±2 or more is off by default. A ±1 semitone shift also turns any compatible pair into a +7/−7 relation, which is useful for exploring.

### 1.5 Key detection reliability caveats

- **Accuracy:** a 2020 test found Mixed In Key 76.5%, Traktor 73.8% and rekordbox 69.2% correct [V/M, methodology not published] (https://www.digitaldjtips.com/best-dj-key-detection-2020/).
- **Disagreement between tools:** Serato disagreed with Mixed In Key on 45% of 200+ tracks, and rekordbox on 38%. That test was sponsored by Mixed In Key. (https://wearecrossfader.co.uk/blog/mixed-in-key-11/, https://dev.to/birrings/mixed-in-key-vs-rekordbox-vs-serato-why-dj-platforms-disagree-on-key-60-of-the-time-22fj)
- **Metadata keys are unreliable.** In one informal check, only 25 of 57 Spotify "same-key" pairs were confirmed same-key by DJ software [V] (https://sites.northwestern.edu/msia/2020/07/13/finding-harmonic-connections-in-my-dj-music-library).
- **Typical errors** are confusions of fifth, relative major/minor and parallel key. The MIREX key evaluation scores these as partial credit: fifth 0.5, relative 0.3, parallel 0.2. [D, standard MIREX convention] So a "±1 / relative" mismatch may actually be a same-key pair, and vice versa.
- **Engine rules [R]:**
  1. Store key confidence and the top-2 key candidates. Score key as the expected value over the candidate distribution.
  2. Down-weight key for low-confidence or atonal tracks (low chroma clarity).
  3. Analyse key on the sections that will actually overlap (outro and intro), not the whole track. Tracks modulate, and intros are often atonal.
  4. Prefer a single detector consistently across the library [V] (Digital DJ Tips 2020).

### 1.6 Do real DJs follow harmonic rules? (measured statistics)

- **Direct measurement is missing.** No peer-reviewed published statistic of "% of real DJ transitions that are Camelot-compatible" was found. Searches of the ISMIR, arXiv and blog literature turned up none. This is a gap the team could fill: 1001Tracklists tracklists plus analysed keys, or the djmix dataset from Kim et al. at https://github.com/mir-aidj/djmix-analysis.
- **Indirect evidence:**
  - Rare transposition (2.5%) means DJs don't fix keys on the fly. Compatibility, where it exists, comes from **selection**. [M] (Kim et al.)
  - Kell & Tzanetakis (ISMIR 2013, BBC Essential Mix) found **timbre** is an important factor in both track selection and ordering. They also found real ordering differs significantly from shuffled ordering, and that "sort by decreasing similarity to the first track" is *not* how DJs order. [M] (https://archives.ismir.net/ismir2013/paper/000210.pdf)
- **Expected baseline [D]:** if keys were uniformly random, P(same, ±1, or relative) = 4/24 ≈ 16.7%, and P(adding diagonal and ±2) ≈ 33%. Any measured rate well above these indicates deliberate harmonic selection. Use these baselines when you analyse your own data.

---

## 2. Tempo rules

### 2.1 BPM ranges by genre (typical; borders overlap)
Sources: Ableton (https://learningmusic.ableton.com/make-beats/tempo-and-genre.html), Beatkitchen (https://beatkitchen.io/guides/electronic-music/01-genre-landscape/), dj.studio (https://dj.studio/blog/tempos-bpms-edm), digitaldjpool (https://digitaldjpool.com/blog/dj-bpm-guide/).

| Genre | Typical BPM | Max natural delta per transition (key lock on) [R] | Notes |
|---|---|---|---|
| Downtempo / chill / lo-fi | 60–100 | ±4% | Often half-time feel |
| Hip-hop / rap | 70–100 (trap 130–150 notated, felt at 65–75) | ±6% (cuts are common) | Double-time to DnB at 85↔170 |
| R&B / pop | 90–120 | ±5% | Open format; many cuts |
| Reggaeton / dancehall | 88–100 | ±5% | |
| Afro house / Amapiano | 110–122 / 108–115 | ±3% | |
| Deep house / nu-disco | 115–124 | ±3% | Warm-up territory |
| House / tech house | 120–130 (sweet spot 124–128) | ±3% | 128 overlaps techno and trance [V] |
| Techno | 125–140 (hard techno 140–155) | ±4% | |
| Trance / psytrance | 128–140 / 138–148 | ±3% | |
| UK garage / 2-step | 130–138 | ±3% | |
| Dubstep / riddim | 138–150 (felt at 70–75) | ±3% | Half-time ↔ 70 BPM hip-hop |
| Drum & bass / jungle | 160–180 (most 172–176) | ±3% | 87↔174 double-time |
| Hardstyle / hardcore | 145–160 / 160–200 | ±3% | |

### 2.2 Acceptable delta (measured and convention)
- **Measured:** 86.1% of tracks in real mixes are played within 5% of their original tempo, 94.5% within 10% and 98.6% within 20% [M] (Kim et al.). This is the per-track deviation from native tempo, not the delta between consecutive tracks. **Implication:** consecutive native tempos are usually within about ±5%, often far less in single-genre sets.
- **Convention:** time-stretch artefacts become noticeable beyond about ±5–6% [V].
- **Engine scoring [R]:**
  - `pct = |bpm_target/bpm_native − 1|`, after choosing the best of 1×, ½× and 2× (see 2.3).
  - `S_tempo = 1` if pct ≤ 1.5%; linear down to 0.5 at the genre's tolerance (±3% for 4/4 dance music); 0 beyond 2× tolerance. Hard-filter beyond 8% unless the transition type is a cut, echo-out or "drop-swap".

### 2.3 Half / double time
Treat `bpm`, `bpm/2` and `bpm*2` as equivalent tempo candidates when the genre pair supports it:
- hip-hop ↔ DnB: 85–87 ↔ 170–174
- dubstep / trap ↔ hip-hop / dancehall: 140 ↔ 70
- moombahton (~108) ↔ dancehall
- footwork / juke (160) ↔ 80

Ableton notes DnB and dubstep "juxtapose 80 with 160" [V] (https://learningmusic.ableton.com/make-beats/tempo-and-genre.html). Also correct BPM octave errors in the analysis, a common detector failure, using the genre prior.

**Rule [R]:** half/double matches get S_tempo × 0.85 (a feel change), and the transition should be a cut or a short blend on a phrase boundary.

### 2.4 Tempo journeys across a set
- **Gradual ramps are the norm.** A warm-up example ran a 2-hour set at about 120 BPM for the first 30 minutes, then rose gradually to 125–126 to hand over to a 126–128 headliner [V] (https://www.digitaldjtips.com/how-to-warm-up-for-big-name-djs/). That's about 3 BPM per hour.
- **Changes of up to about 1 BPM are inaudible,** especially in breakdowns. Ramps of about 1 BPM every 30 seconds are used to close a 10 BPM gap [V] (https://forum.djtechtools.com/archive/index.php/t-85520.html, https://www.digitaldjtips.com/how-to-change-tempo-dj-sets/).
- **Classic automated precedent:** HP Labs' hpDJ (Dave Cliff) planned a **tempo trajectory** (BPM as a function of time). It split the set into time slots and matched tracks to slots ranked by tempo, and later versions added crowd monitoring [M/V] (https://eprints.soton.ac.uk/262144/1/HPL-2005-88.pdf; patent EP1162621).
- **Software support:** djay "Morph" changes tempo smoothly over the transition duration. DJ.Studio supports start→end tempo ramps across a set. [V]

**Engine [R]:**
- **Master tempo curve.** Maintain a `master_bpm(t)` target curve; the template is in §3.3.
- **Per-transition slew.** Within a transition the master tempo may move at most 0.5 BPM per 8 bars, and at most 1.5 BPM per transition.
- **Ride back to native tempo.** After the incoming track is solo, ride the deck tempo toward its native BPM (and toward the planned curve) at ≤1 BPM per 16 bars, ideally during a breakdown. Use this to keep time-stretch at ≤3% for the long solo portion of each track. Only ride back if the next planned track wants that tempo.
- **Larger tempo changes.** For changes over 6% (e.g. 128 → 140 or 124 → 174/2), schedule a "reset" transition: a cut, an echo/reverb-out, a loop out, or a breakdown restart. Don't attempt a blend.

---

## 3. Energy management

### 3.1 Energy scales
- **Mixed In Key Energy Level 1–10:** 1–3 chill/ambient, 4–5 warm-up/deep, 6–7 main-floor, 8–10 peak. The guideline is to **move one Energy Level at a time** when possible [V] (https://mixedinkey.com/workflows/use-energy-level-detection/). Mixed In Key's tutorial combines a +2 key boost with +1 energy (7→8) for a big lift [V] (https://mixedinkey.com/?p=188).
- **Building your own [R]:** energy ≈ weighted mix of
  - integrated loudness (LUFS)
  - onset / percussive density
  - spectral centroid / high-frequency energy
  - BPM (normalised within genre)
  - low-end kick strength
  - danceability

  Calibrate to a 1–10 scale per library with quantiles, and keep per-section energy (intro, drop, break) too. The set arc should use the **drop / main-section energy**, while transition smoothness should use **outro-vs-intro energy**.

### 3.2 Arc shapes
- **Classic arc:** warm-up → build → peak → release / closing. **Peak just before the end, not at the end.** Peak-time anthems played too early "flatten the rest of the set" [V] (https://virtualdj.com/articles/dj-set-planning-guide, https://www.mixgraph.io/glossary/warm-up).
- **Wave / sawtooth:** after a build, a controlled **dip of about 10–15% for 2–3 tracks**, then a smaller second peak [V] (https://mixgraph.io/learn/dj-set-planning-guide). This gives the "tension and release" cycle, with cycles of roughly 20–40 minutes [R].
- **Closing:** keep high-tempo tracks running until about 15 minutes before the end, then move to emotional or familiar closers [V] (https://www.digitaldjtips.com/why-djing-is-like-sex-or-when-to-play-your-best-tunes/).
- **Opener / warm-up role:** stay below the headliner, don't play their likely big tracks, and build gradually. Warm-ups typically last 1–2 hours [V] (https://www.redbull.com/us-en/how-to-play-warm-up-dj-sets-guide, https://www.mixgraph.io/glossary/set-time).

### 3.3 Arc template (normalised set time τ ∈ [0,1]) [R]

| Phase | τ range | Target energy (1–10) | BPM (house example) | Track character |
|---|---|---|---|---|
| Opening / warm-up | 0–0.25 | 3→5 | 118–121 | Long intros, deeper, instrumental-leaning, lesser-known, groove over drops |
| Build | 0.25–0.5 | 5→7 with a 1-track dip | 121–124 | More vocals, rising familiarity |
| Peak 1 | 0.5–0.65 | 7→8 | 124–126 | Bigger drops, recognisable |
| Valley (release) | 0.65–0.72 | −10–15% (≈7) for 2–3 tracks | hold | Breakdown-heavy, melodic, vocal "moment" |
| Peak 2 (main) | 0.72–0.9 | 8→9 (10 only 1–2 times per set) | 126–128 | Anthems / bangers, energy boosts allowed |
| Closing | 0.9–1.0 | 9→6 | 128 hold or ease | Emotional, singalong, familiar "last record" |

**Template variants [R]:**
- **"Lounge / background"** (flat 3–5)
- **"Radio / continuous"** (wave with cycles of 4–6 tracks, no big peak)
- **"Workout"** (fast ramp to a plateau, cooldown in the last 10%)
- **"Party / open format"** (high plateau, sawtooth every 3–4 tracks via genre switches)

### 3.4 Step sizes and dwell [R, grounded in the MIK ±1 guideline]
- **Normal step:** |ΔE| ≤ 1 per transition. ΔE = 2 is allowed only as a planned "lift" with a breakdown → drop transition, and at most once per 5 tracks. A drop of ΔE ≤ −2 is allowed only at a valley or at the closing.
- **Dwell:** hold a level for 2–4 tracks, about 10–20 minutes, before stepping. Avoid more than 6 tracks at the same level with the same key, because it starts to feel static.
- **Energy score:** `S_energy = exp(−((E_cand − E_target(τ_next))/σ)²)` with σ ≈ 1.0, plus a step penalty `−0.3·max(0, |E_cand − E_prev| − 1)`.

### 3.5 "Reading the crowd" without a crowd: proxies [R, with precedents]
- **Time of day / venue profile:**
  - before 22:00, background energy is ≤5
  - 00:00–02:00 local, peak
  - after 04:00, after-hours: hypnotic and deeper, energy 6–7
  - morning / work / study: flat, low-vocal
- **Elapsed set time** τ, and the remaining planned duration. Re-plan if the user changes the duration.
- **Explicit feedback:**
  - **like / boost:** shift the target energy +0.5 and up-weight neighbours of the track in embedding space
  - **skip:** a negative reward on the track and, partially, on its *transition features* (key move, ΔE, genre jump), as in DJ-MC's song+transition reward decomposition (https://arxiv.org/abs/1401.1880)
  - **early skip** (under about 30 seconds): a strong negative
  - **late skip:** weak; it may only mean "transition sooner"
- **Spotify's skip data:** the Sequential Skip Prediction dataset (about 130M sessions) labels skips at several depths and includes time-of-day and context-type features. The "last action" alone is a strong predictor of the next skip, so **skips cluster** [M] (https://arxiv.org/pdf/1903.08408). **Rule:** after 2 skips in the last 4 tracks, perform a "context reset" with a larger stylistic or energy jump, rather than nudging.
- **Volume or energy changes** made by the user, and session length, are implicit signals. Long sessions with no skips mean the current direction is working (exploit).

---

## 4. Selection heuristics beyond key and BPM

| Heuristic | Rule / number | Source |
|---|---|---|
| **Timbre / sound similarity** | One of the strongest factors in real selection and ordering. Use an audio embedding (e.g. MFCC/OpenL3/CLAP/discogs-EffNet) and cosine similarity between the *overlapping sections*. Prefer similarity 0.6–0.9: too high is monotonous, too low is jarring | [M] Kell & Tzanetakis 2013; Vande Veire 2018 uses a "style space" (https://link.springer.com/article/10.1186/s13636-018-0134-8) |
| **Genre adjacency** | Build a genre graph (house↔tech house↔techno; deep house↔house↔nu-disco; garage↔house↔bass; DnB↔jungle↔dubstep via half-time). Score 1.0 same subgenre, 0.8 adjacent, 0.5 two hops, 0.2 otherwise. Learn edges from co-occurrence in tracklists | [R]; rekordbox "Mood" uses genre+BPM similarity (https://rekordbox.com/en/support/faq/operation-hints-7/) |
| **Vocal management** | Never overlap two lead vocals for more than 4–8 bars ("a 32-bar blend with both vocals going is a mess"; two rap vocals almost always clash). Follow the "one dominator" rule: one track leads at a time | [V] https://www.mixgraph.io/learn/vocal-mixing-guide, https://www.digitaldjtips.com/the-ultimate-guide-to-mixing-house-music/ |
| Vocal alternation | Avoid more than 3 consecutive vocal-heavy tracks; use instrumental "breathers". In club sets, vocal-led tracks make up about 30–50%, more at peak and closing | [R] |
| **Artist / track repetition** | No same track within the session (or 24h for radio). Same artist: minimum gap 8 tracks or 45 minutes (hard), soft penalty up to 15 tracks. Same label / album: soft penalty within 4 tracks. Remixes of the same original count as the same track | [R]; Mixxx Auto DJ deprioritises recently played tracks (Launchpad 971429) |
| Play-history novelty | Penalise tracks played in the user's last N sessions with exponential decay (half-life about 7 days) unless they are "favourites" | [R] |
| **Era / decade flow** | Stay within ±5 years, or move one decade per 3–4 tracks. rekordbox "Era" mode = similar year + BPM | [V] rekordbox FAQ |
| **Familiarity mix** | Use popularity / play-count as a "familiarity" feature. Warm-up: 20–30% familiar. Peak: 50–70%. Closing: 70%+. Avoid more than 3 bangers in a row (fatigue) and more than 5 deep cuts in a row (a lost floor) | [R] (practitioner consensus: "don't peak too early") |
| **Tension and release / surprise** | Every 20–40 minutes allow one "surprise" pick: a genre jump, an off-key with a cut, an era jump, or a well-known edit. Score = novelty × arc slot fit, and restrict to valleys or post-peak | [R]; MIK says clashing boosts "add contrast… sparingly" [V] |
| **Track play length** | Club sets play a portion of each track (about 3–4 minutes of a ~6-minute track; 32–40 tracks per 2 hours ≈ 3–3.75 minutes each). If tracks play in full, it's about 10 tracks/hour (median track length 5:48). Radio / background play is closer to the full length | [V] https://mixgraph.io/learn/dj-set-planning-guide, https://www.mixgraph.io/glossary/set-time |
| Skipping intros and outros | Enter on a phrase boundary (multiple of 32 beats). Skip drum-only intros at peak time; play them fully during the warm-up. Exit after the last main drop + 16–32 bars, or at the outro start. Cue points across DJs agree within 8 bars 73.6% of the time, and transitions cluster at 32-beat multiples | [M] Kim et al. |
| Section matching | Outgoing outro / break ↔ incoming intro: match harmonicity, low-end (don't stack two basslines, so EQ-swap the bass on the phrase), and energy. Avoid an incoming drop during an outgoing drop unless it's a deliberate "double drop" (DnB/dubstep) | [V/R]; Vande Veire 2018 implements DnB double-drop / rolling / relaxed transition types |

---

## 5. What existing tools do

| Tool | Selection / ordering behaviour (published) | Transition behaviour | Sources |
|---|---|---|---|
| **Mixed In Key** | Key (Camelot) + Energy Level 1–10 analysis. Guidance: same / ±1 / relative; +2 energy boost "sparingly"; change energy by 1 level. "Advanced" moves: Energy Boost, Jaws, Pay Attention, Power Block | n/a (analysis tool) | https://mixedinkey.com/?p=188, https://mixedinkey.com/workflows/use-energy-level-detection/, https://mixedinkey.com/Book/Use-Advanced-Harmonic-Mixing-Techniques/ |
| **rekordbox Related Tracks** | Rule filters on BPM (± range), key (same / related key 1 / related key 2), colour, rating, My Tag, genre, etc. A user-customisable criteria window; results sorted by relevance | — | rekordbox 5.5 manual (https://www.scribd.com/document/477571145/rekordbox5-5-0-manual-EN-pdf); Pioneer forum |
| **rekordbox 7 Track Suggestion** | Up to 5 modes. **Era**: similar year + BPM. **Mood**: similar genre + BPM. **Association**: label / composer. **Collection Radar**: "similar musical characteristics", AI-learned, needs "Radar analysis". **Streaming Radar**: streaming catalogue (described by a third party as "tracks other DJs commonly play") | rekordbox Automix uses phrase, beat, key and BPM data | https://rekordbox.com/en/support/faq/operation-hints-7/, https://dj.studio/blog/rekordbox-7-announced |
| **Serato DJ Pro** | Highlights compatible keys in the library. No true automix: "Autoplay" just plays the next track without beatmatching | — | https://dj.studio/blog/dj-automix-software |
| **Traktor** | Key column (Open Key), key-lock and 1 semitone key knob. The mobile "Traktor DJ" app had a "Recommended Tracks" (tempo/key) panel that users requested in Pro | Basic autoplay / crossfade | https://community.native-instruments.com/discussion/comment/78354 |
| **djay Pro (Algoriddim) Automix AI** | Analyses tracks to pick **transition points and fade length** and applies filters / EQ. Neural Mix (stem separation) powers stem-based transitions. "Morph" keeps BPM smooth across a transition. "Match" suggests tracks by BPM / key, and users ask for rekordbox-style Related Tracks | Automix AI since djay Pro 2 (2017); neural transitions since djay Pro AI | https://help.algoriddim.com/user-manual/djay-pro-mac/mixing-basics/automix, https://cdm.link/djay-pro-2-brings-algorithms-machine-learning-djing/, https://community.algoriddim.com/t/full-blown-match-feature-like-related-tracks-in-rekordbox/23883 |
| **Mixxx Auto DJ** | Plays a queue in order. "Add Random" from Auto DJ crates, with recently played tracks deprioritised unless the pool drops below a minimum % available. Optional requeue | Modes: **Full Intro + Outro** (default; aligns intro / outro cues), **Fade At Outro Start**, **Full Track**, **Skip Silence**. Fixed transition time in seconds (negative = pause). Intro / outro cues auto-detected (silence detection) | https://mixxx.org/news/2020-07-09-intro-outro-sections, https://bugs.launchpad.net/mixxx/+bug/971429, https://manual.mixxx.org/2.6/en/chapters/djing_with_mixxx |
| **VirtualDJ Automix** | "Smart" automix types (e.g. Smart (Tempo)) can choose or queue tempo-compatible tracks | Tempo-matched mixes | https://www.virtualdj.com/wiki/automix.html |
| **Spotify Mix (Aug 2025 beta) + Smart Reorder** | Shows BPM and **Camelot key** per playlist track. **Smart Reorder** re-sequences the playlist by BPM + key | Auto or Custom transitions with Fade / Rise / Blend presets; per-transition timing editable | https://newsroom.spotify.com/2025-08-19/mix-your-favorite-playlists-seamlessly-by-adding-your-own-transitions/, https://www.digit.in/news/audio-video/spotify-rolls-out-smart-reorder-for-seamless-dj-style-playlist-transitions-how-it-works.html |
| **Spotify (research)** | Bittner et al. (ISMIR 2017, Spotify / Echo Nest authors incl. Tristan Jehan): sequencing posed as a **shortest Hamiltonian path** over a graph weighted by key, tempo and timbre transition costs, then rendered with DJ-style transitions | — | https://ir.webis.de/anthology/2017.ismir_conference-2017.55 (summary in https://research.sabanciuniv.edu/52373/1/AI_DJ_AM2025.pdf) |
| **Apple Music AutoMix (iOS 26)** | **Does not reorder.** Plays the user's queue. Pre-analyses audio, uses **time-stretching + beat-matching**, and finds a suitable transition point. Disabled for albums and some genres. On by default; alternatives are crossfade or none. Works over AirPlay since 26.1 | DJ-like overlapping blends | https://www.macrumors.com/2025/06/12/ios-26-automix-apple-music/, https://9to5mac.com/2025/06/16/automix-apple-music-ios-26/ |
| **DJ.Studio** | Automix "harmonize playlist" ordering by key / BPM. Start→end tempo ramp across a whole set | Timeline editor | https://dj.studio/automix |

**Takeaway:** no shipped tool publishes weights. Commercial "suggestion" features are mostly **filter + sort** systems (BPM window ∩ key-relation set ∩ metadata), plus an opaque learned "similar sound" embedding (rekordbox Radar). Consumer automixers (Apple, djay, Mixxx) focus on **transition rendering, not ordering**. Spotify Smart Reorder and Bittner 2017 are the ordering-optimisation precedents.

---

## 6. Academic work

| Work | Method | Key results / numbers |
|---|---|---|
| **Kim, Choi, Sacks, Yang, Nam — "A Computational Analysis of Real-World DJ Mixes using Mix-To-Track Subsequence Alignment", ISMIR 2020** | Data: 1,557 mixes from 1001Tracklists, 13,728 tracks, 20,765 transitions. Method: subsequence DTW alignment of mix ↔ original tracks | Tempo deviation: <5% for 86.1%, <10% for 94.5%, <20% for 98.6%. Transposed: 2.5% of 24,202 tracks, 94.3% of them by 1 semitone, i.e. master tempo is on. Transition lengths peak at 32-beat multiples. Cue agreement: 23.6% exact, 40.4% within 1 bar, 73.6% within 8 bars, 86.2% within 16 bars. https://arxiv.org/abs/2008.10267 · https://github.com/mir-aidj/djmix-analysis |
| **Liebman, Saar-Tsechansky, Stone — DJ-MC, AAMAS 2015** (arXiv 1401.1880) | Playlist as an MDP. Reward = song reward + transition reward, each a dot product of listener weights with features. 34 audio descriptors, discretised into percentile bins; transitions encoded as bin→bin pairs (3,740 weights). Monte Carlo rollouts for planning; online RL from listener feedback | Learns within a single session of about 25–50 songs. Beat a greedy (song-only) baseline in a ~47-person lab study. Follow-up IAAI 2017 replaced the planner with MCTS/UCT and improved further (https://www.cs.utexas.edu/~pstone/Papers/bib2html-links/IAAI2017-eladlieb.pdf). MISQ 2019 "The Right Music at the Right Time" extends it |
| **Kell & Tzanetakis, ISMIR 2013** | Audio features over BBC Essential Mix tracklists | Timbre matters for both selection and ordering. Real order differs significantly from shuffled. Decreasing-similarity-to-seed ordering is not optimal. https://archives.ismir.net/ismir2013/paper/000210.pdf |
| **Vande Veire & De Bie, EURASIP JASMP 2018** | Open-source DnB auto-DJ: beat / downbeat / structure analysis, a "style space" descriptor for song selection, an energetic arc, transition types for DnB. 18-fan listening test | Rated high quality by DnB fans. Code: https://github.com/lenvdv/dnb-autodj-3 · https://link.springer.com/article/10.1186/s13636-018-0134-8 |
| **Bittner et al., ISMIR 2017** (Spotify) | Sequencing as a shortest Hamiltonian path over a transition-cost graph (key, tempo, timbre) plus automatic transitions | https://ir.webis.de/anthology/2017.ismir_conference-2017.55 |
| **Cliff, hpDJ (HP Labs, 2000–2005)** | Tempo trajectory fitted with time-slot ↔ track matching; later, crowd feedback | Prototype reportedly fooled about 40% of a London club crowd. https://eprints.soton.ac.uk/262144/1/HPL-2005-88.pdf |
| **Williams et al., "Temporal Considerations in DJ Mix IR and Generation", TIME 2025** | Survey / framework that splits DJ actions into long-term selection / sequencing vs real-time mixing | https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.TIME.2025.20 |
| **Spotify Sequential Skip Prediction (WSDM Cup 2019)** | ~130M sessions; skip depth labels; context features (time of day, playlist type) | The last action is a strong baseline, so skips are autocorrelated. https://arxiv.org/pdf/1903.08408 |
| Sowula, "Mosaikbox" (TU Wien 2024) | Rule-based stem mixing for automatic DJ mixing | https://repositum.tuwien.at/bitstream/20.500.12708/212628/1/Sowula-2024-Mosaikbox%20Improving%20Fully%20Automatic%20DJ%20Mixing%20Through%20Rule-ba...-vor.pdf |

**Harmonic-rule adherence statistics:** no published measurement was found (see §1.6). We recommend an internal study:
1. Take the djmix dataset or 1001Tracklists IDs.
2. Run one key detector over both tracks of each pair.
3. Compute the distribution of Camelot relations per genre.
4. Compare against the uniform baseline (16.7% for same, ±1 or relative).
5. Use the per-genre empirical frequencies directly as `S_key` priors, e.g. `S_key(rel) = log P_real(rel)/P_uniform(rel)`, normalised.

The same study gives empirical ΔBPM and ΔE distributions.

---

## 7. Suggested scoring model

### 7.1 Pipeline
1. **Candidate generation** (fast filters):
   - Tempo reachable: |Δ| ≤ 8% at 1×, ½× or 2×.
   - Not played this session.
   - Artist gap ≥ 8 tracks.
   - Genre within 2 hops of the set's allowed genre set.
   - Optional: energy within ±2 of target.
   - Embedding kNN top-200 for scale.
2. **Pairwise transition score** `T(a→b)`, using the overlap sections chosen by the cue planner.
3. **Track-in-context score** `C(b | set state)`: arc fit, diversity, familiarity mix, history, feedback.
4. **Planning:** beam search (width 5–10, depth 3–5) or MCTS over `Σ T + Σ C`, re-planned after every transition and on any feedback (DJ-MC style). A whole-set plan is a path through slot targets from the arc template, cf. the hpDJ trajectory and Bittner's Hamiltonian path. Execute only the next step greedily from that plan.

### 7.2 Default weights [R] (score = Σ wᵢ·Sᵢ, each Sᵢ ∈ [0,1], then penalties)

| Component | Symbol | Weight (club / dance) | Weight (open format / pop) | Weight (background / lounge) |
|---|---|---|---|---|
| Tempo compatibility (incl. half/double) | S_tempo | 0.22 | 0.15 | 0.15 |
| Harmonic (effective, see §1.3 modulation) | S_key | 0.18 | 0.10 | 0.15 |
| Energy fit to arc + step | S_energy | 0.18 | 0.18 | 0.15 |
| Timbre / sound similarity of overlap sections | S_timbre | 0.15 | 0.10 | 0.20 |
| Genre adjacency | S_genre | 0.10 | 0.12 | 0.12 |
| Familiarity-vs-phase fit | S_fam | 0.05 | 0.15 | 0.05 |
| User affinity (likes, history, skip model) | S_user | 0.08 | 0.12 | 0.13 |
| Era proximity | S_era | 0.02 | 0.06 | 0.03 |
| Vocal compatibility (overlap) | S_vocal | 0.02 (plus hard penalty below) | 0.02 | 0.02 |

**Penalties (subtract):**
- Lead-vocal overlap > 8 bars: −0.3. Rap-on-rap: −0.5.
- Same artist within 15 tracks: −0.15·(1 − gap/15).
- +2 / +7 key boost used more than once in the last 6 tracks: −0.15.
- |ΔE| > 1 outside planned lift / valley slots: −0.2 per extra level.
- Time-stretch > 5% for the solo portion: −0.2.
- Pitch-shift used: −0.1.
- Same key 6+ tracks in a row: −0.1.
- Recently played in a prior session: −0.2·decay.

**Bonuses:**
- Planned "surprise" slot filled with a high-novelty, high-user-affinity track: +0.15.
- Energy-boost key move (+2 or +7) exactly when the arc calls for a lift: +0.1.

### 7.3 Transition-type selection (couples selection to rendering) [R]

| Condition | Transition |
|---|---|
| S_key ≥ 0.75, S_tempo ≥ 0.8, both overlap sections harmonic | Long blend, 16–32 bars, bass swap on phrase |
| Key-incompatible but drums-only overlap available | Drum-section blend, 8–16 bars |
| S_key < 0.4 or vocal-on-vocal unavoidable | Short blend, ≤4 bars, or cut on the downbeat / echo-out |
| Tempo Δ > 6% or half/double | Cut, echo/reverb-out, or loop-out → new tempo |
| Energy lift slot | Incoming breakdown → drop aligned to outgoing phrase end |

### 7.4 Learning the weights
- **Supervised:** use real DJ transitions (1001Tracklists / djmix) as positives, and random library pairs plus same-session non-adjacent pairs as negatives. Fit logistic regression or GBDT on the feature deltas to obtain weights per genre. Report AUC, and compare to the hand-set weights above.
- **Online:** treat skips, likes and listen-through as rewards. Update weights per user with a bandit or the DJ-MC-style linear reward over (song features, transition-delta bins).
- **Exploration:** keep ε ≈ 0.1 so the surprise budget doubles as exploration.
