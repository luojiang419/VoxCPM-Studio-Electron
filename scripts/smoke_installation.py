"""显式验收完整安装握手；只允许借用本仓库 builds 下的测试环境。"""
import argparse
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--manifest", type=Path, required=True)
parser.add_argument("--payload", type=Path, required=True)
parser.add_argument("--installer", type=Path, required=True)
args = parser.parse_args()
output = ROOT / "builds/installer-live-validation"
output.mkdir(exist_ok=True)
executable = output / "InstallationSmoke.exe"
subprocess.run(["C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe", "/nologo", "/target:exe", "/main:InstallationSmoke", "/out:" + str(executable),
                "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:Accessibility.dll", "/reference:System.Web.Extensions.dll",
                "/reference:System.IO.Compression.dll", "/reference:System.IO.Compression.FileSystem.dll",
                *[str(ROOT / "bootstrap" / name) for name in ("Program.cs", "Installation.cs", "DiskCard.cs", "InstallationSmoke.cs")]], check=True)
subprocess.run([str(executable), str(args.manifest.resolve()), str(args.payload.resolve()), str(args.installer.resolve()),
                str(ROOT / "builds/bootstrap-validation/runtime"), str(ROOT / "builds/bootstrap-validation/models"), str(output),
                str(ROOT / "assets/brand/voxcpm-app.ico")], check=True)
