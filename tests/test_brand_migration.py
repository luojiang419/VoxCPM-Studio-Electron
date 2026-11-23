"""更名迁移使用真实文件、Windows快捷方式和隔离卸载登记，不接触用户安装。"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

spec = importlib.util.spec_from_file_location("brand_updater", Path(__file__).resolve().parents[1] / "frontend/voxcpm_studio_electron/updater.py")
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)


def fixture(tmp_path):
    root, session = tmp_path / "中文 安装", tmp_path / "事务"
    (root / "resources/app").mkdir(parents=True)
    session.mkdir()
    u.write_json(root / "resources/app/package.json", {"version": "2.0.3", "build": {"productName": "JVOX Studio配音系统"}})
    u.write_json(session / "journal.json", {"changes": [], "status": "awaiting-health"})
    (root / "VoxCPM Studio.exe").write_bytes(b"trusted existing electron")
    return root, session


def test_entry_creation_idempotent_and_rollback(tmp_path):
    root, session = fixture(tmp_path)
    u.prepare_brand_entry(root, session)
    assert (root / "JVOX Studio配音系统.exe").read_bytes() == (root / "VoxCPM Studio.exe").read_bytes()
    u.prepare_brand_entry(root, session)
    u.rollback(root, session)
    assert not (root / "JVOX Studio配音系统.exe").exists()
    assert (root / "VoxCPM Studio.exe").is_file()


def test_existing_entry_is_preserved(tmp_path):
    root, session = fixture(tmp_path)
    (root / "JVOX Studio配音系统.exe").write_bytes(b"existing new installation")
    u.prepare_brand_entry(root, session)
    u.rollback(root, session)
    assert (root / "JVOX Studio配音系统.exe").read_bytes() == b"existing new installation"


def test_entry_directory_rejected(tmp_path):
    root, session = fixture(tmp_path)
    (root / "JVOX Studio配音系统.exe").mkdir()
    with pytest.raises(ValueError, match="目录占用"):
        u.prepare_brand_entry(root, session)


def test_signed_uninstaller_and_icon_restore_on_rollback(tmp_path):
    root, session = fixture(tmp_path)
    (root / ".voxcpm-install.json").write_text("{}")
    for target, signed in (("uninstall.exe", "brand-uninstaller.exe"), ("voxcpm.ico", "app.ico")):
        (root / target).write_bytes(b"previous")
        (root / "resources/app" / signed).write_bytes(b"signed replacement")
    u.prepare_brand_entry(root, session)
    assert (root / "uninstall.exe").read_bytes() == b"signed replacement"
    u.rollback(root, session)
    assert (root / "uninstall.exe").read_bytes() == b"previous"
    assert (root / "voxcpm.ico").read_bytes() == b"previous"


@pytest.mark.skipif(os.name != "nt", reason="真实 Windows COM 与注册表")
def test_owned_shortcuts_and_registry_migrate_without_touching_others(tmp_path):
    import winreg
    import uuid
    root, session = fixture(tmp_path)
    u.prepare_brand_entry(root, session)
    desktop, menu = tmp_path / "desktop", tmp_path / "menu/VoxCPM Studio"
    desktop.mkdir(); menu.mkdir(parents=True)
    owned, uninstall, other = desktop / "VoxCPM Studio.lnk", menu / "卸载 VoxCPM Studio.lnk", desktop / "其他软件.lnk"
    script = r'''$s=New-Object -ComObject WScript.Shell
foreach($r in (ConvertFrom-Json $env:JVOX_TEST_LINKS)) {$l=$s.CreateShortcut($r.path);$l.TargetPath=$r.target;$l.Arguments=$r.args;$l.Save()}'''
    rows = [{"path": str(owned), "target": str(root / "VoxCPM Studio.exe"), "args": "--voxcpm-run"},
            {"path": str(uninstall), "target": str(root / "uninstall.exe"), "args": "--uninstall"},
            {"path": str(other), "target": str(tmp_path / "other.exe"), "args": ""}]
    subprocess.run(["powershell.exe", "-NoProfile", "-Command", script], env={**os.environ, "JVOX_TEST_LINKS": json.dumps(rows)}, check=True, capture_output=True)
    untouched = other.read_bytes()
    key = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\VoxCPMStudio-Test-" + uuid.uuid4().hex
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as registry:
        winreg.SetValueEx(registry, "InstallLocation", 0, winreg.REG_SZ, str(root))
        winreg.SetValueEx(registry, "DisplayName", 0, winreg.REG_SZ, "VoxCPM Studio")
    u.write_json(root / ".voxcpm-install.json", {"product": "voxcpm-studio", "root": str(root), "files": [], "shortcuts": [str(owned), str(uninstall), str(other)], "registryKey": key})
    try:
        u.migrate_brand_integration(root, session)
        u.migrate_brand_integration(root, session)
        assert not owned.exists() and not uninstall.exists()
        assert (desktop / "JVOX Studio配音系统.lnk").is_file()
        assert (tmp_path / "menu/JVOX Studio配音系统/卸载 JVOX Studio配音系统.lnk").is_file()
        assert other.read_bytes() == untouched
        state = u.read_json(root / ".voxcpm-install.json")
        assert "JVOX Studio配音系统.exe" in state["files"]
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as registry:
            assert winreg.QueryValueEx(registry, "DisplayName")[0] == "JVOX Studio配音系统"
            assert winreg.QueryValueEx(registry, "DisplayVersion")[0] == "2.0.3"
    finally:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
