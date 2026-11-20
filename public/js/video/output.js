// Pop-out video output window (projector / second screen).
// The popup (public/video.html) grabs the master canvas stream from window.opener.__opendjVideo,
// and receives YouTube layer state by postMessage to drive its own muted IFrame player.

export class OutputManager {
  constructor(mixer, youtube) {
    this.mixer = mixer; this.youtube = youtube; this.win = null; this._poll = null;
    window.__opendjVideo = {
      version: 1,
      attach: (w) => { this.win = w; this.mixer.addOutput('popup'); this.startPoll(); this.sendYt(true); return { stream: this.mixer.stream(), width: this.mixer.canvas.width, height: this.mixer.canvas.height }; },
      detach: (w) => { if (w === this.win) this.closed(); },
    };
    youtube?.on('load', () => this.sendYt(true));
    youtube?.on('state', () => this.sendYt(true));
    youtube?.on('mode', () => this.sendYt(true));
  }

  get isOpen() { return !!this.win && !this.win.closed; }

  /** Window Management API: find a screen other than the one this window is on. */
  async otherScreen() {
    if (!('getScreenDetails' in window)) return null;
    const sd = await window.getScreenDetails(); // may prompt for permission
    return sd.screens.find((s) => s !== sd.currentScreen && !s.isPrimary) || sd.screens.find((s) => s !== sd.currentScreen) || null;
  }

  static get canUseScreens() { return 'getScreenDetails' in window; }

  /**
   * @param {{secondScreen?: boolean}} opts
   * @returns {Promise<Window|null>}
   */
  async open({ secondScreen = false } = {}) {
    let features = 'popup,width=960,height=540';
    let screen = null;
    if (secondScreen) {
      screen = await this.otherScreen().catch(() => null);
      if (!screen) throw new Error(OutputManager.canUseScreens ? 'No second screen found' : 'This browser can’t place windows on other screens (Window Management API)');
      features = `popup,left=${screen.availLeft},top=${screen.availTop},width=${screen.availWidth},height=${screen.availHeight}`;
    }
    if (this.isOpen && !secondScreen) { this.win.focus(); return this.win; }
    const w = window.open('/video.html', 'opendj-video', features);
    if (!w) throw new Error('The output window was blocked. Allow pop-ups for OpenDJ.');
    this.win = w;
    if (screen) {
      try { w.moveTo(screen.availLeft, screen.availTop); w.resizeTo(screen.availWidth, screen.availHeight); } catch { /* */ }
      w.__opendjWantFullscreen = { left: screen.left, top: screen.top }; // the popup asks for fullscreen on its first click
    }
    this.startPoll();
    return w;
  }

  startPoll() {
    clearInterval(this._poll);
    this._poll = setInterval(() => {
      if (!this.isOpen) { this.closed(); return; }
      this.sendYt();
    }, 250);
  }

  sendYt(force) {
    if (!this.isOpen || !this.youtube) return;
    const s = this.youtube.videoId ? this.youtube.snapshot() : { videoId: null };
    const key = JSON.stringify([s.videoId, s.playing, Math.round((s.opacity || 0) * 100)]);
    if (!force && key === this._lastKey && Date.now() - (this._lastSent || 0) < 1000) return;
    this._lastKey = key; this._lastSent = Date.now();
    try { this.win.postMessage({ type: 'opendj-yt', ...s }, location.origin); } catch { /* */ }
  }

  closed() {
    clearInterval(this._poll); this._poll = null;
    this.win = null; this.mixer.removeOutput('popup');
    this.onClose?.();
  }

  close() { try { this.win?.close(); } catch { /* */ } this.closed(); }
}
