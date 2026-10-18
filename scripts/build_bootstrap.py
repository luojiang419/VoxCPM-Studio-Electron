"""将桌面壳放到魔搭，构建只携带固定资源清单的 Windows 原生启动器。"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import urllib.request
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from modelscope_runtime import DEFAULT_REPO, file_url, publish_file, sha256

ROOT = Path(__file__).resolve().parents[1]


def build(payload: Path, output: Path, release_id: str, payload_url: str | None = None, demo: bool = False):
    if output.exists():
        raise ValueError(f"启动器输出目录已存在：{output}")
    output.mkdir(parents=True)
    prefix = f"bootstrap/2.0.2/{release_id}"
    manifest = {"protocol": 1, "componentProtocol": 2, "releaseId": release_id, "entry": "VoxCPM Studio.exe",
                "package": {"name": payload.name, "size": payload.stat().st_size, "sha256": sha256(payload),
                            "urls": [payload_url or file_url(DEFAULT_REPO, prefix + "/" + payload.name)]}, "files": []}
    with zipfile.ZipFile(payload) as archive:
        roots = {a.filename.split("/", 1)[0] for a in archive.infolist()}
        if len(roots) != 1:
            raise ValueError("桌面包必须包含唯一根目录")
        for entry in archive.infolist():
            if entry.is_dir():
                raise ValueError("桌面包应只记录文件")
            with archive.open(entry) as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            manifest["files"].append({"name": entry.filename.split("/", 1)[1], "size": entry.file_size, "sha256": digest})
        root = next(iter(roots))
        manifest["appVersion"] = json.loads(archive.read(root + "/resources/app/package.json"))["version"]
        manifest["appReleaseId"] = json.loads(archive.read(root + "/resources/app/update-config.json"))["releaseId"]
        music = json.loads(archive.read(root + '/resources/app/music-config.json'))
        manifest['musicRuntimeSize'] = music['runtime']['installed_size']
        manifest['musicArchiveSize'] = music['runtime']['size']
        manifest['musicRuntimeVersion'] = music['runtime']['version']
        limits = {'ace-xl-turbo': 15360, 'yue2': 7680, 'minimax-music3': 15360, 'heartmula': 15360}
        manifest['components'] = [{'id': 'lipsync', 'label': '视频对口型与照片说话', 'size': 6 * 1024**3, 'minMemoryMB': 7680}] + [
            {'id': m['id'], 'label': m['label'], 'size': sum(a['size'] for a in m['files']), 'minMemoryMB': limits[m['id']],
             'files': [{key: a[key] for key in ('name', 'size', 'sha256')} for a in m['files']]} for m in music['models']]
    source_manifest = output.parent / (output.name + "-manifest.json")
    source_manifest.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    executable = output / ("VoxCPM安装器-界面演示.exe" if demo else "VoxCPM安装器.exe")
    compiler = Path("C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe")
    subprocess.run([str(compiler), "/nologo", "/target:winexe", "/platform:anycpu", "/optimize+", *(["/define:DEMO"] if demo else []), "/out:" + str(executable),
                    "/win32icon:" + str(ROOT / "assets/brand/voxcpm-installer.ico"),
                    "/resource:" + str(ROOT / "assets/brand/voxcpm-app.ico") + ",app.ico",
                    "/resource:" + str(ROOT / "assets/brand/voxcpm-installer.ico") + ",installer.ico",
                    "/resource:" + str(ROOT / "assets/brand/voxcpm-app-256.png") + ",app-mark.png",
                    "/resource:" + str(source_manifest) + ",bootstrap-manifest.json", "/resource:" + str(ROOT / "assets/brand/disk-local-256.png") + ",disk-local.png", "/reference:System.Windows.Forms.dll",
                    "/reference:System.Drawing.dll", "/reference:Accessibility.dll", "/reference:System.Web.Extensions.dll", "/reference:System.IO.Compression.dll",
                    "/reference:System.IO.Compression.FileSystem.dll", str(ROOT / "bootstrap/Program.cs"), str(ROOT / "bootstrap/SharedTheme.cs"), str(ROOT / "bootstrap/Installation.cs"), str(ROOT / "bootstrap/Components.cs"), str(ROOT / "bootstrap/DiskCard.cs")], check=True)
    (output / "使用说明.txt").write_text("界面演示：点击运行可观看准备进度，并可暂停、继续和重新演示。\n此版本不会下载、安装或打开工作台。\n" if demo else
        "双击 VoxCPM安装器.exe，选择独立安装目录并点击安装并运行。\n"
        "安装器会从魔搭补齐应用、依赖和模型，服务就绪后创建快捷方式并登记 Windows 卸载入口。\n"
        "不需要预先安装 Python；Windows 10/11 自带的 .NET Framework 可运行启动器。\n"
        "默认安装到非 C 盘的 Program Files\\VoxCPMStudio，至少需要 25 GiB 可用空间和读写权限；也可手动更改。\n"
        "C 盘自动检测多个当前用户专用目录的 EXE 写入权限，无需管理员权限；其他分区不可用时也可回退到 C 盘。\n"
        "采用当前用户安装，无需管理员权限。\n"
        "可在 Windows 设置的应用列表或开始菜单卸载；默认保留个人数据，可勾选删除。\n"
        "已下载资源会校验复用；暂停或网络中断后可继续。RTX 50 系自动选择 CUDA 12.8。\n"
        "首次下载的桌面、依赖和模型体积不会消失，只是改由魔搭按需补齐。\n", encoding="utf-8")
    archive = output.parent / (output.name + ".zip")
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED, compresslevel=9) as zip_output:
        for file in output.iterdir():
            zip_output.write(file, file.name)
    plan = {"repository": DEFAULT_REPO, "prefix": prefix, "payload": str(payload), "launcher": str(executable),
            "manifest": str(source_manifest), "package": str(archive), "demo": demo}
    if payload_url:
        from urllib.parse import parse_qs, urlparse
        parsed = urlparse(payload_url)
        if parsed.scheme != "https" or parsed.hostname != "modelscope.cn":
            raise ValueError("复用桌面包地址必须为魔搭 HTTPS")
        plan["payloadRemotePath"] = parse_qs(parsed.query)["FilePath"][0]
    (output.parent / (output.name + "-publication-plan.json")).write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"原生启动器 {executable.stat().st_size:,} 字节；ZIP {archive.stat().st_size:,} 字节")
    return plan


def publish(plan):
    if plan.get("demo"):
        raise ValueError("演示版本不作为正式启动器发布")
    from modelscope.hub.api import HubApi

    api = HubApi()
    for name in ("payload", "launcher"):
        file = Path(plan[name])
        relative = plan.get("payloadRemotePath", plan["prefix"] + "/" + file.name) if name == "payload" else plan["prefix"] + "/" + file.name
        digest = sha256(file)
        publish_file(api, plan["repository"], relative, file, digest)
        request = urllib.request.Request(file_url(plan["repository"], relative))
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=120) as response:
            actual = hashlib.file_digest(response, "sha256").hexdigest()
        if actual != digest:
            raise ValueError("魔搭匿名完整回读校验失败：" + file.name)
    report = {"repository": plan["repository"], "prefix": plan["prefix"], "launcherUrl": file_url(plan["repository"], plan["prefix"] + "/" + Path(plan["launcher"]).name),
              "anonymousFullSha256Verified": True, "autoUpdateActivated": False}
    Path(plan["manifest"]).with_suffix(".publication.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--release-id", default=datetime.now(timezone(timedelta(hours=8))).strftime("%Y%m%d%H%M%S"))
    parser.add_argument("--payload-url", help="复用已发布的不可变魔搭桌面包")
    parser.add_argument("--demo", action="store_true", help="构建不执行下载的界面演示版")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--plan", type=Path, help="发布已构建的启动器，避免重复构建")
    args = parser.parse_args()
    if args.plan:
        plan = json.loads(args.plan.read_text(encoding="utf-8"))
    else:
        if args.payload is None or args.output is None:
            parser.error("构建时需指定 --payload 和 --output")
        plan = build(args.payload.resolve(strict=True), args.output.resolve(), args.release_id, args.payload_url, args.demo)
    if args.publish:
        publish(plan)
