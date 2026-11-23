"""准备 MOSS 专用环境及权重，不写入正式安装。可重复执行以续传。"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import zipfile
import uuid
from urllib.parse import quote

REVISION = '934d6826b084c46a0d033402174d5f8ac4ed2519'

def run(args):
    print('运行:', ' '.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), check=True)


def download_model(root, key, model):
    import requests
    target = root / 'models' / key
    target.mkdir(parents=True, exist_ok=True)
    print(f"检查/续传 {model['name']}（魔搭优先，国内镜像备用）", flush=True)
    def digest(path):
        with path.open('rb') as handle:
            return hashlib.file_digest(handle, 'sha256').hexdigest()
    def download(item):
        path = target / item['path']
        if path.is_file() and path.stat().st_size == item['size'] and digest(path) == item['sha256']:
            print('复用已校验文件：' + item['path'], flush=True)
            return
        if path.exists():
            raise RuntimeError(f'已有文件与清单不符，请检查后重试，未覆盖：{path}')
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(path.name + '.part')
        sources = [
            f"https://modelscope.cn/api/v1/models/OpenMOSS/{model['name']}/repo?Revision=master&FilePath={quote(item['path'], safe='')}",
            f"https://hf-mirror.com/OpenMOSS-Team/{model['name']}/resolve/{model['hfRevision']}/{quote(item['path'])}",
        ]
        error = None
        for source in sources:
            try:
                # 分段续传，避免单次大文件请求因网络中断从头开始。
                offset = partial.stat().st_size if partial.exists() else 0
                if offset > item['size']:
                    raise RuntimeError(f'断点体积异常：{partial}')
                while offset < item['size']:
                    end = min(offset + 64 * 1024 * 1024, item['size']) - 1
                    with requests.get(source, headers={'Range': f'bytes={offset}-{end}'}, stream=True, timeout=(15, 120)) as response:
                        response.raise_for_status()
                        if response.status_code == 206:
                            if not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-'):
                                raise RuntimeError('服务器返回了不匹配的续传位置')
                        elif offset:
                            raise RuntimeError('下载源不支持续传，保留现有断点并尝试备用源')
                        with partial.open('ab') as handle:
                            for block in response.iter_content(1024 * 1024):
                                if block:
                                    handle.write(block); offset += len(block)
                    print(f"{key}/{item['path']} {offset / 1024**2:.0f}/{item['size'] / 1024**2:.0f} MiB", flush=True)
                if partial.stat().st_size != item['size'] or digest(partial) != item['sha256']:
                    partial.replace(path.with_name(path.name + '.rejected-' + uuid.uuid4().hex[:8]))
                    raise RuntimeError(f'下载校验失败：{partial}')
                partial.replace(path)
                return
            except Exception as cause:
                error = cause
                print(f'当前源未完成：{cause}；保留断点尝试备用源。', flush=True)
        raise RuntimeError(f"下载未完成：{item['path']}：{error}")
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(download, model['files']))
    (target / '.jvox-ready.json').write_text(json.dumps({
        'revision': model['hfRevision'], 'source': 'modelscope.cn / hf-mirror.com', 'files': model['files']}), encoding='utf-8')
    print('校验完成：' + model['name'], flush=True)

def prepare(root: Path, mode: str):
    root.mkdir(parents=True, exist_ok=True)
    if mode in ('all', 'models'):
        catalog = json.loads(Path(__file__).with_name('moss-models.json').read_text('utf-8-sig'))
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda key: download_model(root, key, catalog[key]), catalog))
    if mode in ('all', 'runtime'):
        source = root / 'source'
        if not source.is_dir():
            archive = root / 'source.zip'
            urllib.request.urlretrieve(f'https://codeload.github.com/OpenMOSS/MOSS-TTS/zip/{REVISION}', archive)
            with zipfile.ZipFile(archive) as z:
                z.extractall(root)
            (root / f'MOSS-TTS-{REVISION}').rename(source)
            archive.unlink()
        for key in ('soundeffect', 'voice'):
            env = root / key
            python = env / 'Scripts/python.exe'
            marker = env / 'ready.json'
            if python.is_file() and marker.is_file():
                try:
                    if json.loads(marker.read_text('utf-8')).get('sourceRevision') == REVISION:
                        expected = '4.57.1' if key == 'soundeffect' else '5.0.0'
                        check = subprocess.run([str(python), '-c',
                            f"import importlib.metadata as m;assert m.version('torch')=='2.9.0+cu128';assert m.version('transformers')=='{expected}'"], capture_output=True)
                        if check.returncode == 0:
                            print(f'复用已就绪环境：{env}', flush=True)
                            continue
                except (ValueError, OSError):
                    pass
            if not python.is_file():
                run(['uv', 'venv', '--python', sys.executable, env])
            torch_args = ['torch==2.9.0+cu128', 'torchaudio==2.9.0+cu128', 'torchvision==0.24.0+cu128']
            run(['uv', 'pip', 'install', '--python', python, '--extra-index-url',
                 'https://download.pytorch.org/whl/cu128', '--index-strategy', 'unsafe-best-match', *torch_args])
            if key == 'soundeffect':
                run(['uv', 'pip', 'install', '--python', python, '-e', source / 'moss_soundeffect_v2'])
            else:
                run(['uv', 'pip', 'install', '--python', python, 'transformers==5.0.0',
                     'numpy==2.1.0', 'accelerate>=1.10.1', 'soundfile==0.13.1', 'librosa==0.11.0',
                     'einops==0.8.1', 'tiktoken==0.12.0', 'scipy==1.16.2', 'orjson==3.11.4'])
            run([python, '-c', 'import torch, transformers, soundfile; print(torch.__version__, transformers.__version__)'])
            (env / 'ready.json').write_text(json.dumps({'sourceRevision': REVISION}), encoding='utf-8')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1] / 'builds/moss')
    parser.add_argument('--only', choices=['all', 'models', 'runtime'], default='all')
    args = parser.parse_args()
    os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
    prepare(args.root.resolve(), args.only)
