# Builds the macOS-grid app icon source (1024 canvas, 824 squircle, 100px padding)
# from the full-bleed mobile artwork. Regenerate the icon set afterwards with:
#   pnpm tauri icon src-tauri/app-icon.png
import math
from PIL import Image, ImageDraw
import os, sys
HERE=os.path.dirname(os.path.abspath(__file__))
SRC=os.path.join(HERE,'../../mobile/assets/icon.png')
OUT=os.path.join(HERE,'../src-tauri/app-icon.png')
S=4; C=1024*S; A=824*S; off=(C-A)//2
art=Image.open(SRC).convert('RGBA').resize((A,A),Image.LANCZOS)
# superellipse |x|^5+|y|^5=1 approximates Apple's continuous-corner squircle
n=5.0; r=A/2; pts=[]
for i in range(4000):
    t=2*math.pi*i/4000; ct,st=math.cos(t),math.sin(t)
    pts.append((r+r*math.copysign(abs(ct)**(2/n),ct), r+r*math.copysign(abs(st)**(2/n),st)))
mask=Image.new('L',(A,A),0); ImageDraw.Draw(mask).polygon(pts,fill=255)
art.putalpha(mask)
canvas=Image.new('RGBA',(C,C),(0,0,0,0)); canvas.alpha_composite(art,(off,off))
canvas=canvas.resize((1024,1024),Image.LANCZOS)
canvas.save(OUT)
print(canvas.split()[-1].getbbox())
