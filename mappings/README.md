# Community controller mappings

OpenDJ mappings for DJ controllers, made and checked by people who own them. Every file here is released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain), so it can be bundled with OpenDJ and
reused by anyone.

| File | What it is |
|---|---|
| `<Brand>/<Brand>-<Model>.opendj-midi.json` | a mapping |
| `requested.json` | controllers people want, with no mapping yet ("needs a mapping") |
| `index.json` | the controller list the app and the Controller Mapper sync from GitHub. **Generated**: run `node scripts/build-controller-mapper.mjs` |

## In OpenDJ

Community mappings are **built into the app** (`public/community-mappings.json`, generated; mappings that would take it
over 2 MB are downloaded when needed instead). When you plug in a controller without a mapping, OpenDJ recognises it
from its MIDI name:

- **Community mapping available:** it is loaded straight away (built-in DJ-400 / FLX4-style presets are replaced by it).
- **Not in the OpenDJ collection:** OpenDJ looks for a matching mapping in the Mixxx library and offers it.
- **Nothing found:** "Not supported yet: this controller needs to be mapped by hand", with **Map it now**.

With **Recognise new controllers online** on (Settings → Controller Mapper; on by default), OpenDJ checks GitHub every
6 hours for newer versions of the community mappings you use and updates them. A mapping you changed yourself is
kept; you are told that an update exists. Turning the setting off stops all of these GitHub lookups.

## The Controller Mapper

The easiest way to contribute. No git or JavaScript needed.

- **In OpenDJ:** **Settings → Controller Mapper** (also reachable from Settings → Controllers and from the message
  shown when a new controller is plugged in). It uses the app's theme.
- **Without OpenDJ:** download `OpenDJ-Controller-Mapper.html` from the
  [latest release](https://github.com/Bucifer6/OpenDJ/releases/latest) and open it in Google Chrome or Microsoft Edge.
  Close other DJ apps first: on Windows only one program can use a MIDI controller at a time.

It recognises the controller from its MIDI name and the controller list it syncs from this folder:

| The Mapper says | What you can do |
|---|---|
| **Verified** | Load the community mapping and test it. Report a problem, or fix it and submit the change. |
| **Needs verification** | Same, plus **It works: verify it** if everything works on your controller. |
| **Needs a mapping** | Run the guided setup and contribute the first mapping. |
| **Not recognised** | It asks which brand and model you have (with a guess from the MIDI name). Then map it and contribute it, or only request it. |

Inside OpenDJ, **Apply to OpenDJ** uses your changes right away, so you can fix a control that doesn't work without
waiting for anyone.

## From submission to OpenDJ

1. The Mapper opens a GitHub form (a free GitHub account is needed) with the mapping already filled in. If the
   mapping is too large for a link, it saves the file and you drag it into the form.
2. The **Controller mapping intake** workflow (`.github/workflows/mapping-intake.yml`, logic in
   `scripts/mapping-intake.mjs`) validates the mapping and opens a pull request:

   | Form | Pull request |
   |---|---|
   | New controller mapping | adds the mapping file (status *needs verification*) |
   | Fix or problem: with a mapping | replaces the mapping's controls, clears its verifications (*needs verification*) |
   | Fix or problem: report only | no pull request; labelled `needs-verification` for another owner to confirm |
   | Verify a controller mapping | adds the issue author to `contributed.verifiedBy` (not when they made or changed it) |
   | Add a controller to the list | adds it to `requested.json` |

   If something is wrong (invalid JSON, an unknown function, the CC0 box not ticked) the bot comments on the issue.
   Editing the issue runs it again.
3. A maintainer reviews and merges. The controller list (and the Mapper's built-in copy) is regenerated in the same PR.

**Verification rule:** a mapping is *verified* once someone other than its author (and anyone who changed it) has
confirmed it on their own controller. Any change resets it to *needs verification*.

### Maintainer notes

- Once: Settings → Actions → General → enable **Allow GitHub Actions to create and approve pull requests**.
- Pull requests opened by the bot don't start the test workflow by themselves (a GitHub rule for the built-in token):
  close and reopen the PR, or push to it, to run the checks before merging.
- Check that a submission doesn't look copied from another app's or manufacturer's mapping file.

## Pull requests by hand

Add your file as `mappings/<Brand>/<Brand>-<Model>.opendj-midi.json`, then run `node scripts/build-controller-mapper.mjs`
and `npm test`. The tests check every file here:

- valid JSON with `"opendjMidiMapping": 1`, a `name` and a non-empty `entries` list
- every `key` is a MIDI message (`note:<ch>:<num>`, `cc:<ch>:<num>` or `pitch:<ch>:0`, channel 0-15, number 0-127)
- every `target` is a function this version of OpenDJ has
- a `contributed` block with `brand`, `model` and `"license": "CC0-1.0"`

Please only submit mappings you made yourself on your own hardware. Don't copy mappings from other DJ software or
manufacturers' files: their licences usually don't allow it.

## File format

```json
{
  "opendjMidiMapping": 1,
  "device": "DDJ-FLX4",
  "name": "Pioneer DJ DDJ-FLX4",
  "contributed": {
    "brand": "Pioneer DJ", "model": "DDJ-FLX4", "author": "@someone", "testedOn": "Windows 11, OpenDJ 0.4.2",
    "midiNames": ["DDJ-FLX4"], "changedBy": [], "verifiedBy": ["@someone-else"], "license": "CC0-1.0"
  },
  "entries": [
    { "key": "note:0:11", "target": "deck1.play" },
    { "key": "cc:0:0", "lsbKey": "cc:0:32", "target": "deck1.tempo", "invert": true },
    { "key": "cc:0:34", "target": "deck1.jog", "rel": "offset" }
  ]
}
```

`device` and `midiNames` are the MIDI port names used to recognise the controller. Entry options: `lsbKey` (14-bit
faders), `invert`, `rel` (`offset`, `twos`, `wrap` or `auto`, for jog wheels and endless encoders) and `noLed`. See the
top of [`public/js/midi/midi.js`](../public/js/midi/midi.js). OpenDJ itself imports these files unchanged (Settings →
Controllers → Import).
