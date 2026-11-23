from __future__ import annotations

import json
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from voxcpm.studio_api import create_api_app
from voxcpm.studio_lipsync import LipSyncCancelled, LipSyncOutOfMemory, LipSyncService
from voxcpm.lipsync_profiles import PROFILES, select_profile
from voxcpm import lipsync_profiles


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.delenv("VOXCPM_LIPSYNC_ROOT", raising=False)
    root = tmp_path / "lipsync"
    required = ["env/Scripts/python.exe", "source/configs/unet/stage2.yaml",
                "source/checkpoints/latentsync-1.5/latentsync_unet.pt", "source/checkpoints/whisper/tiny.pt",
                "source/checkpoints/vae/config.json", "source/checkpoints/vae/diffusion_pytorch_model.safetensors",
                "source/checkpoints/auxiliary/models/buffalo_l/det_10g.onnx",
                "source/checkpoints/auxiliary/models/buffalo_l/2d106det.onnx"]
    for name in required:
        file = root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b"fixture")
    (root / "runtime.json").write_text(json.dumps({"version": "1.5", "resolution": 256}), encoding="utf-8")
    studio = SimpleNamespace(runtime_summary_payload=lambda: {"data_root": str(tmp_path), "ffmpeg_path": shutil.which("ffmpeg")},
                             settings_payload=lambda: {"output_dir": str(tmp_path / "outputs")})
    service = LipSyncService(tmp_path, studio)
    monkeypatch.setattr(LipSyncService, "hardware", lambda self: {"cuda": True, "name": "fixture 16GB", "totalMB": 16384, "freeMB": 14336})
    monkeypatch.setattr(LipSyncService, "preparation_ready", lambda *args: True)
    return service


def test_profile_and_invalid_configuration_preserve_working_root(service, tmp_path):
    assert service.status()["ready"] and service.status()["engine"] == "LatentSync 1.5"
    root = service.root()
    invalid = tmp_path / "旧版本"
    invalid.mkdir()
    with pytest.raises(ValueError, match="1.5"):
        service.configure(str(invalid))
    assert service.root() == root and not service.config_path.exists()
    manifest = root / "runtime.json"
    manifest.write_text('{"version":"1.6","resolution":512}', encoding="utf-8")
    assert not service.status()["ready"]
    manifest.write_text("{broken", encoding="utf-8")
    assert not service.status()["ready"]


def test_missing_ffprobe_is_not_reported_ready(service, monkeypatch):
    monkeypatch.setattr(service, "ffprobe", lambda *args: "")
    assert not service.status()["ready"] and "ffprobe.exe" in service.status()["missing"]


def test_process_decodes_utf8_and_invalid_bytes_without_losing_progress(service, tmp_path):
    progress = []
    code = "import sys;sys.stdout.buffer.write(b'bad: \\xff\\n');print('__VOXCPM_LIPSYNC__'+__import__('json').dumps({'progress':37,'text':'中文进度'}))"
    with (tmp_path / "进度.log").open("w", encoding="utf-8") as log:
        service._process([sys.executable, "-c", code], tmp_path, lambda *args: progress.append(args), lambda: False, log, 10)
    assert progress == [(37, "中文进度")]
    assert "�" in (tmp_path / "进度.log").read_text(encoding="utf-8")


def test_cancel_terminates_running_subprocess(service, tmp_path):
    started = time.monotonic()
    with (tmp_path / "cancel.log").open("w", encoding="utf-8") as log:
        with pytest.raises(LipSyncCancelled):
            service._process([sys.executable, "-c", "import time;print('started',flush=True);time.sleep(60)"], tmp_path,
                             lambda *args: None, lambda: time.monotonic() - started > .3, log, 10)
    assert time.monotonic() - started < 8


@pytest.mark.parametrize("duration", [0, .1, 121, float("nan")])
def test_invalid_audio_duration_rejected(service, tmp_path, monkeypatch, duration):
    source, audio = tmp_path / "人物.mp4", tmp_path / "配音.wav"
    source.touch(); audio.touch()
    monkeypatch.setattr(service, "probe", lambda file: {"streams": [{"codec_type": "video" if file == source else "audio"}], "format": {"duration": duration}})
    with pytest.raises(ValueError, match="0.32"):
        service.validate(SimpleNamespace(mode="video", source_path=str(source), audio_path=str(audio)))


def media(tmp_path, portrait=False):
    source, audio = tmp_path / "人物 视频 & 素材.mp4", tmp_path / "中文 配音.wav"
    size = "1080x1920" if portrait else "160x96"
    subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=blue:s={size}:r=25",
                    "-t", "0.12", "-pix_fmt", "yuv420p", str(source)], check=True, capture_output=True)
    sf.write(audio, np.zeros(17280), 24000)
    return source, audio


def cpu_runner(service, monkeypatch):
    original = service._process
    def process(command, work, *args):
        if "--root" in command:
            shutil.copyfile(work / "input.mp4", work / "synced.mp4")
            version = command[command.index("--model-version") + 1]
            (work / "inference.json").write_text(json.dumps({"engine": f"LatentSync {version}", "resolution": PROFILES[version]["resolution"]}), encoding="utf-8")
        else:
            return original(command, work, *args)
    monkeypatch.setattr(service, "_process", process)


@pytest.mark.parametrize("short_video", ["loop", "hold"])
def test_real_ffmpeg_duration_portrait_audio_and_persistence(service, tmp_path, monkeypatch, short_video):
    source, audio = media(tmp_path, portrait=True)
    cpu_runner(service, monkeypatch)
    payload = SimpleNamespace(mode="video", model_version="1.5", source_path=str(source), audio_path=str(audio), short_video=short_video, steps=20, guidance=1.5, seed=1247)
    result = service.generate(payload, lambda *args: None, lambda: False)
    assert not service.active and service.results() == [result]
    metadata = service.probe(Path(result["outputPath"]))
    video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    assert (video["width"], video["height"]) == (1080, 1920)
    assert video["r_frame_rate"] == "25/1" and abs(result["duration"] - .72) <= .04
    assert any(stream["codec_type"] == "audio" for stream in metadata["streams"])
    assert LipSyncService(tmp_path, service.studio).results() == [result]


@pytest.mark.parametrize("cancel", [False, True])
def test_copy_failure_or_late_cancel_cannot_publish_partial_video(service, tmp_path, monkeypatch, cancel):
    source, audio = media(tmp_path)
    cpu_runner(service, monkeypatch)
    payload = SimpleNamespace(mode="video", model_version="1.5", source_path=str(source), audio_path=str(audio), short_video="loop", steps=20, guidance=1.5, seed=1247)
    cancelled = False
    original = shutil.copy2
    def copy(source, target, *args, **kwargs):
        nonlocal cancelled
        if Path(target).name.endswith(".pending.mp4"):
            Path(target).write_bytes(b"partial")
            if cancel:
                cancelled = True
            else:
                raise OSError("磁盘写入失败")
        else:
            return original(source, target, *args, **kwargs)
    monkeypatch.setattr(shutil, "copy2", copy)
    if cancel:
        assert service.generate(payload, lambda *args: None, lambda: cancelled)["cancelled"]
    else:
        with pytest.raises(OSError, match="磁盘"):
            service.generate(payload, lambda *args: None, lambda: cancelled)
    assert not service.active and service.results() == []
    assert not list((tmp_path / "outputs/lipsync").glob("*.mp4"))


def test_training_rejection_releases_active_state(service):
    service.studio.training_status_payload = lambda: {"running": True}
    with pytest.raises(ValueError, match="训练"):
        service.generate(None, lambda *args: None, lambda: False)
    assert not service.active


def test_video_queue_cancel_and_gpu_conflicts(service, monkeypatch):
    studio = service.studio
    app = create_api_app(studio)
    lipsync = app.state.lipsync
    monkeypatch.setattr(lipsync, "status", lambda **kwargs: {"ready": True})
    monkeypatch.setattr(lipsync, "validate", lambda payload: None)
    started = threading.Event()
    def generate(payload, progress, cancelled):
        started.set()
        while not cancelled():
            time.sleep(.01)
        return {"cancelled": True}
    monkeypatch.setattr(lipsync, "generate", generate)
    with TestClient(app) as client:
        body = {"mode": "video", "sourcePath": "test.mp4", "audioPath": "test.wav"}
        response = client.post("/api/lipsync/generate", json=body)
        assert response.status_code == 200 and started.wait(2)
        task_id = response.json()["taskId"]
        assert client.post(f"/api/tasks/{task_id}/cancel").status_code == 200
        for _ in range(200):
            state = client.get(f"/api/tasks/{task_id}").json()
            if state["status"] == "cancelled":
                break
            time.sleep(.01)
        assert state["status"] == "cancelled"
        lipsync.active = True
        assert client.post("/api/asr/recognize", json={"audioPath": "test.wav"}).status_code == 409
        assert client.post("/api/training/start", json={"pretrainedPath":"model","trainManifest":"train.jsonl","valManifest":"val.jsonl"}).status_code == 409


@pytest.mark.parametrize("total,free,installed,requested,expected", [
    (6144, 6000, ["1.5", "1.6"], "auto", ""),
    (8192, 7000, ["1.5", "1.6"], "auto", "1.5"),
    (10240, 9000, ["1.5", "1.6"], "auto", "1.5"),
    (12288, 11000, ["1.5", "1.6"], "auto", "1.5"),
    (14336, 13000, ["1.5", "1.6"], "auto", "1.5"),
    (16380, 9000, ["1.5", "1.6"], "auto", "1.6"),
    (24576, 16000, ["1.5", "1.6"], "auto", "1.6"),
    (16384, 6000, ["1.5", "1.6"], "auto", "1.6"),
    (16384, 5000, ["1.6"], "auto", "1.6"),
    (16384, 9000, ["1.5"], "auto", "1.5"),
    (12288, 11000, ["1.6"], "auto", ""),
    (16384, 9000, ["1.5", "1.6"], "1.5", "1.5"),
    (12288, 11000, ["1.5", "1.6"], "1.6", ""),
    (16384, 9000, ["1.5"], "1.6", ""),
])
def test_hardware_selection_boundaries(total, free, installed, requested, expected):
    selected, reason = select_profile({"cuda": True, "totalMB": total, "freeMB": free}, installed, requested)
    assert selected == expected and reason


def test_no_cuda_does_not_choose_cpu_or_integrated_gpu():
    assert select_profile({"cuda": False, "totalMB": 32768, "freeMB": 32768}, ["1.5", "1.6"])[0] == ""


def test_wddm_memory_matches_visible_device_by_uuid_and_uses_lower_value(monkeypatch):
    import torch
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(torch.version, "hip", None)
    monkeypatch.setattr(torch.cuda, "mem_get_info", lambda device: (15 * 1024 ** 3, 16 * 1024 ** 3))
    monkeypatch.setattr(torch.cuda, "get_device_properties", lambda device: SimpleNamespace(uuid="bbb"))
    monkeypatch.setattr(torch.cuda, "get_device_name", lambda device: "second visible GPU")
    monkeypatch.setattr(lipsync_profiles.shutil, "which", lambda name: "nvidia-smi")
    monkeypatch.setattr(lipsync_profiles.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0, stdout="GPU-aaa, 24000\nGPU-bbb, 5000\n"))
    detected = lipsync_profiles.detect_hardware()
    assert detected["freeMB"] == 5000 and detected["cudaFreeMB"] == 15360
    assert select_profile(detected, ["1.5", "1.6"])[0] == "1.6"


def test_low_free_memory_rejected_before_starting_media_processing(service, tmp_path, monkeypatch):
    source, audio = media(tmp_path)
    monkeypatch.setattr(service, "hardware", lambda: {"cuda": True, "totalMB": 16384, "freeMB": 3000})
    monkeypatch.setattr(service, "_process", lambda *args: pytest.fail("低空闲显存不应启动子进程"))
    payload = SimpleNamespace(mode="video", model_version="1.5", source_path=str(source), audio_path=str(audio), short_video="loop", steps=20, guidance=1.5, seed=1247)
    with pytest.raises(ValueError, match="空闲显存"):
        service.generate(payload, lambda *args: None, lambda: False)
    assert not service.active


def test_selection_rechecks_after_tts_unloads(service, tmp_path, monkeypatch):
    install_16(service)
    source, audio = media(tmp_path)
    cpu_runner(service, monkeypatch)
    hardware = {"cuda": True, "totalMB": 16384, "freeMB": 5000}
    monkeypatch.setattr(service, "hardware", lambda: dict(hardware))
    service.studio.reset_runtime = lambda: hardware.update(freeMB=14000)
    assert service.status()["selectedVersion"] == "1.6"
    payload = SimpleNamespace(mode="video", source_path=str(source), audio_path=str(audio), short_video="loop", steps=20, guidance=1.5, seed=1247)
    result = service.generate(payload, lambda *args: None, lambda: False)
    assert result["report"]["selectedVersion"] == "1.6" and result["report"]["resolution"] == 512


def install_16(service):
    root = service.root()
    for name in ("config", "checkpoint"):
        target = root / "source" / PROFILES["1.6"][name]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"fixture")
    (root / "runtime-1.6.json").write_text(json.dumps({"version": "1.6", "resolution": 512}), encoding="utf-8")


def test_versioned_manifest_and_manual_api_validation(service):
    install_16(service)
    with TestClient(create_api_app(service.studio)) as client:
        assert client.get("/api/lipsync/status").json()["selectedVersion"] == "1.6"
        assert client.get("/api/lipsync/status?modelVersion=1.5").json()["selectedVersion"] == "1.5"
        assert client.get("/api/lipsync/status?modelVersion=2.0").status_code == 422
        assert client.post("/api/lipsync/generate", json={"modelVersion": "2.0", "sourcePath": "a.mp4", "audioPath": "b.wav"}).status_code == 422
    (service.root() / "runtime-1.6.json").write_text(json.dumps({"version": "1.6", "resolution": 512, "checkpoint": PROFILES["1.5"]["checkpoint"]}), encoding="utf-8")
    assert service.status()["selectedVersion"] == "1.5"
    assert not service.status(model_version="1.6")["ready"]


@pytest.mark.parametrize("requested,failure", [
    ("auto", LipSyncOutOfMemory), ("1.6", LipSyncOutOfMemory),
    ("auto", RuntimeError),
])
def test_failure_stops_without_retry_or_version_change(service, tmp_path, monkeypatch, requested, failure):
    install_16(service)
    source, audio = media(tmp_path)
    cpu_runner(service, monkeypatch)
    original = service._process
    calls = []
    def process(command, work, *args):
        if "--model-version" in command:
            version = command[command.index("--model-version") + 1]
            calls.append(version)
            if version == "1.6":
                (work / "synced.mp4").write_bytes(b"partial")
                raise failure("CUDA out of memory" if failure is LipSyncOutOfMemory else "bad media")
            assert not (work / "synced.mp4").exists()
        return original(command, work, *args)
    monkeypatch.setattr(service, "_process", process)
    payload = SimpleNamespace(mode="video", model_version=requested, source_path=str(source), audio_path=str(audio), short_video="loop", steps=20, guidance=1.5, seed=1247)
    with pytest.raises(failure) as caught:
        service.generate(payload, lambda *args: None, lambda: False)
    if failure is LipSyncOutOfMemory:
        assert "1.6" in str(caught.value) and "保留模型选择" in str(caught.value)
    assert calls == ["1.6"] and not service.results()
    assert service.status(model_version=requested)["selectedVersion"] == "1.6"
    assert not service.active


def test_16gb_low_free_memory_preserves_16_and_does_not_start_15(service, tmp_path, monkeypatch):
    install_16(service)
    source, audio = media(tmp_path)
    monkeypatch.setattr(service, "hardware", lambda: {"cuda": True, "totalMB": 16384, "freeMB": 5000})
    monkeypatch.setattr(service, "_process", lambda *args: pytest.fail("显存不足时不应启动任何模型"))
    assert service.status()["selectedVersion"] == "1.6"
    payload = SimpleNamespace(mode="video", source_path=str(source), audio_path=str(audio), short_video="loop", steps=20, guidance=1.5, seed=1247)
    with pytest.raises(ValueError, match="1.6.*空闲显存不足"):
        service.generate(payload, lambda *args: None, lambda: False)
    assert service.status()["selectedVersion"] == "1.6" and not service.results() and not service.active


def test_cuda_oom_from_real_subprocess_is_typed(service, tmp_path):
    with (tmp_path / "oom.log").open("w", encoding="utf-8") as log:
        with pytest.raises(LipSyncOutOfMemory):
            service._process([sys.executable, "-c", "raise RuntimeError('CUDA out of memory')"], tmp_path,
                             lambda *args: None, lambda: False, log, 10)
