# Pro-DJ Automix: research synthesis and improvement spec

*Status: research + proposal, 2026-11-23. Companion to `INTELLIGENT_AUTOMIX_PLAN.md` (the long-range plan) and
`ADAPTIVE_DJ.md` (what shipped in 0.5.x). Raw research with all citations: `docs/automix-research/01-transitions.md`,
`02-selection.md`, `03-systems-mir.md`.*

> **Owner goal:** *"Work as well as a pro DJ, so I can leave it on at a party and it will just play"*, and
> *"also do tricks and previews."*

That goal sets the order of work. A party DJ is judged first on **never failing** (no silence, no train-wreck, no
level jumps), second on **sounding like one continuous mix** (phrase-correct, one bassline, one vocal), and only
third on flair (double drops, mashups, tricks). This document ranks every change by that order.

**Confidence note.** The research agents could search but most page fetches (arXiv, Springer, Digital DJ Tips, DJ
TechTools) were blocked, so many facts come from search-result extracts. Numbers marked **[M]** are measured in
published studies; **[P]** are practitioner conventions; **[E]** are engineering defaults to tune by ear. Items
marked [verify] in the raw files should be checked against the paper before being quoted.

---

## 0. Implementation status (branch `feature/pro-dj-automix`)

| Item | Status | Where |
|---|---|---|
| P0.1 dead-air watchdog | **Done**: silent master, stalled or stopped on-air deck → restore fader/EQ, finish a stuck transition, or cut in the next track. The track after next is fetched ahead (bytes kept in memory and used by its deck load; an unreadable file is retried once, then dropped a track early). | `automix-watchdog.js`, `AutoMix.watch/rescue/prefetchAhead`, `deck.load` |
| P0.2 analysed-only party pools | **Done** for live / endless / smart pools (analysed tracks preferred when ≥ 5 exist; smart and live starts already analyse first). | `AutoMix.playable` |
| P0.3 loudness | **Done**: BS.1770 integrated + per-phrase LUFS, `mainLufs`, gain = −14 − mainLufs, forced level matching, cut-landing pre-trim, summed-blend loudness judged by the checker. | `audio/loudness.js`, `AutoMix.prepare`, `landingTrim` |
| P0.4 per-region confidence ladder | **Done**: per-phrase `pulse` / `gridErr`; long overlap, short overlap only, or no overlap per region (a beatless incoming intro may fade under a steady outro). | `regionBeatSafety`, `adaptive-dj.js` |
| P0.5 sample-accurate execution | **Partial**: bass swaps, trick EQ moves and ping-pong bars are scheduled on the audio clock; fader / filter curves are still tick-driven. | `Channel.scheduleEq` |
| P0.6 clean mixer | **Done**. | |
| P1.1 phrase grid | **Done**, both tracks' grids aligned; 100 % of blends start on a phrase line in the long-set simulation. | `analysis-core.js`, `adaptive-dj.js` |
| P1.2 one bassline | **Done** for every style (tested invariant, simulated sets: 0 beats of overlap). | `mixLevels`, `stemLevels` |
| P1.3 landing | **Done**. | `adaptive-dj.js` |
| P1.4 club EQ curves | **Done**. | `mixLevels` |
| P1.5 vocal rules | Vocal maps / hold-in, plus the checker's measured vocal-overlap penalty (> 2 s). | |
| P1.6 tempo | **Done**: morph across blends ≤ 4 %, ride-back ≤ 1 BPM / 16 bars, blends capped at 6 % stretch, set tempo journey (≈ 3 BPM per hour through warm-up and build, held at the peak; not for open format). | `morphTarget`, `restoreBars`, `targetBpm` |
| P2.1 genre families | **Done**. | `dj-styles.js` |
| P2.2 loop-extend | **Done**: a short ending loops its last clean 8-bar phrase (no vocals, steady beat) so a full blend fits. | `adaptive-dj.js`, `beginTransition` |
| P2.3 double drop | **Done** (bass family, peak energy, both channels −3 dB, may leave after 45 % of the track). | |
| P2.4 echo/reverb exits | **Done**. | |
| P2.5 stem recipes | **Done**: stem swap, drum bridge, acapella carry, acapella in (AI stems on both decks). | `stemLevels` |
| P2.6 variety / effect budget | **Done**. | |
| P3.1–P3.3 selection | **Done** (artist gap 8 enforced; artist names matched as whole words). | `smartmix.js` |
| P3.4 party controls | **Done**: energy ±, keep this vibe, never play, skip feedback, clean versions only (by tag / title: the library has no advisory flag), end time with wind-down and a reverb-wash finale. | queue panel, Settings → Automix |
| P4.1 checker | **Done** (simulation from automation + section loudness). | `transition-check.js` |
| P4.2 corpus | **Done without audio**: deterministic 3-hour party-set simulations across genres with asserted quality limits (`test/automix-corpus.test.js`, `docs/automix-research/CORPUS.md`); browser e2e `scripts/e2e-pro-automix.mjs`. No listening tests. | |
| P5 tricks | **Done**: bass-cut tease, groove lift, filter build, loop-roll build, pause drop, echo freeze, horn, rewind, scratch fill (needs a scratch sound on a sampler pad), ping-pong (as a transition), acapella drop-in (as a stem transition), light cues (blackout / strobe, when lighting is on). | `automix-tricks.js` |
| P6.1–P6.4 previews | **Done**: one plan object, timeline + verdict + nudges, headphone render, plan locked 2 bars before it begins. | |
| P6.5 set preview | **Done**: planned tracks listed, queue drag / play next / remove, export of the planned set to WAV (offline render: no key lock, stems or tricks in the file). | `automix-export.js` |

Still needed before trusting it unattended at a real party: listening on real music across genres (synthetic fixtures
prove timing, levels and rules, not taste) and a long soak test (hours) on the target laptop.

---

## 1. What pros actually do: the ten findings that matter

1. **Phrase is everything.** Every serious automatic system (Vande Veire 2018, Zehren 2020/22, CUE-DETR 2024,
   Mosaikbox 2024) snaps cues to downbeats on 8/16/32-bar phrase lines at points of structural change, and one 2026
   system (DJustify) attributes most of its gain over a plain crossfade to cue placement. Off-phrase entries are the
   #1 "amateur tell". Real-mix transition lengths cluster at multiples of 32 beats **[M, Kim et al. ISMIR 2020]**.
2. **Landing rule.** The incoming track's main section (drop, groove, hook) should land *exactly where the outgoing
   track would have changed section anyway* (end of its drop, start of its break or outro):
   `start_B = boundary_A − introBars_B`, with `start_B` itself on an outgoing phrase line **[P]**.
3. **Real DJs barely stretch.** 86.1 % of tracks in 1,557 real mixes were played within ±5 % of native tempo, 94.5 %
   within 10 %; only 2.5 % were transposed (94 % of those by one semitone); key lock is on **[M]**. So: pick
   compatible tracks rather than stretch, and ride tempo slowly.
4. **Transitions are per band, not one fader.** Sub-band (3-band) gain curves reconstruct real mixes far better than
   a crossfade **[M, Kim/Yang/Nam NIME 2021, DAFx 2022]**. Canonical shape: incoming enters with lows killed →
   mids/highs come up → **hard bass swap on a phrase downbeat (0–1 beat)** → outgoing mids/highs leave → fader out.
5. **One bassline, one vocal at a time.** Beat-matched kicks are *correlated*: they sum to about +6 dB, not +3 dB, so
   equal-power fader curves do **not** prevent low-end bumps. Pros keep exactly one deck owning the band below
   ~200–250 Hz at every instant **[P/E]**. Two vocals for more than 4–8 bars is the second big clash **[P]**;
   rule-based stem removal (one vocal, one bass) measurably improved listening ratings in Mosaikbox **[M]**.
6. **Loudness is matched on the main section, not the whole file.** Set trim once per track so its drop/chorus
   short-term loudness hits a target (long beatless intros drag integrated LUFS down); keep cut jumps within ±1 LU
   (+2 LU when a lift is intended; never > +3 LU) **[P/E]**.
7. **Know when not to beatmatch.** Commercial systems (VirtualDJ Smart, Apple AutoMix) fall back to a fade or cut when
   beat tracking is unsure. Gate on tempo stability, grid residual and pulse strength *per region* (a steady track can
   have a free-time intro) **[P/E]**.
8. **Technique follows genre.** House/techno: 16–32 bar (techno/afro 32–64) EQ blends. DnB: 8–16 bar blends, double
   drops on ~20–30 % of transitions. Hip-hop/pop/reggaeton/open format: cuts on the 1 or hook, 1–4 bar blends, echo
   outs. Tempo jumps > 6–8 % (non 2:1): echo/reverb-out and restart, never a blend **[P]**. Effects transitions
   (echo, spinback, brake, filter) capped at ~30 % in blend-genre sets and never twice in a row **[P/E]**.
9. **Energy is planned, not reacted to.** Steps of ±1 on a 1–10 scale; dwell 2–4 tracks per level; a 10–15 % valley
   for 2–3 tracks before the main peak; peak shortly before the end; +2 levels only as a planned breakdown → drop
   lift **[P]**. Real DJ orderings are measurably non-random and sound-similarity-driven **[M, Kell & Tzanetakis
   2013]**; planning a few tracks ahead beat greedy picking in user studies **[M, DJ-MC]**.
10. **Key is soft, and key detection is unreliable** (69–77 % for commercial detectors **[M]**). Weight key by
    detection confidence *and* by how tonal the overlapping sections are (a drums-only overlap barely clashes).

---

## 2. Where OpenDJ stands

Already pro-grade or close: section-to-section window search (`adaptive-dj.js`), per-pair style/length scoring with
explanations and learning (`mix-planner.js`), vocal maps from stems, half/double-time tempo distance, beat-confidence
gate (0.35), phase keeper with pitch nudges, stem swap, 11 transition styles, smart/live selection with set shapes,
master limiter. This is well beyond Mixxx Auto DJ (crossfader only, no EQ or phrase logic), which the research names
as the baseline to beat.

The gaps below are what separates it from "leave it on at a party".

---

## 3. Improvement spec, in priority order

Each item: **pro practice → current code → change → how we check it.**

### P0 — Party-safe: it must never fail audibly

**P0.1 Dead-air watchdog.**
- Pros: silence is the cardinal sin; any gap > ~250 ms is noticed.
- Now: a failed load toasts and skips (`automix.js:524`, `:770`), and a track that ends without a transition is
  caught (`automix.js:868`). There is no check on the *actual master output*.
- Change: while automix is on, watch master RMS (the limiter worklet already posts meters). If it stays below −50
  dBFS for > 1.5 s outside a planned silence (or a deck is "playing" but its position stops advancing), do an
  emergency start: cut the next preloaded track in on its mix-in point; if that fails, pick any analysed track from
  the pool. Keep **two** tracks preloaded and decoded ahead, not one. Log every trigger.
- Check: e2e test that kills the next track's file mid-set and stalls a deck; output gap must stay < 2 s.

**P0.2 Party mode never starts a track it hasn't analysed.**
- Now: unanalysed tracks score neutral and fall back to echo/cut.
- Change: in endless/party sets, analyse the next N = 3 candidates ahead (background queue already exists), and
  exclude tracks whose analysis failed or whose BPM/grid is missing *unless* the pool is otherwise empty. Prefer
  tracks with section analysis (`smartmix.js` `parts.phrase` already rewards this; make it a filter in party mode).

**P0.3 Loudness consistency (biggest audible quality jump for little code).**
- Now: `loudness()` (`analysis-core.js:255`) is gated RMS targeting −12 dB, used only when the `autoGain` setting is
  on (`deck.js:196`). A real BS.1770 `integratedLoudness` exists in `sampler.js`. Faders sit at a fixed 0.8.
- Change:
  1. Move BS.1770 into `audio/loudness.js` and compute **short-term LUFS per section** in the analysis worker.
  2. Track trim = target − LUFS of the loudest main section (drop/chorus), clamped to [−12, +6] dB. Force it on
     while automix runs.
  3. Drop/cut styles: check B's landing section vs A's exit section; if > +2 LU, pre-trim B for the first phrase and
     ease back over 8 bars.
  4. Blends: predict the summed loudness from section band energies; if > target + 1 LU, dip both faders (or rely on
     P1.2 low-band ownership, which removes most of the bump).
- Check: objective checker (P4) — no short-term LUFS bump > 2 LU or dip > 3 LU across any transition; limiter gain
  reduction < 2 dB typical.

**P0.4 Fallback ladder driven by confidence, per region.**
- Now: global `bpmConfidence < 0.35` forces echo/cut/reverb (`adaptive-dj.js:59`).
- Change: compute confidence on the *overlap region* (tempo stability of 8 s windows within 1 %, grid residual RMS <
  ~10–15 ms, pulse strength). Ladder: long blend → short blend (≤ 8 bars) → echo-out + cut on downbeat → equal-power
  fade 2–8 s (no beatmatch) → cut on silence. Live-drummed disco/funk, rubato pop and folk (see
  `INTELLIGENT_AUTOMIX_PLAN.md` §10) land on the lower rungs automatically.

**P0.5 Sample-accurate execution.**
- Now: `ADAPTIVE_DJ.md` states starts and control updates run on the UI tick; "a stalled UI can delay a handover".
  At a party the laptop will be busy (stems, visuals, lights). A drop 30–50 ms late is audible.
- Change: schedule the incoming `play()`, the bass swap, cuts and FX engage at an `AudioContext` time computed one
  bar ahead (worklet message with a start frame), and drive EQ/fader curves with `setValueCurveAtTime` instead of
  per-frame `ch.set`. Keep the UI tick only for re-planning.
- Check: e2e measures kick-onset alignment at the swap under CPU load; target < 5 ms, flag > 10 ms.

**P0.6 Always leave the mixer clean.** After each transition, reset filters, FX sends, EQ and loop on the deck that
left (only when its fader is at 0) and assert the incoming deck is at EQ-flat/filter-off by the end of the blend.

### P1 — Sounds like one continuous mix

**P1.1 Phrase grid, not just a bar grid.**
- Now: `detectPhrases` works on the 3-band waveform with a 4/4, downbeat-phase vote; `adaptive-dj.js` snaps
  candidate exits/entries to **bars** (`snap`, line 18).
- Change (all cheap DSP, research §2.5 of `03-systems-mir.md`):
  1. Bar-synchronous features: low/mid/high RMS, chroma, a few MFCCs, drum presence, vocal probability.
  2. Bar-level self-similarity + multi-scale Foote novelty (kernels of 4/8/16 bars).
  3. **Phrase-offset vote:** pick offset o ∈ 0..7 bars maximising Σ novelty[o + 8k] (handles pickup bars).
  4. Boundaries = novelty peaks within ±1 bar of the 8-bar grid, preferring 16/32 multiples; store a confidence.
  5. Snap all candidate exits/entries to **phrase** lines (8-bar), falling back to 4-bar only when confidence is low.
- Check: hand-label 30 tracks across genres; boundaries within ±1 bar ≥ 75 %.

**P1.2 Low-band ownership as a hard invariant.**
- Now: `blend`/`bassswap` kill the incoming low until the swap (good), but `filter` (`automix.js:287`) and
  `crossfade` (`:293`) run both tracks' full low end through an equal-power crossfade, which with beat-matched kicks
  gives a +3 to +6 dB low-end bump and flamming.
- Change: a single post-processor over `mixLevels` output: at every k, exactly one deck has low > −20 dB; ownership
  changes on a beat (phrase downbeat preferred) with a 0–4 beat ramp. Exception: a drums-only incoming intro may keep
  low at −6 to −10 dB for kick punch. With stems, apply ownership to the bass stem.

**P1.3 Land the incoming track on the outgoing phrase (drop-on-the-break).**
- Now: blends end on an outgoing section boundary and `planBestTransition` rewards `bars ≈ introBars` (+3), but
  start, swap and landing are not solved jointly.
- Change: for each exit boundary `tA` and each incoming landing section `kB` (first groove/drop/hook), compute
  `start_B = tA − bars(intro of B before kB)`; require `start_B` on an outgoing phrase line; place the bass swap on the
  landing downbeat (or the phrase line before it). If the intro isn't a multiple of 8 bars, loop-extend (P2.2) or trim
  the incoming intro to the nearest phrase. Score: landing exact > 4-bar off > unaligned.

**P1.4 Blend curves from the research recipe.**
- Now (`mixLevels` blend, `automix.js:277`): incoming fader reaches 0.8 by k = 1/3 with highs and mids near flat,
  while the outgoing stays at 0.8 and full EQ → doubled hats and a mid build-up before the swap.
- Change to the 32-bar recipe (`01-transitions.md` §2.1): B fader up over the first quarter; B highs −6 dB → 0 by
  bar 8, B mids −6 → −3 dB; A highs → −6 dB from bar 8; **swap at the phrase line** in 0–1 beat (hard) or 2–4 beats
  for rolling sub-bass; after it, A mids → −6 dB and A highs → −12 dB over 8 bars, then A fader out over the last
  4–8 bars (or a high-pass sweep). Ramps linear in dB for EQ, smoothstep for faders.

**P1.5 Vocal rules (Mosaikbox values as defaults).** Vocal segments from the vocal stem split at ≥ 1 s below −40
dBFS, segments < 400 ms dropped; a clash is > 2 s of overlapping vocals (≈ 1 bar). Without stems, keep the current
section-based estimate but cap overlaps of two "likely vocal" sections at 4 bars. Echo-out and cut points must fall
in a vocal gap that starts within one beat after a phrase end (no "-ing ing ing").

**P1.6 Tempo handling like a DJ.**
- Now: incoming is synced for the whole overlap, then eases back to native in `TEMPO_RESTORE_BARS = 8`
  (`automix.js:390`) — a 4 % move in 8 bars is audible on vocals.
- Change: (a) for Δ ≤ 4 %, **morph** the master tempo from A's to B's across the overlap (or meet in the middle);
  (b) after the blend, ride at ≤ 1 BPM per 16 bars, preferably during a breakdown, and only if the *next planned*
  track wants that tempo; (c) keep a set-level target tempo curve (e.g. house 120 → 128 at ≈ 3 BPM/hour) so tempo
  drifts musically over the night; (d) Δ > 6–8 % and not ≈ 2:1 → reset transition (echo/reverb/loop-out, then B at
  native tempo); ≈ 2:1 → cut on a build → drop, not a long blend.

### P2 — The pro vocabulary

**P2.1 Genre-aware technique tables.** Add per-style-family defaults (lengths, allowed styles, effect budget) and use
the inferred style of the two tracks (tags now; classifier later per `INTELLIGENT_AUTOMIX_PLAN.md` §5):

| Family | Default technique | Blend length | Swap | Effects budget |
|---|---|---|---|---|
| House / tech house / afro | EQ blend, landing on the break | 16–32 (afro 32–64) | phrase, hard | ≤ 20 % |
| Techno / minimal | long EQ blend, filter | 32–64 | phrase, 2–4 beats | ≤ 15 % |
| Trance / progressive | breakdown → breakdown, reverb wash | 16–32 | at drop | ≤ 25 % |
| DnB / dubstep | rolling 8–16; double drop 20–30 % | 8–16 | at drop | ≤ 30 % |
| Hip-hop / R&B / pop / reggaeton / afrobeats | cut on the 1 / hook, 1–4 bar blend, echo-out | 0–8 | at cut | ≤ 40 % |
| Disco / funk / live drums | short blend or loop-extend, fades | 8–16 | phrase | ≤ 20 % |
| Lounge / background | long crossfade, filter | 16–32 | soft | ≤ 10 % |

**P2.2 Loop-extend.** When the required blend is longer than the clean region (radio edits, short intros, fade
outs), loop a 4- or 8-bar drum-dominant region starting on a phrase downbeat (seam crossfade 2–5 ms), ≤ 32 bars in
total, released on a phrase line. With stems: loop A's drums stem only ("drum bridge").

**P2.3 Double drop / drop swap** (DnB, dubstep, bass, festival EDM; peak slots only). Align drop downbeats; at the
drop the non-owner's low is killed and mids −3 to −6 dB, both channels −3 dB; run 16–32 bars, then swap or pull A.
Requires key distance ≤ 1, |Δtempo| ≤ 2 %, grid confidence high. Drop swap (cut to B's drop where A would have
dropped) is the safe variant when keys clash.

**P2.4 Proper echo and reverb exits.** Delay 1 beat (½ for busy material, 2 beats for slow hip-hop), feedback 40–60 %,
wet ramp to 50–70 % over the last bar, high-pass 200–400 Hz on the tail, delay fed **pre-fader** so it rings after the
cut; B in on the cut downbeat or the next one — never more than one bar of tail alone. Reverb: 4–10 s decay, HPF
300–600 Hz on the send. Never two echo-outs in a row (the commonest automix tell).

**P2.5 Stem recipes** (when both decks have stems): drums-first, instrumental bridge (mute A's vocals for its last
8–16 bars so B's vocal can come early), acapella carry (A's hook over B's instrumental for 4–16 bars, keys must match,
HPF vocal 120–150 Hz), drum bridge for tempo changes. Compensate the 3–6 dB perceived drop when stems are removed.

**P2.6 Variety rules.** Same effect never twice in a row; effects ≤ the family budget; same key ≤ 6 tracks running;
energy-boost key moves (+2, +7) ≤ 1 per 6 tracks and only on a planned lift.

### P3 — Selection and set programming for a party

**P3.1 Arc from context, not a manual shape.** Choose the arc template from set length and clock time: before 22:00
background (energy ≤ 5), build to peak around 00:00–02:00, after 04:00 deeper/hypnotic (6–7). Template for a set
fraction τ: warm-up 3→5 (0–0.25), build 5→7 (to 0.5), peak 1 7→8 (to 0.65), valley ≈ −15 % for 2–3 tracks, main
peak 8→9 (to 0.9, 10 at most once or twice), close 9→6. Endless sets repeat the build-peak-valley cycle (the current
`LIVE_ENDLESS_CYCLE = 30` tracks) anchored to clock time.

**P3.2 Score changes in `scoreTransition` (`smartmix.js:94`):**
- Key values toward the research ranking: same 1.0, ±1 0.9, relative 0.85, diagonal 0.75, +2 0.6 (lift only),
  +7 0.4 (cut/drum-only overlaps only); multiply by key confidence (store `keyConfidence`; `detectKey` computes it
  but it isn't saved).
- Tempo: 1.0 within 1.5 %, falling to 0.5 at ±3 % (dance) or ±5 % (open format); half/double × 0.85.
- Energy: Gaussian around the arc target (σ ≈ 1) plus −0.3 per level beyond a ±1 step, except planned lifts.
- New: **familiarity** (play count / favourites / library rating) — 20–30 % familiar in the warm-up, 50–70 % at peak,
  70 %+ at the close; no more than 3 bangers or 5 deep cuts in a row.
- New: **vocal alternation** — ≤ 3 vocal-heavy tracks in a row.
- Artist gap: hard 8 tracks or 45 min (currently 2–6 from the variety slider), soft to 15; remixes of the same
  original count as the same song.
- New: **sound similarity** of the overlap sections (band-energy and groove fingerprint now; embeddings later), best
  in 0.6–0.9: too similar is monotonous, too different is jarring.

**P3.3 Look ahead, re-plan often.** `liveNext` is greedy (top 6 by pair score, `smartmix.js:238`). Replace with a
small beam (width 5, depth 3) over pair + context scores, re-planned after every transition, user edit or skip, and
execute only the next step. This avoids painting the set into a corner (a key or tempo dead end, the only bangers
spent early).

**P3.4 Party controls that need no DJ skill.** "More energy / less energy" (shift arc ±1), "play this next", "never
play", "keep this vibe" (narrow genre and similarity), a skip button that counts as feedback (early skip < 30 s =
strong negative for the track *and* its transition features; 2 skips in the last 4 tracks = a bigger context reset
rather than a nudge), an explicit-lyrics filter and a "wind down" end time.

### P4 — Measure it

**P4.1 Objective transition checker.** Render each planned transition offline (OfflineAudioContext, both decks'
automation) and score it; on failure shift the window ±1 phrase, shorten, switch to stems, or step down the fallback
ladder (P0.4). Starting thresholds:

| Check | Threshold |
|---|---|
| Short-term LUFS (3 s) across the transition | bump ≤ 2 LU, dip ≤ 3 LU vs interpolated pre/post |
| Low band (< 150 Hz) overlap | ≤ 1 beat with both decks above −20 dB |
| Beat alignment (low-band onset cross-correlation) | < 10 ms; flag > 20 ms |
| Downbeat and phrase alignment | bar index mod 4 equal; blends start on 8-bar lines |
| Vocal overlap | < 1 bar (≈ 2 s) |
| Key of overlap | Camelot distance ≤ 1, or chroma cosine > 0.6 |
| Stretch of either track | ≤ ±5 % (≤ 3 % for the solo part) |
| Dead air | no stretch < −50 dBFS longer than 250 ms |

**P4.2 Regression corpus and listening tests.** A fixed set of ~40 permissively licensed tracks across the genre
families, rendered to a 2-hour mix in CI with the checker's per-transition scores tracked over time; periodic blind
A/B listening against the previous release. Log skips within 30 s of a transition and manual overrides as the live
quality signal, and use them to tune weights (the learning store in `mix-planner.js` already does this for styles).

### P5 — Tricks: a performance layer inside tracks

A pro doesn't only mix *between* tracks; at a party they also play *inside* them: tension before drops, a rewind
at peak time, a horn on the drop in a dancehall block. OpenDJ already has the instruments (loops with rolls, FX
bus, brake/backspin, `sampler.js` with the air horn, `scratch-samples.js`, the sequencer, stems, hot cues,
lighting). What is missing is a **trick planner** that decides *when* a trick serves the floor.

**Rules every trick obeys** (from the "amateur tells" checklist, `01-transitions.md` §5):
- Quantised: starts on a beat, preferably the last bar of a phrase. It resolves **exactly on the next phrase
  downbeat**; where it lands matters more than what it does.
- Never over a vocal line mid-word; never when the region's grid confidence is low; never two tricks within 16 bars.
- Reversible: the deck's loop, FX, EQ and filter state is restored on the landing downbeat (P0.6).
- Budgeted by the arc and genre family: none in the warm-up τ < 0.15 or in lounge/background sets; at most 1 per
  15 min while building; 2–4 per 15 min at the peaks. The same trick is not repeated within 20 min. Wedding or
  open-format profiles get more; techno/minimal get almost none (a filter build at most).

**Catalogue** (recipes in bars; all lengths at the playing tempo):

| Trick | Recipe | Where / when | Families |
|---|---|---|---|
| **Loop-roll build** | the last 2–4 bars before a drop: roll 1 bar → ½ → ¼ → ⅛ beat while a high-pass rises to ~1 kHz; release and HPF off on the drop downbeat | end of a build into a drop; also as an intra-track lift (the current `loop` exit, reused mid-track) | EDM, house, DnB, open format |
| **Bass-cut tease** | low kill for the last 1–2 bars of a 16-bar phrase (small lift) or 8 bars before a drop (tension); low back on the downbeat | phrase ends inside long grooves; before drops | house, techno, afro, DnB |
| **Filter build** | LPF closes over 8 bars to ~400 Hz, opens on the drop downbeat (optionally a 1-beat full cut first) | breakdown → drop | house, trance, techno |
| **Pause drop** | full cut (or 1-beat echo freeze) for the last beat or bar before the drop; drop hits on the 1 | big familiar tracks at peak; crowd sing-along moments | open format, EDM, pop, hip-hop |
| **Echo freeze / stutter** | ½-beat echo, feedback 90–100 % for one bar on the last word of a hook, then the dry signal returns on the downbeat | end of a vocal hook in a known song | pop, hip-hop, reggaeton |
| **Rewind (spinback to cue)** | after the first drop phrase (16–32 bars), a 1–2-beat spinback then restart from the drop hot cue on the next downbeat | peak only, a very familiar banger; at most once per hour | DnB, dancehall, UK garage, hip-hop, wedding |
| **Horn / sample hit** | `sampler.js` hit on the drop downbeat, ducked −3 to −6 dB under the track, high-passed; at most one per block | dancehall, reggaeton, hip-hop and wedding blocks, drops only | open format, dancehall, Latin |
| **Scratch fill** | baby or chirp scratch from `scratch-samples.js` on beats 3–4 of the bar before a phrase line, over a breakdown or instrumental intro | open-format and hip-hop transitions; never over vocals | hip-hop, open format |
| **Ping-pong / chop** | alternate A and B every bar (or 2 beats) for 4–8 bars with 3–5 ms ramps, then commit to B on a phrase line | before a cut between two well-gridded tracks with compatible keys | hip-hop, open format |
| **Acapella drop-in** | the incoming track's vocal stem over the outgoing instrumental for 4–8 bars before its own drop (P2.5) | compatible keys (distance ≤ 1); stems on both decks | pop, house, hip-hop |
| **Double drop** | P2.3 | peak slots | DnB, dubstep, EDM |
| **Light cue** | strobe / blackout cues from `lighting/` on the drop downbeat, a pause drop, a rewind | whenever a trick or drop lands, if lighting is on | all |

**Trick planner.** Tricks are timeline events on the same plan object as transitions (P6.1), placed after the
transition is fixed, so they never collide with a swap. Candidate slots: phrase ends before drops, the end of
long grooves (> 32 bars without a section change: "keep it interesting"), and the incoming drop after a
transition. Score each `(slot, trick)` with: family allowance × arc slot (rising energy or peak) × familiarity of
the track (tricks on songs people know read as intentional) × grid confidence × vocal gap, minus the
cooldown/budget penalties. Keep the top candidate only when it scores above a threshold, so most phrase ends get no
trick. The explanation string says why ("peak, familiar track, 32-bar groove: bass-cut tease into the drop").

### P6 — Previews: see and hear the mix before the crowd does

A pro hears the next blend in the headphones before the crowd does. For an unattended set, previews are how the
host builds trust in the automix and corrects it without stopping the party.

**P6.1 One plan object for everything.** `planAdaptiveTransition` already returns style, bars, timing, cue, why
and alternatives. Extend it into a complete, serialisable **mix plan** for the next 1–3 transitions:
- per deck, beat-stamped automation lanes (fader, low/mid/high, filter, FX send, stem gains, tempo);
- the swap and landing points, plus trick events (P5);
- the checker scores (P4.1) and the ranked alternatives.

The executor plays this plan (P0.5) and the preview, the checker and the UI all read it. "What you saw is what
plays."

**P6.2 Visual preview (queue / deck panel).**
- Both waveforms aligned on the outgoing phrase grid, with section colours and the overlap window.
- The automation lanes, the bass-swap line and the landing marker, any planned tricks, a countdown to the
  transition, and the "why" text.
- One-tap edits that feed the existing learning store (`learnChoice` in `mix-planner.js`):
  - pick an alternative style;
  - shift the window ±1 phrase;
  - change the length (8/16/32);
  - "no tricks here";
  - lock the plan.

**P6.3 Audio preview in the headphones (Sandbox).**
- Render the planned transition offline: an OfflineAudioContext with the same EQ, filter, FX and stem-gain graph,
  about 8 bars before the start through 8 bars after the landing.
- Play the render on the cue/headphone output while the master carries on unchanged. VirtualDJ's Sandbox is the
  commercial precedent.
- Also offer "preview next 3 transitions", which plays each render back to back.
- On a single-output device (phone, one sound card), the preview plays only when automix is paused or before the
  set starts.
- The same render feeds the objective checker, so one render pass serves both.

**P6.4 Rehearse, then commit.**
- Plan each transition at least one phrase before it begins, then render it, check it and repair it as in P4.1.
- Lock the plan two bars before it begins. Later changes (the user takes a control, a skip, a track edit) re-plan
  the *following* transition rather than changing a running one. The exception is an instant manual takeover, which
  stops the automation on that control only.

**P6.5 Set preview.**
- The beam plan (P3.3) shown as the next 5–10 tracks, with energy, tempo and key curves against the arc target and
  a reason per pick.
- Drag to reorder, pin, or ban a track; each edit re-plans.
- "Render this set" exports the planned mix offline to a file, which is useful for checking a party set the day
  before and is the CI regression render (P4.2).

---

## 4. Suggested order of implementation

| Step | Items | Why first |
|---|---|---|
| 1 | P0.1, P0.6, P0.2 | A party can't survive one silence; cheap and testable |
| 2 | P0.3, P1.2 | Loudness and bass bumps are what guests hear most |
| 3 | P0.5, P1.4 | Tight, sample-accurate swaps with pro EQ curves |
| 4 | P1.1, P1.3, P1.5 | Phrase landing: the single biggest "sounds like a DJ" gain |
| 5 | P0.4, P1.6 | Robust on live drums and tempo changes |
| 6 | P6.1, P6.2, P6.4 | One plan object the executor, preview, checker and UI share; the base for everything after |
| 7 | P3.1–P3.4 | Hours-long sets that build and keep a party going |
| 8 | P2.x | Genre vocabulary and flair |
| 9 | P6.3, P6.5 | Headphone sandbox preview and set preview / render |
| 10 | P5 | Tricks, once timing (P0.5), phrase grid (P1.1) and budget rules are solid |
| — | P4 | Should start alongside step 2 and grow with each step |

## 5. Parameter quick reference [E unless noted]

| Parameter | Default |
|---|---|
| Phrase grid | 8 bars; prefer 16/32-bar boundaries for entries and swaps |
| Bass swap | on a phrase downbeat, 0–1 beat (hard) or 2–4 beats (rolling sub) |
| Low ownership | non-owner low ≤ −20 dB; change only on a beat |
| Echo out | 1 beat, feedback 40–60 %, wet 50–70 %, tail HPF 200–400 Hz, ≤ 1 bar tail alone |
| Reverb wash | decay 4–10 s, HPF 300–600 Hz on the send |
| Loop extend | 4/8-bar drum region, seam 2–5 ms, ≤ 32 bars total |
| Tempo within a blend | ≤ 4 % morph; else reset transition; ≈ 2:1 → cut |
| Tempo ride after a blend | ≤ 1 BPM per 16 bars |
| Set tempo drift | ≈ 3 BPM per hour |
| Stretch | 86 % of real tracks within ±5 % **[M]** |
| Loudness | main-section trim to target; cut jumps ±1 LU (+2 lift); limiter −1 dBTP, < 2 dB GR |
| Energy | ±1 per transition; dwell 2–4 tracks; valley −10–15 % for 2–3 tracks |
| Artist gap | 8 tracks / 45 min hard, 15 soft |
| Effects | never twice in a row; ≤ family budget (P2.1) |
| Minimum play | keep `MIN_PLAY` 0.6 / 90 s for party sets; club sets play ~3–4 min of a 6-min track **[P]** |
