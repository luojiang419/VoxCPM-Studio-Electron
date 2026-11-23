"""老用户修复器安全边界与持久更新通道测试。"""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import os
import subprocess
import sys

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("legacy_repair_engine", ROOT / "repair/engine.py")
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def test_trust_anchor_rejects_tampering_and_foreign_product():
    key = Ed25519PrivateKey.generate()
    public = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()
    def sign(product="voxcpm-studio"):
        payload = json.dumps({"protocol": 1, "product": product, "platform": "win32-x64", "version": "2.0.2", "releaseId": "20261018154833", "package": {"size": 10, "sha256": "a"*64}})
        return {"payload": payload, "signature": key.sign(payload.encode()).hex()}
    assert e.verify_envelope(sign(), public)["version"] == "2.0.2"
    forged = sign(); forged["payload"] += " "
    with pytest.raises(Exception): e.verify_envelope(forged, public)
    with pytest.raises(ValueError, match="不兼容"): e.verify_envelope(sign("other"), public)


def test_missing_update_metadata_uses_actual_install_record(tmp_path):
    root = tmp_path / "老安装"
    put(root / ".voxcpm-install.json", {"product": "voxcpm-studio", "version": "2.0.2"})
    (root / "VoxCPM Studio.exe").write_bytes(b"entry")
    assert e.validate_root(root) == root
    assert e.installed_identity(root) == ("2.0.2", "00000000000000")
    assert not (root / "resources/app/update-config.json").exists()


def test_running_owned_apps_block_without_affecting_other_installs(tmp_path):
    root = tmp_path / "one"
    e.assert_stopped(root, [{"ExecutablePath": str(tmp_path / "two/VoxCPM Studio.exe")}])
    with pytest.raises(RuntimeError, match="先关闭"):
        e.assert_stopped(root, [{"ExecutablePath": str(root / "VoxCPM Studio.exe")}])
    e.assert_stopped(root, [{"Name": "python.exe", "ExecutablePath": None}])
    with pytest.raises(RuntimeError, match="无法确认"):
        e.assert_stopped(root, [{"Name": "VoxCPM Studio.exe", "ExecutablePath": None}])


def test_process_selection_respects_directory_arguments_and_descendant_identity(tmp_path):
    root = tmp_path / "one"
    records = [
        {"ProcessId": 10, "Created": 100, "ExecutablePath": str(root / "VoxCPM Studio.exe")},
        {"ProcessId": 11, "ParentProcessId": 10, "Created": 101, "ExecutablePath": str(tmp_path / "shared/helper.exe")},
        {"ProcessId": 12, "ParentProcessId": 10, "Created": 99, "ExecutablePath": str(tmp_path / "other/helper.exe")},
        {"ProcessId": 13, "ExecutablePath": str(tmp_path / "one-other/VoxCPM Studio.exe")},
        {"ProcessId": 14, "ExecutablePath": str(tmp_path / "shared/python.exe"), "CommandLine": f'python.exe "{root / "app/desktop_api.py"}"'},
        {"ProcessId": 15, "ExecutablePath": str(tmp_path / "shared/python.exe"), "CommandLine": f'python.exe -c "print(\'{root / "app/desktop_api.py"}\')"'},
        {"ProcessId": 16, "ExecutablePath": str(root / "runtime/python/pythonw.exe")},
    ]
    assert {p["ProcessId"] for p in e.owned_processes(root, records)[0]} == {10, 11, 14, 16}


def test_process_selection_excludes_repairer_worker_and_ancestors_even_inside_root(tmp_path):
    root = tmp_path / "one"
    records = [{"ProcessId": os.getpid(), "ParentProcessId": os.getppid(), "ExecutablePath": str(root / "runtime/python/python.exe")},
               {"ProcessId": os.getppid(), "ExecutablePath": str(root / "VoxCPM Studio.exe")}]
    assert e.owned_processes(root, records) == ([], [])


def test_stop_processes_rechecks_and_records_forced_exit(tmp_path, monkeypatch):
    root, work = tmp_path / "one", tmp_path / "work"
    target = {"ProcessId": 10, "ExecutablePath": str(root / "VoxCPM Studio.exe")}
    inventories = iter([[target], []])
    monkeypatch.setattr(e, "process_inventory", lambda: next(inventories))
    monkeypatch.setattr(e.time, "sleep", lambda _: None)
    ticks = iter([0, 3]); monkeypatch.setattr(e.time, "monotonic", lambda: next(ticks))
    actions = []
    class Handle:
        def __init__(self, item): self.item, self.handle = item, 1
        def exited(self): return False
        def request_close(self): actions.append("close")
        def terminate(self): actions.append("force")
        def close(self): actions.append("release")
    monkeypatch.setattr(e, "ProcessHandle", Handle)
    result = e.stop_owned_processes(root, work)
    assert actions == ["close", "force", "release"]
    assert result[0]["ProcessId"] == 10 and result[0]["forced"] is True
    assert e.read(work / "stopped-processes.json") == result


def test_stop_process_access_denied_reports_pid_and_never_continues(tmp_path, monkeypatch):
    root = tmp_path / "one"
    target = {"ProcessId": 10, "ExecutablePath": str(root / "VoxCPM Studio.exe")}
    monkeypatch.setattr(e, "process_inventory", lambda: [target])
    def denied(item): raise PermissionError("Access denied")
    monkeypatch.setattr(e, "ProcessHandle", denied)
    with pytest.raises(RuntimeError, match="PID 10.*管理员"):
        e.stop_owned_processes(root, tmp_path / "work")


def test_real_process_handle_does_not_terminate_reused_or_changed_identity():
    child = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(30)"], creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        item = next(p for p in e.process_inventory() if p.get("ProcessId") == child.pid)
        for changed in ({**item, "Created": item["Created"] - 10000000}, {**item, "ExecutablePath": str(ROOT / "different/python.exe")}):
            handle = e.ProcessHandle(changed)
            try:
                assert handle.handle is None
                handle.terminate()
                assert child.poll() is None
            finally: handle.close()
    finally:
        child.terminate(); child.wait(timeout=10)


def test_incomplete_backups_plan_forward_repair_without_erasing_records(tmp_path):
    root = tmp_path / "app"; session = root / "data/cache/updates/session-old"
    put(session / "session.json", {"root": str(root), "session": str(session)})
    put(session / "journal.json", {"status": "installing", "changes": [{"path": "resources/app/main.js", "existed": True}]})
    pending = session.parent / "pending.json"
    put(pending, {"session": str(session), "pid": 123})
    transaction = SimpleNamespace(alive=lambda pid: False, safe_path=lambda path: path)
    assert e.recover_pending(root, transaction) == (False, session)
    assert pending.exists() and e.read(session / "journal.json")["status"] == "installing"
    transaction.alive = lambda pid: True
    with pytest.raises(RuntimeError, match="仍在运行"): e.recover_pending(root, transaction)


@pytest.mark.parametrize("wait_result,should_fail", [(0, False), (258, True)])
def test_termination_access_denied_only_succeeds_after_verified_handle_exits(wait_result, should_fail):
    handle = object.__new__(e.ProcessHandle)
    handle.handle = 123
    waits = []
    handle.kernel = SimpleNamespace(
        TerminateProcess=lambda process, code: False,
        WaitForSingleObject=lambda process, timeout: waits.append((process, timeout)) or wait_result,
    )
    handle.ctypes = SimpleNamespace(get_last_error=lambda: 5, WinError=lambda code: PermissionError(code, "access denied"))
    handle.exited = lambda: False
    if should_fail:
        with pytest.raises(PermissionError): handle.terminate()
    else:
        handle.terminate()
    assert waits == [(123, 5000)]


def test_foreign_recovery_is_refused(tmp_path):
    root = tmp_path / "app"
    foreign = tmp_path / "foreign"; foreign.mkdir()
    put(root / "data/cache/updates/pending.json", {"session": str(foreign), "pid": 0})
    with pytest.raises(ValueError, match="不属于"):
        e.recover_pending(root, SimpleNamespace())


def test_working_component_selection_is_preserved_byte_for_byte(tmp_path):
    root = tmp_path / "app"
    file = root / "data/component-selection.json"
    file.parent.mkdir(parents=True)
    original = b'{"selected":["heartmula"],"removed":["lipsync"]}'
    file.write_bytes(original)
    assert e.migrate_components(root, tmp_path / "session") is False
    assert file.read_bytes() == original


def test_corrupt_component_metadata_is_backed_up_not_deleted(tmp_path):
    root, session = tmp_path / "app", tmp_path / "session"
    file = root / "data/component-selection.json"; file.parent.mkdir(parents=True)
    file.write_bytes(b"{broken old metadata")
    assert e.migrate_components(root, session) is True
    assert (session / "metadata-backup/component-selection.json").read_bytes() == b"{broken old metadata"
    assert e.read(file)["selected"] == []


def test_runtime_paths_and_owned_repair_lock(tmp_path):
    with pytest.raises(ValueError): e.safe_member(tmp_path, "../outside")
    with pytest.raises(ValueError): e.safe_member(tmp_path, "C:/outside")
    transaction = SimpleNamespace(alive=lambda pid: True)
    with e.repair_lock(tmp_path, transaction):
        with pytest.raises(RuntimeError, match="另一个"):
            with e.repair_lock(tmp_path, transaction): pass
    assert not (tmp_path / "data/cache/updates/repairer.lock").exists()


def test_owned_legacy_launcher_is_fixed_but_custom_modern_launcher_is_preserved(tmp_path, monkeypatch):
    root = tmp_path / "app"; root.mkdir()
    file = root / "Launch VoxCPM Studio Desktop.bat"
    file.write_bytes(b'start electron_shell\\electron.exe .\r\n')
    modern = root / "Launch VoxCPM Studio Electron.bat"
    original = b'set CUSTOM_OPTION=keep\r\nstart "" "VoxCPM Studio.exe"\r\n'
    modern.write_bytes(original)
    monkeypatch.setattr(e.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0, stdout="[]", stderr=""))
    session = tmp_path / "session"
    changed = e.repair_launchers(root, session, [])
    assert changed == [str(file)]
    assert b"VoxCPM Studio.exe" in file.read_bytes()
    assert (session / "entry-backup" / file.name).read_bytes() == b'start electron_shell\\electron.exe .\r\n'
    assert modern.read_bytes() == original


def test_real_shortcut_repair_only_changes_app_entry_in_selected_install(tmp_path):
    root, links = tmp_path / "原安装", tmp_path / "测试快捷方式"
    root.mkdir(); links.mkdir()
    script = r"""[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$shell=New-Object -ComObject WScript.Shell
$cases=@(@('用户自定义名称.lnk',(Join-Path $env:TEST_ROOT 'electron_shell\electron.exe')), @('其他软件.lnk',(Join-Path $env:TEST_OTHER 'VoxCPM Studio.exe')), @('修复器.lnk',(Join-Path $env:TEST_ROOT 'VoxCPM更新修复器.exe')))
foreach($case in $cases) { $link=$shell.CreateShortcut((Join-Path $env:TEST_LINKS $case[0])); $link.TargetPath=$case[1]; $link.Arguments='old-entry'; $link.Save() }
"""
    env = {**os.environ, "TEST_ROOT": str(root), "TEST_OTHER": str(tmp_path / "other"), "TEST_LINKS": str(links)}
    subprocess.run(["powershell.exe", "-NoProfile", "-Command", script], env=env, check=True, capture_output=True)
    foreign = (links / "其他软件.lnk").read_bytes()
    tool = (links / "修复器.lnk").read_bytes()
    changed = e.repair_launchers(root, tmp_path / "session", [links])
    assert changed == [str(links / "用户自定义名称.lnk")]
    result = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut((Join-Path $env:TEST_LINKS '用户自定义名称.lnk')); @{target=$l.TargetPath;args=$l.Arguments} | ConvertTo-Json -Compress"],
        env=env, check=True, capture_output=True, text=True, encoding="utf-8")
    fixed = json.loads(result.stdout)
    assert Path(fixed["target"]) == root / "VoxCPM Studio.exe" and fixed["args"] == "--voxcpm-run"
    assert (links / "其他软件.lnk").read_bytes() == foreign
    assert (links / "修复器.lnk").read_bytes() == tool
