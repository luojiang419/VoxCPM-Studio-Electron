"""从已验证的视频环境构建独立依赖包和固定下载清单；--publish 仅发布补齐资源。"""
from __future__ import annotations

import argparse
from collections import deque
import hashlib
from importlib import metadata
import json
from pathlib import Path
import shutil
import urllib.parse
import urllib.request
import zipfile

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

ROOT = Path(__file__).resolve().parents[1]
REPO = "jiangjiang419/voxcpm-studio-updates"
PREFIX = "lipsync/20261018-v1"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def url(repo, filename):
    return f"https://modelscope.cn/api/v1/models/{repo}/repo?" + urllib.parse.urlencode({"Revision": "master", "FilePath": filename})


def main(args):
    output = ROOT / "builds/lipsync-assets"
    output.mkdir(parents=True, exist_ok=True)
    pending = deque("diffusers transformers accelerate opencv-python decord omegaconf kornia einops librosa imageio imageio-ffmpeg ffmpeg-python insightface onnxruntime onnx soundfile scipy ftfy".split())
    selected = {}
    while pending:
        name = canonicalize_name(pending.popleft())
        if name in selected or name in {"torch", "torchvision"}:
            continue
        try:
            distribution = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            if name == "opencv-python":
                distribution = metadata.distribution("opencv-contrib-python")
            else:
                raise
        selected[name] = distribution
        for item in distribution.requires or []:
            requirement = Requirement(item)
            if requirement.marker is None or requirement.marker.evaluate({"extra": ""}):
                pending.append(requirement.name)
    bundle = output / "video-dependencies-cp312-win_amd64.zip"
    versions = {name: d.version for name, d in selected.items()}
    if bundle.exists():
        with zipfile.ZipFile(bundle) as archive:
            previous = json.loads(archive.read("video-bundle-info.json"))
        if previous != versions:
            bundle.unlink()  # 仅重建本脚本的可再生依赖产物，不覆盖已发布远端资源。
    if not bundle.exists():
        files = {}
        for distribution in selected.values():
            base = Path(distribution.locate_file("")).resolve()
            for item in distribution.files or []:
                file = Path(distribution.locate_file(item)).resolve()
                if not file.is_relative_to(base) or not file.is_file() or file.suffix in {".pyc", ".pyo"} or "__pycache__" in file.parts:
                    continue
                files[file.relative_to(base).as_posix()] = file
        with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED, compresslevel=4) as archive:
            for relative, file in sorted(files.items()):
                archive.write(file, relative)
            archive.writestr("video-bundle-info.json", json.dumps(versions, indent=2))
    assets = {}
    def own(path):
        assets[path.name] = path
        return {"name": path.name, "size": path.stat().st_size, "sha256": digest(path), "urls": [url(REPO, PREFIX + "/" + path.name)]}
    source = output / "latentsync-source.zip"
    revision = "a229c3948406bc2cf6eaf4873e662e70c6a04746"
    if not source.exists():
        urllib.request.urlretrieve(f"https://codeload.github.com/bytedance/LatentSync/zip/{revision}", source)
    config = {"protocol": 1, "revision": PREFIX, "sourceRevision": revision,
              "dependencies": own(bundle), "source": own(source), "torchvision": {}, "common": [], "models": {}}
    probe = output / "ffprobe.exe"
    if args.ffprobe:
        shutil.copy2(args.ffprobe, probe)
    if not probe.exists():
        shutil.copy2(shutil.which("ffprobe"), probe)
    if probe.stat().st_size < 1024 * 1024:
        raise RuntimeError("ffprobe可能是启动器shim，请用 --ffprobe 指定可独立运行的实际二进制文件")
    config["common"].append({**own(probe), "path": "tools/ffprobe.exe"})
    for profile, version in [("cu126", "0.21.0"), ("cu128", "0.22.1")]:
        filename = f"torchvision-{version}+{profile}-cp312-cp312-win_amd64.whl"
        wheel = output / filename
        if not wheel.exists():
            urllib.request.urlretrieve(f"https://download.pytorch.org/whl/{profile}/" + urllib.parse.quote(filename), wheel)
        config["torchvision"][profile] = own(wheel)
    checkpoints = args.model_root / "source/checkpoints"
    for name in ("det_10g.onnx", "2d106det.onnx"):
        file = checkpoints / "auxiliary/models/buffalo_l" / name
        target = output / name
        if not target.exists():
            shutil.copyfile(file, target)
        config["common"].append({**own(target), "path": "source/checkpoints/auxiliary/models/buffalo_l/" + name})
    for filename in ("config.json", "diffusion_pytorch_model.safetensors"):
        file = checkpoints / "vae" / filename
        config["common"].append({"name": "vae-" + filename, "path": "source/checkpoints/vae/" + filename,
                                 "size": file.stat().st_size, "sha256": digest(file),
                                 "urls": [url("stabilityai/sd-vae-ft-mse", filename)]})
    tiny = checkpoints / "whisper/tiny.pt"
    config["common"].append({"name": "tiny.pt", "path": "source/checkpoints/whisper/tiny.pt", "size": tiny.stat().st_size,
                             "sha256": digest(tiny), "urls": [url("bytedance-community/LatentSync-1.5", "whisper/tiny.pt")]})
    for version, relative in [("1.5", "latentsync-1.5/latentsync_unet.pt"), ("1.6", "latentsync_unet.pt")]:
        file = checkpoints / relative
        config["models"][version] = {"name": f"latentsync-{version}.pt", "path": "source/checkpoints/" + relative,
                                     "size": file.stat().st_size, "sha256": digest(file),
                                     "urls": [url("bytedance-community/LatentSync-" + version, "latentsync_unet.pt")]}
    target = ROOT / "backend/voxcpm/lipsync-install.json"
    target.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"config": str(target), "packages": len(selected), "assets": {name: p.stat().st_size for name, p in assets.items()}}, indent=2), flush=True)
    if args.publish:
        from modelscope.hub.api import HubApi
        api = HubApi()
        existing = {f["Path"]: f for f in api.get_model_files(REPO, recursive=True) if f["Type"] == "blob"}
        for name, file in assets.items():
            remote = PREFIX + "/" + name
            if remote in existing:
                if existing[remote].get("Sha256") != digest(file):
                    raise RuntimeError("同名资源校验不匹配，禁止覆盖：" + remote)
            else:
                api.upload_file(path_or_fileobj=str(file), path_in_repo=remote, repo_id=REPO, commit_message="assets: optional lip-sync runtime")
            request = urllib.request.Request(url(REPO, remote), headers={"Range": "bytes=0-31"})
            with urllib.request.urlopen(request, timeout=45) as response:
                assert len(response.read(32)) == 32
            print("匿名资源读取通过：", remote, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--ffprobe", type=Path)
    main(parser.parse_args())
