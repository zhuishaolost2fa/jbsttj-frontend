# -*- coding: utf-8 -*-
"""Generate tabbar icon PNGs (81x81) for the jbsttj-frontend app.

Draws 3 icons x 2 states (gray / brand blue) with 4x supersampling:
  - tab-import    : upload arrow (导入)
  - tab-scripts   : closed book  (剧本)
  - tab-profile   : user bust     (我的)

Usage: python gen-tabbar-icons.py [output_dir]
"""
import os
import sys

from PIL import Image, ImageDraw

S = 81          # final icon size (Taro recommended 81x81)
SCALE = 4       # supersampling factor
BIG = S * SCALE

GRAY = (154, 160, 174, 255)     # #9aa0ae  unselected
BLUE = (91, 124, 250, 255)      # #5b7cfa  selected

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'src', 'assets', 'tabbar')


def P(x, y):
    """Scale an 81-space coordinate into the supersampled canvas."""
    return x * SCALE, y * SCALE


def rline(d, a, b, w, color):
    """Line with round caps (draw line + dots at both ends)."""
    a = P(*a)
    b = P(*b)
    r = w * SCALE / 2.0
    d.line([a, b], fill=color, width=int(w * SCALE))
    for c in (a, b):
        d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=color)


def draw_upload(d, color, w=6.5):
    """Upward arrow with a tray underneath."""
    tip = (40.5, 19)
    lw = (28.5, 33)
    rw = (52.5, 33)
    stem_b = (40.5, 52)
    tray_l = (24, 61)
    tray_r = (57, 61)
    rline(d, tip, lw, w, color)
    rline(d, tip, rw, w, color)
    rline(d, (40.5, 33), stem_b, w, color)
    rline(d, tray_l, tray_r, w, color)


def draw_book(d, color, w=6.5):
    """Closed book: rounded rect + spine + page lines."""
    box = [P(25, 23), P(56, 57)]
    d.rounded_rectangle(box, radius=6 * SCALE, outline=color,
                        width=int(w * SCALE))
    rline(d, (36, 23), (36, 57), 5.5, color)
    for y in (31, 40, 49):
        rline(d, (43, y), (51, y), 4.2, color)


def draw_user(d, color, w=6.5):
    """Bust: head circle + shoulder arc."""
    d.ellipse([P(31.5, 20), P(49.5, 38)], fill=color)
    arc_box = [P(22, 42), P(59, 75)]
    d.arc(arc_box, 180, 360, fill=color, width=int(w * SCALE))
    # round the two arc endpoints
    r = w * SCALE / 2.0
    for c in (P(22, 58.5), P(59, 58.5)):
        d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=color)


ICONS = {
    'tab-import': draw_upload,
    'tab-scripts': draw_book,
    'tab-profile': draw_user,
}


def render(draw_fn, color):
    img = Image.new('RGBA', (BIG, BIG), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    draw_fn(d, color)
    return img.resize((S, S), Image.LANCZOS)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else OUT
    os.makedirs(out, exist_ok=True)
    for name, fn in ICONS.items():
        for suffix, color in (('', GRAY), ('-active', BLUE)):
            path = os.path.join(out, f'{name}{suffix}.png')
            render(fn, color).save(path)
            size = os.path.getsize(path)
            print(f'wrote {path} ({size} bytes)')


if __name__ == '__main__':
    main()
