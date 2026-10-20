"""使用前校验对应模型；已验证且未变化的文件复用记录，不扫描其他模型。"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from contextlib import contextmanager

_lock = threading.RLock()


class ResourceCancelled(RuntimeError):
    pass


class ResourceFileError(ValueError):
    def __init__(self, file, reason, repairable=True):
        super().__init__(f'模型资源缺失或损坏：{file.name}。原因：{reason}。检查位置：{file}。请在“功能与模型管理”中保存并准备，或运行安装修复器。')
        self.repairable = repairable


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
                raise ResourceCancelled('模型校验已取消')
            file = (root / asset['name']).resolve()
            if not file.is_relative_to(root):
                raise ValueError('模型清单路径越界')
            try:
                stat = file.stat()
                stamp = {'sha256': asset['sha256'], 'size': stat.st_size, 'mtime': stat.st_mtime_ns, 'ctime': stat.st_ctime_ns}
                if not file.is_file():
                    raise IsADirectoryError('该路径不是模型文件')
                if stat.st_size != asset['size']:
                    raise ValueError(f'文件大小不匹配，实际 {stat.st_size} 字节，应为 {asset["size"]} 字节')
                if cache.get(str(file)) == stamp:
                    continue
                digest = hashlib.sha256()
                with file.open('rb') as source:
                    for block in iter(lambda: source.read(8 * 1024**2), b''):
                        if cancelled():
                            raise ResourceCancelled('模型校验已取消')
                        digest.update(block)
                if digest.hexdigest() != asset['sha256']:
                    raise ValueError('SHA256 校验不匹配，文件内容与模型清单不一致')
                current = file.stat()
                if any(getattr(current, key) != getattr(stat, key) for key in ('st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_dev', 'st_ino')):
                    raise ValueError('校验期间文件内容或身份被修改')
                cache[str(file)] = stamp
                changed = True
            except (OSError, ValueError) as error:
                reason = '该目录下未找到文件' if isinstance(error, FileNotFoundError) else str(error)
                raise ResourceFileError(file, reason, not isinstance(error, OSError) or isinstance(error, FileNotFoundError)) from error
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


def _model_resources(model, directory=None, *, root=None, data_root=None, catalog=None):
    root = Path(root or os.environ.get('VOXCPM_PROJECT_ROOT') or Path(__file__).resolve().parents[2])
    data_root = Path(data_root or os.environ.get('VOXCPM_DATA_ROOT') or root / 'data')
    filename = 'runtime-config.json' if isinstance(model, int) else 'music-config.json'
    explicit = os.environ.get('VOXCPM_RUNTIME_CONFIG') if isinstance(model, int) else None
    candidates = [Path(explicit)] if explicit else [root / 'resources/app' / filename, Path(__file__).resolve().parents[2] / 'frontend/voxcpm_studio_electron' / filename]
    if catalog is None:
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
        assets = spec['files']
    else:
        target = Path(directory or os.environ.get('VOXCPM_MUSIC_MODELS_ROOT') or root / 'models/music')
        if any(not asset['name'].startswith('models/music/') for asset in spec['files']):
            raise ValueError('音乐模型清单路径无效')
        assets = [{**asset, 'name': asset['name'].removeprefix('models/music/')} for asset in spec['files']]
    return assets, target.resolve(), data_root / 'cache/model-verification.json'


def verify_model_resources(model, directory=None, *, root=None, data_root=None, cancelled=lambda: False):
    resources = _model_resources(model, directory, root=root, data_root=data_root)
    if resources:
        assets, target, cache = resources
        verify_files(assets, target, cache, cancelled)


def _check_cancelled(cancelled):
    if cancelled():
        raise ResourceCancelled('模型自动修复已取消，已下载部分会保留，下次生成时继续')


def _writable_path(root, name):
    relative = Path(name)
    if relative.is_absolute() or '\\' in name or ':' in name or '..' in relative.parts:
        raise ValueError('模型清单路径越界')
    file = root / relative
    for item in [file, *file.parents]:
        if item == root:
            break
        if item.is_symlink() or item.is_junction():
            raise ValueError('模型修复路径经过链接，已保留原文件')
    if not file.resolve().is_relative_to(root):
        raise ValueError('模型清单路径越界')
    return file


@contextmanager
def _repair_lock(cache, cancelled):
    # 与 Electron 组件准备共享同一锁，避免安装/删除与自动修复交叉覆盖文件。
    lock = cache.parent.parent / '.component-preparation.lock'
    lock.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(2):
        _check_cancelled(cancelled)
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                pid = int(lock.read_text('utf8'))
                if pid <= 0:
                    raise ValueError('无效锁记录')
                if os.name == 'nt':
                    import ctypes
                    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
                    if handle:
                        ctypes.windll.kernel32.CloseHandle(handle)
                        raise RuntimeError('另一进程正在准备或移除模型，请稍后重试')
                    if ctypes.windll.kernel32.GetLastError() != 87:
                        raise RuntimeError('无法确认模型准备进程状态，请稍后重试')
                else:
                    os.kill(pid, 0)
                    raise RuntimeError('另一进程正在准备或移除模型，请稍后重试')
            except ProcessLookupError:
                pass
            except (ValueError, OSError) as error:
                raise RuntimeError('模型准备锁正在使用，请稍后重试') from error
            if attempt:
                raise RuntimeError('无法锁定模型修复目录，请稍后重试')
            lock.unlink()
    try:
        os.write(fd, str(os.getpid()).encode('ascii'))
        yield
    finally:
        os.close(fd)
        lock.unlink(missing_ok=True)


def _download_url(url):
    parsed = urlsplit(url)
    if parsed.username or parsed.password or not parsed.hostname or not (parsed.scheme == 'https' or
            parsed.scheme == 'http' and parsed.hostname in {'127.0.0.1', 'localhost', '::1'}):
        raise ValueError('模型下载地址必须使用 HTTPS')
    return url


class _ResourceRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, _download_url(newurl))


def _hash_file(file, cancelled):
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024**2), b''):
            _check_cancelled(cancelled)
            digest.update(block)
    return digest.hexdigest()


def _repair_file(asset, target, root, cancelled, progress):
    if not isinstance(asset.get('size'), int) or asset['size'] <= 0 or not re.fullmatch('[a-f0-9]{64}', asset.get('sha256', '')) or not asset.get('urls'):
        raise ValueError('模型下载清单无效，未替换原文件')
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = _writable_path(root, asset['name'] + '.part')
    if partial.exists() and not partial.is_file():
        raise ValueError('模型下载临时路径不是文件')
    opener = urllib.request.build_opener(_ResourceRedirect())
    errors = []
    for url in asset['urls']:
        _download_url(url)
        for attempt in range(2):
            _check_cancelled(cancelled)
            offset = partial.stat().st_size if partial.exists() else 0
            if offset >= asset['size']:
                if offset == asset['size'] and _hash_file(partial, cancelled) == asset['sha256']:
                    _check_cancelled(cancelled)
                    partial.replace(target)
                    return
                partial.unlink()
                offset = 0
            if shutil.disk_usage(target.parent).free < asset['size'] - offset + 512 * 1024**2:
                raise RuntimeError(f'自动修复 {target.name} 所需空间不足，请释放磁盘空间后重试')
            try:
                request = urllib.request.Request(url, headers={'Range': f'bytes={offset}-', 'User-Agent': 'VoxCPM-Model-Repair/1.0'})
                with opener.open(request, timeout=30) as response:
                    if response.status == 206:
                        match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
                        if not match or int(match[1]) != offset or int(match[3]) != asset['size'] or not offset <= int(match[2]) < asset['size']:
                            raise ValueError('模型服务器断点范围不匹配')
                    elif response.status == 200:
                        offset = 0
                    else:
                        raise ValueError('模型服务器未返回有效文件')
                    with partial.open('ab' if offset else 'wb') as stream:
                        done, last = offset, 0
                        progress(done, asset['size'])
                        while True:
                            _check_cancelled(cancelled)
                            block = response.read(1024**2)
                            if not block:
                                break
                            done += len(block)
                            if done > asset['size']:
                                raise ValueError('模型下载长度超过清单')
                            stream.write(block)
                            if time.monotonic() - last >= .3:
                                progress(done, asset['size'])
                                last = time.monotonic()
                if partial.stat().st_size != asset['size']:
                    raise ValueError('模型下载未完成，已保留断点')
                progress(asset['size'], asset['size'])
                if _hash_file(partial, cancelled) != asset['sha256']:
                    partial.unlink()
                    raise ValueError('模型下载 SHA256 校验失败')
                _check_cancelled(cancelled)
                partial.replace(target)  # 校验通过后才原子替换，保留失败前的旧文件。
                return
            except (OSError, ValueError, http.client.IncompleteRead) as error:
                errors.append(str(error))
    raise RuntimeError(f'自动修复 {target.name} 失败，已保留原文件及可续传的下载；再次生成可重试：' + '；'.join(errors[-2:]))


def ensure_model_resources(model, directory=None, *, root=None, data_root=None, catalog=None, cancelled=lambda: False, progress=lambda *_: None):
    resources = _model_resources(model, directory, root=root, data_root=data_root, catalog=catalog)
    if resources is None:
        return
    assets, target, cache = resources
    total = sum(asset['size'] for asset in assets)
    with _lock:
        completed = 0
        for asset in assets:
            _check_cancelled(cancelled)
            file = _writable_path(target, asset['name'])
            progress(round(completed * 100 / total), f'正在校验当前模型：{file.name}')
            try:
                verify_files([asset], target, cache, cancelled)
            except ResourceFileError as error:
                if os.environ.get('VOXCPM_INSTALLED_RESOURCES_READONLY') == '1' or os.environ.get('VOXCPM_OFFLINE') == '1':
                    raise RuntimeError(f'本地复用模式下模型缺失或校验失败：{file}。未下载或替换文件，请在已安装软件中检查该模型。') from error
                if not error.repairable:
                    raise RuntimeError(f'无法读取 {file.name}，请检查文件权限或占用；未自动替换原文件') from error
                with _repair_lock(cache, cancelled):
                    def report(done, size):
                        progress(round((completed + done) * 100 / total), f'正在自动修复 {file.name} · {done * 100 // size}%（{done / 1024**2:.1f}/{size / 1024**2:.1f} MB）')
                    _repair_file(asset, file, target, cancelled, report)
                    progress(round((completed + asset['size']) * 100 / total), f'正在复检已修复模型：{file.name}')
                    verify_files([asset], target, cache, cancelled)
            completed += asset['size']
        progress(100, '当前音乐模型资源已就绪，继续生成')
