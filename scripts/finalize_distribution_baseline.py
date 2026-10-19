"""核验最终安装器、当前源码和实际安装结果，冻结可直接分发的基准包。"""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import zipfile

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from release_update import ROOT, FRONTEND, sources


def digest(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def finalize(build_file, validation_file, output=None):
    build_file, validation_file = Path(build_file).resolve(), Path(validation_file).resolve()
    built = json.loads(build_file.read_text('utf8'))
    validation = json.loads(validation_file.read_text('utf8'))
    validated_build = Path(validation['build'])
    validated_build = validated_build if validated_build.is_absolute() else ROOT / validated_build
    if not validation.get('passed') or validated_build.resolve() != build_file:
        raise ValueError('验收结果不属于本次最终安装器')
    exe = Path(built['executable'])
    if exe.stat().st_size != built['size'] or digest(exe) != built['sha256']:
        raise ValueError('最终 EXE 与构建记录不一致')
    snapshot = Path(built['snapshot'])
    snapshot = (snapshot if snapshot.is_absolute() else ROOT / snapshot).resolve()
    envelope = json.loads((snapshot / 'envelope.json').read_text('utf8'))
    manifest = json.loads((snapshot / 'manifest.json').read_text('utf8'))
    config = json.loads((FRONTEND / 'update-config.json').read_text('utf8'))
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(config['publicKey'])).verify(bytes.fromhex(envelope['signature']), envelope['payload'].encode())
    if json.loads(envelope['payload']) != manifest or manifest['releaseId'] != built['releaseId']:
        raise ValueError('内置应用版本与签名清单不一致')
    package = snapshot / manifest['package']['name']
    if package.stat().st_size != manifest['package']['size'] or digest(package) != manifest['package']['sha256']:
        raise ValueError('签名应用包校验失败')
    current = dict((relative, file) for file, relative in sources())
    installed = Path(validation['root'])
    with zipfile.ZipFile(package) as archive, zipfile.ZipFile(built['desktopArchive']) as desktop:
        prefix = desktop.namelist()[0].split('/')[0] + '/'
        for item in manifest['files']:
            relative = item['path']
            if digest(current[relative]) != item['sha256'] or digest(installed / relative) != item['sha256']:
                raise ValueError('源码或实际安装未包含最新应用文件：' + relative)
            for value in [archive.read(relative), desktop.read(prefix + relative)]:
                if len(value) != item['size'] or hashlib.sha256(value).hexdigest() != item['sha256']:
                    raise ValueError('桌面包与签名包不一致：' + relative)
    output = Path(output or ROOT / 'builds/正式分发' / f'基准包-{built["version"]}-{built["releaseId"]}').resolve()
    if output.exists():
        raise ValueError('基准包目录已存在，未覆盖：' + str(output))
    output.mkdir(parents=True)
    distributed = output / 'JVOX Studio配音系统安装器.exe'
    shutil.copy2(exe, distributed)
    if digest(distributed) != built['sha256']:
        raise ValueError('分发副本校验失败')
    report = {'version': built['version'], 'releaseId': built['releaseId'], 'buildId': built['buildId'],
        'executable': str(distributed), 'sourceExecutable': str(exe), 'size': built['size'], 'sha256': built['sha256'],
        'verifiedApplicationFiles': len(manifest['files']), 'signedPackageSha256': manifest['package']['sha256'],
        'snapshot': str(snapshot), 'validationReport': str(validation_file), 'installedRoot': str(installed),
        'matchesCurrentSource': True, 'matchesActualInstallation': True, 'modelsAndDependencies': '按用户选择联网补齐',
        'upgradeExperience': '旧版手动升级一次后，启动提示；一次选择自动下载、安装和重启'}
    (output / '基准包记录.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    (output / 'SHA256.txt').write_text(built['sha256'] + '  JVOX Studio配音系统安装器.exe\n', encoding='utf-8-sig')
    (output / '分发说明.txt').write_text(
        f'JVOX Studio配音系统 新安装基准包\n版本：{built["version"]} / {built["releaseId"]}\n\n'
        '把 JVOX Studio配音系统安装器.exe 发给用户，双击选择安装位置和功能即可。\n'
        '内置当前全部应用功能与修复，模型和运行依赖按选择联网补齐。\n'
        '已安装用户也可用同一文件检查和修复，操作前请保存正在编辑的任务。\n\n'
        '旧版用户可用原有检查更新入口手动升级一次，保留已有模型、配置与作品。\n'
        '此后开启启动自动检查，发现新版直接弹出独立更新器；选择“现在更新”后自动下载、校验、安装并重启。\n'
        '选择“下次启动更新”则继续使用，下次启动再提醒。\n', encoding='utf-8-sig')
    built.update(validationPassed=True, validationReport=str(validation_file), distributionBaseline=str(output))
    build_file.write_text(json.dumps(built, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('build', type=Path)
    parser.add_argument('validation', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    finalize(args.build, args.validation, args.output)
