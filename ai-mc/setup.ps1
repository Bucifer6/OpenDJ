# Instalare OpenDJ + AI MC pe PC-ul de DJ (cel cu Ollama).
# Rulează din folderul OpenDJ:   powershell -ExecutionPolicy Bypass -File ai-mc\setup.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$aimc = Join-Path $root 'ai-mc'
Set-Location $root
function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

Step 'Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node -or [int]((node -v) -replace '^v(\d+).*', '$1') -lt 22) {
  Write-Host 'Instalez Node.js LTS cu winget...'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  Refresh-Path
}
node -v

Step 'FFmpeg'
$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ff) {
  Write-Host 'Instalez FFmpeg cu winget...'
  winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
  Refresh-Path
  $ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if (-not $ff) { $ff = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1 }
}
$ffPath = if ($ff.Source) { $ff.Source } else { $ff.FullName }
if (-not $ffPath) { throw 'Nu găsesc ffmpeg.exe după instalare. Redeschide PowerShell și rulează din nou.' }
Write-Host "ffmpeg: $ffPath"

Step 'Pachete OpenDJ (npm install)'
npm install --no-audit --no-fund

Step 'Vocea Piper (română, ro_RO-mihai)'
$tools = Join-Path $aimc 'tools'
New-Item -ItemType Directory -Force (Join-Path $tools 'voices') | Out-Null
$ProgressPreference = 'SilentlyContinue'
if (-not (Test-Path (Join-Path $tools 'piper\piper.exe'))) {
  $zip = Join-Path $tools 'piper.zip'
  Invoke-WebRequest 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip' -OutFile $zip
  Expand-Archive $zip -DestinationPath $tools -Force
  Remove-Item $zip
}
foreach ($f in 'ro_RO-mihai-medium.onnx', 'ro_RO-mihai-medium.onnx.json') {
  $dst = Join-Path $tools "voices\$f"
  if (-not (Test-Path $dst)) { Invoke-WebRequest "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/ro/ro_RO/mihai/medium/$f" -OutFile $dst }
}

Step 'Vocea Microsoft (edge-tts, Python)'
$ErrorActionPreference = 'Continue'
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py -or $py.Source -like '*WindowsApps*') {
  Write-Host 'Instalez Python cu winget...'
  winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
  Refresh-Path
}
python -m pip install --quiet --upgrade edge-tts
python -m edge_tts --list-voices | Select-String 'ro-RO'
$ErrorActionPreference = 'Stop'

Step 'Configurare AI MC (Ollama local)'
$cfgFile = Join-Path $aimc 'data\config.json'
New-Item -ItemType Directory -Force (Split-Path $cfgFile) | Out-Null
$cfg = if (Test-Path $cfgFile) { Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }
$cfg | Add-Member -Force NoteProperty ollamaUrl 'http://127.0.0.1:11434'
$cfg | Add-Member -Force NoteProperty ffmpeg $ffPath
if (-not $cfg.model) { $cfg | Add-Member -Force NoteProperty model 'gemma3:12b' }
[IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))

Step 'Test voce'
$test = Join-Path $aimc 'data\test-voce.wav'
# Piper logs "Loaded voice…" on stderr; with ErrorActionPreference=Stop, PowerShell 5.1 would treat that as an error.
$ErrorActionPreference = 'Continue'
$piperArgs = @('--model', (Join-Path $tools 'voices\ro_RO-mihai-medium.onnx'), '--output_file', $test)
$txt = Join-Path $aimc 'data\test-voce.txt'
[IO.File]::WriteAllText($txt, "Salutare, petrecere! Aici radioul vostru, cu dedicații și voie bună!`n", (New-Object Text.UTF8Encoding $false))
Start-Process -FilePath (Join-Path $tools 'piper\piper.exe') -ArgumentList $piperArgs -NoNewWindow -Wait -RedirectStandardInput $txt -RedirectStandardError (Join-Path $aimc 'data\piper-log.txt')
$ErrorActionPreference = 'Stop'
if (Test-Path $test) { (New-Object Media.SoundPlayer $test).PlaySync(); Write-Host 'Vocea merge.' -ForegroundColor Green } else { Write-Warning 'Piper nu a produs sunet.' }

Step 'Firewall (pagina prietenilor, port 7381)'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($admin) {
  if (-not (Get-NetFirewallRule -DisplayName 'AI MC radio' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'AI MC radio' -Direction Inbound -Protocol TCP -LocalPort 7381 -Profile Private -Action Allow | Out-Null
    New-NetFirewallRule -DisplayName 'AI MC radio (Tailscale)' -Direction Inbound -Protocol TCP -LocalPort 7381 -RemoteAddress 100.64.0.0/10 -Action Allow | Out-Null
  }
  Write-Host 'Port 7381 permis pentru rețeaua de acasă și Tailscale.'
} else { Write-Warning 'Nu rulezi ca Administrator: Windows te va întreba de firewall la prima pornire (alege Private).' }

Write-Host "`nGata! Pornește radioul cu:  powershell -ExecutionPolicy Bypass -File ai-mc\start-radio.ps1" -ForegroundColor Green
