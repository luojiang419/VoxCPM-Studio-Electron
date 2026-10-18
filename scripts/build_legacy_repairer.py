"""构建可直接分发的单EXE老用户修复器，内含签名应用快照及专用运行环境。"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

from build_updater_runtime import build as build_runtime
from release_update import FRONTEND, ROOT


def sha(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def build(snapshot, output=None):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    envelope=json.loads((snapshot/"envelope.json").read_text("utf-8"))
    config=json.loads((FRONTEND/"update-config.json").read_text("utf-8"))
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(config["publicKey"])).verify(bytes.fromhex(envelope["signature"]),envelope["payload"].encode())
    manifest=json.loads(envelope["payload"])
    package=snapshot/manifest["package"]["name"]
    if sha(package)!=manifest["package"]["sha256"]:
        raise ValueError("应用快照哈希错误")
    runtime,_,profile=build_runtime()
    with zipfile.ZipFile(package) as z:
        signed_profile=json.loads(z.read("resources/app/updater-runtime-config.json"))
    if signed_profile!=profile:
        raise ValueError("修复器与签名应用要求的独立环境不一致")
    build_id=hashlib.sha256(b"".join((ROOT/p).read_bytes() for p in ("repair/engine.py","repair/worker.py","repair/Program.cs","updater/Program.cs","bootstrap/SharedTheme.cs","frontend/voxcpm_studio_electron/updater.py"))).hexdigest()[:10]
    output=output or ROOT/"builds/正式分发"/("VoxCPM-老用户更新修复器-"+manifest["releaseId"]+"-"+build_id)
    output.mkdir(parents=True,exist_ok=False)
    stage=ROOT/"builds/repairer-build"/(manifest["releaseId"]+"-"+build_id)
    stage.mkdir(parents=True,exist_ok=False)
    payload=stage/"payload"
    shutil.copytree(runtime,payload/"runtime")
    for name in ("engine.py","worker.py"):
        shutil.copy2(ROOT/"repair"/name,payload/name)
    shutil.copy2(FRONTEND/"updater.py",payload/"updater.py")
    (payload/"snapshot").mkdir()
    shutil.copy2(snapshot/"envelope.json",payload/"snapshot/envelope.json")
    shutil.copy2(package,payload/"snapshot"/package.name)
    (payload/"repair-config.json").write_text(json.dumps({"protocol":1,"publicKey":config["publicKey"],"manifestUrl":config["manifestUrl"]},indent=2),encoding="utf-8")
    records=[]
    archive=stage/"repair-payload.zip"
    with zipfile.ZipFile(archive,"x",zipfile.ZIP_DEFLATED) as z:
        for file in sorted(payload.rglob("*")):
            if file.is_file() and "__pycache__" not in file.parts:
                relative=file.relative_to(payload).as_posix()
                z.write(file,relative)
                records.append({"path":relative,"size":file.stat().st_size,"sha256":sha(file)})
    bundle=stage/"repair-bundle.json"
    bundle.write_text(json.dumps({"product":"voxcpm-studio-repairer","releaseId":manifest["releaseId"],"sha256":sha(archive),"files":records},indent=2),encoding="utf-8")
    executable=output/"VoxCPM更新修复器.exe"
    subprocess.run(["C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe","/nologo","/target:winexe","/platform:anycpu","/optimize+","/main:VoxLegacyRepair.Program","/out:"+str(executable),
        "/win32icon:"+str(ROOT/"assets/brand/voxcpm-app.ico"),"/resource:"+str(ROOT/"assets/brand/voxcpm-app-256.png")+",app-mark.png",
        "/resource:"+str(archive)+",repair-payload.zip","/resource:"+str(bundle)+",repair-bundle.json",
        "/reference:System.Windows.Forms.dll","/reference:System.Drawing.dll","/reference:Accessibility.dll","/reference:System.Web.Extensions.dll","/reference:System.IO.Compression.dll","/reference:System.IO.Compression.FileSystem.dll",
        str(ROOT/"bootstrap/SharedTheme.cs"),str(ROOT/"updater/Program.cs"),str(ROOT/"repair/Program.cs")],check=True)
    (output/"使用说明.txt").write_text("请先保存作品并停止生成或训练，双击 VoxCPM更新修复器.exe。\n自动识别原安装位置，也可以手动选择。点击“开始修复并升级”。\n会自动关闭本目录工作台及更新器，隐藏进程无法正常退出时会强制结束；未保存内容和进行中的任务可能丢失。\n自带修复环境，不需要安装Python或开发工具。保留已保存的模型、配置、音色和作品。\n修复完成后直接在软件内检查更新，不需要每次运行修复器。\n请勿卸载或删除旧目录；若失败，使用“查看更新日志”保留错误记录。权限不足可右键以管理员身份运行。\n",encoding="utf-8-sig")
    report={"version":manifest["version"],"releaseId":manifest["releaseId"],"buildId":build_id,"executable":str(executable),"size":executable.stat().st_size,"sha256":sha(executable),"runtimeId":profile["id"],"payload":str(payload),"autoTerminateOwnedProcesses":True}
    (output/"构建记录.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return report


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot",type=Path)
    parser.add_argument("--output",type=Path)
    args=parser.parse_args()
    build(args.snapshot.resolve(strict=True),args.output)
