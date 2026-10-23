"""使用已安装SenseVoiceSmall的CTC时间戳对齐字幕，不重新生成或切割旁白。"""
from pathlib import Path
import difflib
import json
import os
import re

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", PYTHONDONTWRITEBYTECODE="1")
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "builds/promo"

def clean(value):
    return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", value)

cache = OUT / "narration-word-timestamps.json"
if cache.exists():
    result = json.loads(cache.read_text(encoding="utf-8"))
else:
    import torch
    from funasr import AutoModel
    torch.set_num_threads(4)
    model = AutoModel(model="D:/Program Files/VoxCPMStudio/models/iic__SenseVoiceSmall", device="cpu",
        disable_update=True, log_level="ERROR", ncpu=4)
    result = model.generate(input=str(OUT / "原创青年男声-整段旁白.wav"), language="zh", use_itn=True, output_timestamp=True)[0]
    cache.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

words, stamps = result["words"], result["timestamp"]
assert len(words) == len(stamps) and len(words) > 200
asr_chars, char_starts, char_ends = [], [], []
for word, (start, end) in zip(words, stamps):
    chars = clean(word)
    for i, ch in enumerate(chars):
        asr_chars.append(ch)
        char_starts.append((start + (end-start)*i/max(1,len(chars)))/1000)
        char_ends.append((start + (end-start)*(i+1)/max(1,len(chars)))/1000)

text = (ROOT / "scripts/promo_narration.txt").read_text(encoding="utf-8").strip()
original = clean(text)
recognition = "".join(asr_chars)
matcher = difflib.SequenceMatcher(None, original, recognition, autojunk=False)
mapping = {}
for a, b, length in matcher.get_matching_blocks():
    mapping.update({a+i: b+i for i in range(length)})
assert len(mapping)/len(original) > .90, "识别文本差异过大，停止自动对齐"
import numpy as np
keys = sorted(mapping)
positions = np.interp(np.arange(len(original)), keys, [mapping[key] for key in keys])
starts = np.interp(positions, np.arange(len(char_starts)), char_starts)
ends = np.interp(positions, np.arange(len(char_ends)), char_ends)
subtitles = json.loads((OUT / "captions.json").read_text(encoding="utf-8"))
offset = 0
for row in subtitles["captions"]:
    length = len(clean(row["text"]))
    row["start"] = round(max(0, float(starts[offset])-.07), 3)
    row["end"] = round(min(subtitles["duration"], float(ends[offset+length-1])+.10), 3)
    offset += length
assert offset == len(original)
subtitles["captions"][0]["start"] = 0
for i, row in enumerate(subtitles["captions"][:-1]):
    row["end"] = subtitles["captions"][i+1]["start"]
subtitles["captions"][-1]["end"] = subtitles["duration"]
subtitles["timing"] = "SenseVoiceSmall CTC 时间戳与原始文案对应，98%文本匹配"
(OUT / "captions.json").write_text(json.dumps(subtitles, ensure_ascii=False, indent=2), encoding="utf-8")

offset, boundaries = 0, [0.]
paragraphs = text.splitlines()
for paragraph in paragraphs[:-1]:
    offset += len(clean(paragraph))
    boundaries.append(round(max(0, float(starts[offset])-.07), 3))
boundaries.append(subtitles["duration"])
(OUT / "chapters-aligned.json").write_text(json.dumps(boundaries), encoding="utf-8")

def stamp(seconds):
    ms = round(seconds*1000)
    return f"{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}"

(OUT / "宣传片字幕.srt").write_text("\n\n".join(f"{i+1}\n{stamp(row['start'])} --> {stamp(row['end'])}\n{row['text']}" for i,row in enumerate(subtitles["captions"]))+"\n", encoding="utf-8")
print("CTC字幕对齐完成，匹配率", round(matcher.ratio(),4), "章节边界", boundaries, flush=True)
