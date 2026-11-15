param(
  [switch]$SkipAppBuild,
  [switch]$SkipCompress,
  [switch]$ForceCompress
)

$ErrorActionPreference = "Stop"
$project = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$release = Join-Path $project "release\GPT-SoVITS-Studio"
$build = Join-Path $project "build"
$outDir = Join-Path $project "release\installer"
$tools = Join-Path $project "tools"
$sevenZip = Join-Path $tools "7zr.exe"
$sevenZip64 = Join-Path $tools "7za.exe"
$payload = Join-Path $build "payload.7z"
$listFile = Join-Path $build "payload-files.txt"
$stub = Join-Path $build "installer-stub.exe"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$appExe = Join-Path $release "GPT-SoVITS-Studio.exe"
$oldExe = Join-Path $release "GPT-SoVITS Studio.exe"

if (-not (Test-Path $release)) { throw "Portable release not found: $release" }
if (-not (Test-Path $csc)) { throw ".NET Framework C# compiler not found: $csc" }
$running = Get-Process "GPT-SoVITS-Studio", "GPT-SoVITS Studio" -ErrorAction SilentlyContinue
if ($running) {
  throw "GPT-SoVITS-Studio is running. Close it before building the installer."
}
New-Item -ItemType Directory -Force -Path $build | Out-Null
New-Item -ItemType Directory -Force -Path $tools | Out-Null

if (-not (Test-Path $sevenZip)) {
  Write-Host "Downloading 7zr.exe..."
  Invoke-WebRequest -Uri "https://www.7-zip.org/a/7zr.exe" -OutFile $sevenZip -UseBasicParsing
}

if (-not (Test-Path $sevenZip64)) {
  Write-Host "Downloading 64-bit 7za.exe..."
  $extra = Join-Path $tools "7z-extra.7z"
  Invoke-WebRequest -Uri "https://www.7-zip.org/a/7z2604-extra.7z" -OutFile $extra -UseBasicParsing
  & $sevenZip e $extra "x64\7za.exe" "-o$tools" -y | Out-Null
  Remove-Item $extra -Force -ErrorAction SilentlyContinue
}

if (-not $SkipAppBuild) {
  Write-Host "[1/5] Building app and updating release..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "update-release.ps1")
  if ($LASTEXITCODE -ne 0) { throw "update-release.ps1 failed" }
} else {
  Write-Host "[1/5] App build skipped"
}

if ((Test-Path $oldExe) -and -not (Test-Path $appExe)) {
  Move-Item $oldExe $appExe -Force
}
if (-not (Test-Path $appExe)) {
  throw "App executable not found: $appExe"
}

Write-Host "[2/5] Collecting payload files (data excluded, example voice included)..."
$root = (Resolve-Path $release).Path
$exampleSource = Join-Path $project "installer\assets\smart_falcon.v5t"
$exampleDest = Join-Path $root "data\voices\smart_falcon.v5t"
if (-not (Test-Path $exampleDest) -and (Test-Path $exampleSource)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $exampleDest) | Out-Null
  Copy-Item $exampleSource $exampleDest -Force
}
$files = Get-ChildItem $root -Recurse -File | Where-Object { $_.FullName -notlike "$root\data\*" }
$list = New-Object System.Collections.Generic.List[string]
foreach ($file in $files) {
  $list.Add($file.FullName.Substring($root.Length + 1))
}
$exampleVoice = "data\voices\smart_falcon.v5t"
if (Test-Path (Join-Path $root $exampleVoice)) {
  $list.Add($exampleVoice)
} else {
  Write-Warning "Example voice not found: $exampleVoice"
}
[IO.File]::WriteAllLines($listFile, $list, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("Payload files: {0}" -f $list.Count)

if (-not $SkipCompress) {
  if ($ForceCompress -or -not (Test-Path $payload)) {
    Write-Host "[3/5] Compressing payload with LZMA2 (this can take 20-60 minutes)..."
    if (Test-Path $payload) { Remove-Item $payload -Force }
    Push-Location $root
    try {
      & $sevenZip64 a -t7z -m0=lzma2 -mx=7 -mmt=8 -md=64m -ms=on $payload "@$listFile"
      if ($LASTEXITCODE -gt 1) { throw "7zr compression failed ($LASTEXITCODE)" }
    } finally {
      Pop-Location
    }
  } else {
    Write-Host "[3/5] Reusing existing payload: $payload"
  }
} else {
  if (-not (Test-Path $payload)) { throw "SkipCompress was set but payload is missing: $payload" }
  Write-Host "[3/5] Compression skipped"
}

Write-Host "[4/5] Building installer UI..."
& $csc /nologo /target:winexe /langversion:5 /optimize+ `
  /out:$stub `
  /win32icon:"$project\installer\icon-mono.ico" `
  /win32manifest:"$project\installer\app.manifest" `
  /resource:"$sevenZip",SevenZip `
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Core.dll /r:Microsoft.CSharp.dll `
  "$project\installer\Installer.cs"
if ($LASTEXITCODE -ne 0) { throw "Installer compilation failed" }

Write-Host "[5/5] Writing installer package..."
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item $stub (Join-Path $outDir "GPT-SoVITS-Studio-Setup.exe") -Force
Copy-Item $payload (Join-Path $outDir "GPT-SoVITS-Studio-Portable.7z") -Force

$readme = @(
  "GPT-SoVITS-Studio 安装说明",
  "==========================",
  "",
  "请保持以下两个文件在同一个文件夹：",
  "  GPT-SoVITS-Studio-Setup.exe",
  "  GPT-SoVITS-Studio-Portable.7z",
  "",
  "安装：",
  "  1. 双击 GPT-SoVITS-Studio-Setup.exe。",
  "  2. 选择安装路径，勾选 创建桌面快捷方式。",
  "  3. 点击 安装，等待解压完成。",
  "",
  "说明：",
  "  - 安装包包含程序、v5turbo 模型、SenseVoice 模型和示例音色 smart_falcon。",
  "  - 不包含历史记录、日志和其他个人音色。",
  "  - 覆盖安装时，已有 data 目录会保留。",
  "  - 卸载：删除安装目录和桌面快捷方式即可，不写注册表。",
  "  - 未签名安装器可能触发 SmartScreen，自用可放行。",
  "",
  "安装包也可以直接用 7-Zip 解压，作为绿色便携版使用。"
)
[IO.File]::WriteAllLines((Join-Path $outDir "安装说明.txt"), $readme, (New-Object System.Text.UTF8Encoding($false)))

$setupFile = Join-Path $outDir "GPT-SoVITS-Studio-Setup.exe"
$payloadOut = Join-Path $outDir "GPT-SoVITS-Studio-Portable.7z"
$hashes = @(
  ("{0}  {1}" -f (Get-FileHash $setupFile -Algorithm SHA256).Hash, (Split-Path $setupFile -Leaf)),
  ("{0}  {1}" -f (Get-FileHash $payloadOut -Algorithm SHA256).Hash, (Split-Path $payloadOut -Leaf))
)
[IO.File]::WriteAllLines((Join-Path $outDir "SHA256.txt"), $hashes, (New-Object System.Text.UTF8Encoding($false)))

$setupSize = (Get-Item $setupFile).Length
$payloadSize = (Get-Item $payloadOut).Length
Write-Host ("Installer ready: {0}" -f $outDir)
Write-Host ("Setup.exe: {0:N1} MB" -f ($setupSize / 1MB))
Write-Host ("Payload:   {0:N2} GB" -f ($payloadSize / 1GB))
