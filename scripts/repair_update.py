"""旧客户端一次性离线修复：签名校验后用新版更新器升级，保留事务与健康确认。"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid


def recover_pending(root: Path, updater):
    pending = root / "data/cache/updates/pending.json"
    if not pending.exists():
        return False
    state = updater.read_json(pending)
    session = Path(state["session"]).resolve(strict=True)
    if not session.is_relative_to(pending.parent.resolve()):
        raise ValueError("未完成事务的会话目录不属于当前软件，请保留日志后联系维护者")
    settings = updater.read_json(session / "session.json")
    if Path(settings["root"]).resolve() != root or Path(settings["session"]).resolve() != session:
        raise ValueError("未完成事务与当前软件目录不一致，已停止恢复")
    if state.get("pid") and updater.alive(state["pid"]):
        raise RuntimeError("独立更新进程仍在运行，请等待完成或正常关闭更新器后重试")
    # 使用已有事务备份恢复，不删除用户数据、不丢弃回滚记录。
    updater.run(session, recover=True)
    return True


def prepare(root: Path, snapshot: Path, helper: Path):
    root = root.resolve(strict=True)
    app = root / "resources/app"
    if not (root / "runtime_manifest.json").is_file() or not (root / "VoxCPM Studio.exe").is_file():
        raise ValueError("请选择包含 VoxCPM Studio.exe 的软件安装目录")
    # 只检查该安装目录，不结束其他副本或用户任务。
    query = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); "
        "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('VoxCPM Studio.exe','electron.exe') } | "
        "Select-Object -ExpandProperty ExecutablePath) | ConvertTo-Json -Compress"],
        capture_output=True, text=True, encoding="utf-8", check=True)
    executables = json.loads(query.stdout or "[]")
    if isinstance(executables, str):
        executables = [executables]
    if any(value and Path(value).resolve().is_relative_to(root) for value in executables):
        raise RuntimeError("请先关闭该目录的软件和独立更新窗口，再运行修复。不会强制结束你的任务。")
    spec = importlib.util.spec_from_file_location("repair_updater", helper)
    updater = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(updater)
    cache = root / "data/cache/updates"
    recovered = recover_pending(root, updater)
    config = updater.read_json(app / "update-config.json")
    package = updater.read_json(app / "package.json")
    envelope = updater.read_json(snapshot / "envelope.json")
    manifest = json.loads(envelope["payload"])
    # 离线入口不能回退已安装版本，必须包含应用身份与更新器。
    session = cache / ("session-repair-" + uuid.uuid4().hex)
    session.mkdir(parents=True)
    shutil.copy2(snapshot / "envelope.json", session / "envelope.json")
    shutil.copy2(snapshot / manifest["package"]["name"], session / "package.zip")
    settings = {"root": str(root), "session": str(session), "parentPid": os.getpid(),
                "publicKey": config["publicKey"], "currentVersion": package["version"],
                "currentReleaseId": config.get("releaseId", "00000000000000"),
                "resultPath": str(cache / "last-result.json"), "pythonExecutable": sys.executable}
    updater.write_json(session / "session.json", settings)
    verified = updater.validate(session, settings)
    record = next(item for item in verified["files"] if item["path"] == "resources/app/updater.py")
    script = session / "stage/resources/app/updater.py"
    if updater.sha256(script) != record["sha256"]:
        raise ValueError("新版更新脚本校验失败")
    shutil.copy2(script, session / "updater.py")
    native = next((item for item in verified["files"] if item["path"] == "resources/app/standalone-updater.exe"), None)
    if native:
        executable = session / "VoxCPM Updater.exe"
        shutil.copy2(session / "stage" / native["path"], executable)
        child = subprocess.Popen([str(executable), "--session", str(session)], cwd=session,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS)
        print(json.dumps({"session": str(session), "pid": child.pid, "releaseId": verified["releaseId"], "recoveredInterruptedUpdate": recovered}, ensure_ascii=True))
        return
    with (session / "updater.log").open("ab") as log:
        child = subprocess.Popen([sys.executable, "-u", str(session / "updater.py"), str(session)],
            cwd=session, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NO_WINDOW)
    print(json.dumps({"session": str(session), "pid": child.pid, "releaseId": verified["releaseId"], "recoveredInterruptedUpdate": recovered}, ensure_ascii=True))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--snapshot", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--helper", type=Path, default=Path(__file__).resolve().parent / "updater.py")
    args = parser.parse_args()
    try:
        prepare(args.root, args.snapshot, args.helper)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
