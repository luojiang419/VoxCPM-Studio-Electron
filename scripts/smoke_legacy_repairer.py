"""真实单EXE修复器验收：损坏旧版、缺失备份、同版本再修复。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]


def sha(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def put(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value), encoding="utf-8")


def stop(root):
    code = "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter \"Name='VoxCPM Studio.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"
    result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", code], capture_output=True, text=True, encoding="utf-8", check=True)
    processes = json.loads(result.stdout or "[]")
    if isinstance(processes, dict): processes = [processes]
    for item in processes:
        if item.get("ExecutablePath") and Path(item["ExecutablePath"]).resolve() == root / "VoxCPM Studio.exe":
            subprocess.run(["taskkill.exe", "/PID", str(item["ProcessId"]), "/T", "/F"], capture_output=True)


def capture_window(process, output):
    for _ in range(40):
        result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
            str(ROOT / "scripts/capture_update_window.ps1"), "-UpdaterProcessId", str(process.pid), "-OutputPath", str(output)], capture_output=True)
        if result.returncode == 0: return
        if process.poll() is not None: break
        time.sleep(0.25)
    raise RuntimeError("无法捕获修复器实际窗口：" + result.stderr.decode("utf-8", errors="replace"))


def close_window(process):
    subprocess.run(["powershell.exe", "-NoProfile", "-Command", f"(Get-Process -Id {process.pid}).CloseMainWindow()"], check=True, capture_output=True)
    process.wait(timeout=15)


def run(executable, baseline, same=True, capture=False, expected_release=None):
    run_dir = ROOT / "builds/legacy-repairer-validation" / str(time.time_ns())
    root = run_dir / "旧版 安装目录"
    root.mkdir(parents=True)
    excluded = {"allow-main-exit.json", "smoke-result.json", "settings-before-update.png", "standalone-updater.png"}
    for entry in baseline.iterdir():
        if entry.name in excluded: continue
        if entry.is_file(): shutil.copy2(entry, root / entry.name)
        elif entry.name in ("resources", "locales", "app"):
            shutil.copytree(entry, root / entry.name, ignore=lambda folder, names: [name for name in names if name.startswith("app-held-for-independence-test") or name == "__pycache__"])
    for name in ("runtime", "models", "ffmpeg"):
        if (baseline / name).exists():
            subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(root / name), str(baseline / name)], capture_output=True, check=True)
    profile = {"selected": [], "removed": ["heartmula"], "defaultModel": "ace-xl-turbo"}
    put(root / "data/component-selection.json", profile)
    sentinel = root / "data/outputs/原用户作品-保留验证.txt"
    sentinel.parent.mkdir(parents=True); sentinel.write_text("用户原有作品与配置必须保留", encoding="utf-8")
    data_hash, selection_hash = sha(sentinel), sha(root / "data/component-selection.json")
    model = root / ("models/config.json" if (root / "models/config.json").is_file() else "models/openbmb__VoxCPM2/config.json")
    model_hash = sha(model)
    app = root / "resources/app"
    (app / "update-config.json").unlink(missing_ok=True)
    (app / "package.json").write_bytes(b"{broken package metadata")
    (app / "main.js").write_text("throw new Error('old update damaged the entry');", encoding="utf-8")
    (app / "update-service.js").write_text("throw new Error('old updater damaged');", encoding="utf-8")
    pending = root / "data/cache/updates/session-old-without-backup"
    put(pending / "session.json", {"root": str(root), "session": str(pending), "currentVersion": "2.0.2"})
    put(pending / "journal.json", {"status": "installing", "changes": [{"path": "resources/app/main.js", "existed": True}]})
    put(pending.parent / "pending.json", {"session": str(pending), "pid": 0})
    legacy_bat = root / "Launch VoxCPM Studio Desktop.bat"
    legacy_bat.write_bytes(b'@echo off\r\nstart electron_shell\\electron.exe .\r\n')
    try:
        if capture:
            idle = subprocess.Popen([str(executable), "--root", str(root)])
            try: capture_window(idle, run_dir / "repairer-ready.png")
            finally: close_window(idle)
        first_file = run_dir / "first-repair.json"
        arguments = [str(executable), "--root", str(root), "--repair", "--report", str(first_file)]
        if capture:
            completed = subprocess.Popen(arguments)
            deadline = time.monotonic() + 360
            while not first_file.exists() and completed.poll() is None and time.monotonic() < deadline:
                time.sleep(0.25)
            if not first_file.exists():
                raise RuntimeError("修复器没有在限时内输出结果，保留窗口及日志")
            time.sleep(0.5)
            capture_window(completed, run_dir / "repairer-complete.png")
            close_window(completed)
        else:
            completed = subprocess.run(arguments + ["--exit-on-complete"], timeout=360)
        first = json.loads(first_file.read_text("utf-8-sig"))
        assert completed.returncode == 0, first
        assert first["status"] == "complete" and first["updateChannelVerified"]
        if expected_release:
            assert first["releaseId"] == first["channel"]["latestReleaseId"] == expected_release
            assert first["catalogNetworkError"] is None
        assert first["forwardRepair"] is True
        assert first["channel"]["updaterRuntime"] == "dedicated"
        assert epath(first["dedicatedRuntime"]).is_relative_to(root / "data/tools/updater-runtime")
        assert sha(sentinel) == data_hash and sha(model) == model_hash
        assert sha(root / "data/component-selection.json") == selection_hash
        assert json.loads((pending / "journal.json").read_text("utf-8"))["status"] == "superseded-by-repair"
        assert b'VoxCPM Studio.exe' in legacy_bat.read_bytes() and b'electron_shell' not in legacy_bat.read_bytes()
        report = {"passed": True, "root": str(root), "executable": str(executable), "firstRepair": first,
                  "userDataPreserved": True, "modelPreserved": True, "componentSelectionPreserved": True, "legacyEntryFixed": True}
        if same:
            stop(root)
            (app / "update-service.js").write_text("throw new Error('same-version updater corruption');", encoding="utf-8")
            same_file = run_dir / "same-release-repair.json"
            completed = subprocess.run([str(executable), "--root", str(root), "--repair", "--exit-on-complete", "--report", str(same_file)], timeout=360)
            repaired = json.loads(same_file.read_text("utf-8-sig"))
            assert completed.returncode == 0, repaired
            assert repaired["previousReleaseId"] == repaired["releaseId"] == first["releaseId"]
            assert repaired["updateChannelVerified"]
            assert sha(sentinel) == data_hash and sha(model) == model_hash
            report["sameReleaseRepair"] = repaired
        put(run_dir / "report.json", report)
        print(json.dumps({"passed": True, "root": str(root), "report": str(run_dir / "report.json")}, ensure_ascii=False))
        return report
    finally:
        stop(root)


def epath(value): return Path(value).resolve()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--capture", action="store_true", help="保存实际修复前和完成窗口截图")
    parser.add_argument("--expected-release", help="公网验收要求联网安装指定最新发布")
    args = parser.parse_args()
    run(args.executable.resolve(strict=True), args.baseline.resolve(strict=True), not args.once, args.capture, args.expected_release)
