"""唐宫教程制作的可恢复任务；仅调用当前项目已启动的本地服务。"""
from pathlib import Path
import json
import shutil
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "builds/promo-tang"
OUT.mkdir(parents=True, exist_ok=True)
PLAN = json.loads((Path(__file__).parent / "plan.json").read_text(encoding="utf-8"))

def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")

def request(route, data=None, method=None):
    state = json.loads((ROOT.parent / "data/cache/electron_backend_state.json").read_text(encoding="utf-8"))
    req = urllib.request.Request(state["serviceUrl"] + route,
        data=json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else None,
        headers={"Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)

def generate(name, text, control, reference="", prompt="", mode="声音设计"):
    task_path = OUT / (name + "-task.json")
    if task_path.exists():
        task = json.loads(task_path.read_text(encoding="utf-8"))
    else:
        payload = {"mode": mode, "text": text, "control": control,
            "referenceAudio": reference, "promptText": prompt, "cfgValue": 2,
            "normalize": False, "denoise": False, "inferenceTimesteps": 10}
        save(name + "-request.json", payload)
        task = request("/api/tasks/generate-single", payload)
        save(name + "-task.json", task)
        print(name, "已整段提交", task["taskId"], len(text), flush=True)
    while True:
        task = request("/api/tasks/" + task["taskId"])
        save(name + "-status.json", task)
        if task["status"] in {"succeeded", "failed"}:
            break
        time.sleep(4)
    if task["status"] != "succeeded":
        raise RuntimeError(task.get("error") or task.get("statusText"))
    dest = OUT / (name + ".wav")
    if not dest.exists():
        shutil.copy2(task["result"]["output_path"], dest)
    print(name, "完成", str(dest), flush=True)
    return dest

if __name__ == "__main__":
    generate("tutorial-narration", "\n".join(c["text"] for c in PLAN["chapters"]), PLAN["narratorControl"])
    for key in ["musician", "general", "story_narrator"]:
        role = PLAN["roles"][key]
        generate(key + "-reference", role.get("referenceText") or role.get("designText") or role["text"], role["control"])
