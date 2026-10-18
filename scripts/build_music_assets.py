"""从实测环境制作独立音乐运行包，模型另走魔搭清单，不混入安装器。"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import shutil
import urllib.request
import zipfile

from packaging.requirements import Requirement

ROOT = Path(__file__).resolve().parents[1]
REPO = "jiangjiang419/voxcpm-studio-updates"


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024**2), b""):
            h.update(chunk)
    return h.hexdigest()


def url(path):
    return f"https://modelscope.cn/api/v1/models/{REPO}/repo?Revision=master&FilePath=" + urllib.parse.quote(path, safe="")


def link(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        return
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)


def build(source, output, version, refresh=False, prepare_only=False):
    output.mkdir(parents=True, exist_ok=True)
    stage = output / "stage"
    if stage.exists() and not refresh:
        raise RuntimeError("暂存目录已存在，请选择新的输出目录")
    stage.mkdir(exist_ok=refresh)
    python_spec = json.loads((ROOT / "frontend/voxcpm_studio_electron/runtime-config.json").read_text(encoding="utf8"))["python"]
    archive = output / python_spec["name"]
    if not archive.exists():
        urllib.request.urlretrieve(python_spec["urls"][0], archive)
    if digest(archive) != python_spec["sha256"]:
        raise RuntimeError("Python核心校验失败")
    python_root = stage / "python"
    with zipfile.ZipFile(archive) as z:
        z.extractall(python_root)
    (python_root / "python312._pth").write_text("python312.zip\n.\nLib/site-packages\nimport site\n", encoding="utf8")
    overlay = source / "runtime/music-python"
    fallback = {d.metadata["Name"].lower().replace("_", "-"): d for d in metadata.distributions(path=[str(overlay)])}
    requirements = (source / "vendor/ComfyUI/requirements.txt").read_text(encoding="utf8").splitlines()
    pending = [Requirement(line).name for line in requirements if line.strip() and not line.startswith("#")]
    pending += ["soundfile", "tiktoken", *fallback]
    copied = {}
    while pending:
        name = pending.pop().lower().replace("_", "-")
        if name in copied:
            continue
        try:
            dist = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            dist = fallback.get(name)
            if dist is None:
                if name in {"pyopengl", "comfy-angle"}:
                    continue
                raise
        copied[name] = dist.version
        for requirement in dist.requires or []:
            req = Requirement(requirement)
            if not req.marker or req.marker.evaluate({"extra": ""}):
                pending.append(req.name)
        base = Path(dist.locate_file("")).resolve()
        for relative in dist.files or []:
            file = Path(dist.locate_file(relative)).resolve()
            if not file.is_relative_to(base) or not file.is_file() or file.suffix == ".pyc":
                continue
            link(file, python_root / "Lib/site-packages" / file.relative_to(base))
    exclusions = shutil.ignore_patterns(".git", "__pycache__", "*.pyc", "node_modules", ".cache")
    def comfy_ignore(directory, names):
        ignored = exclusions(directory, names)
        if Path(directory) == source / 'vendor/ComfyUI':
            ignored.update(n for n in names if n in {'models', 'input', 'output', 'user', 'custom_nodes'})
        return ignored
    shutil.copytree(source / "vendor/ComfyUI", stage / "ComfyUI", ignore=comfy_ignore, dirs_exist_ok=refresh)
    shutil.copytree(overlay, stage / "heart-python", ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "bin"), dirs_exist_ok=refresh)
    shutil.copytree(source / "third_party/music/heartlib/src", stage / "heartlib", ignore=exclusions, dirs_exist_ok=refresh)
    shutil.copytree(source / "third_party/music/YuE2-ComfyUI/yue2_comfy", stage / "yue2_comfy", ignore=exclusions, dirs_exist_ok=refresh)
    for name in ["LICENSE", "NOTICE.md", "SOURCE_REVISION.txt"]:
        original = source / "third_party/music/YuE2-ComfyUI" / name
        if original.is_file():
            shutil.copy2(original, stage / ("yue2-" + name))
    if prepare_only:
        (stage / 'runtime-info.json').write_text(json.dumps({'version': version, 'packages': copied}), encoding='utf8')
    else:
        package(stage, output, version, copied)


def package(stage, output, version, copied):
    entries = {}
    for file in stage.rglob("*"):
        if file.is_file() and file.name not in {'runtime-info.json', 'ready.json'} and '__pycache__' not in file.parts and file.suffix != '.pyc':
            entries[file.relative_to(stage).as_posix()] = file.stat().st_size
    (stage / "runtime-info.json").write_text(json.dumps({"version": version, "python": "3.12", "packages": copied, "files": entries}, ensure_ascii=False), encoding="utf8")
    bundle = output / "music-runtime.zip"
    print("PACKAGING", len(entries), round(sum(entries.values()) / 1024**3, 2), "GiB", flush=True)
    with zipfile.ZipFile(bundle, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as z:
        for relative in [*entries, 'runtime-info.json']:
            z.write(stage / relative, relative)
    parts = []
    prefix = "music/" + version
    with bundle.open("rb") as f:
        index = 0
        while chunk := f.read(256 * 1024**2):
            name = f"music-runtime.zip.part{index:02d}"
            part = output / name
            part.write_bytes(chunk)
            parts.append({"name": name, "size": len(chunk), "sha256": hashlib.sha256(chunk).hexdigest(), "urls": [url(prefix + "/" + name)]})
            index += 1
    spec = {"version": version, "size": bundle.stat().st_size, "sha256": digest(bundle), "parts": parts,
            "installed_size": sum(entries.values()), "required": ["python/python.exe", "python/Lib/site-packages/torch/__init__.py", "ComfyUI/main.py", "yue2_comfy/nodes.py", "heartlib/heartlib/__init__.py", "runtime-info.json"]}
    (output / "runtime-spec.json").write_text(json.dumps(spec, indent=2), encoding="utf8")
    (output / "upload-plan.json").write_text(json.dumps({"repository": REPO, "prefix": prefix, "files": [{**p, "local": str(output / p["name"])} for p in parts]}, indent=2), encoding="utf8")
    (output / 'manifest.json').write_text(json.dumps({'protocol': 1, 'files': [{k: p[k] for k in ('name', 'size', 'sha256')} for p in parts]}, indent=2), encoding='utf8')
    print("RUNTIME_READY", bundle.stat().st_size, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", default="20261018-v1")
    parser.add_argument('--repack', action='store_true')
    parser.add_argument('--refresh', action='store_true')
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    if args.repack:
        stage = args.output.resolve() / 'stage'
        package(stage, args.output.resolve(), args.version, json.loads((stage / 'runtime-info.json').read_text(encoding='utf8'))['packages'])
    else:
        build(args.source.resolve(), args.output.resolve(), args.version, args.refresh, args.prepare_only)
