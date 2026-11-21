# Instalează clonarea de voce (XTTS-v2 pentru română) pe PC-ul cu placă video NVIDIA.
# Rulează din folderul OpenDJ:   powershell -ExecutionPolicy Bypass -File ai-mc\xtts\install-xtts.ps1
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$model = Join-Path $here 'model'
$venv = Join-Path $here '.venv'
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

Write-Host @'
Modelul FraPiz/xtts-v2-moldovan-romanian are licența Coqui Public Model License 1.0:
DOAR uz necomercial (petreceri, prieteni: da; câștig de bani din el sau din ce produce: nu).
Clonează doar vocea cuiva care e de acord.
'@ -ForegroundColor Yellow
$ok = Read-Host 'Ești de acord? (da/nu)'
if ($ok -notmatch '^(da|d|yes|y)$') { Write-Host 'Oprit.'; exit 1 }

Step 'Python 3.11'
$py311 = $null
try { $v = & py -3.11 -c "import sys; print(sys.executable)" 2>$null; if ($LASTEXITCODE -eq 0) { $py311 = $v.Trim() } } catch {}
if (-not $py311) {
  winget install -e --id Python.Python.3.11 --accept-source-agreements --accept-package-agreements
  Refresh-Path
  try { $v = & py -3.11 -c "import sys; print(sys.executable)" 2>$null; if ($LASTEXITCODE -eq 0) { $py311 = $v.Trim() } } catch {}
  if (-not $py311) { $cand = "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe"; if (Test-Path $cand) { $py311 = $cand } }
}
if (-not $py311) { Write-Warning 'Nu găsesc Python 3.11. Redeschide PowerShell și rulează din nou.'; exit 1 }
Write-Host "Python: $py311"

Step 'Mediu Python separat (.venv)'
if (-not (Test-Path "$venv\Scripts\python.exe")) { & $py311 -m venv $venv }
$vpy = "$venv\Scripts\python.exe"
& $vpy -m pip install --quiet --upgrade pip

Step 'PyTorch cu CUDA (~2.5 GB, durează)'
& $vpy -m pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu126

Step 'Coqui TTS (XTTS) + utilitare'
& $vpy -m pip install coqui-tts "transformers>=4.57,<4.58" soundfile num2words six "torch==2.7.1" "torchaudio==2.7.1" --extra-index-url https://download.pytorch.org/whl/cu126
& $vpy -c "import torch; print('CUDA:', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"

Step 'Modelul românesc (~5.8 GB, se poate relua dacă se întrerupe)'
New-Item -ItemType Directory -Force $model | Out-Null
$base = 'https://huggingface.co/FraPiz/xtts-v2-moldovan-romanian/resolve/main'
foreach ($f in 'config.json', 'vocab.json', 'best_model.pth') {
  $dst = Join-Path $model $f
  Write-Host "  $f"
  curl.exe -L -C - --retry 5 --fail -o $dst "$base/$f"
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 33) { Write-Warning "Descărcarea $f a eșuat (cod $LASTEXITCODE). Rulează scriptul din nou: continuă de unde a rămas." ; exit 1 }
}
$size = (Get-Item (Join-Path $model 'best_model.pth')).Length / 1GB
Write-Host ("best_model.pth: {0:N2} GB" -f $size)
if ($size -lt 5) { Write-Warning 'Fișierul pare incomplet. Rulează scriptul din nou.'; exit 1 }

New-Item -ItemType Directory -Force (Join-Path (Split-Path $here) 'voices') | Out-Null
Write-Host "`nGata! Pornește serverul de voce cu:  powershell -ExecutionPolicy Bypass -File ai-mc\xtts\start-xtts.ps1" -ForegroundColor Green
Write-Host 'Apoi înregistrează vocea de MC din panoul AI MC (http://127.0.0.1:7381/admin → Voce clonată).' -ForegroundColor Green
