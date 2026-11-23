"""本任务音乐后端：只读复用安装版，输出和数据库写制作目录。"""
from common import OUT, ROOT, request, save
import json
import os
from pathlib import Path
import subprocess
import urllib.request
import time

folder=OUT/"music-backend"
folder.mkdir(exist_ok=True)
(folder/"user").mkdir(exist_ok=True)
engine=Path("D:/Program Files/VoxCPMStudio/runtime/music/20261018-v1")
assert (engine/"python/python.exe").is_file()
config={"voxcpm_music":{"base_path":"D:/Program Files/VoxCPMStudio/models/music/comfy","checkpoints":"checkpoints","diffusion_models":"diffusion_models","text_encoders":"text_encoders","vae":"vae"}}
(folder/"models.yaml").write_text(json.dumps(config),encoding="utf-8")
runner="import sys,runpy;root=sys.argv.pop(1);sys.path.insert(0,root);sys.argv[0]=root+'/main.py';runpy.run_path(sys.argv[0],run_name='__main__')"
cmd=[str(engine/"python/python.exe"),"-u","-c",runner,str(engine/"ComfyUI"),"--listen","127.0.0.1","--port","19187","--disable-auto-launch","--disable-all-custom-nodes","--disable-api-nodes","--preview-method","none","--extra-model-paths-config",str(folder/"models.yaml"),"--output-directory",str(folder/"output"),"--user-directory",str(folder/"user"),"--database-url","sqlite:///"+(folder/"user/music.db").as_posix(),"--disable-dynamic-vram","--disable-async-offload","--disable-pinned-memory"]
try:
    urllib.request.urlopen("http://127.0.0.1:19187/system_stats",timeout=3)
    raise RuntimeError("19187端口已占用，先核对任务后台，不启动第二份")
except OSError:pass
child=subprocess.Popen(cmd,cwd=folder,env={**os.environ,"PYTHONUTF8":"1","PYTHONDONTWRITEBYTECODE":"1","HF_HUB_OFFLINE":"1","TRANSFORMERS_OFFLINE":"1"},stdout=(folder/"startup.log").open("w",encoding="utf-8"),stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
save("music-backend/process.json",{"pid":child.pid,"command":cmd})
for _ in range(60):
    if child.poll() is not None:raise RuntimeError("音乐后台退出，检查startup.log")
    try:
        urllib.request.urlopen("http://127.0.0.1:19187/system_stats",timeout=2)
        break
    except OSError:time.sleep(1)
else:raise RuntimeError("音乐后台尚未就绪")
settings_path=ROOT.parent/"data/music-settings.json"
settings=json.loads(settings_path.read_text(encoding="utf-8")) if settings_path.exists() else {"comfyUrl":""}
save("music-settings-original.json",settings)
result=request("/api/music/settings",{"comfyUrl":"http://127.0.0.1:19187"},method="PUT")
print("音乐兼容后端已就绪",child.pid,flush=True)
