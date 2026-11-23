"""在源码覆盖层运行音乐/助手测试，不依赖用户系统Python或完整加载TTS模型。"""
from pathlib import Path
import sys
import types

ROOT = Path(__file__).resolve().parents[1]
package = types.ModuleType('voxcpm'); package.__path__ = [str(ROOT / 'backend/voxcpm'), str(ROOT.parent / 'src/voxcpm')]
sys.modules['voxcpm'] = package
import pytest

if __name__ == '__main__':
    arguments = sys.argv[1:]
    if not any(not item.startswith('-') and Path(item).exists() for item in arguments):
        arguments = [str(ROOT / 'tests/test_music_prompts.py'), str(ROOT / 'tests/test_studio_assistant.py'), str(ROOT / 'tests/test_studio_music.py'), '-q', *arguments]
    raise SystemExit(pytest.main(arguments))
