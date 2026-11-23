param([string]$Plan = '', [switch]$Apply)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$projectRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot '..'))
if (-not $Plan) { $Plan = Join-Path $repoRoot 'builds\storage-cleanup\plan.json' }
$planPath = [IO.Path]::GetFullPath($Plan)
if (-not $planPath.StartsWith("$repoRoot\builds\storage-cleanup\", [StringComparison]::OrdinalIgnoreCase)) { throw '清理清单必须存放于 builds/storage-cleanup' }
$document = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
if ([IO.Path]::GetFullPath($document.root) -ne $projectRoot) { throw '清单与当前工作区不匹配' }
$allowed = @("$repoRoot\builds\", "$projectRoot\启动准备开发\builds\", "$projectRoot\音乐助手开发\builds\", "$projectRoot\backup\", "$projectRoot\vendor\")
$targets = @()
foreach ($entry in $document.targets) {
    $target = [IO.Path]::GetFullPath((Join-Path $projectRoot $entry.path))
    if (-not $target.StartsWith("$projectRoot\", [StringComparison]::OrdinalIgnoreCase)) { throw "路径越界：$target" }
    if ($target -match '[\\/]\.git([\\/]|$)|[\\/]\.update-private([\\/]|$)' -or $target.StartsWith("$repoRoot\builds\storage-cleanup", [StringComparison]::OrdinalIgnoreCase)) { throw "受保护路径：$target" }
    $isCache = ((Split-Path $target -Leaf) -in @('__pycache__', '.pytest_cache', '.cache'))
    if (-not $isCache -and -not @($allowed | Where-Object { $target.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count) { throw "不在可清理目录中：$target" }
    # 拒绝通过任何上级 junction 写到实际项目之外；目标自身为 junction 时只删除链接。
    $ancestor = Split-Path $target -Parent
    while ($ancestor -and $ancestor -ne $projectRoot) {
        $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "清单路径穿过目录联接：$target" }
        $ancestor = Split-Path $ancestor -Parent
    }
    $targets += $target
}
Write-Host "已核对 $($targets.Count) 个项目内目标；执行模式：$Apply"
if (-not $Apply) { $document.targets | Format-Table path,reason -AutoSize; return }
$running = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(pythonw?|electron|JVOX.*|VoxCPM.*)\.exe$' -and $_.CommandLine -like "*$projectRoot*" })
if ($running.Count) { throw "项目有 $($running.Count) 个运行进程，请先退出后清理" }

function Remove-LocalTree([string]$Target) {
    $item = Get-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
    if (-not $item) { return }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Remove-Item -LiteralPath $Target -Force; return }
    if ($item.PSIsContainer) {
        # PowerShell 7 不穿透目录联接；先逐项去掉联接，避免运行环境/模型目标受影响。
        $stack = [Collections.Generic.Stack[string]]::new()
        $stack.Push($Target)
        while ($stack.Count) {
            $folder = $stack.Pop()
            foreach ($child in Get-ChildItem -LiteralPath $folder -Force) {
                if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { Remove-Item -LiteralPath $child.FullName -Force }
                elseif ($child.PSIsContainer) { $stack.Push($child.FullName) }
            }
        }
        # 个别硬链接可能被其他项目的 Python 映射。继续清理其余文件，保留占用项。
        $removalErrors = @()
        Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction SilentlyContinue -ErrorVariable removalErrors
        if (Test-Path -LiteralPath $Target) { throw "仍有 $($removalErrors.Count) 项无法删除：$($removalErrors[0].Exception.Message)" }
    } else { Remove-Item -LiteralPath $Target -Force }
}
$freeBefore = (Get-PSDrive -Name ([IO.Path]::GetPathRoot($projectRoot).TrimEnd('\', ':'))).Free
$removed = @(); $failed = @()
foreach ($target in $targets) {
    try { Remove-LocalTree $target; $removed += $target }
    catch { $failed += @{path=$target; error=$_.Exception.Message}; Write-Warning "未能清理：$target，$($_.Exception.Message)" }
}
$freeAfter = (Get-PSDrive -Name ([IO.Path]::GetPathRoot($projectRoot).TrimEnd('\', ':'))).Free
$report = @{time=(Get-Date -Format o); root=$projectRoot; freeBefore=$freeBefore; freeAfter=$freeAfter;
    freedBytes=($freeAfter-$freeBefore); removed=$removed; failed=$failed}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path (Split-Path $planPath -Parent) 'result.json') -Encoding utf8
Write-Host "完成 $($removed.Count) 项，失败 $($failed.Count) 项；磁盘可用空间增加 $([math]::Round(($freeAfter-$freeBefore)/1GB,2)) GiB"
if ($failed.Count) { throw '部分清理未完成，见 result.json' }
