param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$Version = "1.1.1",
  [switch]$SkipSlim,
  [switch]$SkipFull,
  [switch]$UiOnly,
  [int]$Level = 5,
  # Extracted Umamusume voice-library release root (contains voices/ and NOTICE.md).
  [string]$VoiceLibrary = "",
  [string]$VoiceFolder = "赛马娘"
)

$ErrorActionPreference = "Stop"
$project = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$release = Join-Path $project "release"
$dist = Join-Path $project "dist"
$sevenZip = Join-Path $project "node_modules\7zip-bin\win\x64\7za.exe"
$sampleVoice = Join-Path $project "..\GPT-SoVITS-Studio-Portable\data\voices\smart_falcon.v5t"
if (-not (Test-Path $sevenZip)) { throw "7za.exe not found: $sevenZip" }
if (-not (Test-Path $sampleVoice)) { Write-Warning "sample voice not found, the package will have no example voice" }
New-Item -ItemType Directory -Force -Path $dist | Out-Null

function Copy-UmamusumeVoices {
  param([string]$Target)
  if (-not $VoiceLibrary) {
    throw "Full build requires -VoiceLibrary <extracted release root> (contains voices/ and NOTICE.md)."
  }
  $sourceVoices = Join-Path $VoiceLibrary "voices"
  if (-not (Test-Path $sourceVoices)) { throw "Voice library not found: $sourceVoices" }
  $voiceFiles = @(Get-ChildItem $sourceVoices -File -Filter "*.v5t")
  if ($voiceFiles.Count -eq 0) { throw "No .v5t files in $sourceVoices" }
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  foreach ($file in $voiceFiles) {
    Copy-Item $file.FullName (Join-Path $Target $file.Name) -Force
  }
  foreach ($name in @("README.md", "NOTICE.md", "VOICE_ASSETS_LICENSE.md", "LICENSE")) {
    $src = Join-Path $VoiceLibrary $name
    if (Test-Path $src) { Copy-Item $src (Join-Path $Target $name) -Force }
  }
  Write-Host ("  bundled {0} Umamusume voices -> {1}" -f $voiceFiles.Count, $Target)
}

function Build-Variant {
  param([string]$Name, [switch]$Slim, [switch]$NoEngine)

  Write-Host "=== building $Name (slim=$Slim, uiOnly=$NoEngine) ==="
  $args = @{ Source = $Source; Force = $true }
  if ($Slim) { $args.SlimModels = $true }
  if ($NoEngine) { $args.NoEngine = $true }
  # build-portable throws on failure; its $LASTEXITCODE can be a robocopy success code (1..7).
  & (Join-Path $PSScriptRoot "build-portable.ps1") @args

  $built = Join-Path $release "GPT-SoVITS-Studio"
  $voices = Join-Path $built "data\voices"
  New-Item -ItemType Directory -Force -Path $voices | Out-Null
  if ($NoEngine) {
    Write-Host "  UI build: no sample voices"
  } elseif ($Slim) {
    if (Test-Path $sampleVoice) { Copy-Item $sampleVoice (Join-Path $voices "smart_falcon.v5t") -Force }
  } else {
    $voiceTarget = if ($VoiceFolder) { Join-Path $voices $VoiceFolder } else { $voices }
    Copy-UmamusumeVoices -Target $voiceTarget
  }

  $target = Join-Path $release $Name
  if (Test-Path $target) { throw "already exists: $target" }
  Move-Item $built $target

  $bytes = (Get-ChildItem $target -Recurse -File | Measure-Object Length -Sum).Sum
  Write-Host ("  folder {0:N2} GB" -f ($bytes / 1GB))

  $archive = Join-Path $dist "$Name.7z"
  if (Test-Path $archive) { Remove-Item $archive -Force }
  Write-Host "  compressing -> $archive (level $Level)"
  Push-Location $release
  try {
    & $sevenZip a -t7z "-mx=$Level" -mmt=on -bsp1 $archive $Name | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7z failed for $Name ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
  $size = (Get-Item $archive).Length
  Write-Host ("  archive {0:N2} GB: {1}" -f ($size / 1GB), $archive)
  return $archive
}

$done = @()
if ($UiOnly) {
  $done += Build-Variant -Name "GPT-SoVITS-Studio-$Version-ui" -NoEngine
} else {
  if (-not $SkipSlim) { $done += Build-Variant -Name "GPT-SoVITS-Studio-$Version-slim" -Slim }
  if (-not $SkipFull) { $done += Build-Variant -Name "GPT-SoVITS-Studio-$Version-full" }
}
Write-Host "=== done ==="
$done | ForEach-Object { Write-Host $_ }
