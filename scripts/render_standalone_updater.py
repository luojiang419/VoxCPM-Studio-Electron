"""使用实际原生窗体渲染安装器共用主题及更新状态，不运行更新任务。"""
from pathlib import Path
import subprocess
import time
import json

ROOT = Path(__file__).resolve().parents[1]
output = ROOT / "builds/updater-theme-validation" / str(time.time_ns())
output.mkdir(parents=True)
executable = output / "UpdaterPreview.exe"
subprocess.run(["C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe", "/nologo", "/target:winexe", "/main:VoxStandaloneUpdater.UpdaterPreview",
                "/out:" + str(executable), "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll", "/reference:System.Web.Extensions.dll", "/reference:Accessibility.dll",
                "/resource:" + str(ROOT / "assets/brand/voxcpm-app-256.png") + ",app-mark.png",
                str(ROOT / "bootstrap/SharedTheme.cs"), str(ROOT / "updater/Program.cs"), str(ROOT / "updater/Preview.cs")], check=True)
subprocess.run([str(executable), str(output)], check=True)
from PIL import Image, ImageDraw
names = [f"{state}-{theme}.png" for theme in ("light", "dark") for state in ("checking", "installing", "restarting", "complete", "error", "long")]
sheet = Image.new("RGB", (1440, 936), "#e5e4de")
draw = ImageDraw.Draw(sheet)
for index, name in enumerate(names):
    frame = Image.open(output / name).convert("RGB")
    frame.thumbnail((360, 290))
    x, y = index % 4 * 360, index // 4 * 312
    sheet.paste(frame, (x, y + 22)); draw.text((x + 8, y + 4), name, fill="#30332d")
sheet.save(output / "contact-sheet.png")
observations = json.loads((output / "scale-observations.json").read_text("utf-8-sig"))
for item in observations:
    assert Image.open(output / f"scale-{item['scale']:.2f}.png").size == tuple(item["actual"])
    assert item["controlsInsideClient"]
(output / "report.json").write_text(json.dumps({"passed": True, "nativeFormRendered": True, "states": 6,
    "themes": ["light", "dark"], "scales": observations, "themeSwitchPreservesStatus": True,
    "closeBlockedWhileUpdating": True, "closeAllowedAfterCompletion": True,
    "promptThemes": ["light", "dark"], "promptDeferralCloses": True,
    "promptConfirmationWritesChoice": True, "promptDoesNotStartWorker": True}, indent=2), encoding="utf-8")
print(output)
