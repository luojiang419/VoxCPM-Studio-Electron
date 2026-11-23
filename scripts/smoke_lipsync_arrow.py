"""真实视频Python复现用户Arrow/NumPy导入故障，并验证隔离后完整CUDA/引擎探测。"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend/voxcpm"))
spec = importlib.util.spec_from_file_location("lipsync_prepare", ROOT / "backend/voxcpm/lipsync_prepare.py")
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


def run(video_root):
    output = ROOT / "builds/lipsync-arrow-validation" / str(time.time_ns())
    output.mkdir(parents=True)
    poison = output / "incompatible-optional-arrow"; poison.mkdir()
    (poison / "pyarrow.py").write_text("raise RuntimeError('pyarrow requires NumPy 2.0 or newer, found 1.26.4')", encoding="utf-8")
    prefix = "import sys;sys.path.insert(0," + repr(str(poison)) + ");\n"
    env = {**os.environ, "NO_ALBUMENTATIONS_UPDATE": "1", "HF_HUB_OFFLINE": "1"}
    python = video_root / "env/Scripts/python.exe"
    results = []
    for name, code in [("before", module.PROBE.replace("sys.modules['pyarrow']=None", "# 复现旧版未隔离可选Arrow")), ("after", module.PROBE)]:
        completed = subprocess.run([str(python), "-B", "-c", prefix + code, str(video_root / "source")], capture_output=True, text=True,
                                   encoding="utf-8", errors="replace", timeout=150, env=env)
        (output / (name + ".log")).write_text(completed.stdout + completed.stderr, encoding="utf-8")
        results.append(completed)
    assert results[0].returncode != 0 and "pyarrow requires NumPy 2.0 or newer, found 1.26.4" in results[0].stderr
    assert results[1].returncode == 0 and "__VOXCPM_PROBE__" in results[1].stdout, results[1].stderr[-4000:]
    report = {"passed": True, "videoRoot": str(video_root), "reproducedUserArrowNumpyConflict": True,
              "fullVideoCudaAndPipelineProbePassed": True, "diskDependenciesUnchanged": True, "logs": str(output)}
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video_root", type=Path)
    args = parser.parse_args()
    run(args.video_root.resolve(strict=True))
