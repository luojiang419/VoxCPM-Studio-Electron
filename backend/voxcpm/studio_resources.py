"""使用前校验对应模型；已验证且未变化的文件复用记录，不扫描其他模型。"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import threading

_lock = threading.RLock()


def verify_files(assets, root, cache_file, cancelled=lambda: False):
    root, cache_file = Path(root).resolve(), Path(cache_file)
    with _lock:
        try:
            cache = json.loads(cache_file.read_text(encoding='utf8'))
            if not isinstance(cache, dict):
                cache = {}
        except (OSError, ValueError):
            cache = {}
        changed = False
        for asset in assets:
            if cancelled():
                raise RuntimeError('模型校验已取消')
            file = (root / asset['name']).resolve()
            if not file.is_relative_to(root):
                raise ValueError('模型清单路径越界')
            try:
                stat = file.stat()
                stamp = {'sha256': asset['sha256'], 'size': stat.st_size, 'mtime': stat.st_mtime_ns, 'ctime': stat.st_ctime_ns}
                if not file.is_file() or stat.st_size != asset['size']:
                    raise ValueError('文件大小不匹配')
                if cache.get(str(file)) == stamp:
                    continue
                digest = hashlib.sha256()
                with file.open('rb') as source:
                    for block in iter(lambda: source.read(8 * 1024**2), b''):
                        if cancelled():
                            raise RuntimeError('模型校验已取消')
                        digest.update(block)
                if digest.hexdigest() != asset['sha256'] or file.stat() != stat:
                    raise ValueError('文件校验失败或校验期间被修改')
                cache[str(file)] = stamp
                changed = True
            except (OSError, ValueError) as error:
                raise ValueError(f'模型资源缺失或损坏：{file.name}。请在“功能与模型管理”中保存并准备，或运行安装修复器。') from error
        if changed:
            temporary = cache_file.with_suffix('.tmp')
            try:
                cache_file.parent.mkdir(parents=True, exist_ok=True)
                temporary.write_text(json.dumps(cache), encoding='utf8')
                temporary.replace(cache_file)
            except OSError:
                # 缓存写失败不影响本次已通过的真实校验，下次重新检查。
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass


def verify_model_resources(model, directory=None, *, root=None, data_root=None, cancelled=lambda: False):
    root = Path(root or os.environ.get('VOXCPM_PROJECT_ROOT') or Path(__file__).resolve().parents[2])
    data_root = Path(data_root or os.environ.get('VOXCPM_DATA_ROOT') or root / 'data')
    filename = 'runtime-config.json' if isinstance(model, int) else 'music-config.json'
    explicit = os.environ.get('VOXCPM_RUNTIME_CONFIG') if isinstance(model, int) else None
    candidates = [Path(explicit)] if explicit else [root / 'resources/app' / filename, Path(__file__).resolve().parents[2] / 'frontend/voxcpm_studio_electron' / filename]
    manifest = next((file for file in candidates if file.is_file()), None)
    if manifest is None:
        if explicit:
            raise ValueError('模型资源清单缺失，请运行安装修复器')
        return  # 独立 Python/Gradio 入口仍允许用户自管模型。
    catalog = json.loads(manifest.read_text(encoding='utf8'))
    spec = catalog['models'][model] if isinstance(model, int) else next(m for m in catalog['models'] if m['id'] == model)
    if isinstance(model, int):
        default = Path(os.environ.get('VOXCPM_MODELS_ROOT') or root / 'models') / spec['folder']
        target = Path(directory).resolve() if directory else default.resolve()
        if directory and target != default.resolve():
            return  # 自选模型版本不使用内置版本的权重哈希。
    else:
        target = root
    verify_files(spec['files'], target, data_root / 'cache/model-verification.json', cancelled)
