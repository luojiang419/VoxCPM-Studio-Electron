"""将已签名快照打包为可复制到另一台电脑运行的离线修复包，不发布公网。"""
import argparse
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def build(snapshot: Path, output_dir: Path | None = None):
    import sys
    sys.path.insert(0, str(ROOT / "frontend/voxcpm_studio_electron"))
    from updater import read_json, sha256
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    envelope = read_json(snapshot / "envelope.json")
    config = read_json(ROOT / "frontend/voxcpm_studio_electron/update-config.json")
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(config["publicKey"])).verify(bytes.fromhex(envelope["signature"]), envelope["payload"].encode())
    import json
    manifest = json.loads(envelope["payload"])
    package = snapshot / manifest["package"]["name"]
    if sha256(package) != manifest["package"]["sha256"]:
        raise ValueError("快照包哈希错误")
    output = output_dir or ROOT / "builds/正式分发" / ("VoxCPM-更新修复-" + manifest["releaseId"])
    output.mkdir(parents=True, exist_ok=False)
    for name in ("repair_update.py", "repair_update.ps1"):
        shutil.copy2(ROOT / "scripts" / name, output / name)
    # Windows PowerShell 5.1 通过 BOM 正确读取中文文案。
    script = output / "repair_update.ps1"
    script.write_text(script.read_text("utf-8"), encoding="utf-8-sig")
    shutil.copy2(ROOT / "frontend/voxcpm_studio_electron/updater.py", output / "updater.py")
    shutil.copy2(snapshot / "envelope.json", output / "envelope.json")
    shutil.copy2(package, output / package.name)
    manifest_native = next((item for item in manifest["files"] if item["path"] == "resources/app/standalone-updater.exe"), None)
    if manifest_native:
        with zipfile.ZipFile(package) as payload:
            native = payload.read(manifest_native["path"])
        if __import__('hashlib').sha256(native).hexdigest() != manifest_native["sha256"]:
            raise ValueError("原生独立更新器校验失败")
        (output / "standalone-updater.exe").write_bytes(native)
    (output / "修复更新.cmd").write_bytes(b'@echo off\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0repair_update.ps1" %*\r\npause\r\n')
    (output / "使用说明.txt").write_text(
        "请先完整解压，再关闭原软件与更新器，双击“修复更新.cmd”。\n"
        "自动识别原安装位置；找不到或有多个目录时会要求选择包含 VoxCPM Studio.exe 的目录。\n"
        "也可把原 VoxCPM Studio.exe 拖到“修复更新.cmd”上指定路径。\n"
        "无需重新下载模型，无需额外安装 Python。软件原有运行环境必须已准备完毕。\n"
        "签名验证后替换应用文件，自动重启；启动失败回滚，并显示具体原因和日志路径。\n"
        "不会删除模型、配置、音色与作品。请保持修复窗口打开至显示成功。\n"
        "遇到上次更新中断时，会在确认更新进程已退出后从事务备份恢复，再安装修复。不要手动删除pending.json或backup。\n"
        "若修复仍失败，不要卸载或删除原目录；保留窗口中显示的updater.log和会话目录，联系维护者定位。\n"
        f"目标版本：{manifest['version']}；发布序号：{manifest['releaseId']}。\n"
        "修复成功后，请在设置中确认发布序号并再次检查更新。相同或更旧的修复包会拒绝重复安装。\n", encoding="utf-8-sig")
    archive = output.with_suffix(".zip")
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED) as z:
        for file in output.iterdir():
            z.write(file, output.name + "/" + file.name)
    print(str(archive))
    print("SHA256: " + sha256(archive))
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--output", type=Path, help="使用独立目录保存公开分发包，不覆盖已验证旧产物")
    args = parser.parse_args()
    build(args.snapshot.resolve(strict=True), args.output)
