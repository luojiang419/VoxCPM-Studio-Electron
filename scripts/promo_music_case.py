"""使用本项目支持的手工双语提示词接口生成案例，不伪造 AI 助手配置。"""
from pathlib import Path
import json
import time
import urllib.request
import sys

OUT = Path(__file__).resolve().parents[1] / "builds/promo"
stem = sys.argv[1] if len(sys.argv) > 1 else "music-case-r5"
assert stem in {"music-case-r2", "music-case-r3", "music-case-r4", "music-case-r5"}
status_path = OUT / f"{stem}-status.json"
if status_path.exists():
    previous = json.loads(status_path.read_text(encoding="utf-8"))
    if previous.get("status") == "succeeded" and Path(previous["result"]["outputPath"]).is_file():
        print("已复用成功音乐案例，不重复生成。", flush=True)
        raise SystemExit(0)
base = json.loads((OUT.parents[2] / "data/cache/electron_backend_state.json").read_text(encoding="utf-8"))["serviceUrl"]

def request(route, payload=None):
    req = urllib.request.Request(base + route, data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as response:
        return json.load(response)

path = OUT / f"{stem}-task.json"
if path.exists():
    task = json.loads(path.read_text(encoding="utf-8"))
else:
    payload = {"brief": {"modelId": "ace-xl-turbo", "title": "一起开场", "instrumental": True,
        "duration": 30, "bpm": 120, "language": "unknown", "seed": 1247}, "autoOptimize": False,
        "draft": {"title": "一起开场", "caption": "Bright uplifting electronic instrumental. Crisp electronic drums, warm synth plucks and bouncy bass. Simple catchy melody, clean spacious arrangement, tight transitions and a confident upbeat ending. Instrumental only.",
        "captionZh": "明亮轻快的电子背景音乐，清晰电子鼓点、温暖合成器与弹跳贝斯，旋律简洁，编排通透，小节转折利落，纯器乐。", "lyrics": "", "metadata": {"bpm": 120, "language": "unknown"}}}
    (OUT / f"{stem}-request.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    task = request("/api/music/generate", payload)
    path.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
    print("已提交本地音乐案例", task["taskId"], flush=True)
while task["status"] not in {"succeeded", "failed", "cancelled"}:
    time.sleep(5)
    task = request("/api/tasks/" + task["taskId"])
    (OUT / f"{stem}-status.json").write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
if task["status"] != "succeeded":
    raise RuntimeError(task.get("error") or task.get("statusText"))
print("音乐案例成功", flush=True)
