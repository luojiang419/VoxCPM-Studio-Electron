param([string]$InstallRoot = '', [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'installed_resources.ps1')
$values = Get-InstalledVoxCPMResources -InstallRoot $InstallRoot
$values.VOXCPM_APP_ROOT = Join-Path $PSScriptRoot 'dev_backend'
$values.VOXCPM_DATA_ROOT = Join-Path $repoRoot '..\data'
$values.VOXCPM_OFFLINE = '1'
$values.HF_HUB_OFFLINE = '1'
$values.HF_DATASETS_OFFLINE = '1'
$values.PIP_NO_INDEX = '1'
$values.PYTHONUTF8 = '1'
$values.PYTHONIOENCODING = 'utf-8'
$values.PYTHONDONTWRITEBYTECODE = '1'
$values.ELECTRON_RUN_AS_NODE = $null
$frontend = Join-Path $repoRoot 'frontend\voxcpm_studio_electron'
$electron = Join-Path $frontend 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron)) { throw '本地 Electron 依赖不存在，未自动下载。' }
$saved = @{}
Push-Location $frontend
try {
    foreach ($key in $values.Keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process'); [Environment]::SetEnvironmentVariable($key, $values[$key], 'Process') }
    Write-Host "直接复用已安装资源：$($values.VOXCPM_INSTALLED_ROOT)"
    if (-not $SkipBuild) {
        & node node_modules/vite/bin/vite.js build
        if ($LASTEXITCODE -ne 0) { throw '本地界面构建失败' }
    }
    & $electron .
    if ($LASTEXITCODE -ne 0) { throw "开发工作台退出异常：$LASTEXITCODE" }
} finally {
    Pop-Location
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
}
