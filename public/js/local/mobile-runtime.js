// Phone behaviour of the app (local mode): audio unlock on the first touch, keeping the music going with the screen
// locked, keeping the screen on while playing, and the Android back button.
//   iOS:     Info.plist UIBackgroundModes=audio + AVAudioSession .playback (AppDelegate.swift). WebKit keeps a page
//            that is playing audio running in the background; a silent looping <audio> element marks the page as a
//            media session so it stays that way between tracks.
//   Android: a foreground service of type mediaPlayback (OpenDJAudio plugin in MainActivity) keeps the process alive
//            with a "Playing" notification while decks play or a recording runs.
//   Both:    @capacitor-community/keep-awake while playing; Media Session metadata for the lock screen.
import { wavHeader } from './recording.js';

export function startMobileRuntime({ plugins = {}, native = false, os = 'web', win = globalThis } = {}) {
  const doc = win.document;
  // ---- audio unlock: iOS / Android only start audio from a user gesture ----
  const unlock = () => { win.opendj?.engine?.resume?.(); };
  doc.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  doc.addEventListener('touchend', unlock, { capture: true, passive: true });

  // ---- playing state ----
  let silent = null, playing = false, idleSince = 0, fgService = false;
  const silentEl = () => {
    if (silent) return silent;
    const sr = 8000, secs = 2, bytes = sr * secs * 2;
    const wav = new Uint8Array(44 + bytes); wav.set(wavHeader({ sampleRate: sr, channels: 1, dataBytes: bytes }));
    silent = Object.assign(doc.createElement('audio'), { loop: true, preload: 'auto' });
    silent.setAttribute('playsinline', '');
    silent.src = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    silent.volume = 0.01;
    return silent;
  };
  const nowPlaying = (engine) => engine.decks.filter((d) => d.playing && d.track).sort((a, b) => (b.volumeOut ?? 0) - (a.volumeOut ?? 0))[0]?.track;

  const tick = () => {
    const app = win.opendj, engine = app?.engine;
    if (!engine) return;
    const active = engine.decks.some((d) => d.playing) || !!app.recording?.recording;
    if (active) idleSince = 0; else if (!idleSince) idleSince = Date.now();
    const want = active || (idleSince && Date.now() - idleSince < 20000); // keep the session through short pauses
    const t = nowPlaying(engine);
    if (t && 'mediaSession' in navigator && win.MediaMetadata) {
      const md = navigator.mediaSession.metadata;
      if (!md || md.title !== (t.title || '') || md.artist !== (t.artist || '')) navigator.mediaSession.metadata = new win.MediaMetadata({ title: t.title || '', artist: t.artist || '', album: 'OpenDJ' });
      navigator.mediaSession.playbackState = 'playing';
    }
    if (want === playing) return;
    playing = want;
    if (native) {
      if (playing) silentEl().play().catch(() => {}); else silent?.pause();
      if (playing) plugins.KeepAwake?.keepAwake().catch(() => {}); else plugins.KeepAwake?.allowSleep().catch(() => {});
      if (plugins.OpenDJAudio && os === 'android') {
        if (playing && !fgService) { fgService = true; plugins.OpenDJAudio.start({ title: 'OpenDJ is playing' }).catch(() => { fgService = false; }); }
        if (!playing && fgService) { fgService = false; plugins.OpenDJAudio.stop().catch(() => {}); }
      }
    }
    if (!playing && 'mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  };
  const timer = setInterval(tick, 1000);

  // ---- Android back button: close the top dialog / menu, never quit by accident while music plays ----
  if (native && plugins.App) {
    plugins.App.addListener('backButton', () => {
      const top = [...doc.querySelectorAll('.overlay, .ctx-menu, .rec-panel, .seq-panel')].pop();
      if (top) { doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); if (top.isConnected && top.classList.contains('ctx-menu')) top.remove(); return; }
      if (win.opendj?.engine?.decks?.some((d) => d.playing)) { win.opendj.toast?.('Music is playing: use the Home button to leave OpenDJ'); return; }
      plugins.App.minimizeApp?.().catch(() => {});
    }).catch(() => {});
  }
  return { stop: () => clearInterval(timer), tick };
}
