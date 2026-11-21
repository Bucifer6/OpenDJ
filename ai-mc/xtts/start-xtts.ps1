# Pornește serverul local de voce clonată (XTTS) pe 127.0.0.1:5005.
$here = $PSScriptRoot
$vpy = Join-Path $here '.venv\Scripts\python.exe'
if (-not (Test-Path $vpy)) { Write-Warning 'Rulează întâi ai-mc\xtts\install-xtts.ps1'; exit 1 }
$env:PYTHONUTF8 = '1'
& $vpy (Join-Path $here 'xtts_server.py')
