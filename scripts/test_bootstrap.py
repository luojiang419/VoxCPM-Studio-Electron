"""编译并运行原生启动器下载/恢复测试；可选验证真实魔搭桌面包。"""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
executable = ROOT / "builds/modelscope-distribution/BootstrapTests.exe"
executable.parent.mkdir(parents=True, exist_ok=True)
compiler = "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
subprocess.run([compiler, "/nologo", "/target:exe", "/main:BootstrapTests", "/out:" + str(executable),
                "/win32manifest:" + str(ROOT / "bootstrap/long-path.manifest"),
                "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:Accessibility.dll", "/reference:System.Web.Extensions.dll",
                "/reference:System.IO.Compression.dll", "/reference:System.IO.Compression.FileSystem.dll",
                str(ROOT / "bootstrap/Program.cs"), str(ROOT / "bootstrap/SharedTheme.cs"), str(ROOT / "bootstrap/Installation.cs"), str(ROOT / "bootstrap/Components.cs"), str(ROOT / "bootstrap/DiskCard.cs"), str(ROOT / "bootstrap/Tests.cs")], check=True)
subprocess.run([str(executable), *sys.argv[1:]], check=True)
