"""安装完整独立音乐运行包；校验、暂存、切换后才标记就绪。"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile


def inside(root, relative):
    if not relative or '\\' in relative or ':' in relative or relative.startswith('/') or any(p in {'', '.', '..'} for p in relative.split('/')):
        raise ValueError('运行包含非法路径')
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError('运行包路径越界')
    return path


def install(cache, target, spec):
    for candidate in [Path(target), *Path(target).parents]:
        if candidate.is_symlink() or getattr(candidate, 'is_junction', lambda: False)():
            raise ValueError('运行环境路径不能经过符号链接或目录连接')
    cache, target = Path(cache).resolve(), Path(target).resolve()
    old = target.with_name(target.name + '.previous')
    staging = target.with_name(target.name + '.installing')
    for candidate in (old, staging):
        if candidate.is_symlink() or getattr(candidate, 'is_junction', lambda: False)():
            raise ValueError('运行环境暂存路径不能是符号链接或目录连接')
    # 上次可能在两个目录更名之间被终止，先恢复旧环境，再重新准备。
    if old.is_dir() and not target.exists():
        old.rename(target)
    if old.is_dir() and target.is_dir():
        if not (target / 'ready.json').is_file():
            raise RuntimeError('发现未完成的环境切换，请保留备份并检查目录')
        shutil.rmtree(old)
    try:
        _install(cache, target, staging, old, spec)
    finally:
        (cache / 'music-runtime.zip.part').unlink(missing_ok=True)


def _install(cache, target, staging, old, spec):
    print('正在校验并合并音乐运行包分卷', flush=True)
    cache.mkdir(parents=True, exist_ok=True)
    merged = cache / 'music-runtime.zip.part'
    digest = hashlib.sha256()
    with merged.open('wb') as output:
        for part in spec['parts']:
            name = part['name']
            if Path(name).name != name or '/' in name or '\\' in name:
                raise ValueError('分卷名称无效')
            path = cache / name
            if path.stat().st_size != part['size']:
                raise ValueError('运行包分卷大小不匹配')
            h = hashlib.sha256()
            with path.open('rb') as source:
                for block in iter(lambda: source.read(8 * 1024**2), b''):
                    h.update(block); digest.update(block); output.write(block)
            if h.hexdigest() != part['sha256']:
                raise ValueError('运行包分卷SHA256不匹配')
    if merged.stat().st_size != spec['size'] or digest.hexdigest() != spec['sha256']:
        raise ValueError('完整运行包校验失败')
    if staging.is_dir():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    with zipfile.ZipFile(merged) as bundle:
        names = set()
        for item in bundle.infolist():
            relative = item.filename
            inside(staging, relative)
            if relative.casefold() in names or (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('运行包含非法路径')
            names.add(relative.casefold())
        if sum(i.file_size for i in bundle.infolist()) > spec['installed_size'] + 16 * 1024**2:
            raise ValueError('运行包解压大小超过清单')
        print(f'正在解压独立音乐环境，共 {len(bundle.infolist())} 个文件', flush=True)
        for index, item in enumerate(bundle.infolist(), 1):
            bundle.extract(item, staging)
            if index % 2000 == 0:
                print(f'已解压 {index}/{len(bundle.infolist())} 个文件', flush=True)
    info = json.loads((staging / 'runtime-info.json').read_text(encoding='utf8'))
    if info['version'] != spec['version']:
        raise ValueError('运行包版本不匹配')
    for relative, size in info['files'].items():
        path = inside(staging, relative)
        if not path.is_file() or path.stat().st_size != size:
            raise ValueError('运行包解压不完整: ' + relative)
    for relative in spec['required']:
        if not inside(staging, relative).is_file():
            raise ValueError('运行包缺少必要文件')
    (staging / 'ready.json').write_text(json.dumps({'sha256': spec['sha256'], 'version': spec['version']}), encoding='utf8')
    if target.exists():
        if old.exists():
            raise RuntimeError('发现上次安装备份，请先完成恢复')
        target.rename(old)
        try:
            staging.rename(target)
        except BaseException:
            old.rename(target); raise
        shutil.rmtree(old)
    else:
        staging.rename(target)
    merged.unlink()
    print('音乐运行环境安装完成，等待启动自检', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--spec', required=True)
    args = parser.parse_args()
    install(args.cache, args.target, json.loads(Path(args.spec).read_text(encoding='utf8'))['runtime'])
