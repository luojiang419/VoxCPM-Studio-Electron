"""编译不依赖Electron应用模块的原生独立更新器。"""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "frontend/voxcpm_studio_electron/standalone-updater.exe"


def build():
    source = ROOT / "updater/Program.cs"
    icon = ROOT / "assets/brand/voxcpm-app.ico"
    fingerprint = hashlib.sha256(source.read_bytes() + icon.read_bytes()).hexdigest()
    metadata = OUTPUT.with_suffix(".build.json")
    if OUTPUT.exists() and metadata.exists():
        cached = json.loads(metadata.read_text("utf-8"))
        if cached.get("source") == fingerprint and cached.get("sha256") == hashlib.sha256(OUTPUT.read_bytes()).hexdigest():
            return OUTPUT
    compiler = Path("C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe")
    subprocess.run([str(compiler), "/nologo", "/target:winexe", "/platform:anycpu", "/optimize+",
                    "/out:" + str(OUTPUT), "/win32icon:" + str(icon), "/reference:System.Windows.Forms.dll",
                    "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll", str(source)], check=True)
    metadata.write_text(json.dumps({"source": fingerprint, "sha256": hashlib.sha256(OUTPUT.read_bytes()).hexdigest()}, indent=2), encoding="utf-8")
    return OUTPUT


if __name__ == "__main__":
    print(build())
