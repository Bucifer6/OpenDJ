# 01 — DJ Transition Techniques: Execution Rules for an Automix Engine

Scope: transition techniques, phrasing fundamentals, gain staging, and suitability detection, written so each item can be encoded as a parameterised rule. Target engine: 2+ decks, 3-band isolator EQ, HPF/LPF filter, echo/delay/reverb, loops, tempo + keylock, crossfader, 4-stem separation (vocals / drums / bass / other).

> **Provenance note.** Web *search* worked during this research, but direct page fetching was blocked for every DJ site tried (digitaldjtips.com, djtechtools.com, mixgraph.io, dj.studio). Claims tagged **[src]** come from search-result summaries of the cited pages. Numbers tagged **[eng]** are engineering defaults synthesised from common practice: reasonable starting values to tune by listening, not quoted standards. No source gives a single authoritative number for most parameters (the sources themselves say so), so expose them as config.

---

## 0. Glossary and units

| Term | Definition (4/4 time) |
|---|---|
| beat | 1 quarter note. `beat_s = 60 / BPM` |
| bar (measure) | 4 beats |
| phrase | 8 bars (32 beats) is the canonical dance phrase. Sections are 8/16/32 bars. Mixed In Key: dance music is "produced in groups or phrases of 32 beats" [src: [MIK – Control the energy level](https://mixedinkey.com/Book/Control-The-Energy-Level-Of-Your-DJ-Sets)]. DJ TechTools: most electronic/pop is built on phrases of 16 and 32 counts [src: [DJTT – Why you must understand phrasing](https://djtechtools.com/2014/11/16/how-to-dj-101-why-you-must-understand-phrasing/)] |
| downbeat / "the one" | beat 1 of a bar. Phrase downbeat = beat 1 of bar 1 of a phrase |
| hypermeter | the 4/8/16/32-bar grouping above the bar. Most structural changes (new element, drop, break) happen on a 16- or 32-bar hypermeter boundary |
| section | intro / build / drop / breakdown / outro (EDM); intro / verse / hook / bridge (hip-hop, pop) |

Duration table (useful for UI and for checking time budgets):

| BPM | 1 bar | 8 bars | 16 bars | 32 bars |
|---|---|---|---|---|
| 90 | 2.67 s | 21.3 s | 42.7 s | 85.3 s |
| 100 | 2.40 s | 19.2 s | 38.4 s | 76.8 s |
| 124 | 1.94 s | 15.5 s | 31.0 s | 61.9 s |
| 128 | 1.875 s | 15.0 s | 30.0 s | 60.0 s |
| 140 | 1.71 s | 13.7 s | 27.4 s | 54.9 s |
| 174 | 1.38 s | 11.0 s | 22.1 s | 44.1 s |

At 128 BPM, 8 bars is 15 s [src: production guides; [Berklee – remix structure](https://online.berklee.edu/takenote/remix-song-structure/)].

---

## 1. Phrasing fundamentals

### 1.1 Rules

1. **Start the incoming track on a phrase downbeat of the outgoing track.** With simple 16-bar structures it is often enough to start the incoming track at a phrase boundary of the playing track [src: [Wikipedia – Phrasing (DJ)](https://en.wikipedia.org/wiki/Phrasing_(DJ))].
2. **Alignment math.** If the incoming track has an N-bar intro and you want its first main section (drop/groove) to land on the outgoing track's next section change at bar T, then `start_in = T − N` bars, and that point must itself be a phrase boundary of the outgoing track [src: DJTT forum thread on phrase matching; [DJKIT "Rule of 32"](https://www.djkit.com/blogs/news/djing-rule-of-32)]. DJKIT's example: start the incoming intro 32 beats before the outgoing phrase ends. It says the rule works best for house, techno, trance, DnB and EDM.
3. **Intro over outro** is the basic phrase mix [src: MIK]. Intros and outros are sparse, which keeps blends clean [src: [DJClass – phrasing](https://djclass.net/learn/phrasing-and-song-structure)].
4. **Verify, don't assume.** Tracks mix 8-, 16- and 32-bar sections. Some have 4-bar pickups, 2-bar fills or odd 12/24-bar sections [src: [Cursa – bars & phrasing](https://cursa.app/en/page/dj-mixing-foundations-bars-phrasing-and-starting-on-the-one)]. The engine needs section detection (§4), not just a fixed grid from the first beat.
5. **Events happen on boundaries.** EQ swaps, cuts and FX engage/disengage on a phrase downbeat (preferred), else a bar downbeat. A swap on the phrase downbeat "sounds like part of the arrangement"; a mid-bar swap sounds like a change [src: [mixgraph – bass swap](https://www.mixgraph.io/glossary/bass-swap)].

### 1.2 Track structure by genre [eng unless cited]

Bars are given at the track's native tempo.

| Genre | BPM | Typical structure (bars) | DJ-friendly zones | Notes |
|---|---|---|---|---|
| House / tech house | 120–128 | Intro 16–32 (often drums only for first 8–16) → groove/verse 16–32 → breakdown 8–32 → build 8–16 → drop 32 → outro 16–32 | intro, outro, often the post-drop groove | Some mainstream house has 24-bar intros where the first 8 are "for the DJ" [src: KVR forum via search]. Production guides say intros are usually a multiple of 16 bars, with a new element every 32 beats [src: [MIK Captain – arrange a dance track](https://mixedinkey.com/captain-plugins/wiki/how-to-arrange-a-dance-music-track/)] |
| Techno | 125–140 (modern peak 135–150) | Long, loop-based. Intro 32–64, slow 16/32-bar element changes, 1–2 breaks, outro 32–64 | very long overlap windows | Phrase changes are subtle. Detect them by spectral novelty rather than by energy drops |
| Trance | 132–140 | Intro 32 → build 16 → main 32 → long breakdown 32–64 (melodic, often beatless) → build 8–16 → climax 32 → outro 32 | intro/outro; breakdown-to-breakdown | Big melodic keys mean harmonic compatibility matters most here |
| Drum & bass | 170–176 | Intro 16–32 (often 32, often beatless or broken) → drop 1 (32–64) → break 16–32 → drop 2 (32) → outro 16–32 | intro → drop alignment; double drop | One DJ guide: "16- or 32-bar intro, a drop, a middle break, another drop, then an outro" [src: r/Beatmatch thread via search]. Vande Veire & De Bie's automatic DnB DJ annotates drops and uses three transition types: **double drop, rolling, relaxed** [src: [EURASIP 2018](https://link.springer.com/article/10.1186/s13636-018-0134-8)] |
| Dubstep / riddim | 140 (feels 70) | Intro 16 → build 8 → drop 16–32 → break 8–16 → build 8 → drop 2 16–32 → outro 8–16 | short; drop-swap and double-drop culture | Half-time feel: count bars at 140 |
| Hip-hop / rap | 85–100 (trap 130–150 half-time) | Intro 4–8 → verse 16 → hook 8 → verse 16 → hook 8 → bridge 8 → hook 8 → outro 4–8 | hook start, verse start, short instrumental intro | Clean/club edits add 8–16-bar DJ intros. Quick-mix style plays 30–90 s per record and depends on preset cue points [src: [mixgraph – quick mix](https://www.mixgraph.io/glossary/quick-mix)] |
| Pop / top-40 | 95–128 | Intro 4–8 → verse 8–16 → pre 4–8 → chorus 8–16 → … → bridge 8 → final chorus → outro 4–8 (often a fade) | first chorus; "intro edits" | Radio versions have short intros and fade-outs. Prefer extended/DJ edits; otherwise cut-mix |
| Disco / nu-disco / funk | 110–125 (live drums: drifting tempo) | Intro 8–16 → verse/chorus → long instrumental breaks → outro | breaks; 12" extended mixes | Live-played tempo drifts ±1–2 BPM, so the beatgrid needs tempo-curve support. Keep blends short (8–16) or loop-extend |
| Reggaeton / dembow | 88–100 | Intro 4–8 → verse/coro 8–16, dembow loop throughout | almost anywhere on a 4/8-bar boundary | Constant dembow pattern makes beat blending easy. Vocal clash is the main risk, so use short blends or cuts |
| Afro house / amapiano | 118–124 / 110–115 | Long intros (32+), percussive grooves, log-drum bass (amapiano) entering late; long 32–64-bar blends common | long intros/outros | Amapiano log drum = bass + melody, so never stack two log-drum lines |
| Afrobeats | 98–110 | Pop-like: intro 4–8 → verse/hook | hook boundaries | Mix like open-format: short blends, cuts |

### 1.3 Cue point selection (where pros cue) [eng + src]

Priority order for automatic cue generation:

1. **Mix-in cue**: first downbeat of the first phrase containing a kick (drum intro start). If the track starts beatless, cue on the beatless intro's first phrase downbeat and treat it as an "ambient intro".
2. **Drop cue**: first downbeat of the first main drop (needed for drop-swap/double drop). The mixgraph drop-swap entry recommends a hot cue on the incoming drop [src: [mixgraph – drop swap](https://www.mixgraph.io/glossary/drop-swap)].
3. **Break cue**: first downbeat of the main breakdown.
4. **Mix-out cue**: first downbeat of the outro phrase (often where the main bass/melody exits).
5. **Vocal-in cue** (hip-hop/pop): first downbeat of the first hook or verse.
6. **Loop-able regions**: 4/8/16-bar drum-only regions (stable spectrum, low vocal energy) for loop extension.

Grid sanity: snap every cue to the nearest bar downbeat, then to a phrase downbeat when within ±1 bar of the detected section boundary.

### 1.4 Section-landing rule (phrase alignment objective)

Let the outgoing track A have its next section boundary at time `tA` (e.g. its outro start or its 2nd-drop end), and the incoming track B have its target landing point `kB` (drop, first groove, or hook) after `nB` bars of lead-in. Then:

```
start_B (in A's bar index) = barIndex(tA) - nB
constraint: start_B is on an A phrase downbeat (mod 8 bars == 0 relative to A's phrase grid)
constraint: overlap region in A must be "mixable" (low vocal / low melodic density) for the stems that are audible
```

If `nB` is not a multiple of 8, either loop/trim B's intro, or accept start on a 4-bar boundary (lower score).

---

## 2. Transition catalogue

Notation: `A` = outgoing, `B` = incoming. Bars are relative to the transition start `t0` = an A phrase downbeat. "EQ low −∞" = full kill (isolator). EQ values are dB on the deck's 3-band isolator, 0 dB = unity. Fader 0–1 is the channel-fader position *before* the fader curve.

### 2.1 Long EQ blend with bass swap (house / techno / trance / afro)

- **Sound:** two grooves layered so the floor barely notices. Hats and percussion of B creep in, then the bassline "changes hands" on a downbeat.
- **When:** house, techno, tech house, trance, afro house, progressive. Energy maintenance or gentle rises. Needs |ΔBPM| ≤ ~3% after sync (tempo-matched), keys compatible (Camelot same / ±1 / A↔B relative) or at least one track's overlapping part atonal (drum intro).
- **Duration:** 16–32 bars typical (house), 32–64 (techno/afro/progressive). One recipe: 16-bar blend, gradual handoff over bars 17–24, full swap by 25–32 [src: [Cursa – EQ blends](https://cursa.app/en/page/dj-mixing-foundations-eq-use-for-smooth-blends)]. DDJT: switch the bass at the first beat of a new phrase after two 8-bar phrases [src: [Digital DJ Tips – muddy mixes](https://www.digitaldjtips.com/?p=2799689)]. Hard swaps are typically placed at 16, 32 or 48 bars [src: [DJ Courses Online](https://djcoursesonline.com/dj-blog/2018/6/26/the-performance-approach-to-eqing-2)].

**Recipe (32-bar version, house at 124–128):**

| Bar (from t0) | Deck A | Deck B |
|---|---|---|
| pre | playing, EQ flat | cued at mix-in cue; trim set to loudness-match (§3.4); **low −∞ (kill)** before fader up [src: [DJClass – gain staging & EQ](https://djclass.net/learn/gain-staging-and-eq)]; high −6 dB, mid −6 dB [eng] |
| 0 (A phrase downbeat) | — | play B; fader 0 → 1 over 8 bars (linear on fader, which with a smooth fader curve ≈ equal-power) |
| 0–8 | — | high −6 → 0 dB over bars 4–8 |
| 8 | high 0 → −6 dB over 8 bars (makes room for B's hats) | mid −6 → −3 dB |
| 16 (phrase downbeat) **BASS SWAP** | low 0 → −∞ in ≤1 beat (hard) or over 2–4 beats | low −∞ → 0 in the same window. Total low-band energy must stay ~constant |
| 16–24 | mid 0 → −6 dB; high −6 → −12 dB | mid → 0 dB |
| 24–32 | fader 1 → 0 over 8 bars (or by bar 28), alternatively HPF sweep up (see 2.3) | — |
| 32 | stop A, reset EQ | solo |

Swap-speed variants: an instant swap, 2-beat swap, 4-beat swap, or no EQ at all; one drill practises all four [src: [Digital DJ Pool – EQ for beginners](https://digitaldjpool.com/blog/dj-eq-mixing-for-beginners/)]. For the engine, pick:

| Swap style | Duration | Use when |
|---|---|---|
| Hard (kill/unkill) | 0 beats (on downbeat) or 1 beat | both tracks have strong, distinct basslines; tech house/techno; most robust |
| Fast fade | 2–4 beats | sub-heavy rolling bass where a click/gap would be audible |
| Slow fade (crossfade of low band) | 1–2 bars | only if both low ends are just kick+sub and in compatible key; risky |

- **Failure modes:** two basslines audible together (mud, phase cancellation/boosting of kicks, out-of-key sub). Swapping mid-phrase. Leaving A's highs fully up so the hats double (harsh, "busy"). Overall level bump while both faders are at 1 with mids/highs flat. Mid-range (vocal/lead) clash in bars 8–24. Swapping onto a section where B's bass does not yet exist (B still in drum intro), which leaves a hole in the low end.
- **Suitability detection:** BPM ratio within ±3% (or 2:1); A has a ≥16-bar tail with low vocal-stem energy; B has a ≥16-bar intro with low vocal and melodic stem energy; beatgrid confidence high for both; key distance ≤1 Camelot step *or* the low-band (bass stem) is atonal/absent in one of the overlap halves; B's bass stem onset bar known (swap at or after it).

### 2.2 Quick bass swap / short EQ mix

- **Sound:** a tight 4–8-bar handover. Feels like the track "turns into" the next one.
- **When:** tech house, UK garage, bass house, open-format house, DnB "rolling" mixes, and whenever key compatibility is poor (short overlap = less clash). Energy maintenance.
- **Duration:** 4–8 bars (house), 8–16 bars (DnB, since bars are shorter).
- **Recipe (8 bars):** pre: B low −∞, fader 0. Bar 0: B fader 0 → 1 over 2–4 bars, B highs in. Bar 4 (or 8): bass swap on the downbeat (hard). Bars 4–8: A fader → 0 (or A HPF 20 Hz → 1 kHz). Bar 8: A out.
- **Failure modes:** starting mid-phrase. A's vocal clashing with B's lead. Fader drop on A leaving an energy dip. A's reverb tail or snare roll colliding.
- **Detection:** same as 2.1 but only requires 8-bar clean regions. Prefer it when vocal/melodic stems are dense in the overlap or when key distance is > 1 step.

### 2.3 Filter sweep transitions (HPF/LPF)

- **Sound:** HPF on A = A thins and "lifts away" (tension). LPF on B = B arrives muffled ("next room") and opens up.
- **When:** all 4/4 genres. Particularly good for masking key clashes or groove differences, and building tension into a drop. Native Instruments describes the mirror approach: high-pass the incoming track, then open it while closing the outgoing one [src: [NI – best DJ effects](https://blog.native-instruments.com/best-dj-effects/)]. VirtualDJ: apply a gradual HPF to the outgoing track during its final phrase while the new track comes in at full frequency, and don't push the filter to its extreme [src: [VirtualDJ – DJ effects](https://virtualdj.com/articles/how-to-use-dj-effects)]. Start the sweep at a phrase start (8 or 16 bars) and move the filter only on bar starts [src: [Cursa – filter transitions](https://cursa.app/en/page/dj-mixing-foundations-filter-transitions-and-tension-control)]. Don't overuse it: one filter sweep or reverb wash per transition is often enough [src: [DJClass – filters & FX](https://djclass.net/learn/filters-and-fx)].
- **Parameters [eng]:**

| Param | HPF-out (on A) | LPF-in (on B) |
|---|---|---|
| Cutoff path | 20 Hz → 300 Hz (bars 0–4, slow) → 2–4 kHz (bars 4–8, faster): **exponential (log-frequency) ramp**, i.e. linear in octaves | 300–500 Hz → 20 kHz, exponential |
| Resonance (Q) | 0.7–1.5 (mild); up to 3–4 for an obvious "sweep" in tension builds | 0.7–1.0 |
| Duration | 8 or 16 bars | 8 or 16 bars |
| Exit | at bar 8/16 downbeat, fader A → 0 within ≤1 beat, then reset filter after the fader is down | reaches open at the B phrase downbeat (ideally B's drop) |
| Combine with | bass swap at the midpoint (A's HPF passing ~150 Hz is effectively the bass handoff) | B low kill until the downbeat |

- **Engine note:** an HPF sweep on A *replaces* the A-side bass kill. As A's cutoff passes 100–200 Hz, B's low band should come in. Implement it as "low-band ownership" (§3.2).
- **Failure modes:** sweeping too fast or too far (into a thin whistle) and leaving it there. Resetting the filter while the fader is up (A suddenly blasts back). High-Q resonance at high volume (ear-piercing). Filtering both decks simultaneously in the same direction (whole mix goes thin). Sweeping across a vocal phrase.
- **Detection:** good default when key distance is > 2 Camelot steps, when the A overlap region has vocals (filter removes the presence band progressively), or when timbres clash. Score higher if B's landing point is a drop.

### 2.4 Echo-out / delay freeze exit

- **Sound:** A's last beat or phrase repeats in tempo-synced echoes that decay while B starts clean (or starts on the next downbeat).
- **When:** any genre, but especially when tracks are *not* compatible for a blend: different BPM, key, or genre; switching tempo (§2.11); ending vocal tracks; hip-hop and open format; the end of a set. Digital DJ Tips points out that once the echo starts you have less control, a "dead end", and suggests alternatives [src: [DDJT – Stop using echo out](https://www.digitaldjtips.com/stop-using-echo-out/)].
- **Parameters:** delay time 1 beat or 1/2 beat [src: [DDJT – 3 essential effects](https://digitaldjtips.com/?p=2756549)]. A 1-beat echo suits a quick vocal exit; a 2-beat echo leaves more space before a drop [src: VirtualDJ]. Traktor users start around 1/16, 1/4 or 1/2 with Freeze [src: NI]. The delay must be tempo-synced, or the repeats fight the grid [src: [mixgraph – echo out](https://www.mixgraph.io/glossary/echo-out)]. Keep feedback modest, since a long tail competes with the incoming track [src: VirtualDJ].

| Param | Value [eng] |
|---|---|
| Delay time | 1 beat (default); 1/2 beat for busier/faster material; 3/4 (dotted) for a "bouncing" exit in house; 2 beats for slow hip-hop |
| Feedback | 40–60% (tail ≈ 2–4 bars). 70%+ only for freeze/build moments |
| Wet/dry | ramp wet 0 → 50–70% over the last 1 bar before cut |
| Filter on tail | HPF 200–400 Hz on the delay return (removes muddy low repeats); optional LPF 6–8 kHz to soften |
| Post-cut tail | 2–4 bars; B must be audible no later than 1 bar after the cut |
| Freeze variant | at the cut, set feedback ≈ 100% for 1 bar (loop-like stutter), then drop to 30% so it decays |

- **Recipe:** (1) Choose the cut point = A's phrase downbeat or the last beat of a vocal line (e.g. the bar-4 or bar-8 downbeat of A's last phrase). (2) One bar before: engage echo with wet ramping up, feedback 50%, HPF on the echo return. (3) On the cut beat: A's *dry* signal fader → 0 instantly (post-fader send off, i.e. "echo-out" requires a send that keeps ringing after the fader drops, so in Web Audio route the delay **pre-fader**, or capture the input then cut the dry gain). (4) B starts on the next downbeat (1 bar after the cut) *or* exactly on the cut downbeat if B starts with a strong drum hit / drop. (5) Tail decays under B; HPF the tail upward over 2 bars.
- **Failure modes:** unsynced delay time. Too much feedback (mud under B). Bass in the repeats. Cutting mid-word (echoes "-ing ing ing"). Gap of silence between the tail and B ("dead air"). Echoing a non-downbeat (stutters feel off-grid). Using the echo-out for every transition (the commonest amateur tell).
- **Detection:** prefer when (|ΔBPM| > 6% and not ~2:1) OR key distance ≥ 3 steps OR genre change OR A has a clear final vocal phrase ending on a downbeat. Choose a cut point where the A vocal stem has an onset-free gap starting within 1 beat after a word ending.

### 2.5 Reverb wash-out

- **Sound:** A dissolves into a reverb cloud; B emerges from or after it. More atmospheric than echo.
- **When:** trance, progressive, melodic techno, downtempo, ambient breaks; leaving a breakdown; genre/tempo changes. Thomann: place the reverb just before the track exits so the tail carries it out [src: [Thomann – DJ effects](https://www.thomannmusic.com/blog/inspire/dj-effects-chasing-the-dramatic-drop/)]. Serato's "epic reverb" variant HPFs the outgoing track to drop the bass, then pulls the reverb back out to bring the beat in [src: [Serato – epic reverb](https://serato.com/latest/blog/18312/pro-tip-epic-reverb)].
- **Parameters [eng]:** reverb decay 4–10 s (large hall/plate); pre-delay 20–40 ms; wet ramp 0 → 80–100% over 1–2 bars; HPF on the reverb input or return at 300–600 Hz (no low-frequency wash); damping on highs ~6–8 kHz to avoid hiss. At the cut, the dry fader → 0 and the reverb send stays (pre-fader/"spillover"). B starts at the next phrase downbeat, low cut for 1 bar.
- **Failure modes:** low-end wash (mud). Too long under a full-energy B. Silence gap. Overuse.
- **Detection:** A ends in a sustained pad/vocal; B starts beatless or with a strong drop; energy change (down → up) desired; BPM/key incompatible.

### 2.6 Loop-and-blend (extending intros/outros)

- **Sound:** invisible; A's final drum bar(s) or B's intro keep repeating to make room for a long blend.
- **When:** A's outro or B's intro is too short for the chosen blend length; radio edits; disco/funk breaks; tracks that end with a fade-out (loop before the fade).
- **Recipe [eng]:** pick a 4- or 8-bar region (better: 8 = one phrase, preserves hypermeter; a 1-bar loop is fine for pure drums) that is drum-dominant (low vocal/other-stem energy) and starts on a phrase downbeat. Engage the loop exactly on the region's end so playback wraps seamlessly (sample-accurate quantized loop, with 2–5 ms crossfade at the loop seam). Run the blend over the loop. Release the loop on a phrase boundary, or simply fade A out while looping. Don't loop more than ~16–32 bars total of the same 1–4-bar material (gets monotonous); vary it with a filter. Traktor's 32-beat (8-bar) maximum loop is one practical reference [src: DJTT forum via search].
- **Stems enhancement:** loop A's *drums stem only* while the full B comes in (A's vocals/melody stop naturally) — the "drum bridge".
- **Failure modes:** loop seam click (no crossfade). Loop starting off-phrase so the hypermeter flips. Looping a region with a vocal fragment or a crash cymbal (obvious repetition). Leaving the loop on until the region's sustained notes repeat unnaturally.
- **Detection:** compute required blend length vs available clean region length. If short, search for a 4/8-bar drum-only region near the cue (high drums-stem ratio, spectral self-similarity with the next bar > threshold).

### 2.7 Cut / slam / drop-swap on the downbeat

- **Sound:** instant change on beat 1. Punchy, energetic, zero overlap.
- **When:** hip-hop, open format, DnB, dubstep, bass music, festival EDM, any situation where tracks clash harmonically or rhythmically. Hip-hop, DnB, open format and urban DJs tend to use shorter mixes and cut tracks in "on the one" [src: [NI – DJ transitions](https://blog.native-instruments.com/dj-transitions/)].
- **Variants:**

| Variant | Execution |
|---|---|
| Straight cut | at A's phrase downbeat, A fader 1 → 0 and B 0 → 1 in < 10 ms (use a 3–5 ms ramp to avoid clicks). B starts from its cue (drop or hook) |
| Drop-swap | at the moment A would drop (end of A's build), cut to B's drop instead: B starts from its drop cue on A's drop downbeat. Only one drop is heard, lower risk than double drop [src: [mixgraph – drop swap](https://www.mixgraph.io/glossary/drop-swap)] |
| Build-into-drop | let A play its build (8–16 bars) and cut to B's drop on the downbeat after the build. Or: B's build over A's breakdown, cut |
| Dropmix (hip-hop) | jump in on the snare of beat 2 or 4 instead of the 1 [src: [DDJT – Dropmix](https://www.digitaldjtips.com/2020/04/dropmix-like-a-pro-hip-hop-dj/)] |
| Cut with FX tail | add a 1/2- or 1-beat echo on A at the cut (2.4) to soften |
| Silence/"pause" cut | 1 beat or 1 bar of silence (or an "air horn"/sweep) before B's drop. Dramatic; open format only |

- **Duration:** 0 bars (instant), plus an optional 1–2-bar build cue.
- **Failure modes:** off-grid timing (cut not on the downbeat; even 30–50 ms late is audible). Level jump (B's drop much louder or softer than A's section: loudness-match by section LUFS, §3.4). Cutting from a high-energy section into an intro (energy cliff). Click at the cut.
- **Detection:** the default fallback for any pair; preferred for hip-hop/pop/reggaeton/open format, large BPM difference after tempo change, or key distance ≥ 3. Need: B has an identified hook/drop cue; A has a section boundary within the time budget.

### 2.8 Double drop (DnB, dubstep, bass music)

- **Sound:** both tracks' drops hit simultaneously, a huge layered moment.
- **When:** DnB, jungle, dubstep, riddim, bass house, festival EDM; peak energy. Requires precise beatmatching [src: [dj.studio – mix DnB](https://dj.studio/blog/mix-drum-and-bass)]. Variant: drop one track's 1st drop on the other's 2nd drop [src: r/Beatmatch via search]. Vande Veire & De Bie's automatic DnB system implements "double drop" as one of three transition types with annotated fade lengths in measures [src: EURASIP 2018].
- **Recipe [eng, DnB @ 174]:**
  1. Alignment: B's drop downbeat = A's drop downbeat (A's 1st or 2nd drop). So `start_B = A_drop_bar − B_intro_bars` (typically 16 or 32 bars of B's intro run under A's build/breakdown).
  2. During the lead-in: B fader up, B low −∞, B mid −6 dB, B high 0 (B's intro hats/fx add to A's build).
  3. At the drop downbeat: **low band goes to ONE track only.** Choose the dominant bass (the "owner") and keep the other's low at −∞ (or a −10 to −15 dB shelf so only the kick punch remains). Mid of the non-owner −3 to −6 dB.
  4. Both drops run 16–32 bars together (to the end of one drop phrase).
  5. At the end of that phrase: either fade/cut A, or bass-swap to B and remove A over 4–8 bars.
- **Failure modes:** two basslines (the main danger; this is where "never two basslines" bites hardest). Kicks/snares not phase-aligned (flams). Key clash between reese/wobble basses. Level bump (+3–6 dB when summing two full drops, so pull both channel gains down ~3 dB at the drop). Drops of different lengths (one ends after 16, the other runs 32: the mismatch is audible). Overuse.
- **Detection:** both tracks have detected drops; |ΔBPM| ≤ 2%; key distance ≤ 1 step (bass is tonal); drop lengths equal; B's intro length ≤ A's build+break length; low-band spectral overlap high → require full low kill on the non-owner.

### 2.9 Spinback / backspin and brake (vinyl stop)

- **Sound:** spinback = record yanked backwards (a "whoosh" falling in pitch); brake = record slows to a stop, pitch falling.
- **When:** hip-hop, open format, party/wedding, DnB/jungle rewinds, dubstep. Useful when the two tracks cannot be blended [src: [mixgraph – spinback](https://www.mixgraph.io/glossary/spinback)]. A brake is also a classic end-of-track or end-of-routine exit [src: DDJT, search summary]. One extension trick: at the end of a phrase do a half or full backspin and jump back to the drop's hot cue [src: [zZounds – well placed backspin](https://blog.zzounds.com/2020/01/10/improve-your-mix-with-a-well-placed-backspin/)].
- **Parameters [eng]:**

| Param | Brake | Spinback |
|---|---|---|
| Trigger | last beat of A's phrase (beat 4 of bar 8/16), or on the downbeat for "stop then drop" | beat 4 (the "and" of 4) of A's last phrase bar |
| Duration | 1/2 – 2 beats ("brake within a beat" is a common setting [src: Crossfader vinyl brake trick, search summary]); longer (1–2 bars) = audible slowdown | 1/2 – 2 beats, playback rate −1× → −3× peak, then decaying to 0 |
| Rate curve | exponential decay to 0 (rate(t) = r0·e^(−t/τ), cut at rate < 0.05) | reverse rate ramp up fast (50 ms) then decay |
| EQ | reduce A's low before the spinback; maybe lower the channel slightly [src: zZounds] | same, and HPF ~150 Hz on the reversed audio |
| Landing | **B must start exactly on the next downbeat** after the effect ends; where it ends matters more than how fast [src: mixgraph – brake] | same |

- **Failure modes:** landing B late (dead air). Spinback length not quantised. Loud low-end rumble during the reverse. Overuse (gimmick). Using it in a flowing techno set.
- **Detection:** open-format/hip-hop context; incompatible BPM/key; A at a high-energy point and B starts with a strong downbeat (hook/drop cue). Do not use for house/techno blends.

### 2.10 Power-down (turntable power-off)

- **Sound:** like a brake but slower and more "dying": 1–4 bars of pitch dropping to 0 with an LPF closing.
- **When:** end of set, tension before a massive drop (silence → drop), hip-hop/party moments.
- **Recipe [eng]:** at A's last phrase bar 1: rate ramp 1.0 → 0 over 1–2 bars (exponential), LPF 20 kHz → 400 Hz in parallel; volume follows −6 dB at the end. Optional 1 beat of silence. B drops on the next phrase downbeat.
- **Failure:** same as the brake; plus keylock must be OFF during the slowdown (keylock + slowdown sounds like time-stretch artefacts, not a turntable).

### 2.11 Tempo-change transitions

Pros change tempo by (a) gradual pitch ride, (b) half/double-time bridge, (c) cut/echo-out and restart, (d) using a beatless section as a free tempo zone.

| Method | When | Execution [eng + src] |
|---|---|---|
| Gradual ride (pre-shift) | Δ ≤ ~6–8% total, flowing genres | Shift the master tempo during a breakdown or across tracks a couple of BPM at a time [src: [DDJT – tempo trap](https://www.digitaldjtips.com/how-to-change-tempo-dj-sets/)]. Rate of change ≤ ~1 BPM per 8 bars [eng] is barely noticeable with keylock on. Do it during sections without sustained tonal elements if keylock is off (pitch drift) |
| Tempo morph within the blend | Δ ≤ ~4% | Both decks follow a master tempo that ramps from BPM_A to BPM_B over the overlap. DJ.Studio's modes start the tempo change at the beginning of the transition window ("Full") or in the middle ("Half") [src: [DJ.Studio help – BPM controls](https://help.dj.studio/en/articles/8261956-bpm-controls-tips-and-faqs)] |
| Half/double-time bridge | ratio ≈ 2:1 (70↔140, 87↔174, 85↔170) | Beatmatch at the 2:1 ratio. One bar of the half-time track equals two bars of the other, so phrasing must count across both [src: [DDJT – half/double time](https://www.digitaldjtips.com/how-to-mix-using-half-time-and-double-time-bpms/)]. Works best with a fast cut rather than a long crossfade, timed with a build and drop [src: same]. Going from very sludgy half-time to very pacy double-time can sound jarring [src: Pioneer DJ blog via search]. DJ.Studio caps a single transition's stretch at ~25–30% and switches to double/half beyond that [src: [DJ.Studio help – double and half tempo](https://help.dj.studio/en/articles/15359028-double-and-half-tempo)] |
| Echo-out and restart | any Δ, especially non-integer ratios (e.g. 124 → 174) | 2.4 recipe, then B starts at its native tempo on a strong downbeat 0–1 bar after the cut. Set master tempo to B *before* B is audible |
| Brake / spinback restart | open format | 2.9 |
| Beatless bridge | trance/progressive/ambient | Mix A's (or B's) beatless breakdown; tempo is free while no percussion is audible. Ramp the tempo there, then drums enter at the new tempo |
| Acapella bridge | hip-hop/open format | Play a vocal-only stem (no strong pulse) briefly while changing master tempo |

Limits [eng]: with keylock on, ±8% stretch is generally clean; ±8–16% is audible on vocals; beyond that, use a 2:1 relationship or a non-beatmatched method. Without keylock, ±6% (≈ ±1 semitone) changes key by up to 1 semitone, so re-check harmonic compatibility after the pitch change (1 semitone ≈ +7 Camelot steps).

### 2.12 Acapella-over-instrumental / mashup blending (stems)

- **Sound:** A's vocal over B's beat (or vice versa); a live remix; the transition *is* the mashup.
- **When:** open format, hip-hop, pop, house edits, "bootleg" culture. Needs key compatibility (vocals are highly tonal: Camelot same / ±1 / relative) and tempo within keylock range.
- **Stem recipes:** fade out drums on A while bringing in drums on B [src: [dj.studio – stem separation guide](https://dj.studio/blog/evidence-based-guide-dj-stem-separation)]. Mute A's vocals so only its instrumental plays, then lay the acapella over B's instrumental [src: Skillshare tutorial via search]. Serato Stems gives instant acapella/instrumental and toggles for vocals, melody, bass and drums [src: [Serato Stems](https://serato.com/dj/pro/stems)]. rekordbox Track Separation exposes vocal/drums/inst (newer versions: vocal/inst/bass/drums) [src: search summary].

| Stem transition | Execution (bars from t0) [eng] |
|---|---|
| **Drums-first** | 0–8: B drums stem only, under full A (B's other stems muted, B low kill on drums or kick-only). 8: B bass stem in, A bass stem out (swap on downbeat). 8–16: A drums out over 4 bars → B drums own the rhythm. 16: A's vocals/melody still playing over B's drums+bass (mashup moment, ≤ 16 bars if keys are compatible, else ≤ 4). 24/32: A other+vocals out, B other+vocals in on a phrase downbeat (e.g. on B's hook) |
| **Vocal carry-over** | Keep A's vocal stem running over B's instrumental for 4–16 bars (e.g. a hook line), then fade A's vocal out on a phrase end. Requires vocal phrase alignment: A's vocal phrase start on a B phrase downbeat |
| **Acapella intro** | Start B's vocal stem (acapella) 4–8 bars before B's drop over A's instrumental (A vocals muted). Drop to full B on the downbeat |
| **Instrumental bridge** | Mute A's vocals for its last 8–16 bars (instrumental out) so B's vocals can come in early with no clash |
| **Drum bridge** | A → only A drums (other stems out over 2–4 bars) → 4–8 bars of drums only → B (any tempo-change trick happens here) |

- **Stem gain:** when re-assembling full B from stems, all stems must sum to unity (0 dB each); don't "boost" a solo stem. Artefacts (vocal ghosts in instrumentals, especially with distorted guitars/harsh synths) are reported [src: search summary], so keep solo-stem exposure short and HPF the vocal stem at ~120–150 Hz to drop separation artefacts.
- **Failure modes:** vocal key clash (worst offender). Two vocals at once ("mid-range clash"). Vocal phrase starting off the downbeat. Stem artefacts exposed for a long time. Stem toggling causing level drops (removing drums from a track removes ~3–6 dB of perceived loudness: compensate).
- **Detection:** vocal stem energy timeline (find gaps/phrases); key of A's vocal vs B's harmony; stem separation confidence; genre (open format/pop/hip-hop/house more tolerant).

### 2.13 Hip-hop / open-format quick cuts and wordplay transitions

- **Quick mix style:** play 30–90 s per record, relying on cue points set in advance [src: mixgraph – quick mix]. Transitions are mostly cuts, short 1–4-bar blends, echo-outs, spinbacks, chops.
- **Chop:** alternate rapidly between two records with the crossfader, a bar or phrase from each, so they trade the floor [src: mixgraph glossary via search]. Half-beat chopping: cut the crossfader on every half beat ("one and two and") [src: Crossfader/DDJT tutorial via search].
- **Wordplay transition:** the last line or word of A references the title or first line of B (e.g. A's lyric "…let's go" → B whose hook starts with "Let's go"). Mechanically: echo-out or cut on A's keyword, B starts at the matching lyric cue (often B's hook). [eng: requires lyric transcription / ASR on vocal stems plus a keyword index; a light version is matching song titles to A's last-line words.]
- **Recipe (cut on the hook) [eng]:** A at the end of a hook or verse (detected section boundary). At bar −1: A 1/2-beat echo engaged, wet 30%. At downbeat 0: A fader → 0, B plays from its hook/verse cue at full level. Total 0–1 bar.
- **Failure modes:** cutting mid-line; landing on a weak part of B (intro instead of hook); level mismatch; repeating the same trick.
- **Detection:** genre tags hip-hop/R&B/pop/reggaeton/afrobeats; short intros; vocal-dense tracks; BPM often unequal (but ≤ 8% between adjacent picks in practice).

### 2.14 "Drop on the drop" vs "drop on the break" (phrase-matched placement)

Two families of phrase-aligned placement:

| Mode | Alignment | Effect | When |
|---|---|---|---|
| Drop on the drop (double drop) | B's drop downbeat = A's drop downbeat | maximum energy, layering | 2.8; DnB/dubstep/EDM peaks |
| Drop on the break (classic phrase mix) | B's drop downbeat = A's breakdown downbeat (or A's outro start) | A goes quiet exactly where B explodes; the crowd perceives one continuous "track" whose next drop is B | most common in house/techno/trance/DnB. The "rolling" type in Vande Veire & De Bie [src: EURASIP 2018] |
| Break on the drop (rare) | B's breakdown over A's drop end | energy down-shift | set-closing, lowering energy |
| Break into break | A's breakdown → B's breakdown (2.15) | smooth, atmospheric | trance, progressive, melodic |

**Rule:** the incoming track's high-energy entry should land where the outgoing track would have changed section anyway (the end of its drop phrase, start of its break, start of its outro). Compute `start_B = boundary_A − bars_before_B_landing` (§1.4).

### 2.15 Breakdown into breakdown

- **Sound:** two atmospheric, beatless (or kick-less) sections overlapping; the beat that returns is B's.
- **When:** trance, progressive house, melodic techno; energy reset; also a tempo-change zone (2.11).
- **Recipe [eng]:** at A's breakdown downbeat (first beatless bar), start B at its breakdown cue (or its beatless intro). Keys must be compatible (pads/leads are exposed): Camelot same/±1/relative only. A: fader down over 8–16 bars, LPF closing (or reverb wash 2.5). B: fader up over 4–8 bars, LPF opening. B's build plays → B's drop. A must be fully gone before B's build ends.
- **Failure modes:** key clash is very audible with no drums to mask it. Two leads/vocals. A's drums returning while B's build is happening (A's breakdown shorter than planned: always check A's breakdown length ≥ overlap).
- **Detection:** both tracks have breakdowns ≥ 16 bars; key distance ≤ 1; low percussion energy in both regions.

### 2.16 Beat juggling / ping-pong (brief)

- **Sound:** alternating short segments (1–2 beats or 1 bar) of the same or two records to create a new rhythm.
- **For automix:** a simple "ping-pong" = alternate A and B every 1 bar for 4–8 bars before the full switch (crossfader hard cuts with 3–5 ms ramps), or alternate drums stems. Only for open format/hip-hop, and only with beat-tight grids. Originally done with two copies of the same record [src: Crossfader tutorial via search].
- **Failure:** timing slop of more than ~10 ms; overuse.

---

## 3. Mixer mechanics: faders, curves, gain staging, clash rules

### 3.1 Channel faders vs crossfader

- **Long blends (house/techno):** most club DJs use channel faders with the crossfader off or centred. Each fader gives independent control, enabling asymmetric shapes such as "B up fast, A down late".
- **Cuts/scratching/chops (hip-hop/open format):** a sharp crossfader curve ("cut" curve: full level for both sides at ~1–3 mm from each end).
- Mixxx exposes the crossfader curve in Preferences ▸ Mixer (constant power to slow fade, among others) [src: [Mixxx manual – Mixer prefs](https://manual.mixxx.org/2.5/ca/chapters/preferences/mixer)].

Curve formulas (x = crossfader 0 → 1; gA, gB linear gains) [eng, standard DSP]:

| Curve | gA(x) | gB(x) | Centre | Use |
|---|---|---|---|---|
| Linear (constant voltage) | 1 − x | x | −6 dB each, sum dips ~−3 dB for uncorrelated material | correlated material (same track) |
| Equal power (constant power) | cos(πx/2) | sin(πx/2) | −3 dB each; constant total power for *uncorrelated* signals | default automix crossfade for full-range blends |
| Smooth / "dipless" | min(1, 2(1−x)) | min(1, 2x) | 0 dB each (both full at centre) | EQ blends: fader moves, EQ does the work. **Needs gain compensation**, otherwise +3–6 dB bump |
| Cut (scratch) | 1 if x < 1−ε else 0 | 1 if x > ε else 0, ε ≈ 0.02–0.05 | 0 dB each | cuts, chops |

Important: two **beatmatched** kicks are *correlated* (in phase), so they sum coherently (+6 dB when both are at unity), not +3 dB. Equal-power curves don't prevent low-end bumps on beatmatched material. This is why DJs kill one track's low band rather than relying on fader curves (§3.2).

Channel fader curve [eng]: map fader position f (0–1) to gain with an audio taper, e.g. `gain_dB = 60·(f − 1)` for f > 0.1 (−54 dB at 0.1), with a linear taper below to 0. Or use `g = f^2` (≈ −12 dB at half) or `g = f^3`. Ramp shapes for automation: S-curve (smoothstep) for fader fades in long blends; linear-in-dB for fade-outs.

### 3.2 "Never two basslines at once" (low-band ownership)

- Overlapping kicks and basslines during transitions are the most common source of clipping; each track can be safe alone while the sum clips [src: [Cursa – gain staging](https://cursa.app/en/page/dj-mixing-foundations-gain-staging-headroom-and-clean-levels)].
- **Engine rule:** at every instant exactly one deck "owns" the low band (< ~200–250 Hz; Mixxx's default low-shelf crossover is 246 Hz [src: Mixxx manual]). The non-owner's low EQ is ≤ −20 dB (kill preferred). Ownership changes only on a beat (preferably a phrase downbeat), with a crossover ramp of 0–4 beats. Exception: if the non-owner has no bass stem energy in the low band (drum intro: kick only), its low can be at −6 to −10 dB for punch; still avoid two full kicks at 0 dB.
- **Stem alternative:** with stems, ownership can apply to the *bass stem* (mute/unmute) while kicks are handled via the drums stem low EQ. That allows "A's bassline out, B's kick in" combinations.
- **Kick phase check:** if two kicks overlap at full low, misalignment of 5–15 ms causes flamming/comb filtering. Require beatgrid alignment error < ~5 ms when any two low bands overlap.

### 3.3 Mid-range clash (vocals, leads)

- Two vocals or two lead melodies at once is the second most common clash. Rule: at most one dominant vocal at a time; at most one dominant lead in the 500 Hz–4 kHz presence band unless keys match.
- Mitigation ladder [eng]: (1) time the overlap to avoid vocal regions (use vocal stem activity); (2) mute the vocal stem of one deck; (3) mid EQ −6 to −12 dB on the less important track during overlap; (4) HPF/LPF to move one track out of the band; (5) shorten the blend; (6) cut instead.
- Hats doubling (highs): two full-hat tracks overlapping at 0 dB sound harsh; drop the outgoing high to −6 dB once the incoming highs are in.

### 3.4 Gain staging and loudness matching (LUFS)

- **Trim once, mix with faders.** Changing trim mid-transition causes tonal shifts and hits limiters unpredictably. Set trim once per track and do transition work with faders [src: Cursa – gain staging].
- **Match perceived loudness, not peaks.** Two tracks with identical peaks can differ in loudness (dense mids and sustained energy raise it) [src: same]. LUFS (ITU-R BS.1770) is the standard loudness measure [src: [Sweetwater – LUFS](https://sweetwater.com/insync/what-is-lufs-and-why-should-i-care/)].
- **Leave headroom for transitions**; DJ output metering is often recommended to sit around −6 to 0 dBFS [src: vendor blog via search, treat as soft].

Engine parameters [eng]:

| Param | Value |
|---|---|
| Analysis | integrated LUFS per track *and* short-term LUFS (3 s window) per section (intro, drop, outro) |
| Target | normalise each deck's trim so its **main section** (drop/chorus) short-term LUFS = target, e.g. −14 LUFS at the deck (or −10 to −9 for club masters; the absolute value matters less than consistency). Use the main section, not integrated, because long beatless intros drag integrated loudness down |
| Trim limits | ±12 dB; do not boost more than +6 dB (noise, clipping) |
| Blend compensation | during an overlap with both decks full-range, reduce master/bus by ~1.5–3 dB or each deck by the curve's built-in dip. Measure the expected summed loudness: if the predicted short-term LUFS of the sum exceeds target + 1 LU, automate a compensating gain on the incoming fader |
| Section landing | at a cut, B's section loudness should be within ±1 LU of A's section (up to +2 LU when an energy *increase* is intended; never > +3 LU jump) |
| Master safety | true-peak limiter on master, ceiling −1 dBTP, aim for < 2 dB gain reduction typical; frequent limiting = gain staging is wrong |
| Stems toggled off | compensate (e.g. removing drums: +2 to +4 dB on remaining stems only if the result would otherwise be a perceived drop that isn't intended) |

### 3.5 EQ conventions [eng]

| Band | Range (typical isolator) | Kill depth | Ramp |
|---|---|---|---|
| Low | < 200–250 Hz | −∞ (or ≤ −26 dB) | 0–4 beats for swaps; 8–16 bars for fades |
| Mid | 250 Hz – 2.5 kHz | −∞ | 4–16 bars |
| High | > 2.5 kHz | −∞ | 4–16 bars |

Mixxx's mixing EQs are isolators (high shelf + band-pass + low shelf, adapted from analog crossovers) with full kill [src: Mixxx manual]. A 1–2-bar bass cut at the end of a 16-bar section gives a small lift; an 8-bar cut builds tension [src: [MusicRadar – EQ & filter tricks](https://www.musicradar.com/news/eq-and-filter-tricks-for-djs)]. That is a useful "intra-track" trick the automix can use to signal an incoming change.

---

## 4. Suitability detection from audio analysis

### 4.1 Required analysis features per track

| Feature | Use |
|---|---|
| BPM, beatgrid, downbeats (bar phase), grid confidence; tempo curve for live-drummed tracks | all beatmatched methods |
| Phrase grid and section boundaries + labels (intro / build / drop / break / outro / verse / hook); boundary strength | §1, placement |
| Key (Camelot) + key confidence; tonalness per section (chroma entropy) | harmonic compatibility; atonal drum intros relax key constraints |
| Per-section energy: short-term LUFS, low-band RMS, onset density, spectral centroid/flux | energy matching, drop detection (big jump in low RMS + LUFS after a build) |
| Stem activity timelines (vocals, drums, bass, other) at bar resolution | mixable-region detection, clash avoidance, loop-region search |
| Drum-only / loopable regions (high drums ratio, high bar-to-bar self-similarity) | loop extension |
| Vocal phrase onsets/offsets; optional ASR keywords | echo-out cut points, wordplay |
| Genre / style tag (classifier or metadata) | choose transition family and durations |

Mixability of a bar `b` for role R (outgoing tail / incoming head) [eng]:

```
mix(b) = w1*(1 - vocal_act(b)) + w2*(1 - other_act(b)) + w3*drums_act(b) + w4*(1 - tonalness(b)) + w5*grid_conf
```

A region is "clean" if mix ≥ 0.6 for ≥ L consecutive bars, starting on a phrase downbeat.

### 4.2 Pair compatibility features

| Feature | Formula / threshold [eng] |
|---|---|
| Tempo ratio r | r = BPM_B/BPM_A; normalise by ×2/÷2 to [0.75, 1.5]. "Blendable": abs(r−1) ≤ 0.03 (ideal) … 0.06 (acceptable with keylock). 2:1: abs(r−2) ≤ 0.04 |
| Key distance | Camelot steps: 0 = same; 1 = adjacent number or A↔B same number; +2 = MIK "Energy Boost" (8A → 10A) [src: [MIK – energy boost](https://mixedinkey.com/workflows/change-energy-with-camelot-wheel/)]; +7 = semitone jump, dramatic, avoid on slow mixes [src: DJTT forum]. Effective key after pitch shift without keylock: semitones = 12·log2(r) |
| Energy delta | ΔLUFS and Δonset-density between A's exit section and B's entry section |
| Spectral overlap | cosine similarity of 3-band energy in the overlap: high low-band overlap ⇒ strict low ownership; high mid overlap ⇒ vocal handling needed |
| Genre distance | from tags; cross-genre ⇒ cut/echo/tempo tricks |

### 4.3 Technique selection decision table [eng]

| Condition | First choice | Fallbacks |
|---|---|---|
| Same genre (house/techno/afro/progressive), abs(r−1) ≤ 3%, key Δ ≤ 1, clean regions ≥ 16 bars | Long EQ blend 16–32 bars (2.1) | filter blend (2.3), quick swap (2.2) |
| as above but key Δ = 2–3 | Quick bass swap 8 bars (2.2) + HPF on A | filter sweep (2.3); stem instrumental bridge |
| as above but clean regions < 16 bars | Loop-extend (2.6) + blend | quick swap |
| Trance/progressive, both have breakdowns, key Δ ≤ 1 | Breakdown-into-breakdown (2.15) | drop on the break (2.14) |
| DnB/dubstep, key Δ ≤ 1, drop lengths match, |r−1| ≤ 2% | Double drop (2.8) ~20–30% of transitions (variety) | drop on the break; quick swap 16 bars |
| DnB/dubstep, key mismatch | Drop-swap cut (2.7) | echo-out (2.4) |
| Hip-hop/pop/reggaeton/afrobeats/open format | Cut on the hook/downbeat (2.7/2.13), 1–4-bar blend | echo-out, spinback/brake, stem acapella carry (2.12) |
| abs(r−1) in 3–8%, same family | Tempo morph during the blend or pre-ride during A's breakdown (2.11) | echo-out restart |
| r ≈ 2 or 0.5 | Half/double-time cut on a build/drop (2.11) | drum bridge |
| abs(r−1) > 8% non-integer, or genre jump | Echo-out restart (2.4) or reverb wash (2.5) | brake/spinback (2.9), beatless/acapella bridge |
| Vocal overlap unavoidable | Mute one vocal stem (2.12) | shorten/cut |
| End of set | Power-down (2.10) or long reverb wash | echo-out |

Variety constraint: don't use the same "effect" transition (echo, spinback, brake, filter sweep) twice in a row, and cap effect transitions at ~30% of transitions in a blend-genre set. Overusing the echo-out is a common amateur tell.

---

## 5. Amateur tells (global checklist the engine should avoid)

1. Off-phrase entrances/swaps (the #1 tell).
2. Two basslines / two full kicks at 0 dB (mud, +3–6 dB bump, limiter pumping).
3. Two vocals at once, or key-clashing leads/pads.
4. Level jumps at cuts (> ±1–2 LU unintended).
5. Fader/EQ moves that are too abrupt where a smooth move was expected (zipper noise, unramped gain changes: always ramp ≥ 3–5 ms; for EQ ≥ 10–20 ms unless an intentional kill on a beat).
6. Long silence ("dead air") after FX exits.
7. FX overuse; the same trick repeatedly.
8. Leaving filters/FX engaged after a transition (forgetting to reset). The engine should reset when the fader is at 0.
9. Grid drift during long blends (tempo slightly off → phasing/flams). Use sync with sample-accurate phase lock.
10. Energy cliffs: cutting from a drop into a beatless intro, or a sudden +4 LU jump.
11. Keylock artefacts at large stretch (> ~8%) on vocals.
12. Cutting mid-word or mid-vocal-phrase.

---

## 6. Parameter quick-reference (defaults to start tuning from) [eng]

| Technique | Genre default length | Swap/cut timing | EQ/filter | FX |
|---|---|---|---|---|
| Long EQ blend | house 16–32, techno 32–64, afro 32–64, trance 16–32 | bass swap at bar 16 (of 32) on downbeat, 0–1 beat | B low kill pre-swap; A high −6 dB after B highs in | — |
| Quick swap | 4–8 (house), 8–16 (DnB) | bar 4 or 8 | same | — |
| Filter out (A) | 8–16 | fader cut at end | HPF 20 Hz → 2–4 kHz exp, Q 0.7–1.5 | — |
| Filter in (B) | 8–16 | open on B phrase downbeat | LPF 400 Hz → 20 kHz exp | — |
| Echo-out | tail 2–4 bars | cut on phrase/vocal end | HPF 200–400 Hz on tail | delay 1 beat (1/2 fast), fb 40–60%, wet 50–70% |
| Reverb wash | 2–8 bars | cut on phrase | HPF 300–600 Hz on reverb | decay 4–10 s, wet → 80–100% |
| Loop-extend | loop 4/8 bars (1 bar drums ok), total ≤ 32 | release on phrase | — | 2–5 ms seam crossfade |
| Cut / drop-swap | 0 bars | on downbeat ±5 ms | — | optional 1/2-beat echo |
| Double drop | 16–32 bars overlap after the drop | drops aligned to the bar | non-owner low −∞, mid −3 to −6 dB; both channels −3 dB | — |
| Brake | 1/2–2 beats (or 1–2 bars) | trigger beat 4, B on the next 1 | low cut on A | rate exp decay |
| Spinback | 1/2–2 beats | trigger "and" of 4 | HPF 150 Hz | reverse rate |
| Power-down | 1–2 bars | B on the next phrase | LPF → 400 Hz | rate → 0 |
| Breakdown→breakdown | 8–16 | B drop owns | LPF out on A, LPF open on B | optional reverb |
| Stem drum bridge | 4–8 bars drums-only | phrase boundary | — | tempo change allowed |
| Acapella carry | 4–16 bars | vocal phrase aligned to B downbeat | HPF vocal 120–150 Hz | — |
| Tempo ride | ≤ 1 BPM / 8 bars | — | — | keylock on |
| Half/double time | cut (0–4 bars) | on build→drop | — | — |

---

## 7. Academic and engineering references

- Vande Veire, L. & De Bie, T. (2018). *From raw audio to a seamless mix: creating an automated DJ system for Drum and Bass.* EURASIP JASMP 2018:13. Three transition types (double drop, rolling, relaxed) with annotated fade lengths in measures; DJ EQ adjustments over bass/mid/treble. 91% fully correct annotations on 160 songs and a 220-song hold-out set; 18-listener test. https://link.springer.com/article/10.1186/s13636-018-0134-8 (open-source code "auto-dj" accompanies the paper).
- Chen, B.-Y. et al. (2022). *Automatic DJ Transitions with Differentiable Audio Effects and GANs* (DJtransGAN, ICASSP 2022). Learns fader and 2-band EQ curves from real DJ mixes. https://arxiv.org/abs/2110.06525
- *Automated Time-frequency Domain Audio Crossfades using Graph Cuts* (2023). Per-frequency-bin transition times, a generalisation of the bass swap. https://arxiv.org/pdf/2301.13380
- Mixxx manual: crossfader curves, isolator EQ (246 Hz default low crossover), kill. https://manual.mixxx.org/2.5/ca/chapters/preferences/mixer
- Mixed In Key: phrasing/energy, Camelot, Energy Boost (+2). https://mixedinkey.com/Book/Control-The-Energy-Level-Of-Your-DJ-Sets, https://mixedinkey.com/workflows/change-energy-with-camelot-wheel/
- DJ TechTools: phrasing. https://djtechtools.com/2014/11/16/how-to-dj-101-why-you-must-understand-phrasing/ ; EQ theory https://djtechtools.com/2012/03/11/eq-critical-dj-techniques-theory/
- Digital DJ Tips: half/double time https://www.digitaldjtips.com/how-to-mix-using-half-time-and-double-time-bpms/ ; tempo changes https://www.digitaldjtips.com/how-to-change-tempo-dj-sets/ ; echo https://www.digitaldjtips.com/how-to-use-echo-when-djing/ ; dropmix https://www.digitaldjtips.com/2020/04/dropmix-like-a-pro-hip-hop-dj/ ; five basic transitions https://www.digitaldjtips.com/rock-the-dancefloor/five-basic-dj-transitions/
- Native Instruments blog: DJ transitions https://blog.native-instruments.com/dj-transitions/ ; phrase mixing https://www.native-instruments.com/blogs/blog/phrase-mixing ; DJ effects https://blog.native-instruments.com/best-dj-effects/
- Serato: Stems https://serato.com/dj/pro/stems ; epic reverb https://serato.com/latest/blog/18312/pro-tip-epic-reverb
- Crossfader (wearecrossfader.co.uk): DnB mixing https://wearecrossfader.co.uk/blog/howtomixdnb/ ; hip-hop https://wearecrossfader.co.uk/blog/how-to-mix-hip-hop/ ; 12 high-energy transitions https://wearecrossfader.co.uk/blog/12-high-energy-dj-transitions/
- VirtualDJ articles: effects https://virtualdj.com/articles/how-to-use-dj-effects ; levels https://virtualdj.com/articles/how-to-balance-dj-levels
- DJ.Studio help: BPM transition modes and the 25–30% stretch cap. https://help.dj.studio/en/articles/8261956-bpm-controls-tips-and-faqs , https://help.dj.studio/en/articles/15359028-double-and-half-tempo

Gaps worth filling later (pages could not be fetched): exact transition-length distributions measured from real DJ mixes (DJtransGAN/Kim et al. "Computational analysis of real-world DJ mixes", ISMIR 2020, which reports mix-segment and transition-length statistics, is a good target), and Pioneer/AlphaTheta's own guides (not surfaced by search).
