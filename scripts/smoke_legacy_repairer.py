"""真实单EXE修复器验收：损坏旧版、缺失备份、同版本再修复。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "repair"))
import engine


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


def start_hidden_fixtures(root, run_dir):
    code = run_dir / "HiddenProcess.cs"
    code.write_text('using System; using System.Diagnostics; using System.IO; using System.Threading; class HiddenProcess { static void Main(string[] a) { if(a.Length==3 && a[0]=="--parent") { var child=Process.Start(new ProcessStartInfo(a[1]) { UseShellExecute=false,CreateNoWindow=true }); File.WriteAllText(a[2],child.Id.ToString()); } Thread.Sleep(Timeout.Infinite); } }', encoding="utf-8")
    native = run_dir / "HiddenProcess.exe"
    subprocess.run(["C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe", "/nologo", "/target:winexe", "/out:" + str(native), str(code)], check=True)
    owned = root / "data/cache/process-fixtures"; owned.mkdir(parents=True)
    other = run_dir / (root.name + "-other"); other.mkdir()
    shared = run_dir / "shared"; shared.mkdir()
    paths = [owned / "VoxCPM Updater.exe", owned / "hidden-worker.exe", other / "VoxCPM Updater.exe", shared / "python.exe"]
    for path in paths: shutil.copy2(native, path)
    ready = run_dir / "hidden-child-pid.txt"
    parent = subprocess.Popen([str(paths[0]), "--parent", str(paths[1]), str(ready)])
    foreign = subprocess.Popen([str(paths[2])])
    backend = subprocess.Popen([str(paths[3]), str(root / "app/desktop_api.py")])
    deadline = time.monotonic() + 10
    while not ready.exists() and time.monotonic() < deadline: time.sleep(.1)
    assert ready.exists(), "隐藏子进程未启动"
    child_pid = int(ready.read_text())
    targets = [p for p in engine.process_inventory() if p.get("ProcessId") in {parent.pid, backend.pid, child_pid}]
    assert len(targets) == 3
    handles = [engine.ProcessHandle(item) for item in targets]
    assert all(not handle.exited() for handle in handles)
    return parent, foreign, backend, child_pid, handles


def clone_video_fixture(source, target):
    def copy(file, destination):
        # 模型大文件只读复用；源码和依赖均使用独立副本，不改变已有视频环境。
        if Path(file).stat().st_size > 64 * 1024 ** 2:
            os.link(file, destination)
            return destination
        return shutil.copy2(file, destination)
    for name in ("env", "source", "tools", "downloads"):
        if (source / name).exists():
            shutil.copytree(source / name, target / name, copy_function=copy, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for name in ("runtime.json", "runtime-1.5.json", "runtime-1.6.json"):
        if (source / name).exists(): shutil.copy2(source / name, target / name)
    (target / "env/Lib/video-packages/pyarrow.py").write_text("raise RuntimeError('pyarrow requires NumPy 2.0 or newer, found 1.26.4')", encoding="utf-8")


def run(executable, baseline, same=True, capture=False, expected_release=None, running_processes=False, video_root=None):
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
    profile = {"selected": ["lipsync"] if video_root else [], "removed": ["heartmula"], "defaultModel": "ace-xl-turbo"}
    put(root / "data/component-selection.json", profile)
    if video_root:
        target = root / "data/lipsync"
        clone_video_fixture(video_root, target)
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
    fixtures = None
    try:
        if running_processes:
            fixtures = start_hidden_fixtures(root, run_dir)
            put(pending.parent / "pending.json", {"session": str(pending), "pid": fixtures[0].pid})
        if capture:
            idle = subprocess.Popen([str(executable), "--root", str(root)])
            try: capture_window(idle, run_dir / "repairer-ready.png")
            finally: close_window(idle)
        first_file = run_dir / "first-repair.json"
        arguments = [str(executable), "--root", str(root), "--repair", "--report", str(first_file)]
        if capture:
            completed = subprocess.Popen(arguments)
            deadline = time.monotonic() + (600 if video_root else 360)
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
        if fixtures:
            parent, foreign, backend, child_pid, handles = fixtures
            assert parent.poll() is not None and backend.poll() is not None and all(handle.exited() for handle in handles)
            assert foreign.poll() is None, "其他安装目录进程不能被结束"
            stopped = {item["ProcessId"]: item for item in first["stoppedProcesses"]}
            assert {parent.pid, backend.pid, child_pid}.issubset(stopped)
            assert all(stopped[pid]["forced"] for pid in (parent.pid, backend.pid, child_pid))
        if expected_release:
            assert first["releaseId"] == first["channel"]["latestReleaseId"] == expected_release
            assert first["catalogNetworkError"] is None
        assert first["forwardRepair"] is True
        assert first["channel"]["updaterRuntime"] == "dedicated"
        assert epath(first["dedicatedRuntime"]).is_relative_to(root / "data/tools/updater-runtime")
        assert sha(sentinel) == data_hash and sha(model) == model_hash
        assert sha(root / "data/component-selection.json") == selection_hash
        if video_root:
            ready = json.loads((root / "data/lipsync/ready-1.6.json").read_text("utf-8"))
            assert ready["fingerprint"]["videoPolicy"] == "no-optional-arrow-v1"
            assert "NumPy 2.0" in (root / "data/lipsync/env/Lib/video-packages/pyarrow.py").read_text()
        assert json.loads((pending / "journal.json").read_text("utf-8"))["status"] == "superseded-by-repair"
        assert b'VoxCPM Studio.exe' in legacy_bat.read_bytes() and b'electron_shell' not in legacy_bat.read_bytes()
        report = {"passed": True, "root": str(root), "executable": str(executable), "firstRepair": first,
                  "userDataPreserved": True, "modelPreserved": True, "componentSelectionPreserved": True, "legacyEntryFixed": True}
        if fixtures:
            report.update(hiddenProcessesAutomaticallyTerminated=True, orphanChildrenTerminated=True, sharedPythonMatchedByScript=True, otherInstallProcessPreserved=True)
        if video_root:
            report.update(videoSelectedAndPreserved=True, videoConflictFixedDuringRealRestart=True)
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
        if fixtures:
            for handle in fixtures[-1]:
                try: handle.terminate()
                finally: handle.close()
            foreign = fixtures[1]
            if foreign.poll() is None: foreign.terminate(); foreign.wait(timeout=10)


def epath(value): return Path(value).resolve()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--capture", action="store_true", help="保存实际修复前和完成窗口截图")
    parser.add_argument("--expected-release", help="公网验收要求联网安装指定最新发布")
    parser.add_argument("--running-processes", action="store_true", help="先创建真实隐藏更新器、子进程、共享Python及其他安装进程")
    parser.add_argument("--video-root", type=Path, help="复制已有视频环境并注入用户Arrow冲突，验收选中视频功能时的实际修复重启")
    args = parser.parse_args()
    run(args.executable.resolve(strict=True), args.baseline.resolve(strict=True), not args.once, args.capture, args.expected_release, args.running_processes, args.video_root.resolve(strict=True) if args.video_root else None)
