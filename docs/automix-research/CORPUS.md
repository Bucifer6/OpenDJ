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

## Known issues (the `todo` tests)

These targets run as `todo` tests: they report, but do not fail the suite. Once the code meets a target, turn its test
into a normal assertion.

1. **Exits one bar early when the analysis is rounded to milliseconds** (`adaptive-dj.js`). The analyser rounds
   `endTime` and phrase ends to the nearest millisecond (`r3`). When the rounded end falls a fraction of a millisecond
   before the exact bar line, the last phrase-line exit is lost in two places:
   - `lastBar` floors with a tolerance of only `1e-6` bars;
   - the snapped section end is filtered by `x <= end + 1e-6` seconds.

   The planner then exits one bar early. The blend starts 3 bars into a phrase, and the incoming grid is 1 bar off,
   which also costs score. In the simulated sets this affects 27–40 % of all blends. With unrounded fixture times it
   affects none. To reproduce:
   ```js
   const r3 = (x) => Math.round(x * 1000) / 1000, bpm = 126.4, bar = 240 / bpm, db = 0.228;
   const phrases = Array.from({ length: 11 }, (_, i) => ({ type: i ? (i === 10 ? 'outro' : i % 2 ? 'drop' : 'breakdown') : 'intro',
     start: r3(db + i * 16 * bar), end: r3(db + (i + 1) * 16 * bar), energy: 0.6 }));
   const out = { id: 'a', bpm, downbeat: db, gridOffset: db, phraseAnchor: db, endTime: phrases.at(-1).end,
     duration: phrases.at(-1).end + 2, key: '8A', energy: 6, genre: 'House', phrases };
   const p = planAdaptiveTransition(out, { ...out, id: 'b' }, { position: 200, entry: 200 });
   // endTime 334.405 (exact line 334.4052): p.exit 332.506, offPhraseBars(out, p.exit) = 1, blend start 3 bars off
   ```
   A tolerance of a few milliseconds would fix it, for example `+ 0.01 / bar` in the floor and `end + 0.01` in the
   filters.
2. **The artist gap is soft.** `weightsFrom().artistWindow` is described as a *hard* gap of 8 tracks, but
   `scoreTransition` only subtracts 2 to 4 points (× the variety weight). Within a genre, a better key or energy match
   wins, so a three-hour set has 0–5 artists repeated within 8 tracks.

   Related bug: `artistKey` in `smartmix.js` splits on `x`, `ft` or `vs` even when they come at the end of a word,
   because the regex has `\s*` before the separator. As a result, `"Max Cooper"`, `"Max Richter"` and `"Alex …"`
   collapse to `"ma"` / `"ale"`, and unrelated artists count as the same:
   `scoreTransition({id:'x',artist:'Max Cooper'}, {id:'y',artist:'Max Richter'}, {history:[]}).parts.artistGap === 1`.
   The suite's own `artistOf` requires whitespace before those words.
3. **Tempo.** `tempoOk` is 88–100 %, against the 95 % target from Kim et al. 2020. The selection's tempo tolerance
   is 5 % for open format and scores linearly beyond it, and the planner still beat-matches up to 8 %. As a result,
   cross-genre moves such as dubstep 140 → techno 130, or reggaeton 90 → 97, end up stretched by 5–8 %.
4. **The checker reports level dips on ordinary outro blends.** `checkTransition` measures the dip against a straight
   line from the level 1 s before the blend to the level 1 s after it. When the outgoing track's outro (−4 LU)
   follows a drop, and the blend lands the incoming drop, the quieter outro and intro in the middle read as a 3.5–5 LU
   "dip". The outro is part of the music, so this is probably a false positive; it holds `levelOk` at 77–100 %.
   One way to fix it would be to start the reference line from the outgoing level at the blend start.

Observation (not asserted): in real sets double drops are rare. Even with `doubleDrops: true`, the bass night has 1
in 31 transitions; with AutoMix's default (the 35 % pair hash), the three-hour bass night has none. The `MIN_PLAY`
rule (60 % of what is left) appears to put the earliest exit after the last drop + 16 bars in most cases, so double-drop exits are
seldom available.
