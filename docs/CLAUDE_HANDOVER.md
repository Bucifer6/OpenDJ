# OpenDJ handover for Claude

Target Windows portable first. PRs 11–16 cover smart Automix, portable stems setup, in-app skins, deck MIX NOW, crossfader layout and the 111-sample browser. PR 17 adds the recorded air horn and local Ollama planning. Transition length is set in bars in the Automix dialog.

Verify startup and library download frame pacing with real audio, EQ dragging and crossfader travel in narrow mixers on wide windows. Exercise repeated MIX NOW presses, queue edits and stopping during preload. Check recorded airhorn and sample persistence after restart.

Desktop planning uses electron/main.js, electron/preload.cjs and public/js/ui/dialogs.js. Ollama runs on loopback port 11434. A named installed model ranks the first 60 tracks. Test real model failures and Romanian voice availability. System speech currently plays outside the master mix.

Outstanding: route MC voice into master audio and broadcasts, add live dedications, implement authenticated web MCP control of playback and existing broadcast targets. Inspect public/js/recording/broadcaster.js and server/broadcast.js. Test in a private stream. Verify controller and vinyl skin layouts on Windows. Do not infer interactive performance from packaging CI.
