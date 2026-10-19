"""统一安装器的只读健康检查与按需修复；复用已签名应用事务。"""
from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import zipfile
import uuid
import engine

HEALTHY = '一切正常，无需再次安装，开始创作吧'


def safe(root, relative):
    if not isinstance(relative, str) or '\\' in relative or ':' in relative:
        raise ValueError('检查清单路径无效')
    parts = relative.split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise ValueError('检查清单路径越界')
    target = root.joinpath(*parts)
    # 用户资源可使用已有目录连接；应用文件不允许重定向至其他安装。
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError('应用文件路径不能指向安装目录之外')
    return target


def matches(file, item):
    try:
        return file.is_file() and file.stat().st_size == item['size'] and engine.digest(file) == item['sha256']
    except OSError:
        return False


def app_manifest(root, payload):
    config = engine.read(payload / 'repair-config.json')
    identity = engine.installed_identity(root)
    candidates = [payload / 'snapshot/envelope.json']
    candidates += list((root / 'data/cache/updates').glob('session-*/envelope.json'))
    for file in candidates:
        try:
            manifest = engine.verify_envelope(engine.read(file), config['publicKey'])
            if (manifest['version'], manifest['releaseId']) == identity:
                return manifest
        except Exception:
            continue
    # 本地没有对应版本证据时查询签名源；不以更新版本代替当前版本的完整性证据。
    envelope, manifest, network_error = engine.choose_release(payload, config)
    if (manifest['version'], manifest['releaseId']) == identity:
        return manifest
    return None


def probe_runtime(root):
    ready = engine.read(root / 'data/cache/runtime-ready.json')
    if not ready.get('files'):
        raise ValueError('音频环境缺少就绪记录')
    for item in ready['files']:
        file = Path(item['file'])
        stat = file.stat()
        if item['type'] == 'file' and (stat.st_size != item['size'] or abs(stat.st_mtime_ns / 1e6 - item['mtimeMs']) > .05):
            raise ValueError('音频环境或模型文件发生变化，需要复检：' + file.name)
    python = ready['python']
    source = (root / 'resources/app/runtime-service.js').read_text('utf8')
    probe = re.search(r'const STARTUP_PROBE = String.raw`(.*?)`;', source, re.S)
    if not probe:
        raise ValueError('音频自检入口不完整')
    args = [python, '-I', '-c', probe.group(1)]
    if ready.get('managed'):
        profile = Path(python).parent.name.removeprefix('py312-')
        config = engine.read(root / 'resources/app/runtime-config.json')
        args.extend([str(root / 'resources/app/runtime-requirements.txt'), config['python']['version'], config['profiles'][profile]['torch'] + '+' + profile])
    result = subprocess.run(args,
                            capture_output=True, timeout=90, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise ValueError('音频依赖加载失败，需要修复')


def inspect(root, payload):
    """不关闭进程、不下载资源、不改写用户安装；日志只写外部会话。"""
    issues = []
    desktop = engine.read(payload / 'desktop-manifest.json')
    engine.emit('正在检查桌面启动文件…', 5)
    native = [i for i in desktop['files'] if not i['name'].startswith(('resources/app/', 'app/'))
              and i['name'] not in ('runtime_manifest.json', 'lightweight.json', '使用说明.txt')]
    for i, item in enumerate(native):
        if not matches(safe(root, item['name']), item):
            issues.append('桌面文件缺失或损坏：' + item['name'])
        engine.emit('正在校验桌面文件 %d/%d' % (i + 1, len(native)), 5 + int(15 * (i + 1) / len(native)))
    engine.emit('正在检查已安装版本的签名应用文件…', 22)
    manifest = app_manifest(root, payload)
    if manifest is None:
        issues.append('当前应用版本缺少可验证的签名记录或版本信息损坏')
    else:
        for i, item in enumerate(manifest['files']):
            if not matches(safe(root, item['path']), item):
                issues.append('应用文件缺失或损坏：' + item['path'])
            engine.emit('正在校验应用文件 %d/%d' % (i + 1, len(manifest['files'])), 22 + int(25 * (i + 1) / len(manifest['files'])))
    if (root / 'data/cache/updates/pending.json').exists():
        issues.append('存在未完成更新事务')
    if issues:
        return issues
    engine.emit('正在检查音频环境与已安装模型…', 50)
    try:
        probe_runtime(root)
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        issues.append('运行环境需要复检：' + str(error))
    app = root / 'resources/app'
    try:
        profile = engine.read(app / 'updater-runtime-config.json')
        directory = root / 'data/tools/updater-runtime' / profile['id']
        # 更新环境按需创建；不存在时由正常更新流程补齐，不判为故障。
        if directory.exists():
            for item in profile['files']:
                if not matches(safe(directory, item['path']), item):
                    issues.append('独立更新环境文件损坏：' + item['path'])
    except (OSError, ValueError, KeyError) as error:
        issues.append('更新环境清单异常：' + str(error))
    engine.emit('正在检查已选择的可选组件…', 65)
    try:
        selection = engine.read(root / 'data/component-selection.json')
        receipt = engine.read(root / 'data/cache/component-ready.json')
        if sorted(selection['selected']) != sorted(receipt['selected']):
            raise ValueError('组件选择与就绪记录不一致')
        catalog = engine.read(app / 'music-config.json')
        selected = [m for m in catalog['models'] if m['id'] in selection['selected']]
        for model in selected:
            for item in model['files']:
                engine.emit('正在校验音乐模型：' + item['name'], 70)
                # 模型可能通过只读硬链接复用；只核验不写入。
                file = root / item['name']
                if not matches(file, item):
                    issues.append('音乐模型缺失或损坏：' + item['name'])
        if selected:
            directory = root / 'runtime/music' / catalog['runtime']['version']
            result = subprocess.run([str(directory / 'python/python.exe'), str(root / 'app/src/voxcpm/music_worker.py'),
                                     '--probe', '--engine', str(directory), '--models', ','.join(m['id'] for m in selected)],
                                    capture_output=True, timeout=180, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if result.returncode:
                issues.append('音乐运行环境自检失败')
        if 'lipsync' in selection['selected']:
            # 使用已校验源码中的只读状态检查，不启动生成或下载。
            # 视频完整检查由下方独立探针执行，失败进入既有准备链路。
            probe = root / 'app/src/voxcpm/lipsync_prepare.py'
            import importlib.util
            spec = importlib.util.spec_from_file_location('maintenance_video', probe)
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            directory = root / 'data/lipsync'
            video_config = engine.read(root / 'app/src/voxcpm/lipsync-install.json')
            installed_video = engine.read(directory / 'runtime.json')
            version = installed_video['version']
            for item in [*video_config['common'], video_config['models'][version]]:
                if not matches(directory / item['path'], item):
                    issues.append('视频资源缺失或损坏：' + item['path'])
            result = subprocess.run([str(directory / 'env/Scripts/python.exe'), '-c', module.PROBE, str(directory / 'source')],
                                    capture_output=True, timeout=120, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if result.returncode:
                issues.append('视频运行环境自检失败')
    except (OSError, ValueError, KeyError, ImportError, subprocess.TimeoutExpired) as error:
        issues.append('可选组件需要复检：' + str(error))
    return issues


def restore_desktop(root, payload, work):
    manifest = engine.read(payload / 'desktop-manifest.json')
    archive = payload / 'desktop.zip'
    if engine.digest(archive) != manifest['package']['sha256']:
        raise ValueError('内置桌面包校验失败')
    native = [i for i in manifest['files'] if not i['name'].startswith(('resources/app/', 'app/'))
              and i['name'] not in ('runtime_manifest.json', 'lightweight.json', '使用说明.txt')]
    with zipfile.ZipFile(archive) as z:
        prefix = z.namelist()[0].split('/')[0]
        for item in native:
            target = safe(root, item['name'])
            if matches(target, item):
                continue
            stage = safe(work / 'desktop-stage', item['name'])
            stage.parent.mkdir(parents=True, exist_ok=True)
            with z.open(prefix + '/' + item['name']) as src, stage.open('wb') as dst:
                shutil.copyfileobj(src, dst)
            if not matches(stage, item):
                raise ValueError('桌面资源校验失败：' + item['name'])
            if target.exists():
                backup = safe(work / 'desktop-backup', item['name']); backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, backup)
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(target.name + '.repair-' + uuid.uuid4().hex)
            try:
                with stage.open('rb') as src, temporary.open('xb') as dst:
                    shutil.copyfileobj(src, dst)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)


def maintain(request):
    root, payload, work = Path(request['root']).resolve(), Path(request['payload']).resolve(), Path(request['work']).resolve()
    if root == Path(root.anchor) or not any((root / n).is_file() for n in ('.voxcpm-install.json', 'runtime_manifest.json')):
        raise ValueError('未识别到有效安装目录，已停止操作')
    issues = inspect(root, payload)
    if not issues:
        report = {'status': 'healthy', 'message': HEALTHY, 'root': str(root), 'issues': [], 'repaired': False}
    else:
        engine.write(work / 'inspection.json', {'issues': issues, 'root': str(root)})
        engine.emit('发现 %d 项问题，正在准备修复…' % len(issues), 0)
        # 修复前先确认可信目标不会降级，不能先替换新版桌面壳。
        config = engine.read(payload / 'repair-config.json')
        _, target, _ = engine.choose_release(payload, config)
        version, release = engine.installed_identity(root)
        if version and engine.release_order({'version': version, 'releaseId': release}) > engine.release_order(target):
            raise ValueError('当前版本高于可用修复包，请使用更新的安装器；未修改现有应用')
        transaction = engine.load_transaction(payload)
        with engine.repair_lock(root, transaction):
            engine.stop_owned_processes(root, work)
            restore_desktop(root, payload, work)
            repair_request = {**request, 'resultPath': str(work / 'transaction-result.json')}
            report = engine.perform_repair(repair_request, work, payload, config, transaction, engine.validate_root(root))
        engine.emit('正在进行修复后完整复检…', 0)
        remaining = inspect(root, payload)
        if remaining:
            raise RuntimeError('修复后仍有问题：' + '；'.join(remaining[:5]))
        report.update(message='修复完成，开始创作吧', repaired=True, issues=issues)
    engine.write(work / 'status.json', report)
    engine.write(request['resultPath'], report)
    engine.emit(report['message'], 100)
    return report
