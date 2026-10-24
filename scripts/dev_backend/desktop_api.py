"""使用安装目录的 Python，运行当前开发源码；不复制模型或依赖。"""
from pathlib import Path
import runpy
import sys
import types

ROOT = Path(__file__).resolve().parents[2]
package = types.ModuleType("voxcpm")
package.__path__ = [str(ROOT / "backend/voxcpm"), str(ROOT.parent / "src/voxcpm")]
sys.modules["voxcpm"] = package
model_package = types.ModuleType("voxcpm.model")
model_package.__path__ = [str(ROOT / "backend/voxcpm/model"), str(ROOT.parent / "src/voxcpm/model")]
sys.modules["voxcpm.model"] = model_package
runpy.run_path(str(ROOT.parent / "desktop_api.py"), run_name="__main__")
