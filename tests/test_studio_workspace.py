from __future__ import annotations

import threading
import time
import zipfile
import ast
import json
from types import SimpleNamespace
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from voxcpm.studio_api import create_api_app
from voxcpm.studio_workspace import DEFAULT_CONFIG, WorkspaceStore


class WaveStudio:
    def __init__(self, root):
        self.root = root
        self.calls = []
        self.block = None
        self.started = threading.Event()
        self.fail = set()

    def runtime_summary_payload(self):
        return {"data_root": str(self.root)}

    def settings_payload(self):
        return {"output_dir": str(self.root / "outputs")}

    def generate_audio_payload(self, **kwargs):
        self.calls.append(kwargs)
        self.started.set()
        if self.block:
            self.block.wait(3)
        if kwargs["text"] in self.fail:
            raise ValueError("模拟生成失败")
        # 固定路径刻意模拟既有单条输出的覆盖风险。
        path = self.root / "source.wav"
        value = .1 if len(self.calls) % 2 else .2
        sf.write(path, np.full(2400, value, dtype=np.float32), 24000, subtype="FLOAT")
        return {"output_path": str(path)}


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.delenv("VOXCPM_DATA_ROOT", raising=False)
    studio = WaveStudio(tmp_path)
    app = create_api_app(studio)
    return TestClient(app), studio, app.state.workspace


def prepared(client, text="{小明}你好\n小红：欢迎回来"):
    project = client.post("/api/workspace/projects", json={"name": "测试配音"}).json()
    response = client.post(f"/api/workspace/projects/{project['id']}/parse", json={"text": text, "maxChars": 120})
    assert response.status_code == 200, response.text
    return response.json()


def wait_task(client, task_id):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        task = client.get(f"/api/tasks/{task_id}").json()
        if task["status"] in {"succeeded", "failed", "cancelled"}:
            return task
        time.sleep(.01)
    raise AssertionError("任务超时")


def generate(client, project, **payload):
    response = client.post(f"/api/workspace/projects/{project['id']}/generate", json=payload)
    assert response.status_code == 200
    return wait_task(client, response.json()["taskId"])


def test_parse_roles_split_srt_and_persistence(setup):
    client, studio, store = setup
    project = prepared(client, "{小明}你好。欢迎回来！\n小红：一起开始吧。\n这里仍是小红。")
    assert [r["name"] for r in project["roles"]] == ["旁白", "小明", "小红"]
    assert len(project["segments"]) == 3
    assert project["segments"][1]["roleId"] == project["segments"][2]["roleId"]
    restarted = WorkspaceStore(store.root, studio)
    assert restarted.get_project(project["id"])["segments"] == project["segments"]
    srt = "1\n00:00:00,000 --> 00:00:03,000\n小明：你好\n欢迎\n\n2\n00:00:03,100 --> 00:00:05,000\n小红：开始"
    parsed = client.post(f"/api/workspace/projects/{project['id']}/parse", json={"text": srt}).json()
    assert [s["text"] for s in parsed["segments"]] == ["你好 欢迎", "开始"]
    assert len(WorkspaceStore.split_text("甲" * 25 + "，" + "乙" * 25, 20)) == 3


def test_generation_role_config_unique_audio_export_and_staleness(setup):
    client, studio, store = setup
    project = prepared(client)
    project["roles"][1]["config"]["control"] = "温柔"
    project["roles"][2]["config"]["control"] = "清晰"
    project["roles"][1].update(volume=.5, pan=-1)
    project["segments"][0]["pauseAfterMs"] = 200
    project = client.put(f"/api/workspace/projects/{project['id']}", json=project).json()
    task = generate(client, project)
    assert task["status"] == "succeeded"
    assert (task["completed"], task["total"]) == (2, 2)
    assert [c["control"] for c in studio.calls] == ["温柔", "清晰"]
    project = task["result"]["project"]
    paths = [s["audioPath"] for s in project["segments"]]
    assert paths[0] != paths[1]
    assert sf.read(paths[0])[0][0] == pytest.approx(.1)
    assert sf.read(paths[1])[0][0] == pytest.approx(.2)
    exported = client.post(f"/api/workspace/projects/{project['id']}/export")
    assert exported.status_code == 200, exported.text
    result = exported.json()
    audio, rate = sf.read(result["outputPath"])
    assert rate == 24000
    assert audio.shape == (9600, 2)
    assert result["duration"] == pytest.approx(.4)
    assert audio[:2400, 0].mean() == pytest.approx(.05, abs=.0001)
    assert np.max(np.abs(audio[:2400, 1])) == 0
    assert np.max(np.abs(audio[2400:7200])) == 0
    srt = Path(result["srtPath"]).read_text(encoding="utf-8-sig")
    assert "00:00:00,000 --> 00:00:00,100" in srt
    assert "00:00:00,300 --> 00:00:00,400" in srt
    with zipfile.ZipFile(result["archivePath"]) as archive:
        assert {"full.wav", "subtitles.srt", "manifest.json"} <= set(archive.namelist())
        assert len([n for n in archive.namelist() if n.startswith("roles/")]) == 2
        assert len([n for n in archive.namelist() if n.startswith("segments/")]) == 2
    assert len(client.get("/api/workspace/history").json()["items"]) == 3
    project["segments"][0]["text"] = "修改的台词"
    edited = client.put(f"/api/workspace/projects/{project['id']}", json=project).json()
    assert edited["segments"][0]["stale"] is True
    assert edited["segments"][1]["stale"] is False
    assert client.post(f"/api/workspace/projects/{project['id']}/export").status_code == 400
    retry = generate(client, edited)
    assert retry["result"]["generatedCount"] == 1
    assert len(studio.calls) == 3


def test_failed_segments_retry_and_no_unnecessary_regeneration(setup):
    client, studio, store = setup
    project = prepared(client)
    studio.fail.add("你好")
    task = generate(client, project)
    assert task["result"]["failedCount"] == 1
    assert task["result"]["generatedCount"] == 1
    assert task["result"]["project"]["segments"][0]["status"] == "failed"
    studio.fail.clear()
    assert generate(client, project)["result"]["generatedCount"] == 1
    assert generate(client, project)["result"]["generatedCount"] == 0
    assert len(studio.calls) == 3


def test_cancel_during_generation_keeps_completed_piece(setup):
    client, studio, store = setup
    project = prepared(client)
    studio.block = threading.Event()
    task = client.post(f"/api/workspace/projects/{project['id']}/generate", json={}).json()
    assert studio.started.wait(2)
    cancelled = client.post(f"/api/tasks/{task['taskId']}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["cancelRequested"] is True
    studio.block.set()
    final = wait_task(client, task["taskId"])
    assert final["status"] == "cancelled"
    assert final["completed"] == 1
    assert len(studio.calls) == 1
    assert final["result"]["project"]["segments"][0]["status"] == "ready"


def test_concurrent_edit_prevents_old_generation_overwriting_new_text(setup):
    client, studio, store = setup
    project = prepared(client)
    studio.block = threading.Event()
    task = client.post(f"/api/workspace/projects/{project['id']}/generate", json={"segmentIds": [project["segments"][0]["id"]]}).json()
    assert studio.started.wait(2)
    project["segments"][0]["text"] = "新的台词"
    assert client.put(f"/api/workspace/projects/{project['id']}", json=project).status_code == 200
    studio.block.set()
    finished = wait_task(client, task["taskId"])
    segment = finished["result"]["project"]["segments"][0]
    assert segment["text"] == "新的台词"
    assert segment["audioPath"] == ""
    assert len(store.history()["items"]) == 1


def test_voice_copies_reference_and_detects_reference_changes(setup, tmp_path):
    client, studio, store = setup
    reference = tmp_path / "reference.wav"
    sf.write(reference, np.zeros(100), 24000)
    voice = client.post("/api/workspace/voices", json={"name": "收藏", "config": {**DEFAULT_CONFIG, "referenceAudio": str(reference)}}).json()
    copied = Path(voice["config"]["referenceAudio"])
    assert copied != reference and copied.is_file()
    reference.unlink()
    project = prepared(client)
    project["roles"][1]["config"] = voice["config"]
    project = client.put(f"/api/workspace/projects/{project['id']}", json=project).json()
    generated = generate(client, project)["result"]["project"]
    sf.write(copied, np.zeros(200), 24000)
    assert store.get_project(project["id"])["segments"][0]["stale"]
    client.delete(f"/api/workspace/voices/{voice['id']}")
    assert copied.exists()
    assert client.get("/api/workspace/voices").json() == {"items": []}


def test_designed_voice_preserves_sample_and_applies_as_fixed_reference(setup, tmp_path):
    client, studio, store = setup
    preview = tmp_path / "designed.wav"
    sf.write(preview, np.full(2400, .12), 24000)
    original = preview.read_bytes()
    config = {**DEFAULT_CONFIG, "control": "温暖自然", "cfgValue": 2.3}
    response = client.post("/api/workspace/voices", json={"name": "设计叙述", "tags": ["旁白"],
        "config": config, "previewAudio": str(preview), "sampleText": "这是试听文案。"})
    assert response.status_code == 200, response.text
    voice = response.json()
    saved = Path(voice["previewAudio"])
    assert saved != preview and saved.read_bytes() == original
    assert voice["sourceMode"] == "声音设计"
    assert voice["designConfig"] == config
    assert voice["sampleText"] == "这是试听文案。"
    assert voice["config"]["mode"] == "可控克隆"
    assert voice["config"]["referenceAudio"] == str(saved)
    preview.unlink()
    assert client.get(voice["previewUrl"]).content == original
    restarted = WorkspaceStore(store.root, studio)
    assert restarted.voices()["items"][0] == voice
    project = prepared(client)
    project["roles"][1]["config"] = voice["config"]
    project = client.put(f"/api/workspace/projects/{project['id']}", json=project).json()
    assert generate(client, project)["status"] == "succeeded"
    assert studio.calls[0]["mode"] == "可控克隆"
    assert studio.calls[0]["reference_audio"] == str(saved)
    client.delete(f"/api/workspace/voices/{voice['id']}")
    assert saved.is_file()  # 已应用到角色的参考继续可用。


@pytest.mark.parametrize("mode", ["可控克隆", "极致克隆"])
def test_saved_clone_keeps_mode_and_owns_reference_and_preview(setup, tmp_path, mode):
    client, studio, store = setup
    reference, preview = tmp_path / "reference.wav", tmp_path / "preview.wav"
    sf.write(reference, np.zeros(1000), 24000)
    sf.write(preview, np.ones(2000) * .1, 24000)
    config = {**DEFAULT_CONFIG, "mode": mode, "referenceAudio": str(reference), "promptText": "参考文案"}
    voice = client.post("/api/workspace/voices", json={"name": mode, "config": config, "previewAudio": str(preview)}).json()
    saved_reference, saved_preview = Path(voice["config"]["referenceAudio"]), Path(voice["previewAudio"])
    assert saved_reference != reference and saved_preview != preview and saved_reference != saved_preview
    assert saved_reference.read_bytes() == reference.read_bytes()
    assert saved_preview.read_bytes() == preview.read_bytes()
    assert voice["config"]["mode"] == voice["sourceMode"] == voice["designConfig"]["mode"] == mode
    assert voice["designConfig"]["referenceAudio"] == str(saved_reference)
    reference.unlink(); preview.unlink()
    assert saved_reference.is_file() and client.get(voice["previewUrl"]).status_code == 200


def test_voice_save_rejects_missing_sample_without_creating_entry(setup, tmp_path):
    client, studio, store = setup
    response = client.post("/api/workspace/voices", json={"name": "无效", "config": DEFAULT_CONFIG,
        "previewAudio": str(tmp_path / "missing.wav")})
    assert response.status_code == 400
    assert store.voices() == {"items": []}
    assert not (store.root / "voices").exists()


def test_voice_save_rolls_back_files_and_entry_on_write_failure(setup, tmp_path, monkeypatch):
    client, studio, store = setup
    preview = tmp_path / "preview.wav"
    sf.write(preview, np.zeros(100), 24000)
    def fail_save():
        raise OSError("模拟写入失败")
    monkeypatch.setattr(store, "_save", fail_save)
    with pytest.raises(OSError, match="模拟写入失败"):
        store.add_voice({"name": "失败", "config": DEFAULT_CONFIG, "previewAudio": str(preview)})
    assert store.voices() == {"items": []}
    assert list((store.root / "voices").iterdir()) == []
    assert preview.is_file()


def test_bgm_resamples_loops_and_export_rejects_invalid_settings(setup, tmp_path):
    client, studio, store = setup
    project = prepared(client)
    bgm = tmp_path / "bgm.wav"
    sf.write(bgm, np.full(800, .2), 8000, subtype="FLOAT")
    project["backgroundMusic"] = {"path": str(bgm), "volume": .5}
    project = client.put(f"/api/workspace/projects/{project['id']}", json=project).json()
    generate(client, project)
    result = client.post(f"/api/workspace/projects/{project['id']}/export").json()
    wave, rate = sf.read(result["outputPath"])
    assert rate == 24000 and wave.shape == (12000, 2)
    assert wave[3000, 0] == pytest.approx(.1, abs=.0001)
    project["roles"][0]["pan"] = 1.5
    assert client.put(f"/api/workspace/projects/{project['id']}", json=project).status_code == 400
    assert client.get("/api/workspace/projects/missing").status_code == 404


def test_untrusted_ids_and_audio_paths_rejected(setup, tmp_path):
    client, studio, store = setup
    project = prepared(client)
    endpoint = f"/api/workspace/projects/{project['id']}"
    project["segments"][0]["audioPath"] = str(tmp_path / "injected.wav")
    project["segments"][0]["status"] = "ready"
    saved = client.put(endpoint, json=project).json()
    assert saved["segments"][0]["audioPath"] == ""
    assert saved["segments"][0]["status"] == "pending"
    project["segments"][0]["id"] = "../../escaped"
    assert client.put(endpoint, json=project).status_code == 400
    project["segments"][0]["id"] = "safe"
    project["roles"][0]["id"] = "../../escaped"
    assert client.put(endpoint, json=project).status_code == 400
    assert not (tmp_path.parent / "escaped.wav").exists()


def test_export_fingerprint_stale_for_mix_changes_and_regeneration(setup):
    client, studio, store = setup
    project = prepared(client)
    endpoint = f"/api/workspace/projects/{project['id']}"
    generate(client, project)
    result = client.post(endpoint + "/export").json()
    assert result["project"]["lastExport"]["stale"] is False
    project = result["project"]
    project["segments"][0]["pauseAfterMs"] += 100
    saved = client.put(endpoint, json=project).json()
    assert saved["lastExport"]["stale"] is True
    assert saved["segments"][0]["stale"] is False
    result = client.post(endpoint + "/export").json()
    project = result["project"]
    project["roles"][1]["volume"] = .6
    assert client.put(endpoint, json=project).json()["lastExport"]["stale"] is True
    result = client.post(endpoint + "/export").json()
    assert result["project"]["lastExport"]["stale"] is False
    generated = generate(client, project, segmentIds=[project["segments"][0]["id"]], force=True)
    assert generated["result"]["project"]["lastExport"]["stale"] is True


def test_single_workspace_history_is_persistent_snapshot(setup):
    client, studio, store = setup
    task = client.post("/api/tasks/generate-single", json={"mode": "声音设计", "text": "独立创作"}).json()
    assert wait_task(client, task["taskId"])["status"] == "succeeded"
    history = client.get("/api/workspace/history").json()["items"]
    assert history[0]["kind"] == "single"
    assert history[0]["text"] == "独立创作"
    assert Path(history[0]["audioPath"]).is_file()
    assert sf.info(history[0]["audioPath"]).duration == pytest.approx(.1)
    assert WorkspaceStore(store.root, studio).history()["items"][0]["id"] == history[0]["id"]


def test_queued_cancel_prevents_model_call_and_restart_keeps_ready_audio(setup):
    client, studio, store = setup
    project = prepared(client)
    studio.block = threading.Event()
    first = client.post(f"/api/workspace/projects/{project['id']}/generate", json={"segmentIds": [project["segments"][0]["id"]]}).json()
    assert studio.started.wait(2)
    second = client.post(f"/api/workspace/projects/{project['id']}/generate", json={"force": True}).json()
    assert client.post(f"/api/tasks/{second['taskId']}/cancel").status_code == 200
    studio.block.set()
    assert wait_task(client, first["taskId"])["status"] == "succeeded"
    assert wait_task(client, second["taskId"])["status"] == "cancelled"
    assert len(studio.calls) == 1
    reloaded = WorkspaceStore(store.root, studio).get_project(project["id"])
    assert reloaded["segments"][0]["status"] == "ready"
    assert reloaded["segments"][0]["stale"] is False
    assert reloaded["segments"][1]["status"] == "pending"


def lightweight_studio(tmp_path):
    """执行真实方法，仅替换重模型构造，避免加载 torch/Gradio/FunASR。"""
    root = Path(__file__).resolve().parents[1]
    source = root / "src" / "voxcpm" / "studio_app.py"
    if not source.exists():
        source = root / "backend" / "voxcpm" / "studio_app.py"
    module = ast.parse(source.read_text(encoding="utf-8"))
    original = next(node for node in module.body if isinstance(node, ast.ClassDef) and node.name == "VoxCPMStudio")
    names = {"get_or_load_voxcpm", "build_generation_kwargs", "generate_audio_payload", "batch_generate_payload", "read_batch_items"}
    original.body = [node for node in original.body if isinstance(node, ast.FunctionDef) and node.name in names]
    extracted = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), original], type_ignores=[])
    constructor_calls = []
    generation_calls = []

    def fake_model(**kwargs):
        constructor_calls.append(kwargs)
        if kwargs["enable_denoiser"] and kwargs["zipenhancer_model_path"] != "valid-enhancer":
            raise FileNotFoundError("过期增强模型目录")

        def generate(**generation):
            generation_calls.append(generation)
            return np.zeros(240, dtype=np.float32)
        return SimpleNamespace(tts_model=SimpleNamespace(sample_rate=24000), generate=generate)

    namespace = {"ensure_model_resources": lambda *args: None, "torch": SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False)), "VoxCPM": fake_model, "Path": Path, "json": json, "sf": sf, "zipfile": zipfile,
                 "NO_LORA_LABEL": "不使用 LoRA", "DEFAULT_ZIPENHANCER": "default-enhancer", "now_stamp": lambda: "test-run"}
    exec(compile(ast.fix_missing_locations(extracted), str(source), "exec"), namespace)
    studio = namespace["VoxCPMStudio"]()
    studio.settings = SimpleNamespace(disable_denoiser=False, disable_optimize=True,
        zipenhancer_path="outdated-enhancer", output_dir=str(tmp_path))
    studio.voxcpm_model = None
    studio.loaded_model_key = None
    studio.resolve_model_source = lambda selected: "local-model"
    studio.ensure_model_directory = lambda model: model
    studio.default_lora_config = lambda: {"rank": 32}
    studio.lora_signature = lambda config: json.dumps(config)
    studio.prepare_prompt_text = lambda mode, audio, text: text
    studio.apply_lora_selection = lambda model, selected: None
    studio.runtime_summary_payload = lambda: {}
    studio.output_file = lambda category, stem, suffix: tmp_path / f"{stem}{suffix}"
    return studio, constructor_calls, generation_calls


def test_lazy_denoiser_cache_respects_actual_requested_state(tmp_path):
    studio, calls, generated = lightweight_studio(tmp_path)
    plain = studio.get_or_load_voxcpm(load_denoiser=False)
    assert calls[-1]["enable_denoiser"] is False
    assert calls[-1]["zipenhancer_model_path"] is None
    assert studio.get_or_load_voxcpm(load_denoiser=False) is plain
    studio.settings.zipenhancer_path = "another-outdated-path"
    assert studio.get_or_load_voxcpm(load_denoiser=False) is plain
    assert len(calls) == 1
    with pytest.raises(FileNotFoundError, match="过期增强模型目录"):
        studio.get_or_load_voxcpm(load_denoiser=True)
    studio.settings.zipenhancer_path = "valid-enhancer"
    enhanced = studio.get_or_load_voxcpm(load_denoiser=True)
    assert enhanced is not plain and calls[-1]["enable_denoiser"] is True
    assert studio.get_or_load_voxcpm() is enhanced  # 预热默认保持设置行为。
    assert studio.get_or_load_voxcpm(load_denoiser=False) is not enhanced
    studio.settings.disable_denoiser = True
    assert studio.get_or_load_voxcpm(load_denoiser=True) is studio.voxcpm_model
    assert calls[-1]["enable_denoiser"] is False


@pytest.mark.parametrize("batch", [False, True])
def test_single_and_batch_only_load_requested_denoiser(tmp_path, batch):
    studio, calls, generated = lightweight_studio(tmp_path)
    common = {"mode": "可控克隆", "control": "", "reference_audio": "reference.wav", "prompt_text": "",
              "selected_lora": "不使用 LoRA", "cfg_value": 2, "normalize": False, "denoise": False, "inference_timesteps": 10}
    def run():
        if batch:
            return studio.batch_generate_payload(**common, batch_text="甲\n乙", batch_file=None, output_prefix="test")
        return studio.generate_audio_payload(**common, text="甲")
    result = run()
    assert Path(result["archive_path"] if batch else result["output_path"]).is_file()
    assert len(calls) == 1 and calls[0]["enable_denoiser"] is False
    assert all(call["denoise"] is False for call in generated)
    common["denoise"] = True
    with pytest.raises(FileNotFoundError):
        run()  # 请求增强时真实加载失败必须传出错误，不静默跳过。
    studio.settings.zipenhancer_path = "valid-enhancer"
    run()
    assert calls[-1]["enable_denoiser"] is True
    assert generated[-1]["denoise"] is True
    studio.settings.disable_denoiser = True
    previous_count = len(calls)
    with pytest.raises(ValueError, match="系统设置中禁用"):
        run()
    assert len(calls) == previous_count  # 全局禁用与本次增强冲突在加载前报错。


@pytest.mark.parametrize("mode", ["可控克隆", "极致克隆"])
def test_reference_voice_without_generation_can_preview_reload_and_apply(setup, tmp_path, mode):
    client, studio, store = setup
    reference = tmp_path / "导入参考.wav"
    sf.write(reference, np.full(1200, .1), 24000)
    original = reference.read_bytes()
    config = {**DEFAULT_CONFIG, "mode": mode, "referenceAudio": str(reference), "promptText": "原参考文本"}
    response = client.post("/api/workspace/voices", json={"name": "直接收藏", "tags": ["参考音"],
        "config": config, "sampleText": "下次合成的文案"})
    assert response.status_code == 200
    voice = response.json()
    assert "previewAudio" not in voice and studio.calls == []
    reference.unlink()
    assert client.get(voice["previewUrl"]).content == original
    assert WorkspaceStore(store.root, studio).voices()["items"][0] == voice
    project = prepared(client)
    project["roles"][1]["config"] = voice["config"]
    project = client.put(f"/api/workspace/projects/{project['id']}", json=project).json()
    assert generate(client, project)["status"] == "succeeded"
    assert studio.calls[0]["reference_audio"] == voice["config"]["referenceAudio"]
    assert studio.calls[0]["mode"] == mode
    assert studio.calls[0]["prompt_text"] == "原参考文本"
    assert voice["sampleText"] == "下次合成的文案"


def test_edit_voice_keeps_id_and_applied_reference_and_replaces_old_preview(setup, tmp_path):
    client, studio, store = setup
    original, replacement, preview = [tmp_path / name for name in ("old.wav", "new.wav", "preview.wav")]
    for file, length in ((original, 1200), (replacement, 2400), (preview, 3600)):
        sf.write(file, np.zeros(length), 24000)
    config = {**DEFAULT_CONFIG, "mode": "极致克隆", "referenceAudio": str(original), "promptText": "原文本"}
    voice = client.post("/api/workspace/voices", json={"name": "原音色", "config": config, "previewAudio": str(preview)}).json()
    old_reference = Path(voice["config"]["referenceAudio"])
    project = prepared(client)
    project["roles"][0]["config"] = voice["config"]
    client.put(f"/api/workspace/projects/{project['id']}", json=project)
    config.update(referenceAudio=str(replacement), promptText="新参考文本", control="新描述", cfgValue=2.6)
    response = client.put(f"/api/workspace/voices/{voice['id']}", json={"name": "编辑后", "tags": ["修改"],
        "config": config, "previewAudio": "", "sampleText": "新文案"})
    assert response.status_code == 200
    edited = response.json()
    assert edited["id"] == voice["id"] and edited["createdAt"] == voice["createdAt"]
    assert edited["updatedAt"] and edited["name"] == "编辑后" and edited["tags"] == ["修改"]
    assert edited["sampleText"] == "新文案" and "previewAudio" not in edited and "designConfig" not in edited
    assert edited["config"]["promptText"] == "新参考文本" and edited["config"]["cfgValue"] == 2.6
    assert client.get(edited["previewUrl"]).content == replacement.read_bytes()
    assert Path(edited["config"]["referenceAudio"]).read_bytes() == replacement.read_bytes()
    assert old_reference.is_file() and Path(voice["previewAudio"]).is_file()
    assert client.get(f"/api/workspace/projects/{project['id']}").json()["roles"][0]["config"] == voice["config"]
    assert WorkspaceStore(store.root, studio).voices()["items"] == [edited]
    assert client.put("/api/workspace/voices/missing", json={"config": config}).status_code == 404


def test_edit_voice_failure_preserves_previous_record_and_files(setup, tmp_path, monkeypatch):
    client, studio, store = setup
    reference = tmp_path / "reference.wav"
    sf.write(reference, np.zeros(1200), 24000)
    config = {**DEFAULT_CONFIG, "mode": "可控克隆", "referenceAudio": str(reference)}
    voice = store.add_voice({"name": "原音色", "config": config})
    folders = set((store.root / "voices").iterdir())
    def fail():
        raise OSError("模拟磁盘失败")
    monkeypatch.setattr(store, "_save", fail)
    with pytest.raises(OSError, match="模拟磁盘失败"):
        store.update_voice(voice["id"], {"name": "不应保存", "config": config})
    assert store.voices()["items"] == [voice]
    assert WorkspaceStore(store.root, studio).voices()["items"] == [voice]
    assert set((store.root / "voices").iterdir()) == folders
    assert Path(voice["config"]["referenceAudio"]).is_file()
