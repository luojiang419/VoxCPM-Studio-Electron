"""绘制薄型机械硬盘透明 PNG：金属盘片、读写臂、螺丝与低矮底座。"""
from pathlib import Path
import math
from PIL import Image, ImageDraw, ImageFilter

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/"assets/brand"
OUT.mkdir(parents=True,exist_ok=True)
S=3
im=Image.new("RGBA",(512*S,512*S))
shadow=Image.new("RGBA",im.size)
ImageDraw.Draw(shadow).ellipse((100*S,300*S,455*S,371*S),fill=(24,38,33,48))
im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14*S)))
draw=ImageDraw.Draw(im)

def xy(u,v,z=0):
    return ((80+244*u+124*v)*S,(177-81*u+135*v+z)*S)

def polygon(points,fill):
    draw.polygon(points,fill=fill)

def localpoly(points,fill,z=0):
    polygon([xy(u,v,z) for u,v in points],fill)

def line(points,fill,width=1):
    draw.line(points,fill=fill,width=round(width*S),joint="curve")

def ring(u,v,r,fill,width=1):
    pts=[xy(u+r*math.cos(i*math.pi/90),v+r*math.sin(i*math.pi/90)) for i in range(181)]
    if width==0: polygon(pts,fill)
    else: line(pts,fill,width)

outline=[(.05,0),(.95,0),(1,.05),(1,.95),(.95,1),(.05,1),(0,.95),(0,.05)]
# 薄型深色底座，厚度仅 24 px，前沿保留金属倒角。
localpoly(outline,"#293c3b",26)
localpoly([(0,.95),(.05,1),(.95,1),(1,.95),(1,.7),(0,.7)],"#647675",24)
localpoly(outline,"#c3ccc9")
localpoly([(.07,.055),(.93,.055),(.95,.08),(.95,.92),(.92,.95),(.08,.95),(.05,.92),(.05,.08)],"#e8eae5")
# 深灰圆形凹槽和真实金属盘片，细密同心纹理强化磁盘辨识度。
ring(.45,.48,.395,"#6f827d",0)
ring(.45,.48,.372,"#b5bfbc",0)
for i in range(80,0,-1):
    r=.36*i/80
    grey=182+int(38*(1-i/80))+int(12*math.sin(i*.21))
    ring(.45,.48,r,(grey,min(255,grey+5),min(255,grey+3),255),0)
for i in range(8): ring(.45,.48,.19+i*.021,"#e0e5df",.55)
ring(.45,.48,.357,"#f8faf4",1.7)
ring(.45,.48,.105,"#778b83",0)
ring(.45,.48,.079,"#e9ece4",0)
ring(.45,.48,.041,"#738a7d",0)
ring(.45,.48,.021,"#273d34",0)
# 读写臂支座与狭长金属臂，朝盘片内侧伸出。
ring(.82,.80,.12,"#6d8177",0)
ring(.82,.80,.092,"#c6d0c7",0)
localpoly([(.88,.80),(.77,.84),(.44,.48),(.47,.43)],"#788a80")
localpoly([(.85,.77),(.78,.79),(.46,.46),(.48,.435)],"#f3f4e9")
localpoly([(.445,.48),(.40,.43),(.445,.405),(.48,.44)],"#b58c5f")
ring(.82,.80,.038,"#627e6c",0)
# 四角紧固件、底边通风切口、铜色接触片与柔和绿色状态灯。
for u,v in ((.075,.075),(.925,.075),(.925,.925),(.075,.925)):
    ring(u,v,.024,"#8b9d93",0)
    line([xy(u-.009,v-.006),xy(u+.009,v+.006)],"#f4f5eb",1)
line([xy(.06,1,7),xy(.94,1,7)],"#eef0e9",1.5)
for i in range(4):
    u=.30+i*.12
    line([xy(u,1,17),xy(u+.06,1,17)],"#273d35",2)
for i in range(5):
    u=.62+i*.045
    line([xy(u,0,8),xy(u+.025,0,8)],"#b9a479",2.5)
light=xy(.90,1,16)
x,y=light
draw.ellipse((x-4*S,y-2*S,x+4*S,y+2*S),fill="#a8d39c")
im=im.resize((512,512),Image.Resampling.LANCZOS)
im.save(OUT/"disk-local.png",optimize=True)
im.resize((256,256),Image.Resampling.LANCZOS).save(OUT/"disk-local-256.png",optimize=True)
assert im.mode=="RGBA" and im.getchannel("A").getextrema()==(0,255)
print(OUT/"disk-local.png")
