param(
  [string]$Source = "",
  [Parameter(Mandatory = $true)][string]$Destination,
  [switch]$SkipRuntime,
  [switch]$SlimModels,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
if (-not $Source) {
  throw "Please pass -Source <path to GPT-SoVITS v5 package>."
}
$Source = (Resolve-Path $Source).Path
$Destination = [System.IO.Path]::GetFullPath($Destination)

if (-not (Test-Path (Join-Path $Source "runtime\python.exe"))) {
  throw "Source is not a GPT-SoVITS package: $Source"
}
if (-not (Test-Path (Join-Path $Source "GPT_SoVITS\TTS_infer_pack\TTS.py"))) {
  throw "GPT_SoVITS/TTS_infer_pack/TTS.py not found in $Source"
}
if (Test-Path $Destination) {
  if (-not $Force) { throw "Destination already exists: $Destination (use -Force to replace)" }
  Remove-Item $Destination -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Destination | Out-Null

function Copy-Tree {
  param([string]$From, [string]$To, [string[]]$ExcludeDirs = @())
  if (-not (Test-Path $From)) { throw "Missing source: $From" }
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  $arguments = @($From, $To, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1")
  if ($ExcludeDirs.Count -gt 0) {
    $arguments += "/XD"
    $arguments += $ExcludeDirs
  }
  & robocopy @arguments | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "robocopy failed ($LASTEXITCODE): $From -> $To" }
}

function Copy-FileIfExists {
  param([string]$From, [string]$To)
  if (-not (Test-Path $From)) { throw "Missing file: $From" }
  New-Item -ItemType Directory -Force -Path (Split-Path $To -Parent) | Out-Null
  Copy-Item $From $To -Force
}

Write-Host "Preparing slim engine..."
Write-Host "  from: $Source"
Write-Host "  to:   $Destination"

if (-not $SkipRuntime) {
  Write-Host "[1/6] runtime (this is the large one)..."
  Copy-Tree (Join-Path $Source "runtime") (Join-Path $Destination "runtime") @("__pycache__")
} else {
  Write-Host "[1/6] runtime skipped"
}

Write-Host "[2/6] GPT_SoVITS code..."
$codeExclude = @("pretrained_models", "__pycache__")
if ($SlimModels) { $codeExclude += "G2PWModel" }
Copy-Tree (Join-Path $Source "GPT_SoVITS") (Join-Path $Destination "GPT_SoVITS") $codeExclude

Write-Host "[3/6] selected pretrained models..."
$pretrained = Join-Path $Destination "GPT_SoVITS\pretrained_models"
New-Item -ItemType Directory -Force -Path $pretrained | Out-Null
if ($SlimModels) {
  # Slim package: big weights are downloaded by the app (models page / MCP download_models).
  Write-Host "  slim: skipping s1v3.ckpt, s2Gv5turbo.pth, vocoder.pth, HuBERT, RoBERTa, langdetect, G2PW"
  foreach ($dir in @("gsv-v5-pretrained", "chinese-roberta-wwm-ext-large", "chinese-hubert-base", "fast_langdetect")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $pretrained $dir) | Out-Null
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $Destination "GPT_SoVITS\text\G2PWModel") | Out-Null
} else {
  foreach ($dir in @("chinese-roberta-wwm-ext-large", "chinese-hubert-base", "fast_langdetect")) {
    Copy-Tree (Join-Path $Source "GPT_SoVITS\pretrained_models\$dir") (Join-Path $pretrained $dir)
  }
  Copy-FileIfExists (Join-Path $Source "GPT_SoVITS\pretrained_models\s1v3.ckpt") (Join-Path $pretrained "s1v3.ckpt")
  Copy-FileIfExists (Join-Path $Source "GPT_SoVITS\pretrained_models\gsv-v5-pretrained\s2Gv5turbo.pth") (Join-Path $pretrained "gsv-v5-pretrained\s2Gv5turbo.pth")
  Copy-FileIfExists (Join-Path $Source "GPT_SoVITS\pretrained_models\gsv-v5-pretrained\vocoder.pth") (Join-Path $pretrained "gsv-v5-pretrained\vocoder.pth")
}

Write-Host "[4/6] tools (without UVR5 and old ASR models)..."
Copy-Tree (Join-Path $Source "tools") (Join-Path $Destination "tools") @("uvr5", "denoise-model", (Join-Path $Source "tools\asr\models"), "__pycache__")

Write-Host "[5/6] ASR models (SenseVoice + VAD + CAM++)..."
$cache = Join-Path $env:USERPROFILE ".cache\modelscope"
$sense = Join-Path $cache "hub\models\iic\SenseVoiceSmall"
$vad = Join-Path $cache "models\iic--speech_fsmn_vad_zh-cn-16k-common-pytorch\snapshots\master"
$spk = Join-Path $cache "hub\models\iic\speech_campplus_sv_zh-cn_16k-common"
# Rebuilding from another portable folder: its engine already holds the ASR models.
if (-not (Test-Path $sense) -and (Test-Path (Join-Path $Source "models\asr\SenseVoiceSmall"))) { $sense = Join-Path $Source "models\asr\SenseVoiceSmall" }
if (-not (Test-Path $vad) -and (Test-Path (Join-Path $Source "models\asr\fsmn-vad"))) { $vad = Join-Path $Source "models\asr\fsmn-vad" }
if (-not (Test-Path $spk) -and (Test-Path (Join-Path $Source "models\asr\campplus"))) { $spk = Join-Path $Source "models\asr\campplus" }
$asrRoot = Join-Path $Destination "models\asr"
New-Item -ItemType Directory -Force -Path $asrRoot | Out-Null
if ($SlimModels) {
  # SenseVoice is downloadable; VAD and CAM++ are tiny and ship with the package.
  New-Item -ItemType Directory -Force -Path (Join-Path $asrRoot "SenseVoiceSmall") | Out-Null
  Write-Host "  slim: skipping SenseVoiceSmall (downloaded by the app)"
} elseif (Test-Path $sense) {
  Copy-Tree $sense (Join-Path $asrRoot "SenseVoiceSmall")
} else {
  throw "SenseVoiceSmall not found: $sense"
}
if (Test-Path $vad) { Copy-Tree $vad (Join-Path $asrRoot "fsmn-vad") } else { throw "FSMN-VAD not found: $vad" }
if (Test-Path $spk) { Copy-Tree $spk (Join-Path $asrRoot "campplus") } else { Write-Warning "CAM++ not found: $spk (speaker diarization will be unavailable)" }

Write-Host "[6/6] weights folders, manifest and license..."
foreach ($dir in @("GPT_weights_v5turbo", "SoVITS_weights_v5turbo", "output")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Destination $dir) | Out-Null
}
foreach ($file in @("weight.json", "LICENSE")) {
  $sourceFile = Join-Path $Source $file
  if (Test-Path $sourceFile) { Copy-Item $sourceFile (Join-Path $Destination $file) -Force }
}
$manifest = [ordered]@{
  app = "GPT-SoVITS-Studio"
  engine = "GPT-SoVITS v5turbo"
  source = $Source
  preparedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  asr = @("SenseVoiceSmall", "fsmn-vad", "campplus")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Destination "engine-manifest.json") -Encoding UTF8

$bytes = (Get-ChildItem $Destination -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
Write-Host ("Engine ready: {0} ({1:N2} GB)" -f $Destination, ($bytes / 1GB))
