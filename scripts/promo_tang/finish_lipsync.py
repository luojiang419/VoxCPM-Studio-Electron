"""给放大的口型成品补上精确台词和真实声音波形，保留自然微表情。"""
import json
import subprocess
from common import OUT,ROOT,save

def ass_time(t):
    cs=round(t*100);return f"{cs//360000}:{cs//6000%60:02}:{cs//100%60:02}.{cs%100:02}"

def main():
    timeline=json.loads((OUT/"edit-timeline.json").read_text(encoding="utf-8"))
    section=next(s for s in timeline["sections"] if s["id"]=="lipsync-preview")
    a,b=section["start"],section["end"]
    lines=[(a+.04,a+3.36,"鼓点再紧些，莫让将军赶上了。"),(a+3.61,b-.05,"愿今夜的灯，长明不灭。")]
    template="""[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,Microsoft YaHei,38,&H00FFFFFF,&H00FFFFFF,&H00202020,&H00202020,-1,0,0,0,100,100,0,0,3,9,0,2,80,80,35,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    template+="\n".join(f"Dialogue: 0,{ass_time(lo)},{ass_time(hi)},Main,,0,0,0,,{text}" for lo,hi,text in lines)+"\n"
    (OUT/"lip-patch.ass").write_text(template,encoding="utf-8-sig")
    graph=(f"[1:a]asplit=2[wave][master];[wave]atrim=start={a}:end={b},asetpts=PTS-STARTPTS,"
        f"showwaves=s=1100x66:mode=cline:rate=60:colors=0xEFC18E:scale=sqrt,colorkey=0x000000:0.02:0.1,"
        f"setpts=PTS+{a}/TB[scope];[0:v]drawbox=x=0:y=945:w=1920:h=135:color=0x191816:t=fill:enable='between(t,{a},{b})'[clean];"
        f"[clean][scope]overlay=x=410:y=933:enable='between(t,{a},{b})':eof_action=pass,subtitles=lip-patch.ass[v];"
        "[master]loudnorm=I=-16:TP=-1.2:LRA=9[a]")
    ff=ROOT.parent/"runtime/ffmpeg/bin/ffmpeg.exe"
    subprocess.run([str(ff),"-hide_banner","-y","-i","film-silent-polished.mp4","-i","master-premix.wav","-filter_complex",graph,
        "-map","[v]","-map","[a]","-c:v","h264_nvenc","-preset","p5","-cq","17","-pix_fmt","yuv420p","-c:a","aac","-b:a","256k","-ar","48000","-movflags","+faststart","-shortest","JVOX-唐宫小剧场与完整教程-横版.mp4"],cwd=OUT,stdout=subprocess.DEVNULL,stderr=(OUT/"lip-finish.log").open("w",encoding="utf-8"),check=True)
    timeline["captions"]=[c for c in timeline["captions"] if not (a<=c["start"]<b)]
    timeline["captions"].extend({"start":lo,"end":hi,"text":text} for lo,hi,text in lines)
    timeline["captions"].sort(key=lambda c:c["start"])
    save("edit-timeline.json",timeline)
    print("口型台词与波形已完成",flush=True)

if __name__=="__main__":main()
