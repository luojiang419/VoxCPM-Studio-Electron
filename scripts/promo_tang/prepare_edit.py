"""把实录标记转为可复核选段；排除等待、错误输入和中断后缺失的原片。"""
import json
import soundfile as sf
from common import OUT, save

def main():
    roots=sorted(OUT.glob("raw-*"))
    starts=[json.loads((p/"session.json").read_text(encoding="utf-8"))["startedAt"] for p in roots]
    actions=[json.loads(s) for s in (OUT/"native-actions.jsonl").read_text(encoding="utf-8").splitlines()]
    def event(name,kind="chapter"):
        row=next(a for a in actions if a["action"]==kind and a.get("name")==name)
        index=max(j for j,s in enumerate(starts) if s<=row["time"])
        return index,row["time"]-starts[index]-.20
    def span(name,length,offset=0,continuous=False,kind="chapter"):
        i,t=event(name,kind);return [i,max(0,t+offset),t+offset+length]+(["continuous"] if continuous else [])
    video=span("video-result",3.36,.12,True,"preview")
    photo=span("photo-result",2.72,.12,True,"preview")
    solo=span("retake-music-solo",6,.10,True)
    fade=span("retake-music-fade",8.25,0,True)
    project=span("retake-project-preview",8,.62,True)
    recipe={
      "design":[[0,23.0,28.2],[0,107.5,109.5],[0,157.0,159.1]],
      "clone":[[0,192.0,198.0],[0,209.0,215.7],[0,253.0,255.0],[0,269.8,273.5],[0,289.0,294.1],[0,319.0,322.1]],
      "voices":[[0,176.0,191.3],[0,347.0,364.0]],
      "music":[[0,365.6,400.6],[0,460.5,473.2]],
      "music_transition":[fade],
      "production":[[0,573.0,581.1],[0,637.0,659.0],span("retake-redo",2.0),span("retake-redo",2.0,6.0),span("retake-mix",2.2),span("retake-export",9,-7.5)],
      "history":[span("retake-history",2.3),span("retake-music",5.3,-5.4)],
      "control":[[0,718.2,721.2,"continuous"],[0,735.3,738.3,"continuous"],[0,746.6,749.2,"continuous"],[0,765.4,769.7,"continuous"]],
      "lipsync":[span("video-retake-input",11.0),span("video-retake-generate",1.5),[2,50.1,61.1],span("photo-result",.9)],
      "batch":[span("batch",45.6),span("batch-result",1.0)],
      "inserts":{
        "design":{"audio":"emperor-reference.wav","storyScene":1,"title":"试听 · 唐玄宗","role":"唐玄宗","caption":"禄山，今夜鼓声正好。来，为朕再舞一曲！"},
        "clone":{"audio":"clone-comparison.wav","storyScene":3,"title":"试听 · 可控克隆与极致克隆","role":"女乐工","caption":"鼓点再紧些，莫让将军赶上了。愿今夜的灯，长明不灭。"},
        "voices":{"audio":"general-reference.wav","storyScene":2,"title":"试听 · 安禄山","role":"安禄山","caption":"臣愿以此一舞，敬陛下，敬这万里太平。"},
        "music":{"silence":6,"footage":[solo],"title":"试听 · 刚生成的《一曲长安》","caption":"琵琶 · 笛与笙 · 胡鼓｜本项目实际生成"},
        "production":{"audio":"exports/唐宫配音工程.wav","trim":[0,8],"footage":[project],"title":"试听 · 多角色配音工程"},
        "lipsync":{"audio":"lipsync-comparison.wav","footage":[video,photo],"title":"预览 · 视频对口型与照片说话","caption":"鼓点再紧些，莫让将军赶上了。愿今夜的灯，长明不灭。"},
        "batch":{"silence":1.4,"footage":[span("batch-result",1.4,-.2,True)],"title":"三条不同文案 · 全部生成成功"}
      }}
    save("edit-recipes.json",recipe)
    print("实录选段已保存",flush=True)

if __name__=="__main__":main()
