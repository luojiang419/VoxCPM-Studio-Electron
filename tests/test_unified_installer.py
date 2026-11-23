"""安装检查分支：正常零修复、损坏按需修复、失败不假报正常。"""
import sys
from pathlib import Path
from contextlib import nullcontext
import json
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'repair'))
import maintenance as m


def put(file,value):
    file.parent.mkdir(parents=True,exist_ok=True);file.write_text(json.dumps(value),encoding='utf8')


@pytest.fixture
def request_data(tmp_path):
    root=tmp_path/'root';payload=tmp_path/'payload';work=tmp_path/'work'
    for p in (root,payload,work): p.mkdir()
    put(root/'runtime_manifest.json',{'version':'2.0.2'})
    put(payload/'repair-config.json',{})
    return {'root':str(root),'payload':str(payload),'work':str(work),'resultPath':str(work/'result.json')}


def test_healthy_never_stops_processes_or_repairs(request_data,monkeypatch):
    monkeypatch.setattr(m,'inspect',lambda *a:[])
    def forbidden(*a): raise AssertionError('正常安装不应进入修复')
    monkeypatch.setattr(m.engine,'stop_owned_processes',forbidden)
    monkeypatch.setattr(m.engine,'perform_repair',forbidden)
    result=m.maintain(request_data)
    assert result['status']=='healthy' and not result['repaired']
    assert result['message']==m.HEALTHY


def repair_stubs(monkeypatch):
    monkeypatch.setattr(m.engine,'choose_release',lambda *a: ({},{'version':'2.0.2','releaseId':'20261019010000'},None))
    monkeypatch.setattr(m.engine,'installed_identity',lambda *a: ('2.0.2','20261019010000'))
    monkeypatch.setattr(m.engine,'load_transaction',lambda *a:None)
    monkeypatch.setattr(m.engine,'repair_lock',lambda *a:nullcontext())
    monkeypatch.setattr(m.engine,'validate_root',lambda root:root)


def test_damage_repairs_then_rechecks(request_data,monkeypatch):
    repair_stubs(monkeypatch);calls=[];results=iter([['应用缺失'],[]])
    monkeypatch.setattr(m,'inspect',lambda *a:next(results))
    monkeypatch.setattr(m.engine,'stop_owned_processes',lambda *a:calls.append('stop'))
    monkeypatch.setattr(m,'restore_desktop',lambda *a:calls.append('desktop'))
    monkeypatch.setattr(m.engine,'perform_repair',lambda *a: calls.append('repair') or {'status':'complete'})
    result=m.maintain(request_data)
    assert calls==['stop','desktop','repair'] and result['repaired']


def test_newer_version_never_overwritten(request_data,monkeypatch):
    repair_stubs(monkeypatch)
    monkeypatch.setattr(m,'inspect',lambda *a:['文件损坏'])
    monkeypatch.setattr(m.engine,'installed_identity',lambda *a:('2.0.2','20990101000000'))
    monkeypatch.setattr(m,'restore_desktop',lambda *a:pytest.fail('不得覆盖新版'))
    with pytest.raises(ValueError,match='高于'):m.maintain(request_data)


def test_failed_recheck_not_reported_healthy(request_data,monkeypatch):
    repair_stubs(monkeypatch)
    monkeypatch.setattr(m,'inspect',lambda *a:['依赖损坏'])
    monkeypatch.setattr(m.engine,'stop_owned_processes',lambda *a:None)
    monkeypatch.setattr(m,'restore_desktop',lambda *a:None)
    monkeypatch.setattr(m.engine,'perform_repair',lambda *a:{'status':'complete'})
    with pytest.raises(RuntimeError,match='仍有问题'):m.maintain(request_data)


@pytest.mark.parametrize('path',['../outside','/outside','a\\b','C:/outside','a/../b'])
def test_manifest_paths_stay_inside(tmp_path,path):
    with pytest.raises(ValueError):m.safe(tmp_path,path)


def test_desktop_hash_detects_same_size_corruption(tmp_path,monkeypatch):
    root=tmp_path/'root';root.mkdir();payload=tmp_path/'payload';payload.mkdir()
    file=root/'VoxCPM Studio.exe';file.write_bytes(b'good')
    put(payload/'desktop-manifest.json',{'files':[{'name':file.name,'size':4,'sha256':m.engine.digest(file)}]})
    monkeypatch.setattr(m,'app_manifest',lambda *a:{'files':[]})
    file.write_bytes(b'evil')
    assert '桌面文件' in m.inspect(root,payload)[0]

def test_desktop_restore_replaces_on_target_volume_and_preserves_backup(tmp_path,monkeypatch):
    import zipfile
    root=tmp_path/'install';payload=tmp_path/'payload';work=tmp_path/'session'
    for folder in (root,payload,work):folder.mkdir()
    target=root/'VoxCPM Studio.exe';target.write_bytes(b'broken')
    wanted=payload/'expected';wanted.write_bytes(b'correct')
    archive=payload/'desktop.zip'
    with zipfile.ZipFile(archive,'w') as z:z.writestr('Desktop/VoxCPM Studio.exe',b'correct')
    put(payload/'desktop-manifest.json',{'package':{'sha256':m.engine.digest(archive)},'files':[{'name':target.name,'size':7,'sha256':m.engine.digest(wanted)}]})
    replace=m.os.replace
    def checked(source,destination):
        assert Path(source).parent==Path(destination).parent, '最终替换必须在目标盘内完成'
        replace(source,destination)
    monkeypatch.setattr(m.os,'replace',checked)
    m.restore_desktop(root,payload,work)
    assert target.read_bytes()==b'correct'
    assert (work/'desktop-backup'/target.name).read_bytes()==b'broken'
    assert not list(root.glob('*.repair-*'))
