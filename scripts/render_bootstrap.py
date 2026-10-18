"""直接渲染实际原生启动器的主题和准备状态，不进行网络下载。"""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
output = ROOT / "builds/launcher-design-validation"
output.mkdir(exist_ok=True)
executable = output / "BootstrapPreview.exe"
subprocess.run(["C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe", "/nologo", "/target:exe", "/main:BootstrapPreview", "/out:" + str(executable),
                "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll",
                "/reference:System.IO.Compression.dll", "/reference:System.IO.Compression.FileSystem.dll",
                str(ROOT / "bootstrap/Program.cs"), str(ROOT / "bootstrap/Preview.cs")], check=True)
manifest = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "builds/VoxCPM-Studio-Bootstrap-2.0.2-ModelScope-manifest.json"
subprocess.run([str(executable), str(manifest), str(output)], check=True)
