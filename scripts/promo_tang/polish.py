"""试听段增加真实音频频谱，口型段展示真实成品，章节用Bezier短溶解。"""
import bisect
import json
import math
import subprocess
import sys
import cv2
import numpy as np
import soundfile as sf
from PIL import Image,ImageDraw,ImageFont
from common import OUT,ROOT,save
sys.path.insert(0,str(ROOT/"scripts"))
from promo_edit import bezier
from edit import layer,overlay_regions

W,H,FPS=1920,1080,60
FF=ROOT.parent/"runtime/ffmpeg/bin/ffmpeg.exe"
cv2.setNumThreads(4)

def main():
    timeline=json.loads((OUT/"edit-timeline.json").read_text(encoding="utf-8"))
    sections=timeline["sections"];ends=[s["end"] for s in sections]
    signal,sr=sf.read(OUT/"master-premix.wav",dtype="float32",always_2d=True);signal=signal.mean(axis=1)
    cap=cv2.VideoCapture(str(OUT/"film-silent.mp4"));frames=int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    videos=[cv2.VideoCapture(str(OUT/"exports"/name)) for name in ["唐风视频对口型.mp4","唐风照片说话.mp4"]]
    video_frames=[None,None];video_indices=[-1,-1]
    captions=timeline["captions"];cached={}
    panels={}
    for key,text in [("music-preview","《一曲长安》 · 真实音乐试听"),("music_transition","让宴乐渐退到教程背景"),("production-preview","唐宫多角色工程 · 真实音频试听")]:
        im=Image.new("RGBA",(1120,208),(19,21,22,238));d=ImageDraw.Draw(im)
        d.rounded_rectangle((0,0,1119,207),18,fill=(19,21,22,238),outline=(157,116,65,220),width=2)
        d.text((28,16),text,font=ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc",27),fill="#efbd82")
        d.text((28,171),"音频可视化 · 后期呈现",font=ImageFont.truetype("C:/Windows/Fonts/msyh.ttc",17),fill="#a99d8e")
        panels[key]=np.array(im)
    child=subprocess.Popen([str(FF),"-v","warning","-y","-f","rawvideo","-pix_fmt","bgr24","-s",f"{W}x{H}","-r",str(FPS),"-i","pipe:0","-an","-c:v","h264_nvenc","-preset","p5","-cq","17","-pix_fmt","yuv420p","-movflags","+faststart",str(OUT/"film-silent-polished.mp4")],stdin=subprocess.PIPE,stderr=(OUT/"polish.log").open("w"))
    previous_section=-1;previous_frame=None;transition_from=None
    try:
        for f in range(frames):
            ok,frame=cap.read()
            if not ok:raise RuntimeError("合成原片读取失败")
            t=f/FPS;j=min(len(ends)-1,bisect.bisect_right(ends,t));section=sections[j];key=section["id"]
            if key in panels:
                panel=panels[key];x,y=400,713;alpha=panel[:,:,3:4].astype(np.float32)/255
                frame[y:y+208,x:x+1120]=(frame[y:y+208,x:x+1120]*(1-alpha)+panel[:,:,:3][:,:,::-1]*alpha).astype(np.uint8)
                center=round(t*sr);a=max(0,center-2048);b=min(len(signal),a+4096);sample=np.pad(signal[a:b],(0,4096-(b-a)))
                fft=np.abs(np.fft.rfft(sample*np.hanning(4096)))
                bins=np.geomspace(2,900,65).astype(int);values=np.array([fft[lo:hi+1].mean() for lo,hi in zip(bins,bins[1:])])
                values=np.clip(np.log1p(values*7)/5,0,1)
                # 居中的频谱随真实声音变化；没有为软件虚构新的控件。
                for k,value in enumerate(values):
                    height=round(12+103*value);xx=430+k*16
                    cv2.rectangle(frame,(xx,862-height),(xx+9,862),(100,175,231),-1,cv2.LINE_AA)
                # 同时绘制实时波形，低音量背景也有可读的变化。
                wave=sample[::8];scale=min(190,28/max(.01,float(np.sqrt(np.mean(sample*sample)))))
                points=np.column_stack([np.linspace(430,1476,len(wave)),804+np.clip(wave*scale,-48,48)]).astype(np.int32)
                cv2.polylines(frame,[points],False,(190,214,230),2,cv2.LINE_AA)
                if key=="music_transition":
                    gain=1-.87*min(1,(t-section["start"])/4.8)
                    cv2.line(frame,(430,892),(1476,892),(63,65,65),5,cv2.LINE_AA)
                    cv2.line(frame,(430,892),(round(430+1046*gain),892),(99,176,232),5,cv2.LINE_AA)
            elif key=="lipsync-preview":
                elapsed=t-section["start"];vi=0 if elapsed<3.61 else 1;vt=min(3.35,elapsed) if vi==0 else elapsed-3.61
                video=videos[vi];idx=min(int(video.get(cv2.CAP_PROP_FRAME_COUNT))-1,max(0,int(vt*video.get(cv2.CAP_PROP_FPS))))
                if idx!=video_indices[vi]:
                    if idx!=video_indices[vi]+1:video.set(cv2.CAP_PROP_POS_FRAMES,idx)
                    success,picture=video.read()
                    if not success:raise RuntimeError("口型成品读取失败")
                    video_frames[vi]=picture;video_indices[vi]=idx
                picture=video_frames[vi];frame[:]=(22,24,25)
                h,w=picture.shape[:2];scale=min(1350/w,810/h);size=(round(w*scale),round(h*scale));image=cv2.resize(picture,size,interpolation=cv2.INTER_CUBIC)
                x=(W-size[0])//2;y=130+(810-size[1])//2;frame[y:y+size[1],x:x+size[0]]=image
                caption=next((c for c in captions if c["start"]<=t<c["end"]),None);k=(section["id"],vi)
                if k not in cached:
                    label={**section,"title":"真实生成结果 · "+("视频对口型" if vi==0 else "照片说话")}
                    cached[k]=overlay_regions(layer(label,caption,t))
                for x,y,w,h,inverse,premul in cached[k]:frame[y:y+h,x:x+w]=(frame[y:y+h,x:x+w]*inverse+premul).astype(np.uint8)
            if j!=previous_section:
                transition_from=previous_frame.copy() if previous_frame is not None else None;previous_section=j
            if transition_from is not None and t-section["start"]<.30:
                q=bezier((t-section["start"])/.30);frame=cv2.addWeighted(transition_from,1-q,frame,q,0)
            child.stdin.write(frame.tobytes());previous_frame=frame
            if f%(FPS*30)==0:print("试听与转场",round(t,1),"/",round(timeline["duration"],1),flush=True)
    finally:child.stdin.close()
    if child.wait():raise RuntimeError("试听段渲染失败")
    subprocess.run([str(FF),"-v","info","-y","-i",str(OUT/"film-silent-polished.mp4"),"-i",str(OUT/"master-premix.wav"),"-map","0:v","-map","1:a","-c:v","copy","-af","loudnorm=I=-16:TP=-1.2:LRA=9","-ar","48000","-c:a","aac","-b:a","256k","-shortest","-movflags","+faststart",str(OUT/"JVOX-唐宫小剧场与完整教程-横版.mp4")],stderr=(OUT/"polish-mux.log").open("w"),check=True)
    save("polish-report.json",{"audioVisualization":["music-preview","music_transition","production-preview"],"resultVideoFiles":["exports/唐风视频对口型.mp4","exports/唐风照片说话.mp4"],"transition":"cubic-bezier(.22,1,.36,1)","transitionSeconds":.30})

if __name__=="__main__":main()
