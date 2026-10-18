param([int]$UpdaterProcessId, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class UpdateWindowCapture {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr context, int flags);
}
'@
$updater = Get-Process -Id $UpdaterProcessId
if (-not $updater.MainWindowHandle) { throw '独立更新器窗口尚未显示' }
$rectangle = New-Object UpdateWindowCapture+Rect
if (-not [UpdateWindowCapture]::GetWindowRect($updater.MainWindowHandle, [ref]$rectangle)) { throw '无法读取更新器窗口范围' }
$bitmap = New-Object Drawing.Bitmap(($rectangle.Right - $rectangle.Left), ($rectangle.Bottom - $rectangle.Top))
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$context = $graphics.GetHdc()
try {
    if (-not [UpdateWindowCapture]::PrintWindow($updater.MainWindowHandle, $context, 2)) { throw '独立窗口截图失败' }
} finally { $graphics.ReleaseHdc($context); $graphics.Dispose() }
$bitmap.Save($OutputPath, [Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Output $updater.MainWindowTitle
