"""构建不包含 Python、CUDA、模型与用户数据的 Windows 轻量包。"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parent
FRONTEND = ROOT / "frontend/voxcpm_studio_electron"
RUNTIME_FILES = ("runtime-service.js", "runtime-config.json", "runtime-requirements.txt", "install-protocol.js", "component-service.js", "music-config.json")
SHELL_FILES = ("main.js", "preload.js", "package.json", "update-service.js", "update-window.js", "update-config.json", "updater.py", "standalone-updater.exe", "brand-uninstaller.exe", "updater-runtime-config.json", *RUNTIME_FILES)


def build(output: Path, skip_build: bool = False, skip_zip: bool = False) -> Path:
    from build_updater_runtime import build as build_update_runtime
    build_update_runtime()
    from build_standalone_updater import build as build_updater
    build_updater()
    output = output.resolve()
    if output.exists():
        raise ValueError(f"输出目录已存在，使用新目录以保护原文件：{output}")
    if not skip_build:
        for command in ("node_modules/typescript/bin/tsc", "node_modules/vite/bin/vite.js"):
            subprocess.run(["node", str(FRONTEND / command), "--noEmit" if "typescript" in command else "build"], cwd=FRONTEND, check=True)
    electron = FRONTEND / "node_modules/electron/dist"
    if not (electron / "electron.exe").is_file():
        raise ValueError("请先在前端目录执行 npm ci（可配置 ELECTRON_MIRROR 国内镜像）")
    shutil.copytree(electron, output, ignore=lambda directory, names: [n for n in names if Path(directory).name == "locales" and n not in ("en-US.pak", "zh-CN.pak")])
    (output / "electron.exe").rename(output / "JVOX Studio配音系统.exe")
    icon = ROOT / "assets/brand/voxcpm-app.ico"
    if not icon.is_file():
        raise ValueError("缺少品牌图标，请先执行 scripts/build_brand_icons.py")
    environment = dict(os.environ)
    environment["PATH"] = str(FRONTEND / "node_modules/7zip-bin/win/x64") + os.pathsep + environment.get("PATH", "")
    subprocess.run([str(FRONTEND / "node_modules/app-builder-bin/win/x64/app-builder.exe"), "rcedit", "--args",
                    json.dumps([str(output / "JVOX Studio配音系统.exe"), "--set-icon", str(icon), "--set-file-version", json.loads((FRONTEND / "package.json").read_text("utf8"))["version"], "--set-product-version", json.loads((FRONTEND / "package.json").read_text("utf8"))["version"], "--set-version-string", "ProductName", "JVOX Studio配音系统", "--set-version-string", "FileDescription", "JVOX Studio配音系统"])], env=environment, check=True)
    app = output / "resources/app"
    app.mkdir(parents=True, exist_ok=True)
    for name in SHELL_FILES:
        shutil.copy2(FRONTEND / name, app / name)
    shutil.copy2(icon, app / "app.ico")
    shutil.copy2(ROOT / "assets/brand/voxcpm-app-256.png", app / "app-icon.png")
    shutil.copytree(FRONTEND / "dist", app / "dist")
    backend = output / "app"
    backend.mkdir()
    for name in ("desktop_api.py", "desktop_app.py", "app.py", "pyproject.toml", "LICENSE"):
        shutil.copy2(PROJECT / name, backend / name)
    for name in ("src/voxcpm", "assets", "conf"):
        shutil.copytree(PROJECT / name, backend / name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"))
    shutil.copytree(ROOT / "backend/voxcpm", backend / "src/voxcpm", dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    scripts = backend / "scripts"
    scripts.mkdir()
    for name in ("train_voxcpm_finetune.py", "test_voxcpm_ft_infer.py", "test_voxcpm_lora_infer.py", "download_bundle_model.py", "portable_self_check.py"):
        shutil.copy2(PROJECT / "scripts" / name, scripts / name)
    for name in ("setup_lipsync.py", "requirements-lipsync.txt"):
        if (ROOT / "scripts" / name).is_file():
            shutil.copy2(ROOT / "scripts" / name, scripts / name)
    manifest = {"protocol": 1, "mode": "lightweight", "platform": "win32-x64", "version": json.loads((FRONTEND / "package.json").read_text("utf8"))["version"]}
    for name in ("lightweight.json", "runtime_manifest.json"):
        (output / name).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output / "使用说明.txt").write_text(
        "双击 JVOX Studio配音系统.exe，自动检查并补齐已选择的功能、模型和依赖，然后进入工作区。\n"
        "首次需要联网并预留至少 25GB 可用空间；具体下载量取决于显卡和缓存。\n"
        "桌面、模型、Python 和依赖优先从魔搭补齐。补齐后可离线使用已安装功能。\n"
        "RTX 50 系自动选择 CUDA 12.8，需要 NVIDIA Windows 驱动 570.65 或更新。\n"
        "下载中断可点击继续；关闭软件会暂停，保留已下载文件。日志：data/cache/runtime-bootstrap.log。\n"
        "请解压到可写本地目录，路径尽量简短；不要放在 Program Files 等需要管理员权限的位置。\n"
        "首次补齐包括配音、语音识别和降噪，以及所选视频、音乐功能的独立运行环境。\n"
        "可在功能与模型管理中选择、移除和恢复模型；更新后保留主动移除状态。\n", encoding="utf-8")
    if not skip_zip:
        archive = output.parent / (output.name + ".zip")
        if archive.exists():
            raise ValueError(f"压缩包已存在，未覆盖：{archive}")
        with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for file in sorted(output.rglob("*")):
                if file.is_file():
                    z.write(file, output.name + "/" + file.relative_to(output).as_posix())
        print(f"轻量压缩包：{archive}（{archive.stat().st_size / 1024**2:.1f} MB）")
    print(f"轻量前端：{output}")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "builds/JVOX-Studio-Lightweight-2.0.2")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--skip-zip", action="store_true")
    args = parser.parse_args()
    build(args.output, args.skip_build, args.skip_zip)
