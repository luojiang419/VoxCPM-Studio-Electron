"""老用户修复引擎：可信签名、专用更新环境、事务恢复和后续通道验证。"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager


def read(file):
    return json.loads(Path(file).read_text("utf-8-sig"))


def write(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix(file.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, file)


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def emit(message, progress=0):
    print(json.dumps({"message": message, "progress": progress}, ensure_ascii=True), flush=True)


def load_transaction(payload):
    spec = importlib.util.spec_from_file_location("repair_transaction", Path(payload) / "updater.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify_envelope(envelope, key):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(key)).verify(bytes.fromhex(envelope["signature"]), envelope["payload"].encode("utf-8"))
    manifest = json.loads(envelope["payload"])
    if (manifest.get("protocol"), manifest.get("product"), manifest.get("platform")) != (1, "voxcpm-studio", "win32-x64"):
        raise ValueError("更新与当前软件或平台不兼容")
    if not re.fullmatch(r"\d{14}", manifest.get("releaseId", "")):
        raise ValueError("发布序号无效")
    if not re.fullmatch(r"\d+\.\d+\.\d+", manifest.get("version", "")):
        raise ValueError("版本格式无效")
    meta = manifest["package"]
    if not re.fullmatch(r"[a-f0-9]{64}", meta.get("sha256", "")) or not isinstance(meta.get("size"), int) or not 0 < meta["size"] <= 1024**3:
        raise ValueError("签名包元数据无效")
    return manifest


def release_order(manifest):
    return tuple(map(int, manifest["version"].split("."))), manifest.get("releaseId", "00000000000000")


def url_allowed(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.username or parsed.password or parsed.scheme not in ("https", "http"):
        raise ValueError("更新地址必须使用HTTPS")
    if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("更新地址必须使用HTTPS")


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        url_allowed(newurl)
        return super().redirect_request(request, response, code, message, headers, newurl)


def open_url(url, headers=None):
    url_allowed(url)
    request = urllib.request.Request(url, headers={"User-Agent": "VoxCPM-Studio-Repairer/1.0", **(headers or {})})
    return urllib.request.build_opener(SafeRedirect()).open(request, timeout=30)


def choose_release(payload, config):
    envelope = read(Path(payload) / "snapshot/envelope.json")
    embedded = verify_envelope(envelope, config["publicKey"])
    network_error = None
    try:
        with open_url(config["manifestUrl"]) as response:
            body = response.read(4 * 1024 * 1024 + 1)
        if len(body) > 4 * 1024 * 1024:
            raise ValueError("更新清单过大")
        remote_envelope = json.loads(body)
        remote = verify_envelope(remote_envelope, config["publicKey"])
        if release_order(remote) > release_order(embedded):
            return remote_envelope, remote, None
    except (OSError, urllib.error.URLError) as error:
        network_error = str(error)
    # 签名错误不静默退回，避免把被篡改的更新源当作正常离线情形。
    return envelope, embedded, network_error


def validate_root(root):
    root = Path(root)
    if root.is_file():
        root = root.parent
    root = root.resolve(strict=True)
    if not any((root / name).is_file() for name in ("JVOX Studio配音系统.exe", "VoxCPM Studio.exe")):
        raise ValueError("未找到原软件主程序，请选择 JVOX Studio配音系统或旧版的原安装目录")
    if not any((root / name).is_file() for name in ("runtime_manifest.json", ".voxcpm-install.json")):
        raise ValueError("该目录没有软件安装标记，已停止操作")
    if root == Path(root.anchor) or root == Path(os.environ.get("USERPROFILE", "/__none__")):
        raise ValueError("不能把磁盘或个人资料根目录作为修复目标")
    return root


def process_inventory():
    result = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); "
        "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,"
        "@{Name='Created';Expression={$_.CreationDate.ToFileTimeUtc()}}) | ConvertTo-Json -Compress"],
        capture_output=True, text=True, encoding="utf-8", check=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
    parsed = json.loads(result.stdout or "[]")
    return parsed if isinstance(parsed, list) else [parsed]


def process_label(item):
    return f"{item.get('Name') or Path(item.get('ExecutablePath') or '?').name} (PID {item.get('ProcessId', '?')})，路径：{item.get('ExecutablePath') or '无权限读取'}"


def owned_processes(root, processes):
    # 先排除本修复工作进程及全部祖先，即使修复器恰好放在原安装目录内。
    indexed = {p.get("ProcessId"): p for p in processes}
    protected, current = set(), os.getpid()
    while current and current not in protected:
        protected.add(current)
        current = indexed.get(current, {}).get("ParentProcessId")
    protected.add(os.getppid())
    names = {"jvox studio配音系统.exe", "jvox updater.exe", "voxcpm studio.exe", "voxcpm updater.exe", "electron.exe", "python.exe", "pythonw.exe", "ffmpeg.exe", "ffprobe.exe", "node.exe"}
    targets, unknown = {}, []
    for item in processes:
        pid = item.get("ProcessId")
        if pid in protected or (isinstance(pid, int) and pid <= 4):
            continue
        executable = item.get("ExecutablePath")
        name = (item.get("Name") or Path(executable or "").name).lower()
        if name not in names:
            continue
        if not executable:
            if name in {"voxcpm studio.exe", "voxcpm updater.exe"}:
                unknown.append(item)
            continue
        # 不解析junction：共享音频运行时的进程路径仍可能通过当前安装的junction启动。
        owned = Path(os.path.abspath(executable)).is_relative_to(root)
        if not owned and name in {"python.exe", "pythonw.exe"}:
            # 外部/共享Python必须有精确脚本参数，不能仅匹配包含安装路径的任意字符串。
            command = item.get("CommandLine") or ""
            arguments = re.findall(r'"([^"\r\n]*)"|([^\s"]+)', command)
            for quoted, bare in arguments:
                arg = quoted or bare
                if not os.path.isabs(arg):
                    continue
                script = Path(os.path.abspath(arg))
                if script.is_relative_to(root) and script.suffix.lower() == ".py" and script.name in {"desktop_api.py", "updater.py", "train_voxcpm_finetune.py", "train_voxcpm_lora.py"}:
                    owned = True
                    break
        if owned:
            targets[pid] = item
    # 子进程仅在父进程确属本目录且创建时间不早于父进程时纳入，避免复用的父PID。
    changed = True
    while changed:
        changed = False
        for item in processes:
            pid, parent = item.get("ProcessId"), targets.get(item.get("ParentProcessId"))
            if pid in targets or pid in protected or not isinstance(pid, int) or pid <= 4:
                continue
            if parent and item.get("ExecutablePath") and item.get("Created", 0) >= parent.get("Created", 0) > 0:
                targets[pid] = item; changed = True
    return list(targets.values()), unknown


def assert_stopped(root, processes=None):
    targets, unknown = owned_processes(root, processes if processes is not None else process_inventory())
    if targets:
        raise RuntimeError("请先关闭该目录的工作台和独立更新窗口：" + "; ".join(map(process_label, targets)))
    if unknown:
        raise RuntimeError("无法确认软件进程归属：" + "; ".join(map(process_label, unknown)) + "。请以管理员身份重新运行修复器。")


class ProcessHandle:
    """固定Windows进程句柄并核对映像、创建时间，避免按名称或复用PID误结束。"""
    def __init__(self, item):
        import ctypes
        from ctypes import wintypes
        self.ctypes, self.item = ctypes, item
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.WaitForSingleObject.restype = wintypes.DWORD
        self.kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        self.kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        self.kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        self.handle = self.kernel.OpenProcess(0x1000 | 0x100000 | 1, False, item["ProcessId"])
        if not self.handle:
            if ctypes.get_last_error() == 87: return  # 枚举后已退出。
            raise OSError(ctypes.get_last_error(), "无法打开进程")
        try:
            name, size = ctypes.create_unicode_buffer(32768), wintypes.DWORD(32768)
            if not self.kernel.QueryFullProcessImageNameW(self.handle, 0, name, ctypes.byref(size)):
                raise ctypes.WinError(ctypes.get_last_error())
            times = [wintypes.FILETIME() for _ in range(4)]
            if not self.kernel.GetProcessTimes(self.handle, *(ctypes.byref(t) for t in times)):
                raise ctypes.WinError(ctypes.get_last_error())
            created = (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
            if (os.path.normcase(os.path.realpath(name.value)) != os.path.normcase(os.path.realpath(item["ExecutablePath"]))
                    or not item.get("Created") or abs(created - item["Created"]) >= 10):
                self.close()  # 进程身份变化，由下一轮枚举重新判断归属。
        except BaseException:
            self.close(); raise

    def close(self):
        if self.handle: self.kernel.CloseHandle(self.handle); self.handle = None

    def exited(self):
        return not self.handle or self.kernel.WaitForSingleObject(self.handle, 0) == 0

    def request_close(self):
        from ctypes import wintypes
        ctypes = self.ctypes
        user = ctypes.WinDLL("user32", use_last_error=True)
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
        user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        def visit(window, _):
            pid = wintypes.DWORD()
            user.GetWindowThreadProcessId(window, ctypes.byref(pid))
            if pid.value == self.item["ProcessId"] and not self.exited():
                user.PostMessageW(window, 0x10, 0, 0)
            return True
        user.EnumWindows(callback_type(visit), 0)

    def terminate(self):
        if not self.exited() and not self.kernel.TerminateProcess(self.handle, 1):
            error = self.ctypes.get_last_error()
            # 主进程退出会同时结束子进程。Windows 在进程结束中也会返回
            # ERROR_ACCESS_DENIED；仅当同一已校验句柄确已结束才视为成功。
            if error == 5 and self.kernel.WaitForSingleObject(self.handle, 5000) == 0:
                return
            if not self.exited():
                raise self.ctypes.WinError(error)
        if self.handle and self.kernel.WaitForSingleObject(self.handle, 5000) != 0:
            raise RuntimeError("等待进程退出超时")


def stop_owned_processes(root, work):
    report = work / "stopped-processes.json"
    stopped = read(report) if report.exists() else []
    for _ in range(4):
        targets, unknown = owned_processes(root, process_inventory())
        if unknown:
            raise RuntimeError("无法确认软件进程归属：" + "; ".join(map(process_label, unknown)) + "。请右键以管理员身份运行修复器。")
        if not targets: return stopped
        handles = []
        try:
            # 打开并校验所有句柄后再发关闭消息，避免父退出后漏掉后台子进程。
            for item in targets:
                try: handles.append(ProcessHandle(item))
                except OSError as error:
                    raise RuntimeError("无法自动结束 " + process_label(item) + "。请右键以管理员身份运行修复器。" + str(error)) from error
            emit(f"正在关闭本目录的 {len(handles)} 个工作台与后台进程…", 1)
            for handle in handles:
                if not handle.exited(): handle.request_close()
            deadline = time.monotonic() + 2
            while any(not h.exited() for h in handles) and time.monotonic() < deadline:
                time.sleep(0.1)
            for handle in handles:
                if not handle.handle: continue
                forced = not handle.exited()
                if forced: emit("正在强制结束 " + process_label(handle.item), 1)
                try: handle.terminate()
                except (OSError, RuntimeError) as error:
                    raise RuntimeError("无法结束 " + process_label(handle.item) + "。请以管理员身份运行修复器后重试。" + str(error)) from error
                record = {**{k: handle.item.get(k) for k in ("ProcessId", "Name", "ExecutablePath", "Created")}, "forced": forced}
                stopped.append(record); write(report, stopped)
                emit(("已强制结束 " if forced else "已关闭 ") + process_label(handle.item), 1)
        finally:
            for handle in handles: handle.close()
    assert_stopped(root)
    return stopped


@contextmanager
def repair_lock(root, transaction):
    file = root / "data/cache/updates/repairer.lock"
    file.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(2):
        try:
            descriptor = os.open(file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(descriptor, json.dumps({"product": "voxcpm-studio-repairer", "pid": os.getpid()}).encode())
            os.close(descriptor)
            break
        except FileExistsError:
            previous = read(file)
            if previous.get("product") != "voxcpm-studio-repairer" or transaction.alive(previous.get("pid", 0)):
                raise RuntimeError("另一个修复任务仍在处理该目录，请等待完成")
            file.unlink()
    else:
        raise RuntimeError("无法取得修复目录锁")
    try:
        yield
    finally:
        if file.exists() and read(file).get("pid") == os.getpid():
            file.unlink()


def installed_identity(root):
    version = None
    for name in ("resources/app/package.json", ".voxcpm-install.json", "runtime_manifest.json"):
        try:
            candidate = read(root / name).get("version")
            if re.fullmatch(r"\d+\.\d+\.\d+", candidate or ""):
                version = candidate
                break
        except (OSError, ValueError, AttributeError):
            pass
    release = "00000000000000"
    try:
        candidate = read(root / "resources/app/update-config.json").get("releaseId")
        if re.fullmatch(r"\d{14}", candidate or ""):
            release = candidate
    except (OSError, ValueError, AttributeError):
        pass
    return version, release


def baseline_version(root):
    try:
        metadata = read(root / "runtime_manifest.json")
        match = re.search(r"-(\d+\.\d+\.\d+)$", metadata.get("bundle_name", ""))
        if match and metadata.get("desktop_shell") == "electron":
            return match[1]
    except (OSError, ValueError, AttributeError):
        pass
    return None


def recover_pending(root, transaction):
    pending = root / "data/cache/updates/pending.json"
    if not pending.exists():
        return False, None
    state = read(pending)
    session = Path(state["session"]).resolve(strict=True)
    if not session.is_relative_to(pending.parent.resolve()):
        raise ValueError("中断事务不属于该目录，未自动恢复")
    settings = read(session / "session.json")
    if Path(settings["root"]).resolve() != root or Path(settings["session"]).resolve() != session:
        raise ValueError("中断事务身份不一致，未自动恢复")
    if state.get("pid") and transaction.alive(state["pid"]):
        raise RuntimeError("原更新进程仍在运行，请等待或正常关闭原更新器后重试")
    journal_file = session / "journal.json"
    if not journal_file.exists():
        return False, session
    journal = read(journal_file)
    for item in journal.get("changes", []):
        transaction.safe_path(item["path"])
        if item.get("existed") and not (session / "backup" / item["path"]).is_file():
            return False, session
    transaction.run(session, recover=True)
    return True, None


def safe_member(root, relative):
    if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative or relative.startswith("/") or ".." in relative.split("/"):
        raise ValueError("运行环境路径非法")
    target = root / relative
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("运行环境路径越界")
    cursor = target
    while cursor != root:
        if cursor.is_symlink() or cursor.is_junction():
            raise ValueError("运行环境目录不能包含链接")
        cursor = cursor.parent
    return target


def provision_runtime(root, payload, manifest, session):
    if not re.fullmatch(r"[a-zA-Z0-9._-]{1,80}", manifest["id"]):
        raise ValueError("更新环境标识非法")
    base = root / "data/tools/updater-runtime"
    for directory in (root / "data", root / "data/tools", base):
        if directory.is_symlink() or directory.is_junction():
            raise ValueError("专用更新环境不能写入目录链接")
    destination = base / manifest["id"]
    if destination.is_symlink() or destination.is_junction():
        raise ValueError("专用更新环境不能是目录链接")
    source = Path(payload) / "runtime"
    def verified(folder):
        try:
            return all(safe_member(folder, r["path"]).is_file() and (folder/r["path"]).stat().st_size == r["size"] and digest(folder/r["path"]) == r["sha256"] for r in manifest["files"])
        except (OSError, ValueError):
            return False
    if not verified(source):
        raise ValueError("修复器内置更新环境校验失败")
    if not verified(destination):
        base.mkdir(parents=True, exist_ok=True)
        staging = base / (manifest["id"] + ".new-" + uuid.uuid4().hex)
        staging.mkdir()
        for item in manifest["files"]:
            target = safe_member(staging, item["path"])
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source / item["path"], target)
        if not verified(staging):
            raise ValueError("专用更新环境写入校验失败")
        backup = session / "updater-runtime-backup"
        if destination.exists():
            os.replace(destination, backup)
        try:
            os.replace(staging, destination)
        except BaseException:
            if backup.exists():
                os.replace(backup, destination)
            raise
    python = destination / manifest["python"]
    subprocess.run([str(python), "-B", "-c", "from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey; import ssl,zipfile"],
                   check=True, capture_output=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
    write(destination / "runtime-manifest.json", manifest)
    return python


def obtain_package(session, payload, manifest):
    meta = manifest["package"]
    embedded = Path(payload) / "snapshot" / meta["name"]
    target = session / "package.zip"
    if embedded.is_file() and embedded.stat().st_size == meta["size"] and digest(embedded) == meta["sha256"]:
        shutil.copy2(embedded, target)
        return
    partial = session / "package.part"
    offset = partial.stat().st_size if partial.exists() else 0
    if offset > meta["size"]:
        partial.unlink(); offset = 0
    if offset < meta["size"]:
        with open_url(meta["url"], {"Range": f"bytes={offset}-"} if offset else None) as response:
            if response.status == 206:
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                if not match or int(match[1]) != offset or int(match[3]) != meta["size"]:
                    raise ValueError("更新服务器续传响应错误")
            else:
                offset = 0
            with partial.open("ab" if offset else "wb") as stream:
                while chunk := response.read(256 * 1024):
                    offset += len(chunk)
                    if offset > meta["size"]:
                        raise ValueError("更新包大小超出签名清单")
                    stream.write(chunk)
                    emit(f"正在下载可信更新 {int(offset*100/meta['size'])}%", 10 + int(offset*15/meta["size"]))
    if partial.stat().st_size != meta["size"] or digest(partial) != meta["sha256"]:
        raise ValueError("更新包哈希校验失败，未替换应用文件")
    os.replace(partial, target)


def migrate_components(root, session):
    file = root / "data/component-selection.json"
    if file.exists():
        try:
            previous = read(file)
            if isinstance(previous.get("selected"), list) and all(isinstance(x, str) for x in previous["selected"]):
                return False
        except (OSError, ValueError, AttributeError):
            pass
        backup = session / "metadata-backup/component-selection.json"
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, backup)
    selected = []
    try:
        catalog = read(session / "stage/resources/app/music-config.json")
        selected = [m["id"] for m in catalog["models"] if m["files"] and all((root/a["name"]).is_file() and (root/a["name"]).stat().st_size == a["size"] for a in m["files"])]
    except (OSError, ValueError, KeyError):
        pass
    if (root / "data/lipsync/env/python.exe").is_file():
        selected.insert(0, "lipsync")
    write(file, {"protocol": 1, "selected": selected, "removed": [], "defaultModel": next((x for x in selected if x != "lipsync"), "ace-xl-turbo")})
    return True


def repair_launchers(root, session, shortcut_places=None):
    changed = []
    for name in ("Launch VoxCPM Studio Desktop.bat", "Launch VoxCPM Studio Electron.bat"):
        file = root / name
        if file.is_symlink() or file.is_junction():
            continue
        if file.is_file() and any(word in file.read_bytes().lower() for word in (b"electron_shell", b"electron.exe")):
            backup = session / "entry-backup" / name
            backup.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(file, backup)
            file.write_bytes(b'@echo off\r\nset "ELECTRON_RUN_AS_NODE="\r\nset "VOXCPM_APP_ROOT="\r\nset "VOXCPM_DATA_ROOT="\r\nset "VOXCPM_PYTHON_EXE="\r\ncd /d "%~dp0"\r\nstart "" "%~dp0VoxCPM Studio.exe" --voxcpm-run\r\n')
            changed.append(str(file))
    # 仅修正现有且明确指向当前安装目录的快捷方式，不创建/覆盖其他用户快捷方式。
    script = r"""
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$repairRoot=$env:VOXCPM_REPAIR_TARGET
$backup=$env:VOXCPM_REPAIR_BACKUP
$shell=New-Object -ComObject WScript.Shell
$places=@([Environment]::GetFolderPath('DesktopDirectory'),[Environment]::GetFolderPath('CommonDesktopDirectory'),(Join-Path ([Environment]::GetFolderPath('Programs')) 'VoxCPM Studio'))
if($env:VOXCPM_REPAIR_SHORTCUT_FOLDERS) { $places=@(ConvertFrom-Json $env:VOXCPM_REPAIR_SHORTCUT_FOLDERS) }
$changed=@()
foreach($place in $places) { if(Test-Path -LiteralPath $place) { foreach($file in Get-ChildItem -LiteralPath $place -Filter '*.lnk' -ErrorAction SilentlyContinue) {
 if(($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
 $link=$shell.CreateShortcut($file.FullName)
 if($link.TargetPath -and ([IO.Path]::GetFileName($link.TargetPath) -in @('VoxCPM Studio.exe','electron.exe','Launch VoxCPM Studio Desktop.bat','Launch VoxCPM Studio Electron.bat')) -and ([IO.Path]::GetFullPath($link.TargetPath)).StartsWith($repairRoot+'\',[StringComparison]::OrdinalIgnoreCase)) {
  New-Item -ItemType Directory -Force -Path $backup | Out-Null
  Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $backup ([guid]::NewGuid().ToString()+'.lnk'))
  $link.TargetPath=Join-Path $repairRoot $(if(Test-Path -LiteralPath (Join-Path $repairRoot 'JVOX Studio配音系统.exe')) {'JVOX Studio配音系统.exe'} else {'VoxCPM Studio.exe'});$link.Arguments='--voxcpm-run';$link.WorkingDirectory=$repairRoot;$link.Save();$changed+=$file.FullName
 }
} } }
ConvertTo-Json -InputObject $changed -Compress
"""
    result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", script], capture_output=True, text=True, encoding="utf-8",
        env={**os.environ, "VOXCPM_REPAIR_TARGET": str(root), "VOXCPM_REPAIR_BACKUP": str(session / "entry-backup"),
             "VOXCPM_REPAIR_SHORTCUT_FOLDERS": json.dumps([str(p) for p in shortcut_places]) if shortcut_places is not None else ""}, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise RuntimeError("程序已升级，但旧启动入口修复失败：" + result.stderr)
    changed.extend(json.loads(result.stdout or "[]"))
    return changed


def verify_channel(root):
    code = r"""const fs=require('fs'),path=require('path');const root=process.argv[1],appDir=path.join(root,'resources/app');
const {UpdateService}=require(path.join(appDir,'update-service.js'));const version=JSON.parse(fs.readFileSync(path.join(appDir,'package.json'))).version;
(async()=>{const s=new UpdateService({root,dataRoot:path.join(root,'data'),appDir,currentVersion:version,pythonExecutable:'__audio_python_not_used__'});
await s.ensureUpdaterPython();const state=await s.check();if(!['current','available'].includes(state.status)||state.updaterRuntime!=='dedicated')throw new Error(state.message);
console.log(JSON.stringify({status:state.status,currentReleaseId:state.currentReleaseId,latestReleaseId:state.latestReleaseId,updaterRuntime:state.updaterRuntime,python:s.python}));})().catch(e=>{console.error(e.message);process.exitCode=1});"""
    result = subprocess.run([str(root / ("JVOX Studio配音系统.exe" if (root / "JVOX Studio配音系统.exe").is_file() else "VoxCPM Studio.exe")), "-e", code, str(root)], capture_output=True, text=True, encoding="utf-8",
        env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"}, timeout=90, creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise RuntimeError("程序已修复，但后续更新通道检查未通过：" + result.stderr.strip())
    return json.loads(result.stdout.strip().splitlines()[-1])


def repair(request):
    work, payload = Path(request["work"]).resolve(), Path(request["payload"]).resolve()
    config = read(payload / "repair-config.json")
    transaction = load_transaction(payload)
    root = validate_root(request["root"])
    with repair_lock(root, transaction):
        stop_owned_processes(root, work)
        return perform_repair(request, work, payload, config, transaction, root)


def perform_repair(request, work, payload, config, transaction, root):
    emit("正在检查并恢复旧版更新记录…", 2)
    recovered, superseded = recover_pending(root, transaction)
    previous_version, previous_release = installed_identity(root)
    baseline = previous_version or baseline_version(root)
    if not baseline:
        raise ValueError("无法识别兼容安装基线，未修改应用文件；请保留目录与日志供维护者确认")
    emit("正在验证可信更新与修复范围…", 6)
    envelope, manifest, network_error = choose_release(payload, config)
    if previous_version is None:
        if network_error:
            raise RuntimeError("旧版版本信息损坏且网络不可用，不能可靠选择修复目标；请联网后重试")
        emit("版本信息损坏，依据已识别的安装基线恢复最新可信程序…", 8)
    if release_order({"version": previous_version or baseline, "releaseId": previous_release}) > release_order(manifest):
        raise RuntimeError("当前软件比修复器内置版本更新，已拒绝降级；请联网获取新版修复器")
    session = root / "data/cache/updates" / ("session-repairer-" + uuid.uuid4().hex)
    session.mkdir(parents=True)
    write(session / "envelope.json", envelope)
    settings = {"root": str(root), "session": str(session), "parentPid": 0, "publicKey": config["publicKey"],
        "currentVersion": previous_version, "baselineVersion": baseline, "repairIdentityUnknown": previous_version is None,
        "currentReleaseId": previous_release, "repair": True,
        "resultPath": str(root / "data/cache/updates/last-result.json")}
    write(session / "session.json", settings)
    obtain_package(session, payload, manifest)
    manifest = transaction.validate(session, settings)
    runtime = read(session / "stage/resources/app/updater-runtime-config.json")
    emit("正在补齐独立更新通道，不改动音频环境…", 26)
    python = provision_runtime(root, payload, runtime, session)
    settings["pythonExecutable"] = str(python)
    write(session / "session.json", settings)
    migrated = migrate_components(root, session)
    bootstrap = root / "runtime_manifest.json"
    try:
        read(bootstrap)
    except (OSError, ValueError):
        if bootstrap.exists():
            backup = session / "metadata-backup/runtime_manifest.json"
            backup.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(bootstrap, backup)
        write(bootstrap, {"protocol": 1, "mode": "repair-migrated", "platform": "win32-x64", "version": previous_version})
    stopped = stop_owned_processes(root, work)
    latest_version, latest_release = installed_identity(root)
    if release_order({"version": latest_version or baseline, "releaseId": latest_release}) > release_order(manifest):
        raise RuntimeError("修复期间检测到更高版本已安装，已停止覆盖")
    if superseded:
        emit("旧回滚备份不完整，保留记录并从完整签名包继续修复…", 28)
        shutil.copy2(root / "data/cache/updates/pending.json", session / "previous-pending.json")
        old_journal = superseded / "journal.json"
        if old_journal.exists():
            shutil.copy2(old_journal, session / "previous-journal.json")
            journal = read(old_journal)
            journal.update(status="superseded-by-repair", supersedingSession=str(session))
            write(old_journal, journal)
    # 安装前标记当前工作进程，阻止用户误开旧工作台与替换过程并发。
    write(root / "data/cache/updates/pending.json", {"session": str(session), "pid": os.getpid()})
    # 清除仅对当前进程生效的旧开发入口覆盖，数据中的模型与配置保持原样。
    for key in ("ELECTRON_RUN_AS_NODE", "VOXCPM_APP_ROOT", "VOXCPM_DATA_ROOT", "VOXCPM_PROJECT_ROOT", "VOXCPM_PYTHON_EXE", "VOXCPM_MODEL_DIR", "VOXCPM_UPDATE_SESSION", "VOXCPM_UPDATE_HEALTH_FILE"):
        os.environ.pop(key, None)
    transaction.emit = lambda text, progress=0: emit(text, max(28, min(92, progress)))
    transaction.run(session)
    for record in manifest["files"]:
        if record["path"].startswith("resources/app/") and digest(root / record["path"]) != record["sha256"]:
            raise RuntimeError("应用已启动，但更新组件文件核验失败：" + record["path"])
    emit("正在修正原软件的启动入口…", 94)
    entries = repair_launchers(root, session)
    emit("正在使用已安装更新服务验证后续升级通道…", 97)
    channel = verify_channel(root)
    report = {"status": "complete", "message": "修复完成，独立更新通道已验证。", "root": str(root), "transactionSession": str(session),
        "previousVersion": previous_version, "baselineVersion": baseline, "previousVersionKnown": previous_version is not None,
        "previousReleaseId": previous_release, "version": manifest["version"], "releaseId": manifest["releaseId"],
        "recoveredInterruptedUpdate": recovered, "forwardRepair": bool(superseded), "dedicatedRuntime": str(python), "updateChannelVerified": True, "channel": channel,
        "componentSelectionMigrated": migrated, "entryRepairs": entries, "stoppedProcesses": stopped, "catalogNetworkError": network_error, "finishedAt": time.time()}
    write(work / "status.json", report)
    write(request["resultPath"], report)
    emit("修复完成，后续可直接在软件内检查更新。", 100)
    return report
