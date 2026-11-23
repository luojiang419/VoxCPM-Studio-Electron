"""从完整旁白制作字幕初稿；按音频停顿微调时间，保留原始音频。"""
from pathlib import Path
import json
import re
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "builds/promo"
text = (ROOT / "scripts/promo_narration.txt").read_text(encoding="utf-8").strip()
audio, rate = sf.read(OUT / "原创青年男声-整段旁白.wav")
if audio.ndim > 1:
    audio = audio.mean(axis=1)
duration = len(audio) / rate
hop = int(rate * .02)
rms = np.array([np.sqrt(np.mean(audio[i:i + hop] ** 2)) for i in range(0, len(audio), hop)])
threshold = max(.005, min(.012, float(np.quantile(rms, .22))))
silent = rms < threshold
gaps = []
start = None
for i, value in enumerate(np.r_[silent, False]):
    if value and start is None:
        start = i
    elif not value and start is not None:
        if i - start >= 3:
            gaps.append(((start + i) * .01, (i - start) * .02))
        start = None

chunks, current = [], ""
for item in re.findall(r"[^，。！？、\n]+[，。！？、]?", text):
    item = item.strip()
    if not item:
        continue
    if current and len(current + item) > 23:
        chunks.append(current)
        current = ""
    current += item
    if item[-1:] in "。！？" or len(current) >= 17:
        chunks.append(current)
        current = ""
if current:
    chunks.append(current)

def weight(value):
    return max(1, len(re.sub(r"[\s，。！？、]", "", value)))

weights = np.array([weight(value) for value in chunks], dtype=float)
targets = np.cumsum(weights) / weights.sum() * (duration - .12)
bounds = [0.0]
for target in targets[:-1]:
    candidates = [(t, length) for t, length in gaps if abs(t - target) < .48 and t > bounds[-1] + .7]
    selected = min(candidates, key=lambda gap: abs(gap[0] - target) - min(.12, gap[1] * .2))[0] if candidates else float(target)
    bounds.append(max(bounds[-1] + .7, selected))
bounds.append(duration)

def stamp(seconds):
    ms = round(seconds * 1000)
    return f"{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}"

captions = [{"start": round(bounds[i], 3), "end": round(bounds[i + 1], 3),
             "text": value.rstrip("，。！？、")} for i, value in enumerate(chunks)]
(OUT / "宣传片字幕-待画面对齐.srt").write_text("\n\n".join(
    f"{i+1}\n{stamp(row['start'])} --> {stamp(row['end'])}\n{row['text']}" for i, row in enumerate(captions)) + "\n", encoding="utf-8")
(OUT / "captions.json").write_text(json.dumps({"timing": "按停顿估算，剪辑预览时复核", "duration": duration, "captions": captions}, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"字幕初稿 {len(captions)} 条，覆盖 {duration:.2f} 秒，原始旁白未剪切。")
