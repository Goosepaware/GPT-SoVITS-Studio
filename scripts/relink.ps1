# Rebuild the renderer/main bundles, copy them into the portable folder, restart the app.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/relink.ps1
$ErrorActionPreference = 'Stop'
$src = 'D:\program\tts\GPT-SoVITS-Studio-src'
$app = 'D:\program\tts\GPT-SoVITS-Studio-Portable'

Push-Location $src
try {
  $env:NODE_OPTIONS = '--use-system-ca'
  npm run typecheck
  if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
} finally {
  Pop-Location
}

Copy-Item "$src\out\*" "$app\resources\app\out" -Recurse -Force
Copy-Item "$src\python\*.py" "$app\resources\python" -Force
Copy-Item "$src\resources\PORTABLE-README.txt" "$app\README.txt" -Force

Get-Process 'GPT-SoVITS-Studio' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 3
Start-Process "$app\GPT-SoVITS-Studio.exe"
Start-Sleep 10
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:39281/health' -UseBasicParsing -TimeoutSec 5
  "BUILD OK, MCP health=$($r.StatusCode)"
} catch {
  'BUILD OK, but MCP health check failed'
}
