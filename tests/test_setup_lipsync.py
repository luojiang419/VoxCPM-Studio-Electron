"""验证追加模型不会覆盖另一版本；下载与第三方依赖使用显式替身。"""
import importlib.util
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace

import pytest


@pytest.fixture
def installer(tmp_path, monkeypatch):
    script = Path(__file__).resolve().parents[1] / "scripts/setup_lipsync.py"
    spec = importlib.util.spec_from_file_location("setup_lipsync_test", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    (tmp_path / "source").mkdir()
    calls = []
    def download(repo, filename, *, revision, local_dir):
        target = local_dir / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"test weight")
        calls.append((repo, revision, target))
        return str(target)
    import huggingface_hub
    import torch
    monkeypatch.setattr(huggingface_hub, "hf_hub_download", download)
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(torch.cuda, "get_device_name", lambda *a: "fixture GPU")
    for name in ("insightface", "insightface.app", "latentsync", "latentsync.pipelines", "latentsync.pipelines.lipsync_pipeline"):
        monkeypatch.setitem(sys.modules, name, ModuleType(name))
    sys.modules["insightface.app"].FaceAnalysis = lambda **kwargs: SimpleNamespace(prepare=lambda **k: None)
    sys.modules["latentsync.pipelines.lipsync_pipeline"].LipsyncPipeline = object
    return module, calls


@pytest.mark.parametrize("total,expected", [(12288, "1.5"), (16384, "1.6")])
def test_install_auto_selects_one_weight_without_replacing_other_manifest(installer, tmp_path, monkeypatch, total, expected):
    module, calls = installer
    monkeypatch.setattr(module, "detect_hardware", lambda: {"cuda": True, "name": "fixture", "totalMB": total, "freeMB": total})
    existing = '{"version":"1.5","resolution":256,"validation":{"result":"passed"}}'
    (tmp_path / "runtime.json").write_text(existing, encoding="utf-8")
    module.download(tmp_path)
    weights = [call for call in calls if call[2].name == "latentsync_unet.pt"]
    assert len(weights) == 1 and weights[0][0] == "ByteDance/LatentSync-" + expected
    assert weights[0][2] == tmp_path / "source" / module.PROFILES[expected]["checkpoint"]
    assert (tmp_path / "runtime.json").read_text(encoding="utf-8") == existing
    manifest = json.loads((tmp_path / f"runtime-{expected}.json").read_text(encoding="utf-8"))
    assert manifest["version"] == expected
    if expected == "1.5":
        assert manifest["validation"] == {"result": "passed"}


def test_install_both_uses_distinct_weight_paths(installer, tmp_path, monkeypatch):
    module, calls = installer
    monkeypatch.setattr(module, "detect_hardware", lambda: {"cuda": True, "name": "fixture", "totalMB": 16384, "freeMB": 15000})
    module.download(tmp_path, "both")
    weights = [call[2] for call in calls if call[2].name == "latentsync_unet.pt"]
    assert len(set(weights)) == 2
    assert module.load_manifest(tmp_path, "1.5") and module.load_manifest(tmp_path, "1.6")


def test_unsupported_hardware_stops_before_weight_download(installer, tmp_path, monkeypatch):
    module, calls = installer
    monkeypatch.setattr(module, "detect_hardware", lambda: {"cuda": False})
    with pytest.raises(RuntimeError, match="CUDA"):
        module.download(tmp_path)
    assert not calls and not (tmp_path / "runtime.json").exists()
