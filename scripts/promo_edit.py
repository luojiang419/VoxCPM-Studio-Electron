"""真实桌面录屏剪辑：输入活动去静止、鼠标跟随、Bezier镜头与运动模糊。

读取原片实际PTS而非平均FPS；不改写界面内容，不拼接旁白。
"""
from pathlib import Path
import argparse
import bisect
import json
import math
import re
import subprocess
import time
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "builds/promo"
FF = ROOT.parent / "runtime/ffmpeg/bin/ffmpeg.exe"
PROBE = FF.with_name("ffprobe.exe")
FONT = "C:/Windows/Fonts/msyh.ttc"
BOLD = "C:/Windows/Fonts/msyhbd.ttc"

def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))

def bezier(x):
    """CSS cubic-bezier(.22,1,.36,1)，二分反解X。"""
    x = max(0., min(1., x))
    lo, hi = 0., 1.
    for _ in range(16):
        t = (lo + hi) / 2
        value = 3 * (1-t)**2 * t * .22 + 3 * (1-t) * t*t * .36 + t**3
        if value < x:
            lo = t
        else:
            hi = t
    return 1 - (1 - (lo + hi) / 2)**3

def merge(spans, gap=.45):
    result = []
    for a, b in sorted(spans):
        if b <= a:
            continue
        if result and a <= result[-1][1] + gap:
            result[-1][1] = max(result[-1][1], b)
        else:
            result.append([a, b])
    return result

class Recording:
    def __init__(self, directory, actions):
        self.root = directory
        self.meta = read(directory / "session.json")
        self.start = self.meta["startedAt"]
        source = directory / "screen.mp4"
        constant = directory / "screen-cfr60.mp4"
        if not constant.exists():
            print("按原始PTS重采样60fps：", directory.name, flush=True)
            subprocess.run([str(FF), "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
                "-an", "-vf", "fps=60", "-c:v", "h264_nvenc", "-preset", "p4", "-cq", "15", "-pix_fmt", "yuv420p", str(constant)], check=True)
        self.cap = cv2.VideoCapture(str(constant))
        self.actions = [dict(row, t=row["time"]-self.start-.20) for row in actions
                        if self.start <= row["time"] <= self.start+self.cap.get(cv2.CAP_PROP_FRAME_COUNT)/self.cap.get(cv2.CAP_PROP_FPS)+1]
        self.pts = np.arange(int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT)))/60
        samples = [json.loads(line) for line in (directory / "cursor.jsonl").read_text(encoding="utf-8").splitlines()]
        self.mouse = np.array([[row["t"]-.20, row["x"], row["y"], row["left"], row["appVisible"]] for row in samples], dtype=float)
        self.index = -1
        self.frame = None
        self.valid = []
        active = None
        for sample in self.mouse:
            if sample[4] and active is None:
                active = max(0, sample[0])
            elif not sample[4] and active is not None:
                self.valid.append([active, sample[0]])
                active = None
        if active is not None:
            self.valid.append([active, self.mouse[-1, 0]])
        self.clicks = [row["t"] for row in self.actions if row["action"] == "click"]

    def cursor(self, t):
        return np.array([np.interp(t, self.mouse[:, 0], self.mouse[:, 1]), np.interp(t, self.mouse[:, 0], self.mouse[:, 2])])

    def image(self, t):
        index = min(len(self.pts)-1, max(0, int(np.searchsorted(self.pts, t))))
        if self.frame is not None and index == self.index:
            return self.frame
        if index < self.index or index > self.index + 120:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, index))
            self.index = index-1
        while self.index < index:
            ok, frame = self.cap.read()
            if not ok:
                raise RuntimeError(f"无法解码真实原片：{self.root.name} / {index}")
            self.frame, self.index = frame, self.index+1
        return self.frame

    def keep(self, start, end):
        spans = []
        for row in self.actions:
            t = row["t"]
            if start <= t <= end:
                if row["action"] in {"move", "click"}:
                    spans.append([t-.60, t+.62])
                elif row["action"] == "type":
                    spans.append([t-max(.4, row.get("characters", 0)*.019), t+.5])
                elif row["action"] == "key":
                    spans.append([t-.1, t+.45])
        # 每段保留实际完成状态，避免只留下点击而漏掉结果。
        spans.extend([[start, start+.35], [end-.75, end-.10]])
        spans = merge([[max(a, start), min(b, end)] for a, b in spans])
        valid = []
        for a, b in spans:
            for va, vb in self.valid:
                lo, hi = max(a, va+.24), min(b, vb-.05)
                if hi-lo >= .10:
                    valid.append([lo, hi])
        return merge(valid, gap=.06)

def build_timeline(recordings, config, duration):
    first = recordings[0]
    chapters = {row.get("name"): row["t"] for row in first.actions if row["action"] == "chapter"}
    intervals = {
        "intro": [(first, 43., 45.), (first, 257., 259.), (first, 358.5, 360.5)],
        "design": [(first, chapters["design"], chapters["example"]-.2)],
        "example": [(first, chapters["example"], chapters["save"]-.3)],
        "save": [(first, chapters["save"], 155.)],
        "production": [(first, chapters["production"], chapters["batch"]-.3)],
        "batch": [(first, chapters["batch"], chapters["history"]-.1), (first, chapters["history"], chapters["music"]-.1)],
        "quickstart": [(first, chapters["quickstart"], chapters["capture-pause"]-.1)],
    }
    # 补录的真实结果镜头可加入“更多创作”段，不替换或伪造原始界面。
    extras = {}
    for recording in recordings[1:]:
        markers = [row for row in recording.actions if row["action"] == "chapter"]
        for i, marker in enumerate(markers):
            if marker.get("name") in {"music-result", "photo-result", "video-result"}:
                end = markers[i+1]["t"] if i+1 < len(markers) else recording.pts[-1]-.2
                clicks = [row["t"] for row in recording.actions if row["action"] == "click" and marker["t"] <= row["t"] < end]
                a = clicks[0]+.15 if clicks else marker["t"]+.20
                extras[marker["name"]] = (recording, a, min(end-.1, a+3.1))
    paragraphs = [value.strip() for value in (ROOT / "scripts/promo_narration.txt").read_text(encoding="utf-8").splitlines() if value.strip()]
    weights = [len(re.sub(r"[\W_]", "", text)) for text in paragraphs]
    ends = np.cumsum(weights) / sum(weights) * duration
    if (OUT / "chapters-aligned.json").exists():
        ends = np.array(read(OUT / "chapters-aligned.json")[1:])
    start = 0.
    timeline = []
    for chapter, finish in zip(config["chapters"], ends):
        if chapter["id"] == "batch":
            groups = [("batch", "04 · 批量处理与作品归档", .21, intervals["batch"][:1], False),
                ("history", "作品记录 · 分类归档与导出", .35, intervals["batch"][1:], False),
                ("music", "音乐创作 · 30秒本地纯音乐" if "music-result" in extras else "音乐创作 · 风格与编曲", .12, [extras.get("music-result", (first, 382., 390.))], "music-result" in extras)]
            if "video-result" in extras:
                groups.append(("video", "视频对口型 · 实际生成与预览", .14, [extras["video-result"]], True))
            if "photo-result" in extras:
                groups.append(("photo", "照片说话 · 原创虚构头像", .18, [extras["photo-result"]], True))
            total_weight = sum(group[2] for group in groups)
            segment_start = start
            for identity, title, fraction, sources, live in groups:
                pieces = []
                for recording, a, b in sources:
                    for sa, sb in ([[a,b]] if live else recording.keep(a,b)):
                        pieces.append({"recording": recording, "in": sa, "out": sb})
                total = sum(piece["out"]-piece["in"] for piece in pieces)
                length = (float(finish)-start)*fraction/total_weight
                t = segment_start
                for piece in pieces:
                    span = (piece["out"]-piece["in"])/total*length
                    timeline.append({**piece, "start": t, "end": t+span, "chapter": {**chapter,"id": identity,"title": title}})
                    t += span
                segment_start += length
            start = float(finish)
            continue
        pieces = []
        for recording, a, b in intervals[chapter["id"]]:
            for sa, sb in recording.keep(a, b):
                pieces.append({"recording": recording, "in": sa, "out": sb})
        if not pieces:
            raise RuntimeError("没有可用的真实镜头：" + chapter["id"])
        total = sum(piece["out"]-piece["in"] for piece in pieces)
        t = start
        for piece in pieces:
            length = (piece["out"]-piece["in"]) / total * (float(finish)-start)
            timeline.append({**piece, "start": t, "end": t+length, "chapter": chapter})
            t += length
        start = float(finish)
    audit = [{"source": row["recording"].root.name, "sourceIn": round(row["in"], 3), "sourceOut": round(row["out"], 3),
              "start": round(row["start"], 3), "end": round(row["end"], 3), "chapter": row["chapter"]["id"]} for row in timeline]
    (OUT / "edit-timeline.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    return timeline

def wrapped(value, font, width):
    if font.getlength(value) > width and font.getlength(value) <= width*2:
        candidates = [i for i in range(1,len(value)) if font.getlength(value[:i]) <= width and font.getlength(value[i:]) <= width]
        punctuated = [i for i in candidates if value[i-1] in "，、："]
        if candidates:
            split = min(punctuated or candidates, key=lambda i: abs(font.getlength(value[:i])-font.getlength(value[i:])))
            return [value[:split].rstrip("，、："), value[split:]]
    lines, line = [], ""
    for ch in value:
        if line and font.getlength(line+ch) > width:
            lines.append(line)
            line = ch
        else:
            line += ch
    if line:
        lines.append(line)
    return lines

def text_layer(w, h, chapter, caption, vertical):
    layer = Image.new("RGBA", (w, h), (0,0,0,0))
    draw = ImageDraw.Draw(layer)
    if vertical:
        draw.rounded_rectangle((60, 94, 136, 170), radius=22, fill="#272725")
        draw.text((78, 95), "J", font=ImageFont.truetype(BOLD, 58), fill="#f0b874")
        draw.text((158, 95), "JVOX STUDIO", font=ImageFont.truetype(BOLD, 43), fill="#292927")
        draw.text((160, 150), "声音设计 · 真实软件操作", font=ImageFont.truetype(FONT, 26), fill="#74716b")
        font = ImageFont.truetype(BOLD, 57)
        for i, line in enumerate(wrapped(chapter["title"], font, 900)):
            draw.text((60, 234+i*84), line, font=font, fill="#292927")
        draw.rounded_rectangle((48, 427, 948, 439), radius=6, fill="#c77b40")
        font = ImageFont.truetype(BOLD, 47)
        lines = wrapped(caption, font, 860)
        for i, line in enumerate(lines):
            draw.text((500-font.getlength(line)/2, 1587+i*70), line, font=font, fill="#292927")
        draw.text((62, 1804), "本地创作，让灵感被听见", font=ImageFont.truetype(FONT, 28), fill="#837c72")
    else:
        brand_font = ImageFont.truetype(BOLD, 23)
        draw.rounded_rectangle((28, 28, 261, 80), radius=15, fill=(30,30,28,224))
        draw.text((48, 37), "JVOX STUDIO", font=brand_font, fill="#f0b874")
        font = ImageFont.truetype(BOLD, 28)
        label = chapter["title"]
        width = font.getlength(label)+48
        draw.rounded_rectangle((w-width-60, 28, w-60, 80), radius=15, fill=(30,30,28,224))
        draw.text((w-width-36, 34), label, font=font, fill="#fff5e9")
        font = ImageFont.truetype(BOLD, 39)
        lines = wrapped(caption, font, 1420)
        y = 1003-(len(lines)-1)*48
        width = max(font.getlength(line) for line in lines)+54 if lines else 0
        draw.rounded_rectangle((w/2-width/2, y-9, w/2+width/2, y+len(lines)*48+7), radius=17, fill=(25,25,23,226))
        for i, line in enumerate(lines):
            draw.text((w/2-font.getlength(line)/2, y+i*48), line, font=font, fill="white", stroke_width=0)
    return np.array(layer)

def composite(base, layer):
    h, w = base.shape[:2]
    regions = [(0, 90), (930, h)] if w > h else [(0, 450), (1560, h)]
    for top, bottom in regions:
        alpha = layer[top:bottom, :, 3:4].astype(np.float32)/255
        rgb = layer[top:bottom, :, :3][:, :, ::-1]
        base[top:bottom] = (base[top:bottom]*(1-alpha) + rgb*alpha).astype(np.uint8)
    return base

def camera_window(pointer, vertical, chapter, chapter_progress):
    x, y = pointer
    overview = chapter == "intro" or (y > 980 and not vertical)
    if chapter == "intro":
        x, y = (620 if vertical else 1020), 510
    elif chapter == "example":
        x, y = (570+370*chapter_progress if vertical else 780), 310
        if chapter_progress > .65:
            x, y = (560 if vertical else 1020), 880
            overview = not vertical
    elif chapter in {"photo", "video"}:
        x, y = 910, 780
    elif chapter == "production" and 1150 < x < 1350 and 700 < y < 850:
        x, y = 780, 500
    elif y > 980 and not vertical:
        x, y = 1020, 580
    if vertical:
        zoom = 1.18 if chapter == "intro" else 1.45 if x > 205 else 1.12
        height = 1080/zoom
        width = height * 900/1050
    else:
        zoom = 1.03 if overview else 1.58 if x > 205 else 1.015
        height = 1080/zoom
        width = height * 1920/1080
    return np.array([np.clip(x, width/2, 1920-width/2), np.clip(y, height/2, 1080-height/2), width, height])

def warp(source, camera, size):
    cx, cy, width, height = camera
    cx, cy = np.clip(cx, width/2, 1920-width/2), np.clip(cy, height/2, 1080-height/2)
    w, h = size
    matrix = np.array([[w/width, 0, w/2-cx*w/width], [0, h/height, h/2-cy*h/height]], dtype=np.float32)
    return cv2.warpAffine(source, matrix, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)

def render(timeline, captions, duration, vertical=False, draft=False):
    w, h = (1080, 1920) if vertical else (1920, 1080)
    fps = 30 if draft else 60
    label = "抖音竖版" if vertical else "闲鱼横版"
    if draft:
        label += "-预览"
    destination = OUT / ("JVOX宣传片-" + label + ".mp4")
    silent = OUT / ("render-" + label + ".mp4")
    log = (OUT / ("render-" + label + ".log")).open("w")
    process = subprocess.Popen([str(FF), "-hide_banner", "-loglevel", "warning", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-s", f"{w}x{h}", "-r", str(fps), "-i", "pipe:0", "-an", "-c:v", "h264_nvenc", "-preset", "p5", "-cq", "18",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(silent)], stdin=subprocess.PIPE, stderr=log)
    chapter_ends = [row["end"] for row in timeline]
    caption_ends = [row["end"] for row in captions]
    chapter_ranges = {}
    for shot in timeline:
        value = chapter_ranges.setdefault(shot["chapter"]["id"], [shot["start"], shot["end"]])
        value[1] = shot["end"]
    cached_layers = {}
    camera = None
    old_camera = None
    old_shot = -1
    shot_started = 0.
    started = time.monotonic()
    try:
        for index in range(math.ceil(duration*fps)):
            t = min(duration-.001, index/fps)
            shot_index = min(len(timeline)-1, bisect.bisect_right(chapter_ends, t))
            shot = timeline[shot_index]
            source_t = shot["in"]+(t-shot["start"])/(shot["end"]-shot["start"])*(shot["out"]-shot["in"])
            recording = shot["recording"]
            source = recording.image(source_t)
            pointer = recording.cursor(source_t)
            cr = chapter_ranges[shot["chapter"]["id"]]
            target = camera_window(pointer, vertical, shot["chapter"]["id"], (t-cr[0])/(cr[1]-cr[0]))
            if camera is None:
                camera = target.copy()
            if shot_index != old_shot:
                old_camera, old_shot, shot_started = camera.copy(), shot_index, t
            progress = bezier((t-shot_started)/.58)
            desired = old_camera*(1-progress)+target*progress
            next_camera = camera+(desired-camera)*(1-math.exp(-1/(fps*.12)))
            delta = next_camera-camera
            camera = next_camera
            size = (900, 1050) if vertical else (w, h)
            movement = np.linalg.norm(delta[:2]) * size[0]/camera[2]
            if movement > .9 and not draft:
                scene = sum(warp(source, camera-delta*k, size).astype(np.float32) for k in (.0,.28,.56))/3
                scene = scene.astype(np.uint8)
            else:
                scene = warp(source, camera, size)
            # 重绘真实采样的鼠标，原片录制时已隐藏系统鼠标。
            px = (pointer[0]-camera[0])*size[0]/camera[2]+size[0]/2
            py = (pointer[1]-camera[1])*size[1]/camera[3]+size[1]/2
            if 0 <= px < size[0] and 0 <= py < size[1]:
                p = np.array([[px,py],[px+2,py+24],[px+8,py+18],[px+14,py+29],[px+20,py+26],[px+14,py+15],[px+24,py+14]], dtype=np.int32)
                cv2.fillPoly(scene, [p], (255,255,255), cv2.LINE_AA)
                cv2.polylines(scene, [p], True, (35,35,33), 2, cv2.LINE_AA)
                nearest = min((source_t-click for click in recording.clicks if 0 <= source_t-click <= .50), default=None)
                if nearest is not None:
                    cv2.circle(scene, (round(px),round(py)), round(12+nearest*58), (58,135,208), max(1,round(3-nearest*4)), cv2.LINE_AA)
            if vertical:
                frame = np.full((h,w,3), (241,246,250), dtype=np.uint8)
                frame[470:1520,48:948] = scene
            else:
                frame = scene
            ci = min(len(captions)-1, bisect.bisect_right(caption_ends, t))
            key = (shot["chapter"]["id"], ci)
            if key not in cached_layers:
                cached_layers[key] = text_layer(w, h, shot["chapter"], captions[ci]["text"], vertical)
            frame = composite(frame, cached_layers[key])
            process.stdin.write(frame.tobytes())
            if index % (fps*8) == 0:
                print(f"{label} {index/fps:.0f}/{duration:.2f}s，渲染已用 {time.monotonic()-started:.0f}s", flush=True)
    finally:
        process.stdin.close()
        process.wait()
        log.close()
    if process.returncode:
        raise RuntimeError("视频编码失败：" + label)
    # 整条旁白直接编码，只做响度处理，没有音频切片或重新排列。
    command = [str(FF), "-hide_banner", "-loglevel", "error", "-y", "-i", str(silent), "-i", str(OUT / "原创青年男声-整段旁白.wav")]
    music = OUT / "exports/一起开场-本地纯音乐.wav"
    if music.exists():
        filters = ("[1:a]loudnorm=I=-16:TP=-1.5:LRA=7[voice];"
            "[2:a]asplit=3[m0][m1][m2];[m0][m1]acrossfade=d=1:c1=tri:c2=tri[m01];"
            "[m01][m2]acrossfade=d=1:c1=tri:c2=tri,volume=0.065,afade=t=in:d=1,"
            f"afade=t=out:st={max(0,duration-1.7)}:d=1.7[music];[voice][music]amix=inputs=2:duration=first:normalize=0[audio]")
        command += ["-i", str(music), "-filter_complex", filters, "-map", "0:v", "-map", "[audio]"]
    else:
        command += ["-map", "0:v", "-map", "1:a", "-af", "loudnorm=I=-16:TP=-1.5:LRA=7"]
    command += ["-c:v", "copy", "-c:a", "aac", "-ar", "48000", "-b:a", "256k", "-t", str(duration), "-movflags", "+faststart", str(destination)]
    subprocess.run(command, check=True)
    print("已保存", destination, flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--format", choices=["landscape", "portrait", "both"], default="both")
    parser.add_argument("--draft", action="store_true")
    parser.add_argument("--limit", type=float, default=0)
    args = parser.parse_args()
    actions = [json.loads(line) for line in (OUT / "native-actions.jsonl").read_text(encoding="utf-8").splitlines()]
    recordings = [Recording(path, actions) for path in sorted(OUT.glob("raw-*")) if (path / "session.json").exists()]
    if not recordings:
        raise RuntimeError("缺少实际录制素材。")
    audio, rate = sf.read(OUT / "原创青年男声-整段旁白.wav")
    duration = len(audio)/rate
    timeline = build_timeline(recordings, read(ROOT / "scripts/promo_plan.json"), duration)
    subtitles = read(OUT / "captions.json")["captions"]
    render_duration = min(duration, args.limit) if args.limit else duration
    if args.format in {"landscape", "both"}:
        render(timeline, subtitles, render_duration, draft=args.draft)
    if args.format in {"portrait", "both"}:
        render(timeline, subtitles, render_duration, vertical=True, draft=args.draft)
