from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import zipfile

from fastapi.testclient import TestClient
import pytest

from voxcpm.lipsync_prepare import cached_ready, download, exclusive, extract, fingerprint, stamps
from voxcpm.studio_api import create_api_app


@contextmanager
def server(data, ignore_range=False):
    ranges = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_GET(self):
            header = self.headers.get("Range", "")
            ranges.append(header)
            offset = 0 if ignore_range else int(header.split("=")[1].split("-")[0]) if header else 0
            self.send_response(200 if ignore_range else 206)
            if not ignore_range:
                self.send_header("Content-Range", f"bytes {offset}-{len(data)-1}/{len(data)}")
            self.send_header("Content-Length", str(len(data)-offset))
            self.end_headers()
            self.wfile.write(data[offset:])
    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{http.server_port}/weight", ranges
    finally:
        http.shutdown()
        http.server_close()


def test_local_resource_reuse_and_offline_missing(tmp_path, monkeypatch):
    source = tmp_path / "shared"
    source.mkdir()
    data = b"verified-local-model"
    (source / "weight.pt").write_bytes(data)
    asset = {"name": "weight.pt", "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
             "urls": ["https://example.invalid/weight.pt"]}
    monkeypatch.setenv("VOXCPM_LOCAL_ASSET_DIRS", str(source))
    monkeypatch.setenv("VOXCPM_OFFLINE", "1")
    def unexpected_network(*args, **kwargs):
        raise AssertionError("本地复用不能联网")
    monkeypatch.setattr("urllib.request.urlopen", unexpected_network)
    target = tmp_path / "copy/weight.pt"
    assert download(asset, target).read_bytes() == data
    target.write_bytes(b"x" * len(data))
    assert (source / "weight.pt").read_bytes() == data
    (source / "weight.pt").write_bytes(b"x" * len(data))
    with pytest.raises(RuntimeError, match="离线验收缺少资源"):
        download(asset, target)
    target.with_name("weight.pt.part").write_bytes(data)
    assert download(asset, target).read_bytes() == data


@pytest.mark.parametrize("ignore_range", [False, True])
def test_resume_or_restart_does_not_duplicate_bytes(tmp_path, ignore_range):
    data = b"verified-model-data" * 10000
    target = tmp_path / "中文 权重.pt"
    partial = target.with_name(target.name + ".part")
    partial.write_bytes(data[:8123])
    with server(data, ignore_range) as (url, ranges):
        asset = {"name": target.name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "urls": [url]}
        download(asset, target, allow_http=True)
        assert target.read_bytes() == data and ranges == ["bytes=8123-"] and not partial.exists()
        download(asset, target, allow_http=True)
        assert len(ranges) == 1


def test_wrong_hash_cannot_publish_model(tmp_path):
    data = b"corrupt-data"
    with server(data) as (url, ranges):
        asset = {"name": "weight.pt", "size": len(data), "sha256": "0" * 64, "urls": [url]}
        with pytest.raises(RuntimeError, match="SHA256"):
            download(asset, tmp_path / "weight.pt", allow_http=True)
    assert not (tmp_path / "weight.pt").exists()


@pytest.mark.parametrize("filename", ["../outside.txt", "C:/outside.txt", "..\\outside.txt"])
def test_archive_rejects_paths_outside_target_before_extraction(tmp_path, filename):
    archive = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("valid.txt", "valid")
        bundle.writestr(filename, "bad")
    with pytest.raises(ValueError, match="不安全"):
        extract(archive, tmp_path / "extract")
    assert not (tmp_path / "extract/valid.txt").exists()


def test_ready_cache_invalidates_missing_or_changed_file_and_new_config(tmp_path):
    file = tmp_path / "weight.pt"
    file.write_bytes(b"data")
    config = {"revision": "one"}
    ready = {"fingerprint": fingerprint(config, sys.executable), "files": stamps([file])}
    (tmp_path / "ready-1.6.json").write_text(json.dumps(ready), encoding="utf-8")
    assert cached_ready(tmp_path, "1.6", config, sys.executable)
    assert not cached_ready(tmp_path, "1.6", {"revision": "two"}, sys.executable)
    ready["fingerprint"].pop("videoPolicy")
    (tmp_path / "ready-1.6.json").write_text(json.dumps(ready), encoding="utf-8")
    assert not cached_ready(tmp_path, "1.6", config, sys.executable), "旧环境必须重新执行隔离后的真实探测"
    ready["fingerprint"] = fingerprint(config, sys.executable)
    (tmp_path / "ready-1.6.json").write_text(json.dumps(ready), encoding="utf-8")
    file.write_bytes(b"changed")
    assert not cached_ready(tmp_path, "1.6", config, sys.executable)
    file.unlink()
    assert not cached_ready(tmp_path, "1.6", config, sys.executable)


def test_exclusive_lock_releases_after_exception(tmp_path):
    with pytest.raises(RuntimeError, match="another"):
        with exclusive(tmp_path):
            with pytest.raises(RuntimeError, match="另一窗口"):
                with exclusive(tmp_path):
                    pass
            raise RuntimeError("another")
    with exclusive(tmp_path):
        pass


def test_preparation_api_deduplicates_cancels_and_keeps_16gb_target(tmp_path, monkeypatch):
    monkeypatch.setenv("VOXCPM_LIPSYNC_ROOT", str(tmp_path / "模型"))
    studio = SimpleNamespace(runtime_summary_payload=lambda: {"data_root": str(tmp_path)}, settings_payload=lambda: {"output_dir": str(tmp_path / "outputs")})
    app = create_api_app(studio)
    # 此用例验证资源准备/取消，授权门禁另有真实签名用例覆盖。
    monkeypatch.setattr(app.state.license_guard, "require", lambda: None)
    service = app.state.lipsync
    monkeypatch.setattr(service, "hardware", lambda: {"cuda": True, "totalMB": 16384, "freeMB": 5000})
    started = threading.Event()
    def prepare(version, progress, cancelled):
        try:
            assert version == "auto"
            started.set()
            while not cancelled():
                time.sleep(.01)
            return {"cancelled": True}
        finally:
            service.preparing = False
    monkeypatch.setattr(service, "prepare", prepare)
    with TestClient(app) as client:
        status = client.get("/api/lipsync/status").json()
        assert status["preferredVersion"] == "1.6" and status["needsPreparation"]
        first = client.post("/api/lipsync/prepare", json={}).json()
        assert started.wait(2)
        second = client.post("/api/lipsync/prepare", json={}).json()
        assert second["taskId"] == first["taskId"]
        assert client.post("/api/asr/recognize", json={"audioPath": "test.wav"}).status_code == 409
        assert client.post("/api/tasks/" + first["taskId"] + "/cancel").status_code == 200
        for _ in range(200):
            if client.get("/api/tasks/" + first["taskId"]).json()["status"] == "cancelled":
                break
            time.sleep(.01)
        assert not service.preparing
        monkeypatch.setattr(service, "hardware", lambda: {"cuda": False, "totalMB": 0, "freeMB": 0})
        assert client.post("/api/lipsync/prepare", json={}).status_code == 400


def test_queued_preparation_can_be_cancelled_without_stuck_reservation(tmp_path, monkeypatch):
    studio = SimpleNamespace(runtime_summary_payload=lambda: {"data_root": str(tmp_path)}, settings_payload=lambda: {"output_dir": str(tmp_path / "outputs")})
    app = create_api_app(studio)
    monkeypatch.setattr(app.state.license_guard, "require", lambda: None)
    service, tasks = app.state.lipsync, app.state.task_queue
    monkeypatch.setattr(service, "hardware", lambda: {"cuda": True, "totalMB": 16384, "freeMB": 10000})
    blocked, release = threading.Event(), threading.Event()
    def blocking():
        blocked.set(); release.wait(5); return {}
    tasks.submit("test-blocker", "block", blocking)
    assert blocked.wait(2)
    with TestClient(app) as client:
        task = client.post("/api/lipsync/prepare", json={}).json()
        assert service.preparing
        client.post("/api/tasks/" + task["taskId"] + "/cancel")
        release.set()
        for _ in range(200):
            if client.get("/api/tasks/" + task["taskId"]).json()["status"] == "cancelled":
                break
            time.sleep(.01)
        assert not service.preparing
