"""国内源的续传、校验与复用不访问网络。"""
import hashlib
import importlib.util
from pathlib import Path
import requests

spec = importlib.util.spec_from_file_location('prepare_moss', Path(__file__).resolve().parents[1] / 'scripts/prepare_moss.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


def test_domestic_resume_and_valid_file_reuse(tmp_path, monkeypatch):
    data = b'moss-audio-test'
    target = tmp_path / 'models/voice'; target.mkdir(parents=True)
    (target / 'weights.part').write_bytes(data[:4])
    calls = []
    class Response:
        status_code = 206
        headers = {'Content-Range': f'bytes 4-{len(data)-1}/{len(data)}'}
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def raise_for_status(self): pass
        def iter_content(self, size): yield data[4:]
    def get(url, **kwargs):
        calls.append((url, kwargs)); return Response()
    monkeypatch.setattr(requests, 'get', get)
    model = {'name': 'MOSS-VoiceGenerator', 'hfRevision': 'fixed', 'files': [
        {'path': 'weights', 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}]}
    module.download_model(tmp_path, 'voice', model)
    assert calls[0][0].startswith('https://modelscope.cn/')
    assert calls[0][1]['headers']['Range'].startswith('bytes=4-')
    assert (target / 'weights').read_bytes() == data
    module.download_model(tmp_path, 'voice', model)
    assert len(calls) == 1


def test_modelscope_failure_uses_domestic_mirror(tmp_path, monkeypatch):
    data = b'ok'
    calls = []
    class Response:
        status_code = 200; headers = {}
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def raise_for_status(self): pass
        def iter_content(self, size): yield data
    def get(url, **kwargs):
        calls.append(url)
        if 'modelscope.cn' in url: raise requests.Timeout('模拟超时')
        return Response()
    monkeypatch.setattr(requests, 'get', get)
    module.download_model(tmp_path, 'voice', {'name': 'MOSS-VoiceGenerator', 'hfRevision': 'fixed', 'files': [
        {'path': 'weights', 'size': 2, 'sha256': hashlib.sha256(data).hexdigest()}]})
    assert len(calls) == 2 and calls[1].startswith('https://hf-mirror.com/')
