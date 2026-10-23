"""整段旁白一次提交本项目声音设计；保存任务号后可恢复轮询，不重复生成。"""
from pathlib import Path
import json
import shutil
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "builds/promo"
OUT.mkdir(parents=True, exist_ok=True)
state = json.loads((ROOT.parent / "data/cache/electron_backend_state.json").read_text(encoding="utf-8"))
base = state["serviceUrl"]

def request(route, data=None):
    req = urllib.request.Request(base + route,
        data=json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else None,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)

def save(name, data):
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

task_file = OUT / "narration-task.json"
if task_file.exists():
    task = json.loads(task_file.read_text(encoding="utf-8"))
else:
    text = (ROOT / "scripts/promo_narration.txt").read_text(encoding="utf-8").strip()
    payload = {
        "mode": "声音设计", "text": text,
        "control": "中国青年男性，阳光爽朗，清亮有磁性的中音，标准普通话，专业游戏讲解风格，吐字清晰，语速中快，节奏利落，重点词自然重读，富有感染力但不喊叫。",
        "referenceAudio": "", "promptText": "", "cfgValue": 2.0,
        "normalize": False, "denoise": False, "inferenceTimesteps": 10,
    }
    save("narration-request.json", payload)
    task = request("/api/tasks/generate-single", payload)
    save("narration-task.json", task)
    print("已整段提交声音设计：", task["taskId"], "字数", len(text), flush=True)

while True:
    task = request("/api/tasks/" + task["taskId"])
    save("narration-status.json", task)
    if task["status"] in {"succeeded", "failed"}:
        break
    time.sleep(5)
if task["status"] != "succeeded":
    raise RuntimeError(task.get("error") or task.get("statusText"))
source = Path(task["result"]["output_path"])
shutil.copy2(source, OUT / "原创青年男声-整段旁白.wav")
print("整段旁白生成完成：", source, flush=True)
