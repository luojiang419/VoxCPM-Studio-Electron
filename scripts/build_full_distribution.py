"""只读复用正式安装，构建双 CUDA 全量分发；资源准备与封装可分别恢复。"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / 'frontend/voxcpm_studio_electron'
SKIP_DIRS = {'__pycache__', '.git', '.pytest_cache', '.mypy_cache'}
last_progress = 0
copied = 0


def log(message):
    print(message, flush=True)


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def write(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf8')


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def checked(path, asset):
    path = Path(path)
    if not path.is_file() or path.stat().st_size != asset['size'] or digest(path) != asset['sha256']:
        raise ValueError('固定资源缺失或哈希不符：' + str(path))
    return path


def safe(root, relative):
    if not relative or '\\' in relative or ':' in relative or any(p in ('', '.', '..') or p.rstrip(' .') != p for p in relative.split('/')):
        raise ValueError('资源路径无效：' + relative)
    base = root.resolve()
    result = base / relative
    if not result.resolve().is_relative_to(base):
        raise ValueError('资源路径越界：' + relative)
    return result


def copy_file(source, target):
    global copied, last_progress
    source, target = Path(source), Path(target)
    if source.is_symlink() or source.is_junction():
        raise ValueError('不复制目录连接或符号链接：' + str(source))
    target.parent.mkdir(parents=True, exist_ok=True)
    stat = source.stat()
    existing = target.stat() if target.is_file() else None
    if not existing or (existing.st_size, existing.st_mtime_ns) != (stat.st_size, stat.st_mtime_ns):
        shutil.copy2(source, target)
        copied += stat.st_size
    if time.monotonic() - last_progress > 10:
        log(f'资源复制中：本轮已复制 {copied / 1024**3:.2f} GiB；{source.name}')
        last_progress = time.monotonic()


def copy_tree(source, target):
    source, target = Path(source), Path(target)
    def pairs():
        for folder, dirs, files in os.walk(source, followlinks=False):
            base = Path(folder)
            dirs[:] = [name for name in dirs if name not in SKIP_DIRS]
            for name in dirs:
                path = base / name
                if path.is_symlink() or path.is_junction():
                    raise ValueError('运行时存在外部连接：' + str(path))
            for name in files:
                if name.endswith(('.pyc', '.pyo', '.log', '.tmp', '.part')) or name == '.env' or name.startswith('__editable__'):
                    continue
                yield base / name, target / (base / name).relative_to(source)
    copy_batch(pairs())


def copy_batch(pairs):
    with ThreadPoolExecutor(max_workers=8) as pool:
        for _ in pool.map(lambda pair: copy_file(*pair), pairs):
            pass


def asset_source(asset):
    candidates = [ROOT / 'builds/modelscope-distribution/assets', ROOT / 'builds/modelscope-distribution/wheels',
                  ROOT / 'builds/lipsync-assets', ROOT.parent / 'vendor/windows_312_cu126/assets',
                  ROOT.parent / 'vendor/windows_312_cu126/wheels']
    for folder in candidates:
        candidate = folder / asset['name']
        if candidate.is_file() and candidate.stat().st_size == asset['size'] and digest(candidate) == asset['sha256']:
            return candidate
    raise ValueError('本机固定资源不存在，未自动重复下载：' + asset['name'])


def python_paths(directory):
    # 相对当前解释器，而非构建机器的安装目录。
    (directory / 'python312._pth').write_text('python312.zip\n.\nLib/site-packages\n../../../app/src\nimport site\n', encoding='utf8')


def portable_consoles(payload, work):
    launcher = work / 'portable-python-console.exe'
    metadata = work / 'portable-console-build.json'
    fingerprint = digest(ROOT / 'scripts/PortablePythonConsole.cs')
    if not launcher.exists() or not metadata.exists() or read(metadata) != {'source': fingerprint, 'executable': digest(launcher)}:
        subprocess.run(['C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', '/nologo', '/target:exe', '/optimize+',
                        '/out:' + str(launcher), str(ROOT / 'scripts/PortablePythonConsole.cs')], check=True)
        write(metadata, {'source': fingerprint, 'executable': digest(launcher)})
    count = 0
    for python in [*payload.glob('runtime/managed/*/python.exe'), *payload.glob('runtime/music/*/python/python.exe')]:
        scripts = python.parent / 'Scripts'
        for command in scripts.glob('*.exe'):
            entry = scripts / 'portable-entries' / (command.stem + '.py')
            if zipfile.is_zipfile(command):
                with zipfile.ZipFile(command) as archive:
                    if '__main__.py' not in archive.namelist():
                        continue
                    body = archive.read('__main__.py')
                entry.parent.mkdir(exist_ok=True)
                entry.write_bytes(body)
            if entry.is_file():
                shutil.copyfile(launcher, command)
                count += 1
        info = python.parent.parent / 'runtime-info.json'
        if info.is_file():
            value = read(info)
            for file in scripts.rglob('*'):
                if file.is_file():
                    value['files'][file.relative_to(info.parent).as_posix()] = file.stat().st_size
            value['packaging'] = 'portable-console-v1'
            write(info, value)
    log(f'已重建 {count} 个可迁移命令入口，避免调用构建机器的 Python。')


def prepare_resources(installed, work):
    payload = work / 'payload/JVOXStudio'
    marker = work / 'resources-ready.json'
    if marker.is_file():
        if not (payload / 'runtime/managed/py312-cu126/python.exe').is_file():
            raise ValueError('该工作目录的临时副本已清理；分发包仍可使用，重新构建请指定新的工作目录。')
        log('资源准备检查点已存在，保留已完成副本。')
        return payload
    payload.mkdir(parents=True, exist_ok=True)
    runtime = read(FRONTEND / 'runtime-config.json')
    music = read(FRONTEND / 'music-config.json')
    ace = next(item for item in music['models'] if item['id'] == 'ace-xl-turbo')
    if not (work / 'models-ready.json').exists():
        log('准备当前配音、识别、降噪及 ACE 模型；不复制用户作品和配置。')
        for model in runtime['models']:
            for asset in model['files']:
                relative = 'models/' + model['folder'] + '/' + asset['name']
                copy_file(checked(safe(installed, relative), asset), safe(payload, relative))
        for asset in ace['files']:
            copy_file(checked(safe(installed, asset['name']), asset), safe(payload, asset['name']))
        write(work / 'models-ready.json', {'copied': True})
    for profile in ('cu126', 'cu128'):
        directory = payload / f'runtime/managed/py312-{profile}'
        complete = work / f'{profile}-ready.json'
        if complete.exists():
            log(profile + ' 已完成，复用检查点。')
            continue
        log('准备 ' + profile + ' 独立可迁移主运行时。')
        copy_tree(installed / 'runtime/managed/py312-cu126', directory)
        python_paths(directory)
        if profile == 'cu128':
            wheels = [str(asset_source(asset)) for asset in runtime['profiles'][profile]['wheels']]
            env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1', 'PIP_NO_INDEX': '1',
                   'PIP_NO_CACHE_DIR': '1', 'PIP_DISABLE_PIP_VERSION_CHECK': '1'}
            subprocess.run([str(directory / 'python.exe'), '-I', '-m', 'pip', 'install', '--no-index', '--no-deps',
                            '--force-reinstall', *wheels], env=env, check=True)
        subprocess.run([str(directory / 'python.exe'), '-I', '-m', 'pip', 'check'], check=True)
        for direct in (directory / 'Lib/site-packages').glob('*.dist-info/direct_url.json'):
            direct.unlink()
        write(directory / 'ready.json', {'profile': profile, 'bundled': True})
        write(complete, {'profile': profile, 'prepared': True})
    log('按原始固定清单复制独立音乐引擎，排除所有后来产生的个人文件。')
    music_source = installed / ('runtime/music/' + music['runtime']['version'])
    music_target = payload / ('runtime/music/' + music['runtime']['version'])
    music_target.mkdir(parents=True, exist_ok=True)
    music_target = music_target.resolve()
    info = read(music_source / 'runtime-info.json')
    def music_pairs():
        for relative, size in info['files'].items():
            if relative.startswith(('ComfyUI/user/', 'ComfyUI/input/', 'ComfyUI/output/', 'ComfyUI/temp/')):
                raise ValueError('原始音乐清单含用户目录，需先审查：' + relative)
            source = safe(music_source, relative)
            if source.stat().st_size != size:
                raise ValueError('原始音乐引擎文件发生变化：' + relative)
            yield source, safe(music_target, relative)
    copy_batch(music_pairs())
    copy_file(music_source / 'runtime-info.json', music_target / 'runtime-info.json')
    write(music_target / 'ready.json', {'sha256': music['runtime']['sha256'], 'version': music['runtime']['version']})
    log('准备 LatentSync 1.6 模型与双版本视频依赖；首次启用时按主 CUDA 环境本地展开。')
    video = read(ROOT / 'backend/voxcpm/lipsync-install.json')
    assets = payload / 'offline-assets'
    for asset in [video['source'], video['dependencies'], *video['torchvision'].values()]:
        copy_file(asset_source(asset), assets / asset['name'])
    archive = asset_source(video['source'])
    prefix = 'LatentSync-' + video['sourceRevision'] + '/'
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            if entry.is_dir():
                continue
            if not entry.filename.startswith(prefix):
                raise ValueError('视频固定源包根目录不匹配')
            target = safe(payload / 'data/lipsync/source', entry.filename[len(prefix):])
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(entry) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output, 1024**2)
    for asset in [*video['common'], video['models']['1.6']]:
        copy_file(checked(safe(installed / 'data/lipsync', asset['path']), asset), safe(payload / 'data/lipsync', asset['path']))
    copy_file(installed / 'data/lipsync/tools/ffmpeg.exe', payload / 'data/lipsync/tools/ffmpeg.exe')
    # 更新器使用单独的固定签名验证环境，不复制原安装 data 中的任何账号信息。
    updater = read(FRONTEND / 'updater-runtime-config.json')
    updater_source = ROOT / ('builds/updater-runtime/' + updater['id'])
    updater_target = payload / ('data/tools/updater-runtime/' + updater['id'])
    for asset in updater['files']:
        copy_file(checked(safe(updater_source, asset['path']), asset), safe(updater_target, asset['path']))
    write(marker, {'sourceInstallation': str(installed), 'payload': str(payload), 'profiles': ['cu126', 'cu128'],
                   'models': ['VoxCPM2', 'SenseVoiceSmall', 'ZipEnhancer', 'ace-xl-turbo', 'LatentSync-1.6']})
    return payload


def package(work, output):
    from build_lightweight import build as build_desktop
    from build_bootstrap import build as build_launcher
    from release_update import build as build_snapshot
    payload = work / 'payload/JVOXStudio'
    if not (work / 'resources-ready.json').exists():
        raise ValueError('先执行 resources 阶段')
    if not payload.is_dir():
        raise ValueError('已清理构建暂存目录，请使用现有分发包或指定新工作目录重建。')
    stage = work / 'application-ready.json'
    if stage.exists():
        snapshot = Path(read(stage)['snapshot'])
    else:
        snapshot = build_snapshot('双 CUDA 全量分发：内置当前模型和 20–40/50 系独立运行时，按显卡自动选用并保留魔搭按需补齐。', '0.2.0')
        desktop = build_desktop(work / 'desktop', skip_build=True, skip_zip=True)
        copy_tree(desktop, payload)
        (payload / 'lightweight.json').unlink(missing_ok=True)
        write(payload / 'runtime_manifest.json', {'protocol': 1, 'mode': 'full', 'platform': 'win32-x64', 'version': '2.0.4'})
        write(stage, {'snapshot': str(snapshot)})
    portable_consoles(payload, work)
    output.mkdir(parents=True, exist_ok=True)
    archive = output / 'JVOX-完整资源.zip'
    inventory_path = work / 'inventory.json'
    if not inventory_path.exists():
        inventory = []
        known_models = {}
        runtime = read(FRONTEND / 'runtime-config.json')
        for model in runtime['models']:
            for asset in model['files']:
                relative = 'models/' + model['folder'] + '/' + asset['name']
                checked(safe(payload, relative), asset)
                known_models[relative] = asset['sha256']
        for model in read(FRONTEND / 'music-config.json')['models']:
            if model['id'] == 'ace-xl-turbo':
                for asset in model['files']:
                    checked(safe(payload, asset['name']), asset)
                    known_models[asset['name']] = asset['sha256']
        files = []
        for file in sorted(payload.rglob('*')):
            if any(part in SKIP_DIRS for part in file.relative_to(payload).parts) or file.suffix in ('.pyc', '.pyo'):
                continue
            if file.is_symlink() or file.is_junction():
                raise ValueError('分发内容不允许依赖外部连接：' + str(file))
            if file.is_file():
                files.append(file)
        def record(file):
            relative = file.relative_to(payload).as_posix()
            return {'name': relative, 'size': file.stat().st_size,
                    'sha256': known_models[relative] if relative in known_models else digest(file)}
        with ThreadPoolExecutor(max_workers=8) as pool:
            for index, asset in enumerate(pool.map(record, files)):
                inventory.append(asset)
                if index % 2000 == 0:
                    log(f'生成全量文件校验清单：已检查 {len(inventory)} 个文件')
        write(inventory_path, inventory)
    inventory = read(inventory_path)
    if not archive.exists():
        temporary = archive.with_suffix('.zip.building')
        log('压缩完整 ZIP64 资源包；资源只写入一次，不包含作品、账号或密钥。')
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as bundle:
            total = sum(a['size'] for a in inventory)
            done = 0; last = 0
            for asset in inventory:
                file = safe(payload, asset['name'])
                bundle.write(file, 'JVOXStudio/' + asset['name'])
                done += asset['size']
                if time.monotonic() - last > 10:
                    log(f'压缩进度：{done/1024**3:.2f}/{total/1024**3:.2f} GiB')
                    last = time.monotonic()
        temporary.rename(archive)
    plan = build_launcher(archive, work / 'launcher', datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S'),
                          full_bundle=True, inventory=inventory)
    installer = output / 'JVOX全量安装器.exe'
    copy_file(plan['launcher'], installer)
    checksums = {installer.name: digest(installer), archive.name: digest(archive)}
    (output / 'SHA256SUMS.txt').write_text(''.join(f'{value}  {name}\n' for name, value in checksums.items()), encoding='utf8')
    manifest = read(snapshot / 'manifest.json')
    summary = {'version': manifest['version'], 'releaseId': manifest['releaseId'], 'installer': installer.name,
               'archive': archive.name, 'archiveBytes': archive.stat().st_size, 'installedBytes': sum(a['size'] for a in inventory),
               'files': len(inventory), 'profiles': ['cu126', 'cu128'], 'checksums': checksums,
               'models': read(work / 'resources-ready.json')['models'], 'privateDataIncluded': False}
    write(output / '分发记录.json', summary)
    write(work / 'package-ready.json', {**summary, 'snapshot': str(snapshot), 'plan': plan, 'distribution': str(output)})
    (output / '分发与安装说明.txt').write_text(
        '请把本文件夹内的 JVOX全量安装器.exe 和 JVOX-完整资源.zip 一起分发，不能只发 EXE。\n'
        '用户双击安装器，选择独立安装位置及功能。已携带的资源在本地展开，不需要另装 Python 或 CUDA Toolkit。\n'
        '20–40 系自动使用 CUDA 12.6；50 系自动使用 CUDA 12.8。驱动分别需 560.76 / 570.65 或更新。\n'
        '包含 VoxCPM2、SenseVoice、降噪、ACE-Step 1.5 XL Turbo、LatentSync 1.6；其余模型仍按需联网补齐。\n'
        '视频依赖已随包，首次启用会根据 CUDA 版本本地展开。不同模型仍有各自显存要求。\n'
        '缺失或损坏资源仍可从魔搭补齐；本包不包含用户作品、账号、API 密钥或个人设置。\n'
        '安装后可删除分发资源包。资源 ZIP 大于 4GB，请使用 NTFS 或 exFAT 等支持大文件的存储。\n'
        f'展开内容约 {summary["installedBytes"]/1024**3:.1f} GiB，安装盘另外保留至少 5 GiB 空间。\n', encoding='utf8')
    log(json.dumps(summary, ensure_ascii=False))


def refresh_launcher(work, output):
    """复用已压好的资源，仅重编译原生壳；不重压几十 GB 的模型。"""
    from build_bootstrap import build as build_launcher
    package = read(work / 'package-ready.json')
    archive = output / package['archive']
    if digest(archive) != package['checksums'][archive.name]:
        raise ValueError('完整资源包发生变化，不能仅替换安装器')
    sources = ['bootstrap/Program.cs', 'bootstrap/Installation.cs', 'bootstrap/Components.cs', 'bootstrap/long-path.manifest',
               'bootstrap/SharedTheme.cs', 'bootstrap/DiskCard.cs', 'scripts/build_bootstrap.py']
    fingerprint = hashlib.sha256(b''.join((ROOT / name).read_bytes() for name in sources)).hexdigest()[:12]
    directory = work / ('launcher-' + fingerprint)
    plan_file = work / (directory.name + '-publication-plan.json')
    plan = read(plan_file) if plan_file.exists() else build_launcher(archive, directory,
        datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S'), full_bundle=True, inventory=read(work / 'inventory.json'))
    copy_file(plan['launcher'], output / package['installer'])
    package['checksums'][package['installer']] = digest(output / package['installer'])
    package['plan'] = plan
    package['nativeSourceFingerprint'] = fingerprint
    write(work / 'package-ready.json', package)
    write(output / '分发记录.json', {key: value for key, value in package.items() if key not in ('plan', 'snapshot', 'distribution')})
    (output / 'SHA256SUMS.txt').write_text(''.join(f'{value}  {name}\n' for name, value in package['checksums'].items()), encoding='utf8')
    log(json.dumps({'launcherRefreshed': True, 'fingerprint': fingerprint, 'checksums': package['checksums']}, ensure_ascii=False))


def refresh_consoles(work, output):
    """仅更新少量命令入口，7-Zip 原样复用大型模型的压缩数据。"""
    package = read(work / 'package-ready.json')
    archive = output / package['archive']
    if digest(archive) != package['checksums'][archive.name]:
        raise ValueError('完整资源包发生变化，停止增量封装')
    payload = work / 'payload/JVOXStudio'
    if not payload.is_dir():
        raise ValueError('命令入口暂存已清理；完整包仍可分发，修改入口请在新的工作目录重建。')
    portable_consoles(payload, work)
    inventory = read(work / 'inventory.json')
    changed = []
    for asset in inventory:
        name = asset['name']
        if name.startswith('runtime/') and (('/Scripts/' in name and name.endswith('.exe')) or name.endswith('/runtime-info.json')):
            file = safe(payload, name)
            checksum = digest(file)
            if checksum != asset['sha256'] or file.stat().st_size != asset['size']:
                asset.update(size=file.stat().st_size, sha256=checksum)
                changed.append('JVOXStudio/' + name)
    if changed:
        listing = work / 'updated-console-files.txt'
        listing.write_text('\n'.join(changed) + '\n', encoding='utf8')
        seven = FRONTEND / 'node_modules/7zip-bin/win/x64/7za.exe'
        log(f'仅更新 {len(changed)} 个命令/元数据文件，不重新压缩大模型。')
        subprocess.run([str(seven), 'u', '-tzip', str(archive), '@' + str(listing), '-scsUTF-8', '-mx=1', '-mmt=8',
                        '-bso0', '-bsp0', '-y', '-w' + str(work)], cwd=work / 'payload', check=True)
        with zipfile.ZipFile(archive) as packed:
            if len(packed.infolist()) != len(inventory) or any(entry.is_dir() for entry in packed.infolist()):
                raise ValueError('增量封装改变了资源条目结构')
            expected = {asset['name']: asset for asset in inventory}
            for name in changed:
                if hashlib.sha256(packed.read(name)).hexdigest() != expected[name.split('/', 1)[1]]['sha256']:
                    raise ValueError('更新的命令入口校验失败：' + name)
        write(work / 'inventory.json', inventory)
        package.update(archiveBytes=archive.stat().st_size, installedBytes=sum(asset['size'] for asset in inventory))
        package['checksums'][archive.name] = digest(archive)
        write(work / 'package-ready.json', package)
    refresh_launcher(work, output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['resources', 'package', 'launcher', 'consoles'])
    parser.add_argument('--installed', type=Path)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    work = args.work.resolve()
    if not work.is_relative_to((ROOT / 'builds').resolve()):
        raise ValueError('构建工作目录必须位于本项目 builds')
    work.mkdir(parents=True, exist_ok=True)
    if args.phase == 'resources':
        if not args.installed or not (args.installed / '.voxcpm-install.json').is_file():
            raise ValueError('必须指定带有正式安装记录的只读来源')
        prepare_resources(args.installed.resolve(), work)
    else:
        if not args.output:
            raise ValueError('需要 --output 分发位置')
        if not args.output.resolve().is_relative_to((ROOT / 'builds').resolve()):
            raise ValueError('分发输出必须位于本项目 builds')
        if args.phase == 'launcher':
            refresh_launcher(work, args.output.resolve())
        elif args.phase == 'consoles':
            refresh_consoles(work, args.output.resolve())
        else:
            package(work, args.output.resolve())
