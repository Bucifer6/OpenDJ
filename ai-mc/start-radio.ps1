# Pornește OpenDJ (pagina DJ, în Chrome/Edge) + AI MC (pagina prietenilor) în două ferestre.
$root = Split-Path -Parent $PSScriptRoot
$cfgFile = Join-Path $PSScriptRoot 'data\config.json'
$ff = $null
if (Test-Path $cfgFile) { $ff = (Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json).ffmpeg }
if (-not $ff -or -not (Test-Path $ff)) { $ff = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source }
if ($ff) { $env:OPENDJ_FFMPEG = $ff }
# cloned voice server (only if installed with ai-mc\xtts\install-xtts.ps1); started first so it gets its GPU memory
if (Test-Path (Join-Path $PSScriptRoot 'xtts\.venv\Scripts\python.exe')) {
  Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle='Voce clonata'; Set-Location '$root'; powershell -ExecutionPolicy Bypass -File ai-mc\xtts\start-xtts.ps1"
}
Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle='OpenDJ'; Set-Location '$root'; npm run web"
Start-Process powershell -ArgumentList '-NoExit', '-Command', "`$host.UI.RawUI.WindowTitle='AI MC'; Set-Location '$root'; node ai-mc/server.js"
Start-Sleep -Seconds 4
Start-Process 'http://127.0.0.1:7380'
Start-Process 'http://127.0.0.1:7381/admin'
