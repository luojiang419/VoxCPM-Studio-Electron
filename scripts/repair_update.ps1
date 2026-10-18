param([string]$InstallRoot)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    if (-not $InstallRoot) {
        $saved = Get-ItemProperty 'HKCU:\Software\VoxCPMStudio\Installer' -ErrorAction SilentlyContinue
        if ($saved.InstallLocation -and (Test-Path -LiteralPath (Join-Path $saved.InstallLocation 'runtime_manifest.json'))) { $InstallRoot = $saved.InstallLocation }
    }
    if (-not $InstallRoot) {
        $candidates = @(
            (Join-Path $env:LOCALAPPDATA 'VoxCPMStudio')
            (Join-Path $env:LOCALAPPDATA 'Apps\VoxCPMStudio')
            (Join-Path $env:USERPROFILE 'Apps\VoxCPMStudio')
            (Join-Path $env:USERPROFILE 'VoxCPMStudio')
            Get-PSDrive -PSProvider FileSystem | ForEach-Object { Join-Path $_.Root 'Program Files\VoxCPMStudio' }
        ) | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'runtime_manifest.json') } | Select-Object -Unique
        if (@($candidates).Count -eq 1) { $InstallRoot = @($candidates)[0] }
    }
    if (-not $InstallRoot) {
        Add-Type -AssemblyName System.Windows.Forms
        $picker = New-Object System.Windows.Forms.FolderBrowserDialog
        $picker.Description = '选择包含 VoxCPM Studio.exe 的原软件安装目录（不会删除模型和作品）'
        if ($picker.ShowDialog() -ne 'OK') { exit 1 }
        $InstallRoot = $picker.SelectedPath
    }
    if (Test-Path -LiteralPath $InstallRoot -PathType Leaf) { $InstallRoot = Split-Path -LiteralPath $InstallRoot -Parent }
    $InstallRoot = (Resolve-Path -LiteralPath $InstallRoot).Path
    Write-Host "正在修复：$InstallRoot"
    $pythonCandidates = @((Join-Path $InstallRoot 'runtime\python\python.exe'))
    $managed = Join-Path $InstallRoot 'runtime\managed'
    if (Test-Path -LiteralPath $managed) {
        $pythonCandidates = @(Get-ChildItem -LiteralPath $managed -Directory | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'python.exe' }) + $pythonCandidates
    }
    $python = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $python) { throw '未找到软件自带 Python。请先在软件中完成运行环境准备，再关闭软件运行修复。' }
    $prepared = & $python (Join-Path $PSScriptRoot 'repair_update.py') $InstallRoot
    if ($LASTEXITCODE -ne 0) { throw '修复准备失败，请查看上方具体原因。原应用文件尚未替换。' }
    $session = $prepared | ConvertFrom-Json
    Write-Host "目标发布序号：$($session.releaseId)"
    $lastMessage = ''
    while ($true) {
        $log = Join-Path $session.session 'updater.log'
        if (Test-Path -LiteralPath $log) {
            $line = Get-Content -LiteralPath $log -Tail 1
            try { $progress = $line | ConvertFrom-Json; if ($progress.message -and $progress.message -ne $lastMessage) { $lastMessage = $progress.message; Write-Host $lastMessage } } catch { }
        }
        $statusPath = Join-Path $session.session 'status.json'
        if (Test-Path -LiteralPath $statusPath) {
            $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($status.status -eq 'complete') { Write-Host '修复成功。软件已自动启动，可在设置中查看发布序号并再次检查更新。'; break }
            if ($status.status -in @('error','rolled-back')) { throw "$($status.message)`n日志：$log" }
        }
        if (-not (Get-Process -Id $session.pid -ErrorAction SilentlyContinue)) { throw "更新器已退出，请查看日志：$log" }
        Start-Sleep -Milliseconds 500
    }
} catch {
    Write-Host "修复未完成：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
