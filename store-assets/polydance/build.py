#!/usr/bin/env python3
"""Polydance store artwork. Original illustrated cover art, NOT application screenshots.
Python3 + Pillow 10.0.1; macOS Avenir Next fonts (not redistributed). All geometry is procedural;
only the existing app's dancer alpha is reused. No recordings, network, tokens or private data.
The icon, the spatial pair and the logo's tile are the app icon every platform has, drawn by design/icons.py
(the Mac's dock icon's style, Robin, 2026-11-11); this file imports it rather than drawing an icon of its own.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import hashlib
import importlib.util
import json
import math
import sys

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'upload'
FONT = '/System/Library/Fonts/Avenir Next.ttc'
COND = '/System/Library/Fonts/Avenir Next Condensed.ttc'
INK = '#201c1a'
CREAM = '#efe6d2'
AMBER = '#efa830'
# The logo's colour, design/tokens.json colors.logo (the deck's orange since 2026-11-11; design/logo.py runs this).
LOGO = json.loads((ROOT.parent.parent / 'design' / 'tokens.json').read_text())['colors']['logo'].lower()
MARK = ROOT / 'source' / 'polydance-mark.png'
sys.dont_write_bytecode = True  # no __pycache__ beside design/icons.py
_spec = importlib.util.spec_from_file_location('icons', ROOT.parent.parent / 'design' / 'icons.py')
icons = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(icons)


def font(size, bold=False, condensed=False):
    return ImageFont.truetype(COND if condensed else FONT, max(1, int(size)), index=0 if bold else 7)


def text(im, xy, value, size, fill=CREAM, bold=False, anchor='lt', condensed=False):
    ImageDraw.Draw(im).text(xy, value, font=font(size, bold, condensed), fill=fill, anchor=anchor)


def fit_text(im, value, box, size, fill=CREAM, bold=True):
    x, y, w, h = box
    while ImageDraw.Draw(im).textlength(value, font=font(size, bold)) > w:
        size -= 1
    text(im, (x + w / 2, y + h / 2), value, size, fill, bold, 'mm')


def background(w, h):
    # Gentle warm vignette rather than a flat black tile; RGB output has no alpha.
    small = Image.new('RGB', (240, 160))
    p = small.load()
    for y in range(160):
        for x in range(240):
            glow = max(0, 1 - math.hypot((x-115)/190, (y-75)/145))
            p[x, y] = (int(23+22*glow), int(21+17*glow), int(20+12*glow))
    return small.resize((w, h), Image.Resampling.BICUBIC)


def dancer(size, color=INK):
    alpha = Image.open(MARK).convert('RGBA').getchannel('A')
    alpha = alpha.resize((size, size), Image.Resampling.LANCZOS)
    image = Image.new('RGBA', (size, size), color)
    image.putalpha(alpha)
    return image


def deck():
    """Illustrated recorder in the app's materials/colors. Not a rendered Android screen."""
    im = Image.new('RGBA', (1800, 1160))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((22,28,1778,1135),48,fill='#171410',outline='#746047',width=4)
    d.rounded_rectangle((30,30,1770,1110),42,fill='#ae8455')
    for y in range(40,1100,10):
        # Subdued grain, deterministic and restrained.
        d.line([(40,y),(500,y+3),(1200,y-2),(1760,y+1)],fill='#b98f5e',width=2)
    d.rounded_rectangle((82,68,1718,1052),28,fill='#27231e',outline='#15120f',width=5)
    # Brushed upper faceplate.
    for y in range(95,755):
        t=(y-95)/660
        c=tuple(round(a+(b-a)*t) for a,b in zip((231,223,203),(196,184,156)))
        d.line((109,y,1691,y),fill=c)
    d.line((109,755,1691,755),fill='#867553',width=4)
    for x in (128,1672):
        for y in (119,729,1010):
            d.ellipse((x-10,y-10,x+10,y+10),fill='#aaa08b',outline='#4c4132',width=2)
            d.line((x-6,y+4,x+6,y-4),fill='#4c4132',width=2)
    # Tape joins the two reels around the head block.
    d.line([(500,390),(420,670),(700,692),(1100,692),(1380,670),(1300,390)],fill='#50362a',width=12)
    d.rounded_rectangle((740,641,1060,725),10,fill='#39332a',outline='#7c725f',width=3)
    for x in (722,1078):
        d.ellipse((x-20,673,x+20,713),fill='#d6cbb4',outline='#41382c',width=5)
    for cx,cy,r,mark in ((502,397,255,False),(1298,397,255,True)):
        d.ellipse((cx-r+4,cy-r+14,cx+r+4,cy+r+14),fill='#7e705b')
        d.ellipse((cx-r,cy-r,cx+r,cy+r),fill='#d6cbb6',outline='#f6efdf',width=5)
        d.ellipse((cx-r*.86,cy-r*.86,cx+r*.86,cy+r*.86),fill='#4d3729')
        for rr in range(140,213,9):
            d.ellipse((cx-rr,cy-rr,cx+rr,cy+rr),outline='#684c37',width=2)
        for i in range(3):
            a=math.radians(120*i-90)
            x=cx+185*math.cos(a);y=cy+185*math.sin(a)
            d.ellipse((x-36,y-36,x+36,y+36),fill='#c5bca7',outline='#92836b',width=3)
        d.ellipse((cx-108,cy-108,cx+108,cy+108),fill=LOGO if mark else '#e87336',outline='#ad442d',width=3)
        if mark:
            image=dancer(174)
            im.alpha_composite(image,(cx-87,cy-87))
        else:
            d.ellipse((cx-30,cy-30,cx+30,cy+30),fill=INK)
            for i in range(3):
                a=math.radians(i*120)
                d.line((cx,cy,cx+24*math.cos(a),cy+24*math.sin(a)),fill=CREAM,width=5)
    text(im,(900,124),'POLYDANCE',29,INK,True,'mm',True)
    # Lower faceplate: two amber VU meters and a red record key.
    for x in (166,556):
        d.rounded_rectangle((x,803,x+322,981),12,fill='#100f0c',outline='#6a5f4c',width=3)
        d.rounded_rectangle((x+14,817,x+308,965),5,fill='#d8b865')
        d.arc((x+40,845,x+282,1065),203,337,fill='#413122',width=3)
        for i in range(13):
            a=math.radians(206+i*10.5)
            x1=x+161+117*math.cos(a);y1=960+105*math.sin(a)
            x2=x+161+102*math.cos(a);y2=960+92*math.sin(a)
            d.line((x1,y1,x2,y2),fill='#9c3327' if i>9 else '#413122',width=3)
        d.line((x+161,960,x+110,855),fill='#a0332b',width=5)
        text(im,(x+161,942),'VU',19,INK,True,'mm')
    d.rounded_rectangle((966,811,1228,950),12,fill='#141310',outline='#5a5143',width=3)
    text(im,(1097,881),'00:00',54,CREAM,False,'mm')
    d.ellipse((1287,805,1303,821),fill='#de4b3b')
    text(im,(1320,805),'REC',20,CREAM,True)
    d.rounded_rectangle((1280,856,1565,982),14,fill='#8d2d22')
    d.rounded_rectangle((1280,848,1565,966),14,fill='#cc4432',outline='#e4775e',width=2)
    d.ellipse((1396,880,1448,932),fill=CREAM)
    text(im,(1540,1004),'MIC  /  APP',17,'#baa889',False,'rt')
    return im


def paste_deck(im, width, center_x, top, art):
    height=round(width*art.height/art.width)
    img=art.resize((width,height),Image.Resampling.LANCZOS)
    x=round(center_x-width/2)
    shadow=Image.new('RGBA',im.size)
    sd=ImageDraw.Draw(shadow)
    sd.rounded_rectangle((x+10,top+25,x+width-10,top+height+12),40,fill=(0,0,0,145))
    shadow=shadow.filter(ImageFilter.GaussianBlur(max(3,width*.014)))
    im.paste(shadow,(0,0),shadow)
    im.paste(img,(x,top),img)


def cover(w,h,art):
    im=background(w,h)
    if w/h>2.8:
        # Wide surfaces: paired title and deck, both kept away from edge crops.
        fit_text(im,'Polydance',(w*.09,h*.30,w*.43,h*.29),h*.24)
        d=ImageDraw.Draw(im)
        d.rounded_rectangle((w*.11,h*.68,w*.15,h*.686),h*.003,fill=LOGO)
        paste_deck(im,round(w*.29),w*.745,round(h*.19),art)
    else:
        # One vertical hierarchy shared by landscape, square and portrait.
        title_y=h*(.14 if w/h>1.4 else .19)
        fit_text(im,'Polydance',(w*.12,title_y,w*.76,h*.14),min(w*.13,h*.17))
        deco=ImageDraw.Draw(im)
        deco.rounded_rectangle((w*.475,title_y+h*.19,w*.525,title_y+h*.194),3,fill=LOGO)
        top=round(title_y+h*.24)
        width=round(min(w*.82, (h-top-h*.09)*art.width/art.height))
        paste_deck(im,width,w*.5,top,art)
    return im


def save(im,name):
    path=OUT/name
    im.save(path,optimize=True)
    return {'file':name,'width':im.width,'height':im.height,'mode':im.mode,
            'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


def build():
    OUT.mkdir(parents=True,exist_ok=True)
    art=deck();manifest=[]
    specs=[('hero-cover-3000x900.png',3000,900),('cover-landscape-2560x1440.png',2560,1440),
           ('cover-square-1440x1440.png',1440,1440),('cover-portrait-1008x1440.png',1008,1440),
           ('mini-landscape-1080x360.png',1080,360)]
    for name,w,h in specs:
        # 1.5x supersampling keeps type, reel rims and diagonals crisp at export size.
        im=cover(round(w*1.5),round(h*1.5),art).resize((w,h),Image.Resampling.LANCZOS)
        manifest.append(save(im,name))
    # The app icon, as on every platform: the store rounds the square itself.
    mark=icons.load(MARK)
    manifest.append(save(icons.square(mark).resize((512,512),Image.Resampling.LANCZOS),'icon-512x512.png'))
    logo=Image.new('RGBA',(3200,800));e=icons.rounded(mark).resize((480,480),Image.Resampling.LANCZOS)
    logo.alpha_composite(e,(100,160))
    # Thin dark outline makes the pale lettering usable over both light and dark backgrounds.
    ImageDraw.Draw(logo).text((700,415),'Polydance',font=font(405,True),fill=CREAM,
                             stroke_width=5,stroke_fill=INK,anchor='lm')
    manifest.append(save(logo,'logo-transparent-3200x800.png'))
    # Optional spatialized tile, split from the icon: the charcoal behind, the dancer and her glow in front with
    # transparency and no painted shadow. The dashboard takes the 512 px pair first and the 180 px pair after it
    # (2026-11-11); at 72% of the tile she is 369 and 130 px tall, inside its 392 and 138 px safe areas.
    for side in (512,180):
        bg=icons.charcoal(side)
        fg=icons.front(mark,side).resize((side,side),Image.Resampling.LANCZOS)
        manifest.append(save(bg,f'spatial-background-{side}x{side}.png'))
        manifest.append(save(fg,f'spatial-foreground-{side}x{side}.png'))
    (ROOT/'manifest.json').write_text(json.dumps({'name':'Polydance','kind':'illustrated marketing artwork, not screenshots',
        'assets':manifest,'sourceMarkSha256':hashlib.sha256(MARK.read_bytes()).hexdigest()},indent=2)+'\n')
    # A contact sheet lives OUTSIDE upload/ so it cannot be confused with an individual asset.
    sheet=Image.new('RGB',(1500,1430),'#171614')
    text(sheet,(55,35),'Polydance / Store artwork',36,CREAM,True)
    text(sheet,(55,90),'Illustrated covers • Not gameplay screenshots',19,'#b8ad97')
    boxes=[(50,145,1400,420),(50,610,670,377),(770,610,345,345),(1170,610,250,357),
           (50,1080,620,207),(740,1080,220,220),(1030,1080,380,95)]
    for meta,(x,y,w,h) in zip(manifest[:7],boxes):
        image=Image.open(OUT/meta['file']);image.thumbnail((w,h),Image.Resampling.LANCZOS)
        if image.mode=='RGBA':sheet.paste(image,(x,y),image)
        else:sheet.paste(image,(x,y))
        text(sheet,(x,y+h+12),meta['file'].replace('.png',''),16,'#c3b8a4')
    sheet.save(ROOT/'PREVIEW.jpg',quality=92)
    # Validate what will actually be uploaded, rather than trusting in-memory modes/dimensions.
    for meta in manifest:
        with Image.open(OUT/meta['file']) as im:
            assert im.size==(meta['width'],meta['height']) and im.mode==meta['mode']
            assert im.format=='PNG'
            if meta['mode']=='RGB':assert 'transparency' not in im.info
    print(f'Validated {len(manifest)} PNGs in {OUT}')


if __name__=='__main__':
    build()
