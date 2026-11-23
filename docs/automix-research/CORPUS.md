# Simulated long-set regression suite (P4.2, without audio)

`test/automix-corpus.test.js` plays three-hour party sets through the real automix code and checks the quality of the
whole set. Any change to selection (`smartmix.js`), planning (`adaptive-dj.js`, `mix-planner.js`, `dj-styles.js`) or
the checker (`transition-check.js`) that makes the mix worse should fail it. It runs in about 5 s and gives the same
result on every run.

## What it does

- **Library** (`test/fixtures/automix-corpus.js`, `makeLibrary`): about 150 synthetic track descriptions, generated
  from a seeded PRNG (mulberry32), spread over 12 genre families: house, tech house, techno, trance, drum & bass,
  dubstep, hip-hop, pop, reggaeton, afrobeats, disco and lounge. Each track has:
  - BPM within the family's range, `bpmConfidence`, a Camelot key with `keyConfidence`, and energy from 1 to 10.
  - `rating` / `playCount`, and artists that repeat (popular ones get more tracks).
  - `phrases` on 8/16-bar lines, with per-section `energy` (0..1) and `lufs`. Club tracks use the layout
    intro / buildup / drop / breakdown / outro; vocal genres use verse / chorus.
  - About 20 % of tracks start with a 1–2-bar pickup (`downbeat` before `phraseAnchor`), and 4-bar intros sit before
    the first phrase line.
  - `mainLufs`, `lufs`, and `gain = -14 - mainLufs`.
  - A per-second `vocalMap` for vocal tracks.

  Section times are rounded to milliseconds, as the analyser stores them.
- **Set** (`simulateSet`): starts from a seed track. Each next track comes from `liveNext` with shape `party`,
  `endless: true`, the AutoMix cycle of 30 tracks, and a fixed clock that starts at 22:00 and advances by the time
  played. History works as in `AutoMix.fillLive`. `transitionScore` is AutoMix's `transitionQuality`.
- **Transitions**: each one is planned with `planAdaptiveTransition`, as `AutoMix.nextTransition` does:
  - position and entry are where the outgoing track came in, and rate is 1;
  - `recent` holds the last 6 styles, with a double drop recorded as `doubledrop`;
  - `prevStyle` is the previous transition's style.
- **Played time**: the outgoing track counts until its exit, then the incoming track counts from wherever it is at
  that point, so the overlap is counted once.

## Scenarios

| Scenario | Library | Notes |
|---|---|---|
| mixed A / B / C | 150 tracks, all 12 families (seed 7) | three seed tracks; 3 banned ids |
| house night | 80 house + tech house (seed 11) | single genre |
| open format | 90 hip-hop / pop / reggaeton / afrobeats (seed 13) | short blends, cuts |
| bass night | 70 drum & bass + dubstep (seed 17) | |
| bass, double drops | the same, 90 min, `doubleDrops: true` | exercises the double-drop rules |

## Metrics (`setMetrics`) and what is asserted

Hard limits apply to every scenario. Baseline floors are checked with a 0.1 margin, and artist repeats with a margin
of +2.

| Metric | Meaning | Asserted |
|---|---|---|
| unplanned | transitions with no plan | 0 |
| lowOverlapBeats | beats with two basslines (checker) | ≤ 1 on every blend |
| bump / dip | checker loudness bump / dip vs a straight line (LU) | every bump ≤ 2.5 and ≥ 95 % ≤ 2; every dip ≤ 5.5 |
| levelOk | blends with bump ≤ 2 and dip ≤ 3 | ≥ baseline − 0.1 |
| checkOk | blends with no checker issue | ≥ baseline − 0.1 |
| vocalClash | blends with > 2 s of vocal on vocal | ≤ 5 % |
| onLine | blends that start on an outgoing 4-bar phrase line (`offPhraseBars` 0 or 4) | ≥ baseline − 0.1 |
| onPhrase / gridAligned | starts on an 8-bar line; incoming grid aligned (`gridMisalign` 0) | reported |
| landed | blends whose incoming main part lands on the exit | ≥ 90 % |
| effectShare | echo / reverb / spin / brake / loop share | ≤ mean family `fxBudget` + 0.1 |
| sameEffectTwice | the same effect twice in a row | 0 |
| double drops | outside the bass family / twice in a row | 0 / 0 |
| trackRepeats, bannedPicked, backToBack | replays, banned picks, same artist twice in a row | 0 |
| artistRepeats | picks whose artist played in the previous 8 tracks | ≤ baseline + 2 |
| energyOk | picks with \|ΔE\| ≤ 2 | ≥ 90 % |
| tempoOk / blendStretchOk | picks / blends within 5 % tempo (half/double allowed) | ≥ baseline − 0.1 / ≥ min(95 %, baseline − 0.05) |
| ms | runtime of one simulation | < 5 s |

Each scenario prints its numbers with `t.diagnostic`. To see them, run
`node --test --test-reporter=spec test/automix-corpus.test.js`.

## Updating baselines

Update a baseline only when a change is meant to alter the set, for example a new selection rule. Never update one
just to make a failure go away.

1. Run `CORPUS_BASELINE=1 node --test test/automix-corpus.test.js`. Each scenario prints one JSON line.
2. Copy the values into `BASELINE` in the test file.
3. In the commit message, say why the numbers moved.

Better numbers can be copied in the same way, so that the floor rises.

If you change the generator (`makeLibrary`), every scenario changes, so update all the baselines in the same commit.

## Issues found by the suite (all fixed)

The first run of this suite found these, and the targets that used to be `todo` tests are now ordinary assertions:

1. **Exit one bar early on millisecond-rounded times** (27–40 % of blends started 3 bars into a phrase): `adaptive-dj.js` now accepts phrase lines up to 10 ms past the music's end. Phrase-line starts: 100 %.
2. **Artist key collapsed names** ("Max Cooper" → "ma", because `x` / `ft` / `vs` matched inside words): separators must now be whole words. The 8-track artist gap is now a strong penalty instead of a mild one; repeats within 8: 0 in every scenario.
3. **Tempo**: blends are capped at 6 % stretch (only a quick 4-bar bass swap goes up to 8 %), and club sets penalise picks more than 5 % away. Club scenarios ≥ 95 % within 5 %; open-format sets move tempo on cuts, where nothing is stretched.
4. **Checker dips**: the reference is now each track's own section level at that instant, not the loud drop before an outro.
5. **Double drops were nearly impossible** (the 60 % minimum play left no exit inside the second drop): they may now leave after 45 % of the track, and both channels come down about 3 dB while both drops play.
