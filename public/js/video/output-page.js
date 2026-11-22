// Pop-out output window (public/video.html): shows the main window's master video canvas stream full-size,
// plus its own muted YouTube IFrame player kept in sync by postMessage. Black when nothing plays.
import { loadYouTubeApi } from './youtube.js';
import { initI18n } from '../i18n.js';

initI18n(); // interface language stored by the main window

const video = document.getElementById('out');
const ytBox = document.getElementById('yt');
const status = document.getElementById('status');
const bar = document.getElementById('bar');
const clickFs = document.getElementById('clickfs');
let attached = false, yt = null, ytId = null, ytReady = false;

function attach() {
  const bridge = window.opener && !window.opener.closed ? window.opener.__opendjVideo : null;
  if (!bridge) { status.textContent = 'Open this window from OpenDJ (Video → Pop-out output)'; attached = false; return; }
  try {
    const { stream, width, height, fullscreen } = bridge.attach(window);
    if (fullscreen && !document.fullscreenElement) askFullscreen();
    video.srcObject = stream;
    video.play().catch(() => {});
    attached = true;
    status.textContent = `${width}×${height}`;
  } catch (e) { status.textContent = `Not connected: ${e.message}`; attached = false; }
}

function alive() {
  const s = video.srcObject;
  return attached && s && s.getVideoTracks().some((t) => t.readyState === 'live') && window.opener && !window.opener.closed;
}

attach();
// main window reloaded / stream ended: reconnect
setInterval(() => { if (!alive()) attach(); }, 2000);
window.addEventListener('pagehide', () => { try { window.opener?.__opendjVideo?.detach(window); } catch { /* */ } });

// ---- full screen
const toggleFs = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
document.getElementById('fs').addEventListener('click', toggleFs);
document.addEventListener('dblclick', toggleFs);
document.addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F') toggleFs(); });
function askFullscreen() {
  // a new window can't enter full screen by itself: try (works with a fresh user activation), else ask for a click
  document.documentElement.requestFullscreen().catch(() => {
    clickFs.hidden = false;
    const go = () => { clickFs.hidden = true; document.documentElement.requestFullscreen().catch(() => {}); document.removeEventListener('pointerdown', go); };
    document.addEventListener('pointerdown', go);
  });
}
document.addEventListener('fullscreenchange', () => { clickFs.hidden = true; });

// auto-hide the toolbar + cursor
let idle;
const wake = () => { bar.classList.remove('hidden'); document.body.classList.remove('idle'); clearTimeout(idle); idle = setTimeout(() => { bar.classList.add('hidden'); document.body.classList.add('idle'); }, 2500); };
document.addEventListener('pointermove', wake); wake();

// ---- YouTube layer (own muted player; audio, if any, only plays in the main window's jukebox player)
window.addEventListener('message', async (e) => {
  if (e.origin !== location.origin || e.data?.type !== 'opendj-yt') return;
  const s = e.data;
  if (!s.videoId) { if (yt) { try { yt.destroy(); } catch { /* */ } yt = null; ytId = null; ytReady = false; ytBox.replaceChildren(); } return; }
  ytBox.style.opacity = String(s.opacity ?? 0);
  if (ytId !== s.videoId) {
    ytId = s.videoId; ytReady = false;
    const YT = await loadYouTubeApi(window).catch(() => null);
    if (!YT) return;
    if (yt) { yt.loadVideoById({ videoId: s.videoId, startSeconds: s.time || 0 }); ytReady = true; return; }
    const div = document.createElement('div'); ytBox.replaceChildren(div);
    yt = new YT.Player(div, {
      host: 'https://www.youtube-nocookie.com', videoId: s.videoId, width: '100%', height: '100%',
      playerVars: { autoplay: 1, mute: 1, playsinline: 1, controls: 0, rel: 0, start: Math.floor(s.time || 0), origin: location.origin },
      events: { onReady: () => { yt.mute(); ytReady = true; follow(s); } },
    });
    return;
  }
  if (ytReady) follow(s);
});

function follow(s) {
  try {
    const st = yt.getPlayerState();
    if (s.playing && st !== 1 && st !== 3) yt.playVideo();
    if (!s.playing && st === 1) yt.pauseVideo();
    if (yt.getPlaybackRate() !== s.rate && s.rate) yt.setPlaybackRate(s.rate);
    const target = s.time + (s.playing ? (Date.now() - s.at) / 1000 * (s.rate || 1) : 0);
    if (Math.abs(yt.getCurrentTime() - target) > 0.4) yt.seekTo(target, true);
  } catch { /* player not ready */ }
}
