"""独立演示入口：同一套设置组件与真实 API，模型/依赖仅复用。"""
from pathlib import Path
import sys
import types

ROOT = Path(__file__).resolve().parents[1]
package = types.ModuleType("voxcpm")
package.__path__ = [str(ROOT / "backend/voxcpm"), str(ROOT.parent / "src/voxcpm")]
sys.modules["voxcpm"] = package

from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from voxcpm.studio_api import create_api_app
import uvicorn

app = create_api_app()
dist = ROOT / "frontend/voxcpm_studio_electron/dist"
app.mount("/assets", StaticFiles(directory=dist / "assets"), name="demo-assets")

@app.get("/")
def preview():
    return FileResponse(dist / "api-preview.html", headers={"Cache-Control": "no-store"})

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8918)
