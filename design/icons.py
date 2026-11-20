#!/usr/bin/env python3
"""Draws Polydance's app icon for every platform in one style, the Mac's dock icon (Robin, 2026-11-11: "I like the
mac dock icon we've made. Can we ensure that style of icon is used across every platform"). The tile: the ballerina
(app/android/app/src/main/res/drawable-nodpi/polydance_mark.png) in the logo's colour, 72% of the tile's height and
centred on her outline, over a faint glow of her own colour, on the store art's warm charcoal, lighter towards the
middle. Each platform gets that tile in the shape it expects:

- Mac: mac/App/Resources/AppIcon.icns on macOS's icon grid (an 824 px rounded square at 100 px in 1024, with a soft
  shadow), and the menu-bar silhouette at 1x and 2x (a template image, which macOS tints).
- iPhone: ios/.../AppIcon.appiconset/AppIcon.png, the square at 1024 px, no corners and no transparency; iOS rounds it.
- Vision Pro: visionos/.../AppIcon.solidimagestack, visionOS's two layers at 1024 px, the charcoal behind and the dancer
  with her glow in front, transparent elsewhere; visionOS cuts the circle and moves the layers apart as it is looked at.
- Headsets, Quest and Android XR: the adaptive launcher icon (res/mipmap-anydpi/ic_launcher.xml) over three 108 dp
  layers in res/drawable-nodpi: the charcoal, the dancer and her glow inside the 66 dp circle every launcher's mask
  keeps, and her silhouette for Android 13's themed icons. The launcher cuts the shape (Android XR's is a circle).
- Stores: store-assets/polydance/build.py imports this file for the Meta icon, the spatial pair and the logo's tile
  (and Google Play's listing, when it has an icon, should take the same 512 px square). This script runs build.py
  last, so one command redraws every icon.
- Homepage: site/assets/icon-512.png for home screens (which round it) and site/assets/favicon.png, the rounded tile,
  for a browser tab.

design/icons.json records the sha256 of each file written here, and tests/design.test.ts fails when a committed icon
differs from it or a platform stops pointing at its icon.

The mark is a 256 px raster and no larger cut-out exists (the 1024 px render in the first Polydance repository is on a
green background), so the 1024 px icons draw her scaled up. Everything is drawn at 4x and scaled down.

Python 3 and Pillow (12.1.1, 2026-11-11); iconutil comes with macOS. No network.

    python3 -I design/icons.py
"""
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter
import hashlib
import json
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
MARK = REPO / 'app' / 'android' / 'app' / 'src' / 'main' / 'res' / 'drawable-nodpi' / 'polydance_mark.png'
MAC = REPO / 'mac' / 'App' / 'Resources'
IPHONE = REPO / 'ios' / 'App' / 'Resources' / 'Assets.xcassets' / 'AppIcon.appiconset' / 'AppIcon.png'
VISION = REPO / 'visionos' / 'App' / 'Resources' / 'Assets.xcassets' / 'AppIcon.solidimagestack'
ANDROID = REPO / 'app' / 'android' / 'app' / 'src' / 'main' / 'res' / 'drawable-nodpi'
SITE = REPO / 'site' / 'assets'
STORE = REPO / 'store-assets' / 'polydance' / 'build.py'
RECORD = HERE / 'icons.json'

# The store art's warm charcoal (store-assets/polydance/build.py INK).
INK = (32, 28, 26)
# The logo's colour, design/tokens.json colors.logo (the deck's orange since 2026-11-11; design/logo.py runs this).
LOGO = tuple(int(json.loads((REPO / 'design' / 'tokens.json').read_text())['colors']['logo'][i:i + 2], 16) for i in (1, 3, 5))

# The Mac's proportions, as shares of the tile's side, so every shape matches the dock icon.
DANCER = 0.72                # her height
GLOW = 28 / 824              # the blur of her glow
GLOW_ALPHA = 45              # its strength, in percent
LIGHT = (412 / 824, 372 / 824)   # the centre of the charcoal's light: across the middle, a little above it
REACH = 600 / 824            # how far the light reaches
CORNER = 185 / 824           # the rounded square's corner radius
SS = 4                       # drawn at 4x, then scaled down

# The menu bar's glyph height in points (macOS draws status items about 16 to 18 pt tall).
MENU_BAR_PT = 18
# Thickens the silhouette by 2 px each side at 256 px before it is scaled down, so the arms stay visible.
MENU_BAR_GROW = 5

# Android's adaptive icon: 108 dp layers, of which a launcher shows the middle 72 dp; at xxxhdpi, 4 px a dp.
ADAPTIVE, ADAPTIVE_FACE = 432, 288


def load(mark_path=MARK):
    mark = Image.open(mark_path).convert('RGBA')
    if mark.size != (256, 256):
        sys.exit(f'icons: expected the 256 px mark, found {mark.size} at {mark_path}')
    return mark


def charcoal(canvas, face=None, size=None):
    """The tile's background on a `canvas` px square whose tile is the centred `face` px square (all of it unless
    given), so the light falls the same way whatever a platform trims. Returned at `size` px (the canvas's own)."""
    face = face or canvas
    margin = (canvas - face) / 2
    small = Image.new('RGB', (256, 256))
    pixels = small.load()
    for y in range(256):
        for x in range(256):
            u, v = (x * canvas / 256 - margin) / face, (y * canvas / 256 - margin) / face
            glow = max(0.0, 1 - (((u - LIGHT[0]) / REACH) ** 2 + ((v - LIGHT[1]) / REACH) ** 2) ** 0.5)
            pixels[x, y] = (int(INK[0] + 26 * glow), int(INK[1] + 20 * glow), int(INK[2] + 15 * glow))
    side = size or canvas
    return small.resize((side, side), Image.Resampling.BICUBIC)


def placed(mark, canvas, face):
    """Her cut-out sized for a `face` px tile and its top-left corner centred in a `canvas` px square, both at 4x."""
    dancer = mark.crop(mark.getchannel('A').getbbox())
    height = round(face * DANCER * SS)
    width = round(height * dancer.width / dancer.height)
    size = canvas * SS
    return dancer.resize((width, height), Image.Resampling.LANCZOS), ((size - width) // 2, (size - height) // 2)


def front(mark, canvas, face=None):
    """The dancer over her glow, transparent elsewhere, at 4x: what sits on the charcoal."""
    face = face or canvas
    size = canvas * SS
    dancer, corner = placed(mark, canvas, face)
    glow = Image.new('L', (size, size), 0)
    glow.paste(dancer.getchannel('A'), corner)
    glow = glow.filter(ImageFilter.GaussianBlur(GLOW * face * SS)).point(lambda v: v * GLOW_ALPHA // 100)
    layer = Image.new('RGBA', (size, size), LOGO + (0,))
    layer.putalpha(glow)
    layer.alpha_composite(dancer, corner)
    return layer


def rounded_mask(size, box, radius):
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius, fill=255)
    return mask


def square(mark, side=1024):
    """The tile filling its square, no corners, no transparency: iOS, the stores and home screens round it themselves."""
    tile = charcoal(side, size=side * SS).convert('RGBA')
    tile.alpha_composite(front(mark, side))
    return tile.convert('RGB').resize((side, side), Image.Resampling.LANCZOS)


def rounded(mark, side=1024):
    """The tile as the Mac's rounded square, filling the canvas, transparent in the corners: a browser tab, the store logo."""
    size = side * SS
    tile = charcoal(side, size=size).convert('RGBA')
    tile.alpha_composite(front(mark, side))
    tile.putalpha(rounded_mask(size, (0, 0, size, size), CORNER * size))
    return tile.resize((side, side), Image.Resampling.LANCZOS)


def mac_icon(mark):
    """1024 px, on macOS's icon grid: an 824 px rounded square at 100 px with a soft shadow."""
    size = 1024 * SS
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    box = (100 * SS, 100 * SS, 924 * SS, 924 * SS)

    shadow = Image.new('L', (size, size), 0)
    ImageDraw.Draw(shadow).rounded_rectangle((box[0], box[1] + 12 * SS, box[2], box[3] + 12 * SS), 185 * SS, fill=90)
    shadow = shadow.filter(ImageFilter.GaussianBlur(20 * SS))
    canvas.paste((0, 0, 0, 255), (0, 0), shadow)

    tile = rounded_mask(size, box, 185 * SS)
    canvas.paste(charcoal(1024, 824, size), (0, 0), tile)
    layer = front(mark, 1024, 824)
    layer.putalpha(ImageChops.multiply(layer.getchannel('A'), tile))
    canvas.alpha_composite(layer)
    return canvas.resize((1024, 1024), Image.Resampling.LANCZOS)


def menu_bar(alpha, height):
    grown = alpha.filter(ImageFilter.MaxFilter(MENU_BAR_GROW))
    shape = grown.crop(grown.getbbox())
    width = round(height * shape.width / shape.height)
    shape = shape.resize((width, height), Image.Resampling.LANCZOS)
    # A template image: black where the dancer is, transparent elsewhere; macOS tints it for the menu bar.
    image = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    image.paste((0, 0, 0, 255), (0, 0), shape)
    return image


def adaptive(mark):
    """Android's three layers at 432 px: the charcoal, the dancer and her glow, and her white silhouette (the themed
    icon; the launcher tints it). At 72% of the 72 dp face she is 52 dp tall, her outline's corners 32 dp from the
    centre, inside the 66 dp circle every launcher's mask keeps."""
    background = charcoal(ADAPTIVE, ADAPTIVE_FACE)
    foreground = front(mark, ADAPTIVE, ADAPTIVE_FACE).resize((ADAPTIVE, ADAPTIVE), Image.Resampling.LANCZOS)
    dancer, corner = placed(mark, ADAPTIVE, ADAPTIVE_FACE)
    silhouette = Image.new('RGBA', (ADAPTIVE * SS, ADAPTIVE * SS), (255, 255, 255, 0))
    silhouette.paste((255, 255, 255, 255), corner, dancer.getchannel('A'))
    return background, foreground, silhouette.resize((ADAPTIVE, ADAPTIVE), Image.Resampling.LANCZOS)


def vision(mark, side=1024):
    """visionOS's two layers: the charcoal filling the square (visionOS cuts the circle) and the dancer over her glow,
    transparent elsewhere. At 72% of the circle's height her outline's corners stay inside it."""
    back = charcoal(side, size=side)
    front_layer = front(mark, side).resize((side, side), Image.Resampling.LANCZOS)
    return back, front_layer


def write_stack(back, front_layer, folder):
    """The asset catalog's image stack for visionOS: Front over Back, each one 1024 px image. Returns the images written."""
    info = {'author': 'design/icons.py', 'version': 1}
    folder.mkdir(parents=True, exist_ok=True)
    (folder.parent / 'Contents.json').write_text(json.dumps({'info': info}, indent=2) + '\n')
    (folder / 'Contents.json').write_text(json.dumps({'info': info, 'layers': [
        {'filename': 'Front.solidimagestacklayer'}, {'filename': 'Back.solidimagestacklayer'}]}, indent=2) + '\n')
    images = []
    for name, image in (('Front', front_layer), ('Back', back)):
        layer = folder / f'{name}.solidimagestacklayer'
        content = layer / 'Content.imageset'
        content.mkdir(parents=True, exist_ok=True)
        (layer / 'Contents.json').write_text(json.dumps({'info': info}, indent=2) + '\n')
        (content / 'Contents.json').write_text(json.dumps({'images': [{'filename': f'{name}.png', 'idiom': 'vision', 'scale': '2x'}],
                                                           'info': info}, indent=2) + '\n')
        images.append((image, content / f'{name}.png'))
    return images


def write_icns(master, path):
    sizes = {'16x16': 16, '16x16@2x': 32, '32x32': 32, '32x32@2x': 64, '128x128': 128, '128x128@2x': 256,
             '256x256': 256, '256x256@2x': 512, '512x512': 512, '512x512@2x': 1024}
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / 'AppIcon.iconset'
        iconset.mkdir()
        for name, px in sizes.items():
            master.resize((px, px), Image.Resampling.LANCZOS).save(iconset / f'icon_{name}.png')
        subprocess.run(['/usr/bin/iconutil', '-c', 'icns', '-o', str(path), str(iconset)], check=True)


def main():
    if not MARK.is_file():
        sys.exit(f'icons: the logo is not at {MARK}')
    mark = load()
    written = []

    def save(image, path, optimize=True):
        image.save(path, optimize=optimize)
        written.append(path)

    MAC.mkdir(exist_ok=True)
    alpha = mark.getchannel('A')
    save(menu_bar(alpha, MENU_BAR_PT), MAC / 'MenuBarDancer.png', False)
    save(menu_bar(alpha, MENU_BAR_PT * 2), MAC / 'MenuBarDancer@2x.png', False)
    master = mac_icon(mark)
    write_icns(master, MAC / 'AppIcon.icns')
    written.append(MAC / 'AppIcon.icns')

    full = square(mark)
    save(full, IPHONE)
    for image, path in write_stack(*vision(mark), VISION):
        save(image, path)
    for image, name in zip(adaptive(mark), ('launcher_background', 'launcher_foreground', 'launcher_monochrome')):
        save(image, ANDROID / f'{name}.png')
    save(full.resize((512, 512), Image.Resampling.LANCZOS), SITE / 'icon-512.png')
    save(rounded(mark).resize((64, 64), Image.Resampling.LANCZOS), SITE / 'favicon.png')

    RECORD.write_text(json.dumps({
        'drawnBy': 'design/icons.py',
        'markSha256': hashlib.sha256(MARK.read_bytes()).hexdigest(),
        'files': {str(p.relative_to(REPO)): hashlib.sha256(p.read_bytes()).hexdigest() for p in written},
    }, indent=2) + '\n')
    print(f'icons: wrote {len(written)} files and {RECORD.relative_to(REPO)}; the store art next')
    subprocess.run([sys.executable, '-I', str(STORE)], check=True)


if __name__ == '__main__':
    main()
