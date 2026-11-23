"""唐宫横版成片：真实操作去等待、Bezier鼠标镜头、整段主讲与角色互动。"""
import argparse
import bisect
import json
import math
from pathlib import Path
import subprocess
import sys
import time
import cv2
import numpy as np
import soundfile as sf
from PIL import Image, ImageDraw, ImageFont
from common import OUT, ROOT, PLAN, save
from story_audio import stretch
sys.path.insert(0,str(ROOT/"scripts"))
import promo_edit as base
base.OUT=OUT
FF=ROOT.parent/"runtime/ffmpeg/bin/ffmpeg.exe"
W,H,FPS,SR=1920,1080,60,48000
FONT="C:/Windows/Fonts/msyh.ttc";BOLD="C:/Windows/Fonts/msyhbd.ttc"
cv2.setNumThreads(4)

def read(name):return json.loads((OUT/name).read_text(encoding="utf-8"))

def overlay_regions(overlay):
    result=[]
    for left,top,right,bottom in [(0,0,850,80),(850,0,W,80),(0,80,W,155),(0,925,W,H)]:
        mask=overlay[top:bottom,left:right,3]
        x,y,w,h=cv2.boundingRect(mask)
        if not w or not h:continue
        x+=left;y+=top
        alpha=overlay[y:y+h,x:x+w,3:4].astype(np.float32)/255
        premul=overlay[y:y+h,x:x+w,:3][:,:,::-1].astype(np.float32)*alpha
        result.append((x,y,w,h,1-alpha,premul))
    return result

def blur_camera(source,camera,delta):
    frames=[]
    for k in [0,.25,.5]:
        cx,cy,width,height=camera-delta*k
        cx=np.clip(cx,width/2,W-width/2);cy=np.clip(cy,height/2,H-height/2)
        m=np.array([[W/width,0,W/2-cx*W/width],[0,H/height,H/2-cy*H/height]],np.float32)
        frames.append(cv2.warpAffine(source,m,(W,H),flags=cv2.INTER_LINEAR,borderMode=cv2.BORDER_REPLICATE))
    return cv2.addWeighted(cv2.addWeighted(frames[0],.5,frames[1],.5,0),2/3,frames[2],1/3,0)

def load_recordings():
    actions=[json.loads(line) for line in (OUT/"native-actions.jsonl").read_text(encoding="utf-8").splitlines()]
    return [base.Recording(p,actions) for p in sorted(OUT.glob("raw-*"))]

def audio(path):
    a,sr=sf.read(path,dtype="float32",always_2d=True);assert sr==SR
    return a if a.shape[1]==2 else np.repeat(a[:,:1],2,axis=1)

def source_timeline(recipes,recordings,duration,chapter):
    keep=[]
    for row in recipes:
        r=recordings[row[0]];a,b=row[1:3]
        assert 0<=a<b<=len(r.pts)/60+.1,(r.root.name,a,b,len(r.pts)/60)
        spans=r.keep(a,b) if len(row)<4 or row[3]!="continuous" else [[a,b]]
        # 原生文件选择框会短暂露出任务栏；保留点击和选中后的状态，剪掉对话框。
        dialogs=[]
        for k,action in enumerate(r.actions):
            if action["action"]=="key" and action.get("keys")==["alt","n"]:
                previous=next((x for x in reversed(r.actions[:k]) if x["action"]=="click"),None)
                enter=next((x for x in r.actions[k+1:] if x["action"]=="key" and x.get("keys")==["enter"]),None)
                if previous and enter:dialogs.append([previous["t"]+.06,enter["t"]+.7])
        for da,db in dialogs:
            spans=[piece for lo,hi in spans for piece in ([[lo,hi]] if db<=lo or da>=hi else [[lo,min(hi,da)],[max(lo,db),hi]]) if piece[1]-piece[0]>.12]
        keep.extend((row[0],a,b) for a,b in spans)
    total=sum(b-a for _,a,b in keep)
    if not total:raise RuntimeError("没有可用真实录屏片段："+chapter)
    cursor=0;result=[]
    for index,a,b in keep:
        d=(b-a)/total*duration
        result.append({"start":cursor,"end":cursor+d,"recording":index,"in":a,"out":b,"chapter":chapter,"kind":"ui"});cursor+=d
    return result

def build():
    recipe=read("edit-recipes.json");aligned=read("tutorial-narration-aligned.json");story=read("story-timeline.json")
    recordings=load_recordings();voice=stretch("tutorial-narration",.92)
    # 主讲只在自然章节边界留出试听，音频始终来自唯一一次完整生成。
    chunks=[np.zeros((10*SR,2),np.float32)];cursor=10.;shots=[];caps=[];sections=[]
    def visual(rows,duration,chapter):
        nonlocal cursor
        pieces=source_timeline(rows,recordings,duration,chapter)
        for piece in pieces:shots.append({**piece,"start":piece["start"]+cursor,"end":piece["end"]+cursor})
    for chapter in aligned["chapters"]:
        a=round(chapter["start"]/.92*SR);b=round(chapter["end"]/.92*SR)
        if chapter==aligned["chapters"][-1]:b=len(voice)
        piece=np.repeat(voice[a:b,None],2,axis=1);duration=len(piece)/SR
        start=cursor;visual(recipe[chapter["id"]],duration,chapter["id"])
        chunks.append(piece)
        for cap in aligned["captions"]:
            if chapter["start"]-.001<=cap["start"]<chapter["end"]-.001:
                caps.append({"start":start+(cap["start"]-chapter["start"])/.92,"end":min(start+duration,start+(cap["end"]-chapter["start"])/.92),"text":cap["text"]})
        sections.append({"start":start,"end":start+duration,"id":chapter["id"],"title":chapter["title"]});cursor+=duration
        insert=recipe.get("inserts",{}).get(chapter["id"])
        if insert:
            if insert.get("silence"):data=np.zeros((round(insert["silence"]*SR),2),np.float32)
            else:
                data=audio(OUT/insert["audio"])
                if insert.get("trim"):data=data[round(insert["trim"][0]*SR):round(insert["trim"][1]*SR)]
                rms=np.sqrt(np.mean(data*data));data*=min(3,.105/max(.001,rms))
            duration=len(data)/SR;start=cursor
            if insert.get("storyScene") is not None:
                shots.append({"kind":"art","scene":insert["storyScene"],"in":7.0,"start":start,"end":start+duration,"chapter":chapter["id"]})
            else:visual(insert["footage"],duration,chapter["id"])
            chunks.append(data)
            if insert.get("caption"):caps.append({"start":start+.05,"end":start+duration-.08,"text":insert["caption"],"role":insert.get("role","")})
            sections.append({"start":start,"end":start+duration,"id":chapter["id"]+"-preview","title":insert["title"]});cursor+=duration
    story_start=cursor
    dialogue=audio(OUT/"story-dialogue.wav");chunks.append(dialogue)
    for scene in story["scenes"]:shots.append({"kind":"art","scene":scene["index"],"in":0,"start":story_start+scene["start"],"end":story_start+scene["end"],"chapter":"story"})
    for cap in story["captions"]:caps.append({**cap,"start":cap["start"]+story_start,"end":cap["end"]+story_start})
    sections.append({"start":story_start,"end":story_start+story["duration"],"id":"story","title":PLAN["title"]})
    cursor+=story["duration"]
    # 10秒钩子：从小剧场真实音色与胡旋画面提炼，不添加静止片头。
    preview=np.zeros((10*SR,2),np.float32)
    opening=[next(c for c in story["clips"] if c["role"]=="唐玄宗"),next(c for c in story["clips"] if c["role"]=="安禄山")]
    op=.2
    for row in opening:
        clip=dialogue[round(row["start"]*SR):round(row["end"]*SR)];end=min(10*SR,round(op*SR)+len(clip));preview[round(op*SR):end]+=clip[:end-round(op*SR)]
        caps.append({"start":op,"end":end/SR,"text":row["text"],"role":row["role"]});op=end/SR+.28
    chunks[0]=preview
    shots[:0]=[{"kind":"art","scene":2,"in":.45,"start":0,"end":3.5,"chapter":"opening"},{"kind":"art","scene":2,"in":7.0,"start":3.5,"end":10,"chapter":"opening"}]
    sections.insert(0,{"start":0,"end":10,"id":"opening","title":PLAN["title"]})
    final=np.concatenate(chunks);music=audio(OUT/"一曲长安.wav")
    music_rms=np.sqrt(np.mean(music*music));music*=.09/max(.001,music_rms)
    def bed(start,end,foreground=False,fade_to=None):
        i0=round(start*SR);i1=min(len(final),round(end*SR));n=i1-i0;t=np.arange(n)/SR
        # 重叠式循环，避免75秒接缝产生突变。
        period=len(music)-SR;idx=np.arange(n)%period;loop=music[idx].copy();join=idx<SR
        q=idx[join,None]/SR;loop[join]=music[idx[join]+period]*(1-q)+loop[join]*q
        level=np.full(n,.22 if foreground else .13)
        if foreground:level[:]=1
        if fade_to is not None:level=1-(1-fade_to)*np.minimum(1,t/4.8)
        level*=np.minimum(1,t/.35)*np.minimum(1,(n/SR-t)/1.2)
        final[i0:i1]+=loop*level[:,None]
    bed(0,10,foreground=True)
    music_preview=next(s for s in sections if s["id"]=="music-preview")
    bed(music_preview["start"],music_preview["end"],foreground=True)
    bed(music_preview["end"],story_start,fade_to=.13)
    bed(story_start,cursor,foreground=False)
    # 故事中给音乐更开阔的空间，旁白期间自动压低。
    st=round(story_start*SR);en=len(final)
    music_idx=np.arange(en-st)%len(music);gain=np.full(en-st,.40)
    for row in story["clips"]:
        a=max(0,round((row["start"]-.2)*SR));b=min(len(gain),round((row["end"]+.3)*SR));gain[a:b]=.18
    # 包络用低通平滑，避免边界突变，计算量与音频长度线性相关。
    from scipy.ndimage import uniform_filter1d
    gain=uniform_filter1d(gain,size=9601)
    gain*=np.minimum(1,np.arange(len(gain))/SR/.5)*np.minimum(1,(len(gain)-np.arange(len(gain)))/SR/3)
    final[st:en]+=music[music_idx]*gain[:,None]
    # 保存未响度归一的母带，最终mux时统一LUFS与真峰值。
    peak=float(np.max(np.abs(final)));premix_gain=min(1.,.92/max(.001,peak))
    final*=premix_gain
    sf.write(OUT/"master-premix.wav",final,SR,subtype="PCM_24")
    save("premix-levels.json",{"originalPeak":peak,"linearGain":premix_gain,"peakAfter":float(np.max(np.abs(final))),"clippedSamples":int((np.abs(final)>=.9999).sum())})
    caps.sort(key=lambda c:c["start"])
    save("edit-timeline.json",{"duration":len(final)/SR,"storyStart":story_start,"shots":shots,"sections":sections,"captions":caps,"sourceMinutes":sum(len(r.pts)/60 for r in recordings)/60,"mainNarrationGeneration":"ec2e3de45d674a5aa0e83110de9908a4","narrationTempo":.92})
    print("时间线",round(len(final)/SR,2),"秒；故事从",round(story_start,2),"秒开始",flush=True)
    return recordings

def layer(section,caption,t):
    im=Image.new("RGBA",(W,H));d=ImageDraw.Draw(im)
    font=ImageFont.truetype(BOLD,24);small=ImageFont.truetype(FONT,20)
    d.rounded_rectangle((26,25,243,74),12,fill=(22,23,22,222));d.text((43,33),"JVOX STUDIO",font=font,fill="#efbd82")
    title=section["title"];tf=ImageFont.truetype(BOLD,27);tw=tf.getlength(title)
    d.rounded_rectangle((W-tw-82,25,W-28,74),12,fill=(22,23,22,222));d.text((W-tw-55,31),title,font=tf,fill="#fff7e9")
    if section["id"] in ["opening","story"]:
        text="声音／音乐：本项目生成 · 手绘画面另行制作" if section["id"]=="opening" else "史事演绎｜人物对白为创作"
        d.text((31,86),text,font=small,fill="#f7e7cb",stroke_width=1,stroke_fill=(25,22,18,220))
        if section["id"]=="story" and t>section["end"]-4:
            d.text((31,118),"史料：《新唐书·安禄山传》｜755年，安史之乱爆发",font=small,fill="#f7e7cb",stroke_width=1,stroke_fill=(25,22,18,220))
    if caption:
        text=caption["text"];f=ImageFont.truetype(BOLD,38);lines=base.wrapped(text,f,1430)
        role=caption.get("role","");y=1003-(len(lines)-1)*48
        if role:
            rf=ImageFont.truetype(BOLD,22);rw=rf.getlength(role)+30
            d.rounded_rectangle((W/2-rw/2,y-46,W/2+rw/2,y-14),8,fill=(138,80,29,238));d.text((W/2-rw/2+15,y-45),role,font=rf,fill="#fff4df")
        width=max(f.getlength(s) for s in lines)+54
        d.rounded_rectangle((W/2-width/2,y-9,W/2+width/2,y+len(lines)*48+7),16,fill=(22,22,21,229))
        for j,s in enumerate(lines):d.text((W/2-f.getlength(s)/2,y+j*48),s,font=f,fill="white")
    return np.array(im)

def render(recordings=None,proof=False):
    recordings=recordings or load_recordings();data=read("edit-timeline.json")
    art=[cv2.VideoCapture(str(OUT/"handdraw"/f"scene-{j+1:02}.mp4")) for j in range(5)];art_pos=[-1]*5;art_frame=[None]*5
    def frame_art(shot,t):
        j=shot["scene"];f=min(int(art[j].get(cv2.CAP_PROP_FRAME_COUNT))-1,max(0,round((shot["in"]+t-shot["start"])*30)))
        if f!=art_pos[j]:
            if f<art_pos[j] or f>art_pos[j]+3:art[j].set(cv2.CAP_PROP_POS_FRAMES,f);art_pos[j]=f-1
            while art_pos[j]<f:
                ok,image=art[j].read()
                if not ok:raise RuntimeError("手绘镜头读取失败")
                art_frame[j]=image;art_pos[j]+=1
        return art_frame[j].copy()
    ends=[s["end"] for s in data["shots"]];sections=data["sections"];sends=[s["end"] for s in sections]
    caps=data["captions"];cached={};camera=None;old_camera=None;old_shot=-1;transition=0
    log=(OUT/("proof-render.log" if proof else "render.log")).open("w")
    indices=list(range(math.ceil(data["duration"]*FPS))) if not proof else [round(t*FPS) for t in np.arange(4,data["duration"],9)]
    process=None
    if not proof:process=subprocess.Popen([str(FF),"-v","warning","-y","-f","rawvideo","-pix_fmt","bgr24","-s",f"{W}x{H}","-r",str(FPS),"-i","pipe:0","-an","-c:v","h264_nvenc","-preset","p5","-cq","17","-pix_fmt","yuv420p","-movflags","+faststart",str(OUT/"film-silent.mp4")],stdin=subprocess.PIPE,stderr=log)
    proof_frames=[];began=time.monotonic()
    try:
        for index in indices:
            t=index/FPS;si=min(len(ends)-1,bisect.bisect_right(ends,t));shot=data["shots"][si]
            section=sections[min(len(sections)-1,bisect.bisect_right(sends,t))]
            if shot["kind"]=="art":scene=frame_art(shot,t);camera=None
            else:
                r=recordings[shot["recording"]];q=(t-shot["start"])/(shot["end"]-shot["start"]);source_t=shot["in"]+(shot["out"]-shot["in"])*q
                source=r.image(source_t);pointer=r.cursor(source_t)
                target=base.camera_window(pointer,False,shot["chapter"],q)
                if shot["chapter"]=="lipsync":target=np.array([1020,580,1600,900.])
                if camera is None:camera=target.copy();old_camera=camera.copy()
                if si!=old_shot:old_camera=camera.copy();old_shot=si;transition=t
                progress=base.bezier((t-transition)/.65);desired=old_camera*(1-progress)+target*progress
                next_camera=camera+(desired-camera)*(1-math.exp(-1/(FPS*.16)));delta=next_camera-camera;camera=next_camera
                if np.linalg.norm(delta[:2])*W/camera[2]>.9 and not proof:
                    scene=blur_camera(source,camera,delta)
                else:scene=base.warp(source,camera,(W,H))
                px=(pointer[0]-camera[0])*W/camera[2]+W/2;py=(pointer[1]-camera[1])*H/camera[3]+H/2
                if 0<=px<W and 0<=py<H:
                    cursor=np.array([[px,py],[px+2,py+24],[px+8,py+18],[px+14,py+29],[px+20,py+26],[px+14,py+15],[px+24,py+14]],np.int32)
                    cv2.fillPoly(scene,[cursor],(255,255,255),cv2.LINE_AA);cv2.polylines(scene,[cursor],True,(25,25,25),2,cv2.LINE_AA)
            caption=next((c for c in caps if c["start"]<=t<c["end"]),None)
            key=(section["id"],caption.get("text","") if caption else "",caption.get("role","") if caption else "",bool(section["id"]=="story" and t>section["end"]-4))
            if key not in cached:cached[key]=overlay_regions(layer(section,caption,t))
            for x,y,w,h,inverse,premul in cached[key]:
                scene[y:y+h,x:x+w]=(scene[y:y+h,x:x+w]*inverse+premul).astype(np.uint8)
            if proof:proof_frames.append((t,scene))
            else:
                process.stdin.write(scene.tobytes())
                if index%(FPS*10)==0:print("合成",round(t,1),"/",round(data["duration"],1),"耗时",round(time.monotonic()-began),flush=True)
    finally:
        if process:process.stdin.close()
    if process and process.wait():raise RuntimeError("成片渲染失败")
    if proof:
        sheet=Image.new("RGB",(1920,math.ceil(len(proof_frames)/3)*384),(32,31,29));d=ImageDraw.Draw(sheet);font=ImageFont.truetype(FONT,20)
        for j,(t,frame) in enumerate(proof_frames):
            x=j%3*640;y=j//3*384;sheet.paste(Image.fromarray(cv2.cvtColor(frame,cv2.COLOR_BGR2RGB)).resize((640,360)),(x,y));d.text((x+12,y+360),f"{t:.1f}s",font=font,fill="white")
        sheet.save(OUT/"film-proof.jpg",quality=94)
    else:
        subprocess.run([str(FF),"-v","info","-y","-i",str(OUT/"film-silent.mp4"),"-i",str(OUT/"master-premix.wav"),"-map","0:v","-map","1:a","-c:v","copy","-af","loudnorm=I=-16:TP=-1:LRA=9","-ar","48000","-c:a","aac","-b:a","256k","-shortest","-movflags","+faststart",str(OUT/"JVOX-唐宫小剧场与完整教程-横版.mp4")],stderr=(OUT/"mux.log").open("w"),check=True)

if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--proof",action="store_true");p.add_argument("--rebuild",action="store_true");a=p.parse_args()
    recordings=build() if a.rebuild or not (OUT/"edit-timeline.json").exists() else None
    render(recordings,a.proof)
