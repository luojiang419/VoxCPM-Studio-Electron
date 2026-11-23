"""独立试用分发：复用固定Electron资源，不复制模型、不改正式更新入口。"""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import sys
import zipfile

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from build_lightweight import build as build_desktop


def sha(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def build():
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')
    version = json.loads((ROOT/'frontend/voxcpm_studio_electron/package.json').read_text('utf8'))['version']
    output = ROOT/'builds/正式分发'/f'JVOX-试用安装版-{version}-{stamp}'
    output.mkdir(parents=True, exist_ok=False)
    stage = ROOT/'builds/trial-installer-stage'/stamp
    stage.mkdir(parents=True, exist_ok=False)
    desktop = build_desktop(stage/'JVOX-Studio-Trial', skip_build=False, skip_zip=True)
    app = desktop/'resources/app'
    package = json.loads((app/'package.json').read_text('utf8'))
    package.update(name='jvox-studio-trial', productName='JVOX Studio（授权版）')
    (app/'package.json').write_text(json.dumps(package,ensure_ascii=False,indent=2),encoding='utf8')
    update = json.loads((app/'update-config.json').read_text('utf8'))
    update.update(autoCheck=False, channel='trial',releaseId=stamp, manifestUrl='https://admin.ee2x.cn/api/v1/updates/jvox-trial/latest')
    (app/'update-config.json').write_text(json.dumps(update,ensure_ascii=False,indent=2),encoding='utf8')
    config = json.loads((app/'license-config.json').read_text('utf8'))
    assert config['enabled'] and config['appId']=='jvox-studio' and len(config['publicKey'])==64
    from build_updater_runtime import build as updater_runtime
    crypto_runtime, _, _ = updater_runtime()
    crypto_target = desktop/'app/license-crypto'
    crypto_target.mkdir()
    for item in (crypto_runtime/'Lib/site-packages').iterdir():
        if item.name in {'cryptography','cffi','pycparser'} or item.name.startswith('_cffi_backend.') or (item.name.endswith('.dist-info') and item.name.startswith(('cryptography-','cffi-','pycparser-'))):
            if item.is_dir():
                shutil.copytree(item,crypto_target/item.name,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
            else:
                shutil.copy2(item,crypto_target/item.name)
    (desktop/'使用说明.txt').write_text(
        'JVOX Studio 授权版\n\n运行 JVOX Studio配音系统.exe，注册或登录后开始使用。\n'
        '每个账号、每款软件默认试用一个自然月；作者可在云端调整期限。\n'
        '左下角账户与授权可查看倒计时、刷新授权和退出登录。最后7天每天首次使用提醒一次。\n'
        '永久权限由作者核实收款后在后台开通；联网约一分钟内自动转为正式版，无需重装，也可点击刷新授权。\n'
        '同设备、同MAC网卡只可领一次试用；同公网IP默认一份，共用网络可联系作者放行。MAC只上传按软件隔离的指纹。\n'
        '首次激活需要联网；试用签名租约最长72小时，且不能跨过到期时间。\n'
        '本包包含桌面和业务代码，不包含Python、CUDA和模型。首次运行按原有固定清单下载缺失资源，建议至少25GiB空间。\n'
        '安装目录及快捷方式保持稳定，授权后保留模型、配置和作品。暂不接入旧无授权更新通道。\n'
        '管理后台：https://admin.ee2x.cn/admin/login\n',encoding='utf-8-sig')
    records=[]
    forbidden={'.env','credentials.json','license-session.json','auth.sqlite3','license-ed25519.key','smoke-account.json'}
    for f in sorted(desktop.rglob('*')):
        if f.is_file():
            if f.name in forbidden or '.auth-private' in f.parts or '.update-private' in f.parts:
                raise ValueError('分发中发现私密文件：'+str(f))
            records.append({'path':f.relative_to(desktop).as_posix(),'size':f.stat().st_size,'sha256':sha(f)})
    archive=stage/f'JVOX-Studio-Licensed-{version}.zip'
    with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for record in records:z.write(desktop/record['path'],desktop.name+'/'+record['path'])
    from build_trial_installer import build as build_installer
    executable, installer_manifest = build_installer(desktop, archive, output, stamp, records)
    manifest={'product':'jvox-studio-licensed','version':version,'releaseId':stamp,'authOrigin':config['serverUrl'],'files':records,
              'installer': {'name': executable.name, 'size': executable.stat().st_size, 'sha256': sha(executable)}}
    raw=json.dumps(manifest,ensure_ascii=False,separators=(',',':'))
    signing=Ed25519PrivateKey.from_private_bytes((ROOT/'.update-private/signing-key').read_bytes())
    envelope={'payload':raw,'signature':signing.sign(raw.encode()).hex()}
    (output/'分发清单.json').write_text(json.dumps(envelope,ensure_ascii=False,indent=2),encoding='utf8')
    (output/'分发公钥.txt').write_text(signing.public_key().public_bytes(Encoding.Raw,PublicFormat.Raw).hex(),encoding='ascii')
    (output/'使用说明.txt').write_text('双击 '+executable.name+'，选择安装位置，安装完成自动打开工作台。\n'
        '首次使用需要联网，自动补齐所选模型和运行环境，建议至少25GiB可用空间；不需要预装Python。\n'
        '注册即试用一个自然月。左下角“账户与授权”可查看剩余时间、刷新或退出。\n'
        '作者在后台开通永久权限后，联网约一分钟内自动转为正式版，无需重新安装。\n'
        '同设备、MAC网卡和公网IP限制重复领取；共用网络请联系作者放行。\n'
        '开始菜单或Windows应用列表可卸载，默认保留个人配置和作品。\n',encoding='utf-8-sig')
    report={'version':version,'releaseId':stamp,'directory':str(output),'desktop':str(desktop),'archive':str(archive),
            'installerManifest':str(installer_manifest),'executable':str(executable),'format':'exe-installer',
            'size':executable.stat().st_size,'sha256':sha(executable),'files':len(records),'containsModels':False,'published':False}
    (output/'构建记录.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    (output/'SHA256SUMS.txt').write_text(report['sha256']+'  '+executable.name+'\n',encoding='ascii')
    (ROOT/'builds/trial-distribution-latest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(report,ensure_ascii=False))
    return report


if __name__=='__main__':
    build()
