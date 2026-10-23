"""本地 SenseVoice CTC 对齐；仅分析已生成的整段声音，不重生成主讲。"""
import os
os.environ.update(HF_HUB_OFFLINE="1",TRANSFORMERS_OFFLINE="1",PYTHONDONTWRITEBYTECODE="1")
import difflib
import json
import re
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import numpy as np
import soundfile as sf
from common import OUT, PLAN, save

def clean(s):return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]","",s)

def align(name,text,model):
    path=OUT/(name+"-ctc.json")
    if path.exists():data=json.loads(path.read_text(encoding="utf-8"))
    else:
        data=model.generate(input=str(OUT/(name+".wav")),language="zh",use_itn=True,output_timestamp=True)[0]
        save(name+"-ctc.json",data)
    chars=[];starts=[];ends=[]
    for word,(a,b) in zip(data["words"],data["timestamp"]):
        w=clean(word)
        for j,c in enumerate(w):
            chars.append(c);starts.append((a+(b-a)*j/len(w))/1000);ends.append((a+(b-a)*(j+1)/len(w))/1000)
    orig=clean(text);match=difflib.SequenceMatcher(None,orig,"".join(chars),autojunk=False)
    mapping={a+j:b+j for a,b,n in match.get_matching_blocks() for j in range(n)}
    ratio=len(mapping)/len(orig)
    if ratio<.85:raise RuntimeError(f"{name}:文本差异过大 {ratio}")
    keys=sorted(mapping);pos=np.interp(np.arange(len(orig)),keys,[mapping[k] for k in keys])
    starts=np.interp(pos,np.arange(len(starts)),starts);ends=np.interp(pos,np.arange(len(ends)),ends)
    duration=sf.info(OUT/(name+".wav")).duration
    phrases=re.findall(r"[^，。！？；：、\n]+[，。！？；：、]?",text)
    captions=[];offset=0
    for phrase in phrases:
        # 合并太短的词，保持字幕可读，最长每行23个中文字符。
        if not clean(phrase):continue
        for chunk in re.findall(r".{1,23}",phrase):
            n=len(clean(chunk))
            if n:
                captions.append({"start":round(max(0,float(starts[offset])-.06),3),"end":round(min(duration,float(ends[offset+n-1])+.13),3),"text":chunk.rstrip('，。；：、')})
                offset+=n
    result={"duration":duration,"match":round(ratio,4),"text":text,"captions":captions,"characters":[{"c":c,"start":round(float(a),3),"end":round(float(b),3)} for c,a,b in zip(orig,starts,ends)]}
    if name=="tutorial-narration":
        offset=0;chapters=[]
        for chapter in PLAN["chapters"]:
            n=len(clean(chapter["text"]));chapters.append({**chapter,"start":round(max(0,float(starts[offset])-.08),3),"end":round(min(duration,float(ends[offset+n-1])+.14),3)});offset+=n
        chapters[0]["start"]=0
        for a,b in zip(chapters,chapters[1:]):a["end"]=b["start"]
        chapters[-1]["end"]=duration
        result["chapters"]=chapters
    save(name+"-aligned.json",result)
    print(name,round(duration,2),"匹配",round(ratio,4),flush=True)

if __name__=="__main__":
    import torch
    from funasr import AutoModel
    torch.set_num_threads(4)
    model=AutoModel(model="D:/Program Files/VoxCPMStudio/models/iic__SenseVoiceSmall",device="cpu",disable_update=True,log_level="ERROR",ncpu=4)
    names=sys.argv[1:] or ["tutorial-narration"]
    for name in names:
        if name=="tutorial-narration":text="\n".join(c["text"] for c in PLAN["chapters"])
        else:text=json.loads((OUT/(name+"-request.json")).read_text(encoding="utf-8"))["text"]
        align(name,text,model)
