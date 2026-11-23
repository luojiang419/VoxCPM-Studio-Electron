"""单文件修复器内置运行时执行入口。"""
import argparse
import json
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine

parser = argparse.ArgumentParser()
parser.add_argument("--request", type=Path, required=True)
args = parser.parse_args()
request = json.loads(args.request.read_text("utf-8-sig"))
try:
    if request.get('maintenance'):
        import maintenance
        maintenance.maintain(request)
    else:
        engine.repair(request)
except Exception as error:
    import traceback
    traceback.print_exc()
    result = {"status": "error", "message": str(error), "root": request.get("root"), "finishedAt": time.time()}
    engine.write(Path(request["work"]) / "status.json", result)
    engine.write(request["resultPath"], result)
    engine.emit(str(error), 0)
    sys.exit(1)
