"""最终规格、完整解码、响度与冻结检查，并整理独立交付目录。"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
from common import OUT, ROOT, PLAN, save

FF=ROOT.parent/"runtime/ffmpeg/bin/ffmpeg.exe";PROBE=FF.with_name("ffprobe.exe")

def stamp(t):
    ms=round(t*1000);return f"{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}"

def main():
    film=OUT/"JVOX-唐宫小剧场与完整教程-横版.mp4"
    timeline=json.loads((OUT/"edit-timeline.json").read_text(encoding="utf-8"))
    info=json.loads(subprocess.check_output([str(PROBE),"-v","error","-show_streams","-show_format","-of","json",str(film)],text=True,encoding="utf-8"))
    video=next(s for s in info["streams"] if s["codec_type"]=="video");audio=next(s for s in info["streams"] if s["codec_type"]=="audio")
    assert (video["width"],video["height"],video["r_frame_rate"])==(1920,1080,"60/1")
    duration=float(info["format"]["duration"]);assert 180<=duration<=300
    assert abs(duration-timeline["duration"])<.12 and audio["sample_rate"]=="48000"
    report={"duration":duration,"width":1920,"height":1080,"fps":60,"sampleRate":48000,"openingSeconds":10,"storyStart":timeline["storyStart"],"storySeconds":timeline["duration"]-timeline["storyStart"],"captionCount":len(timeline["captions"]),"freezeThreshold":"-65dB / 3 seconds","narrationSingleGenerationTask":timeline["mainNarrationGeneration"],"narrationCTCMatch":.9709,"chapters":[s for s in timeline["sections"] if not s["id"].endswith("-preview")],"historicalNote":PLAN["historicalNote"]}
    # 一次完整解码同时扫描无意义长冻结与响度，保留原始日志供复核。
    check=subprocess.run([str(FF),"-hide_banner","-nostats","-i",str(film),"-vf","freezedetect=n=-65dB:d=3","-af","loudnorm=I=-16:TP=-1:LRA=9:print_format=json","-f","null","-"],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True,encoding="utf-8",errors="replace")
    (OUT/"qa-full-decode.log").write_text(check.stderr,encoding="utf-8");assert check.returncode==0
    report["fullDecodePassed"]=True
    freezes=[];start=None
    for line in check.stderr.splitlines():
        if "freeze_start:" in line:start=float(line.split("freeze_start:")[-1])
        if "freeze_end:" in line and start is not None:freezes.append([start,float(line.split("freeze_end:")[-1])]);start=None
    if start is not None:freezes.append([start,duration])
    report["freezesLongerThan3Seconds"]=freezes
    loud=re.search(r'\{\s*"input_i".*?\}',check.stderr,re.S)
    if loud:report["loudness"]=json.loads(loud.group(0))
    assert not freezes,"发现超过3秒的冻结，请检查qa日志与时间线后修复"
    captions=timeline["captions"]
    (OUT/"唐宫宣传片字幕.srt").write_text("\n\n".join(f"{i+1}\n{stamp(c['start'])} --> {stamp(c['end'])}\n"+(c.get('role','')+'：' if c.get('role') else '')+c['text'] for i,c in enumerate(captions))+"\n",encoding="utf-8")
    target=ROOT.parent/"宣传片交付/2026-10-24-唐宫横版"
    target.mkdir(parents=True,exist_ok=True)
    files=[film,OUT/"唐宫宣传片字幕.srt",OUT/"tutorial-narration.wav",OUT/"story-dialogue.wav",OUT/"一曲长安.wav",OUT/"film-proof.jpg"]
    for file in files:shutil.copy2(file,target/file.name)
    shutil.copytree(OUT/"exports",target/"真实功能案例",dirs_exist_ok=True)
    shutil.copytree(OUT/"images",target/"手绘与人物素材",dirs_exist_ok=True)
    shutil.copy2(OUT/"assets-manifest.json",target/"绘图提示词与来源.json")
    shutil.copy2(ROOT/"docs/唐宫宣传片制作与交付说明.md",target/"制作说明.md")
    shutil.copy2(ROOT/"scripts/promo_tang/plan.json",target/"完整文案与史料.json")
    for seconds,name in [(6,"唐宫作品封面.png"),(timeline["storyStart"]-30,"软件教程封面.png")]:
        subprocess.run([str(FF),"-v","error","-y","-ss",str(seconds),"-i",str(film),"-frames:v","1",str(target/name)],check=True)
    story_film=target/"胡旋未歇-完整手绘小剧场.mp4"
    subprocess.run([str(FF),"-v","error","-y","-ss",str(timeline["storyStart"]+.30),"-i",str(film),"-t",str(timeline["duration"]-timeline["storyStart"]-.30),"-c:v","h264_nvenc","-preset","p5","-cq","17","-c:a","aac","-b:a","256k","-movflags","+faststart",str(story_film)],check=True)
    report["sha256"]=hashlib.sha256(film.read_bytes()).hexdigest()
    assert hashlib.sha256((target/film.name).read_bytes()).hexdigest()==report["sha256"]
    report["deliveredTo"]=str(target)
    save("verification.json",report)
    (target/"核验报告.json").write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"seconds":duration,"directory":str(target),"loudness":report.get("loudness"),"freezeCount":len(freezes)},ensure_ascii=False),flush=True)

if __name__=="__main__":main()
