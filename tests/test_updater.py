"""真实 ZIP、签名、替换和回滚测试；全部在独立临时目录运行。"""
import importlib.util
import json
from pathlib import Path
import sys
import zipfile

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

MODULE = Path(__file__).resolve().parents[1] / "frontend/voxcpm_studio_electron/updater.py"
spec = importlib.util.spec_from_file_location("voxcpm_updater", MODULE)
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)


def prepare(tmp_path, extra=None):
    root, session = tmp_path / "中文 便携目录", tmp_path / "更新 会话"
    root.mkdir(); session.mkdir()
    (root / "runtime_manifest.json").write_text("{}")
    files = {"resources/app/package.json": b'{"version":"2.0.2"}',
             "resources/app/main.js": b"new desktop", "app/src/voxcpm/new.py": b"new module"}
    if extra:
        files.update(extra)
    records = []
    with zipfile.ZipFile(session / "package.zip", "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)
            import hashlib
            records.append({"path": name, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()})
    key = Ed25519PrivateKey.generate()
    settings = {"root": str(root), "session": str(session), "currentVersion": "2.0.1", "parentPid": 999999,
                "publicKey": key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()}
    manifest = {"protocol": 1, "product": "voxcpm-studio", "platform": "win32-x64", "version": "2.0.2", "minVersion": "0.2.0",
                "package": {"size": (session / "package.zip").stat().st_size, "sha256": u.sha256(session / "package.zip")}, "files": records}
    payload = json.dumps(manifest)
    u.write_json(session / "envelope.json", {"payload": payload, "signature": key.sign(payload.encode()).hex()})
    u.write_json(session / "session.json", settings)
    return root, session, settings


@pytest.mark.parametrize("relative", ["../main.js", "/resources/app/a", "data/config/a", "models/a", "runtime/a", "app/studio_config.json",
    "resources/app/../../data/a", "resources/app/C:/a", "resources/app/NUL.txt", "resources/app/a. ", "resources\\app\\a", "resources/app/./a", "resources/app/.env"])
def test_reject_unsafe_paths(relative):
    with pytest.raises(ValueError):
        u.safe_path(relative)


def test_install_and_rollback_preserves_data(tmp_path):
    root, session, settings = prepare(tmp_path)
    old = root / "resources/app/main.js"
    old.parent.mkdir(parents=True); old.write_bytes(b"old desktop")
    data = root / "data/config/studio_config.json"
    data.parent.mkdir(parents=True); data.write_bytes(b"user settings")
    model = root / "models/weights.bin"
    model.parent.mkdir(); model.write_bytes(b"model")
    manifest = u.validate(session, settings)
    u.install(root, session, manifest)
    assert old.read_bytes() == b"new desktop"
    assert (root / "app/src/voxcpm/new.py").is_file()
    u.rollback(root, session)
    assert old.read_bytes() == b"old desktop"
    assert not (root / "resources/app/package.json").exists()
    assert not (root / "app/src/voxcpm/new.py").exists()
    assert data.read_bytes() == b"user settings"
    assert model.read_bytes() == b"model"


def test_write_failure_rolls_back(tmp_path):
    root, session, settings = prepare(tmp_path)
    old = root / "resources/app/main.js"
    old.parent.mkdir(parents=True); old.write_bytes(b"old desktop")
    manifest = u.validate(session, settings)
    with pytest.raises(OSError, match="测试注入"):
        u.install(root, session, manifest, fail_after=2)
    assert old.read_bytes() == b"old desktop"
    assert not (root / "resources/app/package.json").exists()


def test_crash_recovery(tmp_path):
    root, session, settings = prepare(tmp_path)
    old = root / "resources/app/main.js"
    old.parent.mkdir(parents=True); old.write_bytes(b"original")
    manifest = u.validate(session, settings)
    u.install(root, session, manifest)
    u.write_json(root / "data/cache/updates/pending.json", {"session": str(session)})
    u.run(session, recover=True)
    assert old.read_bytes() == b"original"
    assert not (root / "data/cache/updates/pending.json").exists()


def test_package_tampering(tmp_path):
    _, session, settings = prepare(tmp_path)
    with (session / "package.zip").open("ab") as stream:
        stream.write(b"tampered")
    with pytest.raises(ValueError, match="完整性"):
        u.validate(session, settings)


def test_signature_tampering(tmp_path):
    _, session, settings = prepare(tmp_path)
    envelope = u.read_json(session / "envelope.json")
    envelope["payload"] += " "
    u.write_json(session / "envelope.json", envelope)
    from cryptography.exceptions import InvalidSignature
    with pytest.raises(InvalidSignature):
        u.validate(session, settings)


def test_protected_file_in_signed_package(tmp_path):
    _, session, settings = prepare(tmp_path, {"data/config/studio_config.json": b"forbidden"})
    with pytest.raises(ValueError, match="禁止"):
        u.validate(session, settings)


def test_reject_downgrade(tmp_path):
    _, session, settings = prepare(tmp_path)
    settings["currentVersion"] = "2.0.2"
    with pytest.raises(ValueError, match="相同或更旧"):
        u.validate(session, settings)


def test_explicit_same_release_repair_does_not_allow_downgrade(tmp_path):
    _, session, settings = prepare(tmp_path)
    settings.update(currentVersion="2.0.2", repair=True)
    assert u.validate(session, settings)["version"] == "2.0.2"
    settings["currentReleaseId"] = "20261018000001"
    with pytest.raises(ValueError, match="相同或更旧"):
        u.validate(session, settings)


def test_repair_with_unknown_version_requires_explicit_verified_baseline(tmp_path):
    _, session, settings = prepare(tmp_path)
    settings.update(currentVersion=None, repair=True, repairIdentityUnknown=True, baselineVersion="2.0.1")
    assert u.validate(session, settings)["version"] == "2.0.2"
    settings["repair"] = False
    with pytest.raises(ValueError): u.validate(session, settings)
    settings.update(currentVersion="2.0.3", currentReleaseId="00000000000000")
    with pytest.raises(ValueError, match="相同或更旧"):
        u.validate(session, settings)


def test_reject_junction(tmp_path):
    root, session, settings = prepare(tmp_path)
    external = tmp_path / "用户 外部目录"
    external.mkdir()
    (root / "resources").mkdir()
    import subprocess
    result = subprocess.run(["cmd", "/c", "mklink", "/J", str(root / "resources/app"), str(external)], capture_output=True)
    assert result.returncode == 0
    with pytest.raises(ValueError):
        u.install(root, session, u.validate(session, settings))
    assert not list(external.iterdir())


def test_failed_restart_restores_and_reopens_old_version(tmp_path, monkeypatch):
    root, session, settings = prepare(tmp_path)
    old = root / "resources/app/main.js"
    old.parent.mkdir(parents=True); old.write_bytes(b"working old version")
    monkeypatch.setattr(u, "wait_exit", lambda *args, **kwargs: None)
    restarts = []
    class FailedChild:
        pid = 12345
        def poll(self): return 1
    def restart(root, session, health=True):
        restarts.append(health)
        return FailedChild()
    monkeypatch.setattr(u, "restart", restart)
    with pytest.raises(RuntimeError, match="启动失败"):
        u.run(session)
    assert restarts == [True, False]
    assert old.read_bytes() == b"working old version"
    assert not (root / "data/cache/updates/pending.json").exists()
    assert u.read_json(session / "journal.json")["status"] == "rolled-back"


def test_success_requires_health_ack(tmp_path, monkeypatch):
    root, session, settings = prepare(tmp_path)
    monkeypatch.setattr(u, "wait_exit", lambda *args, **kwargs: None)
    class HealthyChild:
        pid = 12345
        def poll(self): return None
    def restart(root, session, health=True):
        u.write_json(session / "healthy.json", {"version": "2.0.2", "pid": HealthyChild.pid})
        return HealthyChild()
    monkeypatch.setattr(u, "restart", restart)
    u.run(session)
    assert u.read_json(session / "status.json")["status"] == "complete"
    assert u.read_json(session / "journal.json")["status"] == "complete"
    assert u.read_json(root / "data/cache/updates/last-result.json")["status"] == "complete"
    assert u.read_json(session / "ready.json")["parentPid"] == settings["parentPid"]


def test_failed_rollback_keeps_pending_for_recovery(tmp_path, monkeypatch):
    root, session, settings = prepare(tmp_path)
    monkeypatch.setattr(u, "wait_exit", lambda *args, **kwargs: None)
    def fail_install(root, session, manifest):
        u.write_json(session / "journal.json", {"status": "installing", "changes": []})
        raise OSError("写入故障")
    def fail_rollback(root, session):
        raise PermissionError("文件仍被锁定")
    monkeypatch.setattr(u, "install", fail_install)
    monkeypatch.setattr(u, "rollback", fail_rollback)
    with pytest.raises(PermissionError):
        u.run(session)
    assert (root / "data/cache/updates/pending.json").is_file()


def test_cancelled_preparation_never_changes_application(tmp_path):
    root, session, settings = prepare(tmp_path)
    u.write_json(session / "cancel.json", {})
    with pytest.raises(RuntimeError, match="取消"):
        u.run(session)
    assert not (root / "resources/app").exists()
    assert not (root / "data/cache/updates/pending.json").exists()


@pytest.mark.parametrize("health_pid", [12345, 54321])
def test_stale_or_foreign_health_cannot_confirm_update(tmp_path, monkeypatch, health_pid):
    root, session, settings = prepare(tmp_path)
    old = root / "resources/app/main.js"
    old.parent.mkdir(parents=True); old.write_bytes(b"original")
    u.write_json(session / "healthy.json", {"version": "2.0.2", "pid": health_pid})
    monkeypatch.setattr(u, "wait_exit", lambda *args, **kwargs: None)
    class Child:
        pid = 12345
        def poll(self): return 1
    def restart(*args, **kwargs):
        assert not (session / "healthy.json").exists(), "重启前必须清理旧健康回执"
        # 错误进程即使写了正确版本，也不能被当作本次新版健康。
        u.write_json(session / "healthy.json", {"version": "2.0.2", "pid": health_pid})
        return Child()
    calls = []
    def counted_restart(*args, **kwargs):
        calls.append(kwargs.get("health", True))
        return restart(*args, **kwargs) if len(calls) == 1 else Child()
    monkeypatch.setattr(u, "restart", counted_restart)
    with pytest.raises(RuntimeError, match="启动失败"):
        u.run(session)
    assert old.read_bytes() == b"original"
    result = u.read_json(root / "data/cache/updates/last-result.json")
    assert result["status"] == "rolled-back"
    assert "启动失败" in result["message"]


def test_installed_file_corruption_rolls_back(tmp_path, monkeypatch):
    root, session, settings = prepare(tmp_path)
    old = root / "resources/app/main.js"
    old.parent.mkdir(parents=True); old.write_bytes(b"original")
    manifest = u.validate(session, settings)
    copy = u.shutil.copy2
    def corrupt(source, target):
        result = copy(source, target)
        if str(target).endswith("main.js.voxcpm-update"):
            Path(target).write_bytes(b"corrupted")
        return result
    monkeypatch.setattr(u.shutil, "copy2", corrupt)
    with pytest.raises(OSError, match="安装后文件校验失败"):
        u.install(root, session, manifest)
    assert old.read_bytes() == b"original"


@pytest.mark.parametrize("case", ["interrupted", "running", "foreign"])
def test_offline_repair_recovers_only_owned_stopped_transactions(tmp_path, monkeypatch, case):
    repair_spec = importlib.util.spec_from_file_location("repair_update", MODULE.parents[2] / "scripts/repair_update.py")
    repair = importlib.util.module_from_spec(repair_spec)
    repair_spec.loader.exec_module(repair)
    root, external, settings = prepare(tmp_path)
    session = root / "data/cache/updates/session-old"
    session.parent.mkdir(parents=True)
    import shutil
    shutil.move(str(external), str(session))
    settings["session"] = str(session)
    u.write_json(session / "session.json", settings)
    old = root / "resources/app/main.js"
    old.parent.mkdir(parents=True); old.write_bytes(b"original")
    u.install(root, session, u.validate(session, settings))
    pending = session.parent / "pending.json"
    u.write_json(pending, {"session": str(session), "pid": 12345})
    monkeypatch.setattr(u, "alive", lambda pid: case == "running")
    if case == "foreign":
        settings["root"] = str(tmp_path)
        u.write_json(session / "session.json", settings)
        with pytest.raises(ValueError, match="不一致"):
            repair.recover_pending(root, u)
    elif case == "running":
        with pytest.raises(RuntimeError, match="仍在运行"):
            repair.recover_pending(root, u)
    else:
        assert repair.recover_pending(root, u) is True
        assert old.read_bytes() == b"original"
        assert not pending.exists()
        assert u.read_json(session / "journal.json")["status"] == "rolled-back"
        return
    assert old.read_bytes() == b"new desktop"
    assert pending.exists()


def test_legacy_window_hands_off_to_native_until_parent_exits(tmp_path, monkeypatch):
    root, session, settings = prepare(tmp_path)
    native = session / "stage/resources/app/standalone-updater.exe"
    native.parent.mkdir(parents=True); native.write_bytes(b"verified native fixture")
    manifest = {"version": "2.0.2", "releaseId": "20261018000001", "files": [{"path": "resources/app/standalone-updater.exe"}]}
    monkeypatch.setattr(u, "validate", lambda *args: manifest)
    class Host:
        pid = 23456
        def poll(self): return None
    launched = []
    def spawn(command, **kwargs):
        launched.append(command)
        u.write_json(session / "host-ready.json", {"hostPid": Host.pid, "workerPid": 34567})
        u.write_json(session / "ready.json", {"pid": 34567, "parentPid": settings["parentPid"], "releaseId": manifest["releaseId"]})
        return Host()
    monkeypatch.setattr(u.subprocess, "Popen", spawn)
    exited = []
    monkeypatch.setattr(u, "wait_exit", lambda pid, **kwargs: exited.append(pid))
    assert u.launch_standalone(session) is True
    assert Path(launched[0][0]) == session / "VoxCPM Updater.exe"
    assert launched[0][1:] == ["--session", str(session)]
    assert exited == [settings["parentPid"]], "旧窗口须等旧主进程收到ready并退出，不能抢先关闭"
    assert u.read_json(session / "session.json")["pythonExecutable"] == sys.executable
