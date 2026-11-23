"""为已有便携包一次性接入更新能力；只覆盖应用代码，先备份并保留用户数据。"""
from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_update import FRONTEND, sources
sys.path.insert(0, str(FRONTEND))
from updater import destination, write_json, sha256


def install_support(bundle: Path):
    bundle = bundle.resolve(strict=True)
    if not all((bundle / item).is_file() for item in (
        "runtime_manifest.json", "VoxCPM Studio.exe", "runtime/python/python.exe", "resources/app/package.json"
    )):
        raise ValueError("目标不是有效的 VoxCPM Electron 便携包")
    check = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); "
        "Get-CimInstance Win32_Process -Filter \"Name='VoxCPM Studio.exe'\" | Select-Object -ExpandProperty ExecutablePath"],
        capture_output=True, text=True, encoding="utf-8", check=True)
    if str(bundle / "VoxCPM Studio.exe").lower() in check.stdout.lower():
        raise RuntimeError("目标软件正在运行，请关闭该便携包后接入")
    subprocess.run([str(bundle / "runtime/python/python.exe"), "-c", "import cryptography"], check=True)
    backup = bundle / "data/cache/updates" / ("bootstrap-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    backup.mkdir(parents=True)
    records = []
    try:
        for source, relative in sources():
            target = destination(bundle, relative)
            existed = target.is_file()
            if existed:
                saved = backup / "files" / relative
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, saved)
            records.append({"path": relative, "existed": existed})
            write_json(backup / "journal.json", records)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            if sha256(source) != sha256(target):
                raise RuntimeError(f"复制校验失败：{relative}")
    except BaseException:
        for record in reversed(records):
            target = destination(bundle, record["path"])
            if record["existed"]:
                shutil.copy2(backup / "files" / record["path"], target)
            else:
                target.unlink(missing_ok=True)
        raise
    report = {"bundle": str(bundle), "version": json.loads((FRONTEND / "package.json").read_text())["version"],
              "files": len(records), "backup": str(backup), "userDataPreserved": True}
    write_json(backup / "result.json", report)
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    args = parser.parse_args()
    install_support(args.bundle)
