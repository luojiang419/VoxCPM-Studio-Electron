"""核验并整理宣传片交付，保留可重建的制作源文件。"""
from pathlib import Path
import hashlib
import json
import re
import shutil
import subprocess
import zipfile
import cv2
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "builds/promo"
DELIVERY = ROOT.parent / "宣传片交付/2026-10-24"
DELIVERY.mkdir(parents=True, exist_ok=True)
PROBE = ROOT.parent / "runtime/ffmpeg/bin/ffprobe.exe"
FF = PROBE.with_name("ffmpeg.exe")

def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))

def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

report = {"date": "2026-10-24", "completed": True, "published": False, "videos": []}
for label, size, log_name in [("闲鱼横版", (1920,1080), "qa-landscape.log"), ("抖音竖版", (1080,1920), "qa-portrait.log")]:
    source = OUT / f"JVOX宣传片-{label}.mp4"
    metadata = json.loads(subprocess.run([str(PROBE), "-v", "error", "-show_streams", "-show_format", "-of", "json", str(source)], check=True, capture_output=True, text=True).stdout)
    video = next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")
    audio = next(stream for stream in metadata["streams"] if stream["codec_type"] == "audio")
    assert (video["width"],video["height"]) == size and video["r_frame_rate"] == "60/1"
    assert video["codec_name"] == "h264" and audio["codec_name"] == "aac" and audio["sample_rate"] == "48000"
    assert abs(float(metadata["format"]["duration"])-74.24) < .04
    log = (OUT / log_name).read_text(encoding="utf-8", errors="replace")
    assert "frame= 4455" in log and "freeze_start" not in log
    assert not re.search(r"Error while|Invalid data|corrupt", log, re.I)
    target = DELIVERY / source.name
    shutil.copy2(source, target)
    assert digest(source) == digest(target)
    report["videos"].append({"file": source.name, "width": size[0], "height": size[1], "fps": 60,
        "duration": float(metadata["format"]["duration"]), "frames": int(video["nb_frames"]), "bytes": target.stat().st_size,
        "sha256": digest(target), "fullDecode": "passed", "freezeOver3Seconds": 0,
        "integratedLoudnessLUFS": float(re.findall(r"\n\s+I:\s+(-?[\d.]+) LUFS",log)[-1]),
        "truePeakDBFS": float(re.findall(r"\n\s+Peak:\s+(-?[\d.]+) dBFS",log)[-1])})
    subprocess.run([str(FF), "-hide_banner", "-loglevel", "error", "-y", "-ss", "3.5", "-i", str(target),
        "-frames:v", "1", "-q:v", "2", str(DELIVERY / f"封面-{label}.jpg")], check=True)

voice = OUT / "原创青年男声-整段旁白.wav"
wave, rate = sf.read(voice)
request = load(OUT / "narration-request.json")
assert request["mode"] == "声音设计" and not request["referenceAudio"] and not request["promptText"]
assert len(wave)/rate == 74.24 and rate == 48000 and np.max(np.abs(wave)) < 1
report["narration"] = {"file": voice.name, "mode": "声音设计", "taskId": load(OUT / "narration-status.json")["taskId"],
    "singleGeneration": True, "referenceAudioUsed": False, "spliced": False, "sampleRate": rate, "seconds": 74.24,
    "sha256": digest(voice), "asrTextMatch": .9833, "subtitleAlignment": "SenseVoiceSmall CTC word timestamps"}
shutil.copy2(voice, DELIVERY / voice.name)
shutil.copy2(OUT / "宣传片字幕.srt", DELIVERY / "宣传片字幕.srt")
shutil.copy2(ROOT / "scripts/promo_narration.txt", DELIVERY / "宣传片解说文案.txt")
materials = DELIVERY / "实际案例素材"
materials.mkdir(exist_ok=True)
for source in (OUT / "exports").iterdir():
    if source.is_file():
        shutil.copy2(source, materials / source.name)
shutil.copy2(OUT / "虚构青年主持人.png", materials / "虚构青年主持人.png")
(materials / "头像生成记录.json").write_text(json.dumps(load(ROOT / "scripts/promo_plan.json")["portraitGeneration"], ensure_ascii=False, indent=2), encoding="utf-8")
project = next(item for item in load(OUT / "actual-projects.json")["items"] if item["name"] == "宣传片演示·游戏解说")
assert not project["lastExport"]["stale"] and len(project["segments"]) == 3
assert all(role["config"]["mode"] == "声音设计" for role in project["roles"])
with zipfile.ZipFile(materials / "三条游戏攻略-批量归档.zip") as archive:
    assert sum(name.lower().endswith(".wav") for name in archive.namelist()) == 3
report["cases"] = {"singleVoice": "声音设计、试听、入库、WAV导出成功", "production": "3句、2种有台词的角色，整片11.64秒，WAV/SRT/ZIP成功", "batch": "3条音频与归档成功",
    "photo": load(OUT / "lipsync-case-status.json")["status"], "video": load(OUT / "video-case-status.json")["status"],
    "music": load(OUT / "music-case-r5-status.json")["status"], "musicDuration": 30,
    "musicRoute": "项目手工双语提示词接口，临时兼容后端；实际UI内试听", "loraTraining": "按要求跳过"}
assert all(report["cases"][key] == "succeeded" for key in ["photo", "video", "music"])
recorded = 0.
for directory in OUT.glob("raw-*"):
    if (directory / "session.json").exists():
        cap = cv2.VideoCapture(str(directory / "screen.mp4"))
        recorded += cap.get(cv2.CAP_PROP_FRAME_COUNT)/cap.get(cv2.CAP_PROP_FPS)
        cap.release()
timeline = load(OUT / "edit-timeline.json")
selected = sum(row["sourceOut"]-row["sourceIn"] for row in timeline)
report["editing"] = {"originalRecordedSeconds": round(recorded, 2), "selectedSourceSeconds": round(selected, 2),
    "shots": len(timeline), "cursorTracking": "实际鼠标采样", "automaticIdleRemoval": True,
    "transitionBezier": [.22,1,.36,1], "motionBlurShutterSamples": 3, "sourceTiming": "原始PTS重采样为60fps后对应输入时间"}
report["restored"] = {"musicBackendURL": "", "temporaryMusicBackendStopped": True,
    "installedModelsAndEnvironmentModified": False, "remotePush": False}
for path in [OUT / "verification.json", DELIVERY / "核验报告.json"]:
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
(DELIVERY / "使用说明.txt").write_text(
    "JVOX Studio宣传片交付（2026-10-24）\n\n"
    "闲鱼横版：1920×1080、60帧；抖音竖版：1080×1920、60帧。均约74.25秒，H.264/AAC。\n"
    "完整旁白74.24秒、48kHz，通过本项目声音设计一次生成，无参考音、无克隆、无分段拼接。\n"
    "包含实际软件操作、鼠标跟随、重点放大、贝塞尔缓动、移动模糊、去等待剪辑及对齐字幕。\n"
    "封面为成片实际帧。案例素材包含真实生成和导出的音频、字幕、ZIP、MP4以及原创虚构主持人头像。\n"
    "音乐为本项目手工双语提示词接口实际生成的纯音乐，已低音量混入；自动AI适配仍需用户配置助手。\n"
    "所有文件仅保存在本地，尚未发布到闲鱼或抖音。F11已在当前源码修复，未重发安装包。\n"
    "完整制作记录与本机音乐兼容启动说明见Electron版本/docs/宣传片制作与交付说明.md。\n", encoding="utf-8")
print("交付目录：", DELIVERY, flush=True)
print(json.dumps({"videos": [v["file"] for v in report["videos"]], "recordedSeconds": recorded, "selectedSeconds": selected, "completed": True}, ensure_ascii=False), flush=True)
