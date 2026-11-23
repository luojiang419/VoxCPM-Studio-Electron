param([int]$UpdaterProcessId, [string]$ButtonName)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$updater = Get-Process -Id $UpdaterProcessId
$window = [System.Windows.Automation.AutomationElement]::FromHandle($updater.MainWindowHandle)
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $ButtonName)
$button = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
if (!$button -or !$button.Current.IsEnabled) {
  $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $names = foreach ($item in $items) { $item.Current.Name }
  throw ('Updater button is missing or disabled: ' + $ButtonName + '; found: ' + ($names -join ', '))
}
try {
  $invoke = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $invoke.Invoke()
} catch [System.InvalidOperationException] {
  # .NET Framework custom controls may omit InvokePattern; use their real Enter handler.
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class UpdaterTestKeys {
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
}
'@
  $handle = [IntPtr]$button.Current.NativeWindowHandle
  if ($handle -eq [IntPtr]::Zero) { throw 'Updater button has no native handle' }
  [UpdaterTestKeys]::SendMessage($handle, 0x100, [IntPtr]13, [IntPtr]::Zero) | Out-Null
  [UpdaterTestKeys]::SendMessage($handle, 0x101, [IntPtr]13, [IntPtr]::Zero) | Out-Null
}
