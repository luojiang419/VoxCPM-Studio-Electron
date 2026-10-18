"""在独立目录、隔离注册表键与快捷方式目录验收安装和卸载。"""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
output = ROOT / "builds/installer-validation"
output.mkdir(exist_ok=True)
exe = output / "InstallationTests.exe"
subprocess.run(["C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe", "/nologo", "/target:exe", "/main:InstallationTests", "/out:" + str(exe),
                "/resource:" + str(ROOT / "assets/brand/disk-local-256.png") + ",disk-local.png", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:Accessibility.dll", "/reference:System.Web.Extensions.dll",
                "/reference:System.IO.Compression.dll", "/reference:System.IO.Compression.FileSystem.dll",
                str(ROOT / "bootstrap/Program.cs"), str(ROOT / "bootstrap/Installation.cs"), str(ROOT / "bootstrap/Components.cs"), str(ROOT / "bootstrap/DiskCard.cs"), str(ROOT / "bootstrap/InstallationTests.cs")], check=True)
subprocess.run([str(exe)], check=True)
