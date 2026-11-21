# Controller Mapper (source)

`template.html` is the source of the Controller Mapper. `node scripts/build-controller-mapper.mjs` turns it into
**`public/controller-mapper.html`**, which:

- ships inside OpenDJ as the **Settings → Controller Mapper** tab (an iframe; `MidiManager.openMapper()` switches to
  it). It copies the app's design tokens so it matches the current theme, and talks to the app with `postMessage`
  (`opendj-mapper:hello` / `:mapping` / `:apply`, same origin only). While it listens to a controller, the app ignores
  that controller so mapping a button doesn't also play a deck.
- is attached to every release as the standalone `OpenDJ-Controller-Mapper.html`, which works when double-clicked

Controller recognition (`public/js/midi/community.js`) is shared by the app and the page.
The build embeds OpenDJ's real function list (`buildTargets()` in `public/js/midi/midi.js`), the detection and guided
steps from `public/js/midi/wizard.js`, and a copy of `mappings/index.json`. It also writes that index, `public/community-mappings.json` (the mappings built into the app) and a strict
hash-based Content-Security-Policy. Edit the template, run the build, and commit both outputs: `npm test` fails when
they are out of date.

How contributions flow from the Mapper into `mappings/`: see [mappings/README.md](../../mappings/README.md).
