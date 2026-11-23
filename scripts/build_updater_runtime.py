"""构建独立于音频环境的Python更新运行时，不包含Torch、模型或用户数据。"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend/voxcpm_studio_electron"


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def build():
    vendor = ROOT.parent / "vendor/windows_312_cu126"
    python = vendor / "assets/python-3.12.10-embed-amd64.zip"
    if digest(python) != "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3":
        raise ValueError("独立Python来源校验失败")
    wheels = [vendor / "wheels" / name for name in (
        "cryptography-47.0.0-cp311-abi3-win_amd64.whl", "cffi-2.0.0-cp312-cp312-win_amd64.whl", "pycparser-3.0-py3-none-any.whl")]
    identity = hashlib.sha256(("canonical-zip-v2:" + "".join(digest(p) for p in [python, *wheels])).encode()).hexdigest()[:12]
    runtime_id = "py312-crypto47-" + identity
    directory = ROOT / "builds/updater-runtime" / runtime_id
    archive = directory.with_suffix(".zip")
    config_file = FRONTEND / "updater-runtime-config.json"
    def with_package(manifest):
        config = json.loads((FRONTEND / "update-config.json").read_text("utf-8"))
        from urllib.parse import urlencode
        url = f"https://modelscope.cn/api/v1/models/{config['repository']}/repo?" + urlencode({"Revision": "master", "FilePath": f"runtime/updater/{runtime_id}/VoxCPM-Updater-Runtime.zip"})
        result = {**manifest, "package": {"name": "VoxCPM-Updater-Runtime.zip", "size": archive.stat().st_size, "sha256": digest(archive), "urls": [url]}}
        config_file.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return result
    if archive.exists() and (directory / "runtime-manifest.json").exists():
        manifest = json.loads((directory / "runtime-manifest.json").read_text("utf-8"))
        if all((directory / f["path"]).is_file() and digest(directory / f["path"]) == f["sha256"] for f in manifest["files"]):
            return directory, archive, with_package(manifest)
    directory.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(python) as z:
        z.extractall(directory)
    site = directory / "Lib/site-packages"
    site.mkdir(parents=True)
    for wheel in wheels:
        with zipfile.ZipFile(wheel) as z:
            for entry in z.infolist():
                target = site / entry.filename
                if not target.resolve().is_relative_to(site.resolve()) or "\\" in entry.filename:
                    raise ValueError("依赖包路径越界")
                if entry.is_dir():
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(z.read(entry))
    (directory / "python312._pth").write_text("python312.zip\n.\nLib/site-packages\nimport site\n", encoding="utf-8")
    subprocess.run([str(directory / "python.exe"), "-B", "-c",
        "from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey; k=Ed25519PrivateKey.generate(); k.public_key().verify(k.sign(b'updater-runtime'),b'updater-runtime'); print('Independent updater runtime verified')"], check=True)
    files = [{"path": p.relative_to(directory).as_posix(), "size": p.stat().st_size, "sha256": digest(p)}
             for p in sorted(directory.rglob("*")) if p.is_file() and "__pycache__" not in p.parts]
    manifest = {"protocol": 1, "id": runtime_id, "python": "python.exe", "files": files}
    (directory / "runtime-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED) as z:
        for item in files:
            info = zipfile.ZipInfo(item["path"], (2026, 1, 1, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, (directory / item["path"]).read_bytes())
        info = zipfile.ZipInfo("runtime-manifest.json", (2026, 1, 1, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, (directory / "runtime-manifest.json").read_bytes())
    print(f"独立更新运行时：{archive}，{archive.stat().st_size}字节")
    return directory, archive, with_package(manifest)


if __name__ == "__main__":
    build()
