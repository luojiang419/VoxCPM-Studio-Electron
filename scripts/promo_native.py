"""原生录制备用工具；输入子命令需用户明确同意替代 Computer Use 后使用。

只向 session.json 对应的 JVOX 窗口输入；每次输入均核对前台窗口和全屏尺寸。
不修改系统设置，不访问网络，不在其他窗口输入，不删除文件。
"""
from pathlib import Path
import argparse
import ctypes
from ctypes import wintypes
import json
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "builds/promo"
FFMPEG = ROOT.parent / "runtime/ffmpeg/bin/ffmpeg.exe"
user32 = ctypes.windll.user32
try:
    user32.SetProcessDPIAware()
except OSError:
    pass
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetAncestor.restype = wintypes.HWND

def focus():
    expected = json.loads((OUT / "session.json").read_text(encoding="utf-8"))["pid"]
    matches = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(window, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(window, ctypes.byref(pid))
        name = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(window, name, len(name))
        if pid.value == expected and name.value == "JVOX Studio配音系统":
            matches.append(window)
        return True
    user32.EnumWindows(callback_type(visit), 0)
    if len(matches) != 1:
        raise RuntimeError("无法唯一定位本次录制窗口。")
    user32.ShowWindow(matches[0], 9)
    foreground = user32.GetForegroundWindow()
    foreground_thread = user32.GetWindowThreadProcessId(foreground, None)
    current_thread = ctypes.windll.kernel32.GetCurrentThreadId()
    attached = bool(user32.AttachThreadInput(current_thread, foreground_thread, True))
    try:
        user32.BringWindowToTop(matches[0])
        user32.SetForegroundWindow(matches[0])
    finally:
        if attached:
            user32.AttachThreadInput(current_thread, foreground_thread, False)
    time.sleep(.6)

def target():
    window = user32.GetForegroundWindow()
    name = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(window, name, len(name))
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(window, ctypes.byref(pid))
    expected = json.loads((OUT / "session.json").read_text(encoding="utf-8"))["pid"]
    owner = user32.GetAncestor(window, 3)
    owner_name = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(owner, owner_name, len(owner_name))
    if pid.value != expected or (name.value != "JVOX Studio配音系统" and owner_name.value != "JVOX Studio配音系统"):
        raise RuntimeError(f"前台不是本次录制的 JVOX 窗口（{name.value}, PID={pid.value}, 预期={expected}），已停止输入。")
    rect = wintypes.RECT()
    user32.GetWindowRect(owner, ctypes.byref(rect))
    if name.value == "JVOX Studio配音系统" and (rect.left, rect.top, rect.right, rect.bottom) != (0, 0, 1920, 1080):
        raise RuntimeError("软件必须处于原生 1920×1080 全屏，已停止输入。")
    return window

def mark(action, **data):
    with (OUT / "native-actions.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"time": time.time(), "action": action, **data}, ensure_ascii=False) + "\n")

def move(x, y):
    target()
    if not (0 <= x < 1920 and 0 <= y < 1080):
        raise ValueError("鼠标坐标超出软件画面。")
    point = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(point))
    start = time.perf_counter()
    while True:
        t = min(1, (time.perf_counter() - start) / .48)
        ease = 1 - (1 - t) ** 3
        user32.SetCursorPos(round(point.x + (x - point.x) * ease), round(point.y + (y - point.y) * ease))
        if t >= 1:
            break
        time.sleep(1 / 120)
    mark("move", x=x, y=y)

class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]

class INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]

class INPUT(ctypes.Structure):
    _anonymous_ = ("union",)
    _fields_ = [("type", wintypes.DWORD), ("union", INPUTUNION)]

def send(*events):
    target()
    batch = (INPUT * len(events))(*events)
    if user32.SendInput(len(events), batch, ctypes.sizeof(INPUT)) != len(events):
        raise RuntimeError("Windows 未接受全部输入事件。")

def key_event(vk, up=False):
    return INPUT(type=1, ki=KEYBDINPUT(wVk=vk, dwFlags=2 if up else 0))

def click(x, y):
    move(x, y)
    send(INPUT(type=0, mi=MOUSEINPUT(dwFlags=2)), INPUT(type=0, mi=MOUSEINPUT(dwFlags=4)))
    mark("click", x=x, y=y)

def type_text(value):
    target()
    raw = value.replace("\r\n", "\n").encode("utf-16-le")
    # Unicode 注入，避免更改用户剪贴板；逐字记录不保存文本内容。
    for i in range(0, len(raw), 2):
        unit = int.from_bytes(raw[i:i+2], "little")
        if unit == 10:
            send(key_event(13), key_event(13, True))
            time.sleep(.025)
            continue
        send(INPUT(type=1, ki=KEYBDINPUT(wScan=unit, dwFlags=4)),
             INPUT(type=1, ki=KEYBDINPUT(wScan=unit, dwFlags=6)))
        time.sleep(.012)
    mark("type", characters=len(value))

def capture(name):
    target()
    if Path(name).name != name or not name.endswith(".png"):
        raise ValueError("截图名称必须是当前输出目录内的 PNG 文件名。")
    subprocess.run([str(FFMPEG), "-hide_banner", "-loglevel", "error", "-f", "gdigrab",
        "-framerate", "30", "-draw_mouse", "1", "-i", "desktop", "-frames:v", "1", "-y", str(OUT / name)], check=True)

def record():
    target()
    recording = OUT / ("raw-" + time.strftime("%Y%m%d-%H%M%S"))
    recording.mkdir()
    start = time.time()
    process = subprocess.Popen([str(FFMPEG), "-hide_banner", "-loglevel", "warning", "-f", "gdigrab",
        "-framerate", "60", "-draw_mouse", "0", "-i", "desktop", "-c:v", "h264_nvenc", "-preset", "p5",
        "-cq", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", str(recording / "screen.mp4")],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=(recording / "ffmpeg.log").open("w"))
    metadata = json.dumps({"root": str(recording), "startedAt": start, "pid": process.pid}, ensure_ascii=False, indent=2)
    (OUT / "active-recording.json").write_text(metadata, encoding="utf-8")
    (recording / "session.json").write_text(metadata, encoding="utf-8")
    print(str(recording), flush=True)
    try:
        with (recording / "cursor.jsonl").open("w", encoding="utf-8") as stream:
            while process.poll() is None and not (recording / "stop").exists():
                point = wintypes.POINT()
                user32.GetCursorPos(ctypes.byref(point))
                try:
                    target()
                    valid = True
                except RuntimeError:
                    valid = False
                stream.write(json.dumps({"t": round(time.time() - start, 4), "x": point.x, "y": point.y,
                    "left": bool(user32.GetAsyncKeyState(1) & 0x8000), "appVisible": valid}) + "\n")
                stream.flush()
                time.sleep(1 / 60)
    finally:
        if process.poll() is None:
            process.stdin.write(b"q\n")
            process.stdin.flush()
            process.wait(timeout=30)
    if process.returncode:
        raise RuntimeError("录制编码失败，请查看本次 ffmpeg.log。")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["focus", "capture", "record", "stop", "click", "move", "type", "key", "mark"])
    parser.add_argument("values", nargs="*")
    args = parser.parse_args()
    if args.action == "focus":
        focus()
    elif args.action == "capture":
        capture(args.values[0])
    elif args.action == "record":
        record()
    elif args.action == "stop":
        info = json.loads((OUT / "active-recording.json").read_text(encoding="utf-8"))
        (Path(info["root"]) / "stop").touch()
    elif args.action in {"click", "move"}:
        (click if args.action == "click" else move)(*map(int, args.values))
    elif args.action == "type":
        type_text(Path(args.values[0]).read_text(encoding="utf-8"))
    elif args.action == "key":
        keys = {"ctrl": 17, "shift": 16, "alt": 18, "a": 65, "n": 78, "enter": 13, "tab": 9, "escape": 27, "backspace": 8}
        values = [keys[key.lower()] for key in args.values]
        send(*(key_event(key) for key in values), *(key_event(key, True) for key in reversed(values)))
        mark("key", keys=args.values)
    elif args.action == "mark":
        mark("chapter", name=" ".join(args.values))
