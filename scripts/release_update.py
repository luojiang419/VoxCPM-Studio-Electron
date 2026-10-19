"""构建签名应用更新包，并按需发布到魔搭。私钥仅保存在本机 .update-private。"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import urllib.parse
import urllib.request
import zipfile

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, PrivateFormat, NoEncryption

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parent
FRONTEND = ROOT / "frontend/voxcpm_studio_electron"
sys.path.insert(0, str(FRONTEND))
from updater import safe_path, sha256, write_json, read_json


def file_url(repo, relative):
    return f"https://modelscope.cn/api/v1/models/{repo}/repo?" + urllib.parse.urlencode(
        {"Revision": "master", "FilePath": relative})


def keys():
    private = ROOT / ".update-private/signing-key"
    config = read_json(FRONTEND / "update-config.json")
    if private.exists():
        key = Ed25519PrivateKey.from_private_bytes(private.read_bytes())
    else:
        if config.get("publicKey"):
            raise ValueError("私钥缺失，不能自动替换客户端已信任的公钥")
        private.parent.mkdir(exist_ok=True)
        key = Ed25519PrivateKey.generate()
        with private.open("xb") as stream:
            stream.write(key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption()))
    public = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()
    if config.get("publicKey") and config["publicKey"] != public:
        raise ValueError("私钥与已配置公钥不匹配")
    config["publicKey"] = public
    write_json(FRONTEND / "update-config.json", config)
    return key, config


def sources():
    for name in ("main.js", "preload.js", "package.json", "update-service.js", "update-window.js", "update-config.json", "updater.py",
                 "standalone-updater.exe", "updater-runtime-config.json",
                 "runtime-service.js", "runtime-config.json", "runtime-requirements.txt", "install-protocol.js", "component-service.js", "music-config.json", "app.ico", "app-icon.png"):
        yield FRONTEND / name, "resources/app/" + name
    for file in sorted((FRONTEND / "dist").rglob("*")):
        if file.is_file():
            yield file, "resources/app/" + file.relative_to(FRONTEND).as_posix()
    for name in ("app.py", "desktop_api.py", "desktop_app.py", "pyproject.toml"):
        yield PROJECT / name, "app/" + name
    for directory in ("src/voxcpm", "conf", "assets"):
        for file in sorted((PROJECT / directory).rglob("*")):
            if file.is_file() and "__pycache__" not in file.parts and file.suffix not in (".pyc", ".pyo"):
                overlay = ROOT / "backend" / file.relative_to(PROJECT / "src") if directory == "src/voxcpm" else None
                yield overlay if overlay and overlay.is_file() else file, "app/" + file.relative_to(PROJECT).as_posix()
    # 新增后端文件也必须进入发布包，不能依赖父目录已有副本。
    for file in sorted((ROOT / "backend/voxcpm").rglob("*")):
        skill_text = 'music_skills' in file.relative_to(ROOT / 'backend/voxcpm').parts and file.suffix in {'.md', '.txt', '.zip'}
        if file.is_file() and (file.suffix in {".py", ".json"} or skill_text) and not (PROJECT / "src" / file.relative_to(ROOT / "backend")).exists():
            yield file, "app/src/" + file.relative_to(ROOT / "backend").as_posix()
    for name in ("download_bundle_model.py", "portable_self_check.py", "train_voxcpm_finetune.py", "test_voxcpm_ft_infer.py", "test_voxcpm_lora_infer.py"):
        yield PROJECT / "scripts" / name, "app/scripts/" + name


def build(notes, min_version):
    from build_updater_runtime import build as build_update_runtime
    build_update_runtime()
    from build_standalone_updater import build as build_updater
    build_updater()
    key, config = keys()
    release_id = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    config["releaseId"] = release_id
    write_json(FRONTEND / "update-config.json", config)
    subprocess.run(["npm.cmd", "run", "build"], cwd=FRONTEND, check=True, shell=sys.platform == "win32")
    version = read_json(FRONTEND / "package.json")["version"]
    output = ROOT / "builds/updates" / f"{version}-{release_id}"
    if (output / "manifest.json").exists():
        raise ValueError(f"版本已构建，禁止覆盖不可变产物：{output}；请使用已有目录发布或修改正式版本")
    output.mkdir(parents=True, exist_ok=True)
    package = output / f"VoxCPM-Studio-{version}.zip"
    records = []
    with zipfile.ZipFile(package, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file, relative in sources():
            safe_path(relative)
            archive.write(file, relative)
            records.append({"path": relative, "size": file.stat().st_size, "sha256": sha256(file)})
    release_path = f"releases/{version}/{release_id}/{package.name}"
    manifest = {"protocol": 1, "product": "voxcpm-studio", "platform": "win32-x64", "version": version, "releaseId": release_id,
                "minVersion": min_version, "publishedAt": datetime.now(timezone.utc).isoformat(), "notes": notes,
                "package": {"name": package.name, "url": file_url(config["repository"], release_path),
                            "size": package.stat().st_size, "sha256": sha256(package)}, "files": records}
    payload = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))
    envelope = {"payload": payload, "signature": key.sign(payload.encode()).hex()}
    write_json(output / "manifest.json", manifest)
    write_json(output / "envelope.json", envelope)
    return output


def read_remote(url):
    request = urllib.request.Request(url, headers={"Range": "bytes=0-"})
    # 与 SHIYIN 发布器一致：匿名、直连回读，避免登录态掩盖公网访问问题。
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=120) as response:
        return response.read()


def publish(output):
    from modelscope.hub.api import HubApi
    from modelscope.hub.errors import HTTPError
    key, config = keys()
    envelope = read_json(output / "envelope.json")
    key.public_key().verify(bytes.fromhex(envelope["signature"]), envelope["payload"].encode())
    manifest = json.loads(envelope["payload"])
    if manifest != read_json(output / "manifest.json"):
        raise ValueError("清单与签名内容不一致")
    package = output / manifest["package"]["name"]
    if package.stat().st_size != manifest["package"]["size"] or sha256(package) != manifest["package"]["sha256"]:
        raise ValueError("待发布包校验失败")
    repo = config["repository"]
    api = HubApi()
    try:
        api.get_model(repo)
    except HTTPError as error:
        if getattr(error.response, "status_code", None) != 404:
            raise
        api.create_model(repo, visibility=5, license="Apache License 2.0", chinese_name="VoxCPM Studio 桌面更新")
    remote_path = f"releases/{manifest['version']}/" + (f"{manifest['releaseId']}/" if manifest.get('releaseId') else "") + package.name
    existing = {item["Path"] for item in api.get_model_files(repo, recursive=True) if item["Type"] == "blob"}
    if remote_path in existing:
        if hashlib.sha256(read_remote(file_url(repo, remote_path))).hexdigest() != manifest["package"]["sha256"]:
            raise ValueError("远端已有同名不同内容版本，禁止覆盖")
    else:
        api.upload_file(path_or_fileobj=str(package), path_in_repo=remote_path, repo_id=repo,
                        commit_message=f"release: VoxCPM Studio {manifest['version']}")
    remote = read_remote(file_url(repo, remote_path))
    if len(remote) != manifest["package"]["size"] or hashlib.sha256(remote).hexdigest() != manifest["package"]["sha256"]:
        raise ValueError("魔搭匿名包回读校验失败，未激活更新")
    latest_url = config["manifestUrl"]
    if "public/latest.json" in existing:
        previous = json.loads(read_remote(latest_url))
        key.public_key().verify(bytes.fromhex(previous["signature"]), previous["payload"].encode())
        from updater import version
        previous_manifest = json.loads(previous["payload"])
        if version(previous_manifest["version"]) > version(manifest["version"]) or (
            version(previous_manifest["version"]) == version(manifest["version"]) and
            previous_manifest.get("releaseId", "00000000000000") > manifest.get("releaseId", "00000000000000")
        ):
            raise ValueError("禁止回退公网最新版本")
    activation = output / "activation"
    (activation / "public").mkdir(parents=True, exist_ok=True)
    (activation / "public/latest.json").write_bytes((output / "envelope.json").read_bytes())
    (activation / "configuration.json").write_text('{"framework":"pytorch","task":"text-to-speech","pipeline":{"type":"text-to-speech"}}', "utf-8")
    (activation / "README.md").write_text(
        "---\nlicense: apache-2.0\ntasks:\n- text-to-speech\n---\n# VoxCPM Studio 桌面更新\n\n"
        "此仓库仅存放 VoxCPM Studio 桌面更新，不包含模型权重或用户数据。\n\n"
        "客户端通过 public/latest.json 验证 Ed25519 签名，下载后校验 SHA-256。\n"
        "已有旧版首次接入请参阅源码仓库 docs/自动更新说明.md。\n", "utf-8")
    repairer_report = output / "repairer-publication.json"
    repair_report = output / "repair-publication.json"
    unified_report = read_json(repairer_report) if repairer_report.exists() else {}
    if unified_report.get("unified"):
        repair = unified_report
        if repair.get("releaseId") != manifest.get("releaseId") or not repair.get("anonymousVerification"):
            raise ValueError("一体版发布记录与本次更新不一致")
        with (activation / "README.md").open("a", encoding="utf-8") as stream:
            stream.write(
                f"\n## 当前正式更新\n\n版本：{manifest['version']}，发布序号：{manifest['releaseId']}。\n\n"
                f"{manifest['notes']}\n\n"
                "旧客户端首次升级仍使用已有检查更新和下载入口。安装本版后，启动发现新版会直接打开独立更新器，"
                "选择“现在更新”自动下载、校验、安装并重启；选择“下次启动更新”本次继续使用，下次启动再提醒。确认前不下载或关闭工作台。\n\n"
                f"## 安装、检查与修复\n\n[下载 VoxCPM 安装修复一体版 EXE]({repair['repairUrl']})"
                f"（约 {repair['size'] / 1024 ** 2:.1f} MB），新老用户使用同一个文件。\n\n"
                "1. 首次运行选择独立安装目录和功能，自动补齐运行依赖及模型，无需预先安装 Python。\n"
                "2. 已安装时自动识别原目录并检查；正常提示“一切正常，无需再次安装，开始创作吧”，保留运行中的工作台。\n"
                "3. 发现损坏后显示修复进度，使用可信签名包恢复并再次检查；完成后可开始创作。\n\n"
                "运行前请保存任务。只有需要修复才关闭本目录工作台和后台进程，残留进程可能被强制结束；保留已保存作品、模型、配置、密钥和功能选择。"
                "首次依赖/模型下载及获取更新修复资源需要联网，禁止降级已安装的新版。失败时保留日志，不要删除原目录或更新备份。\n\n"
                f"EXE SHA256：`{repair['sha256']}`。\n")
    elif repairer_report.exists():
        repair = read_json(repairer_report)
        if repair.get("releaseId") != manifest.get("releaseId") or not repair.get("anonymousVerification"):
            raise ValueError("单文件修复器发布记录与本次更新不一致")
        with (activation / "README.md").open("a", encoding="utf-8") as stream:
            stream.write(
                f"\n## 当前正式更新\n\n版本：{manifest['version']}，发布序号：{manifest['releaseId']}。\n\n"
                "已安装用户可在软件内检查更新，通过原生独立更新器安装。更新运行环境独立于音频 Python，缺失或损坏时自动补齐。\n\n"
                f"## 老用户一键修复\n\n[下载独立更新修复器 EXE]({repair['repairUrl']})（约 {repair['size'] / 1024 ** 2:.1f} MB），可直接转发给老用户。\n\n"
                "1. 保存作品并停止生成/训练任务，双击修复器，无需解压或安装 Python。\n"
                "2. 确认自动找到的原安装目录；找不到时选择包含 VoxCPM Studio.exe 的原目录。\n"
                "3. 点击“开始修复并升级”，等待修复成功并自动打开软件。\n\n"
                + ("修复器会先自动关闭本目录工作台及旧更新器，隐藏进程无法正常退出时强制结束，未保存内容和进行中的任务可能丢失。"
                   "权限不足时显示具体进程和路径，可右键以管理员身份运行；不结束其他安装目录的进程。\n\n" if repair.get("autoTerminateOwnedProcesses") else "请先关闭原软件和旧更新窗口。\n\n") +
                "修复器联网选择最新可信签名应用，支持同一发布的损坏文件修复，保留模型、配置、音色、作品和已有功能选择。"
                "修复完成后直接使用软件内置更新，不需要每次运行修复器。\n\n"
                "不要卸载、删除旧目录或手动清除更新备份。若失败，请保留窗口显示的日志和会话目录供维护者定位。\n\n"
                f"修复器 SHA256：`{repair['sha256']}`。\n")
    elif repair_report.exists():
        repair = read_json(repair_report)
        if repair.get("releaseId") != manifest.get("releaseId") or not repair.get("anonymousVerification"):
            raise ValueError("修复包发布记录与本次更新不一致")
        with (activation / "README.md").open("a", encoding="utf-8") as stream:
            stream.write(
                f"\n## 当前正式更新\n\n版本：{manifest['version']}，发布序号：{manifest['releaseId']}。\n\n"
                "已安装用户在软件内点击“检查更新”，下载后确认安装，无需重新安装模型。\n\n"
                + ("本次包含原生独立更新器 VoxCPM Updater.exe：新客户端点击“启动独立更新器”，窗口就绪后工作台关闭；"
                   "独立窗口继续安装并自动打开新版。较旧客户端可能仍显示“重启并安装”的确认文字。\n\n"
                   if any(item['path'] == 'resources/app/standalone-updater.exe' for item in manifest['files']) else "") +
                f"## 更新失败的补救\n\n[下载一次性更新修复包]({repair['repairUrl']})（约 {repair['size'] / 1024 ** 2:.1f} MB）。\n\n"
                "1. 完整解压修复包，关闭原软件和独立更新窗口。\n"
                "2. 双击“修复更新.cmd”；默认目录自动识别，找不到时选择包含 VoxCPM Studio.exe 的原安装目录。\n"
                "3. 等待修复成功与自动重启，在设置里核对当前发布序号，再检查更新。\n\n"
                "修复在原目录进行，保留模型、配置、音色和作品；上次更新中断时先使用事务备份恢复。"
                "请不要卸载、删除原目录或手动清理 pending.json / backup。\n\n"
                "若修复仍失败，保留窗口所列的 updater.log 与会话目录，并提供错误内容给维护者定位；"
                "运行环境缺失、权限限制或安全软件拦截需要按日志处理，不通过修改版本标记掩盖失败。\n\n"
                f"修复包 SHA256：`{repair['sha256']}`。\n")
    api.upload_folder(repo_id=repo, folder_path=str(activation), commit_message=f"activate: VoxCPM Studio {manifest['version']}")
    if json.loads(read_remote(latest_url)) != envelope:
        raise ValueError("魔搭最新入口匿名回读不一致")
    report = {"repository": repo, "version": manifest["version"], "releaseId": manifest.get("releaseId"), "sha256": manifest["package"]["sha256"],
              "size": manifest["package"]["size"], "anonymousVerification": True, "manifestUrl": latest_url}
    write_json(output / "publication.json", report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--notes", default="新增自动检查更新、独立更新器、签名校验及失败回滚。")
    parser.add_argument("--min-version", default="0.2.0")
    parser.add_argument("--init-key", action="store_true")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--snapshot", type=Path, help="复用已构建的不可变版本目录")
    args = parser.parse_args()
    if args.init_key:
        keys()
        print("本机签名密钥已就绪，公钥已写入客户端配置；私钥不进入 Git 与发布包。")
    else:
        output = args.snapshot.resolve(strict=True) if args.snapshot else build(args.notes, args.min_version)
        print(f"更新包：{output}")
        if args.publish:
            publish(output)
