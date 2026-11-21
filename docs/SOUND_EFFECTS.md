# Downloadable sampler sounds

OpenDJ includes a downloadable in-app catalogue of 111 recorded one-shots from the Sonic Pi sample collection. The audio files are fetched only when a user selects one and are stored locally in that sampler pad's browser storage; they are not bundled into OpenDJ releases.

The collection README states that these files are CC0 1.0, and lists the original Freesound contributor for each sample. OpenDJ pins the source to Sonic Pi commit `ed4b23ccb77f0845cbad2b8d911cd36a455ec597`. The catalogue retains the creator and original source URL in `public/js/audio/sample-catalog.js`; those details are also saved with a loaded pad and shown in its tooltip.

The bundled catalogue deliberately omits loops. In particular, it does not include the Amen break recordings from the source collection. The sampler still accepts users' own samples through the existing file import control.

Source and licence:
- Sonic Pi sample credits and licence: https://github.com/sonic-pi-net/sonic-pi/blob/ed4b23ccb77f0845cbad2b8d911cd36a455ec597/etc/samples/README.md
- CC0 1.0: https://creativecommons.org/publicdomain/zero/1.0/
