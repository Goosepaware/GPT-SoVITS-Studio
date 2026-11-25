param(
  [switch]$Force,
  [switch]$SkipEngine,
  [switch]$SlimModels,
  [string]$Source = ""
)

$ErrorActionPreference = "Stop"
$project = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$release = Join-Path $project "release\GPT-SoVITS-Studio"
$electronDist = Join-Path $project "node_modules\electron\dist"

if (-not $Source) {
  $parent = Split-Path $project -Parent
  $candidate = Get-ChildItem $parent -Directory -Filter "GPT-SoVITS-v5-*" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -First 1
  if ($candidate) {
    $Source = $candidate.FullName
  }
}
if (-not $SkipEngine -and -not $Source) {
  throw "GPT-SoVITS source package not found. Pass -Source <path> or place a GPT-SoVITS-v5-* folder next to this project."
}

if (-not (Test-Path (Join-Path $electronDist "electron.exe"))) {
  throw "Electron runtime not found: $electronDist. Run npm install first."
}
if (Test-Path $release) {
  if (-not $Force) { throw "Release folder already exists: $release (use -Force)" }
  Remove-Item $release -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $release | Out-Null

Write-Host "[1/5] Building renderer/main bundle..."
Push-Location $project
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "electron-vite build failed" }
} finally {
  Pop-Location
}

Write-Host "[2/5] Copying Electron runtime..."
& robocopy $electronDist $release /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -gt 7) { throw "Failed to copy Electron runtime ($LASTEXITCODE)" }
$exe = Join-Path $release "electron.exe"
$targetExe = Join-Path $release "GPT-SoVITS-Studio.exe"
if (Test-Path $targetExe) { Remove-Item $targetExe -Force }
Move-Item $exe $targetExe -Force
Remove-Item (Join-Path $release "resources\default_app.asar") -Force -ErrorAction SilentlyContinue

Write-Host "[3/5] Assembling app resources..."
$appDir = Join-Path $release "resources\app"
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
& robocopy (Join-Path $project "out") (Join-Path $appDir "out") /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -gt 7) { throw "Failed to copy app bundle ($LASTEXITCODE)" }
Copy-Item (Join-Path $project "package.json") (Join-Path $appDir "package.json") -Force
& robocopy (Join-Path $project "python") (Join-Path $release "resources\python") /E /XD "__pycache__" /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -gt 7) { throw "Failed to copy python workers ($LASTEXITCODE)" }
Copy-Item (Join-Path $project "resources\icon.ico") (Join-Path $release "resources\icon.ico") -Force
Copy-Item (Join-Path $project "resources\icon.png") (Join-Path $release "resources\icon.png") -Force
New-Item -ItemType Directory -Force -Path (Join-Path $release "data") | Out-Null

if (-not $SkipEngine) {
  Write-Host "[4/5] Preparing slim engine (this copies several GB)..."
  # prepare-engine runs with ErrorActionPreference=Stop and throws on failure, so its
  # $LASTEXITCODE (left over from robocopy, which returns 0..7) must not be checked here.
  & (Join-Path $PSScriptRoot "prepare-engine.ps1") -Source $Source -Destination (Join-Path $release "engine") -Force -SlimModels:$SlimModels
} else {
  Write-Host "[4/5] Engine copy skipped (-SkipEngine)"
}

Write-Host "[5/5] Writing README..."
Copy-Item (Join-Path $project "resources\PORTABLE-README.txt") (Join-Path $release "README.txt") -Force

$bytes = (Get-ChildItem $release -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
Write-Host ("Portable build ready: {0} ({1:N2} GB)" -f $release, ($bytes / 1GB))
Write-Host "Run: $targetExe"
