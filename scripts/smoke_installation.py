"""显式验收完整安装握手；只允许借用本仓库 builds 下的测试环境。"""
import argparse
import os
import uuid
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--manifest", type=Path, required=True)
parser.add_argument("--payload", type=Path, required=True)
parser.add_argument("--installer", type=Path, required=True)
parser.add_argument("--standard-user", action="store_true", help="用非管理员令牌在 C 盘中文路径完整验收")
args = parser.parse_args()
output = ROOT / "builds/installer-live-validation"
output.mkdir(exist_ok=True)
executable = output / "InstallationSmoke.exe"
subprocess.run(["C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe", "/nologo", "/target:exe", "/main:InstallationSmoke", "/out:" + str(executable),
                "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:Accessibility.dll", "/reference:System.Web.Extensions.dll",
                "/reference:System.IO.Compression.dll", "/reference:System.IO.Compression.FileSystem.dll",
                *[str(ROOT / "bootstrap" / name) for name in ("Program.cs", "SharedTheme.cs", "Installation.cs", "Components.cs", "DiskCard.cs", "InstallationSmoke.cs")]], check=True)
command = [str(executable), str(args.manifest.resolve()), str(args.payload.resolve()), str(args.installer.resolve()),
           str(ROOT / "builds/bootstrap-validation/runtime"), str(ROOT.parent / "models"), str(output), str(ROOT / "assets/brand/voxcpm-app.ico")]
if args.standard_user:
    output = Path(os.environ["LOCALAPPDATA"]) / "VoxCPM-安装验证" / uuid.uuid4().hex[:8]
    output.mkdir(parents=True)
    command[6] = str(output)
    command.append("--standard-user")
    runner = ROOT / "builds/installer-live-validation/StandardUserRunner.exe"
    subprocess.run(["C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe", "/nologo", "/target:exe", "/out:" + str(runner), str(ROOT / "bootstrap/StandardUserRunner.cs")], check=True)
    command.insert(0, str(runner))
    (ROOT / "builds/installer-cdrive-validation/standard-user-path.txt").write_text(str(output), encoding="utf-8")
subprocess.run(command, check=True)
