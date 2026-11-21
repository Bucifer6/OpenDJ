"""Local voice-cloning server for AI MC: XTTS-v2 fine-tuned for Romanian (FraPiz/xtts-v2-moldovan-romanian).

Keeps the model on the GPU and answers  POST /tts {"text", "voice", "speed"}  with a 24 kHz mono WAV, cloned from
the reference recording  ai-mc/voices/<voice>.wav  (10-30 s of someone talking like an MC; AI MC converts uploads).
GET /health lists the voices. Listens on 127.0.0.1 only.

Model licence: Coqui Public Model License 1.0.0, non-commercial use only. Clone only voices whose owners agree.
"""
import io
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf
import torch
import torchaudio

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get("XTTS_MODEL_DIR", os.path.join(HERE, "model"))
VOICES = os.path.abspath(os.environ.get("XTTS_VOICES", os.path.join(HERE, "..", "voices")))
PORT = int(os.environ.get("XTTS_PORT", "5005"))
SR = 24000


# torchaudio.load needs FFmpeg/torchcodec on Windows in newer versions: read WAVs with soundfile instead
def _sf_load(path, *args, **kwargs):
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    return torch.from_numpy(data.T.copy()), sr


torchaudio.load = _sf_load

# PyTorch >= 2.6 loads checkpoints with weights_only=True; a fine-tuned training checkpoint can hold other pickled
# objects. Retry without the restriction, but only for the model files in MODEL_DIR (the model the user downloaded).
_torch_load = torch.load


def _load(f, *args, **kwargs):
    try:
        return _torch_load(f, *args, **kwargs)
    except Exception as e:
        inside = isinstance(f, (str, os.PathLike)) and os.path.abspath(f).startswith(os.path.abspath(MODEL_DIR))
        if inside and "weights_only" in str(e) and kwargs.get("weights_only") is not False:
            print("[xtts] reîncarc checkpoint-ul fără weights_only (fișierul modelului descărcat)", flush=True)
            kwargs["weights_only"] = False
            return _torch_load(f, *args, **kwargs)
        raise


torch.load = _load

import transformers  # noqa: E402

if int(transformers.__version__.split(".")[0]) >= 5:
    print(f"[xtts] EROARE: transformers {transformers.__version__} nu merge cu XTTS. Rulează:\n"
          f'  "{sys.executable}" -m pip install "transformers>=4.57,<4.58"', flush=True)
    sys.exit(1)

from TTS.tts.configs.xtts_config import XttsConfig  # noqa: E402
from TTS.tts.layers.xtts import tokenizer as xtok  # noqa: E402
from TTS.tts.models.xtts import Xtts  # noqa: E402

try:
    from num2words import num2words
except ImportError:  # numbers stay as digits
    num2words = None

# ------------------------------------------------------------------ Romanian text support (in memory, no file patching)
FIX = str.maketrans({"ş": "ș", "ţ": "ț", "Ş": "Ș", "Ţ": "Ț"})


def ro_clean(txt):
    txt = txt.translate(FIX)
    if num2words:
        txt = re.sub(r"\d+", lambda m: num2words(int(m.group()), lang="ro"), txt)
    txt = re.sub(r"\s+", " ", txt.lower()).strip()
    return txt


_orig_pre = xtok.VoiceBpeTokenizer.preprocess_text


def _pre(self, txt, lang):
    if lang.split("-")[0] == "ro":
        return ro_clean(txt)
    return _orig_pre(self, txt, lang)


xtok.VoiceBpeTokenizer.preprocess_text = _pre
if hasattr(xtok.VoiceBpeTokenizer, "check_input_length"):
    _orig_chk = xtok.VoiceBpeTokenizer.check_input_length

    def _chk(self, txt, lang):
        if lang.split("-")[0] == "ro":
            return
        return _orig_chk(self, txt, lang)

    xtok.VoiceBpeTokenizer.check_input_length = _chk

# ------------------------------------------------------------------ model
if not torch.cuda.is_available():
    print("[xtts] ATENȚIE: nu văd placa video (CUDA); va merge foarte încet pe procesor.", flush=True)
device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"[xtts] încarc modelul din {MODEL_DIR} pe {device}...", flush=True)
t0 = time.time()
config = XttsConfig()
config.load_json(os.path.join(MODEL_DIR, "config.json"))
model = Xtts.init_from_config(config)
model.load_checkpoint(
    config,
    checkpoint_dir=MODEL_DIR,
    checkpoint_path=os.path.join(MODEL_DIR, "best_model.pth"),
    vocab_path=os.path.join(MODEL_DIR, "vocab.json"),
    use_deepspeed=False,
)
model.to(device)
model.eval()
print(f"[xtts] model încărcat în {time.time() - t0:.0f}s", flush=True)

lock = threading.Lock()
latents = {}  # voice -> (mtime, gpt_cond_latent, speaker_embedding)


def voices():
    if not os.path.isdir(VOICES):
        return []
    return sorted(f[:-4] for f in os.listdir(VOICES) if f.lower().endswith(".wav"))


def conditioning(voice):
    path = os.path.join(VOICES, voice + ".wav")
    if not re.fullmatch(r"[\w-]{1,40}", voice) or not os.path.isfile(path):
        raise FileNotFoundError(f"Nu există vocea „{voice}” ({path})")
    mtime = os.path.getmtime(path)
    hit = latents.get(voice)
    if hit and hit[0] == mtime:
        return hit[1], hit[2]
    gpt, spk = model.get_conditioning_latents(audio_path=[path], gpt_cond_len=30, max_ref_length=30)
    latents[voice] = (mtime, gpt, spk)
    return gpt, spk


def chunks(text, limit=180):
    """XTTS sounds best on short pieces: split on sentence ends, then on commas if still too long."""
    out = []
    for sent in re.split(r"(?<=[.!?…])\s+|\n+", text.strip()):
        sent = sent.strip()
        while len(sent) > limit:
            cut = max(sent.rfind(",", 0, limit), sent.rfind(" ", 0, limit))
            cut = cut if cut > 40 else limit
            out.append(sent[:cut + 1].strip())
            sent = sent[cut + 1:].strip()
        if sent:
            out.append(sent)
    return out


def synth(text, voice, speed=1.0, temperature=0.7):
    gpt, spk = conditioning(voice)
    gap = np.zeros(int(SR * 0.09), dtype=np.float32)
    parts = []
    with torch.inference_mode():
        for piece in chunks(text):
            out = model.inference(piece, "ro", gpt, spk, temperature=temperature, top_p=0.7, top_k=30,
                                  length_penalty=0.8, repetition_penalty=10.0, speed=speed)
            parts += [np.asarray(out["wav"], dtype=np.float32), gap]
    wav = np.concatenate(parts) if parts else np.zeros(SR // 2, dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, wav, SR, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "device": device, "voices": voices()})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/tts":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 64 * 1024:
                return self._json(413, {"error": "prea mare"})
            req = json.loads(self.rfile.read(n).decode("utf-8"))
            text = str(req.get("text") or "").strip()[:1500]
            if not text:
                return self._json(400, {"error": "text gol"})
            voice = str(req.get("voice") or "mc")
            speed = min(1.4, max(0.8, float(req.get("speed") or 1.0)))
            temp = min(1.0, max(0.3, float(req.get("temperature") or 0.7)))
            t = time.time()
            with lock:
                wav = synth(text, voice, speed, temp)
            print(f"[xtts] {len(text)} caractere, vocea {voice}: {time.time() - t:.1f}s", flush=True)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(wav)))
            self.end_headers()
            self.wfile.write(wav)
        except FileNotFoundError as e:
            self._json(404, {"error": str(e)})
        except Exception as e:  # keep serving after a bad request
            print("[xtts] eroare:", repr(e), file=sys.stderr, flush=True)
            self._json(500, {"error": repr(e)[:300]})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    os.makedirs(VOICES, exist_ok=True)
    print(f"[xtts] gata pe http://127.0.0.1:{PORT}  voci: {', '.join(voices()) or '(niciuna încă)'}  folder: {VOICES}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
