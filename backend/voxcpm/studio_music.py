"""音乐创作任务、官方提示词记录及隔离推理，不修改共享ComfyUI的文件。"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlencode, urlsplit
import uuid

from .music_graph import graph_for
from .music_prompts import MusicBrief, MusicPromptService, compile_packet
from .studio_assistant import AssistantStore


class MusicCancelled(Exception):
    pass


class MusicGenerationError(RuntimeError):
    def __init__(self, message, packet):
        super().__init__(message)
        self.partial_result = {'packet': packet}


def atomic_json(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf8'); temporary.replace(file)


def fingerprint(brief):
    value = brief.model_dump(by_alias=True); value.pop('seed', None)
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode('utf8')).hexdigest()


def music_filename(title):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', title).strip(' .')
    if name.lower().endswith('.wav'):
        name = name[:-4].rstrip(' .')
    name = name[:100].rstrip(' .') or '未命名音乐'
    if re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])', name.split('.')[0]):
        name = '_' + name
    return name + '.wav'


def release_music_memory():
    import gc
    import sys
    gc.collect()
    torch = sys.modules.get('torch')
    if torch is not None and torch.cuda.is_available():
        torch.cuda.empty_cache()


class MusicService:
    def __init__(self, data_root: Path, studio, *, root=None, catalog=None, assistants=None):
        self.data_root, self.studio = data_root, studio
        self.root = Path(root or os.environ.get('VOXCPM_PROJECT_ROOT') or data_root.parent)
        candidates = [self.root / 'resources/app/music-config.json', Path(__file__).resolve().parents[2] / 'frontend/voxcpm_studio_electron/music-config.json']
        self.catalog = catalog or json.loads(next(file for file in candidates if file.is_file()).read_text(encoding='utf8'))
        self.engine = Path(os.environ.get('VOXCPM_MUSIC_ENGINE_ROOT') or self.root / 'runtime/music' / self.catalog['runtime']['version'])
        self.models = Path(os.environ.get('VOXCPM_MUSIC_MODELS_ROOT') or self.root / 'models/music')
        self.assistants = assistants or AssistantStore(data_root)
        self.prompts = MusicPromptService(self.assistants)
        self.lock = threading.Lock(); self.active = False

    def settings(self):
        try:
            return json.loads((self.data_root / 'music-settings.json').read_text(encoding='utf8'))
        except FileNotFoundError:
            return {'comfyUrl': os.environ.get('VOXCPM_MUSIC_COMFY_URL', '')}

    def configure(self, value):
        url = str(value.get('comfyUrl') or '').strip().rstrip('/')
        parsed = urlsplit(url)
        if url and (parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {'', '/'}):
            raise ValueError('ComfyUI地址请使用不含路径和密钥的HTTP/HTTPS服务地址')
        if self.active:
            raise ValueError('音乐任务进行中，暂不能更换ComfyUI服务')
        atomic_json(self.data_root / 'music-settings.json', {'comfyUrl': url})
        return self.settings()

    def status(self):
        try:
            selection = json.loads((self.data_root / 'component-selection.json').read_text(encoding='utf8'))
        except FileNotFoundError:
            selection = {'selected': [], 'removed': [], 'defaultModel': 'ace-xl-turbo'}
        try:
            runtime = json.loads((self.engine / 'ready.json').read_text(encoding='utf8'))
            engine_ready = runtime.get('sha256') == self.catalog['runtime']['sha256'] and (self.engine / 'python/python.exe').is_file()
        except (FileNotFoundError, ValueError):
            engine_ready = False
        models = []
        for model in self.catalog['models']:
            def present(asset):
                file = self.models / asset['name'].removeprefix('models/music/')
                return file.is_file() and file.stat().st_size == asset['size']
            installed = all(present(asset) for asset in model['files'])
            selected = model['id'] in selection['selected'] and model['id'] not in selection.get('removed', [])
            models.append({'id': model['id'], 'name': model['label'], 'installed': installed, 'selected': selected,
                'ready': installed and selected and engine_ready, 'size': sum(f['size'] for f in model['files'])})
        return {'models': models, 'active': self.active, 'runtimeReady': engine_ready,
            'defaultModel': selection.get('defaultModel', 'ace-xl-turbo'), 'settings': self.settings(), 'rules': self.prompts.catalog()}

    def compose(self, brief, progress=lambda *_: None, cancelled=lambda: False):
        started = time.monotonic()
        try:
            packet = self.prompts.compose(brief, progress, cancelled)
        except Exception:
            if cancelled():
                return {'cancelled': True, 'status': '音乐提示词创作已取消'}
            raise
        identity = uuid.uuid4().hex
        packet.update({'promptId': identity, 'briefFingerprint': fingerprint(brief), 'assistantSeconds': round(time.monotonic() - started, 2)})
        atomic_json(self.data_root / 'music-prompts' / (identity + '.json'), packet)
        return packet

    def load_prompt(self, identity):
        if not identity or not isinstance(identity, str) or len(identity) != 32 or any(c not in '0123456789abcdef' for c in identity):
            raise ValueError('音乐提示词记录标识无效')
        try:
            return json.loads((self.data_root / 'music-prompts' / (identity + '.json')).read_text(encoding='utf8'))
        except FileNotFoundError:
            raise ValueError('提示词记录不存在，请重新创作或优化') from None

    def reserve(self, model):
        with self.lock:
            if self.active:
                raise ValueError('已有音乐生成任务，请等待完成或取消后再试')
            state = self.status()
            selected = next(m for m in state['models'] if m['id'] == model)
            if not selected['ready']:
                raise ValueError('请先在功能与模型管理中启用该模型并补齐所需资源')
            self.active = True

    def results(self):
        folder = self.data_root / 'outputs/music'
        rows = []
        for file in sorted(folder.glob('*/result.json'), key=lambda p: p.stat().st_mtime, reverse=True)[:50]:
            try:
                item = json.loads(file.read_text(encoding='utf8'))
                if Path(item['outputPath']).is_file():
                    rows.append(item)
            except (OSError, KeyError, ValueError):
                continue
        return rows

    def generate(self, payload, progress=lambda *_: None, cancelled=lambda: False):
        brief = payload.brief
        run = self.data_root / 'outputs/music' / uuid.uuid4().hex
        run.mkdir(parents=True)
        packet = None
        try:
            packet = self.load_prompt(payload.prompt_id) if payload.prompt_id else None
            if payload.auto_optimize and (packet is None or packet['briefFingerprint'] != fingerprint(brief) or packet.get('rulesVersion') != self.prompts.manifest['version']):
                packet = self.compose(brief, lambda n, text: progress(round(n * .25), text), cancelled)
                if packet.get('cancelled'):
                    return packet
            elif not payload.auto_optimize:
                provenance = {key: packet[key] for key in ('assistant', 'assistantSeconds', 'rulesVersion', 'source') if packet and key in packet}
                raw = payload.draft or {'caption': brief.caption, 'lyrics': brief.lyrics, 'metadata': {}}
                packet = {**compile_packet(brief, raw), **provenance}
            else:
                # 种子不参与提示词缓存，但每次音频生成必须使用用户当前种子。
                packet = {**packet, **compile_packet(brief, packet['draft'])}
            packet.update({'rulesVersion': self.prompts.manifest['version'], 'source': self.prompts.manifest['models'][brief.model_id]})
            if packet['modelId'] != brief.model_id or not packet['canGenerate']:
                raise ValueError('所选模型与提示词不一致，或当前运行接口不支持此生成模式')
            if cancelled():
                raise MusicCancelled()
            request_file = run / 'request.json'; atomic_json(request_file, packet)
            self.studio.reset_runtime()
            release_music_memory()
            generation_start = time.monotonic()
            output, report = run / music_filename(packet['draft']['title']), {}
            if brief.model_id in {'ace-xl-turbo', 'minimax-music3'}:
                report = self._comfy(packet, output, progress, cancelled, run)
            else:
                self._free_idle_comfy(progress, cancelled)
                command = [str(self.engine / 'python/python.exe'), str(Path(__file__).with_name('music_worker.py')), '--generate', '--engine', str(self.engine),
                    '--models-root', str(self.models), '--request', str(request_file), '--output', str(output)]
                self._process(command, run, cancelled, progress)
                report = json.loads(output.with_suffix('.report.json').read_text(encoding='utf8'))
            if cancelled():
                raise MusicCancelled()
            import soundfile as sf
            info = sf.info(output)
            if not info.frames or info.duration < .1:
                raise RuntimeError('音乐模型没有生成有效音频')
            result = {'title': packet['draft']['title'], 'modelId': brief.model_id, 'duration': round(info.duration, 2),
                'fileName': output.name, 'outputPath': str(output), 'previewUrl': '/media?path=' + quote(str(output)), 'requestPath': str(request_file),
                'packet': packet, 'report': {**report, 'elapsedSeconds': round(time.monotonic() - generation_start, 2),
                    'assistantSeconds': packet.get('assistantSeconds', 0), 'sampleRate': info.samplerate}, 'status': '音乐已生成'}
            atomic_json(run / 'result.json', result)
            progress(100, '音乐已生成，可以试听并查看实际提示词')
            return result
        except MusicCancelled:
            return {'cancelled': True, 'status': '音乐生成已取消，原有作品与已完成的提示词保留', 'packet': packet}
        except Exception as error:
            if packet:
                raise MusicGenerationError(str(error), packet) from error
            raise
        finally:
            try:
                release_music_memory()
            finally:
                with self.lock:
                    self.active = False

    @staticmethod
    def _stop(child):
        if child.poll() is not None:
            return
        if os.name == 'nt':
            subprocess.run(['taskkill.exe', '/PID', str(child.pid), '/T', '/F'], capture_output=True, timeout=20, creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            child.terminate()
        try:
            child.wait(timeout=20)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait(timeout=10)

    def _process(self, command, run, cancelled, progress):
        with (run / 'inference.log').open('w', encoding='utf8') as log:
            child = subprocess.Popen(command, cwd=run, stdout=log, stderr=subprocess.STDOUT,
                env={**os.environ, 'PYTHONUTF8': '1', 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'},
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            started = time.monotonic(); last = 0
            try:
                while child.poll() is None:
                    if cancelled():
                        raise MusicCancelled()
                    if time.monotonic() - started > 3600:
                        raise RuntimeError('音乐推理超过一小时，已停止本次任务')
                    if time.monotonic() - last > 2:
                        progress(55, f'正在生成音乐，已用时{int(time.monotonic() - started)}秒'); last = time.monotonic()
                    time.sleep(.25)
            finally:
                self._stop(child)
        if child.returncode:
            detail = (run / 'inference.log').read_text(encoding='utf8', errors='replace')[-3500:]
            if 'out of memory' in detail.lower():
                raise RuntimeError('音乐生成显存不足，已停止本次任务；请释放显存后重试，模型与时长保持不变')
            raise RuntimeError('音乐推理失败，请查看本次inference.log：' + detail)

    @staticmethod
    def _http(base, route, body=None, timeout=15):
        request = urllib.request.Request(base + route, data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type': 'application/json'}, method='GET' if body is None else 'POST')
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return json.loads(raw) if raw.strip() else {}

    def _free_idle_comfy(self, progress, cancelled):
        base = self.settings().get('comfyUrl') or 'http://127.0.0.1:8188'
        try:
            stats = self._http(base, '/system_stats', timeout=3)
            if not isinstance(stats, dict) or 'devices' not in stats:
                return
        except (OSError, ValueError):
            return
        deadline = time.monotonic() + 1800
        while time.monotonic() < deadline:
            if cancelled():
                raise MusicCancelled()
            queue = self._http(base, '/queue')
            if not queue.get('queue_running') and not queue.get('queue_pending'):
                self._http(base, '/free', {'unload_models': True, 'free_memory': True})
                return
            progress(28, '正在等待共享音乐后端空闲，其他任务保持运行'); time.sleep(.5)
        raise RuntimeError('共享ComfyUI等待超时，其他任务未受影响')

    def _comfy(self, packet, output, progress, cancelled, run):
        configured = self.settings().get('comfyUrl', '')
        base, child = configured, None
        # 默认后端仅为当前任务启动，退出即可释放模型及进程内存。
        # 保留旧版显式指定共享服务的兼容入口，不接管或关闭外部进程。
        log = None; prompt_id = ''; completed = False
        try:
            if not base:
                self._free_idle_comfy(progress, cancelled)
                with socket.socket() as probe:
                    probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
                base = f'http://127.0.0.1:{port}'
                paths = run / 'models.yaml'
                (run / 'comfy-user').mkdir()
                atomic_json(paths, {'voxcpm_music': {'base_path': str(self.models / 'comfy'),
                    'checkpoints': 'checkpoints', 'diffusion_models': 'diffusion_models', 'text_encoders': 'text_encoders', 'vae': 'vae'}})
                # 嵌入式Python的_pth不包含脚本目录，需要显式加入ComfyUI源码路径。
                runner = "import sys,runpy;root=sys.argv.pop(1);sys.path.insert(0,root);sys.argv[0]=root+'/main.py';runpy.run_path(sys.argv[0],run_name='__main__')"
                command = [str(self.engine / 'python/python.exe'), '-c', runner, str(self.engine / 'ComfyUI'), '--listen', '127.0.0.1', '--port', str(port),
                    '--disable-auto-launch', '--disable-all-custom-nodes', '--disable-api-nodes', '--preview-method', 'none',
                    '--extra-model-paths-config', str(paths), '--output-directory', str(run / 'comfy-output'), '--user-directory', str(run / 'comfy-user'),
                    '--database-url', 'sqlite:///' + (run / 'comfy-user/music.db').as_posix()]
                log = (run / 'comfy.log').open('w', encoding='utf8')
                child = subprocess.Popen(command, cwd=run, stdout=log, stderr=subprocess.STDOUT,
                    env={**os.environ, 'PYTHONUTF8': '1', 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'}, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                deadline = time.monotonic() + 180
                while time.monotonic() < deadline:
                    if cancelled():
                        raise MusicCancelled()
                    if child.poll() is not None:
                        raise RuntimeError('独立音乐ComfyUI未启动，请查看本次comfy.log')
                    try:
                        self._http(base, '/system_stats'); break
                    except (OSError, ValueError):
                        time.sleep(.5)
                else:
                    raise RuntimeError('独立音乐ComfyUI启动超时')
            progress(28, '正在等待音乐后端空闲')
            deadline = time.monotonic() + 1800
            while time.monotonic() < deadline:
                if cancelled():
                    raise MusicCancelled()
                queue = self._http(base, '/queue')
                if not queue.get('queue_running') and not queue.get('queue_pending'):
                    break
                time.sleep(.5)
            else:
                raise RuntimeError('共享ComfyUI等待超时，其他任务未受影响')
            graph = graph_for(packet, 'voxcpm-music/' + run.name)
            atomic_json(run / 'workflow.json', graph)
            submitted = self._http(base, '/prompt', {'prompt': graph, 'client_id': 'voxcpm-music-' + run.name}, timeout=60)
            prompt_id = submitted['prompt_id']; deadline = time.monotonic() + 3600; started = time.monotonic()
            while time.monotonic() < deadline:
                if cancelled():
                    raise MusicCancelled()
                history = self._http(base, '/history/' + prompt_id)
                entry = history.get(prompt_id)
                if entry:
                    if entry.get('status', {}).get('status_str') == 'error':
                        messages = json.dumps(entry['status'].get('messages', []), ensure_ascii=False)
                        if 'out of memory' in messages.lower():
                            raise RuntimeError('音乐生成显存不足，请释放显存后重试；未改变模型与时长')
                        raise RuntimeError('ComfyUI音乐生成失败：' + messages[-1800:])
                    audio = next((item for node in entry.get('outputs', {}).values() for item in node.get('audio', [])), None)
                    if not audio:
                        raise RuntimeError('音乐工作流已结束，但没有输出音频')
                    url = base + '/view?' + urlencode({k: audio[k] for k in ('filename', 'subfolder', 'type')})
                    original = run / ('comfy-audio' + Path(audio['filename']).suffix)
                    with urllib.request.urlopen(url, timeout=60) as source, original.open('wb') as target:
                        while chunk := source.read(256 * 1024):
                            if cancelled():
                                raise MusicCancelled()
                            target.write(chunk)
                    import soundfile as sf
                    wave, rate = sf.read(original, dtype='float32', always_2d=True)
                    peak = float(abs(wave).max()); gain = min(1, .98 / peak) if peak else 1
                    sf.write(output, wave * gain, rate, subtype='PCM_24')
                    completed = True
                    return {'normalizationGain': gain, 'comfyShared': child is None}
                progress(60, f'正在生成音乐，已用时{int(time.monotonic() - started)}秒'); time.sleep(1)
            raise RuntimeError('音乐生成超过一小时，已停止等待')
        finally:
            if prompt_id and not completed:
                # 只删除自己的排队任务；仅当当前运行项属于本次请求时才中断共享后端。
                try:
                    self._http(base, '/queue', {'delete': [prompt_id]})
                    queue = self._http(base, '/queue')
                    if any(str(item[1]) == prompt_id for item in queue.get('queue_running', [])):
                        self._http(base, '/interrupt', {})
                except (OSError, ValueError):
                    pass
            if prompt_id and child is None:
                try:
                    queue = self._http(base, '/queue')
                    if not queue.get('queue_pending') and all(str(item[1]) == prompt_id for item in queue.get('queue_running', [])):
                        self._http(base, '/free', {'unload_models': True, 'free_memory': True})
                except (OSError, ValueError):
                    pass
            if child:
                self._stop(child)
            if log:
                log.close()
