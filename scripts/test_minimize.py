"""真实原生窗口最小化/恢复及最小化期间下载验证；仅操作隔离测试窗口。"""
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
output = ROOT / 'builds/minimize-validation' / str(time.time_ns())
output.mkdir(parents=True)
executable = output / 'MinimizeTests.exe'
subprocess.run([
    'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', '/nologo', '/target:exe',
    '/main:MinimizeTests', '/out:' + str(executable),
    *['/reference:' + name for name in ('System.Windows.Forms.dll', 'System.Drawing.dll', 'Accessibility.dll',
                                      'System.Web.Extensions.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll')],
    *[str(ROOT / 'bootstrap' / name) for name in ('Program.cs', 'SharedTheme.cs', 'Installation.cs', 'Components.cs', 'DiskCard.cs', 'MinimizeTests.cs')],
    str(ROOT / 'updater/Program.cs'),
], check=True)
result = subprocess.run([str(executable), str(output)], capture_output=True, timeout=60)
(output / 'result.log').write_bytes(result.stdout + result.stderr)
print((result.stdout + result.stderr).decode('utf8', errors='replace'))
print('证据：' + str(output))
sys.exit(result.returncode)
