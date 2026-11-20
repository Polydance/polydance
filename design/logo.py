#!/usr/bin/env python3
"""Puts the ballerina in the `logo` colour of design/tokens.json on every platform (Robin, 2026-11-11: the deck's
orange-red rather than pink), so the logo is changed in one place and one command.

1. Recolours the mark, app/android/app/src/main/res/drawable-nodpi/polydance_mark.png (the logo on the headset's
   deck, and the dancer in every platform's icon), keeping the low-poly facets' shading: each pixel keeps its hue's
   offset from the mark's mean and its saturation and brightness relative to the mean, and the mean becomes the token.
2. Copies it to the store art's source (store-assets/polydance/source/) and the homepage (site/assets/), which
   tests/design.test.ts holds byte for byte to the mark.
3. Runs design/icons.py, which draws every platform's app icon in the Mac's style from the mark and the token (the
   Mac's, the iPhone's, the headsets' launcher, the homepage's) and then the store art (store-assets/polydance/build.py),
   and makes the homepage's link preview from the store's landscape cover.

Running it again with an unchanged token changes nothing visible. Python 3 and Pillow; no network.

    python3 -I design/logo.py
"""
from pathlib import Path
from PIL import Image
import colorsys
import json
import shutil
import subprocess
import sys

REPO = Path(__file__).resolve().parent.parent
MARK = REPO / 'app' / 'android' / 'app' / 'src' / 'main' / 'res' / 'drawable-nodpi' / 'polydance_mark.png'
COPIES = [REPO / 'store-assets' / 'polydance' / 'source' / 'polydance-mark.png', REPO / 'site' / 'assets' / 'polydance-mark.png']
STORE = REPO / 'store-assets' / 'polydance'
SITE = REPO / 'site' / 'assets'


def token() -> tuple:
    value = json.loads((REPO / 'design' / 'tokens.json').read_text())['colors'].get('logo')
    if not isinstance(value, str) or len(value) != 7 or not value.startswith('#'):
        sys.exit(f'logo: design/tokens.json has no colors.logo as #RRGGBB (found {value!r})')
    return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))


def pixels(image):
    """Every pixel in order (Pillow 12.1 renamed getdata, which goes in Pillow 14)."""
    return image.get_flattened_data() if hasattr(image, 'get_flattened_data') else image.getdata()


def hsv(rgb):
    return colorsys.rgb_to_hsv(*(c / 255 for c in rgb))


def mean_hsv(image):
    """The mark's mean colour, weighted by opacity, as hue, saturation and value."""
    r = g = b = w = 0.0
    for (pr, pg, pb, pa) in pixels(image):
        r += pr * pa; g += pg * pa; b += pb * pa; w += pa
    return hsv((r / w, g / w, b / w))


def recolour(image, source, target):
    """Moves every pixel from the source's mean to the target's, keeping its offset in hue and its
    saturation and brightness in proportion, so the facets keep their light and shade."""
    (sh, ss, sv), (th, ts, tv) = source, target
    out = []
    for pixel in pixels(image):
        rgb, rest = pixel[:3], pixel[3:]
        h, s, v = hsv(rgb)
        offset = ((h - sh + 0.5) % 1) - 0.5
        nh = (th + offset) % 1
        ns = min(1.0, s * ts / ss) if ss else ts
        nv = min(1.0, v * tv / sv) if sv else tv
        out.append(tuple(round(c * 255) for c in colorsys.hsv_to_rgb(nh, ns, nv)) + rest)
    result = image.copy()
    result.putdata(out)
    return result


def main():
    target = hsv(token())
    mark = Image.open(MARK).convert('RGBA')
    if mark.size != (256, 256):
        sys.exit(f'logo: expected the 256 px mark, found {mark.size}')
    source = mean_hsv(mark)
    recolour(mark, source, target).save(MARK, optimize=True)
    for copy in COPIES:
        shutil.copyfile(MARK, copy)

    subprocess.run([sys.executable, '-I', str(REPO / 'design' / 'icons.py')], check=True)
    cover = Image.open(STORE / 'upload' / 'cover-landscape-2560x1440.png').convert('RGB')
    cover.resize((1200, 675), Image.Resampling.LANCZOS).save(SITE / 'og.png', optimize=True)
    old = colorsys.hsv_to_rgb(*source)
    print(f'logo: the mark moved from about #{"".join(f"{round(c * 255):02X}" for c in old)} to the token '
          f'#{"".join(f"{c:02X}" for c in token())}; the copies, every platform\'s icon, the store art and the homepage\'s '
          f'preview are redrawn')


if __name__ == '__main__':
    main()
