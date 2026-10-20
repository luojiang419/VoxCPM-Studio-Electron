"""本地真实 HTTP 验证按需模型修复，不下载真实权重或运行 GPU。"""
import hashlib
import http.server
import json
import os
from pathlib import Path
import threading
import time
from types import SimpleNamespace

import pytest

from voxcpm.studio_resources import ensure_model_resources, verify_model_resources, verify_files, ResourceCancelled


@pytest.fixture
def download_server(monkeypatch):
    # 本组使用受控的本机 HTTP 服务器验证修复，不允许继承常规验收的离线标志。
    monkeypatch.delenv('VOXCPM_OFFLINE', raising=False)
    state = SimpleNamespace(data=b'good weights', mode='normal', requests=[])

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            offset = int(self.headers.get('Range', 'bytes=0-')[6:-1])
            state.requests.append((self.path, offset))
            if state.mode == 'failed':
                self.send_error(503)
                return
            body = b'x' * len(state.data) if state.mode == 'corrupt' else state.data
            if offset and state.mode != 'ignore-range':
                self.send_response(206)
                self.send_header('Content-Range', f'bytes {0 if state.mode == "bad-range" else offset}-{len(body)-1}/{len(body)}')
                body = body[offset:]
            else:
                self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    state.url = f'http://127.0.0.1:{server.server_port}/weights'
    yield state
    server.shutdown()
    server.server_close()
    worker.join(2)


def spec(server, name='comfy/diffusion_models/weights.safetensors'):
    return {'name': 'models/music/' + name, 'size': len(server.data), 'sha256': hashlib.sha256(server.data).hexdigest(), 'urls': [server.url]}


def catalog(asset):
    return {'models': [{'id': 'ace-xl-turbo', 'files': [asset]}, {'id': 'yue2', 'files': [{**asset, 'name': 'models/music/not-selected.bin'}]}]}


def repair(tmp_path, server, **kwargs):
    asset = spec(server)
    ensure_model_resources('ace-xl-turbo', root=tmp_path, catalog=catalog(asset), **kwargs)
    return tmp_path / asset['name']


@pytest.mark.parametrize('flag', ['VOXCPM_INSTALLED_RESOURCES_READONLY', 'VOXCPM_OFFLINE'])
def test_local_mode_reuses_complete_model_but_never_downloads_or_replaces(tmp_path, download_server, monkeypatch, flag):
    monkeypatch.setenv(flag, '1')
    file = tmp_path / spec(download_server)['name']
    with pytest.raises(RuntimeError, match='未下载或替换'):
        repair(tmp_path, download_server)
    assert not file.exists() and not download_server.requests
    file.parent.mkdir(parents=True)
    file.write_bytes(download_server.data)
    before = file.stat().st_mtime_ns
    repair(tmp_path, download_server)
    assert file.stat().st_mtime_ns == before and not download_server.requests
    file.write_bytes(b'x' * len(download_server.data))
    with pytest.raises(RuntimeError, match='未下载或替换'):
        repair(tmp_path, download_server)
    assert file.read_bytes() == b'x' * len(download_server.data) and not download_server.requests


def test_missing_file_auto_repairs_only_current_model_and_reuses_verified_file(tmp_path, download_server):
    events = []
    file = repair(tmp_path, download_server, progress=lambda *event: events.append(event))
    assert file.read_bytes() == download_server.data
    assert not (tmp_path / 'models/music/not-selected.bin').exists()
    assert len(download_server.requests) == 1
    repair(tmp_path, download_server)
    assert len(download_server.requests) == 1
    assert any('自动修复' in text for _, text in events) and events[-1][0] == 100


def test_custom_music_directory_is_used_for_status_validation_and_repair(tmp_path, download_server, monkeypatch):
    asset = spec(download_server)
    manifest = tmp_path / 'resources/app/music-config.json'
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps(catalog(asset)))
    custom = tmp_path / 'custom-music'
    file = custom / asset['name'].removeprefix('models/music/')
    file.parent.mkdir(parents=True)
    file.write_bytes(download_server.data)
    monkeypatch.setenv('VOXCPM_MUSIC_MODELS_ROOT', str(custom))
    verify_model_resources('ace-xl-turbo', root=tmp_path)
    ensure_model_resources('ace-xl-turbo', root=tmp_path)
    assert not download_server.requests
    file.write_bytes(b'x' * len(download_server.data))
    ensure_model_resources('ace-xl-turbo', root=tmp_path)
    assert file.read_bytes() == download_server.data
    assert not (tmp_path / asset['name']).exists()


def test_corrupt_hardlink_replacement_preserves_original_source(tmp_path, download_server):
    file = tmp_path / spec(download_server)['name']
    file.parent.mkdir(parents=True)
    original = tmp_path / 'shared-weights'
    original.write_bytes(b'x' * len(download_server.data))
    os.link(original, file)
    repair(tmp_path, download_server)
    assert file.read_bytes() == download_server.data
    assert original.read_bytes() == b'x' * len(download_server.data)


def test_cancel_keeps_partial_and_next_attempt_resumes(tmp_path, download_server):
    download_server.data = bytes(range(251)) * 12000
    cancelled = threading.Event()

    def progress(_, message):
        if '自动修复' in message and '0.0/' not in message:
            cancelled.set()

    with pytest.raises(ResourceCancelled, match='取消'):
        repair(tmp_path, download_server, progress=progress, cancelled=cancelled.is_set)
    file = tmp_path / spec(download_server)['name']
    partial = file.with_name(file.name + '.part')
    offset = partial.stat().st_size
    assert 0 < offset < len(download_server.data)
    assert not file.exists()
    assert not (tmp_path / 'data/.component-preparation.lock').exists()
    repair(tmp_path, download_server)
    assert download_server.requests[-1][1] == offset
    assert file.read_bytes() == download_server.data


@pytest.mark.parametrize('mode', ['ignore-range', 'bad-range'])
def test_server_resume_response_is_validated(tmp_path, download_server, mode):
    asset = spec(download_server)
    file = tmp_path / asset['name']
    file.parent.mkdir(parents=True)
    partial = file.with_name(file.name + '.part')
    partial.write_bytes(download_server.data[:3])
    download_server.mode = mode
    if mode == 'bad-range':
        with pytest.raises(RuntimeError, match='断点范围'):
            repair(tmp_path, download_server)
        assert partial.read_bytes() == download_server.data[:3]
        assert not file.exists()
    else:
        repair(tmp_path, download_server)
        assert file.read_bytes() == download_server.data


@pytest.mark.parametrize('mode', ['failed', 'corrupt'])
def test_failed_download_never_replaces_original_or_marks_ready(tmp_path, download_server, mode):
    asset = spec(download_server)
    file = tmp_path / asset['name']
    file.parent.mkdir(parents=True)
    file.write_bytes(b'x' * len(download_server.data))
    download_server.mode = mode
    with pytest.raises(RuntimeError, match='自动修复.*失败'):
        repair(tmp_path, download_server)
    assert file.read_bytes() == b'x' * len(download_server.data)
    cache = tmp_path / 'data/cache/model-verification.json'
    assert not cache.exists() or str(file.resolve()) not in json.loads(cache.read_text())
    assert not (tmp_path / 'data/.component-preparation.lock').exists()


def test_busy_component_preparation_and_disk_full_do_not_start_download(tmp_path, download_server, monkeypatch):
    lock = tmp_path / 'data/.component-preparation.lock'
    lock.parent.mkdir()
    lock.write_text(str(os.getpid()))
    with pytest.raises(RuntimeError, match='另一进程'):
        repair(tmp_path, download_server)
    assert not download_server.requests and lock.exists()
    lock.unlink()
    monkeypatch.setattr('voxcpm.studio_resources.shutil.disk_usage', lambda _: SimpleNamespace(free=0))
    with pytest.raises(RuntimeError, match='空间不足'):
        repair(tmp_path, download_server)
    assert not download_server.requests and not lock.exists()


def test_unreadable_file_does_not_trigger_destructive_redownload(tmp_path, download_server, monkeypatch):
    file = tmp_path / spec(download_server)['name']
    file.parent.mkdir(parents=True)
    file.write_bytes(download_server.data)
    original = Path.open

    def restricted(path, *args, **kwargs):
        if path == file:
            raise PermissionError('access denied')
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'open', restricted)
    with pytest.raises(RuntimeError, match='文件权限'):
        repair(tmp_path, download_server)
    assert not download_server.requests


def test_path_and_download_scheme_are_rejected(tmp_path, download_server):
    asset = spec(download_server)
    with pytest.raises(ValueError, match='越界'):
        ensure_model_resources('ace-xl-turbo', root=tmp_path, catalog=catalog({**asset, 'name': 'models/music/../../escape'}))
    with pytest.raises(ValueError, match='HTTPS'):
        ensure_model_resources('ace-xl-turbo', root=tmp_path, catalog=catalog({**asset, 'urls': ['file:///unsafe']}))
    assert not download_server.requests


def test_access_time_change_is_not_treated_as_model_corruption(tmp_path, monkeypatch):
    file = tmp_path / 'weights'
    file.write_bytes(b'good weights')
    expected = {'name': file.name, 'size': 12, 'sha256': hashlib.sha256(b'good weights').hexdigest()}
    original = Path.stat
    reads = []

    class AccessTimeChanged:
        def __init__(self, stat, atime):
            self.stat = stat
            self.st_atime = atime

        def __getattr__(self, key):
            return getattr(self.stat, key)

    def observed(path, *args, **kwargs):
        stat = original(path, *args, **kwargs)
        if path == file:
            reads.append(1)
            return AccessTimeChanged(stat, stat.st_atime + len(reads))
        return stat

    monkeypatch.setattr(Path, 'stat', observed)
    verify_files([expected], tmp_path, tmp_path / 'cache.json')
    assert len(reads) >= 2
    assert str(file.resolve()) in json.loads((tmp_path / 'cache.json').read_text())


def test_missing_file_auto_repair_continues_original_api_task(tmp_path, download_server, monkeypatch):
    import numpy as np
    import soundfile as sf
    from fastapi.testclient import TestClient
    from voxcpm.studio_api import create_api_app

    monkeypatch.delenv('VOXCPM_DATA_ROOT', raising=False)
    monkeypatch.delenv('VOXCPM_PROJECT_ROOT', raising=False)
    studio = SimpleNamespace(runtime_summary_payload=lambda: {'data_root': str(tmp_path)}, settings_payload=lambda: {'output_dir': str(tmp_path / 'outputs')},
        training_status_payload=lambda: {'running': False}, reset_runtime=lambda: None)
    app = create_api_app(studio)
    service = app.state.music
    asset = spec(download_server)
    service.root = tmp_path
    service.models = tmp_path / 'custom/music'
    service.engine = tmp_path / 'runtime/music'
    service.catalog = {'runtime': {'sha256': 'fixture'}, 'models': [{'id': 'ace-xl-turbo', 'label': 'ACE', 'files': [asset]}]}
    (service.engine / 'python').mkdir(parents=True)
    (service.engine / 'python/python.exe').touch()
    (service.engine / 'ready.json').write_text('{"sha256":"fixture"}')
    (tmp_path / 'component-selection.json').write_text(json.dumps({'selected': ['ace-xl-turbo'], 'removed': [], 'defaultModel': 'ace-xl-turbo'}))
    rendered = []

    def inference(packet, output, *args):
        file = service.models / asset['name'].removeprefix('models/music/')
        assert file.read_bytes() == download_server.data
        rendered.append(packet['draft']['title'])
        sf.write(output, np.zeros(2400), 24000)
        return {'fixture': True}

    monkeypatch.setattr(service, '_comfy', inference)
    with TestClient(app) as client:
        model = client.get('/api/music/status').json()['models'][0]
        assert model['selected'] and not model['installed'] and not model['ready']
        response = client.post('/api/music/generate', json={'brief': {'title': '原来的作品名', 'lyrics': '保留歌词'}, 'autoOptimize': False,
            'draft': {'caption': 'piano', 'lyrics': '保留歌词'}})
        assert response.status_code == 200, response.text
        identity = response.json()['taskId']
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            task = client.get('/api/tasks/' + identity).json()
            if task['status'] in {'succeeded', 'failed', 'cancelled'}:
                break
            time.sleep(.01)
        assert task['status'] == 'succeeded', task
        assert rendered == ['原来的作品名']
        assert task['result']['packet']['draft']['lyrics'] == '保留歌词'
        assert client.get('/api/music/status').json()['models'][0]['ready']
        assert len(download_server.requests) == 1
        assert not service.active
        assert not (tmp_path / asset['name']).exists()  # 没有下载到错误的默认目录。
