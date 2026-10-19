"""构建单EXE安装/健康检查/修复入口；仅本地构建，不自动发布。"""
from datetime import datetime, timezone
from pathlib import Path
import json
import argparse
import hashlib
from build_bootstrap import build as bootstrap
from build_legacy_repairer import build as repairer
from build_lightweight import build as lightweight
from release_update import build as snapshot_build, ROOT


def build(snapshot=None):
    stamp=datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')
    snapshot = snapshot or snapshot_build('AI助手模型选择、密钥查看及安装修复一体化支持。','0.2.0')
    desktop=lightweight(ROOT/'builds'/('JVOX-Desktop-Unified-'+stamp),skip_build=True)
    manifest=json.loads((snapshot/'manifest.json').read_text('utf8'))
    for item in manifest['files']:
        file=desktop/item['path']
        if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest()!=item['sha256']:
            raise ValueError('安装与修复包必须逐文件一致：'+item['path'])
    archive=desktop.with_suffix('.zip')
    plan=bootstrap(archive,ROOT/'builds'/('unified-bootstrap-'+stamp),stamp)
    report=repairer(snapshot,desktop_manifest=Path(plan['manifest']),desktop_package=archive)
    report.update(snapshot=str(snapshot),desktop=str(desktop),desktopArchive=str(archive),desktopManifest=plan['manifest'])
    (Path(report['executable']).parent/'构建记录.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot',type=Path)
    args=parser.parse_args()
    build(args.snapshot)
