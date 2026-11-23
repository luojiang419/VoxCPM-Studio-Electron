"""在已启动的实际 Electron 上执行三模式真实推理与独立客户端合约验收。"""
import hashlib
import io
import json
import sys
import time
import wave
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "examples"))
from voice_api_client import VoiceClient

OUTPUT = ROOT / "builds/public-api-acceptance"
SESSION = json.loads((OUTPUT / "electron-report.json").read_text(encoding="utf-8"))


def local(path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    with urlopen(Request(SESSION["backendBaseUrl"] + path, data=data, headers={"Content-Type": "application/json"}), timeout=30) as response:
        return json.load(response)


def key(name):
    existing = next((k for k in local("/api/access/keys")["keys"] if k["name"] == name), None)
    if existing:
        return local(f"/api/access/keys/{existing['id']}/secret")["api_key"], existing["id"]
    created = local("/api/access/keys", {"name": name})
    return created["api_key"], created["id"]


def main():
    secret, owner = key("独立客户端真实验收")
    client = VoiceClient(SESSION["publicBaseUrl"], secret)
    text = "别害怕，孩子。先喝一口热茶，等天亮以后，我们一起去看那棵老树。"
    report = {"source": "实际 Electron 主进程启动的后端", "results": [], "checks": []}
    design = {"input": text, "instructions": "年长女性，温暖自然的中低音，普通话，语气平和。", "mode": "design"}
    started = time.monotonic()
    result = client.generate(design, OUTPUT / "design.wav", "actual-electron-design-v1")
    report["results"].append({**result, "mode": "design", "text": text})
    # 同一次验收现场生成的参考音与其输入文案配对，不猜测旧文件的转录。
    receipt = OUTPUT / "reference-receipt.json"
    reference = json.loads(receipt.read_text()) if receipt.exists() else client.upload(OUTPUT / "design.wav")
    receipt.write_text(json.dumps(reference), encoding="utf-8")
    for mode, sync in [("clone", True), ("clone_prompt", False)]:
        payload = {"input": "雨已经停了，我们一起出去看看吧。", "mode": mode, "reference_id": reference["id"]}
        payload.update({"prompt_text": text} if mode == "clone_prompt" else {"instructions": "语气轻松，带一点微笑。"})
        print(f"正在调用 {mode}（相同请求标识会复用已有结果）", flush=True)
        result = client.generate(payload, OUTPUT / f"{mode}.wav", f"actual-electron-{mode}-v1", sync=sync)
        report["results"].append({**result, "mode": mode})
    for entry in report["results"]:
        raw = Path(entry["output"]).read_bytes()
        with wave.open(io.BytesIO(raw)) as audio:
            frames = audio.readframes(audio.getnframes())
            entry.update(sample_rate=audio.getframerate(), channels=audio.getnchannels(), duration=audio.getnframes()/audio.getframerate(), sha256=hashlib.sha256(raw).hexdigest())
            assert entry["duration"] > 1 and any(frames)
    replay = client.request("/audio/generations", json.dumps(design).encode(), request_key="actual-electron-design-v1")
    assert replay["id"] == report["results"][0]["id"]
    other_key, _ = key("隔离边界验收")
    other = VoiceClient(client.base, other_key)
    for path, payload, expected in [
        ("/audio/generations/" + replay["id"], None, 404),
        ("/audio/generations/" + replay["id"] + "/content", None, 404),
        ("/audio/generations", {"input": "你好", "mode": "clone", "reference_id": reference["id"]}, 404),
    ]:
        try:
            other.request(path, None if payload is None else json.dumps(payload).encode())
            raise AssertionError("跨 Key 隔离失败")
        except RuntimeError as error:
            assert f"HTTP {expected}" in str(error)
    try:
        client.request("/audio/generations", json.dumps({**design, "input": "不同文案"}).encode(), request_key="actual-electron-design-v1")
        raise AssertionError("重复请求冲突未拒绝")
    except RuntimeError as error:
        assert "HTTP 409" in str(error)
    stats = next(k for k in local("/api/access/keys")["keys"] if k["id"] == owner)
    assert stats["calls"] == 3, stats
    report.update(seconds=round(time.monotonic()-started, 2), checks=["三种模式真实非静音WAV", "同步WAV、异步查询和下载", "跨Key任务/下载/参考音404", "重复请求复用与参数冲突409", "仅三次生成计入统计"], stats={k:stats[k] for k in ["calls", "calls_today", "last_used_at"]})
    (OUTPUT / "real-generation-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
