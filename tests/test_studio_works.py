"""作品汇总契约：旧数据、全量结果、批量持久化和局部故障隔离。"""
import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from voxcpm.studio_api import create_api_app
from voxcpm.studio_workspace import WorkspaceStore


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.delenv("VOXCPM_DATA_ROOT", raising=False)
    settings = {"output_dir": str(tmp_path / "outputs")}
    studio = SimpleNamespace(runtime_summary_payload=lambda: {"data_root": str(tmp_path)}, settings_payload=lambda: settings)
    app = create_api_app(studio)
    return TestClient(app), app, studio, settings


def write_result(root, category, name, **fields):
    folder = root / ("outputs/music" if category == "music" else "lipsync-jobs") / name
    folder.mkdir(parents=True, exist_ok=True)
    output = folder / ("audio.wav" if category == "music" else "output.mp4")
    output.write_bytes(b"fixture")
    record = {"outputPath": str(output), "duration": 12, **fields}
    (folder / "result.json").write_text(json.dumps(record), encoding="utf-8")
    return output


def write_batch(output_root):
    folder = Path(output_root) / "batch/20261020_test"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "001.wav").write_bytes(b"fixture")
    manifest = folder / "manifest.json"
    manifest.write_text(json.dumps([{"index": 1, "text": "批量第一句", "output_file": "001.wav"}]), encoding="utf-8")
    folder.with_suffix(".zip").write_bytes(b"fixture")
    return {"manifest_path": str(manifest), "archive_path": str(folder.with_suffix(".zip")), "output_dir": str(folder)}


def test_empty_library_does_not_create_project(setup):
    client, app, *_ = setup
    assert client.get("/api/workspace/works").json() == {"items": [], "warnings": []}
    assert client.get("/api/workspace/projects").json()["items"] == []


def test_all_categories_legacy_metadata_sorting_and_safe_urls(setup, tmp_path):
    client, app, _, settings = setup
    audio = tmp_path / "中文 # 单条.wav"
    audio.write_bytes(b"fixture")
    store = app.state.workspace
    store.db["history"] = [
        {"id": "single", "kind": "single", "projectName": "单条创作", "text": "清晨的第一缕阳光", "audioPath": str(audio), "config": {"mode": "可控克隆"}, "createdAt": "2026-10-19T11:00:00", "duration": 4},
        {"id": "segment", "kind": "segment", "projectId": "project-1", "projectName": "双人故事", "segmentId": "seg-1", "audioPath": str(audio), "createdAt": "2026-10-20T11:00:00+08:00"},
        {"id": "export", "kind": "export", "projectId": "project-1", "projectName": "双人故事", "audioPath": str(audio), "createdAt": "2026-10-20T12:00:00+08:00"},
    ]
    write_result(tmp_path, "music", "song", title="山海", modelId="yue2", packet={"draft": {"captionZh": "悠扬的民族器乐"}})
    write_result(tmp_path, "video", "photo", sourcePath="photo.png", mode="photo")
    write_batch(settings["output_dir"])
    data = client.get("/api/workspace/works").json()
    assert {row["category"] for row in data["items"]} == {"voice", "dubbing", "music", "video", "batch"}
    assert len(data["items"]) == 6
    assert len({row["id"] for row in data["items"]}) == 6
    voice = next(row for row in data["items"] if row["category"] == "voice")
    assert voice["title"] == "清晨的第一缕阳光" and voice["label"] == "可控克隆"
    assert "%23" in voice["previewUrl"] and voice["available"]
    dubbing = [row for row in data["items"] if row["category"] == "dubbing"]
    assert [row["label"] for row in dubbing] == ["完整作品", "分段音频"]
    assert next(row for row in data["items"] if row["category"] == "music")["subtitle"] == "悠扬的民族器乐"
    assert next(row for row in data["items"] if row["category"] == "video")["label"] == "照片说话"
    assert not data["warnings"]
    # 独立作品接口不改变视频页依赖的原音频历史契约。
    assert len(client.get("/api/workspace/history").json()["items"]) == 3


def test_full_library_exceeds_recent_results_limits_and_keeps_missing(setup, tmp_path):
    client, *_ = setup
    for i in range(53):
        write_result(tmp_path, "music", str(i), title=f"歌曲{i}")
    for i in range(33):
        write_result(tmp_path, "video", str(i), mode="video")
    missing = write_result(tmp_path, "music", "missing", title="已移动")
    missing.unlink()
    result = client.get("/api/workspace/works").json()
    assert len(result["items"]) == 87
    assert next(row for row in result["items"] if row["title"] == "已移动")["available"] is False
    assert all(row["createdAt"] for row in result["items"])
    assert len(client.get("/api/music/results").json()["items"]) <= 50
    assert len(client.get("/api/lipsync/results").json()["items"]) == 30


def test_batch_task_records_index_survives_restart_output_change_and_deduplicates(setup, tmp_path):
    client, app, studio, settings = setup
    result = write_batch(settings["output_dir"])
    studio.batch_generate_payload = lambda **_: {**result, "count": 1}
    response = client.post("/api/tasks/generate-batch", json={"mode": "声音设计", "batchText": "批量第一句"})
    assert response.status_code == 200
    task_id = response.json()["taskId"]
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        task = client.get("/api/tasks/" + task_id).json()
        if task["status"] in {"succeeded", "failed"}:
            break
        time.sleep(.01)
    assert task["status"] == "succeeded", task
    assert len(client.get("/api/workspace/works").json()["items"]) == 1
    app.state.workspace.record_batch(result)
    assert len(WorkspaceStore(app.state.workspace.root, studio).db["batches"]) == 1
    settings["output_dir"] = str(tmp_path / "new-output")
    restarted = TestClient(create_api_app(studio))
    item = restarted.get("/api/workspace/works").json()["items"][0]
    assert item["subtitle"] == "批量第一句" and item["archiveAvailable"]


def test_corrupt_batch_and_missing_media_do_not_hide_other_works(setup, tmp_path):
    client, app, _, settings = setup
    app.state.workspace.db["history"] = [{"id": "lost", "kind": "single", "audioPath": str(tmp_path / "lost.wav"), "createdAt": ""}]
    result = write_batch(settings["output_dir"])
    Path(result["manifest_path"]).write_text("{bad", encoding="utf-8")
    write_result(tmp_path, "music", "good", title="保留作品")
    data = client.get("/api/workspace/works").json()
    assert len(data["items"]) == 2 and len(data["warnings"]) == 1
    assert next(row for row in data["items"] if row["category"] == "voice")["available"] is False


def test_settings_change_indexes_legacy_batch_before_output_move(setup, tmp_path):
    client, app, studio, settings = setup
    write_batch(settings["output_dir"])
    assert app.state.workspace.db["batches"] == []
    def persist(**values):
        settings["output_dir"] = values["output_dir"]
        return "已保存", ""
    studio.persist_settings = persist
    response = client.put("/api/settings", json={"output_dir": str(tmp_path / "moved-output")})
    assert response.status_code == 200
    assert len(app.state.workspace.db["batches"]) == 1
    restarted = TestClient(create_api_app(studio))
    assert len(restarted.get("/api/workspace/works").json()["items"]) == 1


def test_partial_source_failure_preserves_other_categories(setup, tmp_path):
    client, app, *_ = setup
    def fail(**_):
        raise OSError("unavailable")
    app.state.music.results = fail
    write_result(tmp_path, "video", "good", mode="video")
    data = client.get("/api/workspace/works").json()
    assert len(data["items"]) == 1 and data["items"][0]["category"] == "video"
    assert data["warnings"] == ["音乐创作记录读取失败，请刷新重试。"]
