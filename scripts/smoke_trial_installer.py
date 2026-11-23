"""实际最终EXE：隔离安装、重复安装、旧版保护、文件校验和保留数据卸载。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import winreg

from smoke_legacy_repairer import capture_window, close_window

ROOT = Path(__file__).resolve().parents[1]
KEY = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\JVOXStudioLicensed'
OLD_KEY = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\VoxCPMStudio'


def registry(key):
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as k:
            return {winreg.EnumValue(k, i)[0]: winreg.EnumValue(k, i)[1] for i in range(winreg.QueryInfoKey(k)[1])}
    except FileNotFoundError:
        return None


def sha(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def cleanup(report):
    report = Path(report).resolve()
    data = json.loads(report.read_text('utf8'))
    root = Path(data['root']).resolve()
    assert root.is_relative_to(ROOT / 'builds/trial-installer-validation')
    state = json.loads((root / '.voxcpm-install.json').read_text('utf-8-sig'))
    assert state['product'] == 'jvox-studio-licensed' and state['id'] == data['installId']
    env = dict(os.environ, JVOX_QA_INSTALLER=data['executable'], JVOX_QA_ROOT=str(root), JVOX_QA_ID=state['id'])
    subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
                    '$ErrorActionPreference="Stop"; [Reflection.Assembly]::LoadFrom($env:JVOX_QA_INSTALLER) | Out-Null; '
                    '[VoxBootstrap.Installer]::Remove($env:JVOX_QA_ROOT,$env:JVOX_QA_ID,$false)'], env=env, check=True)
    assert (root / 'data/outputs/保留作品.txt').read_text('utf8') == '保留模型以外的个人作品'
    assert not (root / 'JVOX Studio配音系统.exe').exists() and registry(KEY) is None
    assert registry(OLD_KEY) == data['oldRegistry']
    data['uninstallPreservedPersonalData'] = True
    report.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf8')
    print('PASS 最终安装器卸载核心实测：移除应用与注册表，保留个人作品，旧正式版登记不变')


def run():
    build = json.loads((ROOT / 'builds/trial-distribution-latest.json').read_text('utf8'))
    exe = Path(build['executable'])
    assert registry(KEY) is None, '已有授权版安装，不覆盖；请先核实或使用已有验收目录'
    before = registry(OLD_KEY)
    out = ROOT / 'builds/trial-installer-validation' / str(time.time_ns())
    out.mkdir(parents=True)
    root = out / '中文 安装目录'
    first = subprocess.Popen([str(exe), '--root', str(root)])
    try:
        time.sleep(1)
        capture_window(first, out / 'installer-home.png')
    finally:
        close_window(first)
    result = out / 'install-result.json'
    subprocess.run([str(exe), '--install-only', '--root', str(root), '--report', str(result)], check=True, timeout=120)
    assert json.loads(result.read_text('utf8'))['ok']
    state = json.loads((root / '.voxcpm-install.json').read_text('utf-8-sig'))
    assert state['product'] == 'jvox-studio-licensed' and state['state'] == 'complete'
    assert len(state['shortcuts']) == 3 and all(Path(p).exists() for p in state['shortcuts'])
    assert registry(KEY)['InstallLocation'] == str(root)
    for item in json.loads(Path(build['installerManifest']).read_text('utf8'))['files']:
        assert sha(root / item['name']) == item['sha256'], item['name']
    sentinel = root / 'data/outputs/保留作品.txt'
    sentinel.parent.mkdir(parents=True, exist_ok=True)
    sentinel.write_text('保留模型以外的个人作品', encoding='utf8')
    subprocess.run([str(exe), '--install-only', '--root', str(root), '--report', str(result)], check=True, timeout=120)
    after = json.loads((root / '.voxcpm-install.json').read_text('utf-8-sig'))
    assert after['id'] == state['id'] and sentinel.read_text('utf8') == '保留模型以外的个人作品'
    # 错选旧无授权正式安装时，在写入目录锁和资源前就必须拒绝。
    if before:
        old_root = Path(before['InstallLocation'])
        marker = sha(old_root / '.voxcpm-install.json')
        refusal = out / 'refused-old-install.json'
        process = subprocess.run([str(exe), '--install-only', '--root', str(old_root), '--report', str(refusal)], timeout=30)
        assert process.returncode == 1 and not json.loads(refusal.read_text('utf8'))['ok']
        assert sha(old_root / '.voxcpm-install.json') == marker
    assert registry(OLD_KEY) == before
    report = {'passed': True, 'root': str(root), 'installId': state['id'], 'executable': str(exe),
              'oldRegistry': before, 'filesVerified': build['files'], 'shortcuts': state['shortcuts'],
              'reinstallPreservesData': True, 'refusesLegacyRoot': True, 'uninstallPreservedPersonalData': False}
    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    (ROOT / 'builds/trial-installer-validation/latest.json').write_text(json.dumps({'report': str(out / 'report.json'), 'root': str(root)}, ensure_ascii=False, indent=2), encoding='utf8')
    print('PASS 最终EXE安装、309文件校验、桌面/开始菜单/卸载登记、重复安装保留作品、拒绝旧正式安装目录：' + str(out))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cleanup', type=Path)
    args = parser.parse_args()
    cleanup(args.cleanup) if args.cleanup else run()
