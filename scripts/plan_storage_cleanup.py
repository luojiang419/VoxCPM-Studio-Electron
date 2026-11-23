"""仅生成本项目清理清单；保留最新正式交付、唯一资源和测试中借用的配置。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil

REPO = Path(__file__).resolve().parents[1]
PROJECT = REPO.parent
OUTPUT = REPO / "builds/storage-cleanup"


def plan():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    baselines = list((REPO / "builds/正式分发").glob("基准包-*/基准包记录.json"))
    if not baselines:
        raise RuntimeError("未找到正式基准包记录，拒绝推测最新版本")
    baseline = max(baselines, key=lambda p: json.loads(p.read_text("utf8"))["releaseId"])
    record = json.loads(baseline.read_text("utf8"))
    source = Path(record["sourceExecutable"]).parent
    build = json.loads((source / "构建记录.json").read_text("utf8"))
    updater = json.loads((REPO / "frontend/voxcpm_studio_electron/updater-runtime-config.json").read_text("utf8"))["id"]
    targets = []

    def add(path, reason):
        # 不 resolve 叶子 junction；执行端也会核对所有上级目录。
        path = Path(os.path.abspath(path))
        if path.exists() or path.is_symlink() or path.is_junction():
            targets.append({"path": path.relative_to(PROJECT).as_posix(), "reason": reason})

    def children_except(directory, keep, reason):
        if directory.is_dir():
            for p in directory.iterdir():
                if p.name not in keep:
                    add(p, reason)

    keep = {"storage-cleanup", "正式分发", "updates", "repairer-build", "updater-runtime", "bootstrap-validation",
            "modelscope-distribution", "lipsync-assets", "VoxCPM-Studio-Electron-Portable-2.0.1",
            Path(build["desktop"]).name, Path(build["desktopArchive"]).name}
    children_except(REPO / "builds", keep, "历史安装器、桌面副本或隔离验收产物")
    children_except(REPO / "builds/正式分发", {baseline.parent.name, source.name}, "仅保留最新正式分发")
    children_except(REPO / "builds/updates", {Path(record["snapshot"]).name}, "仅保留最新签名快照")
    children_except(REPO / "builds/repairer-build", {Path(build["payload"]).parent.name}, "历史安装器构建中间产物")
    children_except(REPO / "builds/updater-runtime", {updater, updater + ".zip", updater + ".publication.json"}, "旧独立更新环境")
    children_except(REPO / "builds/bootstrap-validation", {"runtime"}, "保留已安装音频依赖，移除测试副本和下载副本")
    for name in ("native-validation", "electron-data", "publication"):
        add(REPO / "builds/modelscope-distribution" / name, "保留固定离线资源，移除验证/上传副本")
    portable = REPO / "builds/VoxCPM-Studio-Electron-Portable-2.0.1"
    children_except(portable, {"runtime", "ffmpeg"}, "旧便携版应用与重复模型；兼容目录仅保留共享依赖链接")
    old_python = portable / "runtime/python"
    if old_python.is_dir() and not old_python.is_junction():
        add(old_python, "旧音频依赖由当前已验证托管环境替代，清理后建立兼容链接")
    site = REPO / "builds/bootstrap-validation/runtime/managed/py312-cu126/Lib/site-packages"
    for p in site.glob("~*"):
        add(p, "pip 升级遗留的不可导入旧依赖")

    for worktree, fixture in (("启动准备开发", "component-live-validation"), ("音乐助手开发", "music-ui-live-validation")):
        builds = PROJECT / worktree / "builds"
        children_except(builds, {fixture}, "旧工作树构建与测试副本；保留工作树源码和 Git")
        children_except(builds / fixture, {"runtime", "models"}, "旧测试桌面副本；唯一音乐资源已迁移到根目录")
        models = builds / fixture / "models"
        if models.is_dir() and not models.is_junction():
            add(models, "重复模型目录由根 models 的兼容链接替代")

    backups = sorted((PROJECT / "backup").glob("v*"), key=lambda p: p.name)
    for p in backups[:-1]:
        add(p, "源码备份只保留最新一份；当前版本由 Git 保存")
    for p in (PROJECT / "vendor").rglob("*.partial"):
        complete = p.with_name(p.name.removesuffix(".wget.partial")) if p.name.endswith(".wget.partial") else p.with_suffix("")
        if complete.is_file():
            add(p, "已存在完整文件的废弃下载断点")
    for root in (REPO / "backend", REPO / "scripts", REPO / "tests", PROJECT / "src"):
        for p in root.rglob("__pycache__"):
            add(p, "可再生 Python 字节码缓存")
    for root in (REPO, PROJECT, PROJECT / "启动准备开发", PROJECT / "音乐助手开发"):
        add(root / ".pytest_cache", "可再生测试缓存")

    # 删除嵌套重复条目，并保存夹具中借用的配置，避免误清唯一的助手凭据。
    selected = []
    for entry in sorted(targets, key=lambda e: (len(Path(e["path"]).parts), e["path"])):
        relative = Path(entry["path"])
        if not any(relative.is_relative_to(Path(parent["path"])) for parent in selected):
            selected.append(entry)
    preserved = []
    for entry in selected:
        target = PROJECT / entry["path"]
        if not target.is_dir() or target.is_junction():
            continue
        for folder, dirs, files in os.walk(target, followlinks=False):
            dirs[:] = [d for d in dirs if not (Path(folder) / d).is_junction() and not (Path(folder) / d).is_symlink()]
            for name in files:
                path = Path(folder) / name
                if "config" in path.parts and "data" in path.parts and path.suffix == ".json":
                    dest = OUTPUT / "preserved-configs" / path.relative_to(PROJECT)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(path, dest)
                    preserved.append(path.relative_to(PROJECT).as_posix())
    # 最新正式版本验收结果仍留作证据，实际安装副本可再生。
    report = Path(record["validationReport"])
    if report.is_file():
        shutil.copy2(report, OUTPUT / "latest-release-validation.json")
    result = {"root": str(PROJECT), "releaseId": record["releaseId"], "targets": selected,
              "preservedConfigs": preserved, "note": "只生成清单；由 cleanup_project.ps1 核对后执行。"}
    (OUTPUT / "plan.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf8")
    print(f"最新正式发布 {record['releaseId']}；清理目标 {len(selected)} 项；配置另存 {len(preserved)} 项。")


if __name__ == "__main__":
    plan()
