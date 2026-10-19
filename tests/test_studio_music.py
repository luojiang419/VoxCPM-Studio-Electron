import sys
import io
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from voxcpm.studio_api import create_api_app
from voxcpm.music_prompts import MusicBrief, compile_packet
from voxcpm.studio_music import MusicCancelled, MusicService, music_filename


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr("voxcpm.studio_music.verify_model_resources", lambda *_args, **_kwargs: None)
    monkeypatch.delenv('VOXCPM_DATA_ROOT', raising=False)
    monkeypatch.delenv('VOXCPM_PROJECT_ROOT', raising=False)
    studio = SimpleNamespace(runtime_summary_payload=lambda: {'data_root': str(tmp_path)}, settings_payload=lambda: {'output_dir': str(tmp_path / 'outputs')},
        training_status_payload=lambda: {'running': False}, reset_runtime=lambda: None)
    app = create_api_app(studio)
    return TestClient(app), app, studio


def await_task(client, path, identity):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        response = client.get(path + identity); assert response.status_code == 200
        value = response.json()
        if value['status'] in {'succeeded', 'failed', 'cancelled'}:
            return value
        time.sleep(.01)
    raise AssertionError('任务未结束')


def ready_status():
    return {'models': [{'id': name, 'ready': True} for name in ['ace-xl-turbo', 'minimax-music3', 'yue2', 'heartmula']]}


def test_catalog_exposes_actual_official_sources_and_missing_models_need_preparation(setup):
    client, app, studio = setup
    response = client.get('/api/music/status'); assert response.status_code == 200
    value = response.json(); assert len(value['rules']['models']) == 4
    assert next(m for m in value['rules']['models'] if m['id'] == 'heartmula')['kind'] == 'official-docs'
    assert client.post('/api/music/generate', json={'brief': {'idea': '中文音乐'}}).status_code == 400
    assert not app.state.music.active


def test_compose_uses_separate_queue_and_surfaces_missing_assistant(setup):
    client, app, _ = setup
    response = client.post('/api/music/compose', json={'idea': '史诗中文歌曲'})
    assert response.status_code == 200
    state = await_task(client, '/api/music/prompt-tasks/', response.json()['taskId'])
    assert state['status'] == 'failed' and '助手' in state['error']
    assert not app.state.music.active


def test_manual_generation_retains_real_inputs_history_and_seekable_audio(setup, monkeypatch):
    client, app, _ = setup
    monkeypatch.setattr(app.state.music, 'status', ready_status)
    monkeypatch.setitem(sys.modules, 'torch', None)
    def render(packet, output, progress, cancelled, run):
        assert packet['inputs']['lyrics'] == '[Verse]\n我的中文歌词'
        sf.write(output, np.zeros(24000), 24000)
        return {'normalizationGain': 1}
    monkeypatch.setattr(app.state.music, '_comfy', render)
    body = {'brief': {'idea': '史诗', 'lyrics': '[Verse]\n我的中文歌词'}, 'autoOptimize': False,
            'draft': {'title': '火种', 'caption': 'Cinematic strings and brass', 'lyrics': '[Verse]\n我的中文歌词', 'metadata': {'bpm': 92, 'keyScale': 'D minor'}}}
    response = client.post('/api/music/generate', json=body); assert response.status_code == 200, response.text
    state = await_task(client, '/api/tasks/', response.json()['taskId'])
    assert state['status'] == 'succeeded', state
    result = state['result']; assert result['title'] == '火种' and result['report']['elapsedSeconds'] >= 0
    assert Path(result['outputPath']).name == '火种.wav'
    assert result['fileName'] == '火种.wav'
    assert result['packet']['inputs']['bpm'] == 92
    assert client.get('/api/music/results').json()['items'][0]['outputPath'] == result['outputPath']
    audio = client.get(result['previewUrl'], headers={'Range': 'bytes=0-63'})
    assert audio.status_code == 206 and len(audio.content) == 64
    assert not app.state.music.active


@pytest.mark.parametrize('title,expected', [('星火·和平', '星火·和平.wav'), ('CON', '_CON.wav'),
    ('夜曲.wav', '夜曲.wav'), ('第一章:火/水?', '第一章_火_水_.wav'), (' . ', '未命名音乐.wav')])
def test_music_filename_is_identifiable_and_valid_on_windows(title, expected):
    assert music_filename(title) == expected


def test_same_named_songs_keep_distinct_files_and_user_title_wins(setup, monkeypatch):
    client, app, _ = setup
    monkeypatch.setattr(app.state.music, 'status', ready_status)
    monkeypatch.setitem(sys.modules, 'torch', None)
    def render(packet, output, *args):
        sf.write(output, np.zeros(2400), 24000); return {}
    monkeypatch.setattr(app.state.music, '_comfy', render)
    body = {'brief': {'title': '用户歌曲名', 'lyrics': '中文歌词'}, 'autoOptimize': False,
        'draft': {'title': 'AI建议名称', 'caption': 'piano', 'lyrics': '中文歌词'}}
    results = []
    for _ in range(2):
        response = client.post('/api/music/generate', json=body)
        state = await_task(client, '/api/tasks/', response.json()['taskId'])
        assert state['status'] == 'succeeded', state
        results.append(state['result'])
    assert results[0]['outputPath'] != results[1]['outputPath']
    for result in results:
        assert result['title'] == '用户歌曲名'
        assert Path(result['outputPath']).name == '用户歌曲名.wav' and Path(result['outputPath']).is_file()


@pytest.mark.parametrize('outcome', ['success', 'failure', 'cancelled'])
def test_automatic_comfy_process_is_stopped_on_every_exit(setup, monkeypatch, tmp_path, outcome):
    _, app, _ = setup; service = app.state.music
    monkeypatch.setattr(service, '_free_idle_comfy', lambda *args: None)
    packet = compile_packet(MusicBrief(lyrics='中文歌词'), {'caption': 'piano', 'lyrics': '中文歌词'})
    child = SimpleNamespace(poll=lambda: None)
    stopped = []
    monkeypatch.setattr('voxcpm.studio_music.subprocess.Popen', lambda *args, **kwargs: child)
    monkeypatch.setattr(service, '_stop', stopped.append)
    cancel = threading.Event()
    def http(base, route, body=None, timeout=15):
        assert not route.startswith('/object_info/'), '默认应启动自己的进程，不自动复用外部服务'
        if route == '/queue': return {'queue_running': [], 'queue_pending': []}
        if route == '/prompt':
            if outcome == 'cancelled': cancel.set()
            return {'prompt_id': 'ours'}
        if route == '/history/ours':
            if outcome == 'failure': return {'ours': {'status': {'status_str': 'error', 'messages': ['inference failed']}}}
            return {'ours': {'outputs': {'save': {'audio': [{'filename': 'test.wav', 'subfolder': '', 'type': 'output'}]}}}}
        return {}
    monkeypatch.setattr(service, '_http', http)
    data = io.BytesIO(); sf.write(data, np.zeros(2400), 24000, format='WAV'); raw = data.getvalue()
    monkeypatch.setattr('urllib.request.urlopen', lambda *args, **kwargs: io.BytesIO(raw))
    if outcome == 'success':
        service._comfy(packet, tmp_path / '曲名.wav', lambda *_: None, cancel.is_set, tmp_path)
        assert (tmp_path / '曲名.wav').is_file()
    else:
        with pytest.raises(MusicCancelled if outcome == 'cancelled' else RuntimeError):
            service._comfy(packet, tmp_path / '曲名.wav', lambda *_: None, cancel.is_set, tmp_path)
    assert stopped == [child]


def test_cancel_queued_music_releases_reserved_state(setup, monkeypatch):
    client, app, _ = setup
    monkeypatch.setattr(app.state.music, 'status', ready_status)
    gate, started = threading.Event(), threading.Event()
    def block():
        started.set(); gate.wait(3); return {'status': 'complete'}
    app.state.task_queue.submit('fixture', 'block', block); assert started.wait(1)
    response = client.post('/api/music/generate', json={'brief': {'lyrics': '中文歌词'}, 'autoOptimize': False, 'draft': {'caption': 'piano', 'lyrics': '中文歌词'}})
    assert response.status_code == 200 and app.state.music.active
    identity = response.json()['taskId']
    assert client.post('/api/tasks/' + identity + '/cancel').status_code == 200
    gate.set(); assert await_task(client, '/api/tasks/', identity)['status'] == 'cancelled'
    assert not app.state.music.active


@pytest.mark.parametrize('owns_running', [False, True])
def test_shared_comfy_cancel_only_interrupts_own_request(setup, monkeypatch, tmp_path, owns_running):
    _, app, _ = setup; service = app.state.music
    service.configure({'comfyUrl': 'http://127.0.0.1:8188'})
    packet = compile_packet(MusicBrief(lyrics='中文歌词'), {'caption': 'orchestral', 'lyrics': '中文歌词'})
    calls, cancel = [], threading.Event()
    def http(base, route, body=None, timeout=15):
        calls.append((route, body))
        if route == '/queue':
            return {'queue_running': [[1, 'our-id' if owns_running else 'other-id']] if cancel.is_set() else [], 'queue_pending': []}
        if route == '/prompt':
            return {'prompt_id': 'our-id'}
        if route == '/history/our-id':
            cancel.set(); return {}
        return {}
    monkeypatch.setattr(service, '_http', http)
    with pytest.raises(MusicCancelled):
        service._comfy(packet, tmp_path / 'audio.wav', lambda *_: None, cancel.is_set, tmp_path)
    assert ('/queue', {'delete': ['our-id']}) in calls
    assert any(route == '/interrupt' for route, body in calls) is owns_running


def test_generation_conflicts_with_training_and_does_not_reserve_on_rejection(setup):
    client, app, studio = setup
    studio.training_status_payload = lambda: {'running': True}
    response = client.post('/api/music/generate', json={'brief': {'idea': '中文史诗'}})
    assert response.status_code == 409 and not app.state.music.active


def test_compile_cannot_add_unknown_model_fields(setup):
    client, _, _ = setup
    body = {'brief': {'modelId': 'yue2', 'lyrics': '中文歌词', 'bpm': 90}, 'draft': {'caption': 'piano', 'lyrics': '中文歌词',
        'negative_prompt': 'invalid', 'reference_audio': 'not-supported', 'metadata': {}}}
    response = client.post('/api/music/compile', json=body)
    assert response.status_code == 200
    assert set(response.json()['inputs']) == {'style', 'lyrics', 'cot', 'seed'}


def test_comfy_empty_success_body_is_valid(monkeypatch):
    import urllib.request
    monkeypatch.setattr(urllib.request, 'urlopen', lambda *a, **kw: io.BytesIO(b''))
    assert MusicService._http('http://localhost', '/free', {}) == {}


def test_generation_failure_keeps_prepared_draft_for_retry(setup, monkeypatch):
    client, app, _ = setup
    monkeypatch.setattr(app.state.music, 'status', ready_status)
    monkeypatch.setitem(sys.modules, 'torch', None)
    def fail(*args):
        raise RuntimeError('模拟模型推理失败')
    monkeypatch.setattr(app.state.music, '_comfy', fail)
    response = client.post('/api/music/generate', json={'brief': {'lyrics': '中文歌词'}, 'autoOptimize': False,
        'draft': {'title': '保留我的草稿', 'caption': 'piano', 'lyrics': '中文歌词'}})
    state = await_task(client, '/api/tasks/', response.json()['taskId'])
    assert state['status'] == 'failed' and state['result']['packet']['draft']['title'] == '保留我的草稿'
    assert not app.state.music.active


def test_auto_creation_before_generation_and_cached_seed_change(setup, monkeypatch):
    client, app, _ = setup
    monkeypatch.setattr(app.state.music, 'status', ready_status)
    monkeypatch.setitem(sys.modules, 'torch', None)
    store = app.state.music.assistants
    store.save({'providers': [{'id': 'fixture', 'name': '测试助手', 'model': 'test-model', 'baseUrl': 'http://localhost:1', 'enabled': True}]})
    calls = []
    def complete(provider, key, system, user):
        calls.append(user)
        return json.dumps({'title': '自动创作', 'caption': 'cinematic piano', 'lyrics': '[Verse]\nAI创作中文歌词',
            'metadata': {'bpm': 90, 'keyScale': 'D minor', 'language': 'zh', 'timeSignature': '4/4'}})
    store.transport = complete
    rendered = []
    def render(packet, output, *args):
        rendered.append(packet['seed']); sf.write(output, np.zeros(2400), 24000); return {}
    monkeypatch.setattr(app.state.music, '_comfy', render)
    body = {'brief': {'idea': '史诗与和平', 'language': 'zh'}, 'autoOptimize': True}
    first = client.post('/api/music/generate', json=body)
    state = await_task(client, '/api/tasks/', first.json()['taskId'])
    assert state['status'] == 'succeeded', state
    assert state['result']['packet']['assistant']['model'] == 'test-model'
    body['promptId'] = state['result']['packet']['promptId']; body['brief']['seed'] = 44
    second = client.post('/api/music/generate', json=body)
    assert await_task(client, '/api/tasks/', second.json()['taskId'])['status'] == 'succeeded'
    assert len(calls) == 1 and rendered == [1247, 44]
