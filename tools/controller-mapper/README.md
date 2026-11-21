# Controller Mapper (source)

`template.html` is the source of the Controller Mapper. `node scripts/build-controller-mapper.mjs` turns it into
**`public/controller-mapper.html`**, which:

- ships inside OpenDJ (Settings → Controllers → Controller Mapper, opened with `MidiManager.openMapper()`), talking to
  the app with `postMessage` (`opendj-mapper:hello` / `:mapping` / `:apply`, same origin only)
- is attached to every release as the standalone `OpenDJ-Controller-Mapper.html`, which works when double-clicked

The build embeds OpenDJ's real function list (`buildTargets()` in `public/js/midi/midi.js`), the detection and guided
steps from `public/js/midi/wizard.js`, and a copy of `mappings/index.json`. It also writes that index and a strict
hash-based Content-Security-Policy. Edit the template, run the build, and commit both outputs: `npm test` fails when
they are out of date.

How contributions flow from the Mapper into `mappings/`: see [mappings/README.md](../../mappings/README.md).
