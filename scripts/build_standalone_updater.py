"""编译不依赖Electron应用模块的原生独立更新器。"""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "frontend/voxcpm_studio_electron/standalone-updater.exe"


def build():
    build_uninstaller()
    source = ROOT / "updater/Program.cs"
    shared = ROOT / "bootstrap/SharedTheme.cs"
    icon = ROOT / "assets/brand/voxcpm-app.ico"
    mark = ROOT / "assets/brand/voxcpm-app-256.png"
    fingerprint = hashlib.sha256(source.read_bytes() + shared.read_bytes() + icon.read_bytes() + mark.read_bytes()).hexdigest()
    metadata = OUTPUT.with_suffix(".build.json")
    if OUTPUT.exists() and metadata.exists():
        cached = json.loads(metadata.read_text("utf-8"))
        if cached.get("source") == fingerprint and cached.get("sha256") == hashlib.sha256(OUTPUT.read_bytes()).hexdigest():
            return OUTPUT
    compiler = Path("C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe")
    subprocess.run([str(compiler), "/nologo", "/target:winexe", "/platform:anycpu", "/optimize+",
                    "/out:" + str(OUTPUT), "/win32icon:" + str(icon), "/reference:System.Windows.Forms.dll",
                    "/resource:" + str(mark) + ",app-mark.png", "/reference:Accessibility.dll",
                    "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll", str(shared), str(source)], check=True)
    metadata.write_text(json.dumps({"source": fingerprint, "sha256": hashlib.sha256(OUTPUT.read_bytes()).hexdigest()}, indent=2), encoding="utf-8")
    return OUTPUT


def build_uninstaller():
    files = [ROOT / "bootstrap" / name for name in ("BrandUninstaller.cs", "Program.cs", "SharedTheme.cs", "Installation.cs", "Components.cs", "DiskCard.cs")]
    icon = ROOT / "assets/brand/voxcpm-app.ico"
    output = OUTPUT.with_name("brand-uninstaller.exe")
    metadata = output.with_suffix(".build.json")
    fingerprint = hashlib.sha256(b"".join(file.read_bytes() for file in [*files, icon])).hexdigest()
    if output.exists() and metadata.exists():
        cached = json.loads(metadata.read_text("utf8"))
        if cached.get("source") == fingerprint and cached.get("sha256") == hashlib.sha256(output.read_bytes()).hexdigest():
            return output
    subprocess.run(["C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe", "/nologo", "/target:winexe", "/optimize+", "/main:VoxBootstrap.BrandUninstaller", "/out:" + str(output), "/win32icon:" + str(icon),
        *["/reference:" + name for name in ("System.Windows.Forms.dll", "System.Drawing.dll", "Accessibility.dll", "System.Web.Extensions.dll", "System.IO.Compression.dll", "System.IO.Compression.FileSystem.dll")], *map(str, files)], check=True)
    metadata.write_text(json.dumps({"source": fingerprint, "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}, indent=2), encoding="utf8")
    return output


if __name__ == "__main__":
    print(build())
