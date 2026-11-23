"""用户已授权的原生输入与全屏录制，唐宫项目独立保存。"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import promo_native as n

n.OUT = n.ROOT / "builds/promo-tang"
n.OUT.mkdir(parents=True, exist_ok=True)
session_path=n.OUT/"session.json"
session_text=(n.ROOT/"builds/promo/session.json").read_text(encoding="utf-8")
if not session_path.exists() or session_path.read_text(encoding="utf-8") != session_text:
    pending=n.OUT/f"session-{os.getpid()}.tmp"
    pending.write_text(session_text,encoding="utf-8")
    pending.replace(session_path)

def key(*names):
    keys = {"ctrl":17,"shift":16,"alt":18,"a":65,"n":78,"r":82,"enter":13,"tab":9,"escape":27,"backspace":8,"f11":122,"home":36,"end":35,"down":40,"up":38,"left":37,"right":39}
    values = [keys[k.lower()] for k in names]
    n.send(*(n.key_event(v) for v in values), *(n.key_event(v, True) for v in reversed(values)))
    n.mark("key", keys=names)

def focus():
    n.focus()
    pid = n.wintypes.DWORD()
    window = n.user32.GetForegroundWindow()
    n.user32.GetWindowThreadProcessId(window, ctypes.byref(pid))
    expected = json.loads((n.OUT / "session.json").read_text(encoding="utf-8"))["pid"]
    if pid.value != expected:
        raise RuntimeError("未能激活本次 JVOX 进程")
    rect = n.wintypes.RECT()
    n.user32.GetWindowRect(window, ctypes.byref(rect))
    if (rect.left,rect.top,rect.right,rect.bottom) != (0,0,1920,1080):
        events=(n.INPUT*2)(n.key_event(122),n.key_event(122,True))
        if n.user32.SendInput(2,events,ctypes.sizeof(n.INPUT)) != 2:
            raise RuntimeError("无法发送全屏快捷键")
        time.sleep(.9)
    n.target()

def fill(x,y,text):
    n.click(x,y)
    key("ctrl","a")
    n.type_text(text)

def choose_file(x,y,path):
    n.click(x,y)
    time.sleep(.75)
    key("alt","n")
    key("ctrl","a")
    n.type_text(str(path))
    key("enter")
    time.sleep(.8)

def scroll(delta):
    n.send(n.INPUT(type=0,mi=n.MOUSEINPUT(mouseData=delta & 0xffffffff,dwFlags=0x0800)))
    n.mark("scroll",delta=delta)
    time.sleep(.65)

if __name__ == "__main__":
    p=argparse.ArgumentParser();p.add_argument("action");p.add_argument("values",nargs="*");a=p.parse_args()
    if a.action == "focus":focus()
    elif a.action == "record":n.record()
    elif a.action == "capture":n.capture(a.values[0])
    elif a.action == "stop":(Path(json.loads((n.OUT/"active-recording.json").read_text(encoding="utf-8"))["root"])/"stop").touch()
    elif a.action == "click":n.click(*map(int,a.values))
    elif a.action == "move":n.move(*map(int,a.values))
    elif a.action == "key":key(*a.values)
    elif a.action == "type":n.type_text(Path(a.values[0]).read_text(encoding="utf-8"))
    elif a.action == "mark":n.mark("chapter",name=" ".join(a.values))
    elif a.action == "scroll":scroll(int(a.values[0]))
