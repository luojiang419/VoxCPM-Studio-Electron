"""验证最终一体化EXE：首次界面、完整安装握手、正常复检、缺失主程序修复。"""
from pathlib import Path
import argparse
import json
import os
import shutil
import subprocess
import time
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'repair'))
import engine
sys.path.insert(0,str(ROOT/'scripts'))
from smoke_legacy_repairer import capture_window, close_window


def run(build, installed=None):
    report=json.loads(Path(build).read_text('utf8'))
    exe=Path(report['executable'])
    out=ROOT/'builds/unified-validation'/str(time.time_ns());out.mkdir(parents=True)
    if installed is None:
        # 使用实际最终EXE打开全新位置，只观察首页，不登记真实安装。
        first=subprocess.Popen([str(exe),'--root',str(out/'fresh-target')])
        try:
            capture_window(first,out/'first-install.png')
        finally:
            close_window(first)
        source=(ROOT/'bootstrap/InstallationSmoke.cs').read_text('utf8')
        source=source.replace('Path.Combine(output, "fixtures", Guid.NewGuid().ToString("N"), "Program Files", "VoxCPMStudio")', 'Path.Combine(output, "Studio")')
        source=source.replace('if (standardUser) {\n                string source', 'if (true) {\n                string source')
        source=source.replace('            if (!standardUser) File.WriteAllBytes(pth, originalPth);', '')
        source=source.replace('            File.Copy(args[1], Path.Combine(cache, manifest.package.name));', '')
        start=source.index('            Directory.CreateDirectory(Path.Combine(root, "data", "voices"))')
        end=source.index('        } catch (Exception error)',start)
        source=source[:start]+'''            File.WriteAllText(Path.Combine(output,"installed-root.json"),json.Serialize(new {root}),Encoding.UTF8);
                Console.WriteLine("PASS 首次安装核心展开、GPU准备、服务握手与系统集成"); return 0;
    '''+source[end:]
        start=source.index('            foreach (string name in new[] { "runtime", "models" })',source.index('        finally'))
        end=source.index('            Registry.CurrentUser.DeleteSubKeyTree',start)
        source=source[:start]+source[end:]
        source=source.replace('            child = Installer.StartPreparation(root, report, session);', '''            File.WriteAllText(Path.Combine(root,"data/component-selection.json"),"{\\"selected\\":[],\\"removed\\":[],\\"defaultModel\\":\\"ace-xl-turbo\\"}");
                child = Installer.StartPreparation(root, report, session);''')
        test=out/'InstallationSmoke.cs';test.write_text(source,encoding='utf8')
        native=out/'InstallationSmoke.exe'
        subprocess.run(['C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe','/nologo','/target:exe','/main:InstallationSmoke','/define:UNIFIED','/out:'+str(native),
            '/resource:'+report['desktopManifest']+',bootstrap-manifest.json',
            '/resource:'+str(Path(report['payload']).parent/'repair-payload.zip')+',repair-payload.zip',
            '/resource:'+str(Path(report['payload']).parent/'repair-bundle.json')+',repair-bundle.json',
            *['/reference:'+s for s in ('System.Windows.Forms.dll','System.Drawing.dll','Accessibility.dll','System.Web.Extensions.dll','System.IO.Compression.dll','System.IO.Compression.FileSystem.dll')],
            *[str(ROOT/'bootstrap'/name) for name in ('Program.cs','SharedTheme.cs','Installation.cs','Components.cs','DiskCard.cs')],str(ROOT/'repair/Program.cs'),str(ROOT/'updater/Program.cs'),str(test)],check=True)
        subprocess.run([str(native),report['desktopManifest'],report['desktopArchive'],str(exe),str(ROOT/'builds/bootstrap-validation/runtime'),str(ROOT.parent/'models'),str(out),str(ROOT/'assets/brand/voxcpm-app.ico')],check=True,timeout=600)
        root=Path(json.loads((out/'installed-root.json').read_text('utf-8-sig'))['root'])
    else:
        root=Path(installed).resolve()
        assert root.is_relative_to(ROOT/'builds/unified-validation')
    sentinel=root/'data/outputs/保留作品.txt';sentinel.parent.mkdir(parents=True,exist_ok=True);sentinel.write_text('我的作品',encoding='utf8')
    selection=(root/'data/component-selection.json').read_bytes()
    def maintenance(name,expected):
        result=out/(name+'.json')
        child=subprocess.Popen([str(exe),'--root',str(root),'--report',str(result)])
        try:
            capture_window(child,out/(name+'-progress.png'))
            deadline=time.monotonic()+480
            while not result.exists() and child.poll() is None and time.monotonic()<deadline:time.sleep(.3)
            assert result.exists(), '未收到最终结果：'+str(out)
            data=json.loads(result.read_text('utf-8-sig'))
            time.sleep(.5);capture_window(child,out/(name+'.png'))
            assert data['status']==expected,data
            return data
        finally:
            if child.poll() is None:close_window(child)
    try:
        if installed is not None:
            maintenance('resume-repair','complete')
        healthy=maintenance('healthy','healthy')
        # 同大小应用损坏加桌面EXE缺失，必须仍识别为原安装并修复。
        engine.stop_owned_processes(root,out)
        (root/'resources/app/main.js').write_text('broken',encoding='utf8')
        (root/'VoxCPM Studio.exe').unlink()
        repaired=maintenance('repaired','complete')
        running,_=engine.owned_processes(root,engine.process_inventory())
        assert running, '修复后工作台未运行'
        again=maintenance('healthy-again','healthy')
        after,_=engine.owned_processes(root,engine.process_inventory())
        assert {p['ProcessId'] for p in running}.issubset({p['ProcessId'] for p in after}), '正常检查不能关闭正在运行的工作台'
        assert sentinel.read_text('utf8')=='我的作品' and (root/'data/component-selection.json').read_bytes()==selection
        result={'passed':True,'root':str(root),'build':str(build),'firstInstallHandshake':installed is None,'reusedInstalledFixture':str(installed) if installed else None,'healthy':healthy,'repair':repaired,'healthyAgain':again,'userDataPreserved':True,'healthyPreservesRunningProcesses':True}
        (out/'report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
        print('PASS 最终EXE安装/正常检查/缺失EXE修复/再次正常；报告：'+str(out))
    finally:
        engine.stop_owned_processes(root,out)
    return out

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('build',type=Path);parser.add_argument('--resume',type=Path);args=parser.parse_args();run(args.build,args.resume)
