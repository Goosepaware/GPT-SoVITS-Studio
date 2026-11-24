param([switch]$SkipBuild, [string]$Release = "")

$ErrorActionPreference = "Stop"
$project = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Release) { $Release = Join-Path $project "release\GPT-SoVITS-Studio" }
$release = (Resolve-Path $Release).Path
if (-not (Test-Path (Join-Path $release "GPT-SoVITS-Studio.exe"))) { throw "Not a portable release: $release" }

if (-not $SkipBuild) {
  Push-Location $project
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
  } finally {
    Pop-Location
  }
}

$appDir = Join-Path $release "resources\app"
& robocopy (Join-Path $project "out") (Join-Path $appDir "out") /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -gt 7) { throw "failed to update app bundle" }
Copy-Item (Join-Path $project "package.json") (Join-Path $appDir "package.json") -Force
& robocopy (Join-Path $project "python") (Join-Path $release "resources\python") /MIR /XD "__pycache__" /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -gt 7) { throw "failed to update python workers" }
Copy-Item (Join-Path $project "resources\icon.ico") (Join-Path $release "resources\icon.ico") -Force
Copy-Item (Join-Path $project "resources\icon.png") (Join-Path $release "resources\icon.png") -Force
Copy-Item (Join-Path $project "resources\PORTABLE-README.txt") (Join-Path $release "README.txt") -Force
Write-Host "Release app files updated (engine and data untouched): $release"
