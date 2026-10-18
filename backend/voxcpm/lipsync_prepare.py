"""可取消的独立视频补齐进程；仅使用标准库，不修改语音运行环境。"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile

try:
    from .lipsync_profiles import PROFILES, load_manifest
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from lipsync_profiles import PROFILES, load_manifest

CONFIG = Path(__file__).with_name("lipsync-install.json")


def emit(progress, text, **extra):
    print("__VOXCPM_LIPSYNC__" + json.dumps({"progress": progress, "text": text, **extra}, ensure_ascii=False), flush=True)


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(asset, target, progress=lambda *args: None, allow_http=False):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and target.stat().st_size == asset["size"] and sha256(target) == asset["sha256"]:
        progress(asset["size"], asset["size"])
        return target
    partial = target.with_name(target.name + ".part")
    errors = []
    for url in asset["urls"]:
        if not url.startswith("https://") and not (allow_http and url.startswith("http://127.0.0.1:")):
            raise ValueError("补齐资源必须使用HTTPS")
        for _ in range(2):
            try:
                offset = partial.stat().st_size if partial.exists() else 0
                if offset >= asset["size"]:
                    if offset == asset["size"] and sha256(partial) == asset["sha256"]:
                        partial.replace(target)
                        return target
                    partial.unlink()
                    offset = 0
                request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-", "User-Agent": "VoxCPM-LipSync/1"})
                with urllib.request.urlopen(request, timeout=30) as response:
                    ranged = response.status == 206
                    if ranged:
                        prefix = f"bytes {offset}-"
                        if not response.headers.get("Content-Range", "").startswith(prefix):
                            raise RuntimeError("服务器断点范围不匹配")
                    else:
                        offset = 0
                    with partial.open("ab" if ranged and offset else "wb") as stream:
                        done, last = offset, 0
                        while block := response.read(1024 * 1024):
                            done += len(block)
                            if done > asset["size"]:
                                raise RuntimeError("资源长度超过清单")
                            stream.write(block)
                            if time.monotonic() - last > .4:
                                progress(done, asset["size"])
                                last = time.monotonic()
                if partial.stat().st_size != asset["size"]:
                    raise RuntimeError("下载未完成，保留断点供下次继续")
                if sha256(partial) != asset["sha256"]:
                    partial.unlink()
                    raise RuntimeError("资源SHA256校验失败")
                partial.replace(target)
                progress(asset["size"], asset["size"])
                return target
            except (OSError, ValueError, RuntimeError, urllib.error.URLError, http.client.IncompleteRead) as exc:
                errors.append(str(exc))
    raise RuntimeError(f"补齐 {asset['name']} 失败，可稍后重试：" + "；".join(errors[-2:]))


def extract(archive, target):
    target = Path(target).resolve()
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        for item in bundle.infolist():
            relative = item.filename.replace("\\", "/")
            path = (target / relative).resolve()
            if not path.is_relative_to(target) or ":" in relative or ((item.external_attr >> 16) & 0o170000) == 0o120000:
                raise ValueError("资源压缩包包含不安全路径")
        bundle.extractall(target)


@contextmanager
def exclusive(root):
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".prepare.lock").open("a+b") as lock:
        lock.seek(0)
        lock.write(b"0")
        lock.flush()
        lock.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError("另一窗口正在补齐视频组件，请等待完成后重试。") from exc
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == "nt":
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def clone_python(base_python, root):
    base = Path(base_python).resolve().parent
    scripts = root / "env/Scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    for file in base.iterdir():
        if file.is_file() and (file.suffix in {".dll", ".pyd"} or (file.name.startswith("python") and file.suffix in {".exe", ".zip"})):
            shutil.copy2(file, scripts / file.name)
    (root / "env/Lib/video-packages").mkdir(parents=True, exist_ok=True)
    paths = ["python312.zip", ".", "../Lib/video-packages", str(base), str(base / "Lib"), str(base / "Lib/site-packages"), "import site", ""]
    (scripts / "python312._pth").write_text("\n".join(paths), encoding="utf-8")
    return scripts / "python.exe"


PROBE = r'''
import sys,json,locale
from pathlib import Path
if sys.platform=='win32': locale.setlocale(locale.LC_CTYPE,'.UTF8')
import torch,torchvision,cv2,onnxruntime,numpy,diffusers,transformers,kornia
assert torch.cuda.is_available(),'CUDA不可用，请检查驱动和运行控制中的运行时'
x=torch.ones((8,8),device='cuda'); assert (x@x)[0,0].item()==8
assert torchvision.ops.nms(torch.tensor([[0.,0.,1.,1.]],device='cuda'),torch.ones(1,device='cuda'),.5).numel()==1
source=Path(sys.argv[1]);sys.path.insert(0,str(source))
from latentsync.pipelines.lipsync_pipeline import LipsyncPipeline
from insightface.app import FaceAnalysis
detector=FaceAnalysis(name='buffalo_l',allowed_modules=['detection','landmark_2d_106'],root=str(source/'checkpoints/auxiliary'),providers=['CPUExecutionProvider'])
detector.prepare(ctx_id=-1,det_size=(512,512))
assert 'landmark_2d_106' in detector.models,'人脸定位模型缺失'
files=[sys.executable]
for module in [torch,torchvision,cv2,onnxruntime,numpy,diffusers,transformers,kornia]:
 files.append(module.__file__)
 for pattern in ['*.pyd','*.dll']:
  for p in Path(module.__file__).parent.rglob(pattern): files.append(str(p))
print('__VOXCPM_PROBE__'+json.dumps({'torch':torch.__version__,'files':files}))
'''


def fingerprint(config, base_python):
    path = Path(base_python).resolve()
    return {"config": hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest(),
            "basePython": str(path), "baseSize": path.stat().st_size, "baseTime": path.stat().st_mtime_ns}


def stamps(paths):
    return [{"path": str(path), "size": Path(path).stat().st_size, "time": Path(path).stat().st_mtime_ns} for path in dict.fromkeys(map(str, paths))]


def cached_ready(root, version, config, base_python):
    try:
        ready = json.loads((root / f"ready-{version}.json").read_text(encoding="utf-8"))
        return ready["fingerprint"] == fingerprint(config, base_python) and ready["files"] == stamps([f["path"] for f in ready["files"]])
    except (OSError, ValueError, KeyError, TypeError):
        return False


def prepare(root, version, base_python, config):
    if sys.platform != "win32" or sys.version_info[:2] != (3, 12) or sys.maxsize < 2 ** 32:
        raise RuntimeError("视频自动补齐需要程序自带的 Windows x64 Python 3.12 运行时。")
    with exclusive(root):
        if cached_ready(root, version, config, base_python):
            emit(100, "视频组件已就绪，复用本地资源")
            return
        cache = root / "downloads"
        cache.mkdir(exist_ok=True)
        profile = PROFILES[version]
        legacy_ready = bool(load_manifest(root, version)) and (root / "env/Scripts/python.exe").is_file()
        required = [*config["common"], config["models"][version]]
        needed = 0
        for asset in required:
            target = root / asset["path"]
            if not target.is_file() or target.stat().st_size != asset["size"]:
                partial = target.with_name(target.name + ".part")
                completed = min(partial.stat().st_size, asset["size"]) if partial.is_file() else 0
                needed += asset["size"] - completed
        if not legacy_ready:
            needed += config["dependencies"]["size"] + 2 * 1024 ** 3
        if shutil.disk_usage(root).free < needed + 1024 ** 3:
            raise RuntimeError(f"视频组件所在磁盘空间不足，建议至少保留 {(needed + 1024**3)/1024**3:.1f} GiB 可用空间。")
        def fetch(asset, target, start=10, end=85):
            emit(start, "检查本地组件：" + asset["name"])
            return download(asset, target, lambda done, size: emit(start + int((end-start)*done/max(size,1)),
                            f"补齐 {asset['name']} · {done/1024**2:.1f}/{size/1024**2:.1f} MB", downloaded=done, size=size))
        source_files = [profile["config"], "latentsync/pipelines/lipsync_pipeline.py", "latentsync/models/unet.py", "latentsync/utils/mask.png"]
        # 首次补齐/缓存失效时恢复固定源码，不能仅因某个配置存在就信任损坏或不同版本的引擎。
        emit(5, "检查固定版本视频引擎")
        archive = fetch(config["source"], cache / config["source"]["name"], 5, 10)
        stage = root / ".source-extracting"
        extract(archive, stage)
        shutil.copytree(stage / ("LatentSync-" + config["sourceRevision"]), root / "source", dirs_exist_ok=True)
        shutil.rmtree(stage)
        for index, asset in enumerate(required):
            start = 10 + int(70 * index / len(required))
            fetch(asset, root / asset["path"], start, 10 + int(70 * (index+1) / len(required)))
        python = root / "env/Scripts/python.exe"
        def install_dependencies():
            nonlocal python
            emit(81, "建立独立视频运行环境")
            python = clone_python(base_python, root)
            # 主运行时已按显卡架构补齐CUDA；视频环境只增加相匹配的torchvision。
            result = subprocess.run([str(base_python), "-c", "import torch,json;print(json.dumps({'version':torch.__version__,'cuda':torch.version.cuda}))"],
                                    capture_output=True, text=True, encoding="utf-8", errors="replace", check=True,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), timeout=45)
            base = json.loads(result.stdout.strip().splitlines()[-1])
            cu = "cu128" if base["version"].startswith("2.7.1") and base["cuda"] == "12.8" else "cu126" if base["version"].startswith("2.6.0") and base["cuda"] == "12.6" else ""
            if not cu:
                raise RuntimeError("主运行时版本不匹配，请先在运行控制中补齐受支持的CUDA运行时。")
            archive = fetch(config["dependencies"], cache / config["dependencies"]["name"], 81, 89)
            emit(90, "解压视频依赖，无需安装编译工具")
            extract(archive, root / "env/Lib/video-packages")
            wheel = fetch(config["torchvision"][cu], cache / config["torchvision"][cu]["name"], 90, 93)
            extract(wheel, root / "env/Lib/video-packages")
        if not legacy_ready:
            install_dependencies()
        tools = root / "tools"
        tools.mkdir(exist_ok=True)
        if not (tools / "ffmpeg.exe").is_file():
            subprocess.run([str(python), "-c", "import imageio_ffmpeg,shutil,sys;shutil.copy2(imageio_ffmpeg.get_ffmpeg_exe(),sys.argv[1])", str(tools / "ffmpeg.exe")],
                           check=True, timeout=30, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        emit(94, "验证CUDA、视频依赖和人脸模型")
        result = subprocess.run([str(python), "-c", PROBE, str(root / "source")], capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=120,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        print(result.stdout, flush=True)
        if result.returncode and legacy_ready:
            emit(80, "已有视频环境验证失败，修复独立依赖")
            install_dependencies()
            result = subprocess.run([str(python), "-c", PROBE, str(root / "source")], capture_output=True, text=True,
                                    encoding="utf-8", errors="replace", timeout=120,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            print(result.stdout, flush=True)
        if result.returncode:
            raise RuntimeError("视频组件验证失败，可重试修复：" + result.stderr[-2500:])
        probe = json.loads(next(line[len("__VOXCPM_PROBE__"):] for line in result.stdout.splitlines() if line.startswith("__VOXCPM_PROBE__")))
        manifest = {"engine": "LatentSync", "version": version, "resolution": profile["resolution"], "config": profile["config"],
                    "checkpoint": profile["checkpoint"], "sourceRevision": config["sourceRevision"], "modelRevision": profile["revision"],
                    "torch": probe["torch"], "validation": load_manifest(root, version).get("validation")}
        manifest_path = root / f"runtime-{version}.json"
        pending = manifest_path.with_suffix(".pending.json")
        pending.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        pending.replace(manifest_path)
        if not (root / "runtime.json").exists():
            shutil.copy2(manifest_path, root / "runtime.json")
        for tool in ("ffmpeg", "ffprobe"):
            subprocess.run([str(tools / (tool + ".exe")), "-version"], check=True, capture_output=True, timeout=20,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        files = [*(root / a["path"] for a in required), tools / "ffmpeg.exe", *(root / "source" / name for name in source_files), manifest_path, *probe["files"]]
        pth = python.with_name("python312._pth")
        if pth.exists():
            files.append(pth)
        record = {"fingerprint": fingerprint(config, base_python), "files": stamps(files)}
        marker = root / f"ready-{version}.json"
        pending = marker.with_suffix(".pending.json")
        pending.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        pending.replace(marker)
        emit(100, f"LatentSync {version} 已就绪")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--version", choices=list(PROFILES), required=True)
    parser.add_argument("--base-python", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.root.resolve(), args.version, args.base_python, json.loads(CONFIG.read_text(encoding="utf-8")))
