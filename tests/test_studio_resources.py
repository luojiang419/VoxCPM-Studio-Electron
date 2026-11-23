import hashlib
import json
from pathlib import Path

import pytest
from voxcpm.studio_resources import verify_files, verify_model_resources


def asset(name, data=b'weights'):
    return {'name': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


@pytest.mark.parametrize('flag', ['VOXCPM_INSTALLED_RESOURCES_READONLY', 'VOXCPM_OFFLINE'])
def test_local_model_directory_never_falls_back_to_hub_download(tmp_path, monkeypatch, flag):
    from voxcpm import studio_app
    monkeypatch.setenv(flag, '1')
    monkeypatch.setattr(studio_app, 'PROJECT_ROOT', tmp_path)
    service = object.__new__(studio_app.VoxCPMStudio)
    monkeypatch.setattr(service, 'try_modelscope_download', lambda *_: pytest.fail('不能回退到魔搭下载'))
    local = tmp_path / 'installed-model'
    local.mkdir()
    assert service.ensure_model_directory(str(local)) == str(local)
    with pytest.raises(RuntimeError, match='未创建新模型目录或发起下载'):
        service.ensure_model_directory('missing/offline-model')
    assert not (tmp_path / 'models').exists()


def test_verifies_only_requested_model_and_invalidates_changed_file(tmp_path, monkeypatch):
    monkeypatch.delenv('VOXCPM_RUNTIME_CONFIG', raising=False)
    spec = asset('models/music/selected.bin')
    manifest = tmp_path / 'resources/app/music-config.json'
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({'models': [{'id': 'selected', 'files': [spec]}, {'id': 'other', 'files': [asset('missing.bin')]}]}))
    file = tmp_path / spec['name']
    file.parent.mkdir(parents=True)
    file.write_bytes(b'weights')
    verify_model_resources('selected', root=tmp_path)
    cache = tmp_path / 'data/cache/model-verification.json'
    assert str(file.resolve()) in json.loads(cache.read_text())
    with monkeypatch.context() as patch:
        patch.setattr(Path, 'open', lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('不能重复读取权重')) if _args[0] == file else original(*_args, **_kwargs))
        verify_model_resources('selected', root=tmp_path)
    file.write_bytes(b'corrupt')
    with pytest.raises(ValueError, match='模型资源缺失或损坏'):
        verify_model_resources('selected', root=tmp_path)


original = Path.open


def test_missing_cancelled_and_escape_do_not_write_ready_cache(tmp_path):
    cache = tmp_path / 'cache.json'
    with pytest.raises(ValueError, match='模型资源缺失'):
        verify_files([asset('missing')], tmp_path, cache)
    with pytest.raises(RuntimeError, match='取消'):
        verify_files([asset('weights')], tmp_path, cache, lambda: True)
    with pytest.raises(ValueError, match='越界'):
        verify_files([asset('../escape')], tmp_path, cache)
    assert not cache.exists()


def test_speech_checks_only_requested_kind(tmp_path, monkeypatch):
    manifest = tmp_path / 'runtime-config.json'
    manifest.write_text(json.dumps({'models': [{'folder': 'tts', 'files': [asset('missing')]}, {'folder': 'asr', 'files': [asset('model.bin')]}]}))
    monkeypatch.setenv('VOXCPM_RUNTIME_CONFIG', str(manifest))
    monkeypatch.delenv('VOXCPM_MODELS_ROOT', raising=False)
    file = tmp_path / 'models/asr/model.bin'
    file.parent.mkdir(parents=True)
    file.write_bytes(b'weights')
    verify_model_resources(1, root=tmp_path)
    with pytest.raises(ValueError, match='模型资源缺失'):
        verify_model_resources(0, root=tmp_path)
