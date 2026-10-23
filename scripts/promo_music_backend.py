"""只读启动已安装音乐后端以诊断冷启动；输出与诊断均在制作目录。"""
from pathlib import Path
import json
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "builds/promo/music-backend"
OUT.mkdir(parents=True, exist_ok=True)
engine = Path("D:/Program Files/VoxCPMStudio/runtime/music/20261018-v1")
source = engine / "ComfyUI"
python = engine / "python/python.exe"
assert source.is_dir() and python.is_file(), "已安装资源缺失，不下载或修复"
(OUT / "user").mkdir(exist_ok=True)
paths = {"voxcpm_music": {"base_path": "D:/Program Files/VoxCPMStudio/models/music/comfy", "checkpoints": "checkpoints", "diffusion_models": "diffusion_models", "text_encoders": "text_encoders", "vae": "vae"}}
(OUT / "models.yaml").write_text(json.dumps(paths), encoding="utf-8")
runner = "import sys,runpy;root=sys.argv.pop(1);sys.path.insert(0,root);sys.argv[0]=root+'/main.py';runpy.run_path(sys.argv[0],run_name='__main__')"
env = {**os.environ, "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
command = [str(python), "-u", "-c", runner, str(source), "--listen", "127.0.0.1", "--port", "19187", "--disable-auto-launch", "--disable-all-custom-nodes", "--disable-api-nodes", "--preview-method", "none", "--extra-model-paths-config", str(OUT / "models.yaml"), "--output-directory", str(OUT / "output"), "--user-directory", str(OUT / "user"), "--database-url", "sqlite:///" + (OUT / "user/music.db").as_posix()]
command.extend(["--disable-dynamic-vram", "--disable-async-offload", "--disable-pinned-memory"])
child = subprocess.Popen(command, cwd=OUT, env=env, stdout=(OUT / "startup.log").open("w", encoding="utf-8"), stderr=subprocess.STDOUT,
    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
(OUT / "process.json").write_text(json.dumps({"pid": child.pid, "baseUrl": "http://127.0.0.1:19187", "command": command}, ensure_ascii=False, indent=2), encoding="utf-8")
print("已启动本任务的本地后端诊断：", child.pid)
