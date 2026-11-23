"""连接已运行的真实本地服务，验证两角色生成、单段重做和音频导出。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.request
import zipfile

import soundfile as sf


def main(base: str, output: Path, check_lazy_denoiser=False, clone=False):
    def request(route, body=None, method=None):
        payload = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(base + route, data=payload, method=method,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as response:
            return json.load(response)

    def task_finish(task):
        previous = None
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            state = request(f"/api/tasks/{task['taskId']}")
            signature = (state["status"], state.get("completed"), state.get("progressText"))
            if signature != previous:
                print(json.dumps({"status": state["status"], "completed": state.get("completed"),
                                  "total": state.get("total"), "message": state.get("progressText")}, ensure_ascii=False), flush=True)
                previous = signature
            if state["status"] in ("succeeded", "failed", "cancelled"):
                assert state["status"] == "succeeded", state
                assert state["result"]["failedCount"] == 0, state
                return state
            time.sleep(1)
        raise TimeoutError("真实语音生成超过验证时间")

    request("/api/health")
    settings = request("/api/settings")["settings"]
    settings["disable_optimize"] = True
    settings["disable_denoiser"] = True
    if check_lazy_denoiser:
        # 隔离测试数据：明确测试未使用的过期增强路径不应阻塞普通生成。
        settings["disable_denoiser"] = False
        settings["zipenhancer_path"] = str(output.parent / "missing-optional-denoiser")
    settings["output_dir"] = str(output.parent / "generated")
    request("/api/settings", settings, "PUT")
    project = request("/api/workspace/projects", {"name": "双人配音 · 新版工作台验收"})
    route = f"/api/workspace/projects/{project['id']}"
    project = request(route + "/parse", {"text": "{旁白}欢迎来到全新的配音工作台。\n{小林}让每一个角色，都有自己的声音。", "maxChars": 80})
    for role in project["roles"]:
        role["config"].update(inferenceTimesteps=6, control="沉稳自然的男声，清晰的纪录片旁白" if role["name"] == "旁白" else "温暖自然的女声，轻松明亮")
    project = request(route, project, "PUT")
    print("开始真实 CUDA 两角色配音。", flush=True)
    initial = task_finish(request(route + "/generate", {"force": False}))
    project = request(route)
    assert len(project["segments"]) == 2
    assert all(s["status"] == "ready" and not s["stale"] for s in project["segments"])
    before_paths = [s["audioPath"] for s in project["segments"]]
    assert len(set(before_paths)) == 2
    for segment in project["segments"]:
        assert sf.info(segment["audioPath"]).duration > .1
    voice = request("/api/workspace/voices", {"name": "温暖叙述 · 验收音色", "tags": ["女声", "叙述"], "config": project["roles"][-1]["config"]})
    first = project["segments"][0]
    first["text"] = "现在，开始创作属于你的声音。"
    project = request(route, project, "PUT")
    assert project["segments"][0]["stale"] is True
    try:
        request(route + "/export", {})
    except urllib.error.HTTPError as error:
        assert error.code == 400
    else:
        raise AssertionError("过期音频不能被静默导出")
    print("过期保护正常，开始只重做第一段。", flush=True)
    redo = task_finish(request(route + "/generate", {"segmentIds": [first["id"]], "force": True}))
    project = request(route)
    assert project["segments"][0]["audioPath"] != before_paths[0]
    assert project["segments"][1]["audioPath"] == before_paths[1]
    if clone:
        reference = project["segments"][1]
        clone_config = {**project["roles"][-1]["config"], "mode": "极致克隆", "control": "",
                        "referenceAudio": reference["audioPath"], "promptText": reference["text"]}
        clone_voice = request("/api/workspace/voices", {"name": "小林 · 本地克隆", "tags": ["参考克隆"], "config": clone_config})
        project["roles"][-1]["config"] = clone_voice["config"]
        project = request(route, project, "PUT")
        print("开始使用自生成参考音频验证真实极致克隆。", flush=True)
        task_finish(request(route + "/generate", {"segmentIds": [reference["id"]], "force": True}))
        project = request(route)
    result = request(route + "/export", {})
    info = sf.info(result["outputPath"])
    expected = sum(s["duration"] for s in project["segments"]) + project["segments"][0]["pauseAfterMs"] / 1000
    assert abs(info.duration - expected) < .005
    assert info.channels == 2
    with zipfile.ZipFile(result["archivePath"]) as archive:
        names = archive.namelist()
        assert "full.wav" in names and "subtitles.srt" in names and "manifest.json" in names
        assert len([n for n in names if n.startswith("segments/")]) == 2
        assert len([n for n in names if n.startswith("roles/")]) == 2
    srt = Path(result["srtPath"]).read_text("utf-8-sig")
    assert "现在，开始创作属于你的声音。" in srt and srt.count("-->") == 2
    history = request("/api/workspace/history")["items"]
    assert any(h["kind"] == "export" and h["projectId"] == project["id"] for h in history)
    report = {"status": "passed", "projectId": project["id"], "voiceId": voice["id"], "baseUrl": base,
              "lazyDenoiserVerified": check_lazy_denoiser, "realVoiceCloneVerified": clone,
              "initialTaskId": initial["taskId"], "redoTaskId": redo["taskId"], "duration": info.duration,
              "sampleRate": info.samplerate, "channels": info.channels,
              "outputPath": result["outputPath"], "srtPath": result["srtPath"], "archivePath": result["archivePath"],
              "outputSha256": hashlib.sha256(Path(result["outputPath"]).read_bytes()).hexdigest(), "archiveMembers": names}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8897")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "builds/production-validation/real-inference.json")
    parser.add_argument("--check-lazy-denoiser", action="store_true")
    parser.add_argument("--clone", action="store_true")
    args = parser.parse_args()
    main(args.base_url.rstrip("/"), args.output, args.check_lazy_denoiser, args.clone)
