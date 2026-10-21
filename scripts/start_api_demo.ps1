param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'installed_resources.ps1')
$resources = Get-InstalledVoxCPMResources
foreach ($key in $resources.Keys) { [Environment]::SetEnvironmentVariable($key, $resources[$key], 'Process') }
$env:VOXCPM_DATA_ROOT = Join-Path $repoRoot 'builds/api-demo-data'
$env:VOXCPM_LAZY_STARTUP = '1'
$env:VOXCPM_OFFLINE = '1'
$env:HF_HUB_OFFLINE = '1'
$env:HF_DATASETS_OFFLINE = '1'
$env:PIP_NO_INDEX = '1'
$env:PYTHONUTF8 = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$frontend = Join-Path $repoRoot 'frontend/voxcpm_studio_electron'
if (-not $SkipBuild) {
    Push-Location $frontend
    try { & node node_modules/vite/bin/vite.js build; if ($LASTEXITCODE -ne 0) { throw '界面构建失败' } } finally { Pop-Location }
}
New-Item -ItemType Directory -Path "$repoRoot/builds/api-demo-data/logs" -Force | Out-Null
$existing = Get-NetTCPConnection -LocalPort 8918 -State Listen -ErrorAction SilentlyContinue
if ($existing) { throw '8918 端口已占用，请先检查正在运行的演示' }
Start-Process -FilePath $resources.VOXCPM_PYTHON_EXE -ArgumentList @("`"$PSScriptRoot/serve_api_demo.py`"") -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput "$repoRoot/builds/api-demo-data/logs/stdout.log" -RedirectStandardError "$repoRoot/builds/api-demo-data/logs/stderr.log"
Write-Output 'VoxCPM API 设置演示启动中：http://127.0.0.1:8918/；直接复用已安装 Python 和模型。'
