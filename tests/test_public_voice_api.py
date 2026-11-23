"""公共边界、密钥生命周期、任务归属及真实 WAV 合约。"""
import io
import time
import wave
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from voxcpm.studio_api import create_api_app


def test_queue_rechecks_license_before_execution():
    import threading
    from voxcpm.studio_api import StudioTaskQueue
    from fastapi import HTTPException
    allowed = [True]
    def require():
        if not allowed[0]:
            raise HTTPException(403, '试用已到期')
    q = StudioTaskQueue()
    q.license_guard = SimpleNamespace(require=require)
    entered, release = threading.Event(), threading.Event()
    first = q.submit('blocker', '正在运行的任务', lambda: (entered.set(), release.wait(5), {'ok': True})[-1])
    assert entered.wait(2)
    called = []
    second = q.submit('public-speech', '等待中的语音', lambda: called.append(True) or {'ok': True})
    allowed[0] = False
    release.set()
    for _ in range(100):
        if q.get(second['taskId'])['status'] == 'failed':
            break
        time.sleep(.01)
    assert q.get(first['taskId'])['status'] == 'succeeded'
    assert q.get(second['taskId'])['status'] == 'failed'
    assert not called


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.setenv("VOXCPM_DATA_ROOT", str(tmp_path))
    def generate(**kwargs):
        assert kwargs["text"] == "你好，明天见。"
        assert kwargs["control"] == "温暖的女声"
        output = tmp_path / "speech.wav"
        with wave.open(str(output), "wb") as wav:
            wav.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
            wav.writeframes(b"\x00\x00" * 24000)
        return {"output_path": str(output), "sample_rate": 24000, "mode": kwargs["mode"]}
    studio = SimpleNamespace(runtime_summary_payload=lambda: {"data_root": str(tmp_path)},
                             settings_payload=lambda: {"output_dir": str(tmp_path / "outputs")}, generate_audio_payload=generate)
    app = create_api_app(studio)
    # 保持既有开发者API合约用例聚焦API Key；真实授权门禁单独验收。
    monkeypatch.setattr(app.state.license_guard, "require", lambda: None)
    api = app.state.public_api
    return TestClient(app), TestClient(api.app), api


def test_keys_auth_rotation_revocation_and_plaintext_not_listed(service):
    local, public, api = service
    created = local.post("/api/access/keys", json={"name": "H3"}).json()
    token, key_id = created["api_key"], created["id"]
    headers = {"Authorization": f"Bearer {token}"}
    assert public.get("/v1/models").status_code == 401
    assert public.get("/v1/models", headers=headers).status_code == 200
    assert token not in local.get("/api/access/keys").text
    assert token.encode() not in api.db_path.read_bytes()
    assert local.get(f"/api/access/keys/{key_id}/secret").json()["api_key"] == token
    new = local.post(f"/api/access/keys/{key_id}/rotate").json()["api_key"]
    assert public.get("/v1/models", headers=headers).status_code == 401
    assert public.get("/v1/models", headers={"Authorization": f"Bearer {new}"}).status_code == 200
    assert local.post(f"/api/access/keys/{key_id}/disable").status_code == 200
    assert public.get("/v1/models", headers={"Authorization": f"Bearer {new}"}).status_code == 401


def test_public_surface_has_no_local_files_or_management_and_rejects_cross_site(service):
    local, public, _ = service
    for path in ["/api/access/keys", "/api/settings", "/media?path=C:/Windows/win.ini", "/api/training/status"]:
        assert public.get(path).status_code == 404
    assert local.post("/api/access/keys", json={"name": "evil"}, headers={"Origin": "https://evil.example"}).status_code == 403
    assert local.get("/api/access", headers={"Host": "evil.example"}).status_code == 403
    assert local.get("/api/access", headers={"Origin": "null"}).status_code == 403
    assert local.put("/api/access", json={"enabled": True}).status_code == 409


def test_public_generation_cannot_bypass_desktop_license(service, monkeypatch):
    from fastapi import HTTPException
    local, public, _ = service
    key = local.post('/api/access/keys', json={'name': '授权门禁'}).json()['api_key']
    def denied():
        raise HTTPException(403, {'code': 'LICENSE_REQUIRED', 'message': '请登录'})
    monkeypatch.setattr(local.app.state.license_guard, 'require', denied)
    headers = {'Authorization': 'Bearer '+key}
    assert public.post('/v1/audio/generations', headers=headers, json={'input': '你好，明天见。'}).status_code == 403
    assert public.post('/v1/audio/speech', headers=headers, json={'input': '你好，明天见。'}).status_code == 403
    preflight = public.options("/v1/audio/generations", headers={"Origin": "https://developer.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Authorization,Idempotency-Key,Content-Type"})
    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "*"


def test_electron_null_origin_requires_current_process_management_token(service, monkeypatch):
    local, _, _ = service
    monkeypatch.setenv("VOXCPM_API_MANAGEMENT_TOKEN", "current-desktop-session")
    headers = {"Origin": "null", "Sec-Fetch-Site": "cross-site", "X-JVOX-Management": "wrong-session"}
    assert local.get("/api/access", headers=headers).status_code == 403
    headers["X-JVOX-Management"] = "current-desktop-session"
    assert local.get("/api/access", headers=headers).status_code == 200
    del headers["Origin"]
    assert local.get("/api/access", headers=headers).status_code == 200
    headers["X-JVOX-Management"] = "wrong-session"
    assert local.get("/api/access", headers=headers).status_code == 403
    headers.update({"Origin": "https://evil.example", "X-JVOX-Management": "current-desktop-session"})
    assert local.get("/api/access", headers=headers).status_code == 403


def test_async_ownership_download_stats_and_validation(service):
    local, public, api = service
    first = local.post("/api/access/keys", json={"name": "H3"}).json()
    second = local.post("/api/access/keys", json={"name": "other"}).json()
    headers = {"Authorization": f"Bearer {first['api_key']}"}
    other = {"Authorization": f"Bearer {second['api_key']}"}
    response = public.post("/v1/audio/generations", headers=headers, json={"input": "你好，明天见。", "instructions": "温暖的女声"})
    assert response.status_code == 202, response.text
    job_id = response.json()["id"]
    assert public.get(f"/v1/audio/generations/{job_id}", headers=other).status_code == 404
    for _ in range(100):
        result = public.get(f"/v1/audio/generations/{job_id}", headers=headers).json()
        if result["status"] == "completed":
            break
        time.sleep(.01)
    assert result["status"] == "completed"
    audio = public.get(result["audio_url"], headers=headers)
    assert wave.open(io.BytesIO(audio.content)).getnframes() == 24000
    assert public.get(result["audio_url"], headers=other).status_code == 404
    assert local.get("/api/access/keys").json()["keys"][1]["calls"] in {0, 1}
    assert next(row for row in api.keys() if row["id"] == first["id"])["calls_today"] == 1
    assert public.post("/v1/audio/speech", headers=headers, json={"input": "x", "mode": "clone", "reference_id": "C:/private.wav"}).status_code == 404
    assert public.post("/v1/audio/speech", headers=headers, json={"input": " "}).status_code == 422
    assert public.post("/v1/audio/references", headers=headers, content=b"fake").status_code == 422
    reference = public.post("/v1/audio/references", headers=headers, content=audio.content).json()
    assert reference["duration"] == 1
    assert public.post("/v1/audio/speech", headers=other, json={"input": "x", "mode": "clone", "reference_id": reference["id"]}).status_code == 404


def test_synchronous_wav_and_restart_results(service, tmp_path):
    local, public, api = service
    key = local.post("/api/access/keys", json={"name": "sync"}).json()["api_key"]
    headers = {"Authorization": f"Bearer {key}"}
    response = public.post("/v1/audio/speech", headers=headers, json={"input": "你好，明天见。", "instructions": "温暖的女声"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.content[:4] == b"RIFF"
    from voxcpm.studio_public_api import PublicVoiceAPI
    restarted = PublicVoiceAPI(api.root, api.studio, api.queue, api.workspace)
    restored = TestClient(restarted.app)
    job_id = next(iter(api.tasks))
    assert restored.get(f"/v1/audio/generations/{job_id}", headers=headers).json()["status"] == "completed"
    assert restored.get(f"/v1/audio/generations/{job_id}/content", headers=headers).content == response.content


def test_idempotent_requests_reuse_result_and_reject_changed_payload(service):
    local, public, api = service
    key = local.post("/api/access/keys", json={"name": "retry"}).json()["api_key"]
    headers = {"Authorization": f"Bearer {key}", "Idempotency-Key": "h3-job-stable"}
    body = {"input": "你好，明天见。", "instructions": "温暖的女声"}
    first = public.post("/v1/audio/generations", headers=headers, json=body).json()
    second = public.post("/v1/audio/generations", headers=headers, json=body).json()
    assert first["id"] == second["id"]
    assert len(api.tasks) == 1
    assert api.keys()[0]["calls"] == 1
    assert public.post("/v1/audio/generations", headers=headers, json={**body, "input": "不同台词"}).status_code == 409


def test_live_listener_config_persists_and_occupied_port_is_reported(service):
    import socket
    import urllib.request
    local, _, api = service
    key = local.post("/api/access/keys", json={"name": "network"}).json()["api_key"]
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    try:
        response = local.put("/api/access", json={"enabled": True, "host": "127.0.0.1", "port": port})
        assert response.status_code == 200 and response.json()["listening"]
        request = urllib.request.Request(f"http://127.0.0.1:{port}/v1/models", headers={"Authorization": f"Bearer {key}"})
        assert urllib.request.urlopen(request).status == 200
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0)); occupied.listen()
            assert local.put("/api/access", json={"enabled": True, "port": occupied.getsockname()[1]}).status_code == 409
        assert api.status()["listening"]
        assert api.config()["port"] == port
    finally:
        api.stop()


@pytest.mark.parametrize("mode,expected", [("design", "声音设计"), ("clone", "可控克隆"), ("clone_prompt", "极致克隆")])
def test_each_mode_preserves_reference_transcript_and_model_controls(service, monkeypatch, mode, expected):
    local, public, api = service
    token = local.post("/api/access/keys", json={"name": mode}).json()["api_key"]
    headers = {"Authorization": f"Bearer {token}"}
    audio = io.BytesIO()
    with wave.open(audio, "wb") as wav:
        wav.setparams((1, 2, 24000, 0, "NONE", "not compressed"))
        wav.writeframes(b"\0\0" * 24000)
    ref = public.post("/v1/audio/references", headers=headers, content=audio.getvalue()).json()["id"]
    calls = []
    original = api.studio.generate_audio_payload
    def generate(**kwargs):
        calls.append(kwargs)
        return original(**kwargs)
    monkeypatch.setattr(api.studio, "generate_audio_payload", generate)
    payload = {"input": "你好，明天见。", "instructions": "温暖的女声", "mode": mode,
               "reference_id": ref, "prompt_text": "这是参考音准确转录。", "cfg_value": 3, "inference_timesteps": 12}
    response = public.post("/v1/audio/speech", headers=headers, json=payload)
    assert response.status_code == 200
    assert calls[0]["mode"] == expected
    assert calls[0]["prompt_text"] == payload["prompt_text"]
    assert calls[0]["cfg_value"] == 3 and calls[0]["inference_timesteps"] == 12
    if mode == "design":
        assert calls[0]["reference_audio"] is None
    else:
        assert calls[0]["reference_audio"].endswith(ref + ".wav")
    if mode == "clone_prompt":
        assert public.post("/v1/audio/generations", headers=headers, json={**payload, "prompt_text": " "}).status_code == 422


def test_concurrent_retries_share_one_inference_and_deleted_key_is_revoked(service):
    from concurrent.futures import ThreadPoolExecutor
    local, public, api = service
    created = local.post("/api/access/keys", json={"name": "并发重试"}).json()
    headers = {"Authorization": f"Bearer {created['api_key']}", "Idempotency-Key": "concurrent"}
    payload = {"input": "你好，明天见。", "instructions": "温暖的女声"}
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: public.post("/v1/audio/generations", headers=headers, json=payload), range(8)))
    assert all(r.status_code == 202 for r in results)
    assert len({r.json()["id"] for r in results}) == len(api.tasks) == api.keys()[0]["calls"] == 1
    assert local.delete(f"/api/access/keys/{created['id']}").status_code == 200
    assert public.get("/v1/models", headers=headers).status_code == 401
