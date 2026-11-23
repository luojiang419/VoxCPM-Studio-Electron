"""为本地视频建立独立环境并下载固定版本的官方权重。

使用常规 Windows Python 3.10～3.12：
python scripts/setup_lipsync.py --root <data/lipsync>
--reuse-installed-torch 仅适用于本机已有 CUDA PyTorch 的开发环境。
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import venv
import zipfile

script_root = Path(__file__).resolve().parents[1]
profile_source = script_root / "backend/voxcpm"
if not profile_source.is_dir():
    profile_source = script_root / "src/voxcpm"
sys.path.insert(0, str(profile_source))
from lipsync_profiles import PROFILES, detect_hardware, load_manifest, select_profile

SOURCE_REVISION = "a229c3948406bc2cf6eaf4873e662e70c6a04746"
VAE_REVISION = "31f26fdeee1355a5c34592e401dd41e45d25a493"


def command(args):
    subprocess.run([str(arg) for arg in args], check=True)


def check_tools(root):
    for name in ("ffmpeg", "ffprobe"):
        local = root / "tools" / (name + ".exe")
        if not local.is_file() and not shutil.which(name):
            raise RuntimeError(f"缺少 {name}。请将 FFmpeg 工具加入 PATH，或把 {name}.exe 放入 {root / 'tools'} 后重试。")


def download(root, model_version="auto"):
    from huggingface_hub import hf_hub_download
    hardware = detect_hardware()
    selected, reason = select_profile(hardware, list(PROFILES), "auto" if model_version == "both" else model_version)
    if not selected:
        raise RuntimeError(reason)
    versions = list(PROFILES) if model_version == "both" else [selected]
    print(f"检测到 {hardware['name']}，显存 {hardware['totalMB'] / 1024:.1f} GB。{reason}", flush=True)
    source = root / "source"
    if not source.is_dir():
        print("下载固定版本 LatentSync 官方源码…", flush=True)
        with tempfile.TemporaryDirectory(prefix="voxcpm-lipsync-") as temporary:
            archive = Path(temporary) / "source.zip"
            urllib.request.urlretrieve(f"https://codeload.github.com/bytedance/LatentSync/zip/{SOURCE_REVISION}", archive)
            with zipfile.ZipFile(archive) as bundle:
                bundle.extractall(temporary)
            shutil.copytree(Path(temporary) / f"LatentSync-{SOURCE_REVISION}", source)
    checkpoint = source / "checkpoints"
    jobs = [(f"ByteDance/LatentSync-{v}", PROFILES[v]["revision"], "latentsync_unet.pt",
             (source / PROFILES[v]["checkpoint"]).parent) for v in versions]
    jobs += [("ByteDance/LatentSync-1.5", PROFILES["1.5"]["revision"], "whisper/tiny.pt", checkpoint),
            ("stabilityai/sd-vae-ft-mse", VAE_REVISION, "config.json", checkpoint / "vae"),
            ("stabilityai/sd-vae-ft-mse", VAE_REVISION, "diffusion_pytorch_model.safetensors", checkpoint / "vae")]
    def fetch(job):
        repo, revision, filename, directory = job
        return hf_hub_download(repo, filename, revision=revision, local_dir=directory)
    with ThreadPoolExecutor(max_workers=4) as pool:
        for path in pool.map(fetch, jobs):
            print("权重就绪：", path, flush=True)
    from insightface.app import FaceAnalysis
    detector = FaceAnalysis(name="buffalo_l", allowed_modules=["detection", "landmark_2d_106"],
                            root=str(checkpoint / "auxiliary"), providers=["CPUExecutionProvider"])
    detector.prepare(ctx_id=-1, det_size=(512, 512))
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("当前专用环境无法使用 CUDA。请检查驱动及 PyTorch。")
    sys.path.insert(0, str(source))
    from latentsync.pipelines.lipsync_pipeline import LipsyncPipeline  # noqa: F401
    # 新增另一版本时保留现有默认清单，避免破坏已安装版本及其实测记录。
    for version in versions:
        profile = PROFILES[version]
        previous = load_manifest(root, version)
        manifest = {"engine": "LatentSync", "version": version, "resolution": profile["resolution"],
                    "config": profile["config"], "checkpoint": profile["checkpoint"],
                    "sourceRevision": SOURCE_REVISION, "modelRevision": profile["revision"], "vaeRevision": VAE_REVISION,
                    "python": sys.version, "torch": torch.__version__, "gpu": torch.cuda.get_device_name(0),
                    "validation": previous.get("validation")}
        manifest_path = root / f"runtime-{version}.json"
        temporary = manifest_path.with_suffix(".pending.json")
        temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(manifest_path)
        if not (root / "runtime.json").exists():
            shutil.copy2(manifest_path, root / "runtime.json")
    print("安装检查通过。可在视频对口型页面选择此目录：", root, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--model-version", choices=["auto", "1.5", "1.6", "both"], default="auto",
                        help="默认按硬件安装；both 同时安装两套权重以便手动切换")
    parser.add_argument("--reuse-installed-torch", action="store_true")
    parser.add_argument("--download-only", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    check_tools(root)
    if args.download_only:
        download(root, args.model_version)
    else:
        if sys.platform != "win32" or not (3, 10) <= sys.version_info[:2] <= (3, 12):
            raise SystemExit("请使用 Windows Python 3.10～3.12 运行此安装入口。")
        python = root / "env/Scripts/python.exe"
        if not python.is_file():
            venv.EnvBuilder(with_pip=True, system_site_packages=args.reuse_installed_torch).create(root / "env")
        if not args.reuse_installed_torch:
            command([python, "-m", "pip", "install", "torch==2.6.0", "torchvision==0.21.0", "--index-url", "https://download.pytorch.org/whl/cu126"])
        command([python, "-m", "pip", "install", "-r", Path(__file__).with_name("requirements-lipsync.txt")])
        command([python, __file__, "--root", root, "--download-only", "--model-version", args.model_version])
