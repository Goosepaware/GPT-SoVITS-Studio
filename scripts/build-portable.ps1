param(
  [switch]$Force,
  [switch]$SkipEngine,
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
  & (Join-Path $PSScriptRoot "prepare-engine.ps1") -Source $Source -Destination (Join-Path $release "engine") -Force
  if ($LASTEXITCODE -ne 0) { throw "prepare-engine failed" }
} else {
  Write-Host "[4/5] Engine copy skipped (-SkipEngine)"
}

Write-Host "[5/5] Writing README..."
$readmeLines = @(
  "GPT-SoVITS-Studio (v5turbo)",
  "===========================",
  "",
  "启动：双击 `"GPT-SoVITS-Studio.exe`"",
  "",
  "这是一个绿色便携目录。不要把 exe 单独移动出去：",
  "- resources\   Electron 应用与 Python worker",
  "- engine\      GPT-SoVITS 运行时、v5turbo 底模、SenseVoice",
  "- data\        配置、音色库、生成结果、日志、缓存",
  "",
  "首次启动会自动识别 engine 目录。所有模型推理都在本机完成。",
  "",
  "常用位置：",
  "- 生成结果：data\outputs",
  "- 运行日志：data\logs",
  "- 配置文件：data\config.json",
  "- 音色库：data\voices，每个 .v5t 文件就是一个可分享音色包",
  "- 主题：设置 → 外观，彩色 / 黑白两套风格，各自支持深色 / 浅色",
  "",
  "卸载/释放显存：",
  "- 模型页点【卸载并释放显存】，或直接关闭应用；worker 进程会被结束，显存由系统回收。"
)
Set-Content (Join-Path $release "README.txt") $readmeLines -Encoding UTF8

$bytes = (Get-ChildItem $release -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
Write-Host ("Portable build ready: {0} ({1:N2} GB)" -f $release, ($bytes / 1GB))
Write-Host "Run: $targetExe"
