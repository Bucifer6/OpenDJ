# OpenDJ mixer and turntable plan

_Status: plan only. No code has been written. Drafted 2026-11-21 from a read-only pass over the repo and web research._

**Research limits.** www.pioneerdj.com could not be reached from this session (DNS blocked). Pioneer facts below come from search-result excerpts of Pioneer, retailer, review and Serato pages, not from the manuals. Those items are marked ⚠ and repeated in §8. Effort scale is the same as `docs/CONTROLLER_SUPPORT_PLAN.md`: **S** is up to 1 week, **M** is 1–3 weeks and **L** is 3–8 weeks, for one developer.

---

## 1. Summary

### 1.1 What OpenDJ already has

It covers more than most free apps.
- **Mixer:**
  - a 4-channel mixer
  - an LR8 isolator EQ with a DJM-style knob law
  - a resonant one-knob filter
  - 5 Color FX: Space, Dub Echo, Noise, Crush and Jet
  - 10 beat FX per channel, with post-fader tails
  - quick stems on VOC/INST
  - a look-ahead limiter at −1 dBFS
  - 3 crossfader curves
  - cue/PFL, split cue, 4-channel out and a second-device cue
  - a mic with 2-band EQ, compressor and manual talkover
- **Decks:**
  - WSOLA key lock
  - velocity scratch, brake, backspin, censor, slip, reverse and rolls
  - slicer, Pitch Play, Key Sync, instant doubles, memory loops
  - DVS ABS/REL/INT
  - a canvas platter with a 33⅓ rpm marker and a progress ring

### 1.2 The main gaps

- **Mixer:**
  - no booth output
  - one EQ type and one filter type
  - no master isolator
  - peak-only meters
  - no mic FX and no voice-activated talkover
  - crossfader: no hamster reverse, no cut-in setting, and a fixed 4 ms gain time constant that is slow for cuts
  - no channel-fader curves
  - no master beat-FX bus, FX frequency or X-Pad-style strip
  - no send/return, compressor or dual headphones
- **Turntables:**
  - The motor start/stop hook exists in the worklet but nothing calls it. Spin-up after a scratch is instant.
  - Brake and backspin times are hard-coded.
  - no 45/78 rpm
  - no platter inertia or flick gestures
  - one pointer per jog, so no multitouch platter, no haptics and no scratch view on phones
  - no vinyl artwork, strobe or tonearm visuals, and no CDJ-style jog display
  - no scratch-sample bank, Active Loop, quantize divisions or tempo glide
  - `vinylMode`, brake and backspin have no MIDI targets

### 1.3 Top recommendations, in order

1. **Battle-ready crossfader and fader curves (P0, S).** A continuous curve, hamster reverse, a cut-in dead zone, a fast-cut gain ramp (≤2 ms, no clicks) and upfader curves. This is cheap, and every scratch DJ will look for it first.
2. **Vinyl physics model (P0, M).**
   - motor start (torque) and stop (brake) times, wiring up the unused worklet `motor` hook
   - spin-up after release, platter inertia and flick-to-spinback
   - user-set brake and spinback amounts
   - 33/45/78 rpm
3. **Touch platter v2 (P1, M).**
   - per-pointer tracking with `getCoalescedEvents`, on top of the controller plan's position-following worklet (§4.7 of that plan; not duplicated here)
   - two-finger "hand on record"
   - a phone scratch view with a built-in crossfader strip
   - Capacitor haptics
4. **Platter skins (P1, M):** Vinyl (rotating cover art, strobe dots, tonearm needle-drop), CDJ jog display (artwork, position ring, slip ghost, loop arc) and Minimal (today's).
5. **Mixer depth (P1, M–L):**
   - EQ type selector: Isolator, Classic, 4-band, Sculpt
   - Model 1-style HPF/LPF
   - master isolator
   - LUFS and true-peak metering
   - mic FX and auto-talkover
   - **booth output** with a 2-band EQ
6. **Optional mixer personalities (P1, S on top of item 5):** Club, Classic, Rotary and Battle. A suggestion chip comes from the automix inferred profile (for example, Rotary for rominimal). It is never forced.
7. **Beat FX v2 and CDJ deck features (P1–P2):** master FX bus, FX frequency, an X-Pad-like strip, Active Loop, quantize divisions, tempo glide (needs automix P1 `rateRamp`) and scratch samples.

---

## 2. What exists today (verified in code)

### 2.1 Mixer: `public/js/audio/engine.js`, `effects.js`, `fx-worklets.js`, `ui/mixer-ui.js`

| Area | What exists | Where |
|---|---|---|
| Channel chain | trim (±12 dB plus auto-gain) → quick stems (mid/side DSP) → EQ → HPF/LPF → Color FX → FxUnit → fader → crossfader gain → music bus | `engine.js` `Channel` (l.19–190) |
| EQ | 3-band isolator: Linkwitz-Riley 48 dB/oct at 200 Hz and 2.5 kHz, with an all-pass to keep phase coherent, about 34 biquads per channel. Knob law `eqKnobGain`: +6 dB, 0 dB at noon, −26 dB at 8 o'clock, then fading to a full kill | `engine.js` l.9, l.24–35 |
| Filter | One knob. Left is a 24 dB/oct LPF (18 kHz → 70 Hz) and right is an HPF (20 Hz → 8 kHz), with a dead zone and resonance up to about +6.5 dB | `applyFilter` l.167 |
| Color FX | `filter`, `space`, `dubecho`, `noise`, `crush`, `pitch` (labelled "Jet"). The amount follows the filter knob, and one global selector applies to all channels | `effects.js` `COLOR` l.315; `mixer-ui.js` `colorSel` |
| Beat FX | Per channel, `FxUnit` with 10 effects: Echo, Ping Pong, Reverb, Flanger, Phaser, Chorus, Auto Filter, Trans, Bit Crusher, Distortion, plus Noise Sweep. It has MIX, PARAM, P2 and beat divisions from ⅛ to 8, with beat-locked LFOs. Tails are post-fader or pre-fader | `effects.js` l.106–498 |
| Deck "FX" pads | Brake, Backspin, Censor, Echo Out, Roll ¼, Roll ⅛, Filter Sweep, Tape Stop | `app.js` `padFx` l.464; `deck-ui.js` pad mode `fx` |
| Crossfader | Curves `smooth` (constant power), `constant` (linear) and `sharp` (knee at 92 %). Each channel has an assign of A, THRU or B. **Gain is set with `setTargetAtTime(g, t, 0.004)`**, so −40 dB arrives about 18 ms after the move | `applyCrossfader` l.376; `setXfGain` l.132 |
| Channel fader | gain = v² (fixed curve) | `apply()` |
| Cue | Per-channel PFL (pre-fader, post-FX), a cue/master blend (equal power) and phones volume | `setCueMix` |
| Outputs | Master device (`setSinkId`); `cueMode` `split` (mono master L, mono cue R), `channels34` (4-channel), or headphones on a second device via `MediaStreamDestination` plus `<audio>.setSinkId` | `applyOutputs` l.334 |
| Master | volume, then the brickwall limiter (`opendj-limiter` worklet, −1 dBFS, always in the path) | `createLimiter` l.192 |
| Mic | `getUserMedia` → gain → 90 Hz HPF → low shelf (200 Hz) and high shelf (5 kHz) at ±12 dB → compressor (−24 dB, 4:1) → master bus. Manual talkover ducks the music bus by `settings.talkoverDb`, default −12 dB | `setMic` l.274, `setTalkover` l.299 |
| Sampler | 8 pads of synthesised FX at −14 LUFS, routed straight to the master bus (no cue, no channel). There is also a 16-step sequencer | `sampler.js`, `sequencer.js` |
| Meters | `AnalyserNode` peak. Channel meters are pre-fader; master is L/R. The UI uses hardware-like ballistics | `level()`, `masterLevels()`, `mixer-ui.js` `vuMeter` |
| Recording | taps `masterOut`, after the limiter, so it includes the mic | `recording/pcm-tap.js` |
| MIDI (mixer) | `mixerN.{volume,trim,eqHigh,eqMid,eqLow,filter,cue,fxOn,fxMix,fxParam,fxParam2,vocal,inst}`, `mixer.crossfader`, `master.{volume,cueMix,hpVolume}`, `mic.{on,talkover,volume}` | `midi/midi.js` `buildTargets` |

### 2.2 Decks: `audio/deck.js`, `audio/worklets.js`, `ui/deck-ui.js`, `ui/controls.js`, `ui/waveform.js`, `dvs/`

| Area | What exists | Where |
|---|---|---|
| Scratch | `jogScratch(deltaRot, dt)` turns movement into a velocity (33⅓ rpm, 1.8 s of audio per revolution, clamped to ±12×). The worklet smooths it (`curRate += (target−curRate)·0.02` per sample, about a 1 ms time constant), with a 40 ms idle reset | `deck.js` l.397; `worklets.js` l.164 |
| Jog behaviour | **VINYL** toggle (`deck.vinylMode`): the top scratches and the outer ring (radius > 0.78) nudges. With vinyl off, the whole platter nudges. The mouse wheel nudges. Paused nudge seeks | `controls.js` l.120–150; `deck-ui.js` l.57 |
| Motor | **The worklet supports `startTime` (motor ramp) via a `motor` message, but no code sends it, so play and release are instant** (de-clicked by a 4 ms ghost cross-fade) | `worklets.js` l.19, l.91, l.165 |
| Brake / backspin | Friction-plus-drag brake model reaching 0 in the requested time; backspin flick (60 ms) then spin-down. Called with fixed values (1.2 s, 3 s "tape stop", 1 s) | `deck.js` l.505–510; `app.js` l.467 |
| Low-speed level | Below 0.3× the level follows platter speed, like a cartridge | `worklets.js` `VEL_KNEE` |
| Transport extras | Slip (shadow position), reverse, censor (slip plus reverse), rolls with slip, slicer (8 slices), beat jump (UI 1–32, MIDI ½–64; moves an active loop), loops (in/out, auto, ½, ×2), 8 hot cues with phase-quantised jumps, memory cues and loops | `deck.js` |
| Tempo | Ranges ±6/8/10/16/25/50/100 %, fader, ±4 % bend buttons, ±0.5 % step targets, reset, sync (beat or tempo), master deck, half/double-time matching | `deck.js` l.10, l.342–393 |
| Key | WSOLA key lock, key shift ±12, Key Sync, PITCH pad mode (Pitch Play) | `deck.js` l.544–570 |
| Needle drop | Clicking or dragging the **overview waveform seeks** (any time, not quantised). Dragging the scrolling waveform scratches while playing or seeks while paused | `waveform.js` l.85–93, l.229–237 |
| Platter visual | Canvas: brushed rim, grooves, sheen, a rotating notch at 33⅓, a progress ring (red blink < 30 s), and a BPM label in the centre. **Hidden in 4-deck layout** | `controls.js` l.152–233; `app.css` `.four-decks .jog` |
| Pointer model | One pointer per jog (`last` is a single object). A second finger on the same jog overrides the first. Separate elements (jog plus crossfader) already track separate pointers | `controls.js` |
| Instant doubles / load guard | Drag a deck header onto another deck. Loading onto a playing deck asks for confirmation (a soft "deck lock") | `deck.js` `cloneFrom`; `app.js` l.109 |
| DVS | Serato CV02/CD and Traktor MK1/MK2. ABS (needle drops jump), REL and INT; 33/45 rpm per deck | `dvs/dvs.js` |
| Layouts | Classic, Perform, Waves and 4 Decks; deck panels Cues, Loops, FX, Stems, Key | `app.js` l.146; `deck-ui.js` |
| MIDI (deck) | About 70 per deck (see `buildTargets`). **Missing:** `vinylMode`, brake, backspin, rpm, tempo range and motor times | `midi/midi.js` |
| Haptics | None. `@capacitor/haptics` is not a dependency (`package.json`) | — |

### 2.3 Plans this one builds on (do not duplicate)

- **`docs/CONTROLLER_SUPPORT_PLAN.md`:**
  - §4.7: MIDI timestamps, `ticksPerRev` jog profiles, a **position-following worklet with an alpha-beta filter**, release ramp, high-res jogs, and the baby-scratch acceptance test (< 5 ms RMS)
  - §4.9: `fx1.*` / `fx2.*` targets, `deckN.needle`, `deckN.jumpSize.*`, soft takeover
  - Phase 3 owns all of that.

  This plan reuses the same position API for touch and mouse input, and adds vinyl motor physics around it.
- **`docs/INTELLIGENT_AUTOMIX_PLAN.md`:**
  - P1 execution engine: `Channel.automate`, worklet `rateRamp` / `playAt`, and lanes `a.eq.low` and so on
  - P2 `automix/context.js` inferred profiles, including "Rominimal"

  Personalities (§5) read the profile. Tempo glide (T11) reuses `rateRamp`. EQ types must keep automix lanes working (§7 risks).
- **`docs/RESOURCES_AND_LICENSING.md`:** only CC0, public-domain, CC-BY or CC-BY-SA material may be bundled. The Sonic Pi CC0 `vinyl_scratch`, `vinyl_backspin` and `vinyl_rewind` samples are already shortlisted (§3.1 of that doc).

---

## 3. Research summary

### 3.1 Club and battle mixers

| Mixer | Features relevant to OpenDJ | Source |
|---|---|---|
| Pioneer DJM-A9 | - Dual headphones, each with its own cue, volume and mix ⚠<br>- Sound Color FX **Center Lock**<br>- 14 Beat FX (new: Mobius, Triplet Filter, Triplet Roll)<br>- horizontal X-Pad<br>- Mic FX Echo, Pitch and Megaphone plus a separate Mic Reverb ⚠ (sources differ)<br>- phantom power<br>- 2-band booth EQ<br>- mic can be excluded from the recording output<br>- talkover attenuator | [Pioneer news](https://www.pioneerdj.com/en/news/2023/djm-a9-4-channel-professional-dj-mixer/), [Serato](https://serato.com/dj/hardware/pioneer-djm-a9), [Pioneer store](https://pioneerdjstore.com/products/djm-a9), [Mixmag](https://mixmag.net/read/pioneer-dj-new-four-channel-mixer-djm-a9-tech), [Digital DJ Tips](https://www.digitaldjtips.com/reviews/pioneer-dj-djm-a9-mixer/) |
| Pioneer DJM-V10 | - **4-band EQ** (Hi, Mid-Hi, Mid-Lo, Low; Hi and Low full kill)<br>- **one-knob compressor** per channel<br>- send/return to 4 built-in FX (Short Delay, Long Delay, Dub Echo, Reverb) or external units and apps; return to the channel, master or a separate channel<br>- **3-band master isolator** with adjustable crossovers ⚠<br>- booth EQ | [Pioneer 4-band EQ/compressor page](https://www.pioneerdj.com/en/product/features/mixer/djm-v10-4-band-eq-and-compressor), [DJ TechTools](https://djtechtools.com/2020/01/16/djm-v10-pioneer-djs-new-6-channel-mixer-looks-like-it-was-designed-by-a-techno-dj), [DJ Mag](https://djmag.com/news/pioneer-dj-announce-new-flagship-mixer-djm-v10) |
| Pioneer DJM-900NXS2 / 750MK2 | - Sound Color FX: Sweep, Filter, Crush, Dub Echo, Noise, Space<br>- Beat FX with **FX Frequency** (apply to a chosen band)<br>- Beat FX list on the 750MK2: Delay, Echo, Ping Pong, Spiral, Reverb, Trans, Flanger, Pitch, Roll, Vinyl Brake, Helix | [900NXS2 overview](https://www.pioneerdj.com/en/product/mixer/archive/djm-900nxs2/black/overview/), [750MK2 Pro FX](https://www.pioneerdj.com/en/product/features/mixer/pro-fx-djm-750mk2/) |
| Pioneer DJM-S11 (battle) | - crossfader curve, reverse, and per-channel-fader curve and reverse in the driver panel<br>- feel (tension)<br>- lag and "smoothness" settings<br>- Magvel Fader Pro, whose cut lag and bounce are left for the DJ to tune | [Serato S11](https://support.serato.com/hc/en-us/articles/10173644586895), [Digital DJ Tips](https://www.digitaldjtips.com/reviews/pioneer-dj-djm-s11-mixer/), [Magvel story](https://www.pioneerdj.com/en/landing/magvel-fader-evolution/) |
| Allen & Heath Xone:96 | - 2 VCF filters (HPF/BPF/LPF, frequency and resonance), assignable to any channel<br>- **CRUNCH**: controlled harmonic distortion before the filter | [MusicRadar](https://www.musicradar.com/news/allen-and-heath-launches-new-xone96-flagship-mixer), [Mixmag](https://mixmag.net/feature/allen-heaths-xone-96-mixer-delivers-space-shaking-analogue-sound) |
| Allen & Heath Xone:92 | - 4-band EQ with total kill on HF and LF (wide-Q cut, narrow-Q boost)<br>- 2 VCFs with **LFO**<br>- crossfader curve knob from progressive to fast cut<br>- 3-way channel-fader curve switch | [A&H block diagram](https://www.allen-heath.com/content/uploads/2023/06/Xone92-Block-Diagram.pdf), [Bonedo Mk2](https://www.bonedo.de/artikel/allen-heath-xone92-mk2-test/) |
| PLAYdifferently Model 1 / 1.4 | - per channel: low-Q **HPF and LPF** (cut only, no colour)<br>- **Sculpt** sweepable EQ (+8 / −20 dB, wide Q, about 7 octaves; 70 Hz–7 kHz on the 1.4) | [DJ TechTools](https://djtechtools.com/2016/05/03/playdifferently-model-1-hands-richie-hawtin/), [Mixxx bug 1581721](https://bugs.launchpad.net/bugs/1581721), [ask.audio](https://ask.audio/articles/review-model-1-mixer), [Digital DJ Tips 1.4](https://www.digitaldjtips.com/?p=2762727) |
| Rane Seventy-Two MKII | - MAG FOUR faders with reverse, contour and **cut-in** adjust<br>- internal and external crossfader tension | [Rane](https://www.rane.com/revitalized-flagship-seventy-two-mixer-twelve-motorized-controller/), [Rane cut-in support](https://support.rane.com/en/support/solutions/articles/69000814134-rane-dj-seventy-two-setting-the-adjustable-fader-tension-and-cut-in), [Rane: hamster history](https://www.rane.com/history-of-the-hamster-switch/) |
| Rane MP2015 (rotary) | - 3-band isolator with adjustable crossover points<br>- steep sweepable channel filters<br>- a submix channel with filter resonance<br>- filters stack<br>- EQ slope: 12 or 24 dB/oct ⚠ (sources differ) | [Rane data sheet](https://cdn.inmusicbrands.com/rane/pdf/mp2015_data.pdf), [DJ Mag review](https://djmag.com/content/review-rane-mp2015-rotary-mixer) |
| E&S DJR400, Condesa, Bozak-style | - discrete circuits close to the original Bozak (Condesa)<br>- valve output stage for warmth and saturation, bypassable (E&S)<br>- rotaries "encourage you to mix differently" | [Vinyl Factory: Condesa](https://thevinylfactory.com/features/condesa-rotary-mixer-interview/), [Mixdown: DJR400](https://mixdownmag.com.au/reviews/review-es-djr-400-rotary-mixer/), [DJ TechTools rotaries](https://djtechtools.com/2016/06/24/independent-rotary-mixers-botique-dj-tool/) |
| Ecler WARM4 | - 4th-order (24 dB/oct) 3-band isolator at 300 Hz and 4 kHz, −∞ to +12 dB<br>- per-channel subharmonic synth (25–60 Hz) | [Juno Daily](https://www.juno.co.uk/junodaily/?p=180589), [Turntable Lab](https://www.turntablelab.com/collections/ecler-dj-mixers/products/ecler-warm4-four-channel-analogue-rotary-mixer) |
| Denon X1850 | - 4 Sweep FX (left/right variants)<br>- 16 BPM FX with FX quantize, two FX sections<br>- per-channel filters with resonance<br>- two mics | [Denon DJ](https://www.denondj.com/x1850%20prime-x1850primexus.html), [DJ Mag](https://direct.djmag.com/news/denon-dj-announce-new-x1850-mixer) |
| Scratch technique and fader terms | - cut-in is the dead space before the fader starts tracking<br>- hamster means reverse<br>- in software, the sharpest cut time is coupled to the audio buffer size | [Rane support](https://support.rane.com/en/support/solutions/articles/69000814134-rane-dj-seventy-two-setting-the-adjustable-fader-tension-and-cut-in), [Mixxx bug 1703475](https://bugs.launchpad.net/bugs/1703475), [Mixxx hamster request](https://code.launchpad.net/bugs/829533) |
| Loudness meters | EBU Mode: momentary 400 ms, short-term 3 s, BS.1770-4 K-weighting; true peak by 4× oversampling | [EBU Tech 3341](https://tech.ebu.ch/docs/tech/tech3341.pdf), [EBU R128](https://tech.ebu.ch/docs/r/r128v4_0.pdf) |

### 3.2 Turntables, players and jogs

| Device | Feel and features | Source |
|---|---|---|
| Technics SL-1200MK7 / M7L | - **start torque and brake speed adjustable separately in 4 steps**<br>- start-up 0.7 s to 33⅓<br>- ±8 / ±16 % pitch<br>- **reverse play** at 33/45/78<br>- 78 rpm via a switch | [Technics MK7](https://technics.com/uk/products/dj-series/sl-1200mk7.html), [spec PDF](https://help.na.panasonic.com/wp-content/uploads/2024/11/SL1200MK7_Specifications_US_1.pdf) |
| Pioneer PLX-CRSS12 | - torque High, Mid or Low<br>- 3 stop speeds<br>- tonearm-free DVS<br>- Magvel clamp sets how heavy the platter feels | [Digital DJ Tips](https://www.digitaldjtips.com/reviews/pioneer-dj-plx-crss12-controller-turntable/), [Sweetwater](https://www.sweetwater.com/store/detail/PLXCRSS12) |
| Reloop RP-8000 MK2 | - **Platter Play**: pads change platter speed to play melodies (22 scales)<br>- pitch ±8 / 16 / 50 %<br>- 8 pads with Cue, Loop, Roll, Slicer, Pitch Play | [CDM](https://cdm.link/reloops-new-rp-8000-mk2-instrumental-pitch-control-serato-integration/), [Serato](https://serato.com/dj/hardware/reloop-rp-8000-mk2) |
| Rane Twelve MKII / One | - motorised platter at 3,600 ticks per revolution<br>- strip for track search and hot cues<br>- swappable slipmat | [Rane](https://rane.com/twelve-mkii), [B&H](https://www.bhphotovideo.com/c/product/1580013-REG/rane_dj_twelve_mkii_12_motorized.html/overview) |
| Pioneer CDJ-3000 | - **Jog Mode**: Vinyl (top scratches, edge bends) or CDJ (all bends)<br>- **Jog Adjust** (weight)<br>- **Vinyl Speed Adjust** (a brake-like stop on pause)<br>- beat jump ½–64 (Shift changes size), moves loops<br>- Key Shift and Key Sync<br>- **Active Loop**<br>- fine-tune loop in/out with the jog | [CDJ-3000 manual](https://www.fullcompass.com/common/files/87303-CDJ3000UserManual.pdf), [VirtualDJ CDJ-3000 manual](https://virtualdj.com/manuals/hardware/pioneer/cdj3k/controls.html), [MusicRadar](https://musicradar.com/reviews/pioneer-dj-cdj-3000-review) |
| Denon SC6000 / SC6000M | - SC6000M: 8.5″ motorised platter with **torque adjust**, slip friction set by the spindle screw<br>- **jog display** with artwork, BPM, loop and time<br>- Engine OS vinyl stop time settings ⚠ | [Engine user guide v5.3](https://cdn.inmusicbrands.com/engine/53/SC6000%20PRIME%2C%20SC6000M%20PRIME%2C%20SC5000%20PRIME%2C%20SC5000M%20PRIME%20-%20User%20Guide%20-%20v5.3.0.pdf), [Engine DJ community](https://community.enginedj.com/t/sc6000m-backspin/52333) |
| Pioneer DDJ-FLX10 | on-jog displays (proprietary; not drivable, per the controller plan §4.8) | controller plan |
| Serato Scratch Bank | a pad mode that swaps a deck to a scratch sample or track (up to 32 slots); pre-installed samples | [Serato support](https://support.serato.com/hc/en-us/articles/360002234676-Using-Scratch-Banks-with-Serato-DJ-Pro), [Rane 1.6 firmware](https://www.rane.com/1-6-firmware-update-how-to-use-serato-scratch-bank/) |
| VirtualDJ | Vinyl mode (scratch) or CD mode (nudge); playback physics apply while playing | [VirtualDJ manual](https://virtualdj.com/manuals/virtualdj/interface/decks/deckbasics/) |
| Scratch techniques | - **baby**: back and forth, fader open<br>- **chirp**: fader closes at the turnarounds<br>- **transformer**: steady record, fader taps<br>- **flare**: fader starts open, clicks closed mid-stroke<br>- **crab**: four-finger taps against the thumb | [We Are Crossfader](https://wearecrossfader.co.uk/blog/scratching-for-beginners/), [Wikipedia: Crab](https://en.wikipedia.org/wiki/Crab_(scratch)), [School of Scratch](https://schoolofscratch.com/classroom/course-4-scratch-techniques/) |
| djay turntable view | No official description was found. A community request notes that the grooves are a stock illustration, not the track's audio ⚠ | [Algoriddim community](https://community.algoriddim.com/t/vinyl-grooves-would-show-actual-audio-data-not-arbitrary-tracks/729) |

### 3.3 Platform facts

- **Haptics.** `@capacitor/haptics` offers `impact`, `notification`, `vibrate`, `selectionStart`, `selectionChanged` and `selectionEnd`. Calls resolve with no effect on devices without a haptic engine. Custom patterns need `@capawesome/capacitor-haptics` (Core Haptics on iOS) ([Capacitor docs](https://capacitorjs.com/docs/apis/haptics), [Capawesome](https://capawesome.io/docs/sdks/capacitor/haptics/)). On the web, `navigator.vibrate` works on Android Chrome only ⚠, not iOS Safari.
- **Latency.** `AudioContext.baseLatency` and `outputLatency` are estimates. Measure end-to-end latency yourself ([MDN](https://developer.mozilla.org/docs/Web/API/AudioContext/outputLatency), [WebAudio issue 2467](https://github.com/WebAudio/web-audio-api/issues/2467)). Gain changes still land on 128-frame render boundaries: 2.7 ms at 48 kHz.
- **Multitouch.** Pointer Events give each finger its own `pointerId` and `setPointerCapture`. `getCoalescedEvents()` returns sub-frame samples for smooth platter tracking ⚠ (availability varies on iOS WebKit).

---

## 4. Mixer feature list

**Conventions.**
- MIDI ids follow `buildTargets` (`mixerN.*`, `mixer.*`, `master.*`, `mic.*`) and the controller plan (`fx1.*`, `fx2.*`, `kind` of `button`, `abs` or `rel`, and v2 `takeover: pickup` for absolute knobs).
- New ids never rename existing ones.
- "Advanced drawer" means a new collapsible **Advanced mixer** panel under the mixer, opened from a ⚙ button next to the curve selector. On phones it is a bottom sheet.
- Each feature is a pure function or a small node factory, so `test/fx-dsp.test.js` (Node, math and worklets) and `scripts/e2e-fx.mjs` (browser `OfflineAudioContext`) can measure it objectively.

### M1. Crossfader v2: curve knob, hamster reverse, cut-in, fast cut (P0, S)
- **Reference:** Xone:92 progressive-to-fast-cut curve knob; Rane Seventy-Two MAG FOUR reverse, contour and cut-in; DJM-S11 curve, reverse and lag settings; Rane hamster history.
- **Sketch:**
  - Replace the three-way `settings.crossfaderCurve` with:
    - `xf.curve` (0–1 continuous)
    - `xf.reverse` (boolean)
    - `xf.cutIn` (dead zone at each end, 0–10 % of travel)
    - `xf.cutTime` (ms)
  - Pure `xfGain(pos, side, {curve, cutIn})` in a new `audio/curves.js`:
    - curve 0 is linear
    - curve 0.5 is constant power (today's "smooth")
    - curve 1 is a cut: the gain reaches unity within `cutIn` plus 1 % of travel
    - the family is a power and smoothstep blend
  - Migrate old values: smooth → 0.5, constant → 0, sharp → 1 with cutIn 8 %.
  - **Fast cut:** `setXfGain` currently uses `setTargetAtTime(g, t, 0.004)` (about 18 ms to −40 dB). Switch to `linearRampToValueAtTime` over `cutTime` (default 1 ms in Battle, 5 ms elsewhere) after `cancelAndHoldAtTime`.
  - For MIDI input, schedule at the event's timestamp mapped to audio time (needs the controller plan Phase 0 `e.timeStamp`).
  - CPU: none added.
- **UI:**
  - The curve selector next to the crossfader becomes a small curve knob with a preview glyph.
  - REV (hamster) toggle beside it.
  - cut-in and cut time live in the advanced drawer.
- **MIDI:** `mixer.xfCurve` (abs, pickup), `mixer.xfReverse` (button, LED), `mixer.xfCutIn` (abs).
- **Mobile:** The crossfader on phones gets a larger hit area (48 px). The reverse toggle stays reachable in the scratch view (T8).
- **Tests and acceptance:**
  - Node: curve 0 gives a linear sum; curve 0.5 gives |A|²+|B|² = 1 ± 0.01 across travel; curve 1 gives the far side ≤ −80 dB at `pos ≥ cutIn+1 %`.
  - Monotonic for every curve value.
  - Reverse mirrors exactly.
  - e2e (`OfflineAudioContext`) with `cutTime` 1 ms:
    - gain reaches ≤ −60 dB within 1 ms plus one render quantum of the scheduled time
    - the largest sample step stays within 1.05× the clean signal's (no click)
  - Old settings migrate to identical gains within 0.1 dB.

### M2. Channel-fader curves and upfader reverse (P0, S)
- **Reference:** Xone:92 3-way channel-fader curve; DJM-S11 per-channel-fader curve and reverse.
- **Sketch:**
  - `mixer.faderCurve` set to:
    - `log`: today's v², which is −12 dB at half travel
    - `linear`
    - `smooth`: v³ (rotary-like, long top end)
    - `cut`: unity above 3 % travel, for battle upfader cuts
  - `cutTime` is shared with M1.
  - Optional per-channel `faderReverse`.
  - The pure function lives in `curves.js`. `apply()` uses it for both `fader` and `postFader`, so post-fader FX tails stay consistent.
- **UI:** advanced drawer (global curve plus per-channel reverse). Battle and Rotary personalities preset it.
- **MIDI:** `mixer.faderCurve.next` (button), `mixerN.faderReverse` (button).
- **Mobile:** none special.
- **Tests:**
  - curve tables at 0, 0.25, 0.5, 0.75 and 1 match the spec within 0.1 dB
  - `cut` reaches ≤ −80 dB below 3 %
  - post-fader FX send equals the dry fader gain within 0.1 dB

### M3. Selectable EQ type (P1 for Classic and 4-band, P2 for Sculpt; M)
- **Reference:** DJM-900NXS2 and A9 style EQ vs isolator ⚠ (the A9's selector was not verified); V10 and Xone:92 4-band with full kill on HF and LF; Model 1 Sculpt (+8/−20 dB, wide Q, 70 Hz–7 kHz on the 1.4); WARM4 4th-order isolator.
- **Sketch:** factor the EQ into `audio/eq.js` with interchangeable factories that all share one interface: `{input, output, set(bands), dispose}`.
  - `isolator` (today's LR8 at 200 Hz / 2.5 kHz).
  - `classic`: low shelf at 70 Hz, peaking at 1 kHz with Q 0.7, high shelf at 13 kHz. That is 3 biquads, so very cheap, and the bands overlap like an analogue EQ. Knob law: +6 / −26 dB with no full kill (a classic EQ cannot fully kill).
  - `fourBand`: LR8 at 150 Hz, 1 kHz and 5 kHz (about 50 biquads), with Hi and Low full kill and the mids reaching −26 dB like the V10 ⚠ (the exact V10 frequencies and ranges were not verified).
  - `sculpt`: the HPF and LPF of M4 plus one peaking band, swept from 70 Hz to 7 kHz, Q about 0.35, +8 / −20 dB.

  The type is switched with a 30 ms equal-gain cross-fade between the old and new chains. The new chain is created first; the old one is disposed after 150 ms, the same pattern as `setColorFx`. Isolator crossover points become adjustable within ±1 octave (MP2015-style), advanced only.

  CPU per channel:
  - isolator: about 34 biquads
  - fourBand: about 50
  - classic: 3
  - sculpt: 5

  On low-end mobile, a `fourBand` choice falls back to LR4, 24 dB/oct, about 25 biquads, with a note in Settings.
- **Logical bands:** `eqHigh`, `eqMid` and `eqLow` keep their meaning. 4-band adds `eqMidHigh` and `eqMidLow`; `eqMid` drives both when only 3 controls are mapped. In Sculpt, `eqMid` is the gain and a new `eqFreq` sets the frequency. This keeps automix lanes (`a.eq.low`) and existing MIDI maps working.
- **UI:**
  - The strip shows 3 or 4 EQ knobs according to type (the HI/MID/LOW labels change).
  - The type selector is in the advanced drawer and the personalities.
  - Compact strips (`.mx-short`) hide MID-LO first.
- **MIDI:** existing `mixerN.eqHigh/eqMid/eqLow`; new `mixerN.eqMidHigh`, `mixerN.eqMidLow`, `mixerN.eqFreq` (abs, pickup); `mixer.eqType.next` (button).
- **Mobile:** 4 knobs do not fit a phone strip. Show 3 and a "more" sheet.
- **Tests (e2e via `BiquadFilterNode.getFrequencyResponse` or an offline sweep):**
  - isolator: flat ±0.1 dB at noon; each kill > 40 dB across its band (today's guarantee)
  - classic: noon flat ±0.1 dB; low at −26 dB gives −26 ± 1 dB at 40 Hz and less than 3 dB effect at 1 kHz
  - fourBand: noon flat ±0.2 dB; Hi and Low kills > 40 dB; Mid-Hi at min gives ≤ −24 dB at 2 kHz
  - sculpt: +8 ± 0.5 dB at max and −20 ± 0.5 dB at min, at the selected frequency
  - type switch: no sample step above 1.05× the clean signal's; level at noon matches within 0.2 dB between types
  - automix bass swap with each type removes ≥ 30 dB at 60 Hz

### M4. Filter modes and Color FX Center Lock (P1, S–M)
- **Reference:**
  - Model 1: per-channel low-Q HPF and LPF that only cut and add no colour.
  - Xone:96 and Xone:92: two VCFs (HPF, BPF or LPF; frequency, resonance and LFO), assignable to channels.
  - DJM-A9: Center Lock.
- **Sketch:**
  - `filterMode: oneKnob` (today).
  - `dual`: the existing `hpf` and `lpf` nodes, but driven by two knobs, Q at Butterworth, no resonance. The filter knob becomes `filterHp` and a new knob `filterLp` appears.
  - `vcf` (P2): two global filter units, A and B, each with a type, frequency, resonance up to Q 12 and a beat-synced LFO reusing `opendj-lfo`. They are assignable per channel (Xone-style) and inserted after the channel EQ through a send/return-style insert gain pair, at 4 biquads per unit.
  - **Center Lock:** a setting that stops the filter or Color FX knob crossing noon in one drag. It needs a deliberate second drag, and MIDI is clamped at noon until the control returns to the dead zone. This is pure UI and controller logic.
- **UI:**
  - In `dual` mode the strip shows two small knobs, HP and LP, where the filter knob was.
  - The VCF units sit in the advanced drawer, with A/B assign buttons on each strip (like the crossfader assign).
- **MIDI:** `mixerN.filterHp`, `mixerN.filterLp` (abs); `mixerN.vcfAssign` (A, B or off); `vcfA.freq/res/type/lfoRate/lfoOn` and the same for `vcfB.*`; `mixer.centerLock` (button).
- **Mobile:** use `dual` mode only in landscape. The VCF units appear only on tablets.
- **Tests:**
  - `dual` at rest is flat within 0.01 dB (parked filters, as today).
  - HP at max gives ≥ 24 dB attenuation at 100 Hz, LP at max ≥ 24 dB at 5 kHz, with no resonant peak above +0.5 dB.
  - VCF resonance gives a peak of +12 ± 2 dB at fc.
  - The LFO is phase-locked to the beat grid within 1 ms (the existing LFO test pattern).
  - Center Lock: a simulated drag from −0.5 to +0.5 stops at 0 ± the dead zone.

### M5. More Color FX (P1, S each)
- **Reference:** DJM Sound Color FX Sweep and Pitch ⚠; Xone:96 CRUNCH; X1850 Sweep FX.
- **Sketch:** add entries to `COLOR` in `effects.js`. Keep the id `pitch`, which is labelled Jet, for stored settings.
  - `sweep`: a band-pass gate whose width follows the knob (left narrows towards the low band, right towards the high band).
  - `crunch`: tanh drive with 2× oversampling before the filter. It is an insert with a `wetAmount` ramp.
  - `pitchShift`: a real ±1 octave shift from a short WSOLA or granular worklet, reusing the deck's WSOLA code (CPU about 0.3 % per channel ⚠ estimate).
  - Per-channel Color FX selection (today one selector sets all channels) becomes possible: per-channel in the advanced drawer, global by default.
- **UI:** the existing Color FX `<select>`. In per-channel mode, a small badge on each strip.
- **MIDI:** `mixer.colorFx.next` / `prev` (button) and `mixerN.colorFx.next`.
- **Mobile:** fine. `pitchShift` is turned off when the device-class CPU budget is low.
- **Tests:**
  - every new Color FX is bit-transparent at noon (dead zone): the null test against dry is ≤ −90 dBFS
  - crunch THD rises monotonically with the knob
  - pitchShift produces 2× frequency ± 0.5 % at the max position
  - type switch is click-free (existing pattern)

### M6. Booth output with booth EQ (P1, M)
- **Reference:** DJM-A9 and V10 booth EQ (2-band on the A9); the 900NXS2 setting that removes the mic from the booth ⚠ (community post).
- **Sketch:**
  - New nodes in `Engine.init`: `boothTap` (after the limiter, so the booth never clips) → `boothLow` (low shelf 100 Hz ±12 dB) → `boothHigh` (high shelf 8 kHz ±12 dB) → `boothGain` → `boothOut`.
  - Mic routing: the mic currently joins `masterBus`. Add a separate `micToBooth` gain, which needs the mic to reach the booth by its own path:
    - master minus mic before the limiter, plus mic × `micToBooth`
    - simpler: compute the booth from `musicBus + sampler + mic × micToBooth` through its own `boothLimiter`, which costs one extra limiter worklet
  - `applyOutputs` gains booth destinations:
    - (a) a second or third device via the existing `MediaStreamDestination` plus `<audio>.setSinkId` path (used today for cue)
    - (b) a new `cueMode` value, `channels6` (master 1/2, cue 3/4, booth 5/6) when `destination.maxChannelCount ≥ 6`
    - (c) `channels34booth` (master 1/2, booth 3/4) when the headphones are on another device

    Settings: `boothDeviceId`, `boothRoute`.
  - CPU: 2 biquads plus a gain, or plus a limiter in the separate-mix variant.
- **UI:**
  - master section: BOOTH knob under MASTER
  - advanced drawer: booth EQ HI/LO, "Mic in booth" toggle, and the output routing (repeated in Settings → Audio)
- **MIDI:** `master.boothVolume`, `master.boothEqHigh`, `master.boothEqLow` (abs, pickup); `mic.toBooth` (button).
- **Mobile:** usually one output, so the booth is hidden unless a USB interface reports 4 or more channels (Android ⚠) or a second route exists. Capacitor WebViews may not support `setSinkId` ⚠.
- **Tests and acceptance:**
  - e2e with a fake 6-channel destination: a booth-only tone appears on channels 5/6 only (crosstalk ≤ −90 dB)
  - booth EQ ±12 dB ± 0.5 at 50 Hz and 12 kHz
  - "Mic in booth" off: the mic is absent from booth (≤ −90 dB) and present in master
  - booth level does not affect master or the recording

### M7. Headphone section v2 (P1 for cue extras, P2 for dual headphones; M)
- **Reference:** DJM-A9 dual headphones, each with its own cue, volume and mix; the common master CUE button; split cue (exists).
- **Sketch:**
  - P1:
    - `sampler cue` (route the sampler through a cue send)
    - `master cue` button
    - `cue level` knob, A9-style mono/stereo split option
    - per-channel `cuePost` (post-fader cue, as some battle mixers offer ⚠)
  - P2 dual headphones:
    - a second cue bus `cueBus2`, with per-channel `cueSend2`
    - `hp2` blend and volume
    - routing to a device or channels 5/6 like M6 (shares the output-routing code)
- **UI:**
  - master section: a small "CUE MST" button and a sampler-cue toggle on the sampler knob
  - dual headphones: a "B" cue row under each strip's CUE button (advanced only)
- **MIDI:** `master.cue` (button), `sampler.cue` (button), `mixerN.cue2` (button), `master.hp2Volume`, `master.hp2CueMix` (abs).
- **Mobile:** dual headphones need a splitter or interface, so hide it. Sampler cue works with split cue.
- **Tests:**
  - cue2 isolation ≥ 90 dB from cue1
  - post-fader cue tracks the fader within 0.1 dB
  - sampler cue: the sample is in phones only when the sampler master volume is 0

### M8. Mic section v2 (P1, M)
- **Reference:** DJM-A9 Mic FX (Echo, Pitch, Megaphone plus Reverb ⚠), phantom power (hardware; not applicable), talkover attenuator, mic excluded from recording; X1850 two mics.
- **Sketch:**
  1. **3-band EQ:** add a 1.5 kHz peaking band. `setMicEq` accepts `mid`.
  2. **Mic FX:**
     - Echo: reuse `feedbackDelay`, tempo-synced to the master deck.
     - Reverb: reuse the `opendj-reverb` worklet.
     - Megaphone: band-pass from 500 Hz to 3 kHz plus tanh drive.
     - Pitch (P2): the pitchShift worklet from M5.

     They are send-type effects on the mic chain, after the compressor, with an FX on button and a level knob.
  3. **Talkover modes:**
     - `manual` (today)
     - `auto`: an envelope follower in a small worklet, or an `AnalyserNode` RMS polled at 50 Hz, opens the duck when the mic exceeds a threshold, with 10 ms attack and 300 ms release
     - `advanced`: ducks only 300 Hz–5 kHz of the music with two peaking biquads, so the bass keeps driving the floor ⚠ (Pioneer's "advanced talkover" naming was not verified)

     A depth knob replaces the fixed `talkoverDb`.
  4. **Routing:** mic to booth (M6) and a "mic in recording" toggle. Recording currently taps `masterOut`, so this needs the recorder to tap `masterOut − mic` or a parallel `recBus` (M15).
  5. **Feedback reducer (P2):** an FFT on the mic (`AnalyserNode`, 4096 bins) finds narrow sustained peaks (more than 12 dB above the neighbouring bins for longer than 300 ms) and places up to 4 notch biquads with Q 30. A one-tap "learn" ring-out mode is included.

  CPU: about 6 biquads, a delay, the reverb worklet (already used by Space) and a tiny follower.
- **UI:** the existing `mic-box` grows FX on/select, a talkover mode chip and depth. EQ and the feedback reducer go in the advanced drawer.
- **MIDI:** `mic.eqHigh`, `mic.eqMid`, `mic.eqLow` (abs); `mic.fxOn` (button); `mic.fxType.next`; `mic.fxLevel` (abs); `mic.talkoverMode.next`; `mic.talkoverDepth` (abs); `mic.toRecord` (button).
- **Mobile:** works, since `getUserMedia` exists in the WebViews. Default to auto talkover off. Echo cancellation stays off, as today.
- **Tests and acceptance:**
  - mic FX add ≤ 1 render quantum of latency to the dry mic path (measured as an impulse offset in an offline render with a `MediaStreamSource` substitute)
  - auto talkover: the duck reaches −(depth) ± 1 dB within 15 ms of a −20 dBFS voice burst and releases within 400 ms
  - advanced mode: 60 Hz is attenuated ≤ 1 dB while 1 kHz reaches the full depth
  - feedback reducer: a synthetic 2.5 kHz howl is reduced ≥ 15 dB within 1 s, and pink noise at the same level is not notched

### M9. Beat FX v2: master FX bus, FX frequency, FX strip, new effects (P1, M–L)
- **Reference:** DJM-A9 14 Beat FX (Mobius, Triplet Filter, Triplet Roll), horizontal X-Pad, channel selector; 900NXS2 FX Frequency; 750MK2 list (Spiral, Helix, Pitch, Roll, Vinyl Brake); X1850 FX quantize.
- **Sketch:**
  - **FX bus:** one or two global FX units (`fxUnits[0..1]`), each a `FxUnit` instance with an assign of `ch1..4`, `master` or `crossfader A/B`. Assigning `masterN` inserts it before the master limiter. Channel-assigned units feed from the channel's post-colour point.
  - This is exactly what the controller plan's `fx1.*` / `fx2.*` targets need. They map onto these units rather than onto channel FX. Today's per-channel FX remain as "Channel FX" (the deck FX panel).
  - **FX frequency:** three band toggles (Low, Mid, High) split the unit's send with the isolator crossover code (`eq.js`), so for example only the highs get echoed. Off bands pass dry. CPU: about 34 biquads per unit when on.
  - **FX strip:** an X-Pad-like touch strip. Touching a division (¼, ½, ¾, 1, 2…) momentarily engages the FX at that division and releases on lift. Sliding changes the division. Generic name: "FX strip"; trademark wording rules apply (§7).
  - **New effects in `FX`:**
    - `spiral`: echo with pitch rising per repeat
    - `helix`: a captured-loop freeze
    - `tripletFilter`: Auto Filter on triplets
    - `tripletRoll`: needs deck rolls, so it is a deck FX
    - `lowCutEcho`
    - `shimmer`: reverb plus octave
    - `mobius` (P2): a Shepard-tone sweep ⚠ (the A9 behaviour was not verified)
  - **FX quantize:** on/off starts and stops on the next beat division.
- **UI:**
  - The mixer gets an "FX" row under the crossfader in Perform layout: unit select, assign chips, the strip, the band toggles and on.
  - In Classic layout it lives in the advanced drawer.
  - The deck FX panel keeps channel FX.
- **MIDI:** controller plan names `fx1.on`, `fx1.select`, `fx1.param`, `fx1.time` and `fx2.*`, plus `fx.unit{N}.assign.deck{M}`. Add `fx1.assign.master`, `fx1.band.low/mid/high` (button), `fx1.strip` (abs, 0–1 maps to a division; release sends off), `fx1.quantize`.
- **Mobile:** one FX unit; the strip is a full-width bar in the mixer sheet; the band split is off on low-end devices.
- **Tests:**
  - FX on master: the dry path is unchanged within 0.1 dB when the FX is off
  - band split: with "High" only, 100 Hz content is unchanged (null ≤ −60 dB) while 8 kHz is processed
  - FX strip: the echo time equals the division × beat within 1 ms
  - quantised on: the onset lands on the beat ± 1 render quantum

### M10. Send/return (P2, M–L)
- **Reference:** DJM-V10 send/return: 4 built-in send FX, external units and apps, return to channel, master or own channel.
- **Sketch:**
  - Per channel `send` gain (post-fader) → `sendBus` → either:
    - **built-in send FX** (Short Delay, Long Delay, Dub Echo, Reverb, reusing existing nodes) → `returnGain` → master bus or a return channel strip, or
    - **external:** on desktop or web with a multichannel interface, `sendBus` → output channels 5/6 (or 7/8), with the return from `getUserMedia` input channels → `returnGain`. The DVS code already does multichannel capture and the cue code does multichannel output; both are reused.
  - Round-trip latency compensation is not possible for a parallel send, so document that it suits FX, not dry blending.
- **UI:** a SEND knob per strip (advanced only); a send/return block in the advanced drawer.
- **MIDI:** `mixerN.send` (abs), `master.returnLevel` (abs), `send.type.next` (button), `send.on` (button).
- **Mobile:** built-in send FX only.
- **Tests:** a send at 0 is bit-identical to no send; return routing (channel versus master) is checked by tone presence; reported external latency equals `baseLatency + outputLatency + input` ⚠, measured by loopback in e2e with a fake device.

### M11. One-knob channel compressor (P2, S)
- **Reference:** DJM-V10 per-channel compressor (amount only).
- **Sketch:**
  - A `DynamicsCompressor` after the trim. One knob maps to threshold 0 → −30 dB and ratio 1 → 4.
  - Auto make-up = half the static gain reduction at −14 LUFS programme ⚠ (to tune), 10 ms attack and 150 ms release.
  - At 0 it is bypassed by a cross-fade so it adds no latency.
  - CPU: one native compressor per channel.
- **UI:** small COMP knob under TRIM (advanced, or Club and Classic personalities on desktop).
- **MIDI:** `mixerN.comp` (abs).
- **Mobile:** available; hidden on phones.
- **Tests:**
  - at 0, null to dry ≤ −90 dB
  - at max, crest factor drops ≥ 4 dB on a drum loop
  - output loudness within ±1.5 LU of the input (make-up)

### M12. Master isolator (P1, S)
- **Reference:** DJM-V10 3-band master isolator; MP2015 isolator; Ecler WARM4 (300 Hz / 4 kHz, −∞ to +12 dB); rotary tradition.
- **Sketch:**
  - The `eq.js` isolator factory is inserted between `masterGain` and the limiter.
  - Knob law: −∞ to +6 dB (rotary: up to +12 dB, with the limiter as backstop). Crossovers 300 Hz / 4 kHz by default, adjustable.
  - Bypassed at noon by a cross-fade, so there is no phase change when unused.
  - CPU: about 34 biquads.
- **UI:**
  - Rotary personality: three big knobs at the top of the master section.
  - Other personalities: the advanced drawer.
- **MIDI:** `master.isoLow`, `master.isoMid`, `master.isoHigh` (abs, pickup), `master.isoOn` (button).
- **Mobile:** fine (one instance).
- **Tests:** noon is flat ±0.1 dB; each kill > 40 dB in band; bypass toggling is click-free; the limiter still holds −1 dBFS with +12 dB boosts.

### M13. Master section extras (P1 for limiter UI, P2 for others; S)
- **Reference:** standard club mixers; the brickwall limiter already exists.
- **Sketch:**
  - Expose limiter gain reduction (already posted by the worklet as `lim.gainReduction`) as an LED.
  - Limiter ceiling setting: −0.3 to −3 dBFS.
  - Master balance.
  - Mono master switch (club PA).
  - Optional "loudness boost" is out of scope; it fights the limiter. Keep the limiter as a safety device.
- **UI:** master section, with a GR LED next to the meters; balance and mono in the drawer.
- **MIDI:** `master.balance` (abs), `master.mono` (button), `master.limiter` (button).
- **Tests:** a GR reading of 0 below the ceiling; mono gives L = R within 0.01 dB; balance at an extreme gives the other side ≤ −80 dB.

### M14. Metering: RMS, LUFS, true peak and per band (P1, M)
- **Reference:** EBU Tech 3341 (M = 400 ms, S = 3 s, BS.1770-4) and true peak by 4× oversampling.
- **Sketch:**
  - A new `opendj-meter` worklet on `masterOut` (and optionally per channel) computes:
    - K-weighting (two biquads, implemented in the worklet)
    - momentary, short-term and integrated LUFS (gated)
    - true peak with a 4× polyphase FIR
    - RMS

    It posts results at 10 Hz. Reuse the BS.1770 constants already in `analysis-core.js` and `sampler.js`.
  - Per-band meters: the channel's isolator band outputs get cheap `AnalyserNode`s only while the advanced drawer is open.
  - CPU: about 0.2 % per meter instance at 48 kHz ⚠ estimate.
- **UI:**
  - Master meters get an RMS bar plus a peak dot.
  - A LUFS-S readout under the master knob in the advanced drawer, as a "Loudness" card with M, S, I, TP and GR.
  - Channel meters remain pre-fader peak, today's ballistics.
- **MIDI or LED state:** `master.lufs` and `master.truePeak` added to `buildStates` for controllers with VU LEDs (`scale: vu` in the controller plan).
- **Mobile:** master only.
- **Tests:**
  - the EBU Tech 3341 test signals (1 kHz sine at −23 dBFS → −23.0 ± 0.1 LUFS, stereo)
  - true peak of an inter-sample-over test file within ±0.3 dB of the reference
  - meters cost under 0.3 ms per tick (perf bench)

### M15. Record section (P2, S)
- **Reference:** DJM-A9 mic excluded from recording.
- **Sketch:** a `recBus` node composed of `masterBus` minus the mic, plus mic × `micToRecord`, then a record-level gain and its own limiter. `pcm-tap.js` can tap either `masterOut` (as today) or `recOut`, set by `recording.source: master | rec`.
- **UI:** a recording panel setting and a REC LEVEL knob in the drawer.
- **MIDI:** `record.level` (abs), `mic.toRecord`.
- **Tests:** with the mic excluded, a mic tone is ≤ −90 dB in the file and present in master; rec level ±12 dB ±0.1.

### M16. Warmth and saturation (P2, S)
- **Reference:** E&S DJR400 valve stage (bypassable); Xone:96 Crunch; Condesa discrete circuitry.
- **Sketch:**
  - `WaveShaper` with an asymmetric tanh curve, `oversample: '2x'`, on the master (and optionally per channel).
  - The drive is set so that −14 LUFS programme gets about 0.5–2 % THD with mostly 2nd-harmonic content ⚠ (subjective; to tune by ear).
  - The level is compensated. Bypass is a true cross-fade.
- **UI:** a "Warmth" knob, shown in the Rotary personality and in the drawer.
- **MIDI:** `master.warmth` (abs).
- **Mobile:** master-only, `oversample: 'none'` on low-end devices.
- **Tests:** at 0, null ≤ −90 dB; THD at a mid setting 1 ± 0.5 % on a 1 kHz −14 dBFS sine; H2 > H3; loudness change ≤ 0.5 LU.

### M17. Rotary-style controls (P1, M; part of the Rotary personality)
- **Reference:** Bozak, Condesa, E&S, MP2015 and Model 1 practice: rotary channel levels, wide isolators, gentle filters.
- **Sketch:**
  - Channel volume shown as a large rotary knob instead of a fader, with a −∞ to +6 dB audio taper (the `smooth` curve from M2 plus a headroom range) and the limiter as backstop.
  - Smoothing time 30 ms instead of 5 ms, for a "heavy knob" feel.
  - The crossfader is hidden by default (rotaries have none) but can be re-enabled.
  - Filters use `dual` mode (M4) with low Q.
  - Master isolator (M12) and warmth (M16) are shown.
  - EQ type isolator or sculpt.
  - The automix still drives `volume`, so no lane change is needed.
- **UI:** `mixer-ui.js` renders the strip variant from the personality. The 4-deck order (3 1 2 4) is kept.
- **MIDI:** unchanged (`mixerN.volume`), so controllers with faders still work.
- **Mobile:** big knobs are hard on phones, so rotary mode uses faders there and keeps the sound settings.
- **Tests:** taper table within 0.1 dB; knob-to-gain smoothing time constant 30 ms ± 5 ms; personality switch keeps levels within 0.5 dB at the current positions.

### M18. Advanced mixer drawer (P1, S–M)
- A collapsible panel under the mixer. Tabs:
  - **Channel:** EQ type, filter mode, comp, send, per-channel Color FX, cue B, fader reverse
  - **Master:** isolator, booth, limiter, warmth, balance and mono, record
  - **Mic:** EQ, FX, talkover, feedback
  - **Faders:** crossfader curve, cut-in, cut time, fader curve, center lock
  - **Loudness:** M14
- It is keyboard-accessible and closed by default. On phones it is a bottom sheet from the mixer header.
- Every control in it has a MIDI id and appears in Settings → Controllers.

---

## 5. Selectable mixer personalities (all optional)

A personality is a **named preset of the settings above**, not a separate engine. It changes curves, EQ and filter type, visible controls and defaults. It never changes levels abruptly, and anything can be overridden afterwards; the result shows as "Custom (based on Club)".

| Personality | EQ | Filter | Crossfader | Channel level | Master | Extras |
|---|---|---|---|---|---|---|
| **Club** (default; today's sound) | Isolator, LR8 at 200 Hz / 2.5 kHz | One-knob resonant + Color FX | constant power (curve 0.5), cut time 5 ms | fader, `log` | limiter | beat FX bus, meters |
| **Classic** (DJM-style full-kill EQ) | Classic shelving/peaking EQ with a kill option ⚠ (DJM "EQ" vs "Isolator" behaviour to verify) | One-knob + Color FX, Center Lock on | constant power | fader, `log` | limiter, booth shown | channel comp available |
| **Rotary** (Model 1 / Bozak feel) | Isolator 300 Hz / 4 kHz (WARM4-like) or Sculpt | `dual` HPF/LPF, low Q, no resonance | hidden | rotary knob, `smooth` taper, 30 ms smoothing | **master isolator**, warmth on (low) | Color FX hidden, FX bus collapsed |
| **Battle** (scratch) | Isolator | One-knob | curve 1, cut-in 2 %, **cut time 1 ms**, REV toggle visible | fader `cut`, reverse available | limiter | scratch view (T8), scratch samples pad mode (T9), platter Vinyl skin, light jog weight |

- **Switching:** `mixer.personality` in settings and `mixer.personality.next` in MIDI. EQ or filter type changes cross-fade (M3). UI changes animate. Switching is blocked while a crossfader cut is held, to avoid surprises mid-scratch.
- **Smart suggestion, never forced (in line with the automix plan §3 principles):**
  - When `automix/context.js` (automix P2) reports a profile with confidence of 0.7 or more, the mixer header shows a dismissible chip:
    - Rominimal or minimal profile: "Long blends ahead. Try the Rotary mixer?"
    - Hip-hop or turntablist content, or a scratch-controller mapping detected by the controller plan's auto-detection: "Battle mixer?"
    - Club house or techno: no chip, since Club is already active.
  - Rules:
    - one tap applies it; a second tap undoes it
    - "Don't suggest for this playlist" is remembered locally
    - no auto-switch
    - no suggestion while a deck is on air with its fader up, only between tracks
    - all inference stays on the device
  - Until automix P2 ships, personalities are manual only.
- **Tests:**
  - each personality maps to the exact settings table above (snapshot test)
  - switching with two decks playing gives no sample step above 1.05× clean, and level within 0.5 dB
  - the chip appears for the rominimal fixture playlist from the automix P2 fixtures, never auto-applies, and stays dismissed after a reload

---

## 6. Turntable and deck feature list

### T1. Vinyl physics model (P0, M)
- **Reference:**
  - SL-1200MK7: start torque and brake in 4 steps each, 0.7 s start-up.
  - PLX-CRSS12: torque High, Mid or Low and 3 stop speeds.
  - CDJ-3000: Vinyl Speed Adjust.
  - SC6000M: torque adjust and slip friction.
- **Sketch:** one `motor` model in `worklets.js`, replacing the ad-hoc branches:
  - **Motor torque** sets the start time `startTime`. The hook exists today (`case 'motor'`) but is unused. Model it as a torque-limited approach, `dv/dt = clamp(K·(target − v), ±τ/I)`, so a start from 0 to 1× takes `startTime`. The default stays 0 (CDJ-instant).
  - **Brake** time on pause/stop: reuse the existing friction-plus-drag model. Pause uses it when `stopTime > 0` (CDJ Vinyl Speed Adjust semantics).
  - **Release spin-up:** when the jog or touch is released, `curRate` is approached through the motor model, not snapped. The controller plan §4.7 item 4 asks for exactly this "release ramp", so build it once here and that plan reuses it.
  - **Platter inertia (coast):** when the deck is stopped (motor off) and the hand releases with velocity, the record coasts: `dv/dt = −(bA + bB·|v|)` with the friction set by `inertia`. While playing, the release velocity blends into the motor approach, so a throw forwards speeds up briefly.
  - **Slip-mat feel:**
    - `slipmat` from 0 (sticky; the platter follows the hand fully, today's behaviour) to 1 (slick: a still hand lets the record creep at `slipmat × 3 %` of motor speed, and spin-up after release is faster because the platter never stopped)
    - a deliberately simple 1-parameter model ⚠ to tune with DJs
  - **Spin-back amount:** `backspin(seconds, speed)` parameters become user settings (spin length 0.4–4 s and throw speed 2–8×), plus gesture-driven spinbacks from T10.
  - **Reverse play** honours the motor: switching REV ramps through 0 using start and stop times, like the MK7 reverse.
  - `quartz lock`: a toggle that pins tempo at 0 % regardless of the fader. It mirrors the old Technics pitch-lock role, which the MK7 does not need ⚠. It is UI-level only (ignore fader input while on).
  - Parameters live per deck with a global default: `deck.motor = {startTime, stopTime, inertia, slipmat, spinTime, spinSpeed}` posted to the worklet. The settings schema gains `vinyl.*`.
  - CPU: negligible (per-sample scalar maths, as today).
- **UI:**
  - Deck panel "Key" becomes "Key & Platter" ⚠ naming, or a new "Platter" tab with START, STOP, WEIGHT (T3), SLIPMAT, SPIN, 33/45/78 (T4) and QUARTZ.
  - The VINYL button stays on the deck face.
  - The Battle personality presets these.
- **MIDI:** `deckN.vinylMode` (button, LED; missing today), `deckN.motorStart`, `deckN.motorStop` (abs, mapped 0–3 s), `deckN.slipmat` (abs), `deckN.brake` (button; missing today), `deckN.backspin` (button), `deckN.startStop` (button: motor start/stop with ramps, distinct from `play`), `deckN.quartz` (button).
- **Mobile:** same model. Defaults: startTime 0, stopTime 0 (CDJ behaviour), so nothing changes unless the user opts in.
- **Tests (Node, `test/fx-dsp.test.js` pattern):**
  - startTime 0.7 s gives 1× ± 1 % at 0.70 ± 0.02 s, monotonic
  - stopTime 1.2 s gives 0 at 1.2 ± 0.03 s (the existing brake test, extended to pause)
  - release from scratch at 0 velocity with startTime 0.3 s reaches 99 % of the play rate at 0.3 ± 0.02 s, with no sample step above 1.05× clean
  - inertia: a stopped deck released at 2× coasts and stops within the configured time ± 5 %
  - with startTime 0, behaviour is bit-identical to today (regression)
  - REV with ramps passes through 0 without a click

### T2. Jog modes and jog weight (P0, S)
- **Reference:** CDJ-3000 Jog Mode (Vinyl or CDJ) and Jog Adjust; VirtualDJ Vinyl or CD mode.
- **Sketch:**
  - `vinylMode` exists. Add `jogWeight` from 0 (light) to 1 (heavy).
  - In velocity mode it scales the worklet's hand-smoothing coefficient: 0.02 per sample today, giving 0.06 (light) to 0.005 (heavy).
  - In the controller plan's position mode it scales the alpha-beta filter's α and β within limits that still pass that plan's < 5 ms RMS test.
  - Add CDJ "touch release" ⚠: in CDJ mode, a touch of the top surface while paused does a temporary stop and play.
- **UI:** WEIGHT knob in the Platter tab.
- **MIDI:** `deckN.jogWeight` (abs).
- **Tests:** heavy versus light gives a step-response 10–90 % time ratio of at least 5×; the controller plan's baby-scratch test passes at weights 0, 0.5 and 1.

### T3. Scratch quality for touch and mouse (P0/P1, M; coordinated with controller plan §4.7)
- **Do not duplicate:** the position-following worklet (alpha-beta filter or PLL), `ticksPerRev`, MIDI timestamps and the baby-scratch acceptance test belong to the controller plan, Phase 3.
- **Add here:**
  - `controls.js` `jogWheel` and `waveform.js` drag-scratch feed the **same position API** (`deck.jogPosition(targetAngle, t)`). Pointer angle is unwrapped across ±π.
  - `e.timeStamp` replaces `performance.now()`. `getCoalescedEvents()` samples are used where available.
  - Touch-down counts as "hand on record" (motor decouples). Touch-up uses T1 release.
  - 33⅓ maps to 1.8 s per revolution, 45 to 1.333 s (T4).
  - The waveform drag uses pixels per second from the zoom level.
- **Ordering:** if the controller plan's Phase 3 has not landed, implement its worklet part (position-follow filter) in this phase and let the controller plan consume it. Agree the message shape `{type: 'scratchPos', pos, t}` in both docs.
- **UI:** unchanged.
- **MIDI:** none new.
- **Tests:**
  - a synthetic pointer stream (baby scratch at 2 Hz, ±90°, 60 Hz events with jitter of ±4 ms) keeps playhead error < 8 ms RMS ⚠ (looser than MIDI because of frame-rate input)
  - coalesced events at 240 Hz give < 5 ms RMS
  - no direction flips beyond the input's

### T4. 33 / 45 / 78 RPM and the scratch scale (P1, S)
- **Reference:** SL-1200MK7 (33/45/78); Twelve MKII ⚠; DVS already has 33/45 per deck.
- **Sketch:**
  - `deck.rpm ∈ {33.33, 45, 78}` sets the seconds per revolution (1.8 / 1.333 / 0.769) for the platter visual rotation and the touch/MIDI scratch scale. With MIDI, the jog profile's `rpm` field from the controller plan wins when present.
  - This is not playback speed. A real deck at 45 rpm plays a 33 record fast, but that would be confusing digitally, so it is documented clearly.
  - An optional "Speed mode" (P2) makes 33→45 a +35 % tempo jump with the motor ramp, as a performance trick.
- **UI:** 33 / 45 / 78 chips in the Platter tab; the platter shows the RPM.
- **MIDI:** `deckN.rpm33`, `deckN.rpm45`, `deckN.rpm78` (button, LED).
- **Tests:** one full touch rotation at 45 moves 1.333 s ± 1 %; the visual angle equals pos / spr × 2π.

### T5. Pitch, bend and tempo glide (P1, S–M)
- **Reference:** ±8/16/50 (RP-8000), ±8/16 (MK7), CDJ ranges; CDJ jog-ring bend; the requested "tempo ramp".
- **Sketch:**
  - Ranges exist.
  - **Ramped bend:** holding ± bends progressively (from 1 % up to 8 % over 1 s) instead of today's fixed ±4 %.
  - **Fine step** setting: 0.02, 0.05 or 0.5 %.
  - **Tempo glide:** "reset to 0 %" or "go to the master BPM" over N beats (1–64), using automix P1's worklet `rateRamp` (sample-accurate) once available. Before then, use a main-thread ramp at 25 ms ticks as a fallback.
  - **Quartz** is in T1.
- **UI:** RESET long-press opens a glide menu (1, 4, 16 or 64 beats). Bend buttons keep their position.
- **MIDI:** `deckN.tempoGlideReset`, `deckN.tempoGlideSync` (button), `deckN.tempoRange.next` (button; missing today), `deckN.bendUp/Down` (exist; behaviour gains the ramp, with a setting to restore today's).
- **Tests:** glide over 16 beats ends at the target ± 0.01 % at beat 16 ± 5 ms; tempo is monotonic; key lock stays click-free (the existing QA M1 test pattern).

### T6. Needle drop (P1, S)
- **Reference:** vinyl needle drop; DVS ABS; Twelve MKII strip search; controller plan `deckN.needle`.
- **Sketch:**
  - Overview click-to-seek exists. Add:
    - (a) an optional quantise for needle drops (snap to beat or bar when quantize is on)
    - (b) "Needle lock while playing" (default off on desktop, on for phones), which prevents accidental jumps on air: a long-press is required
    - (c) dragging the **tonearm** in the Vinyl skin (T7) to drop, with a cue-preview "groove" sound while dragging (P2)
    - (d) the controller plan's `deckN.needle` abs target shares this code path
- **UI:** overview waveform, tonearm, and a lock toggle in the Platter tab.
- **MIDI:** `deckN.needle` (from the controller plan), `deckN.needleLock` (button).
- **Tests:** a quantised drop lands within ±1 ms of the grid; lock blocks a short tap and allows a 400 ms press.

### T7. Platter visual skins (P1, M)
- **Reference:** vinyl with label art; Technics strobe dots; tonearm progress; SC6000 and CDJ-3000 jog displays (artwork, position, loop).
- **Sketch:** split `jogWheel` drawing into `ui/platter-skins.js`, keeping the cached-body plus moving-parts approach and frame skipping. Skins:
  - **Vinyl:**
    - The rotating label shows the track's cover (`api.coverUrl`), clipped to a circle and cached as an `ImageBitmap`.
    - Grooves are optionally drawn from the waveform's energy, so quiet passages look like wider-spaced grooves. This answers the djay community request ⚠ (optional).
    - Strobe dots: two rings, for 33 and 45. Each dot row is drawn at angle `θ = (actualSpeed − nominalSpeed × (1 + rowPct)) × t`, so the row matching the current pitch appears to stand still, like a strobe. Rows sit at 0 and ±3.3 % ⚠ (Technics row values to verify).
    - The tonearm angle maps track progress from the outer to the inner groove. It is draggable for T6.
  - **CDJ display:**
    - centre artwork
    - track position ring (as today)
    - **slip ghost ring** showing the shadow position when slip is engaged (the worklet already knows `shadow`; expose it through the existing position messages)
    - loop arc, hot-cue ticks on the ring, touch indicator, BPM, and time remaining
  - **Minimal:** today's look.
  - All skins honour `prefers-reduced-motion` (rotation becomes a progress-only indicator) and themes (`cssVar`).
  - A **mini platter** for 4-deck layout (P2): today it is hidden. Show a 64 px CDJ-skin indicator with touch scratch when space allows.
- **UI:** a skin selector in Settings → Decks, with Battle defaulting to Vinyl and Club to CDJ display.
- **MIDI:** none.
- **Mobile:** artwork decode is cached. Frame budget is 1 ms per platter per frame on the e2e Pixel 7 profile with 4× throttling (existing perf suite).
- **Tests:**
  - visual snapshot per skin (`scripts/e2e-ui-sweep.mjs`)
  - the strobe row at 0 % is stationary (angle change below 0.5° over 1 s at 0 % pitch; moving at +1 %)
  - tonearm angle is linear in progress
  - ui-bench draw time is ≤ 1 ms per platter

### T8. Touch, multitouch and haptics (P1, M)
- **Reference:** phone-first decks; controller transforms (platter plus crossfader).
- **Sketch:**
  - **Per-pointer tracking** in `jogWheel`: a Map of `pointerId` to state.
    - first finger on the platter scratches
    - **a second finger anywhere on the same platter = "hand holding the record"** (velocity 0 hold, like pressing a finger on vinyl), released when it lifts
    - a two-finger rotation gesture is an alternative scratch on small screens
  - Separate elements (crossfader, upfaders) already capture their own pointers, so **transform and flare** (platter finger plus crossfader finger) work today; verify on iOS and Android.
  - **Scratch view (phones):** a full-screen deck with a big platter, a vertical crossfader strip on the thumb side (left or right handed), a cut button ("transformer button": momentary gate of the deck channel through the M1 fast-cut ramp), and scratch-sample pads (T9). It opens from a deck-header button or a landscape double-tap.
  - **Haptics** (`@capacitor/haptics`, a new dependency):
    - `selectionChanged()` every 1/16 rotation while scratching, throttled to 40 Hz
    - `impact({style: 'light'})` when the playhead crosses a hot cue or a beat while touching, and when the crossfader reaches a cut edge
    - `impact('medium')` on downbeats in the scratch view (optional metronome feel)
    - all of it controlled by a setting with Off, Subtle and Full levels, default Subtle on phones
    - web fallback `navigator.vibrate(5)` where supported, nothing on iOS web
    - wrapped in `platform.js` so desktop is a no-op
  - **Latency notice:** show measured touch-to-sound latency (`baseLatency + outputLatency` plus an input estimate) in the scratch view, with the same "use wired audio" hint the controller plan gives for BLE.
- **UI:** the scratch-view button on the deck header (phones and tablets); a haptics setting.
- **MIDI:** none.
- **Mobile:** this feature is mainly for mobile. iPad split view is supported.
- **Tests:**
  - e2e (`e2e-mobile.mjs`) synthesises two pointers: platter scratch and crossfader taps at 8 Hz (transformer). The audio gate pattern in the PCM tap matches the tap times within one render quantum plus the cut time.
  - The second finger holds: deck velocity is 0 ± 0.01 while held.
  - The haptics mock receives ≤ 40 calls per second.
  - No haptics are issued when the setting is Off.

### T9. Scratch samples bank (P2, M)
- **Reference:** Serato Scratch Bank, a pad mode that swaps the deck to a scratch sample.
- **Sketch:**
  - A new pad mode `scratch` with 4–8 slots. Pressing a slot:
    1. snapshots the deck state, using the `cloneFrom` fields (track, position, tempo, loop, stems)
    2. loads the sample buffer into the same deck worklet via the existing `load` message (samples are short, under 15 s, so they decode quickly)
    3. leaves the platter, crossfader and FX behaving normally
  - A second press, or "return", reloads the track at the shadow position (playing time continues if slip was on).
  - Slots hold user samples or built-in ones.
  - **Built-in sounds must be bundle-safe** (`RESOURCES_AND_LICENSING.md` §0.5): use the Sonic Pi CC0 `vinyl_scratch` and similar files, or OpenDJ-synthesised sounds (a sine "ahh" vowel via formant filters; tone bursts). **Do not bundle the classic "ahh" or "fresh" samples**: they come from copyrighted records (⚠ provenance not researched here; assume uncleared).
  - Credits go into `public/samples/CREDITS.json`.
- **UI:** a SCRATCH pad mode in the deck Cues panel and in the scratch view (T8); load a user sample by dropping a file on a slot.
- **MIDI:** `deckN.padMode.scratch` (button), `deckN.scratchSlot{1-8}` (button), `deckN.scratchReturn` (button). This is compatible with the controller plan's `deckN.padMode.*` family.
- **Mobile:** works offline with bundled CC0 sounds.
- **Tests:** after return, track position equals the snapshot (or shadow) ± 5 ms; tempo, key and loop are restored exactly; CREDITS.json lists every bundled file with an SPDX licence (CI check).

### T10. Gesture spinback, brake and platter FX (P1, S)
- **Reference:** real vinyl backspins; Engine OS vinyl stop settings ⚠.
- **Sketch:**
  - On a touch or jog release with backward velocity below −3× while playing, trigger `backspin` with speed equal to the release velocity and time from the T1 settings.
  - A flick forwards when stopped coasts (T1 inertia).
  - **Brake on stop** honours `stopTime`.
  - Deck FX pads ("Brake", "Tape Stop", "Backspin") use the user's amounts instead of the fixed 1.2 s, 3 s and 1 s.
  - Slip variants (P2): **slip brake** and **slip spinback** resume at the shadow position afterwards (slip plus brake: the worklet already has `shadow`).
- **UI:** a "Flick to spin back" setting; amounts in the Platter tab.
- **MIDI:** `deckN.backspin`, `deckN.brake` (from T1), `deckN.slipBrake` (button).
- **Tests:** a release at −5× triggers a backspin with initial speed 5 ± 0.2×; slip brake resumes at the shadow ± 5 ms.

### T11. CDJ-3000 and SC6000 deck features still missing (P1–P2, S–M each)
| Feature | Reference | Sketch | MIDI | Pri |
|---|---|---|---|---|
| **Active Loop** | CDJ-3000 manual "Using Active Loop" | A memory loop flagged `active` auto-engages when the playhead reaches its start (worklet `loopAt` from automix P1, or a main-thread check with look-ahead). Stored in the cue model (`shared/cues.js`) | `deckN.activeLoop` (button: flag the current loop) | P1 |
| **Quantize divisions** | CDJ quantize beat value ⚠ | `deck.quantize` becomes `{on, div: 1/8 to 1 bar}`; `snap()` uses the division | `deckN.quantizeDiv.next` | P1 |
| **Beat jump sizes** | CDJ ½–64, Shift pages | The UI cycles 1–32 today; add ½ and 64 to match MIDI, and the controller plan's `deckN.jumpSize.up/down` | (controller plan) | P1 |
| **Loop in/out adjust with jog** | CDJ-3000 manual | While IN or OUT is held, the jog moves that point (snaps when quantised) | `deckN.loopInAdjust`, `deckN.loopOutAdjust` (button modifiers) | P2 |
| **Platter Play** | RP-8000 MK2 | A variant of PITCH pad mode with key lock off and rate steps (pads play semitone rates through the motor), plus scale presets | `deckN.padMode.platterPlay` | P2 |
| **Hard deck lock** | — | Option: a playing deck refuses loads entirely (today it asks) | `deckN.lock` (button) | P2 |
| **Slip reverse** | CDJ / Serato | Exists as censor; add a latching variant | (exists `deckN.censor`) | — |
| **Reverse with motor** | MK7 | T1 | `deckN.reverse` (exists) | P0 via T1 |
| **Tempo ramp / glide** | requested | T5 | — | P1 |
| **Key shift / Key Sync, Beat Sync vs master tempo, rolls, censor, instant doubles, slicer, Pitch Play, stems** | CDJ, Serato, rekordbox | **Already exist** (§2.2) | — | — |

---

## 7. Phased roadmap

### Phase A: quick wins (S–M, about 2–3 weeks), no routing changes
- **Scope:**
  - M1 crossfader v2 (curve, hamster, cut-in, fast cut)
  - M2 fader curves
  - M4 Center Lock
  - T1 motor start/stop wiring the existing worklet hook (start, stop, release spin-up, user brake and spinback amounts)
  - T2 jog weight
  - T4 RPM
  - missing MIDI targets (`deckN.vinylMode/brake/backspin/tempoRange.next/rpm*`, `mixer.xfCurve/xfReverse`)
- **Files:**
  - new `public/js/audio/curves.js`
  - changed: `audio/engine.js` (`applyCrossfader`, `setXfGain`, `apply`), `audio/worklets.js` (motor model), `audio/deck.js` (motor params, rpm), `ui/mixer-ui.js`, `ui/deck-ui.js`, `ui/controls.js`, `midi/midi.js` (`buildTargets`), `shared/settings-schema.js` (with migration), `test/fx-dsp.test.js`, `scripts/e2e-fx.mjs`
- **Dependencies:** none. Fast-cut scheduling at MIDI timestamps improves after controller plan Phase 0.
- **Risks:** settings migration; changing `setXfGain` timing could affect automix fades, so automix uses the 5 ms default and is covered by `test/automix.test.js`.

### Phase B: vinyl feel and touch (M–L, about 4–6 weeks)
- **Scope:**
  - T1 inertia, slipmat and reverse ramps
  - T3 touch/mouse position API
  - T10 gesture spinback
  - T8 multitouch, scratch view and haptics
  - T7 platter skins (Vinyl, CDJ, Minimal)
  - T6 needle lock and quantise
- **Files:**
  - new `ui/platter-skins.js`, `ui/scratch-view.js`, `local/haptics.js` (or `platform.js` helper)
  - changed `ui/controls.js`, `ui/waveform.js`, `audio/worklets.js`, `audio/deck.js`, `css/app.css`, `css/mobile.css`, `package.json` (add `@capacitor/haptics`), `docs/MOBILE.md`, `scripts/e2e-mobile.mjs`, `scripts/perf/ui-bench.mjs`
- **Dependencies:** controller plan Phase 3 position-follow worklet. Whichever phase starts first builds it; agree the message API.
- **Risks:**
  - iOS WebKit pointer coalescing ⚠
  - touch latency on Android WebViews (show the latency notice)
  - artwork decode memory with 4 decks (cap at 512 px)

### Phase C: mixer depth (L, about 5–8 weeks)
- **Scope:**
  - M3 EQ types (Classic and 4-band first)
  - M4 dual filter
  - M12 master isolator
  - M14 meters
  - M8 mic v2 (EQ, FX, auto and advanced talkover)
  - M6 booth output
  - M7 cue extras
  - M13 master extras
  - M18 drawer
- **Files:**
  - new `audio/eq.js`, `audio/meter-worklet.js` (or added to `fx-worklets.js`), `ui/mixer-advanced.js`
  - changed `audio/engine.js` (Channel EQ factory, master chain, booth and output routing, mic), `audio/effects.js`, `ui/mixer-ui.js`, `midi/midi.js`, `shared/settings-schema.js`, `recording/pcm-tap.js` (unchanged tap point, verified), `scripts/e2e-fx.mjs`
- **Dependencies:** automix P1 (`Channel.automate`) must target logical bands, not nodes. Coordinate so EQ types do not break lanes.
- **Risks:**
  - CPU on phones: biquad counts grow (4 channels × 50 plus a master of 34). Mitigate with lazy creation, cross-fade bypass, LR4 fallback, and the perf suite gate (two decks plus analysis on the Pixel 7 profile with 4× throttle must not drop UI frames below today's baseline).
  - Multichannel output support varies by OS and browser ⚠; Capacitor `setSinkId` ⚠.

### Phase D: personalities and smart suggestion (S–M, about 2 weeks)
- **Scope:** §5 presets, M17 rotary controls, M16 warmth, and the suggestion chip.
- **Files:** new `audio/personalities.js` (data), `ui/mixer-ui.js` strip variants, a hook in `automix/context.js` consumers.
- **Dependencies:** Phase C. Automix P2 for suggestions (manual personalities ship without it).
- **Risks:** users confused by moving controls, so keep Club as default and allow "Custom".

### Phase E: FX and decks (M–L, about 4–6 weeks)
- **Scope:**
  - M9 FX bus, FX frequency, FX strip and new effects
  - M5 new Color FX
  - T5 tempo glide
  - T11 Active Loop, quantize divisions and beat jump sizes
  - T9 scratch samples
- **Files:**
  - changed `audio/effects.js`, `audio/fx-worklets.js` (pitch shift), `audio/engine.js` (FX units), `audio/deck.js`, `shared/cues.js`, `ui/deck-ui.js`, `ui/mixer-ui.js`, `midi/midi.js`
  - new `public/samples/scratch/*` plus `CREDITS.json` entries
- **Dependencies:**
  - controller plan §4.9 `fx1/fx2` target names (map onto the FX bus)
  - automix P1 `rateRamp` / `loopAt` for sample-accurate glide and Active Loop (fallbacks exist)
  - licensing doc §3.1 for samples
- **Risks:** trademark wording (§7.1); pitch-shift CPU on mobile.

### Phase F: pro routing (L, about 4–8 weeks, desktop-first)
- **Scope:** M10 send/return (built-in, then external), M7 dual headphones, M11 compressor, M15 record section, M8 feedback reducer, VCF units (M4), Platter Play and hard deck lock (T11), mini platter in 4-deck view (T7).
- **Dependencies:** Phase C output-routing code; DVS multichannel input code for returns.
- **Risks:** device matrix testing needs real interfaces; latency of external returns.

### 7.1 Cross-cutting risks
| Risk | Mitigation |
|---|---|
| **Trademarks** (Magvel, Sound Color FX, X-Pad, Scratch Bank, DJM, Model 1, Xone) | Use generic UI names: "Color FX" (already used), "FX strip", "scratch samples", "fast-cut fader", "Rotary". Name products only in docs and references (nominative use), the same rule as the controller plan §9 risks |
| **Breaking settings and MIDI maps** | Never rename ids; migrate `crossfaderCurve`; v1 MIDI maps keep working (controller plan golden replay) |
| **Automix interaction** | Automix writes logical controls (`volume`, `eqLow`, `filter`). Personalities and EQ types translate them. The automix test suite runs once per EQ type and personality |
| **Click-free guarantee** | Every new switch uses the existing fade patterns. The e2e max-step check applies to every new toggle |
| **CPU / battery on phones** | Lazy graphs, device-class budgets, perf gate in CI |
| **Over-complex UI** | Club default unchanged; advanced drawer closed by default; personalities hide what they do not use |

---

## 8. Unverified items (to confirm)

1. Pioneer product and manual pages could not be fetched (DNS blocked). Confirm against the DJM-A9, V10, 900NXS2, S11 and CDJ-3000 manuals:
   - the A9 dual-headphone details and Mic FX list (Echo, Pitch, Megaphone plus Reverb; sources differ)
   - whether the A9 or 900NXS2 has an EQ/Isolator curve selector
   - the existence and behaviour of an "advanced" talkover mode
   - V10 4-band EQ frequencies and ranges, master isolator crossovers and booth EQ bands
   - S11 cut-lag menu values
   - CDJ-3000 touch-release and quantize-division options
   - 900NXS2 Beat FX list (the list above is from the 750MK2 page)
2. The DJM "Mobius" behaviour (assumed to be a Shepard-tone style sweep) and the exact "Sweep" Color FX algorithm.
3. Technics strobe-dot row percentages; whether the MK7 or M7L has any quartz-lock function.
4. Twelve MKII 33/45 platter speeds (from a Q&A page only); SC6000 Engine OS vinyl stop/start time settings and tempo ramp (not found in the guide excerpts).
5. MP2015 EQ slope (12 or 24 dB/oct; sources disagree); Model 1 original per-channel frequency ranges (the 70 Hz–7 kHz figure is for the Model 1.4).
6. djay turntable-view details (no official description found).
7. Platform:
   - `getCoalescedEvents()` on iOS WebKit
   - `navigator.vibrate` support matrix
   - `setSinkId` and more than 2 output channels in Capacitor WebViews and Safari
   - Android USB interface channel counts reported to the WebView
8. Provenance and licence of classic scratch phrases ("ahh", "fresh"). Assumed uncleared; never bundle.
9. All CPU figures (pitch shift about 0.3 % per channel, meter about 0.2 %) are estimates. Measure with `scripts/perf/ui-bench.mjs` and an audio-thread load probe.
10. Haptic feel values (rates, styles) and slip-mat and inertia parameters need tuning with real DJs.

---

## 9. Mixer half: implementation notes (0.5)

### 9.1 EQ presets (M3, user request "resemble the real deal")

Each preset is in `public/js/audio/eq.js` (`EQ_PRESETS`). Generic names only. The frequency response of every preset is measured in `scripts/fx/mixer-checks.mjs`.

| Preset (UI) | Reference behaviour | Band type | Frequencies | Range and knob law | Character |
|---|---|---|---|---|---|
| Isolator (default) | club 4-channel mixers in isolator mode | LR8 isolator, bands sum to an all-pass | 200 Hz / 2.5 kHz | +6 dB … -26 dB at 8 o'clock, then a full kill | clean |
| Club Classic | 900-class club EQ ⚠ (spec sheets list +6 / -26 dB at 70 Hz / 1 kHz / 13 kHz) | low shelf, peak (Q 0.7), high shelf | 70 Hz / 1 kHz / 13 kHz | +6 / -26 dB at 8 o'clock; the last tenth of the travel slides into a kill (shelves -50 dB, corners glide to 180 Hz / 5 kHz) | overlapping analogue-style bands |
| 4-Band | flagship 6-channel mixer ⚠ (frequencies not verified) | LR8 isolator, 4 bands | 150 Hz / 1 kHz / 5 kHz | Hi and Low +6 / kill; Mid-Hi and Mid-Lo +6 / -26 dB | clean |
| Rotary | boutique rotary and 4th-order isolator mixers ⚠ (+12 / -inf) | LR4 isolator (24 dB/oct) | 300 Hz / 4 kHz | +12 dB … -inf, long log taper (kill from 10 o'clock) | gentle tanh colour |
| Battle | scratch mixers | LR8 isolator | 250 Hz / 3 kHz | +6 dB; steep kill, silent from 9 o'clock | clean |
| Vintage Warm | classic analogue EQ | low shelf, peak (Q 0.5), high shelf | 100 Hz / 800 Hz / 8 kHz | +10 / -20 dB, kill at the end | mild tanh colour |
| Sculpt | one-band sweep EQ with HP / LP ⚠ (70 Hz – 7 kHz on the 1.4 model) | HP + peak (Q 0.35) + LP | peak 70 Hz – 7 kHz (FREQ) | +8 / -20 dB; LOW left sweeps the HP up to 400 Hz (bass kill), HIGH left sweeps the LP down | clean |

Measured (offline render, `e2e-fx`): every preset is flat at noon within 0.02 dB and the automix bass swap (LOW at -1) removes 43–97 dB at 60 Hz. The shelving presets match their RBJ target curves within 0.01–0.03 dB. The centre detent is the knob's existing 2 % detent for every preset.

Personalities pick a preset: Club → Isolator, Classic → Club Classic, Rotary → Rotary, Battle → Battle. Personalities change behaviour and which controls are shown; they keep OpenDJ's own look.

### 9.2 Deviations from the plan text

- **Smooth crossfader (curve 0.5)** is kept identical to today's "Smooth": each side follows the √2·cos (constant-power) law, normalised to unity at the centre. It is not a strict |A|² + |B|² = 1 sum, because changing it would change Club's sound.
- **Legacy "Scratch"** migrates to curve 0.9 with no cut-in, which gives identical gains. Curve 1 with cut-in 2 % is the Battle setting.
- **Classic EQ** uses a kill on the last tenth of the knob, so the automix bass swap still removes more than 30 dB.
- **Compressor** has a 2 ms look-ahead, so the drum transients are caught (crest -5.4 dB, loudness +0.2 LU at -14 LUFS). Until it is first turned up it is not in the path. When it first engages, the look-ahead glides in over 300 ms, so there is no comb filter and no click.
- **Warmth** adds only the 2nd and 3rd harmonics (polynomial, no oversampling, no latency), so at 0 the output is the input exactly.
- **Pitch shift** (Color FX, Spiral, Shimmer, mic pitch) is a two-tap delay-line shifter (`opendj-pitch`), not the deck's WSOLA.
- **Booth EQ** shelves sit at 150 Hz and 5 kHz, so the full ±12 dB arrives by 50 Hz and 12 kHz.
- **Null tests across offline renders** have a floor of about 4e-4 (-68 dBFS) in Chromium. Even two identical channels in one render differ by that much at random. Where a null cannot be done inside a single deterministic path, the checks allow that floor.

### 9.3 Not done (mixer half)

- **VCF units (M4, P2):** an LFO-driven filter.
- **Per-preset centre-detent widths.**
- **Mobius beat FX (P2):** its behaviour is unverified.
- **Triplet Roll:** it needs deck rolls.
- **External send/return** (send on extra outputs, return from an input device): left out, because it could not be verified end to end in this pass. Built-in send FX with return to the master or a channel ship.
- **Look-alike mixer skins:** left out by the owner's decision. Features live in OpenDJ's own layout.
- **The suggestion chip** reads the automix queue's genre tags. This stands in until `automix/context.js` (automix P2) exists.

### 9.4 Voice bus (for the MC / text-to-speech voice)

```js
const v = engine.voiceInput();         // GainNode: connect any AudioNode to it
```

The voice joins the **mic bus**, so it goes everywhere the mic does:
- the master: after the master isolator and warmth, before the master volume and limiter
- the booth, when "mic in booth" is on
- the recording, unless "mic in recording" is off (`engine.recTap` is the record tap that `recording/pcm-tap.js` reads)
- auto talkover, which it triggers (`talkoverMode` `auto` / `advanced`)

Manual ducking is `engine.setTalkover(true)`.
