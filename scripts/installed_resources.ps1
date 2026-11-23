function Get-InstalledVoxCPMResources {
    param([string]$InstallRoot = '')
    $repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    if (-not $InstallRoot) { $InstallRoot = $env:VOXCPM_INSTALLED_ROOT }
    if (-not $InstallRoot) {
        foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\VoxCPMStudio', 'HKCU:\Software\VoxCPMStudio\Installer')) {
            $record = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
            if ($record.InstallLocation) { $InstallRoot = $record.InstallLocation; break }
        }
    }
    if (-not $InstallRoot) { throw '未找到已安装目录。请使用 -InstallRoot 指定安装器实际安装的位置；不会自动下载模型。' }
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    $markerPath = Join-Path $InstallRoot '.voxcpm-install.json'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw "目录缺少安装记录：$InstallRoot" }
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ($marker.product -ne 'voxcpm-studio' -or $marker.state -ne 'complete' -or [IO.Path]::GetFullPath($marker.root).TrimEnd('\') -ne $InstallRoot) { throw '安装记录不完整或与目录不匹配，未尝试下载或修复。' }
    $pythonPath = ''
    foreach ($profile in @('cu128', 'cu126', 'cpu')) {
        $candidate = Join-Path $InstallRoot "runtime\managed\py312-$profile\python.exe"
        if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path (Split-Path $candidate -Parent) 'ready.json'))) { $pythonPath = $candidate; break }
    }
    if (-not $pythonPath) { throw '已安装目录没有就绪的 Python 环境；请从正式软件检查安装，不在开发目录重新下载。' }
    $catalog = Get-Content -LiteralPath (Join-Path $repoRoot 'frontend\voxcpm_studio_electron\music-config.json') -Raw | ConvertFrom-Json
    $runtimeCatalog = Get-Content -LiteralPath (Join-Path $repoRoot 'frontend\voxcpm_studio_electron\runtime-config.json') -Raw | ConvertFrom-Json
    $modelsRoot = Join-Path $InstallRoot 'models'
    $voiceRoot = Join-Path $modelsRoot $runtimeCatalog.models[0].folder
    if (-not (Test-Path -LiteralPath (Join-Path $voiceRoot 'config.json'))) { throw "未找到已安装的配音模型：$voiceRoot；不自动下载。" }
    $lipsyncRoot = Join-Path $InstallRoot 'data\lipsync'
    $lipsyncSettings = Join-Path $InstallRoot 'data\lipsync-settings.json'
    if (Test-Path -LiteralPath $lipsyncSettings) {
        $settings = Get-Content -LiteralPath $lipsyncSettings -Raw | ConvertFrom-Json
        if ($settings.root) { $lipsyncRoot = [IO.Path]::GetFullPath($settings.root) }
    }
    return @{
        VOXCPM_INSTALLED_ROOT=$InstallRoot; VOXCPM_INSTALLED_RESOURCES_READONLY='1';
        VOXCPM_PYTHON_EXE=$pythonPath; VOXCPM_MODEL_DIR=$voiceRoot; VOXCPM_MODELS_ROOT=$modelsRoot;
        ZIPENHANCER_MODEL_PATH=(Join-Path $modelsRoot $runtimeCatalog.models[2].folder);
        VOXCPM_MUSIC_MODELS_ROOT=(Join-Path $modelsRoot 'music');
        VOXCPM_MUSIC_ENGINE_ROOT=(Join-Path $InstallRoot "runtime\music\$($catalog.runtime.version)");
        VOXCPM_LIPSYNC_ROOT=$lipsyncRoot
    }
}
