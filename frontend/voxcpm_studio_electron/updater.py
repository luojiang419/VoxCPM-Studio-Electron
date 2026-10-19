"""VoxCPM 独立更新事务。仅使用便携 Python 与已有 cryptography。"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import time
import uuid
import zipfile

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def write_json(file: Path, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)


def read_json(file):
    return json.loads(Path(file).read_text("utf-8-sig"))


def sha256(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def emit(message, progress=0):
    print(json.dumps({"message": message, "progress": progress}, ensure_ascii=True), flush=True)


def safe_path(relative: str) -> str:
    if not isinstance(relative, str) or "\\" in relative or ":" in relative or "\x00" in relative:
        raise ValueError("更新路径非法")
    parts = PurePosixPath(relative).parts
    if not parts or relative != "/".join(parts) or any(
        p in (".", "..") or p.endswith((".", " ")) or
        re.match(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)", p, re.I)
        for p in parts
    ):
        raise ValueError(f"更新路径非法：{relative}")
    # 白名单排除 data/models/runtime/配置/第三方工具及源码工作区。
    allowed = relative.startswith("resources/app/") or (
        relative.startswith("app/") and (
            parts[1] in ("src", "conf", "scripts", "assets") or
            relative in ("app/app.py", "app/desktop_api.py", "app/desktop_app.py", "app/pyproject.toml")
        )
    )
    if not allowed or any(p.lower() in (".git", "__pycache__", "node_modules", ".env") for p in parts):
        raise ValueError(f"更新禁止覆盖此路径：{relative}")
    return relative


def destination(root: Path, relative: str):
    target = root / safe_path(relative)
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("更新路径超出软件目录")
    cursor = target
    while cursor != root:
        if cursor.is_symlink() or cursor.is_junction():
            raise ValueError("更新目标不能是符号链接或目录联接")
        cursor = cursor.parent
    if target.exists() and not target.is_file():
        raise ValueError("更新文件目标已被目录占用")
    return target


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise ValueError("版本号格式无效")
    return tuple(map(int, value.split(".")))


def validate(session: Path, settings):
    envelope = read_json(session / "envelope.json")
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(settings["publicKey"])).verify(
        bytes.fromhex(envelope["signature"]), envelope["payload"].encode("utf-8"))
    manifest = json.loads(envelope["payload"])
    if (manifest.get("protocol"), manifest.get("product"), manifest.get("platform")) != (
        1, "voxcpm-studio", "win32-x64"
    ):
        raise ValueError("更新包不兼容")
    release_id = manifest.get("releaseId", "00000000000000")
    if not re.fullmatch(r"\d{14}", release_id):
        raise ValueError("发布序号无效")
    reference_version = settings["currentVersion"]
    if reference_version is None and settings.get("repair") is True and settings.get("repairIdentityUnknown") is True:
        reference_version = settings["baselineVersion"]
    same_repair = settings.get("repair") is True and settings["currentVersion"] is not None and version(manifest["version"]) == version(reference_version) and release_id == settings.get("currentReleaseId", "00000000000000")
    if version(manifest["version"]) < version(reference_version) or (
        version(manifest["version"]) == version(reference_version) and
        release_id <= settings.get("currentReleaseId", "00000000000000") and not same_repair
    ):
        raise ValueError("拒绝安装相同或更旧的版本")
    if version(reference_version) < version(manifest["minVersion"]):
        raise ValueError("需要先升级完整便携基线")
    package = session / "package.zip"
    meta = manifest["package"]
    if package.stat().st_size != meta["size"] or sha256(package) != meta["sha256"]:
        raise ValueError("更新包完整性校验失败")
    records = manifest["files"]
    if not records or len(records) > 20000:
        raise ValueError("更新文件数量无效")
    names = set()
    total = 0
    for record in records:
        relative = safe_path(record["path"])
        if relative.lower() in names:
            raise ValueError("更新包含重复路径")
        names.add(relative.lower())
        if not isinstance(record["size"], int) or record["size"] < 0 or not re.fullmatch(r"[0-9a-f]{64}", record["sha256"]):
            raise ValueError("更新文件元数据无效")
        total += record["size"]
    if total > 2 * 1024 ** 3:
        raise ValueError("更新解压总量超过限制")
    stage = session / "stage"
    stage.mkdir(exist_ok=True)
    with zipfile.ZipFile(package) as archive:
        entries = archive.infolist()
        if len(entries) != len(records) or {e.filename for e in entries} != {r["path"] for r in records}:
            raise ValueError("压缩包与签名文件清单不一致")
        by_name = {e.filename: e for e in entries}
        for record in records:
            entry = by_name[record["path"]]
            if stat.S_ISLNK(entry.external_attr >> 16) or entry.file_size != record["size"]:
                raise ValueError("更新包含链接或文件大小异常")
            target = destination(stage, record["path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
            if sha256(target) != record["sha256"]:
                raise ValueError("解压文件哈希校验失败")
    package_json = read_json(stage / "resources/app/package.json")
    if package_json["version"] != manifest["version"]:
        raise ValueError("应用版本与发布清单不一致")
    if manifest.get("releaseId") and read_json(stage / "resources/app/update-config.json").get("releaseId") != release_id:
        raise ValueError("应用发布序号与清单不一致")
    return manifest


def alive(pid):
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        handle = kernel.OpenProcess(0x1000, False, int(pid))
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            code = ctypes.c_ulong()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False


def wait_exit(pid, timeout=120, cancel=None):
    deadline = time.monotonic() + timeout
    while alive(pid):
        if cancel and cancel.exists():
            raise RuntimeError("主程序已取消本次安装")
        if time.monotonic() >= deadline:
            raise TimeoutError("软件尚未退出，已取消安装，请关闭软件后重新尝试")
        time.sleep(0.2)


def rollback(root: Path, session: Path):
    journal_path = session / "journal.json"
    if not journal_path.exists():
        return
    journal = read_json(journal_path)
    for name in journal.get("brandReplacements", []):
        if name not in ("uninstall.exe", "voxcpm.ico"):
            raise ValueError("更名回滚文件无效")
        shutil.copy2(session / "brand-backup" / name, root / name)
    # 更名入口是旧启动器的兼容副本，不能进入任意路径白名单。
    branded = root / "JVOX Studio配音系统.exe"
    if journal.get("brandEntryCreated") and branded.is_file() and sha256(branded) == journal.get("brandEntryHash"):
        branded.unlink()
    for change in reversed(journal["changes"]):
        target = destination(root, change["path"])
        if change["existed"]:
            backup = session / "backup" / change["path"]
            if not backup.is_file():
                raise RuntimeError(f"回滚备份缺失：{change['path']}")
            temporary = target.with_name(target.name + ".voxcpm-rollback")
            shutil.copy2(backup, temporary)
            os.replace(temporary, target)
        else:
            target.unlink(missing_ok=True)
    journal["status"] = "rolled-back"
    write_json(journal_path, journal)


def install(root: Path, session: Path, manifest, fail_after=None):
    journal = {"status": "installing", "version": manifest["version"], "changes": []}
    for record in manifest["files"]:
        destination(root, record["path"])
    if shutil.disk_usage(root).free < sum(r["size"] for r in manifest["files"]) * 2 + 20 * 1024 ** 2:
        raise OSError("软件所在磁盘空间不足")
    try:
        for index, record in enumerate(manifest["files"]):
            relative = record["path"]
            target = destination(root, relative)
            existed = target.is_file()
            if existed:
                backup = session / "backup" / relative
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, backup)
            target.parent.mkdir(parents=True, exist_ok=True)
            journal["changes"].append({"path": relative, "existed": existed})
            write_json(session / "journal.json", journal)
            temporary = target.with_name(target.name + ".voxcpm-update")
            shutil.copy2(session / "stage" / relative, temporary)
            os.replace(temporary, target)
            if target.stat().st_size != record["size"] or sha256(target) != record["sha256"]:
                raise OSError(f"安装后文件校验失败：{relative}")
            emit(f"正在安装 {index + 1}/{len(manifest['files'])}", 30 + int((index + 1) * 55 / len(manifest["files"])))
            if fail_after is not None and index + 1 >= fail_after:
                raise OSError("测试注入写入失败")
        journal["status"] = "awaiting-health"
        write_json(session / "journal.json", journal)
    except BaseException:
        rollback(root, session)
        raise


def preparation_deadline(session, manifest, pid, deadline, limit):
    """只有本次新版进程的近期准备心跳能延长健康检查，有24小时上限。"""
    preparing = session / 'healthy.json.preparing'
    try:
        if preparing.exists() and time.time() - preparing.stat().st_mtime < 45:
            state = read_json(preparing)
            if (state.get('version') == manifest['version'] and state.get('releaseId') == manifest.get('releaseId', '00000000000000')
                    and state.get('pid') == pid and state.get('status') not in ('error', 'cancelled')):
                return min(limit, time.monotonic() + 210)
    except (OSError, ValueError):
        pass
    return deadline


def restart(root, session, health=True):
    env = {k: v for k, v in os.environ.items() if k not in (
        "ELECTRON_RUN_AS_NODE", "VOXCPM_UPDATE_HEALTH_FILE", "VOXCPM_UPDATE_SESSION")}
    if health:
        env["VOXCPM_UPDATE_HEALTH_FILE"] = str(session / "healthy.json")
        env["VOXCPM_UPDATE_SESSION"] = str(session)
    entry = root / "JVOX Studio配音系统.exe"
    if not entry.is_file() or (not health and (root / "VoxCPM Studio.exe").is_file()):
        entry = root / "VoxCPM Studio.exe"
    return subprocess.Popen([str(entry), "--voxcpm-run"], cwd=root, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def prepare_brand_entry(root, session):
    """验签安装后复用现有 Electron 引擎；保留旧 EXE 作为旧快捷方式的兼容入口。"""
    package = read_json(root / "resources/app/package.json")
    if package.get("build", {}).get("productName") != "JVOX Studio配音系统":
        return
    # 已签名的新版卸载器和图标同步到既有安装，归属标记及卸载ID保持不变。
    if (root / ".voxcpm-install.json").is_file():
        for name, source in (("uninstall.exe", "brand-uninstaller.exe"), ("voxcpm.ico", "app.ico")):
            target, signed = root / name, root / "resources/app" / source
            if target.is_symlink() or target.is_junction():
                raise ValueError("更名文件不能是链接")
            if target.is_file() and signed.is_file() and sha256(target) != sha256(signed):
                backup = session / "brand-backup" / name
                backup.parent.mkdir(exist_ok=True)
                shutil.copy2(target, backup)
                journal = read_json(session / "journal.json")
                journal.setdefault("brandReplacements", []).append(name)
                write_json(session / "journal.json", journal)
                temporary = target.with_name(target.name + ".jvox-new")
                shutil.copy2(signed, temporary)
                os.replace(temporary, target)
    entry, legacy = root / "JVOX Studio配音系统.exe", root / "VoxCPM Studio.exe"
    if entry.is_symlink() or entry.is_junction() or legacy.is_symlink() or legacy.is_junction():
        raise ValueError("更名入口不能是链接")
    if entry.exists():
        if not entry.is_file():
            raise ValueError("更名入口被目录占用")
        return
    if not legacy.is_file():
        raise ValueError("软件启动器缺失，请使用新版安装器修复")
    journal = read_json(session / "journal.json")
    journal.update(brandEntryCreated=True, brandEntryHash=sha256(legacy))
    write_json(session / "journal.json", journal)
    temporary = root / (".jvox-entry-" + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("xb") as output, legacy.open("rb") as source:
            shutil.copyfileobj(source, output)
            output.flush(); os.fsync(output.fileno())
        # Windows rename 不覆盖已存在目标；崩溃也不会留下可启动的半成品 EXE。
        os.rename(temporary, entry)
    finally:
        temporary.unlink(missing_ok=True)


def migrate_brand_integration(root, session):
    """只迁移归属记录中的快捷方式及同目录卸载登记；不扫描或覆盖其他软件。"""
    if os.name != "nt" or not (root / ".voxcpm-install.json").is_file():
        return
    script = r'''
$ErrorActionPreference='Stop'
$root=$env:JVOX_MIGRATION_ROOT
$marker=Join-Path $root '.voxcpm-install.json'
$state=Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
if($state.product -ne 'voxcpm-studio' -or [IO.Path]::GetFullPath($state.root).TrimEnd('\') -ne [IO.Path]::GetFullPath($root).TrimEnd('\')) { throw '安装归属记录无效' }
$shell=New-Object -ComObject WScript.Shell
$links=@($state.shortcuts)
foreach($file in @($state.shortcuts)) {
 if(!(Test-Path -LiteralPath $file -PathType Leaf) -or [IO.Path]::GetExtension($file) -ne '.lnk') {continue}
 if(((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {continue}
 $old=$shell.CreateShortcut($file)
 $target=[IO.Path]::GetFullPath($old.TargetPath)
 $entry=[IO.Path]::GetFileName($target)
 if([IO.Path]::GetDirectoryName($target) -ne $root -or $entry -notin @('VoxCPM Studio.exe','JVOX Studio配音系统.exe','uninstall.exe')) {continue}
 $folder=[IO.Path]::GetDirectoryName($file)
 if([IO.Path]::GetFileName($folder) -eq 'VoxCPM Studio') {$folder=Join-Path ([IO.Path]::GetDirectoryName($folder)) 'JVOX Studio配音系统'}
 $title=if($entry -eq 'uninstall.exe') {'卸载 JVOX Studio配音系统'} else {'JVOX Studio配音系统'}
 $next=Join-Path $folder ($title+'.lnk')
 if((Test-Path -LiteralPath $next) -and $next -ne $file) {
  $existing=$shell.CreateShortcut($next)
  if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($existing.TargetPath)) -ne $root) {continue}
 }
 New-Item -ItemType Directory -Path $folder -Force | Out-Null
 $link=$shell.CreateShortcut($next)
 $link.TargetPath=if($entry -eq 'uninstall.exe') {$target} else {Join-Path $root 'JVOX Studio配音系统.exe'}
 $link.Arguments=$old.Arguments;$link.WorkingDirectory=$root;$link.IconLocation=Join-Path $root 'resources\app\app.ico';$link.Save()
 if($next -ne $file) {Remove-Item -LiteralPath $file -Force}
 $links=@($links | Where-Object {$_ -ne $file}) + $next
}
$state.shortcuts=@($links | Select-Object -Unique)
$state.files=@(@($state.files) + 'JVOX Studio配音系统.exe' | Select-Object -Unique)
$key=$null
try {
 if($state.registryKey -and $state.registryKey.StartsWith('Software\Microsoft\Windows\CurrentVersion\Uninstall\VoxCPMStudio',[StringComparison]::OrdinalIgnoreCase)) {
  $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($state.registryKey,$true)
  if($key -and $key.GetValue('InstallLocation') -eq $root) {
   $key.SetValue('DisplayName','JVOX Studio配音系统');$key.SetValue('Publisher','JVOX Studio配音系统')
   $pkg=Get-Content -LiteralPath (Join-Path $root 'resources\app\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
   $key.SetValue('DisplayVersion',$pkg.version);$key.SetValue('DisplayIcon',(Join-Path $root 'resources\app\app.ico'))
  }
 }
} finally {if($key){$key.Dispose()}}
$temporary=$marker+'.jvox-tmp'
[IO.File]::WriteAllText($temporary,($state | ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination $marker -Force
'''
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        env={**os.environ, "JVOX_MIGRATION_ROOT": str(root)}, capture_output=True, timeout=30,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))


def launch_standalone(session: Path):
    """兼容上一发布的旧窗口：签名验证后交给原生EXE，窗口无需留在应用目录。"""
    settings = read_json(session / "session.json")
    manifest = validate(session, settings)
    native = next((r for r in manifest["files"] if r["path"] == "resources/app/standalone-updater.exe"), None)
    if not native:
        return False
    executable = session / "VoxCPM Updater.exe"
    shutil.copy2(session / "stage" / native["path"], executable)
    settings["pythonExecutable"] = sys.executable
    settings.setdefault("resultPath", str(Path(settings["root"]) / "data/cache/updates/last-result.json"))
    write_json(session / "session.json", settings)
    child = subprocess.Popen([str(executable), "--session", str(session)], cwd=session,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS)
    emit("原生独立更新器已打开，正在等待接管…", 5)
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        host_file, ready_file = session / "host-ready.json", session / "ready.json"
        if host_file.exists() and ready_file.exists():
            host, ready = read_json(host_file), read_json(ready_file)
            if (host.get("hostPid") == child.pid and host.get("workerPid") == ready.get("pid")
                    and ready.get("parentPid") == settings["parentPid"] and ready.get("releaseId") == manifest.get("releaseId")):
                # 旧窗口等原主进程退出后再关闭，保证旧客户端来得及接收ready握手。
                wait_exit(settings["parentPid"], cancel=session / "cancel.json")
                return True
        if child.poll() is not None:
            raise RuntimeError("原生独立更新器提前退出")
        if (session / "cancel.json").exists():
            raise RuntimeError("主程序已取消本次安装")
        time.sleep(0.1)
    write_json(session / "cancel.json", {"cancelledAt": time.time()})
    raise TimeoutError("独立更新器接管超时，未允许主程序退出")


def run(session: Path, recover=False):
    settings = read_json(session / "session.json")
    root = Path(settings["root"]).resolve(strict=True)
    if str(session) != settings["session"] or not (root / "runtime_manifest.json").is_file():
        raise ValueError("更新会话或便携目录无效")
    pending = root / "data/cache/updates/pending.json"
    result_path = Path(settings.get("resultPath", root / "data/cache/updates/last-result.json"))
    def result(status, message, manifest=None):
        value = {"status": status, "message": message, "session": str(session), "finishedAt": time.time(),
                 "version": (manifest or {}).get("version"), "releaseId": (manifest or {}).get("releaseId"),
                 "previousVersion": settings["currentVersion"], "previousReleaseId": settings.get("currentReleaseId")}
        write_json(session / "status.json", value)
        write_json(result_path, value)
    if recover:
        journal = read_json(session / "journal.json") if (session / "journal.json").exists() else {}
        if journal.get("status") not in ("complete", "rolled-back"):
            rollback(root, session)
            result("rolled-back", "上次更新中断，已恢复原版本。请查看更新日志后重试。")
        pending.unlink(missing_ok=True)
        return
    emit("正在验证签名与更新文件…", 5)
    manifest = validate(session, settings)
    if (session / "cancel.json").exists():
        raise RuntimeError("主程序已取消本次安装")
    write_json(session / "ready.json", {"session": str(session), "parentPid": settings["parentPid"],
               "pid": os.getpid(), "releaseId": manifest.get("releaseId")})
    emit("等待主程序退出…", 20)
    wait_exit(settings["parentPid"], cancel=session / "cancel.json")
    if (session / "cancel.json").exists():
        raise RuntimeError("主程序已取消本次安装")
    write_json(pending, {"session": str(session), "pid": os.getpid()})
    write_json(session / "status.json", {"status": "installing", "version": manifest["version"]})
    try:
        install(root, session, manifest)
        prepare_brand_entry(root, session)
        emit("正在重启并检查本地服务…", 90)
        for name in ("healthy.json", "healthy.json.preparing"):
            (session / name).unlink(missing_ok=True)
        child = restart(root, session)
        deadline = time.monotonic() + 210
        preparation_limit = time.monotonic() + 24 * 3600
        try:
            while time.monotonic() < deadline:
                deadline = preparation_deadline(session, manifest, child.pid, deadline, preparation_limit)
                if (session / "healthy.json").exists():
                    health = read_json(session / "healthy.json")
                    if (health.get("version") == manifest["version"] and health.get("releaseId", "00000000000000") == manifest.get("releaseId", "00000000000000")
                            and health.get("pid") == child.pid and child.poll() is None):
                        break
                preparing = session / "healthy.json.preparing"
                if preparing.exists():
                    state = read_json(preparing)
                    if state.get("pid") == child.pid and state.get("status") in ("error", "cancelled"):
                        raise RuntimeError("新版启动失败：" + state.get("message", "运行环境或服务未就绪"))
                if child.poll() is not None:
                    raise RuntimeError("新版软件启动失败")
                time.sleep(0.5)
            else:
                raise TimeoutError("新版启动检查超时")
        except BaseException:
            if child.poll() is None:
                subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"], capture_output=True)
                wait_exit(child.pid, 20)
            raise
        journal = read_json(session / "journal.json")
        journal["status"] = "complete"
        write_json(session / "journal.json", journal)
        try:
            migrate_brand_integration(root, session)
        except Exception as error:
            # 应用已通过健康检查；系统快捷方式失败不能反转已成功的应用事务。
            (session / "brand-migration-warning.txt").write_text(str(error), encoding="utf-8")
        result("complete", "更新安装成功，文件、界面及本地服务检查通过。", manifest)
        emit("更新完成，本地服务已就绪。", 100)
    except BaseException as error:
        rollback(root, session)
        result("rolled-back", f"更新未生效，已恢复原版本：{error}", manifest)
        pending.unlink(missing_ok=True)
        restart(root, session, health=False)
        raise
    finally:
        journal_path = session / "journal.json"
        if not journal_path.exists() or read_json(journal_path).get("status") in ("complete", "rolled-back"):
            pending.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("--recover", action="store_true")
    parser.add_argument("--worker", action="store_true", help="由独立更新器启动的事务工作进程")
    args = parser.parse_args()
    try:
        session = args.session.resolve(strict=True)
        if args.recover or args.worker or not launch_standalone(session):
            run(session, args.recover)
    except BaseException as error:
        status_file = args.session / "status.json"
        if not status_file.exists() or read_json(status_file).get("status") not in ("complete", "rolled-back"):
            write_json(status_file, {"status": "error", "message": str(error)})
        emit(f"更新失败：{error}。已保留日志与回滚记录。")
        sys.exit(1)
