// Text to speech for the MC voice and dedications, rendered by the operating system's own speech engine into a WAV
// file, so the page can play it through the Web Audio graph (master bus -> recording and broadcast) instead of
// speechSynthesis, which plays outside the mix.
//
//   Windows: System.Speech (SAPI 5) through PowerShell, built in. Romanian needs the "Romanian" speech voice
//            (Settings > Time & language > Speech > Add voices; Microsoft Andrei / Ioana).
//   macOS:   `say -o`, built in. Romanian voice: Ioana (System Settings > Accessibility > Spoken Content).
//   Linux:   espeak-ng (or espeak) when installed (GPL-3.0, run as a separate program, never bundled). It has
//            English and Romanian voices.
// Nothing is bundled and nothing is downloaded. Without an engine the page falls back to speechSynthesis (heard
// locally only) or shows the text, and says so.
//
// Safety: the text never appears on a command line (it goes through stdin), commands are spawned without a shell,
// the text is limited to 500 characters, one synthesis runs at a time (a short queue, then 429), each is
// time-limited and the output size is capped. Registered from server/index.js: registerTtsRoutes({ route, ... }).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const TTS_MAX_CHARS = 500;
const MAX_WAV = 24 * 1024 * 1024;
const TIMEOUT = 25000;
export const LANGS = { en: { culture: 'en-US', espeak: 'en-us', mac: /^en[_-]/i }, ro: { culture: 'ro-RO', espeak: 'ro', mac: /^ro[_-]/i } };

/** Plain spoken text: control / bidi characters removed, whitespace collapsed, clipped. */
export function cleanSpeech(v) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TTS_MAX_CHARS);
}

function run(cmd, args, { input = '', timeout = TIMEOUT, maxBytes = MAX_WAV, env } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, env: env || process.env }); } catch (e) { return reject(e); }
    const out = [], err = []; let n = 0, done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(t); fn(v); };
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } finish(reject, Object.assign(new Error('Speech engine timed out'), { code: 'ETIMEDOUT' })); }, timeout);
    p.on('error', (e) => finish(reject, e));
    p.stdout.on('data', (d) => { n += d.length; if (n > maxBytes) { try { p.kill('SIGKILL'); } catch { /* gone */ } finish(reject, new Error('Speech output too large')); } else out.push(d); });
    p.stderr.on('data', (d) => { if (err.length < 50) err.push(d); });
    p.on('close', (code) => (code === 0 ? finish(resolve, Buffer.concat(out)) : finish(reject, Object.assign(new Error(`Speech engine failed (${code}): ${Buffer.concat(err).toString().slice(0, 200)}`), { code: 'EFAIL' }))));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}
const tmpWav = () => path.join(os.tmpdir(), `opendj-tts-${crypto.randomBytes(8).toString('hex')}.wav`);
async function readAndRemove(file) { try { return await fs.promises.readFile(file); } finally { fs.promises.rm(file, { force: true }).catch(() => {}); } }

// ---------------------------------------------------------------- engines

// PowerShell: the JSON request comes from stdin; the script itself is constant.
const PS_LIST = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Culture.Name + "|" + $_.VoiceInfo.Name }';
const PS_SPEAK = [
  'Add-Type -AssemblyName System.Speech',
  '$r = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $r.culture } | Select-Object -First 1',
  'if (-not $v) { exit 3 }',
  '$s.SelectVoice($v.VoiceInfo.Name)',
  '$s.Rate = [int]$r.rate',
  '$s.SetOutputToWaveFile($r.out)',
  '$s.Speak([string]$r.text)',
  '$s.Dispose()',
].join('; ');
const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];

export const ENGINES = {
  sapi: {
    label: 'Windows speech (SAPI)',
    async voices() { const out = (await run('powershell.exe', psArgs(PS_LIST), { timeout: 15000 })).toString('utf8'); return out.split(/\r?\n/).filter(Boolean).map((l) => { const [culture, name] = l.split('|'); return { culture, name }; }); },
    has(voices, lang) { return voices.some((v) => v.culture?.toLowerCase() === LANGS[lang].culture.toLowerCase()); },
    async speak(text, lang) {
      const out = tmpWav();
      await run('powershell.exe', psArgs(PS_SPEAK), { input: JSON.stringify({ text, culture: LANGS[lang].culture, out, rate: 0 }) });
      return readAndRemove(out);
    },
  },
  say: {
    label: 'macOS speech (say)',
    async voices() { const out = (await run('say', ['-v', '?'], { timeout: 10000 })).toString('utf8'); return out.split('\n').map((l) => /^(.+?)\s+([a-z]{2}[_-][A-Za-z]{2,})\s+#/.exec(l)).filter(Boolean).map((m) => ({ name: m[1].trim(), culture: m[2] })); },
    has(voices, lang) { return voices.some((v) => LANGS[lang].mac.test(v.culture)); },
    async speak(text, lang, voices) {
      const v = voices.find((x) => LANGS[lang].mac.test(x.culture));
      const out = tmpWav();
      await run('say', [...(v ? ['-v', v.name] : []), '-o', out, '--file-format=WAVE', '--data-format=LEI16@22050', '-f', '-'], { input: text });
      return readAndRemove(out);
    },
  },
  espeak: {
    label: 'eSpeak NG',
    cmd: null,
    async voices() {
      for (const cmd of ['espeak-ng', 'espeak']) {
        try { const out = (await run(cmd, ['--voices'], { timeout: 8000 })).toString('utf8'); this.cmd = cmd; return out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 3).map((c) => ({ culture: c[1], name: c[3] })); } catch { /* next */ }
      }
      throw new Error('espeak-ng is not installed');
    },
    has(voices, lang) { return voices.some((v) => v.culture === LANGS[lang].espeak || v.culture?.startsWith(LANGS[lang].espeak.slice(0, 2))); },
    async speak(text, lang) { return run(this.cmd || 'espeak-ng', ['-v', LANGS[lang].espeak, '-s', '160', '--stdout', '--stdin'], { input: text }); },
  },
};

/** The engine for this platform and its voices, detected once (null when there is none). */
export function detectTts({ platform = process.platform, engines = ENGINES } = {}) {
  const order = platform === 'win32' ? ['sapi'] : platform === 'darwin' ? ['say', 'espeak'] : ['espeak'];
  return (async () => {
    for (const id of order) {
      const e = engines[id]; if (!e) continue;
      try {
        const voices = await e.voices();
        return { id, engine: e, voices, languages: Object.fromEntries(Object.keys(LANGS).map((l) => [l, !!e.has(voices, l)])) };
      } catch { /* not available */ }
    }
    return null;
  })();
}

const isWav = (b) => b.length > 44 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE';
/** Streamed WAVs (espeak-ng --stdout) carry placeholder sizes: set the RIFF and data sizes from the real length. */
export function fixWavSizes(b) {
  if (!isWav(b)) return b;
  let o = 12;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === 'data') { if (o + 8 + size > b.length) b.writeUInt32LE(b.length - o - 8, o + 4); b.writeUInt32LE(b.length - 8, 4); return b; }
    o += 8 + size + (size & 1);
  }
  return b;
}

/**
 * Routes: GET /api/tts/voices, POST /api/tts { text, lang } -> audio/wav.
 * @param {object} o  { route, httpError, detect (tests: () => Promise<detected>) }
 */
export function registerTtsRoutes({ route, httpError, detect = detectTts }) {
  let detected = null;
  const engine = () => (detected ||= detect().catch(() => null));
  let busy = 0; const waiting = [];
  const recent = [];
  const slot = async () => {
    if (busy) { if (waiting.length >= 3) throw httpError(429, 'The speech engine is busy, try again in a moment'); await new Promise((r) => waiting.push(r)); }
    busy++;
  };
  const release = () => { busy--; waiting.shift()?.(); };

  route('GET', '/api/tts/voices', async () => {
    const d = await engine();
    return d ? { engine: d.id, label: d.engine.label, languages: d.languages } : { engine: null, label: null, languages: { en: false, ro: false } };
  });
  route('POST', '/api/tts', async ({ res, body }) => {
    const text = cleanSpeech(body?.text);
    const lang = body?.lang === 'ro' ? 'ro' : 'en';
    if (!text) throw httpError(400, 'Nothing to say');
    const now = Date.now();
    while (recent.length && now - recent[0] > 60000) recent.shift();
    if (recent.length >= 30) throw httpError(429, 'Too many announcements in a minute');
    const d = await engine();
    if (!d) throw Object.assign(httpError(501, 'No speech engine on this computer'), { code: 'no-tts' });
    if (!d.languages[lang]) throw Object.assign(httpError(501, lang === 'ro' ? 'No Romanian voice is installed for the speech engine' : 'No English voice is installed for the speech engine'), { code: 'no-voice' });
    recent.push(now);
    await slot();
    let wav;
    try { wav = await d.engine.speak(text, lang, d.voices); } catch (e) {
      throw httpError(502, e.code === 'ETIMEDOUT' ? 'The speech engine took too long' : 'The speech engine could not say that');
    } finally { release(); }
    if (!isWav(wav)) throw httpError(502, 'The speech engine returned no audio');
    wav = fixWavSizes(wav);
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store' });
    res.end(wav);
    return undefined;
  }, { bodyLimit: 8 * 1024 });
}
