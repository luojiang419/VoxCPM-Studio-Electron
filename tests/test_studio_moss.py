"""覆盖模型路由、授权门禁、参数、作品持久化及音色下游兼容。"""
import time
from pathlib import Path
from types import SimpleNamespace
import wave
import os
import subprocess
import sys
import threading

import pytest
from fastapi.testclient import TestClient
from fastapi import HTTPException
from pydantic import ValidationError

from voxcpm.studio_api import create_api_app
from voxcpm.studio_api import StudioTaskQueue
from voxcpm.studio_moss import MossService, SoundEffectRequest


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('VOXCPM_DATA_ROOT', str(tmp_path))
    monkeypatch.setenv('VOXCPM_MOSS_ROOT', str(tmp_path / 'moss'))
    studio = SimpleNamespace(settings_payload=lambda: {'output_dir': str(tmp_path / 'outputs')},
        runtime_summary_payload=lambda: {'data_root': str(tmp_path)},
        training_status_payload=lambda: {'running': False}, reset_runtime=lambda: None)
    app = create_api_app(studio)
    monkeypatch.setattr(app.state.license_guard, 'require', lambda: None)
    return TestClient(app)


def await_task(client, task):
    for _ in range(100):
        result = client.get('/api/tasks/' + task['taskId']).json()
        if result['status'] in ('succeeded', 'failed', 'cancelled'):
            return result
        time.sleep(.01)
    raise AssertionError('任务未结束')


def write_wav(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as f:
        f.setparams((1, 2, 24000, 0, 'NONE', 'not compressed'))
        f.writeframes(b'\0\0' * 24000)


def test_missing_resources_never_trigger_download(client):
    status = client.get('/api/moss/status').json()
    assert not any(m['ready'] for m in status['models'])
    response = client.post('/api/tasks/generate-soundeffect', json={'prompt': '鸟鸣'})
    assert response.status_code == 400 and '尚未准备' in response.json()['detail']
    assert not Path(status['root']).exists()


@pytest.mark.parametrize('patch', [{'seconds': 31}, {'seconds': 0}, {'steps': 0}, {'seed': -1}, {'guidance': float('inf')}])
def test_soundeffect_parameter_bounds(patch):
    with pytest.raises(ValidationError):
        SoundEffectRequest(prompt='雨声', **patch)


def test_license_gate_covers_new_generation_route(client, monkeypatch):
    def denied():
        raise HTTPException(403, '授权失效')
    monkeypatch.setattr(client.app.state.license_guard, 'require', denied)
    assert client.post('/api/tasks/generate-soundeffect', json={'prompt': '雨声'}).status_code == 403


def test_moss_rejects_cloning_and_empty_instruction(client):
    for patch in [{'mode': '可控克隆', 'control': '女声'}, {'mode': '声音设计', 'control': ''}]:
        result = client.post('/api/tasks/generate-single', json={'model': 'moss-voice', 'text': '你好', **patch})
        assert result.status_code == 400
    assert client.post('/api/tasks/generate-single', json={'model': 'typo', 'mode': '声音设计', 'text': '你好'}).status_code == 422


def test_voice_model_dispatch_history_and_reusable_reference(client, tmp_path, monkeypatch):
    moss = client.app.state.moss
    monkeypatch.setattr(moss, 'require_ready', lambda key: None)
    def generate(kind, payload, progress, cancelled):
        assert kind == 'voice' and payload['control'] == '温暖的女声'
        path = tmp_path / 'voice.wav'; write_wav(path)
        return {'output_path': str(path), 'previewUrl': '/media?path=' + str(path)}
    monkeypatch.setattr(moss, 'generate', generate)
    task = client.post('/api/tasks/generate-single', json={'model': 'moss-voice', 'mode': '声音设计', 'text': '你好', 'control': '温暖的女声'}).json()
    assert await_task(client, task)['status'] == 'succeeded'
    history = client.get('/api/workspace/history').json()['items'][0]
    assert history['config']['model'] == 'moss-voice'
    voice = client.post('/api/workspace/voices', json={'name': 'MOSS女声', 'config': history['config'],
        'previewAudio': history['audioPath'], 'sampleText': '你好'}).json()
    assert voice['designConfig']['model'] == 'moss-voice'
    assert voice['config']['model'] == 'voxcpm' and voice['config']['mode'] == '可控克隆'
    assert Path(voice['config']['referenceAudio']).is_file()


def test_soundeffect_queue_serialization_and_works(client, tmp_path, monkeypatch):
    moss = client.app.state.moss
    monkeypatch.setattr(moss, 'require_ready', lambda key: None)
    seen = []
    def generate(kind, payload, progress, cancelled):
        seen.append(payload)
        path = tmp_path / 'outputs/soundeffects/one/audio.wav'; write_wav(path)
        record = {'id': 'one', 'title': '雨声', 'prompt': payload['prompt'], 'duration': 1,
                  'outputPath': str(path), 'createdAt': '2026-10-26T12:00:00', 'settings': payload}
        import json
        (path.parent / 'result.json').write_text(json.dumps(record), encoding='utf-8')
        return record
    monkeypatch.setattr(moss, 'generate', generate)
    task = client.post('/api/tasks/generate-soundeffect', json={'prompt': '窗边雨声', 'negativePrompt': '音乐', 'seed': 99}).json()
    assert await_task(client, task)['status'] == 'succeeded'
    assert seen[0]['negativePrompt'] == '音乐' and seen[0]['seed'] == 99
    works = client.get('/api/workspace/works').json()['items']
    assert works[0]['category'] == 'soundeffect' and works[0]['available']
    assert client.get('/api/soundeffects/results').json()['items'][0]['settings']['seed'] == 99


def test_silent_worker_success_is_failed_and_not_added_to_works(client, monkeypatch):
    import json
    moss = client.app.state.moss
    monkeypatch.setattr(moss, 'require_ready', lambda key: None)
    class CompletedWorker:
        returncode = 0
        def poll(self): return 0
    def launch(command, **kwargs):
        request_file = Path(command[-1])
        request = json.loads(request_file.read_text('utf-8'))
        write_wav(Path(request['output']))
        (request_file.parent / 'worker-result.json').write_text(json.dumps(
            {'sample_rate': 24000, 'duration': 1, 'channels': 1}), encoding='utf-8')
        return CompletedWorker()
    monkeypatch.setattr(subprocess, 'Popen', launch)
    task = client.post('/api/tasks/generate-soundeffect', json={'prompt': '燧发枪补充弹药和击发'}).json()
    result = await_task(client, task)
    assert result['status'] == 'failed' and '近乎静音' in result['error']
    assert client.get('/api/soundeffects/results').json()['items'] == []
    assert client.get('/api/workspace/works').json()['items'] == []


def test_soundeffect_can_cancel_before_execution():
    queue = StudioTaskQueue()
    entered, release = threading.Event(), threading.Event()
    queue.submit('blocker', '占位', lambda: (entered.set(), release.wait(5), {'ok': True})[-1])
    assert entered.wait(2)
    called = []
    try:
        task = queue.submit('generate-soundeffect', '音效生成', lambda: called.append(True) or {})
        assert queue.cancel(task['taskId'])['cancelRequested']
    finally:
        release.set()
    for _ in range(100):
        if queue.get(task['taskId'])['status'] == 'cancelled':
            break
        time.sleep(.01)
    assert queue.get(task['taskId'])['status'] == 'cancelled' and not called


@pytest.mark.skipif(os.name != 'nt', reason='Windows venv 进程树恢复验证')
def test_stop_process_terminates_child_interpreter(tmp_path):
    import psutil
    pid_file = tmp_path / 'child.pid'
    code = "import subprocess,sys,time;from pathlib import Path;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);Path(sys.argv[1]).write_text(str(p.pid));time.sleep(60)"
    process = subprocess.Popen([sys.executable, '-c', code, str(pid_file)], creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        for _ in range(100):
            if pid_file.is_file():
                break
            time.sleep(.02)
        child_pid = int(pid_file.read_text())
        assert psutil.pid_exists(child_pid)
        MossService.stop_process(process)
        for _ in range(100):
            if not psutil.pid_exists(child_pid):
                break
            time.sleep(.02)
        assert process.poll() is not None and not psutil.pid_exists(child_pid)
    finally:
        MossService.stop_process(process)
