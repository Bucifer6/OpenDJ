// Text-to-speech: Piper (local, Romanian voice) + an FFmpeg effect chain per persona style.
// Without Piper the announcements are text-only (shown in OpenDJ and on the listeners' page).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, DATA } from './store.js';

// Voice "styles". Real singing is not possible with TTS: these give a declaimed, wedding-mic / MC feel.
// Every style ends in loudness normalisation (LOUD), so the voice sits at the level of a mastered track.
export const FX = {
  radio: 'highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=80:makeup=2',
  mc: 'highpass=f=90,acompressor=threshold=-22dB:ratio=4:attack=3:release=60:makeup=2,aecho=0.9:0.5:70:0.08',
  lautar: 'asetrate=44100*1.03,aresample=44100,atempo=0.97,highpass=f=110,acompressor=threshold=-20dB:ratio=3:makeup=2,aecho=0.9:0.55:60:0.12',
  manele: 'asetrate=44100*1.05,aresample=44100,atempo=0.95,highpass=f=120,chorus=0.7:0.9:40:0.25:0.25:2,acompressor=threshold=-22dB:ratio=4:makeup=2,aecho=0.9:0.55:55:0.12',
};
const LOUD = 'loudnorm=I=-14:TP=-2:LRA=7'; // headroom: peaks stay below the master limiter

const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

// Natural (neural) voices already have prosody: no pitch/tempo tricks, only "mic" colour.
export const FX_NATURAL = {
  radio: 'highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=80:makeup=2',
  mc: 'highpass=f=90,equalizer=f=3000:t=q:w=1:g=3,acompressor=threshold=-24dB:ratio=5:attack=2:release=50:makeup=3,aecho=0.9:0.45:45:0.06',
  lautar: 'highpass=f=100,equalizer=f=2500:t=q:w=1:g=2,acompressor=threshold=-22dB:ratio=4:makeup=2,aecho=0.9:0.5:55:0.09',
  manele: 'highpass=f=110,equalizer=f=3000:t=q:w=1:g=3,chorus=0.8:0.9:30:0.15:0.3:1.5,acompressor=threshold=-24dB:ratio=5:attack=2:makeup=3,aecho=0.9:0.5:45:0.08',
};

function piperStatus(t) {
  if (!fs.existsSync(abs(t.piperPath))) return { ok: false, why: `Piper nu e instalat (${t.piperPath})` };
  if (!fs.existsSync(abs(t.voice))) return { ok: false, why: `Vocea lipsește (${t.voice})` };
  return { ok: true };
}
export function ttsStatus(config) {
  const t = config.tts || {};
  if (t.engine === 'edge') return { ok: true, engine: 'edge', voice: t.edgeVoice, fallback: piperStatus(t).ok };
  if (t.engine === 'xtts') return { ok: true, engine: 'xtts', voice: t.xttsVoice || 'mc', fallback: true };
  if (t.engine !== 'piper') return { ok: false, why: 'TTS oprit' };
  return { ...piperStatus(t), engine: 'piper' };
}

function run(cmd, args, input, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} a ieșit cu ${code}: ${err.trim().split('\n').pop()}`))));
    if (input != null) p.stdin.end(input); else p.stdin.end();
  });
}

/** Renders text → 44.1 kHz stereo WAV with the persona's voice effect. Returns { id, file } or null without TTS. */
export async function speak(config, text, style = 'radio', persona = {}) {
  if (!ttsStatus(config).ok || !text) return null;
  const t = config.tts;
  const id = crypto.randomBytes(8).toString('hex');
  const out = path.join(DATA, 'audio', id + '.wav');
  // Romanian letters: NFC + comma-below ș/ț (the old cedilla ş/ţ make voices stumble)
  const spoken = text.normalize('NFC').replace(/ş/g, 'ș').replace(/Ş/g, 'Ș').replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  let raw = null, fx = FX[style] || FX.radio;
  const TRIM = 'silenceremove=stop_periods=-1:stop_duration=0.15:stop_threshold=-42dB:stop_silence=0.08,';
  if (t.engine === 'xtts') {
    // cloned voice from the local XTTS server (ai-mc/xtts); on failure: Microsoft voice, then Piper
    try {
      const r = await fetch((t.xttsUrl || 'http://127.0.0.1:5005').replace(/\/+$/, '') + '/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ text: spoken, voice: persona.xttsVoice || t.xttsVoice || 'mc', speed: Number(t.xttsSpeed) || 1.0, temperature: Number(t.xttsTemperature) || 0.7 }),
        signal: AbortSignal.timeout(120000),
      });
      if (!r.ok) throw new Error(`XTTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
      raw = path.join(DATA, 'audio', id + '.raw.wav');
      fs.writeFileSync(raw, Buffer.from(await r.arrayBuffer()));
      fx = TRIM + (FX_NATURAL[style] || FX_NATURAL.radio);
    } catch (e) {
      console.error('[ai-mc] voce clonată:', e.message, '(folosesc vocea Microsoft)');
      raw = null;
    }
  }
  if (!raw && (t.engine === 'edge' || t.engine === 'xtts')) {
    // Microsoft neural voice through the edge-tts Python package (needs internet); Piper is the fallback
    // the text goes as an argument (UTF-16 on Windows) and Python is forced to UTF-8: a text file read with the
    // Windows code page loses ă/â/î/ș/ț, and the voice then reads it like Romanian without diacritics
    raw = path.join(DATA, 'audio', id + '.raw.mp3');
    try {
      await run(t.python || 'python', ['-m', 'edge_tts', '--voice', persona.edgeVoice || t.edgeVoice || 'ro-RO-EmilNeural',
        `--rate=${persona.edgeRate || t.edgeRate || '+12%'}`, `--pitch=${persona.edgePitch || t.edgePitch || '+5Hz'}`,
        '--text', spoken.replace(/\n+/g, ' '), '--write-media', raw], null, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
      // tighten the pauses the neural voice leaves after every "!" and "." (an MC doesn't stop to breathe)
      fx = TRIM + (FX_NATURAL[style] || FX_NATURAL.radio);
    } catch (e) {
      console.error('[ai-mc] edge-tts:', e.message, piperStatus(t).ok ? '(folosesc Piper)' : '');
      raw = null;
      if (!piperStatus(t).ok) throw e;
    }
  }
  if (!raw) {
    // Piper reads one utterance per line; verses keep their line breaks as pauses.
    raw = path.join(DATA, 'audio', id + '.raw.wav');
    await run(abs(t.piperPath), ['--model', abs(t.voice), '--output_file', raw, '--length_scale', String(t.lengthScale || 1), '--sentence_silence', '0.2'], spoken + '\n');
  }
  await run(config.ffmpeg || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-af', `aresample=44100,${fx},${LOUD},aresample=44100,alimiter=limit=0.85`, '-ar', '44100', '-ac', '2', out]);
  fs.rm(raw, { force: true }, () => {});
  return { id, file: out };
}

/** Is the voice-cloning server up, and which voices does it have? */
export async function xttsHealth(config) {
  try {
    const r = await fetch((config.tts?.xttsUrl || 'http://127.0.0.1:5005').replace(/\/+$/, '') + '/health', { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : { ok: false };
  } catch { return { ok: false }; }
}

/** Converts any uploaded recording to the XTTS reference format: mono 22.05 kHz WAV, max 30 s, even level. */
export async function makeReference(config, src, dst) {
  await run(config.ffmpeg || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-t', '30', '-af',
    'highpass=f=70,silenceremove=start_periods=1:start_threshold=-45dB,loudnorm=I=-18:TP=-2', '-ac', '1', '-ar', '22050', dst]);
}

/** Deletes rendered audio older than a day. */
export function cleanupAudio() {
  const dir = path.join(DATA, 'audio');
  const cutoff = Date.now() - 24 * 3600e3;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p); } catch { /* in use */ }
  }
}
