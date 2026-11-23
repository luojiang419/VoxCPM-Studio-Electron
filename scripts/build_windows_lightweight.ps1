param([string]$PythonExe = "python", [string]$Output = "")
$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "build_lightweight.py"
$buildArgs = @($scriptPath)
if ($Output) { $buildArgs += @("--output", $Output) }
& $PythonExe @buildArgs
if ($LASTEXITCODE -ne 0) { throw "轻量版构建失败：$LASTEXITCODE" }
