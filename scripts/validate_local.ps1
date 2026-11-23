param([string]$PythonExe = "python", [string]$Script = "", [string[]]$ScriptArgs = @(), [string]$InstallRoot = '', [switch]$Fixture)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$projectRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot '..'))
$assetDirs = @(
    "$repoRoot\builds\modelscope-distribution\assets",
    "$repoRoot\builds\modelscope-distribution\wheels",
    "$repoRoot\builds\modelscope-distribution",
    "$repoRoot\builds\lipsync-assets",
    "$projectRoot\vendor\windows_312_cu126\wheels",
    "$projectRoot\vendor\windows_312_cu126\assets",
    "$projectRoot\data\lipsync"
    "$projectRoot\data\cache\music-runtime\20261018-v1"
) + @(Get-ChildItem -LiteralPath "$projectRoot\models" -Directory | ForEach-Object FullName)
$values = @{ VOXCPM_OFFLINE='1'; HF_HUB_OFFLINE='1'; HF_DATASETS_OFFLINE='1'; PIP_NO_INDEX='1'; PYTHONUTF8='1'; PYTHONIOENCODING='utf-8';
    PIP_DISABLE_PIP_VERSION_CHECK='1'; PYTHONDONTWRITEBYTECODE='1'; VOXCPM_LOCAL_ASSET_DIRS=($assetDirs -join [IO.Path]::PathSeparator) }
if ($Script -and -not $Fixture) {
    . (Join-Path $PSScriptRoot 'installed_resources.ps1')
    $installed = Get-InstalledVoxCPMResources -InstallRoot $InstallRoot
    foreach ($key in $installed.Keys) { $values[$key] = $installed[$key] }
    if (-not $PSBoundParameters.ContainsKey('PythonExe')) { $PythonExe = $installed.VOXCPM_PYTHON_EXE }
    Write-Host "验收直接读取已安装模型：$($installed.VOXCPM_INSTALLED_ROOT)"
}
$saved = @{}
try {
    foreach ($key in $values.Keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process'); [Environment]::SetEnvironmentVariable($key, $values[$key], 'Process') }
    Push-Location $repoRoot
    if ($Script) {
        $scriptPath = [IO.Path]::GetFullPath((Join-Path $repoRoot $Script))
        if (-not $scriptPath.StartsWith("$repoRoot\scripts\", [StringComparison]::OrdinalIgnoreCase)) { throw '验收脚本必须位于本仓库 scripts 目录' }
        if ($scriptPath.EndsWith('.py')) { & $PythonExe $scriptPath @ScriptArgs }
        elseif ($scriptPath.EndsWith('.cjs') -or $scriptPath.EndsWith('.js')) { & node $scriptPath @ScriptArgs }
        else { throw '仅支持 Python 或 Node 验收脚本' }
        if ($LASTEXITCODE -ne 0) { throw "离线验收失败：$LASTEXITCODE" }
    } else {
        & node --test frontend/voxcpm_studio_electron/tests/runtime-service.test.cjs
        if ($LASTEXITCODE -ne 0) { throw '运行环境回归失败' }
        & $PythonExe scripts/test_music_suite.py tests/test_lipsync_prepare.py -q -p no:cacheprovider
        if ($LASTEXITCODE -ne 0) { throw '视频资源回归失败' }
    }
} finally {
    Pop-Location
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
}
