"""MOSS 通过独立子进程推理，避免污染主语音环境。"""
from __future__ import annotations
import gc
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import threading
import uuid
from datetime import datetime
from urllib.parse import quote

from pydantic import BaseModel, Field


class SoundEffectRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    negative_prompt: str = Field(default='', alias='negativePrompt', max_length=1000)
    title: str = Field(default='', max_length=100)
    seconds: float = Field(default=10, ge=1, le=30, allow_inf_nan=False)
    steps: int = Field(default=100, ge=10, le=200)
    guidance: float = Field(default=4, ge=1, le=10, allow_inf_nan=False)
    seed: int = Field(default=1247, ge=0, le=2147483647)


def atomic_json(path: Path, payload):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


class MossService:
    def __init__(self, data_root: Path, studio):
        self.data_root, self.studio = Path(data_root), studio
        self.root = Path(os.environ.get('VOXCPM_MOSS_ROOT') or Path(__file__).resolve().parents[2] / 'builds/moss')
        self.active = False
        self.lock = threading.RLock()

    def status(self):
        models = []
        for key, name in [('soundeffect', 'MOSS-SoundEffect v2'), ('voice', 'MOSS-VoiceGenerator')]:
            required = [self.root / key / 'ready.json', self.root / key / 'Scripts/python.exe',
                        self.root / 'models' / key / '.jvox-ready.json']
            if key == 'voice':
                required.append(self.root / 'models/codec/.jvox-ready.json')
            missing = [str(p) for p in required if not p.is_file()]
            for directory in ([key, 'codec'] if key == 'voice' else [key]):
                marker = self.root / 'models' / directory / '.jvox-ready.json'
                if marker.is_file():
                    try:
                        manifest = json.loads(marker.read_text('utf-8'))
                        if not manifest.get('files'):
                            missing.append(str(marker))
                        for item in manifest.get('files', []):
                            path = marker.parent / item['path']
                            if not path.is_file() or path.stat().st_size != item['size']:
                                missing.append(str(path))
                    except (ValueError, OSError, KeyError, TypeError):
                        missing.append(str(marker))
            models.append({'id': key, 'name': name, 'ready': not missing, 'missing': missing,
                           'path': str(self.root / 'models' / key)})
        return {'models': models, 'active': self.active, 'root': str(self.root)}

    def require_ready(self, key):
        model = next(m for m in self.status()['models'] if m['id'] == key)
        if not model['ready']:
            raise ValueError(f"{model['name']} 尚未准备完成，请运行测试目录的「准备MOSS模型.cmd」。")

    @staticmethod
    def stop_process(child):
        if child.poll() is not None:
            return
        # Windows venv 的 python.exe 会创建真实解释器子进程，必须一并停止。
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        else:
            child.terminate()
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait()

    def results(self, limit=None):
        items = []
        for path in (self.data_root / 'outputs/soundeffects').glob('*/result.json'):
            try:
                items.append(json.loads(path.read_text('utf-8')))
            except (OSError, ValueError):
                continue
        items.sort(key=lambda r: r.get('createdAt', ''), reverse=True)
        return items if limit is None else items[:limit]

    def generate(self, key, payload, progress, cancelled):
        self.require_ready(key)
        if cancelled():
            return {'cancelled': True, 'status': '任务已取消。'}
        with self.lock:
            if self.studio.training_status_payload().get('running'):
                raise ValueError('请先停止训练，再生成 MOSS 音频。')
            self.active = True
        run = self.data_root / 'outputs' / ('soundeffects' if key == 'soundeffect' else 'moss-voice') / uuid.uuid4().hex
        run.mkdir(parents=True)
        child = None
        try:
            self.studio.reset_runtime()
            gc.collect()
            torch = sys.modules.get('torch')
            if torch is not None and torch.cuda.is_available():
                torch.cuda.empty_cache()
            request = {'kind': key, 'root': str(self.root), 'output': str(run / 'audio.wav'), **payload}
            atomic_json(run / 'request.json', request)
            command = [str(self.root / key / 'Scripts/python.exe'),
                       str(Path(__file__).with_name('moss_worker.py')), str(run / 'request.json')]
            env = {**os.environ, 'PYTHONUTF8': '1', 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
                   'HF_HOME': str(self.root / 'cache/huggingface'), 'HF_MODULES_CACHE': str(self.root / 'cache/modules'),
                   'TORCHDYNAMO_DISABLE': '1', 'TOKENIZERS_PARALLELISM': 'false'}
            progress(0, '正在加载 MOSS 模型，首次推理需要一些时间。')
            with (run / 'inference.log').open('w', encoding='utf-8') as log:
                child = subprocess.Popen(command, cwd=run, env=env, stdout=log, stderr=subprocess.STDOUT,
                                         creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                previous_message = ''
                while child.poll() is None:
                    if cancelled():
                        self.stop_process(child)
                        return {'cancelled': True, 'status': '已取消，草稿已保留。'}
                    phase = run / 'progress.json'
                    if phase.is_file():
                        try:
                            state = json.loads(phase.read_text('utf-8'))
                            if state['message'] != previous_message:
                                previous_message = state['message']
                                progress(0, previous_message)
                        except (OSError, ValueError, KeyError):
                            pass
                    time.sleep(.4)
            if child.returncode:
                detail = (run / 'inference.log').read_text('utf-8')[-1800:]
                if 'out of memory' in detail.lower():
                    raise ValueError('显存不足，请关闭其他占用显存的程序后重试；模型未切换。日志：' + str(run / 'inference.log'))
                raise ValueError('MOSS 推理失败：' + detail)
            result = json.loads((run / 'worker-result.json').read_text('utf-8'))
            output = str(run / 'audio.wav')
            record = {**result, 'id': run.name, 'outputPath': output, 'output_path': output,
                      'previewUrl': '/media?path=' + quote(output), 'createdAt': datetime.now().isoformat(),
                      'modelId': 'MOSS-SoundEffect-v2.0' if key == 'soundeffect' else 'MOSS-VoiceGenerator',
                      'title': payload.get('title') or payload.get('prompt', payload.get('text', ''))[:32],
                      'prompt': payload.get('prompt', ''), 'settings': payload, 'status': '生成完成，作品已保存。'}
            atomic_json(run / 'result.json', record)
            progress(100, record['status'])
            return record
        finally:
            if child and child.poll() is None:
                self.stop_process(child)
            self.active = False
