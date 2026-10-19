"""最终安装器 EXE 的最小化/恢复验证；只打开全新测试目录首页。"""
from ctypes import wintypes
import ctypes
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from smoke_legacy_repairer import capture_window


def run(build):
    info = json.loads(Path(build).read_text('utf8'))
    output = ROOT / 'builds/minimize-validation' / ('final-' + str(time.time_ns()))
    output.mkdir(parents=True)
    user32 = ctypes.WinDLL('user32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.EnumChildWindows.argtypes = [wintypes.HWND, callback_type, wintypes.LPARAM]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.IsWindowVisible.argtypes = user32.IsIconic.argtypes = [wintypes.HWND]
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    child = subprocess.Popen([info['executable'], '--root', str(output / 'fresh-target')])
    window = None

    def windows():
        found = []

        @callback_type
        def visit(handle, _):
            process_id = wintypes.DWORD()
            user32.GetWindowThreadProcessId(handle, ctypes.byref(process_id))
            if process_id.value == child.pid and user32.IsWindowVisible(handle):
                name = ctypes.create_unicode_buffer(256)
                user32.GetClassNameW(handle, name, 256)
                if name.value.startswith('WindowsForms10.Window') or name.value == '#32770':
                    found.append(handle)
            return True

        user32.EnumWindows(visit, 0)
        return found

    def edit_values():
        values = []

        @callback_type
        def visit(handle, _):
            name = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(handle, name, 256)
            if '.EDIT.' in name.value.upper() or name.value.upper() == 'EDIT':
                value = ctypes.create_unicode_buffer(2048)
                user32.GetWindowTextW(handle, value, 2048)
                values.append(value.value)
            return True

        user32.EnumChildWindows(window, visit, 0)
        return sorted(values)

    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            active = windows()
            if active:
                window = active[0]
                break
            assert child.poll() is None, '安装器提前退出'
            time.sleep(.05)
        assert window, '安装窗口未显示'
        time.sleep(.2)
        before = edit_values()
        for _ in range(5):
            user32.ShowWindow(window, 6)
            time.sleep(.12)
            assert user32.IsIconic(window), '最终 EXE 未最小化'
            assert child.poll() is None and windows() == [window], '最小化退出或弹出额外对话框'
            user32.ShowWindow(window, 9)
            time.sleep(.12)
            assert not user32.IsIconic(window) and windows() == [window], '恢复后异常'
            assert edit_values() == before, '恢复后安装路径或输入值变化'
        capture_window(child, output / 'restored.png')
        result = {'passed': True, 'cycles': 5, 'exceptionDialogs': 0, 'build': str(build),
                  'installationStarted': False, 'userInstallationModified': False, 'inputValuesPreserved': True}
        (output / 'report.json').write_text(json.dumps(result, indent=2), encoding='utf8')
        print('PASS 最终 EXE 连续最小化/恢复 5 次，无额外异常对话框：' + str(output))
    finally:
        if window and child.poll() is None:
            user32.PostMessageW(window, 0x10, 0, 0)
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.terminate()
            child.wait(timeout=5)


if __name__ == '__main__':
    run(sys.argv[1])
