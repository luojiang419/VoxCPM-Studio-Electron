"""编译独立授权版单EXE安装器，内置桌面包，复用原生安装/归属/卸载实现。"""
import json
from pathlib import Path
import subprocess

from build_bootstrap import sha256

ROOT = Path(__file__).resolve().parents[1]


def build(desktop, archive, output, stamp, records):
    app = desktop / 'resources/app'
    package = json.loads((app / 'package.json').read_text('utf8'))
    music = json.loads((app / 'music-config.json').read_text('utf8'))
    manifest = {'protocol': 1, 'componentProtocol': 2, 'releaseId': stamp,
                'appVersion': package['version'], 'appReleaseId': stamp, 'entry': 'JVOX Studio配音系统.exe',
                'package': {'name': archive.name, 'size': archive.stat().st_size, 'sha256': sha256(archive),
                            'urls': ['https://admin.ee2x.cn/embedded-only/' + stamp]},
                'files': [{'name': r['path'], 'size': r['size'], 'sha256': r['sha256']} for r in records],
                'musicRuntimeSize': music['runtime']['installed_size'], 'musicArchiveSize': music['runtime']['size'],
                'musicRuntimeVersion': music['runtime']['version']}
    limits = {'ace-xl-turbo': 15360, 'yue2': 7680, 'minimax-music3': 15360, 'heartmula': 15360}
    manifest['components'] = [{'id': 'lipsync', 'label': '视频对口型与照片说话', 'size': 6 * 1024**3, 'minMemoryMB': 7680}] + [
        {'id': m['id'], 'label': m['label'], 'size': sum(a['size'] for a in m['files']), 'minMemoryMB': limits[m['id']],
         'files': [{k: a[k] for k in ('name', 'size', 'sha256')} for a in m['files']]} for m in music['models']]
    source_manifest = archive.parent / 'bootstrap-manifest.json'
    source_manifest.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
    executable = output / f"JVOX-Studio-Setup-{package['version']}.exe"
    assets = ROOT / 'assets/brand'
    subprocess.run(['C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', '/nologo', '/target:winexe', '/platform:anycpu',
                    '/optimize+', '/define:AUTHORIZED', '/main:VoxBootstrap.AuthorizedInstaller', '/out:' + str(executable),
                    '/win32manifest:' + str(ROOT / 'bootstrap/long-path.manifest'),
                    '/win32icon:' + str(assets / 'voxcpm-installer.ico'), '/resource:' + str(archive) + ',desktop.zip',
                    '/resource:' + str(source_manifest) + ',bootstrap-manifest.json',
                    *['/resource:' + str(assets / f) + ',' + n for f, n in [('voxcpm-app.ico', 'app.ico'), ('voxcpm-installer.ico', 'installer.ico'),
                      ('voxcpm-app-256.png', 'app-mark.png'), ('disk-local-256.png', 'disk-local.png')]],
                    *['/reference:' + n for n in ['System.Windows.Forms.dll', 'System.Drawing.dll', 'Accessibility.dll',
                      'System.Web.Extensions.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll']],
                    *[str(ROOT / 'bootstrap' / n) for n in ['AuthorizedInstaller.cs', 'Program.cs', 'Installation.cs',
                      'SharedTheme.cs', 'Components.cs', 'DiskCard.cs']]], check=True)
    return executable, source_manifest
