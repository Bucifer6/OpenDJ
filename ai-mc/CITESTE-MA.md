# AI MC pentru OpenDJ – radio de petrecere cu DJ AI

Un DJ / MC / lăutar cu AI local care conduce petrecerea din OpenDJ: alege piesele și trecerile, bagă efecte pe beat,
citește dedicații și versuri cu vocea lui, iar prietenii ascultă live pe o pagină web unde scriu în chat, cer piese
și dedicații.

```
Ollama (Gemma etc.)  ──text / decizii──►  AI MC (port 7381)  ──voce──►  OpenDJ (port 7380, peste muzică)
OpenDJ ── Broadcast / Icecast ──►  AI MC /live  ──►  pagina prietenilor (stream, chat, cereri, dedicații)
OpenDJ (bridge) ── candidate smart-mix ──►  DJ AI ── piesa următoare + trecere + efecte ──►  OpenDJ automix
```

## Ce face
- **Pagina pentru prieteni** (`/`): stream live cu vizualizări, chat cu DJ-ul AI, cereri de piese (caută în colecție),
  dedicații și versuri citite în emisie.
- **DJ AI**: la fiecare piesă, OpenDJ alege candidatele potrivite (tempo ±4 %, ton Camelot, energie, gen, fără
  repetări), iar modelul alege piesa, stilul de trecere (blend, echo, backspin, brake, loop…), goarna pe beat și ce
  strigă la microfon. Cererile prietenilor au prioritate.
- **Ce muzică pune**: genuri din colecție, limbi (română / engleză / spaniolă / altele, ghicite din titlu),
  „doar muzică românească”, cuvinte de inclus / exclus.
- **Personaje**: cântăreț de manele, lăutar, MC de club, DJ de radio – editabile, cu exemple de stil și 👍 pe textele
  reușite („învățare” prin exemple), plus ce știe despre prieteni. Export Modelfile (Ollama) și date de antrenare (JSONL).
- **Voce**: Microsoft (edge-tts, online), voce clonată locală (XTTS-v2 pentru română, pe placa video NVIDIA) sau Piper,
  cu trecere automată pe următoarea dacă una nu merge.

## Pornire
```
powershell -ExecutionPolicy Bypass -File ai-mc\setup.ps1          # o dată: Node, FFmpeg, npm, Piper, edge-tts
powershell -ExecutionPolicy Bypass -File ai-mc\xtts\install-xtts.ps1   # opțional: voce clonată (GPU NVIDIA, ~9 GB)
powershell -ExecutionPolicy Bypass -File ai-mc\start-radio.ps1     # pornește vocea, OpenDJ și AI MC
```
Parola panoului (`http://127.0.0.1:7381/admin`) și parola sursei Icecast apar în fereastra AI MC.

1. **Ollama**: setează adresa în panou (local `http://127.0.0.1:11434` sau alt PC, ex. prin Tailscale; acolo
   `OLLAMA_HOST=0.0.0.0` și portul 11434 permis în firewall).
2. **OpenDJ → Record & stream → Broadcast**: țintă Icecast `127.0.0.1`, port `7381`, mount `/live`, user `source`,
   parola sursei din fereastra AI MC, MP3 128 kbps.
3. **OpenDJ → Settings → Automix**: debifează *Key Sync* (altfel vocea cântăreților e transpusă) și pornește Automix.
4. Pagina OpenDJ trebuie să rămână deschisă (Chrome / Edge): prin ea intră vocea în mix și execută DJ-ul AI.

## Prietenii
- Rețeaua de acasă: `http://<IP-ul PC-ului>:7381/`
- Internet: în spatele unui reverse proxy (Caddy / nginx) care trimite doar spre portul 7381 și blochează `/admin`,
  `/bridge/*`, `/status-json.xsl` și metodele `PUT` / `SOURCE`. Pune adresa proxy-ului în `trustedProxies`
  (`ai-mc/data/config.json`) ca limita anti-spam să vadă IP-ul real (antetul `X-Real-IP`).

## Limite
- Vocea vorbește și declamă; nu cântă pe melodie.
- Limba pieselor e ghicită din titlu (fișierele nu au câmp de limbă).
- Modelul XTTS românesc (FraPiz/xtts-v2-moldovan-romanian) are licența Coqui CPML: doar uz necomercial.
  Clonează doar vocea cuiva care e de acord. Mediul lui cere `transformers` 4.57.x (5.x nu merge).
