"""直接渲染实际原生启动器的主题和准备状态，不进行网络下载。"""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
output = ROOT / "builds/launcher-design-validation"
output.mkdir(exist_ok=True)
executable = output / "BootstrapPreview.exe"
subprocess.run(["C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe", "/nologo", "/target:exe", "/main:BootstrapPreview", "/out:" + str(executable),
                "/resource:" + str(ROOT / "assets/brand/disk-local-256.png") + ",disk-local.png", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:Accessibility.dll", "/reference:System.Web.Extensions.dll",
                "/reference:System.IO.Compression.dll", "/reference:System.IO.Compression.FileSystem.dll",
                "/resource:" + str(ROOT / "assets/brand/voxcpm-app-256.png") + ",app-mark.png",
                "/resource:" + str(ROOT / "assets/brand/voxcpm-installer.ico") + ",installer.ico",
                str(ROOT / "bootstrap/Program.cs"), str(ROOT / "bootstrap/Installation.cs"), str(ROOT / "bootstrap/Components.cs"), str(ROOT / "bootstrap/DiskCard.cs"), str(ROOT / "bootstrap/Preview.cs")], check=True)
manifest = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "builds/VoxCPM-Studio-Bootstrap-2.0.2-ModelScope-manifest.json"
subprocess.run([str(executable), str(manifest), str(output)], check=True)

from PIL import Image
frames = [Image.open(path).convert("RGB") for path in sorted((output / "disk-animation-frames").glob("*.png"))]
if frames:
    durations = [1100 if index % 11 == 10 else 38 for index in range(len(frames))]
    frames[0].save(output / "disk-selection.gif", save_all=True, append_images=frames[1:], duration=durations, loop=0)
    print("真实窗口贝塞尔缩放动图：", output / "disk-selection.gif")

switch_frames = [Image.open(path).convert("RGB") for path in sorted((output / "switch-animation-frames").glob("*.png"))]
if switch_frames:
    switch_frames[0].save(output / "switch-light.gif", save_all=True, append_images=switch_frames[1:], duration=[1100 if index % 13 == 12 else 30 for index in range(len(switch_frames))], loop=0)
    print("真实开关光效动图：", output / "switch-light.gif")
