// MC voice: spoken announcements and dedications over the mix.
//
// Preferred path ("mix"): the OpenDJ server renders the text with the operating system's speech engine
// (server/tts.js: SAPI on Windows, `say` on macOS, espeak-ng on Linux) into a WAV, and it plays here through the Web
// Audio graph: voice gain -> engine.voiceInput() (the master bus, after the music duck). So it is heard in the
// master output, recorded and broadcast, and the music is ducked under it (talkover).
// Fallback ("local"): speechSynthesis, which plays outside the mix: heard on this computer's default output only,
// not recorded or broadcast. Used when the server has no speech engine / voice (mobile app, hosted server).
// Last resort ("text"): no voice for the language (e.g. no Romanian voice installed): the caller shows the text.
import { Emitter } from '../util.js';

export const VOICE_LANGS = { en: { label: 'English', bcp47: 'en-GB' }, ro: { label: 'Română', bcp47: 'ro-RO' } };

/** Best speechSynthesis voice for a language ('en' | 'ro'), or null. Exact region first, then any of the language. */
export function pickVoice(voices, lang) {
  const want = (VOICE_LANGS[lang] || VOICE_LANGS.en).bcp47.toLowerCase(), base = want.slice(0, 2);
  const norm = (v) => String(v?.lang || '').replace('_', '-').toLowerCase();
  const list = Array.from(voices || []);
  return list.find((v) => norm(v) === want && v.localService) || list.find((v) => norm(v) === want)
    || list.find((v) => norm(v).startsWith(base + '-') || norm(v) === base) || null;
}

/** speechSynthesis voices; Chromium fills the list asynchronously (voiceschanged), so wait a little for it. */
export function synthVoices(timeout = 1200) {
  const ss = globalThis.speechSynthesis;
  if (!ss) return Promise.resolve([]);
  const now = ss.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); ss.removeEventListener?.('voiceschanged', done); resolve(ss.getVoices()); };
    const t = setTimeout(done, timeout);
    ss.addEventListener?.('voiceschanged', done);
  });
}

export class VoiceBus extends Emitter {
  /** @param {object} engine  the app's Engine (ctx, duck, voiceInput(), settings, talkover) */
  constructor(engine, { fetchImpl = (...a) => fetch(...a) } = {}) {
    super();
    this.engine = engine; this.fetch = fetchImpl;
    this.active = 0; this.sources = new Set(); this._caps = null;
    this.out = null;
    engine.on?.('master', (key) => { if (key === 'talkover' && this.active) this._applyDuck(); });
  }
  get ctx() { return this.engine.ctx; }
  _output() {
    if (!this.out) {
      const c = this.ctx;
      this.out = c.createGain(); this.out.gain.value = Number(this.engine.settings?.voiceVolume ?? 1);
      // gentle presence lift and a compressor so speech sits on top of a loud mix
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
      const pres = c.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3000; pres.Q.value = 0.8; pres.gain.value = 3;
      const comp = c.createDynamicsCompressor(); comp.threshold.value = -22; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
      this.out.connect(hp); hp.connect(pres); pres.connect(comp);
      this.meter = c.createAnalyser(); this.meter.fftSize = 1024; comp.connect(this.meter);
      this._target = this.engine.voiceInput?.() || this.engine.masterBus;
      comp.connect(this._target);
    }
    return this.out;
  }
  duckLevel() { const db = Number(this.engine.settings?.voiceDuckDb ?? this.engine.settings?.talkoverDb ?? -12); return Math.pow(10, Math.min(0, db) / 20); }
  _applyDuck(at = this.ctx.currentTime) {
    const g = this.engine.duck?.gain; if (!g) return;
    const on = this.active > 0 || this.engine.talkover;
    const talk = Math.pow(10, (this.engine.settings?.talkoverDb ?? -12) / 20);
    const level = this.active > 0 ? Math.min(this.duckLevel(), this.engine.talkover ? talk : 1) : (this.engine.talkover ? talk : 1);
    g.cancelScheduledValues(at);
    g.setTargetAtTime(on ? level : 1, at, on ? 0.06 : 0.3);
  }

  /** What this install can do: { mix: { en, ro, engine }, local: { en, ro } }. Cached for a minute. */
  async capabilities({ fresh = false } = {}) {
    if (!fresh && this._caps && Date.now() - this._caps.at < 60000) return this._caps.v;
    let mix = { engine: null, label: null, en: false, ro: false };
    try {
      const r = await this.fetch('/api/tts/voices', { credentials: 'same-origin' });
      if (r.ok) { const j = await r.json(); mix = { engine: j.engine, label: j.label, en: !!j.languages?.en, ro: !!j.languages?.ro }; }
    } catch { /* no server (mobile app) */ }
    const voices = await synthVoices();
    const local = { en: !!pickVoice(voices, 'en'), ro: !!pickVoice(voices, 'ro'), any: voices.length > 0 };
    const v = { mix, local };
    this._caps = { at: Date.now(), v };
    return v;
  }

  /** Render text to an AudioBuffer through the server's speech engine. Throws with .code 'no-tts' / 'no-voice'. */
  async render(text, lang = 'en') {
    let r;
    try { r = await this.fetch('/api/tts', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, lang }) }); }
    catch { throw Object.assign(new Error('No speech engine available'), { code: 'no-tts' }); }
    if (!r.ok) {
      let j = {}; try { j = await r.json(); } catch { /* not JSON */ }
      throw Object.assign(new Error(j.error || `Speech failed (HTTP ${r.status})`), { code: j.code || (r.status === 404 ? 'no-tts' : 'tts-failed'), status: r.status });
    }
    return this.ctx.decodeAudioData(await r.arrayBuffer());
  }

  /**
   * Play a rendered voice buffer at AudioContext time `at` (0 = now), ducking the music under it.
   * @returns {{ start: number, end: number, done: Promise<void> }}
   */
  play(buffer, { at = 0, duck = true } = {}) {
    const c = this.ctx, out = this._output();
    const start = Math.max(c.currentTime + 0.05, at || 0), end = start + buffer.duration;
    const src = c.createBufferSource(); src.buffer = buffer; src.connect(out);
    src.start(start);
    this.sources.add(src);
    if (duck) {
      this.active++;
      // the duck starts a little before the voice and lets go after it
      const g = this.engine.duck?.gain;
      if (g) { g.cancelScheduledValues(c.currentTime); g.setTargetAtTime(this.duckLevel(), Math.max(c.currentTime, start - 0.25), 0.06); }
    }
    this.emit('start', { start, end });
    const done = new Promise((resolve) => {
      src.onended = () => {
        this.sources.delete(src);
        if (duck) { this.active = Math.max(0, this.active - 1); if (!this.active) this._applyDuck(c.currentTime + 0.15); }
        this.emit('end');
        resolve();
      };
    });
    return { start, end, done };
  }

  /** Stop every voice now (and release the duck). */
  stop() {
    for (const s of this.sources) { try { s.stop(); } catch { /* not started */ } }
    globalThis.speechSynthesis?.cancel?.();
  }

  /** Voice level now (0..1 peak), for tests / meters. */
  level() { if (!this.meter) return 0; const b = (this._b ||= new Float32Array(1024)); this.meter.getFloatTimeDomainData(b); let p = 0; for (const v of b) p = Math.max(p, Math.abs(v)); return p; }

  /**
   * Speak through speechSynthesis (outside the mix). Ducks the music while it talks. Resolves when finished;
   * returns false when there is no voice for the language.
   */
  async speakLocal(text, lang = 'en') {
    const ss = globalThis.speechSynthesis;
    if (!ss || typeof SpeechSynthesisUtterance === 'undefined') return false;
    const voice = pickVoice(await synthVoices(), lang);
    if (!voice) return false;
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice; u.lang = voice.lang || VOICE_LANGS[lang]?.bcp47;
    this.active++; this._applyDuck();
    await new Promise((resolve) => {
      const fin = () => { clearTimeout(t); resolve(); };
      const t = setTimeout(fin, 4000 + text.length * 150); // engines that never fire onend
      u.onend = fin; u.onerror = fin;
      ss.speak(u);
    });
    this.active = Math.max(0, this.active - 1); this._applyDuck();
    return true;
  }

  /**
   * Prepare an announcement: { mode: 'mix', buffer } | { mode: 'local' } | { mode: 'text', reason }.
   * Prefers the mix path, then speechSynthesis, then text only.
   */
  async prepare(text, lang = 'en') {
    try { return { mode: 'mix', buffer: await this.render(text, lang) }; } catch (e) {
      const caps = await this.capabilities();
      if (caps.local[lang]) return { mode: 'local', reason: e.message };
      const name = VOICE_LANGS[lang]?.label || lang;
      return { mode: 'text', reason: e.code === 'no-voice' || caps.local.any ? `No ${name} voice is installed on this computer` : 'No speech engine is available on this computer' };
    }
  }

  /** Prepare and speak now (or at `at`). Returns { mode, reason?, end? } once it has started (mix) or finished (local). */
  async say(text, { lang = 'en', at = 0 } = {}) {
    const p = await this.prepare(text, lang);
    if (p.mode === 'mix') { const r = this.play(p.buffer, { at }); return { mode: 'mix', start: r.start, end: r.end, done: r.done }; }
    if (p.mode === 'local') { await this.speakLocal(text, lang); return { mode: 'local', reason: p.reason }; }
    return p;
  }
}
