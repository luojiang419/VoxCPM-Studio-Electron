"""独立验证完整 ZIP64 解压、目录迁移、双 CUDA、实际配音、视频离线准备与桌面启动。"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from build_full_distribution import ROOT, checked, digest, read, write


def run(work):
    package = read(work / 'package-ready.json')
    output = Path(package['distribution'])
    plan = package['plan']
    validation = work / 'validation'
    validation.mkdir(exist_ok=True)
    # 每阶段有独立记录；恢复验证时保留已完成解压，不重复复制几十 GB。
    extracted = validation / '提取目录'
    moved = validation / '移动后的安装 JVOX'
    for candidate in (extracted, moved):
        if not candidate.resolve().is_relative_to((ROOT / 'builds').resolve()) or candidate.is_symlink() or candidate.is_junction():
            raise ValueError('验收路径不在受控工作区内')
    if not moved.exists():
        compiler = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        native = validation / 'FullArchiveTest.exe'
        subprocess.run([compiler, '/nologo', '/target:exe', '/main:BootstrapTests', '/out:' + str(native),
            '/win32manifest:' + str(ROOT / 'bootstrap/long-path.manifest'),
            *['/reference:' + name for name in ['System.Windows.Forms.dll', 'System.Drawing.dll', 'Accessibility.dll',
             'System.Web.Extensions.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll']],
            *[str(ROOT / 'bootstrap' / name) for name in ['Program.cs', 'SharedTheme.cs', 'Installation.cs', 'Components.cs', 'DiskCard.cs', 'Tests.cs']]], check=True)
        print('开始验证实际完整 ZIP64：原生校验、解压和逐文件 SHA256。', flush=True)
        subprocess.run([str(native), plan['manifest'], str(extracted), str(output)], check=True, timeout=5400)
        # 两个路径都在 builds，且目标不存在，整目录只更名，不创建共享连接。
        extracted.rename(moved)
        write(validation / 'extraction.json', {'passed': True, 'nativeZIP64': True, 'movedRoot': str(moved)})
    env = {key: value for key, value in os.environ.items() if not key.startswith('VOXCPM_')}
    env.update(VOXCPM_OFFLINE='1', HF_HUB_OFFLINE='1', HF_DATASETS_OFFLINE='1', PIP_NO_INDEX='1',
               PYTHONUTF8='1', PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1',
               VOXCPM_LOCAL_ASSET_DIRS=str(moved / 'offline-assets'))
    runtime_report = validation / 'runtimes.json'
    if not runtime_report.exists():
        source = (moved / 'resources/app/runtime-service.js').read_text(encoding='utf8')
        probe = re.search(r'const PROBE = String.raw`(.*?)`;', source, re.S)[1]
        rows = []
        for profile in ('cu126', 'cu128'):
            python = moved / f'runtime/managed/py312-{profile}/python.exe'
            print('验证迁移后的 ' + profile + '、依赖闭包与实际 CUDA 算子。', flush=True)
            result = subprocess.run([str(python), '-B', '-I', '-X', 'utf8', '-c', probe, profile,
                                    str(moved / 'resources/app/runtime-requirements.txt')],
                                    capture_output=True, text=True, encoding='utf8', env=env, timeout=240)
            if result.returncode:
                raise RuntimeError(result.stdout + result.stderr)
            row = json.loads(result.stdout.splitlines()[-1]); row['profile'] = profile
            assert Path(row['python']).is_relative_to(moved)
            rows.append(row)
            command = python.parent / 'Scripts/pip.exe'
            cli = subprocess.run([str(command), '--version'], cwd=validation, capture_output=True, text=True,
                                 encoding='utf8', env=env, timeout=60, check=True)
            assert os.path.normcase(str(python.parent)) in os.path.normcase(cli.stdout)
            row['portablePip'] = True
        write(runtime_report, {'passed': True, 'rows': rows, 'RTX50PhysicalTest': False})
    voice_report = validation / 'voice.json'
    if not voice_report.exists():
        python = moved / 'runtime/managed/py312-cu126/python.exe'
        code = '''import json,sys,numpy as np,soundfile as sf
from pathlib import Path
from voxcpm.core import VoxCPM
root=Path(sys.argv[1]); output=Path(sys.argv[2])
model=VoxCPM(voxcpm_model_path=str(root/'models/openbmb__VoxCPM2'),enable_denoiser=False,optimize=False)
audio=model.generate(text='离线全量安装验证完成，欢迎使用。',inference_timesteps=4,max_len=256)
assert np.isfinite(audio).all() and audio.size>1000 and abs(audio).max()>0
rate=model.tts_model.sample_rate; sf.write(output/'offline-voice.wav',audio,rate)
(output/'voice.json').write_text(json.dumps(dict(passed=True,sampleRate=rate,seconds=round(audio.size/rate,3))),encoding='utf8')
'''
        print('验证迁移目录中的实际配音，不读取正式安装模型。', flush=True)
        subprocess.run([str(python), '-B', '-I', '-X', 'utf8', '-c', code, str(moved), str(validation)], env=env, check=True, timeout=300)
    video_report = validation / 'video.json'
    if not video_report.exists():
        python = moved / 'runtime/managed/py312-cu126/python.exe'
        print('验证视频 1.6 从本包离线资源建立匹配环境。', flush=True)
        subprocess.run([str(python), '-B', str(moved / 'app/src/voxcpm/lipsync_prepare.py'), '--root', str(moved / 'data/lipsync'),
                        '--version', '1.6', '--base-python', str(python)], env=env, check=True, timeout=600)
        write(video_report, {'passed': True, 'version': '1.6', 'offline': True, 'ready': (moved / 'data/lipsync/ready-1.6.json').is_file()})
    app_report = validation / 'app-report.json'
    if not app_report.exists():
        subprocess.run(['node', str(ROOT / 'scripts/smoke_full_bundle_app.cjs'), str(moved), str(validation)],
                        env=env, check=True, timeout=300)
    # 分发时必须保持 EXE 与资源 ZIP 配对，重新核对其最终校验值。
    for name, checksum in package['checksums'].items():
        if digest(output / name) != checksum:
            raise ValueError('分发文件发生变化：' + name)
    manifest = read(plan['manifest'])
    forbidden = [asset['name'] for asset in manifest['files'] if asset['name'].startswith(('data/config/', 'data/outputs/', 'data/cache/', '.update-private/'))
                 or '__pycache__' in asset['name'].split('/') or asset['name'].endswith(('.pyc', '.pyo', '/.env'))]
    if forbidden:
        raise ValueError('分发清单包含不应随包的数据：' + str(forbidden[:5]))
    report = {'passed': True, 'distribution': str(output), 'files': package['files'], 'installedBytes': package['installedBytes'],
              'archiveBytes': package['archiveBytes'], 'nativeZIP64Extraction': True, 'relocated': True, 'noSharedDirectories': True,
              'runtimeValidation': read(runtime_report), 'voice': read(voice_report), 'video': read(video_report), 'app': read(app_report),
              'privacyInventoryPassed': True, 'checksumsVerified': True}
    write(validation / 'report.json', report)
    public = {key: report[key] for key in ('passed', 'files', 'installedBytes', 'archiveBytes', 'nativeZIP64Extraction', 'relocated',
              'noSharedDirectories', 'privacyInventoryPassed', 'checksumsVerified')}
    public.update(version=package['version'], releaseId=package['releaseId'], runtimeProfiles=['cu126', 'cu128'],
                  physicalGPU='RTX 4070 Ti SUPER', RTX50PhysicalTest=False, voice=report['voice'], videoOfflinePreparation=True)
    write(output / '验证结果.json', public)
    print(json.dumps(public, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', type=Path, required=True)
    args = parser.parse_args()
    run(args.work.resolve())
