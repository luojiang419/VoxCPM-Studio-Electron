param([switch]$SkipBuild, [int]$DebugPort = 0, [switch]$Hidden)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
. (Join-Path $PSScriptRoot 'installed_resources.ps1')
$values = Get-InstalledVoxCPMResources
$testRoot = Join-Path $repoRoot 'builds/moss-test'
$values.VOXCPM_APP_ROOT = Join-Path $PSScriptRoot 'dev_backend'
$values.VOXCPM_DATA_ROOT = Join-Path $testRoot 'data'
$values.VOXCPM_MOSS_ROOT = Join-Path $repoRoot 'builds/moss'
$values.VOXCPM_DEVELOPMENT_LABEL = 'MOSS 隔离测试'
$values.VOXCPM_OFFLINE = '1'
$values.HF_HUB_OFFLINE = '1'
$values.HF_DATASETS_OFFLINE = '1'
$values.PIP_NO_INDEX = '1'
$values.PYTHONUTF8 = '1'
$values.PYTHONIOENCODING = 'utf-8'
$values.PYTHONDONTWRITEBYTECODE = '1'
$values.ELECTRON_RUN_AS_NODE = $null
$configDir = Join-Path $values.VOXCPM_DATA_ROOT 'config'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$config = Join-Path $configDir 'studio_config.json'
if (-not (Test-Path -LiteralPath $config)) {
    @{ output_dir = (Join-Path $values.VOXCPM_DATA_ROOT 'outputs'); cache_dir = (Join-Path $values.VOXCPM_DATA_ROOT 'cache'); proxy_url = '' } | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding utf8
}
$frontend = Join-Path $repoRoot 'frontend/voxcpm_studio_electron'
$electron = Join-Path $frontend 'node_modules/electron/dist/electron.exe'
if (-not (Test-Path -LiteralPath $electron)) { throw '缺少开发 Electron 依赖，请按测试说明配置已有 node_modules。' }
$saved = @{}
try {
    foreach ($key in $values.Keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process'); [Environment]::SetEnvironmentVariable($key, $values[$key], 'Process') }
    if (-not $SkipBuild) {
        Push-Location $frontend
        try { & node node_modules/vite/bin/vite.js build; if ($LASTEXITCODE -ne 0) { throw '界面构建失败' } } finally { Pop-Location }
    }
    $launchArgs = @(('"' + $frontend + '"'), ('--user-data-dir="' + (Join-Path $testRoot 'electron-profile') + '"'))
    if ($DebugPort) { $launchArgs += "--remote-debugging-port=$DebugPort" }
    $launch = @{ FilePath = $electron; ArgumentList = $launchArgs; WorkingDirectory = $frontend; PassThru = $true; Environment = $values;
        RedirectStandardError = (Join-Path $testRoot 'desktop-error.log'); RedirectStandardOutput = (Join-Path $testRoot 'desktop-out.log') }
    if ($Hidden) { $launch.WindowStyle = 'Hidden' }
    $child = Start-Process @launch
    Write-Host "MOSS 隔离测试版已启动，PID $($child.Id)"
    Write-Host "独立数据：$($values.VOXCPM_DATA_ROOT)"
    Write-Host '正式安装的模型仅供读取；MOSS 权重和环境留在当前测试目录。'
} finally {
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
}
