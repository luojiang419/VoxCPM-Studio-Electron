"""只读调用引用任务的逐笔勾线/添色引擎，新增唐宫局部对象运动与分镜。

外部工作区不修改、不复制进本仓库；绘图资产已另存本任务images目录。
"""
import argparse
import json
import math
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from common import OUT, ROOT, save

SOURCE=Path("D:/data/codex/2026-10-23/https-github-com-geeklee-srt-whiteboard")
sys.path.insert(0,str(SOURCE/"work/leopard-v3"))
import handdraw_motion as wb

W,H,FPS=1920,1080,30
FF=ROOT.parent/"runtime/ffmpeg/bin/ffmpeg.exe"
PAPER=(245,235,219)
IMAGES=[]
YY,XX=np.mgrid[0:H,0:W].astype(np.float32)

def soft(cx,cy,sx,sy):return np.exp(-((XX-cx)/sx)**4-((YY-cy)/sy)**4).astype(np.float32)

def initialize():
    global IMAGES,MASKS
    for name in ["changan.png","emperor-scene.png","banquet.png","quiet-scene.png","changan.png"]:
        data=np.array(Image.open(OUT/"images"/name).convert("RGB").resize((W,H),Image.Resampling.LANCZOS))
        IMAGES.append(data)
    MASKS={"dancer":soft(1000,650,440,360),"lanterns":soft(1070,150,720,200),"musician":soft(1690,700,225,280),"water":soft(1210,944,640,130),"curtain":soft(1540,410,330,400)}
    wb.W=W;wb.H=H;wb.START=.2;wb.INK_END=4.1;wb.DRAW_END=6.1;wb.REFS=[0]*5
    wb.motion=SimpleNamespace(SHOTS=[lambda t,d,i=i:motion(i,t) for i in range(5)],BGS=[np.full((H,W,3),PAPER,np.uint8) for _ in range(5)])
    wb.headers=lambda *args:None
    image,mask=wb.sr._load_hand(SOURCE/"work/source/assets/drawing-hand.png",320)
    wb.HAND=wb.sr.TipOverlay(cv2.cvtColor(image,cv2.COLOR_BGR2RGB),mask,tip_anchor_x=0,tip_anchor_y=0)

def motion(index,t):
    im=IMAGES[index]
    dx=np.zeros((H,W),np.float32);dy=dx.copy()
    if index==2:
        # 舞袖随鼓点摆动；脸上权重很低，避免五官被拉扯。
        mask=MASKS["dancer"]*np.clip((YY-320)/230,0,1)
        dx+=mask*(10*np.sin(YY/130+t*3.6)+4*np.sin(t*1.2))
        dy+=mask*4*np.sin(XX/180+t*3.6)
        dy+=MASKS["musician"]*1.8*np.sin(t*4.2)
    elif index==1:
        dx+=soft(1420,760,280,250)*3*np.sin(YY/190+t*1.2)
        dy+=soft(400,760,250,230)*1.8*np.sin(t*1.5)
    elif index==3:
        dx+=MASKS["curtain"]*5*np.sin(YY/240+t*.8)
    else:
        dx+=MASKS["water"]*3.5*np.sin(YY/24+t*1.4)
        dy+=soft(1550,320,360,180)*1.6*np.sin(t*.5)
    # 悬灯轻摆贯穿宴会，绘制完成后仍有局部运动。
    if index in [1,2,3]:dx+=MASKS["lanterns"]*3.0*np.sin(t*.75+YY/190)
    frame=cv2.remap(im,XX+dx,YY+dy,cv2.INTER_LINEAR,borderMode=cv2.BORDER_REFLECT101)
    if index==4:
        # 最后一幕由暖金缓缓收束为冷灰，仍能看清灯火。
        q=min(1,max(0,(t-1)/11))*.38
        gray=cv2.cvtColor(frame,cv2.COLOR_RGB2GRAY)[:,:,None]
        frame=np.clip(frame.astype(float)*(1-q)+gray*q,0,255).astype(np.uint8)
    return frame

def render(proof=False):
    initialize();timeline=json.loads((OUT/"story-timeline.json").read_text(encoding="utf-8"))
    folder=OUT/"handdraw";folder.mkdir(exist_ok=True)
    metrics=[]
    for scene in timeline["scenes"]:
        i=scene["index"];duration=scene["end"]-scene["start"]
        dest=folder/f"scene-{i+1:02}.mp4"
        if dest.exists() and not proof:print("复用手绘镜头",i+1,flush=True);continue
        drawing=wb.Drawing(i)
        marks=[.8,2.5,4.8,6.0,7.4,min(duration-.15,10.0)]
        samples=[]
        if proof:
            for t in marks:samples.append(drawing.frame(t))
        else:
            child=subprocess.Popen([str(FF),"-v","warning","-y","-f","rawvideo","-pix_fmt","rgb24","-s",f"{W}x{H}","-r",str(FPS),"-i","pipe:0","-an","-c:v","h264_nvenc","-preset","p4","-cq","17","-pix_fmt","yuv420p","-movflags","+faststart",str(dest)],stdin=subprocess.PIPE,stderr=(folder/f"scene-{i+1:02}.log").open("w"))
            try:
                for f in range(math.ceil(duration*FPS)):
                    frame=drawing.frame(f/FPS)
                    if f in [round(t*FPS) for t in marks]:samples.append(frame.copy())
                    child.stdin.write(frame.tobytes())
            finally:child.stdin.close()
            if child.wait():raise RuntimeError("手绘编码失败")
        sheet=Image.new("RGB",(1920,768),PAPER);draw=ImageDraw.Draw(sheet);font=ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf",20)
        for j,(frame,t) in enumerate(zip(samples,marks)):
            x=j%3*640;y=j//3*384;sheet.paste(Image.fromarray(frame).resize((640,360)),(x,y));draw.text((x+10,y+360),f"{t:.1f}s",font=font,fill=(65,50,35))
        sheet.save(folder/f"scene-{i+1:02}-proof.jpg",quality=94)
        delta=float(np.abs(motion(i,7).astype(np.int16)-motion(i,9).astype(np.int16)).mean())
        metrics.append({"scene":i+1,"seconds":duration,"handUntil":6.1,"inkCells":len(drawing.cells),"objectMotionDifference":delta})
        print("手绘镜头完成",i+1,round(duration,2),round(delta,3),flush=True)
    save("handdraw/metrics.json",metrics)

if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--proof",action="store_true");render(p.parse_args().proof)
