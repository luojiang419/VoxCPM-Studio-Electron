"""按CTC句界把整段角色录音编排成小剧场，保留各角色音色。"""
import json
import re
import subprocess
import numpy as np
import soundfile as sf
from common import OUT, ROOT, PLAN, save

FF=ROOT.parent/"runtime/ffmpeg/bin/ffmpeg.exe"
SR=48000

def read(name):return json.loads((OUT/name).read_text(encoding="utf-8"))
def clean(s):return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]","",s)

def lines(name,paragraphs):
    d=read(name+"-aligned.json");chars=d["characters"];offset=0;result=[]
    for text in paragraphs:
        n=len(clean(text));a=max(0,chars[offset]["start"]-.075);b=min(d["duration"],chars[offset+n-1]["end"]+.16)
        result.append((name,a,b,text));offset+=n
    return result

def stretch(name,speed):
    dest=OUT/(name+f"-tempo{speed}.wav")
    if not dest.exists():subprocess.run([str(FF),"-v","error","-y","-i",str(OUT/(name+".wav")),"-af",f"atempo={speed}","-ar",str(SR),str(dest)],check=True)
    data,rate=sf.read(dest,dtype="float32");assert rate==SR
    if data.ndim>1:data=data.mean(axis=1)
    rms=np.sqrt(np.mean(data*data));data*=min(2.5,.105/max(.001,rms))
    return data

def main():
    narrator=lines("story_narrator-reference",PLAN["roles"]["story_narrator"]["text"].splitlines())
    emperor=lines("emperor-story",PLAN["roles"]["emperor"]["storyText"].splitlines())
    general=lines("general-story",PLAN["roles"]["general"]["storyText"].splitlines())
    musician=lines("musician-story",PLAN["roles"]["musician"]["storyText"].splitlines())
    extreme=("musician-extreme",0,sf.info(OUT/"musician-extreme.wav").duration,PLAN["roles"]["musician"]["extremeText"])
    scenes=[[("旁白",narrator[0]),("女乐工",musician[0])],
        [("旁白",narrator[1]),("唐玄宗",emperor[0]),("安禄山",general[0]),("唐玄宗",emperor[1])],
        [("旁白",narrator[2]),("女乐工",musician[1]),("安禄山",general[1])],
        [("旁白",narrator[3]),("女乐工",extreme),("女乐工",musician[2])],
        [("旁白",narrator[4])]]
    speeds={"story_narrator-reference":.84,"emperor-story":.94,"general-story":.94,"musician-story":.94,"musician-extreme":.94}
    audio={name:stretch(name,speed) for name,speed in speeds.items()}
    timeline=[];scene_rows=[];parts=[];cursor=0
    for i,scene in enumerate(scenes):
        start=cursor
        lead=.7 if i==0 else .4
        parts.append(np.zeros(round(lead*SR),np.float32));cursor+=lead
        for who,(name,a,b,text) in scene:
            speed=speeds[name];piece=audio[name][round(a/speed*SR):round(b/speed*SR)].copy()
            fade=min(400,len(piece)//3);piece[:fade]*=np.linspace(0,1,fade);piece[-fade:]*=np.linspace(1,0,fade)
            timeline.append({"scene":i,"role":who,"name":name,"start":cursor,"end":cursor+len(piece)/SR,"sourceStart":a,"sourceEnd":b,"speed":speed,"text":text})
            parts.append(piece);cursor+=len(piece)/SR
            gap=.6 if who=="旁白" else .45
            parts.append(np.zeros(round(gap*SR),np.float32));cursor+=gap
        tail=2.8 if i==4 else 1.0
        parts.append(np.zeros(round(tail*SR),np.float32));cursor+=tail
        scene_rows.append({"index":i,"start":start,"end":cursor,"title":["灯火长安","御前邀舞","胡旋疾如风","灯，长明不灭","烽火之前"][i]})
    track=np.concatenate(parts);sf.write(OUT/"story-dialogue.wav",track,SR,subtype="PCM_16")
    captions=[]
    for row in timeline:
        if row["name"]=="musician-extreme":captions.append({"start":row["start"],"end":row["end"],"text":row["text"],"role":row["role"]});continue
        alignment=read(row["name"]+"-aligned.json")
        for cap in alignment["captions"]:
            if row["sourceStart"]-.04<=cap["start"]<row["sourceEnd"]-.08:
                captions.append({"start":max(row["start"],row["start"]+(cap["start"]-row["sourceStart"])/row["speed"]),"end":min(row["end"],row["start"]+(cap["end"]-row["sourceStart"])/row["speed"]),"text":cap["text"],"role":row["role"]})
    save("story-timeline.json",{"duration":len(track)/SR,"scenes":scene_rows,"clips":timeline,"captions":captions})
    print("完整小剧场",round(len(track)/SR,2),"秒",flush=True)

if __name__=="__main__":main()
