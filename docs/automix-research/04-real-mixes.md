# 04 — What real DJ mixes show: measured timing for the AI DJ

Scope: how long DJs play each track, how long transitions last, where in the tracks they happen, how the EQ is
handed over, and how teases / previews are done. Each finding is compared with what OpenDJ's Automix does today
(0.5.10), and turned into proposed changes. Earlier research (`01-transitions.md`, `02-selection.md`,
`03-systems-mir.md`, `../PRO_DJ_AUTOMIX_RESEARCH.md`) is not repeated here. This file adds measured numbers where
those files had practitioner advice or a "[verify]".

Tags: **[M]** measured from real mixes; **[M-1]** measured from one real transition; **[A]** an automatic DJ
system designed by researchers (expert rules, not measurement); **[P]** practitioner advice (tutorials, forums).

---

## 1. Sources and how they were used

| Source | What it is | Used for |
|---|---|---|
| Kim, Choi, Sacks, Yang, Nam, *A Computational Analysis of Real-World DJ Mixes using Mix-To-Track Subsequence Alignment*, ISMIR 2020. https://arxiv.org/abs/2008.10267, figures and code in https://github.com/mir-aidj/djmix-analysis | 1,557 real mixes (1001Tracklists, mostly house / trance), each aligned to its original tracks: 20,765 transitions | Transition lengths (section 2.2), cue agreement, tempo / key |
| The same repository, `img/fig_eq.svg` | EQ curves estimated for one real transition (the follow-up NIME 2021 / DAFx 2022 method) | The EQ sequence (section 2.4) |
| djmix-dataset (Kim, Yang, Nam, DAFx 2022). https://github.com/mir-aidj/djmix-dataset | 5,040 real mixes from MixesDB, with tracklist timestamps | How long each track plays (section 2.1): 862 mixes with usable timestamps, 14,963 track changes |
| Vande Veire & De Bie, *From raw audio to a seamless mix: an automated DJ system for Drum and Bass*, EURASIP JASMP 2018. Code: https://github.com/aida-ugent/dnb-autodj | [A] | Drum & bass transition types, EQ automation |
| Zehren, Alunno, Bientinesi, *Automatic Detection of Cue Points for the Emulation of DJ Mixing*, Computer Music Journal 46(3), 2022 (M-DJCUE dataset) | Cue rules from interviews with DJs, 134 annotated tracks | Where cues go (section 2.3) |
| DJ TechTools, Digital DJ Tips, DJ.Studio, Mixed In Key and similar | [P] | Teases, genres without measured data |

**Listening to mixes ourselves did not work.** We downloaded nine Creative Commons mixes from the Mixotic netlabel
(techno, tech house, deep house, trance, drum & bass, hip-hop / funk; about 11 hours, 156 tracks). We tried to measure
the transitions from the mix audio alone: find each track change, then fit each moment's spectrum in three bands as
a mix of the outgoing and the incoming track's sound. A test mix built with known blend lengths and bass swaps gave
wrong answers. The low band of two techno tracks (kick plus bass) looks too similar to tell which track it belongs to,
and smooth blends of similar tracks hide the track changes. Reliable measurement needs the original tracks, aligned
to the mix (what Kim et al. did), so no numbers from that attempt are used here. Doing it properly is item 7 in
section 4.

**Teases and previews have no measured data anywhere.** The 1001Tracklists alignment needs 32 beats of a track
playing on its own to find it, so a 4-bar tease is invisible to it. The tease rules below are practitioner advice.

---

## 2. Findings

### 2.1 How long each track plays [M]

Time from one track's start to the next track's start in the tracklist. This is roughly how long a track owns the
mix, its blend included. Timestamps are mostly whole minutes, so the values are rounded to about a minute.

| Genre tag | Track changes | p10 | p25 | Median | p75 | p90 | Tracks / hour |
|---|---|---|---|---|---|---|---|
| All | 14,963 | 2.0 min | 3.0 | **4.0** | 5.0 | 6.0 | 15.8 |
| House | 6,002 | 2.0 | 3.0 | **4.0** | 5.0 | 6.0 | 15.7 |
| Techno | 3,713 | 2.0 | 3.0 | **4.0** | 5.0 | 6.0 | 15.8 |
| Tech house | 3,496 | 2.3 | 3.0 | **4.0** | 5.0 | 6.0 | 15.5 |
| Progressive house | 3,299 | 1.8 | 2.6 | **3.3** | 4.1 | 5.2 | 19.1 |
| Deep house | 1,599 | 3.0 | 3.6 | **4.5** | 5.5 | 6.4 | 13.9 |
| Drum & bass | 1,599 | 1.9 | 2.2 | **3.0** | 4.0 | 5.0 | 18.8 |
| Trance | 988 | 2.5 | 3.4 | **4.3** | 5.1 | 6.0 | 14.2 |
| Minimal | 275 | 2.5 | 3.8 | **5.0** | 6.0 | 7.0 | 14.1 |

- Radio / podcast mixes and club / live recordings (Boiler Room, club nights) both have a median of 4.0 minutes.
- So a track is typically heard for 3–5 minutes, blend included. Club tracks are often 6–8 minutes long, so in those
  genres DJs leave out part of the intro or outro [P: "mix in on the intro, out on the outro, skip phrases of a long
  intro"].
- There is no measured data for hip-hop, open format, pop or weddings. Practitioners say 1–2.5 minutes per song
  there, 30–45 s for quick mixing, and radio edits are often played nearly whole [P].

### 2.2 How long a transition lasts [M]

Read from the histogram in Kim et al. (`img/fig_cue_translength.svg`: 18,551 transitions, measured from where the
outgoing track starts to leave to where the incoming track plays alone). Bars assume 4 beats.

| p10 | p25 | **Median** | p75 | p90 |
|---|---|---|---|---|
| 15 beats (4 bars) | 34 beats (8 bars) | **64 beats (16 bars)** | 105 beats (26 bars) | 158 beats (39 bars) |

- **Whole phrases win.** The tallest bins are 32 beats (8 bars) and 64 beats (16 bars), and multiples of 8 bars
  are clearly more common than the lengths next to them.
- **A quarter of transitions are 8 bars or shorter**; about 3 % are cuts (under 1 bar).
- **Blends over 40 bars are rare** (10 %), and 64 bars or more rarer still.
- At 128 BPM, 16 bars is 30 s; 32 bars is 60 s.
- DJs agree on cue points: for the same track, 40 % of cues fall within 1 bar of each other, 74 % within 8 bars and
  86 % within 16 bars. Cue points follow the track's structure.

### 2.3 Where in the tracks [M / A / P]

- **Cue-in:** in the intro, on the first beat of a 4- or 8-bar phrase, no later than the start of the main section.
  A long intro is treated as several phrases, and DJs pick one to start from rather than always the first
  [M-DJCUE annotation rules; P].
- **Cue-out:** after the outgoing track's main section has played; best in its outro, or where a drop ends (the
  high → low energy boundary) [M-DJCUE; A].
- **The landing rule:** the incoming main part lands where the outgoing track would have changed section anyway, so
  energy never dips. Vande Veire's "rolling" transition puts the incoming drop exactly where the outgoing drop ends
  [A, P].
- **Drum & bass** [A]:
  - **Double drop** (both drops hit together, the outgoing track goes on 32 bars after): about 30 % of transitions,
    never two in a row.
  - **Rolling** (16 bars in, 16 out): the default.
  - **Relaxed** (in calm sections): the rest.

### 2.4 How the EQ is handed over [M-1, A, P]

**One real transition** (the EQ figure in the Kim et al. repository: about 34 bars shown, 0 = band fully cut,
1 = full):

| Bar of the window | Outgoing track | Incoming track |
|---|---|---|
| 0–3 | mids trimmed to 0.66 | starts with all three bands almost silent (fader up, EQ killed) |
| 12 | | **lows half up (0.38)**: some bass already, under the outgoing bass |
| 15.5 | | mids open, to 0.9 within one bar |
| **19.5** | **lows cut, 0.8 → 0.02 within one beat** | **lows up, 0.38 → 0.74 in the same beat: the bass swap** |
| 19–21 | | highs open to 1 (the hats arrive with the swap) |
| 22–27 | highs step down 0.9 → 0.07 over about 5 bars | lows to 0.8–1 |
| 23–34 | mids step down 0.66 → 0, then the track is out | |

The sequence, which matches Vande Veire's system and practitioner advice:

1. The incoming track starts with its EQ mostly killed.
2. The incoming mids come in about 4 bars before the swap.
3. **The bass is swapped in one beat**, on a bar line about 57 % of the way through the window shown (the figure does
   not mark where the transition starts and ends). The incoming highs open with it.
4. The outgoing highs step down over about 4–8 bars, then the outgoing mids, and the fader goes last.

What this one example adds: the incoming bass was not fully killed before the swap. It sat at about −8 dB for about
8 bars under the outgoing bass. One example is not a rule; treat this as an option to test by ear.

Vande Veire's drum & bass system [A] swaps the bass in one bar exactly at the incoming drop, then fades the
outgoing track over the next 16–32 bars.

### 2.5 Teases and previews [P only]

What practitioners describe:

| Move | How | When |
|---|---|---|
| **Hook / acapella tease** | about 4 bars of the next track's vocal hook over the current track's outro, at reduced level | on an 8- or 16-bar phrase start, shortly before the real mix; same or neighbouring key |
| **Vocal layer** | the next track's acapella over the current track for 8–16 bars, then the full mix | open format, mash-up style; needs a clean acapella (stems) |
| **Loop preview** | a 4- or 8-bar loop of the next track's drums or riff, brought in with its bass killed, pulled out on a phrase line | house / techno, before a long blend |
| **Cut-in and pull-out** | 1 bar of the next track on a downbeat, then back | no source gives timing; rare in sources |

What every source agrees on:

- A tease is short, sits on a phrase line and is clearly the next record, typically its hook.
- A tease is occasional, not a pattern.
- It must not clash in key.

### 2.6 Tempo and key [M]

- 86 % of tracks are played within ±5 % of their original tempo.
- Only 2.5 % of tracks are transposed, almost always by one semitone.

The set's tempo drifts slowly, through small nudges per track. In one example mix analysed by Kim et al., it went from
106 to 126 BPM over the set. This is already in `02-selection.md` and the planner (it stops beat-matching beyond
±8 %).

---

## 3. OpenDJ today versus the evidence

| Area | OpenDJ 0.5.10 | Evidence | Verdict |
|---|---|---|---|
| Blend length, club families | `dj-styles.js`: house and trance prefer 32 bars, techno 32 or 64, all allow up to 64; `automix.js` `AUTO_LENGTH_STYLE.blend` 16–64 | median 16 bars, half of transitions are 8–26 bars, 90 % under 40 | **Too long.** 0.5.9 made 32 bars the house / trance target (techno 32 or 64), which only about a quarter of real transitions reach. |
| Blend length, drum & bass | 16 preferred, up to 32 | rolling 16 in / 16 out; double drop runs 32 bars past the drop | matches |
| Blend length, open format | 4–8 bars, cuts preferred | cuts, 4–8-beat blends [P] | matches |
| How long a track plays | `adaptive-dj.js`: at least 60 % of what is left after the cue-in (90 s minimum); cue-in within the first 25 % | median 4 min per track (3 min for drum & bass and progressive house, 4.5–5 for deep house and minimal) | Roughly right for 6–8-minute club tracks; no per-genre target. A 7-minute track entered at 0:30 can be heard for about 6 minutes, more than most DJs play it |
| Cue-in / cue-out | intro or a section in the first quarter; exit on section ends; landing on the incoming main part | the same rules | matches |
| Bass swap point | `phraseSwapPoint`: the incoming phrase line nearest the middle of the blend (between 20 % and 85 %) | about 57 % of the shown window [M-1]; at the incoming drop / main part [A] | close; prefer the landing point when there is one |
| Bass swap speed | one move (`inLow` −1 → 0 at the swap) | one beat [M-1, A, P] | matches |
| Incoming bass before the swap | fully killed | partly up (about −8 dB) for about 8 bars in the real example [M-1] | an option to try |
| Order of the other bands | incoming mids / highs come up early (−6 dB); outgoing highs step down before the swap; outgoing mids go after it | incoming highs open with the swap; outgoing highs go after it, then mids | close; the real DJ kept the incoming highs down until the swap |
| Teases (`automix-tricks.js` `planTease`, off by default since 0.5.10) | 8 bars, a third of transitions (subtle) or half (party), 8–56 bars before the mix; without stems a high-passed slice of the incoming hook | about 4 bars, occasional, the hook / acapella or a drum loop, shortly before the mix, on a phrase line | **Too long, too often, and the filtered kind is not a DJ move.** The thin, high-passed slice is a likely source of the "beeps" reported in 0.5.9 |
| Double drops | about 35 % of eligible drum & bass pairs, never twice in a row | about 30 %, never twice in a row [A] | matches |

---

## 4. Proposed changes (in order)

1. **Shorter club blends.**
   - `dj-styles.js`: set house and trance `bestBars` to `[16]` and techno to `[16, 32]`. Cap the usual length at
     32 bars, keeping 48–64 only for two long beatless or drums-only sections (an outro over an intro).
   - Corpus test (`test/automix-corpus.test.js`): assert that the blend-length median over a house night is
     16 bars, and that at most 15 % of blends exceed 32 bars.
2. **A per-genre play-time target.** Next to `MIN_PLAY`, give each family a target time per track (house / techno
   4 min, deep house / minimal 5, drum & bass / progressive 3, open format 2) and score exits by their distance
   from it. Keep `MIN_PLAY` as the floor. The corpus test then checks the per-family medians against the table in
   section 2.1.
3. **Swap on the landing point.**
   - When the incoming main part lands inside the blend, put the bass swap on its first downbeat.
   - Otherwise use the incoming phrase line nearest 55–60 % of the blend (`phraseSwapPoint`).
   - Keep the incoming highs down until the swap.
4. **An optional bass preview.** The incoming low at −8 dB for the 8 bars before the swap, only when the
   transition check (`transition-check.js`) finds no low-end bump. Off by default, to be judged by ear.
5. **Teases rebuilt before they come back on** (they stay off by default until then):
   - 4 bars, not 8.
   - Only the hook / acapella (with stems, key compatible) or a drum loop with its bass killed. No high-passed
     slice of the full mix.
   - Placed 8–16 bars before the blend starts, on a phrase line, never over outgoing vocals.
   - At most one transition in five, never two in a row. In open format, the acapella tease may be more frequent.
   - E2E check (`scripts/e2e-pro-automix.mjs`): a tease never overlaps the blend, and its level stays at least
     6 dB under the outgoing track.
6. **Expose the measured targets in the plan's explanation** (`why`). For example: "16-bar blend (most DJs:
   8–26)". The preview then shows where a plan sits against real mixes.
7. **A real-mix benchmark (later).** Measure transitions the way Kim et al. did: align Creative Commons mixes
   (Mixotic) to their original netlabel tracks. That gives per-genre blend lengths, swap points and EQ curves from
   audio, including teases if the alignment window is shortened. It needs the original tracks; many are on
   archive.org.

---

## 5. Reproducing the numbers

- **Section 2.1:**
  1. Download `djmix-dataset.json` from https://github.com/mir-aidj/djmix-dataset.
  2. Parse the `[mm]` / `[h:mm:ss]` tracklist timestamps, keeping mixes with at least 5 increasing timestamps and a
     first timestamp under 10 minutes.
  3. Take the differences between successive starts, and group them by the MixesDB genre tags.
- **Section 2.2:** read the bar heights from the matplotlib SVG `img/fig_cue_translength.svg` in
  https://github.com/mir-aidj/djmix-analysis (80 bins of 3 beats, 18,551 transitions), using the axis tick
  positions for scale, then take cumulative percentiles.
- **Section 2.4:** read the six "Mix" curves in `img/fig_eq.svg` of the same repository, using its 139 beat lines
  for the time axis.
