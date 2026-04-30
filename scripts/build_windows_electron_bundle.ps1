param(
    [string]$PythonVersion = "3.12.10",
    [string]$BundleName = "VoxCPM-Studio-Electron-Portable",
    [string]$OutputRoot = "",
    [string]$ModelDir = "",
    [string]$ModelRepoId = "openbmb/VoxCPM2",
    [string]$FfmpegDir = "G:\data\app\DIT\ffmpeg",
    [string]$ProxyUrl = "http://127.0.0.1:7890",
    [string]$ElectronMirror = "https://npmmirror.com/mirrors/electron/",
    [string]$TorchMirrorBaseUrl = "https://mirrors.aliyun.com/pytorch-wheels",
    [string]$PyPIMirrorUrl = "https://mirrors.aliyun.com/pypi/simple/",
    [ValidateSet("cu118", "cu124", "cu126", "cu128", "cu130")]
    [string]$TorchChannel = "cu126",
    [string]$TorchVersion = "2.6.0",
    [string]$TorchAudioVersion = "2.6.0",
    [switch]$UseCpuTorch,
    [switch]$SkipModelDownload
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$electronRoot = Split-Path -Parent $scriptDir
$projectRoot = Split-Path -Parent $electronRoot
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $electronRoot "builds"
}

$bundleRoot = Join-Path $OutputRoot $BundleName
$electronProject = Join-Path $electronRoot "frontend\voxcpm_studio_electron"
$electronBundleRoot = Join-Path $bundleRoot "electron_shell"
$electronRuntime = Join-Path $electronProject "node_modules\electron\dist"
$desktopExeName = "VoxCPM Studio.exe"
$desktopExePath = Join-Path $bundleRoot $desktopExeName
$resourcesRoot = Join-Path $bundleRoot "resources"
$resourcesAppRoot = Join-Path $resourcesRoot "app"
$desktopLauncherBat = Join-Path $bundleRoot "Launch VoxCPM Studio Desktop.bat"
$electronAliasBat = Join-Path $bundleRoot "Launch VoxCPM Studio Electron.bat"
$legacyDesktopBat = Join-Path $bundleRoot "Launch VoxCPM Studio Legacy WebView.bat"
$manifestPath = Join-Path $bundleRoot "runtime_manifest.json"
$zipPath = Join-Path $OutputRoot "$BundleName.zip"
$robocopyExe = Join-Path $env:WINDIR "System32\robocopy.exe"
$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
$tarExe = Join-Path $env:WINDIR "System32\tar.exe"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Checked {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$WorkingDirectory = $projectRoot
    )

    Write-Host "$FilePath $($Arguments -join ' ')" -ForegroundColor DarkGray
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -NoNewWindow -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "Command failed with exit code $($process.ExitCode): $FilePath $($Arguments -join ' ')"
    }
}

function Invoke-Robocopy {
    param(
        [string]$Source,
        [string]$Destination,
        [string[]]$ExtraArgs = @("/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
    )

    if (-not (Test-Path $robocopyExe)) {
        throw "robocopy.exe not found: $robocopyExe"
    }

    $argumentList = @($Source, $Destination) + $ExtraArgs
    $process = Start-Process -FilePath $robocopyExe -ArgumentList $argumentList -NoNewWindow -Wait -PassThru
    return $process.ExitCode
}

function Compress-BundleArchive {
    param(
        [string]$RootDirectory,
        [string]$BundleDirectoryName,
        [string]$ArchivePath
    )

    if (-not (Test-Path $tarExe)) {
        throw "tar.exe not found: $tarExe"
    }

    if (Test-Path $ArchivePath) {
        Remove-Item -LiteralPath $ArchivePath -Force
    }

    $archiveName = Split-Path -Leaf $ArchivePath
    $process = Start-Process -FilePath $tarExe -ArgumentList @("-a", "-c", "-f", $archiveName, $BundleDirectoryName) -WorkingDirectory $RootDirectory -NoNewWindow -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "tar.exe failed with exit code $($process.ExitCode): $archiveName"
    }
}

if (-not (Test-Path $electronProject)) {
    throw "Electron project not found: $electronProject"
}
if ([string]::IsNullOrWhiteSpace($npmCmd)) {
    throw "npm.cmd not found in current Windows environment"
}
if ([string]::IsNullOrWhiteSpace($nodeExe)) {
    throw "node.exe not found in current Windows environment"
}

Write-Step "Build bundled Python runtime first"
$portableScript = Join-Path $projectRoot "scripts\build_windows_portable.ps1"
$portableArgs = @(
    "-ExecutionPolicy", "Bypass",
    "-File", $portableScript,
    "-PythonVersion", $PythonVersion,
    "-BundleName", $BundleName,
    "-FfmpegDir", $FfmpegDir,
    "-ProxyUrl", $ProxyUrl,
    "-TorchMirrorBaseUrl", $TorchMirrorBaseUrl,
    "-PyPIMirrorUrl", $PyPIMirrorUrl,
    "-TorchChannel", $TorchChannel,
    "-TorchVersion", $TorchVersion,
    "-TorchAudioVersion", $TorchAudioVersion,
    "-SkipZip"
)
if (-not [string]::IsNullOrWhiteSpace($OutputRoot)) {
    $portableArgs += @("-OutputRoot", $OutputRoot)
}
if (-not [string]::IsNullOrWhiteSpace($ModelDir)) {
    $portableArgs += @("-ModelDir", $ModelDir)
}
if (-not [string]::IsNullOrWhiteSpace($ModelRepoId)) {
    $portableArgs += @("-ModelRepoId", $ModelRepoId)
}
if ($UseCpuTorch) {
    $portableArgs += "-UseCpuTorch"
}
if ($SkipModelDownload) {
    $portableArgs += "-SkipModelDownload"
}
Invoke-Checked -FilePath "powershell.exe" -Arguments $portableArgs

Write-Step "Install Electron renderer dependencies"
$previousElectronMirror = $env:ELECTRON_MIRROR
if (-not [string]::IsNullOrWhiteSpace($ElectronMirror)) {
    $env:ELECTRON_MIRROR = $ElectronMirror
}
try {
    Invoke-Checked -FilePath $npmCmd -Arguments @("install") -WorkingDirectory $electronProject

Write-Step "Build Electron renderer assets"
    Invoke-Checked -FilePath $nodeExe -Arguments @((Join-Path $electronProject "node_modules\vite\bin\vite.js"), "build") -WorkingDirectory $electronProject
} finally {
    $env:ELECTRON_MIRROR = $previousElectronMirror
}

if (-not (Test-Path (Join-Path $electronRuntime "electron.exe"))) {
    throw "Electron runtime not found: $(Join-Path $electronRuntime 'electron.exe')"
}

Write-Step "Assemble direct desktop executable"
Invoke-Robocopy -Source $electronRuntime -Destination $bundleRoot
if (Test-Path $desktopExePath) {
    Remove-Item -LiteralPath $desktopExePath -Force
}
Rename-Item -LiteralPath (Join-Path $bundleRoot "electron.exe") -NewName $desktopExeName -Force
if (Test-Path $resourcesAppRoot) {
    Remove-Item -LiteralPath $resourcesAppRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $resourcesAppRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $electronProject "main.js") -Destination (Join-Path $resourcesAppRoot "main.js") -Force
Copy-Item -LiteralPath (Join-Path $electronProject "preload.js") -Destination (Join-Path $resourcesAppRoot "preload.js") -Force
Copy-Item -LiteralPath (Join-Path $electronProject "package.json") -Destination (Join-Path $resourcesAppRoot "package.json") -Force
Invoke-Robocopy -Source (Join-Path $electronProject "dist") -Destination (Join-Path $resourcesAppRoot "dist")

Write-Step "Copy Electron shell into bundle"
if (Test-Path $electronBundleRoot) {
    Remove-Item -LiteralPath $electronBundleRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $electronBundleRoot | Out-Null
$copyCode = Invoke-Robocopy -Source $electronProject -Destination $electronBundleRoot -ExtraArgs @("/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/XD", "release")
if ($copyCode -ge 8) {
    throw "robocopy failed while copying Electron shell files"
}

$existingDesktopLauncher = Join-Path $bundleRoot "Launch VoxCPM Studio Desktop.bat"
if (Test-Path $existingDesktopLauncher) {
    Move-Item -LiteralPath $existingDesktopLauncher -Destination $legacyDesktopBat -Force
}

$launcher = @"
@echo off
setlocal
cd /d "%~dp0"
set "PATH=%~dp0runtime\python;%~dp0runtime\python\Scripts;%~dp0ffmpeg\bin;%~dp0ffmpeg;%PATH%"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
set "VOXCPM_APP_ROOT=%~dp0app"
set "VOXCPM_DATA_ROOT=%~dp0data"
set "VOXCPM_PYTHON_EXE=%~dp0runtime\python\python.exe"
if exist "%~dp0models" set "VOXCPM_MODEL_DIR=%~dp0models"
start "" "%~dp0VoxCPM Studio.exe"
endlocal
"@

Set-Content -LiteralPath $desktopLauncherBat -Value $launcher -Encoding ASCII
Set-Content -LiteralPath $electronAliasBat -Value $launcher -Encoding ASCII

if (Test-Path $manifestPath) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest | Add-Member -NotePropertyName "desktop_shell" -NotePropertyValue "electron" -Force
    $manifest | Add-Member -NotePropertyName "desktop_exe" -NotePropertyValue ".\VoxCPM Studio.exe" -Force
    $manifest | Add-Member -NotePropertyName "desktop_entry" -NotePropertyValue ".\Launch VoxCPM Studio Desktop.bat" -Force
    $manifest | Add-Member -NotePropertyName "legacy_webview_entry" -NotePropertyValue ".\Launch VoxCPM Studio Legacy WebView.bat" -Force
    $manifest | Add-Member -NotePropertyName "electron_shell_root" -NotePropertyValue ".\electron_shell" -Force
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
}

Write-Step "Compress Electron portable bundle"
Compress-BundleArchive -RootDirectory $OutputRoot -BundleDirectoryName $BundleName -ArchivePath $zipPath

Write-Step "Electron portable bundle build completed"
Write-Host "Bundle directory: $bundleRoot" -ForegroundColor Green
Write-Host "Archive path: $zipPath" -ForegroundColor Green
Write-Host "Default desktop entry: $desktopLauncherBat" -ForegroundColor Green
Write-Host "Legacy WebView fallback: $legacyDesktopBat" -ForegroundColor Yellow
