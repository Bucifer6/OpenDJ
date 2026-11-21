# OpenDJ controller and hardware support plan

*Status: plan only, no code. Researched 2026-11-21. Files in this repo are cited as relative paths. Anything not confirmed is marked **(unverified)** and also listed in §11.*

## 1. Summary

### Today
OpenDJ already has unusually broad generic controller support, all in `public/js/midi/`:
- **Web MIDI**, with MIDI Learn that:
  - detects 14-bit MSB/LSB pairs automatically
  - decodes relative encoders (two's complement, offset-64, wrap, auto-detect)
  - nudges absolute targets from endless encoders
- **LED feedback**: automatic note-on 127/0 echoes, or explicit Mixxx-style `outputs`.
- **MIDI clock out** at 24 ppqn, phase-locked to the master deck.
- **Generic WebHID** "learn-by-diff", which classifies bits, counters, deltas and 8/16-bit absolute values (`hid.js`).
- **Gamepads** (`gamepad.js`).
- **Mixxx `.midi.xml` import**, fetched at runtime from GitHub only when the user asks, with heuristics for `<script-binding>` functions and LED outputs (`mixxx.js`, `mixxx-online.js`).
- **A guided setup wizard** (`wizard.js`).
- **An unmapped-device prompt**: "New controller: Find mapping / Guided setup / Don't ask again" (`MidiManager.offerMapping`).
- About 300 targets across 4 decks, the mixer, stems, sampler, slicer, key, beat-jump, pad modes, mic, sequencer, automix, record, Link and lyrics (`buildTargets`).
- An e2e test that stubs Web MIDI ports, imports a Mixxx mapping, drives decks and checks LEDs, the wizard and HID learn (`scripts/e2e-controllers.mjs`), plus unit tests in `test/controllers.test.js`.

**Desktop audio** already has three headphone-cue modes (`public/js/audio/engine.js` `applyOutputs`):
- `split`: mono master on the left, mono cue on the right
- `channels34`: 4-channel discrete output when `ctx.destination.maxChannelCount >= 4`
- a second output device via `setSinkId`

So a controller's built-in 4-channel sound card is partly supported already.

### Gaps
1. **Only one bundled preset.** "Pioneer DDJ-400 / DDJ-FLX4 (best-effort)" is in `presets.js`, alongside a generic 2-deck layout. `docs/GAP_ANALYSIS.md` rates "official plug-and-play mappings" ◐. The provenance of the DDJ-400 preset should be confirmed: if it was transcribed from Mixxx's GPL mapping, it must be rewritten (§3.2).
2. **No SysEx.** `requestMIDIAccess({ sysex: false })`, even though Electron already grants `midiSysex` (`electron/main.js`). Without SysEx, OpenDJ cannot:
   - send the DDJ-FLX4 keep-alive
   - ask inMusic (Numark/Denon) units to dump control positions
   - take a Mixtrack out of demo mode
   - send RGB pad colours on Launchpad/Push
   - send a Universal Identity Request
3. **Mapping format v1 is flat.** `{key, target, invert, rel, lsbKey, noLed}` has:
   - no conditions or layers. Shift is one global `app.shift`, and only a few handlers check it.
   - no deck banks (4 decks on a 2-deck controller)
   - no soft takeover
   - no colour or velocity palettes
   - no init/keep-alive sequences
   - no per-device jog profile (jog resolution is hard-coded at about 720 ticks per revolution)
   - no display hooks
4. **Scratch feel.** `deck.jogScratch` derives velocity from wall-clock `performance.now()` deltas between messages and ignores the Web MIDI `event.timeStamp`. It sends a velocity to the worklet, with a 40 ms idle reset. Message batching and jitter make this rough, especially over BLE.
5. **Mobile has no controllers at all.**
   - `platform.js` hides MIDI ("WKWebView and the Android WebView have no Web MIDI").
   - That is true for iOS.
   - For Android, MDN's compat data marks `webview_android` as mirroring Chrome for `requestMIDIAccess`, so it may work behind a permission. This needs a spike (§5.2).
6. **Mixxx HID mappings can't be imported.** Mixxx ships 18 `.hid.xml` mappings, including NI S2 MK3, S3, S4 MK3, Z1 and F1, and Pioneer CDJ HID. All are script-driven, so the converter only handles `.midi.xml`. HID controllers need hand-learning today.
7. **No mapping editor beyond Learn.** There is no layer, colour or takeover editing, no record/replay test fixtures, and no community submission path.
8. **Missing hardware integrations:** Pro DJ Link status, pad grids (Launchpad/Push), Stream Deck, OSC input (OSC is output-only, for lighting) and BLE MIDI on desktop.

### Target
"Plug in a top-25 controller and it just works", on desktop, the web app and both phone apps, with:
- first-party MIT/CC0 mappings
- correct LEDs
- soft takeover
- proper scratching
- 4-deck banks
- stems and sampler pads
- the controller's sound card picked automatically

Plus a community pipeline that turns a captured MIDI log and a JSON file into a tested mapping.

### Top recommendations (in order)
1. **Mapping format v2 and runtime** (§4.1), with SysEx enabled, MIDI timestamps, soft takeover and device identity. This unlocks everything else. v1 mappings load unchanged.
2. **Record/replay test harness and "virtual controller" fixtures** (§4.6), so mappings can be reviewed and regression-tested without hardware.
3. **First-party bundled mappings for the top ~15 controllers**, written from manufacturer charts where they exist and device captures where they don't. Ship them under CC0 (data) or MIT, starting with DDJ-FLX4/400, DDJ-200, DDJ-FLX2, Mixtrack Platinum FX / Pro FX, Inpulse 200/300/500, DJControl Mix and Party Mix.
4. **Native Capacitor MIDI bridge** with a `navigator.requestMIDIAccess` polyfill (USB and BLE on iOS and Android), so the existing MIDI code runs unchanged on phones. Spike the Android WebView's own Web MIDI first.
5. **Scratch rework**: position-based jog with per-device ticks per revolution, MIDI timestamps and an alpha-beta filter.
6. **Controller-audio auto-pick**: when a known controller with a 4-channel interface connects, offer "Use *DDJ-FLX4* outputs 1-2 for master and 3-4 for headphones".
7. **Declarative HID drivers** for NI S2 MK3 / S3 (desktop and Android only), then Launchpad/Push pads, Stream Deck, OSC-in and Pro DJ Link status.

---

## 2. What works today: details and gaps from the code

| Area | Today (file) | Gap |
|---|---|---|
| Transport | Web MIDI (`midi.js`); WebHID (`hid.js`, Electron chooser in `electron/main.js` `setupHidChooser`); Gamepad API | `sysex:false`; no BLE MIDI path on Windows (§7.8); nothing on mobile |
| Device identity | Port name; `portBase()` normalises in/out names; `NOT_A_CONTROLLER` regex; auto-apply `PRESETS[].match` regex | No SysEx identity, no manufacturer field (`MIDIPort.manufacturer` is unused), no USB VID/PID for MIDI |
| Mapping data | `settings.midiMappings[device] = {name, entries, outputs?, source?, importInfo?}`; JSON export `opendjMidiMapping: 1` | No layers, banks, takeover, colour, init, jog profile or displays |
| Learn | 14-bit LSB watch (400 ms), relative guess, guided wizard (`wizard.js`) | No "learn shifted", no layer-aware learn |
| Targets | `buildTargets(app)`: deck transport, tempo/bend, jog/jogRing/jogSearch/jogTouch, loops, beat loops, beat jumps (½ to 64), 8 hot cues, rolls, sampler, beat-jump pads, slicer, pad modes (`hotcue/roll/jump/sampler/fx`), key ±/sync/knob, stems ×4 (mute/level) + acapella/instrumental/stem FX, mixer `mixerN.*` (volume, trim, EQ ×3, filter, cue, fxOn, fxMix, fxParam, fxParam2, vocal, inst), crossfader, master/cue-mix/HP volume, shift, mic, sequencer, browser, automix, record, Link and lyrics | No per-unit FX targets (FX1/FX2 unit select, effect select, beat FX time); no "deck select" or bank targets; no `velocity`-aware pads; no "needle search" (strip) target; stems and colour LED states are not exposed for RGB |
| LEDs | 80 ms poll, de-duplicated, explicit outputs (Mixxx) or auto echo; VU and clip states (`buildStates`) | No colours, palettes, blink, SysEx output, or VU segment scaling per device |
| Scratch | `deckN.jog` → `jogScratch(rot = delta/720, dt)`; worklet smooths velocity (`worklets.js` `curRate += (target-curRate)*0.02`) | Fixed 720 ticks per revolution, ignores `e.timeStamp`, velocity-based not position-based |
| Imports | Mixxx `.midi.xml` (runtime, user-triggered; GPL caveat honoured in `mixxx-online.js` and docs §2.7) | `.hid.xml` not supported; no rekordbox CSV / VirtualDJ / Traktor TSI import |
| Clock | MIDI clock out | No MIDI clock in (not needed for DJ controllers) |
| Audio | `cueMode`: `split` / `channels34` / second device | Not linked to the controller; no auto-suggest |
| Mobile | Controllers hidden (`platform.js`, `docs/MOBILE.md`) | Needs a native bridge (§5) |
| Tests | `scripts/e2e-controllers.mjs`, `test/controllers.test.js` | No per-mapping replay fixtures; no LED golden files |

---

## 3. Research findings

### 3.1 Mapping sources and licences

| Source | Licence / status | How OpenDJ may use it |
|---|---|---|
| **Mixxx mappings** (`res/controllers`, 144 `.midi.xml` and 18 `.hid.xml` as of 2026-11-20) | GPL-2.0-or-later (repo) | Runtime fetch on user request only, as now. **Do not bundle, convert-and-ship or port** them, scripts included. Reading them for facts is legally different from copying, but to stay clean, first-party mappings should be derived from charts and captures, and say so in their `provenance` field. |
| **Manufacturer MIDI charts** (Pioneer "List of MIDI messages", Roland "MIDI Implementation", Novation/Akai programmer's references) | The document is copyrighted, but the facts in it (which note or CC a control sends) are not copyrightable expression in the US (*Feist*). The EU database right protects substantial extraction from databases with substantial investment; a per-device message list is unlikely to qualify, but this is **(unverified legal opinion)** | Writing our own JSON mapping from a chart is fine. Don't redistribute the PDFs; link them. Don't reproduce the chart's layout or prose. |
| **VirtualDJ** | Two XML files: a *definition* (names MIDI codes and HID zones) and a *mapper* (names → VDJscript actions) ([ControllerMappingFile v8](https://virtualdj.com/wiki/ControllerMappingFile_v8.html), [Controller Developers](https://virtualdj.com/wiki/Controller%20Developers)). Built-in definitions are not exposed to users; custom definitions need a Pro licence (forum reports) | **User import is possible but low value.** A user's own definition plus mapper gives the MIDI codes and VDJscript strings. VDJscript is a full language, so only simple verbs (`play_pause`, `cue_stop`, `hot_cue 1`, `volume`, `eq_low`…) translate. Offer it as "best-effort import" in a later phase. |
| **rekordbox** | MIDI LEARN exports and imports `.csv`; lines starting with `#` are comments; each row names a function and the hex MIDI input ([AlphaTheta FAQ](https://forums.pioneerdj.com/hc/en-us/articles/25240734758809-How-to-customize-rekordbox-MIDI-mapping), [DJTechTools](https://djtechtools.com/2019/06/24/hacking-rekordbox-fx-and-adding-rmx-1000-control)). Column schema not officially documented **(unverified)** | Feasible user import of a user's *own* exported CSV: function name → OpenDJ target table. Built-in rekordbox mappings for Pioneer units are not user-visible files. Good for "I customised rekordbox and want the same layout". |
| **Serato** | Serato's user MIDI mapping files are XML under `_Serato_/MIDI` **(unverified)**; native controller support is closed | Possible later import; low priority. |
| **Traktor** `.tsi` | Binary-in-XML; community-documented | Low priority. |
| **djay** | Mappings built in; community XML edits reported on the Algoriddim forum | Not a source. |
| **Community resources** | Mixxx forums and wiki (GPL/CC-BY-SA text), DJTechTools mapping site (per-file licences vary), manualslib (copyrighted manuals) | Use as hints for which controls exist; never copy files. |

**Recommendation: first-class bundled OpenDJ mappings.**
- **Licence:** mapping JSON files under **CC0-1.0**, so other projects (including Mixxx) can reuse them freely, which builds goodwill. Any per-device JS helper goes under **MIT**. Each file carries `provenance: { method: "chart"|"capture"|"chart+capture", chart: "<url>", firmware: "1.02", testedBy: [...], date }`.
- **How they get written:**
  1. Start from the manufacturer chart where one exists.
  2. Otherwise run the **capture tool** (§4.6): "press every control in order" produces a JSONL log.
  3. Generate a skeleton mapping from the capture.
  4. Hand-assign targets.
  5. Verify on hardware with the replay harness and a checklist.
- **Contributor workflow:**
  1. Settings → Controllers → "Record a session for a new mapping" saves `capture.jsonl` with device name, identity reply and firmware.
  2. The contributor opens a GitHub issue using the template "Controller mapping: <device>" and attaches the capture, a photo of the unit, and the chart link.
  3. A maintainer or volunteer writes `public/js/midi/mappings/<vendor>-<model>.json`.
  4. CI runs `scripts/test-mappings.mjs`, which replays the capture into a headless engine and asserts target hits, LED outputs and takeover.
  5. A device owner signs off on the checklist in the PR.
  6. The mapping is tagged `verified` (hardware-tested) or `community` (capture-only).
- **No Mixxx-derived content.** The PR template asks: "Did you copy from Mixxx, Serato, rekordbox or VirtualDJ files? (must be no)". A CI check greps for Mixxx-isms in comments and names (`engine.`, `[Channel1]`, `script-binding`).

### 3.2 A note on facts seen in GPL code
In Mixxx scripts we saw that:
- the DDJ-FLX4 needs a periodic SysEx keep-alive (the script comment says it was "reverse engineered with Wireshark")
- inMusic units (MC7000, Mixtrack Platinum FX) accept a "status request" SysEx that makes the unit report all control positions
- the Mixtrack Platinum FX leaves demo mode after a Universal Identity Request (`F0 7E 00 06 01 F7`)
- Mixxx enables soft takeover on tempo and FX meta knobs for the DDJ-400/FLX4 and the MC7000 pitch faders

These are interoperability facts. OpenDJ should **confirm each on hardware with its own USB/MIDI capture** and record that capture as the provenance, rather than citing Mixxx code.

### 3.3 Controllers people buy (2024–2026): what we found

**Pioneer DJ / AlphaTheta**
- **Interface.** Modern DDJ units are USB MIDI and USB Audio class compliant: Mixxx documents the FLX4, and AlphaTheta lists the FLX2 as "Class compliant (no need to install audio drivers)" ([AlphaTheta FLX2 announcement](https://alphatheta.com/en/information/introducing-ddj-flx2-compact-2-channel-dj-controller/), [VirtualDJ FLX2 setup](https://virtualdj.com/manuals/hardware/alphatheta/ddjflx2/setup.html), [Mixxx FLX4](https://manual.mixxx.org/2.6/sq/hardware/controllers/pioneer_ddj_flx4)).
- **Charts.** Pioneer publishes "List of MIDI messages" PDFs for many units: [DDJ-SR](https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-sr/ddj-sr_list_of_midi_messages_e.pdf), [DDJ-RX](https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-rx/ddj-rx_list_of_midi_message_e.pdf), [DDJ-SB3](https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-sb3/ddj-sb3_midi_message_list_e2.pdf), [XDJ-RX](https://www.pioneerdj.com/-/media/pioneerdj/software-info/system/xdj-rx/xdj-rx_list_of_midi_message_e_ver221.pdf), [XDJ-RX3 (Japanese edition)](https://www.pioneerdj.com/-/media/pioneerdj/software-info/system/xdj-rx3/xdj-rx3_midi_message_list_j1.pdf), [XDJ-AZ](https://www.pioneerdj.com/-/media/pioneerdj/software-info/system/xdj-az/xdj-az_midi_message_list_e1.pdf), [Opus Quad](https://www.pioneerdj.com/-/media/pioneerdj/software-info/system/opus-quad/en/opus-quad_midi_message_list_e1.pdf), [Omnis Duo](https://www.pioneerdj.com/-/media/pioneerdj/software-info/system/omnis-duo/omnis-duo_midi_message_list_e1.pdf).
- **No MIDI list found** for the FLX2/FLX4/FLX6/FLX10, REV series or DDJ-400/800/1000. Only a [DDJ-FLX4 rekordbox hardware diagram](https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-flx4/ddj-flx4_hardwarediagram_rekordbox_e1.pdf) turned up **(unverified: check each product's support page)**. The URL pattern is `pioneerdj.com/-/media/pioneerdj/software-info/controller/<model>/…`.
- **Pioneer details:**
  - The FLX4 has 14-bit mixer controls and needs a SysEx keep-alive (§3.2). The SB-series lists show 14-bit MSB/LSB values from 0 to 16383.
  - The DDJ-FLX10 has on-jog displays (deck info, waveform, artwork, logo). The 3-band waveform is rekordbox-only, and Serato shows only a playhead ([Pioneer FLX10 page](https://www.pioneerdj.com/en/product/dj-controllers/ddj-flx10/), [Crossfader review](https://wearecrossfader.co.uk/blog/pioneer-dj-ddj-flx10-review/)). The display protocol is not public, so treat displays as **not feasible** unless Pioneer documents them.
  - The DDJ-200 is a USB and **Bluetooth MIDI** "smart" controller with **no audio interface** ([Pioneer DDJ-200 news](https://www.pioneerdj.com/en/news/2019/ddj-200-smart-dj-controller), [Digital DJ Tips](https://www.digitaldjtips.com/first-look-pioneer-dj-ddj-200-wedj-app-for-iphone/)). Some retailers list it as discontinued.
  - The FLX2 is USB-C bus-powered. A Bluetooth connection is mentioned by a retailer **(unverified)**.
- **CDJ-3000 / DJM in HID mode:** Pioneer's CDJ HID protocol is not public. Mixxx has a `Pioneer CDJ HID.hid.xml` for older CDJs. CDJ MIDI mode exists on many models; a chart for the CDJ-3000 was not found **(unverified)**.

**Numark (inMusic)**
- The Mixtrack Platinum FX / Pro FX are USB Audio and MIDI class compliant ([Mixxx](https://manual.mixxx.org/2.6/de/hardware/controllers/numark_mixtrack_platinum_fx)).
- No public MIDI chart was found ([search](https://jp.juno.co.uk/downloads/manual/821140-01U.pdf/) shows only the user guide).
- The Platinum FX has small **jog-centre displays** that Mixxx drives over MIDI, so they are feasible for OpenDJ. It also needs SysEx: demo-mode exit, status dump, and fader-cut mode.
- Mixxx also has the Party Mix and NS4FX.

**Hercules (Guillemot)**
- The DJControl Inpulse 200/300/500 are class compliant ([DJUCED KB](https://www.djuced.com/?p=8200)). No public MIDI chart was found ([Mixxx wiki](https://github.com/mixxxdj/mixxx/wiki/Hercules-DJControl-Inpulse-500)).
- The **DJControl Mix** and **Mix Ultra** connect over **Bluetooth LE MIDI** to iOS 11.2+ and Android 8.1+ ([Hercules](https://hercules.com/en/product/djcontrol-mix), [Bonedo](https://www.bonedo.de/artikel/hercules-djcontrol-mix-test)). These are prime phone-app targets. Mixxx has a `Hercules DJControl MIX.midi.xml`.
- The Inpulse T7 has motorised platters (P3).

**Native Instruments**
- The Traktor Kontrol S2 MK3, S3, S4 MK3, Z1 and F1 use **HID**. The X1 is MIDI.
- The S3 is "USB class compliant audio and HID", with a 4-channel sound card: master on 1-2, headphones on 3-4. The S2 MK3 uses the same channel layout ([Mixxx S3](https://manual.mixxx.org/2.4/en/hardware/controllers/native_instruments_traktor_kontrol_s3), [Mixxx S2 MK3](https://manual.mixxx.org/2.5/de/hardware/controllers/native_instruments_traktor_kontrol_s2_mk3)).
- The S4 MK3 has HID controls and motorised (haptic) jogs. Its screens use **USB bulk** transfers; Mixxx 2.7 added screen support via a separate bulk mapping ([Mixxx S4 MK3](https://manual.mixxx.org/2.7/gl/hardware/controllers/native_instruments_traktor_kontrol_s4_mk3)).
- **WebUSB could in principle drive bulk screens on desktop Chromium/Electron (unverified; OS driver claiming may block it).**

**Denon DJ (inMusic)**
- The MC7000 and MC6000MK2 are MIDI. No public chart exists, according to an [Engine DJ forum thread](https://community.enginedj.com/t/midi-implementation-documentation/3300). They use a SysEx status request.
- The SC Live 2/4 and Prime Go/4+ have a **Computer mode** for Serato and VirtualDJ ([VirtualDJ SC Live 4](https://virtualdj.com/manuals/hardware/denon/sclive4/setup.html)). Whether they are plain class-compliant MIDI in that mode is **(unverified)**.

**Rane**
- The Rane One is a Serato-designed controller with motorised platters. Its motor control uses device-specific messages, and other apps support it poorly ([NI forum](https://community.native-instruments.com/discussion/comment/66843/), [VirtualDJ forum](https://virtualdj.com/forums/243327/General_Discussion/Rane_One_Definition_file_edit_.html)).
- The Rane Four's interface is **(unverified)**.
- Both are P3.

**Reloop**
- The Mixon 8 Pro is class compliant on macOS but needs a driver on Windows ([Serato](https://support.serato.com/hc/en-us/articles/10173655705359)).
- The Buddy and Ready are djay- and Serato-oriented. No charts were found.
- Mixxx has no mapping for the Mixon, Buddy or Ready.

**Roland**
- Roland publishes a MIDI implementation chart for the [DJ-707M](https://www.bax-shop.nl/downloads/products/9000-0054-9324/dj-707m_midi_imple_chart_eng01_w.pdf). The DJ-202 and DJ-505 charts are **(unverified)**.
- Mixxx has the DJ-505.

**Behringer**
- Mixxx covers the CMD Micro, CMD Studio 4a, DDM4000, BCD2000/3000 and more. These are MIDI units; charts are often in the manuals **(unverified)**.

**Pad and grid controllers (MIDI with public references)**
- Novation: [Launchpad X programmer's reference](https://fael-downloads-prod.focusrite.com/customer/test/s3fs-public/downloads/Launchpad%20X%20-%20Programmers%20Reference%20Manual.pdf), [Launch Control XL](https://fael-downloads-prod.focusrite.com/customer/prod/downloads/launch_control_xl_programmer_s_reference_guide.pdf).
- Akai: [APC Key 25 mk2 protocol](https://cdn.inmusicbrands.com/akai/attachments/APC%20Key%2025%20mk2%20-%20Communication%20Protocol%20-%20v1.1.pdf).
- Ableton: [Push 2 MIDI and display interface](https://www.github.com/Ableton/push-interface). Its licence is not stated in our results; CDM calls it "public source", so it is **(unverified)**.

### 3.4 What other apps do
- **djay** (iOS/Android/desktop): built-in mappings auto-load. Bluetooth MIDI pairing is in Settings → MIDI ([Hercules Mix setup](https://www.datart.cz/mixazni-pult-hercules-djcontrol-mix-bily.html)). Some functions are hidden from MIDI Learn. There is no marketplace, and users share XML.
- **rekordbox / Serato**: they only "unlock" supported hardware. MIDI Learn has CSV export and import in rekordbox. Neither has a marketplace.
- **VirtualDJ**: auto-detects hundreds of controllers and needs a paid licence for most of them ([Prime GO](https://virtualdj.com/manuals/hardware/denon/primego/setup.html)). It separates definition and mapper files, and its add-ons site works as a mapping marketplace.
- **Traktor**: native NI HID plus TSI import/export; the community shares TSI files.
- **Mixxx**: auto-detects by USB and port name, ships about 160 GPL mappings with JS scripts, has a manual page per controller and a forum-based review process ([Contributing Mappings](https://github.com/mixxxdj/mixxx/wiki/Contributing%20Mappings)), soft takeover via `engine.softTakeover` and HID/bulk support.

**Lesson for OpenDJ:** auto-detect plus an auto-apply prompt, per-controller docs, and a reviewed mapping library are table stakes. Being free with no licence gating (unlike VirtualDJ) and working on phones (like djay) are OpenDJ's differentiators.

---

## 4. Architecture

### 4.1 Mapping format v2 (JSON)
**Goals:**
- backwards compatible: a v1 `{entries}` mapping is a v2 mapping with one layer and no extras
- declarative first, so mappings are reviewable data
- an optional tiny per-device JS "driver" (MIT, bundled) only for things data can't express, such as display rendering or HID parsing

**Example (abridged):**
```jsonc
{
  "opendjMapping": 2,
  "id": "pioneer-ddj-flx4",
  "name": "Pioneer DJ DDJ-FLX4",          // shown as "Works with Pioneer DJ DDJ-FLX4"
  "licence": "CC0-1.0",
  "provenance": { "method": "chart+capture", "chart": null, "firmware": "1.02", "testedBy": ["@handle"], "date": "2027-01-15" },
  "match": {
    "portName": ["^DDJ-FLX4\\b"],                     // regex, case-insensitive, after portBase()
    "sysexIdentity": { "manufacturer": [0x00, 0x40, 0x05], "family": null },   // optional
    "usb": [{ "vid": "0x2B73", "pid": "0x????" }]      // used where the platform exposes it (mobile bridge, WebHID)
  },
  "audio": { "outputs": 4, "master": [1, 2], "cue": [3, 4], "inputs": 0, "deviceLabel": ["DDJ-FLX4"] },
  "init":   [{ "sysex": "F0 … F7" }, { "requestState": true }],     // sent on connect / after mapping load
  "keepalive": { "everyMs": 250, "send": [{ "sysex": "F0 … F7" }] },
  "shutdown": [{ "allLedsOff": true }],
  "vars":  { "left": 1, "right": 2 },                 // deck banks: $left/$right resolve at runtime
  "layers": ["base", "shift"],                        // conditions can test layers and vars
  "jog": { "default": { "ticksPerRev": 720, "touch": true, "mode": "position", "rpm": 33.33, "alpha": 0.125, "beta": 0.0039 } },
  "controls": [                                       // physical controls (named once, reused by inputs/outputs)
    { "id": "L.play",  "midi": "note:0:0x0B" },
    { "id": "L.jog",   "midi": "cc:0:0x22", "rel": "offset" },
    { "id": "L.jogTouch", "midi": "note:0:0x36" },
    { "id": "L.tempo", "midi": "cc:0:0x00", "lsb": "cc:0:0x20", "takeover": "pickup" },
    { "id": "M.xfader","midi": "cc:6:0x1F", "lsb": "cc:6:0x3F", "takeover": "none" },
    { "id": "L.pad1",  "midi": "note:7:0x00", "velocity": true }
  ],
  "inputs": [
    { "control": "L.play",  "target": "deck{$left}.play" },
    { "control": "L.play",  "when": "shift", "target": "deck{$left}.cueReturnPlay" },
    { "control": "L.tempo", "target": "deck{$left}.tempo", "invert": true },
    { "control": "L.jog",   "target": "deck{$left}.jog", "profile": "default" },
    { "control": "L.deckSwitch", "action": { "toggleVar": "left", "values": [1, 3] } },
    { "control": "L.shift", "action": { "layer": "shift", "momentary": true, "scope": "left" } },
    { "control": "L.padModeStems", "action": { "set": { "padModeL": "stems" } } },
    { "control": "L.pad1", "when": "padModeL == 'stems'", "target": "deck{$left}.stem1Mute" }
  ],
  "outputs": [
    { "control": "L.play", "state": "deck{$left}.play", "on": 127, "off": 0, "blinkWhen": "deck{$left}.cueArmed" },
    { "control": "L.pad1", "state": "deck{$left}.hotcue1.color", "palette": "pioneer-pad" },
    { "control": "L.vu",   "state": "mixer{$left}.vu", "scale": { "type": "vu", "steps": 11, "min": 0, "max": 127 } },
    { "control": "L.deckLed", "state": "$left == 3", "on": 127, "off": 0 }
  ],
  "palettes": { "pioneer-pad": { "type": "velocity", "map": [[ "#FF0000", 1 ], [ "#00FF00", 33 ]] } },
  "displays": [{ "id": "L.jogScreen", "driver": "numark-mtpfx-jog", "state": ["deck{$left}.position", "deck{$left}.bpm"] }],
  "driver": null                                      // optional MIT JS module id for exotic devices
}
```

**Semantics:**
- **Conditions** (`when`) use a tiny safe expression language over layers, vars and target states: `==`, `!=`, `&&`, `||`, `!`. No `eval`.
- **Layers**: `momentary` or `toggle`, with scope `global`, `left` or `right`, so the Pioneer-style per-side shift works.
- **Deck banks**: `vars` are templated into target ids (`deck{$left}`). Switching a bank triggers LED refresh and takeover re-arm for every control bound through that var.
- **Soft takeover**: `takeover: "pickup" | "scale" | "none"`, default `pickup` for absolute knobs and faders except the crossfader and channel faders on scratch units. A pickup control ignores input until it crosses the current software value (threshold ±2 %). This is needed after deck switches, preset loads, automix and UI changes. The UI shows a "ghost" marker of the hardware position.
- **LED colours**: `palette` types are:
  - `velocity`: nearest-colour lookup table (Pioneer, Novation and Akai use velocity palettes)
  - `rgb-sysex`: a template with `{r}{g}{b}` 7-bit slots (Launchpad X, Push 2)
  - `rgb-cc`
  
  Hot-cue colours come from the track's cue colours, which OpenDJ already stores.
- **SysEx**: `init`, `keepalive` and `shutdown`, plus `requestState` for units with status-dump commands. The runtime requests `sysex:true` only when a mapping needs it, or always in Electron where it's already permitted. In browsers this triggers the SysEx permission prompt once.
- **Jog profiles**: see §4.7.
- **Displays**: a driver id plus the states it needs. The renderer runs in the driver module (§4.8).
- **HID**: the same schema, with `hid:` control keys (existing `parseHidKey` syntax) plus `hidOut` report templates for LEDs. Device drivers declare the report layout.

**Compiler:** `compileMapping(v1|v2) → runtime tables` with:
- a `Map<msgKey, handler[]>` (O(1) dispatch instead of today's linear scan over `entries` per message)
- an output plan per state
- validation errors listed in the UI

### 4.2 Device auto-detection
Order of evidence:
1. **USB VID/PID**: available via WebHID, and via the mobile bridge (Android `UsbDevice`; on iOS only the CoreMIDI model/manufacturer strings).
2. **SysEx Universal Identity Reply** (`F0 7E 7F 06 01 F7` request) gives the manufacturer ID, family and model. Only when SysEx is allowed, and **never** to unknown devices without a short timeout. Some units react to SysEx: the Mixtrack exits demo mode, which is harmless.
3. **`MIDIPort.manufacturer` / `.name`** regex after `portBase()`.
4. User choice, remembered.

Known SysEx manufacturer IDs to seed the table: Roland `41`, Akai `47`, Novation/Focusrite `00 20 29`, NI `00 21 09`, Ableton `00 21 1D`, Pioneer `00 40 05` (consistent with bytes seen in DDJ SysEx). Numark, Denon, Hercules and Reloop are **(unverified)**; confirm from captures. USB VIDs (Pioneer DJ `0x2B73`, NI `0x17CC`, Hercules `0x06F8`, inMusic `0x15E4`, Roland `0x0582`) are **(unverified)**.

Multi-port devices (for example XDJ units, or controllers exposing a second "MIDI 2" port for displays) group by `portBase()` plus the identity reply.

### 4.3 Plug-and-play prompt
This extends `offerMapping()`:
- **Known controller, bundled mapping:**
  - *"DDJ-FLX4 connected. Use the OpenDJ mapping (verified, firmware 1.02+)?"* with [Use] [Customise] [Not now].
  - If the controller has an audio interface: a second step, *"Send master to DDJ-FLX4 outputs 1-2 and headphones to 3-4?"*. This sets `masterDeviceId` and `cueMode: 'channels34'` (or `split` when only 2 channels are exposed, see §6).
  - Auto-apply silently only if the user ticked "Always use bundled mappings".
- **Known controller, no bundled mapping:** the current toast ("Find mapping" via the Mixxx search, or "Guided setup"), plus "Help us support this controller: record a capture".
- **Firmware too old:** a non-blocking note with a link to the vendor's updater (text only, no vendor logos).
- **On mobile:** the same prompt after BLE pairing or a USB attach event.

### 4.4 Mapping editor UX (Settings → Controllers)
- **Device view:** list or grid of physical controls (from `controls` or captured), each showing the live value and the current target per layer. Touch a control on the hardware to highlight its row (already partly in place via the `message` event).
- **Layer tabs:** Base / Shift / per-pad-mode. Learn into the active layer.
- **Per-row options:** invert, relative mode, 14-bit, takeover, velocity, deck bank var (`Left deck`/`Right deck`/fixed N), LED (auto/colour palette/off).
- **Banks:** "This controller has deck switch buttons" toggle that converts fixed `deck1` targets to `deck{$left}`.
- **Test mode:** fires targets in a sandbox engine (no audio), useful for checking without disturbing a mix.
- **Diff vs bundled:** user overrides stored as a patch on top of the bundled mapping, so bundled updates still arrive. Show "3 changes from the OpenDJ mapping" with Reset.
- **Export/share:** v2 JSON with CC0 tick-box; "Submit to OpenDJ" opens a prefilled GitHub issue URL (no auto-upload, no accounts).

### 4.5 Import paths
| Format | Phase | Notes |
|---|---|---|
| OpenDJ v1/v2 JSON | P0 | v1 auto-upgrades in memory; stored as-is |
| Mixxx `.midi.xml` (runtime, user-triggered) | exists | Keep the GPL notice; improve heuristics for shift layers (map Mixxx `shift`-suffixed functions to the `shift` layer) and convert `<options><soft-takeover/>` to `takeover:pickup` |
| Mixxx `.hid.xml` | never | Script-only; offer the generic HID learn or an OpenDJ HID driver instead |
| rekordbox MIDI LEARN `.csv` (user's own export) | P4 | Function-name table; flag unknown rows |
| VirtualDJ definition + mapper XML (user's own) | P5 (optional) | Simple VDJscript verbs only |
| Traktor `.tsi`, Serato XML | later / never | Low value |

### 4.6 Testing harness
- **Capture format** (`.jsonl`): header `{device, portName, identity, firmware, opendjVersion, mapping}`, then `{t, port, data:[…]}` per message, both directions, with Web MIDI `timeStamp`s.
- **Recorder:** a Controllers panel button. It also records outgoing LEDs/SysEx, so LED behaviour can be golden-tested.
- **Replay:** `scripts/test-mappings.mjs` loads each bundled mapping and its `test/fixtures/controllers/<id>/*.jsonl`. It stubs `MIDIAccess` (reusing the e2e stub approach), replays into a headless engine, and asserts:
  1. every `controls[]` id is exercised
  2. every input dispatches the expected target (fixture annotations: `{"expect": "deck1.play"}`)
  3. takeover suppression works
  4. the LED output stream matches the golden file
  5. bank switching re-routes correctly
  6. init/keep-alive timing is right
- **Virtual controllers in e2e:** extend `scripts/e2e-controllers.mjs` with a "virtual FLX4" built from the bundled mapping's `controls`. It sends synthetic jog spins (constant speed, back-and-forth "baby scratch" waveform) and checks deck position against the expected platter angle within tolerance. This is the objective scratch-feel test.
- **Unit tests** in `test/controllers.test.js` cover: compiler, condition evaluator, takeover state machine, palette nearest-colour, relative decoders, identity parsing, and the Web MIDI polyfill contract (§5).
- **Mobile:** a fake native bridge in `scripts/e2e-mobile.mjs` that emits MIDI events through the polyfill.

### 4.7 Scratching that feels right
Today the jog sends `delta/720` rotations and wall-clock `dt` into a velocity, and the worklet low-passes it. Changes:
1. **Use `MIDIMessageEvent.timeStamp`** (and the native bridge's host timestamps) instead of `performance.now()` at handler time. BLE and USB batching otherwise produce bursts of near-zero `dt`, hence spikes.
2. **Per-device `ticksPerRev`** in the jog profile. Measure with a calibration step: "spin the platter exactly one turn". Store it in the mapping and in user settings.
3. **Position-following mode** (recommended default when jog touch is held):
   - Accumulate platter angle → target track position (33⅓ rpm = 1.8 s per revolution, as today).
   - Send `{ targetPos, t }` to the worklet.
   - The worklet runs an **alpha-beta filter** (standard α≈1/8, β≈α²/4 style) or a critically damped PLL that drives `curRate` to track the target position. This removes drift and sounds like vinyl, because displacement stays exact.
   - Keep the velocity mode for touchless "jog nudge".
4. **Release behaviour:** on touch release, ramp back to play speed with a configurable "motor" time (reuses the `startTime`/brake model). Slip mode is respected as today.
5. **Jog touch without a sensor:** a "scratch on movement while paused" option, plus timeout-based release.
6. **High-res jogs:** support 14-bit or pitch-bend jog messages and HID 16-bit counters (`u16le` already parsed in `hid.js`) via `rel: 'wrap'` with `range: 16384|65536`.
7. **Acceptance test:** a synthetic baby-scratch at 2 Hz, ±90°. The playhead error stays under 5 ms RMS and there are no sign flips in `curRate` beyond the input's (e2e via `getOutputTimestamp`).

### 4.8 Displays and screens
| Device | Mechanism | Feasibility |
|---|---|---|
| Numark Mixtrack Platinum FX jog displays | MIDI messages (driven by Mixxx today) | ✔ desktop/web/mobile via MIDI; small driver module |
| Pioneer DDJ-FLX10 / DDJ-1000 on-jog displays, DDJ-REV7 jog screens | Undocumented, likely SysEx or vendor-specific | ✖ unless AlphaTheta documents it; don't reverse-engineer encrypted or handshake paths |
| NI S4 MK3 screens | USB bulk endpoint (Mixxx 2.7 supports it) | ◐ desktop via WebUSB in Electron/Chromium **(unverified: the OS may claim the interface; Windows needs WinUSB)**; ✖ iOS; ◐ Android via `UsbManager` |
| Ableton Push 2 display | USB bulk, documented in push-interface | ◐ desktop WebUSB; licence of the doc **(unverified)** |
| Denon SC Live / Prime screens | Engine OS in standalone; not exposed in computer mode **(unverified)** | ✖ |

Display drivers render a small canvas (waveform, BPM, time) to the device format at 10–30 fps in a worker.

### 4.9 Other feature work driven by controllers
- **Shift layers:** per-side shift, plus "shift-lock" for accessibility.
- **Deck switching:** `$left/$right` banks; deck-colour LEDs; 4-deck automatic for units with deck buttons (FLX6, FLX10, NS4FX, MC7000).
- **FX units:** add targets `fx1.on/select/param/time/beatFx`, `fx2.*` (Pioneer Beat FX, Serato FX1/FX2 banks) mapped onto existing channel FX. `fxParam2` already exists. Add `fx.unit{N}.assign.deck{M}`.
- **Stems:** the existing targets cover Serato-style stem pads (vocal/drums/bass/melody mute) and Pioneer FLX10 "Track Separation" style vocal/inst/drums buttons. Add a `deckN.padMode.stems` pad mode and `deckN.stemSolo{1-4}`. Mobile AI stems are unavailable (`docs/MOBILE.md`), but "quick stems" (`mixerN.vocal/inst`) work.
- **Sampler pads:** velocity-sensitive (`velocity:true` scales the sample gain); sampler bank select.
- **Beat-jump and key:** existing targets; add `deckN.jumpSize.up/down` and `deckN.jumpBySize±` for Pioneer's pad paging.
- **Needle search strips** (Mixtrack, Inpulse 500): an `abs` target `deckN.needle`, only while paused (option).
- **VU meters:** `scale: vu` with per-device step count; peak-hold option.

---

## 5. Mobile plan (iOS and Android)

### 5.1 Approach: a Web MIDI-shaped native bridge
Write a small first-party Capacitor plugin, `capacitor-opendj-midi` (MIT), plus `public/js/midi/native-midi-polyfill.js`. The polyfill installs `navigator.requestMIDIAccess` when `platform.native` and the native API is missing. **`MidiManager` stays unchanged.**

**Polyfill contract (subset of the W3C Web MIDI API):**
- `requestMIDIAccess({sysex})` returns `MIDIAccess` with:
  - `inputs` / `outputs` as `Map<id, MIDIPort>`
  - `onstatechange`
  - `sysexEnabled`
- Each port has `id, name, manufacturer, state, connection, onmidimessage` (`{data: Uint8Array, timeStamp}`), `send(data, timestamp?)` and `open()`/`close()`.
- Extra non-standard calls under `navigator.opendjMidi`:
  - `pairBluetooth()`: shows the native BLE picker
  - `usbInfo(portId)`: VID/PID on Android
  - `latencyStats()`

**Bridge transport:**
- Capacitor `notifyListeners('midi', {...})` serialises through the JS bridge, typically low single-digit ms **(unverified; measure)**.
- To keep up with dense jog streams (hundreds of messages per second per jog), native code **coalesces messages per port every 2–4 ms** into one event: `{port, msgs: [[ts, b0, b1, b2], …]}` with base64 for SysEx.
- Timestamps use the native host clock, converted to `performance.now()` space at connect time. Re-sync every 10 s.
- Output: `send()` is batched the same way. LED traffic is already de-duplicated by `MidiManager`.

### 5.2 Android
1. **Spike first (S):**
   - MDN compat data lists `webview_android` as mirroring Chrome for `navigator.requestMIDIAccess`.
   - Chromium's Web MIDI permission prompt was "not released on WebView" ([blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/nz320H9J6bs)). Behaviour depends on the app's `WebChromeClient.onPermissionRequest`, where the resource constant is `PermissionRequest.RESOURCE_MIDI_SYSEX`.
   - Test on a Pixel and a Samsung (Samsung Internet reportedly never resolves `requestMIDIAccess`, [Samsung forum](https://forum.developer.samsung.com/t/web-midi-api-requesting-midi-access-promise-doesnt-resolve/23572)).
   - Try a Capacitor `BridgeWebChromeClient` subclass that grants MIDI for the app origin only.
   - **If USB MIDI works natively in the WebView, USB needs no plugin on Android.** BLE devices still need a native "pair" step, because Android only exposes a BLE MIDI device after `MidiManager.openBluetoothDevice()`.
2. **Plugin (M):**
   - `android.media.midi.MidiManager` (API 23+): `getDevices()` / `getDevicesForTransport()` (API 33+), `registerDeviceCallback`, `openDevice` for USB, `openBluetoothDevice` for BLE ([reference](https://developer.android.com/reference/android/media/midi/MidiManager)).
   - Keep a strong reference to the opened BLE device, because a garbage-collected `MidiDevice` closes ([android-midi group](https://groups.google.com/g/android-midi/c/chFSXKjysQA)).
   - **BLE scan:** `BluetoothLeScanner` filtered on the BLE-MIDI service UUID `03B80E5A-EDE8-4B33-A751-6CE34EC4C700`, shown in a native bottom sheet.
   - **Permissions:** Android 12+ needs `BLUETOOTH_SCAN` (with `neverForLocation`) and `BLUETOOTH_CONNECT`; older versions need `ACCESS_FINE_LOCATION` and `BLUETOOTH`/`BLUETOOTH_ADMIN`. Declare `<uses-feature android:name="android.software.midi" android:required="false"/>`.
   - **USB:** no permission dialog for class-compliant MIDI via `MidiManager`. The USB-OTG adapter is the user's responsibility; document USB-C hubs with power delivery.
3. **HID on Android (L, later):** `UsbManager` can open the HID interface of NI controllers with a user permission dialog and run the same declarative HID driver over a native bulk/interrupt bridge. **Feasible, not trivial (unverified per device).**

### 5.3 iOS / iPadOS
- **No Web MIDI in WKWebView** (MDN: Safari has `version_added: false`), so a plugin is required.
- **CoreMIDI:** a `MIDIClient` with a notify block for add/remove, and input ports with `MIDIInputPortCreateWithProtocol` (MIDI 1.0 UMP, converted to bytes) or the legacy block API.
- **USB MIDI** via Lightning/USB-C adapters (Camera Connection Kit) or direct USB-C on recent iPhones and iPads. Class-compliant controllers appear automatically. Bus power is limited; many controllers need a powered hub **(unverified per device)**.
- **Bluetooth LE MIDI:** present `CABTMIDICentralViewController` (CoreAudioKit) from the plugin ([Apple](https://developer.apple.com/documentation/coreaudiokit/cabtmidicentralviewcontroller.md), [QA1831](https://developer.apple.com/library/ios/qa/qa1831/_index.html)).
  - Paired devices then show up as normal CoreMIDI endpoints.
  - iOS 16+ reconnects paired BLE MIDI peripherals automatically ([Apple MIDI Bluetooth](https://developer.apple.com/documentation/coremidi/midi-bluetooth.md)).
  - Note the iOS 27 SwiftUI-wrapping layout crash: present it as a plain `UIViewController` in a `UINavigationController` from UIKit ([forum](https://developer.apple.com/forums/thread/850584)).
- **Info.plist:** `NSBluetoothAlwaysUsageDescription`. No special entitlement is needed for CoreMIDI.
- **HID on iOS: NI-style HID controllers are not possible in the App Store app.**
  - iOS gives apps no generic USB HID access.
  - iPadOS DriverKit exists only on M-series iPads, needs Apple-granted, VID-specific entitlements, and has "no viable path for open-source drivers" according to developers ([Apple DriverKit for iPadOS](https://developer.apple.com/documentation/driverkit/creating-drivers-for-ipados.md), [forum](https://developer.apple.com/forums/thread/818914)).
  - Say so in the UI: "Traktor Kontrol (HID) controllers work on desktop and Android only."
- **Gamepads:** WKWebView exposes the Gamepad API (MDN mirrors Safari), so `gamepad.js` may already work on iOS **(unverified)**. Consider un-hiding gamepads separately from MIDI.

### 5.4 Existing plugins (evaluated)
| Option | Licence | Maturity | Verdict |
|---|---|---|---|
| `@eugabrielsilva/capacitor-midi-device` 8.0.1 | MIT (per `docs/RESOURCES_AND_LICENSING.md` §2.6) | Immature fork, 0 stars | Read for ideas; don't depend on it |
| `cordova-plugin-webmidi` (recifra; fork of mizuhiki's WebMIDIAPIShimForiOS) | **(unverified)** | iOS only; last push May 2024 ([ecosyste.ms](https://awesome.ecosyste.ms/projects/github.com%2Frecifra%2Fcordova-plugin-webmidi)) | Good prior art for the shim shape; Cordova, not Capacitor |
| `capacitor-midi` (npm) | **(unverified)** | "Just started" per [Ionic forum](https://forum.ionicframework.com/t/need-a-midi-plugin/181775) | No |
| `@capacitor-community/bluetooth-le` | MIT | Mature | Not needed: CoreMIDI and `MidiManager` handle BLE-MIDI framing natively |
| react-native-midi, flutter_midi_command | various | Show the scope | Not reusable |

**Decision:** write our own plugin of about 600–900 lines per platform (Swift and Kotlin), MIT, living in the repo at `mobile/plugins/capacitor-opendj-midi/`. Publish it to npm later if useful to others.

### 5.5 Latency, power and UX
- **Expected end-to-end input latency:** USB about 2–5 ms native plus bridge; BLE adds the connection interval, typically 7.5–15 ms plus jitter ([android-midi group](https://groups.google.com/g/android-midi/c/ElWqyeo56_4)). Show "Bluetooth adds a little delay: use USB for scratching."
- Measure with a loopback test: send a note out, the controller echoes an LED, and capture with a phone camera at high fps. Or use an audio-click method with a MIDI-to-audio device.
- Keep the screen-on logic already used for playback. BLE reconnect is handled on resume.

### 5.6 Mobile audio with controllers
See §6.

### 5.7 App store notes
- **iOS:**
  - The Bluetooth usage string must explain MIDI controllers.
  - Avoid vendor trademarks in the app name and keywords; "works with" in descriptions is fine (nominative use).
  - CoreMIDI is public API, so there is no review risk.
- **Google Play:**
  - Declare the Bluetooth permissions with `neverForLocation`.
  - The Data safety form says no data is collected from BLE.
  - `android.software.midi` stays `required=false`, so devices without MIDI still install.

### 5.8 Mobile testing
- Fake-bridge e2e in `scripts/e2e-mobile.mjs`.
- Manual matrix:
  - an iPhone (USB-C) with DDJ-FLX4, DDJ-200 (BLE) and DJControl Mix (BLE)
  - an iPad with Mixtrack Platinum FX through a powered hub
  - a Pixel and a Samsung with the same devices
- TestFlight and Play internal track builds go to community testers (§10).

---

## 6. Audio interfaces on controllers

**Desktop (largely working):**
- `cueMode: 'channels34'` already routes master to 1/2 and cue to 3/4 when `ctx.destination.maxChannelCount >= 4`.
- Add a **controller → audio device association** (`mapping.audio.deviceLabel` regex against `enumerateDevices()` labels) and the plug-and-play prompt (§4.3).
- Platform caveats **(unverified, test)**:
  - Windows Chromium uses WASAPI shared mode; a 4-channel class-compliant device may enumerate as two stereo endpoints. If so, use master → endpoint A and cue → endpoint B via the existing `cueDeviceId` path.
  - macOS Core Audio exposes one 4-channel device.
  - Linux PipeWire may need a "Pro Audio" profile to expose 4 channels.
- Add a **test tone per output pair** in Settings → Audio.

**Mobile:**
- WKWebView and Android WebView Web Audio output is effectively **stereo**, so `channels34` won't work in the WebView **(unverified, check `maxChannelCount`)**.
- **Practical path:** `split` cue mode (mono master on the left, mono cue on the right) with a split-cue Y-cable, which OpenDJ already supports. Controllers with a 4-channel interface plugged into a phone will usually present outputs 1/2 as the default route.
- **Native multichannel (L, later):**
  - iOS `AVAudioSession` supports multichannel USB class-compliant routes with `maximumOutputNumberOfChannels`.
  - Android AAudio supports USB multichannel on recent versions.
  - Both would need a native audio sink fed from the WebView (a big change). Defer until there's demand.

---

## 7. Hardware integrations beyond DJ controllers

| Integration | Mechanism | Licence | Platforms | Feasibility and notes |
|---|---|---|---|---|
| **Pro DJ Link status** (CDJ/XDJ/DJM network) | `prolink-connect` (TypeScript, MIT per aggregator; last push Dec 2024; fork `@dmxjs/prolink-connect`) ([npm](https://npmjs.com/package/prolink-connect)) | MIT (confirm LICENSE file) | Desktop (Electron main / server) and Docker on the LAN; ✖ mobile (UDP) | ✔ read-only: tempo, beat, on-air, track metadata. Use it to sync OpenDJ's master tempo or automix with CDJs, show "now playing" and drive lighting. It acts as a virtual CDJ; document that it can occupy a player number. Treat any **control** of CDJs over Pro DJ Link as out of scope. |
| **CDJ HID mode** | Pioneer HID protocol not public (vendor SDK under NDA, **unverified**); Mixxx has a community `.hid.xml` for older CDJs | — | Desktop | ✖ for first-party. Users may try generic HID learn. CDJ **MIDI mode** with a published chart (if available) is fine. |
| **Launchpad / Launch Control / APC / Push as pads** | MIDI with public programmer's references (Novation, Akai), Push 2 interface repo | Facts from public docs; Push repo licence **(unverified)** | All with MIDI | ✔ Bundled mappings: 8×8 grid = 4 decks × 8 hot cues / sampler 64 / stems mute matrix, RGB via SysEx palettes. Push 2 display ◐ desktop WebUSB. Mixxx has GPL Launchpad mappings; don't reuse. |
| **Elgato Stream Deck** | HID (WebHID); `@elgato-stream-deck/webhid` | MIT (per Yarn listing; verify the package and a pinned version, given recent npm supply-chain incidents) | Desktop, web (Chromium); Android via the HID bridge later; ✖ iOS | ✔ Button images rendered from OpenDJ state (deck, cue colours, BPM). A first-class "Stream Deck" page in Controllers. |
| **TouchOSC / Lemur / Open Stage Control (OSC tablets)** | OSC over UDP in; OpenDJ already sends OSC for lighting (`public/js/lighting/panel.js`, `server/lighting/`) | `osc.js` MIT option | Desktop/Docker server receives UDP; ✖ mobile app as a receiver | ✔ An OSC → target bridge: `/opendj/deck/1/play 1`, `/opendj/mixer/1/volume 0.7`; feedback by sending state back to the tablet. Ship a CC0 TouchOSC layout. A mobile OpenDJ could also act as a *remote control* for a desktop OpenDJ over the existing `server/remote.js` (WebSocket), with no UDP needed. |
| **Gamepads** | Gamepad API (exists) | — | All (iOS **unverified**) | Un-hide on mobile; add default layouts for Xbox/PS pads. |
| **Keyboard mapping editor** | Keyboard events | — | All | Reuse the v2 compiler with `key:` controls; conflict detection with existing shortcuts; export/import. Valuable for laptop-only DJs and accessibility. |
| **Foot pedals** | USB MIDI pedals (MIDI) or HID "keyboard" pedals (appear as keystrokes) | — | All | ✔ Via MIDI learn or the keyboard editor; document "hold = momentary layer". |
| **Web Bluetooth MIDI on desktop** | macOS exposes paired BLE MIDI via Audio MIDI Setup, so Web MIDI sees it. Windows: BLE MIDI is coming via Windows MIDI Services (preview transport, separate setup tool) ([Microsoft](https://microsoft.github.io/MIDI/kb/ble-midi-transport-architecture/)); Chromium's backend support is **(unverified)**. Linux: BlueZ with the MIDI profile | — | Desktop | Fallback: implement BLE-MIDI framing over **Web Bluetooth** (service `03B80E5A-…`), with an Electron `select-bluetooth-device` chooser (not yet in `electron/main.js`). Works in Chromium on Windows and Linux. M effort. |
| **DVS** | exists (`public/js/dvs/`) | — | Desktop | Combine with the controller's audio inputs (for example the FLX10, DDJ-1000SRT or Rane units with phono inputs) via `mapping.audio.inputs`. |

---

## 8. Controller matrix (top ~25)

**Legend:**
- **Interface:** M = USB MIDI class compliant; H = USB HID; B = Bluetooth LE MIDI; A2/A4 = built-in audio with 2 or 4 output channels.
- **Chart:** ✔ link = manufacturer chart found; ✖ = none found; ? = unverified.
- **Feasibility columns D / W / i / A** = desktop (Electron) / hosted web (Chromium) / iOS / Android.
  - ✔ feasible with the planned work
  - ◐ partial (some features impossible)
  - ✖ not feasible
- **Mixxx** = a GPL mapping exists for runtime import (snapshot 2026-11-20).
- **Plan** = how OpenDJ gets a first-party mapping.
- **Priority:** P0 = first batch, P1 = second, P2 = later, P3 = only with community hardware.

| # | Device | Interface | Chart | D | W | i | A | Jog / LEDs / screens / audio | Mixxx | Plan | Pri |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Pioneer DDJ-FLX4 | M, A4 (master + HP) | ✖ (only a [hardware diagram](https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-flx4/ddj-flx4_hardwarediagram_rekordbox_e1.pdf)) | ✔ | ✔ | ✔ USB-C | ✔ | Touch jog; mono LEDs; 14-bit; SysEx keep-alive; no screens | ✔ | Capture + diagram; replace the existing preset | P0 |
| 2 | Pioneer DDJ-400 | M, A4 | ✖? | ✔ | ✔ | ✔ adapter | ✔ | As FLX4 (predecessor) | ✔ | Capture | P0 |
| 3 | AlphaTheta DDJ-FLX2 | M (USB-C), audio ?, B? | ✖ | ✔ | ✔ | ✔ | ✔ | Small jogs, pads; class compliant ([AlphaTheta](https://alphatheta.com/en/information/introducing-ddj-flx2-compact-2-channel-dj-controller/)) | ✖ | Capture | P0 |
| 4 | Pioneer DDJ-200 | M + B, no audio | ✖ | ✔ | ✔ | ✔ BLE | ✔ BLE | Touch jogs, pads; phone-first | ✔ | Capture | P0 |
| 5 | Pioneer DDJ-FLX6(-GT) | M, A4 | ✖? | ✔ | ✔ | ◐ (bus power) | ◐ | 4-deck, big jogs, merge FX | ✖ | Capture | P1 |
| 6 | Pioneer DDJ-FLX10 | M, A4 + inputs | ✖? | ◐ | ◐ | ◐ | ◐ | Jog displays ✖ (proprietary); stems buttons ✔; 4-deck | ✖ | Capture | P2 |
| 7 | Pioneer DDJ-REV1 | M, A4 | ✖? | ✔ | ✔ | ◐ | ◐ | Battle layout, Serato-style pads | ✖ | Capture | P1 |
| 8 | Pioneer DDJ-REV5 / REV7 | M, A4 | ✖? | ◐ | ◐ | ◐ | ◐ | REV7 motorised platters and jog screens ✖; REV5 stems pads ✔ | ✖ | Community capture | P3 |
| 9 | Pioneer DDJ-800 / DDJ-1000 | M, A4 | ✖? | ✔ | ✔ | ◐ | ◐ | DDJ-1000 on-jog display ✖ | ✖ | Community capture | P2 |
| 10 | Pioneer XDJ-RX3 (PC mode) | M (+HID), A4 | ✔ [MIDI list (JP)](https://www.pioneerdj.com/-/media/pioneerdj/software-info/system/xdj-rx3/xdj-rx3_midi_message_list_j1.pdf) | ✔ | ✔ | ✖ (practically) | ◐ | Screen not drivable | ✖ | Chart | P2 |
| 11 | Pioneer XDJ-XZ / XDJ-AZ / Opus Quad | M, A4 | ✔ [XDJ-AZ](https://www.pioneerdj.com/-/media/pioneerdj/software-info/system/xdj-az/xdj-az_midi_message_list_e1.pdf), [Opus Quad](https://www.pioneerdj.com/-/media/pioneerdj/software-info/system/opus-quad/en/opus-quad_midi_message_list_e1.pdf); XDJ-XZ ? | ✔ | ✔ | ✖ | ◐ | 4-deck | ✖ | Chart | P3 |
| 12 | Pioneer CDJ-3000 / DJM-A9 | MIDI mode ?, HID (closed); Pro DJ Link | ? | ◐ | ◐ | ✖ | ✖ | Status via Pro DJ Link ✔ | CDJ HID (old models) | Pro DJ Link (§7) | P3 |
| 13 | Numark Mixtrack Platinum FX | M, A4 | ✖ | ✔ | ✔ | ✔ adapter | ✔ | Jog displays ✔ (MIDI); SysEx init and status | ✔ | Capture | P0 |
| 14 | Numark Mixtrack Pro FX | M, A4 | ✖ | ✔ | ✔ | ✔ | ✔ | Pads, FX paddles | ✔ | Capture | P0 |
| 15 | Numark Party Mix (II / Live) | M, A? (Live has speakers) | ✖ | ✔ | ✔ | ✔ | ✔ | Party lights; Live BLE? | ✔ (Party Mix) | Capture | P1 |
| 16 | Numark NS4FX | M, A4 | ✖ | ✔ | ✔ | ◐ | ◐ | 4-deck, jog displays? | ✔ | Community | P2 |
| 17 | Hercules DJControl Inpulse 200 (MK2) | M, A4 | ✖ | ✔ | ✔ | ✔ | ✔ | Beatmatch guide LEDs | ✔ (200) | Capture | P0 |
| 18 | Hercules DJControl Inpulse 300 (MK2) | M, A4 | ✖ | ✔ | ✔ | ✔ | ✔ | Pads, beatmatch LEDs | ✔ (300) | Capture | P0 |
| 19 | Hercules DJControl Inpulse 500 / T7 | M, A4 + inputs | ✖ | ✔ | ✔ | ◐ | ◐ | T7 motorised platter (P3) | ✔ (500) | Capture | P1 (500), P3 (T7) |
| 20 | Hercules DJControl Mix / Mix Ultra | B (USB for power; Ultra USB MIDI ?) | ✖ | ◐ (BLE path §7) | ◐ | ✔ BLE | ✔ BLE | Phone-first, small jogs | ✔ (Mix) | Capture | P0 |
| 21 | NI Traktor Kontrol S2 MK3 / S3 | H, A4 | ✖ | ✔ (WebHID driver) | ✔ (Chromium) | ✖ | ◐ (USB host HID bridge) | RGB-ish LEDs via HID reports | ✔ (.hid, script) | HID capture + driver | P2 |
| 22 | NI Traktor Kontrol S4 MK3 / Z1 / F1 / X1 | H (X1 M), A4 | ✖ | ◐ (screens WebUSB?, motors ✖ initially) | ◐ | ✖ | ◐ | Haptic jogs, screens (bulk) | ✔ (.hid/.bulk) | Community | P3 |
| 23 | Denon DJ MC7000 / MC6000MK2 | M, A4 | ✖ ([forum](https://community.enginedj.com/t/midi-implementation-documentation/3300)) | ✔ | ✔ | ◐ | ◐ | SysEx status; 4-deck | ✔ | Community | P2 |
| 24 | Denon DJ SC Live 2/4, Prime Go(+)/4+ (computer mode) | M? A? | ✖ | ◐ | ◐ | ✖? | ◐? | Screens ✖ | ✖ | Community (verify the mode) | P3 |
| 25 | Rane One / Four | M? (Serato-centric), A4 | ✖ | ◐ | ◐ | ✖ | ◐ | Motorised platter (One) ✖ initially | ✖ | Community | P3 |
| 26 | Reloop Mixon 8 Pro / Ready / Buddy | M (Windows driver for Mixon), A4 | ✖ | ✔ | ✔ | ◐ (Buddy ✔ USB-C) | ◐ | Stems pads (Mixon) | ✖ (Mixage only) | Community | P2 |
| 27 | Roland DJ-202 / DJ-505 / DJ-707M | M, A4 | ✔ [DJ-707M chart](https://www.bax-shop.nl/downloads/products/9000-0054-9324/dj-707m_midi_imple_chart_eng01_w.pdf); 202/505 ? | ✔ | ✔ | ◐ | ◐ | Built-in TR drum machine (MIDI clock in sync: use OpenDJ's clock out) | ✔ (505) | Chart | P2 |
| 28 | Behringer CMD Micro / Studio 4a / DDM4000 | M | ? (manuals) | ✔ | ✔ | ✔ | ✔ | Cheap; good test devices | ✔ | Chart / capture | P3 |
| 29 | Novation Launchpad X / Mini MK3, Launch Control XL | M (RGB SysEx) | ✔ [LPX ref](https://fael-downloads-prod.focusrite.com/customer/test/s3fs-public/downloads/Launchpad%20X%20-%20Programmers%20Reference%20Manual.pdf), [LCXL](https://fael-downloads-prod.focusrite.com/customer/prod/downloads/launch_control_xl_programmer_s_reference_guide.pdf) | ✔ | ✔ | ✔ | ✔ | RGB pads | ✔ (older models) | Chart | P1 (pads) |
| 30 | Ableton Push 2 / Akai APC | M + bulk display | ✔ [push-interface](https://www.github.com/Ableton/push-interface), [APC Key 25 mk2](https://cdn.inmusicbrands.com/akai/attachments/APC%20Key%2025%20mk2%20-%20Communication%20Protocol%20-%20v1.1.pdf) | ✔ | ✔ | ✔ (MIDI) | ✔ | Push display ◐ desktop | ✖ | Chart | P2 |

**Why mobile feasibility is ◐ for big units:** iPhones cannot bus-power large controllers, and many need a powered hub or their own PSU **(unverified per unit)**. iOS cannot reach HID.

**"Top 15" for first-party mappings:** rows 1, 2, 3, 4, 5, 7, 13, 14, 15, 17, 18, 19 (500), 20, 29, and one of 21 (S2 MK3, as the HID pilot) or 27 (DJ-202), depending on which hardware arrives first.

---

## 9. Phased roadmap

**Effort:** S ≤ 1 week, M 1–3 weeks, L 3–8 weeks (one developer).

### Phase 0: Foundations (M–L)
**Scope:**
- the v2 schema and compiler (v1-compatible)
- SysEx opt-in
- MIDI timestamps
- soft takeover
- shift/per-side layers and deck banks
- colour palettes
- init/keep-alive/shutdown
- identity probing
- the capture recorder
- the replay harness
- a JSON schema file
- contributor docs

**Files:**
- Add:
  - `public/js/midi/mapping-v2.js` (schema, compile, validate)
  - `public/js/midi/conditions.js`
  - `public/js/midi/takeover.js`
  - `public/js/midi/identify.js`
  - `public/js/midi/capture.js`
  - `public/js/midi/mappings/index.json`
  - `docs/mapping-schema.json`
  - `docs/CONTROLLERS.md` (contributor guide, "works with" wording rules)
  - `.github/ISSUE_TEMPLATE/controller-mapping.yml`
  - `scripts/test-mappings.mjs`
  - `test/fixtures/controllers/`
- Change:
  - `public/js/midi/midi.js`: dispatch via compiled tables, `e.timeStamp`, SysEx, output plans, keep-alive timers
  - `public/js/midi/presets.js`: becomes a loader for `mappings/*.json`; the DDJ-400 preset is rewritten from a capture after its provenance is checked
  - `public/js/ui/controllers-panel.js`: layer tabs, takeover, record capture
  - `public/js/midi/mixxx.js`: map shift functions to the shift layer, `soft-takeover` option → `takeover`
  - `package.json`: add `test:mappings` to `test:e2e`

**Tests:** unit tests for compiler, conditions, takeover, palettes and identity; replay of synthetic fixtures; the existing e2e still passes with v1 mappings.

**Acceptance:**
- every v1 mapping and Mixxx import behaves identically (golden replay)
- a v2 sample mapping with shift and banks passes replay
- SysEx init and keep-alive go out on schedule in the stubbed e2e

### Phase 1: First-party mappings, batch 1 (L, hardware-bound)
**Scope:** DDJ-FLX4, DDJ-400, DDJ-FLX2, DDJ-200, Mixtrack Platinum FX (including jog displays), Mixtrack Pro FX, Inpulse 200/300/500, DJControl Mix, Party Mix, Launchpad X. The plug-and-play prompt and controller → audio association.

**Files:** `public/js/midi/mappings/*.json`; `public/js/midi/drivers/numark-jog-display.js`; `public/js/midi/midi.js` `offerMapping` (bundled-first); `public/js/audio/engine.js`/settings (apply a controller's audio profile); `public/js/ui/dialogs.js` (Audio prompt).

**Tests:** per-device capture fixtures and golden LED streams; a hardware checklist signed off in each PR.

**Acceptance:** each device has 100 % of its `controls` mapped or explicitly marked unsupported, takeover on tempo/FX, correct LEDs, the audio prompt works on desktop (Windows, macOS, Linux), and verified by an owner.

### Phase 2: Mobile MIDI (L)
**Scope:**
- the Android WebView spike (S)
- the `capacitor-opendj-midi` plugin (iOS CoreMIDI + BLE picker; Android `MidiManager` USB + BLE scan)
- `native-midi-polyfill.js`
- un-hide controllers on mobile
- BLE pairing UI
- latency readout
- documentation

**Files:**
- Add: `mobile/plugins/capacitor-opendj-midi/{ios,android,src}`, `public/js/midi/native-midi-polyfill.js`
- Change: `public/js/platform.js` (remove `midi` from `MOBILE_UNAVAILABLE` when the bridge is present), `docs/MOBILE.md`, `mobile/ios/App/App/Info.plist` (Bluetooth string), Android manifest (permissions, uses-feature), `capacitor.config.json`, `scripts/e2e-mobile.mjs` (fake bridge)

**Tests:** polyfill contract unit tests; fake-bridge e2e; manual device matrix (§5.8).

**Acceptance:**
- DDJ-200 and DJControl Mix over BLE, and FLX4 and Mixtrack over USB, control decks on an iPhone and an Android phone
- LEDs work
- BLE reconnects after backgrounding
- median input-to-action latency ≤ 10 ms on USB, ≤ 25 ms on BLE (measured)

### Phase 3: Performance features (M–L)
**Scope:**
- position-mode scratching with the alpha-beta filter and per-device `ticksPerRev` calibration
- jog release ramp
- FX unit targets
- stems pad mode
- velocity pads
- needle search
- VU scaling
- 4-deck banks for FLX6, NS4FX and MC7000

**Files:** `public/js/midi/jog.js` (new), `public/js/audio/deck.js` (`jogScratch` → position API), `public/js/audio/worklets.js` (position-follow filter), `public/js/midi/midi.js` `buildTargets` (new targets), `scripts/e2e-controllers.mjs` (virtual scratch test).

**Acceptance:** the synthetic baby-scratch error is below 5 ms RMS; no audible clicks in the e2e PCM tap; owners of the FLX4 and Mixtrack rate scratch "comparable to Serato/rekordbox" in a blind-ish test.

### Phase 4: Editor and imports (M)
**Scope:** the full mapping editor (layers, banks, palettes, diff vs bundled, test mode), rekordbox CSV import, a "Submit to OpenDJ" issue link, the keyboard mapping editor.

**Files:** `public/js/ui/controllers-panel.js` (split into `controllers-editor.js`), `public/js/midi/import-rekordbox.js`, `public/js/midi/keyboard.js`.

**Acceptance:** a user can build a shift-layered 2-deck mapping from scratch without editing JSON; round-trip export/import is lossless.

### Phase 5: HID drivers (L)
**Scope:** a declarative HID report schema (input fields, LED output reports); NI S2 MK3 and S3 drivers from our own captures; Android USB-HID bridge (optional); iOS documented as unsupported.

**Files:** `public/js/midi/hid.js` (driver hooks, output reports), `public/js/midi/drivers/ni-s2mk3.js`, `ni-s3.js`, `electron/main.js` (chooser filters for known VIDs).

**Acceptance:** an S2 MK3 is fully mapped with LEDs on Windows, macOS and Linux (udev rule documented).

### Phase 6: Other hardware (M each)
- **Stream Deck:** a WebHID page with rendered keys.
- **OSC-in:** `server/osc-in.js` plus a WebSocket relay to the client, and a CC0 TouchOSC layout.
- **Pro DJ Link status:** `server/prolink.js` with `prolink-connect` (desktop/Docker only) and a UI badge "CDJ 2: 124.0 BPM on air".
- **Web Bluetooth MIDI on desktop:** `public/js/midi/ble-midi.js`, with `electron/main.js` handling `select-bluetooth-device`.
- **Push 2 / S4 MK3 displays via WebUSB:** experimental.

**Acceptance:** per feature; for licences, a `THIRD_PARTY_NOTICES.md` entry for each new dependency.

### Risks
| Risk | Mitigation |
|---|---|
| **No hardware access** | Community tester programme (§10); capture-first workflow so remote owners can contribute; mark mappings `community` until verified |
| **Proprietary protocols** (Pioneer jog displays, NI motors and screens, Rane motors, CDJ HID) | Out of scope unless documented; no circumvention of handshakes or encryption; interoperability-only reverse engineering of plain HID/MIDI captures (EU Software Directive art. 6 and US DMCA §1201(f) allow interoperability in many cases, **(unverified legal opinion; get advice before any HID protocol work that involves authentication)**) |
| **GPL contamination** | No Mixxx file or script content in the repo; provenance field; PR checklist; CI grep |
| **Licences of new dependencies** | Prefer zero new runtime deps; `prolink-connect` MIT (server only); `@elgato-stream-deck/webhid` MIT (pin and verify) |
| **Trademarks** | Never use vendor logos or trade dress; write "works with Pioneer DJ DDJ-FLX4" (nominative use); no claims of endorsement; product names only in mapping metadata and docs |
| **Firmware changes** break mappings | `provenance.firmware` field and "firmware ≥ x" check; replay fixtures per firmware |
| **Mobile bridge latency** | Coalescing, timestamps, USB recommended for scratching |
| **Browser SysEx prompt** scares users | Request SysEx only when the mapping needs it; explain beforehand |
| **Android fragmentation** (Samsung WebView quirks, BLE bugs) | Native plugin path does not depend on WebView Web MIDI; device test matrix |

---

## 10. Needs real hardware

**Must test on a device before shipping as "verified":**
- every P0/P1 mapping (rows 1–5, 7, 13–15, 17–20, 29)
- jog `ticksPerRev` and touch
- SysEx keep-alive and init (FLX4)
- status-dump (Numark)
- jog displays (Mixtrack Platinum FX)
- the 4-channel audio enumeration on Windows, macOS and Linux for FLX4, Inpulse, Mixtrack and S2 MK3
- BLE pairing and reconnect: DDJ-200 and DJControl Mix on iOS and Android
- USB bus power from an iPhone and an Android phone per controller
- the Android WebView native Web MIDI spike (Pixel and Samsung)
- scratch feel
- NI S2 MK3 / S3 HID reports
- the Pro DJ Link status read with at least 2 CDJs or an XDJ
- Stream Deck (one model)
- Launchpad X RGB

**How to source devices and testers:**
1. **Community tester programme.** A `docs/CONTROLLERS.md` "Wanted" table lists devices with no verified tester. Owners run the capture tool and the 15-minute checklist and are credited in the mapping's `testedBy`.
2. **Buy cheap or used units** for the P0 set. Most are inexpensive on the used market. Budget with the owner; maybe crowdfund via GitHub Sponsors or Open Collective.
3. **Ask vendors** for loaner or demo units and, where missing, MIDI charts. Pioneer, Hercules (DJUCED team), inMusic and Reloop have supported third-party software before. Ask for permission to *link* their charts, not to host them.
4. **Local DJ schools and shops:** a one-day "mapping sprint" with a laptop running the recorder.
5. **CI never needs hardware:** captures plus replay keep regressions out.

---

## 11. Unverified items (to confirm)

1. Whether Pioneer publishes MIDI message lists for the DDJ-FLX2/FLX4/FLX6/FLX10, REV1/5/7, DDJ-400/800/1000, XDJ-XZ and CDJ-3000. pioneerdj.com was not reachable from the research sandbox. An English XDJ-RX3 edition is likely but unconfirmed.
2. Whether Hercules, Numark, Denon, Reloop or Rane publish any MIDI charts (none found).
3. The DDJ-FLX2's Bluetooth support and whether it has an audio interface; the Hercules Mix Ultra's USB MIDI; the Numark Party Mix Live's BLE support.
4. Denon SC Live / Prime computer-mode interface details; the Rane One/Four interface (MIDI vs HID).
5. SysEx manufacturer IDs and USB VIDs listed in §4.2, other than Roland, Akai, Novation, NI and Ableton.
6. Android WebView behaviour for `requestMIDIAccess` today (MDN says it mirrors Chrome, but WebView permissions and Samsung behaviour are unclear).
7. Capacitor bridge latency numbers and BLE latency on current phones.
8. iOS Gamepad API availability inside WKWebView for OpenDJ's setup.
9. Windows Chromium's handling of 4-channel class-compliant devices (one 4-channel endpoint vs two stereo); Linux PipeWire profiles; mobile WebView `maxChannelCount`.
10. Windows BLE MIDI reachability from Chromium's Web MIDI (Windows MIDI Services' BLE transport is preview).
11. The licence of Ableton's `push-interface` repo and of mizuhiki's WebMIDIAPIShimForiOS / `cordova-plugin-webmidi`.
12. `prolink-connect`'s licence from its own LICENSE file (MIT per aggregators) and its maintenance status (last push Dec 2024).
13. `@elgato-stream-deck/webhid` licence from the package itself (MIT per Yarn listing).
14. WebUSB access to NI S4 MK3 and Push 2 bulk display endpoints on each OS.
15. Legal points: facts in MIDI charts are not protected (US *Feist*; EU database right unlikely to apply); interoperability reverse-engineering scope.
16. The provenance of the current `presets.js` DDJ-400 entries (written independently or transcribed from Mixxx).
17. The rekordbox MIDI LEARN CSV column schema (export a file to confirm).
18. CDJ HID protocol availability (vendor SDK under NDA is assumed).

---

### Sources
- Mixxx: [FLX4 manual](https://manual.mixxx.org/2.6/sq/hardware/controllers/pioneer_ddj_flx4), [S4 MK3](https://manual.mixxx.org/2.7/gl/hardware/controllers/native_instruments_traktor_kontrol_s4_mk3), [S3](https://manual.mixxx.org/2.4/en/hardware/controllers/native_instruments_traktor_kontrol_s3), [S2 MK3](https://manual.mixxx.org/2.5/de/hardware/controllers/native_instruments_traktor_kontrol_s2_mk3), [Mixtrack Platinum FX](https://manual.mixxx.org/2.6/de/hardware/controllers/numark_mixtrack_platinum_fx), [Contributing Mappings](https://github.com/mixxxdj/mixxx/wiki/Contributing%20Mappings), [MIDI mapping format](https://github.com/mixxxdj/mixxx/wiki/Midi-Controller-Mapping-File-Format), [soft takeover blueprint](https://blueprints.launchpad.net/mixxx/+spec/midi-soft-takeover)
- Pioneer / AlphaTheta: [DDJ-SR list](https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-sr/ddj-sr_list_of_midi_messages_e.pdf), [DDJ-RX list](https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-rx/ddj-rx_list_of_midi_message_e.pdf), [DDJ-SB3](https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-sb3/ddj-sb3_midi_message_list_e2.pdf), [XDJ-RX](https://www.pioneerdj.com/-/media/pioneerdj/software-info/system/xdj-rx/xdj-rx_list_of_midi_message_e_ver221.pdf), [XDJ-RX3 (JP)](https://www.pioneerdj.com/-/media/pioneerdj/software-info/system/xdj-rx3/xdj-rx3_midi_message_list_j1.pdf), [XDJ-AZ](https://www.pioneerdj.com/-/media/pioneerdj/software-info/system/xdj-az/xdj-az_midi_message_list_e1.pdf), [Opus Quad](https://www.pioneerdj.com/-/media/pioneerdj/software-info/system/opus-quad/en/opus-quad_midi_message_list_e1.pdf), [Omnis Duo](https://www.pioneerdj.com/-/media/pioneerdj/software-info/system/omnis-duo/omnis-duo_midi_message_list_e1.pdf), [FLX4 hardware diagram](https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-flx4/ddj-flx4_hardwarediagram_rekordbox_e1.pdf), [FLX2](https://alphatheta.com/en/information/introducing-ddj-flx2-compact-2-channel-dj-controller/), [FLX10](https://www.pioneerdj.com/en/product/dj-controllers/ddj-flx10/), [DDJ-200](https://www.pioneerdj.com/en/news/2019/ddj-200-smart-dj-controller), [rekordbox MIDI mapping FAQ](https://forums.pioneerdj.com/hc/en-us/articles/25240734758809-How-to-customize-rekordbox-MIDI-mapping)
- Others: [Hercules DJControl Mix](https://hercules.com/en/product/djcontrol-mix), [DJUCED Inpulse 500](https://www.djuced.com/?p=8200), [Engine DJ MC7000 thread](https://community.enginedj.com/t/midi-implementation-documentation/3300), [VirtualDJ SC Live 4](https://virtualdj.com/manuals/hardware/denon/sclive4/setup.html), [Serato Mixon 8 Pro](https://support.serato.com/hc/en-us/articles/10173655705359), [Roland DJ-707M chart](https://www.bax-shop.nl/downloads/products/9000-0054-9324/dj-707m_midi_imple_chart_eng01_w.pdf), [VirtualDJ mapping file](https://virtualdj.com/wiki/ControllerMappingFile_v8.html), [DJTechTools rekordbox CSV](https://djtechtools.com/2019/06/24/hacking-rekordbox-fx-and-adding-rmx-1000-control)
- Platforms: [MDN browser-compat-data](https://github.com/mdn/browser-compat-data), [blink-dev Web MIDI permission](https://groups.google.com/a/chromium.org/g/blink-dev/c/nz320H9J6bs), [Android MidiManager](https://developer.android.com/reference/android/media/midi/MidiManager), [android-midi BLE notes](https://groups.google.com/g/android-midi/c/chFSXKjysQA), [CABTMIDICentralViewController](https://developer.apple.com/documentation/coreaudiokit/cabtmidicentralviewcontroller.md), [QA1831](https://developer.apple.com/library/ios/qa/qa1831/_index.html), [CoreMIDI Bluetooth](https://developer.apple.com/documentation/coremidi/midi-bluetooth.md), [iPadOS DriverKit](https://developer.apple.com/documentation/driverkit/creating-drivers-for-ipados.md), [DriverKit open-source thread](https://developer.apple.com/forums/thread/818914), [Windows MIDI Services BLE](https://microsoft.github.io/MIDI/kb/ble-midi-transport-architecture/), [cordova-plugin-webmidi](https://awesome.ecosyste.ms/projects/github.com%2Frecifra%2Fcordova-plugin-webmidi), [Ionic MIDI forum](https://forum.ionicframework.com/t/need-a-midi-plugin/181775)
- Hardware integrations: [prolink-connect](https://npmjs.com/package/prolink-connect), [Push 2 interface](https://www.github.com/Ableton/push-interface), [Launchpad X reference](https://fael-downloads-prod.focusrite.com/customer/test/s3fs-public/downloads/Launchpad%20X%20-%20Programmers%20Reference%20Manual.pdf), [APC Key 25 mk2](https://cdn.inmusicbrands.com/akai/attachments/APC%20Key%2025%20mk2%20-%20Communication%20Protocol%20-%20v1.1.pdf), [node-elgato-stream-deck](https://github.com/julusian/node-elgato-stream-deck)